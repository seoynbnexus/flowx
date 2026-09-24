const FULL_STATUS_SET = ['active', 'superseded', 'failed', 'creating', 'created', 'verified', 'unknown']

export async function up({ context: pool }) {
  const [rows] = await pool.query(
    "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_execution_generations' AND COLUMN_NAME = 'status'"
  )
  const match = rows.length ? String(rows[0].COLUMN_TYPE).match(/^enum\((.*)\)$/i) : null
  const values = match ? match[1].split(',').map((v) => v.trim().replace(/^'(.*)'$/, '$1')) : []
  const missing = FULL_STATUS_SET.filter((v) => !values.includes(v))
  if (!missing.length) {
    console.log('  ~ campaign_execution_generations.status already complete')
    return
  }
  const list = FULL_STATUS_SET.map((v) => `'${v}'`).join(',')
  await pool.execute(
    `ALTER TABLE campaign_execution_generations MODIFY COLUMN status ENUM(${list}) NOT NULL DEFAULT 'active'`
  )
  console.log(`  + Extended campaign_execution_generations.status with: ${missing.join(', ')}`)
}

export async function down({ context: pool }) {
  console.log('  ~ 091 only ever adds an enum value; no destructive down action')
}

export default { up, down }
