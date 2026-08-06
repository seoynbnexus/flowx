export async function up({ context: pool }) {
  const metaAccountId = process.env.META_AD_ACCOUNT_ID
  if (metaAccountId && process.env.NODE_ENV !== 'test') {
    await pool.execute(
      'UPDATE meta_ad_accounts SET token_encrypted = NULL WHERE account_id = ?',
      [metaAccountId]
    )
    console.log(`  + Cleared stored token for env primary account ${metaAccountId}`)
  } else {
    console.log('  ~ no META_AD_ACCOUNT_ID (or test env) — nothing to clear')
  }
}

export async function down() {
  console.log('  ~ no-op: cleared token cannot be restored')
}
