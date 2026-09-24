import { v7 as generateUuid } from 'uuid'

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex')
}

async function columnExists(pool, table, column) {
  const [rows] = await pool.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  )
  return rows.length > 0
}

const FLAG = {
  key: 'campaign_repair_category_client_edit',
  value: false,
  isPublic: 0,
  description: 'Per-category repair gate for CLIENT_EDIT amendments (client-initiated creative fix on a FAILED, already-live campaign): when true, these amendments may be created. Fail-closed default off.',
}

export async function up({ context: pool }) {
  if (await columnExists(pool, 'campaign_execution_repairs', 'amendment_creative')) {
    console.log('  ~ campaign_execution_repairs.amendment_creative already present')
  } else {
    await pool.execute(
      'ALTER TABLE campaign_execution_repairs ADD COLUMN amendment_creative JSON NULL DEFAULT NULL AFTER media_height'
    )
    console.log('  + Added campaign_execution_repairs.amendment_creative')
  }

  await pool.execute(
    `INSERT IGNORE INTO app_config (id, config_key, config_value, is_public, description, version)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [uuidToBuffer(generateUuid()), FLAG.key, JSON.stringify(FLAG.value), FLAG.isPublic, FLAG.description]
  )
  console.log(`  + Seeded app_config ${FLAG.key}`)
}

export async function down({ context: pool }) {
  await pool.execute('DELETE FROM app_config WHERE config_key = ?', [FLAG.key])
  console.log(`  - Removed app_config ${FLAG.key}`)

  if (await columnExists(pool, 'campaign_execution_repairs', 'amendment_creative')) {
    await pool.execute('ALTER TABLE campaign_execution_repairs DROP COLUMN amendment_creative')
    console.log('  - Dropped campaign_execution_repairs.amendment_creative')
  }
}

export default { up, down }
