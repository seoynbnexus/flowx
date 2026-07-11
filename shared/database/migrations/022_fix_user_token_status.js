export async function up({ context: pool }) {
  const [platforms] = await pool.query(`SELECT id, code FROM platforms WHERE code IN ('facebook', 'instagram')`);
  const platformMap = {};
  for (const p of platforms) platformMap[p.code] = p.id;

  if (platformMap.facebook) {
    // Fix existing Facebook page accounts that got token_type='user' (pre-migration 020 records)
    await pool.query(
      `UPDATE user_platform_accounts
       SET token_type = 'page', updated_at = NOW()
       WHERE token_type = 'user' AND platform_id = ? AND platform_user_id IS NOT NULL`,
      [platformMap.facebook]
    );
    const [pageFixed] = await pool.query(
      `SELECT COUNT(*) as count FROM user_platform_accounts WHERE token_type = 'page' AND platform_id = ?`,
      [platformMap.facebook]
    );
    console.log(`  ~ Fixed token_type to 'page' for ${pageFixed[0].count} Facebook page(s)`);

    // Fix existing user-level FB tokens — set them verified so they don't appear as pending in admin
    await pool.query(
      `UPDATE user_platform_accounts
       SET verification_status = 'verified', updated_at = NOW()
       WHERE token_type = 'user' AND platform_id = ?`,
      [platformMap.facebook]
    );
    const [userFixed] = await pool.query(
      `SELECT COUNT(*) as count FROM user_platform_accounts WHERE token_type = 'user' AND platform_id = ?`,
      [platformMap.facebook]
    );
    console.log(`  ~ Set verification_status = 'verified' for ${userFixed[0].count} Facebook user-level token(s)`);
  }

  if (platformMap.instagram) {
    // Fix Instagram Business accounts that got token_type='user' — set to 'page'
    await pool.query(
      `UPDATE user_platform_accounts
       SET token_type = 'page', updated_at = NOW()
       WHERE token_type = 'user' AND platform_id = ? AND verification_status = 'verified'`,
      [platformMap.instagram]
    );
    const [igFixed] = await pool.query(
      `SELECT COUNT(*) as count FROM user_platform_accounts WHERE token_type = 'page' AND platform_id = ?`,
      [platformMap.instagram]
    );
    console.log(`  ~ Fixed token_type to 'page' for ${igFixed[0].count} Instagram Business account(s)`);
  }
}

export async function down({ context: pool }) {
  const [platforms] = await pool.query(`SELECT id, code FROM platforms WHERE code IN ('facebook', 'instagram')`);
  const platformMap = {};
  for (const p of platforms) platformMap[p.code] = p.id;

  if (platformMap.facebook) {
    await pool.query(
      `UPDATE user_platform_accounts
       SET token_type = 'user', updated_at = NOW()
       WHERE token_type = 'page' AND platform_id = ? AND platform_user_id IS NOT NULL`,
      [platformMap.facebook]
    );

    await pool.query(
      `UPDATE user_platform_accounts
       SET verification_status = 'pending', updated_at = NOW()
       WHERE token_type = 'user' AND platform_id = ? AND verification_status = 'verified'`,
      [platformMap.facebook]
    );
  }

  if (platformMap.instagram) {
    await pool.query(
      `UPDATE user_platform_accounts
       SET token_type = 'user', updated_at = NOW()
       WHERE token_type = 'page' AND platform_id = ? AND verification_status = 'verified'`,
      [platformMap.instagram]
    );
  }
}

export default { up, down };
