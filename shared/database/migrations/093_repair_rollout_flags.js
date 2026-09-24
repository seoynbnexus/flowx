import { v7 as generateUuid } from 'uuid'

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex')
}

const SEEDS = [
  {
    key: 'campaign_repair_rollout',
    value: 'off',
    isPublic: 0,
    description: 'Repair rollout gate: off blocks all new repairs, admin_only allows admin-created repairs, enabled opens repair creation. Fail-closed default off.',
  },
  {
    key: 'campaign_repair_execution_enabled',
    value: false,
    isPublic: 0,
    description: 'Repair worker execution flag: when true, the repair worker may create replacement Meta objects; when false, repairs park at READY_FOR_CREATION. OFF by default.',
  },
  {
    key: 'campaign_repair_killed',
    value: false,
    isPublic: 0,
    description: 'Repair kill switch: when true, all repair mutations (request + worker) are refused without state changes. Emergency stop.',
  },
  {
    key: 'campaign_repair_category_media_dimension',
    value: true,
    isPublic: 0,
    description: 'Per-category repair gate for MEDIA_DIMENSION issues: when true, media-dimension repairs may be created. Default on.',
  },
]

export async function up({ context: pool }) {
  for (const seed of SEEDS) {
    await pool.execute(
      `INSERT IGNORE INTO app_config (id, config_key, config_value, is_public, description, version)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [uuidToBuffer(generateUuid()), seed.key, JSON.stringify(seed.value), seed.isPublic ?? 0, seed.description]
    )
    console.log(`  + Seeded app_config ${seed.key}`)
  }
}

export async function down({ context: pool }) {
  for (const seed of SEEDS) {
    await pool.execute('DELETE FROM app_config WHERE config_key = ?', [seed.key])
  }
  console.log('  - Removed repair rollout flag seeds')
}

export default { up, down }
