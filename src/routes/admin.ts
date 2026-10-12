// src/routes/admin.ts
import { Router, Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Prisma, ReportStatus, AdminRole } from '@prisma/client';
import { prisma } from '../db';
import { decrypt } from '../crypto';
import { asyncHandler } from '../utils/asyncHandler';
import { sanitizeText } from '../utils/sanitize';
import { normalizeTrackingCode } from '../utils/trackingCode';
import {
  hashPassword, verifyPassword, dummyHash, validatePasswordStrength, generateTempPassword,
} from '../utils/password';
import { getFreshMediaLink } from '../services/media';
import {
  csrfGuard, requireAdmin, enforcePasswordChange, requireRole,
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
  req.admin = { id: admin.id, email: admin.email, name: admin.name, role: admin.role, mustChangePassword: admin.mustChangePassword };
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
router.get('/reports', asyncHandler(async (req, res) => {
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
    if (/^[\w-]{20,40}$/.test(search)) or.push({ id: search }); // internal reference from the email
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

router.get('/reports/stats', asyncHandler(async (_req, res) => {
  res.json(await getStats());
}));

router.get('/reports/:id', asyncHandler(async (req, res) => {
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

  const media = await Promise.all(
    report.media.map(async (m) => ({
      id: m.id,
      type: m.type,
      name: m.key.split('/').pop() ?? m.key,
      url: await getFreshMediaLink(m.key), // short-lived signed link
    }))
  );

  await audit(req, 'VIEW_REPORT', { reportId: report.id });

  const { informant, media: _media, ...rest } = report;
  res.json({ ...rest, media, hasInformant: !!informant });
}));

// Informant identity is behind its own explicit call so every reveal is audited.
router.get('/reports/:id/informant', asyncHandler(async (req, res) => {
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

router.patch('/reports/:id/status', asyncHandler(async (req, res) => {
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

/* ───────────────────────── ADMIN MANAGEMENT (super admin) ───────────────────────── */

const adminSelect = {
  id: true, email: true, name: true, role: true, mustChangePassword: true, lastLoginAt: true, createdAt: true,
} satisfies Prisma.AdminSelect;

router.get('/admins', requireRole('SUPER_ADMIN'), asyncHandler(async (_req, res) => {
  const admins = await prisma.admin.findMany({ select: adminSelect, orderBy: { createdAt: 'asc' } });
  res.json({ admins });
}));

const createAdminSchema = z.object({
  email: z.string().email().max(120),
  name: z.string().trim().min(2).max(80),
  role: z.nativeEnum(AdminRole),
});

router.post('/admins', requireRole('SUPER_ADMIN'), asyncHandler(async (req, res) => {
  const parsed = createAdminSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid email, name and role.' });

  const tempPassword = generateTempPassword();
  try {
    const admin = await prisma.admin.create({
      data: {
        email: parsed.data.email.trim().toLowerCase(),
        name: sanitizeText(parsed.data.name),
        role: parsed.data.role,
        passwordHash: await hashPassword(tempPassword),
        mustChangePassword: true,
      },
      select: adminSelect,
    });
    await audit(req, 'ADMIN_CREATED', { meta: { email: admin.email, role: admin.role } });
    // The temporary password is shown once and never stored in readable form.
    res.status(201).json({ admin, tempPassword });
  } catch (err: any) {
    if (err?.code === 'P2002') return res.status(409).json({ error: 'An admin with that email already exists.' });
    throw err;
  }
}));

router.post('/admins/:id/reset-password', requireRole('SUPER_ADMIN'), asyncHandler(async (req, res) => {
  const target = await prisma.admin.findUnique({ where: { id: req.params.id }, select: { id: true, email: true } });
  if (!target) return res.status(404).json({ error: 'Admin not found' });

  const tempPassword = generateTempPassword();
  await prisma.$transaction([
    prisma.admin.update({
      where: { id: target.id },
      data: { passwordHash: await hashPassword(tempPassword), mustChangePassword: true, failedAttempts: 0, lockedUntil: null },
    }),
    prisma.adminSession.deleteMany({ where: { adminId: target.id } }), // force sign-out everywhere
  ]);
  await audit(req, 'ADMIN_PASSWORD_RESET', { meta: { email: target.email } });
  res.json({ tempPassword });
}));

router.delete('/admins/:id', requireRole('SUPER_ADMIN'), asyncHandler(async (req, res) => {
  if (req.params.id === req.admin!.id) return res.status(400).json({ error: "You can't remove your own account." });

  const target = await prisma.admin.findUnique({ where: { id: req.params.id }, select: { id: true, email: true, role: true } });
  if (!target) return res.status(404).json({ error: 'Admin not found' });

  if (target.role === 'SUPER_ADMIN') {
    const others = await prisma.admin.count({ where: { role: 'SUPER_ADMIN', id: { not: target.id } } });
    if (others === 0) return res.status(400).json({ error: 'You cannot remove the last super admin.' });
  }

  await prisma.admin.delete({ where: { id: target.id } }); // sessions cascade → access ends immediately
  await audit(req, 'ADMIN_DELETED', { meta: { email: target.email, role: target.role } });
  res.json({ ok: true });
}));

router.get('/audit', requireRole('SUPER_ADMIN'), asyncHandler(async (_req, res) => {
  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { id: true, actorEmail: true, action: true, reportId: true, meta: true, ip: true, createdAt: true },
  });
  res.json({ logs });
}));

export default router;