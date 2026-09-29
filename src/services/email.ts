// src/services/email.ts
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { signMediaToken } from '../utils/mediaToken';
import { r2 } from './r2';

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
// Brevo caps the combined size of attachments on a transactional email (~4MB).
// Anything that doesn't fit is still reachable through its permanent link.
const MAX_TOTAL_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

type ReportForEmail = {
  id: string;
  state: string;
  city: string;
  address: string;
  description: string;
  createdAt: Date;
  media: { id: string; key: string; type: string }[];
  informant?: { name?: string; phone?: string; email?: string; address?: string } | null;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fileName(key: string): string {
  return key.split('/').pop()!;
}

function buildPermanentLink(mediaId: string): string {
  const token = signMediaToken(mediaId);
  return `${process.env.PUBLIC_API_URL}/api/reports/media/${mediaId}/view?token=${token}`;
}

async function fetchAttachment(key: string) {
  try {
    const obj = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: key }));
    const body = await obj.Body?.transformToByteArray();
    if (!body || body.byteLength > MAX_ATTACHMENT_BYTES) {
      console.warn(`[email] skipping attachment (empty or over size limit): ${key}`);
      return null;
    }
    return { filename: fileName(key), content: Buffer.from(body) };
  } catch (err) {
    console.error(`[email] failed to fetch attachment ${key}:`, err);
    return null;
  }
}

export async function sendReportNotification(report: ReportForEmail) {
  const images = report.media.filter((m) => m.type === 'image');
  const videos = report.media.filter((m) => m.type === 'video');
  const documents = report.media.filter((m) => m.type === 'document');

  console.log(
    `[email] preparing report ${report.id}: ${images.length} image(s), ${videos.length} video(s), ${documents.length} document(s)`
  );

  // Attach images and documents (videos are too large — link only).
  const candidates = [...images, ...documents];
  const fetched = await Promise.all(candidates.map((m) => fetchAttachment(m.key)));

  const attachments: { filename: string; content: Buffer }[] = [];
  let totalBytes = 0;
  for (const a of fetched) {
    if (!a) continue;
    if (totalBytes + a.content.byteLength > MAX_TOTAL_ATTACHMENT_BYTES) {
      console.warn(`[email] skipping ${a.filename}: total attachment cap reached`);
      continue;
    }
    totalBytes += a.content.byteLength;
    attachments.push(a);
  }

  const fileLinksHtml =
    videos.length || documents.length
      ? `<p><strong>Video and document evidence (permanent link — always works):</strong><br/>${[
          ...videos,
          ...documents,
        ]
          .map((m) => `<a href="${buildPermanentLink(m.id)}">${escapeHtml(fileName(m.key))}</a>`)
          .join('<br/>')}</p>`
      : '';

  const imageLinksHtml = images.length
    ? `<p style="font-size:12px;color:#888">Full-resolution image links: ${images
        .map((m, i) => `<a href="${buildPermanentLink(m.id)}">image ${i + 1}</a>`)
        .join(', ')}</p>`
    : '';

  const inf = report.informant;
  const informantHtml = inf
    ? `
      <h3>Informant details (optional, provided by reporter)</h3>
      <p>
        Name: ${escapeHtml(inf.name || 'Not provided')}<br/>
        Phone: ${escapeHtml(inf.phone || 'Not provided')}<br/>
        Email: ${escapeHtml(inf.email || 'Not provided')}<br/>
        Address: ${escapeHtml(inf.address || 'Not provided')}
      </p>`
    : `<p><em>Report submitted anonymously — no informant details provided.</em></p>`;

  const html = `
    <h2>New corruption report</h2>
    <p style="color:#666;font-size:13px">Reference: ${escapeHtml(report.id)}</p>
    <p><strong>Submitted:</strong> ${report.createdAt.toISOString()}</p>
    <h3>Case details</h3>
    <p>State: ${escapeHtml(report.state)}<br/>City: ${escapeHtml(report.city)}<br/>Address: ${escapeHtml(report.address)}</p>
    <h3>Report description</h3>
    <p>${escapeHtml(report.description).replace(/\n/g, '<br/>')}</p>
    <p><strong>Attached images:</strong> ${images.length} &middot; <strong>Videos:</strong> ${videos.length} &middot; <strong>Documents:</strong> ${documents.length}</p>
    ${fileLinksHtml}
    ${imageLinksHtml}
    ${informantHtml}
  `;

  console.log(
    `[email] sending report ${report.id} to Brevo with ${attachments.length} attachment(s), ${totalBytes} bytes`
  );

  const res = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'api-key': process.env.BREVO_API_KEY!,
    },
    body: JSON.stringify({
      sender: { email: process.env.EMAIL_FROM, name: 'ICPC Reports' },
      to: [{ email: process.env.REPORT_NOTIFICATION_EMAIL }],
      bcc: process.env.INTERNAL_AUDIT_EMAIL ? [{ email: process.env.INTERNAL_AUDIT_EMAIL }] : undefined,
      subject: `New ICPC report from ${report.state}, ${report.city}`,
      htmlContent: html,
      ...(attachments.length > 0
        ? {
            attachment: attachments.map((a) => ({
              name: a.filename,
              content: a.content.toString('base64'),
            })),
          }
        : {}),
    }),
  });

  const responseText = await res.text().catch(() => '');

  if (!res.ok) {
    throw new Error(`Brevo send failed: ${res.status} ${responseText}`);
  }

  // Brevo returns { messageId } on acceptance. Search for this id in
  // Brevo > Transactional > Logs to see whether it was delivered, blocked or bounced.
  console.log(`[email] Brevo accepted report ${report.id}: ${res.status} ${responseText}`);
}