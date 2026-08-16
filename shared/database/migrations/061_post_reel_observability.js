export async function up({ context: pool }) {
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets' AND COLUMN_NAME = 'last_meta_status'"
  )
  if (cols.length === 0) {
    await pool.execute('ALTER TABLE post_targets ADD COLUMN last_meta_status VARCHAR(255) NULL DEFAULT NULL AFTER last_verify_at')
    await pool.execute('ALTER TABLE post_targets ADD COLUMN last_operation VARCHAR(64) NULL DEFAULT NULL AFTER last_meta_status')
    await pool.execute('ALTER TABLE post_targets ADD COLUMN last_operation_at TIMESTAMP NULL DEFAULT NULL AFTER last_operation')
    await pool.execute('ALTER TABLE post_targets ADD COLUMN processing_started_at TIMESTAMP NULL DEFAULT NULL AFTER last_operation_at')
    await pool.execute('ALTER TABLE post_targets ADD COLUMN unknown_since TIMESTAMP NULL DEFAULT NULL AFTER processing_started_at')
    console.log('  + Added FB reel observability columns to post_targets')
  } else {
    console.log('  ~ post_targets reel observability columns already present')
  }
}

export async function down({ context: pool }) {
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets' AND COLUMN_NAME = 'last_meta_status'"
  )
  if (cols.length > 0) {
    await pool.execute('ALTER TABLE post_targets DROP COLUMN unknown_since')
    await pool.execute('ALTER TABLE post_targets DROP COLUMN processing_started_at')
    await pool.execute('ALTER TABLE post_targets DROP COLUMN last_operation_at')
    await pool.execute('ALTER TABLE post_targets DROP COLUMN last_operation')
    await pool.execute('ALTER TABLE post_targets DROP COLUMN last_meta_status')
  }
}

export default { up, down }
