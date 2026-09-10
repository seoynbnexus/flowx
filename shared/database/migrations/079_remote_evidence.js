/**
 * Remote-evidence tracking for deletion monitoring.
 *
 *   remote_token_key VARCHAR(64) NULL — fingerprint (sha256 16-hex via
 *     tokenKeyFor) of the token used at the last VERIFIED observation.
 *     NULL = pre-tracking (grandfathered): evidence matching stays armed
 *     until a token change is actually observed. Set only on visible/hidden
 *     observations; MISSING/UNKNOWN probes never touch it, and the classified
 *     MISSING evidence is only trusted when the current probe token matches
 *     this key (or the key is NULL). Rotation disarms the #10 evidence path
 *     until a fresh visible observation re-arms it under the new key.
 *
 *   remote_verified_at TIMESTAMP NULL — timestamp of the last positive
 *     (visible/hidden) remote observation. Backfilled to posted_at for every
 *     posted target: publishing is itself the first verified observation
 *     (made with the page token by construction), so a target deleted before
 *     its first poll still carries a baseline instead of staying UNKNOWN
 *     forever. UNKNOWN observations flip remote_content_state only and never
 *     touch this column — evidence survives inconclusive probes.
 */
export async function up({ context: pool }) {
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets'"
  )
  const has = (name) => cols.some(c => c.COLUMN_NAME === name)
  const add = async (name, ddl) => {
    if (!has(name)) {
      await pool.execute(`ALTER TABLE post_targets ADD COLUMN ${ddl}`)
      console.log(`  + post_targets.${name}`)
    } else {
      console.log(`  ~ post_targets.${name} present`)
    }
  }
  await add('remote_token_key', 'remote_token_key VARCHAR(64) NULL DEFAULT NULL AFTER remote_state_source')
  await add('remote_verified_at', 'remote_verified_at TIMESTAMP NULL DEFAULT NULL AFTER remote_token_key')

  const [backfilled] = await pool.query(
    "UPDATE post_targets SET remote_verified_at = posted_at WHERE status = 'posted' AND posted_at IS NOT NULL AND remote_verified_at IS NULL"
  )
  console.log(`  ~ remote_verified_at backfilled from posted_at: ${backfilled.affectedRows} rows`)
}

export async function down({ context: pool }) {
  const dropCol = async (name) => {
    const [cols] = await pool.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets' AND COLUMN_NAME = ?",
      [name]
    )
    if (cols.length > 0) {
      await pool.execute(`ALTER TABLE post_targets DROP COLUMN ${name}`)
      console.log(`  - post_targets.${name}`)
    }
  }
  await dropCol('remote_verified_at')
  await dropCol('remote_token_key')
}

export default { up, down }
