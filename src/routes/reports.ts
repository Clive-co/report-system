// src/routes/reports.ts
import { Router } from 'express';
import { PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { prisma } from '../db';
import { encrypt } from '../crypto';
import { r2 } from '../services/r2';
import { sendReportNotification } from '../services/email';
import { reportSchema, uploadUrlSchema } from '../validation/reportSchema';
import { sanitizeText } from '../utils/sanitize';
import { generateTrackingCode } from '../utils/trackingCode';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

const ALLOWED_EXTENSIONS: Record<string, string[]> = {
  image: ['jpg', 'jpeg', 'png'],
  video: ['mp4', 'mov'],
  document: ['pdf', 'doc', 'docx'],
};

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  mp4: 'video/mp4', mov: 'video/quicktime',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB

router.post('/upload-url', asyncHandler(async (req, res) => {
  const parsed = uploadUrlSchema.safeParse(req.body);
  if (!parsed.success) {
    console.error('upload-url validation failed:', parsed.error.flatten());
    return res.status(400).json({ error: 'Invalid request' });
  }

  const ext = parsed.data.filename.split('.').pop()?.toLowerCase() ?? '';
  const allowed = ALLOWED_EXTENSIONS[parsed.data.type] ?? [];
  if (!allowed.includes(ext)) {
    return res.status(400).json({ error: `File type .${ext} is not allowed for ${parsed.data.type}` });
  }

  const key = `reports/${randomUUID()}.${ext}`;
  const uploadUrl = await getSignedUrl(
    r2,
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET!,
      Key: key,
      ContentType: CONTENT_TYPES[ext],
    }),
    { expiresIn: 300 }
  );

  // A presigned PUT can't enforce a max size, so the size is verified server-side
  // (HeadObject) when the report is submitted — see verifyMedia below.
  res.json({ uploadUrl, key, maxBytes: MAX_UPLOAD_BYTES });
}));

function mediaTypeFromKey(key: string): 'image' | 'video' | 'document' {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png'].includes(ext)) return 'image';
  if (['mp4', 'mov'].includes(ext)) return 'video';
  return 'document';
}

/** Confirms every key was really uploaded, is within the size cap, and isn't already used. */
async function verifyMedia(keys: string[]): Promise<string | null> {
  if (new Set(keys).size !== keys.length) return 'Duplicate files in report';

  const alreadyUsed = await prisma.media.count({ where: { key: { in: keys } } });
  if (alreadyUsed > 0) return 'A file is already attached to another report';

  for (const key of keys) {
    try {
      const head = await r2.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: key }));
      const size = head.ContentLength ?? 0;
      if (size === 0) return 'An uploaded file is empty';
      if (size > MAX_UPLOAD_BYTES) {
        await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: key })).catch(() => {});
        return 'An uploaded file is over 50MB';
      }
    } catch {
      return 'An uploaded file could not be found. Please upload it again.';
    }
  }
  return null;
}

router.post('/', asyncHandler(async (req, res) => {
  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' });
  const { state, city, mediaKeys, informant } = parsed.data;

  // defense in depth — sanitize again even though the frontend already did
  const address = sanitizeText(parsed.data.address);
  const description = sanitizeText(parsed.data.description);

  const mediaProblem = await verifyMedia(mediaKeys);
  if (mediaProblem) return res.status(400).json({ error: mediaProblem });

  // The tracking code is unique in the DB; on the (astronomically unlikely) collision, retry.
  let report: Awaited<ReturnType<typeof createReport>> | null = null;
  for (let attempt = 0; attempt < 5 && !report; attempt++) {
    try {
      report = await createReport(generateTrackingCode());
    } catch (err: any) {
      const collision = err?.code === 'P2002' && String(err?.meta?.target).includes('trackingCode');
      if (!collision) throw err;
    }
  }
  if (!report) return res.status(500).json({ error: 'Could not create report' });

  function createReport(trackingCode: string) {
    return prisma.report.create({
      data: {
        trackingCode,
        state, city, address, description,
        media: { create: mediaKeys.map((key) => ({ key, type: mediaTypeFromKey(key) })) },
        events: { create: { toStatus: 'RECEIVED' } }, // first entry in the status history
        informant: informant
          ? {
              create: {
                nameEnc: informant.name ? encrypt(sanitizeText(informant.name)) : null,
                phoneEnc: informant.phone ? encrypt(sanitizeText(informant.phone)) : null,
                emailEnc: informant.email ? encrypt(sanitizeText(informant.email)) : null,
                addressEnc: informant.address ? encrypt(sanitizeText(informant.address)) : null,
              },
            }
          : undefined,
      },
      include: { media: true },
    });
  }

  // The tracking code is the only identifier returned to the reporter.
  res.status(201).json({ trackingCode: report.trackingCode });

  // Minimal on purpose: location, time and counts only. Details and evidence are read in the case desk.
  sendReportNotification({
    trackingCode: report.trackingCode ?? report.id,
    state: report.state,
    city: report.city,
    createdAt: report.createdAt,
    mediaCount: report.media.length,
    anonymous: !informant,
  }).catch((err) => console.error('Failed to send report notification:', err));
}));

// NOTE: the old public /media/:id/view signed-link route was removed. Evidence is now only
// reachable through the authenticated, role-checked /api/admin/media/:id/stream (super admin only).
// Links inside old notification emails stop working as a result, which is intended.

export default router;