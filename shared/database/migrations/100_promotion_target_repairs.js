async function tableExists(pool, name) {
  const [rows] = await pool.query(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [name]
  )
  return rows.length > 0
}

export async function up({ context: pool }) {
  if (await tableExists(pool, 'promotion_target_repairs')) {
    console.log('  ~ promotion_target_repairs table already present')
    return
  }
  await pool.execute(`
    CREATE TABLE promotion_target_repairs (
      id BINARY(16) NOT NULL,
      promotion_target_id BINARY(16) NOT NULL,
      object_id VARCHAR(64) NOT NULL,
      error_code VARCHAR(32) NOT NULL,
      run_key VARCHAR(64) NOT NULL,
      status ENUM('pending','ready_for_creation','creative_created','ad_created','activating','active_verified','completed','failed','unknown')
        NOT NULL DEFAULT 'pending',
      attempts INT NOT NULL DEFAULT 0,
      error TEXT NULL DEFAULT NULL,
      amendment_fields JSON NULL DEFAULT NULL,
      promotion_target_issue_id BINARY(16) NULL DEFAULT NULL,
      old_creative_id VARCHAR(64) NULL DEFAULT NULL,
      old_ad_id VARCHAR(64) NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_ptgt_repair_triple (promotion_target_id, object_id, error_code),
      UNIQUE KEY uk_ptgt_repair_run (run_key),
      KEY idx_ptgt_repair_target (promotion_target_id, status),
      CONSTRAINT fk_ptgt_repair_target FOREIGN KEY (promotion_target_id)
        REFERENCES promotion_targets (id) ON DELETE CASCADE,
      CONSTRAINT fk_ptgt_repair_issue FOREIGN KEY (promotion_target_issue_id)
        REFERENCES promotion_target_issues (id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  console.log('  + Created promotion_target_repairs table')
}

export async function down({ context: pool }) {
  if (!(await tableExists(pool, 'promotion_target_repairs'))) {
    console.log('  ~ promotion_target_repairs table already absent')
    return
  }
  await pool.execute('DROP TABLE IF EXISTS promotion_target_repairs')
  console.log('  - Dropped promotion_target_repairs table')
}

export default { up, down }
