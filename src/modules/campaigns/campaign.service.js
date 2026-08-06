import * as repo from './campaign.repository.js'
import { generateUuid } from '../../../shared/utils/uuid.utils.js'
import { NotFoundError, ValidationError, ForbiddenError } from '../../../shared/errors/AppError.js'
import { CAMPAIGN_STATUS, VALID_TRANSITIONS, REVIEW_ACTIONS, CAMPAIGN_JOB_TYPES, META_STATUS, BILLING_ENTRY_KINDS } from './campaign.model.js'
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
  listAccountAds,
  getCampaignStatusesBatch,
  getAdAccount,
  createInsightsReport,
  getInsightsReport,
  getInsightsReportData,
  extractMetaError,
} from '../../../shared/services/meta-ads.service.js'
import { logMetaEvent } from '../../../shared/services/meta-logger.service.js'
import { transaction, queryOne } from '../../../shared/database/connection.js'
import { isRateLimited, isSoftThrottled, getRateLimitState, getAllRateLimitStates } from '../../../shared/services/meta-rate-limiter.js'
import { sendAdminAlert, sendPublisherRepublishNotification } from '../../../shared/mailer/alert.mailer.js'

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

function envTokenFor(account) {
  if (account?.metaAccountId === process.env.META_AD_ACCOUNT_ID && process.env.META_SYSTEM_USER_TOKEN) {
    return process.env.META_SYSTEM_USER_TOKEN
  }
  return account?.accessToken || null
}

export async function resolveAccountContext(metaAccountId) {
  if (metaAccountId) {
    const account = await repo.findMetaAdAccountByMetaId(metaAccountId)
    if (account?.id) {
      return { accountId: account.metaAccountId, accessToken: envTokenFor(account), accountDbId: account.id }
    }
    return { accountId: metaAccountId, accessToken: process.env.META_SYSTEM_USER_TOKEN || null, accountDbId: null }
  }
  const primary = await repo.findPrimaryMetaAdAccount()
  if (primary?.id) {
    return { accountId: primary.metaAccountId, accessToken: envTokenFor(primary), accountDbId: primary.id }
  }
  return { accountId: process.env.META_AD_ACCOUNT_ID || null, accessToken: process.env.META_SYSTEM_USER_TOKEN || null, accountDbId: null }
}

export async function getCampaignAccountContext(campaignId) {
  const account = await repo.findCampaignAdAccount(campaignId)
  if (account?.id) {
    return { accountId: account.metaAccountId, accessToken: envTokenFor(account), accountDbId: account.id }
  }
  return resolveAccountContext(process.env.META_AD_ACCOUNT_ID)
}

export async function getSyncableAccounts() {
  const accounts = await repo.listMetaAdAccounts({ activeOnly: true })
  if (accounts.length) {
    return accounts.map(a => ({ accountId: a.metaAccountId, accountDbId: a.id }))
  }
  if (process.env.META_AD_ACCOUNT_ID) {
    return [{ accountId: process.env.META_AD_ACCOUNT_ID, accountDbId: null }]
  }
  return []
}

async function pickAdAccountForAssignment() {
  const accounts = await repo.listMetaAdAccounts({ activeOnly: true })
  if (!accounts.length) return null
  const charges = await repo.sumChargedBudgetByAccount()
  const counts = await repo.countCampaignsByAccount()
  const scored = accounts.map(a => {
    const spent = charges[a.id] || 0
    const ratio = a.monthlyCapPaise > 0 ? spent / a.monthlyCapPaise : 0
    const eligible = a.monthlyCapPaise === 0 || spent < a.monthlyCapPaise
    return { account: a, ratio, eligible, count: counts[a.id] || 0 }
  })
  const pool = scored.filter(s => s.eligible)
  const candidates = (pool.length ? pool : scored).slice()
  candidates.sort((a, b) => (a.ratio - b.ratio) || (a.count - b.count) || (a.account.isPrimary ? -1 : 1))
  return candidates[0].account
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
  const account = await pickAdAccountForAssignment()
  const campaign = await repo.createCampaign(id, userId, { ...data, adAccountId: account?.id || null })
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

  const originalStatus = campaign.status
  const blockedStatuses = [
    CAMPAIGN_STATUS.APPROVED,
    CAMPAIGN_STATUS.SCHEDULED,
    CAMPAIGN_STATUS.RUNNING,
    CAMPAIGN_STATUS.COMPLETED,
    CAMPAIGN_STATUS.CANCELLED,
    CAMPAIGN_STATUS.ARCHIVED,
    CAMPAIGN_STATUS.AWAITING_PUBLISHERS,
  ]
  if (blockedStatuses.includes(campaign.status)) {
    throw new ValidationError('Cannot edit campaign in its current status')
  }

  if (campaign.status !== CAMPAIGN_STATUS.DRAFT) {
    data.status = CAMPAIGN_STATUS.DRAFT

    return await transaction(async () => {
      const updated = await repo.updateCampaign(campaignId, data)
      const subService = await import('../subscriptions/subscription.service.js')
      await subService.refundUsage(userId, 'campaigns', 'campaign', campaignId)

      if (originalStatus === CAMPAIGN_STATUS.FAILED) {
        const pubRequests = await repo.findPublisherRequestsByCampaignId(campaignId)
        const creative = await repo.findCreativeByCampaignId(campaignId)
        for (const req of pubRequests) {
          if (req.status === 'published') {
            await repo.updatePublisherRequest(req.id, {
              status: 'pending_republish',
              creativeSnapshot: creative ? JSON.stringify(creative) : null,
            })
            await sendPublisherRepublishNotification(req.publisherId, campaignId, campaign.name)
          } else {
            await repo.updatePublisherRequest(req.id, {
              creativeSnapshot: creative ? JSON.stringify(creative) : null,
            })
          }
        }
      }

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
      const spendSplit = await coinService.spend(campaign.clientId, totalDeduction, 'campaign_escrow', campaignId, `Campaign escrow: ${campaign.name}`)

      await repo.updateCampaignWithStatusGuard(campaignId, {
        status: CAMPAIGN_STATUS.SCHEDULED,
        escrowAmount: totalEscrow,
        coinsEscrowedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
        clientConfirmed: true,
        clientConfirmedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      }, CAMPAIGN_STATUS.APPROVED)

      await repo.createReviewLog(campaignId, userId, REVIEW_ACTIONS.CONFIRMED, CAMPAIGN_STATUS.APPROVED, 'Client confirmed admin adjustments')

      if (adBudgetCost > 0) {
        const coinRate = await getCoinConversionRate()
        const chargedPaise = Math.round(adBudgetCost * coinRate * 100)
        await repo.updateCampaign(campaignId, { chargedAdBudgetPaise: chargedPaise })
        await repo.insertBillingEntry(campaignId, {
          kind: BILLING_ENTRY_KINDS.CHARGE,
          paise: chargedPaise,
          coins: adBudgetCost,
          rate: coinRate,
          paidFromMonthly: spendSplit.fromMonthly,
          paidFromWallet: spendSplit.fromWallet,
          reason: `Meta ad budget charge: ${campaign.name}`,
        })
      }
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
  const [campaign, creative, metaSettings] = await Promise.all([
    repo.findCampaignById(campaignId),
    repo.findCreativeByCampaignId(campaignId),
    repo.findMetaSettingsByCampaignId(campaignId),
  ])

  if (!campaign) {
    await logMetaEvent({ campaignId, userId, action: 'create_all', error: 'Campaign not found' })
    return { success: false, error: 'Campaign not found' }
  }

  const { accountId: adAccountId, accessToken: systemToken } = await getCampaignAccountContext(campaignId)
  if (!adAccountId || !systemToken) {
    await logMetaEvent({ campaignId, userId, action: 'create_all', error: 'Meta Ads not configured' })
    return { success: false, error: 'Meta Ads not configured' }
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
  let cleanupError = null
  for (const obj of [...existingUserObjects].reverse()) {
    try {
      await META_ROLLBACK_FN[obj.objectType](obj.objectId, systemToken)
      await logMetaEvent({
        campaignId, userId, action: `delete_${obj.objectType}`, objectType: obj.objectType, objectId: obj.objectId,
      })
    } catch (err) {
      const cleanupDetail = extractMetaError(err)
      if (cleanupDetail?.code === 100) {
        await logMetaEvent({
          campaignId, userId, action: `delete_${obj.objectType}`, objectType: obj.objectType, objectId: obj.objectId, error: 'already deleted',
        })
        continue
      }
      cleanupError = err
      await logMetaEvent({
        campaignId, userId, action: `delete_${obj.objectType}`, objectType: obj.objectType, objectId: obj.objectId, error: err.message,
      })
      break
    }
  }
  if (cleanupError) {
    const message = `Existing Meta objects not cleaned up — aborting create: ${cleanupError.message}`
    await logMetaEvent({ campaignId, userId, action: 'create_all', error: message })
    return { success: false, error: message }
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

  const { accountId: adAccountId, accessToken: systemToken } = await resolveAccountContext()
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
    const spendSplit = await coinService.spend(campaign.clientId, totalDeduction, 'campaign_escrow', campaignId, `Campaign escrow: ${campaign.name}`)
    if (adBudgetCost > 0) {
      const coinRate = await getCoinConversionRate()
      const chargedPaise = Math.round(adBudgetCost * coinRate * 100)
      await repo.updateCampaign(campaignId, { chargedAdBudgetPaise: chargedPaise })
      await repo.insertBillingEntry(campaignId, {
        kind: BILLING_ENTRY_KINDS.CHARGE,
        paise: chargedPaise,
        coins: adBudgetCost,
        rate: coinRate,
        paidFromMonthly: spendSplit.fromMonthly,
        paidFromWallet: spendSplit.fromWallet,
        reason: `Meta ad budget charge: ${campaign.name}`,
      })
    }
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

  const { accountId, accessToken } = await getCampaignAccountContext(campaignId)
  if (!accountId || !accessToken) {
    throw new ValidationError('Meta Ads not configured — add a meta ad account or set META_AD_ACCOUNT_ID and META_SYSTEM_USER_TOKEN')
  }

  const queuedJob = await enqueueCampaignJob(campaignId, CAMPAIGN_JOB_TYPES.RETRY_META)
  return { queued: true, jobId: queuedJob.jobId }
}

export async function retryCampaignMeta(campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')

  const { accountId: adAccountId, accessToken: systemToken } = await getCampaignAccountContext(campaignId)

  if (!adAccountId || !systemToken) {
    throw new ValidationError('Meta Ads not configured — add a meta ad account or set META_AD_ACCOUNT_ID and META_SYSTEM_USER_TOKEN')
  }

  const existingObjects = await repo.findMetaObjectsByCampaignId(campaignId)

  const deleteOrder = ['ad', 'ad_creative', 'ad_set', 'facebook_campaign']
  for (const objType of deleteOrder) {
    const objects = existingObjects.filter(o => o.objectType === objType)
    for (const obj of objects) {
      try {
        await META_ROLLBACK_FN[objType](obj.objectId, systemToken)
        await logMetaEvent({
          campaignId, action: `delete_${objType}`, objectType: objType, objectId: obj.objectId,
        })
      } catch (err) {
        const cleanupDetail = extractMetaError(err)
        if (cleanupDetail?.code === 100) {
          await logMetaEvent({
            campaignId, action: `delete_${objType}`, objectType: objType, objectId: obj.objectId, error: 'already deleted',
          })
          continue
        }
        await logMetaEvent({
          campaignId, action: `delete_${objType}`, objectType: objType, objectId: obj.objectId, error: err.message,
        })
        throw new Error(`Existing Meta objects not cleaned up — aborting retry: ${err.message}`)
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
  const { accessToken: systemToken } = await getCampaignAccountContext(campaignId)
  if (!systemToken) {
    await logMetaEvent({ campaignId, action: 'activate_all', error: 'Meta system token not configured' })
    return { success: false, error: 'Meta system token not configured' }
  }

  const objects = await repo.findMetaObjectsByCampaignId(campaignId)

  const groups = new Map()
  for (const obj of objects) {
    const key = obj.createdForUserId || 'none'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(obj)
  }

  const chains = []
  for (const group of groups.values()) {
    const resolved = resolveMetaObjects(group)
    if (resolved.facebook_campaign && resolved.ad_set && resolved.ad) {
      chains.push({ facebook_campaign: resolved.facebook_campaign, ad_set: resolved.ad_set, ad: resolved.ad })
    }
  }

  if (!chains.length) {
    await logMetaEvent({ campaignId, action: 'activate_all', error: 'No complete Meta object chains to activate' })
    return { success: false, error: 'No Meta objects to activate' }
  }

  const activateOrder = ['facebook_campaign', 'ad_set', 'ad']
  const results = []

  for (const chain of chains) {
    for (const objType of activateOrder) {
      const item = chain[objType]
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

export async function getCampaignInsights(userId, campaignId, query = {}) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.clientId !== userId) throw new ForbiddenError('Not your campaign')

  if (query?.refresh) {
    const enqueued = await repo.requeueAutoJob(campaignId, CAMPAIGN_JOB_TYPES.SYNC_INSIGHTS)
    return { queued: true, enqueued }
  }

  const from = query?.from || null
  const to = query?.to || null
  const rows = await repo.findDailyStats(campaignId, { from, to })

  return {
    cached: true,
    campaignId,
    rows,
    totalSpendPaise: rows.reduce((sum, r) => sum + r.spendPaise, 0),
    liveSpendPaise: campaign.metaSpentPaise || 0,
    chargedAdBudgetPaise: campaign.chargedAdBudgetPaise || 0,
    lastInsightsSyncAt: campaign.lastInsightsSyncAt || null,
    insightsError: campaign.insightsError || null,
  }
}

export async function enqueueAutoJob(campaignId, jobType, payload = {}, options = {}) {
  const enqueued = await repo.requeueAutoJob(campaignId, jobType, payload, options)
  return { enqueued }
}

export async function queueManualSettle(campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.settledAt) return { queued: false, alreadySettled: true }
  const jobId = generateUuid()
  const enqueued = await repo.enqueueCampaignJob(jobId, campaignId, CAMPAIGN_JOB_TYPES.SETTLE_CAMPAIGN)
  return { queued: true, jobId, enqueued }
}

const STATUS_SYNC_STALENESS_SECONDS = 120
const STATUS_SYNC_PAUSED_STALENESS_SECONDS = 3600
const INSIGHTS_SYNC_STALENESS_SECONDS = 3600
const SYNC_BATCH_LIMIT = 50
const ACCOUNT_SYNC_RUN_KEY_PREFIX = 'status:'
const ACCOUNT_INSIGHTS_RUN_KEY_PREFIX = 'insights:'
const RATE_LIMIT_BACKOFF_SECONDS = 300
const INSIGHTS_POLL_MIN_INTERVAL_MS = 60 * 1000

export async function scheduleCampaignSyncs() {
  if (isRateLimited()) {
    return { skipped: true, reason: 'rate_limited' }
  }
  const softThrottled = isSoftThrottled()
  const shedLimit = Number(process.env.META_SHED_ACCOUNT_LIMIT) || 3

  let accounts = await getSyncableAccounts()
  if (!accounts.length) return { skipped: true, reason: 'meta_not_configured' }

  let shedAccounts = []
  if (softThrottled) {
    if (accounts.length <= shedLimit) {
      return { skipped: true, reason: 'soft_throttled' }
    }
    const charges = await repo.sumChargedBudgetByAccount()
    const dbAccounts = await repo.listMetaAdAccounts({ activeOnly: true })
    const capMap = new Map(dbAccounts.map(a => [a.id, a.monthlyCapPaise]))
    accounts = accounts.map(a => ({
      ...a,
      ratio: capMap.get(a.accountDbId) > 0 ? (charges[a.accountDbId] || 0) / capMap.get(a.accountDbId) : 0,
    }))
    accounts.sort((x, y) => y.ratio - x.ratio)
    shedAccounts = accounts.slice(shedLimit)
    accounts = accounts.slice(0, shedLimit)
  }

  const statusDue = await repo.findCampaignsDueForStatusSync({
    stalenessSeconds: STATUS_SYNC_STALENESS_SECONDS,
    pausedStalenessSeconds: STATUS_SYNC_PAUSED_STALENESS_SECONDS,
    limit: SYNC_BATCH_LIMIT,
  })

  const insightsBatch = await repo.findDueInsightsBatch({
    stalenessSeconds: INSIGHTS_SYNC_STALENESS_SECONDS,
    limit: 100,
  })

  let statusEnqueued = 0
  let insightsEnqueued = 0
  for (const account of accounts) {
    if (statusDue.length > 0) {
      const runKey = `${ACCOUNT_SYNC_RUN_KEY_PREFIX}${account.accountId}`
      const pending = await repo.findAutoJobByRunKey(runKey)
      if (!pending) {
        const jitter = Math.floor(Math.random() * 60)
        await repo.requeueAutoJob(null, CAMPAIGN_JOB_TYPES.SYNC_ACCOUNT_STATUS, { adAccountId: account.accountId }, {
          runKey,
          runAfterSeconds: jitter,
        })
        statusEnqueued += 1
      }
    }

    if (insightsBatch.length > 0) {
      const runKey = `${ACCOUNT_INSIGHTS_RUN_KEY_PREFIX}${account.accountId}`
      const pending = await repo.findAutoJobByRunKey(runKey)
      const state = await repo.getMetaSyncState(runKey)
      const pollBlocked = state?.reportRunId && state?.nextPollAt && Date.now() < Number(state.nextPollAt)
      if (!pending && !pollBlocked) {
        const jitter = Math.floor(Math.random() * 60)
        await repo.requeueAutoJob(null, CAMPAIGN_JOB_TYPES.SYNC_ACCOUNT_INSIGHTS, { adAccountId: account.accountId }, {
          runKey,
          runAfterSeconds: jitter,
        })
        insightsEnqueued += 1
      }
    }
  }

  return {
    statusEnqueued,
    insightsEnqueued,
    statusDue: statusDue.length,
    insightsDue: insightsBatch.length,
    accounts: accounts.length,
    shed: shedAccounts.length ? shedAccounts.map(a => a.accountId) : undefined,
  }
}

function resolveMetaObjects(rows) {
  const sorted = [...rows].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  const byType = {}
  for (const row of sorted) {
    if (!byType[row.objectType]) byType[row.objectType] = row
  }
  return byType
}

export async function syncCampaignStatusJob(campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) return { success: false, error: 'Campaign not found' }
  if (![CAMPAIGN_STATUS.RUNNING, CAMPAIGN_STATUS.PAUSED].includes(campaign.status)) {
    return { success: false, error: 'Campaign not syncable' }
  }

  const { accountId: adAccountId, accessToken: systemToken } = await getCampaignAccountContext(campaignId)

  if (!systemToken || !adAccountId) {
    await logMetaEvent({ campaignId, action: 'sync', error: 'Meta not configured' })
    return { success: false, error: 'Meta not configured' }
  }

  const metaObjects = await repo.findMetaObjectsByCampaignId(campaignId)
  const { ad: adObj, facebook_campaign: fbCampaignObj } = resolveMetaObjects(metaObjects)
  const ad = adObj
  const fbCampaign = fbCampaignObj

  if (!ad) return { success: false, error: 'No Meta ad object to sync' }

  const result = {
    campaignId,
    statusBefore: campaign.status,
    statusAfter: campaign.status,
    statusChanged: false,
    metaSpendPaise: campaign.metaSpentPaise || 0,
    spendUpdated: false,
    archived: false,
    errors: [],
  }

  let syncError = null

  try {
    const adStatusData = await getObjectStatus(ad.objectId, systemToken)
    const metaAdStatus = adStatusData.effective_status || adStatusData.status || 'UNKNOWN'

    if (metaAdStatus !== ad.status) {
      await repo.saveMetaObjectStatus(ad.objectId, metaAdStatus)
    }

    const transition = await applyMetaStatusTransition(campaign, metaAdStatus)
    result.statusAfter = transition.statusAfter
    result.statusChanged = transition.statusChanged
  } catch (err) {
    const detail = extractMetaError(err)
    if (detail && detail.code === 100) {
      result.archived = true
      await repo.updateCampaign(campaignId, { metaStatus: META_STATUS.ARCHIVED, metaError: detail.userMsg || err.message })
      await repo.createReviewLog(campaignId, null, REVIEW_ACTIONS.SUBMITTED, campaign.status,
        `Meta ad object deleted — manual review required: ${detail.userMsg || err.message}`)
      await sendAdminAlert('Meta campaign archived', `Campaign ${campaign.name} (${campaignId}) has a deleted Meta object. Review and settle manually: ${detail.userMsg || err.message}`)
    } else {
      result.errors.push(`Status sync failed: ${err.message}`)
      syncError = err
    }
  }

  if (!syncError && !result.archived && fbCampaign) {
    try {
      const spend = await applySpendFromDailyStats(campaign)
      if (spend.updated) {
        result.metaSpendPaise = spend.metaSpendPaise
        result.spendUpdated = true
      }
      if (spend.error) result.errors.push(spend.error)
    } catch (err) {
      result.errors.push(`Spend sync failed: ${err.message}`)
    }
  }

  if (syncError) {
    const detail = extractMetaError(syncError)
    if (detail?.code === 80004 || isRateLimited()) {
      await repo.stampMetaSyncBackoff(campaignId, RATE_LIMIT_BACKOFF_SECONDS)
    } else {
      await repo.touchMetaSync(campaignId)
    }
    throw syncError
  }

  await repo.touchMetaSync(campaignId)

  await logMetaEvent({
    campaignId, action: 'sync',
    params: {
      statusBefore: result.statusBefore,
      statusAfter: result.statusAfter,
      statusChanged: result.statusChanged,
      spendPaise: result.metaSpendPaise,
      archived: result.archived,
    },
  })

  return { success: true, result }
}

async function applyMetaStatusTransition(campaign, metaAdStatus) {
  const status = String(metaAdStatus || '').toUpperCase()
  let statusChanged = false
  let metaStatusChanged = false
  let newStatus = campaign.status
  let newMetaStatus = campaign.metaStatus

  if (['DISAPPROVED', 'REJECTED'].includes(status)
    && [CAMPAIGN_STATUS.RUNNING, CAMPAIGN_STATUS.PAUSED].includes(campaign.status)) {
    await repo.updateCampaignWithStatusGuard(campaign.id, {
      status: CAMPAIGN_STATUS.FAILED,
      metaStatus: META_STATUS.FAILED,
      metaError: 'Ad disapproved by Meta',
    }, campaign.status)
    await repo.createReviewLog(campaign.id, null, REVIEW_ACTIONS.SUBMITTED, campaign.status,
      'Ad disapproved by Meta')
    newStatus = CAMPAIGN_STATUS.FAILED
    newMetaStatus = META_STATUS.FAILED
    statusChanged = true
    metaStatusChanged = true
  } else if (status === 'ARCHIVED' || status === 'DELETED') {
    await repo.updateCampaign(campaign.id, { metaStatus: META_STATUS.ARCHIVED, metaError: `Meta campaign ${status.toLowerCase()}` })
    await repo.createReviewLog(campaign.id, null, REVIEW_ACTIONS.SUBMITTED, campaign.status,
      `Meta campaign ${status.toLowerCase()} — manual review required`)
    await repo.requeueAutoJob(campaign.id, CAMPAIGN_JOB_TYPES.SETTLE_CAMPAIGN)
    await sendAdminAlert('Meta campaign archived via sync',
      `Campaign ${campaign.name} (${campaign.id}) was ${status.toLowerCase()} on Meta. Review and settle manually.`)
    newMetaStatus = META_STATUS.ARCHIVED
    metaStatusChanged = true
  } else if (status === 'PAUSED' && campaign.status === CAMPAIGN_STATUS.RUNNING) {
    await repo.updateCampaignStatus(campaign.id, CAMPAIGN_STATUS.PAUSED)
    await repo.updateCampaign(campaign.id, { metaStatus: META_STATUS.PAUSED })
    await repo.createReviewLog(campaign.id, null, REVIEW_ACTIONS.SUBMITTED, CAMPAIGN_STATUS.RUNNING, 'Campaign paused from Meta')
    newStatus = CAMPAIGN_STATUS.PAUSED
    newMetaStatus = META_STATUS.PAUSED
    statusChanged = true
    metaStatusChanged = true
  } else if (status === 'ACTIVE' && campaign.status === CAMPAIGN_STATUS.PAUSED) {
    await repo.updateCampaignStatus(campaign.id, CAMPAIGN_STATUS.RUNNING)
    await repo.updateCampaign(campaign.id, { metaStatus: META_STATUS.ACTIVE })
    await repo.createReviewLog(campaign.id, null, REVIEW_ACTIONS.SUBMITTED, CAMPAIGN_STATUS.PAUSED, 'Campaign resumed from Meta')
    newStatus = CAMPAIGN_STATUS.RUNNING
    newMetaStatus = META_STATUS.ACTIVE
    statusChanged = true
    metaStatusChanged = true
  } else if (status === 'ACTIVE') {
    await repo.updateCampaign(campaign.id, { metaStatus: META_STATUS.ACTIVE })
    newMetaStatus = META_STATUS.ACTIVE
    metaStatusChanged = true
  } else if (status === 'PAUSED') {
    await repo.updateCampaign(campaign.id, { metaStatus: META_STATUS.PAUSED })
    newMetaStatus = META_STATUS.PAUSED
    metaStatusChanged = true
  } else if (status === 'PENDING_REVIEW') {
    await repo.updateCampaign(campaign.id, { metaStatus: META_STATUS.PENDING_REVIEW })
    newMetaStatus = META_STATUS.PENDING_REVIEW
    metaStatusChanged = true
  } else if (status === 'PENDING_BILLING_INFO') {
    await repo.updateCampaign(campaign.id, { metaStatus: META_STATUS.PENDING_BILLING_INFO })
    await sendAdminAlert('Meta campaign billing info required',
      `Campaign ${campaign.name} (${campaign.id}) requires billing info on Meta.`)
    newMetaStatus = META_STATUS.PENDING_BILLING_INFO
    metaStatusChanged = true
  } else if (status === 'WITH_ISSUES') {
    await repo.updateCampaign(campaign.id, { metaStatus: META_STATUS.WITH_ISSUES })
    await sendAdminAlert('Meta campaign has issues',
      `Campaign ${campaign.name} (${campaign.id}) has policy issues on Meta.`)
    newMetaStatus = META_STATUS.WITH_ISSUES
    metaStatusChanged = true
  } else if (status === 'PREAPPROVED') {
    await repo.updateCampaign(campaign.id, { metaStatus: META_STATUS.PREAPPROVED })
    newMetaStatus = META_STATUS.PREAPPROVED
    metaStatusChanged = true
  }

  return { statusAfter: newStatus, metaStatusAfter: newMetaStatus, statusChanged, metaStatusChanged }
}

async function applySpendFromDailyStats(campaign) {
  const spendPaise = await repo.sumDailyStatsSpend(campaign.id)
  if (spendPaise > 0 && spendPaise > (campaign.metaSpentPaise || 0)) {
    await repo.saveMetaSpend(campaign.id, spendPaise)
    return { updated: true, metaSpendPaise: spendPaise }
  }
  if (spendPaise > 0 && spendPaise < (campaign.metaSpentPaise || 0)) {
    const error = `Spend went backwards: ${spendPaise} < ${campaign.metaSpentPaise}`
    await logMetaEvent({ campaignId: campaign.id, action: 'sync', error })
    return { updated: false, error }
  }
  return { updated: false }
}

async function enforceAccountBudgetCap(dbAccount) {
  if (!dbAccount || !(Number(dbAccount.monthlyCapPaise) > 0)) {
    return { success: true, checked: false }
  }

  const charges = await repo.sumChargedBudgetByAccount()
  const spent = charges[dbAccount.id] || 0
  const cap = Number(dbAccount.monthlyCapPaise)
  const ratio = spent / cap

  if (ratio < 1) {
    const state = await repo.getMetaSyncState(`cap_alert:${dbAccount.id}`)
    const lastAlert = state?.alertedAt ? Number(state.alertedAt) : 0
    if (ratio >= 0.95 && Date.now() - lastAlert > 24 * 60 * 60 * 1000) {
      await sendAdminAlert('Meta ad account near monthly cap',
        `Ad account ${dbAccount.metaAccountId} (${dbAccount.name || 'unnamed'}) has charged ${spent} paise of its ${cap} paise monthly cap (${Math.round(ratio * 100)}%).`)
      await repo.saveMetaSyncState(`cap_alert:${dbAccount.id}`, { alertedAt: Date.now() })
    }
    return { success: true, checked: true, ratio }
  }

  const running = await repo.findRunningCampaignsByAccount(dbAccount.id)
  const { accessToken: systemToken } = await resolveAccountContext(dbAccount.metaAccountId)
  const paused = []
  for (const campaign of running) {
    try {
      const metaObjects = await repo.findMetaObjectsByCampaignId(campaign.id)
      const ad = metaObjects.find(o => o.objectType === 'ad')
      if (ad?.objectId && systemToken) {
        await updateAdStatus(ad.objectId, 'PAUSED', systemToken)
        await repo.saveMetaObjectStatus(ad.objectId, 'PAUSED')
      }
      await applyMetaStatusTransition(campaign, 'PAUSED')
      await repo.createReviewLog(campaign.id, null, REVIEW_ACTIONS.SUBMITTED, campaign.status,
        `Paused by budget cap — account charged ${spent} of ${cap} paise`)
      paused.push(campaign.id)
    } catch (err) {
      await logMetaEvent({ campaignId: campaign.id, action: 'budget_cap', error: err.message })
    }
  }

  await repo.saveMetaSyncState(`cap_pause:${dbAccount.id}`, { pausedAt: Date.now(), pausedCount: paused.length })
  return { success: true, checked: true, ratio, atCap: true, paused }
}

export async function syncAccountStatusJob(adAccountId = process.env.META_AD_ACCOUNT_ID) {
  const { accessToken: systemToken, accountDbId } = await resolveAccountContext(adAccountId)
  if (!systemToken || !adAccountId) {
    return { success: false, error: 'Meta not configured' }
  }

  const dbAccount = accountDbId ? await repo.findMetaAdAccountById(accountDbId) : null
  const includeUnassigned = !dbAccount || dbAccount.isPrimary || adAccountId === process.env.META_AD_ACCOUNT_ID

  const budget = await enforceAccountBudgetCap(dbAccount)

  const rows = await repo.findAllAdObjectSyncRows({
    adAccountId: dbAccount?.id || undefined,
    includeUnassigned,
  })
  if (!rows.length) return { success: true, skipped: true }

  const { rows: ads, truncated } = await listAccountAds(adAccountId, systemToken)
  const byObjectId = new Map(rows.map(r => [r.objectId, r]))
  const seen = new Set()
  const results = []

  for (const ad of ads) {
    const row = byObjectId.get(ad.id)
    if (!row) continue
    seen.add(ad.id)
    try {
      const campaign = await repo.findCampaignById(row.campaignId)
      if (!campaign) continue
      const metaAdStatus = ad.effective_status || ad.status || 'UNKNOWN'
      if (metaAdStatus !== row.adStatus) {
        await repo.saveMetaObjectStatus(ad.id, metaAdStatus)
      }
      const transition = await applyMetaStatusTransition(campaign, metaAdStatus)
      const spend = await applySpendFromDailyStats(campaign)
      await repo.touchMetaSync(campaign.id)
      results.push({ campaignId: campaign.id, ...transition, spendUpdated: spend.updated })
    } catch (err) {
      const detail = extractMetaError(err)
      if (detail && detail.code === 100) {
        await repo.updateCampaign(row.campaignId, { metaStatus: META_STATUS.ARCHIVED, metaError: detail.userMsg || err.message })
        await repo.createReviewLog(row.campaignId, null, REVIEW_ACTIONS.SUBMITTED, row.status,
          `Meta ad object deleted — manual review required: ${detail.userMsg || err.message}`)
        results.push({ campaignId: row.campaignId, archived: true })
      } else {
        throw err
      }
    }
  }

  if (!truncated) {
    for (const row of rows) {
      if (seen.has(row.objectId)) continue
      try {
        const campaign = await repo.findCampaignById(row.campaignId)
        if (!campaign) continue
        await repo.updateCampaign(campaign.id, { metaStatus: META_STATUS.ARCHIVED, metaError: 'Meta ad object missing from account — likely deleted' })
        await repo.createReviewLog(campaign.id, null, REVIEW_ACTIONS.SUBMITTED, campaign.status,
          'Meta ad object missing from account — manual review required')
        await sendAdminAlert('Meta campaign archived', `Campaign ${campaign.name} (${campaign.id}) has a deleted Meta object. Review and settle manually.`)
        await repo.touchMetaSync(campaign.id)
        results.push({ campaignId: campaign.id, archived: true })
      } catch (err) {
        await logMetaEvent({ campaignId: row.campaignId, action: 'sync_account', error: err.message })
      }
    }
  }

  // Campaign-level batched status check for campaigns needing it
  const CAMPAIGN_LEVEL_STATUSES = [
    META_STATUS.PENDING_REVIEW,
    META_STATUS.PENDING_BILLING_INFO,
    META_STATUS.WITH_ISSUES,
    META_STATUS.PREAPPROVED,
  ]
  const needCampaignCheck = results
    .filter(r => CAMPAIGN_LEVEL_STATUSES.includes(r.metaStatusAfter))
    .map(r => {
      const row = rows.find(x => x.campaignId === r.campaignId)
      return row?.fbCampaignId
    })
    .filter(Boolean)

  if (needCampaignCheck.length > 0 && !isRateLimited(accountDbId)) {
    try {
      const campaignStatuses = await getCampaignStatusesBatch(adAccountId, systemToken, needCampaignCheck)
      for (const fbId of needCampaignCheck) {
        const metaStatus = campaignStatuses[fbId]
        if (!metaStatus) continue
        const row = rows.find(r => r.fbCampaignId === fbId)
        if (!row) continue
        const campaign = await repo.findCampaignById(row.campaignId)
        if (!campaign) continue
        const transition = await applyMetaStatusTransition(campaign, metaStatus)
        results.push({ campaignId: campaign.id, ...transition, campaignLevelCheck: true })
      }
    } catch (err) {
      await logMetaEvent({ campaignId: null, action: 'sync_campaign_batch', error: err.message })
    }
  }

  return { success: true, ads: ads.length, campaigns: results.length, truncated, budget }
}

async function fanOutInsightsRows(rowsData) {
  const fbIds = [...new Set((rowsData || []).map(r => r.campaign_id).filter(Boolean))]
  if (!fbIds.length) return { count: 0, campaignIds: [] }
  const idMap = await repo.findCampaignIdsByFbObjectIds(fbIds)
  const grouped = {}
  for (const row of rowsData || []) {
    const campaignId = idMap.get(row.campaign_id)
    if (!campaignId) continue
    if (!grouped[campaignId]) grouped[campaignId] = []
    grouped[campaignId].push(row)
  }
  let count = 0
  for (const campaignId of Object.keys(grouped)) {
    count += await persistInsightsRows(campaignId, grouped[campaignId])
  }
  return { count, campaignIds: Object.keys(grouped) }
}

export async function syncAccountInsightsJob(adAccountId = process.env.META_AD_ACCOUNT_ID) {
  const { accessToken: systemToken, accountDbId } = await resolveAccountContext(adAccountId)
  if (!systemToken || !adAccountId) {
    return { success: false, error: 'Meta not configured' }
  }

  const dbAccount = accountDbId ? await repo.findMetaAdAccountById(accountDbId) : null
  const includeUnassigned = !dbAccount || dbAccount.isPrimary || adAccountId === process.env.META_AD_ACCOUNT_ID

  const runKey = `${ACCOUNT_INSIGHTS_RUN_KEY_PREFIX}${adAccountId}`
  const state = await repo.getMetaSyncState(runKey)
  const reportRunId = state?.reportRunId || null

  try {
    if (reportRunId) {
      if (state?.nextPollAt && Date.now() < Number(state.nextPollAt)) {
        return { success: true, pending: true, throttled: true }
      }
      const report = await getInsightsReport(reportRunId, systemToken)
      const status = report.async_status || report.status || ''
      if (status === 'Job Completed' || status === 'COMPLETED') {
        const rowsData = await getInsightsReportData(reportRunId, systemToken)
        const { count, campaignIds } = await fanOutInsightsRows(rowsData)
        await repo.clearMetaSyncState(runKey)
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
        for (const campaignId of campaignIds) {
          await repo.saveInsightsSyncState(campaignId, { lastInsightsSyncAt: now, insightsError: null })
        }
        return { success: true, rows: count, campaigns: campaignIds.length }
      }
      if (status === 'Job Failed' || status === 'FAILED') {
        await repo.clearMetaSyncState(runKey)
        throw new Error(`Insights report failed: ${report.error || 'unknown error'}`)
      }
      await repo.saveMetaSyncState(runKey, { reportRunId, nextPollAt: Date.now() + INSIGHTS_POLL_MIN_INTERVAL_MS })
      return { success: true, pending: true }
    }

    if (isRateLimited(adAccountId)) {
      throw new Error('Meta rate limited — insights sync deferred')
    }

    const batch = await repo.findDueInsightsBatch({
      stalenessSeconds: INSIGHTS_SYNC_STALENESS_SECONDS,
      limit: 100,
      adAccountId: dbAccount?.id || undefined,
      includeUnassigned,
    })
    if (!batch.length) return { success: true, skipped: true }

    const fbIds = [...new Set(batch.map(b => b.fbObjectId).filter(Boolean))]
    if (!fbIds.length) return { success: true, skipped: true }

    const since = batch.map(b => computeInsightsBackfillStart(b)).sort()[0]
    const until = new Date().toISOString().slice(0, 10)

    const report = await createInsightsReport(adAccountId, {
      accessToken: systemToken,
      level: 'campaign',
      timeIncrement: 1,
      since,
      until,
      filtering: [{ field: 'campaign.id', operator: 'IN', value: fbIds }],
    })

    const runId = report.report_run_id
    if (!runId) {
      throw new Error(`Insights report created without report_run_id: ${JSON.stringify(report)}`)
    }

    await repo.saveMetaSyncState(runKey, { reportRunId: runId, nextPollAt: Date.now() + INSIGHTS_POLL_MIN_INTERVAL_MS })
    return { success: true, pending: true, campaigns: batch.length }
  } catch (err) {
    await logMetaEvent({ action: 'sync_account_insights', error: err.message })
    throw err
  }
}

const REPORT_RUN_PREFIX = 'report_running:'

function computeInsightsBackfillStart(campaign) {
  const start = campaign.scheduledAt ? new Date(campaign.scheduledAt) : null
  if (start && Number.isFinite(start.getTime())) {
    return start.toISOString().slice(0, 10)
  }
  return new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

async function persistInsightsRows(campaignId, rows) {
  let count = 0
  for (const row of rows || []) {
    const actions = {}
    for (const action of row.actions || []) {
      if (action?.action_type) actions[action.action_type] = action.value
    }
    const costPerActionType = {}
    for (const cost of row.cost_per_action_type || []) {
      if (cost?.action_type) costPerActionType[cost.action_type] = cost.value
    }
    await repo.upsertDailyStat(campaignId, {
      statDate: row.date_start,
      impressions: row.impressions,
      reach: row.reach,
      frequency: row.frequency,
      clicks: row.clicks,
      uniqueClicks: row.unique_clicks,
      ctr: row.ctr,
      cpc: row.cpc,
      cpm: row.cpm,
      spendPaise: Math.round(parseFloat(row.spend || '0') * 100),
      actions,
      costPerActionType,
    })
    count += 1
  }
  return count
}

export async function syncCampaignInsightsJob(campaignId) {
  const { accountId: adAccountId, accessToken: systemToken } = await getCampaignAccountContext(campaignId)

  if (!systemToken || !adAccountId) {
    return { success: false, error: 'Meta not configured' }
  }

  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) return { success: false, error: 'Campaign not found' }

  const fbObjectIds = await repo.findFacebookCampaignObjectIds(campaignId)
  if (!fbObjectIds.length) return { success: false, error: 'No Meta campaign objects' }

  const resumeError = campaign.insightsError || ''
  const reportRunId = resumeError.startsWith(REPORT_RUN_PREFIX)
    ? resumeError.slice(REPORT_RUN_PREFIX.length)
    : null

  try {
    if (reportRunId) {
      const report = await getInsightsReport(reportRunId, systemToken)
      const status = report.async_status || report.status || ''
      if (status === 'Job Completed' || status === 'COMPLETED') {
        const rowsData = await getInsightsReportData(reportRunId, systemToken)
        const count = await persistInsightsRows(campaignId, rowsData)
        await repo.saveInsightsSyncState(campaignId, {
          lastInsightsSyncAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
          insightsError: null,
        })
        return { success: true, rows: count }
      }
      if (status === 'Job Failed' || status === 'FAILED') {
        await repo.saveInsightsSyncState(campaignId, { insightsError: null })
        throw new Error(`Insights report failed: ${report.error || 'unknown error'}`)
      }
      return { success: true, pending: true }
    }

    if (isRateLimited()) {
      throw new Error('Meta rate limited — insights sync deferred')
    }

    const since = computeInsightsBackfillStart(campaign)
    const until = new Date().toISOString().slice(0, 10)

    const report = await createInsightsReport(adAccountId, {
      accessToken: systemToken,
      level: 'campaign',
      timeIncrement: 1,
      since,
      until,
      filtering: [{ field: 'campaign.id', operator: 'IN', value: fbObjectIds }],
    })

    const runId = report.report_run_id
    if (!runId) {
      throw new Error(`Insights report created without report_run_id: ${JSON.stringify(report)}`)
    }

    await repo.saveInsightsSyncState(campaignId, { insightsError: `${REPORT_RUN_PREFIX}${runId}` })
    return { success: true, pending: true }
  } catch (err) {
    await logMetaEvent({ campaignId, action: 'sync_insights', error: err.message })
    throw err
  }
}

export async function pollAccountBalance() {
  const accounts = await getSyncableAccounts()
  if (!accounts.length) return { success: false, error: 'Meta not configured' }

  const results = []
  for (const account of accounts) {
    try {
      const { accessToken: systemToken } = await resolveAccountContext(account.accountId)
      if (!systemToken) {
        results.push({ adAccountId: account.accountId, success: false, error: 'No token configured' })
        continue
      }
      const data = await getAdAccount(account.accountId, systemToken)
      const balancePaise = Math.round(parseFloat(data.balance || '0') * 100)
      await repo.insertAccountSnapshot({
        adAccountId: account.accountId,
        balancePaise,
        currency: data.currency || null,
        accountStatus: data.account_status || null,
        disableReason: data.disable_reason || null,
      })
      results.push({ adAccountId: account.accountId, success: true, balancePaise })
    } catch (err) {
      await logMetaEvent({ action: 'account_balance', error: err.message })
      results.push({ adAccountId: account.accountId, success: false, error: err.message })
    }
  }

  return { success: results.some(r => r.success), results }
}

export async function endExpiredCampaigns() {
  const due = await repo.findEndableRunningCampaigns()
  const results = []
  for (const campaign of due) {
    try {
      await repo.updateCampaignWithStatusGuard(campaign.id, {
        status: CAMPAIGN_STATUS.COMPLETED,
      }, campaign.status)
      await repo.createReviewLog(campaign.id, null, REVIEW_ACTIONS.SUBMITTED, campaign.status, 'Campaign ended by schedule')
      await repo.requeueAutoJob(campaign.id, CAMPAIGN_JOB_TYPES.SETTLE_CAMPAIGN)
      results.push({ campaignId: campaign.id, success: true })
    } catch (err) {
      results.push({ campaignId: campaign.id, success: false, error: err.message })
    }
  }
  return results
}

export async function settleCampaignJob(campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.settledAt) return { success: true, alreadySettled: true }

  const chargedPaise = campaign.chargedAdBudgetPaise || 0
  if (chargedPaise <= 0) return { success: true, nothingCharged: true }

  const charge = await repo.findCampaignCharge(campaignId)
  const rate = charge?.rate || (await getCoinConversionRate())
  const paisePerCoin = Math.max(rate * 100, 1)
  const coinService = await import('../../../shared/services/coin.service.js')

  if ([CAMPAIGN_STATUS.RUNNING, CAMPAIGN_STATUS.PAUSED].includes(campaign.status)) {
    await repo.updateCampaignWithStatusGuard(campaignId, { status: CAMPAIGN_STATUS.COMPLETED }, campaign.status)
    await repo.createReviewLog(campaignId, null, REVIEW_ACTIONS.SUBMITTED, campaign.status, 'Campaign ended — Meta settlement triggered')
  }

  const actualPaise = await repo.sumDailyStatsSpend(campaignId)

  if (actualPaise <= chargedPaise) {
    const refundPaise = chargedPaise - actualPaise
    const refundCoins = Math.round(refundPaise / paisePerCoin)

    if (refundCoins > 0) {
      const fromMonthly = charge?.paidFromMonthly || 0
      const fromWallet = charge?.paidFromWallet || 0
      const totalChargedCoins = fromMonthly + fromWallet
      let monthlyShare = 0
      let walletShare = refundCoins
      if (totalChargedCoins > 0) {
        monthlyShare = Math.round(refundCoins * (fromMonthly / totalChargedCoins))
        walletShare = refundCoins - monthlyShare
      }
      await coinService.refundWithDetail(campaign.clientId, refundCoins, 'campaign_escrow', campaignId,
        `Meta spend settlement refund: ${campaign.name}`, { fromMonthly: monthlyShare, fromWallet: walletShare })
      await repo.insertBillingEntry(campaignId, {
        kind: BILLING_ENTRY_KINDS.REFUND,
        paise: refundPaise,
        coins: refundCoins,
        rate,
        paidFromMonthly: monthlyShare,
        paidFromWallet: walletShare,
        reason: `Settlement refund: charged ${chargedPaise} paise, spent ${actualPaise} paise`,
      })
    }

    await repo.insertBillingEntry(campaignId, {
      kind: BILLING_ENTRY_KINDS.SETTLE,
      paise: actualPaise,
      coins: Math.round(actualPaise / paisePerCoin),
      rate,
      reason: `Campaign settled: charged ${chargedPaise} paise, actual spend ${actualPaise} paise`,
    })
    await repo.markCampaignSettled(campaignId)
    return { success: true, refundCoins, actualPaise, chargedPaise }
  }

  const overspendPaise = actualPaise - chargedPaise
  const overspendCoins = Math.ceil(overspendPaise / paisePerCoin)

  try {
    await coinService.spend(campaign.clientId, overspendCoins, 'campaign_escrow', campaignId,
      `Meta overspend settlement: ${campaign.name}`)
    await repo.insertBillingEntry(campaignId, {
      kind: BILLING_ENTRY_KINDS.OVERSPEND,
      paise: overspendPaise,
      coins: overspendCoins,
      rate,
      reason: `Overspend settlement: spent ${actualPaise} paise vs charged ${chargedPaise} paise`,
    })
    await repo.insertBillingEntry(campaignId, {
      kind: BILLING_ENTRY_KINDS.SETTLE,
      paise: actualPaise,
      coins: Math.round(actualPaise / paisePerCoin),
      rate,
      reason: 'Campaign settled with overspend deduction',
    })
    await repo.markCampaignSettled(campaignId)
    return { success: true, overspendCoins, actualPaise, chargedPaise }
  } catch (err) {
    if (err?.statusCode === 422 || err?.code === 'INSUFFICIENT_COINS') {
      await repo.insertBillingEntry(campaignId, {
        kind: BILLING_ENTRY_KINDS.OVERSPEND,
        paise: overspendPaise,
        coins: overspendCoins,
        rate,
        reason: `Overspend on hold — insufficient wallet coins for ${overspendCoins} coins`,
      })
      await sendAdminAlert('Campaign overspend hold', `Campaign ${campaign.name} (${campaignId}) spent ${actualPaise} paise vs ${chargedPaise} charged; could not deduct ${overspendCoins} coins (insufficient balance).`)
      return { success: true, held: true, overspendCoins, actualPaise, chargedPaise }
    }
    throw err
  }
}

export async function getMetaSyncHealth() {
  const [staleCampaigns, failedJobs, unsettledCount, runningCount, pausedCount, accountSnapshot, rateLimit, accounts, rateLimits, schedulerLease, chargedBudget] = await Promise.all([
    repo.findStaleRunningCampaigns(),
    repo.countFailedJobsByType(),
    repo.countUnsettledCampaigns(),
    repo.countRunningCampaigns(),
    repo.countPausedCampaigns(),
    repo.findLatestAccountSnapshot(),
    Promise.resolve(getRateLimitState()),
    repo.listMetaAdAccounts(),
    Promise.resolve(getAllRateLimitStates()),
    repo.getSchedulerLease('meta_sync_scheduler'),
    repo.sumChargedBudgetByAccount(),
  ])

  return {
    runningCount,
    pausedCount,
    staleCampaigns,
    failedJobs,
    unsettledCount,
    accountSnapshot,
    rateLimit,
    accounts,
    rateLimits,
    schedulerLease,
    chargedBudget,
  }
}

export async function forceSyncCampaign(campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  const enqueued = await repo.requeueAutoJob(campaignId, CAMPAIGN_JOB_TYPES.SYNC_STATUS)
  await repo.requeueAutoJob(campaignId, CAMPAIGN_JOB_TYPES.SYNC_INSIGHTS)
  return { queued: true, enqueued }
}

export async function listMetaAccounts() {
  return repo.listMetaAdAccounts()
}

export async function createMetaAccount(data) {
  const isEnvPrimary = data.metaAccountId === process.env.META_AD_ACCOUNT_ID
  const existing = await repo.findMetaAdAccountByMetaId(data.metaAccountId)
  if (existing) {
    if (data.isPrimary) {
      await repo.clearPrimaryMetaAccounts(existing.id)
    }
    return repo.updateMetaAdAccount(existing.id, isEnvPrimary ? { ...data, token: null } : data)
  }
  if (!isEnvPrimary && !data.token) {
    throw new ValidationError('Token is required for new accounts')
  }
  if (data.isPrimary) {
    await repo.clearPrimaryMetaAccounts()
  }
  return repo.createMetaAdAccount(isEnvPrimary ? { ...data, token: null } : data)
}

export async function updateMetaAccount(id, data) {
  const existing = await repo.findMetaAdAccountById(id)
  if (!existing) throw new NotFoundError('Meta ad account not found')
  if (data.isPrimary) {
    await repo.clearPrimaryMetaAccounts(existing.id)
  }
  if (existing.metaAccountId === process.env.META_AD_ACCOUNT_ID && data.token) {
    data = { ...data, token: null }
  }
  return repo.updateMetaAdAccount(id, data)
}

export async function deleteMetaAccount(id) {
  const existing = await repo.findMetaAdAccountById(id)
  if (!existing) throw new NotFoundError('Meta ad account not found')
  await repo.deleteMetaAdAccount(id)
  return { deleted: true }
}
