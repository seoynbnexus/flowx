import mysql from 'mysql2/promise';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dbConfig } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const INITIAL_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '001_initial_schema.js');

const INITIAL_TABLES = [
  'users', 'user_profiles', 'user_passwords', 'user_sessions',
  'roles', 'permissions', 'role_permissions', 'user_roles',
  'oauth_providers', 'oauth_accounts', 'oauth_tokens',
  'email_verifications', 'password_resets', 'phone_otps',
  'audit_logs', 'auth_login_history',
];

function parseCreateTable(sql) {
  const tables = {};
  const blockRegex = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\)\s*ENGINE=/gi;
  let match;

  while ((match = blockRegex.exec(sql)) !== null) {
    const tableName = match[1];
    const columns = [];
    const body = match[2];

    const columnRegex = /^\s+`?(\w+)`?\s+(\w+(?:\s*\([^)]*\))?(?:\s+\w+)*)/gm;
    let colMatch;
    while ((colMatch = columnRegex.exec(body)) !== null) {
      const name = colMatch[1];
      const type = colMatch[2].trim();
      if (!/^(PRIMARY|KEY|UNIQUE|CONSTRAINT|INDEX|FULLTEXT)/i.test(type)) {
        columns.push({ name, type });
      }
    }

    if (columns.length > 0) {
      tables[tableName] = columns;
    }
  }

  return tables;
}

async function getCurrentSchema(conn) {
  const [tables] = await conn.execute(
    "SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'",
    [dbConfig.database]
  );

  const schema = {};
  for (const { TABLE_NAME } of tables) {
    const [cols] = await conn.execute(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ?
       ORDER BY ORDINAL_POSITION`,
      [dbConfig.database, TABLE_NAME]
    );

    schema[TABLE_NAME] = cols.map(c => ({
      name: c.COLUMN_NAME,
      type: c.COLUMN_TYPE,
      nullable: c.IS_NULLABLE === 'YES',
      default: c.COLUMN_DEFAULT,
      extra: c.EXTRA,
    }));
  }

  return schema;
}

function mapType(col) {
  let sql = col.type.toUpperCase();

  if (col.extra && col.extra.includes('DEFAULT_GENERATED')) {
    if (col.default && col.default.startsWith('(')) {
      sql += ` DEFAULT ${col.default}`;
    }
  }

  if (!col.nullable) {
    sql += ' NOT NULL';
  }

  if (col.extra && col.extra.includes('on update CURRENT_TIMESTAMP')) {
    sql += ' ON UPDATE CURRENT_TIMESTAMP';
  } else if (col.default !== null && !col.extra?.includes('DEFAULT_GENERATED')) {
    if (col.default === 'CURRENT_TIMESTAMP') {
      sql += ' DEFAULT CURRENT_TIMESTAMP';
    } else if (typeof col.default === 'string' && !col.default.startsWith('(')) {
      sql += ` DEFAULT '${col.default}'`;
    } else if (col.default !== null) {
      sql += ` DEFAULT ${col.default}`;
    }
  }

  if (col.extra === 'auto_increment') {
    sql += ' AUTO_INCREMENT';
  }

  return sql;
}

function generateCreateTable(tableName, columns) {
  const cols = columns.map(c => `  \`${c.name}\` ${mapType(c)}`).join(',\n');
  return `CREATE TABLE IF NOT EXISTS \`${tableName}\` (\n${cols}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`;
}

function generateAddColumn(tableName, column) {
  return `ALTER TABLE \`${tableName}\` ADD COLUMN \`${column.name}\` ${mapType(column)};`;
}

function generateDropColumn(tableName, column) {
  return `ALTER TABLE \`${tableName}\` DROP COLUMN \`${column.name}\`;`;
}

async function run() {
  let initialContent;
  try {
    initialContent = await fs.readFile(INITIAL_MIGRATION_PATH, 'utf8');
  } catch {
    console.error('Could not read 001_initial_schema.js');
    process.exit(1);
  }

  const baselineTables = parseCreateTable(initialContent);

  const conn = await mysql.createConnection({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
  });
  let currentSchema;
  try {
    await conn.execute(`USE \`${dbConfig.database}\``);
    currentSchema = await getCurrentSchema(conn);
  } catch {
    currentSchema = {};
  } finally {
    await conn.end();
  }

  const newTables = [];
  const newColumns = [];

  for (const [tableName, columns] of Object.entries(currentSchema)) {
    if (tableName === '_migrations') continue;

    if (!INITIAL_TABLES.includes(tableName)) {
      newTables.push({ name: tableName, columns });
    } else if (baselineTables[tableName]) {
      const baselineNames = new Set(baselineTables[tableName].map(c => c.name));
      for (const col of columns) {
        if (!baselineNames.has(col.name)) {
          newColumns.push({ table: tableName, column: col });
        }
      }
    }
  }

  const upStatements = [];
  const downStatements = [];

  for (const table of newTables) {
    upStatements.push(generateCreateTable(table.name, table.columns));
    downStatements.push(`DROP TABLE IF EXISTS \`${table.name}\`;`);
  }

  for (const { table, column } of newColumns) {
    upStatements.push(generateAddColumn(table, column));
    downStatements.push(generateDropColumn(table, column));
  }

  if (upStatements.length === 0) {
    console.log('Schema is in sync — no changes detected.');
    await fs.writeFile(
      path.join(MIGRATIONS_DIR, '002_schema_sync.js'),
      schemaTemplate([], [])
    );
    console.log('Generated 002_schema_sync.js (empty — no diff).');
    return;
  }

  await fs.writeFile(
    path.join(MIGRATIONS_DIR, '002_schema_sync.js'),
    schemaTemplate(upStatements, downStatements.reverse())
  );

  console.log(`\nGenerated 002_schema_sync.js:`);
  if (newTables.length > 0) {
    console.log(`  New tables: ${newTables.map(t => t.name).join(', ')}`);
  }
  if (newColumns.length > 0) {
    console.log(`  New columns: ${newColumns.map(c => `${c.table}.${c.column.name}`).join(', ')}`);
  }
  console.log(`\nReview then run: npm run migrate:up`);
}

function schemaTemplate(upStatements, downStatements) {
  const up = upStatements.map(s => `  await pool.execute(\`${s}\`);`).join('\n');
  const down = downStatements.map(s => `  await pool.execute(\`${s}\`);`).join('\n');

  return `export async function up({ context: pool }) {
${up}
}

export async function down({ context: pool }) {
${down}
}
`;
}

run().catch(err => {
  console.error('Schema sync failed:', err.message);
  process.exit(1);
});
