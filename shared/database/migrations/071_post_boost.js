export async function up({ context: pool }) {
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts'"
  )
  const has = (name) => cols.some(c => c.COLUMN_NAME === name)
  const add = async (name, ddl) => {
    if (!has(name)) {
      await pool.execute(`ALTER TABLE posts ADD COLUMN ${ddl}`)
      console.log(`  + posts.${name}`)
    } else {
      console.log(`  ~ posts.${name} present`)
    }
  }
  await add('boost_enabled', "boost_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER run_on_publishers")
  await add('boost_budget_type', "boost_budget_type ENUM('daily','lifetime') NULL AFTER boost_enabled")
  await add('boost_budget_amount', "boost_budget_amount DECIMAL(15,2) NULL AFTER boost_budget_type")
  await add('boost_spend_cap', "boost_spend_cap DECIMAL(15,2) NULL AFTER boost_budget_amount")
  await add('boost_end_time', "boost_end_time TIMESTAMP NULL AFTER boost_spend_cap")
  await add('boost_targeting', "boost_targeting JSON NULL AFTER boost_end_time")
  await add('boost_placement', "boost_placement JSON NULL AFTER boost_targeting")
  await add('boost_bid_strategy', "boost_bid_strategy VARCHAR(50) NULL AFTER boost_placement")
  await add('boost_optimization_goal', "boost_optimization_goal VARCHAR(100) NULL AFTER boost_bid_strategy")
  await add('ad_account_id', "ad_account_id BINARY(16) NULL AFTER boost_optimization_goal")
  await add('charged_boost_paise', "charged_boost_paise BIGINT NOT NULL DEFAULT 0 AFTER ad_account_id")
  await add('boost_error', "boost_error TEXT NULL AFTER charged_boost_paise")

  const [idx] = await pool.query(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts' AND INDEX_NAME = 'idx_posts_boost_enabled'"
  )
  if (idx.length === 0) {
    try {
      await pool.execute('ALTER TABLE posts ADD KEY idx_posts_boost_enabled (boost_enabled)')
      console.log('  + idx_posts_boost_enabled')
    } catch (e) { console.log('  ~ idx_posts_boost_enabled not added', e.message) }
  }

  const [fk] = await pool.query(
    "SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts' AND CONSTRAINT_NAME = 'fk_posts_ad_account'"
  )
  if (fk.length === 0) {
    try {
      await pool.execute('ALTER TABLE posts ADD CONSTRAINT fk_posts_ad_account FOREIGN KEY (ad_account_id) REFERENCES meta_ad_accounts (id)')
      console.log('  + fk_posts_ad_account')
    } catch (e) { console.log('  ~ fk_posts_ad_account not added', e.message) }
  }

  const [tables] = await pool.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('post_boost_targets','post_billing_entries')"
  )
  if (!tables.some(t => t.TABLE_NAME === 'post_boost_targets')) {
    await pool.execute(`
      CREATE TABLE post_boost_targets (
        id BINARY(16) NOT NULL,
        post_id BINARY(16) NOT NULL,
        post_target_id BINARY(16) NOT NULL,
        platform_account_id BINARY(16) NULL,
        object_type ENUM('facebook_campaign','ad_set','ad_creative','ad') NOT NULL,
        object_id VARCHAR(255) NOT NULL,
        status VARCHAR(50) NULL,
        boost_status ENUM('pending','active','paused','failed','archived') NOT NULL DEFAULT 'pending',
        created_for_user_id BINARY(16) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_pbt_object_id (object_id),
        KEY idx_pbt_post_id (post_id),
        KEY idx_pbt_target_id (post_target_id),
        CONSTRAINT fk_pbt_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
        CONSTRAINT fk_pbt_target FOREIGN KEY (post_target_id) REFERENCES post_targets (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    console.log('  + post_boost_targets')
  } else {
    console.log('  ~ post_boost_targets present')
  }

  if (!tables.some(t => t.TABLE_NAME === 'post_billing_entries')) {
    await pool.execute(`
      CREATE TABLE post_billing_entries (
        id BINARY(16) NOT NULL,
        post_id BINARY(16) NOT NULL,
        kind ENUM('charge','settle','refund','overspend') NOT NULL,
        paise BIGINT NOT NULL,
        coins DECIMAL(15,2) NOT NULL,
        rate DECIMAL(15,6) NOT NULL,
        paid_from_monthly DECIMAL(15,2) NOT NULL DEFAULT 0,
        paid_from_wallet DECIMAL(15,2) NOT NULL DEFAULT 0,
        reason VARCHAR(255) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_pbe_post_id (post_id, created_at),
        CONSTRAINT fk_pbe_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    console.log('  + post_billing_entries')
  } else {
    console.log('  ~ post_billing_entries present')
  }
}

export async function down({ context: pool }) {
  const dropCol = async (name) => {
    const [cols] = await pool.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts' AND COLUMN_NAME = ?",
      [name]
    )
    if (cols.length > 0) {
      await pool.execute(`ALTER TABLE posts DROP COLUMN ${name}`)
      console.log(`  - posts.${name}`)
    }
  }
  const dropIdx = async (name) => {
    const [rows] = await pool.query(
      'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
      ['posts', name]
    )
    if (rows.length > 0) {
      await pool.execute(`ALTER TABLE posts DROP INDEX ${name}`)
      console.log(`  - ${name}`)
    }
  }
  await pool.execute('DROP TABLE IF EXISTS post_billing_entries')
  await pool.execute('DROP TABLE IF EXISTS post_boost_targets')
  await dropIdx('idx_posts_boost_enabled')
  await dropCol('boost_error')
  await dropCol('charged_boost_paise')
  await dropCol('ad_account_id')
  await dropCol('boost_optimization_goal')
  await dropCol('boost_bid_strategy')
  await dropCol('boost_placement')
  await dropCol('boost_targeting')
  await dropCol('boost_end_time')
  await dropCol('boost_spend_cap')
  await dropCol('boost_budget_amount')
  await dropCol('boost_budget_type')
  await dropCol('boost_enabled')
}

export default { up, down }
