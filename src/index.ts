// src/index.ts
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import reportsRouter from './routes/reports';

const app = express();

// Railway sits behind a reverse proxy that sets X-Forwarded-For.
// This MUST be set before any middleware (rate-limit especially) reads req.ip.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({ origin: false }));
app.use(express.json({ limit: '50kb' }));

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

// Catches errors thrown by upstream middleware (e.g. express.json() failing
// to parse a malformed/mislabeled body) before any route handler runs.
// Without this, those failures return a 400 silently with nothing logged.
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled request error:', {
    message: err?.message,
    type: err?.type,
    status: err?.status || err?.statusCode,
    path: req.path,
    contentType: req.headers['content-type'],
    contentLength: req.headers['content-length'],
  });
  res.status(err?.status || err?.statusCode || 500).json({ error: 'Server error' });
});

const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});