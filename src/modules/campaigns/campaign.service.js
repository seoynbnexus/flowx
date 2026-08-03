import * as repo from './campaign.repository.js'
import { generateUuid } from '../../../shared/utils/uuid.utils.js'
import { NotFoundError, ValidationError, ForbiddenError } from '../../../shared/errors/AppError.js'
import { CAMPAIGN_STATUS, VALID_TRANSITIONS, REVIEW_ACTIONS, CAMPAIGN_JOB_TYPES } from './campaign.model.js'
import { addCoins, createTransaction } from '../ai/ai.repository.js'
import { findActivePublishersByCategoryId } from './campaign.repository.js'
import {
  createAdCampaign,
  createAdSet,
  createAdCreative,
  createAd,
  deleteAd,
  deleteAdSet,
  deleteAdCreative,
  deleteAdCampaign,
  updateAdStatus,
  getObjectStatus,
  getCampaignSpend,
  getCampaignInsights as getCampaignInsightsFromMeta,
  extractMetaError,
} from '../../../shared/services/meta-ads.service.js'
import { logMetaEvent } from '../../../shared/services/meta-logger.service.js'
import { transaction, queryOne } from '../../../shared/database/connection.js'

let cachedCoinRate = null

export async function enqueueCampaignJob(campaignId, jobType, actorId = null, payload = {}) {
  const jobId = generateUuid()
  const enqueued = await repo.enqueueCampaignJob(jobId, campaignId, jobType, actorId, payload)
  return { jobId, enqueued }
}

export async function markCampaignJobFailed(campaignId, jobType, message) {
  try {
    const campaign = await repo.findCampaignById(campaignId)
    if (!campaign) return
    const inFlight = [
      CAMPAIGN_STATUS.PENDING_REVIEW,
      CAMPAIGN_STATUS.APPROVED,
      CAMPAIGN_STATUS.AWAITING_PUBLISHERS,
      CAMPAIGN_STATUS.SCHEDULED,
    ].includes(campaign.status)
    if (inFlight) {
      await repo.updateCampaign(campaignId, { metaStatus: 'failed', metaError: message })
    }
    await repo.createReviewLog(campaignId, null, REVIEW_ACTIONS.SUBMITTED, campaign.status,
      `Background job ${jobType} failed: ${message}`)
  } catch (err) {
    // best-effort — never let failure marking crash the worker
  }
}

export async function getCoinConversionRate() {
  if (cachedCoinRate !== null) return cachedCoinRate
  try {
    const row = await queryOne("SELECT config_value FROM app_config WHERE config_key = 'coin_conversion_rate'")
    cachedCoinRate = row ? JSON.parse(row.config_value) : 1
    return cachedCoinRate
  } catch {
    return 1
  }
}

export function invalidateCoinRateCache() {
  cachedCoinRate = null
}

let cachedPublisherMultiplier = null
let cachedDeadlineDays = null

export async function getPublisherRequestMultiplier() {
  if (cachedPublisherMultiplier !== null) return cachedPublisherMultiplier
  try {
    const row = await queryOne("SELECT config_value FROM app_config WHERE config_key = 'publisher_request_multiplier'")
    cachedPublisherMultiplier = row ? JSON.parse(row.config_value) : 2
    return cachedPublisherMultiplier
  } catch {
    return 2
  }
}

export async function getPublisherResponseDeadlineDays() {
  if (cachedDeadlineDays !== null) return cachedDeadlineDays
  try {
    const row = await queryOne("SELECT config_value FROM app_config WHERE config_key = 'publisher_response_deadline_days'")
    cachedDeadlineDays = row ? JSON.parse(row.config_value) : 7
    return cachedDeadlineDays
  } catch {
    return 7
  }
}

export function invalidatePublisherConfigCache() {
  cachedPublisherMultiplier = null
  cachedDeadlineDays = null
}

function buildUrlTags(creative) {
  if (!creative?.utmSource && !creative?.utmMedium && !creative?.utmCampaign) return null
  const params = new URLSearchParams()
  if (creative.utmSource) params.set('utm_source', creative.utmSource)
  if (creative.utmMedium) params.set('utm_medium', creative.utmMedium)
  if (creative.utmCampaign) params.set('utm_campaign', creative.utmCampaign)
  if (creative.utmContent) params.set('utm_content', creative.utmContent)
  if (creative.utmTerm) params.set('utm_term', creative.utmTerm)
  return params.toString()
}

function assertValidTransition(current, next) {
  const allowed = VALID_TRANSITIONS[current]
  if (!allowed || !allowed.includes(next)) {
    throw new ValidationError(`Cannot transition from '${current}' to '${next}'`)
  }
}

export async function createCampaign(userId, data) {
  const id = generateUuid()
  const campaign = await repo.createCampaign(id, userId, data)
  return campaign
}

export async function getCampaign(userId, campaignId, isAdmin = false) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')

  if (!isAdmin && campaign.clientId !== userId) {
    throw new ForbiddenError('You do not have access to this campaign')
  }

  const [creative, metaSettings, reviewLog, publisherRequests, metaObjects] = await Promise.all([
    repo.findCreativeByCampaignId(campaignId),
    repo.findMetaSettingsByCampaignId(campaignId),
    repo.findReviewLogsByCampaignId(campaignId),
    repo.findPublisherRequestsByCampaignId(campaignId),
    repo.findMetaObjectsByCampaignId(campaignId),
  ])

  return { ...campaign, creative, metaSettings, reviewLog, publisherRequests, metaObjects }
}

export async function listCampaigns(userId, query) {
  return repo.findCampaignsByClientId(userId, query)
}

export async function updateCampaign(userId, campaignId, data) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.clientId !== userId) throw new ForbiddenError('Not your campaign')

  if ([
    CAMPAIGN_STATUS.APPROVED,
    CAMPAIGN_STATUS.SCHEDULED,
    CAMPAIGN_STATUS.RUNNING,
    CAMPAIGN_STATUS.COMPLETED,
    CAMPAIGN_STATUS.CANCELLED,
    CAMPAIGN_STATUS.FAILED,
  ].includes(campaign.status)) {
    throw new ValidationError('Cannot edit campaign in its current status')
  }

  if (campaign.status !== CAMPAIGN_STATUS.DRAFT) {
    data.status = CAMPAIGN_STATUS.DRAFT

    return await transaction(async () => {
      const updated = await repo.updateCampaign(campaignId, data)
      const subService = await import('../subscriptions/subscription.service.js')
      await subService.refundUsage(userId, 'campaigns', 'campaign', campaignId)
      return updated
    })
  }

  return repo.updateCampaign(campaignId, data)
}

export async function submitCampaign(userId, campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.clientId !== userId) throw new ForbiddenError('Not your campaign')
  assertValidTransition(campaign.status, CAMPAIGN_STATUS.PENDING_REVIEW)

  const creative = await repo.findCreativeByCampaignId(campaignId)
  if (!creative || (!creative.caption && !creative.mediaUrl)) {
    throw new ValidationError('Campaign must have at least a caption or media before submitting for review')
  }

  return await transaction(async () => {
    const subService = await import('../subscriptions/subscription.service.js')
    await subService.consumeUsage(userId, 'campaigns', 'campaign', campaignId)

    const updated = await repo.updateCampaignWithStatusGuard(campaignId, { status: CAMPAIGN_STATUS.PENDING_REVIEW }, campaign.status)
    await repo.createReviewLog(campaignId, userId, REVIEW_ACTIONS.SUBMITTED, campaign.status, null)

    return updated
  })
}

export async function cancelCampaign(userId, campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.clientId !== userId) throw new ForbiddenError('Not your campaign')
  assertValidTransition(campaign.status, CAMPAIGN_STATUS.CANCELLED)

  return await transaction(async () => {
    const updated = await repo.updateCampaignWithStatusGuard(campaignId, { status: CAMPAIGN_STATUS.CANCELLED }, campaign.status)
    await repo.createReviewLog(campaignId, userId, REVIEW_ACTIONS.CANCELLED, campaign.status, null)

    const NO_REFUND_STATUSES = [CAMPAIGN_STATUS.DRAFT, CAMPAIGN_STATUS.SCHEDULED, CAMPAIGN_STATUS.RUNNING, CAMPAIGN_STATUS.COMPLETED]
    if (!NO_REFUND_STATUSES.includes(campaign.status)) {
      const subService = await import('../subscriptions/subscription.service.js')
      await subService.refundUsage(userId, 'campaigns', 'campaign', campaignId)
    }

    return updated
  })
}

export async function saveCreative(userId, campaignId, data) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.clientId !== userId) throw new ForbiddenError('Not your campaign')

  const id = generateUuid()
  return repo.createCreative(id, campaignId, data)
}

export async function saveMetaSettings(userId, campaignId, data) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.clientId !== userId) throw new ForbiddenError('Not your campaign')

  const id = generateUuid()
  return repo.createMetaSettings(id, campaignId, data)
}

export async function confirmAdjustments(userId, campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.clientId !== userId) throw new ForbiddenError('Not your campaign')
  if (campaign.status !== CAMPAIGN_STATUS.APPROVED) {
    throw new ValidationError('Campaign must be in approved status to confirm')
  }
  if (!campaign.adminNotes) {
    throw new ValidationError('No admin adjustments to confirm')
  }

  const totalEscrow = calculateTotalEscrow(campaign)
  const metaSettings = await repo.findMetaSettingsByCampaignId(campaignId)
  const adBudgetCost = calculateAdBudget(metaSettings, campaign.publisherCount)
  const totalDeduction = totalEscrow + adBudgetCost

  if (campaign.categoryId && campaign.publisherCount && campaign.coinsPerPublisher) {
    const subService = await import('../subscriptions/subscription.service.js')
    const limit = await subService.getLimit(userId, 'publishers_per_campaign')
    if (campaign.publisherCount > limit) {
      throw new ValidationError(`Publisher count exceeds your plan limit of ${limit} publishers per campaign`)
    }
  }

  const coinService = await import('../../../shared/services/coin.service.js')
  const available = await coinService.getAvailable(userId)
  if (available.total < totalDeduction) {
    throw new ValidationError('Insufficient coins. You need to top up your wallet first.')
  }

  let updated

  // Publisher flow after adjustments — await publishers before Meta ads
  if (campaign.categoryId && campaign.publisherCount && campaign.coinsPerPublisher) {
    const multiplier = await getPublisherRequestMultiplier()
    const deadlineDays = await getPublisherResponseDeadlineDays()
    const deadlineAt = new Date()
    deadlineAt.setDate(deadlineAt.getDate() + deadlineDays)

    await transaction(async () => {
      await coinService.spend(userId, totalDeduction, 'campaign_escrow', campaignId, `Campaign escrow: ${campaign.name}`)

      updated = await repo.updateCampaignWithStatusGuard(campaignId, {
        status: CAMPAIGN_STATUS.AWAITING_PUBLISHERS,
        escrowAmount: totalEscrow,
        coinsEscrowedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
        publisherResponseDeadlineAt: deadlineAt.toISOString().slice(0, 19).replace('T', ' '),
        clientConfirmed: true,
        clientConfirmedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      }, CAMPAIGN_STATUS.APPROVED)

      await repo.createReviewLog(campaignId, userId, REVIEW_ACTIONS.CONFIRMED, CAMPAIGN_STATUS.APPROVED,
        `Client confirmed — awaiting ${campaign.publisherCount} publishers`)

      await createPublisherRequestsForCampaign(campaignId, campaign.categoryId, campaign.publisherCount, campaign.coinsPerPublisher, multiplier)
    })
    return updated
  }

  const queuedJob = await enqueueCampaignJob(campaignId, CAMPAIGN_JOB_TYPES.CONFIRM_GO_LIVE, userId)
  return { queued: true, jobId: queuedJob.jobId, campaign }
}

export async function confirmAndGoLive(campaignId, userId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (![CAMPAIGN_STATUS.APPROVED, CAMPAIGN_STATUS.SCHEDULED].includes(campaign.status)) {
    throw new ValidationError('Campaign must be in approved status to confirm')
  }
  if (!campaign.adminNotes) {
    throw new ValidationError('No admin adjustments to confirm')
  }

  const coinService = await import('../../../shared/services/coin.service.js')

  if (campaign.status === CAMPAIGN_STATUS.APPROVED) {
    const totalEscrow = calculateTotalEscrow(campaign)
    const metaSettings = await repo.findMetaSettingsByCampaignId(campaignId)
    const adBudgetCost = calculateAdBudget(metaSettings, campaign.publisherCount)
    const totalDeduction = totalEscrow + adBudgetCost

    const available = await coinService.getAvailable(campaign.clientId)
    if (available.total < totalDeduction) {
      throw new ValidationError('Insufficient coins. You need to top up your wallet first.')
    }

    await transaction(async () => {
      await coinService.spend(campaign.clientId, totalDeduction, 'campaign_escrow', campaignId, `Campaign escrow: ${campaign.name}`)

      await repo.updateCampaignWithStatusGuard(campaignId, {
        status: CAMPAIGN_STATUS.SCHEDULED,
        escrowAmount: totalEscrow,
        coinsEscrowedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
        clientConfirmed: true,
        clientConfirmedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      }, CAMPAIGN_STATUS.APPROVED)

      await repo.createReviewLog(campaignId, userId, REVIEW_ACTIONS.CONFIRMED, CAMPAIGN_STATUS.APPROVED, 'Client confirmed admin adjustments')
    })
  }

  const publishResult = await publishAdForClient(campaignId)
  if (!publishResult.success) {
    throw new ValidationError(`Failed to publish campaign on Meta: ${publishResult.error}`)
  }

  const activateResult = await activateAllMetaObjects(campaignId)
  if (!activateResult.success) {
    throw new ValidationError(`Failed to activate Meta ads: ${activateResult.results.find(r => !r.success)?.error || 'unknown error'}`)
  }

  const scheduledAt = campaign.scheduledAt ? new Date(campaign.scheduledAt) : null
  const isFutureSchedule = scheduledAt && scheduledAt.getTime() > Date.now()
  const afterPublishStatus = isFutureSchedule ? CAMPAIGN_STATUS.SCHEDULED : CAMPAIGN_STATUS.RUNNING

  if (afterPublishStatus === CAMPAIGN_STATUS.RUNNING) {
    await repo.updateCampaignWithStatusGuard(campaignId, { status: CAMPAIGN_STATUS.RUNNING }, CAMPAIGN_STATUS.SCHEDULED)
    await repo.createReviewLog(campaignId, userId, REVIEW_ACTIONS.CONFIRMED, CAMPAIGN_STATUS.SCHEDULED, 'Campaign is now running')
  }

  return repo.findCampaignById(campaignId)
}

function calculateTotalEscrow(campaign) {
  const publisherCost = (campaign.publisherCount || 0) * (campaign.coinsPerPublisher || 0)
  const platformFee = Math.round(publisherCost * 0.1)
  return publisherCost + platformFee
}

function calculateAdBudget(metaSettings, publisherCount) {
  return (metaSettings?.budgetAmount || 1000) * ((publisherCount || 0) + 1)
}

async function createPublisherRequestsForCampaign(campaignId, categoryId, targetCount, coinsPerPublisher, multiplier = 1) {
  const publishers = await findActivePublishersByCategoryId(categoryId)
  console.log(`[campaign] createPublisherRequests: campaign=${campaignId.substring(0,8)} category=${categoryId.substring(0,8)} publishersFound=${publishers.length} target=${targetCount}`)
  const sendCount = Math.min(publishers.length, targetCount * multiplier)
  const selected = publishers.slice(0, sendCount)
  if (selected.length === 0) {
    console.log(`[campaign] No publishers found for category ${categoryId.substring(0,8)} — skipping request creation`)
    return
  }

  const created = await repo.createPublisherRequests(campaignId, selected.map(p => p.publisherId), coinsPerPublisher)
  console.log(`[campaign] Created ${created.length} publisher requests for campaign ${campaignId.substring(0,8)}`)

  const campaign = await repo.findCampaignById(campaignId)
  const { createAndSend } = await import('../notifications/notifications.service.js')
  for (const item of created) {
    const pub = selected.find(p => p.publisherId === item.publisherId)
    if (!pub) continue
    try {
      await createAndSend(
        item.publisherId,
        'new_campaign_request',
        'New Campaign Request',
        `New request: "${campaign?.name || 'Campaign'}" — ${coinsPerPublisher.toLocaleString()} coins`,
        { campaignId, campaignName: campaign?.name, coinsOffered: coinsPerPublisher, requestId: item.requestId },
        pub.email,
        pub.firstName,
      )
    } catch (err) {
      console.warn(`[campaign] Failed to notify publisher ${item.publisherId}: ${err.message}`)
    }
  }
}

const MIN_BUDGET_INR = 100
const MIN_DURATION_MS = 24 * 60 * 60 * 1000

function buildMetaAdPayloads(campaign, creative, metaSettings, pageId, coinRate) {
  const coinBudget = metaSettings?.budgetAmount || 1000
  const budgetInINR = Math.round(coinBudget * coinRate)
  const isDaily = metaSettings?.budgetType === 'daily' || !metaSettings?.budgetType
  const minBudgetError = budgetInINR < MIN_BUDGET_INR
    ? `Minimum ${isDaily ? 'daily' : 'lifetime'} budget is ₹${MIN_BUDGET_INR} (${Math.ceil(MIN_BUDGET_INR / coinRate)} coins at current conversion rate)`
    : null

  const now = Date.now()
  const startTimeMs = campaign.scheduledAt ? new Date(campaign.scheduledAt).getTime() : null
  const endTimeMs = metaSettings?.endTime ? new Date(metaSettings.endTime).getTime() : null
  let scheduleError = null
  if (startTimeMs !== null && Number.isFinite(startTimeMs) && startTimeMs <= now) {
    scheduleError = 'Ad set start time must be in the future'
  } else if (endTimeMs !== null && Number.isFinite(endTimeMs) && endTimeMs <= now) {
    scheduleError = 'Ad set end time must be in the future'
  } else if (startTimeMs !== null && endTimeMs !== null && Number.isFinite(endTimeMs) && endTimeMs <= startTimeMs) {
    scheduleError = 'Ad set end time must be after start time'
  } else if (!isDaily && endTimeMs === null) {
    scheduleError = 'End time is required for lifetime budget'
  } else if (isDaily && endTimeMs !== null && Number.isFinite(endTimeMs) && endTimeMs - (startTimeMs ?? now) <= MIN_DURATION_MS) {
    scheduleError = 'Daily budget is only allowed for ad sets running longer than 24 hours'
  }

  const fbCampaignName = `FlowX-${campaign.name}-${campaign.id.substring(0, 8)}`

  const targeting = metaSettings?.targeting || {}

  delete targeting.age
  delete targeting.gender
  delete targeting.country

  if (targeting.geo_locations) {
    delete targeting.geo_locations.location_types
  }

  const geo = targeting.geo_locations
  if (geo?.countries?.length && (geo.regions?.length || geo.cities?.length || geo.zips?.length)) {
    delete geo.countries
  }
  if (!geo?.countries?.length && !geo?.custom_locations?.length) {
    if (!geo) targeting.geo_locations = { countries: ['IN'] }
    else targeting.geo_locations.countries = ['IN']
  }
  if (geo?.custom_locations?.length) {
    delete geo.regions
    delete geo.cities
    delete geo.zips
    delete geo.countries
  }

  if (targeting.age_min && targeting.age_max && targeting.age_min > targeting.age_max) {
    targeting.age_max = targeting.age_min
  }

  const spendCapInPaise = metaSettings?.spendCap ? Math.round(metaSettings.spendCap * coinRate * 100) : null
  const creativeMessage = creative?.caption || creative?.textBody || campaign.name
  const creativeMediaUrl = creative?.mediaUrl || null
  const creativeCallToAction = creative?.callToAction || null
  const creativeExtra = { headline: creative?.headline, description: creative?.description }
  const adSetBudget = {
    budgetType: metaSettings?.budgetType || 'daily',
    budgetAmount: budgetInINR,
    bidStrategy: metaSettings?.bidStrategy || 'LOWEST_COST_WITHOUT_CAP',
    optimizationGoal: metaSettings?.optimizationGoal || 'REACH',
    billingEvent: metaSettings?.billingEvent || null,
    promotedPageId: pageId,
  }
  const adSetSchedule = (() => {
    const s = {}
    if (campaign.scheduledAt) s.startTime = Math.floor(new Date(campaign.scheduledAt).getTime() / 1000)
    if (metaSettings?.endTime) s.endTime = Math.floor(new Date(metaSettings.endTime).getTime() / 1000)
    return s
  })()

  return {
    budgetInINR,
    isDaily,
    minBudgetError,
    scheduleError,
    fbCampaignName,
    targeting,
    spendCapInPaise,
    creativeMessage,
    creativeMediaUrl,
    creativeCallToAction,
    creativeExtra,
    adSetBudget,
    adSetSchedule,
    adSetPlacement: metaSettings?.platformPlacement || {},
    campaignObjective: metaSettings?.objective || 'OUTCOME_TRAFFIC',
  }
}

async function createMetaAdObjectsForUser(campaignId, userId, pageId) {
  const adAccountId = process.env.META_AD_ACCOUNT_ID
  const systemToken = process.env.META_SYSTEM_USER_TOKEN

  if (!adAccountId || !systemToken) {
    await logMetaEvent({ campaignId, userId, action: 'create_all', error: 'Meta Ads not configured' })
    return { success: false, error: 'Meta Ads not configured' }
  }

  const [campaign, creative, metaSettings] = await Promise.all([
    repo.findCampaignById(campaignId),
    repo.findCreativeByCampaignId(campaignId),
    repo.findMetaSettingsByCampaignId(campaignId),
  ])

  if (!campaign) {
    await logMetaEvent({ campaignId, userId, action: 'create_all', error: 'Campaign not found' })
    return { success: false, error: 'Campaign not found' }
  }

  const coinRate = await getCoinConversionRate()
  const payload = buildMetaAdPayloads(campaign, creative, metaSettings, pageId, coinRate)
  if (payload.minBudgetError) {
    await logMetaEvent({ campaignId, userId, action: 'create_all', error: payload.minBudgetError })
    return { success: false, error: payload.minBudgetError }
  }
  if (payload.scheduleError) {
    await logMetaEvent({ campaignId, userId, action: 'create_all', error: payload.scheduleError })
    return { success: false, error: payload.scheduleError }
  }

  const {
    targeting, adSetBudget, adSetSchedule, adSetPlacement,
    fbCampaignName, spendCapInPaise, campaignObjective,
    creativeMessage, creativeMediaUrl, creativeCallToAction, creativeExtra,
  } = payload

  const existingUserObjects = await repo.findMetaObjectsForUser(campaignId, userId)
  for (const obj of [...existingUserObjects].reverse()) {
    try {
      await META_ROLLBACK_FN[obj.objectType](obj.objectId, systemToken)
      await logMetaEvent({
        campaignId, userId, action: `delete_${obj.objectType}`, objectType: obj.objectType, objectId: obj.objectId,
      })
    } catch (err) {
      await logMetaEvent({
        campaignId, userId, action: `delete_${obj.objectType}`, objectType: obj.objectType, objectId: obj.objectId, error: err.message,
      })
    }
  }
  await repo.deleteMetaObjectsForUser(campaignId, userId)

  const createdObjects = []

  const validateStep = async (step, fn) => {
    try {
      await fn()
      return null
    } catch (error) {
      const detail = extractMetaError(error)
      const message = detail?.userMsg || error.message
      await logMetaEvent({ campaignId, userId, action: step, error: message })
      return message
    }
  }

  try {
    const creativeValidationError = await validateStep('validate_creative', () =>
      createAdCreative(adAccountId, pageId, creativeMessage, creativeMediaUrl, creativeCallToAction, systemToken, creativeExtra, true),
    )
    if (creativeValidationError) return { success: false, error: creativeValidationError }

    const campaignValidationError = await validateStep('validate_campaign', () =>
      createAdCampaign(adAccountId, fbCampaignName, campaignObjective, 'PAUSED', systemToken, { spendCap: spendCapInPaise }, true),
    )
    if (campaignValidationError) return { success: false, error: campaignValidationError }

    const t0 = Date.now()
    const fbCampaign = await createAdCampaign(adAccountId, fbCampaignName, campaignObjective, 'PAUSED', systemToken, { spendCap: spendCapInPaise })
    createdObjects.push({ type: 'facebook_campaign', id: fbCampaign.id })
    await repo.createMetaObject(campaignId, 'facebook_campaign', fbCampaign.id, null, 'PAUSED', userId)
    await logMetaEvent({
      campaignId, userId, action: 'create_campaign', objectType: 'facebook_campaign', objectId: fbCampaign.id, params: { name: fbCampaignName, objective: campaignObjective }, durationMs: Date.now() - t0,
    })

    const adSetValidationError = await validateStep('validate_ad_set', () =>
      createAdSet(adAccountId, fbCampaign.id, targeting, adSetBudget, adSetSchedule, adSetPlacement, systemToken, true),
    )
    if (adSetValidationError) {
      await rollbackMetaObjects(createdObjects, campaignId, systemToken, userId)
      return { success: false, error: adSetValidationError }
    }

    const t1 = Date.now()
    const fbAdSet = await createAdSet(adAccountId, fbCampaign.id, targeting, adSetBudget, adSetSchedule, adSetPlacement, systemToken)
    createdObjects.push({ type: 'ad_set', id: fbAdSet.id })
    await repo.createMetaObject(campaignId, 'ad_set', fbAdSet.id, null, 'PAUSED', userId)
    await logMetaEvent({
      campaignId, userId, action: 'create_ad_set', objectType: 'ad_set', objectId: fbAdSet.id, params: { campaignId: fbCampaign.id }, durationMs: Date.now() - t1,
    })

    const t2 = Date.now()
    const fbCreative = await createAdCreative(adAccountId, pageId, creativeMessage, creativeMediaUrl, creativeCallToAction, systemToken, creativeExtra)
    createdObjects.push({ type: 'ad_creative', id: fbCreative.id })
    await repo.createMetaObject(campaignId, 'ad_creative', fbCreative.id, null, null, userId)
    await logMetaEvent({
      campaignId, userId, action: 'create_creative', objectType: 'ad_creative', objectId: fbCreative.id, params: { pageId }, durationMs: Date.now() - t2,
    })

    const adValidationError = await validateStep('validate_ad', () =>
      createAd(adAccountId, fbAdSet.id, fbCreative.id, fbCampaignName, systemToken, 'PAUSED', { urlTags: buildUrlTags(creative) }, true),
    )
    if (adValidationError) {
      await rollbackMetaObjects(createdObjects, campaignId, systemToken, userId)
      return { success: false, error: adValidationError }
    }

    const t3 = Date.now()
    const urlTags = buildUrlTags(creative)
    const fbAd = await createAd(adAccountId, fbAdSet.id, fbCreative.id, fbCampaignName, systemToken, 'PAUSED', { urlTags })
    createdObjects.push({ type: 'ad', id: fbAd.id })
    await repo.createMetaObject(campaignId, 'ad', fbAd.id, null, 'PAUSED', userId)
    await logMetaEvent({
      campaignId, userId, action: 'create_ad', objectType: 'ad', objectId: fbAd.id, params: { adSetId: fbAdSet.id, creativeId: fbCreative.id }, durationMs: Date.now() - t3,
    })

    return { success: true }
  } catch (error) {
    await rollbackMetaObjects(createdObjects, campaignId, systemToken, userId)
    const detail = extractMetaError(error)
    const message = detail?.userMsg || error.message
    await logMetaEvent({ campaignId, userId, action: 'create_all', error: message })
    return { success: false, error: message }
  }
}

const META_ROLLBACK_FN = {
  facebook_campaign: deleteAdCampaign,
  ad_set: deleteAdSet,
  ad_creative: deleteAdCreative,
  ad: deleteAd,
}

async function rollbackMetaObjects(createdObjects, campaignId, systemToken, userId) {
  for (let i = createdObjects.length - 1; i >= 0; i--) {
    const obj = createdObjects[i]
    try {
      await META_ROLLBACK_FN[obj.type](obj.id, systemToken)
    } catch {
      // best-effort rollback
    }
  }
  await repo.deleteMetaObjectsForUser(campaignId, userId)
}

export async function validateCampaignDraft(userId, campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
  console.log("from service log campaign : ", campaign)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.clientId !== userId) throw new ForbiddenError('Not your campaign')

  if (![
    CAMPAIGN_STATUS.DRAFT,
    CAMPAIGN_STATUS.PENDING_REVIEW,
    CAMPAIGN_STATUS.REJECTED,
    CAMPAIGN_STATUS.CHANGES_REQUESTED,
  ].includes(campaign.status)) {
    throw new ValidationError(`Campaign cannot be validated in ${campaign.status} status`)
  }

  const adAccountId = process.env.META_AD_ACCOUNT_ID
  const systemToken = process.env.META_SYSTEM_USER_TOKEN
  if (!adAccountId || !systemToken) {
    return { valid: false, checks: [], error: 'Meta Ads not configured' }
  }

  const page = await repo.findVerifiedFacebookPage(userId)
  if (!page) {
    return { valid: false, checks: [], error: 'You need a verified Facebook page connected to run Meta campaigns' }
  }

  const [creative, metaSettings] = await Promise.all([
    repo.findCreativeByCampaignId(campaignId),
    repo.findMetaSettingsByCampaignId(campaignId),
  ])

  const coinRate = await getCoinConversionRate()
  const payload = buildMetaAdPayloads(campaign, creative, metaSettings, page.platformUserId, coinRate)
  if (payload.minBudgetError) {
    return { valid: false, checks: [], error: payload.minBudgetError }
  }
  if (payload.scheduleError) {
    return { valid: false, checks: [], error: payload.scheduleError }
  }

  const checks = []
  const run = async (object, fn) => {
    try {
      await fn()
      checks.push({ object, ok: true })
    } catch (error) {
      const detail = extractMetaError(error)
      checks.push({ object, ok: false, error: detail?.userMsg || error.message })
    }
  }

  await run('creative', () =>
    createAdCreative(adAccountId, page.platformUserId, payload.creativeMessage, payload.creativeMediaUrl, payload.creativeCallToAction, systemToken, payload.creativeExtra, true),
  )
  await run('campaign', () =>
    createAdCampaign(adAccountId, payload.fbCampaignName, payload.campaignObjective, 'PAUSED', systemToken, { spendCap: payload.spendCapInPaise }, true),
  )

  const failed = checks.filter(c => !c.ok)
  await logMetaEvent({
    campaignId, userId, action: 'pre_validate',
    error: failed.length ? failed.map(c => c.error).join('; ') : null,
  })

  return { valid: failed.length === 0, checks, error: failed[0]?.error || null }
}

async function publishAdForClient(campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) return { success: false, error: 'Campaign not found' }

  const page = await repo.findVerifiedFacebookPage(campaign.clientId)
  if (!page) {
    const error = 'Client has no verified Facebook page'
    await repo.updateCampaign(campaignId, { metaStatus: 'failed', metaError: error })
    await logMetaEvent({ campaignId, userId: campaign.clientId, action: 'publish_client', error })
    return { success: false, error }
  }

  const result = await createMetaAdObjectsForUser(campaignId, campaign.clientId, page.platformUserId)

  await repo.updateCampaign(campaignId, {
    metaStatus: result.success ? 'created' : 'failed',
    metaError: result.success ? null : result.error,
  })

  return result
}

export async function listAllCampaigns(query) {
  return repo.findAllCampaigns(query)
}

export async function approveCampaign(adminId, campaignId, data) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.status !== CAMPAIGN_STATUS.PENDING_REVIEW) {
    throw new ValidationError('Campaign must be in pending review status')
  }

  const hasAdjustments = data.publisherCount !== undefined || data.coinsPerPublisher !== undefined
  const nextStatus = hasAdjustments ? CAMPAIGN_STATUS.APPROVED : CAMPAIGN_STATUS.SCHEDULED
  const effectivePublisherCount = data.publisherCount ?? campaign.publisherCount

  if (data.publisherCount !== undefined) {
    const subService = await import('../subscriptions/subscription.service.js')
    const limit = await subService.getLimit(campaign.clientId, 'publishers_per_campaign')
    if (data.publisherCount > limit) {
      throw new ValidationError(`Publisher count exceeds client plan limit of ${limit} publishers per campaign`)
    }
  }

  const escrowAmount = hasAdjustments ? 0 : calculateTotalEscrow({
    ...campaign,
    publisherCount: effectivePublisherCount,
    coinsPerPublisher: data.coinsPerPublisher ?? campaign.coinsPerPublisher,
  })

  const metaSettings = hasAdjustments ? null : await repo.findMetaSettingsByCampaignId(campaignId)
  const adBudgetCost = hasAdjustments ? 0 : calculateAdBudget(metaSettings, effectivePublisherCount)
  const totalDeduction = escrowAmount + adBudgetCost

  const updateData = {
    status: nextStatus,
    reviewedBy: adminId,
    reviewedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    reviewNotes: data.notes || null,
    adminNotes: hasAdjustments ? [
      data.publisherCount ? `Publisher count adjusted to ${data.publisherCount}` : null,
      data.coinsPerPublisher ? `Coins per publisher adjusted to ${data.coinsPerPublisher}` : null,
      data.notes || null,
    ].filter(Boolean).join('; ') || null : null,
    publisherCount: data.publisherCount ?? campaign.publisherCount,
    coinsPerPublisher: data.coinsPerPublisher ?? campaign.coinsPerPublisher,
  }

  if (!hasAdjustments) {
    const coinService = await import('../../../shared/services/coin.service.js')
    const available = await coinService.getAvailable(campaign.clientId)
    if (available.total < totalDeduction) {
      throw new ValidationError('Client has insufficient coins. Campaign cannot be approved.')
    }

    updateData.escrowAmount = escrowAmount
    updateData.coinsEscrowedAt = new Date().toISOString().slice(0, 19).replace('T', ' ')

    // Publisher flow — await publishers before creating Meta ads
    if (campaign.categoryId && campaign.publisherCount && campaign.coinsPerPublisher) {
      const multiplier = await getPublisherRequestMultiplier()
      const deadlineDays = await getPublisherResponseDeadlineDays()
      const deadlineAt = new Date()
      deadlineAt.setDate(deadlineAt.getDate() + deadlineDays)

      let updated
      await transaction(async () => {
        await coinService.spend(campaign.clientId, totalDeduction, 'campaign_escrow', campaignId, `Campaign escrow: ${campaign.name}`)

        updated = await repo.updateCampaignWithStatusGuard(campaignId, {
          status: CAMPAIGN_STATUS.AWAITING_PUBLISHERS,
          escrowAmount,
          coinsEscrowedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
          publisherResponseDeadlineAt: deadlineAt.toISOString().slice(0, 19).replace('T', ' '),
          reviewedBy: adminId,
          reviewedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
          reviewNotes: data.notes || null,
          publisherCount: effectivePublisherCount,
          coinsPerPublisher: data.coinsPerPublisher ?? campaign.coinsPerPublisher,
        }, CAMPAIGN_STATUS.PENDING_REVIEW)

        await repo.createReviewLog(campaignId, adminId, REVIEW_ACTIONS.APPROVED, campaign.status, `Approved — awaiting ${campaign.publisherCount} publishers`)

        await createPublisherRequestsForCampaign(campaignId, campaign.categoryId, campaign.publisherCount, campaign.coinsPerPublisher, multiplier)
      })
      return updated
    }

    const queuedJob = await enqueueCampaignJob(campaignId, CAMPAIGN_JOB_TYPES.APPROVE_GO_LIVE, adminId, {
      notes: data.notes || null,
    })
    return { queued: true, jobId: queuedJob.jobId, campaign }
  }

  let updated
  await transaction(async () => {
    updated = await repo.updateCampaignWithStatusGuard(campaignId, updateData, CAMPAIGN_STATUS.PENDING_REVIEW)
    await repo.createReviewLog(campaignId, adminId, REVIEW_ACTIONS.APPROVED, campaign.status, data.notes || null)
  })
  return updated
}

export async function approveAndGoLive(campaignId, adminId, payload = {}) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.status !== CAMPAIGN_STATUS.PENDING_REVIEW) {
    throw new ValidationError('Campaign must be in pending review status')
  }

  const escrowAmount = calculateTotalEscrow(campaign)
  const metaSettings = await repo.findMetaSettingsByCampaignId(campaignId)
  const adBudgetCost = calculateAdBudget(metaSettings, campaign.publisherCount)
  const totalDeduction = escrowAmount + adBudgetCost

  const coinService = await import('../../../shared/services/coin.service.js')
  const available = await coinService.getAvailable(campaign.clientId)
  if (available.total < totalDeduction) {
    throw new ValidationError('Client has insufficient coins. Campaign cannot be approved.')
  }

  const publishResult = await publishAdForClient(campaignId)
  if (!publishResult.success) {
    throw new ValidationError(`Failed to publish campaign on Meta: ${publishResult.error}`)
  }

  const activateResult = await activateAllMetaObjects(campaignId)
  if (!activateResult.success) {
    throw new ValidationError(`Failed to activate Meta ads: ${activateResult.results.find(r => !r.success)?.error || 'unknown error'}`)
  }

  const scheduledAt = campaign.scheduledAt ? new Date(campaign.scheduledAt) : null
  const isFutureSchedule = scheduledAt && scheduledAt.getTime() > Date.now()
  const afterPublishStatus = isFutureSchedule ? CAMPAIGN_STATUS.SCHEDULED : CAMPAIGN_STATUS.RUNNING
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')

  let updated
  await transaction(async () => {
    updated = await repo.updateCampaignWithStatusGuard(campaignId, {
      status: afterPublishStatus,
      reviewedBy: adminId,
      reviewedAt: now,
      reviewNotes: payload.notes || null,
      publisherCount: campaign.publisherCount,
      coinsPerPublisher: campaign.coinsPerPublisher,
      escrowAmount,
      coinsEscrowedAt: now,
    }, CAMPAIGN_STATUS.PENDING_REVIEW)
    await repo.createReviewLog(campaignId, adminId, REVIEW_ACTIONS.APPROVED, CAMPAIGN_STATUS.PENDING_REVIEW, payload.notes || null)
    await coinService.spend(campaign.clientId, totalDeduction, 'campaign_escrow', campaignId, `Campaign escrow: ${campaign.name}`)
  })

  return updated
}

export async function rejectCampaign(adminId, campaignId, data) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.status !== CAMPAIGN_STATUS.PENDING_REVIEW) {
    throw new ValidationError('Campaign must be in pending review status')
  }

  return await transaction(async () => {
    const updated = await repo.updateCampaignWithStatusGuard(campaignId, {
      status: CAMPAIGN_STATUS.REJECTED,
      reviewedBy: adminId,
      reviewedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      reviewNotes: data.notes || 'Rejected',
    }, CAMPAIGN_STATUS.PENDING_REVIEW)

    await repo.createReviewLog(campaignId, adminId, REVIEW_ACTIONS.REJECTED, campaign.status, data.notes || null)

    const NO_REFUND_STATUSES = [CAMPAIGN_STATUS.DRAFT, CAMPAIGN_STATUS.SCHEDULED, CAMPAIGN_STATUS.RUNNING, CAMPAIGN_STATUS.COMPLETED]
    if (!NO_REFUND_STATUSES.includes(campaign.status)) {
      const subService = await import('../subscriptions/subscription.service.js')
      await subService.refundUsage(campaign.clientId, 'campaigns', 'campaign', campaignId)
    }

    return updated
  })
}

export async function listPublisherRequests(publisherId, query) {
  return repo.findPublisherRequestsByPublisherId(publisherId, query)
}

export async function acceptPublisherRequest(publisherId, requestId) {
  const request = await repo.findPublisherRequestById(requestId)
  if (!request) throw new NotFoundError('Request not found')
  if (request.publisherId !== publisherId) throw new ForbiddenError('Not your request')
  if (request.status !== 'pending') throw new ValidationError('Request is no longer pending')

  const campaign = await repo.findCampaignById(request.campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')

  return await transaction(async () => {
    await repo.lockCampaignById(request.campaignId)
    const acceptedCount = await repo.countPublisherRequestsByStatus(request.campaignId, 'accepted')
    if (acceptedCount >= (campaign.publisherCount || Infinity)) {
      throw new ValidationError('Publisher capacity reached for this campaign')
    }
    await repo.updatePublisherRequestStatusWithGuard(requestId, 'accepted', new Date().toISOString().slice(0, 19).replace('T', ' '), 'pending')

    const newAcceptedCount = await repo.countPublisherRequestsByStatus(request.campaignId, 'accepted')

    if (newAcceptedCount >= (campaign.publisherCount || Infinity)) {
      const pendingRequests = await repo.findPublisherRequestsByStatus(request.campaignId, 'pending')
      for (const p of pendingRequests) {
        await repo.updatePublisherRequestStatusWithGuard(p.id, 'rejected', new Date().toISOString().slice(0, 19).replace('T', ' '), 'pending')
      }

      await enqueueCampaignJob(request.campaignId, CAMPAIGN_JOB_TYPES.PUBLISHER_GO_LIVE)
    }

    return repo.findPublisherRequestById(requestId)
  })
}

export async function goLiveForFilledCampaign(campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.status !== CAMPAIGN_STATUS.AWAITING_PUBLISHERS) {
    throw new ValidationError('Campaign must be in awaiting_publishers status')
  }

  return await transaction(async () => {
    await repo.lockCampaignById(campaignId)

    const clientResult = await publishAdForClient(campaignId)
    if (!clientResult.success) {
      throw new Error(`Failed to create Meta ads for client: ${clientResult.error}`)
    }

    const acceptedRequests = await repo.findAcceptedPublisherRequests(campaignId)
    for (const ar of acceptedRequests) {
      const page = await repo.findVerifiedFacebookPage(ar.publisherId)
      if (page) {
        const result = await createMetaAdObjectsForUser(campaignId, ar.publisherId, page.platformUserId)
        if (result.success) {
          await repo.updatePublisherRequestPublishedWithGuard(ar.id, 'accepted')
        } else {
          await repo.updatePublisherRequestStatusWithGuard(ar.id, 'failed', new Date().toISOString().slice(0, 19).replace('T', ' '), 'accepted')
        }
      }
    }

    const activateResult = await activateAllMetaObjects(campaignId)

    if (!activateResult.success) {
      const activationError = activateResult.results.find(r => !r.success)?.error || 'Meta activation failed'
      await logMetaEvent({ campaignId, userId: campaign.clientId, action: 'activate_all', error: activationError })
      await repo.updateCampaign(campaignId, { metaStatus: 'failed', metaError: activationError })
      await repo.createReviewLog(campaignId, null, REVIEW_ACTIONS.SUBMITTED, CAMPAIGN_STATUS.AWAITING_PUBLISHERS,
        `Meta activation failed — campaign stays awaiting publishers: ${activationError}`)
      return repo.findCampaignById(campaignId)
    }

    const scheduledAt = campaign.scheduledAt ? new Date(campaign.scheduledAt) : null
    const isFutureSchedule = scheduledAt && scheduledAt.getTime() > Date.now()
    const afterPublishStatus = isFutureSchedule ? CAMPAIGN_STATUS.SCHEDULED : CAMPAIGN_STATUS.RUNNING
    await repo.updateCampaignWithStatusGuard(campaignId, { status: afterPublishStatus }, CAMPAIGN_STATUS.AWAITING_PUBLISHERS)
    await repo.createReviewLog(campaignId, null, REVIEW_ACTIONS.SUBMITTED, CAMPAIGN_STATUS.AWAITING_PUBLISHERS,
      `All ${campaign.publisherCount} publisher slots filled — campaign ${afterPublishStatus === CAMPAIGN_STATUS.RUNNING ? 'is now running' : 'scheduled'}`)

    return repo.findCampaignById(campaignId)
  })
}

export async function rejectPublisherRequest(publisherId, requestId) {
  const request = await repo.findPublisherRequestById(requestId)
  if (!request) throw new NotFoundError('Request not found')
  if (request.publisherId !== publisherId) throw new ForbiddenError('Not your request')
  if (request.status !== 'pending') throw new ValidationError('Request is no longer pending')

  await repo.updatePublisherRequestStatusWithGuard(requestId, 'rejected', new Date().toISOString().slice(0, 19).replace('T', ' '), 'pending')
  return repo.findPublisherRequestById(requestId)
}

export async function queueRetryMeta(campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')

  if (!process.env.META_AD_ACCOUNT_ID || !process.env.META_SYSTEM_USER_TOKEN) {
    throw new ValidationError('Meta Ads not configured — set META_AD_ACCOUNT_ID and META_SYSTEM_USER_TOKEN')
  }

  const queuedJob = await enqueueCampaignJob(campaignId, CAMPAIGN_JOB_TYPES.RETRY_META)
  return { queued: true, jobId: queuedJob.jobId }
}

export async function retryCampaignMeta(campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')

  const adAccountId = process.env.META_AD_ACCOUNT_ID
  const systemToken = process.env.META_SYSTEM_USER_TOKEN

  if (!adAccountId || !systemToken) {
    throw new ValidationError('Meta Ads not configured — set META_AD_ACCOUNT_ID and META_SYSTEM_USER_TOKEN')
  }

  const existingObjects = await repo.findMetaObjectsByCampaignId(campaignId)

  const deleteOrder = ['ad', 'ad_creative', 'ad_set', 'facebook_campaign']
  for (const objType of deleteOrder) {
    const objects = existingObjects.filter(o => o.objectType === objType)
    for (const obj of objects) {
      try {
        if (objType === 'ad') await deleteAd(obj.objectId, systemToken)
        else if (objType === 'ad_creative') await deleteAdCreative(obj.objectId, systemToken)
        else if (objType === 'ad_set') await deleteAdSet(obj.objectId, systemToken)
        else if (objType === 'facebook_campaign') await deleteAdCampaign(obj.objectId, systemToken)
        await logMetaEvent({
          campaignId, action: `delete_${objType}`, objectType: objType, objectId: obj.objectId,
        })
      } catch (err) {
        await logMetaEvent({
          campaignId, action: `delete_${objType}`, objectType: objType, objectId: obj.objectId, error: err.message,
        })
      }
    }
  }

  return await transaction(async () => {
    await repo.deleteMetaObjectsByCampaignId(campaignId)
    const result = await publishAdForClient(campaignId)
    if (!result.success) return result

    const requests = await repo.findPublisherRequestsByCampaignId(campaignId)
    for (const r of requests.filter(r => r.status === 'accepted' || r.status === 'published')) {
      const page = await repo.findVerifiedFacebookPage(r.publisherId)
      if (!page) continue
      const pubResult = await createMetaAdObjectsForUser(campaignId, r.publisherId, page.platformUserId)
      if (pubResult.success) {
        if (r.status === 'accepted') {
          await repo.updatePublisherRequestPublishedWithGuard(r.id, 'accepted')
        }
      } else {
        await logMetaEvent({
          campaignId, userId: r.publisherId, action: 'retry_publisher', error: pubResult.error,
        })
      }
    }

    return { success: true }
  })
}

export async function activateAllMetaObjects(campaignId) {
  const systemToken = process.env.META_SYSTEM_USER_TOKEN
  if (!systemToken) {
    await logMetaEvent({ campaignId, action: 'activate_all', error: 'META_SYSTEM_USER_TOKEN not configured' })
    return { success: false, error: 'Meta system token not configured' }
  }

  const objects = await repo.findMetaObjectsByCampaignId(campaignId)

  if (!objects.length) {
    await logMetaEvent({ campaignId, action: 'activate_all', error: 'No Meta objects to activate' })
    return { success: false, error: 'No Meta objects to activate' }
  }

  const activateOrder = ['facebook_campaign', 'ad_set', 'ad']
  const results = []

  for (const objType of activateOrder) {
    const items = objects.filter(o => o.objectType === objType)
    for (const item of items) {
      try {
        const t0 = Date.now()
        await updateAdStatus(item.objectId, 'ACTIVE', systemToken)
        await repo.saveMetaObjectStatus(item.objectId, 'ACTIVE')
        await logMetaEvent({
          campaignId, action: `activate_${objType}`, objectType: objType, objectId: item.objectId, durationMs: Date.now() - t0,
        })
        results.push({ objectType: objType, objectId: item.objectId, success: true })
      } catch (err) {
        await logMetaEvent({
          campaignId, action: `activate_${objType}`, objectType: objType, objectId: item.objectId, error: err.message,
        })
        results.push({ objectType: objType, objectId: item.objectId, success: false, error: err.message })
      }
    }
  }

  const allSuccess = results.every(r => r.success)
  return { success: allSuccess, results }
}

export async function completePublisherRequest(requestId) {
  const request = await repo.findPublisherRequestById(requestId)
  if (!request) throw new NotFoundError('Request not found')

  if (request.status !== 'published') {
    throw new ValidationError(`Cannot complete request with status '${request.status}' — must be 'published'`)
  }

  const completedAt = new Date().toISOString().slice(0, 19).replace('T', ' ')

  await transaction(async () => {
    await repo.updatePublisherRequestStatus(requestId, 'completed', completedAt)
    await addCoins(request.publisherId, request.coinsOffered)
    await createTransaction(generateUuid(), request.publisherId, `Campaign payout: ${request.campaignName}`, request.coinsOffered, 'credit', 'campaign', request.campaignId)
  })

  return repo.findPublisherRequestById(requestId)
}

export async function syncCampaignMetaStatus(campaignId) {
  const systemToken = process.env.META_SYSTEM_USER_TOKEN
  const adAccountId = process.env.META_AD_ACCOUNT_ID

  if (!systemToken || !adAccountId) {
    await logMetaEvent({ campaignId, action: 'sync', error: 'Meta not configured' })
    return { success: false, error: 'Meta not configured' }
  }

  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) return { success: false, error: 'Campaign not found' }
  if (!['running', 'paused'].includes(campaign.status)) return { success: false, error: 'Campaign not syncable' }

  const metaObjects = await repo.findMetaObjectsByCampaignId(campaignId)
  const ad = metaObjects.find(o => o.objectType === 'ad')
  const fbCampaign = metaObjects.find(o => o.objectType === 'facebook_campaign')

  if (!ad) return { success: false, error: 'No Meta ad object to sync' }

  const result = {
    campaignId,
    statusBefore: campaign.status,
    statusAfter: campaign.status,
    statusChanged: false,
    metaSpendPaise: campaign.metaSpentPaise || 0,
    spendUpdated: false,
    errors: [],
  }

  try {
    const adStatusData = await getObjectStatus(ad.objectId, systemToken)
    const metaAdStatus = adStatusData.effective_status || adStatusData.status || 'UNKNOWN'

    if (metaAdStatus !== ad.status) {
      await repo.saveMetaObjectStatus(ad.objectId, metaAdStatus)
      result.metaStatus = metaAdStatus
    }

    if (metaAdStatus === 'PAUSED' && campaign.status === 'running') {
      await repo.updateCampaignStatus(campaignId, 'paused')
      await repo.createReviewLog(campaignId, null, 'submitted', 'running', 'Campaign paused from Meta')
      result.statusAfter = 'paused'
      result.statusChanged = true
    } else if (metaAdStatus === 'ACTIVE' && campaign.status === 'paused') {
      await repo.updateCampaignStatus(campaignId, 'running')
      await repo.createReviewLog(campaignId, null, 'submitted', 'paused', 'Campaign resumed from Meta')
      result.statusAfter = 'running'
      result.statusChanged = true
    }
  } catch (err) {
      result.errors.push(`Status sync failed: ${err.message}`)
  }

  if (fbCampaign) {
    try {
      const spendData = await getCampaignSpend(fbCampaign.objectId, systemToken)
      if (spendData && spendData.spend !== undefined) {
        const spendPaise = Math.round(parseFloat(spendData.spend || '0') * 100)
        if (spendPaise > 0 && spendPaise !== (campaign.metaSpentPaise || 0)) {
          await repo.saveMetaSpend(campaignId, spendPaise)
          result.metaSpendPaise = spendPaise
          result.spendUpdated = true
        }
      }
    } catch (err) {
      result.errors.push(`Spend sync failed: ${err.message}`)
    }
  }

  await logMetaEvent({
    campaignId, action: 'sync',
    params: { statusBefore: result.statusBefore, statusAfter: result.statusAfter, statusChanged: result.statusChanged, spendPaise: result.metaSpendPaise },
  })

  return { success: true, result }
}

export async function syncAllActiveCampaigns() {
  const campaigns = await repo.findSyncableCampaigns()
  const results = []

  for (const campaign of campaigns) {
    try {
      const syncResult = await syncCampaignMetaStatus(campaign.id)
      results.push(syncResult)
    } catch (err) {
      results.push({ campaignId: campaign.id, success: false, error: err.message })
    }
  }

  return results
}

export async function activateDueScheduledCampaigns() {
  const due = await repo.findDueScheduledCampaigns()
  const results = []
  for (const campaign of due) {
    try {
      const activateResult = await activateAllMetaObjects(campaign.id)
      if (activateResult.success) {
        await repo.updateCampaignStatus(campaign.id, CAMPAIGN_STATUS.RUNNING)
        await repo.createReviewLog(campaign.id, null, REVIEW_ACTIONS.SUBMITTED, CAMPAIGN_STATUS.SCHEDULED,
          'Scheduled campaign started')
        results.push({ campaignId: campaign.id, success: true })
      } else {
        results.push({ campaignId: campaign.id, success: false, error: 'Meta activation failed' })
      }
    } catch (err) {
      results.push({ campaignId: campaign.id, success: false, error: err.message })
    }
  }
  return results
}

export async function setPublisherCategories(publisherId, categoryIds) {
  return repo.setPublisherCategories(publisherId, categoryIds)
}

export async function getPublisherCategories(publisherId) {
  return repo.findPublisherCategories(publisherId)
}

export async function getCampaignDetail(campaignId) {
  return getCampaign(null, campaignId, true)
}

export async function duplicateCampaign(userId, campaignId, data) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.clientId !== userId) throw new ForbiddenError('Not your campaign')

  const newId = generateUuid()
  const newName = data.name || `${campaign.name} (Copy)`

  const newCampaign = await repo.createCampaign(newId, userId, {
    name: newName,
    type: campaign.type,
    categoryId: campaign.categoryId,
    scheduledAt: null,
    publisherCount: campaign.publisherCount,
    coinsPerPublisher: campaign.coinsPerPublisher,
  })

  const creative = await repo.findCreativeByCampaignId(campaignId)
  if (creative) {
    await repo.createCreative(generateUuid(), newId, {
      mediaUrl: creative.mediaUrl,
      caption: creative.caption,
      hashtags: creative.hashtags,
      textBody: creative.textBody,
      callToAction: creative.callToAction,
      headline: creative.headline,
      description: creative.description,
      utmSource: creative.utmSource,
      utmMedium: creative.utmMedium,
      utmCampaign: creative.utmCampaign,
      utmContent: creative.utmContent,
      utmTerm: creative.utmTerm,
    })
  }

  const metaSettings = await repo.findMetaSettingsByCampaignId(campaignId)
  if (metaSettings) {
    await repo.createMetaSettings(generateUuid(), newId, {
      objective: metaSettings.objective,
      adAccountId: metaSettings.adAccountId,
      bidStrategy: metaSettings.bidStrategy,
      optimizationGoal: metaSettings.optimizationGoal,
      budgetType: metaSettings.budgetType,
      budgetAmount: metaSettings.budgetAmount,
      billingEvent: metaSettings.billingEvent,
      spendCap: metaSettings.spendCap,
      endTime: metaSettings.endTime,
      targeting: metaSettings.targeting,
      platformPlacement: metaSettings.platformPlacement,
    })
  }

  return newCampaign
}

export async function handleExpiredAwaitingCampaigns() {
  const expired = await repo.findExpiredAwaitingCampaigns()
  const results = []

  for (const campaign of expired) {
    try {
      await transaction(async () => {
        // Cancel all pending publisher requests
        const pendingRequests = await repo.findPublisherRequestsByStatus(campaign.id, 'pending')
        for (const p of pendingRequests) {
          await repo.updatePublisherRequestStatus(p.id, 'cancelled', new Date().toISOString().slice(0, 19).replace('T', ' '))
        }

        // Refund escrow to client
        if (campaign.escrowAmount > 0) {
          const coinService = await import('../../../shared/services/coin.service.js')
          await coinService.refund(campaign.clientId, campaign.escrowAmount, 'campaign_escrow', campaign.id, `Refund: publisher deadline passed for ${campaign.name}`)
        }

        // Transition to failed
        await repo.updateCampaignWithStatusGuard(campaign.id, {
          status: CAMPAIGN_STATUS.FAILED,
          metaError: `Publisher response deadline passed — only ${pendingRequests.length} pending publishers responded`,
        }, CAMPAIGN_STATUS.AWAITING_PUBLISHERS)

        await repo.createReviewLog(campaign.id, null, REVIEW_ACTIONS.SUBMITTED, CAMPAIGN_STATUS.AWAITING_PUBLISHERS,
          'Publisher response deadline passed — campaign failed')
      })
      results.push({ campaignId: campaign.id, success: true })
    } catch (err) {
      results.push({ campaignId: campaign.id, success: false, error: err.message })
    }
  }

  return results
}

export async function queueForceGoLive(adminId, campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.status !== CAMPAIGN_STATUS.AWAITING_PUBLISHERS) {
    throw new ValidationError('Campaign must be in awaiting_publishers status')
  }

  const queuedJob = await enqueueCampaignJob(campaignId, CAMPAIGN_JOB_TYPES.FORCE_GO_LIVE, adminId)
  return { queued: true, jobId: queuedJob.jobId }
}

export async function forceGoLiveCampaign(adminId, campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.status !== CAMPAIGN_STATUS.AWAITING_PUBLISHERS) {
    throw new ValidationError('Campaign must be in awaiting_publishers status')
  }

  const acceptedRequests = await repo.findAcceptedPublisherRequests(campaignId)

  return await transaction(async () => {
    await repo.lockCampaignById(campaignId)
    // Cancel remaining pending requests
    const pendingRequests = await repo.findPublisherRequestsByStatus(campaignId, 'pending')
    for (const p of pendingRequests) {
      await repo.updatePublisherRequestStatus(p.id, 'cancelled', new Date().toISOString().slice(0, 19).replace('T', ' '))
    }

    // Refund escrow for unfilled slots
    const unfilledSlots = (campaign.publisherCount || 0) - acceptedRequests.length
    if (unfilledSlots > 0 && campaign.coinsPerPublisher) {
      const refundAmount = unfilledSlots * campaign.coinsPerPublisher * 1.1
      const coinService = await import('../../../shared/services/coin.service.js')
      await coinService.refund(campaign.clientId, Math.round(refundAmount), 'campaign_escrow', campaignId,
        `Refund for ${unfilledSlots} unfilled publisher slots`)
    }

    // Create client Meta ads
    const clientResult = await publishAdForClient(campaignId)
    if (!clientResult.success) {
      throw new ValidationError(`Failed to create Meta ads for client: ${clientResult.error}`)
    }

    // Create Meta ads for each accepted or published publisher
    const publisherRequests = await repo.findPublisherRequestsByCampaignId(campaignId)
    for (const ar of publisherRequests.filter(r => r.status === 'accepted' || r.status === 'published')) {
      const page = await repo.findVerifiedFacebookPage(ar.publisherId)
      if (page) {
        const result = await createMetaAdObjectsForUser(campaignId, ar.publisherId, page.platformUserId)
        if (result.success) {
          if (ar.status === 'accepted') {
            await repo.updatePublisherRequestPublishedWithGuard(ar.id, 'accepted')
          }
        } else {
          if (ar.status === 'accepted') {
            await repo.updatePublisherRequestStatusWithGuard(ar.id, 'failed', new Date().toISOString().slice(0, 19).replace('T', ' '), 'accepted')
          }
          await logMetaEvent({
            campaignId, userId: ar.publisherId, action: 'publish_publisher', error: result.error,
          })
        }
      }
    }

    // Activate all Meta objects
    const activateResult = await activateAllMetaObjects(campaignId)

    if (!activateResult.success) {
      const activationError = activateResult.results.find(r => !r.success)?.error || 'Meta activation failed'
      await logMetaEvent({ campaignId, userId: campaign.clientId, action: 'activate_all', error: activationError })
      await repo.updateCampaign(campaignId, { metaStatus: 'failed', metaError: activationError })
      await repo.createReviewLog(campaignId, adminId, REVIEW_ACTIONS.APPROVED, CAMPAIGN_STATUS.AWAITING_PUBLISHERS,
        `Meta activation failed — campaign stays awaiting publishers: ${activationError}`)
      return repo.findCampaignById(campaignId)
    }

    // Transition to running/scheduled
    const scheduledAt = campaign.scheduledAt ? new Date(campaign.scheduledAt) : null
    const isFutureSchedule = scheduledAt && scheduledAt.getTime() > Date.now()
    const afterPublishStatus = isFutureSchedule ? CAMPAIGN_STATUS.SCHEDULED : CAMPAIGN_STATUS.RUNNING
    await repo.updateCampaignWithStatusGuard(campaignId, { status: afterPublishStatus }, CAMPAIGN_STATUS.AWAITING_PUBLISHERS)
    await repo.createReviewLog(campaignId, adminId, REVIEW_ACTIONS.APPROVED, CAMPAIGN_STATUS.AWAITING_PUBLISHERS,
      `Admin force go-live with ${acceptedRequests.length} publishers — campaign ${afterPublishStatus === CAMPAIGN_STATUS.RUNNING ? 'running' : 'scheduled'}`)

    return repo.findCampaignById(campaignId)
  })
}

export async function forceCancelCampaign(adminId, campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.status !== CAMPAIGN_STATUS.AWAITING_PUBLISHERS) {
    throw new ValidationError('Campaign must be in awaiting_publishers status')
  }

  return await transaction(async () => {
    // Cancel all publisher requests
    const allRequests = await repo.findPublisherRequestsByCampaignId(campaignId)
    for (const r of allRequests) {
      if (r.status === 'pending') {
        await repo.updatePublisherRequestStatus(r.id, 'cancelled', new Date().toISOString().slice(0, 19).replace('T', ' '))
      }
    }

    // Refund full escrow
    if (campaign.escrowAmount > 0) {
      const coinService = await import('../../../shared/services/coin.service.js')
      await coinService.refund(campaign.clientId, campaign.escrowAmount, 'campaign_escrow', campaignId,
        `Refund: campaign cancelled by admin — ${campaign.name}`)
    }

    // Transition to cancelled
    await repo.updateCampaignWithStatusGuard(campaignId, {
      status: CAMPAIGN_STATUS.CANCELLED,
      metaError: `Cancelled by admin while awaiting publishers`,
    }, CAMPAIGN_STATUS.AWAITING_PUBLISHERS)

    await repo.createReviewLog(campaignId, adminId, REVIEW_ACTIONS.CANCELLED, CAMPAIGN_STATUS.AWAITING_PUBLISHERS,
      'Admin force cancelled campaign while awaiting publishers')

    return repo.findCampaignById(campaignId)
  })
}

export async function getPublisherProgress(campaignId, userId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.clientId !== userId) throw new ForbiddenError('Not your campaign')

  const publisherRequests = await repo.findPublisherRequestsByCampaignId(campaignId)

  const counts = {
    totalRequested: campaign.publisherCount || 0,
    accepted: publisherRequests.filter(r => r.status === 'accepted').length,
    published: publisherRequests.filter(r => r.status === 'published').length,
    pending: publisherRequests.filter(r => r.status === 'pending').length,
    rejected: publisherRequests.filter(r => r.status === 'rejected').length,
    failed: publisherRequests.filter(r => r.status === 'failed').length,
    cancelled: publisherRequests.filter(r => r.status === 'cancelled').length,
  }

  return {
    counts,
    publishers: publisherRequests.map(r => ({
      id: r.id,
      publisherId: r.publisherId,
      publisherEmail: r.publisherEmail,
      publisherFirstName: r.publisherFirstName,
      publisherLastName: r.publisherLastName,
      coinsOffered: r.coinsOffered,
      status: r.status,
      respondedAt: r.respondedAt,
      publishedAt: r.publishedAt,
    })),
  }
}

export async function getCampaignInsights(userId, campaignId, datePreset = 'last_30d') {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.clientId !== userId) throw new ForbiddenError('Not your campaign')

  const metaObjects = await repo.findMetaObjectsByCampaignId(campaignId)
  const fbCampaignObjs = metaObjects.filter(o => o.objectType === 'facebook_campaign')
  if (!fbCampaignObjs.length) throw new ValidationError('Campaign has no Meta objects yet')

  const systemToken = process.env.META_SYSTEM_USER_TOKEN
  if (!systemToken) throw new ValidationError('Meta system token not configured')

  let insights = []
  let triedObjectIds = []

  for (const obj of fbCampaignObjs) {
    triedObjectIds.push(obj.objectId)
    insights = await getCampaignInsightsFromMeta(obj.objectId, systemToken, datePreset)
    if (insights && insights.length > 0) break
  }

  if (!insights || insights.length === 0) {
    await logMetaEvent({
      campaignId, action: 'get_insights',
      params: { objectIds: triedObjectIds, datePreset, resultCount: 0 },
      error: 'Empty insights response from Meta for all facebook_campaign objects',
    })
  }

  return insights
}
