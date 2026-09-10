async function tableExists(pool, name) {
  const [tables] = await pool.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    [name]
  )
  return tables.length > 0
}

export async function up({ context: pool }) {
  if (!(await tableExists(pool, 'promotions'))) {
    await pool.execute(`
      CREATE TABLE promotions (
        id BINARY(16) NOT NULL,
        post_id BINARY(16) NOT NULL,
        client_id BINARY(16) NOT NULL,
        status ENUM('waiting_for_post','validating','creating','pending_review','active','paused','completed','failed','cancelled') NOT NULL DEFAULT 'waiting_for_post',
        budget_type ENUM('daily','lifetime') NULL,
        budget_amount DECIMAL(15,2) NULL,
        spend_cap DECIMAL(15,2) NULL,
        objective VARCHAR(50) NULL,
        optimization_goal VARCHAR(50) NULL,
        bid_strategy VARCHAR(50) NULL,
        targeting JSON NULL,
        placement JSON NULL,
        call_to_action VARCHAR(100) NULL,
        link VARCHAR(2000) NULL,
        headline VARCHAR(255) NULL,
        description VARCHAR(500) NULL,
        start_at TIMESTAMP NULL,
        end_at TIMESTAMP NULL,
        charged_paise BIGINT NOT NULL DEFAULT 0,
        error TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_promotions_post (post_id),
        KEY idx_promotions_client (client_id, status),
        KEY idx_promotions_status (status),
        CONSTRAINT fk_promotions_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
        CONSTRAINT fk_promotions_client FOREIGN KEY (client_id) REFERENCES users (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    console.log('  + promotions')
  } else {
    console.log('  ~ promotions present')
  }

  if (!(await tableExists(pool, 'promotion_targets'))) {
    await pool.execute(`
      CREATE TABLE promotion_targets (
        id BINARY(16) NOT NULL,
        promotion_id BINARY(16) NOT NULL,
        post_target_id BINARY(16) NOT NULL,
        platform ENUM('facebook','instagram') NOT NULL,
        platform_account_id BINARY(16) NULL,
        status ENUM('pending','validating','creating','active','paused','failed','cancelled') NOT NULL DEFAULT 'pending',
        eligibility_status ENUM('unknown','eligible','ineligible') NOT NULL DEFAULT 'unknown',
        eligibility_reason VARCHAR(500) NULL,
        platform_campaign_id VARCHAR(64) NULL,
        platform_adset_id VARCHAR(64) NULL,
        platform_creative_id VARCHAR(64) NULL,
        platform_ad_id VARCHAR(64) NULL,
        attempts INT NOT NULL DEFAULT 0,
        error TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_ptgt_post_target (post_target_id),
        UNIQUE KEY uk_ptgt_campaign (platform_campaign_id),
        KEY idx_ptgt_promotion (promotion_id, status),
        KEY idx_ptgt_status (status),
        CONSTRAINT fk_ptgt_promotion FOREIGN KEY (promotion_id) REFERENCES promotions (id) ON DELETE CASCADE,
        CONSTRAINT fk_ptgt_post_target FOREIGN KEY (post_target_id) REFERENCES post_targets (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    console.log('  + promotion_targets')
  } else {
    console.log('  ~ promotion_targets present')
  }
}

export async function down({ context: pool }) {
  if (await tableExists(pool, 'promotion_targets')) {
    await pool.execute('DROP TABLE promotion_targets')
    console.log('  - promotion_targets')
  }
  if (await tableExists(pool, 'promotions')) {
    await pool.execute('DROP TABLE promotions')
    console.log('  - promotions')
  }
}

export default { up, down }
