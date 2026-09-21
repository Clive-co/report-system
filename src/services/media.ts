// src/services/media.ts
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { r2 } from './r2';

const FIFTEEN_MINUTES_SECONDS = 60 * 15;

export async function getFreshMediaLink(key: string) {
  return getSignedUrl(
    r2,
    new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: key }),
    { expiresIn: FIFTEEN_MINUTES_SECONDS }
  );
}