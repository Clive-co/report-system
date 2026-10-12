// src/index.ts
import 'dotenv/config';
import path from 'path';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import reportsRouter from './routes/reports';
import trackRouter from './routes/track';
import adminRouter from './routes/admin';

const app = express();
const isProd = process.env.NODE_ENV === 'production';

// Railway sits behind a reverse proxy that sets X-Forwarded-For.
// This MUST be set before any middleware (rate-limit especially) reads req.ip.
app.set('trust proxy', 1);

// The dashboard is served from this same server, so its CSP can be strict:
// only our own scripts/styles, and evidence images/videos from R2 signed links.
const R2_HOSTS = 'https://*.r2.cloudflarestorage.com';
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'img-src': ["'self'", 'data:', R2_HOSTS],
        'media-src': ["'self'", R2_HOSTS],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
        // don't force https on http://localhost during development
        'upgrade-insecure-requests': isProd ? [] : null,
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  })
);
app.use(cors({ origin: false })); // the dashboard is same-origin; the mobile app doesn't need CORS
app.use(express.json({ limit: '50kb' }));

// ── Official dashboard (static files) ──
app.use(
  '/admin',
  express.static(path.join(__dirname, '..', 'public', 'admin'), {
    index: 'index.html',
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  })
);

// ── Public: submit a report ──
app.use(
  '/api/reports',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    // belt-and-suspenders: even if trust proxy is ever misconfigured again,
    // don't let the rate limiter's own header validation crash the server
    validate: { xForwardedForHeader: false },
  }),
  reportsRouter
);

// ── Public: check report status (its own, more generous limit for app refreshes;
//    still far too low to brute-force a ~49-bit tracking code) ──
app.use(
  '/api/track',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
  }),
  trackRouter
);

// ── Officials only ──
app.use('/api/admin', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store'); // never cache report data in browsers or proxies
  next();
});
app.use(
  '/api/admin',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
  }),
  adminRouter
);

// Catches errors thrown by upstream middleware (e.g. express.json() failing
// to parse a malformed/mislabeled body) and by async route handlers (via asyncHandler).
// Only metadata is logged — never request bodies, which can contain personal details.
const DB_UNAVAILABLE_CODES = new Set(['P1001', 'P1002', 'P1017', 'P2024']);

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled request error:', {
    message: err?.message,
    type: err?.type,
    status: err?.status || err?.statusCode,
    path: req.path,
    contentType: req.headers['content-type'],
    contentLength: req.headers['content-length'],
  });

  // Database temporarily unreachable: tell the client it's transient (503) so it can retry,
  // instead of a generic 500.
  if (DB_UNAVAILABLE_CODES.has(err?.code ?? err?.errorCode)) {
    return res.status(503).json({ error: 'The server is temporarily unable to reach its database. Please try again in a moment.' });
  }

  res.status(err?.status || err?.statusCode || 500).json({ error: 'Server error' });
});

const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
