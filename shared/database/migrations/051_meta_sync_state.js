export async function up({ context: pool }) {
  const [tables] = await pool.execute(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meta_sync_state'"
  )
  if (tables.length === 0) {
    await pool.execute(`
      CREATE TABLE meta_sync_state (
        run_key VARCHAR(64) NOT NULL,
        state JSON NOT NULL DEFAULT (JSON_OBJECT()),
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (run_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    console.log('  + Created meta_sync_state table')
  } else {
    console.log('  ~ meta_sync_state already exists')
  }
}

export async function down({ context: pool }) {
  const [tables] = await pool.execute(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meta_sync_state'"
  )
  if (tables.length > 0) {
    await pool.execute('DROP TABLE meta_sync_state')
    console.log('  - Dropped meta_sync_state table')
  }
}

export default { up, down }
