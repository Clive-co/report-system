// src/utils/mediaToken.ts
import crypto from 'crypto';

function getSecret(): string {
  const secret = process.env.MEDIA_LINK_SECRET;
  if (!secret) throw new Error('MEDIA_LINK_SECRET is not set');
  return secret;
}

export function signMediaToken(mediaId: string): string {
  return crypto.createHmac('sha256', getSecret()).update(mediaId).digest('base64url');
}

export function verifyMediaToken(mediaId: string, token: string): boolean {
  const expected = signMediaToken(mediaId);
  // constant-time comparison to avoid timing attacks
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}