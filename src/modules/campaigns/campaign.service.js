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
} from '../../../shared/services/meta-ads.service.js'



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
  if (campaign.status !== CAMPAIGN_STATUS.DRAFT) {
    throw new ValidationError('Can only edit campaigns in draft status')
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

  const subService = await import('../subscriptions/subscription.service.js')
  await subService.consumeUsage(userId, 'campaigns', 'campaign', campaignId)

  const updated = await repo.updateCampaign(campaignId, { status: CAMPAIGN_STATUS.PENDING_REVIEW })
  await repo.createReviewLog(campaignId, userId, REVIEW_ACTIONS.SUBMITTED, campaign.status, null)

  return updated
}

export async function cancelCampaign(userId, campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.clientId !== userId) throw new ForbiddenError('Not your campaign')
  assertValidTransition(campaign.status, CAMPAIGN_STATUS.CANCELLED)

  const updated = await repo.updateCampaign(campaignId, { status: CAMPAIGN_STATUS.CANCELLED })
  await repo.createReviewLog(campaignId, userId, REVIEW_ACTIONS.CANCELLED, campaign.status, null)

  const NO_REFUND_STATUSES = [CAMPAIGN_STATUS.DRAFT, CAMPAIGN_STATUS.SCHEDULED, CAMPAIGN_STATUS.RUNNING, CAMPAIGN_STATUS.COMPLETED]
  if (!NO_REFUND_STATUSES.includes(campaign.status)) {
    const subService = await import('../subscriptions/subscription.service.js')
    await subService.refundUsage(userId, 'campaigns', 'campaign', campaignId)
  }

  return updated
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
  const coinService = await import('../../../shared/services/coin.service.js')
  await coinService.spend(userId, totalEscrow, 'campaign_escrow', campaignId, `Campaign escrow: ${campaign.name}`)

  const updated = await repo.updateCampaign(campaignId, {
    status: CAMPAIGN_STATUS.SCHEDULED,
    escrowAmount: totalEscrow,
    coinsEscrowedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    clientConfirmed: true,
    clientConfirmedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
  })

  await repo.createReviewLog(campaignId, userId, REVIEW_ACTIONS.CONFIRMED, CAMPAIGN_STATUS.APPROVED, 'Client confirmed admin adjustments')

  if (campaign.categoryId && campaign.publisherCount && campaign.coinsPerPublisher) {
    const subService = await import('../subscriptions/subscription.service.js')
    const limit = await subService.getLimit(userId, 'publishers_per_campaign')
    if (campaign.publisherCount > limit) {
      throw new ValidationError(`Publisher count exceeds your plan limit of ${limit} publishers per campaign`)
    }
    await createPublisherRequestsForCampaign(campaignId, campaign.categoryId, campaign.publisherCount, campaign.coinsPerPublisher)
  }

  await publishAdForClient(campaignId)

  return updated
}

function calculateTotalEscrow(campaign) {
  const publisherCost = (campaign.publisherCount || 0) * (campaign.coinsPerPublisher || 0)
  const platformFee = Math.round(publisherCost * 0.1)
  return publisherCost + platformFee
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
    console.error('META_AD_ACCOUNT_ID or META_SYSTEM_USER_TOKEN not configured')
    return { success: false, error: 'Meta Ads not configured' }
  }

  const [campaign, creative, metaSettings] = await Promise.all([
    repo.findCampaignById(campaignId),
    repo.findCreativeByCampaignId(campaignId),
    repo.findMetaSettingsByCampaignId(campaignId),
  ])

  if (!campaign) return { success: false, error: 'Campaign not found' }

  const fbCampaignName = `FlowX-${campaign.name}-${campaignId.substring(0, 8)}`

  try {
    const fbCampaign = await createAdCampaign(
      adAccountId,
      fbCampaignName,
      metaSettings?.objective || 'OUTCOME_TRAFFIC',
      'PAUSED',
      systemToken,
    )
    await repo.createMetaObject(campaignId, 'facebook_campaign', fbCampaign.id, null, null)

    const fbAdSet = await createAdSet(
      adAccountId,
      fbCampaign.id,
      metaSettings?.targeting || {},
      {
        budgetType: metaSettings?.budgetType || 'daily',
        budgetAmount: metaSettings?.budgetAmount || 1000,
        bidStrategy: metaSettings?.bidStrategy || 'LOWEST_COST_WITHOUT_CAP',
        optimizationGoal: metaSettings?.optimizationGoal || 'REACH',
      },
      campaign.scheduledAt ? { startTime: Math.floor(new Date(campaign.scheduledAt).getTime() / 1000) } : {},
      metaSettings?.platformPlacement || {},
      systemToken,
    )
    await repo.createMetaObject(campaignId, 'ad_set', fbAdSet.id, null, null)

    const fbCreative = await createAdCreative(
      adAccountId,
      pageId,
      creative?.caption || creative?.textBody || campaign.name,
      creative?.mediaUrl || null,
      creative?.callToAction || null,
      systemToken,
    )
    await repo.createMetaObject(campaignId, 'ad_creative', fbCreative.id, null, null)

    const fbAd = await createAd(
      adAccountId,
      fbAdSet.id,
      fbCreative.id,
      fbCampaignName,
      systemToken,
      'ACTIVE',
    )
    await repo.createMetaObject(campaignId, 'ad', fbAd.id, null, null)

    return { success: true }
  } catch (error) {
    console.error('Meta Ads API error for user', userId, ':', error.message)
    return { success: false, error: error.message }
  }
}

async function publishAdForClient(campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) return

  const page = await repo.findVerifiedFacebookPage(campaign.clientId)
  if (!page) {
    console.warn(`Client ${campaign.clientId} has no verified Facebook page — skipping client ad`)
    return
  }

  await createMetaAdObjectsForUser(campaignId, campaign.clientId, page.platformUserId)
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
    if (available.total < escrowAmount) {
      throw new ValidationError('Client has insufficient coins for escrow. Campaign cannot be approved.')
    }
    updateData.escrowAmount = escrowAmount
    updateData.coinsEscrowedAt = new Date().toISOString().slice(0, 19).replace('T', ' ')
  }

  const updated = await repo.updateCampaign(campaignId, updateData)
  await repo.createReviewLog(campaignId, adminId, REVIEW_ACTIONS.APPROVED, campaign.status, data.notes || null)

  if (!hasAdjustments) {
    const coinService = await import('../../../shared/services/coin.service.js')
    await coinService.spend(campaign.clientId, escrowAmount, 'campaign_escrow', campaignId, `Campaign escrow: ${campaign.name}`)

    if (campaign.categoryId && campaign.publisherCount && campaign.coinsPerPublisher) {
      await createPublisherRequestsForCampaign(campaignId, campaign.categoryId, campaign.publisherCount, campaign.coinsPerPublisher)
    }

    await publishAdForClient(campaignId)
  }

  return updated
}

export async function rejectCampaign(adminId, campaignId, data) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.status !== CAMPAIGN_STATUS.PENDING_REVIEW) {
    throw new ValidationError('Campaign must be in pending review status')
  }

  const updated = await repo.updateCampaign(campaignId, {
    status: CAMPAIGN_STATUS.REJECTED,
    reviewedBy: adminId,
    reviewedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    reviewNotes: data.notes || 'Rejected',
  })

  await repo.createReviewLog(campaignId, adminId, REVIEW_ACTIONS.REJECTED, campaign.status, data.notes || null)

  const NO_REFUND_STATUSES = [CAMPAIGN_STATUS.DRAFT, CAMPAIGN_STATUS.SCHEDULED, CAMPAIGN_STATUS.RUNNING, CAMPAIGN_STATUS.COMPLETED]
  if (!NO_REFUND_STATUSES.includes(campaign.status)) {
    const subService = await import('../subscriptions/subscription.service.js')
    await subService.refundUsage(campaign.clientId, 'campaigns', 'campaign', campaignId)
  }

  return updated
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

  const acceptedCount = await repo.countPublisherRequestsByStatus(request.campaignId, 'accepted')
  if (acceptedCount >= (campaign.publisherCount || Infinity)) {
    throw new ValidationError('Publisher capacity reached for this campaign')
  }

  await repo.updatePublisherRequestStatus(requestId, 'accepted', new Date().toISOString().slice(0, 19).replace('T', ' '))

  const page = await repo.findVerifiedFacebookPage(publisherId)
  if (page) {
    const result = await createMetaAdObjectsForUser(request.campaignId, publisherId, page.platformUserId)
    if (result.success) {
      await repo.updatePublisherRequestPublished(requestId)
    } else {
      await repo.updatePublisherRequestStatus(requestId, 'failed', new Date().toISOString().slice(0, 19).replace('T', ' '))
    }
  } else {
    console.warn(`Publisher ${publisherId} has no verified Facebook page — marking request as failed`)
    await repo.updatePublisherRequestStatus(requestId, 'failed', new Date().toISOString().slice(0, 19).replace('T', ' '))
  }

  const newAcceptedCount = await repo.countPublisherRequestsByStatus(request.campaignId, 'accepted')

  if (newAcceptedCount >= (campaign.publisherCount || Infinity)) {
    const pendingRequests = await repo.findPublisherRequestsByStatus(request.campaignId, 'pending')
    for (const p of pendingRequests) {
      await repo.updatePublisherRequestStatus(p.id, 'rejected', new Date().toISOString().slice(0, 19).replace('T', ' '))
    }
  }

  await tryTransitionToRunning(request.campaignId)

  return repo.findPublisherRequestById(requestId)
}

export async function rejectPublisherRequest(publisherId, requestId) {
  const request = await repo.findPublisherRequestById(requestId)
  if (!request) throw new NotFoundError('Request not found')
  if (request.publisherId !== publisherId) throw new ForbiddenError('Not your request')
  if (request.status !== 'pending') throw new ValidationError('Request is no longer pending')

  await repo.updatePublisherRequestStatus(requestId, 'rejected', new Date().toISOString().slice(0, 19).replace('T', ' '))
  return repo.findPublisherRequestById(requestId)
}

export async function completePublisherRequest(campaignId, requestId) {
  const request = await repo.findPublisherRequestById(requestId)
  if (!request) throw new NotFoundError('Request not found')

  await repo.updatePublisherRequestStatus(requestId, 'completed', new Date().toISOString().slice(0, 19).replace('T', ' '))
  await addCoins(request.publisherId, request.coinsOffered)
  await createTransaction(generateUuid(), request.publisherId, `Campaign payout: ${request.campaignName}`, request.coinsOffered, 'credit', 'campaign', campaignId)

  return repo.findPublisherRequestById(requestId)
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
