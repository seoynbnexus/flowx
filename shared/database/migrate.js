import { Umzug } from 'umzug';
import mysql from 'mysql2/promise';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { dbConfig } from './config.js';
import { getPool, closePool } from './connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

const mysqlStorage = {
  async logMigration({ name }) {
    const pool = getPool();
    await pool.execute(
      'INSERT INTO _migrations (name, executed_at) VALUES (?, NOW())',
      [name]
    );
  },

  async unlogMigration({ name }) {
    const pool = getPool();
    await pool.execute('DELETE FROM _migrations WHERE name = ?', [name]);
  },

  async executed() {
    const pool = getPool();
    const [rows] = await pool.execute(
      'SELECT name FROM _migrations ORDER BY name'
    );
    return rows.map(r => r.name);
  },
};

function isMain() {
  const resolved = path.resolve(process.argv[1] || '');
  return resolved === __filename;
}

async function loadMigrations() {
  const files = await fs.readdir(MIGRATIONS_DIR);
  const migrationFiles = files.filter(f => f.endsWith('.js')).sort();

  const migrations = await Promise.all(
    migrationFiles.map(async file => {
      const filePath = path.join(MIGRATIONS_DIR, file);
      const migration = await import(`file://${filePath}`);
      const name = file.replace(/\.js$/, '');

      return {
        name,
        up: async ({ context }) => {
          await migration.up({ context });
        },
        down: async ({ context }) => {
          if (migration.down) {
            await migration.down({ context });
          }
        },
      };
    })
  );

  return migrations;
}

export async function createMigrator(pool) {
  const migrations = await loadMigrations();

  return new Umzug({
    migrations,
    context: pool,
    storage: mysqlStorage,
    logger: console,
  });
}

export async function ensureMigrationTable(pool) {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name VARCHAR(255) PRIMARY KEY,
      executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

export async function ensureDatabase() {
  const conn = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
  });

  try {
    await conn.execute(
      `CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    console.log(`Database '${dbConfig.database}' ensured.`);
  } finally {
    await conn.end();
  }
}

async function runMigrations() {
  await ensureDatabase();

  const pool = getPool();
  await ensureMigrationTable(pool);

  const umzug = await createMigrator(pool);

  const action = process.argv[2] || 'up';

  try {
    if (action === 'up') {
      const pending = await umzug.pending();
      if (pending.length === 0) {
        console.log('No pending migrations.');
      } else {
        const results = await umzug.up();
        results.forEach(r => console.log(`Migrated: ${r.name}`));
      }
    } else if (action === 'down') {
      const results = await umzug.down({ to: 0 });
      results.forEach(r => console.log(`Reverted: ${r.name}`));
    } else if (action === 'list') {
      const executed = await umzug.executed();
      const pending = await umzug.pending();
      console.log('\nExecuted migrations:');
      executed.forEach(e => console.log(`  ✓ ${e.name}`));
      console.log('\nPending migrations:');
      pending.forEach(p => console.log(`  ○ ${p.name}`));
    } else {
      console.error(`Unknown action: ${action}`);
      console.log('Usage: node shared/database/migrate.js [up|down|list]');
      process.exit(1);
    }
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await closePool();
  }
}

if (isMain()) {
  runMigrations();
}
