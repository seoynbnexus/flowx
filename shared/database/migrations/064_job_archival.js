export async function up({ context: pool }) {
  const [jobTypeIdx] = await pool.query(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_jobs' AND INDEX_NAME = 'idx_campaign_jobs_job_type'"
  )
  if (jobTypeIdx.length === 0) {
    await pool.execute('ALTER TABLE campaign_jobs ADD KEY idx_campaign_jobs_job_type (job_type)')
    console.log('  + Added idx_campaign_jobs_job_type to campaign_jobs')
  } else {
    console.log('  ~ campaign_jobs idx_campaign_jobs_job_type already present')
  }

  const [finishedIdx] = await pool.query(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_jobs' AND INDEX_NAME = 'idx_campaign_jobs_finished'"
  )
  if (finishedIdx.length === 0) {
    await pool.execute('ALTER TABLE campaign_jobs ADD KEY idx_campaign_jobs_finished (status, finished_at)')
    console.log('  + Added idx_campaign_jobs_finished to campaign_jobs')
  } else {
    console.log('  ~ campaign_jobs idx_campaign_jobs_finished already present')
  }

  const [peIdx] = await pool.query(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_engagement_daily' AND INDEX_NAME = 'idx_pe_created_at'"
  )
  if (peIdx.length === 0) {
    await pool.execute('ALTER TABLE post_engagement_daily ADD KEY idx_pe_created_at (created_at)')
    console.log('  + Added idx_pe_created_at to post_engagement_daily')
  } else {
    console.log('  ~ post_engagement_daily idx_pe_created_at already present')
  }
}

export async function down({ context: pool }) {
  const [jobTypeIdx] = await pool.query(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_jobs' AND INDEX_NAME = 'idx_campaign_jobs_job_type'"
  )
  if (jobTypeIdx.length > 0) {
    await pool.execute('ALTER TABLE campaign_jobs DROP INDEX idx_campaign_jobs_job_type')
  }

  const [finishedIdx] = await pool.query(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_jobs' AND INDEX_NAME = 'idx_campaign_jobs_finished'"
  )
  if (finishedIdx.length > 0) {
    await pool.execute('ALTER TABLE campaign_jobs DROP INDEX idx_campaign_jobs_finished')
  }

  const [peIdx] = await pool.query(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_engagement_daily' AND INDEX_NAME = 'idx_pe_created_at'"
  )
  if (peIdx.length > 0) {
    await pool.execute('ALTER TABLE post_engagement_daily DROP INDEX idx_pe_created_at')
  }
}

export default { up, down }
