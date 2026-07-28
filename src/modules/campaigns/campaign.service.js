import * as repo from './campaign.repository.js'
import { generateUuid } from '../../../shared/utils/uuid.utils.js'
import { NotFoundError, ValidationError, ForbiddenError } from '../../../shared/errors/AppError.js'
import { CAMPAIGN_STATUS, VALID_TRANSITIONS, REVIEW_ACTIONS } from './campaign.model.js'
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
} from '../../../shared/services/meta-ads.service.js'
import { logMetaEvent } from '../../../shared/services/meta-logger.service.js'
import { transaction, queryOne } from '../../../shared/database/connection.js'

let cachedCoinRate = null

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
  let updated
  await transaction(async () => {
    await coinService.spend(userId, totalDeduction, 'campaign_escrow', campaignId, `Campaign escrow: ${campaign.name}`)

    updated = await repo.updateCampaignWithStatusGuard(campaignId, {
      status: CAMPAIGN_STATUS.SCHEDULED,
      escrowAmount: totalEscrow,
      coinsEscrowedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      clientConfirmed: true,
      clientConfirmedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    }, CAMPAIGN_STATUS.APPROVED)

    await repo.createReviewLog(campaignId, userId, REVIEW_ACTIONS.CONFIRMED, CAMPAIGN_STATUS.APPROVED, 'Client confirmed admin adjustments')

    if (campaign.categoryId && campaign.publisherCount && campaign.coinsPerPublisher) {
      await createPublisherRequestsForCampaign(campaignId, campaign.categoryId, campaign.publisherCount, campaign.coinsPerPublisher)
    }
  })

  const publishResult = await publishAdForClient(campaignId)
  if (publishResult.success) {
    const activateResult = await activateAllMetaObjects(campaignId)
    if (activateResult.success) {
      const scheduledAt = campaign.scheduledAt ? new Date(campaign.scheduledAt) : null
      const isFutureSchedule = scheduledAt && scheduledAt.getTime() > Date.now()
      const afterPublishStatus = isFutureSchedule ? CAMPAIGN_STATUS.SCHEDULED : CAMPAIGN_STATUS.RUNNING
      await repo.updateCampaignWithStatusGuard(campaignId, { status: afterPublishStatus }, CAMPAIGN_STATUS.SCHEDULED)
      await repo.createReviewLog(campaignId, userId, REVIEW_ACTIONS.CONFIRMED, CAMPAIGN_STATUS.SCHEDULED,
        `Campaign ${afterPublishStatus === CAMPAIGN_STATUS.RUNNING ? 'is now running' : 'scheduled'}`)
    }
  }

  return updated
}

function calculateTotalEscrow(campaign) {
  const publisherCost = (campaign.publisherCount || 0) * (campaign.coinsPerPublisher || 0)
  const platformFee = Math.round(publisherCost * 0.1)
  return publisherCost + platformFee
}

function calculateAdBudget(metaSettings, publisherCount) {
  return (metaSettings?.budgetAmount || 1000) * ((publisherCount || 0) + 1)
}

async function createPublisherRequestsForCampaign(campaignId, categoryId, targetCount, coinsPerPublisher) {
  const publishers = await findActivePublishersByCategoryId(categoryId)
  const selected = publishers.slice(0, targetCount)
  if (selected.length === 0) return

  await repo.createPublisherRequests(campaignId, selected.map(p => p.publisherId), coinsPerPublisher)
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
  const coinBudget = metaSettings?.budgetAmount || 1000
  const budgetInINR = Math.round(coinBudget * coinRate)
  const isDaily = metaSettings?.budgetType === 'daily' || !metaSettings?.budgetType
  const MIN_BUDGET_INR = 100
  if (budgetInINR < MIN_BUDGET_INR) {
    const label = isDaily ? 'daily' : 'lifetime'
    const minCoins = Math.ceil(MIN_BUDGET_INR / coinRate)
    const error = `Minimum ${label} budget is ₹${MIN_BUDGET_INR} (${minCoins} coins at current conversion rate)`
    await logMetaEvent({ campaignId, userId, action: 'create_all', error })
    return { success: false, error }
  }

  const fbCampaignName = `FlowX-${campaign.name}-${campaignId.substring(0, 8)}`

  try {
    const t0 = Date.now()
    const spendCapInPaise = metaSettings?.spendCap ? Math.round(metaSettings.spendCap * coinRate * 100) : null
    const fbCampaign = await createAdCampaign(
      adAccountId,
      fbCampaignName,
      metaSettings?.objective || 'OUTCOME_TRAFFIC',
      'PAUSED',
      systemToken,
      { spendCap: spendCapInPaise },
    )
    await repo.createMetaObject(campaignId, 'facebook_campaign', fbCampaign.id, null, 'PAUSED')
    await logMetaEvent({
      campaignId, userId, action: 'create_campaign', objectType: 'facebook_campaign', objectId: fbCampaign.id, params: { name: fbCampaignName, objective: metaSettings?.objective }, durationMs: Date.now() - t0,
    })

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
    if (!geo?.countries?.length) {
      if (!geo) targeting.geo_locations = { countries: ['IN'] }
      else targeting.geo_locations.countries = ['IN']
    }
    if (geo?.custom_locations?.length) {
      delete geo.regions
      delete geo.cities
      delete geo.zips
    }

    if (targeting.age_min && targeting.age_max && targeting.age_min > targeting.age_max) {
      targeting.age_max = targeting.age_min
    }

    const t1 = Date.now()
    const fbAdSet = await createAdSet(
      adAccountId,
      fbCampaign.id,
      targeting,
      {
        budgetType: metaSettings?.budgetType || 'daily',
        budgetAmount: budgetInINR,
        bidStrategy: metaSettings?.bidStrategy || 'LOWEST_COST_WITHOUT_CAP',
        optimizationGoal: metaSettings?.optimizationGoal || 'REACH',
        billingEvent: metaSettings?.billingEvent || null,
        promotedPageId: pageId,
      },
      (() => {
        const s = {}
        if (campaign.scheduledAt) s.startTime = Math.floor(new Date(campaign.scheduledAt).getTime() / 1000)
        if (metaSettings?.endTime) s.endTime = Math.floor(new Date(metaSettings.endTime).getTime() / 1000)
        return s
      })(),
      metaSettings?.platformPlacement || {},
      systemToken,
    )
    await repo.createMetaObject(campaignId, 'ad_set', fbAdSet.id, null, 'PAUSED')
    await logMetaEvent({
      campaignId, userId, action: 'create_ad_set', objectType: 'ad_set', objectId: fbAdSet.id, params: { campaignId: fbCampaign.id }, durationMs: Date.now() - t1,
    })

    const t2 = Date.now()
    const fbCreative = await createAdCreative(
      adAccountId,
      pageId,
      creative?.caption || creative?.textBody || campaign.name,
      creative?.mediaUrl || null,
      creative?.callToAction || null,
      systemToken,
      { headline: creative?.headline, description: creative?.description },
    )
    await repo.createMetaObject(campaignId, 'ad_creative', fbCreative.id, null, null)
    await logMetaEvent({
      campaignId, userId, action: 'create_creative', objectType: 'ad_creative', objectId: fbCreative.id, params: { pageId }, durationMs: Date.now() - t2,
    })

    const t3 = Date.now()
    const urlTags = buildUrlTags(creative)
    const fbAd = await createAd(
      adAccountId,
      fbAdSet.id,
      fbCreative.id,
      fbCampaignName,
      systemToken,
      'PAUSED',
      { urlTags },
    )
    await repo.createMetaObject(campaignId, 'ad', fbAd.id, null, 'PAUSED')
    await logMetaEvent({
      campaignId, userId, action: 'create_ad', objectType: 'ad', objectId: fbAd.id, params: { adSetId: fbAdSet.id, creativeId: fbCreative.id }, durationMs: Date.now() - t3,
    })

    return { success: true }
  } catch (error) {
    await logMetaEvent({ campaignId, userId, action: 'create_all', error: error.message })
    return { success: false, error: error.message }
  }
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
    updateData.status = afterPublishStatus

    let updated
    await transaction(async () => {
      updated = await repo.updateCampaignWithStatusGuard(campaignId, updateData, CAMPAIGN_STATUS.PENDING_REVIEW)
      await repo.createReviewLog(campaignId, adminId, REVIEW_ACTIONS.APPROVED, campaign.status, data.notes || null)
      await coinService.spend(campaign.clientId, totalDeduction, 'campaign_escrow', campaignId, `Campaign escrow: ${campaign.name}`)
      if (campaign.categoryId && campaign.publisherCount && campaign.coinsPerPublisher) {
        await createPublisherRequestsForCampaign(campaignId, campaign.categoryId, campaign.publisherCount, campaign.coinsPerPublisher)
      }
    })

    return updated
  }

  let updated
  await transaction(async () => {
    updated = await repo.updateCampaignWithStatusGuard(campaignId, updateData, CAMPAIGN_STATUS.PENDING_REVIEW)
    await repo.createReviewLog(campaignId, adminId, REVIEW_ACTIONS.APPROVED, campaign.status, data.notes || null)
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

async function tryTransitionToRunning(campaignId) {
  const publishedCount = await repo.countPublisherRequestsByStatus(campaignId, 'published')
  if (publishedCount === 0) return

  const pendingCount = await repo.countPublisherRequestsByStatus(campaignId, 'pending')
  const acceptedCount = await repo.countPublisherRequestsByStatus(campaignId, 'accepted')

  if (pendingCount === 0 && acceptedCount === 0) {
    await repo.updateCampaignStatus(campaignId, CAMPAIGN_STATUS.RUNNING)
    await repo.createReviewLog(campaignId, null, REVIEW_ACTIONS.SUBMITTED, CAMPAIGN_STATUS.SCHEDULED, 'Campaign is now running on publisher pages')
  }
}

export async function acceptPublisherRequest(publisherId, requestId) {
  const request = await repo.findPublisherRequestById(requestId)
  if (!request) throw new NotFoundError('Request not found')
  if (request.publisherId !== publisherId) throw new ForbiddenError('Not your request')
  if (request.status !== 'pending') throw new ValidationError('Request is no longer pending')

  const campaign = await repo.findCampaignById(request.campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')

  return await transaction(async () => {
    const acceptedCount = await repo.countPublisherRequestsByStatus(request.campaignId, 'accepted')
    if (acceptedCount >= (campaign.publisherCount || Infinity)) {
      throw new ValidationError('Publisher capacity reached for this campaign')
    }
    await repo.updatePublisherRequestStatusWithGuard(requestId, 'accepted', new Date().toISOString().slice(0, 19).replace('T', ' '), 'pending')

    const page = await repo.findVerifiedFacebookPage(publisherId)
    if (page) {
      const result = await createMetaAdObjectsForUser(request.campaignId, publisherId, page.platformUserId)
      if (result.success) {
        await repo.updatePublisherRequestPublishedWithGuard(requestId, 'accepted')
      } else {
        await repo.updatePublisherRequestStatusWithGuard(requestId, 'failed', new Date().toISOString().slice(0, 19).replace('T', ' '), 'accepted')
      }
    } else {
      console.warn(`Publisher ${publisherId} has no verified Facebook page — marking request as failed`)
      await repo.updatePublisherRequestStatusWithGuard(requestId, 'failed', new Date().toISOString().slice(0, 19).replace('T', ' '), 'accepted')
    }

    const newAcceptedCount = await repo.countPublisherRequestsByStatus(request.campaignId, 'accepted')

    if (newAcceptedCount >= (campaign.publisherCount || Infinity)) {
      const pendingRequests = await repo.findPublisherRequestsByStatus(request.campaignId, 'pending')
      for (const p of pendingRequests) {
        await repo.updatePublisherRequestStatusWithGuard(p.id, 'rejected', new Date().toISOString().slice(0, 19).replace('T', ' '), 'pending')
      }
    }

    await tryTransitionToRunning(request.campaignId)

    return repo.findPublisherRequestById(requestId)
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
    return result
  })
}

export async function activateAllMetaObjects(campaignId) {
  const systemToken = process.env.META_SYSTEM_USER_TOKEN
  if (!systemToken) {
    await logMetaEvent({ campaignId, action: 'activate_all', error: 'META_SYSTEM_USER_TOKEN not configured' })
    return { success: false, error: 'Meta system token not configured' }
  }

  const objects = await repo.findMetaObjectsByCampaignId(campaignId)

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

export async function getCampaignInsights(userId, campaignId, datePreset = 'last_7d') {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.clientId !== userId) throw new ForbiddenError('Not your campaign')

  const metaObjects = await repo.findMetaObjectsByCampaignId(campaignId)
  const fbCampaignObj = metaObjects.find(o => o.objectType === 'facebook_campaign')
  if (!fbCampaignObj) throw new ValidationError('Campaign has no Meta objects yet')

  const systemToken = process.env.META_SYSTEM_USER_TOKEN
  if (!systemToken) throw new ValidationError('Meta system token not configured')

  return getCampaignInsightsFromMeta(fbCampaignObj.objectId, systemToken, datePreset)
}
