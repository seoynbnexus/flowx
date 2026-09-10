import { query, queryOne } from '../../../shared/database/connection.js'
import { uuidToBuffer, bufferToUuid } from '../../../shared/utils/uuid.utils.js'
import { decrypt } from '../../../shared/utils/crypto.utils.js'

const REASON_MAX = 255

/**
 * Targets due for a remote-existence check. A target is due when:
 *   - status = 'posted' with a stored Meta object id (match-by-immutable-id),
 *   - the post is not a story (story expiry is indistinguishable from
 *     deletion — stories are excluded from deletion monitoring),
 *   - within the monitoring window (30d from posted_at — PostTarget/boost
 *     lifecycle, never Post.created_at),
 *   - review is 'none' and the last check is stale (unknown states keep
 *     re-checking at the same cadence), OR review is 'flagged' with a MISSING
 *     remote state whose flag predates the grace period (grace re-verify).
 * Confirmed/dismissed targets never poll again (terminal).
 */
export async function findRemoteHealthDueTargets({
  checkSeconds = 21600,
  graceSeconds = 172800,
  monitorDays = 30,
  limit = 100,
} = {}) {
  const check = Math.max(300, Math.floor(Number(checkSeconds) || 21600))
  const grace = Math.max(300, Math.floor(Number(graceSeconds) || 172800))
  const days = Math.max(1, Math.floor(Number(monitorDays) || 30))
  const lim = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)))
  const rows = await query(
    `SELECT DISTINCT pt.id AS target_id, pt.post_id, pt.meta_object_id,
            pt.target_type, pt.publisher_request_id, pt.platform_account_id,
            pt.remote_content_state, pt.deletion_review_state,
            pt.deletion_flagged_at, pt.remote_state_checked_at,
            pt.remote_token_key, pt.remote_verified_at,
            p.type AS post_type,
            pl.code AS platform_code, upa.access_token AS access_token,
            upa.platform_user_id AS platform_user_id
       FROM post_targets pt
       JOIN posts p ON p.id = pt.post_id
       JOIN user_platform_accounts upa ON upa.id = pt.platform_account_id
       JOIN platforms pl ON pl.id = upa.platform_id
      WHERE pt.status = 'posted'
        AND pt.meta_object_id IS NOT NULL
        AND p.type != 'story'
        AND pt.posted_at IS NOT NULL
        AND pt.posted_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
        AND pt.deletion_review_state IN ('none', 'flagged')
        AND (
          (pt.deletion_review_state = 'none'
           AND (pt.remote_state_checked_at IS NULL
                OR pt.remote_state_checked_at < DATE_SUB(NOW(), INTERVAL ${check} SECOND)))
          OR (pt.deletion_review_state = 'flagged'
              AND pt.remote_content_state = 'missing'
              AND pt.deletion_flagged_at IS NOT NULL
              AND pt.deletion_flagged_at < DATE_SUB(NOW(), INTERVAL ${grace} SECOND))
        )
        AND NOT EXISTS (
          SELECT 1 FROM campaign_jobs j
          WHERE j.campaign_id = pt.post_id AND j.job_type = 'post_remote_health' AND j.status IN ('queued', 'running')
        )
      ORDER BY pt.deletion_flagged_at ASC, pt.remote_state_checked_at ASC
      LIMIT ${lim}`,
  )
  return rows.map(r => ({
    postTargetId: bufferToUuid(r.target_id),
    postId: bufferToUuid(r.post_id),
    metaObjectId: r.meta_object_id || null,
    targetType: r.target_type,
    publisherRequestId: r.publisher_request_id ? bufferToUuid(r.publisher_request_id) : null,
    platformAccountId: bufferToUuid(r.platform_account_id),
    remoteContentState: r.remote_content_state || 'visible',
    deletionReviewState: r.deletion_review_state || 'none',
    deletionFlaggedAt: r.deletion_flagged_at || null,
    remoteStateCheckedAt: r.remote_state_checked_at || null,
    remoteTokenKey: r.remote_token_key || null,
    remoteVerifiedAt: r.remote_verified_at || null,
    postType: r.post_type,
    platformCode: r.platform_code || null,
    platformUserId: r.platform_user_id ? String(r.platform_user_id) : null,
    accessToken: r.access_token ? decrypt(r.access_token) : null,
  }))
}

/**
 * Single-target fetch for the webhook-expedited remote-health job. Same
 * eligibility as the due query (posted + stored Meta id + non-story +
 * non-terminal review + not already meta-deleted) so expedited probes can
 * never resurrect terminal targets or stories.
 */
export async function findRemoteHealthTargetById(targetId) {
  const rows = await query(
    `SELECT pt.id AS target_id, pt.post_id, pt.meta_object_id,
            pt.target_type, pt.publisher_request_id, pt.platform_account_id,
            pt.remote_content_state, pt.deletion_review_state,
            pt.deletion_flagged_at, pt.remote_state_checked_at,
            pt.remote_token_key, pt.remote_verified_at,
            p.type AS post_type,
            pl.code AS platform_code, upa.access_token AS access_token,
            upa.platform_user_id AS platform_user_id
       FROM post_targets pt
       JOIN posts p ON p.id = pt.post_id
       JOIN user_platform_accounts upa ON upa.id = pt.platform_account_id
       JOIN platforms pl ON pl.id = upa.platform_id
      WHERE pt.id = ?
        AND pt.status = 'posted'
        AND pt.meta_object_id IS NOT NULL
        AND p.type != 'story'
        AND pt.deletion_review_state IN ('none', 'flagged')
        AND pt.meta_deleted_at IS NULL`,
    [uuidToBuffer(targetId)]
  )
  if (!rows.length) return null
  const r = rows[0]
  return {
    postTargetId: bufferToUuid(r.target_id),
    postId: bufferToUuid(r.post_id),
    metaObjectId: r.meta_object_id || null,
    targetType: r.target_type,
    publisherRequestId: r.publisher_request_id ? bufferToUuid(r.publisher_request_id) : null,
    platformAccountId: bufferToUuid(r.platform_account_id),
    remoteContentState: r.remote_content_state || 'visible',
    deletionReviewState: r.deletion_review_state || 'none',
    deletionFlaggedAt: r.deletion_flagged_at || null,
    remoteStateCheckedAt: r.remote_state_checked_at || null,
    remoteTokenKey: r.remote_token_key || null,
    remoteVerifiedAt: r.remote_verified_at || null,
    postType: r.post_type,
    platformCode: r.platform_code || null,
    platformUserId: r.platform_user_id ? String(r.platform_user_id) : null,
    accessToken: r.access_token ? decrypt(r.access_token) : null,
  }
}

/**
 * Flag a deletion candidate. Guarded to review='none' so repeated webhook
 * events and poller passes converge on the first flag. Returns true when this
 * call created the flag (caller owns flag-time side effects: boost pause).
 */
export async function flagDeletionCandidate(targetId, { remoteState = 'missing', source = 'poll', reason = null } = {}) {
  const result = await query(
    `UPDATE post_targets
         SET remote_content_state = ?,
             remote_state_checked_at = NOW(),
             remote_state_source = ?,
             deletion_review_state = 'flagged',
             deletion_flagged_at = NOW(),
             deletion_reason = ?
       WHERE id = ? AND deletion_review_state = 'none'`,
    [remoteState, source, reason ? String(reason).slice(0, REASON_MAX) : null, uuidToBuffer(targetId)]
  )
  return result.affectedRows > 0
}

/**
 * Confirm a flagged deletion after the grace re-verify. Guarded to
 * review='flagged' so only the first confirmation wins (caller owns
 * enforcement: boost terminalization, payout block, violation accounting).
 * CONFIRMED is permanently terminal — no transition out exists.
 */
export async function confirmFlaggedDeletion(targetId, reason = null) {
  const result = await query(
    `UPDATE post_targets
         SET deletion_review_state = 'confirmed',
             deletion_confirmed_at = NOW(),
             deletion_reason = COALESCE(?, deletion_reason),
             meta_remote_status = 'deleted',
             meta_deleted_at = NOW()
       WHERE id = ? AND deletion_review_state = 'flagged'`,
    [reason ? String(reason).slice(0, REASON_MAX) : null, uuidToBuffer(targetId)]
  )
  return result.affectedRows > 0
}

/**
 * Recover a flagged candidate whose object reappeared during re-verification.
 * Guarded to review='flagged' — CONFIRMED is terminal and never recovers.
 * Returns true when this call cleared the flag (caller owns recovery side
 * effects: boost resume when the deletion system paused it).
 */
export async function recoverFlaggedDeletion(targetId, remoteState, source, tokenKey = null) {
  const result = await query(
    `UPDATE post_targets
        SET remote_content_state = ?,
            remote_state_checked_at = NOW(),
            remote_state_source = ?,
            remote_token_key = COALESCE(?, remote_token_key),
            remote_verified_at = NOW(),
            deletion_review_state = 'none',
            deletion_flagged_at = NULL,
            deletion_reason = NULL
      WHERE id = ? AND deletion_review_state = 'flagged'`,
    [remoteState, source, tokenKey, uuidToBuffer(targetId)]
  )
  return result.affectedRows > 0
}

/**
 * Stamp a remote-state observation without touching the review pipeline.
 * Used for visible/hidden/unknown observations on non-terminal targets.
 * Flagged targets keep their flag until the explicit grace re-verify (a
 * VISIBLE observation routes to recoverFlaggedDeletion instead).
 *
 * Verified observations (visible/hidden) arm the evidence baseline: they
 * stamp remote_verified_at and refresh remote_token_key (COALESCE keeps the
 * previous key when the caller has none). UNKNOWN observations touch only
 * checked_at/source — remote_content_state flips but the verified baseline
 * and token key survive so later evidence stays trustworthy.
 */
export async function stampRemoteState(targetId, remoteState, source, tokenKey = null) {
  if (remoteState === 'visible' || remoteState === 'hidden') {
    await query(
      `UPDATE post_targets
          SET remote_content_state = ?,
              remote_state_checked_at = NOW(),
              remote_state_source = ?,
              remote_token_key = COALESCE(?, remote_token_key),
              remote_verified_at = NOW()
        WHERE id = ? AND deletion_review_state IN ('none', 'flagged')`,
      [remoteState, source, tokenKey, uuidToBuffer(targetId)]
    )
    return
  }
  await query(
    `UPDATE post_targets
        SET remote_content_state = ?,
            remote_state_checked_at = NOW(),
            remote_state_source = ?
      WHERE id = ? AND deletion_review_state IN ('none', 'flagged')`,
    [remoteState, source, uuidToBuffer(targetId)]
  )
}

/**
 * Non-blocking HIDDEN marker (FB is_hidden). Hidden is reversible and never
 * a deletion signal — no review change. It IS a positive observation, so the
 * evidence baseline is armed (verified_at + token key).
 */
export async function markRemoteHidden(targetId, source, tokenKey = null) {
  await query(
    `UPDATE post_targets
        SET remote_content_state = 'hidden',
            remote_state_checked_at = NOW(),
            remote_state_source = ?,
            remote_token_key = COALESCE(?, remote_token_key),
            remote_verified_at = NOW()
      WHERE id = ? AND deletion_review_state IN ('none', 'flagged')`,
    [source, tokenKey, uuidToBuffer(targetId)]
  )
}

/**
 * Violation-only dismissal. Guarded to review='confirmed' and changes ONLY
 * the review decision: payout block lifted, violation_count corrected via
 * violationCounted. Remote deletion stays terminal (remote_content_state
 * stays 'missing', confirmed_at stays set, boost stays stopped).
 */
export async function dismissConfirmedViolation(targetId) {
  const result = await query(
    `UPDATE post_targets
        SET deletion_review_state = 'dismissed'
      WHERE id = ? AND deletion_review_state = 'confirmed'`,
    [uuidToBuffer(targetId)]
  )
  return result.affectedRows > 0
}

export async function setBoostPausedByDeletion(targetId, on) {
  await query('UPDATE post_targets SET boost_paused_by_deletion = ? WHERE id = ?', [on ? 1 : 0, uuidToBuffer(targetId)])
}

export async function setViolationCounted(targetId, on) {
  await query('UPDATE post_targets SET violation_counted = ? WHERE id = ?', [on ? 1 : 0, uuidToBuffer(targetId)])
}

export async function incrementRequestViolation(requestId) {
  await query(
    'UPDATE post_publisher_requests SET violation_count = violation_count + 1, last_violation_at = NOW() WHERE id = ?',
    [uuidToBuffer(requestId)]
  )
}

export async function decrementRequestViolation(requestId) {
  await query(
    'UPDATE post_publisher_requests SET violation_count = GREATEST(0, violation_count - 1) WHERE id = ?',
    [uuidToBuffer(requestId)]
  )
}

/**
 * Idempotent clawback claim. Part of the caller's transaction: sets the full
 * requested amount only when nothing was ever claimed — if the coin spend
 * throws (insufficient balance), the whole transaction rolls back and the
 * clawback stays pending (strict all-or-nothing).
 */
export async function claimClawback(requestId, paise) {
  const result = await query(
    'UPDATE post_publisher_requests SET clawback_paise = ?, clawback_at = NOW() WHERE id = ? AND clawback_paise = 0',
    [paise, uuidToBuffer(requestId)]
  )
  return result.affectedRows > 0
}

export async function findViolationTargetsByPostId(postId) {
  const rows = await query(
    `SELECT pt.*, p.code as platform_code, upa.platform_user_id, upa.platform_display_name, upa.platform_username
       FROM post_targets pt
       JOIN user_platform_accounts upa ON upa.id = pt.platform_account_id
       JOIN platforms p ON p.id = upa.platform_id
      WHERE pt.post_id = ?
        AND pt.deletion_review_state IN ('flagged', 'confirmed', 'dismissed')`,
    [uuidToBuffer(postId)]
  )
  return rows.map(r => ({
    postTargetId: bufferToUuid(r.id),
    postId: bufferToUuid(r.post_id),
    targetType: r.target_type,
    publisherRequestId: r.publisher_request_id ? bufferToUuid(r.publisher_request_id) : null,
    metaObjectId: r.meta_object_id || null,
    platformCode: r.platform_code || null,
    platformDisplayName: r.platform_display_name || null,
    platformUsername: r.platform_username || null,
    remoteContentState: r.remote_content_state || 'visible',
    deletionReviewState: r.deletion_review_state || 'none',
    deletionFlaggedAt: r.deletion_flagged_at || null,
    deletionConfirmedAt: r.deletion_confirmed_at || null,
    deletionReason: r.deletion_reason || null,
    violationCounted: !!r.violation_counted,
    boostPausedByDeletion: !!r.boost_paused_by_deletion,
  }))
}

export async function findConfirmedDeletionTargetsByRequestId(requestId) {
  const rows = await query(
    'SELECT id FROM post_targets WHERE publisher_request_id = ? AND deletion_review_state = ?',
    [uuidToBuffer(requestId), 'confirmed']
  )
  return rows.map(r => bufferToUuid(r.id))
}

export async function findRequestViolationInfo(requestId) {
  const row = await queryOne(
    'SELECT violation_count, last_violation_at, clawback_paise, clawback_at, payout_status, coins_offered FROM post_publisher_requests WHERE id = ?',
    [uuidToBuffer(requestId)]
  )
  if (!row) return null
  return {
    violationCount: Number(row.violation_count) || 0,
    lastViolationAt: row.last_violation_at || null,
    clawbackPaise: Number(row.clawback_paise) || 0,
    clawbackAt: row.clawback_at || null,
    payoutStatus: row.payout_status || 'pending',
    coinsOffered: Number(row.coins_offered) || 0,
  }
}
