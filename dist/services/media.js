"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFreshMediaLink = getFreshMediaLink;
// src/services/media.ts
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const r2_1 = require("./r2");
const FIFTEEN_MINUTES_SECONDS = 60 * 15;
async function getFreshMediaLink(key) {
    return (0, s3_request_presigner_1.getSignedUrl)(r2_1.r2, new client_s3_1.GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }), { expiresIn: FIFTEEN_MINUTES_SECONDS });
}
