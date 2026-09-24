import { query, queryOne, transaction } from '../../../shared/database/connection.js'
import { uuidToBuffer, bufferToUuid, generateUuid } from '../../../shared/utils/uuid.utils.js'
import { PROMOTION_STATUS, TERMINAL_PROMOTION_STATUSES } from './promotion.model.js'

function mapPromotionRow(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    postId: bufferToUuid(row.post_id),
    clientId: bufferToUuid(row.client_id),
    status: row.status,
    budgetType: row.budget_type || null,
    budgetAmount: row.budget_amount != null ? Number(row.budget_amount) : null,
    spendCap: row.spend_cap != null ? Number(row.spend_cap) : null,
    objective: row.objective || null,
    optimizationGoal: row.optimization_goal || null,
    bidStrategy: row.bid_strategy || null,
    bidAmount: row.bid_amount != null ? Number(row.bid_amount) : null,
    specialAdCategories: typeof row.special_ad_categories === 'string' ? JSON.parse(row.special_ad_categories) : row.special_ad_categories || [],
    targeting: typeof row.targeting === 'string' ? JSON.parse(row.targeting) : row.targeting || null,
    placement: typeof row.placement === 'string' ? JSON.parse(row.placement) : row.placement || null,
    resolvedTargeting: typeof row.resolved_targeting === 'string' ? JSON.parse(row.resolved_targeting) : row.resolved_targeting || null,
    resolvedPlacement: typeof row.resolved_placement === 'string' ? JSON.parse(row.resolved_placement) : row.resolved_placement || null,
    resolvedGraphVersion: row.resolved_graph_version || null,
    resolvedAt: row.resolved_at || null,
    callToAction: row.call_to_action || null,
    link: row.link || null,
    headline: row.headline || null,
    description: row.description || null,
    startAt: row.start_at || null,
    endAt: row.end_at || null,
    chargedPaise: row.charged_paise != null ? Number(row.charged_paise) : 0,
    error: row.error || null,
    settledAt: row.settled_at || null,
    unfilledSlotsSettledAt: row.unfilled_slots_settled_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapPromotionTargetRow(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    promotionId: bufferToUuid(row.promotion_id),
    postTargetId: bufferToUuid(row.post_target_id),
    platform: row.platform,
    platformAccountId: row.platform_account_id ? bufferToUuid(row.platform_account_id) : null,
    status: row.status,
    eligibilityStatus: row.eligibility_status,
    eligibilityReason: row.eligibility_reason || null,
    platformCampaignId: row.platform_campaign_id || null,
    platformAdsetId: row.platform_adset_id || null,
    platformCreativeId: row.platform_creative_id || null,
    platformAdId: row.platform_ad_id || null,
    attempts: Number(row.attempts) || 0,
    error: row.error || null,
    refundedPaise: row.refunded_paise != null ? Number(row.refunded_paise) : 0,
    consumedPaise: row.consumed_paise != null ? Number(row.consumed_paise) : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    postId: row.post_id ? bufferToUuid(row.post_id) : null,
    postTargetStatus: row.pt_status || null,
    metaObjectId: row.pt_meta_object_id || null,
    platformCode: row.pt_platform_code || null,
    platformUserId: row.pt_platform_user_id || null,
    igBusinessAccountId: row.pt_ig_business_account_id || null,
    accessToken: row.pt_access_token ? row.pt_access_token : null,
  }
}

function toDbTimestamp(value) {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

export async function createPromotion(id, postId, clientId, data) {
  await query(
    `INSERT INTO promotions (id, post_id, client_id, status, budget_type, budget_amount, spend_cap,
       objective, optimization_goal, bid_strategy, bid_amount, special_ad_categories, targeting, placement, call_to_action, link,
       headline, description, start_at, end_at, charged_paise)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(postId),
      uuidToBuffer(clientId),
      data.status || 'waiting_for_post',
      data.budgetType || null,
      data.budgetAmount || null,
      data.spendCap || null,
      data.objective || null,
      data.optimizationGoal || null,
      data.bidStrategy || null,
      data.bidAmount || null,
      JSON.stringify(data.specialAdCategories || []),
      data.targeting ? JSON.stringify(data.targeting) : null,
      data.placement ? JSON.stringify(data.placement) : null,
      data.callToAction || null,
      data.link || null,
      data.headline || null,
      data.description || null,
      toDbTimestamp(data.startAt),
      toDbTimestamp(data.endAt),
      data.chargedPaise || 0,
    ]
  )
  return findPromotionById(id)
}

export async function createPromotionTarget(id, promotionId, postTargetId, platform, platformAccountId) {
  await query(
    `INSERT INTO promotion_targets (id, promotion_id, post_target_id, platform, platform_account_id)
     VALUES (?, ?, ?, ?, ?)`,
    [uuidToBuffer(id), uuidToBuffer(promotionId), uuidToBuffer(postTargetId), platform, platformAccountId ? uuidToBuffer(platformAccountId) : null]
  )
  return findPromotionTargetById(id)
}

const NON_TERMINAL_PROMOTION_STATUSES = Object.values(PROMOTION_STATUS).filter((s) => !TERMINAL_PROMOTION_STATUSES.includes(s))

export async function findPromotionsNeedingResolution(limit = 25, afterId = null) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25))
  const placeholders = NON_TERMINAL_PROMOTION_STATUSES.map(() => '?').join(',')
  const params = [...NON_TERMINAL_PROMOTION_STATUSES]
  let cursor = ''
  if (afterId) {
    cursor = 'AND id > ?'
    params.push(uuidToBuffer(afterId))
  }
  const rows = await query(
    `SELECT * FROM promotions WHERE status IN (${placeholders}) AND resolved_at IS NULL ${cursor} ORDER BY id ASC LIMIT ${safeLimit}`,
    params
  )
  return rows.map(mapPromotionRow)
}

export async function countUnresolvedPromotions() {
  const placeholders = NON_TERMINAL_PROMOTION_STATUSES.map(() => '?').join(',')
  const row = await queryOne(
    `SELECT COUNT(*) as c FROM promotions WHERE status IN (${placeholders}) AND resolved_at IS NULL`,
    NON_TERMINAL_PROMOTION_STATUSES
  )
  return Number(row?.c) || 0
}

export async function findPromotionById(id) {
  const row = await queryOne('SELECT * FROM promotions WHERE id = ?', [uuidToBuffer(id)])
  return mapPromotionRow(row)
}

export async function findPromotionByPostId(postId) {
  const row = await queryOne('SELECT * FROM promotions WHERE post_id = ?', [uuidToBuffer(postId)])
  return mapPromotionRow(row)
}

export async function findPromotionTargetsByPromotionId(promotionId) {
  const rows = await query('SELECT * FROM promotion_targets WHERE promotion_id = ? ORDER BY created_at ASC', [uuidToBuffer(promotionId)])
  return rows.map(mapPromotionTargetRow)
}

export async function findPromotionTargetById(id) {
  const row = await queryOne(
    `SELECT ptgt.*, pt.post_id, pt.status as pt_status, pt.meta_object_id as pt_meta_object_id,
            p.code as pt_platform_code, upa.platform_user_id as pt_platform_user_id,
            upa.instagram_business_account_id as pt_ig_business_account_id, upa.access_token as pt_access_token
     FROM promotion_targets ptgt
     JOIN post_targets pt ON pt.id = ptgt.post_target_id
     JOIN user_platform_accounts upa ON upa.id = pt.platform_account_id
     JOIN platforms p ON p.id = upa.platform_id
     WHERE ptgt.id = ?`,
    [uuidToBuffer(id)]
  )
  const mapped = mapPromotionTargetRow(row)
  if (mapped?.accessToken) {
    const { decrypt } = await import('../../../shared/utils/crypto.utils.js')
    mapped.accessToken = decrypt(mapped.accessToken)
  }
  return mapped
}

export async function findPromotionTargetByPostTargetId(postTargetId) {
  const row = await queryOne('SELECT * FROM promotion_targets WHERE post_target_id = ?', [uuidToBuffer(postTargetId)])
  return mapPromotionTargetRow(row)
}

export async function findPendingPromotionTargetsForPostTargetIds(postTargetIds) {
  if (!postTargetIds.length) return []
  const placeholders = postTargetIds.map(() => '?').join(', ')
  const rows = await query(
    `SELECT * FROM promotion_targets WHERE post_target_id IN (${placeholders}) AND status = 'pending'`,
    postTargetIds.map(uuidToBuffer)
  )
  return rows.map(mapPromotionTargetRow)
}

/**
 * Three independent reasons a promotion_target needs a nudge, unioned in one
 * query (all still gated on no active queued/running job for it):
 *   1. pending, underlying post live — the original "never got its first job" case
 *   2. validating/creating for >15min, underlying post still live — a worker
 *      died mid-flight (crash recovery; 15min > the 10min job-stale window so
 *      a merely-slow-but-alive worker is never falsely reclaimed here)
 *   3. underlying post_target permanently failed — this share will never
 *      self-heal (the post can't retroactively become "posted"), so it must
 *      be swept regardless of promotion_target status or staleness
 */
export async function findStuckPendingPromotionTargets() {
  const rows = await query(
    `SELECT ptgt.* FROM promotion_targets ptgt
     JOIN post_targets pt ON pt.id = ptgt.post_target_id
     JOIN promotions pr ON pr.id = ptgt.promotion_id
     WHERE pr.status IN ('waiting_for_post', 'validating', 'creating')
       AND pt.deletion_review_state = 'none'
       AND (
         (ptgt.status = 'pending' AND pt.status = 'posted' AND pt.meta_object_id IS NOT NULL)
         OR (ptgt.status IN ('validating', 'creating') AND pt.status = 'posted' AND pt.meta_object_id IS NOT NULL AND ptgt.updated_at < NOW() - INTERVAL 15 MINUTE)
         OR (ptgt.status IN ('pending', 'validating', 'creating') AND pt.status = 'failed')
       )
       AND NOT EXISTS (
         SELECT 1 FROM campaign_jobs j
         WHERE j.job_type = 'promotion_execute'
           AND LOWER(REPLACE(JSON_UNQUOTE(JSON_EXTRACT(j.payload, '$.promotionTargetId')), '-', '')) = HEX(ptgt.id)
           AND j.status IN ('queued', 'running')
       )`
  )
  return rows.map(mapPromotionTargetRow)
}

/**
 * Resets a target stuck at validating/creating (worker died mid-flight, per
 * findStuckPendingPromotionTargets' staleness branch) back to pending so it
 * becomes claimable again via claimPromotionTargetForCreation.
 */
export async function resetStalePromotionTargetToPending(id) {
  const result = await query(
    "UPDATE promotion_targets SET status = 'pending' WHERE id = ? AND status IN ('validating', 'creating')",
    [uuidToBuffer(id)]
  )
  return result.affectedRows > 0
}

/**
 * DB-level exactly-once claim for entering Meta object creation. Guards
 * against the campaign_jobs stale-reclaim (10min) double-dispatching the
 * same promotion_target while the original worker is still alive but slow —
 * only one concurrent caller can win the pending/validating -> creating
 * transition; the loser must stand down rather than risk creating duplicate
 * Meta objects. Deliberately excludes 'creating' as a source (that would
 * make the guard a no-op) — recovery for a genuinely stuck 'creating' target
 * goes through resetStalePromotionTargetToPending first.
 */
export async function claimPromotionTargetForCreation(id) {
  const result = await query(
    "UPDATE promotion_targets SET status = 'creating' WHERE id = ? AND status IN ('pending', 'validating')",
    [uuidToBuffer(id)]
  )
  return result.affectedRows > 0
}

/**
 * Guarded active -> paused / paused -> active transitions for the deletion
 * pause/resume paths. Without the WHERE-status guard, a concurrent cancel or
 * confirmed-deletion settle (both plain writes on the same row) racing
 * against pauseBoostForDeletionCandidate/resumeBoostAfterRecovery could
 * resurrect an already-terminated target back to paused/active.
 */
export async function claimPromotionTargetPause(id) {
  const result = await query(
    "UPDATE promotion_targets SET status = 'paused' WHERE id = ? AND status = 'active'",
    [uuidToBuffer(id)]
  )
  return result.affectedRows > 0
}

export async function claimPromotionTargetResume(id) {
  const result = await query(
    "UPDATE promotion_targets SET status = 'active' WHERE id = ? AND status = 'paused'",
    [uuidToBuffer(id)]
  )
  return result.affectedRows > 0
}

/**
 * Guarded active/paused -> needs_repair claim before a repair takes over the
 * target's Meta objects. Exclusivity fence for the repair flow — a target
 * already needs_repair (a repair already claimed it) or already
 * failed/cancelled cannot be claimed again.
 */
export async function claimPromotionTargetForRepairSwap(id) {
  const result = await query(
    "UPDATE promotion_targets SET status = 'needs_repair' WHERE id = ? AND status IN ('active', 'paused')",
    [uuidToBuffer(id)]
  )
  return result.affectedRows > 0
}

/**
 * Guarded exit from needs_repair once a repair completes (toStatus='active')
 * or is exhausted (toStatus='failed'). Only ever fires from needs_repair —
 * a target that left the repair flow through some other path (e.g. a
 * concurrent cancel) is never resurrected by a late-finishing repair job.
 */
export async function restorePromotionTargetAfterRepair(id, toStatus) {
  const result = await query(
    'UPDATE promotion_targets SET status = ? WHERE id = ? AND status = ?',
    [toStatus, uuidToBuffer(id), 'needs_repair']
  )
  return result.affectedRows > 0
}

/**
 * Targets due for the ad-level status+issues poll: live (active/paused)
 * with a Meta ad object to check, oldest-synced first. Independent of the
 * Insights-piggyback cadence (1-6h) — issue detection needs to be far
 * faster than spend reporting for a disapproval to become actionable.
 */
export async function findDuePromotionTargetsForStatusSync(limit) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100))
  const rows = await query(
    `SELECT ptgt.*, pt.post_id, pt.status as pt_status, pt.meta_object_id as pt_meta_object_id,
            p.code as pt_platform_code, upa.platform_user_id as pt_platform_user_id,
            upa.instagram_business_account_id as pt_ig_business_account_id, upa.access_token as pt_access_token
     FROM promotion_targets ptgt
     JOIN post_targets pt ON pt.id = ptgt.post_target_id
     JOIN user_platform_accounts upa ON upa.id = pt.platform_account_id
     JOIN platforms p ON p.id = upa.platform_id
     WHERE ptgt.status IN ('active', 'paused') AND ptgt.platform_ad_id IS NOT NULL
     ORDER BY ptgt.status_synced_at IS NOT NULL, ptgt.status_synced_at ASC
     LIMIT ${safeLimit}`
  )
  return rows.map(mapPromotionTargetRow)
}

export async function stampPromotionTargetStatusSync(id) {
  await query('UPDATE promotion_targets SET status_synced_at = NOW() WHERE id = ?', [uuidToBuffer(id)])
}

export async function updatePromotionTarget(id, data) {
  const fields = []
  const params = []
  if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status) }
  if (data.eligibilityStatus !== undefined) { fields.push('eligibility_status = ?'); params.push(data.eligibilityStatus) }
  if (data.eligibilityReason !== undefined) { fields.push('eligibility_reason = ?'); params.push(data.eligibilityReason) }
  if (data.platformCampaignId !== undefined) { fields.push('platform_campaign_id = ?'); params.push(data.platformCampaignId) }
  if (data.platformAdsetId !== undefined) { fields.push('platform_adset_id = ?'); params.push(data.platformAdsetId) }
  if (data.platformCreativeId !== undefined) { fields.push('platform_creative_id = ?'); params.push(data.platformCreativeId) }
  if (data.platformAdId !== undefined) { fields.push('platform_ad_id = ?'); params.push(data.platformAdId) }
  if (data.attempts !== undefined) { fields.push('attempts = ?'); params.push(data.attempts) }
  if (data.error !== undefined) { fields.push('error = ?'); params.push(data.error) }
  if (data.refundedPaise !== undefined) { fields.push('refunded_paise = ?'); params.push(data.refundedPaise) }
  if (data.consumedPaise !== undefined) { fields.push('consumed_paise = ?'); params.push(data.consumedPaise) }
  if (fields.length === 0) return
  params.push(uuidToBuffer(id))
  await query(`UPDATE promotion_targets SET ${fields.join(', ')} WHERE id = ?`, params)
}

/**
 * DB-level exactly-once claim for a per-target refund. Only the caller that
 * flips refunded_paise 0 -> share owns the coin refund; concurrent workers,
 * retries, and admin retries all lose the race. Runs inside the caller's
 * transaction together with the coin refund so a failed refund rolls the
 * claim back (retry possible, double-refund impossible).
 */
export async function claimPromotionTargetRefund(id, sharePaise) {
  const result = await query(
    'UPDATE promotion_targets SET refunded_paise = ? WHERE id = ? AND refunded_paise = 0 AND consumed_paise = 0',
    [sharePaise, uuidToBuffer(id)]
  )
  return result.affectedRows > 0
}

/**
 * Guarded consume stamp (mirrors the cancel path's was-active semantics).
 * Idempotent by construction — no coin movement, claim is the write.
 */
export async function claimPromotionTargetConsume(id, paise) {
  const result = await query(
    'UPDATE promotion_targets SET consumed_paise = ? WHERE id = ? AND consumed_paise = 0 AND refunded_paise = 0',
    [paise, uuidToBuffer(id)]
  )
  return result.affectedRows > 0
}

/**
 * DB-level exactly-once claim for promotion leftover settlement. Only the
 * first claimant computes and pays the leftover; later callers see settled.
 */
export async function claimPromotionSettled(id, settledAt) {
  const result = await query(
    'UPDATE promotions SET settled_at = ? WHERE id = ? AND settled_at IS NULL',
    [settledAt, uuidToBuffer(id)]
  )
  return result.affectedRows > 0
}

/**
 * DB-level exactly-once claim for refunding boost slots that were charged
 * upfront but never got a promotion_target row at all (a publisher slot
 * nobody accepted by the response deadline). Shrinks charged_paise directly
 * in the same guarded UPDATE — after this commits, the promotion's
 * charged_paise correctly reflects only the slots that actually
 * materialized (or are about to), so the existing per-target
 * consume/refund and settlePromotionLeftover math need no further changes.
 */
export async function claimPromotionUnfilledSlots(id, refundPaise, settledAt) {
  const result = await query(
    `UPDATE promotions SET charged_paise = charged_paise - ?, unfilled_slots_settled_at = ?
     WHERE id = ? AND unfilled_slots_settled_at IS NULL AND charged_paise >= ?`,
    [refundPaise, settledAt, uuidToBuffer(id), refundPaise]
  )
  return result.affectedRows > 0
}

export async function updatePromotion(id, data) {
  const fields = []
  const params = []
  if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status) }
  if (data.error !== undefined) { fields.push('error = ?'); params.push(data.error) }
  if (data.chargedPaise !== undefined) { fields.push('charged_paise = ?'); params.push(data.chargedPaise) }
  if (data.settledAt !== undefined) { fields.push('settled_at = ?'); params.push(data.settledAt) }
  if (data.resolvedTargeting !== undefined) { fields.push('resolved_targeting = ?'); params.push(data.resolvedTargeting ? JSON.stringify(data.resolvedTargeting) : null) }
  if (data.resolvedPlacement !== undefined) { fields.push('resolved_placement = ?'); params.push(data.resolvedPlacement ? JSON.stringify(data.resolvedPlacement) : null) }
  if (data.resolvedGraphVersion !== undefined) { fields.push('resolved_graph_version = ?'); params.push(data.resolvedGraphVersion) }
  if (data.resolvedAt !== undefined) { fields.push('resolved_at = ?'); params.push(data.resolvedAt) }
  if (fields.length === 0) return
  params.push(uuidToBuffer(id))
  await query(`UPDATE promotions SET ${fields.join(', ')} WHERE id = ?`, params)
}

export async function updatePromotionWithStatusGuard(id, data, expectedStatus) {
  const fields = []
  const params = []
  if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status) }
  if (data.error !== undefined) { fields.push('error = ?'); params.push(data.error) }
  if (fields.length === 0) return null
  params.push(expectedStatus, uuidToBuffer(id))
  const result = await query(`UPDATE promotions SET ${fields.join(', ')} WHERE status = ? AND id = ?`, params)
  if (result.affectedRows === 0) return null
  return findPromotionById(id)
}

export { transaction }
