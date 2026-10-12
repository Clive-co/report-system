// src/db.ts
import { PrismaClient } from '@prisma/client';

// Retry only errors where the query provably never ran:
//   P1001 can't reach the database server
//   P1002 database server reached but timed out
//   P2024 timed out waiting for a free pooled connection
// Retrying these is safe even for writes. (P1017 "connection closed" is deliberately
// NOT retried: the write may already have been applied.)
const RETRYABLE = new Set(['P1001', 'P1002', 'P2024']);
const MAX_RETRIES = 2;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const base = new PrismaClient();

export const prisma = base.$extends({
  query: {
    async $allOperations({ args, query }) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await query(args);
        } catch (err: any) {
          // connection-time errors expose `errorCode`, query-time errors expose `code`
          const code = err?.code ?? err?.errorCode;
          if (attempt >= MAX_RETRIES || !RETRYABLE.has(code)) throw err;
          console.warn(`[db] ${code}, retrying (${attempt + 1}/${MAX_RETRIES})`);
          await sleep(500 * (attempt + 1));
        }
      }
    },
  },
});