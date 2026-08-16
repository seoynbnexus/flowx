export async function up({ context: pool }) {
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets' AND COLUMN_NAME = 'publish_state'"
  )
  if (cols.length === 0) {
    await pool.execute("ALTER TABLE post_targets ADD COLUMN publish_state VARCHAR(32) NOT NULL DEFAULT 'none' AFTER status")
    await pool.execute('ALTER TABLE post_targets ADD COLUMN remote_video_id VARCHAR(255) NULL DEFAULT NULL AFTER publish_state')
    await pool.execute('ALTER TABLE post_targets ADD COLUMN remote_upload_url TEXT NULL DEFAULT NULL AFTER remote_video_id')
    await pool.execute('ALTER TABLE post_targets ADD COLUMN publish_state_changed_at TIMESTAMP NULL DEFAULT NULL AFTER remote_upload_url')
    await pool.execute('ALTER TABLE post_targets ADD COLUMN verification_attempts INT NOT NULL DEFAULT 0 AFTER publish_state_changed_at')
    await pool.execute('ALTER TABLE post_targets ADD COLUMN last_verify_at TIMESTAMP NULL DEFAULT NULL AFTER verification_attempts')
  }
}

export async function down({ context: pool }) {
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets' AND COLUMN_NAME = 'publish_state'"
  )
  if (cols.length > 0) {
    await pool.execute('ALTER TABLE post_targets DROP COLUMN last_verify_at')
    await pool.execute('ALTER TABLE post_targets DROP COLUMN verification_attempts')
    await pool.execute('ALTER TABLE post_targets DROP COLUMN publish_state_changed_at')
    await pool.execute('ALTER TABLE post_targets DROP COLUMN remote_upload_url')
    await pool.execute('ALTER TABLE post_targets DROP COLUMN remote_video_id')
    await pool.execute('ALTER TABLE post_targets DROP COLUMN publish_state')
  }
}

export default { up, down }