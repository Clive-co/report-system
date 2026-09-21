"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendReportNotification = sendReportNotification;
// src/services/email.ts
const nodemailer_1 = __importDefault(require("nodemailer"));
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const mediaToken_1 = require("../utils/mediaToken");
const r2_1 = require("./r2");
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
function getTransporter() {
    return nodemailer_1.default.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT),
        secure: process.env.SMTP_PORT === '465',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
}
function buildPermanentLink(mediaId) {
    const token = (0, mediaToken_1.signMediaToken)(mediaId);
    return `${process.env.PUBLIC_API_URL}/api/reports/media/${mediaId}/view?token=${token}`;
}
async function getVideoLink(key) {
    return (0, s3_request_presigner_1.getSignedUrl)(r2_1.r2, new client_s3_1.GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }), { expiresIn: 60 * 60 * 24 });
}
async function fetchImageAttachment(key) {
    try {
        const obj = await r2_1.r2.send(new client_s3_1.GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
        const body = await obj.Body?.transformToByteArray();
        if (!body || body.byteLength > MAX_ATTACHMENT_BYTES)
            return null;
        return { filename: key.split('/').pop(), content: Buffer.from(body) };
    }
    catch {
        return null;
    }
}
async function sendReportNotification(report) {
    const images = report.media.filter((m) => m.type === 'image');
    const videos = report.media.filter((m) => m.type === 'video');
    const documents = report.media.filter((m) => m.type === 'document');
    const attachments = (await Promise.all(images.map((img) => fetchImageAttachment(img.key)))).filter((a) => a !== null);
    const fileLinksHtml = (videos.length || documents.length)
        ? `<p><strong>Video and document evidence (permanent link — always works):</strong><br/>${[...videos, ...documents]
            .map((m) => `<a href="${buildPermanentLink(m.id)}">${m.key.split('/').pop()}</a>`)
            .join('<br/>')}</p>`
        : '';
    // also give images a permanent link even though small ones are attached inline,
    // in case an attachment was skipped for being over MAX_ATTACHMENT_BYTES
    const imageLinksHtml = images.length
        ? `<p style="font-size:12px;color:#888">Full-resolution image links: ${images
            .map((m, i) => `<a href="${buildPermanentLink(m.id)}">image ${i + 1}</a>`)
            .join(', ')}</p>`
        : '';
    const informantHtml = report.informant
        ? `
      <h3>Informant details (optional, provided by reporter)</h3>
      <p>
        Name: ${report.informant.name || 'Not provided'}<br/>
        Phone: ${report.informant.phone || 'Not provided'}<br/>
        Email: ${report.informant.email || 'Not provided'}<br/>
        Address: ${report.informant.address || 'Not provided'}
      </p>`
        : `<p><em>Report submitted anonymously — no informant details provided.</em></p>`;
    const html = `
    <h2>New corruption report</h2>
    <p style="color:#666;font-size:13px">Reference: ${report.id}</p>
    <p><strong>Submitted:</strong> ${report.createdAt.toISOString()}</p>
    <h3>Case details</h3>
    <p>State: ${report.state}<br/>City: ${report.city}<br/>Address: ${report.address}</p>
    <h3>Report description</h3>
    <p>${report.description.replace(/\n/g, '<br/>')}</p>
    <p><strong>Attached images:</strong> ${images.length} &middot; <strong>Videos:</strong> ${videos.length}</p>
    ${fileLinksHtml}
    ${informantHtml}
  `;
    await getTransporter().sendMail({
        from: process.env.SMTP_FROM,
        to: process.env.REPORT_NOTIFICATION_EMAIL,
        bcc: process.env.INTERNAL_AUDIT_EMAIL,
        subject: `New ICPC report from ${report.state}, ${report.city}`,
        html,
        attachments,
    });
}
