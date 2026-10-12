// src/utils/asyncHandler.ts
// Express 4 doesn't catch rejected promises from async handlers: without this,
// a DB error leaves the request hanging. This forwards them to the error middleware.
import type { Request, Response, NextFunction, RequestHandler } from 'express';

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };