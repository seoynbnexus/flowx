import * as repo from './post.repository.js'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../../shared/utils/uuid.utils.js'
import { NotFoundError, ValidationError, ForbiddenError } from '../../../shared/errors/AppError.js'
import { POST_STATUS, POST_TYPES, VALID_TRANSITIONS, REVIEW_ACTIONS, POST_JOB_TYPES, POST_TARGET_STATUS, POST_TARGET_TYPES, POST_TARGET_PUBLISH_STATE, PUBLISHER_REQUEST_STATUS } from './post.model.js'
import { enqueueCampaignJob as enqueueJob, enqueueTargetJob as enqueueReelJob, requeueAutoJob, enqueueCampaignJob } from '../campaigns/campaign.repository.js'
import { transaction, queryOne } from '../../../shared/database/connection.js'
import { createPagePhotoPost, createPageVideoPost, createFeedPost, createInstagramMedia, publishInstagramMedia, createInstagramStory, getContainerStatus, getMediaEngagement, deleteInstagramContainer, extractMetaError, createPageVideoStory, createPagePhotoStory, startPageReel, uploadPageReelMedia, getPageReelStatus, finishPageReel, resolvePageReelPostId, qualifyFbPostId, createUnpublishedPagePost, createAdCreativeFromPost, createAdCreative, createAdCampaign, createAdSet, createAd, updateAdStatus, getPostPromotability, resolveFbPostObjectId, isPostLiveForBoost, isInstagramPostLive, getInstagramBoostEligibility, createAdCreativeFromInstagramPost, getConnectedFacebookPage, getCreativeStoryId, deleteAdCreative, deleteAdCampaign, deleteAdSet } from '../../../shared/services/meta-ads.service.js'
import { getInstagramMedia } from '../../../shared/services/meta-graph.service.js'
import { buildPostMessage, validatePostContent, PostValidationError } from '../../../shared/services/post-content-validation.js'
import { isPublicHttpUrl, resolveMediaHost, inspectMediaSize, fetchBoundedBytes } from '../../../shared/services/media-url.js'
import { probeMedia, probeWithFfprobe } from '../../../shared/services/media-probe.js'
import { isRateLimited, tokenKeyFor } from '../../../shared/services/meta-rate-limiter.js'
import { randomBytes, createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAccountContext, getCoinConversionRate } from '../campaigns/campaign.service.js'
import { logMetaEvent } from '../../../shared/services/meta-logger.service.js'

async function isPostDuplicateEnabled() {
  try {
    const row = await queryOne('SELECT config_value FROM app_config WHERE config_key = ?', ['feature_visibility'])
    if (!row) return false
    const v = typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value
    return v.post_duplicate === true
  } catch { return false }
}

function validateBoostConfig(data) {
  if (data.boostEnabled) {
    if (!data.boostBudgetAmount || data.boostBudgetAmount <= 0) {
      throw new ValidationError('Boost requires a budget amount')
    }
    const budgetType = data.boostBudgetType || 'daily'
    if (budgetType === 'lifetime' && !data.boostEndTime) {
      throw new ValidationError('Lifetime boost requires an end time')
    }
    // Minimum budget check (₹100 minimum)
    const coinRate = 1 // will be validated properly in createPost with actual rate
  } else if (data.boostBudgetAmount || data.boostSpendCap || data.boostEndTime) {
    throw new ValidationError('Budget/spend cap/end time require boost to be enabled')
  }
}

function calculatePostBoostCost(post) {
  const perCopy = post.boostBudgetAmount || 1000
  const copies = post.runOnPublishers ? (post.publisherCount || 0) + 1 : 1
  return perCopy * copies
}

async function capturePostPromotability(target, qualifiedId) {
  if (target.platformCode !== 'facebook' || !target.accessToken || !qualifiedId) return
  try {
    const promo = await getPostPromotability(qualifiedId, target.accessToken)
    await repo.updatePostTargetStatus(target.id, {
      promotableId: promo.promotableId,
      isEligibleForPromotion: promo.isEligible,
      allowedObjectives: promo.allowedObjectives,
      eligibilityCheckedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      eligibilityReason: promo.isEligible ? null : `Not eligible: ${promo.instagramEligibility || 'Help Center 1575107409431290'}`,
    })
  } catch (e) {
    // best-effort, don't block publish
    try {
      await repo.updatePostTargetStatus(target.id, {
        eligibilityCheckedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
        eligibilityReason: String(e.message).slice(0,500),
      })
    } catch {}
  }
}

export async function getPostBoostFlags(postId) {
  try {
    const post = await repo.findPostById(postId)
    return post ? { boostEnabled: !!post.boostEnabled } : null
  } catch {
    return null
  }
}

export async function capturePostPromotabilityForWebhook(targetRow, qualifiedPostId) {
  const { decrypt } = await import('../../../shared/utils/crypto.utils.js')
  const { bufferToUuid } = await import('../../../shared/utils/uuid.utils.js')
  const { queryOne } = await import('../../../shared/database/connection.js')
  const account = await queryOne('SELECT access_token FROM user_platform_accounts WHERE id = ?', [targetRow.platform_account_id])
  const accessToken = account?.access_token ? decrypt(account.access_token) : null
  if (!accessToken) return
  await capturePostPromotability({
    id: bufferToUuid(targetRow.id),
    platformCode: 'facebook',
    accessToken,
  }, qualifiedPostId)
}

async function getFbPageIdForIgTarget(target, clientId) {
  const igActorId = target.igBusinessAccountId || target.platformUserId
  if (!igActorId || !clientId) return null
  const linked = await queryOne(
    `SELECT upa.platform_user_id FROM user_platform_accounts upa
     JOIN platforms p ON p.id = upa.platform_id
     WHERE upa.user_id = ? AND p.code = 'facebook' AND upa.verification_status = 'verified'
       AND upa.instagram_business_account_id = ? LIMIT 1`,
    [uuidToBuffer(clientId), String(igActorId)]
  )
  if (linked?.platform_user_id) return String(linked.platform_user_id)
  if (target.accessToken) {
    const graphPageId = await getConnectedFacebookPage(igActorId, target.accessToken)
    if (graphPageId) return graphPageId
  }
  return null
}

async function buildPostBoostPayloads(post, target, coinRate) {
  const budgetType = post.boostBudgetType || 'daily'
  const isDaily = budgetType === 'daily'
  const minBudgetInr = isDaily ? 241 : 100
  const coinBudget = post.boostBudgetAmount || 1000
  const budgetInINR = Math.round(coinBudget * coinRate)
  const isLifetime = budgetType === 'lifetime'

  let scheduleError = null
  const now = Date.now()
  const startTimeMs = post.scheduledAt ? new Date(post.scheduledAt).getTime() : now
  const endTimeMs = post.boostEndTime ? new Date(post.boostEndTime).getTime() : null

  if (post.scheduledAt && startTimeMs && startTimeMs <= now) scheduleError = 'Boost start time must be in the future'
  if (endTimeMs && endTimeMs <= now) scheduleError = 'Boost end time must be in the future'
  if (endTimeMs && startTimeMs && endTimeMs <= startTimeMs) scheduleError = 'End time must be after start time'
  if (isLifetime && !endTimeMs) scheduleError = 'End time is required for lifetime budget'
  if (isDaily && endTimeMs && endTimeMs - startTimeMs <= 24 * 60 * 60 * 1000) scheduleError = 'Daily budget requires duration > 24h'

  const legacyObjectiveMap = {
    REACH: 'OUTCOME_AWARENESS',
    IMPRESSIONS: 'OUTCOME_AWARENESS',
    BRAND_AWARENESS: 'OUTCOME_AWARENESS',
    VIDEO_VIEWS: 'OUTCOME_ENGAGEMENT',
    POST_ENGAGEMENT: 'OUTCOME_ENGAGEMENT',
    LINK_CLICKS: 'OUTCOME_TRAFFIC',
    MESSAGES: 'OUTCOME_ENGAGEMENT',
    PAGE_LIKES: 'OUTCOME_ENGAGEMENT',
    APP_INSTALLS: 'OUTCOME_APP_PROMOTION',
    CONVERSIONS: 'OUTCOME_SALES',
    LEAD_GENERATION: 'OUTCOME_LEADS',
  }
  const allowedObjectives = new Set([
    'OUTCOME_AWARENESS','OUTCOME_TRAFFIC','OUTCOME_ENGAGEMENT'
  ])
  let rawObjective = String(post.boostObjective || 'OUTCOME_ENGAGEMENT').toUpperCase().trim()
  if (legacyObjectiveMap[rawObjective]) rawObjective = legacyObjectiveMap[rawObjective]
  if (!allowedObjectives.has(rawObjective)) rawObjective = 'OUTCOME_ENGAGEMENT'
  const fbCampaignName = `FlowX-Boost-${(post.name || 'Boost').slice(0, 40)}-${String(post.id).slice(0, 8)}`
  const targeting = post.boostTargeting && typeof post.boostTargeting === 'object' ? { ...post.boostTargeting } : {}
  const boostCallToAction = post.boostCallToAction || null
  const boostLink = post.boostLink || post.mediaUrl || null
  const boostHeadline = post.boostHeadline || null
  const boostDescription = post.boostDescription || null
  delete targeting.age
  delete targeting.gender
  delete targeting.country
  if (targeting.geo_locations) delete targeting.geo_locations.location_types
  if (!targeting.geo_locations?.countries?.length && !targeting.geo_locations?.custom_locations?.length) {
    targeting.geo_locations = { countries: ['IN'] }
  }

  const objectiveConfig = {
    OUTCOME_AWARENESS: { goals: ['REACH','IMPRESSIONS'], defaultGoal: 'REACH' },
    OUTCOME_TRAFFIC: { goals: ['LINK_CLICKS','LANDING_PAGE_VIEWS'], defaultGoal: 'LINK_CLICKS' },
    OUTCOME_ENGAGEMENT: { goals: ['POST_ENGAGEMENT','THRUPLAY','REACH'], defaultGoal: 'REACH' },
  }
  const effectiveOptimization = (() => {
    if (post.boostOptimizationGoal) {
      const v = String(post.boostOptimizationGoal).toUpperCase().trim()
      const allowed = objectiveConfig[rawObjective]?.goals || []
      if (allowed.includes(v)) return v
      return objectiveConfig[rawObjective]?.defaultGoal || 'REACH'
    }
    return objectiveConfig[rawObjective]?.defaultGoal || 'REACH'
  })()
  return {
    budgetInINR,
    isDaily,
    minBudgetError: budgetInINR < minBudgetInr ? `Minimum ${isDaily ? 'daily' : 'lifetime'} budget is ₹${minBudgetInr} (${Math.ceil(minBudgetInr / coinRate)} coins)` : null,
    scheduleError,
    fbCampaignName,
    targeting,
    spendCapInPaise: post.boostSpendCap ? Math.round(post.boostSpendCap * coinRate * 100) : null,
    creativeMessage: buildPostMessage(post),
    creativeMediaUrl: post.mediaUrl,
    boostCallToAction,
    boostLink,
    boostHeadline,
    boostDescription,
    adSetBudget: {
      budgetType,
      budgetAmount: budgetInINR,
      bidStrategy: post.boostBidStrategy || 'LOWEST_COST_WITHOUT_CAP',
      optimizationGoal: effectiveOptimization,
      promotedPageId: target.platformCode === 'instagram' ? null : target.platformUserId,
      destinationType: 'ON_POST',
    },
    adSetSchedule: (() => {
      const hasFutureStart = startTimeMs && startTimeMs > now
      const schedule = {}
      if (hasFutureStart) schedule.startTime = Math.floor(startTimeMs / 1000)
      if (endTimeMs) schedule.endTime = Math.floor(endTimeMs / 1000)
      return schedule
    })(),
    adSetPlacement: (() => {
      const placement = post.boostPlacement && typeof post.boostPlacement === 'object' ? { ...post.boostPlacement } : {}
      if (!placement.publisherPlatforms?.length && target.platformCode === 'instagram') placement.publisherPlatforms = ['instagram']
      return placement
    })(),
    campaignObjective: rawObjective,
  }
}

async function createPostBoostForTarget(post, target, jobPayload = {}) {
  if (target.platformCode !== 'facebook' && target.platformCode !== 'instagram') {
    await logMetaEvent({ action: 'post_boost_hard_fail', postId: post.id, targetId: target.id, error: `Boost not supported for platform ${target.platformCode}` })
    return { success: false, error: `Posts on ${target.platformCode} cannot be boosted.` }
  }
  const igStoryPoll = {
    intervalMs: 5000,
    maxTries: 6,
    requeueSeconds: 60,
    maxRequeues: 8
  }
  // hard gate: check eligibility first (no dark-post fallback)
  if (target.platformCode === 'facebook') {
    // lazy resolution: only video/reel posts store a video id needing post_id resolution; photo posts legitimately store bare photo ids
    if (target.metaObjectId && !String(target.metaObjectId).includes('_') && target.remoteVideoId && target.accessToken) {
      const resolvedId = await resolveFbPostObjectId(target.platformUserId, target.remoteVideoId, target.accessToken)
      if (resolvedId) {
        await repo.updatePostTargetStatus(target.id, { metaObjectId: resolvedId })
        target.metaObjectId = resolvedId
        await logMetaEvent({ action: 'post_boost_id_resolved', postId: post.id, targetId: target.id, objectId: resolvedId })
      } else {
        await logMetaEvent({ action: 'post_boost_id_pending', postId: post.id, targetId: target.id, error: `post_id not yet available for ${target.remoteVideoId || target.metaObjectId} — requeueing` })
        return { requeueAfterSeconds: 60, attempts: 0 }
      }
    }
    // lazy fetch promotability if not yet checked (backwards compat for old rows)
    if (target.isEligibleForPromotion == null && target.promotableId == null && target.metaObjectId) {
      const qualified = qualifyFbPostId(target.platformUserId, target.metaObjectId)
      await capturePostPromotability(target, qualified)
      const refreshed = await repo.findPostTargetById(target.id)
      if (refreshed) {
        target.promotableId = refreshed.promotableId
        target.isEligibleForPromotion = refreshed.isEligibleForPromotion
        target.allowedObjectives = refreshed.allowedObjectives
      }
    }
    // promotability fetch may have failed (token/permission) — don't hard-fail on unknown
    if (target.isEligibleForPromotion === false) {
      const reason = target.eligibilityReason || 'This post is not eligible to be boosted'
      await logMetaEvent({ action: 'post_boost_hard_fail', postId: post.id, targetId: target.id, error: reason })
      return { success: false, error: `Post ${target.metaObjectId} isn't eligible to be boosted — ${reason}. Help Center https://www.facebook.com/business/help/1575107409431290` }
    }
    if (target.allowedObjectives && Array.isArray(target.allowedObjectives) && target.allowedObjectives.length && post.boostObjective) {
      const legacyMap = { REACH: 'OUTCOME_AWARENESS', IMPRESSIONS: 'OUTCOME_AWARENESS', BRAND_AWARENESS: 'OUTCOME_AWARENESS', VIDEO_VIEWS: 'OUTCOME_ENGAGEMENT', POST_ENGAGEMENT: 'OUTCOME_ENGAGEMENT', LINK_CLICKS: 'OUTCOME_TRAFFIC', MESSAGES: 'OUTCOME_ENGAGEMENT', PAGE_LIKES: 'OUTCOME_ENGAGEMENT', CONVERSIONS: 'OUTCOME_SALES', LEAD_GENERATION: 'OUTCOME_LEADS' }
      const mapped = legacyMap[String(post.boostObjective).toUpperCase().trim()] || String(post.boostObjective).toUpperCase().trim()
      const allowed = new Set(target.allowedObjectives.map(s => String(s).toUpperCase()))
      if (!allowed.has(mapped)) {
        return { success: false, error: `Objective ${post.boostObjective} not allowed for this post — allowed: ${target.allowedObjectives.join(', ')}` }
      }
    }
  } else if (target.platformCode === 'instagram') {
    if (post.type === 'story') {
      return { success: false, error: `Instagram stories cannot be boosted — only feed posts and reels are supported` }
    }
    if (target.isEligibleForPromotion == null && target.promotableId == null && target.metaObjectId) {
      const eligibility = await getInstagramBoostEligibility(target.metaObjectId, target.accessToken)
      if (!eligibility.ready) {
        await logMetaEvent({ action: 'post_boost_id_pending', postId: post.id, targetId: target.id, error: `boost_eligibility_info not yet available for ${target.metaObjectId} — requeueing` })
        try {
          await repo.updatePostTargetStatus(target.id, {
            eligibilityCheckedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
            eligibilityReason: 'Pending: boost_eligibility_info not available yet',
          })
        } catch {}
        return { requeueAfterSeconds: 60, attempts: 0 }
      }
      await repo.updatePostTargetStatus(target.id, {
        promotableId: eligibility.isEligible ? target.metaObjectId : null,
        isEligibleForPromotion: eligibility.isEligible,
        allowedObjectives: eligibility.allowedObjectives,
        eligibilityCheckedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
        eligibilityReason: eligibility.isEligible ? null : (eligibility.reasons?.join('; ') || 'Not eligible for Instagram boost'),
      })
      const refreshed = await repo.findPostTargetById(target.id)
      if (refreshed) {
        target.promotableId = refreshed.promotableId
        target.isEligibleForPromotion = refreshed.isEligibleForPromotion
        target.allowedObjectives = refreshed.allowedObjectives
      }
    }
    if (target.isEligibleForPromotion === false) {
      const reason = target.eligibilityReason || 'This Instagram post is not eligible to be boosted'
      await logMetaEvent({ action: 'post_boost_hard_fail', postId: post.id, targetId: target.id, error: reason })
      return { success: false, error: `Instagram post ${target.metaObjectId} isn't eligible to be boosted — ${reason}. Help Center https://www.facebook.com/business/help/1575107409431290` }
    }
    if (target.allowedObjectives && Array.isArray(target.allowedObjectives) && target.allowedObjectives.length && post.boostObjective) {
      const legacyMap = { REACH: 'OUTCOME_AWARENESS', IMPRESSIONS: 'OUTCOME_AWARENESS', BRAND_AWARENESS: 'OUTCOME_AWARENESS', VIDEO_VIEWS: 'OUTCOME_ENGAGEMENT', POST_ENGAGEMENT: 'OUTCOME_ENGAGEMENT', LINK_CLICKS: 'OUTCOME_TRAFFIC', MESSAGES: 'OUTCOME_ENGAGEMENT', PAGE_LIKES: 'OUTCOME_ENGAGEMENT', CONVERSIONS: 'OUTCOME_SALES', LEAD_GENERATION: 'OUTCOME_LEADS' }
      const mapped = legacyMap[String(post.boostObjective).toUpperCase().trim()] || String(post.boostObjective).toUpperCase().trim()
      const allowed = new Set(target.allowedObjectives.map(s => String(s).toUpperCase()))
      if (!allowed.has(mapped)) {
        return { success: false, error: `Objective ${post.boostObjective} not allowed for this Instagram post — allowed: ${target.allowedObjectives.join(', ')}` }
      }
    }
  }

  const { accountId: adAccountId, accessToken: systemToken, accountDbId } = await resolveAccountContext()
  const coinRate = await getCoinConversionRate()
  let boostPayload
  try {
    boostPayload = await buildPostBoostPayloads(post, target, coinRate)
  } catch (e) {
    throw e
  }

  logMetaEvent({ action: 'boost_post_payload_created', params: { payload: JSON.stringify(boostPayload), postId: post.id, targetId: target.id, adAccountId, pageId: target.platformUserId } })

  if (boostPayload.minBudgetError) {
    await logMetaEvent({ action: 'post_boost_create', postId: post.id, targetId: target.id, error: boostPayload.minBudgetError })
    return { success: false, error: boostPayload.minBudgetError }
  }
  if (boostPayload.scheduleError) {
    await logMetaEvent({ action: 'post_boost_create', postId: post.id, targetId: target.id, error: boostPayload.scheduleError })
    return { success: false, error: boostPayload.scheduleError }
  }

  const pageId = target.platformCode === 'instagram' ? (target.igBusinessAccountId || target.platformUserId) : target.platformUserId
  const rawObjectStoryId = target.metaObjectId
  const promotable = target.promotableId || null
  let objectStoryId = target.platformCode === 'instagram' ? rawObjectStoryId : (target.platformCode === 'facebook' ? (promotable || qualifyFbPostId(pageId, rawObjectStoryId)) : rawObjectStoryId)

  logMetaEvent({ action: 'post_boost_create', postId: post.id, targetId: target.id, adAccountId, pageId: target.platformUserId })
  const createdObjects = []

  const validateStep = async (step, fn) => {
    try {
      await fn()
      return null
    } catch (error) {
      const detail = extractMetaError(error)
      await logMetaEvent({ postId: post.id, targetId: target.id, action: step, error: detail?.userMsg || error.message })
      return detail?.userMsg || error.message
    }
  }

  const isInvalidPostIdError = (err) => {
    const d = extractMetaError(err)
    const msg = String(err.message)
    const sub = d?.subcode
    return d?.code === 100 && (
      sub === 1487472 || sub === 2446187 || sub === 1885557 || sub === 2446289 ||
      msg.includes('Invalid post_id') || msg.includes("can't be promoted") || msg.includes('cannot be promoted') || msg.includes('Invalid post_id parameter') || msg.includes("This post can't be boosted")
    )
  }
  const isUnpromotableAdError = (err) => {
    const d = extractMetaError(err)
    const msg = String(err.message)
    return d?.code === 100 && (d?.subcode === 1487472 || d?.subcode === 2446187 || msg.includes("can't be promoted") || msg.includes("Page post can't be used") || msg.includes("This post can't be boosted"))
  }

  try {
    const tryObjectStoryValidate = async () => {
      if (target.platformCode === 'instagram') {
        const igActorId = target.igBusinessAccountId || target.platformUserId
        const fbPageIdForIg = await getFbPageIdForIgTarget(target, post.clientId)
        await createAdCreativeFromInstagramPost(adAccountId, objectStoryId, igActorId, fbPageIdForIg, `Boost ${post.name}`, systemToken, true)
      } else {
        await createAdCreativeFromPost(adAccountId, objectStoryId, `Boost ${post.name}`, systemToken, true)
      }
    }
    let creativeValidationError = null
    try {
      await tryObjectStoryValidate()
    } catch (err) {
      const d = extractMetaError(err)
      const hardMsg = d?.userMsg || err.message
      if (isInvalidPostIdError(err)) {
        await logMetaEvent({ postId: post.id, targetId: target.id, action: 'validate_creative_hard_fail', error: `object_story_id ${objectStoryId} not promotable: ${hardMsg}` })
        creativeValidationError = `${hardMsg} — This post can't be boosted. Help Center https://www.facebook.com/business/help/1575107409431290`
      } else {
        creativeValidationError = hardMsg
      }
    }
    if (creativeValidationError) return { success: false, error: creativeValidationError }

    const campaignValidationError = await validateStep('validate_campaign', () =>
      createAdCampaign(adAccountId, boostPayload.fbCampaignName, boostPayload.campaignObjective, 'PAUSED', systemToken, { spendCap: boostPayload.spendCapInPaise }, true)
    )
    if (campaignValidationError) return { success: false, error: campaignValidationError }

    const t0 = Date.now()
    const fbCampaign = await createAdCampaign(adAccountId, boostPayload.fbCampaignName, boostPayload.campaignObjective, 'PAUSED', systemToken, { spendCap: boostPayload.spendCapInPaise })
    createdObjects.push({ type: 'facebook_campaign', id: fbCampaign.id, postId: post.id, targetId: target.id })
    await repo.createPostBoostTarget(post.id, target.id, { platformAccountId: target.platformAccountId, objectType: 'facebook_campaign', objectId: fbCampaign.id, status: 'PAUSED', boostStatus: 'pending', createdForUserId: post.clientId })

    const adSetValidationError = await validateStep('validate_ad_set', () =>
      createAdSet(adAccountId, fbCampaign.id, boostPayload.targeting, boostPayload.adSetBudget, boostPayload.adSetSchedule, boostPayload.adSetPlacement, systemToken, true)
    )
    if (adSetValidationError) {
      await repo.deletePostBoostTargetsByTargetId(target.id)
      return { success: false, error: adSetValidationError }
    }

    const t1 = Date.now()
    const fbAdSet = await createAdSet(adAccountId, fbCampaign.id, boostPayload.targeting, boostPayload.adSetBudget, boostPayload.adSetSchedule, boostPayload.adSetPlacement, systemToken)
    createdObjects.push({ type: 'ad_set', id: fbAdSet.id, postId: post.id, targetId: target.id })
    await repo.createPostBoostTarget(post.id, target.id, { platformAccountId: target.platformAccountId, objectType: 'ad_set', objectId: fbAdSet.id, status: 'PAUSED', boostStatus: 'pending', createdForUserId: post.clientId })

    const t2 = Date.now()
    let fbCreative
    try {
      if (target.platformCode === 'instagram') {
        const igActorId = target.igBusinessAccountId || target.platformUserId
        const fbPageIdForIg = await getFbPageIdForIgTarget(target, post.clientId)
        fbCreative = await createAdCreativeFromInstagramPost(adAccountId, objectStoryId, igActorId, fbPageIdForIg, `Boost ${post.name}`, systemToken)

        // IG story-id verification poll: wait for Meta to resolve the media into a Facebook shadow post
        let storyId = await getCreativeStoryId(fbCreative.id, systemToken)
        let storyAttempts = 0
        while (!storyId && storyAttempts < igStoryPoll.maxTries) {
          await new Promise(resolve => setTimeout(resolve, igStoryPoll.intervalMs))
          storyId = await getCreativeStoryId(fbCreative.id, systemToken)
          storyAttempts++
        }
        if (!storyId) {
          const nextAttempts = (Number(jobPayload.storyAttempts) || 0) + 1
          if (nextAttempts >= igStoryPoll.maxRequeues) {
            try { await deleteAdCreative(fbCreative.id, systemToken) } catch {}
            await repo.deletePostBoostTargetsByTargetId(target.id)
            for (const obj of createdObjects) {
              try {
                if (obj.type === 'facebook_campaign') await deleteAdCampaign(obj.id, systemToken)
                else if (obj.type === 'ad_set') await deleteAdSet(obj.id, systemToken)
              } catch {}
            }
            return { success: false, error: `Instagram post ${rawObjectStoryId} not ready for boosting — Meta is still indexing the media. Retry in a few minutes (attempt ${nextAttempts}/${igStoryPoll.maxRequeues})` }
          }
          try { await deleteAdCreative(fbCreative.id, systemToken) } catch {}
          await repo.deletePostBoostTargetsByTargetId(target.id)
          for (const obj of createdObjects) {
            try {
              if (obj.type === 'facebook_campaign') await deleteAdCampaign(obj.id, systemToken)
              else if (obj.type === 'ad_set') await deleteAdSet(obj.id, systemToken)
            } catch {}
          }
          await logMetaEvent({ action: 'post_boost_story_pending', postId: post.id, targetId: target.id, error: `effective_object_story_id not yet available for ${fbCreative.id} — requeueing (${nextAttempts}/${igStoryPoll.maxRequeues})` })
          return { requeueAfterSeconds: igStoryPoll.requeueSeconds, attempts: { ...jobPayload, storyAttempts: nextAttempts } }
        }
        // storyId now available — use it as the effective object story id going forward
        objectStoryId = storyId
      } else {
        fbCreative = await createAdCreativeFromPost(adAccountId, objectStoryId, `Boost ${post.name}`, systemToken)
      }
    } catch (err) {
      if (isInvalidPostIdError(err)) {
        const d = extractMetaError(err)
        const hardMsg = d?.userMsg || err.message
        await logMetaEvent({ postId: post.id, targetId: target.id, action: 'create_creative_hard_fail', error: `object_story_id ${objectStoryId} not promotable: ${hardMsg}` })
        throw new ValidationError(`${hardMsg} — This post can't be boosted. Help Center https://www.facebook.com/business/help/1575107409431290`)
      }
      throw err
    }
    if (target.platformCode !== 'instagram') {
      createdObjects.push({ type: 'ad_creative', id: fbCreative.id, postId: post.id, targetId: target.id })
      await repo.createPostBoostTarget(post.id, target.id, { platformAccountId: target.platformAccountId, objectType: 'ad_creative', objectId: fbCreative.id, status: null, boostStatus: 'pending', createdForUserId: post.clientId })
    } else {
      // Instagram: still persist the creative and add to createdObjects
      createdObjects.push({ type: 'ad_creative', id: fbCreative.id, postId: post.id, targetId: target.id })
      await repo.createPostBoostTarget(post.id, target.id, { platformAccountId: target.platformAccountId, objectType: 'ad_creative', objectId: fbCreative.id, status: null, boostStatus: 'pending', createdForUserId: post.clientId })
    }

    const adValidationError = await validateStep('validate_ad', () =>
      createAd(adAccountId, fbAdSet.id, fbCreative.id, `Boost ${post.name}`, systemToken, 'PAUSED', {}, true)
    )
    if (adValidationError) {
      const isUnpromotable = adValidationError.includes("can't be promoted") || adValidationError.includes("Page post can't be used") || adValidationError.includes("This post can't be boosted")
      const hardMsg = isUnpromotable ? `${adValidationError} — This post can't be boosted. Help Center https://www.facebook.com/business/help/1575107409431290` : adValidationError
      await repo.deletePostBoostTargetsByTargetId(target.id)
      return { success: false, error: hardMsg }
    }

    const t3 = Date.now()
    let fbAd
    try {
      fbAd = await createAd(adAccountId, fbAdSet.id, fbCreative.id, `Boost ${post.name}`, systemToken, 'PAUSED')
    } catch (adErr) {
      if (isUnpromotableAdError(adErr)) {
        const d = extractMetaError(adErr)
        const hardMsg = d?.userMsg || adErr.message
        await repo.deletePostBoostTargetsByTargetId(target.id)
        return { success: false, error: `${hardMsg} — This post can't be boosted. Help Center https://www.facebook.com/business/help/1575107409431290` }
      }
      throw adErr
    }
    createdObjects.push({ type: 'ad', id: fbAd.id, postId: post.id, targetId: target.id })
    await repo.createPostBoostTarget(post.id, target.id, { platformAccountId: target.platformAccountId, objectType: 'ad', objectId: fbAd.id, status: 'PAUSED', boostStatus: 'pending', createdForUserId: post.clientId })

    await logMetaEvent({ action: 'post_boost_created', postId: post.id, targetId: target.id, objects: createdObjects.length })
    return { success: true, objects: createdObjects }
   
   }
    catch (error) {
    const detail = extractMetaError(error)
    const message = detail?.userMsg || error.message
    console.error('[postBoost] create error stack', error.stack)
    await logMetaEvent({ action: 'post_boost_create', postId: post.id, targetId: target.id, error: message + ' | stack: ' + String(error.stack).slice(0,500) })
    await repo.deletePostBoostTargetsByTargetId(target.id)
    return { success: false, error: message + ' | ' + String(error.stack).slice(0,200) }
  }
}

export async function queuePostBoosts(postId) {
  const post = await repo.findPostById(postId)
  if (!post || !post.boostEnabled) return { enqueued: 0, skipped: true }
  const targets = await repo.findPostTargetsByPostId(postId)
  const posted = targets.filter(t => t.status === POST_TARGET_STATUS.POSTED && t.metaObjectId)
  if (!posted.length) return { enqueued: 0, skipped: true }
  let enqueued = 0
  let skippedIneligible = 0
  for (const t of posted) {
    if (t.platformCode !== 'facebook' && t.platformCode !== 'instagram') {
      skippedIneligible += 1
      await repo.updatePost(post.id, { boostError: `Posts on ${t.platformCode} cannot be boosted (target ${t.id})` })
      continue
    }
    if (t.platformCode === 'instagram' && post.type === 'story') {
      skippedIneligible += 1
      await repo.updatePost(post.id, { boostError: `Instagram stories cannot be boosted — only feed posts and reels are supported` })
      continue
    }
    if (t.isEligibleForPromotion === false) {
      skippedIneligible += 1
      await repo.updatePost(post.id, { boostError: `Post ${t.metaObjectId} isn't eligible to be boosted — ${t.eligibilityReason || 'Help Center https://www.facebook.com/business/help/1575107409431290'}` })
      continue
    }
    const existing = await repo.findPostBoostTargetsByTargetId(t.id)
    if (existing.length) continue
    const ok = await enqueueReelJob(POST_JOB_TYPES.BOOST, `post_boost:${t.id}`, { postId, postTargetId: t.id })
    if (ok) enqueued += 1
  }
  return { enqueued, total: posted.length, skippedIneligible }
}

export async function getPublisherDeadlineHours() {
  try {
    const hoursRow = await queryOne('SELECT config_value FROM app_config WHERE config_key = ?', ['publisher_response_deadline_hours'])
    if (hoursRow) {
      const v = typeof hoursRow.config_value === 'string' ? JSON.parse(hoursRow.config_value) : hoursRow.config_value
      const n = Number(v)
      if (Number.isFinite(n) && n >= 1 && n <= 720) return Math.floor(n)
    }
    if (process.env.POST_PUBLISHER_DEADLINE_HOURS) {
      const n = Number(process.env.POST_PUBLISHER_DEADLINE_HOURS)
      if (Number.isFinite(n) && n >= 1 && n <= 720) return Math.floor(n)
    }
    const daysRow = await queryOne('SELECT config_value FROM app_config WHERE config_key = ?', ['publisher_response_deadline_days'])
    if (daysRow) {
      const v = typeof daysRow.config_value === 'string' ? JSON.parse(daysRow.config_value) : daysRow.config_value
      const n = Number(v)
      if (Number.isFinite(n) && n >= 1) return Math.floor(n * 24)
    }
    return 48
  } catch { return 48 }
}

export async function effectivePublisherDeadline(scheduledAt) {
  const hours = await getPublisherDeadlineHours()
  const now = Date.now()
  const deadlineMs = now + hours * 3600 * 1000
  if (scheduledAt) {
    const schedMs = new Date(scheduledAt).getTime()
    if (Number.isFinite(schedMs) && schedMs > now) return new Date(Math.min(deadlineMs, schedMs))
  }
  return new Date(deadlineMs)
}

export const postMediaProbe = {
  enabled: process.env.NODE_ENV !== 'test' && process.env.POST_MEDIA_PROBE !== '0',
  timeoutMs: Number(process.env.POST_MEDIA_PROBE_TIMEOUT_MS) || 10000,
  maxBytes: Number(process.env.POST_MEDIA_MAX_BODY_BYTES) || 2 * 1024 * 1024,
}

async function probeBytesWithFfprobe(bytes, timeoutMs) {
  const dir = await mkdtemp(join(tmpdir(), 'flowx-probe-'))
  const file = join(dir, `media-${randomBytes(4).toString('hex')}.bin`)
  try {
    await writeFile(file, bytes)
    return await probeWithFfprobe(file, { timeoutMs })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function probeSingleMedia(urlString) {
  const report = { contentType: null, size: 'UNKNOWN_SIZE', sizeBytes: null, probe: null }
  if (!isPublicHttpUrl(urlString)) return report
  try {
    const host = await resolveMediaHost(urlString)
    if (host.blocked.length) {
      return { ...report, blocked: true, blockedReason: host.blocked.join(', ') }
    }
    const size = await inspectMediaSize(urlString, { timeoutMs: postMediaProbe.timeoutMs })
    const fetched = await fetchBoundedBytes(urlString, {
      timeoutMs: postMediaProbe.timeoutMs,
      maxBytes: postMediaProbe.maxBytes,
    })
    if (fetched.truncated) {
      return {
        contentType: fetched.contentType,
        size: size?.status || 'UNKNOWN_SIZE',
        sizeBytes: size?.sizeBytes ?? null,
        probe: null,
      }
    }
    let probe
    if (process.env.POST_MEDIA_PROBE_FFPROBE === '1') {
      probe = await probeBytesWithFfprobe(fetched.bytes, postMediaProbe.timeoutMs)
    } else {
      probe = probeMedia(fetched.bytes)
    }
    return {
      contentType: fetched.contentType || size?.contentType || null,
      size: size?.status || 'KNOWN_VALID',
      sizeBytes: size?.sizeBytes ?? fetched.bytes.length,
      probe,
    }
  } catch (err) {
    if (err?.code === 'MEDIA_SSRF_BLOCKED' || err?.code === 'MEDIA_URL_INVALID') {
      return { ...report, blocked: true, blockedReason: err.message }
    }
    return { ...report, error: err?.message || String(err) }
  }
}

async function probeMediaForTargets(post, targets) {
  if (!post.mediaUrl) return {}
  const report = await probeSingleMedia(post.mediaUrl)
  const mediaByTarget = {}
  for (const target of targets) {
    if (target && target.id != null) mediaByTarget[target.id] = { ...report }
  }
  return mediaByTarget
}

function partitionMediaErrorIds(post, targets, mediaByTarget) {
  try {
    validatePostContent({ post, targets, mode: 'publish', mediaByTarget })
    return { ids: new Set(), message: null }
  } catch (err) {
    if (!(err instanceof PostValidationError)) return { ids: new Set(), message: null }
    const issues = err.issues.filter(i => i.severity === 'error' && i.target != null)
    const first = issues[0]
    return {
      ids: new Set(issues.map(i => i.target)),
      message: first ? `${first.code}: ${first.message}` : null,
    }
  }
}

function assertValidTransition(current, next) {
  const allowed = VALID_TRANSITIONS[current]
  if (!allowed || !allowed.includes(next)) {
    throw new ValidationError(`Cannot transition from '${current}' to '${next}'`)
  }
}

function isImageUrl(url) {
  return /\.(png|jpe?g|webp|gif|heic)(\?.*)?$/i.test(url || '')
}

function isVideoUrl(url) {
  return /\.(mp4|mov|webm)(\?.*)?$/i.test(url || '')
}

async function sniffMediaType(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal })
    if (!res.ok) return null
    return res.headers.get('content-type') || null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function mediaIsVideoForTarget(post, target, mediaByTarget) {
  const report = mediaByTarget?.[target.id]
  if (report?.probe?.kind != null) return report.probe.kind === 'video'
  if (report?.contentType) return String(report.contentType).startsWith('video/')
  if (isVideoUrl(post.mediaUrl)) return true
  return false
}

export const igContainerPoll = { intervalMs: 5000, timeoutMs: 150000 }

async function waitForContainer(containerId, accessToken) {
  const deadline = Date.now() + igContainerPoll.timeoutMs
  while (Date.now() < deadline) {
    const status = await getContainerStatus(containerId, accessToken)
    if (status.status_code === 'FINISHED' || status.status_code === 'PUBLISHED') return status
    if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
      const detail =
        status.status?.error?.message ||
        status.status?.error ||
        status.status?.message ||
        `Container status: ${status.status_code}`
      throw new Error(`Instagram media container failed: ${detail}`)
    }
    await new Promise(resolve => setTimeout(resolve, igContainerPoll.intervalMs))
  }
  throw new Error('Timed out waiting for Instagram media container to be ready')
}

async function publishToFacebookPage(target, message, mediaUrl, postType) {
  const pageId = target.platformUserId

  if (postType === 'reel') {
    throw new ValidationError('Facebook reels are published via the durable reel job pipeline')
  }

  if (postType === 'story') {
    if (!mediaUrl) throw new ValidationError('Facebook stories require media')
    let isVideo = isVideoUrl(mediaUrl)
    if (!isVideo && !isImageUrl(mediaUrl)) {
      const contentType = await sniffMediaType(mediaUrl)
      if (contentType && contentType.startsWith('video/')) isVideo = true
    }
    if (isVideo) {
      const data = await createPageVideoStory(pageId, target.accessToken, { url: mediaUrl })
      return data.id
    }
    const data = await createPagePhotoStory(pageId, target.accessToken, { url: mediaUrl })
    return data.id
  }

  if (mediaUrl && isImageUrl(mediaUrl)) {
    const data = await createPagePhotoPost(pageId, target.accessToken, { url: mediaUrl, message })
    return data.id
  }
  if (mediaUrl && isVideoUrl(mediaUrl)) {
    const data = await createPageVideoPost(pageId, target.accessToken, { url: mediaUrl, message })
    if (data.videoId) target._remoteVideoId = data.videoId
    return data.id
  }
  if (mediaUrl) {
    const contentType = await sniffMediaType(mediaUrl)
    if (contentType && contentType.startsWith('image/')) {
      const data = await createPagePhotoPost(pageId, target.accessToken, { url: mediaUrl, message })
      return data.id
    }
    if (contentType && contentType.startsWith('video/')) {
      const data = await createPageVideoPost(pageId, target.accessToken, { url: mediaUrl, message })
      if (data.videoId) target._remoteVideoId = data.videoId
      return data.id
    }
  }
  const data = await createFeedPost(pageId, message, mediaUrl || null, null, target.accessToken)
  return data.id
}

async function cleanupOrphanOnPublishFailure(containerId, accessToken) {
  try {
    await deleteInstagramContainer(containerId, accessToken)
  } catch {
    // best-effort cleanup — never mask the original error
  }
}async function publishContainer(igId, containerId, accessToken) {
  try {
    const data = await publishInstagramMedia(igId, containerId, accessToken)
    return data.id || containerId
  } catch (err) {
    await cleanupOrphanOnPublishFailure(containerId, accessToken)
    throw err
  }
}

async function publishToInstagram(target, message, postType, mediaUrl) {
  const igId = target.igBusinessAccountId || target.platformUserId
  if (!igId) {
    throw new ValidationError('Instagram business account id is missing for target account')
  }
  if (postType === 'story') {
    if (!mediaUrl) throw new ValidationError('Instagram stories require media')
    let isVideo = isVideoUrl(mediaUrl)
    if (!isVideo && !isImageUrl(mediaUrl)) {
      const contentType = await sniffMediaType(mediaUrl)
      if (contentType && contentType.startsWith('video/')) isVideo = true
    }
    const container = await createInstagramStory(igId, mediaUrl, target.accessToken, {
      videoUrl: isVideo ? mediaUrl : undefined,
    })
    if (isVideo) {
      try {
        await waitForContainer(container.id, target.accessToken)
      } catch (err) {
        await cleanupOrphanOnPublishFailure(container.id, target.accessToken)
        throw err
      }
    }
    return publishContainer(igId, container.id, target.accessToken)
  }
  if (!mediaUrl) {
    throw new ValidationError('Instagram posts require media')
  }
  let isVideo = isVideoUrl(mediaUrl)
  if (postType === 'reel' && !isVideo) {
    const contentType = await sniffMediaType(mediaUrl)
    if (!contentType || !contentType.startsWith('video/')) {
      throw new ValidationError('Reels require a video media URL')
    }
    isVideo = true
  } else if (postType === 'post' && !isVideo && !isImageUrl(mediaUrl)) {
    const contentType = await sniffMediaType(mediaUrl)
    if (contentType && contentType.startsWith('video/')) isVideo = true
  }
  const container = await createInstagramMedia(igId, mediaUrl, message, target.accessToken, {
    mediaType: isVideo ? 'REELS' : 'IMAGE',
    videoUrl: isVideo ? mediaUrl : undefined,
  })
  if (isVideo) {
    try {
      await waitForContainer(container.id, target.accessToken)
    } catch (err) {
      await cleanupOrphanOnPublishFailure(container.id, target.accessToken)
      throw err
    }
  }
  return publishContainer(igId, container.id, target.accessToken)
}

export async function createPost(userId, data) {
  validatePublisherConfig(data)
  validateBoostConfig(data)
  const boostCost = data.boostEnabled ? calculatePostBoostCost(data) : 0

  if (boostCost > 0) {
    const coinRate = await getCoinConversionRate()
    const coinService = await import('../../../shared/services/coin.service.js')
    const available = await coinService.getAvailable(userId)
    if (available.total < boostCost) {
      throw new ValidationError('Insufficient coins for boost')
    }
    const { accountDbId } = await resolveAccountContext()
    const chargedBoostPaise = Math.round(boostCost * coinRate * 100)

    return transaction(async () => {
      const id = generateUuid()
      const { targetAccountIds, ...postData } = data
      await repo.createPost(id, userId, { ...postData, adAccountId: accountDbId, chargedBoostPaise })
      const spendResult = await coinService.spend(userId, boostCost, 'post_boost', id, `Post boost: ${data.name}`)
      await repo.insertPostBillingEntry(id, {
        kind: 'charge',
        paise: chargedBoostPaise,
        coins: boostCost,
        rate: coinRate,
        paidFromMonthly: spendResult?.fromMonthly || 0,
        paidFromWallet: spendResult?.fromWallet || boostCost,
        reason: `Post boost: ${data.name}`,
      })
      if (targetAccountIds && targetAccountIds.length > 0) {
        await setPostTargets(userId, id, targetAccountIds)
      }
      return repo.findPostById(id)
    })
  }

  const id = generateUuid()
  const { targetAccountIds, ...postData } = data
  const post = await repo.createPost(id, userId, postData)
  if (targetAccountIds && targetAccountIds.length > 0) {
    await setPostTargets(userId, id, targetAccountIds)
  }
  return repo.findPostById(id)
}

function validatePublisherConfig(data) {
  if (data.runOnPublishers) {
    if (!data.categoryId) throw new ValidationError('Publisher posts require a category')
    if (!data.publisherCount || data.publisherCount < 1) {
      throw new ValidationError('Publisher posts require a publisher count of at least 1')
    }
    if (!data.coinsPerPublisher || Number(data.coinsPerPublisher) <= 0) {
      throw new ValidationError('Publisher posts require coins per publisher greater than zero')
    }
  } else if (data.publisherCount || data.coinsPerPublisher) {
    throw new ValidationError('Publisher count and coins per publisher require runOnPublishers to be enabled')
  }
}

function toPublicTarget(target) {
  if (!target) return target
  const { accessToken, remoteUploadUrl, ...rest } = target
  return rest
}

export async function getPost(userId, postId, isAdmin = false) {
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')

  if (!isAdmin && post.clientId !== userId) {
    throw new ForbiddenError('You do not have access to this post')
  }

  const [targets, reviewLog] = await Promise.all([
    repo.findPostTargetsByPostId(postId),
    repo.findReviewLogsByPostId(postId),
  ])

  return { ...post, targets: targets.map(toPublicTarget), reviewLog }
}

export async function listPosts(userId, query) {
  return repo.findPostsByClientId(userId, query)
}

export async function listAllPosts(query) {
  return repo.findAllPosts(query)
}

export async function getPostDetail(postId) {
  return getPost(null, postId, true)
}

export async function updatePost(userId, postId, data) {
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')
  if (post.clientId !== userId) throw new ForbiddenError('Not your post')

  if (data.boostEnabled !== undefined || data.boostBudgetAmount !== undefined || data.boostBudgetType !== undefined || data.boostSpendCap !== undefined || data.boostEndTime !== undefined || data.boostObjective !== undefined || data.boostBidStrategy !== undefined || data.boostOptimizationGoal !== undefined || data.boostTargeting !== undefined || data.boostPlacement !== undefined || data.boostCallToAction !== undefined || data.boostLink !== undefined || data.boostHeadline !== undefined || data.boostDescription !== undefined || data.promotableId !== undefined || data.isEligibleForPromotion !== undefined) {
    throw new ValidationError('Boost can only be set at creation')
  }

  const blockedStatuses = [
    POST_STATUS.APPROVED,
    POST_STATUS.SCHEDULED,
    POST_STATUS.RUNNING,
    POST_STATUS.COMPLETED,
    POST_STATUS.CANCELLED,
    POST_STATUS.AWAITING_PUBLISHERS,
  ]
  if (blockedStatuses.includes(post.status)) {
    throw new ValidationError('Cannot edit post in its current status')
  }

  validatePublisherConfig({ ...post, ...data })

  const { targetAccountIds, ...postData } = data

  if (post.status !== POST_STATUS.DRAFT) {
    await repo.updatePostWithStatusGuard(postId, { ...postData, status: POST_STATUS.DRAFT }, post.status)
  } else {
    await repo.updatePost(postId, postData)
  }

  if (targetAccountIds && targetAccountIds.length > 0) {
    await setPostTargets(userId, postId, targetAccountIds)
  }

  return repo.findPostById(postId)
}

export async function submitPost(userId, postId) {
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')
  if (post.clientId !== userId) throw new ForbiddenError('Not your post')
  assertValidTransition(post.status, POST_STATUS.PENDING_REVIEW)

  if (!post.caption && !post.mediaUrl && !post.textBody) {
    throw new ValidationError('Post must have at least a caption, media or text before submitting for review')
  }

  const targets = await repo.findPostTargetsByPostId(postId)
  const clientTargets = targets.filter(t => t.targetType === POST_TARGET_TYPES.CLIENT)
  if (!post.runOnPublishers && clientTargets.length === 0) {
    throw new ValidationError('Select at least one target account before submitting for review')
  }

  validatePostContent({ post, targets: clientTargets.length ? clientTargets : targets, mode: 'submit' })

  const updated = await repo.updatePostWithStatusGuard(postId, { status: POST_STATUS.PENDING_REVIEW }, post.status)
  await repo.createReviewLog(postId, userId, REVIEW_ACTIONS.SUBMITTED, post.status, null)
  return updated
}

export async function cancelPost(userId, postId) {
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')
  if (post.clientId !== userId) throw new ForbiddenError('Not your post')
  assertValidTransition(post.status, POST_STATUS.CANCELLED)

  if (post.status === POST_STATUS.AWAITING_PUBLISHERS && post.escrowAmount > 0) {
    await refundPostEscrow(post, post.escrowAmount, `Refund: post cancelled while awaiting publishers`)
    const pending = await repo.findPostPublisherRequestsByStatus(postId, PUBLISHER_REQUEST_STATUS.PENDING)
    for (const p of pending) {
      await repo.updatePostPublisherRequestStatusWithGuard(
        p.id,
        PUBLISHER_REQUEST_STATUS.CANCELLED,
        new Date().toISOString().slice(0, 19).replace('T', ' '),
        PUBLISHER_REQUEST_STATUS.PENDING
      )
    }
  }

  if (post.boostEnabled && post.chargedBoostPaise > 0) {
    try {
      const coinService = await import('../../../shared/services/coin.service.js')
      const coinRate = await getCoinConversionRate()
      const refundCoins = Math.round(post.chargedBoostPaise / (coinRate * 100))
      if (refundCoins > 0) {
        await coinService.refundWithDetail(post.clientId, refundCoins, 'post_boost', post.id, `Refund: post cancelled — boost refund for "${post.name}"`, { fromMonthly: 0, fromWallet: refundCoins })
        await repo.insertPostBillingEntry(post.id, { kind: 'refund', paise: post.chargedBoostPaise, coins: refundCoins, rate: coinRate, paidFromMonthly: 0, paidFromWallet: refundCoins, reason: 'Boost refund on cancel' })
      }
    } catch {}
  }

  const updated = await repo.updatePostWithStatusGuard(postId, { status: POST_STATUS.CANCELLED }, post.status)
  await repo.createReviewLog(postId, userId, REVIEW_ACTIONS.CANCELLED, post.status, null)
  return updated
}

export async function duplicatePost(userId, postId, data) {
  if (!(await isPostDuplicateEnabled())) {
    throw new ForbiddenError('Duplicate is temporarily disabled')
  }
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')
  if (post.clientId !== userId) throw new ForbiddenError('Not your post')

  const newId = generateUuid()
  await repo.createPost(newId, userId, {
    name: data.name || `${post.name} (Copy)`,
    type: post.type,
    categoryId: post.categoryId,
    scheduledAt: null,
    runOnPublishers: post.runOnPublishers,
    publisherCount: post.publisherCount,
    coinsPerPublisher: post.coinsPerPublisher,
    caption: post.caption,
    mediaUrl: post.mediaUrl,
    hashtags: post.hashtags,
    textBody: post.textBody,
  })

  const targets = await repo.findPostTargetsByPostId(postId)
  const clientAccountIds = targets.filter(t => t.targetType === POST_TARGET_TYPES.CLIENT).map(t => t.platformAccountId)
  if (clientAccountIds.length > 0) {
    await repo.replacePostTargets(newId, POST_TARGET_TYPES.CLIENT, clientAccountIds)
  }

  return repo.findPostById(newId)
}

export async function setPostTargets(userId, postId, targetAccountIds) {
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')
  if (post.clientId !== userId) throw new ForbiddenError('Not your post')
  if (!Array.isArray(targetAccountIds)) {
    throw new ValidationError('Invalid target account IDs')
  }

  const owned = await repo.findPostAccountsForUser(userId)
  const ownedIds = new Set(owned.map(a => a.id))
  for (const accountId of targetAccountIds) {
    if (!ownedIds.has(accountId)) {
      throw new ValidationError(`Account ${accountId} is not connected to your account`)
    }
  }

  await repo.replacePostTargets(postId, POST_TARGET_TYPES.CLIENT, targetAccountIds)
  const targets = await repo.findPostTargetsByPostId(postId)
  return targets.map(toPublicTarget)
}

export async function getAvailablePostAccounts(userId) {
  return repo.findPostAccountsForUser(userId)
}

export async function approvePost(adminId, postId, data) {
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')
  if (post.status !== POST_STATUS.PENDING_REVIEW) {
    throw new ValidationError('Post must be in pending review status')
  }

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

  if (post.runOnPublishers) {
    if (!post.categoryId || !post.publisherCount || !post.coinsPerPublisher) {
      throw new ValidationError('Publisher posts require a category, publisher count and coins per publisher')
    }
    const { total } = calculatePublisherEscrow(post)
    const coinService = await import('../../../shared/services/coin.service.js')
    const split = await coinService.spend(post.clientId, total, 'post_publisher_escrow', postId,
      `Publisher escrow for "${post.name}"`)

    const effectiveDeadline = await effectivePublisherDeadline(post.scheduledAt)
    const updated = await repo.updatePostWithStatusGuard(postId, {
      status: POST_STATUS.AWAITING_PUBLISHERS,
      escrowAmount: total,
      escrowFromMonthly: split.fromMonthly || 0,
      escrowFromWallet: split.fromWallet || 0,
      coinsEscrowedAt: now,
      reviewedBy: adminId,
      reviewedAt: now,
      reviewNotes: data.notes || null,
      adminNotes: data.notes || null,
      publisherResponseDeadlineAt: effectiveDeadline,
    }, POST_STATUS.PENDING_REVIEW)
    await repo.createReviewLog(postId, adminId, REVIEW_ACTIONS.APPROVED, POST_STATUS.PENDING_REVIEW, data.notes || null)

    await createPostPublisherRequests(postId)

    return { ...updated, awaitingPublishers: true }
  }

  const targets = await repo.findPostTargetsByPostId(postId)
  const clientTargets = targets.filter(t => t.targetType === POST_TARGET_TYPES.CLIENT)
  if (clientTargets.length === 0) {
    throw new ValidationError('Post has no target accounts — client must select targets first')
  }

  const scheduledAt = post.scheduledAt ? new Date(post.scheduledAt) : null
  const isFutureSchedule = scheduledAt && scheduledAt.getTime() > Date.now()
  const afterApproveStatus = isFutureSchedule ? POST_STATUS.SCHEDULED : POST_STATUS.APPROVED

  const updated = await repo.updatePostWithStatusGuard(postId, {
    status: afterApproveStatus,
    reviewedBy: adminId,
    reviewedAt: now,
    reviewNotes: data.notes || null,
    adminNotes: data.notes || null,
  }, POST_STATUS.PENDING_REVIEW)
  await repo.createReviewLog(postId, adminId, REVIEW_ACTIONS.APPROVED, POST_STATUS.PENDING_REVIEW, data.notes || null)

  const queuedJob = await queuePostPublish(postId, isFutureSchedule ? post.scheduledAt : null)
  return { ...updated, queued: true, jobId: queuedJob.jobId }
}

export async function rejectPost(adminId, postId, data) {
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')
  if (post.status !== POST_STATUS.PENDING_REVIEW) {
    throw new ValidationError('Post must be in pending review status')
  }

  const updated = await repo.updatePostWithStatusGuard(postId, {
    status: POST_STATUS.REJECTED,
    reviewedBy: adminId,
    reviewedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    reviewNotes: data.notes || 'Rejected',
  }, POST_STATUS.PENDING_REVIEW)
  await repo.createReviewLog(postId, adminId, REVIEW_ACTIONS.REJECTED, post.status, data.notes || null)
  return updated
}

export async function queuePostPublish(postId, runAfter = null) {
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')
  if (![POST_STATUS.APPROVED, POST_STATUS.SCHEDULED, POST_STATUS.RUNNING, POST_STATUS.FAILED].includes(post.status)) {
    throw new ValidationError('Post is not publishable in its current status')
  }

  const jobId = generateUuid()
  const enqueued = await enqueueJob(jobId, postId, POST_JOB_TYPES.PUBLISH, null, {}, {
    runAfter: runAfter ? new Date(runAfter) : null,
    entityType: 'post',
  })
  return { jobId, enqueued }
}

export async function retryPostPublish(postId) {
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')
  if (![POST_STATUS.RUNNING, POST_STATUS.FAILED].includes(post.status)) {
    throw new ValidationError('Post can only be retried when failed or partially published')
  }

  const targets = await repo.findPostTargetsByPostId(postId)
  for (const target of targets) {
    if (target.status !== POST_TARGET_STATUS.POSTED) {
      await repo.resetPostTargetForRetry(target.id)
    }
  }

  const queuedJob = await queuePostPublish(postId)
  return { queued: true, jobId: queuedJob.jobId }
}

function calculatePublisherEscrow(post) {
  const publisherCost = (post.publisherCount || 0) * (post.coinsPerPublisher || 0)
  const platformFee = Math.round(publisherCost * 0.1)
  return { publisherCost, platformFee, total: publisherCost + platformFee }
}

async function refundPostEscrow(post, refundAmount, note) {
  if (!refundAmount || refundAmount <= 0) return
  const coinService = await import('../../../shared/services/coin.service.js')
  const total = Number(post.escrowAmount) || 0
  if (total <= 0) {
    await coinService.refund(post.clientId, refundAmount, 'post_publisher_escrow', post.id, note)
    return
  }
  const ratio = Math.min(1, refundAmount / total)
  const fromWallet = Math.min(Number(post.escrowFromWallet) || 0, Math.round(ratio * (Number(post.escrowFromWallet) || 0)))
  const fromMonthly = refundAmount - fromWallet
  await coinService.refundWithDetail(post.clientId, refundAmount, 'post_publisher_escrow', post.id, note, { fromMonthly, fromWallet })
}

export function buildContentSnapshot(post) {
  return {
    name: post.name,
    type: post.type,
    caption: post.caption || null,
    mediaUrl: post.mediaUrl || null,
    hashtags: post.hashtags || null,
    textBody: post.textBody || null,
    scheduledAt: post.scheduledAt || null,
  }
}

function snapshotHash(snapshot) {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}

export async function createPostPublisherRequests(postId) {
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')
  if (!post.runOnPublishers || !post.categoryId) return { created: [] }

  const targetCount = post.publisherCount || 0
  if (targetCount <= 0) return { created: [] }
  const multiplier = Number(process.env.POST_PUBLISHER_REQUEST_MULTIPLIER) || 2
  const limit = Math.max(targetCount, targetCount * multiplier)

  const publishers = await repo.findEligiblePublishersForPost({ categoryId: post.categoryId, limit })
  const eligible = publishers.filter(p => p.publisherId !== post.clientId)
  const selected = eligible.slice(0, limit)
  if (selected.length === 0) return { created: [] }

  const expiresAt = await effectivePublisherDeadline(post.scheduledAt)
  const snapshot = buildContentSnapshot(post)
  const hash = snapshotHash(snapshot)

  const created = await repo.createPostPublisherRequests(
    postId,
    selected.map(p => p.publisherId),
    post.coinsPerPublisher,
    { expiresAt, snapshot: JSON.stringify(snapshot), snapshotHash: hash }
  )

  const { createAndSend } = await import('../notifications/notifications.service.js')
  for (const item of created) {
    const pub = selected.find(p => p.publisherId === item.publisherId)
    if (!pub) continue
    try {
      await createAndSend(
        item.publisherId,
        'new_post_request',
        'New Post Request',
        `New post request: "${post.name}" — ${post.coinsPerPublisher.toLocaleString()} coins`,
        { postId, postName: post.name, coinsOffered: post.coinsPerPublisher, requestId: item.requestId },
        pub.email,
        pub.firstName,
      )
    } catch (err) {
      console.warn(`[posts] Failed to notify publisher ${item.publisherId}: ${err.message}`)
    }
  }

  return { created, expiresAt }
}

export async function listPostPublisherRequests(publisherId, query) {
  return repo.findPostPublisherRequestsByPublisherId(publisherId, query)
}

export async function getPostPublisherRequestDetail(publisherId, requestId) {
  const request = await repo.findPostPublisherRequestById(requestId)
  if (!request) throw new NotFoundError('Request not found')
  if (request.publisherId !== publisherId) throw new ForbiddenError('Not your request')
  const post = await repo.findPostById(request.postId)
  const accounts = await repo.findVerifiedPublisherAccounts(publisherId)
  return {
    ...request,
    post: post ? {
      id: post.id,
      name: post.name,
      type: post.type,
      caption: post.caption,
      mediaUrl: post.mediaUrl,
      hashtags: post.hashtags,
      textBody: post.textBody,
    } : null,
    availableAccounts: accounts.map(a => ({
      id: a.id,
      platformCode: a.platformCode,
      platformDisplayName: a.platformDisplayName,
      platformUsername: a.platformUsername,
    })),
  }
}

export async function getPostPublisherProgress(userId, postId) {
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')
  if (post.clientId !== userId) throw new ForbiddenError('Not your post')

  const requests = await repo.findPostPublisherRequestsByPostId(postId)
  const accepted = requests.filter(r => r.status === PUBLISHER_REQUEST_STATUS.ACCEPTED).length
  return {
    requested: post.publisherCount || 0,
    accepted,
    pending: requests.filter(r => r.status === PUBLISHER_REQUEST_STATUS.PENDING).length,
    rejected: requests.filter(r => r.status === PUBLISHER_REQUEST_STATUS.REJECTED).length,
    failed: requests.filter(r => r.status === PUBLISHER_REQUEST_STATUS.FAILED).length,
    published: requests.filter(r => r.status === PUBLISHER_REQUEST_STATUS.PUBLISHED).length,
    completed: requests.filter(r => r.status === PUBLISHER_REQUEST_STATUS.COMPLETED).length,
    deadlineAt: post.publisherResponseDeadlineAt,
    escrowAmount: post.escrowAmount,
    requests,
  }
}

async function getPublisherMaxAccounts() {
  try {
    const row = await queryOne('SELECT config_value FROM app_config WHERE config_key = ?', ['publisher_max_accounts_per_request'])
    if (!row) return 5
    const v = typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value
    const n = Number(v)
    if (!Number.isFinite(n) || n < 1 || n > 10) return 5
    return Math.floor(n)
  } catch { return 5 }
}

export async function acceptPostPublisherRequest(publisherId, requestId, { platformAccountIds, platformAccountId } = {}) {
  const request = await repo.findPostPublisherRequestById(requestId)
  if (!request) throw new NotFoundError('Request not found')
  if (request.publisherId !== publisherId) throw new ForbiddenError('Not your request')
  if (request.status !== PUBLISHER_REQUEST_STATUS.PENDING) {
    throw new ValidationError('Request is no longer pending')
  }

  let ids = platformAccountIds
  if (!ids || !ids.length) {
    if (platformAccountId) ids = [platformAccountId]
  }
  if (!ids || !ids.length) {
    throw new ValidationError('Select at least one verified account to publish on')
  }
  ids = [...new Set(ids.map(String))]
  const cap = await getPublisherMaxAccounts()
  if (ids.length > cap) {
    throw new ValidationError(`Select up to ${cap} accounts`)
  }
  const accounts = await repo.findVerifiedPublisherAccounts(publisherId)
  const allowed = new Set(accounts.map(a => a.id))
  for (const id of ids) {
    if (!allowed.has(id)) throw new ValidationError('Selected account is not a verified account you own')
  }

  const post = await repo.findPostById(request.postId)
  if (!post) throw new NotFoundError('Post not found')

  return transaction(async () => {
    await repo.lockPostById(post.id)
    const acceptedCount = await repo.countPostPublisherRequestsByStatus(post.id, PUBLISHER_REQUEST_STATUS.ACCEPTED)
    if (acceptedCount >= (post.publisherCount || Infinity)) {
      throw new ValidationError('Publisher capacity reached for this post')
    }

    await repo.updatePostPublisherRequest(requestId, { platformAccountIds: ids })
    await repo.updatePostPublisherRequestStatusWithGuard(
      requestId,
      PUBLISHER_REQUEST_STATUS.ACCEPTED,
      new Date().toISOString().slice(0, 19).replace('T', ' '),
      PUBLISHER_REQUEST_STATUS.PENDING
    )

    const newAccepted = await repo.countPostPublisherRequestsByStatus(post.id, PUBLISHER_REQUEST_STATUS.ACCEPTED)
    if (newAccepted >= (post.publisherCount || Infinity)) {
      const pending = await repo.findPostPublisherRequestsByStatus(post.id, PUBLISHER_REQUEST_STATUS.PENDING)
      for (const p of pending) {
        await repo.updatePostPublisherRequestStatusWithGuard(
          p.id,
          PUBLISHER_REQUEST_STATUS.CANCELLED,
          new Date().toISOString().slice(0, 19).replace('T', ' '),
          PUBLISHER_REQUEST_STATUS.PENDING
        )
      }
      await enqueueCampaignJob(generateUuid(), request.postId, POST_JOB_TYPES.PUBLISHER_GO_LIVE, null, {}, {
        runKey: `post:go-live:${request.postId}`,
        entityType: 'post',
      })
    }

    return repo.findPostPublisherRequestById(requestId)
  })
}

export async function rejectPostPublisherRequest(publisherId, requestId) {
  const request = await repo.findPostPublisherRequestById(requestId)
  if (!request) throw new NotFoundError('Request not found')
  if (request.publisherId !== publisherId) throw new ForbiddenError('Not your request')
  if (request.status !== PUBLISHER_REQUEST_STATUS.PENDING) {
    throw new ValidationError('Request is no longer pending')
  }
  await repo.updatePostPublisherRequestStatusWithGuard(
    requestId,
    PUBLISHER_REQUEST_STATUS.REJECTED,
    new Date().toISOString().slice(0, 19).replace('T', ' '),
    PUBLISHER_REQUEST_STATUS.PENDING
  )
  return repo.findPostPublisherRequestById(requestId)
}

export async function completePostPublisherRequest(publisherId, requestId) {
  const request = await repo.findPostPublisherRequestById(requestId)
  if (!request) throw new NotFoundError('Request not found')
  if (request.publisherId !== publisherId) throw new ForbiddenError('Not your request')
  if (request.status !== PUBLISHER_REQUEST_STATUS.PUBLISHED) {
    throw new ValidationError(`Cannot complete request with status '${request.status}' — must be 'published'`)
  }

  const post = await repo.findPostById(request.postId)
  if (!post) throw new NotFoundError('Post not found')

  await transaction(async () => {
    await repo.lockPostById(post.id)
    await repo.updatePostPublisherRequestStatusWithGuard(
      requestId,
      PUBLISHER_REQUEST_STATUS.COMPLETED,
      new Date().toISOString().slice(0, 19).replace('T', ' '),
      PUBLISHER_REQUEST_STATUS.PUBLISHED
    )
    const { addCoins, createTransaction } = await import('../ai/ai.repository.js')
    await addCoins(request.publisherId, request.coinsOffered)
    await createTransaction(generateUuid(), request.publisherId, `Post payout: ${post.name}`, request.coinsOffered, 'credit', 'post', request.postId)
    await repo.updatePostPublisherRequest(requestId, {
      payoutStatus: 'paid',
      payoutTransactionId: generateUuid(),
    })
  })

  return repo.findPostPublisherRequestById(requestId)
}

export async function goLiveForFilledPost(postId) {
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')
  if (post.status !== POST_STATUS.AWAITING_PUBLISHERS) {
    throw new ValidationError('Post must be in awaiting_publishers status')
  }

  const scheduledAtRaw = post.scheduledAt
  const scheduledAt = scheduledAtRaw ? new Date(scheduledAtRaw) : null
  const isFutureSchedule = scheduledAt && scheduledAt.getTime() > Date.now()

  await transaction(async () => {
    await repo.lockPostById(postId)
    const accepted = await repo.findAcceptedPostPublisherRequests(postId)
    if (accepted.length === 0) {
      throw new ValidationError('No accepted publisher slots to go live')
    }

    for (const ar of accepted) {
      const ids = ar.platformAccountIds?.length ? ar.platformAccountIds : (ar.platformAccountId ? [ar.platformAccountId] : [])
      for (const accountId of [...new Set(ids)]) {
        if (!accountId) continue
        await repo.createPublisherTarget(postId, ar.id, accountId)
      }
    }

    const afterStatus = isFutureSchedule ? POST_STATUS.SCHEDULED : POST_STATUS.RUNNING
    await repo.updatePostWithStatusGuard(postId, { status: afterStatus }, POST_STATUS.AWAITING_PUBLISHERS)
    await repo.createReviewLog(postId, null, REVIEW_ACTIONS.SUBMITTED, POST_STATUS.AWAITING_PUBLISHERS,
      `Publisher slots filled — post ${afterStatus === POST_STATUS.RUNNING ? 'is now running' : 'scheduled'}`)
  })

  await queuePostPublish(postId, isFutureSchedule ? scheduledAtRaw : null)
  return repo.findPostById(postId)
}

export async function expirePublisherPosts(postIds) {
  const results = []
  for (const postId of postIds) {
    try {
      const post = await repo.findPostById(postId)
      if (!post || post.status !== POST_STATUS.AWAITING_PUBLISHERS) continue

      const accepted = await repo.findAcceptedPostPublisherRequests(postId)
      const pending = await repo.findPostPublisherRequestsByStatus(postId, PUBLISHER_REQUEST_STATUS.PENDING)

      if (accepted.length > 0) {
        await transaction(async () => {
          await repo.lockPostById(postId)
          for (const p of pending) {
            await repo.updatePostPublisherRequestStatusWithGuard(
              p.id,
              PUBLISHER_REQUEST_STATUS.CANCELLED,
              new Date().toISOString().slice(0, 19).replace('T', ' '),
              PUBLISHER_REQUEST_STATUS.PENDING
            )
          }
          const unfilled = Math.max(0, (post.publisherCount || 0) - accepted.length)
          if (unfilled > 0 && post.coinsPerPublisher) {
            const refundAmount = unfilled * post.coinsPerPublisher
            await refundPostEscrow(post, refundAmount,
              `Refund: ${unfilled} unfilled publisher slot(s) after deadline for ${post.name}`)
          }
          await repo.createReviewLog(postId, null, REVIEW_ACTIONS.SUBMITTED, POST_STATUS.AWAITING_PUBLISHERS,
            `Publisher deadline passed — publishing to ${accepted.length} accepted publisher(s)`)
        })
        await enqueueCampaignJob(generateUuid(), postId, POST_JOB_TYPES.PUBLISHER_GO_LIVE, null, {}, {
          runKey: `post:go-live:${postId}`,
          entityType: 'post',
        })
        results.push({ postId, success: true, mode: 'partial-go-live', accepted: accepted.length })
      } else {
        await transaction(async () => {
          await repo.lockPostById(postId)
          for (const p of pending) {
            await repo.updatePostPublisherRequestStatusWithGuard(
              p.id,
              PUBLISHER_REQUEST_STATUS.CANCELLED,
              new Date().toISOString().slice(0, 19).replace('T', ' '),
              PUBLISHER_REQUEST_STATUS.PENDING
            )
          }
          if (post.escrowAmount > 0) {
            await refundPostEscrow(post, post.escrowAmount,
              `Refund: publisher deadline passed with no accepted publishers for ${post.name}`)
          }
          await repo.updatePostWithStatusGuard(postId, {
            status: POST_STATUS.FAILED,
            error: `Publisher response deadline passed — no publishers accepted`,
          }, POST_STATUS.AWAITING_PUBLISHERS)
          await repo.createReviewLog(postId, null, REVIEW_ACTIONS.SUBMITTED, POST_STATUS.AWAITING_PUBLISHERS,
            'Publisher response deadline passed — no publishers accepted')
        })
        results.push({ postId, success: true, mode: 'no-acceptance', accepted: 0 })
      }
    } catch (err) {
      results.push({ postId, success: false, error: err.message })
    }
  }
  return results
}

export async function handleExpiredPublisherPosts() {
  const postIds = await repo.findExpiredPublisherPosts()
  if (postIds.length === 0) return { processed: 0, results: [] }
  const results = await expirePublisherPosts(postIds)
  return { processed: postIds.length, results }
}

export async function adminListPostPublisherRequests(postId) {
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')
  const requests = await repo.findPostPublisherRequestsByPostId(postId)
  return {
    requested: post.publisherCount || 0,
    escrowAmount: post.escrowAmount,
    deadlineAt: post.publisherResponseDeadlineAt,
    requests,
  }
}

export async function adminForceGoLivePost(postId) {
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')
  if (![POST_STATUS.AWAITING_PUBLISHERS, POST_STATUS.APPROVED].includes(post.status)) {
    throw new ValidationError('Post must be awaiting publishers or approved to force go-live')
  }

  await transaction(async () => {
    await repo.lockPostById(postId)
    const current = await repo.findPostById(postId)
    if (current.status === POST_STATUS.AWAITING_PUBLISHERS) {
      const pending = await repo.findPostPublisherRequestsByStatus(postId, PUBLISHER_REQUEST_STATUS.PENDING)
      for (const p of pending) {
        await repo.updatePostPublisherRequestStatusWithGuard(
          p.id,
          PUBLISHER_REQUEST_STATUS.CANCELLED,
          new Date().toISOString().slice(0, 19).replace('T', ' '),
          PUBLISHER_REQUEST_STATUS.PENDING
        )
      }
    }
  })

  const accepted = await repo.findAcceptedPostPublisherRequests(postId)
  if (accepted.length === 0 && !post.runOnPublishers) {
    return queuePostPublish(postId)
  }
  if (accepted.length === 0 && post.runOnPublishers) {
    throw new ValidationError('Cannot force go-live — no accepted publisher slots')
  }
  await enqueueCampaignJob(generateUuid(), postId, POST_JOB_TYPES.PUBLISHER_GO_LIVE, null, {}, {
    runKey: `post:go-live:${postId}`,
    entityType: 'post',
  })
  return { queued: true }
}

export async function adminExpirePostPublisherRequests(postId) {
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')
  if (post.status !== POST_STATUS.AWAITING_PUBLISHERS) {
    throw new ValidationError('Post must be awaiting publishers to expire requests')
  }
  const results = await expirePublisherPosts([postId])
  return results[0]
}

export async function markPostJobFailed(postId, message) {
  try {
    const post = await repo.findPostById(postId)
    if (!post) return
    if ([POST_STATUS.APPROVED, POST_STATUS.SCHEDULED].includes(post.status)) {
      await repo.updatePostWithStatusGuard(postId, { status: POST_STATUS.FAILED, error: message }, post.status)
      await repo.createReviewLog(postId, null, REVIEW_ACTIONS.SUBMITTED, post.status, `Publish job failed: ${message}`)
    }
  } catch {
    // best-effort — never let failure marking crash the worker
  }
}

async function setPublishState(targetId, state, extras = {}) {
  await repo.updatePostTargetStatus(targetId, {
    publishState: state,
    publishStateChangedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    ...extras,
  })
}

async function syncPublisherRequestOnPost(target) {
  if (target.targetType !== POST_TARGET_TYPES.PUBLISHER || !target.publisherRequestId) return
  try {
    const request = await repo.findPostPublisherRequestById(target.publisherRequestId)
    if (!request) return
    if (target.status === POST_TARGET_STATUS.POSTED && request.status === PUBLISHER_REQUEST_STATUS.ACCEPTED) {
      await repo.updatePostPublisherRequestPublishedWithGuard(target.publisherRequestId, PUBLISHER_REQUEST_STATUS.ACCEPTED)
    } else if (target.status === POST_TARGET_STATUS.FAILED && [PUBLISHER_REQUEST_STATUS.ACCEPTED, PUBLISHER_REQUEST_STATUS.PUBLISHED].includes(request.status)) {
      await repo.updatePostPublisherRequestStatusWithGuard(
        target.publisherRequestId,
        PUBLISHER_REQUEST_STATUS.FAILED,
        new Date().toISOString().slice(0, 19).replace('T', ' '),
        request.status
      )
    }
  } catch (err) {
    console.warn(`[posts] Failed to sync publisher request ${target.publisherRequestId}: ${err.message}`)
  }
}

const IG_VERIFY_WINDOW_MS = 5 * 60 * 1000
const IG_VERIFY_RETRY_CAP = Number(process.env.POST_IG_RETRY_CAP) || 2

async function verifyInstagramPublication(target, message, postType, mediaUrl, retryIfNoMatch = true) {
  const candidate = { message: message || '', mediaUrl: mediaUrl || '' }
  const recent = await getInstagramMedia(target.igBusinessAccountId || target.platformUserId, target.accessToken, 25)
  const matches = []
  for (const media of Array.isArray(recent) ? recent : []) {
    const created = media.timestamp ? new Date(media.timestamp).getTime() : null
    if (created && Math.abs(Date.now() - created) > IG_VERIFY_WINDOW_MS) continue
    const actualCaption = `${media.caption || ''}`
    const wantedCaption = candidate.message.trim()
    const captionMatch = wantedCaption.length > 0 && actualCaption.trim() === wantedCaption
    const typeMatch = postType === 'reel'
      ? media.media_type === 'VIDEO' || media.media_type === 'REELS'
      : postType === 'story'
        ? media.media_type === 'VIDEO' || media.media_type === 'STORIES'
        : media.media_type !== 'VIDEO'
    const score = postType === 'story'
      ? (typeMatch ? 2 : 0) + (captionMatch ? 1 : 0)
      : (captionMatch ? 2 : 0) + (typeMatch ? 1 : 0)
    matches.push({ media, captionMatch, typeMatch, score })
  }
  const high = matches.filter(m => m.score >= 2)
  if (high.length === 1) {
    return { status: 'published', objectId: high[0].media.id, permalink: high[0].media.permalink }
  }
  if (high.length > 1) {
    return { status: 'manual_review' }
  }
  return { status: 'no_match' }
}

export async function verifyPostJob(postId) {
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')

  const targets = await repo.findPostTargetsWithPublishState(postId, POST_TARGET_PUBLISH_STATE.UNKNOWN)
  if (targets.length === 0) return { status: 'no_pending' }

  const message = buildPostMessage(post)
  const results = []
  for (const target of targets) {
    let attempted = false
    try {
      const result = await verifyInstagramPublication(target, message, post.type, post.mediaUrl, true)
      attempted = true
      if (result.status === 'published') {
        await repo.updatePostTargetStatus(target.id, {
          status: POST_TARGET_STATUS.POSTED,
          error: null,
          publishState: POST_TARGET_PUBLISH_STATE.PUBLISHED,
          metaObjectId: result.objectId,
          postedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
        })
        results.push({ targetId: target.id, status: 'published' })
      } else if (result.status === 'manual_review') {
        await setPublishState(target.id, POST_TARGET_PUBLISH_STATE.MANUAL_REVIEW)
        results.push({ targetId: target.id, status: 'manual_review' })
      } else {
        const attempts = (target.verificationAttempts || 0) + 1
        if (attempts >= IG_VERIFY_RETRY_CAP) {
          await setPublishState(target.id, POST_TARGET_PUBLISH_STATE.MANUAL_REVIEW, {
            verificationAttempts: attempts,
            lastVerifyAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
          })
          results.push({ targetId: target.id, status: 'manual_review', attempts })
        } else {
          await setPublishState(target.id, POST_TARGET_PUBLISH_STATE.RETRY_PENDING, {
            verificationAttempts: attempts,
            lastVerifyAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
          })
          await repo.requeueAutoJob(postId, POST_JOB_TYPES.PUBLISH, {}, { entityType: 'post' })
          results.push({ targetId: target.id, status: 'retry_pending', attempts })
        }
      }
    } catch (err) {
      const detail = err?.message || String(err)
      await repo.updatePostTargetStatus(target.id, {
        status: POST_TARGET_STATUS.FAILED,
        error: detail,
        publishState: POST_TARGET_PUBLISH_STATE.RETRYABLE_FAILURE,
      })
      results.push({ targetId: target.id, status: 'error', error: detail })
    }
  }
  return { status: 'processed', results }
}

async function classifyPublishError(err) {
  if (err instanceof ValidationError) return { kind: 'permanent' }
  if (err?.metaHttpStatus == null) {
    return { kind: err?.metaAmbiguous ? 'ambiguous' : 'retryable' }
  }
  if (err.metaHttpStatus >= 400 && err.metaHttpStatus < 500 && err.metaHttpStatus !== 429 && !err?.metaAmbiguous) {
    return { kind: 'permanent' }
  }
  return { kind: err?.metaAmbiguous ? 'ambiguous' : 'retryable' }
}

export const fbReelState = {
  backoffSteps: [5, 15, 30, 60, 120, 300],
  processingBackoffMs: [15000, 30000, 60000, 90000, 120000],
  verifyBackoffSeconds: Number(process.env.POST_FB_REEL_VERIFY_BACKOFF_SECONDS) || 60,
  processingCapMs: Number(process.env.POST_FB_REEL_PROCESSING_CAP_MS) || 30 * 60 * 1000,
}
const FB_REEL_VERIFY_CAP = Number(process.env.POST_FB_REEL_VERIFY_CAP) || 3

const REEL_IN_FLIGHT_STATES = [
  POST_TARGET_PUBLISH_STATE.NONE,
  POST_TARGET_PUBLISH_STATE.UPLOAD_STARTED,
  POST_TARGET_PUBLISH_STATE.UPLOADING,
  POST_TARGET_PUBLISH_STATE.RETRYABLE_FAILURE,
  POST_TARGET_PUBLISH_STATE.RETRY_PENDING,
  POST_TARGET_PUBLISH_STATE.UPLOADED,
  POST_TARGET_PUBLISH_STATE.PROCESSING,
  POST_TARGET_PUBLISH_STATE.READY,
  POST_TARGET_PUBLISH_STATE.VERIFYING,
  POST_TARGET_PUBLISH_STATE.UNKNOWN,
]

function backoffForStep(step) {
  const steps = fbReelState.backoffSteps
  return steps[Math.min(Math.max(0, Math.floor(step)), steps.length - 1)]
}

function backoffForProcessing(elapsedMs) {
  const steps = fbReelState.processingBackoffMs
  for (const [i, step] of steps.entries()) {
    if (elapsedMs < step) return (i + 1) * 15
  }
  return 120
}

function nowString() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
}

function statusDetail(status) {
  if (Array.isArray(status?.status_errors)) {
    return status.status_errors.map(e => e?.message || e).join('; ')
  }
  return status?.status_errors?.message || status?.status_errors || null
}

export async function refreshPostStatus(postId) {
  const post = await repo.findPostById(postId)
  if (!post) return null
  if ([POST_STATUS.COMPLETED, POST_STATUS.CANCELLED, POST_STATUS.FAILED].includes(post.status)) return post
  const targets = await repo.findPostTargetsByPostId(postId)
  const actionable = targets.filter(t => t.status !== POST_TARGET_STATUS.POSTED)
  const posted = targets.filter(t => t.status === POST_TARGET_STATUS.POSTED).length
  const failed = actionable.filter(t => t.status === POST_TARGET_STATUS.FAILED).length
  const pending = actionable.length - failed
  const allPosted = targets.length > 0 && actionable.length === 0
  const allFailed = targets.length > 0 && pending === 0 && posted === 0 && failed > 0
  if (allFailed) {
    const firstFailure = actionable.find(t => t.status === POST_TARGET_STATUS.FAILED)
    const message = firstFailure?.error || 'Post publishing failed for all targets'
    await repo.updatePostWithStatusGuard(postId, {
      status: POST_STATUS.FAILED,
      error: message,
    }, post.status)
    await repo.createReviewLog(postId, null, REVIEW_ACTIONS.SUBMITTED, post.status, `Post failed on all targets: ${message}`)
  } else if (allPosted && post.status !== POST_STATUS.COMPLETED) {
    await repo.updatePostWithStatusGuard(postId, {
      status: POST_STATUS.COMPLETED,
      publishedAt: nowString(),
      error: null,
    }, post.status)
    await repo.createReviewLog(postId, null, REVIEW_ACTIONS.SUBMITTED, post.status, 'Post published to all targets')
    if (post.boostEnabled) {
      try { await queuePostBoosts(postId) } catch {}
    }
  } else if (!allPosted && [POST_STATUS.APPROVED, POST_STATUS.SCHEDULED].includes(post.status)) {
    await repo.updatePostWithStatusGuard(postId, { status: POST_STATUS.RUNNING }, post.status)
  }
  return repo.findPostById(postId)
}

async function reelPublished(target, postId) {
  const ok = await repo.transitionPostTargetState(target.id, ['ready', 'verifying', 'unknown'], POST_TARGET_PUBLISH_STATE.PUBLISHED, {
    status: POST_TARGET_STATUS.POSTED,
    metaObjectId: postId,
    postedAt: nowString(),
    error: null,
    lastMetaStatus: 'published',
    lastOperation: 'published',
    lastOperationAt: nowString(),
  })
  if (!ok) return { requeueAfterSeconds: 30 }
  if (String(postId).includes('_')) {
    try {
      const post = await repo.findPostById(target.postId)
      if (post?.boostEnabled && target.platformCode === 'facebook') {
        await capturePostPromotability(target, postId)
      }
    } catch {}
  }
  await syncPublisherRequestOnPost({ ...target, status: POST_TARGET_STATUS.POSTED })
  await refreshPostStatus(target.postId)
  return { done: true }
}

async function reelManualReview(target, message, step) {
  await repo.transitionPostTargetState(target.id, ['ready', 'verifying', 'unknown'], POST_TARGET_PUBLISH_STATE.MANUAL_REVIEW, {
    status: POST_TARGET_STATUS.FAILED,
    error: message,
    lastOperation: step,
    lastOperationAt: nowString(),
  })
  await syncPublisherRequestOnPost({ ...target, status: POST_TARGET_STATUS.FAILED })
  await refreshPostStatus(target.postId)
  return { done: true }
}

async function reelPermanent(target, message, step) {
  await repo.transitionPostTargetState(target.id, REEL_IN_FLIGHT_STATES, POST_TARGET_PUBLISH_STATE.PERMANENT_FAILURE, {
    status: POST_TARGET_STATUS.FAILED,
    error: message,
    lastOperation: step,
    lastOperationAt: nowString(),
  })
  await syncPublisherRequestOnPost({ ...target, status: POST_TARGET_STATUS.FAILED })
  await refreshPostStatus(target.postId)
  return { done: true }
}

async function reelFailure(target, err, step, attempts) {
  const { kind } = await classifyPublishError(err)
  const message = err?.message || String(err)
  if (kind === 'permanent') {
    await repo.transitionPostTargetState(target.id, REEL_IN_FLIGHT_STATES, POST_TARGET_PUBLISH_STATE.PERMANENT_FAILURE, {
      status: POST_TARGET_STATUS.FAILED,
      error: message,
      lastOperation: step,
      lastOperationAt: nowString(),
    })
    await syncPublisherRequestOnPost({ ...target, status: POST_TARGET_STATUS.FAILED })
    await refreshPostStatus(target.postId)
    return { done: true }
  }
  if (kind === 'ambiguous') {
    const attemptCount = (target.verificationAttempts || 0) + 1
    await repo.transitionPostTargetState(target.id, REEL_IN_FLIGHT_STATES, POST_TARGET_PUBLISH_STATE.UNKNOWN, {
      status: POST_TARGET_STATUS.FAILED,
      error: message,
      verificationAttempts: attemptCount,
      unknownSince: nowString(),
      lastOperation: step,
      lastOperationAt: nowString(),
    })
    await refreshPostStatus(target.postId)
    return { requeueAfterSeconds: fbReelState.verifyBackoffSeconds, attempts: 0 }
  }
  await repo.transitionPostTargetState(target.id, REEL_IN_FLIGHT_STATES, POST_TARGET_PUBLISH_STATE.RETRYABLE_FAILURE, {
    status: POST_TARGET_STATUS.FAILED,
    error: message,
    lastOperation: step,
    lastOperationAt: nowString(),
  })
  await refreshPostStatus(target.postId)
  return { requeueAfterSeconds: backoffForStep(attempts + 1), attempts: attempts + 1 }
}

async function probeUploadStatus(target, accessToken) {
  let status
  try {
    status = await getPageReelStatus(target.remoteVideoId, accessToken)
  } catch (err) {
    const { kind } = await classifyPublishError(err)
    return kind === 'permanent' ? 'error' : 'ambiguous'
  }
  if (!status) return 'ambiguous'
  if (status.video_status === 'error') return 'error'
  if (status.video_status === 'ready' || status.video_status === 'upload_complete') return 'uploaded'
  if (status.uploading_phase?.status === 'finished' || status.uploading_phase?.status === 'complete') return 'uploaded'
  if (status.processing_phase?.status === 'processing_finished' || status.processing_phase?.status === 'finished') return 'uploaded'
  return 'not_uploaded'
}

async function fbReelAllocate(post, target, pageId, accessToken, attempts) {
  if (!post.mediaUrl) return reelPermanent(target, 'Facebook reels require a video media URL', 'allocate')
  let started
  try {
    started = await startPageReel(pageId, accessToken)
  } catch (err) {
    return reelFailure(target, err, 'start', attempts)
  }
  const ok = await repo.transitionPostTargetState(target.id, [POST_TARGET_PUBLISH_STATE.NONE], POST_TARGET_PUBLISH_STATE.UPLOADING, {
    error: null,
    remoteVideoId: started.video_id,
    remoteUploadUrl: started.upload_url,
    lastMetaStatus: 'session_allocated',
    lastOperation: 'start',
    lastOperationAt: nowString(),
  })
  if (!ok) return { requeueAfterSeconds: 15, attempts: 0 }
  return fbReelUpload(post, {
    ...target,
    publishState: POST_TARGET_PUBLISH_STATE.UPLOADING,
    remoteVideoId: started.video_id,
    remoteUploadUrl: started.upload_url,
    skipProbe: true,
  }, pageId, accessToken, attempts)
}

async function fbReelUpload(post, target, pageId, accessToken, attempts) {
  const mediaUrl = post.mediaUrl
  if (!mediaUrl) return reelPermanent(target, 'Facebook reels require a video media URL', 'upload')

  if (target.remoteVideoId && !target.skipProbe) {
    const probed = await probeUploadStatus(target, accessToken)
    if (probed === 'error') {
      return reelPermanent(target, 'Facebook video upload failed', 'upload_probe')
    }
    if (probed === 'ambiguous') {
      const err = new Error('Facebook video upload status is unreachable (ambiguous)')
      err.metaAmbiguous = true
      return reelFailure(target, err, 'upload_probe', attempts)
    }
    if (probed === 'uploaded') {
      const ok = await repo.transitionPostTargetState(target.id, REEL_IN_FLIGHT_STATES, POST_TARGET_PUBLISH_STATE.UPLOADED, {
        error: null,
        lastMetaStatus: 'uploaded',
        lastOperation: 'upload_probe',
        lastOperationAt: nowString(),
      })
      if (!ok) return { requeueAfterSeconds: 15, attempts: 0 }
      return { requeueAfterSeconds: fbReelState.backoffSteps[0], attempts: 0 }
    }
  }

  let uploadUrl = target.remoteUploadUrl
  let videoId = target.remoteVideoId
  if (!uploadUrl || !videoId) {
    let started
    try {
      started = await startPageReel(pageId, accessToken)
    } catch (err) {
      return reelFailure(target, err, 'start', attempts)
    }
    uploadUrl = started.upload_url
    videoId = started.video_id
    const ok = await repo.transitionPostTargetState(target.id, REEL_IN_FLIGHT_STATES, POST_TARGET_PUBLISH_STATE.UPLOADING, {
      error: null,
      remoteVideoId: videoId,
      remoteUploadUrl: uploadUrl,
      lastMetaStatus: 'session_allocated',
      lastOperation: 'start',
      lastOperationAt: nowString(),
    })
    if (!ok) return { requeueAfterSeconds: 15, attempts: 0 }
  }

  try {
    await uploadPageReelMedia(uploadUrl, mediaUrl, accessToken)
  } catch (err) {
    return reelFailure(target, err, 'upload', attempts)
  }

  const ok = await repo.transitionPostTargetState(target.id, REEL_IN_FLIGHT_STATES, POST_TARGET_PUBLISH_STATE.UPLOADED, {
    error: null,
    lastMetaStatus: 'uploaded',
    lastOperation: 'upload',
    lastOperationAt: nowString(),
  })
  if (!ok) return { requeueAfterSeconds: 15, attempts: 0 }
  return { requeueAfterSeconds: fbReelState.backoffSteps[0], attempts: 0 }
}

async function fbReelStatusCheck(post, target, pageId, accessToken, attempts) {
  if (!target.remoteVideoId) return reelFailure(target, new Error('Facebook reel remote video id is missing'), 'status', attempts)
  let status
  try {
    status = await getPageReelStatus(target.remoteVideoId, accessToken)
  } catch (err) {
    return reelFailure(target, err, 'status', attempts)
  }
  const videoStatus = status?.video_status
  if (videoStatus === 'error') {
    return reelPermanent(target, statusDetail(status) || 'Facebook video processing failed', 'status')
  }
  const processing = status?.processing_phase
  const uploading = status?.uploading_phase
  const uploadComplete = videoStatus === 'upload_complete' ||
    uploading?.status === 'complete' ||
    uploading?.status === 'finished'
  const processingDone = videoStatus === 'ready' ||
    processing?.status === 'processing_finished' ||
    processing?.status === 'finished'
  if (processingDone || uploadComplete) {
    const ok = await repo.transitionPostTargetState(target.id, [POST_TARGET_PUBLISH_STATE.UPLOADED, POST_TARGET_PUBLISH_STATE.PROCESSING], POST_TARGET_PUBLISH_STATE.READY, {
      error: null,
      lastMetaStatus: uploadComplete && !processingDone ? 'upload_complete' : 'ready',
      lastOperation: 'status',
      lastOperationAt: nowString(),
    })
    if (!ok) return { requeueAfterSeconds: 15, attempts: 0 }
    return { requeueAfterSeconds: fbReelState.backoffSteps[0], attempts: 0 }
  }
  const startedAt = target.processingStartedAt || target.publishStateChangedAt
  const elapsedMs = startedAt ? Date.now() - new Date(startedAt).getTime() : 0
  if (elapsedMs >= fbReelState.processingCapMs) {
    const err = new Error('Timed out waiting for Facebook to process the reel')
    err.metaAmbiguous = true
    return reelFailure(target, err, 'processing_cap', attempts)
  }
  const ok = await repo.transitionPostTargetState(target.id, [POST_TARGET_PUBLISH_STATE.UPLOADED, POST_TARGET_PUBLISH_STATE.PROCESSING], POST_TARGET_PUBLISH_STATE.PROCESSING, {
    error: null,
    processingStartedAt: target.processingStartedAt || nowString(),
    lastMetaStatus: 'processing',
    lastOperation: 'status',
    lastOperationAt: nowString(),
  })
  if (!ok) return { requeueAfterSeconds: 15, attempts: 0 }
  return { requeueAfterSeconds: backoffForProcessing(elapsedMs), attempts: 0 }
}

async function fbReelFinish(post, target, pageId, accessToken, attempts) {
  if (!target.remoteVideoId) return reelFailure(target, new Error('Facebook reel remote video id is missing'), 'finish', attempts)
  let finished
  try {
    finished = await finishPageReel(pageId, accessToken, {
      videoId: target.remoteVideoId,
      description: buildPostMessage(post),
    })
  } catch (err) {
    return reelFailure(target, err, 'finish', attempts)
  }
  const publishedId = (finished?.post_id ? qualifyFbPostId(pageId, finished.post_id) : null) || finished?.video_id || null
  if (publishedId) return reelPublished(target, publishedId)
  const ok = await repo.transitionPostTargetState(target.id, [POST_TARGET_PUBLISH_STATE.READY], POST_TARGET_PUBLISH_STATE.VERIFYING, {
    error: null,
    lastMetaStatus: 'finish_accepted',
    lastOperation: 'finish',
    lastOperationAt: nowString(),
  })
  if (!ok) return { requeueAfterSeconds: 15, attempts: 0 }
  return { requeueAfterSeconds: fbReelState.backoffSteps[0], attempts: 0 }
}

async function fbReelVerify(post, target, pageId, accessToken, attempts) {
  if (!target.remoteVideoId) return reelManualReview(target, 'Facebook reel remote video id is missing', 'verify')
  let status
  try {
    status = await getPageReelStatus(target.remoteVideoId, accessToken)
  } catch (err) {
    return reelFailure(target, err, 'verify', attempts)
  }
  if (status?.video_status === 'error' || status?.publishing_phase?.publish_status === 'error') {
    return reelPermanent(target, statusDetail(status) || 'Facebook reel publishing failed', 'verify')
  }
  if (status?.publishing_phase?.publish_status === 'published') {
    let resolved
    try {
      resolved = await resolvePageReelPostId(pageId, accessToken, {
        message: buildPostMessage(post),
        since: new Date(target.publishStateChangedAt || target.createdAt).getTime(),
      })
    } catch (err) {
      return reelFailure(target, err, 'verify_resolve', attempts)
    }
    if (resolved?.postId) return reelPublished(target, resolved.postId)
    if (resolved?.ambiguous) return reelManualReview(target, 'multiple matching reels found during verification', 'verify_resolve')
  }
  const uploading = status?.uploading_phase
  const processing = status?.processing_phase
  const uploadComplete = uploading?.status === 'finished' || uploading?.status === 'complete' || status?.video_status === 'upload_complete'
  const uploadIncomplete = !uploadComplete && !uploading?.status
  const processingDone = processing?.status === 'processing_finished' || processing?.status === 'finished' || status?.video_status === 'ready'
  const finishNeverRan = uploadComplete && processing?.status === 'not_started' && status?.publishing_phase?.publish_status === 'not_started'
  if (uploadIncomplete) {
    return fbReelUpload(post, target, pageId, accessToken, attempts)
  }
  if (finishNeverRan) {
    return fbReelFinish(post, target, pageId, accessToken, attempts)
  }
  if (processingDone) {
    return fbReelFinish(post, target, pageId, accessToken, attempts)
  }
  const attemptCount = (target.verificationAttempts || 0) + 1
  if (attemptCount >= FB_REEL_VERIFY_CAP) {
    return reelManualReview(target, 'reel did not confirm published after repeated verification', 'verify')
  }
  const ok = await repo.transitionPostTargetState(target.id, [POST_TARGET_PUBLISH_STATE.VERIFYING, POST_TARGET_PUBLISH_STATE.UNKNOWN], POST_TARGET_PUBLISH_STATE.VERIFYING, {
    error: null,
    verificationAttempts: attemptCount,
    lastVerifyAt: nowString(),
    lastMetaStatus: 'verifying',
    lastOperation: 'verify',
    lastOperationAt: nowString(),
  })
  if (!ok) return { requeueAfterSeconds: fbReelState.verifyBackoffSeconds, attempts: 0 }
  return { requeueAfterSeconds: fbReelState.verifyBackoffSeconds, attempts: 0 }
}

export async function fbReelJob(postId, targetId, payload = {}) {
  if (!postId || !targetId) return { done: true }
  const attempts = Number(payload?.attempts) || 0
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')
  if (post.type !== POST_TYPES.REEL || [POST_STATUS.COMPLETED, POST_STATUS.CANCELLED].includes(post.status)) return { done: true }

  const target = await repo.findPostTargetById(targetId)
  if (!target || target.platformCode !== 'facebook') return { done: true }

  const pageId = target.platformUserId
  const accessToken = target.accessToken
  if (!pageId || !accessToken) return reelPermanent(target, 'Facebook page token is missing for target account', 'setup')

  if (isRateLimited(tokenKeyFor(accessToken))) {
    return { requeueAfterSeconds: 30, attempts: 0 }
  }

  switch (target.publishState) {
    case POST_TARGET_PUBLISH_STATE.NONE:
      return fbReelAllocate(post, target, pageId, accessToken, attempts)
    case POST_TARGET_PUBLISH_STATE.UPLOAD_STARTED:
    case POST_TARGET_PUBLISH_STATE.UPLOADING:
    case POST_TARGET_PUBLISH_STATE.RETRYABLE_FAILURE:
    case POST_TARGET_PUBLISH_STATE.RETRY_PENDING:
      return fbReelUpload(post, target, pageId, accessToken, attempts)
    case POST_TARGET_PUBLISH_STATE.UPLOADED:
    case POST_TARGET_PUBLISH_STATE.PROCESSING:
      return fbReelStatusCheck(post, target, pageId, accessToken, attempts)
    case POST_TARGET_PUBLISH_STATE.READY:
      return fbReelFinish(post, target, pageId, accessToken, attempts)
    case POST_TARGET_PUBLISH_STATE.VERIFYING:
    case POST_TARGET_PUBLISH_STATE.UNKNOWN:
      return fbReelVerify(post, target, pageId, accessToken, attempts)
    default:
      return { done: true }
  }
}

export const igVideoState = {
  pollSeconds: Number(process.env.POST_IG_POLL_SECONDS) || 5,
  processingCapMs: Number(process.env.POST_IG_PROCESSING_CAP_MS) || 30 * 60 * 1000,
  verifyBackoffSeconds: Number(process.env.POST_IG_VERIFY_BACKOFF_SECONDS) || 60,
  backoffSteps: [5, 15, 30, 60, 120, 300],
}

const IG_VIDEO_IN_FLIGHT_STATES = [
  POST_TARGET_PUBLISH_STATE.NONE,
  POST_TARGET_PUBLISH_STATE.UPLOADING,
  POST_TARGET_PUBLISH_STATE.PROCESSING,
  POST_TARGET_PUBLISH_STATE.READY,
  POST_TARGET_PUBLISH_STATE.RETRYABLE_FAILURE,
  POST_TARGET_PUBLISH_STATE.RETRY_PENDING,
  POST_TARGET_PUBLISH_STATE.VERIFYING,
  POST_TARGET_PUBLISH_STATE.UNKNOWN,
]

function igBackoffForStep(step) {
  const steps = igVideoState.backoffSteps
  return steps[Math.min(Math.max(0, Math.floor(step)), steps.length - 1)]
}

function igElapsedMs(target) {
  const startedAt = target.processingStartedAt || target.publishStateChangedAt
  return startedAt ? Date.now() - new Date(startedAt).getTime() : 0
}

async function igCleanupContainer(target) {
  if (!target.containerId || !target.accessToken) return
  try {
    await deleteInstagramContainer(target.containerId, target.accessToken)
  } catch {
    // best-effort cleanup — never mask the original error
  }
  await repo.clearPostTargetContainer(target.id)
}

async function igContainerUnknown(target, message, step) {
  await repo.transitionPostTargetState(target.id, IG_VIDEO_IN_FLIGHT_STATES, POST_TARGET_PUBLISH_STATE.UNKNOWN, {
    status: POST_TARGET_STATUS.FAILED,
    error: message,
    containerId: null,
    unknownSince: nowString(),
    lastOperation: step,
    lastOperationAt: nowString(),
  })
  await refreshPostStatus(target.postId)
  try {
    await repo.requeueAutoJob(target.postId, POST_JOB_TYPES.VERIFY, {}, { entityType: 'post' })
  } catch {
    // verify job already queued or running
  }
  return { done: true }
}

async function igContainerPermanent(target, message, step) {
  await igCleanupContainer(target)
  await repo.transitionPostTargetState(target.id, IG_VIDEO_IN_FLIGHT_STATES, POST_TARGET_PUBLISH_STATE.PERMANENT_FAILURE, {
    status: POST_TARGET_STATUS.FAILED,
    error: message,
    containerId: null,
    lastOperation: step,
    lastOperationAt: nowString(),
  })
  await syncPublisherRequestOnPost({ ...target, status: POST_TARGET_STATUS.FAILED })
  await refreshPostStatus(target.postId)
  return { done: true }
}

async function igContainerFailure(target, err, step, attempts) {
  const { kind } = await classifyPublishError(err)
  const message = err?.message || String(err)
  if (kind === 'permanent') {
    return igContainerPermanent(target, message, step)
  }
  if (kind === 'ambiguous') {
    await igCleanupContainer(target)
    return igContainerUnknown(target, message, step)
  }
  await repo.transitionPostTargetState(target.id, IG_VIDEO_IN_FLIGHT_STATES, POST_TARGET_PUBLISH_STATE.RETRYABLE_FAILURE, {
    status: POST_TARGET_STATUS.FAILED,
    error: message,
    lastOperation: step,
    lastOperationAt: nowString(),
  })
  await refreshPostStatus(target.postId)
  return { requeueAfterSeconds: igBackoffForStep(attempts + 1), attempts: attempts + 1 }
}

async function igContainerPublish(post, target, igId, product, attempts) {
  let published
  try {
    published = await publishInstagramMedia(igId, target.containerId, target.accessToken)
  } catch (err) {
    const detail = extractMetaError(err)
    const notReady = err?.metaErrorCode === 9007 || detail?.code === 9007 || (err?.metaHttpStatus != null && err.metaHttpStatus >= 500)
    if (notReady) {
      await repo.transitionPostTargetState(target.id, IG_VIDEO_IN_FLIGHT_STATES, POST_TARGET_PUBLISH_STATE.PROCESSING, {
        error: err?.message || 'Instagram media container is not ready yet',
        lastOperation: 'publish_wait',
        lastOperationAt: nowString(),
      })
      return { requeueAfterSeconds: igVideoState.pollSeconds, attempts: 0 }
    }
    return igContainerFailure(target, err, 'publish', attempts)
  }
  const ok = await repo.transitionPostTargetState(target.id, IG_VIDEO_IN_FLIGHT_STATES, POST_TARGET_PUBLISH_STATE.PUBLISHED, {
    status: POST_TARGET_STATUS.POSTED,
    metaObjectId: published?.id || target.containerId,
    containerId: null,
    postedAt: nowString(),
    error: null,
    lastMetaStatus: 'published',
    lastOperation: 'published',
    lastOperationAt: nowString(),
  })
  if (!ok) return { requeueAfterSeconds: 15, attempts: 0 }
  await syncPublisherRequestOnPost({ ...target, status: POST_TARGET_STATUS.POSTED })
  await refreshPostStatus(target.postId)
  return { done: true }
}

async function igContainerStatus(post, target, igId, product, attempts) {
  let status
  try {
    status = await getContainerStatus(target.containerId, target.accessToken)
  } catch (err) {
    const detail = extractMetaError(err)
    if (detail?.code === 100) {
      await repo.clearPostTargetContainer(target.id)
      return igContainerCreate(post, { ...target, containerId: null }, igId, product, attempts)
    }
    return igContainerFailure(target, err, 'status', attempts)
  }
  const code = status?.status_code
  if (code === 'ERROR') {
    const detail = status?.status?.error?.message || status?.status?.error || status?.status?.message || 'Instagram media container failed'
    return igContainerPermanent(target, `Instagram media container failed: ${detail}`, 'status')
  }
  if (code === 'EXPIRED') {
    await repo.clearPostTargetContainer(target.id)
    return igContainerCreate(post, { ...target, containerId: null }, igId, product, attempts)
  }
  if (code === 'FINISHED' || code === 'PUBLISHED') {
    const ok = await repo.transitionPostTargetState(target.id, IG_VIDEO_IN_FLIGHT_STATES, POST_TARGET_PUBLISH_STATE.READY, {
      error: null,
      lastMetaStatus: 'container_ready',
      lastOperation: 'status',
      lastOperationAt: nowString(),
    })
    if (!ok) return { requeueAfterSeconds: 15, attempts: 0 }
    return igContainerPublish(post, { ...target, publishState: POST_TARGET_PUBLISH_STATE.READY }, igId, product, attempts)
  }
  if (igElapsedMs(target) >= igVideoState.processingCapMs) {
    const err = new Error('Timed out waiting for Instagram to process the media container')
    err.metaAmbiguous = true
    return igContainerFailure(target, err, 'processing_cap', attempts)
  }
  const ok = await repo.transitionPostTargetState(target.id, IG_VIDEO_IN_FLIGHT_STATES, POST_TARGET_PUBLISH_STATE.PROCESSING, {
    error: null,
    processingStartedAt: target.processingStartedAt || nowString(),
    lastMetaStatus: 'processing',
    lastOperation: 'status',
    lastOperationAt: nowString(),
  })
  if (!ok) return { requeueAfterSeconds: 15, attempts: 0 }
  return { requeueAfterSeconds: igVideoState.pollSeconds, attempts: 0 }
}

async function igContainerCreate(post, target, igId, product, attempts) {
  if (!post.mediaUrl) {
    return igContainerPermanent(target, `Instagram ${product}s require a media URL`, 'create')
  }
  let container
  try {
    if (product === 'story') {
      container = await createInstagramStory(igId, post.mediaUrl, target.accessToken, { videoUrl: post.mediaUrl })
    } else {
      container = await createInstagramMedia(igId, post.mediaUrl, buildPostMessage(post), target.accessToken, {
        mediaType: 'REELS',
        videoUrl: post.mediaUrl,
      })
    }
  } catch (err) {
    return igContainerFailure(target, err, 'create', attempts)
  }
  if (!container?.id) {
    return igContainerPermanent(target, 'Instagram media container creation returned no id', 'create')
  }
  const ok = await repo.transitionPostTargetState(target.id, IG_VIDEO_IN_FLIGHT_STATES, POST_TARGET_PUBLISH_STATE.UPLOADING, {
    error: null,
    containerId: container.id,
    lastMetaStatus: 'container_created',
    lastOperation: 'create',
    lastOperationAt: nowString(),
  })
  if (!ok) {
    await cleanupOrphanOnPublishFailure(container.id, target.accessToken)
    return { requeueAfterSeconds: 15, attempts: 0 }
  }
  return { requeueAfterSeconds: igVideoState.pollSeconds, attempts: 0 }
}

async function igVideoJob(postId, targetId, payload = {}, product = 'reel') {
  if (!postId || !targetId) return { done: true }
  const attempts = Number(payload?.attempts) || 0
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')
  if (![POST_TYPES.REEL, POST_TYPES.STORY].includes(post.type)) return { done: true }

  const target = await repo.findPostTargetById(targetId)
  if (!target || target.platformCode !== 'instagram') return { done: true }

  if ([POST_STATUS.COMPLETED, POST_STATUS.CANCELLED].includes(post.status)) {
    if (target.containerId) await igCleanupContainer(target)
    return { done: true }
  }
  if (target.status === POST_TARGET_STATUS.POSTED) return { done: true }
  if ([POST_TARGET_PUBLISH_STATE.PUBLISHED, POST_TARGET_PUBLISH_STATE.PERMANENT_FAILURE, POST_TARGET_PUBLISH_STATE.MANUAL_REVIEW].includes(target.publishState)) {
    return { done: true }
  }
  if ([POST_TARGET_PUBLISH_STATE.UNKNOWN, POST_TARGET_PUBLISH_STATE.VERIFYING].includes(target.publishState)) {
    return { done: true }
  }

  const igId = target.igBusinessAccountId || target.platformUserId
  const accessToken = target.accessToken
  if (!igId || !accessToken) {
    return igContainerPermanent(target, 'Instagram business account or token is missing for target account', 'setup')
  }

  if (isRateLimited(tokenKeyFor(accessToken))) {
    return { requeueAfterSeconds: 30, attempts: 0 }
  }

  if (target.containerId) {
    if (target.publishState === POST_TARGET_PUBLISH_STATE.READY) {
      return igContainerPublish(post, target, igId, product, attempts)
    }
    return igContainerStatus(post, target, igId, product, attempts)
  }
  return igContainerCreate(post, target, igId, product, attempts)
}

export async function igReelJob(postId, targetId, payload = {}) {
  return igVideoJob(postId, targetId, payload, 'reel')
}

export async function igVideoStoryJob(postId, targetId, payload = {}) {
  return igVideoJob(postId, targetId, payload, 'story')
}

export async function publishPostJob(postId) {
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')

  if ([POST_STATUS.COMPLETED, POST_STATUS.CANCELLED].includes(post.status)) return post
  if (![POST_STATUS.APPROVED, POST_STATUS.SCHEDULED, POST_STATUS.RUNNING, POST_STATUS.FAILED].includes(post.status)) {
    throw new ValidationError(`Post cannot be published in ${post.status} status`)
  }

  if (post.scheduledAt) {
    const schedMs = new Date(post.scheduledAt).getTime()
    if (Number.isFinite(schedMs) && schedMs > Date.now() + 60_000) {
      if (post.status !== POST_STATUS.SCHEDULED) {
        await repo.updatePostWithStatusGuard(postId, { status: POST_STATUS.SCHEDULED }, post.status)
        await repo.createReviewLog(postId, null, REVIEW_ACTIONS.SUBMITTED, post.status, `Post scheduled for ${post.scheduledAt}`)
      }
      const seconds = Math.ceil((schedMs - Date.now()) / 1000)
      return { requeueAfterSeconds: Math.max(seconds, 60), scheduled: true }
    }
  }

  const targets = await repo.findPostTargetsByPostId(postId)
  const actionable = targets.filter(t => t.status !== POST_TARGET_STATUS.POSTED)
  if (actionable.length === 0) {
    if (targets.length === 0) {
      throw new ValidationError('Post has no target accounts to publish to')
    }
    if ([POST_STATUS.APPROVED, POST_STATUS.SCHEDULED].includes(post.status)) {
      await repo.updatePostWithStatusGuard(postId, {
        status: POST_STATUS.COMPLETED,
        publishedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      }, post.status)
      await repo.createReviewLog(postId, null, REVIEW_ACTIONS.SUBMITTED, post.status, 'Post published to all targets')
    }
    return repo.findPostById(postId)
  }

  const message = buildPostMessage(post)
  let successCount = 0
  let firstError = null
  let needsVerify = false
  let jobInFlight = 0

  let mediaErrorIds = new Set()
  let mediaByTarget = {}
  let mediaErrorMessage = null
  if (postMediaProbe.enabled && post.mediaUrl) {
    mediaByTarget = await probeMediaForTargets(post, actionable)
    const partition = partitionMediaErrorIds(post, actionable, mediaByTarget)
    mediaErrorIds = partition.ids
    mediaErrorMessage = partition.message
  }

  const isFbReelTarget = t => t.platformCode === 'facebook' && post.type === POST_TYPES.REEL
  const isIgVideoTarget = t => t.platformCode === 'instagram' && (
    post.type === POST_TYPES.REEL ||
    (post.type === POST_TYPES.STORY && mediaIsVideoForTarget(post, t, mediaByTarget))
  )
  const jobTargets = actionable.filter(t => isFbReelTarget(t) || isIgVideoTarget(t))
  const directTargets = actionable.filter(t => !isFbReelTarget(t) && !isIgVideoTarget(t))

  const mediaError = mediaErrorMessage || 'Media failed publish-mode validation'

  for (const target of jobTargets) {
    if (mediaErrorIds.has(target.id)) {
      await repo.updatePostTargetStatus(target.id, {
        status: POST_TARGET_STATUS.FAILED,
        error: mediaError,
        publishState: POST_TARGET_PUBLISH_STATE.PERMANENT_FAILURE,
      })
      if (!firstError) firstError = mediaError
      continue
    }
    if (target.publishState === POST_TARGET_PUBLISH_STATE.PERMANENT_FAILURE) continue
    if (target.publishState === POST_TARGET_PUBLISH_STATE.PUBLISHED) continue
    const isIg = target.platformCode === 'instagram'
    const jobType = isIg
      ? (post.type === POST_TYPES.REEL ? POST_JOB_TYPES.IG_REEL : POST_JOB_TYPES.IG_STORY)
      : POST_JOB_TYPES.FB_REEL
    const runKey = isIg
      ? (post.type === POST_TYPES.REEL ? `ig_reel:${target.id}` : `ig_story:${target.id}`)
      : `fb_reel:${target.id}`
    try {
      await enqueueReelJob(jobType, runKey, { postId, targetId: target.id })
    } catch {
      // run_key unique already guarantees a single queued/running execution
    }
    jobInFlight += 1
  }

  for (const target of directTargets) {
    if (mediaErrorIds.has(target.id)) {
      await repo.updatePostTargetStatus(target.id, {
        status: POST_TARGET_STATUS.FAILED,
        error: mediaError,
        publishState: POST_TARGET_PUBLISH_STATE.PERMANENT_FAILURE,
      })
      if (!firstError) firstError = mediaError
      continue
    }
    if (target.publishState === POST_TARGET_PUBLISH_STATE.UNKNOWN ||
        target.publishState === POST_TARGET_PUBLISH_STATE.MANUAL_REVIEW) {
      needsVerify = true
      continue
    }
    if (target.publishState === POST_TARGET_PUBLISH_STATE.RETRY_PENDING) {
      const attempts = target.verificationAttempts || 0
      if (attempts >= IG_VERIFY_RETRY_CAP) {
        await setPublishState(target.id, POST_TARGET_PUBLISH_STATE.MANUAL_REVIEW)
        needsVerify = true
        continue
      }
    }
    try {
      if (isRateLimited(tokenKeyFor(target.accessToken))) {
        const err = new Error('Meta API rate limited for this account, retrying shortly')
        err.metaHttpStatus = 429
        throw err
      }
      await setPublishState(target.id, POST_TARGET_PUBLISH_STATE.PUBLISHING)
      let objectId
      if (target.platformCode === 'instagram') {
        objectId = await publishToInstagram(target, message, post.type, post.mediaUrl)
      } else {
        objectId = await publishToFacebookPage(target, message, post.mediaUrl, post.type)
      }
      const remoteVideoId = target._remoteVideoId || null
      await repo.updatePostTargetStatus(target.id, {
        status: POST_TARGET_STATUS.POSTED,
        error: null,
        publishState: POST_TARGET_PUBLISH_STATE.PUBLISHED,
        metaObjectId: objectId,
        ...(remoteVideoId ? { remoteVideoId } : {}),
        postedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      })
      // capture promotability only for boost-enabled posts (id must be post-shaped)
      if (target.platformCode === 'facebook' && post.boostEnabled && String(objectId).includes('_')) {
        await capturePostPromotability(target, qualifyFbPostId(target.platformUserId, objectId))
      }
      await syncPublisherRequestOnPost({ ...target, status: POST_TARGET_STATUS.POSTED })
      if (post.boostEnabled) {
        try {
          await enqueueReelJob(POST_JOB_TYPES.BOOST, `post_boost:${target.id}`, { postId: post.id, postTargetId: target.id })
        } catch {}
      }
      successCount += 1
    } catch (err) {
      const detail = err?.message || String(err)
      if (!firstError) firstError = detail
      const { kind } = await classifyPublishError(err)
      if (kind === 'ambiguous') {
        const attempts = (target.verificationAttempts || 0) + 1
        await setPublishState(target.id, POST_TARGET_PUBLISH_STATE.UNKNOWN, {
          verificationAttempts: attempts,
        })
        needsVerify = true
      } else if (kind === 'permanent') {
        await repo.updatePostTargetStatus(target.id, {
          status: POST_TARGET_STATUS.FAILED,
          error: detail,
          publishState: POST_TARGET_PUBLISH_STATE.PERMANENT_FAILURE,
        })
        await syncPublisherRequestOnPost({ ...target, status: POST_TARGET_STATUS.FAILED })
      } else {
        await repo.updatePostTargetStatus(target.id, {
          status: POST_TARGET_STATUS.FAILED,
          error: detail,
          publishState: POST_TARGET_PUBLISH_STATE.RETRYABLE_FAILURE,
        })
      }
    }
  }

  if (needsVerify) {
    try {
      await repo.requeueAutoJob(postId, POST_JOB_TYPES.VERIFY, {}, { entityType: 'post' })
    } catch {
      // already queued or running — verify job exists
    }
  }

  if (mediaErrorIds.size > 0 && mediaErrorIds.size === actionable.length) {
    const previousStatus = post.status
    const allFailedMessage = `Media failed publish-mode validation for all targets (${mediaError})`
    await repo.updatePostWithStatusGuard(postId, {
      status: POST_STATUS.FAILED,
      error: allFailedMessage,
    }, previousStatus)
    await repo.createReviewLog(postId, null, REVIEW_ACTIONS.SUBMITTED, previousStatus, allFailedMessage)
    return repo.findPostById(postId)
  }

  const remaining = await repo.findPostTargetsByStatus(postId, POST_TARGET_STATUS.PENDING)
  const failed = await repo.findPostTargetsByStatus(postId, POST_TARGET_STATUS.FAILED)
  const verifyPending = targets.filter(t => t.status !== POST_TARGET_STATUS.POSTED && t.status !== POST_TARGET_STATUS.FAILED &&
    (t.publishState === POST_TARGET_PUBLISH_STATE.UNKNOWN ||
     t.publishState === POST_TARGET_PUBLISH_STATE.MANUAL_REVIEW ||
     t.publishState === POST_TARGET_PUBLISH_STATE.RETRY_PENDING))
  const allPosted = successCount > 0 && remaining.length === 0 && verifyPending.length === 0

  if (allPosted && failed.length === 0) {
    const previousStatus = post.status
    await repo.updatePostWithStatusGuard(postId, {
      status: POST_STATUS.COMPLETED,
      publishedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      error: null,
    }, previousStatus)
    await repo.createReviewLog(postId, null, REVIEW_ACTIONS.SUBMITTED, previousStatus, 'Post published to all targets')
  } else if (successCount > 0 || needsVerify || verifyPending.length > 0 || jobInFlight > 0) {
    const previousStatus = post.status
    await repo.updatePostWithStatusGuard(postId, {
      status: POST_STATUS.RUNNING,
      error: firstError,
    }, previousStatus)
    const notes = []
    if (needsVerify) notes.push('awaiting verification on some targets')
    if (verifyPending.length > 0) notes.push(`${verifyPending.length} target(s) pending`)
    if (jobInFlight > 0) notes.push(`${jobInFlight} video target(s) publishing in background`)
    await repo.createReviewLog(postId, null, REVIEW_ACTIONS.SUBMITTED, previousStatus,
      `Post published to ${successCount} target(s) — ${failed.length} failed${notes.length ? ` (${notes.join(', ')})` : ''}`)
  } else {
    throw new Error(firstError || 'Post publishing failed for all targets')
  }

  return repo.findPostById(postId)
}

const POST_ENGAGEMENT_SYNC_SECONDS = Number(process.env.POST_ENGAGEMENT_SYNC_SECONDS) || 3600
const POST_ENGAGEMENT_SYNC_LIMIT = 20

export async function schedulePostEngagementSyncs() {
  const due = await repo.findPostsDueForEngagementSync({
    stalenessSeconds: POST_ENGAGEMENT_SYNC_SECONDS,
    limit: POST_ENGAGEMENT_SYNC_LIMIT,
  })
  const enqueued = []
  for (const postId of due) {
    await repo.requeuePostEngagementJob(postId)
    enqueued.push(postId)
  }
  return { enqueued }
}

export async function syncPostEngagementJob(postId, options = {}) {
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')

  const targets = await repo.findPostTargetsByPostId(postId)
  let posted = targets.filter(t => t.status === POST_TARGET_STATUS.POSTED && t.metaObjectId)
  if (posted.length === 0) return { synced: 0 }

  if (options && options.targetId) {
    const filtered = posted.filter(t => t.id === options.targetId)
    if (filtered.length) posted = filtered
  }
  posted = posted.filter(t => !t.metaDeletedAt)

  if (posted.length === 0) return { synced: 0 }

  const mediaKind = post.type === 'story' ? 'story' : 'post'
  const statDate = new Date().toISOString().slice(0, 10)

  const synced = []
  for (const target of posted) {
    const platform = target.platformCode === 'facebook' ? 'facebook' : 'instagram'
    if (isRateLimited(tokenKeyFor(target.accessToken))) {
      await repo.upsertPostEngagement(target.id, postId, {
        statDate,
        mediaType: null,
        permalink: null,
        likes: 0,
        comments: 0,
        saved: 0,
        shares: 0,
        views: 0,
        reach: 0,
        interactions: 0,
        impressions: 0,
        tapsForward: 0,
        tapsBack: 0,
        exits: 0,
        replies: 0,
        raw: {},
        commentsJson: [],
        error: 'Meta rate limited — skipped this cycle',
      })
      await repo.stampPostEngagementSync(target.id)
      continue
    }
    try {
      const systemToken = process.env.META_SYSTEM_USER_TOKEN
      const preferred = platform === 'facebook' ? target.accessToken : (systemToken || target.accessToken)
      const fallback = platform === 'facebook' ? null : (systemToken ? target.accessToken : null)
      let engagement
      try {
        engagement = await getMediaEngagement(target.metaObjectId, preferred, { mediaKind, platform })
      } catch (err) {
        if (!fallback) throw err
        engagement = await getMediaEngagement(target.metaObjectId, fallback, { mediaKind, platform })
      }
      await repo.upsertPostEngagement(target.id, postId, {
        statDate,
        mediaType: engagement.mediaType,
        permalink: engagement.permalink,
        likes: engagement.likeCount || engagement.insights.likes || 0,
        comments: engagement.commentsCount || engagement.insights.comments || 0,
        saved: engagement.insights.saved || 0,
        shares: engagement.insights.shares || 0,
        views: engagement.insights.views || 0,
        reach: engagement.insights.reach || 0,
        interactions: engagement.insights.total_interactions || 0,
        impressions: engagement.insights.impressions || 0,
        tapsForward: engagement.insights.taps_forward || 0,
        tapsBack: engagement.insights.taps_back || 0,
        exits: engagement.insights.exits || 0,
        replies: engagement.insights.replies || 0,
        raw: engagement,
        commentsJson: engagement.comments,
        error: null,
      })
      await repo.stampPostEngagementSync(target.id)
      synced.push(target.id)
    } catch (err) {
      await repo.upsertPostEngagement(target.id, postId, {
        statDate,
        mediaType: null,
        permalink: null,
        likes: 0,
        comments: 0,
        saved: 0,
        shares: 0,
        views: 0,
        reach: 0,
        interactions: 0,
        impressions: 0,
        tapsForward: 0,
        tapsBack: 0,
        exits: 0,
        replies: 0,
        raw: {},
        commentsJson: [],
        error: err?.message || String(err),
      })
      await repo.stampPostEngagementSync(target.id)
    }
  }

  return { synced: synced.length, total: posted.length }
}

export async function getPostEngagement(userId, postId, query = {}, { skipOwnership = false } = {}) {
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')
  if (!skipOwnership && post.clientId !== userId) throw new ForbiddenError('Not your post')

  if (query?.refresh) {
    const enqueued = await repo.requeuePostEngagementJob(postId)
    return { queued: true, enqueued }
  }

  const rows = await repo.findPostEngagement(postId)
  const byTarget = new Map()
  for (const row of rows) {
    const key = row.targetId
    if (!byTarget.has(key)) {
      byTarget.set(key, {
        targetId: key,
        platformCode: row.platformCode,
        platformDisplayName: row.platformDisplayName,
        platformUsername: row.platformUsername,
        metaObjectId: row.metaObjectId,
        lastEngagementSyncAt: row.lastEngagementSyncAt,
        rows: [],
      })
    }
    byTarget.get(key).rows.push(row)
  }
  return {
    cached: true,
    postId,
    postType: post.type,
    lastSyncAt: rows.length ? rows[rows.length - 1].lastEngagementSyncAt : null,
    targets: [...byTarget.values()].map(t => ({
      ...t,
      latest: t.rows[t.rows.length - 1] || null,
    })),
  }
}

export async function cleanupOrphanContainers() {
  const targets = await repo.findInstagramTargetsWithMediaIds()
  const results = { checked: 0, deleted: 0, kept: 0, skipped: 0 }
  for (const target of targets) {
    if (!target.accessToken) {
      results.skipped += 1
      continue
    }
    results.checked += 1
    let state
    try {
      state = await getContainerStatus(target.metaObjectId, target.accessToken)
    } catch {
      results.skipped += 1
      continue
    }
    const isOrphan =
      state.status_code === 'FINISHED' || state.status_code === 'ERROR' || state.status_code === 'EXPIRED'
    if (!isOrphan) {
      results.kept += 1
      continue
    }
    try {
      await deleteInstagramContainer(target.metaObjectId, target.accessToken)
      await repo.updatePostTargetStatus(target.id, { metaObjectId: null })
      results.deleted += 1
    } catch (err) {
      const detail = extractMetaError(err)
      if (detail?.code === 100) {
        await repo.updatePostTargetStatus(target.id, { metaObjectId: null })
        results.deleted += 1
      } else {
        results.skipped += 1
      }
    }
  }

  const staleMinutes = Math.ceil(igVideoState.processingCapMs / 60000) + 10
  const stale = await repo.findStaleIgContainers(staleMinutes)
  for (const target of stale) {
    if (!target.accessToken) {
      results.skipped += 1
      continue
    }
    results.checked += 1
    let state
    try {
      state = await getContainerStatus(target.containerId, target.accessToken)
    } catch {
      results.skipped += 1
      continue
    }
    const isOrphan =
      state.status_code === 'FINISHED' || state.status_code === 'ERROR' || state.status_code === 'EXPIRED'
    if (!isOrphan) {
      results.kept += 1
      continue
    }
    try {
      await deleteInstagramContainer(target.containerId, target.accessToken)
      await repo.clearPostTargetContainer(target.id)
      results.deleted += 1
    } catch (err) {
      const detail = extractMetaError(err)
      if (detail?.code === 100) {
        await repo.clearPostTargetContainer(target.id)
        results.deleted += 1
      } else {
        results.skipped += 1
      }
    }
  }
  return results
}

export async function watchdogIgVideoTargets() {
  const targets = await repo.findInFlightIgTargetsWithoutJob([POST_JOB_TYPES.IG_REEL, POST_JOB_TYPES.IG_STORY])
  const reenqueued = []
  for (const target of targets) {
    const jobType = target.postType === POST_TYPES.STORY ? POST_JOB_TYPES.IG_STORY : POST_JOB_TYPES.IG_REEL
    const runKey = `${jobType === POST_JOB_TYPES.IG_STORY ? 'ig_story' : 'ig_reel'}:${target.id}`
    const enqueued = await enqueueReelJob(jobType, runKey, { postId: target.postId, targetId: target.id })
    if (enqueued) reenqueued.push(target.id)
  }
  return { reenqueued }
}

export async function postBoostJob(postId, postTargetId, payload = {}) {
  if (!postId || !postTargetId) return { done: true }

  //finding post by id
  const post = await repo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')
  if (!post.boostEnabled) return { done: true }
  if ([POST_STATUS.CANCELLED, POST_STATUS.FAILED].includes(post.status)) return { done: true }

  const target = await repo.findPostTargetById(postTargetId)
  if (!target) return { done: true }
  if (target.status !== POST_TARGET_STATUS.POSTED) return { done: true }
  if (!target.metaObjectId) return { done: true }

  // live gate: post must be indexed before any eligibility/creative calls
  if (target.metaObjectId) {
    const live = target.platformCode === 'instagram'
      ? await isInstagramPostLive(target.metaObjectId, target.accessToken)
      : String(target.metaObjectId).includes('_')
        ? await isPostLiveForBoost(target.platformUserId, target.metaObjectId, target.accessToken)
        : false
    const isBareIdAndShouldWait = target.platformCode === 'instagram' || String(target.metaObjectId).includes('_')
    if (isBareIdAndShouldWait && !live) {
      const attempts = (Number(payload.liveAttempts) || 0) + 1
      if (attempts >= 8) {
        await repo.updatePost(postId, { boostError: `Post ${target.metaObjectId} not yet live after ${attempts} checks — retry from admin` })
        await logMetaEvent({ action: 'post_boost_not_live_parked', postId, targetId: postTargetId, error: `post_id ${target.metaObjectId} not yet live after ${attempts} checks` })
        return { done: true }
      }
      await logMetaEvent({ action: 'post_boost_not_live', postId, targetId: postTargetId, error: `post_id ${target.metaObjectId} not yet live — requeueing (attempt ${attempts})` })
      return { requeueAfterSeconds: Math.min(30 * attempts, 120), attempts: { ...payload, liveAttempts: attempts } }
    }
  }

  const existing = await repo.findPostBoostTargetsByTargetId(postTargetId)
  if (existing.length > 0) return { done: true }

  const { accountId: adAccountId, accessToken: systemToken, accountDbId } = await resolveAccountContext()
  if (!adAccountId || !systemToken) return { done: true }

  if (isRateLimited(tokenKeyFor(systemToken))) {
    return { requeueAfterSeconds: 30, attempts: 0 }
  }

  const result = await createPostBoostForTarget(post, target, payload)
  if (result && typeof result.requeueAfterSeconds === 'number') {
    return result
  }
  if (!result.success) {
    await repo.updatePost(postId, { boostError: result.error })
    return { done: true }
  }

  const activateResult = await activateAllPostBoostObjects(post.id, target.id, systemToken)
  if (!activateResult.success) {
    await repo.updatePost(postId, { boostError: activateResult.error })
    return { done: true }
  }

  await logMetaEvent({ action: 'post_boost_activated', postId, targetId: postTargetId })
  return { done: true }
}

async function activateAllPostBoostObjects(postId, postTargetId, accessToken) {
  const targets = await repo.findPostBoostTargetsByTargetId(postTargetId)
  if (targets.length === 0) return { success: false, error: 'No boost objects found' }

  const order = ['facebook_campaign', 'ad_set', 'ad_creative', 'ad']
  const results = []

  for (const type of order) {
    const obj = targets.find(t => t.objectType === type)
    if (!obj) continue
    try {
      await updateAdStatus(obj.objectId, 'ACTIVE', accessToken)
      await repo.updatePostBoostTargetStatus(obj.postTargetId, 'active')
      results.push({ type: obj.objectType, success: true })
    } catch (err) {
      const detail = extractMetaError(err)
      const message = detail?.userMsg || err.message
      results.push({ type: obj.objectType, success: false, error: message })
    }
  }

  const allSuccess = results.every(r => r.success)
  return { success: allSuccess, error: allSuccess ? null : results.find(r => !r.success)?.error }
}
