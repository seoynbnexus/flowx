import { v7 as generateUuid } from 'uuid'

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex')
}

const SEEDS = [
  {
    key: 'post_media_quota_bytes',
    value: Number(process.env.POST_MEDIA_QUOTA_BYTES) || 512 * 1024 * 1024,
    description: 'Total media storage quota per user in bytes',
  },
  {
    key: 'post_media_max_file_bytes',
    value: Number(process.env.POST_MEDIA_MAX_FILE_BYTES) || 200 * 1024 * 1024,
    description: 'Maximum size for a single uploaded media file in bytes',
  },
]

export async function up({ context: pool }) {
  for (const seed of SEEDS) {
    await pool.execute(
      `INSERT IGNORE INTO app_config (id, config_key, config_value, is_public, description, version)
       VALUES (?, ?, ?, 1, ?, 1)`,
      [uuidToBuffer(generateUuid()), seed.key, JSON.stringify(seed.value), seed.description]
    )
    console.log(`  + Seeded app_config ${seed.key}`)
  }
}

export async function down({ context: pool }) {
  for (const seed of SEEDS) {
    await pool.execute('DELETE FROM app_config WHERE config_key = ?', [seed.key])
  }
  console.log('  - Removed media config seeds')
}

export default { up, down }