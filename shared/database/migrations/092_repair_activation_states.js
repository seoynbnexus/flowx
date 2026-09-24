const ADDED = [
  'new_activating',
  'new_active_verified',
  'old_pausing',
  'old_paused_verified',
  'active_pointer_moved',
  'old_cleanup',
]

async function currentValues(pool) {
  const [rows] = await pool.query(
    "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_execution_repairs' AND COLUMN_NAME = 'status'"
  )
  if (!rows.length) return null
  const match = String(rows[0].COLUMN_TYPE).match(/^enum\((.*)\)$/i)
  if (!match) return null
  return match[1].split(',').map((v) => v.trim().replace(/^'(.*)'$/, '$1'))
}

export async function up({ context: pool }) {
  const values = await currentValues(pool)
  if (!values) {
    console.log('  ~ campaign_execution_repairs.status column not found, skipping')
    return
  }
  const missing = ADDED.filter((v) => !values.includes(v))
  if (!missing.length) {
    console.log('  ~ campaign_execution_repairs.status already complete')
    return
  }
  const list = [...values, ...missing].map((v) => `'${v}'`).join(',')
  await pool.execute(
    `ALTER TABLE campaign_execution_repairs MODIFY COLUMN status ENUM(${list}) NOT NULL DEFAULT 'pending'`
  )
  console.log(`  + Extended campaign_execution_repairs.status with: ${missing.join(', ')}`)
}

export async function down({ context: pool }) {
  console.log('  ~ 092 only ever adds enum values; no destructive down action')
}

export default { up, down }
