import { v7 as generateUuid } from 'uuid';

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

async function addColumnIfMissing(pool, table, column, definition) {
  try {
    const [rows] = await pool.query(`SHOW COLUMNS FROM \`${table}\` WHERE Field = ?`, [column]);
    if (rows.length === 0) {
      await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`);
      console.log(`  + Added column ${table}.${column}`);
    } else {
      console.log(`  ~ Column ${table}.${column} already exists, skipping`);
    }
  } catch (error) {
    console.error(`  ! Error adding ${table}.${column}: ${error.message}`);
    throw error;
  }
}

export async function up({ context: pool }) {
  await addColumnIfMissing(pool, 'user_platform_accounts', 'token_type',
    "token_type ENUM('user', 'page', 'permanent') NOT NULL DEFAULT 'user' AFTER token_status");

  await addColumnIfMissing(pool, 'platforms', 'token_refresh_strategy',
    "token_refresh_strategy VARCHAR(50) DEFAULT NULL AFTER icon_url");

  await addColumnIfMissing(pool, 'platforms', 'default_token_type',
    "default_token_type ENUM('user', 'page', 'permanent') NOT NULL DEFAULT 'user' AFTER token_refresh_strategy");

  try {
    await pool.query(
      `UPDATE platforms SET token_refresh_strategy = 'none', default_token_type = 'page' WHERE code = 'facebook'`
    );
    console.log('  ~ Updated facebook platform: token_refresh_strategy=none, default_token_type=page');

    await pool.query(
      `UPDATE platforms SET token_refresh_strategy = 'meta_exchange', default_token_type = 'user' WHERE code = 'instagram'`
    );
    console.log('  ~ Updated instagram platform: token_refresh_strategy=meta_exchange, default_token_type=user');
  } catch (error) {
    console.error(`  ! Error seeding platform configs: ${error.message}`);
    throw error;
  }
}

export async function down({ context: pool }) {
  try {
    const [rows] = await pool.query(`SHOW COLUMNS FROM user_platform_accounts WHERE Field = 'token_type'`);
    if (rows.length > 0) {
      await pool.query('ALTER TABLE user_platform_accounts DROP COLUMN token_type');
      console.log('  - Dropped column user_platform_accounts.token_type');
    }
  } catch (error) {
    console.error(`  ! Error dropping token_type: ${error.message}`);
  }

  const platformColumns = ['default_token_type', 'token_refresh_strategy'];
  for (const column of platformColumns) {
    try {
      const [rows] = await pool.query(`SHOW COLUMNS FROM platforms WHERE Field = ?`, [column]);
      if (rows.length > 0) {
        await pool.query(`ALTER TABLE platforms DROP COLUMN \`${column}\``);
        console.log(`  - Dropped column platforms.${column}`);
      }
    } catch (error) {
      console.error(`  ! Error dropping platforms.${column}: ${error.message}`);
    }
  }
}

export default { up, down };
