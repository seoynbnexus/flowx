async function tableExists(pool, name) {
  const [rows] = await pool.query(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [name]
  )
  return rows.length > 0
}

export async function up({ context: pool }) {
  if (await tableExists(pool, 'promotion_target_issues')) {
    console.log('  ~ promotion_target_issues table already present')
    return
  }
  await pool.execute(`
    CREATE TABLE promotion_target_issues (
      id BINARY(16) NOT NULL,
      promotion_target_id BINARY(16) NOT NULL,
      object_id VARCHAR(64) NOT NULL,
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
      UNIQUE KEY uk_ptgt_issue (promotion_target_id, object_id, error_code),
      KEY idx_ptgt_issue_active (promotion_target_id, active),
      CONSTRAINT fk_ptgt_issue_target FOREIGN KEY (promotion_target_id)
        REFERENCES promotion_targets (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  console.log('  + Created promotion_target_issues table')
}

export async function down({ context: pool }) {
  if (!(await tableExists(pool, 'promotion_target_issues'))) {
    console.log('  ~ promotion_target_issues table already absent')
    return
  }
  await pool.execute('DROP TABLE IF EXISTS promotion_target_issues')
  console.log('  - Dropped promotion_target_issues table')
}

export default { up, down }
