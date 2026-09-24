async function tableExists(pool, name) {
  const [tables] = await pool.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    [name]
  )
  return tables.length > 0
}

export async function up({ context: pool }) {
  if (!(await tableExists(pool, 'campaign_execution_daily_stats'))) {
    await pool.execute(`
      CREATE TABLE campaign_execution_daily_stats (
        id BINARY(16) NOT NULL,
        campaign_execution_id BINARY(16) NOT NULL,
        stat_date DATE NOT NULL,
        impressions BIGINT NOT NULL DEFAULT 0,
        reach BIGINT NOT NULL DEFAULT 0,
        frequency DOUBLE NOT NULL DEFAULT 0,
        clicks BIGINT NOT NULL DEFAULT 0,
        unique_clicks BIGINT NOT NULL DEFAULT 0,
        ctr DOUBLE NOT NULL DEFAULT 0,
        cpc DOUBLE NOT NULL DEFAULT 0,
        cpm DOUBLE NOT NULL DEFAULT 0,
        spend_paise BIGINT NOT NULL DEFAULT 0,
        actions JSON NULL,
        cost_per_action_type JSON NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_exec_daily (campaign_execution_id, stat_date),
        KEY idx_exec_daily_date (stat_date),
        CONSTRAINT fk_exec_daily_execution FOREIGN KEY (campaign_execution_id) REFERENCES campaign_executions (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    console.log('  + campaign_execution_daily_stats')
  } else {
    console.log('  ~ campaign_execution_daily_stats present')
  }
}

export async function down({ context: pool }) {
  if (await tableExists(pool, 'campaign_execution_daily_stats')) {
    await pool.execute('DROP TABLE campaign_execution_daily_stats')
    console.log('  - campaign_execution_daily_stats')
  }
}

export default { up, down }
