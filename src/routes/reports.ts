// src/routes/reports.ts
import { Router } from 'express';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { prisma } from '../db';
import { encrypt } from '../crypto';
import { r2 } from '../services/r2';
import { sendReportNotification } from '../services/email';
import { verifyMediaToken } from '../utils/mediaToken';
import { reportSchema, uploadUrlSchema } from '../validation/reportSchema';
import { getFreshMediaLink } from '../services/media';
import { sanitizeText } from '../utils/sanitize';

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

router.post('/upload-url', async (req, res) => {
  const parsed = uploadUrlSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });

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

  // Note: presigned PUT can't enforce a max size server-side the way a POST policy
  // can — the 50MB cap is enforced client-side before this endpoint is even called.
  res.json({ uploadUrl, key, maxBytes: MAX_UPLOAD_BYTES });
});

function mediaTypeFromKey(key: string): 'image' | 'video' | 'document' {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png'].includes(ext)) return 'image';
  if (['mp4', 'mov'].includes(ext)) return 'video';
  return 'document';
}

router.post('/', async (req, res) => {
  const parsed = reportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' });
  const { state, city, mediaKeys, informant } = parsed.data;

  // defense in depth — sanitize again even though the frontend already did
  const address = sanitizeText(parsed.data.address);
  const description = sanitizeText(parsed.data.description);

  const report = await prisma.report.create({
    data: {
      state, city, address, description,
      media: { create: mediaKeys.map((key) => ({ key, type: mediaTypeFromKey(key) })) },
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

  res.status(201).json({ id: report.id });

  sendReportNotification({
    id: report.id,
    state: report.state,
    city: report.city,
    address: report.address,
    description: report.description,
    createdAt: report.createdAt,
    media: report.media,
    informant: informant ?? null,
  }).catch((err) => console.error('Failed to send report notification:', err));
});

// Staff-only: regenerate a fresh, working link for a piece of evidence whose
// email link has expired. Storage in R2 never expires — only the signed URL does.
router.get('/:reportId/media/:mediaId/link', async (req, res) => {
  const staffKey = req.headers['x-staff-key'];
  if (staffKey !== process.env.STAFF_ACCESS_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const media = await prisma.media.findFirst({
    where: { id: req.params.mediaId, reportId: req.params.reportId },
  });
  if (!media) return res.status(404).json({ error: 'Not found' });

  const url = await getFreshMediaLink(media.key);
  res.json({ url, expiresIn: '7 days' });
});

router.get('/media/:mediaId/view', async (req, res) => {
  const { mediaId } = req.params;
  const token = req.query.token as string | undefined;

  if (!token || !verifyMediaToken(mediaId, token)) {
    return res.status(403).send('Invalid or missing access token.');
  }

  const media = await prisma.media.findUnique({ where: { id: mediaId } });
  if (!media) return res.status(404).send('This file is no longer available.');

  const freshUrl = await getFreshMediaLink(media.key);
  res.redirect(302, freshUrl);
});

export default router;