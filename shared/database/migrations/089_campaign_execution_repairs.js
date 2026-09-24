async function tableExists(pool, name) {
  const [rows] = await pool.query(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [name]
  )
  return rows.length > 0
}

export async function up({ context: pool }) {
  if (await tableExists(pool, 'campaign_execution_repairs')) {
    console.log('  ~ campaign_execution_repairs table already present')
    return
  }
  await pool.execute(`
    CREATE TABLE campaign_execution_repairs (
      id BINARY(16) NOT NULL,
      campaign_execution_id BINARY(16) NOT NULL,
      generation_no INT NOT NULL DEFAULT 0,
      object_id VARCHAR(64) NOT NULL,
      creative_id VARCHAR(64) NULL DEFAULT NULL,
      error_code VARCHAR(32) NOT NULL,
      run_key VARCHAR(64) NOT NULL,
      status ENUM('pending','ready_for_creation','creative_created','ad_created','new_verified','new_active','old_paused','completed','failed','unknown','superseded') NOT NULL DEFAULT 'pending',
      attempts INT NOT NULL DEFAULT 0,
      error TEXT NULL DEFAULT NULL,
      media_asset_id BINARY(16) NULL DEFAULT NULL,
      media_url VARCHAR(2000) NULL DEFAULT NULL,
      media_width INT NULL DEFAULT NULL,
      media_height INT NULL DEFAULT NULL,
      meta_issue_id BINARY(16) NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_repair_triple (campaign_execution_id, object_id, error_code),
      UNIQUE KEY uk_repair_run (run_key),
      KEY idx_repair_execution (campaign_execution_id, status),
      CONSTRAINT fk_repair_execution FOREIGN KEY (campaign_execution_id)
        REFERENCES campaign_executions (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  console.log('  + Created campaign_execution_repairs table')
}

export async function down({ context: pool }) {
  if (!(await tableExists(pool, 'campaign_execution_repairs'))) {
    console.log('  ~ campaign_execution_repairs table already absent')
    return
  }
  await pool.execute('DROP TABLE IF EXISTS campaign_execution_repairs')
  console.log('  - Dropped campaign_execution_repairs table')
}

export default { up, down }
