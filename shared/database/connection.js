import mysql from 'mysql2/promise';
import { dbConfig } from './config.js';

let pool = null;

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
  const conn = getPool();
  const [rows] = await conn.execute(sql, params);
  return rows;
}

export async function queryOne(sql, params) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

export async function transaction(callback) {
  const conn = getPool();
  const connection = await conn.getConnection();
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
}
