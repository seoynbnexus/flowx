export async function up({ context: pool }) {
  const [cols] = await pool.execute(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_jobs' AND COLUMN_NAME = 'run_key'"
  )
  if (cols.length === 0) {
    await pool.execute('ALTER TABLE campaign_jobs ADD COLUMN run_key VARCHAR(64) NULL AFTER job_type')
    console.log('  + Added run_key to campaign_jobs')
  } else {
    console.log('  ~ campaign_jobs.run_key already present')
  }

  const [nullCols] = await pool.execute(
    "SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_jobs' AND COLUMN_NAME = 'campaign_id'"
  )
  if (nullCols.length > 0 && nullCols[0].IS_NULLABLE !== 'YES') {
    await pool.execute('ALTER TABLE campaign_jobs MODIFY COLUMN campaign_id BINARY(16) NULL')
    console.log('  + Made campaign_jobs.campaign_id nullable')
  }

  const [idx] = await pool.execute(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_jobs' AND INDEX_NAME = 'uk_campaign_jobs_run'"
  )
  if (idx.length === 0) {
    await pool.execute('ALTER TABLE campaign_jobs ADD UNIQUE KEY uk_campaign_jobs_run (job_type, run_key)')
    console.log('  + Added UNIQUE(job_type, run_key) to campaign_jobs')
  } else {
    console.log('  ~ campaign_jobs unique run key already present')
  }
}

export async function down({ context: pool }) {
  const [idx] = await pool.execute(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_jobs' AND INDEX_NAME = 'uk_campaign_jobs_run'"
  )
  if (idx.length > 0) {
    await pool.execute('ALTER TABLE campaign_jobs DROP INDEX uk_campaign_jobs_run')
  }
  await pool.execute('ALTER TABLE campaign_jobs DROP COLUMN run_key')
  await pool.execute('ALTER TABLE campaign_jobs MODIFY COLUMN campaign_id BINARY(16) NOT NULL')
}

export default { up, down }
