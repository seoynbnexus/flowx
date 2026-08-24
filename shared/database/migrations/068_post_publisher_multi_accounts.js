export async function up({ context: pool }) {
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_publisher_requests' AND COLUMN_NAME = 'platform_account_ids'"
  )
  if (cols.length === 0) {
    await pool.execute("ALTER TABLE post_publisher_requests ADD COLUMN platform_account_ids JSON NULL AFTER platform_account_id")
  }
  await pool.query(
    `UPDATE post_publisher_requests
     SET platform_account_ids = JSON_ARRAY(LOWER(CONCAT(
       SUBSTR(HEX(platform_account_id),1,8),'-',SUBSTR(HEX(platform_account_id),9,4),'-',
       SUBSTR(HEX(platform_account_id),13,4),'-',SUBSTR(HEX(platform_account_id),17,4),'-',
       SUBSTR(HEX(platform_account_id),21,12)
     )))
     WHERE platform_account_id IS NOT NULL AND platform_account_ids IS NULL`
  )
}

export async function down({ context: pool }) {
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_publisher_requests' AND COLUMN_NAME = 'platform_account_ids'"
  )
  if (cols.length > 0) {
    await pool.execute("ALTER TABLE post_publisher_requests DROP COLUMN platform_account_ids")
  }
}

export default { up, down }
