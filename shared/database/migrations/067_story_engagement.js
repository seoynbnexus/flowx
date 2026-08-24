const STORY_COLUMNS = [
  { name: 'impressions', after: 'interactions' },
  { name: 'taps_forward', after: 'impressions' },
  { name: 'taps_back', after: 'taps_forward' },
  { name: 'exits', after: 'taps_back' },
  { name: 'replies', after: 'exits' },
]

async function columnExists(pool, name) {
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_engagement_daily' AND COLUMN_NAME = ?",
    [name]
  )
  return cols.length > 0
}

export async function up({ context: pool }) {
  let after = 'interactions'
  for (const col of STORY_COLUMNS) {
    if (!(await columnExists(pool, col.name))) {
      await pool.execute(`ALTER TABLE post_engagement_daily ADD COLUMN ${col.name} BIGINT NOT NULL DEFAULT 0 AFTER ${after}`)
    }
    after = col.name
  }
}

export async function down({ context: pool }) {
  for (const col of STORY_COLUMNS.reverse()) {
    if (await columnExists(pool, col.name)) {
      await pool.execute(`ALTER TABLE post_engagement_daily DROP COLUMN ${col.name}`)
    }
  }
}

export default { up, down }