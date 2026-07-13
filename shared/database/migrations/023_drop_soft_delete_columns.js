async function dropColumnIfExists(pool, table, column) {
  try {
    const [rows] = await pool.query(`SHOW COLUMNS FROM \`${table}\` WHERE Field = ?`, [column]);
    if (rows.length > 0) {
      await pool.query(`ALTER TABLE \`${table}\` DROP COLUMN \`${column}\``);
      console.log(`  - Dropped column ${table}.${column}`);
    } else {
      console.log(`  ~ Column ${table}.${column} does not exist, skipping`);
    }
  } catch (error) {
    console.error(`  ! Error dropping ${table}.${column}: ${error.message}`);
    throw error;
  }
}

export async function up({ context: pool }) {
  // Permanently delete all zombie soft-deleted records
  const [toDelete] = await pool.query('SELECT COUNT(*) as count FROM user_platform_accounts WHERE is_active = 0');
  const zombieCount = toDelete[0].count;
  if (zombieCount > 0) {
    await pool.query('DELETE FROM user_platform_accounts WHERE is_active = 0');
    console.log(`  ~ Deleted ${zombieCount} soft-deleted zombie record(s)`);
  } else {
    console.log('  ~ No zombie records to clean up');
  }

  await dropColumnIfExists(pool, 'user_platform_accounts', 'revoked_at');
  await dropColumnIfExists(pool, 'user_platform_accounts', 'is_active');
}

export async function down({ context: pool }) {
  await pool.query(
    'ALTER TABLE user_platform_accounts ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER verified_by'
  );
  console.log('  + Restored column user_platform_accounts.is_active');

  await pool.query(
    'ALTER TABLE user_platform_accounts ADD COLUMN revoked_at TIMESTAMP NULL DEFAULT NULL AFTER is_active'
  );
  console.log('  + Restored column user_platform_accounts.revoked_at');
}

export default { up, down };
