// src/routes/admin.ts
import { Router, Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Readable } from 'stream';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { Prisma, ReportStatus } from '@prisma/client';
import { prisma } from '../db';
import { decrypt } from '../crypto';
import { r2 } from '../services/r2';
import { asyncHandler } from '../utils/asyncHandler';
import { sanitizeText } from '../utils/sanitize';
import { normalizeTrackingCode } from '../utils/trackingCode';
import {
  hashPassword, verifyPassword, dummyHash, validatePasswordStrength, generateTempPassword,
} from '../utils/password';
import {
  csrfGuard, requireAdmin, enforcePasswordChange, requirePermission, toAuthed,
  createSession, setSessionCookie, clearSessionCookie, hashToken, readSessionToken,
} from '../middleware/adminAuth';

const router = Router();
router.use(csrfGuard);

const MAX_FAILED_LOGINS = 5;
const LOCK_MS = 15 * 60 * 1000;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: 'Too many attempts. Try again later.' },
});

async function audit(
  req: Request,
  action: string,
  extra: { reportId?: string; meta?: Prisma.InputJsonValue; email?: string } = {}
) {
  try {
    await prisma.auditLog.create({
      data: {
        adminId: req.admin?.id ?? null,
        actorEmail: req.admin?.email ?? extra.email?.slice(0, 120) ?? null,
        action,
        reportId: extra.reportId,
        meta: extra.meta,
        ip: req.ip,
      },
    });
  } catch (err) {
    console.error('audit log write failed:', err); // never block the request on logging
  }
}

/* ───────────────────────────── AUTH ───────────────────────────── */

const loginSchema = z.object({ email: z.string().max(120), password: z.string().max(128) });

router.post('/auth/login', loginLimiter, asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter your email and password.' });

  const email = parsed.data.email.trim().toLowerCase();
  const admin = await prisma.admin.findUnique({ where: { email } });
  const now = new Date();
  const locked = !!admin?.lockedUntil && admin.lockedUntil > now;

  // Always run a hash, even for unknown emails, so timing doesn't reveal valid accounts.
  const passwordOk = await verifyPassword(parsed.data.password, admin?.passwordHash ?? (await dummyHash()));

  if (!admin || locked || !passwordOk) {
    if (admin && !locked) {
      const attempts = admin.failedAttempts + 1;
      await prisma.admin.update({
        where: { id: admin.id },
        data:
          attempts >= MAX_FAILED_LOGINS
            ? { failedAttempts: 0, lockedUntil: new Date(now.getTime() + LOCK_MS) }
            : { failedAttempts: attempts },
      });
    }
    await audit(req, 'LOGIN_FAILED', { email, meta: { locked } });
    // One message for every failure so it can't be used to discover accounts.
    return res.status(401).json({ error: 'Invalid email or password, or the account is temporarily locked.' });
  }

  await prisma.adminSession.deleteMany({ where: { expiresAt: { lt: now } } }); // opportunistic cleanup
  await prisma.admin.update({
    where: { id: admin.id },
    data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: now },
  });

  const token = await createSession(admin.id, req); // fresh token every login (no session fixation)
  setSessionCookie(res, token);
  req.admin = toAuthed(admin);
  await audit(req, 'LOGIN');

  res.json({ admin: req.admin });
}));

router.post('/auth/logout', asyncHandler(async (req, res) => {
  const token = readSessionToken(req);
  if (token) await prisma.adminSession.deleteMany({ where: { tokenHash: hashToken(token) } });
  clearSessionCookie(res);
  res.json({ ok: true });
}));

// Everything below requires a valid session.
router.use(requireAdmin);
router.use(enforcePasswordChange);

router.get('/auth/me', (req, res) => {
  res.json({ admin: req.admin });
});

const changePasswordSchema = z.object({
  currentPassword: z.string().max(128),
  newPassword: z.string().max(128),
});

router.post('/auth/change-password', asyncHandler(async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const { currentPassword, newPassword } = parsed.data;

  const admin = await prisma.admin.findUnique({ where: { id: req.admin!.id } });
  if (!admin || !(await verifyPassword(currentPassword, admin.passwordHash))) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  const weak = validatePasswordStrength(newPassword);
  if (weak) return res.status(400).json({ error: weak });
  if (newPassword === currentPassword) return res.status(400).json({ error: 'Choose a different password.' });

  await prisma.admin.update({
    where: { id: admin.id },
    data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false },
  });
  // sign out every other device
  await prisma.adminSession.deleteMany({ where: { adminId: admin.id, id: { not: req.sessionId } } });
  await audit(req, 'PASSWORD_CHANGED');

  req.admin!.mustChangePassword = false;
  res.json({ admin: req.admin });
}));

/* ───────────────────────────── REPORTS ───────────────────────────── */

type Cursor = { t: string; i: string };
const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
function decodeCursor(raw: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof c.t === 'string' && typeof c.i === 'string' && !Number.isNaN(Date.parse(c.t))) return c;
  } catch { /* fall through */ }
  return null;
}

const listQuery = z.object({
  status: z.nativeEnum(ReportStatus).optional(),
  state: z.string().max(50).optional(),
  q: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().max(300).optional(),
});

// Keyset pagination on (createdAt desc, id desc): cost stays flat however deep you scroll,
// unlike OFFSET which gets slower with every page on a multi-million-row table.
router.get('/reports', requirePermission('reports:view'), asyncHandler(async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid filters' });
  const { status, state, q, limit, cursor } = parsed.data;

  const and: Prisma.ReportWhereInput[] = [];
  if (status) and.push({ status });
  if (state) and.push({ state });

  const search = q?.trim();
  if (search) {
    const code = normalizeTrackingCode(search);
    const or: Prisma.ReportWhereInput[] = [];
    if (code) or.push({ trackingCode: code });
    if (/^[\w-]{20,40}$/.test(search)) or.push({ id: search }); // internal reference
    if (or.length === 0) return res.json({ items: [], nextCursor: null });
    and.push({ OR: or });
  }

  if (cursor) {
    const c = decodeCursor(cursor);
    if (!c) return res.status(400).json({ error: 'Invalid cursor' });
    const t = new Date(c.t);
    and.push({ OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: c.i } }] });
  }

  const rows = await prisma.report.findMany({
    where: and.length ? { AND: and } : undefined,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true, trackingCode: true, state: true, city: true, status: true,
      description: true, createdAt: true, statusUpdatedAt: true,
      _count: { select: { media: true } },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  res.json({
    items: page.map((r) => ({
      id: r.id,
      trackingCode: r.trackingCode,
      state: r.state,
      city: r.city,
      status: r.status,
      snippet: r.description.slice(0, 140),
      mediaCount: r._count.media,
      createdAt: r.createdAt,
      statusUpdatedAt: r.statusUpdatedAt,
    })),
    nextCursor: hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), i: last.id }) : null,
  });
}));

// Counts are cached briefly: with millions of rows you don't want every dashboard
// refresh (from every officer) to trigger a group-by.
let statsCache: { at: number; data: unknown } | null = null;
const STATS_TTL_MS = 60 * 1000;

async function getStats() {
  if (statsCache && Date.now() - statsCache.at < STATS_TTL_MS) return statsCache.data;

  const [byStatusRows, last7Days, stateRows] = await Promise.all([
    prisma.report.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.report.count({ where: { createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } }),
    prisma.report.groupBy({ by: ['state'], _count: { _all: true }, orderBy: { state: 'asc' } }),
  ]);

  const byStatus: Record<string, number> = {};
  for (const s of Object.values(ReportStatus)) byStatus[s] = 0;
  for (const row of byStatusRows) byStatus[row.status] = row._count._all;

  const data = {
    total: Object.values(byStatus).reduce((a, b) => a + b, 0),
    last7Days,
    byStatus,
    states: stateRows.map((s) => s.state),
  };
  statsCache = { at: Date.now(), data };
  return data;
}

router.get('/reports/stats', requirePermission('reports:view'), asyncHandler(async (_req, res) => {
  res.json(await getStats());
}));

router.get('/reports/:id', requirePermission('reports:view'), asyncHandler(async (req, res) => {
  const report = await prisma.report.findUnique({
    where: { id: req.params.id },
    select: {
      id: true, trackingCode: true, state: true, city: true, address: true, description: true,
      status: true, createdAt: true, statusUpdatedAt: true,
      media: { select: { id: true, key: true, type: true } },
      events: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, fromStatus: true, toStatus: true, publicNote: true,
          internalNote: true, actorEmail: true, createdAt: true,
        },
      },
      informant: true,
    },
  });
  if (!report) return res.status(404).json({ error: 'Report not found' });

  // Evidence is only described to roles allowed to view it. No storage URLs are ever sent:
  // the browser asks for each file through /media/:id/stream, which checks the role every time.
  const canViewEvidence = req.admin!.permissions.includes('evidence:view');
  const media = canViewEvidence
    ? report.media.map((m) => ({
        id: m.id,
        type: m.type,
        name: m.key.split('/').pop() ?? m.key,
      }))
    : [];

  await audit(req, 'VIEW_REPORT', { reportId: report.id });

  const { informant, media: _media, ...rest } = report;
  res.json({
    ...rest,
    media,
    mediaCount: report.media.length,
    mediaRestricted: !canViewEvidence,
    hasInformant: !!informant,
  });
}));

/* ───────────────────────── EVIDENCE (super admin only) ───────────────────────── */

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  mp4: 'video/mp4', mov: 'video/quicktime',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// The file is streamed through this server instead of handing the browser a storage link,
// so the role is checked, and the view logged, on every access. Only the super admin
// has the 'evidence:view' permission. Files open or download normally (nothing is blocked).
router.get('/media/:id/stream', requirePermission('evidence:view'), asyncHandler(async (req, res) => {
  const media = await prisma.media.findUnique({ where: { id: req.params.id }, select: { id: true, key: true, type: true, reportId: true } });
  if (!media) return res.status(404).json({ error: 'File not found' });

  const ext = (media.key.split('.').pop() ?? '').toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) return res.status(415).json({ error: 'Unsupported file type.' });

  const range = req.headers.range;
  let obj;
  try {
    obj = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: media.key, Range: range }));
  } catch (err: any) {
    if (err?.name === 'InvalidRange') return res.status(416).end();
    if (err?.name === 'NoSuchKey') return res.status(404).json({ error: 'File not found' });
    throw err;
  }
  if (!obj.Body) return res.status(404).json({ error: 'File not found' });

  // log one "view" per file, not one per video range request
  if (!range || /^bytes=0-/.test(range)) {
    await audit(req, 'VIEW_MEDIA', { reportId: media.reportId, meta: { mediaId: media.id, type: media.type } });
  }

  res.status(range && obj.ContentRange ? 206 : 200);
  res.setHeader('Content-Type', contentType);
  if (obj.ContentLength != null) res.setHeader('Content-Length', String(obj.ContentLength));
  if (obj.ContentRange) res.setHeader('Content-Range', obj.ContentRange);
  res.setHeader('Accept-Ranges', 'bytes');
  // images, video and PDFs open in the browser; Word files can't, so they download
  res.setHeader('Content-Disposition', ext === 'doc' || ext === 'docx' ? `attachment; filename="evidence.${ext}"` : 'inline');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  const body = obj.Body as Readable;
  body.on('error', () => res.destroy());
  res.on('close', () => body.destroy());
  body.pipe(res);
}));

// Informant identity is behind its own explicit call so every reveal is audited.
router.get('/reports/:id/informant', requirePermission('informant:view'), asyncHandler(async (req, res) => {
  const report = await prisma.report.findUnique({
    where: { id: req.params.id },
    select: { id: true, informant: true },
  });
  if (!report) return res.status(404).json({ error: 'Report not found' });
  if (!report.informant) return res.json({ informant: null });

  const dec = (value: Uint8Array | null | undefined) => {
    if (!value) return null;
    try { return decrypt(Buffer.from(value)); } catch { return null; }
  };
  const inf = report.informant as any;

  await audit(req, 'VIEW_INFORMANT', { reportId: report.id });
  res.json({
    informant: {
      name: dec(inf.nameEnc),
      phone: dec(inf.phoneEnc),
      email: dec(inf.emailEnc),
      address: dec(inf.addressEnc),
    },
  });
}));

const statusSchema = z.object({
  status: z.nativeEnum(ReportStatus),
  publicNote: z.string().max(500).optional(),
  internalNote: z.string().max(2000).optional(),
});

router.patch('/reports/:id/status', requirePermission('reports:update_status'), asyncHandler(async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid status update' });

  const publicNote = parsed.data.publicNote ? sanitizeText(parsed.data.publicNote) : null;
  const internalNote = parsed.data.internalNote ? sanitizeText(parsed.data.internalNote) : null;

  const current = await prisma.report.findUnique({ where: { id: req.params.id }, select: { status: true } });
  if (!current) return res.status(404).json({ error: 'Report not found' });
  if (current.status === parsed.data.status && !publicNote && !internalNote) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.report.update({
      where: { id: req.params.id },
      data: { status: parsed.data.status, statusUpdatedAt: now },
    }),
    prisma.statusEvent.create({
      data: {
        reportId: req.params.id,
        fromStatus: current.status,
        toStatus: parsed.data.status,
        publicNote: publicNote || null,
        internalNote: internalNote || null,
        adminId: req.admin!.id,
        actorEmail: req.admin!.email,
        createdAt: now,
      },
    }),
  ]);

  statsCache = null; // counts changed
  await audit(req, 'UPDATE_STATUS', {
    reportId: req.params.id,
    meta: { from: current.status, to: parsed.data.status },
  });

  res.json({ ok: true, status: parsed.data.status, statusUpdatedAt: now });
}));

/* ───────────────── OFFICER MANAGEMENT (admin manager role) ─────────────────
 * Admin managers only ever see and touch OFFICER accounts. Super admins and other
 * admin managers are created and reset from the command line (scripts/), never here,
 * and there is deliberately no way to create a super admin through the API.
 */

const officerSelect = {
  id: true, email: true, name: true, role: true, mustChangePassword: true, lastLoginAt: true, createdAt: true,
} satisfies Prisma.AdminSelect;

router.get('/admins', requirePermission('admins:manage'), asyncHandler(async (_req, res) => {
  const admins = await prisma.admin.findMany({
    where: { role: 'OFFICER' },
    select: officerSelect,
    orderBy: { createdAt: 'asc' },
  });
  res.json({ admins });
}));

const createOfficerSchema = z.object({
  email: z.string().email().max(120),
  name: z.string().trim().min(2).max(80),
}); // any `role` sent by a client is ignored: this endpoint can only create officers

router.post('/admins', requirePermission('admins:manage'), asyncHandler(async (req, res) => {
  const parsed = createOfficerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid email and name.' });

  const tempPassword = generateTempPassword();
  try {
    const admin = await prisma.admin.create({
      data: {
        email: parsed.data.email.trim().toLowerCase(),
        name: sanitizeText(parsed.data.name),
        role: 'OFFICER',
        passwordHash: await hashPassword(tempPassword),
        mustChangePassword: true,
      },
      select: officerSelect,
    });
    await audit(req, 'OFFICER_CREATED', { meta: { email: admin.email } });
    // The temporary password is shown once and never stored in readable form.
    res.status(201).json({ admin, tempPassword });
  } catch (err: any) {
    if (err?.code === 'P2002') return res.status(409).json({ error: 'An account with that email already exists.' });
    throw err;
  }
}));

async function findOfficer(id: string) {
  return prisma.admin.findFirst({ where: { id, role: 'OFFICER' }, select: { id: true, email: true } });
}

router.post('/admins/:id/reset-password', requirePermission('admins:manage'), asyncHandler(async (req, res) => {
  const target = await findOfficer(req.params.id);
  if (!target) return res.status(404).json({ error: 'Officer not found' });

  const tempPassword = generateTempPassword();
  await prisma.$transaction([
    prisma.admin.update({
      where: { id: target.id },
      data: { passwordHash: await hashPassword(tempPassword), mustChangePassword: true, failedAttempts: 0, lockedUntil: null },
    }),
    prisma.adminSession.deleteMany({ where: { adminId: target.id } }), // force sign-out everywhere
  ]);
  await audit(req, 'OFFICER_PASSWORD_RESET', { meta: { email: target.email } });
  res.json({ tempPassword });
}));

router.delete('/admins/:id', requirePermission('admins:manage'), asyncHandler(async (req, res) => {
  const target = await findOfficer(req.params.id);
  if (!target) return res.status(404).json({ error: 'Officer not found' });

  await prisma.admin.delete({ where: { id: target.id } }); // sessions cascade → access ends immediately
  await audit(req, 'OFFICER_DELETED', { meta: { email: target.email } });
  res.json({ ok: true });
}));

/* ───────────────────────────── ACTIVITY LOG (super admin) ───────────────────────────── */

router.get('/audit', requirePermission('audit:view'), asyncHandler(async (_req, res) => {
  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { id: true, actorEmail: true, action: true, reportId: true, meta: true, ip: true, createdAt: true },
  });
  res.json({ logs });
}));

export default router;