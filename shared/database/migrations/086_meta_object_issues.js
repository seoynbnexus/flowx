async function tableExists(pool, name) {
  const [rows] = await pool.query(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [name]
  )
  return rows.length > 0
}

export async function up({ context: pool }) {
  if (await tableExists(pool, 'meta_object_issues')) {
    console.log('  ~ meta_object_issues table already present')
    return
  }
  await pool.execute(`
    CREATE TABLE meta_object_issues (
      id BINARY(16) NOT NULL,
      campaign_execution_id BINARY(16) NOT NULL,
      object_id VARCHAR(64) NOT NULL,
      creative_id VARCHAR(64) NULL DEFAULT NULL,
      level VARCHAR(16) NULL DEFAULT NULL,
      error_code VARCHAR(32) NOT NULL,
      error_summary VARCHAR(255) NULL DEFAULT NULL,
      error_message TEXT NULL DEFAULT NULL,
      error_type VARCHAR(32) NULL DEFAULT NULL,
      observed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      cleared_at TIMESTAMP NULL DEFAULT NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_meta_issue_exec_object_code (campaign_execution_id, object_id, error_code),
      KEY idx_meta_issue_execution (campaign_execution_id, active),
      CONSTRAINT fk_meta_issue_execution FOREIGN KEY (campaign_execution_id)
        REFERENCES campaign_executions (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  console.log('  + Created meta_object_issues table')
}

export async function down({ context: pool }) {
  if (!(await tableExists(pool, 'meta_object_issues'))) {
    console.log('  ~ meta_object_issues table already absent')
    return
  }
  await pool.execute('DROP TABLE IF EXISTS meta_object_issues')
  console.log('  - Dropped meta_object_issues table')
}

export default { up, down }
