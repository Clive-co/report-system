// src/routes/track.ts
//
// Public, unauthenticated status lookup for reporters. Anyone holding a tracking code
// can see the status and the public notes — nothing else (no location, description,
// evidence, informant or internal notes).
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { asyncHandler } from '../utils/asyncHandler';
import { normalizeTrackingCode } from '../utils/trackingCode';

const router = Router();

// POST (not GET) so codes never end up in URLs / proxy access logs.
const trackSchema = z.object({
  codes: z.array(z.string().max(40)).min(1).max(10),
});

router.post('/', asyncHandler(async (req, res) => {
  const parsed = trackSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });

  const { codes } = parsed.data;
  const normalized = codes.map((c) => normalizeTrackingCode(c));
  const valid = [...new Set(normalized.filter((c): c is string => !!c))];

  const rows = valid.length
    ? await prisma.report.findMany({
        where: { trackingCode: { in: valid } }, // unique index lookup
        select: {
          trackingCode: true,
          status: true,
          createdAt: true,
          statusUpdatedAt: true,
          events: {
            orderBy: { createdAt: 'asc' },
            take: 50,
            select: { toStatus: true, publicNote: true, createdAt: true },
          },
        },
      })
    : [];

  const found = new Set(rows.map((r) => r.trackingCode));
  const notFound = codes.filter((_, i) => !normalized[i] || !found.has(normalized[i]!));

  res.set('Cache-Control', 'no-store');
  res.json({
    results: rows.map((r) => ({
      trackingCode: r.trackingCode,
      status: r.status,
      createdAt: r.createdAt,
      statusUpdatedAt: r.statusUpdatedAt,
      history: r.events.map((e) => ({ status: e.toStatus, note: e.publicNote, at: e.createdAt })),
    })),
    notFound,
  });
}));

export default router;