import dotenv from 'dotenv';
dotenv.config();

export const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'flowx',
  waitForConnections: true,
  connectionLimit: parseInt(process.env.DB_POOL_LIMIT || '10', 10),
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  timezone: '+00:00',
};
