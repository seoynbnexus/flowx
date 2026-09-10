import * as dmRepo from './deletion-monitoring.repository.js'
import * as postRepo from './post.repository.js'
import * as promoRepo from './promotion.repository.js'
import { NotFoundError, ValidationError, ForbiddenError, ConflictError } from '../../../shared/errors/AppError.js'
import { POST_JOB_TYPES, POST_TARGET_TYPES, REVIEW_ACTIONS } from './post.model.js'
import { PROMOTION_TARGET_STATUS } from './promotion.model.js'
import { REMOTE_CONTENT_STATE, DELETION_REVIEW_STATE } from './deletion-monitoring.model.js'
import { getObjectRemoteState, getPageRemoteState, classifyRemoteStateError } from '../../../shared/services/meta-ads.service.js'
import { isRateLimited, tokenKeyFor } from '../../../shared/services/meta-rate-limiter.js'
import { logMetaEvent } from '../../../shared/services/meta-logger.service.js'
import {
  findAutoJobByRunKey,
  requeueAutoJob,
} from '../campaigns/campaign.repository.js'

export const REMOTE_HEALTH_RUN_KEY = 'remote-health'
export const REMOTE_HEALTH_CHECK_SECONDS = Number(process.env.POST_DELETE_CHECK_SECONDS) || 21600
export const REMOTE_HEALTH_GRACE_SECONDS = (Number(process.env.POST_DELETE_GRACE_HOURS) || 48) * 3600
export const REMOTE_HEALTH_MONITOR_DAYS = Number(process.env.POST_DELETE_MONITOR_DAYS) || 30
export const REMOTE_HEALTH_BATCH_LIMIT = Number(process.env.POST_DELETE_BATCH_LIMIT) || 100

export const remoteHealthSweep = {
  intervalMs: 60 * 1000,
  lastRunAt: 0,
}

async function notifyAdmin(subject, message) {
  try {
    const { sendAdminAlert } = await import('../../../shared/mailer/alert.mailer.js')
    await sendAdminAlert(subject, message)
  } catch {}
}

async function systemToken() {
  try {
    const { resolveAccountContext } = await import('../campaigns/campaign.service.js')
    const { accessToken } = await resolveAccountContext()
    return accessToken || null
  } catch {
    return null
  }
}

function tokenForCheck(target, platform) {
  if (platform === 'instagram') {
    return process.env.META_SYSTEM_USER_TOKEN || target.accessToken || null
  }
  return target.accessToken || null
}

/**
 * Probe one target with evidence-aware classification.
 *
 * FB permission-family errors (code 10/200/210/282 — the deleted-object
 * response under the owner token, live-proven Sep 2026) are only trusted as
 * MISSING when the full evidence chain holds: owner token used, verified
 * baseline exists (remote_verified_at — publish itself backfills it), and
 * the token fingerprint matches the verified observation. On an ambiguous
 * result the page node is probed under the SAME token as a health control
 * (1 cheap GET, only for FB owner-token probes) — page 200 + object code-10
 * = token healthy = deletion stands.
 *
 * Returns { probe, tokenKey } — tokenKey stamps verified observations so a
 * later rotation disarms the evidence until re-verified under the new token.
 */
async function probeTarget(item) {
  const token = tokenForCheck({ accessToken: item.accessToken }, item.platformCode)
  if (!token || isRateLimited(tokenKeyFor(token))) {
    return { probe: null, tokenKey: null }
  }
  const tokenKey = tokenKeyFor(token)
  const context = {
    ownerTokenUsed: item.platformCode === 'facebook' && !!item.accessToken && token === item.accessToken,
    tokenHealthy: null,
    hasVerifiedBaseline: item.remoteVerifiedAt != null,
    tokenKeyMatches: item.remoteTokenKey == null || item.remoteTokenKey === tokenKey,
  }
  let probe = await getObjectRemoteState(item.metaObjectId, token, item.platformCode, context)
  if (probe.permissionAmbiguous && context.ownerTokenUsed) {
    const page = await getPageRemoteState(item.platformUserId, token)
    if (page.state === 'visible') {
      const reclassified = classifyRemoteStateError(probe.error, { ...context, tokenHealthy: true })
      probe = reclassified.permissionAmbiguous ? probe : reclassified
    }
  }
  return { probe, tokenKey }
}

function isPublisherTarget(target) {
  return target.targetType === POST_TARGET_TYPES.PUBLISHER && !!target.publisherRequestId
}

/**
 * Single entry point for every remote-content signal (poller + webhook).
 * Terminal reviews (confirmed/dismissed) are never re-processed.
 */
export async function handleRemoteContentSignal({ postTargetId, remoteState, source, reason = null, detail = null, tokenKey = null }) {
  const targets = await postRepo.findPostTargetsByPostId((await targetPostId(postTargetId)) || '')
  const target = (targets || []).find(t => t.id === postTargetId)
  if (!target) return { ignored: true, reason: 'no_target' }
  const review = target.deletionReviewState || DELETION_REVIEW_STATE.NONE
  if (review === DELETION_REVIEW_STATE.CONFIRMED || review === DELETION_REVIEW_STATE.DISMISSED) {
    return { ignored: true, reason: 'terminal' }
  }
  const msg = reason || detail || null
  const reasonText = msg ? String(msg).slice(0, 250) : null

  if (remoteState === REMOTE_CONTENT_STATE.VISIBLE || remoteState === REMOTE_CONTENT_STATE.HIDDEN) {
    if (review === DELETION_REVIEW_STATE.FLAGGED) {
      const recovered = await dmRepo.recoverFlaggedDeletion(postTargetId, remoteState, source, tokenKey)
      if (!recovered) return { ignored: true, reason: 'race' }
      const resume = await resumeBoostAfterRecovery(target)
      await postRepo.createReviewLog(target.postId, null, REVIEW_ACTIONS.SUBMITTED, (await postRepo.findPostById(target.postId))?.status || 'completed',
        `Deletion candidate recovered on ${target.platformCode || 'platform'} — flag cleared${resume.resumed ? ', boost resumed' : ''}`)
      await logMetaEvent({ action: 'deletion_candidate_recovered', postId: target.postId, postTargetId, remoteState, resumed: resume.resumed })
      return { recovered: true, resumed: resume.resumed }
    }
    if (remoteState === REMOTE_CONTENT_STATE.HIDDEN) {
      await dmRepo.markRemoteHidden(postTargetId, source, tokenKey)
      await logMetaEvent({ action: 'remote_hidden', postId: target.postId, postTargetId, source })
      return { hidden: true }
    }
    await dmRepo.stampRemoteState(postTargetId, REMOTE_CONTENT_STATE.VISIBLE, source, tokenKey)
    return { ok: true, visible: true }
  }

  if (remoteState === REMOTE_CONTENT_STATE.MISSING) {
    if (review === DELETION_REVIEW_STATE.NONE) {
      const flagged = await dmRepo.flagDeletionCandidate(postTargetId, { remoteState, source, reason: reasonText })
      if (!flagged) return { ignored: true, reason: 'race' }
      const pause = await pauseBoostForDeletionCandidate(target)
      await logMetaEvent({ action: 'deletion_candidate_flagged', postId: target.postId, postTargetId, source, reason: msg, boostPaused: pause.paused })
      return { flagged: true, boostPaused: pause.paused }
    }
    // flagged: confirm only after the grace period
    const flaggedAt = target.deletionFlaggedAt ? new Date(target.deletionFlaggedAt).getTime() : 0
    if (Date.now() - flaggedAt < REMOTE_HEALTH_GRACE_SECONDS * 1000) {
      return { pending: true, reason: 'grace' }
    }
    const confirmed = await dmRepo.confirmFlaggedDeletion(postTargetId, reasonText)
    if (!confirmed) return { ignored: true, reason: 'race' }
    await applyDeletionEnforcement({ ...target, deletionReviewState: DELETION_REVIEW_STATE.CONFIRMED })
    return { confirmed: true }
  }

  // unknown: stamp only, never flags
  await dmRepo.stampRemoteState(postTargetId, REMOTE_CONTENT_STATE.UNKNOWN, source)
  return { unknown: true }
}

async function targetPostId(postTargetId) {
  const { queryOne } = await import('../../../shared/database/connection.js')
  const { uuidToBuffer, bufferToUuid } = await import('../../../shared/utils/uuid.utils.js')
  const row = await queryOne('SELECT post_id FROM post_targets WHERE id = ?', [uuidToBuffer(postTargetId)])
  return row ? bufferToUuid(row.post_id) : null
}

/**
 * Immediate spend stop on a strong deletion candidate (reversible).
 * Only ACTIVE boosts are paused, and only those get the ownership flag —
 * client-paused boosts need no action (already zero spend) and FAILED/
 * CANCELLED boosts are never touched.
 */
export async function pauseBoostForDeletionCandidate(target) {
  try {
    const sysToken = await systemToken()
    const { updateAdStatus } = await import('../../../shared/services/meta-ads.service.js')
    const ptgt = await promoRepo.findPromotionTargetByPostTargetId(target.id)
    if (ptgt && ptgt.status === PROMOTION_TARGET_STATUS.ACTIVE) {
      if (ptgt.platformCampaignId && sysToken) {
        try {
          await updateAdStatus(ptgt.platformCampaignId, 'PAUSED', sysToken)
        } catch (err) {
          await logMetaEvent({ action: 'deletion_pause_meta_error', promotionTargetId: ptgt.id, postTargetId: target.id, error: err?.message || String(err) })
        }
      }
      await promoRepo.updatePromotionTarget(ptgt.id, { status: PROMOTION_TARGET_STATUS.PAUSED })
      const { refreshPromotionStatus } = await import('./promotion.service.js')
      await refreshPromotionStatus(ptgt.promotionId)
      await dmRepo.setBoostPausedByDeletion(target.id, true)
      await logMetaEvent({ action: 'deletion_boost_paused', promotionTargetId: ptgt.id, postTargetId: target.id, postId: target.postId })
      return { paused: true, path: 'promotion' }
    }
    if (!ptgt) {
      // legacy path: pause the ad copy mirror only (no coin logic in v1)
      const rows = await postRepo.findPostBoostTargetsByTargetId(target.id)
      const ad = rows.find(r => r.objectType === 'ad' && r.boostStatus === 'active')
      if (ad) {
        if (sysToken) {
          try {
            await updateAdStatus(ad.objectId, 'PAUSED', sysToken)
          } catch (err) {
            await logMetaEvent({ action: 'deletion_pause_meta_error', postTargetId: target.id, error: err?.message || String(err) })
          }
        }
        await postRepo.updatePostBoostTargetStatus(target.id, 'paused')
        await dmRepo.setBoostPausedByDeletion(target.id, true)
        await logMetaEvent({ action: 'deletion_boost_paused', postTargetId: target.id, postId: target.postId, path: 'legacy' })
        return { paused: true, path: 'legacy' }
      }
    }
  } catch (err) {
    await logMetaEvent({ action: 'deletion_pause_error', postTargetId: target.id, postId: target.postId, error: err?.message || String(err) })
  }
  return { paused: false }
}

/**
 * Resume after a candidate recovers — ONLY when the deletion system paused an
 * ACTIVE boost. Client-paused boosts (flag unset) stay paused; terminal
 * boosts are never resurrected. Flag is always cleared.
 */
export async function resumeBoostAfterRecovery(target) {
  if (!target.boostPausedByDeletion) return { resumed: false, reason: 'not_deletion_paused' }
  try {
    const ptgt = await promoRepo.findPromotionTargetByPostTargetId(target.id)
    if (ptgt && ptgt.status === PROMOTION_TARGET_STATUS.PAUSED) {
      const sysToken = await systemToken()
      const { updateAdStatus } = await import('../../../shared/services/meta-ads.service.js')
      if (ptgt.platformCampaignId && sysToken) {
        try {
          await updateAdStatus(ptgt.platformCampaignId, 'ACTIVE', sysToken)
        } catch (err) {
          await logMetaEvent({ action: 'deletion_resume_meta_error', promotionTargetId: ptgt.id, postTargetId: target.id, error: err?.message || String(err) })
          await dmRepo.setBoostPausedByDeletion(target.id, false)
          return { resumed: false, reason: 'meta_resume_failed' }
        }
      }
      await promoRepo.updatePromotionTarget(ptgt.id, { status: PROMOTION_TARGET_STATUS.ACTIVE })
      const { refreshPromotionStatus } = await import('./promotion.service.js')
      await refreshPromotionStatus(ptgt.promotionId)
      await dmRepo.setBoostPausedByDeletion(target.id, false)
      await logMetaEvent({ action: 'deletion_boost_resumed', promotionTargetId: ptgt.id, postTargetId: target.id, postId: target.postId })
      return { resumed: true }
    }
    if (!ptgt) {
      const rows = await postRepo.findPostBoostTargetsByTargetId(target.id)
      const pausedRow = rows.find(r => r.boostStatus === 'paused')
      if (pausedRow) {
        await postRepo.updatePostBoostTargetStatus(target.id, 'active')
        await dmRepo.setBoostPausedByDeletion(target.id, false)
        return { resumed: true, path: 'legacy' }
      }
    }
  } catch (err) {
    await logMetaEvent({ action: 'deletion_resume_error', postTargetId: target.id, postId: target.postId, error: err?.message || String(err) })
  }
  await dmRepo.setBoostPausedByDeletion(target.id, false)
  return { resumed: false, reason: 'not_paused' }
}

/**
 * Owned enforcement for a newly confirmed deletion (caller won the guarded
 * confirm UPDATE — repeated webhooks/poller/admin retries are no-ops).
 * Terminal: the review state never leaves confirmed/dismissed.
 */
export async function applyDeletionEnforcement(target) {
  const post = await postRepo.findPostById(target.postId)
  const publisher = isPublisherTarget(target)
  if (publisher) {
    await dmRepo.incrementRequestViolation(target.publisherRequestId)
    await dmRepo.setViolationCounted(target.id, true)
  }
  const { settleBoostShareForDeletedPostTarget } = await import('./promotion.service.js')
  const settle = await settleBoostShareForDeletedPostTarget(target.id, publisher ? 'Publisher deleted the post' : 'Post deleted from platform')
  // legacy mirror: failed is terminal there too (no coin logic in the legacy path)
  try {
    const rows = await postRepo.findPostBoostTargetsByTargetId(target.id)
    if (rows.length && rows.every(r => r.boostStatus !== 'failed')) {
      await postRepo.updatePostBoostTargetStatus(target.id, 'failed')
    }
  } catch {}
  const statusAfter = post?.status || 'completed'
  await postRepo.createReviewLog(target.postId, null, REVIEW_ACTIONS.SUBMITTED, statusAfter,
    publisher
      ? `Publisher deleted the post on ${target.platformCode || 'platform'} — target terminal, boost stopped, payout blocked`
      : `Client post deleted on ${target.platformCode || 'platform'} — target terminal, boost stopped`)
  const info = publisher ? await dmRepo.findRequestViolationInfo(target.publisherRequestId) : null
  await notifyAdmin(
    publisher ? 'Publisher deleted a paid post' : 'Client deleted a boosted post',
    [
      `Post "${post?.name || target.postId}" (${target.postId})`,
      `Target ${target.id} on ${target.platformCode || 'platform'}${publisher ? ` (publisher request ${target.publisherRequestId})` : ''}`,
      `Boost settled: ${settle ? 'yes' : 'no'}`,
      info ? `Publisher violations: ${info.violationCount}, payout: ${info.payoutStatus}` : 'client-owned target — no publisher violation',
    ].join('\n')
  )
  await logMetaEvent({ action: 'deletion_enforced', postId: target.postId, postTargetId: target.id, publisher, settled: !!settle })
  return { enforced: true, publisher }
}

/**
 * Leader-tick sweep: at most one remote-health job (run_key dedupe, backoff
 * never reset). Interval-gated so the 5s tick stays cheap.
 */
export async function scheduleDeletionMonitoring() {
  if (Date.now() - remoteHealthSweep.lastRunAt < remoteHealthSweep.intervalMs) {
    return { skipped: true, reason: 'sweep_throttle' }
  }
  remoteHealthSweep.lastRunAt = Date.now()
  if (await findAutoJobByRunKey(REMOTE_HEALTH_RUN_KEY)) return { skipped: true, reason: 'already_queued' }
  const due = await dmRepo.findRemoteHealthDueTargets({
    checkSeconds: REMOTE_HEALTH_CHECK_SECONDS,
    graceSeconds: REMOTE_HEALTH_GRACE_SECONDS,
    monitorDays: REMOTE_HEALTH_MONITOR_DAYS,
    limit: 1,
  })
  if (!due.length) return { skipped: true, reason: 'nothing_due' }
  await requeueAutoJob(null, POST_JOB_TYPES.REMOTE_HEALTH, {}, { runKey: REMOTE_HEALTH_RUN_KEY, entityType: 'post' })
  await logMetaEvent({ action: 'remote_health_scheduled' })
  return { enqueued: true }
}

/**
 * Remote-existence batch job (or single-target mode when payload.targetId is
 * set — used by the webhook-expedited recheck). Never throws for target-level
 * failures — every check is isolated and the job returns {done:true}.
 */
export async function runRemoteHealthJob(payload = {}) {
  try {
    let due
    if (payload.targetId) {
      const item = await dmRepo.findRemoteHealthTargetById(payload.targetId)
      due = item ? [item] : []
    } else {
      due = await dmRepo.findRemoteHealthDueTargets({
        checkSeconds: REMOTE_HEALTH_CHECK_SECONDS,
        graceSeconds: REMOTE_HEALTH_GRACE_SECONDS,
        monitorDays: REMOTE_HEALTH_MONITOR_DAYS,
        limit: REMOTE_HEALTH_BATCH_LIMIT,
      })
    }
    if (!due.length) return { done: true, skipped: true }
    const stats = { checked: 0, flagged: 0, confirmed: 0, recovered: 0, unknown: 0, hidden: 0 }
    for (const item of due) {
      try {
        const { probe, tokenKey } = await probeTarget(item)
        if (!probe) continue
        const outcome = await handleRemoteContentSignal({
          postTargetId: item.postTargetId,
          remoteState: probe.state,
          source: 'poll',
          reason: probe.state === 'missing' ? `Post not found on ${item.platformCode} (${probe.detail || 'deleted'})` : null,
          detail: probe.detail || null,
          tokenKey,
        })
        stats.checked += 1
        if (outcome.flagged) stats.flagged += 1
        if (outcome.confirmed) stats.confirmed += 1
        if (outcome.recovered) stats.recovered += 1
        if (outcome.unknown) stats.unknown += 1
        if (outcome.hidden) stats.hidden += 1
      } catch (err) {
        await logMetaEvent({ action: 'remote_health_target_error', postTargetId: item.postTargetId, error: err?.message || String(err) })
      }
    }
    await logMetaEvent({ action: 'remote_health_batch', targeted: !!payload.targetId, ...stats })
    return { done: true, ...stats }
  } catch (err) {
    await logMetaEvent({ action: 'remote_health_error', error: err?.message || String(err) })
    throw err
  }
}

/**
 * Admin review of a confirmed violation. Dismiss clears ONLY the violation
 * decision (payout block lifted, count corrected) — deletion stays terminal.
 * Clawback is strict all-or-nothing in a single transaction: insufficient
 * balance rolls everything back and stays pending.
 */
export async function reviewDeletionViolation(postTargetId, adminId, action) {
  const postId = await targetPostId(postTargetId)
  if (!postId) throw new NotFoundError('Post target not found')
  const targets = await postRepo.findPostTargetsByPostId(postId)
  const target = (targets || []).find(t => t.id === postTargetId)
  if (!target) throw new NotFoundError('Post target not found')
  if (target.deletionReviewState !== DELETION_REVIEW_STATE.CONFIRMED) {
    throw new ValidationError(`Only confirmed violations can be reviewed (state: ${target.deletionReviewState || 'none'})`)
  }
  if (action === 'dismiss') {
    const owned = await dmRepo.dismissConfirmedViolation(postTargetId)
    if (!owned) throw new ConflictError('Violation already reviewed')
    if (target.violationCounted && target.publisherRequestId) {
      await dmRepo.decrementRequestViolation(target.publisherRequestId)
      await dmRepo.setViolationCounted(postTargetId, false)
    }
    await postRepo.createReviewLog(target.postId, adminId, REVIEW_ACTIONS.SUBMITTED,
      (await postRepo.findPostById(target.postId))?.status || 'completed',
      `Deletion violation dismissed by admin — payout block lifted, target stays terminal`)
    await logMetaEvent({ action: 'deletion_violation_dismissed', postId: target.postId, postTargetId, adminId })
    return { dismissed: true }
  }
  if (action === 'clawback') {
    if (!isPublisherTarget(target)) throw new ValidationError('Clawback applies to publisher-owned targets only')
    const request = await postRepo.findPostPublisherRequestById(target.publisherRequestId)
    if (!request) throw new NotFoundError('Publisher request not found')
    const info = await dmRepo.findRequestViolationInfo(target.publisherRequestId)
    if (!info || info.payoutStatus !== 'paid') throw new ValidationError('Clawback requires an already-paid publisher request')
    if (info.clawbackPaise > 0) throw new ConflictError('Clawback already processed')
    const coins = Number(request.coinsOffered) || 0
    if (coins <= 0) throw new ValidationError('Publisher request has no coin payout to claw back')
    const { getCoinConversionRate } = await import('../campaigns/campaign.service.js')
    const coinRate = await getCoinConversionRate()
    const paise = Math.round(coins * coinRate * 100)
    const { transaction } = await import('../../../shared/database/connection.js')
    const coinService = await import('../../../shared/services/coin.service.js')
    await transaction(async () => {
      const claimed = await dmRepo.claimClawback(target.publisherRequestId, paise)
      if (!claimed) throw new ConflictError('Clawback already processed')
      await coinService.spend(request.publisherId, coins, 'publisher_violation', request.id, `Clawback: deleted post "${(await postRepo.findPostById(target.postId))?.name || target.postId}"`)
    })
    await postRepo.createReviewLog(target.postId, adminId, REVIEW_ACTIONS.SUBMITTED,
      (await postRepo.findPostById(target.postId))?.status || 'completed',
      `Admin clawed back ${coins} coins from publisher for deleted post`)
    await logMetaEvent({ action: 'deletion_clawback', postId: target.postId, postTargetId, requestId: request.id, coins, paise, adminId })
    return { clawedBack: true, coins, paise }
  }
  throw new ValidationError(`Unknown review action: ${action}`)
}
