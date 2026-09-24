import * as repairRepo from './promotion-repair.repository.js'
import * as promoRepo from './promotion.repository.js'
import * as postRepo from './post.repository.js'
import { NotFoundError, ValidationError, ForbiddenError } from '../../../shared/errors/AppError.js'
import { queryOne } from '../../../shared/database/connection.js'
import { PROMOTION_TARGET_STATUS, TERMINAL_PROMOTION_STATUSES, PROMOTION_JOB_TYPES } from './promotion.model.js'
import {
  REPAIR_STATUS,
  ACTIVE_REPAIR_STATUSES,
  TERMINAL_REPAIR_STATUSES,
  assertValidRepairTransition,
} from './promotion-repair.model.js'
import { requeueAutoJob } from '../campaigns/campaign.repository.js'
import { getObjectStatus, updateAdStatus, deleteAd, deleteAdCreative, qualifyFbPostId } from '../../../shared/services/meta-ads.service.js'
import { classifyIssueCode, normalizeIssuesInfo, isBoostRepairableCategory } from '../../../shared/services/meta-issue-catalog.js'
import { getCoinConversionRate, resolveAccountContext } from '../campaigns/campaign.service.js'
import { logMetaEvent } from '../../../shared/services/meta-logger.service.js'
import { executeBoostCreation, buildPostBoostPayloads } from './post.service.js'
import { readSnapshotSlice } from './promotion-validation.js'

export const REPAIR_ROLLOUT_FLAG = 'boost_repair_rollout'
export const REPAIR_EXECUTION_FLAG = 'boost_repair_execution_enabled'
export const REPAIR_KILL_FLAG = 'boost_repair_killed'

export async function readRepairFlag(key) {
  try {
    const row = await queryOne('SELECT config_value FROM app_config WHERE config_key = ?', [key])
    if (!row) return undefined
    return typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value
  } catch {
    return undefined
  }
}

export async function getRepairRolloutMode() {
  const value = await readRepairFlag(REPAIR_ROLLOUT_FLAG)
  if (value === 'admin_only' || value === 'enabled') return value
  return 'off'
}

export async function isRepairKilled() {
  return (await readRepairFlag(REPAIR_KILL_FLAG)) === true
}

export function repairCategoryFlagKey(category) {
  return `boost_repair_category_${String(category || 'unknown').toLowerCase()}`
}

export async function isRepairCategoryEnabled(category) {
  if (!isBoostRepairableCategory(category)) return false
  const value = await readRepairFlag(repairCategoryFlagKey(category))
  return value === true
}

export async function isRepairExecutionEnabled() {
  return (await readRepairFlag(REPAIR_EXECUTION_FLAG)) === true
}

export async function assertRepairMutationsAllowed() {
  if (await isRepairKilled()) {
    throw new Error('Boost repair mutations disabled by kill switch')
  }
}

async function loadRepairContext(repairId) {
  const repair = await repairRepo.findRepairById(repairId)
  if (!repair) return { repair: null }
  const ptgt = await promoRepo.findPromotionTargetById(repair.promotionTargetId)
  if (!ptgt) return { repair, promotionTarget: null }
  const promotion = await promoRepo.findPromotionById(ptgt.promotionId)
  const post = promotion ? await postRepo.findPostById(promotion.postId) : null
  const target = await postRepo.findPostTargetById(ptgt.postTargetId)
  return { repair, promotionTarget: ptgt, promotion, post, target }
}

async function transitionRepair(repair, toStatus, reason = null) {
  assertValidRepairTransition(repair.status, toStatus)
  const won = await repairRepo.updateRepairState(repair.id, [repair.status], toStatus)
  if (won !== 1) return null
  if (reason) await repairRepo.recordRepairRun(repair.id, { error: reason, attemptsIncrement: 0 })
  await logMetaEvent({
    action: 'boost_repair_transition',
    params: { repairId: repair.id, promotionTargetId: repair.promotionTargetId, objectId: repair.objectId, errorCode: repair.errorCode, from: repair.status, to: toStatus, reason },
  })
  return repairRepo.findRepairById(repair.id)
}

export async function requestRepair({ promotionTargetId, actorId = null, callToAction = null, issueCode = null }) {
  const rollout = await getRepairRolloutMode()
  if (rollout !== 'admin_only' && rollout !== 'enabled') {
    throw new ForbiddenError('Boost repair rollout is off')
  }
  await assertRepairMutationsAllowed()

  const ptgt = await promoRepo.findPromotionTargetById(promotionTargetId)
  if (!ptgt) throw new NotFoundError('Promotion target not found')
  if (!ptgt.platformAdId) throw new ValidationError('Promotion target has no active Meta ad to repair')

  const candidates = await repairRepo.findActivePromotionTargetIssues(promotionTargetId)
  const scoped = candidates.filter((issue) => issue.objectId === ptgt.platformAdId)
  let issue = null
  if (issueCode) {
    issue = scoped.find((candidate) => candidate.errorCode === String(issueCode)) || null
    if (!issue) throw new ValidationError(`No active issue ${issueCode} on this promotion target's ad`)
  } else if (scoped.length === 1) {
    issue = scoped[0]
  } else if (scoped.length === 0) {
    throw new ValidationError('No active Meta issue on this promotion target ad')
  } else {
    throw new ValidationError('Multiple active issues on this promotion target ad — specify issueCode')
  }

  const classified = classifyIssueCode(issue.errorCode)
  if (!isBoostRepairableCategory(classified.category)) {
    throw new ValidationError(`Issue category ${classified.category} is not repairable yet`)
  }
  if (!(await isRepairCategoryEnabled(classified.category))) {
    throw new ValidationError(`Issue category ${classified.category} is not enabled`)
  }

  const claimed = await promoRepo.claimPromotionTargetForRepairSwap(promotionTargetId)
  if (!claimed) {
    const fresh = await promoRepo.findPromotionTargetById(promotionTargetId)
    throw new ValidationError(`Promotion target is no longer repairable (current status: ${fresh?.status})`)
  }

  const repairInput = {
    promotionTargetId,
    objectId: ptgt.platformAdId,
    errorCode: issue.errorCode,
    status: REPAIR_STATUS.PENDING,
    amendmentFields: callToAction ? { callToAction } : null,
    promotionTargetIssueId: issue.id,
    oldCreativeId: ptgt.platformCreativeId,
    oldAdId: ptgt.platformAdId,
  }

  let repair = null
  let rearmed = false
  try {
    const id = await repairRepo.createRepair(repairInput)
    repair = await repairRepo.findRepairById(id)
  } catch (err) {
    if (err?.code !== 'ER_DUP_ENTRY') throw err
    repair = await repairRepo.findRepairByTriple(promotionTargetId, ptgt.platformAdId, issue.errorCode)
    if (!repair) throw err
    if (ACTIVE_REPAIR_STATUSES.includes(repair.status)) {
      return { repairId: repair.id, runKey: repair.runKey, status: repair.status, queued: false, duplicate: true, rearmed: false }
    }
    const won = await repairRepo.rearmRepair(repair.id, {
      amendmentFields: callToAction ? { callToAction } : null,
      promotionTargetIssueId: issue.id,
      oldCreativeId: ptgt.platformCreativeId,
      oldAdId: ptgt.platformAdId,
    })
    repair = await repairRepo.findRepairById(repair.id)
    rearmed = won === 1
    if (!rearmed) {
      return { repairId: repair.id, runKey: repair.runKey, status: repair.status, queued: false, duplicate: true, rearmed: false }
    }
  }

  await requeueAutoJob(null, PROMOTION_JOB_TYPES.REPAIR, { repairId: repair.id }, { runKey: repair.runKey, entityType: 'post' })
  await logMetaEvent({ action: 'boost_repair_requested', promotionTargetId, params: { repairId: repair.id, objectId: repair.objectId, errorCode: repair.errorCode, rearmed } })
  return { repairId: repair.id, runKey: repair.runKey, status: repair.status, queued: true, duplicate: false, rearmed }
}

export async function getPromotionTargetRepairStatus(promotionTargetId) {
  const ptgt = await promoRepo.findPromotionTargetById(promotionTargetId)
  if (!ptgt) throw new NotFoundError('Promotion target not found')

  const allIssues = await repairRepo.findActivePromotionTargetIssues(promotionTargetId)
  const issues = allIssues.map((issue) => {
    const classified = classifyIssueCode(issue.errorCode)
    const supported = isBoostRepairableCategory(classified.category)
    return {
      id: issue.id,
      objectId: issue.objectId,
      level: issue.level,
      errorCode: issue.errorCode,
      summary: issue.summary,
      message: issue.message,
      errorType: issue.errorType,
      observedAt: issue.observedAt,
      category: classified.category,
      guidance: classified.guidance,
      severity: classified.severity,
      supported,
      repairable: false, // filled below (async gate)
    }
  })
  for (const issue of issues) {
    issue.repairable = issue.supported && (await isRepairCategoryEnabled(issue.category))
  }

  const repairs = await repairRepo.listRepairsForTarget(promotionTargetId)
  const activeRepair = repairs.find((repair) => ACTIVE_REPAIR_STATUSES.includes(repair.status)) || null
  const lastRepair = repairs.length ? repairs[repairs.length - 1] : null
  const issuePresent = issues.length > 0

  const reasons = []
  if (['failed', 'cancelled'].includes(ptgt.status) && !activeRepair) reasons.push('target-terminal')
  if (!ptgt.platformAdId) reasons.push('no-repair-target')
  if (!issuePresent) {
    reasons.push('no-active-issue')
  } else if (!issues.some((issue) => issue.repairable)) {
    reasons.push(issues.some((issue) => issue.supported) ? 'issue-disabled' : 'issue-unsupported')
  }
  if (activeRepair) reasons.push('repair-in-progress')
  const eligible = reasons.length === 0

  return {
    promotionTargetId,
    eligible,
    reasons,
    issues,
    activeRepair: activeRepair ? {
      id: activeRepair.id, status: activeRepair.status, objectId: activeRepair.objectId,
      errorCode: activeRepair.errorCode, runKey: activeRepair.runKey, attempts: activeRepair.attempts, updatedAt: activeRepair.updatedAt,
    } : null,
    lastRepair: lastRepair ? {
      id: lastRepair.id, status: lastRepair.status, objectId: lastRepair.objectId,
      errorCode: lastRepair.errorCode, attempts: lastRepair.attempts, updatedAt: lastRepair.updatedAt,
    } : null,
  }
}

export async function runRepairJob(repairId) {
  await assertRepairMutationsAllowed()
  const ctx = await loadRepairContext(repairId)
  if (!ctx.repair) return { done: true, ignored: 'repair-missing' }
  const { repair, promotionTarget, promotion, post, target } = ctx
  if (!promotionTarget || !promotion || !post || !target) {
    return { done: true, ignored: 'repair-context-incomplete' }
  }

  if (repair.status !== REPAIR_STATUS.PENDING) {
    if (repair.status === REPAIR_STATUS.READY_FOR_CREATION) {
      if (!(await isRepairExecutionEnabled())) return { requeueAfterSeconds: 300, gated: true }
      return runRepairCreation(repair.id)
    }
    if ([REPAIR_STATUS.AD_CREATED, REPAIR_STATUS.ACTIVATING, REPAIR_STATUS.ACTIVE_VERIFIED].includes(repair.status)) {
      return runRepairActivation(repair.id)
    }
    return { done: true, ignored: `repair-status-${repair.status}` }
  }

  await repairRepo.recordRepairRun(repair.id, { attemptsIncrement: 1 })

  const { accessToken: systemToken } = await resolveAccountContext()
  if (!systemToken) throw new Error('Meta not configured for boost repair preflight')

  let statusData = null
  try {
    statusData = await getObjectStatus(repair.objectId, systemToken)
  } catch (err) {
    await transitionRepair(repair, REPAIR_STATUS.UNKNOWN, `Target ad status read failed: ${err.message}`)
    return { done: true, state: REPAIR_STATUS.UNKNOWN }
  }

  const live = normalizeIssuesInfo(statusData?.issues_info)
  const match = live.find((issue) => issue.errorCode === repair.errorCode)
  if (!match) {
    const codes = live.map((issue) => issue.errorCode).join(',') || 'none'
    await transitionRepair(repair, REPAIR_STATUS.FAILED, `Issue ${repair.errorCode} no longer reported; live codes: ${codes}`)
    return { done: true, state: REPAIR_STATUS.FAILED }
  }

  const ready = await transitionRepair(repair, REPAIR_STATUS.READY_FOR_CREATION)
  if (!ready) return { done: true, ignored: 'repair-transition-lost' }
  if (!(await isRepairExecutionEnabled())) return { requeueAfterSeconds: 300, gated: true }
  return runRepairCreation(repair.id)
}

async function deleteOldRepairObjects(repair, systemToken) {
  if (repair.oldAdId) {
    try { await deleteAd(repair.oldAdId, systemToken) } catch (err) {
      await logMetaEvent({ action: 'boost_repair_cleanup_error', promotionTargetId: repair.promotionTargetId, objectType: 'ad', objectId: repair.oldAdId, error: err?.message || String(err) })
    }
  }
  if (repair.oldCreativeId) {
    try { await deleteAdCreative(repair.oldCreativeId, systemToken) } catch (err) {
      await logMetaEvent({ action: 'boost_repair_cleanup_error', promotionTargetId: repair.promotionTargetId, objectType: 'ad_creative', objectId: repair.oldCreativeId, error: err?.message || String(err) })
    }
  }
}

export async function runRepairCreation(repairId) {
  await assertRepairMutationsAllowed()
  const ctx = await loadRepairContext(repairId)
  if (!ctx.repair) return { done: true, ignored: 'repair-missing' }
  const { repair, promotionTarget: ptgt, promotion, post, target } = ctx
  if (!ptgt || !promotion || !post || !target) return { done: true, ignored: 'repair-context-incomplete' }
  if (repair.status !== REPAIR_STATUS.READY_FOR_CREATION) return { done: true, ignored: `repair-status-${repair.status}` }
  if (TERMINAL_PROMOTION_STATUSES.includes(promotion.status)) {
    await transitionRepair(repair, REPAIR_STATUS.FAILED, 'Promotion reached a terminal state before repair completed')
    return { done: true, state: REPAIR_STATUS.FAILED }
  }
  if (ptgt.status !== PROMOTION_TARGET_STATUS.NEEDS_REPAIR) {
    await transitionRepair(repair, REPAIR_STATUS.FAILED, `Promotion target left needs_repair (now ${ptgt.status}) before repair completed`)
    return { done: true, state: REPAIR_STATUS.FAILED }
  }

  const { accountId: adAccountId, accessToken: systemToken } = await resolveAccountContext()
  if (!systemToken) throw new Error('Meta not configured for boost repair creation')

  // Delete the old ad+creative and null the live columns before rebuilding —
  // the repair row's own guarded status is the exclusivity fence, same
  // pattern campaigns rely on their own repair row to fence sibling writes.
  await deleteOldRepairObjects(repair, systemToken)
  await promoRepo.updatePromotionTarget(ptgt.id, { platformCreativeId: null, platformAdId: null })

  const snapshot = readSnapshotSlice(promotion, target.id, target.platformCode)
  if (!snapshot) {
    await transitionRepair(repair, REPAIR_STATUS.FAILED, 'Promotion configuration could not be resolved for repair')
    return { done: true, state: REPAIR_STATUS.FAILED }
  }
  const promoPost = {
    ...post,
    name: `${post.name} ${ptgt.platform} ${ptgt.id.slice(0, 4)}`,
    boostBudgetType: promotion.budgetType,
    boostBudgetAmount: promotion.budgetAmount,
    boostSpendCap: promotion.spendCap,
    boostEndTime: promotion.endAt,
    boostTargeting: snapshot.targeting,
    boostPlacement: snapshot.placement,
    boostBidStrategy: promotion.bidStrategy,
    boostBidAmount: promotion.bidAmount,
    boostSpecialAdCategories: promotion.specialAdCategories,
    boostOptimizationGoal: snapshot.optimizationGoal,
    boostObjective: snapshot.objective,
    boostCallToAction: repair.amendmentFields?.callToAction ?? promotion.callToAction,
    scheduledAt: promotion.startAt,
  }
  const coinRate = await getCoinConversionRate()
  const boostPayload = await buildPostBoostPayloads(promoPost, target, coinRate)
  if (boostPayload.minBudgetError || boostPayload.scheduleError || boostPayload.geoError || boostPayload.bidAmountError) {
    const error = boostPayload.minBudgetError || boostPayload.scheduleError || boostPayload.geoError || boostPayload.bidAmountError
    await transitionRepair(repair, REPAIR_STATUS.FAILED, error)
    return { done: true, state: REPAIR_STATUS.FAILED }
  }
  boostPayload.fbCampaignName = `${boostPayload.fbCampaignName}-repair-${repair.id.slice(0, 4)}`

  const pageId = target.platformCode === 'instagram' ? (target.igBusinessAccountId || target.platformUserId) : target.platformUserId
  const promotable = target.promotableId || null
  const objectStoryId = target.platformCode === 'instagram' ? target.metaObjectId : (promotable || qualifyFbPostId(pageId, target.metaObjectId))

  const result = await executeBoostCreation({
    post: promoPost, target, adAccountId, systemToken, boostPayload, objectStoryId, jobPayload: {},
    logPrefix: 'boost_repair',
  }, {
    existingIds: {
      campaignId: ptgt.platformCampaignId || null,
      adsetId: ptgt.platformAdsetId || null,
      creativeId: null,
      adId: null,
    },
    // Only persists the promotion_target's live columns as each object is
    // created — deliberately does NOT drive the repair row's own status.
    // executeBoostCreation cleans up (deletes + nulls the columns) on ANY
    // failure including transient ones, so a repair retry always starts
    // fully fresh; a repair-row status that tracked "creative created" as a
    // durable checkpoint would go stale the moment that cleanup fires,
    // leaving runRepairJob's dispatcher with no branch to resume from. One
    // hop (ready_for_creation -> ad_created) on full success is simpler and
    // matches decision #2's "simple sequential swap" — CREATIVE_CREATED
    // stays in the model/table for future finer-grained observability but
    // is never a state this service actually parks in.
    onObjectCreated: async (type, id) => {
      if (type === 'ad_creative') await promoRepo.updatePromotionTarget(ptgt.id, { platformCreativeId: id })
      else if (type === 'ad') await promoRepo.updatePromotionTarget(ptgt.id, { platformAdId: id })
    },
    onCleanupDb: async () => {
      await promoRepo.updatePromotionTarget(ptgt.id, { platformCreativeId: null, platformAdId: null })
    },
  })

  if (result && typeof result.requeueAfterSeconds === 'number') {
    return result
  }
  if (!result.success) {
    await transitionRepair(repair, REPAIR_STATUS.FAILED, result.error)
    await promoRepo.restorePromotionTargetAfterRepair(ptgt.id, PROMOTION_TARGET_STATUS.FAILED)
    return { done: true, state: REPAIR_STATUS.FAILED }
  }

  const adCreated = await transitionRepair(repair, REPAIR_STATUS.AD_CREATED)
  if (!adCreated) return { done: true, ignored: 'repair-transition-lost' }

  if (!(await isRepairExecutionEnabled())) return { requeueAfterSeconds: 300, gated: true }
  return runRepairActivation(repair.id)
}

// Bounded step loop mirroring campaigns' runRepairActivation shape, scaled
// down to this feature's 3-hop staircase (ad_created -> activating ->
// active_verified -> completed). Each iteration re-reads nothing extra —
// transitionRepair's own guarded UPDATE means a lost race (someone else
// already advanced it) is detected per-hop via a null return, and the loop
// re-fetches the current row before deciding whether to continue or stand
// down, exactly like every other guarded-transition consumer in this file.
export async function runRepairActivation(repairId) {
  await assertRepairMutationsAllowed()
  const ctx = await loadRepairContext(repairId)
  if (!ctx.repair) return { done: true, ignored: 'repair-missing' }
  let repair = ctx.repair
  const { promotionTarget: ptgt, promotion, post } = ctx
  if (!ptgt || !promotion || !post) return { done: true, ignored: 'repair-context-incomplete' }

  const { accessToken: systemToken } = await resolveAccountContext()
  if (!systemToken) throw new Error('Meta not configured for boost repair activation')

  for (let step = 0; step < 4; step++) {
    if (repair.status === REPAIR_STATUS.AD_CREATED) {
      if (!ptgt.platformAdId) {
        await transitionRepair(repair, REPAIR_STATUS.FAILED, 'No replacement ad id to activate')
        await promoRepo.restorePromotionTargetAfterRepair(ptgt.id, PROMOTION_TARGET_STATUS.FAILED)
        return { done: true, state: REPAIR_STATUS.FAILED }
      }
      try {
        await updateAdStatus(ptgt.platformAdId, 'ACTIVE', systemToken)
      } catch (err) {
        const transient = (err?.statusCode && err.statusCode >= 500) || err?.metaAmbiguous || err?.metaErrorCode === 1
        if (transient) return { requeueAfterSeconds: 30 }
        await transitionRepair(repair, REPAIR_STATUS.FAILED, `Activation failed: ${err?.message || String(err)}`)
        await promoRepo.restorePromotionTargetAfterRepair(ptgt.id, PROMOTION_TARGET_STATUS.FAILED)
        return { done: true, state: REPAIR_STATUS.FAILED }
      }
      const next = await transitionRepair(repair, REPAIR_STATUS.ACTIVATING)
      repair = next || (await repairRepo.findRepairById(repairId))
      continue
    }
    if (repair.status === REPAIR_STATUS.ACTIVATING) {
      const next = await transitionRepair(repair, REPAIR_STATUS.ACTIVE_VERIFIED)
      repair = next || (await repairRepo.findRepairById(repairId))
      continue
    }
    if (repair.status === REPAIR_STATUS.ACTIVE_VERIFIED) {
      await promoRepo.restorePromotionTargetAfterRepair(ptgt.id, PROMOTION_TARGET_STATUS.ACTIVE)
      if (repair.promotionTargetIssueId) {
        await repairRepo.clearPromotionTargetIssue(repair.promotionTargetIssueId).catch(() => {})
      }
      const { refreshPromotionStatus } = await import('./promotion.service.js')
      await refreshPromotionStatus(promotion.id)
      const completed = await transitionRepair(repair, REPAIR_STATUS.COMPLETED)
      await logMetaEvent({ action: 'boost_repair_completed', promotionTargetId: ptgt.id, params: { repairId: repair.id, objectId: ptgt.platformAdId } })
      return { done: true, state: completed?.status || REPAIR_STATUS.COMPLETED }
    }
    return { done: true, ignored: `repair-status-${repair.status}` }
  }
  return { done: true, ignored: 'repair-activation-step-limit' }
}
