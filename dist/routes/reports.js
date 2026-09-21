"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/reports.ts
const express_1 = require("express");
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const crypto_1 = require("crypto");
const db_1 = require("../db");
const crypto_2 = require("../crypto");
const r2_1 = require("../services/r2");
const email_1 = require("../services/email");
const mediaToken_1 = require("../utils/mediaToken");
const reportSchema_1 = require("../validation/reportSchema");
const media_1 = require("../services/media");
const sanitize_1 = require("../utils/sanitize");
const router = (0, express_1.Router)();
const ALLOWED_EXTENSIONS = {
    image: ['jpg', 'jpeg', 'png'],
    video: ['mp4', 'mov'],
    document: ['pdf', 'doc', 'docx'],
};
const CONTENT_TYPES = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    mp4: 'video/mp4', mov: 'video/quicktime',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB
router.post('/upload-url', async (req, res) => {
    const parsed = reportSchema_1.uploadUrlSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Invalid request' });
    const ext = parsed.data.filename.split('.').pop()?.toLowerCase() ?? '';
    const allowed = ALLOWED_EXTENSIONS[parsed.data.type] ?? [];
    if (!allowed.includes(ext)) {
        return res.status(400).json({ error: `File type .${ext} is not allowed for ${parsed.data.type}` });
    }
    const key = `reports/${(0, crypto_1.randomUUID)()}.${ext}`;
    const uploadUrl = await (0, s3_request_presigner_1.getSignedUrl)(r2_1.r2, new client_s3_1.PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        ContentType: CONTENT_TYPES[ext],
    }), { expiresIn: 300 });
    // Note: presigned PUT can't enforce a max size server-side the way a POST policy
    // can — the 50MB cap is enforced client-side before this endpoint is even called.
    res.json({ uploadUrl, key, maxBytes: MAX_UPLOAD_BYTES });
});
function mediaTypeFromKey(key) {
    const ext = key.split('.').pop()?.toLowerCase() ?? '';
    if (['jpg', 'jpeg', 'png'].includes(ext))
        return 'image';
    if (['mp4', 'mov'].includes(ext))
        return 'video';
    return 'document';
}
router.post('/', async (req, res) => {
    const parsed = reportSchema_1.reportSchema.safeParse(req.body);
    if (!parsed.success)
        return res.status(400).json({ error: 'Invalid payload' });
    const { state, city, mediaKeys, informant } = parsed.data;
    // defense in depth — sanitize again even though the frontend already did
    const address = (0, sanitize_1.sanitizeText)(parsed.data.address);
    const description = (0, sanitize_1.sanitizeText)(parsed.data.description);
    const report = await db_1.prisma.report.create({
        data: {
            state, city, address, description,
            media: { create: mediaKeys.map((key) => ({ key, type: mediaTypeFromKey(key) })) },
            informant: informant
                ? {
                    create: {
                        nameEnc: informant.name ? (0, crypto_2.encrypt)((0, sanitize_1.sanitizeText)(informant.name)) : null,
                        phoneEnc: informant.phone ? (0, crypto_2.encrypt)((0, sanitize_1.sanitizeText)(informant.phone)) : null,
                        emailEnc: informant.email ? (0, crypto_2.encrypt)((0, sanitize_1.sanitizeText)(informant.email)) : null,
                        addressEnc: informant.address ? (0, crypto_2.encrypt)((0, sanitize_1.sanitizeText)(informant.address)) : null,
                    },
                }
                : undefined,
        },
        include: { media: true },
    });
    res.status(201).json({ id: report.id });
    (0, email_1.sendReportNotification)({
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
    const media = await db_1.prisma.media.findFirst({
        where: { id: req.params.mediaId, reportId: req.params.reportId },
    });
    if (!media)
        return res.status(404).json({ error: 'Not found' });
    const url = await (0, media_1.getFreshMediaLink)(media.key);
    res.json({ url, expiresIn: '7 days' });
});
router.get('/media/:mediaId/view', async (req, res) => {
    const { mediaId } = req.params;
    const token = req.query.token;
    if (!token || !(0, mediaToken_1.verifyMediaToken)(mediaId, token)) {
        return res.status(403).send('Invalid or missing access token.');
    }
    const media = await db_1.prisma.media.findUnique({ where: { id: mediaId } });
    if (!media)
        return res.status(404).send('This file is no longer available.');
    const freshUrl = await (0, media_1.getFreshMediaLink)(media.key);
    res.redirect(302, freshUrl);
});
exports.default = router;
