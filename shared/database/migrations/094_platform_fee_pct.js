import { v7 as generateUuid } from 'uuid'

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex')
}

const SEEDS = [
  {
    key: 'platform_fee_pct',
    value: 10,
    isPublic: 0,
    description: 'Platform fee on publisher payouts, in percent (supports decimals, e.g. 7.5). Applied to campaign and post publisher escrow.',
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
  console.log('  - Removed platform fee seeds')
}

export default { up, down }
