import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import morgan from 'morgan';
import { getPool } from './shared/database/connection.js';
import { errorHandler } from './shared/middleware/error.middleware.js';
import routes from './src/routes/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:4173',
  'http://192.168.1.11:3001',
  'http://127.0.0.1:5500'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const originUrl = origin.toLowerCase();
    if (allowedOrigins.some(o => o.toLowerCase() === originUrl)) {
      return callback(null, true);
    }
    console.log(`[CORS] Blocked Origin: ${origin}`);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Origin', 'Accept', 'X-Device-Info'],
  exposedHeaders: ['Authorization'],
}));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/privacy-policy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy-policy.html'));
});

app.get('/terms-of-service', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms-of-service.html'));
});

app.use('/api/v1', routes);

app.use(errorHandler);

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    const pool = getPool();
    await pool.getConnection();
    console.log('Database connected');

    const { startCampaignJobWorker } = await import('./src/modules/campaigns/campaign.jobs.js');
    startCampaignJobWorker();
    console.log('Campaign job worker started');

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  const { closePool } = await import('./shared/database/connection.js');
  await closePool();
  process.exit(0);
});

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) start();

export default app;
