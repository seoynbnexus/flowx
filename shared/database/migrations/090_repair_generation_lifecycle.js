async function columnExists(pool, table, column) {
  const [rows] = await pool.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  )
  return rows.length > 0
}

async function enumValues(pool) {
  const [rows] = await pool.query(
    "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_execution_generations' AND COLUMN_NAME = 'status'"
  )
  if (!rows.length) return []
  const match = String(rows[0].COLUMN_TYPE).match(/^enum\((.*)\)$/i)
  if (!match) return []
  return match[1].split(',').map((v) => v.trim().replace(/^'(.*)'$/, '$1'))
}

const FULL_STATUS_SET = ['active', 'superseded', 'failed', 'creating', 'created', 'verified']

export async function up({ context: pool }) {
  const values = await enumValues(pool)
  const missing = FULL_STATUS_SET.filter((v) => !values.includes(v))
  if (missing.length) {
    const list = FULL_STATUS_SET.map((v) => `'${v}'`).join(',')
    await pool.execute(
      `ALTER TABLE campaign_execution_generations MODIFY COLUMN status ENUM(${list}) NOT NULL DEFAULT 'active'`
    )
    console.log(`  + Extended campaign_execution_generations.status with: ${missing.join(', ')}`)
  } else {
    console.log('  ~ campaign_execution_generations.status already complete')
  }

  for (const column of ['ADD COLUMN amended_config JSON NULL DEFAULT NULL', 'ADD COLUMN amended_config_hash CHAR(8) NULL DEFAULT NULL']) {
    const name = column.split(' ')[2]
    if (await columnExists(pool, 'campaign_execution_repairs', name)) {
      console.log(`  ~ campaign_execution_repairs.${name} already present`)
      continue
    }
    await pool.execute(`ALTER TABLE campaign_execution_repairs ${column}`)
    console.log(`  + Added campaign_execution_repairs.${name}`)
  }
}

export async function down({ context: pool }) {
  for (const name of ['amended_config_hash', 'amended_config']) {
    if (!(await columnExists(pool, 'campaign_execution_repairs', name))) {
      console.log(`  ~ campaign_execution_repairs.${name} already absent`)
      continue
    }
    await pool.execute(`ALTER TABLE campaign_execution_repairs DROP COLUMN ${name}`)
    console.log(`  - Dropped campaign_execution_repairs.${name}`)
  }
  const values = await enumValues(pool)
  if (values.includes('creating') || values.includes('created') || values.includes('verified')) {
    await pool.execute(
      "ALTER TABLE campaign_execution_generations MODIFY COLUMN status ENUM('active','superseded','failed') NOT NULL DEFAULT 'active'"
    )
    console.log('  - Narrowed campaign_execution_generations.status to the Phase 3 set')
  } else {
    console.log('  ~ campaign_execution_generations.status already narrow')
  }
}

export default { up, down }
