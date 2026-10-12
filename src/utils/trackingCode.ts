// src/utils/trackingCode.ts
import { randomInt } from 'crypto';

// 30 unambiguous characters (no 0/1/I/L/O/U). 10 chars ≈ 49 bits of entropy,
// which is not guessable even before rate limiting is applied.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateTrackingCode(): string {
  let raw = '';
  for (let i = 0; i < 10; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return `ICPC-${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** Accepts "icpc 7k3m9 qxr2t", "ICPC-7K3M9-QXR2T", etc. Returns canonical form or null. */
export function normalizeTrackingCode(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^ICPC/, '');
  if (!/^[2-9A-HJKMNP-TV-Z]{10}$/.test(cleaned)) return null;
  return `ICPC-${cleaned.slice(0, 5)}-${cleaned.slice(5)}`;
}