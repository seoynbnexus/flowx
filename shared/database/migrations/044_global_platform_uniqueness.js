export async function up({ context: pool }) {
  // 1. Remove cross-user duplicates before adding global unique constraint
  const [duplicates] = await pool.execute(
    `SELECT platform_user_id, platform_id, GROUP_CONCAT(HEX(id) ORDER BY
       CASE verification_status WHEN 'verified' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
       created_at ASC
     SEPARATOR ',') as ordered_ids,
     COUNT(*) as cnt
     FROM user_platform_accounts
     WHERE platform_user_id IS NOT NULL
     GROUP BY platform_user_id, platform_id
     HAVING cnt > 1`
  )

  let removedCount = 0
  for (const group of duplicates) {
    const ids = group.ordered_ids.split(',')
    const keepId = ids[0]
    const removeIds = ids.slice(1)
    if (removeIds.length > 0) {
      const placeholders = removeIds.map(() => '?').join(',')
      const hexIds = removeIds.map(id => Buffer.from(id, 'hex'))
      await pool.execute(
        `DELETE FROM user_platform_accounts WHERE id IN (${placeholders})`,
        hexIds
      )
      removedCount += removeIds.length
    }
  }
  if (removedCount > 0) {
    console.log(`  ~ Removed ${removedCount} duplicate platform account row(s)`)
  }

  // 2. Drop old per-user unique key
  const [oldKey] = await pool.execute(
    `SHOW INDEX FROM user_platform_accounts WHERE Key_name = 'uk_user_platform_account'`
  )
  if (oldKey.length > 0) {
    await pool.execute('ALTER TABLE user_platform_accounts DROP INDEX uk_user_platform_account')
    console.log('  - Dropped per-user unique key uk_user_platform_account')
  }

  // 3. Add index on platform_user_id for global lookup performance
  await pool.execute(
    'ALTER TABLE user_platform_accounts ADD INDEX idx_upa_platform_user_id (platform_user_id(255))'
  )
  console.log('  + Added index idx_upa_platform_user_id')

  // 4. Add global unique key
  await pool.execute(
    `ALTER TABLE user_platform_accounts
     ADD UNIQUE KEY uk_platform_account_global (platform_id, platform_user_id(255))`
  )
  console.log('  + Added global unique key uk_platform_account_global (platform_id, platform_user_id)')
}

export async function down({ context: pool }) {
  // 1. Drop global unique key
  const [globalKey] = await pool.execute(
    `SHOW INDEX FROM user_platform_accounts WHERE Key_name = 'uk_platform_account_global'`
  )
  if (globalKey.length > 0) {
    await pool.execute('ALTER TABLE user_platform_accounts DROP INDEX uk_platform_account_global')
    console.log('  - Dropped global unique key uk_platform_account_global')
  }

  // 2. Drop platform_user_id index if no other key uses it
  const [idxCheck] = await pool.execute(
    `SHOW INDEX FROM user_platform_accounts WHERE Key_name = 'idx_upa_platform_user_id'`
  )
  if (idxCheck.length > 0) {
    await pool.execute('ALTER TABLE user_platform_accounts DROP INDEX idx_upa_platform_user_id')
    console.log('  - Dropped index idx_upa_platform_user_id')
  }

  // 3. Restore per-user unique key
  try {
    await pool.execute(
      `ALTER TABLE user_platform_accounts
       ADD UNIQUE KEY uk_user_platform_account (user_id, platform_id, platform_user_id(255))`
    )
    console.log('  + Restored per-user unique key uk_user_platform_account')
  } catch (error) {
    console.error(`  ! Could not restore uk_user_platform_account: ${error.message}`)
    console.error('  ! You may need to resolve data conflicts manually')
  }
}

export default { up, down }
