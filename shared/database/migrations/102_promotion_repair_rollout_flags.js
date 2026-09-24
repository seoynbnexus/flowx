import { v7 as generateUuid } from 'uuid'

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex')
}

const SEEDS = [
  {
    key: 'boost_repair_rollout',
    value: 'off',
    isPublic: 0,
    description: 'Boost (promotion target) repair rollout gate: off blocks all new repairs, admin_only allows admin-created repairs, enabled opens repair creation. Fail-closed default off.',
  },
  {
    key: 'boost_repair_execution_enabled',
    value: false,
    isPublic: 0,
    description: 'Boost repair worker execution flag: when true, the repair worker may create replacement Meta ad/creative objects; when false, repairs park at ready_for_creation. OFF by default.',
  },
  {
    key: 'boost_repair_killed',
    value: false,
    isPublic: 0,
    description: 'Boost repair kill switch: when true, all repair mutations (request + worker) are refused without state changes. Emergency stop.',
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
  console.log('  - Removed boost repair rollout flag seeds')
}

export default { up, down }
