import mysql from 'mysql2/promise';
import { AsyncLocalStorage } from 'node:async_hooks';
import { dbConfig } from './config.js';

let pool = null;

const als = new AsyncLocalStorage();

export function getPool() {
  if (!pool) {
    pool = mysql.createPool(dbConfig);
    pool.on('connection', (conn) => {
      conn.execute("SET time_zone = '+00:00'");
    });
  }
  return pool;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function query(sql, params) {
  const store = als.getStore();
  const conn = store?.activeTransaction || getPool();
  const [rows] = await conn.execute(sql, params);
  return rows;
}

export async function queryOne(sql, params) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

export async function transaction(callback) {
  const existing = als.getStore()?.activeTransaction;
  if (existing) return await callback(existing);

  const connection = await getPool().getConnection();
  const store = { activeTransaction: connection };
  return als.run(store, async () => {
    try {
      await connection.beginTransaction();
      const result = await callback(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  });
}
