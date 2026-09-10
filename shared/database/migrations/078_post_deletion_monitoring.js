/**
 * Publisher deleted-post monitoring.
 *
 * Two orthogonal state axes on post_targets (a target is NEVER marked by
 * post_targets.status — `posted` stays `posted`; remote availability and
 * violation review are tracked here instead):
 *
 *   remote_content_state:
 *     visible  — object verified present on the platform (initial state: we
 *                published it, so it exists until proven otherwise)
 *     hidden   — FB `is_hidden=true` (reversible; NOT a deletion signal)
 *     missing  — platform-verified object-not-found candidate (grace applies)
 *     unknown  — OAuth/permission/token failure, rate limit, timeout, network
 *                failure, or any unverified error. UNKNOWN is recorded only
 *                (checked_at stamp) and NEVER creates or confirms a violation.
 *
 *   deletion_review_state:
 *     none      — no deletion candidate
 *     flagged   — strong deletion candidate; boost spend is paused immediately
 *                 (reversible when resumable), enforcement waits for re-verify
 *     confirmed — MISSING re-verified after the 48h grace OR a second
 *                 platform-asserted delete. PERMANENTLY TERMINAL: never
 *                 transitions back, never resumes, never reconnects, no repost.
 *     dismissed — admin reviewed: violation decision dismissed ONLY (payout
 *                 block lifted, violation_count corrected). Deletion stays
 *                 terminal — remote_content_state stays `missing`, the target
 *                 stays terminal, the boost stays stopped.
 *
 *   boost_paused_by_deletion:
 *     1 only when the deletion system paused an ACTIVE boost. Resume on
 *     recovery is allowed ONLY when this flag is 1 AND the boost target is
 *     still PAUSED. Boosts paused by anyone else, or FAILED/CANCELLED, are
 *     never resumed by the deletion system.
 *
 * post_publisher_requests gains violation accounting (v1: informational only,
 * no automated suspension):
 *   violation_count INT — atomic +/- per confirmed/dismissed violation
 *   last_violation_at — latest confirmed violation
 *   clawback_paise BIGINT — 0 until admin clawback stamps the full amount
 *     (DB-level exactly-once guard: UPDATE ... WHERE clawback_paise = 0);
 *     the actual coin spend runs in the SAME transaction, so insufficient
 *     balance rolls everything back and clawback stays pending (all-or-nothing).
 *   clawback_at — when the clawback completed.
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
  await add('remote_content_state', "remote_content_state ENUM('visible','hidden','missing','unknown') NOT NULL DEFAULT 'visible' AFTER last_meta_event_at")
  await add('remote_state_checked_at', 'remote_state_checked_at TIMESTAMP NULL DEFAULT NULL AFTER remote_content_state')
  await add('remote_state_source', "remote_state_source ENUM('poll','webhook','admin') NULL DEFAULT NULL AFTER remote_state_checked_at")
  await add('deletion_review_state', "deletion_review_state ENUM('none','flagged','confirmed','dismissed') NOT NULL DEFAULT 'none' AFTER remote_state_source")
  await add('deletion_flagged_at', 'deletion_flagged_at TIMESTAMP NULL DEFAULT NULL AFTER deletion_review_state')
  await add('deletion_confirmed_at', 'deletion_confirmed_at TIMESTAMP NULL DEFAULT NULL AFTER deletion_flagged_at')
  await add('deletion_reason', 'deletion_reason VARCHAR(255) NULL DEFAULT NULL AFTER deletion_confirmed_at')
  await add('violation_counted', 'violation_counted TINYINT NOT NULL DEFAULT 0 AFTER deletion_reason')
  await add('boost_paused_by_deletion', 'boost_paused_by_deletion TINYINT NOT NULL DEFAULT 0 AFTER violation_counted')

  const [idx] = await pool.query(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets' AND INDEX_NAME = 'idx_pt_deletion_review'"
  )
  if (idx.length === 0) {
    try {
      await pool.execute('ALTER TABLE post_targets ADD KEY idx_pt_deletion_review (deletion_review_state, deletion_flagged_at)')
      console.log('  + idx_pt_deletion_review')
    } catch (e) { console.log('  ~ idx_pt_deletion_review not added', e.message) }
  }

  const [pprCols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_publisher_requests'"
  )
  const pprHas = (name) => pprCols.some(c => c.COLUMN_NAME === name)
  const pprAdd = async (name, ddl) => {
    if (!pprHas(name)) {
      await pool.execute(`ALTER TABLE post_publisher_requests ADD COLUMN ${ddl}`)
      console.log(`  + post_publisher_requests.${name}`)
    } else {
      console.log(`  ~ post_publisher_requests.${name} present`)
    }
  }
  await pprAdd('violation_count', 'violation_count INT NOT NULL DEFAULT 0 AFTER payout_transaction_id')
  await pprAdd('last_violation_at', 'last_violation_at TIMESTAMP NULL DEFAULT NULL AFTER violation_count')
  await pprAdd('clawback_paise', 'clawback_paise BIGINT NOT NULL DEFAULT 0 AFTER last_violation_at')
  await pprAdd('clawback_at', 'clawback_at TIMESTAMP NULL DEFAULT NULL AFTER clawback_paise')
}

export async function down({ context: pool }) {
  const dropCol = async (table, name) => {
    const [cols] = await pool.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
      [table, name]
    )
    if (cols.length > 0) {
      await pool.execute(`ALTER TABLE ${table} DROP COLUMN ${name}`)
      console.log(`  - ${table}.${name}`)
    }
  }
  const [idx] = await pool.query(
    'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
    ['post_targets', 'idx_pt_deletion_review']
  )
  if (idx.length > 0) {
    await pool.execute('ALTER TABLE post_targets DROP INDEX idx_pt_deletion_review')
    console.log('  - idx_pt_deletion_review')
  }
  for (const name of ['boost_paused_by_deletion', 'violation_counted', 'deletion_reason', 'deletion_confirmed_at', 'deletion_flagged_at', 'deletion_review_state', 'remote_state_source', 'remote_state_checked_at', 'remote_content_state']) {
    await dropCol('post_targets', name)
  }
  for (const name of ['clawback_at', 'clawback_paise', 'last_violation_at', 'violation_count']) {
    await dropCol('post_publisher_requests', name)
  }
}

export default { up, down }
