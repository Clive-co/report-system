"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signMediaToken = signMediaToken;
exports.verifyMediaToken = verifyMediaToken;
// src/utils/mediaToken.ts
const crypto_1 = __importDefault(require("crypto"));
function getSecret() {
    const secret = process.env.MEDIA_LINK_SECRET;
    if (!secret)
        throw new Error('MEDIA_LINK_SECRET is not set');
    return secret;
}
function signMediaToken(mediaId) {
    return crypto_1.default.createHmac('sha256', getSecret()).update(mediaId).digest('base64url');
}
function verifyMediaToken(mediaId, token) {
    const expected = signMediaToken(mediaId);
    // constant-time comparison to avoid timing attacks
    return crypto_1.default.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}
