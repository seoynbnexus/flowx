async function columnExists(pool, table, column) {
  const [rows] = await pool.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  )
  return rows.length > 0
}

async function addColumn(pool, table, column, ddl) {
  if (await columnExists(pool, table, column)) {
    console.log(`  ~ ${table}.${column} already present`)
  } else {
    await pool.execute(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
    console.log(`  + Added ${table}.${column}`)
  }
}

async function dropColumn(pool, table, column) {
  if (await columnExists(pool, table, column)) {
    await pool.execute(`ALTER TABLE ${table} DROP COLUMN ${column}`)
    console.log(`  - Dropped ${table}.${column}`)
  }
}

// Caches the confirmed Facebook media classification (video/photo/post) that
// getFacebookMediaEngagement's classify-by-trial-and-error loop resolves on
// its first successful sync. Without this, every engagement sync cycle
// re-runs the full try [video, photo, post] loop from scratch — a photo
// target always fails the video-fields attempt first (Meta rejects
// inapplicable fields), forever, on every single cycle. Once a kind is
// confirmed, subsequent syncs try it first and only fall back to the full
// loop if that specific attempt unexpectedly fails (object type genuinely
// changed) — self-healing, never permanently stuck on a stale value.
export async function up({ context: pool }) {
  await addColumn(pool, 'post_targets', 'remote_media_kind', "remote_media_kind VARCHAR(16) NULL DEFAULT NULL AFTER remote_content_state")
}

export async function down({ context: pool }) {
  await dropColumn(pool, 'post_targets', 'remote_media_kind')
}

export default { up, down }
