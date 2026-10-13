// src/middleware/adminAuth.ts
//
// Server-side sessions instead of JWTs: the cookie holds a random opaque token,
// only its SHA-256 hash is stored, so a DB leak can't be replayed and deleting
// an admin or logging out revokes access immediately.
import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { prisma } from '../db';
import { permissionsFor } from '../auth/permissions';
import type { Permission, Role } from '../auth/permissions';

export const COOKIE_NAME = 'icpc_sid';
const IDLE_MS = 30 * 60 * 1000; // sign out after 30 min of inactivity
const ABSOLUTE_MS = 8 * 60 * 60 * 1000; // and never stay signed in longer than 8 h
const TOUCH_INTERVAL_MS = 60 * 1000; // avoid a DB write on every request
const isProd = process.env.NODE_ENV === 'production';

export type AuthedAdmin = {
  id: string;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
  permissions: Permission[];
};

export function toAuthed(a: { id: string; email: string; name: string; role: string; mustChangePassword: boolean }): AuthedAdmin {
  return {
    id: a.id,
    email: a.email,
    name: a.name,
    role: a.role as Role,
    mustChangePassword: a.mustChangePassword,
    permissions: permissionsFor(a.role),
  };
}

declare global {
  namespace Express {
    interface Request {
      admin?: AuthedAdmin;
      sessionId?: string;
    }
  }
}

const cookieOptions = {
  httpOnly: true, // not readable from JS → XSS can't steal it
  secure: isProd, // HTTPS only in production
  sameSite: 'strict' as const, // never sent on cross-site requests
  path: '/api/admin', // not sent to the public API at all
};

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function readSessionToken(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === COOKIE_NAME) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: ABSOLUTE_MS });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(COOKIE_NAME, cookieOptions);
}

export async function createSession(adminId: string, req: Request) {
  const token = crypto.randomBytes(32).toString('base64url');
  await prisma.adminSession.create({
    data: {
      tokenHash: hashToken(token),
      adminId,
      expiresAt: new Date(Date.now() + ABSOLUTE_MS),
      ip: req.ip,
      userAgent: (req.get('user-agent') || '').slice(0, 250),
    },
  });
  return token;
}

/**
 * CSRF defence on top of SameSite=Strict: every state-changing request must carry a
 * custom header (browsers can't add it on cross-site form posts) and, if the browser
 * sends an Origin, it must be the very host this request arrived on. Comparing against
 * the request's own host (instead of an env var) means it works unchanged on localhost
 * and on Railway; a page on any other site can never match it.
 */
export function csrfGuard(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  if (req.get('x-requested-with') !== 'icpc-dashboard') {
    console.warn('[admin] blocked: missing X-Requested-With header', { path: req.path });
    return res.status(403).json({ error: 'Forbidden' });
  }

  const origin = req.get('origin');
  if (origin) {
    // req.protocol honours X-Forwarded-Proto because `trust proxy` is set in index.ts
    const expected = `${req.protocol}://${req.get('host')}`;
    if (origin !== expected) {
      console.warn('[admin] blocked: origin mismatch', { origin, expected, path: req.path });
      return res.status(403).json({ error: 'Forbidden' });
    }
  }
  next();
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const token = readSessionToken(req);
    if (!token) return res.status(401).json({ error: 'Not signed in' });

    const session = await prisma.adminSession.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { admin: true },
    });
    if (!session) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Not signed in' });
    }

    const now = Date.now();
    if (session.expiresAt.getTime() < now || now - session.lastSeenAt.getTime() > IDLE_MS) {
      await prisma.adminSession.delete({ where: { id: session.id } }).catch(() => {});
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Session expired' });
    }

    if (now - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await prisma.adminSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
    }

    req.admin = toAuthed(session.admin);
    req.sessionId = session.id;
    next();
  } catch (err) {
    next(err);
  }
}

// Someone holding a temporary password can do nothing except change it.
const ALLOWED_WHILE_PASSWORD_PENDING = new Set(['/auth/me', '/auth/change-password', '/auth/logout']);
export function enforcePasswordChange(req: Request, res: Response, next: NextFunction) {
  if (req.admin?.mustChangePassword && !ALLOWED_WHILE_PASSWORD_PENDING.has(req.path)) {
    return res.status(403).json({ error: 'You must change your temporary password first.', code: 'PASSWORD_CHANGE_REQUIRED' });
  }
  next();
}

export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.admin?.permissions.includes(permission)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}