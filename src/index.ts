// src/index.ts
import 'dotenv/config'; // MUST be the first import — everything below reads process.env
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import reportsRouter from './routes/reports';

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: false }));
app.use(express.json({ limit: '50kb' }));

app.use(
  '/api/reports',
  rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true }),
  reportsRouter
);

const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});