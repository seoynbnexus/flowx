export async function up({ context: pool }) {
  const [tables] = await pool.execute(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_jobs'"
  )
  if (tables.length === 0) {
    await pool.execute(`
      CREATE TABLE campaign_jobs (
        id BINARY(16) NOT NULL,
        campaign_id BINARY(16) NOT NULL,
        job_type VARCHAR(40) NOT NULL,
        status ENUM('queued', 'running', 'done', 'failed', 'dead') NOT NULL DEFAULT 'queued',
        attempts INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 3,
        run_after TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        error TEXT NULL,
        actor_id BINARY(16) NULL,
        payload JSON NOT NULL DEFAULT (JSON_OBJECT()),
        started_at TIMESTAMP NULL,
        finished_at TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_campaign_jobs_status_run_after (status, run_after),
        KEY idx_campaign_jobs_campaign (campaign_id),
        CONSTRAINT fk_campaign_jobs_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id),
        CONSTRAINT fk_campaign_jobs_actor FOREIGN KEY (actor_id) REFERENCES users (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    console.log('  + Created campaign_jobs table')
  } else {
    console.log('  ~ campaign_jobs already exists')
  }
}

export async function down({ context: pool }) {
  const [tables] = await pool.execute(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_jobs'"
  )
  if (tables.length > 0) {
    await pool.execute('DROP TABLE campaign_jobs')
    console.log('  - Dropped campaign_jobs table')
  }
}

export default { up, down }
