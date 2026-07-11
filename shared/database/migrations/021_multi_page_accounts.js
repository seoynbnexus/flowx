export async function up({ context: pool }) {
  const [rows] = await pool.query(`SHOW INDEX FROM user_platform_accounts WHERE Key_name = 'uk_user_platform'`);
  if (rows.length > 0) {
    // Add index on user_id first so fk_upa_user foreign key has an index after dropping uk_user_platform
    await pool.query('ALTER TABLE user_platform_accounts ADD INDEX idx_upa_user_id (user_id)');
    console.log('  + Added index idx_upa_user_id for foreign key support');

    await pool.query('ALTER TABLE user_platform_accounts DROP INDEX uk_user_platform');
    console.log('  - Dropped unique key uk_user_platform (user_id, platform_id)');
  }

  try {
    await pool.query(
      `ALTER TABLE user_platform_accounts
       ADD UNIQUE KEY uk_user_platform_account (user_id, platform_id, platform_user_id(255))`
    );
    console.log('  + Added unique key uk_user_platform_account (user_id, platform_id, platform_user_id)');
  } catch (error) {
    console.error(`  ! Error adding uk_user_platform_account: ${error.message}`);
    throw error;
  }
}

export async function down({ context: pool }) {
  const [rows] = await pool.query(`SHOW INDEX FROM user_platform_accounts WHERE Key_name = 'uk_user_platform_account'`);
  if (rows.length > 0) {
    await pool.query('ALTER TABLE user_platform_accounts DROP INDEX uk_user_platform_account');
    console.log('  - Dropped unique key uk_user_platform_account');
  }

  await pool.query('ALTER TABLE user_platform_accounts DROP INDEX idx_upa_user_id');
  console.log('  - Dropped index idx_upa_user_id');

  try {
    await pool.query(
      'ALTER TABLE user_platform_accounts ADD UNIQUE KEY uk_user_platform (user_id, platform_id)'
    );
    console.log('  + Restored unique key uk_user_platform');
  } catch (error) {
    console.error(`  ! Error restoring uk_user_platform: ${error.message}`);
  }
}

export default { up, down };
