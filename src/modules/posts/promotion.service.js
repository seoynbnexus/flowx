import * as promoRepo from './promotion.repository.js'
import * as postRepo from './post.repository.js'
import { generateUuid } from '../../../shared/utils/uuid.utils.js'
import { NotFoundError, ValidationError, ForbiddenError, ConflictError } from '../../../shared/errors/AppError.js'
import { queryOne, query } from '../../../shared/database/connection.js'
import { PROMOTION_STATUS, PROMOTION_TARGET_STATUS, PROMOTION_TARGET_ELIGIBILITY, VALID_PROMOTION_TRANSITIONS, TERMINAL_PROMOTION_STATUSES, IN_FLIGHT_PROMOTION_TARGET_STATUSES, PROMOTION_JOB_TYPES } from './promotion.model.js'
import { enqueueTargetJob } from '../campaigns/campaign.repository.js'
import { getInstagramBoostEligibility, getPostPromotability, qualifyFbPostId, resolveFbPostObjectId, updateAdStatus, deleteAdCampaign, deleteAdSet, deleteAdCreative, deleteAd, isInstagramPostLive, isPostLiveForBoost } from '../../../shared/services/meta-ads.service.js'
import { getCoinConversionRate, resolveAccountContext } from '../campaigns/campaign.service.js'
import { isRateLimited, tokenKeyFor } from '../../../shared/services/meta-rate-limiter.js'
import { logMetaEvent } from '../../../shared/services/meta-logger.service.js'
import { POST_STATUS, POST_TARGET_STATUS, POST_TYPES } from './post.model.js'
import { executeBoostCreation, buildPostBoostPayloads } from './post.service.js'

async function readFlag(key) {
  try {
    const row = await queryOne('SELECT config_value FROM app_config WHERE config_key = ?', [key])
    if (!row) return false
    const v = typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value
    return v === true || v === 'true' || v === 1
  } catch { return false }
}

export async function isPromotionsEnabled() {
  return readFlag('promotions_enabled')
}

export async function isPromotionPublishTriggerEnabled() {
  return readFlag('promotion_publish_trigger_enabled')
}

export async function getPromotionsFlagState() {
  const [enabled, trigger] = await Promise.all([isPromotionsEnabled(), isPromotionPublishTriggerEnabled()])
  return { enabled, trigger }
}

async function promotionPerTargetPaise(promotion) {
  const coinRate = await getCoinConversionRate()
  return Math.round((Number(promotion.budgetAmount) || 0) * coinRate * 100)
}

export async function chargePromotionForApproval(post) {
  try {
    if (!post.boostEnabled) return { charged: false }
    const promotion = await promoRepo.findPromotionByPostId(post.id)
    if (!promotion) return { charged: false }
    if (TERMINAL_PROMOTION_STATUSES.includes(promotion.status)) return { charged: false }
    if (promotion.chargedPaise > 0) return { charged: true, alreadyCharged: true }

    const targets = await postRepo.findPostTargetsByPostId(post.id)
    const clientTargetCount = targets.filter(t => t.targetType === 'client').length
    const publisherCount = post.runOnPublishers ? (Number(post.publisherCount) || 0) : 0
    const expected = clientTargetCount + publisherCount
    if (expected <= 0) return { charged: false }

    const coinRate = await getCoinConversionRate()
    const costCoins = (Number(promotion.budgetAmount) || 0) * expected
    if (costCoins <= 0) return { charged: false }

    const coinService = await import('../../../shared/services/coin.service.js')
    const available = await coinService.getAvailable(post.clientId)
    if (available.total < costCoins) {
      throw new ValidationError(`Insufficient coins for boost — need ${costCoins}, available ${available.total}`)
    }

    const spendResult = await coinService.spend(post.clientId, costCoins, 'post_boost', post.id, `Post boost on approval: ${post.name}`)
    const chargedPaise = Math.round(costCoins * coinRate * 100)

    await promoRepo.updatePromotion(promotion.id, { chargedPaise })
    await postRepo.updatePost(post.id, { chargedBoostPaise: chargedPaise })
    await postRepo.insertPostBillingEntry(post.id, {
      kind: 'charge',
      paise: chargedPaise,
      coins: costCoins,
      rate: coinRate,
      paidFromMonthly: spendResult?.fromMonthly || 0,
      paidFromWallet: spendResult?.fromWallet || costCoins,
      reason: `Post boost on approval: ${post.name}`,
    })
    await logMetaEvent({ action: 'promotion_charged_on_approval', promotionId: promotion.id, postId: post.id, coins: costCoins, paise: chargedPaise, targets: expected })
    return { charged: true, chargedPaise, coins: costCoins }
  } catch (err) {
    await logMetaEvent({ action: 'promotion_charge_error', postId: post.id, error: err?.message || String(err) })
    throw err
  }
}

async function refundPromotionTargetShare(ptgt, promotion, post, reason) {
  try {
    if (!promotion || !post) return false
    if (promotion.chargedPaise <= 0) return false
    const sharePaise = await promotionPerTargetPaise(promotion)
    if (sharePaise <= 0) return false
    const shareCoins = Number(promotion.budgetAmount) || 0
    if (shareCoins <= 0) return false

    // exactly-once: claim the refund slot AND pay the coins in one
    // transaction. A failed refund rolls the claim back (retry possible);
    // a committed claim can never be re-claimed (double-refund impossible).
    const { transaction } = await import('../../../shared/database/connection.js')
    return await transaction(async () => {
      const claimed = await promoRepo.claimPromotionTargetRefund(ptgt.id, sharePaise)
      if (!claimed) return false
      const coinRate = await getCoinConversionRate()
      const coinService = await import('../../../shared/services/coin.service.js')
      await coinService.refundWithDetail(post.clientId, shareCoins, 'post_boost', post.id, `Refund: ${reason} — boost share for "${post.name}"`, { fromMonthly: 0, fromWallet: shareCoins })
      await postRepo.insertPostBillingEntry(post.id, {
        kind: 'refund',
        paise: sharePaise,
        coins: shareCoins,
        rate: coinRate,
        paidFromMonthly: 0,
        paidFromWallet: shareCoins,
        reason: `Boost target refund: ${reason}`,
      })
      await logMetaEvent({ action: 'promotion_target_refunded', promotionId: promotion.id, promotionTargetId: ptgt.id, postId: post.id, coins: shareCoins, paise: sharePaise, reason })
      return true
    })
  } catch (err) {
    await logMetaEvent({ action: 'promotion_target_refund_error', promotionId: ptgt?.promotionId, promotionTargetId: ptgt?.id, postId: post?.id, error: err?.message || String(err) })
    return false
  }
}

export async function settlePromotionLeftover(promotionId) {
  try {
    const promotion = await promoRepo.findPromotionById(promotionId)
    if (!promotion) return null
    if (promotion.settledAt) return promotion
    if (promotion.chargedPaise <= 0) return promotion
    if (!TERMINAL_PROMOTION_STATUSES.includes(promotion.status)) return promotion

    // exactly-once: claim the settle slot AND pay the leftover in one
    // transaction. Concurrent settlers converge on the first claimant.
    const { transaction } = await import('../../../shared/database/connection.js')
    return await transaction(async () => {
      const settledAt = new Date().toISOString().slice(0, 19).replace('T', ' ')
      const claimed = await promoRepo.claimPromotionSettled(promotionId, settledAt)
      if (!claimed) return promoRepo.findPromotionById(promotionId)
      const targets = await promoRepo.findPromotionTargetsByPromotionId(promotionId)
      const consumed = targets.reduce((sum, t) => sum + (Number(t.consumedPaise) || 0), 0)
      const refunded = targets.reduce((sum, t) => sum + (Number(t.refundedPaise) || 0), 0)
      const leftoverPaise = promotion.chargedPaise - consumed - refunded
      if (leftoverPaise > 0) {
        const post = await postRepo.findPostById(promotion.postId)
        const coinRate = await getCoinConversionRate()
        const perTargetPaise = await promotionPerTargetPaise(promotion)
        const leftoverCoins = Math.round(leftoverPaise / (coinRate * 100))
        if (post && leftoverCoins > 0) {
          const coinService = await import('../../../shared/services/coin.service.js')
          await coinService.refundWithDetail(post.clientId, leftoverCoins, 'post_boost', post.id, `Refund: unused boost share for "${post.name}"`, { fromMonthly: 0, fromWallet: leftoverCoins })
          await postRepo.insertPostBillingEntry(post.id, {
            kind: 'refund',
            paise: leftoverPaise,
            coins: leftoverCoins,
            rate: coinRate,
            paidFromMonthly: 0,
            paidFromWallet: leftoverCoins,
            reason: 'Boost leftover refund (unfilled/unclaimed shares)',
          })
          await logMetaEvent({ action: 'promotion_leftover_refunded', promotionId, postId: post.id, coins: leftoverCoins, paise: leftoverPaise, perTargetPaise })
        }
      }
      return promoRepo.findPromotionById(promotionId)
    })
  } catch (err) {
    await logMetaEvent({ action: 'promotion_settle_error', promotionId, error: err?.message || String(err) })
    return null
  }
}

async function loadPostForClient(userId, postId) {
  const post = await postRepo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')
  if (post.clientId !== userId) throw new ForbiddenError('Not your post')
  return post
}

async function eligiblePostedClientTargets(postId) {
  const targets = await postRepo.findPostTargetsByPostId(postId)
  return targets.filter(t =>
    t.targetType === 'client' &&
    t.status === POST_TARGET_STATUS.POSTED &&
    t.metaObjectId &&
    t.deletionReviewState !== 'confirmed' &&
    t.remoteContentState !== 'missing' &&
    (t.platformCode === 'facebook' || t.platformCode === 'instagram')
  )
}

function buildPromotionConfigFromPost(post) {
  return {
    status: PROMOTION_STATUS.WAITING_FOR_POST,
    budgetType: post.boostBudgetType || 'daily',
    budgetAmount: post.boostBudgetAmount,
    spendCap: post.boostSpendCap || null,
    objective: post.boostObjective || 'OUTCOME_ENGAGEMENT',
    optimizationGoal: post.boostOptimizationGoal || null,
    bidStrategy: post.boostBidStrategy || null,
    targeting: post.boostTargeting || null,
    placement: post.boostPlacement || null,
    callToAction: post.boostCallToAction || null,
    link: post.boostLink || null,
    headline: post.boostHeadline || null,
    description: post.boostDescription || null,
    startAt: post.scheduledAt || null,
    endAt: post.boostEndTime || null,
    chargedPaise: post.chargedBoostPaise || 0,
  }
}

export async function createPromotionIntentForPost(post, clientTargetIds) {
  if (!(await isPromotionsEnabled())) return null
  const existing = await promoRepo.findPromotionByPostId(post.id)
  if (existing) return existing
  const promotionId = generateUuid()
  const config = buildPromotionConfigFromPost(post)
  await promoRepo.createPromotion(promotionId, post.id, post.clientId, config)
  const targets = await postRepo.findPostTargetsByPostId(post.id)
  for (const t of targets) {
    if (clientTargetIds && !clientTargetIds.includes(t.platformAccountId)) continue
    if (t.targetType !== 'client') continue
    if (t.platformCode !== 'facebook' && t.platformCode !== 'instagram') continue
    await promoRepo.createPromotionTarget(generateUuid(), promotionId, t.id, t.platformCode, t.platformAccountId)
  }
  return promoRepo.findPromotionById(promotionId)
}

export async function createPromotionForPublishedPost(userId, postId, data) {
  const post = await loadPostForClient(userId, postId)
  if (!(await isPromotionsEnabled())) {
    throw new ForbiddenError('Promotions are not enabled')
  }
  const existing = await promoRepo.findPromotionByPostId(postId)
  if (existing) {
    throw new ConflictError('A promotion already exists for this post')
  }

  const targets = await eligiblePostedClientTargets(postId)
  if (targets.length === 0) {
    throw new ValidationError('Post has no published client targets eligible for promotion')
  }

  for (const t of targets) {
    if (t.platformCode === 'instagram' && post.type === POST_TYPES.STORY) {
      throw new ValidationError('Instagram stories cannot be promoted — only feed posts and reels')
    }
  }

  const coinRate = await getCoinConversionRate()
  const { accountDbId } = await resolveAccountContext()
  const perCopy = Number(data.budgetAmount) || 1000
  const cost = perCopy * targets.length
  const coinService = await import('../../../shared/services/coin.service.js')
  const available = await coinService.getAvailable(userId)
  if (available.total < cost) {
    throw new ValidationError('Insufficient coins for promotion')
  }
  const spendResult = await coinService.spend(userId, cost, 'post_boost', postId, `Post promotion: ${post.name}`)
  const chargedPaise = Math.round(cost * coinRate * 100)

  const promotionId = generateUuid()
  await promoRepo.createPromotion(promotionId, postId, userId, {
    status: PROMOTION_STATUS.WAITING_FOR_POST,
    budgetType: data.budgetType,
    budgetAmount: data.budgetAmount,
    spendCap: data.spendCap || null,
    objective: data.objective || 'OUTCOME_ENGAGEMENT',
    optimizationGoal: data.optimizationGoal || null,
    bidStrategy: data.bidStrategy || null,
    targeting: data.targeting || null,
    placement: data.placement || null,
    callToAction: data.callToAction || null,
    link: data.link || null,
    headline: data.headline || null,
    description: data.description || null,
    startAt: data.startAt || null,
    endAt: data.endTime || null,
    chargedPaise,
  })
  await postRepo.insertPostBillingEntry(postId, {
    kind: 'charge',
    paise: chargedPaise,
    coins: cost,
    rate: coinRate,
    paidFromMonthly: spendResult?.fromMonthly || 0,
    paidFromWallet: spendResult?.fromWallet || cost,
    reason: `Post promotion: ${post.name}`,
  })

  const createdTargetIds = []
  for (const t of targets) {
    const ptgtId = generateUuid()
    await promoRepo.createPromotionTarget(ptgtId, promotionId, t.id, t.platformCode, t.platformAccountId)
    createdTargetIds.push(ptgtId)
    await enqueuePromotionTargetJob(ptgtId)
  }

  const promotion = await promoRepo.findPromotionById(promotionId)
  return { promotion, promotionTargetIds: createdTargetIds, chargedCoins: cost }
}

export async function enqueuePromotionTargetJob(promotionTargetId) {
  return enqueueTargetJob(PROMOTION_JOB_TYPES.EXECUTE, `promotion:${promotionTargetId}`, { promotionTargetId })
}

export async function onPostTargetPosted(target) {
  try {
    if (!(await isPromotionPublishTriggerEnabled())) return
    if (target.platformCode !== 'facebook' && target.platformCode !== 'instagram') return
    const ptgt = await promoRepo.findPromotionTargetByPostTargetId(target.id)
    if (!ptgt) return
    if (ptgt.status !== PROMOTION_TARGET_STATUS.PENDING) return
    const promotion = await promoRepo.findPromotionById(ptgt.promotionId)
    if (!promotion || TERMINAL_PROMOTION_STATUSES.includes(promotion.status)) return
    if (!target.metaObjectId) return
    await enqueuePromotionTargetJob(ptgt.id)
    await logMetaEvent({ action: 'promotion_target_wake', promotionId: ptgt.promotionId, promotionTargetId: ptgt.id, postId: target.postId, postTargetId: target.id, platform: target.platformCode })
  } catch (err) {
    await logMetaEvent({ action: 'promotion_wake_error', postTargetId: target.id, error: err?.message || String(err) })
  }
}

export async function createPromotionTargetsForPostTargets(post, postTargets) {
  if (!(await isPromotionsEnabled())) return []
  const promotion = await promoRepo.findPromotionByPostId(post.id)
  if (!promotion) return []
  if (TERMINAL_PROMOTION_STATUSES.includes(promotion.status)) return []
  const created = []
  for (const pt of postTargets) {
    if (pt.platformCode !== 'facebook' && pt.platformCode !== 'instagram') continue
    const existing = await promoRepo.findPromotionTargetByPostTargetId(pt.id)
    if (existing) continue
    const ptgtId = generateUuid()
    await promoRepo.createPromotionTarget(ptgtId, promotion.id, pt.id, pt.platformCode, pt.platformAccountId)
    created.push(ptgtId)
  }
  return created
}

async function checkEligibilityForTarget(promotion, post, target) {
  if (target.platformCode === 'instagram') {
    if (post.type === POST_TYPES.STORY) {
      return { eligible: false, reason: 'Instagram stories cannot be promoted' }
    }
    const eligibility = await getInstagramBoostEligibility(target.metaObjectId, target.accessToken)
    if (!eligibility.ready) {
      return { retry: true, reason: 'boost_eligibility_info not yet available' }
    }
    return { eligible: !!eligibility.isEligible, reason: eligibility.isEligible ? null : (eligibility.reasons?.join('; ') || 'Not eligible for Instagram promotion') }
  }
  if (target.platformCode === 'facebook') {
    if (target.metaObjectId && !String(target.metaObjectId).includes('_') && target.remoteVideoId && target.accessToken) {
      const resolvedId = await resolveFbPostObjectId(target.platformUserId, target.remoteVideoId, target.accessToken)
      if (!resolvedId) return { retry: true, reason: 'post_id not yet available' }
      await postRepo.updatePostTargetStatus(target.id, { metaObjectId: resolvedId })
      target.metaObjectId = resolvedId
    }
    const qualified = qualifyFbPostId(target.platformUserId, target.metaObjectId)
    try {
      const promo = await getPostPromotability(qualified, target.accessToken)
      if (!promo.isEligible) {
        return { eligible: false, reason: promo.instagramEligibility || 'Not eligible for promotion' }
      }
      if (promo.promotableId) {
        try {
          await postRepo.updatePostTargetStatus(target.id, {
            promotableId: promo.promotableId,
            isEligibleForPromotion: promo.isEligible,
            allowedObjectives: promo.allowedObjectives,
            eligibilityCheckedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
            eligibilityReason: null,
          })
        } catch {}
        target.promotableId = promo.promotableId
      }
      return { eligible: true, allowedObjectives: promo.allowedObjectives, promotableId: promo.promotableId || null }
    } catch (err) {
      return { retry: true, reason: `promotability check failed: ${err?.message || String(err)}` }
    }
  }
  return { eligible: false, reason: `Unsupported platform ${target.platformCode}` }
}

export async function runPromotionTargetJob(promotionTargetId, jobPayload = {}) {
  const ptgt = await promoRepo.findPromotionTargetById(promotionTargetId)
  if (!ptgt) return { done: true }
  const promotion = await promoRepo.findPromotionById(ptgt.promotionId)
  if (!promotion) return { done: true }
  if (TERMINAL_PROMOTION_STATUSES.includes(promotion.status)) return { done: true }
  if (ptgt.status === PROMOTION_TARGET_STATUS.CANCELLED || ptgt.status === PROMOTION_TARGET_STATUS.ACTIVE) return { done: true }

  const post = await postRepo.findPostById(ptgt.postId)
  if (!post) return { done: true }

  const target = await postRepo.findPostTargetById(ptgt.postTargetId)
  if (!target) return { done: true }
  if (target.status !== POST_TARGET_STATUS.POSTED) return { done: true }
  if (!target.metaObjectId) return { done: true }
  if (target.deletionReviewState === 'confirmed' || target.remoteContentState === 'missing') {
    // the underlying post is gone — never call Meta; cancel this target's
    // share and let the existing settle path refund it exactly once
    await promoRepo.updatePromotionTarget(ptgt.id, { status: PROMOTION_TARGET_STATUS.CANCELLED })
    await refundPromotionTargetShare(ptgt, promotion, post, 'post deleted from platform')
    await refreshPromotionStatus(promotion.id)
    await logMetaEvent({ action: 'promotion_target_skipped_deleted', promotionId: promotion.id, promotionTargetId: ptgt.id, postId: post.id, postTargetId: target.id })
    return { done: true }
  }

  let liveCheckId = target.metaObjectId
  if (target.platformCode === 'facebook' && !String(target.metaObjectId).includes('_')) {
    if (target.remoteVideoId && target.accessToken) {
      const resolvedId = await resolveFbPostObjectId(target.platformUserId, target.remoteVideoId, target.accessToken)
      if (resolvedId) {
        await postRepo.updatePostTargetStatus(target.id, { metaObjectId: resolvedId })
        target.metaObjectId = resolvedId
        liveCheckId = resolvedId
      } else {
        const attempts = (Number(jobPayload.fbIdAttempts) || 0) + 1
        if (attempts >= 6) {
          await promoRepo.updatePromotionTarget(ptgt.id, { status: PROMOTION_TARGET_STATUS.FAILED, error: `post_id not yet available for ${target.remoteVideoId || target.metaObjectId}`, attempts: ptgt.attempts + 1 })
          await refundPromotionTargetShare(ptgt, promotion, post, 'post_id unavailable')
          await refreshPromotionStatus(promotion.id)
          return { done: true }
        }
        return { requeueAfterSeconds: 60, attempts: { ...jobPayload, fbIdAttempts: attempts } }
      }
    } else {
      liveCheckId = qualifyFbPostId(target.platformUserId, target.metaObjectId)
    }
  }

  const live = target.platformCode === 'instagram'
    ? await isInstagramPostLive(target.metaObjectId, target.accessToken)
    : await isPostLiveForBoost(target.platformUserId, liveCheckId, target.accessToken)
  if (!live) {
    const attempts = (Number(jobPayload.liveAttempts) || 0) + 1
    if (attempts >= 8) {
      await promoRepo.updatePromotionTarget(ptgt.id, { status: PROMOTION_TARGET_STATUS.FAILED, error: `Post ${target.metaObjectId} not yet live after ${attempts} checks`, attempts: ptgt.attempts + 1 })
      await refundPromotionTargetShare(ptgt, promotion, post, 'post not live')
      await refreshPromotionStatus(promotion.id)
      return { done: true }
    }
    return { requeueAfterSeconds: Math.min(30 * attempts, 120), attempts: { ...jobPayload, liveAttempts: attempts } }
  }

  const { accountId: adAccountId, accessToken: systemToken } = await resolveAccountContext()
  if (!adAccountId || !systemToken) return { done: true }
  if (isRateLimited(tokenKeyFor(systemToken))) {
    return { requeueAfterSeconds: 30, attempts: { ...jobPayload } }
  }

  await promoRepo.updatePromotionTarget(ptgt.id, { status: PROMOTION_TARGET_STATUS.VALIDATING })
  await refreshPromotionStatus(promotion.id)

  const eligibility = await checkEligibilityForTarget(promotion, post, target)
  if (eligibility.retry) {
    const attempts = (Number(jobPayload.eligibilityAttempts) || 0) + 1
    if (attempts >= 6) {
      await promoRepo.updatePromotionTarget(ptgt.id, { status: PROMOTION_TARGET_STATUS.FAILED, eligibilityStatus: PROMOTION_TARGET_ELIGIBILITY.UNKNOWN, error: eligibility.reason, attempts: ptgt.attempts + 1 })
      await refundPromotionTargetShare(ptgt, promotion, post, 'eligibility unavailable')
      await refreshPromotionStatus(promotion.id)
      return { done: true }
    }
    await promoRepo.updatePromotionTarget(ptgt.id, { eligibilityStatus: PROMOTION_TARGET_ELIGIBILITY.UNKNOWN, eligibilityReason: eligibility.reason })
    return { requeueAfterSeconds: 60, attempts: { ...jobPayload, eligibilityAttempts: attempts } }
  }
  if (!eligibility.eligible) {
    await promoRepo.updatePromotionTarget(ptgt.id, { status: PROMOTION_TARGET_STATUS.FAILED, eligibilityStatus: PROMOTION_TARGET_ELIGIBILITY.INELIGIBLE, eligibilityReason: eligibility.reason, error: eligibility.reason, attempts: ptgt.attempts + 1 })
    await refundPromotionTargetShare(ptgt, promotion, post, 'ineligible for promotion')
    await refreshPromotionStatus(promotion.id)
    await logMetaEvent({ action: 'promotion_target_ineligible', promotionId: promotion.id, promotionTargetId: ptgt.id, postId: post.id, postTargetId: target.id, platform: ptgt.platform, error: eligibility.reason })
    return { done: true }
  }
  await promoRepo.updatePromotionTarget(ptgt.id, { eligibilityStatus: PROMOTION_TARGET_ELIGIBILITY.ELIGIBLE, eligibilityReason: null })
  if (eligibility.promotableId) target.promotableId = eligibility.promotableId

  await promoRepo.updatePromotion(promotion.id, { status: PROMOTION_STATUS.CREATING })
  await promoRepo.updatePromotionTarget(ptgt.id, { status: PROMOTION_TARGET_STATUS.CREATING })

  const promoPost = {
    ...post,
    name: `${post.name} ${ptgt.platform} ${ptgt.id.slice(0, 4)}`,
    boostBudgetType: promotion.budgetType,
    boostBudgetAmount: promotion.budgetAmount,
    boostSpendCap: promotion.spendCap,
    boostEndTime: promotion.endAt,
    boostTargeting: promotion.targeting,
    boostPlacement: promotion.placement,
    boostBidStrategy: promotion.bidStrategy,
    boostOptimizationGoal: promotion.optimizationGoal,
    boostObjective: promotion.objective,
    boostCallToAction: promotion.callToAction,
    boostLink: promotion.link,
    boostHeadline: promotion.headline,
    boostDescription: promotion.description,
    scheduledAt: promotion.startAt,
  }
  const coinRate = await getCoinConversionRate()
  const boostPayload = await buildPostBoostPayloads(promoPost, target, coinRate)
  if (boostPayload.minBudgetError || boostPayload.scheduleError) {
    const error = boostPayload.minBudgetError || boostPayload.scheduleError
    await promoRepo.updatePromotionTarget(ptgt.id, { status: PROMOTION_TARGET_STATUS.FAILED, error, attempts: ptgt.attempts + 1 })
    await refundPromotionTargetShare(ptgt, promotion, post, 'invalid boost configuration')
    await refreshPromotionStatus(promotion.id)
    return { done: true }
  }
  boostPayload.fbCampaignName = `${boostPayload.fbCampaignName}-${ptgt.id.slice(0, 4)}`

  const pageId = target.platformCode === 'instagram' ? (target.igBusinessAccountId || target.platformUserId) : target.platformUserId
  const promotable = target.promotableId || null
  const objectStoryId = target.platformCode === 'instagram' ? target.metaObjectId : (promotable || qualifyFbPostId(pageId, target.metaObjectId))

  const result = await executeBoostCreation({
    post: promoPost, target, adAccountId, systemToken, boostPayload, objectStoryId, jobPayload,
    logPrefix: 'promotion',
  }, {
    existingIds: {
      campaignId: ptgt.platformCampaignId || null,
      adsetId: ptgt.platformAdsetId || null,
      creativeId: ptgt.platformCreativeId || null,
      adId: ptgt.platformAdId || null,
    },
    onObjectCreated: async (type, id) => {
      const patch = {}
      if (type === 'facebook_campaign') patch.platformCampaignId = id
      else if (type === 'ad_set') patch.platformAdsetId = id
      else if (type === 'ad_creative') patch.platformCreativeId = id
      else if (type === 'ad') patch.platformAdId = id
      await promoRepo.updatePromotionTarget(ptgt.id, patch)
    },
    onCleanupDb: async () => {
      await promoRepo.updatePromotionTarget(ptgt.id, { platformCampaignId: null, platformAdsetId: null, platformCreativeId: null, platformAdId: null })
    },
  })

  if (result && typeof result.requeueAfterSeconds === 'number') {
    await promoRepo.updatePromotionTarget(ptgt.id, { status: PROMOTION_TARGET_STATUS.PENDING })
    return result
  }
  if (!result.success) {
    const executeAttempts = (Number(jobPayload.executeAttempts) || 0)
    const transientRetry = result.transient && executeAttempts < 4
    if (transientRetry) {
      await promoRepo.updatePromotionTarget(ptgt.id, { status: PROMOTION_TARGET_STATUS.PENDING })
      return { requeueAfterSeconds: 30, attempts: { ...jobPayload, executeAttempts: executeAttempts + 1 } }
    }
    await promoRepo.updatePromotionTarget(ptgt.id, { status: PROMOTION_TARGET_STATUS.FAILED, error: result.error, attempts: ptgt.attempts + 1 })
    await refundPromotionTargetShare(ptgt, promotion, post, 'Meta ad creation failed')
    await refreshPromotionStatus(promotion.id)
    return { done: true }
  }

  const activationOrder = [
    ['facebook_campaign', result.finalIds.campaignId],
    ['ad_set', result.finalIds.adsetId],
    ['ad_creative', result.finalIds.creativeId],
    ['ad', result.finalIds.adId],
  ]
  for (const [type, id] of activationOrder) {
    if (!id) continue
    try {
      await updateAdStatus(id, 'ACTIVE', systemToken)
      await logMetaEvent({ action: `promotion_activate_${type}`, promotionId: promotion.id, promotionTargetId: ptgt.id, postId: post.id, postTargetId: target.id, platform: ptgt.platform, objectId: id })
    } catch (err) {
      const activationError = err?.message || String(err)
      const isTransientActivation = (err?.statusCode && err.statusCode >= 500) || err?.metaAmbiguous || err?.metaErrorCode === 1
      if (isTransientActivation) {
        await logMetaEvent({ action: 'promotion_activation_retry', promotionId: promotion.id, promotionTargetId: ptgt.id, objectType: type, objectId: id, error: activationError })
        return { requeueAfterSeconds: 30, attempts: { ...jobPayload } }
      }
      await promoRepo.updatePromotionTarget(ptgt.id, { status: PROMOTION_TARGET_STATUS.FAILED, error: `Activation failed (${type} ${id}): ${activationError}`, attempts: ptgt.attempts + 1 })
      await refundPromotionTargetShare(ptgt, promotion, post, 'ad activation failed')
      await refreshPromotionStatus(promotion.id)
      return { done: true }
    }
  }

  const perTargetPaise = await promotionPerTargetPaise(promotion)
  const consumePatch = perTargetPaise > 0 && !ptgt.consumedPaise ? { consumedPaise: perTargetPaise } : {}
  await promoRepo.updatePromotionTarget(ptgt.id, { status: PROMOTION_TARGET_STATUS.ACTIVE, error: null, attempts: ptgt.attempts + 1, ...consumePatch })
  await refreshPromotionStatus(promotion.id)
  await logMetaEvent({ action: 'promotion_target_active', promotionId: promotion.id, promotionTargetId: ptgt.id, postId: post.id, postTargetId: target.id, platform: ptgt.platform, metaCampaignId: result.finalIds.campaignId, metaAdsetId: result.finalIds.adsetId, metaCreativeId: result.finalIds.creativeId, metaAdId: result.finalIds.adId })
  return { done: true }
}

export async function refreshPromotionStatus(promotionId) {
  const promotion = await promoRepo.findPromotionById(promotionId)
  if (!promotion) return null
  if (TERMINAL_PROMOTION_STATUSES.includes(promotion.status)) return promotion
  const targets = await promoRepo.findPromotionTargetsByPromotionId(promotionId)
  if (targets.length === 0) return promotion

  const active = targets.filter(t => t.status === PROMOTION_TARGET_STATUS.ACTIVE)
  const failed = targets.filter(t => t.status === PROMOTION_TARGET_STATUS.FAILED)
  const cancelled = targets.filter(t => t.status === PROMOTION_TARGET_STATUS.CANCELLED)
  const inFlight = targets.filter(t => IN_FLIGHT_PROMOTION_TARGET_STATUSES.includes(t.status))
  const settled = targets.length - inFlight.length

  let next = promotion.status
  if (cancelled.length === targets.length) {
    next = PROMOTION_STATUS.CANCELLED
  } else if (inFlight.length > 0) {
    next = active.length > 0 ? PROMOTION_STATUS.CREATING : (inFlight.some(t => t.status === PROMOTION_TARGET_STATUS.VALIDATING) ? PROMOTION_STATUS.VALIDATING : PROMOTION_STATUS.CREATING)
  } else if (active.length > 0) {
    next = failed.length > 0 || cancelled.length > 0 ? PROMOTION_STATUS.ACTIVE : PROMOTION_STATUS.ACTIVE
  } else if (failed.length > 0) {
    next = PROMOTION_STATUS.FAILED
  }

  if (next !== promotion.status) {
    const allowed = VALID_PROMOTION_TRANSITIONS[promotion.status] || []
    if (allowed.includes(next) || promotion.status === PROMOTION_STATUS.WAITING_FOR_POST) {
      await promoRepo.updatePromotion(promotionId, { status: next })
    }
  }
  const refreshed = await promoRepo.findPromotionById(promotionId)
  if (refreshed && TERMINAL_PROMOTION_STATUSES.includes(refreshed.status)) {
    await settlePromotionLeftover(promotionId)
  }
  return refreshed
}

export async function recoverStuckPromotionTargets() {
  if (!(await isPromotionsEnabled())) return { recovered: 0 }
  const stuck = await promoRepo.findStuckPendingPromotionTargets()
  let recovered = 0
  for (const ptgt of stuck) {
    try {
      await enqueuePromotionTargetJob(ptgt.id)
      recovered += 1
    } catch (err) {
      await logMetaEvent({ action: 'promotion_recover_error', promotionTargetId: ptgt.id, error: err?.message || String(err) })
    }
  }
  if (recovered > 0) {
    await logMetaEvent({ action: 'promotion_recover_batch', recovered })
  }
  return { recovered }
}

async function cleanupPromotionTargetMetaObjects(ptgt, systemToken) {
  const deleters = []
  if (ptgt.platformAdId) deleters.push(() => deleteAd(ptgt.platformAdId, systemToken))
  if (ptgt.platformCreativeId) deleters.push(() => deleteAdCreative(ptgt.platformCreativeId, systemToken))
  if (ptgt.platformAdsetId) deleters.push(() => deleteAdSet(ptgt.platformAdsetId, systemToken))
  if (ptgt.platformCampaignId) deleters.push(() => deleteAdCampaign(ptgt.platformCampaignId, systemToken))
  let cleaned = 0
  for (const del of deleters) {
    try {
      await del()
      cleaned += 1
    } catch (err) {
      await logMetaEvent({ action: 'promotion_cancel_cleanup_error', promotionId: ptgt.promotionId, promotionTargetId: ptgt.id, objectType: 'meta_object', error: err?.message || String(err) })
    }
  }
  return cleaned
}

export async function cancelPromotion(userId, promotionId) {
  const promotion = await promoRepo.findPromotionById(promotionId)
  if (!promotion) throw new NotFoundError('Promotion not found')
  const post = await postRepo.findPostById(promotion.postId)
  if (!post) throw new NotFoundError('Post not found')
  if (post.clientId !== userId) throw new ForbiddenError('Not your promotion')
  return cancelPromotionById(promotionId)
}

export async function cancelPromotionById(promotionId) {
  const promotion = await promoRepo.findPromotionById(promotionId)
  if (!promotion) throw new NotFoundError('Promotion not found')
  const post = await postRepo.findPostById(promotion.postId)
  if (!post) throw new NotFoundError('Post not found')
  if (TERMINAL_PROMOTION_STATUSES.includes(promotion.status)) {
    throw new ConflictError(`Promotion is already ${promotion.status}`)
  }

  const targets = await promoRepo.findPromotionTargetsByPromotionId(promotionId)
  const { accessToken: systemToken } = await resolveAccountContext()
  const perTargetPaise = await promotionPerTargetPaise(promotion)

  for (const ptgt of targets) {
    if (ptgt.status === PROMOTION_TARGET_STATUS.CANCELLED) continue
    const wasActive = ptgt.status === PROMOTION_TARGET_STATUS.ACTIVE || ptgt.status === PROMOTION_TARGET_STATUS.PAUSED
    if (ptgt.status === PROMOTION_TARGET_STATUS.ACTIVE || ptgt.status === PROMOTION_TARGET_STATUS.CREATING || ptgt.status === PROMOTION_TARGET_STATUS.VALIDATING || ptgt.status === PROMOTION_TARGET_STATUS.PAUSED) {
      if (systemToken) {
        await cleanupPromotionTargetMetaObjects(ptgt, systemToken)
      }
      if (wasActive && perTargetPaise > 0 && !ptgt.consumedPaise) {
        await promoRepo.updatePromotionTarget(ptgt.id, { consumedPaise: perTargetPaise })
      }
      await promoRepo.updatePromotionTarget(ptgt.id, { status: PROMOTION_TARGET_STATUS.CANCELLED, platformCampaignId: null, platformAdsetId: null, platformCreativeId: null, platformAdId: null })
    } else {
      await promoRepo.updatePromotionTarget(ptgt.id, { status: PROMOTION_TARGET_STATUS.CANCELLED })
      if (!wasActive) {
        await refundPromotionTargetShare(ptgt, promotion, post, 'promotion cancelled')
      }
    }
  }

  await promoRepo.updatePromotion(promotionId, { status: PROMOTION_STATUS.CANCELLED })
  await settlePromotionLeftover(promotionId)
  await logMetaEvent({ action: 'promotion_cancelled', promotionId, postId: promotion.postId, targets: targets.length })
  return promoRepo.findPromotionById(promotionId)
}

/**
 * Terminal boost settlement for a confirmed-deleted PostTarget. Scoped to
 * this target's own objects only (verified by reading the target's own
 * platform_*_id columns — never another execution's objects).
 *
 * Settlement mirrors the cancel path's existing rules exactly once:
 *   - was ACTIVE/PAUSED (delivered share) -> consume the share (no refund)
 *   - never active -> refund the share via the hardened claim path
 * Consumers: deletion enforcement (guarded confirm owner) and nothing else.
 */
export async function settleBoostShareForDeletedPostTarget(postTargetId, reason) {
  const ptgt = await promoRepo.findPromotionTargetByPostTargetId(postTargetId)
  if (!ptgt) return null
  if (ptgt.status === PROMOTION_TARGET_STATUS.CANCELLED) return ptgt
  const promotion = await promoRepo.findPromotionById(ptgt.promotionId)
  const post = promotion ? await postRepo.findPostById(promotion.postId) : null
  if (!promotion || !post) return null

  let systemToken = null
  try {
    ;({ accessToken: systemToken } = await resolveAccountContext())
  } catch {}

  // scoped Meta cleanup first (best-effort, idempotent — never throws)
  if (systemToken) {
    await cleanupPromotionTargetMetaObjects(ptgt, systemToken)
  }

  const { transaction } = await import('../../../shared/database/connection.js')
  return transaction(async () => {
    const fresh = await promoRepo.findPromotionTargetByPostTargetId(postTargetId)
    if (!fresh || fresh.status === PROMOTION_TARGET_STATUS.CANCELLED) return fresh
    const wasActive = fresh.status === PROMOTION_TARGET_STATUS.ACTIVE || fresh.status === PROMOTION_TARGET_STATUS.PAUSED
    await promoRepo.updatePromotionTarget(fresh.id, {
      status: PROMOTION_TARGET_STATUS.FAILED,
      error: reason,
      attempts: fresh.attempts + 1,
      platformCampaignId: null,
      platformAdsetId: null,
      platformCreativeId: null,
      platformAdId: null,
    })
    if (wasActive) {
      const perTargetPaise = await promotionPerTargetPaise(promotion)
      if (perTargetPaise > 0) {
        await promoRepo.claimPromotionTargetConsume(fresh.id, perTargetPaise)
      }
    } else {
      await refundPromotionTargetShare(fresh, promotion, post, reason)
    }
    await refreshPromotionStatus(promotion.id)
    await logMetaEvent({ action: 'promotion_target_settled_deleted', promotionId: promotion.id, promotionTargetId: fresh.id, postId: post.id, postTargetId, wasActive, reason })
    return promoRepo.findPromotionTargetByPostTargetId(postTargetId)
  })
}

export async function getPromotionForClient(userId, promotionId) {
  const promotion = await promoRepo.findPromotionById(promotionId)
  if (!promotion) throw new NotFoundError('Promotion not found')
  if (promotion.clientId !== userId) throw new ForbiddenError('Not your promotion')
  const targets = await promoRepo.findPromotionTargetsByPromotionId(promotionId)
  return { ...promotion, targets }
}

export async function listPromotionsForPost(userId, postId) {
  const post = await loadPostForClient(userId, postId)
  const promotion = await promoRepo.findPromotionByPostId(post.id)
  if (!promotion) return { promotion: null, targets: [] }
  const targets = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)
  return { promotion, targets }
}

export async function adminGetPromotion(promotionId) {
  const promotion = await promoRepo.findPromotionById(promotionId)
  if (!promotion) throw new NotFoundError('Promotion not found')
  const targets = await promoRepo.findPromotionTargetsByPromotionId(promotionId)
  return { ...promotion, targets }
}
