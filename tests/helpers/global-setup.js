import mysql from 'mysql2/promise'

const TEST_DB = 'flowx_test'

export async function setup() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  })
  try {
    await conn.execute(`DROP DATABASE IF EXISTS \`${TEST_DB}\``)
    await conn.execute(`CREATE DATABASE \`${TEST_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  } finally {
    await conn.end()
  }
}

export async function teardown() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  })
  try {
    await conn.execute(`DROP DATABASE IF EXISTS \`${TEST_DB}\``)
  } finally {
    await conn.end()
  }
}
