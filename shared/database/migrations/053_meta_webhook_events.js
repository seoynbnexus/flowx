export async function up({ context: pool }) {
  const [tables] = await pool.execute(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meta_webhook_events'"
  )
  if (tables.length === 0) {
    await pool.execute(`
      CREATE TABLE meta_webhook_events (
        id VARCHAR(255) NOT NULL,
        account_id VARCHAR(64) NULL,
        event_type VARCHAR(64) NOT NULL,
        payload JSON NOT NULL DEFAULT (JSON_OBJECT()),
        processed_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_meta_webhook_account (account_id),
        KEY idx_meta_webhook_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    console.log('  + Created meta_webhook_events')
  } else {
    console.log('  ~ meta_webhook_events already present')
  }
}

export async function down({ context: pool }) {
  await pool.execute('DROP TABLE IF EXISTS meta_webhook_events')
}
