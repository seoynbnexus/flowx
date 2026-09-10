/**
 * post_boost_daily_stats — paid-ad performance read model for boosted posts.
 *
 * stat_date semantics: Meta ad-account timezone. Both Meta sources report
 * date boundaries in the ad account's own timezone:
 *   - `campaign_daily_spend` / `campaign_spend` webhooks carry `value.date`
 *     (account-tz date as "YYYY-MM-DD")
 *   - async Insights reports with time_increment=1 return `date_start`
 *     (account-tz date)
 * We persist those dates as-is and never bucket by server timezone.
 * Spend webhooks arriving without a `date` fall back to the current UTC date;
 * the next Insights reconciliation overwrites with the account-tz row.
 *
 * Row grain: one row per (post_target_id, stat_date). Every promotion target
 * is 1:1 with a post target (UNIQUE post_target_id on promotion_targets), so
 * this covers BOTH boost paths:
 *   - legacy boosts resolve via post_boost_targets (object_id of any of the
 *     facebook_campaign / ad_set / ad_creative / ad objects)
 *   - PromotionTarget boosts resolve via platform_*_id columns
 * Two campaigns of the same post are never aggregated in storage — each
 * keyed row belongs to exactly one PostTarget, preserving attribution.
 *
 * spend_paise semantics within a stat_date bucket: GREATEST(existing, incoming)
 * for BOTH writers (webhook amount is daily-cumulative for that date; Insights
 * daily rows lag real-time by ~3h and must never lower a fresher webhook value).
 * All other metrics REPLACE on Insights upsert (Insights is the complete
 * source; webhooks never carry impressions/reach/clicks/ctr/cpm/actions).
 * This makes every write idempotent.
 */
export async function up({ context: pool }) {
  const [tables] = await pool.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_boost_daily_stats'"
  )
  if (!tables.some(t => t.TABLE_NAME === 'post_boost_daily_stats')) {
    await pool.execute(`
      CREATE TABLE post_boost_daily_stats (
        id BINARY(16) NOT NULL,
        post_id BINARY(16) NOT NULL,
        post_target_id BINARY(16) NOT NULL,
        stat_date DATE NOT NULL,
        impressions BIGINT NOT NULL DEFAULT 0,
        reach BIGINT NOT NULL DEFAULT 0,
        frequency DECIMAL(12,4) NOT NULL DEFAULT 0,
        clicks BIGINT NOT NULL DEFAULT 0,
        unique_clicks BIGINT NOT NULL DEFAULT 0,
        ctr DECIMAL(15,6) NOT NULL DEFAULT 0,
        cpc DECIMAL(15,6) NOT NULL DEFAULT 0,
        cpm DECIMAL(15,6) NOT NULL DEFAULT 0,
        spend_paise BIGINT NOT NULL DEFAULT 0,
        actions JSON NULL,
        cost_per_action_type JSON NULL,
        last_source ENUM('webhook','insights') NOT NULL DEFAULT 'insights',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_pbds_target_date (post_target_id, stat_date),
        KEY idx_pbds_post_date (post_id, stat_date),
        CONSTRAINT fk_pbds_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
        CONSTRAINT fk_pbds_target FOREIGN KEY (post_target_id) REFERENCES post_targets (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    console.log('  + post_boost_daily_stats')
  } else {
    console.log('  ~ post_boost_daily_stats present')
  }

  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets'"
  )
  const has = (name) => cols.some(c => c.COLUMN_NAME === name)
  const add = async (name, ddl) => {
    if (!has(name)) {
      await pool.execute(`ALTER TABLE post_targets ADD COLUMN ${ddl}`)
      console.log(`  + post_targets.${name}`)
    } else {
      console.log(`  ~ post_targets.${name} present`)
    }
  }
  // last successful Insights reconciliation (drives the sync staleness gate)
  await add('last_boost_sync_at', 'last_boost_sync_at TIMESTAMP NULL AFTER last_engagement_sync_at')
  // last successfully processed boost-level Meta webhook (webhook-freshness for
  // adaptive polling cadence + UI freshness). Health is derived from this
  // timestamp, never from last_source.
  await add('last_boost_webhook_at', 'last_boost_webhook_at TIMESTAMP NULL AFTER last_boost_sync_at')

  const [idx] = await pool.query(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets' AND INDEX_NAME = 'idx_pt_last_boost_sync'"
  )
  if (idx.length === 0) {
    try {
      await pool.execute('ALTER TABLE post_targets ADD KEY idx_pt_last_boost_sync (last_boost_sync_at)')
      console.log('  + idx_pt_last_boost_sync')
    } catch (e) { console.log('  ~ idx_pt_last_boost_sync not added', e.message) }
  }
}

export async function down({ context: pool }) {
  await pool.execute('DROP TABLE IF EXISTS post_boost_daily_stats')
  const dropCol = async (name) => {
    const [cols] = await pool.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets' AND COLUMN_NAME = ?",
      [name]
    )
    if (cols.length > 0) {
      await pool.execute(`ALTER TABLE post_targets DROP COLUMN ${name}`)
      console.log(`  - post_targets.${name}`)
    }
  }
  const dropIdx = async (name) => {
    const [rows] = await pool.query(
      'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
      ['post_targets', name]
    )
    if (rows.length > 0) {
      await pool.execute(`ALTER TABLE post_targets DROP INDEX ${name}`)
      console.log(`  - ${name}`)
    }
  }
  await dropIdx('idx_pt_last_boost_sync')
  await dropCol('last_boost_webhook_at')
  await dropCol('last_boost_sync_at')
}

export default { up, down }
