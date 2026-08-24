export async function up({ context: pool }) {
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets' AND COLUMN_NAME = 'container_id'"
  )
  if (cols.length === 0) {
    await pool.execute('ALTER TABLE post_targets ADD COLUMN container_id VARCHAR(128) NULL DEFAULT NULL AFTER meta_object_id')
  }
}

export async function down({ context: pool }) {
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets' AND COLUMN_NAME = 'container_id'"
  )
  if (cols.length > 0) {
    await pool.execute('ALTER TABLE post_targets DROP COLUMN container_id')
  }
}

export default { up, down }
