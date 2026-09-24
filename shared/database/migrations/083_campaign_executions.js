async function tableExists(pool, name) {
  const [tables] = await pool.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    [name]
  )
  return tables.length > 0
}

export async function up({ context: pool }) {
  if (!(await tableExists(pool, 'campaign_executions'))) {
    await pool.execute(`
      CREATE TABLE campaign_executions (
        id BINARY(16) NOT NULL,
        campaign_id BINARY(16) NOT NULL,
        owner_user_id BINARY(16) NOT NULL,
        kind ENUM('client','publisher') NOT NULL DEFAULT 'publisher',
        publisher_request_id BINARY(16) NULL,
        status ENUM('pending','validating','creating','active','paused','failed','cancelled','completed') NOT NULL DEFAULT 'pending',
        fb_page_id VARCHAR(128) NULL,
        ad_account_act_id VARCHAR(64) NULL,
        config_hash CHAR(8) NULL,
        platform_campaign_id VARCHAR(64) NULL,
        platform_adset_id VARCHAR(64) NULL,
        platform_creative_id VARCHAR(64) NULL,
        platform_ad_id VARCHAR(64) NULL,
        attempts INT NOT NULL DEFAULT 0,
        error TEXT NULL,
        remote_state ENUM('visible','hidden','missing','unknown') NOT NULL DEFAULT 'visible',
        remote_state_checked_at TIMESTAMP NULL,
        remote_state_source ENUM('poll','webhook','admin') NULL,
        consumed_paise BIGINT NOT NULL DEFAULT 0,
        refunded_paise BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_exec_campaign_owner_kind (campaign_id, owner_user_id, kind),
        UNIQUE KEY uk_exec_platform_campaign (platform_campaign_id),
        KEY idx_exec_campaign (campaign_id, status),
        KEY idx_exec_status (status),
        CONSTRAINT fk_exec_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE,
        CONSTRAINT fk_exec_owner FOREIGN KEY (owner_user_id) REFERENCES users (id),
        CONSTRAINT fk_exec_request FOREIGN KEY (publisher_request_id) REFERENCES campaign_publisher_requests (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    console.log('  + campaign_executions')
  } else {
    console.log('  ~ campaign_executions present')
  }
}

export async function down({ context: pool }) {
  if (await tableExists(pool, 'campaign_executions')) {
    await pool.execute('DROP TABLE campaign_executions')
    console.log('  - campaign_executions')
  }
}

export default { up, down }
