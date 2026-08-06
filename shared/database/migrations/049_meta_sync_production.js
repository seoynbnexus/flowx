export async function up({ context: pool }) {
  const [statTables] = await pool.execute(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_daily_stats'"
  )
  if (statTables.length === 0) {
    await pool.execute(`
      CREATE TABLE campaign_daily_stats (
        id BINARY(16) NOT NULL,
        campaign_id BINARY(16) NOT NULL,
        stat_date DATE NOT NULL,
        impressions BIGINT NOT NULL DEFAULT 0,
        reach BIGINT NOT NULL DEFAULT 0,
        frequency DECIMAL(10,2) NOT NULL DEFAULT 0,
        clicks BIGINT NOT NULL DEFAULT 0,
        unique_clicks BIGINT NOT NULL DEFAULT 0,
        ctr DECIMAL(10,4) NOT NULL DEFAULT 0,
        cpc DECIMAL(15,4) NOT NULL DEFAULT 0,
        cpm DECIMAL(15,4) NOT NULL DEFAULT 0,
        spend_paise BIGINT NOT NULL DEFAULT 0,
        actions JSON NOT NULL DEFAULT (JSON_OBJECT()),
        cost_per_action_type JSON NOT NULL DEFAULT (JSON_OBJECT()),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_campaign_daily (campaign_id, stat_date),
        CONSTRAINT fk_campaign_daily_stats_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    console.log('  + Created campaign_daily_stats table')
  } else {
    console.log('  ~ campaign_daily_stats already exists')
  }

  const [billingTables] = await pool.execute(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_billing_entries'"
  )
  if (billingTables.length === 0) {
    await pool.execute(`
      CREATE TABLE campaign_billing_entries (
        id BINARY(16) NOT NULL,
        campaign_id BINARY(16) NOT NULL,
        kind ENUM('charge', 'settle', 'refund', 'overspend') NOT NULL,
        paise BIGINT NOT NULL DEFAULT 0,
        coins DECIMAL(15,2) NOT NULL DEFAULT 0,
        rate DECIMAL(15,6) NOT NULL DEFAULT 0,
        paid_from_monthly DECIMAL(15,2) NOT NULL DEFAULT 0,
        paid_from_wallet DECIMAL(15,2) NOT NULL DEFAULT 0,
        reason VARCHAR(255) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_campaign_billing_campaign (campaign_id, created_at),
        CONSTRAINT fk_campaign_billing_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    console.log('  + Created campaign_billing_entries table')
  } else {
    console.log('  ~ campaign_billing_entries already exists')
  }

  const [snapshotTables] = await pool.execute(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meta_account_snapshots'"
  )
  if (snapshotTables.length === 0) {
    await pool.execute(`
      CREATE TABLE meta_account_snapshots (
        id BINARY(16) NOT NULL,
        ad_account_id VARCHAR(100) NOT NULL,
        balance_paise BIGINT NOT NULL DEFAULT 0,
        currency VARCHAR(10) NULL,
        account_status VARCHAR(50) NULL,
        disable_reason TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_meta_snapshot_account (ad_account_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    console.log('  + Created meta_account_snapshots table')
  } else {
    console.log('  ~ meta_account_snapshots already exists')
  }

  const [chargedCols] = await pool.execute(
    "SHOW COLUMNS FROM campaigns LIKE 'charged_ad_budget_paise'"
  )
  if (chargedCols.length === 0) {
    await pool.execute(
      'ALTER TABLE campaigns ADD COLUMN charged_ad_budget_paise BIGINT NOT NULL DEFAULT 0 AFTER meta_spent_paise'
    )
    console.log('  + Added charged_ad_budget_paise to campaigns')
  } else {
    console.log('  ~ charged_ad_budget_paise already exists')
  }

  const [insightsSyncCols] = await pool.execute(
    "SHOW COLUMNS FROM campaigns LIKE 'last_insights_sync_at'"
  )
  if (insightsSyncCols.length === 0) {
    await pool.execute(
      'ALTER TABLE campaigns ADD COLUMN last_insights_sync_at TIMESTAMP NULL AFTER last_meta_sync_at'
    )
    await pool.execute(
      'ALTER TABLE campaigns ADD COLUMN insights_error VARCHAR(500) NULL AFTER last_insights_sync_at'
    )
    console.log('  + Added last_insights_sync_at and insights_error to campaigns')
  } else {
    console.log('  ~ last_insights_sync_at already exists')
  }

  const [settledCols] = await pool.execute(
    "SHOW COLUMNS FROM campaigns LIKE 'settled_at'"
  )
  if (settledCols.length === 0) {
    await pool.execute(
      'ALTER TABLE campaigns ADD COLUMN settled_at TIMESTAMP NULL AFTER insights_error'
    )
    console.log('  + Added settled_at to campaigns')
  } else {
    console.log('  ~ settled_at already exists')
  }

  const [metaStatusCols] = await pool.execute(
    "SHOW COLUMNS FROM campaigns WHERE Field = 'meta_status'"
  )
  if (metaStatusCols.length > 0) {
    const currentType = metaStatusCols[0].Type
    if (!currentType.includes('archived')) {
      await pool.execute(
        "ALTER TABLE campaigns MODIFY COLUMN meta_status ENUM('pending','created','active','paused','failed','archived') NOT NULL DEFAULT 'pending'"
      )
      console.log('  + Extended campaigns.meta_status ENUM')
    } else {
      console.log('  ~ campaigns.meta_status already extended')
    }
  }

  const [jobTables] = await pool.execute(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_jobs'"
  )
  if (jobTables.length > 0) {
    const [jobCols] = await pool.execute(
      "SHOW COLUMNS FROM campaign_jobs LIKE 'job_type'"
    )
    const [jobIndexes] = await pool.execute(
      "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_jobs' AND INDEX_NAME = 'uk_campaign_jobs_type'"
    )
    if (jobCols.length > 0 && jobIndexes.length === 0) {
      await pool.execute(`
        DELETE cj FROM campaign_jobs cj
        JOIN campaign_jobs cj2
          ON cj2.campaign_id = cj.campaign_id
         AND cj2.job_type = cj.job_type
         AND (cj2.created_at > cj.created_at OR (cj2.created_at = cj.created_at AND cj2.id > cj.id))
      `)
      await pool.execute(
        'ALTER TABLE campaign_jobs ADD UNIQUE KEY uk_campaign_jobs_type (campaign_id, job_type)'
      )
      console.log('  + Added UNIQUE(campaign_id, job_type) to campaign_jobs')
    } else {
      console.log('  ~ campaign_jobs unique key already present')
    }
  }
}

export async function down({ context: pool }) {
  await pool.execute('ALTER TABLE campaign_jobs DROP INDEX uk_campaign_jobs_type')
  await pool.execute('ALTER TABLE campaigns DROP COLUMN settled_at')
  await pool.execute('ALTER TABLE campaigns DROP COLUMN insights_error')
  await pool.execute('ALTER TABLE campaigns DROP COLUMN last_insights_sync_at')
  await pool.execute('ALTER TABLE campaigns DROP COLUMN charged_ad_budget_paise')

  const [metaStatusCols] = await pool.execute(
    "SHOW COLUMNS FROM campaigns WHERE Field = 'meta_status'"
  )
  if (metaStatusCols.length > 0 && metaStatusCols[0].Type.includes('archived')) {
    await pool.execute(
      "ALTER TABLE campaigns MODIFY COLUMN meta_status ENUM('pending','created','failed') NOT NULL DEFAULT 'pending'"
    )
  }

  const [snapshotTables] = await pool.execute(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meta_account_snapshots'"
  )
  if (snapshotTables.length > 0) {
    await pool.execute('DROP TABLE meta_account_snapshots')
  }

  const [billingTables] = await pool.execute(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_billing_entries'"
  )
  if (billingTables.length > 0) {
    await pool.execute('DROP TABLE campaign_billing_entries')
  }

  const [statTables] = await pool.execute(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_daily_stats'"
  )
  if (statTables.length > 0) {
    await pool.execute('DROP TABLE campaign_daily_stats')
  }
  console.log('  - Reverted migration 049')
}

export default { up, down }