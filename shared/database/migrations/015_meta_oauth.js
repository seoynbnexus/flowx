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
  const table = 'user_platform_accounts';

  await addColumnIfMissing(pool, table, 'instagram_account_type',
    "instagram_account_type ENUM('business', 'creator') DEFAULT NULL AFTER platform_user_id");

  await addColumnIfMissing(pool, table, 'instagram_business_account_id',
    'instagram_business_account_id VARCHAR(255) DEFAULT NULL AFTER instagram_account_type');

  await addColumnIfMissing(pool, table, 'token_status',
    "token_status ENUM('active', 'expired', 'revoked') NOT NULL DEFAULT 'active' AFTER token_expires_at");

  await addColumnIfMissing(pool, table, 'token_issued_at',
    'token_issued_at TIMESTAMP NULL DEFAULT NULL AFTER token_status');

  await addColumnIfMissing(pool, table, 'oauth_provider',
    'oauth_provider VARCHAR(50) DEFAULT NULL AFTER token_issued_at');

  // Seed permission using JS-generated UUID (avoids UUID() SQL function which
  // can fail on MariaDB with mysql.proc version mismatch)
  const permissionId = generateUuid();
  try {
    await pool.query(
      `INSERT IGNORE INTO permissions (id, module, code, name, description)
       VALUES (?, 'platform_accounts', 'platform_accounts.oauth.connect', 'Connect OAuth', 'Connect social media accounts via OAuth')`,
      [uuidToBuffer(permissionId)]
    );
    console.log('  + Seeded permission: platform_accounts.oauth.connect');
  } catch (error) {
    console.error(`  ! Error seeding permission: ${error.message}`);
    throw error;
  }
}

export async function down({ context: pool }) {
  const table = 'user_platform_accounts';

  try {
    await pool.query("DELETE FROM permissions WHERE code = 'platform_accounts.oauth.connect'");
    console.log('  - Removed permission: platform_accounts.oauth.connect');
  } catch (error) {
    console.error(`  ! Error removing permission: ${error.message}`);
  }

  const columns = ['oauth_provider', 'token_issued_at', 'token_status', 'instagram_business_account_id', 'instagram_account_type'];
  for (const column of columns) {
    try {
      const [rows] = await pool.query(`SHOW COLUMNS FROM \`${table}\` WHERE Field = ?`, [column]);
      if (rows.length > 0) {
        await pool.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
        console.log(`  - Dropped column ${table}.${column}`);
      }
    } catch (error) {
      console.error(`  ! Error dropping ${table}.${column}: ${error.message}`);
    }
  }
}

export default { up, down };
