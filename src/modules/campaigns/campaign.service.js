import * as repo from './campaign.repository.js'
import { generateUuid } from '../../../shared/utils/uuid.utils.js'
import { NotFoundError, ValidationError, ForbiddenError, ConflictError } from '../../../shared/errors/AppError.js'
import { CAMPAIGN_STATUS, VALID_TRANSITIONS, REVIEW_ACTIONS, CAMPAIGN_JOB_TYPES, META_STATUS, BILLING_ENTRY_KINDS, META_ISSUE_MESSAGES, BID_STRATEGIES_REQUIRING_BID_AMOUNT } from './campaign.model.js'
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
  getMetaObject,
  isMissingObjectError,
  listAccountAds,
  listAccountCampaigns,
  listCampaignAdSets,
  listAdSetAds,
  getCampaignStatusesBatch,
  getAdAccount,
  createInsightsReport,
  getInsightsReport,
  getInsightsReportData,
  extractMetaError,
  uploadRepairVideoFromUrl,
  waitForAdVideoReady,
  deleteAdVideo,
} from '../../../shared/services/meta-ads.service.js'
import { inspectMediaSize } from '../../../shared/services/media-url.js'
import { classifyChainError } from '../../../shared/services/meta-chain-runner.js'
import { logMetaEvent } from '../../../shared/services/meta-logger.service.js'
import { transaction, queryOne } from '../../../shared/database/connection.js'
import { isRateLimited, isSoftThrottled, getRateLimitState, getAllRateLimitStates } from '../../../shared/services/meta-rate-limiter.js'
import { normalizeIssuesInfo, classifyIssueCode, describeIssuesForCampaign, hasRepairableIssue } from '../../../shared/services/meta-issue-catalog.js'
import { checkAdContentForMeta, checkAdMediaForMeta } from '../../../shared/services/ad-content-validation.js'
import { sendAdminAlert, sendPublisherRepublishNotification } from '../../../shared/mailer/alert.mailer.js'
import * as execRepo from './campaign-execution.repository.js'
import { EXECUTION_KIND, EXECUTION_STATUS, IN_FLIGHT_EXECUTION_STATUSES, TERMINAL_EXECUTION_STATUSES } from './campaign-execution.model.js'
import { classifyRuntimeQuarantine, ensureCampaignSnapshot, checkExecutionSnapshot, findOrCreatePendingExecution, rearmFailedExecution, refreezeCampaignSnapshotIfUnbuilt } from './campaign-execution.service.js'
import { logger } from '../../../shared/utils/logger.js'
let cachedCoinRate = null

export const CAMPAIGN_EXECUTION_RUNTIME_FLAG = 'campaign_execution_runtime_enabled'

export async function isCampaignExecutionRuntimeEnabled() {
  try {
    const row = await queryOne('SELECT config_value FROM app_config WHERE config_key = ?', [CAMPAIGN_EXECUTION_RUNTIME_FLAG])
    if (!row) return false
    const v = typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value
    return v === true
  } catch { return false }
}

async function isCampaignDuplicateEnabled() {
  try {
    const row = await queryOne('SELECT config_value FROM app_config WHERE config_key = ?', ['feature_visibility'])
    if (!row) return false
    const v = typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value
    return v.campaign_duplicate === true
  } catch { return false }
}

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
    const days = await getPublisherResponseDeadlineDays()
    return days * 24
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

export function invalidatePublisherConfigCache() {
  cachedPublisherMultiplier = null
  cachedDeadlineDays = null
}

export function buildUrlTags(creative) {
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

  const [creative, metaSettings, reviewLog, publisherRequests, metaObjects, metaIssues] = await Promise.all([
    repo.findCreativeByCampaignId(campaignId),
    repo.findMetaSettingsByCampaignId(campaignId),
    repo.findReviewLogsByCampaignId(campaignId),
    repo.findPublisherRequestsByCampaignId(campaignId),
    repo.findMetaObjectsByCampaignId(campaignId),
    repo.findMetaObjectIssuesByCampaignId(campaignId).then(rows => rows.map(issue => {
      const classified = classifyIssueCode(issue.errorCode)
      return {
        ...issue,
        category: classified.category,
        guidance: classified.guidance,
        severity: classified.severity,
        repairable: classified.repairable === true,
        requiredInput: classified.requiredInput || null,
      }
    })).catch(() => []),
  ])

  const knownIssues = campaign.metaStatus === 'failed' ? await computeKnownIssuesFor(campaign, creative, metaSettings) : []

  return { ...campaign, creative, metaSettings, reviewLog, publisherRequests, metaObjects, metaIssues, knownIssues }
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

  if (data.endTime) {
    const bufferWarning = computeScheduleBufferWarning(campaign.scheduledAt, data.endTime, data.budgetType, {
      safetyBufferMs: SCHEDULE_SAFETY_BUFFER_MS,
    })
    if (bufferWarning) throw new ValidationError(bufferWarning)
  }

  const id = generateUuid()
  const saved = await repo.createMetaSettings(id, campaignId, data)
  // Best-effort: pick up the new settings on the next build attempt when no
  // owner has started building on Meta yet (see refreezeCampaignSnapshotIfUnbuilt
  // for why this can't happen once a chain is in progress). Never let a
  // snapshot refresh failure mask a successful settings save.
  try {
    await refreezeCampaignSnapshotIfUnbuilt(campaignId)
  } catch (err) {
    logger.warn({ campaignId, err: err?.message }, 'Failed to refresh execution snapshot after saveMetaSettings')
  }
  return saved
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

  // Publisher flow after adjustments — await publishers before Meta ads.
  // Async since Step 13: validate + stage here, spend/transition/requests run
  // in the approve_publisher worker. Client-only confirm keeps its 202 below.
  if (campaign.categoryId && campaign.publisherCount && campaign.coinsPerPublisher) {
    return queuePublisherApprovalFlow(campaign, { flow: 'confirm', actorId: userId })
  }

  // See approveCampaign's client-only branch for why staging AND rearming
  // are both required before enqueueing the job that will need the
  // execution row — confirmAdjustments is exactly as re-enterable as
  // approveCampaign (an admin can adjust and the client can re-confirm
  // after a prior attempt permanently failed the execution).
  await findOrCreatePendingExecution(campaignId, campaign.clientId, EXECUTION_KIND.CLIENT)
  await rearmFailedExecution(campaignId, campaign.clientId, EXECUTION_KIND.CLIENT)

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
    throwGoLiveFailure(publishResult, 'Failed to publish campaign on Meta')
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
// Extra runway required ONLY at the moment a client sets the schedule
// (saveMetaSettings), strictly ON TOP OF a duration that already clears
// Meta's bare 24h floor. buildMetaAdPayloads' own check below measures
// duration from "now" at PUBLISH time, not at save time — a campaign with,
// say, 25h of runway when created can drift under Meta's 24h floor purely
// from elapsed admin-review/retry time before it actually gets published,
// and the client set a perfectly fine schedule but is helpless to fix it
// once "Failed to publish campaign on Meta: Daily budget is only allowed
// for ad sets running longer than 24 hours" already happened (live-
// observed on a campaign that sat in review for under an hour). Requiring
// extra buffer up front gives normal review turnaround room before that
// floor is reached. Deliberately NOT applied to schedules that are already
// invalid outright (past/inverted/missing/already-under-24h) — those stay
// exactly as before, surfaced only via validateCampaignDraft/buildMetaAd
// Payloads at publish time, since they're wrong regardless of elapsed time
// and don't need this early, buffer-specific gate.
const SCHEDULE_SAFETY_BUFFER_MS = Math.max(0, Number(process.env.CAMPAIGN_SCHEDULE_SAFETY_BUFFER_HOURS) || 6) * 60 * 60 * 1000

function computeScheduleError(scheduledAt, endTime, budgetType, referenceNow = Date.now()) {
  const isDaily = budgetType === 'daily' || !budgetType
  const startTimeMs = scheduledAt ? new Date(scheduledAt).getTime() : null
  const endTimeMs = endTime ? new Date(endTime).getTime() : null
  if (startTimeMs !== null && Number.isFinite(startTimeMs) && startTimeMs <= referenceNow) {
    return 'Ad set start time must be in the future'
  }
  if (endTimeMs !== null && Number.isFinite(endTimeMs) && endTimeMs <= referenceNow) {
    return 'Ad set end time must be in the future'
  }
  if (startTimeMs !== null && endTimeMs !== null && Number.isFinite(endTimeMs) && endTimeMs <= startTimeMs) {
    return 'Ad set end time must be after start time'
  }
  if (endTimeMs === null) {
    return isDaily ? 'An end date is required' : 'End time is required for lifetime budget'
  }
  if (isDaily && Number.isFinite(endTimeMs) && endTimeMs - (startTimeMs ?? referenceNow) <= MIN_DURATION_MS) {
    return 'Daily budget is only allowed for ad sets running longer than 24 hours'
  }
  return null
}

// Only fires for a schedule that is CURRENTLY valid (clears every check in
// computeScheduleError, including the bare 24h floor) but has so little
// margin beyond that floor that ordinary admin review time can eat through
// it before publish. An already-invalid schedule (past, inverted, missing,
// or already <=24h) is intentionally left alone here — computeScheduleError
// already covers those the same way it always has, unaffected by elapsed
// time, and validateCampaignDraft/buildMetaAdPayloads remain the single
// place that surfaces them.
function computeScheduleBufferWarning(scheduledAt, endTime, budgetType, { referenceNow = Date.now(), safetyBufferMs = 0 } = {}) {
  if (safetyBufferMs <= 0) return null
  if (computeScheduleError(scheduledAt, endTime, budgetType, referenceNow)) return null
  const isDaily = budgetType === 'daily' || !budgetType
  if (!isDaily) return null
  const startTimeMs = scheduledAt ? new Date(scheduledAt).getTime() : null
  const endTimeMs = new Date(endTime).getTime()
  const duration = endTimeMs - (startTimeMs ?? referenceNow)
  if (duration > MIN_DURATION_MS && duration <= MIN_DURATION_MS + safetyBufferMs) {
    const minHours = Math.round((MIN_DURATION_MS + safetyBufferMs) / 3600000)
    const remainingHours = (duration / 3600000).toFixed(1)
    return `This daily-budget schedule only has ${remainingHours} hours of runway, just over Meta's 24-hour minimum — normal admin review time can easily push it past that floor before the campaign goes live. Please choose an end date at least ${minHours} hours from now (or switch to a lifetime budget).`
  }
  return null
}

// Only the rules Meta actually documents for manual placements are enforced
// here — nothing invented, matching this codebase's existing "never invent
// codes" convention for Meta classification. Source: Marketing API
// "Placement Targeting" reference (publisher_platforms / facebook_positions /
// instagram_positions / messenger_positions / audience_network_positions
// section). Live bug this fixes: a campaign with `publisher_platforms:
// ['audience_network']` and no other platform passed Meta's validate_only
// gate for the campaign+creative but failed at ad-set creation with
// "The placement combination selected is not supported by the campaign
// set-up" — Audience Network can never be selected without Facebook.
function computePlacementError(platformPlacement, objective, optimizationGoal) {
  const platforms = Array.isArray(platformPlacement?.publisher_platforms) ? platformPlacement.publisher_platforms : []
  if (!platforms.length) return null

  const hasPlatform = p => platforms.includes(p)

  if (hasPlatform('audience_network') && !hasPlatform('facebook')) {
    return 'Audience Network cannot be selected without Facebook — please also enable the Facebook placement.'
  }
  if (hasPlatform('audience_network') && objective === 'VIDEO_VIEWS' && optimizationGoal !== 'THRUPLAY') {
    return 'Audience Network with the Video Views objective requires the "ThruPlay" optimization goal.'
  }

  const fbPositions = Array.isArray(platformPlacement?.facebook_positions) ? platformPlacement.facebook_positions : []
  const igPositions = Array.isArray(platformPlacement?.instagram_positions) ? platformPlacement.instagram_positions : []
  const msgrPositions = Array.isArray(platformPlacement?.messenger_positions) ? platformPlacement.messenger_positions : []
  const hasFeedOrIgStory = fbPositions.includes('feed') || (hasPlatform('instagram') && igPositions.includes('story'))

  if (fbPositions.includes('story') && !hasFeedOrIgStory) {
    return 'The Facebook Stories placement requires the Facebook Feed placement (or Instagram Stories) to also be selected.'
  }
  if (msgrPositions.includes('story') && !hasFeedOrIgStory) {
    return 'The Messenger Stories placement requires the Facebook Feed placement (or Instagram Stories) to also be selected.'
  }

  const feedDependentPositions = fbPositions.filter(p => ['marketplace', 'search'].includes(p))
  if (feedDependentPositions.length && !fbPositions.includes('feed')) {
    return `The Facebook ${feedDependentPositions.join(', ')} placement requires the Facebook Feed placement to also be selected.`
  }

  return null
}

// Collapses a geo_locations (or excluded_geo_locations) object to the single
// most specific granularity level present — zips > cities > regions >
// countries — since Meta rejects a request mixing levels ("Remove a
// conflicting location to continue" / "locations overlap": e.g. a country
// plus a city within it). custom_locations (radius-based) is handled
// separately by the caller, since it's independent of these levels.
function collapseGeoLocationGranularity(geo) {
  if (!geo) return
  if (geo.zips?.length) {
    delete geo.cities
    delete geo.regions
    delete geo.countries
  } else if (geo.cities?.length) {
    delete geo.regions
    delete geo.countries
  } else if (geo.regions?.length) {
    delete geo.countries
  }
}

const GEO_LOCATION_KEY_FIELDS = ['countries', 'regions', 'cities', 'zips', 'custom_locations']

function geoLocationKeys(location, field) {
  const list = Array.isArray(location?.[field]) ? location[field] : []
  return list.map(item => (typeof item === 'string' ? item : item?.key)).filter(Boolean)
}

// Confirmed live bug: two campaigns had the exact same region key present in
// BOTH geo_locations.regions and excluded_geo_locations.regions (a location
// picker letting the same place be added to both include and exclude), and
// Meta rejected ad-set creation with "Remove a conflicting location to
// continue." This is a pure input contradiction the app can and must catch
// itself — no Meta call needed, nothing invented — checked across every
// location field Meta itself supports.
function computeLocationConflictError(targeting) {
  const included = targeting?.geo_locations
  const excluded = targeting?.excluded_geo_locations
  if (!included || !excluded) return null
  for (const field of GEO_LOCATION_KEY_FIELDS) {
    const includedKeys = new Set(geoLocationKeys(included, field))
    if (!includedKeys.size) continue
    const hasConflict = geoLocationKeys(excluded, field).some(key => includedKeys.has(key))
    if (hasConflict) {
      return `The same location is both included and excluded in your targeting (${field.replace('_', ' ')}). Remove it from one side to continue.`
    }
  }
  return null
}

function buildMetaAdPayloads(campaign, creative, metaSettings, pageId, coinRate) {
  const coinBudget = metaSettings?.budgetAmount || 1000
  const budgetInINR = Math.round(coinBudget * coinRate)
  const isDaily = metaSettings?.budgetType === 'daily' || !metaSettings?.budgetType
  const minBudgetError = budgetInINR < MIN_BUDGET_INR
    ? `Minimum ${isDaily ? 'daily' : 'lifetime'} budget is ₹${MIN_BUDGET_INR} (${Math.ceil(MIN_BUDGET_INR / coinRate)} coins at current conversion rate)`
    : null

  const scheduleError = computeScheduleError(campaign.scheduledAt, metaSettings?.endTime, metaSettings?.budgetType)

  const bidStrategy = metaSettings?.bidStrategy || 'LOWEST_COST_WITHOUT_CAP'
  const requiresBidAmount = BID_STRATEGIES_REQUIRING_BID_AMOUNT.has(bidStrategy)
  const bidAmountInPaise = metaSettings?.bidAmount ? Math.round(metaSettings.bidAmount * coinRate * 100) : null
  const bidAmountError = requiresBidAmount && !bidAmountInPaise
    ? `A bid amount is required for the "${bidStrategy}" bid strategy`
    : null

  const placementError = computePlacementError(metaSettings?.platformPlacement, metaSettings?.objective, metaSettings?.optimizationGoal)

  const fbCampaignName = `FlowX-${campaign.name}-${campaign.id.substring(0, 8)}`

  const targeting = JSON.parse(JSON.stringify(metaSettings?.targeting || {}))

  delete targeting.age
  delete targeting.gender
  delete targeting.country

  if (targeting.geo_locations) {
    delete targeting.geo_locations.location_types
  }

  const geo = targeting.geo_locations
  // Meta rejects mixing geo_locations granularity levels ("Remove a
  // conflicting location to continue" / documented "locations overlap" —
  // a country plus a city within it, or a region + city + zip all nested
  // together, live-observed on a campaign with all three selected and NO
  // excluded_geo_locations involved at all). The client's location picker
  // lets — even invites — selecting region, city, and zip together for
  // extra precision, but Meta wants exactly one granularity level.
  // Collapse to the single most specific level actually picked; broader
  // levels are redundant with it anyway. Applied independently to
  // excluded_geo_locations below (Meta enforces the same rule there).
  collapseGeoLocationGranularity(geo)
  if (!geo?.countries?.length && !geo?.regions?.length && !geo?.cities?.length && !geo?.zips?.length && !geo?.custom_locations?.length) {
    if (!geo) targeting.geo_locations = { countries: ['IN'] }
    else targeting.geo_locations.countries = ['IN']
  }
  if (geo?.custom_locations?.length) {
    delete geo.regions
    delete geo.cities
    delete geo.zips
    delete geo.countries
  }
  collapseGeoLocationGranularity(targeting.excluded_geo_locations)

  if (targeting.age_min && targeting.age_max && targeting.age_min > targeting.age_max) {
    targeting.age_max = targeting.age_min
  }

  const locationConflictError = computeLocationConflictError(targeting)

  const spendCapInPaise = metaSettings?.spendCap ? Math.round(metaSettings.spendCap * coinRate * 100) : null
  const creativeMessage = creative?.caption || creative?.textBody || campaign.name
  const creativeMediaUrl = creative?.mediaUrl || null
  const creativeCallToAction = creative?.callToAction || null
  const creativeExtra = { headline: creative?.headline, description: creative?.description }
  const adSetBudget = {
    budgetType: metaSettings?.budgetType || 'daily',
    budgetAmount: budgetInINR,
    bidStrategy,
    bidAmount: bidAmountInPaise,
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
    bidAmountError,
    placementError,
    locationConflictError,
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
    specialAdCategories: metaSettings?.specialAdCategories || [],
  }
}

const KNOWN_ISSUE_FIELDS = ['minBudgetError', 'scheduleError', 'bidAmountError', 'placementError', 'locationConflictError']

// Read-only diagnostic reusing the exact same pre-flight checks
// buildMetaAdPayloads runs before any Meta call. Used to tell whether a
// campaign that already failed on Meta has a KNOWN, still-present,
// deterministic problem (a bare retry is guaranteed to fail identically)
// versus something outside these rules — a transient network/rate-limit
// blip, or a genuine Meta ad-policy review — where a retry might still
// succeed. Never guesses beyond these concrete, already-enforced rules.
async function computeKnownIssuesFor(campaign, creative, metaSettings) {
  if (!metaSettings) return []
  const coinRate = await getCoinConversionRate()
  const payload = buildMetaAdPayloads(campaign, creative, metaSettings, null, coinRate)
  return KNOWN_ISSUE_FIELDS.map(field => payload[field]).filter(Boolean)
}

export async function getCampaignKnownIssues(campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) return []
  const [creative, metaSettings] = await Promise.all([
    repo.findCreativeByCampaignId(campaignId),
    repo.findMetaSettingsByCampaignId(campaignId),
  ])
  return computeKnownIssuesFor(campaign, creative, metaSettings)
}

// Fast, non-network media-kind check (matches the extension convention used
// throughout this codebase, e.g. post.service.js's isVideoUrl) — the common
// case for hosted/uploaded media URLs.
function isVideoMediaUrl(url) {
  return /\.(mp4|mov|webm)(\?.*)?$/i.test(url || '')
}

// Extension-less URLs fall back to a single SSRF-safe HEAD content-type
// check (mirrors post.service.js's sniffMediaType, but via the SSRF-guarded
// media-url.js primitive instead of a raw fetch).
async function detectVideoMedia(mediaUrl) {
  if (!mediaUrl) return false
  if (isVideoMediaUrl(mediaUrl)) return true
  if (/\.(jpe?g|png|gif|webp)(\?.*)?$/i.test(mediaUrl)) return false
  try {
    const size = await inspectMediaSize(mediaUrl, {})
    return Boolean(size?.contentType && String(size.contentType).startsWith('video/'))
  } catch {
    return false
  }
}

// Resolves creativeMediaUrl to a ready Meta ad-account video_id, reusing a
// previously uploaded video for the same (campaign, owner, mediaUrl) rather
// than re-uploading on every job retry — campaign job retries are automatic
// (job-queue backoff), unlike the admin-triggered repair flow this mirrors,
// so avoiding duplicate uploads across retries matters here specifically.
// video_data and link_data on a Meta ad creative are mutually exclusive
// (never send both) — this is why the fix lives here: buildOwnerMetaChain
// was always sending video URLs through link_data, so Meta treated the raw
// .mp4 as a webpage to scrape for a link-preview thumbnail instead of as a
// real video attachment (the scrape produces a tiny/broken fallback image,
// which is what actually trips the ">=500px wide" delivery rejection).
async function resolveVideoForCampaignCreative({ campaignId, userId, adAccountId, mediaUrl, systemToken }) {
  const existing = await repo.findCampaignAdVideo(campaignId, userId)
  let videoId = existing?.mediaUrl === mediaUrl ? existing.videoId : null

  if (!videoId) {
    try {
      const uploaded = await uploadRepairVideoFromUrl(adAccountId, { fileUrl: mediaUrl, name: `Campaign video ${campaignId.substring(0, 8)}` }, systemToken)
      videoId = uploaded?.videoId || null
      if (!videoId) return { outcome: 'retryable', classification: 'ambiguous', error: 'Video upload returned no id' }
    } catch (error) {
      const classified = classifyChainError(error)
      if (classified.kind === 'permanent') return { outcome: 'permanent', error: classified.message }
      return { outcome: 'retryable', classification: classified.kind, error: classified.message }
    }
    await repo.upsertCampaignAdVideo(campaignId, userId, mediaUrl, videoId)
  }

  try {
    await waitForAdVideoReady(videoId, systemToken)
    return { outcome: 'ready', videoId }
  } catch (error) {
    if (isMissingObjectError(error)) {
      await repo.deleteCampaignAdVideo(campaignId, userId)
      return { outcome: 'retryable', classification: 'ambiguous', error: `Video no longer exists on Meta — will re-upload: ${error.message}` }
    }
    const classified = classifyChainError(error)
    if (classified.kind === 'permanent') {
      await deleteAdVideo(videoId, systemToken).catch(() => {})
      await repo.deleteCampaignAdVideo(campaignId, userId)
      return { outcome: 'permanent', error: classified.message }
    }
    return { outcome: 'retryable', classification: classified.kind, error: classified.message }
  }
}

async function buildOwnerMetaChain(campaignId, userId, pageId, frozenInputs = null, resume = null) {
  const [campaign, creative, metaSettings] = frozenInputs
    ? [frozenInputs.campaign, frozenInputs.creative, frozenInputs.metaSettings]
    : await Promise.all([
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
  if (payload.bidAmountError) {
    await logMetaEvent({ campaignId, userId, action: 'create_all', error: payload.bidAmountError })
    return { success: false, error: payload.bidAmountError }
  }
  if (payload.placementError) {
    await logMetaEvent({ campaignId, userId, action: 'create_all', error: payload.placementError })
    return { success: false, error: payload.placementError }
  }
  if (payload.locationConflictError) {
    await logMetaEvent({ campaignId, userId, action: 'create_all', error: payload.locationConflictError })
    return { success: false, error: payload.locationConflictError }
  }

  const {
    targeting, adSetBudget, adSetSchedule, adSetPlacement,
    fbCampaignName, spendCapInPaise, campaignObjective, specialAdCategories,
    creativeMessage, creativeMediaUrl, creativeCallToAction, creativeExtra,
  } = payload

  const adopted = {
    facebook_campaign: resume?.existingIds?.facebook_campaign || null,
    ad_set: resume?.existingIds?.ad_set || null,
    ad_creative: resume?.existingIds?.ad_creative || null,
    ad: resume?.existingIds?.ad || null,
  }
  const resumedSteps = Object.values(adopted).filter(Boolean).length
  const reconcileBeforeCreate = Boolean(resume) && (resumedSteps > 0 || resume.ambiguousHint === true)

  if (!resume) {
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
  }

  const createdObjects = []

  const persistCreated = async (type, id) => {
    createdObjects.push({ type, id })
    try {
      await repo.createMetaObject(campaignId, type, id, null, type === 'ad_creative' ? null : 'PAUSED', userId)
    } catch (persistError) {
      if (resume?.onObjectCreated) {
        try {
          await resume.onObjectCreated(type, id)
          await logMetaEvent({ campaignId, userId, action: 'create_all', error: `meta row persist missed for ${type}, execution row holds ${id}` })
          return
        } catch {
          // fall through to throw below
        }
      }
      throw persistError
    }
    if (resume?.onObjectCreated) {
      try {
        await resume.onObjectCreated(type, id)
      } catch (err) {
        await logMetaEvent({ campaignId, userId, action: 'execution_row_patch', objectType: type, objectId: id, error: err.message })
      }
    }
  }

  const adoptReconciled = async (type, id) => {
    await execRepo.appendExecutionObjectAudit(campaignId, userId, { [type]: id })
    if (resume?.onObjectCreated) {
      try {
        await resume.onObjectCreated(type, id)
      } catch (err) {
        await logMetaEvent({ campaignId, userId, action: 'execution_row_patch', objectType: type, objectId: id, error: err.message })
      }
    }
  }

  const ids = { ...adopted }

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

  const rollbackThisRun = async () => {
    for (let i = createdObjects.length - 1; i >= 0; i--) {
      const obj = createdObjects[i]
      try {
        await META_ROLLBACK_FN[obj.type](obj.id, systemToken)
      } catch {
        // best-effort rollback
      }
    }
    await repo.deleteMetaObjectsByObjectIds(campaignId, createdObjects.map(o => o.id))
  }

  const runValidate = async (step, fn) => {
    try {
      await fn()
      return { outcome: 'ok' }
    } catch (error) {
      const classified = classifyChainError(error)
      const detail = extractMetaError(error)
      const message = detail?.userMsg || error.message
      await logMetaEvent({ campaignId, userId, action: step, error: message })
      if (classified.kind === 'permanent' || !resume) return { outcome: 'permanent', error: message }
      return { outcome: 'retryable', classification: classified.kind, error: message }
    }
  }

  const runLookup = async step => {
    try {
      return await reconcileChainStep({
        step, campaignId, ownerUserId: userId, adAccountId, systemToken,
        fbCampaignName, parentIds: { ...ids },
      })
    } catch (lookupError) {
      const lookupClassified = classifyChainError(lookupError)
      if (lookupClassified.kind === 'permanent') {
        return { confident: false, lookupBroken: true, error: lookupError.message }
      }
      return { confident: false, lookupFailed: true, classification: lookupClassified.kind, error: lookupError.message }
    }
  }

  const failClosed = (reason, failedStep) => ({ success: false, failClosed: true, error: reason, failedStep })

  const runCreate = async (step, createFn, logFields) => {
    const attempt = async () => {
      const t0 = Date.now()
      const data = await createFn()
      await persistCreated(step, data.id)
      await logMetaEvent({
        campaignId, userId, action: logFields.action, objectType: step, objectId: data.id,
        params: logFields.params, durationMs: Date.now() - t0,
      })
      return data.id
    }
    const adoptLookup = async lookup => {
      await adoptReconciled(step, lookup.id)
      if (lookup.creativeId && step === 'ad') {
        await adoptReconciled('ad_creative', lookup.creativeId)
        ids.ad_creative = lookup.creativeId
      }
      if (lookup.adId && step === 'ad_creative') {
        await adoptReconciled('ad', lookup.adId)
        ids.ad = lookup.adId
      }
      await logMetaEvent({ campaignId, userId, action: 'reconcile_adopt', objectType: step, objectId: lookup.id })
      return { outcome: 'adopted', id: lookup.id }
    }
    if (reconcileBeforeCreate) {
      const lookup = await runLookup(step)
      if (lookup.lookupBroken) {
        return { outcome: 'permanent', error: `reconcile unavailable for ${step}: ${lookup.error}` }
      }
      if (lookup.lookupFailed) {
        return { outcome: 'retryable', classification: lookup.classification, error: `reconcile failed for ${step}: ${lookup.error}` }
      }
      if (lookup.confident && lookup.id) return adoptLookup(lookup)
      if (lookup.closed) {
        return { outcome: 'closed', error: `cannot establish ${step} identity: ${lookup.reason}` }
      }
      if (!lookup.confidentAbsent) {
        return { outcome: 'retryable', classification: 'ambiguous', error: `cannot establish ${step} identity: ${lookup.reason}` }
      }
    }
    try {
      const id = await attempt()
      return { outcome: 'created', id }
    } catch (error) {
      const classified = classifyChainError(error)
      if (classified.kind === 'permanent') return { outcome: 'permanent', error: classified.message }
      if (!resume) throw error
      if (!reconcileBeforeCreate) {
        return { outcome: 'retryable', classification: classified.kind, error: classified.message }
      }
      const lookup = await runLookup(step)
      if (lookup.lookupBroken) {
        return { outcome: 'permanent', error: `reconcile unavailable for ${step}: ${lookup.error}` }
      }
      if (lookup.lookupFailed) {
        return { outcome: 'retryable', classification: lookup.classification, error: `reconcile failed for ${step}: ${lookup.error}` }
      }
      if (lookup.confident && lookup.id) return adoptLookup(lookup)
      if (lookup.closed) {
        return { outcome: 'closed', error: `cannot establish ${step} identity: ${lookup.reason}` }
      }
      if (!lookup.confidentAbsent) {
        return { outcome: 'retryable', classification: 'ambiguous', error: `cannot establish ${step} identity: ${lookup.reason}` }
      }
      try {
        const id = await attempt()
        return { outcome: 'created', id }
      } catch (retryError) {
        const retryClassified = classifyChainError(retryError)
        if (retryClassified.kind === 'permanent') return { outcome: 'permanent', error: retryClassified.message }
        return { outcome: 'retryable', classification: retryClassified.kind, error: retryClassified.message }
      }
    }
  }

  const failPermanent = async (message, failedStep) => {
    await rollbackThisRun()
    await logMetaEvent({ campaignId, userId, action: 'create_all', error: message })
    return { success: false, error: message, failedStep }
  }

  // Resolve video media to a real video_id before either creative step needs
  // it (the validate_creative dry-run below is the very first thing this
  // function does). Skipped once the creative already exists (nothing left
  // that needs the media reference) — see the two isVideoMediaUrl call sites
  // for why this specific guard (`!ids.ad_creative`) is sufficient.
  let creativeMediaUrlForBuild = creativeMediaUrl
  let creativeExtraForBuild = creativeExtra
  if (!ids.ad_creative && await detectVideoMedia(creativeMediaUrl)) {
    const videoResolved = await resolveVideoForCampaignCreative({ campaignId, userId, adAccountId, mediaUrl: creativeMediaUrl, systemToken })
    if (videoResolved.outcome !== 'ready') {
      await logMetaEvent({ campaignId, userId, action: 'resolve_video', error: videoResolved.error })
      if (videoResolved.outcome === 'permanent') return failPermanent(videoResolved.error, 'resolve_video')
      return { success: false, retryable: true, classification: videoResolved.classification, error: videoResolved.error, failedStep: 'resolve_video' }
    }
    creativeMediaUrlForBuild = null
    creativeExtraForBuild = { ...creativeExtra, video: { videoId: videoResolved.videoId } }
  }

  try {
    if (!ids.facebook_campaign) {
      const creativeValidation = await runValidate('validate_creative', () =>
        createAdCreative(adAccountId, pageId, creativeMessage, creativeMediaUrlForBuild, creativeCallToAction, systemToken, creativeExtraForBuild, true),
      )
      if (creativeValidation.outcome !== 'ok') {
        if (creativeValidation.outcome === 'permanent') return failPermanent(creativeValidation.error, 'validate_creative')
        return { success: false, retryable: true, classification: creativeValidation.classification, error: creativeValidation.error, failedStep: 'validate_creative' }
      }

      const campaignValidation = await runValidate('validate_campaign', () =>
        createAdCampaign(adAccountId, fbCampaignName, campaignObjective, 'PAUSED', systemToken, { spendCap: spendCapInPaise, specialAdCategories }, true),
      )
      if (campaignValidation.outcome !== 'ok') {
        if (campaignValidation.outcome === 'permanent') return failPermanent(campaignValidation.error, 'validate_campaign')
        return { success: false, retryable: true, classification: campaignValidation.classification, error: campaignValidation.error, failedStep: 'validate_campaign' }
      }

      const created = await runCreate('facebook_campaign', () =>
        createAdCampaign(adAccountId, fbCampaignName, campaignObjective, 'PAUSED', systemToken, { spendCap: spendCapInPaise, specialAdCategories }),
        { action: 'create_campaign', params: { name: fbCampaignName, objective: campaignObjective, specialAdCategories } },
      )
      if (created.outcome === 'permanent') return failPermanent(created.error, 'facebook_campaign')
      if (created.outcome === 'closed') return failClosed(created.error, 'facebook_campaign')
      if (created.outcome === 'retryable') {
        return { success: false, retryable: true, classification: created.classification, error: created.error, failedStep: 'facebook_campaign' }
      }
      ids.facebook_campaign = created.id
    }

    if (!ids.ad_set) {
      const adSetValidation = await runValidate('validate_ad_set', () =>
        createAdSet(adAccountId, ids.facebook_campaign, targeting, adSetBudget, adSetSchedule, adSetPlacement, systemToken, true),
      )
      if (adSetValidation.outcome !== 'ok') {
        if (adSetValidation.outcome === 'permanent') return failPermanent(adSetValidation.error, 'validate_ad_set')
        return { success: false, retryable: true, classification: adSetValidation.classification, error: adSetValidation.error, failedStep: 'validate_ad_set' }
      }

      const created = await runCreate('ad_set', () =>
        createAdSet(adAccountId, ids.facebook_campaign, targeting, adSetBudget, adSetSchedule, adSetPlacement, systemToken),
        { action: 'create_ad_set', params: { campaignId: ids.facebook_campaign } },
      )
      if (created.outcome === 'permanent') return failPermanent(created.error, 'ad_set')
      if (created.outcome === 'closed') return failClosed(created.error, 'ad_set')
      if (created.outcome === 'retryable') {
        return { success: false, retryable: true, classification: created.classification, error: created.error, failedStep: 'ad_set' }
      }
      ids.ad_set = created.id
    }

    if (!ids.ad_creative) {
      const created = await runCreate('ad_creative', () =>
        createAdCreative(adAccountId, pageId, creativeMessage, creativeMediaUrlForBuild, creativeCallToAction, systemToken, creativeExtraForBuild),
        { action: 'create_creative', params: { pageId } },
      )
      if (created.outcome === 'permanent') return failPermanent(created.error, 'ad_creative')
      if (created.outcome === 'closed') return failClosed(created.error, 'ad_creative')
      if (created.outcome === 'retryable') {
        return { success: false, retryable: true, classification: created.classification, error: created.error, failedStep: 'ad_creative' }
      }
      ids.ad_creative = created.id
    }

    if (!ids.ad) {
      const adValidation = await runValidate('validate_ad', () =>
        createAd(adAccountId, ids.ad_set, ids.ad_creative, fbCampaignName, systemToken, 'PAUSED', { urlTags: buildUrlTags(creative) }, true),
      )
      if (adValidation.outcome !== 'ok') {
        if (adValidation.outcome === 'permanent') return failPermanent(adValidation.error, 'validate_ad')
        return { success: false, retryable: true, classification: adValidation.classification, error: adValidation.error, failedStep: 'validate_ad' }
      }

      const urlTags = buildUrlTags(creative)
      const created = await runCreate('ad', () =>
        createAd(adAccountId, ids.ad_set, ids.ad_creative, fbCampaignName, systemToken, 'PAUSED', { urlTags }),
        { action: 'create_ad', params: { adSetId: ids.ad_set, creativeId: ids.ad_creative } },
      )
      if (created.outcome === 'permanent') return failPermanent(created.error, 'ad')
      if (created.outcome === 'closed') return failClosed(created.error, 'ad')
      if (created.outcome === 'retryable') {
        return { success: false, retryable: true, classification: created.classification, error: created.error, failedStep: 'ad' }
      }
      ids.ad = created.id
    }

    return { success: true }
  } catch (error) {
    await rollbackThisRun()
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

export async function findForeignTracker(objectId, campaignId, ownerUserId) {
  const executionHit = await execRepo.findExecutionByMetaId(objectId)
  if (executionHit && (executionHit.campaignId !== campaignId || executionHit.ownerUserId !== ownerUserId)) {
    return { tracked: true, holder: `${executionHit.campaignId.substring(0, 8)}:${executionHit.ownerUserId.substring(0, 8)}:${executionHit.kind}` }
  }
  const generationHit = await execRepo.findGenerationByMetaId(objectId)
  if (generationHit) {
    const holderExecution = await execRepo.findExecutionById(generationHit.executionId)
    const activeNo = holderExecution?.activeGenerationNo
    if (activeNo !== null && activeNo !== undefined && Number(activeNo) !== Number(generationHit.generationNo)) {
      return { tracked: true, holder: `gen:${generationHit.executionId.substring(0, 8)}:${generationHit.generationNo}` }
    }
  }
  const rowHit = await repo.findMetaObjectByObjectId(objectId)
  if (rowHit) {
    const rowOwner = rowHit.createdForUserId
    if (rowOwner && (rowHit.campaignId !== campaignId || rowOwner !== ownerUserId)) {
      return { tracked: true, holder: `${rowHit.campaignId.substring(0, 8)}:${rowOwner.substring(0, 8)}` }
    }
  }
  return { tracked: false }
}

async function adoptableCandidates(candidates, campaignId, ownerUserId) {
  const free = []
  for (const candidate of candidates) {
    const tracker = await findForeignTracker(candidate.id, campaignId, ownerUserId)
    if (!tracker.tracked) free.push(candidate)
  }
  return free
}

async function reconcileChainStep({ step, campaignId, ownerUserId, adAccountId, systemToken, fbCampaignName, parentIds }) {
  if (step === 'facebook_campaign') {
    const { rows } = await listAccountCampaigns(adAccountId, systemToken)
    const matches = rows.filter(r => r.name === fbCampaignName)
    if (!matches.length) return { confident: false, confidentAbsent: true }
    const free = await adoptableCandidates(matches, campaignId, ownerUserId)
    if (free.length === 1) {
      return { confident: true, id: free[0].id, basis: matches.length === 1 ? 'unique-name-match' : 'name-match-untracked' }
    }
    if (!free.length) return { confident: false, confidentAbsent: true }
    return { confident: false, closed: true, reason: 'multiple-untracked-candidates' }
  }
  if (step === 'ad_set') {
    if (!parentIds.facebook_campaign) return { confident: false, reason: 'missing-parent-campaign' }
    const { rows } = await listCampaignAdSets(parentIds.facebook_campaign, systemToken)
    const expectedName = `Ad Set ${parentIds.facebook_campaign.substring(0, 8)}`
    const named = rows.filter(r => r.name === expectedName)
    const pool = named.length ? named : rows
    if (!pool.length) return { confident: false, confidentAbsent: true }
    if (pool.length === 1) {
      const tracker = await findForeignTracker(pool[0].id, campaignId, ownerUserId)
      if (!tracker.tracked) {
        return { confident: true, id: pool[0].id, basis: named.length ? 'name-match' : 'single-child' }
      }
      return { confident: false, confidentAbsent: true }
    }
    const free = await adoptableCandidates(pool, campaignId, ownerUserId)
    if (free.length === 1) return { confident: true, id: free[0].id, basis: 'single-untracked-child' }
    if (!free.length) return { confident: false, confidentAbsent: true }
    return { confident: false, closed: true, reason: 'multiple-untracked-children' }
  }
  if (step === 'ad') {
    if (!parentIds.ad_set) return { confident: false, reason: 'missing-parent-adset' }
    const { rows } = await listAdSetAds(parentIds.ad_set, systemToken)
    const named = rows.filter(r => r.name === fbCampaignName)
    const pool = named.length ? named : rows
    if (!pool.length) return { confident: false, confidentAbsent: true }
    const free = await adoptableCandidates(pool, campaignId, ownerUserId)
    if (!free.length) return { confident: false, confidentAbsent: true }
    if (free.length > 1) return { confident: false, closed: true, reason: 'multiple-untracked-children' }
    const pick = free[0]
    let creativeId = pick.creative?.id || null
    if (creativeId) {
      try {
        await getMetaObject(creativeId, systemToken, 'id')
      } catch (probeError) {
        if (isMissingObjectError(probeError)) {
          return { confident: false, reason: 'adopted-ad-creative-missing' }
        }
        throw probeError
      }
    }
    return { confident: true, id: pick.id, creativeId, basis: named.length ? 'name-match' : 'single-child' }
  }
  if (step === 'ad_creative') {
    if (!parentIds.facebook_campaign) return { confident: false, reason: 'no-creative-fingerprint' }
    const { rows: adsets } = await listCampaignAdSets(parentIds.facebook_campaign, systemToken)
    const candidates = []
    for (const adset of adsets.slice(0, 25)) {
      const { rows: ads } = await listAdSetAds(adset.id, systemToken)
      for (const ad of ads) {
        if (ad.name === fbCampaignName && ad.creative?.id) candidates.push({ ad, creativeId: ad.creative.id })
      }
    }
    if (!candidates.length) return { confident: false, confidentAbsent: true }
    const free = []
    for (const candidate of candidates) {
      const tracker = await findForeignTracker(candidate.ad.id, campaignId, ownerUserId)
      if (!tracker.tracked) free.push(candidate)
    }
    if (!free.length) return { confident: false, confidentAbsent: true }
    if (free.length > 1) return { confident: false, reason: 'multiple-untracked-candidates' }
    try {
      await getMetaObject(free[0].creativeId, systemToken, 'id')
    } catch (probeError) {
      if (isMissingObjectError(probeError)) {
        return { confident: false, reason: 'adopted-creative-missing' }
      }
      throw probeError
    }
    return { confident: true, id: free[0].creativeId, adId: free[0].ad.id, basis: 'ad-name-match' }
  }
  return { confident: false, reason: 'no-creative-fingerprint' }
}

const EXECUTION_CREATABLE_CAMPAIGN_STATUSES = [
  CAMPAIGN_STATUS.PENDING_REVIEW,
  CAMPAIGN_STATUS.APPROVED,
  CAMPAIGN_STATUS.AWAITING_PUBLISHERS,
  CAMPAIGN_STATUS.SCHEDULED,
]

function executionHasCompleteIds(execution) {
  return Boolean(
    execution?.platformCampaignId &&
    execution?.platformAdsetId &&
    execution?.platformCreativeId &&
    execution?.platformAdId
  )
}

async function createMetaAdObjectsForUser(campaignId, userId, pageId) {
  return buildOwnerMetaChain(campaignId, userId, pageId)
}

async function gateCampaignAdContent(campaignId) {
  const snapshot = await repo.findCampaignSnapshot(campaignId)
  let creative
  let metaSettings
  if (snapshot?.config) {
    creative = snapshot.config.creative
    metaSettings = snapshot.config.settings
  } else {
    ;[creative, metaSettings] = await Promise.all([
      repo.findCreativeByCampaignId(campaignId),
      repo.findMetaSettingsByCampaignId(campaignId),
    ])
  }
  return checkAdContentForMeta({ creative, metaSettings })
}

export async function routeOwnerChainCreation(campaignId, userId, pageId, options = {}) {
  const gate = await gateCampaignAdContent(campaignId)
  if (!gate.ok) {
    await logMetaEvent({ campaignId, userId, action: 'ad_content_gate', error: gate.message })
    return { path: 'gate', success: false, error: gate.message, retryable: !!gate.retryable }
  }
  if (!(await isCampaignExecutionRuntimeEnabled())) {
    const result = await createMetaAdObjectsForUser(campaignId, userId, pageId)
    return { path: 'legacy', ...result }
  }
  return runExecutionChainCreation(campaignId, userId, pageId, options)
}

export async function runExecutionChainCreation(campaignId, userId, pageId, options = {}) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) {
    await logMetaEvent({ campaignId, userId, action: 'execution_route', error: 'Campaign not found' })
    throw new ValidationError('Campaign not found')
  }
  const kind = userId === campaign.clientId ? EXECUTION_KIND.CLIENT : EXECUTION_KIND.PUBLISHER
  const execution = await execRepo.findExecutionByOwner(campaignId, userId, kind)
  if (!execution) {
    // Reachable only when the execution runtime is ON (the flag-OFF legacy
    // path returns before this function). Never build Meta chains outside
    // the execution model — fail closed so the missing row is staged first.
    await logMetaEvent({ campaignId, userId, action: 'execution_required_missing', params: { kind, runtime: 'on', operation: 'runExecutionChainCreation' }, error: 'Campaign execution required but missing' })
    return { path: 'execution', success: false, failClosed: true, error: 'Campaign execution required but missing (no row for owner/kind)' }
  }
  const entries = await repo.findBillingEntries(campaignId)
  const quarantine = classifyRuntimeQuarantine({
    campaign,
    chargeCount: entries.filter(e => e.kind === 'charge').length,
  })
  if (quarantine) {
    await logMetaEvent({ campaignId, userId, action: 'execution_route', error: `quarantined: ${quarantine}` })
    return { path: 'execution', executionId: execution.id, success: false, skipped: 'quarantined', quarantine, error: `Execution quarantined (${quarantine})` }
  }
  if (!options.skipCampaignStatusGate && !EXECUTION_CREATABLE_CAMPAIGN_STATUSES.includes(campaign.status)) {
    await logMetaEvent({ campaignId, userId, action: 'execution_route', error: `campaign status ${campaign.status} forbids execution` })
    throw new ValidationError(`Campaign status ${campaign.status} forbids execution creation`)
  }
  if (![EXECUTION_STATUS.PENDING, EXECUTION_STATUS.VALIDATING, EXECUTION_STATUS.CREATING, EXECUTION_STATUS.ACTIVE, EXECUTION_STATUS.PAUSED].includes(execution.status)) {
    await logMetaEvent({ campaignId, userId, action: 'execution_route', error: `execution terminal (${execution.status})` })
    return { path: 'execution', executionId: execution.id, success: false, skipped: 'terminal', error: `Execution terminal (${execution.status})` }
  }
  if (executionHasCompleteIds(execution)) {
    await logMetaEvent({ campaignId, userId, action: 'execution_route', error: 'already-live adopt-skip' })
    return { path: 'execution', executionId: execution.id, success: true, skipped: 'already-live', actionable: false }
  }
  if (execution.status === EXECUTION_STATUS.ACTIVE || execution.status === EXECUTION_STATUS.PAUSED) {
    await logMetaEvent({ campaignId, userId, action: 'execution_route', error: 'live execution without Meta IDs' })
    throw new ValidationError('Live execution without Meta IDs cannot be recreated in Step 9')
  }
  const ownerObjects = await repo.findMetaObjectsForUser(campaignId, userId)
  const legacyChain = resolveMetaObjects(ownerObjects)
  if (legacyChain.facebook_campaign && legacyChain.ad_set && legacyChain.ad_creative && legacyChain.ad) {
    await execRepo.updateExecution(execution.id, {
      platformCampaignId: legacyChain.facebook_campaign.objectId,
      platformAdsetId: legacyChain.ad_set.objectId,
      platformCreativeId: legacyChain.ad_creative.objectId,
      platformAdId: legacyChain.ad.objectId,
      status: EXECUTION_STATUS.ACTIVE,
    })
    await logMetaEvent({ campaignId, userId, action: 'execution_adopt', error: 'adopted legacy chain, zero Meta calls' })
    return { path: 'execution', executionId: execution.id, success: true, skipped: 'adopted-legacy-chain', actionable: false }
  }
  const legacyFbIds = [...new Set(ownerObjects.filter(o => o.objectType === 'facebook_campaign').map(o => o.objectId))]
  const knownFbIds = [...new Set([execution.platformCampaignId, ...legacyFbIds].filter(Boolean))]
  if (knownFbIds.length > 1) {
    await logMetaEvent({ campaignId, userId, action: 'execution_route', error: 'duplicate owner chains, refusing to guess' })
    return { path: 'execution', executionId: execution.id, success: false, failClosed: true, error: 'Execution has duplicate owner chains (fail closed)' }
  }
  const resumeIds = {
    facebook_campaign: execution.platformCampaignId || legacyChain.facebook_campaign?.objectId || null,
    ad_set: execution.platformAdsetId || legacyChain.ad_set?.objectId || null,
    ad_creative: execution.platformCreativeId || legacyChain.ad_creative?.objectId || null,
    ad: execution.platformAdId || legacyChain.ad?.objectId || null,
  }
  if (!resumeIds.facebook_campaign && ownerObjects.length > 0) {
    await logMetaEvent({ campaignId, userId, action: 'execution_route', error: 'orphaned legacy children with unknown parent' })
    return { path: 'execution', executionId: execution.id, success: false, failClosed: true, error: 'Execution has orphaned chain objects with unknown parent (fail closed)' }
  }
  const mergePatch = {}
  if (!execution.platformCampaignId && resumeIds.facebook_campaign) mergePatch.platformCampaignId = resumeIds.facebook_campaign
  if (!execution.platformAdsetId && resumeIds.ad_set) mergePatch.platformAdsetId = resumeIds.ad_set
  if (!execution.platformCreativeId && resumeIds.ad_creative) mergePatch.platformCreativeId = resumeIds.ad_creative
  if (!execution.platformAdId && resumeIds.ad) mergePatch.platformAdId = resumeIds.ad
  if (Object.keys(mergePatch).length) {
    await execRepo.updateExecution(execution.id, mergePatch)
    await logMetaEvent({ campaignId, userId, action: 'execution_resume_merge', error: 'merged legacy IDs into execution, zero Meta calls' })
  }
  const ensured = await ensureCampaignSnapshot(campaignId)
  if (!ensured.snapshot) {
    await logMetaEvent({ campaignId, userId, action: 'execution_route', error: `unresolvable snapshot (${ensured.reason})` })
    return { path: 'execution', executionId: execution.id, success: false, failClosed: true, error: `Execution snapshot unresolvable (${ensured.reason})` }
  }
  const checked = checkExecutionSnapshot(ensured.snapshot, execution)
  if (!checked.ok) {
    await logMetaEvent({ campaignId, userId, action: 'execution_route', error: `snapshot ${checked.reason}` })
    return { path: 'execution', executionId: execution.id, success: false, failClosed: true, error: `Execution snapshot ${checked.reason}` }
  }
  if (!execution.configHash) {
    await execRepo.updateExecution(execution.id, { configHash: ensured.snapshot.hash })
  }
  let frozenPageId = execution.fbPageId
  if (!frozenPageId) {
    if (!pageId) {
      await logMetaEvent({ campaignId, userId, action: 'execution_route', error: 'no frozen page and no incoming page' })
      return { path: 'execution', executionId: execution.id, success: false, failClosed: true, error: 'Execution has no frozen page to build with' }
    }
    await execRepo.updateExecution(execution.id, { fbPageId: pageId })
    frozenPageId = pageId
  } else if (frozenPageId !== pageId) {
    await logMetaEvent({ campaignId, userId, action: 'execution_route', error: 'incoming page ignored, frozen page wins' })
  }
  const frozenInputs = {
    campaign: checked.config.campaign,
    creative: checked.config.creative,
    metaSettings: checked.config.settings,
  }
  const executionColumnForType = {
    facebook_campaign: 'platformCampaignId',
    ad_set: 'platformAdsetId',
    ad_creative: 'platformCreativeId',
    ad: 'platformAdId',
  }

  // Atomic per-execution claim: the ONLY thing preventing two genuinely
  // concurrent callers (e.g. a lingering PUBLISHER_GO_LIVE job racing a
  // manually-triggered RETRY_META job, both processed in the same worker
  // tick via Promise.all) from both reading "nothing built yet" above and
  // both calling buildOwnerMetaChain — producing two real, separate Meta
  // chains for the same owner. A guarded single-row UPDATE, same pattern
  // the repair generation state machine already uses for every hop.
  const claimed = await execRepo.updateExecutionWithStatusGuard(
    execution.id, [EXECUTION_STATUS.PENDING, EXECUTION_STATUS.VALIDATING], { status: EXECUTION_STATUS.CREATING }
  )
  if (!claimed) {
    const fresh = await execRepo.findExecutionById(execution.id)
    if (executionHasCompleteIds(fresh)) {
      await logMetaEvent({ campaignId, userId, action: 'execution_claim_lost', error: 'adopted already-complete chain' })
      return { path: 'execution', executionId: execution.id, success: true, skipped: 'already-live', actionable: false }
    }
    if (TERMINAL_EXECUTION_STATUSES.includes(fresh?.status)) {
      await logMetaEvent({ campaignId, userId, action: 'execution_claim_lost', error: `now terminal (${fresh.status})` })
      return { path: 'execution', executionId: execution.id, success: false, skipped: 'terminal', error: `Execution terminal (${fresh.status})` }
    }
    await logMetaEvent({ campaignId, userId, action: 'execution_claim_lost', error: 'claimed by a concurrent caller' })
    return { path: 'execution', executionId: execution.id, success: false, retryable: true, skipped: 'claimed-elsewhere', actionable: false, error: 'Execution is being built by a concurrent caller' }
  }

  const result = await buildOwnerMetaChain(campaignId, userId, frozenPageId, frozenInputs, {
    existingIds: resumeIds,
    ambiguousHint: execution.attempts > 0,
    onObjectCreated: async (type, id) => {
      const column = executionColumnForType[type]
      if (column) await execRepo.updateExecution(execution.id, { [column]: id })
    },
  })
  if (result.success) {
    const fresh = resolveMetaObjects(await repo.findMetaObjectsForUser(campaignId, userId))
    const current = await execRepo.findExecutionById(execution.id)
    const finalIds = {
      platformCampaignId: fresh.facebook_campaign?.objectId || current?.platformCampaignId || null,
      platformAdsetId: fresh.ad_set?.objectId || current?.platformAdsetId || null,
      platformCreativeId: fresh.ad_creative?.objectId || current?.platformCreativeId || null,
      platformAdId: fresh.ad?.objectId || current?.platformAdId || null,
    }
    await execRepo.appendExecutionObjectAudit(campaignId, userId, {
      facebook_campaign: finalIds.platformCampaignId,
      ad_set: finalIds.platformAdsetId,
      ad_creative: finalIds.platformCreativeId,
      ad: finalIds.platformAdId,
    })
    await execRepo.updateExecution(execution.id, {
      ...finalIds,
      status: EXECUTION_STATUS.CREATING,
      attempts: execution.attempts + 1,
      error: null,
    })
    await logMetaEvent({ campaignId, userId, action: 'execution_created' })
    await logMetaEvent({ campaignId, userId, action: 'execution_meta_campaign_created', params: { executionId: execution.id, kind, platformCampaignId: finalIds.platformCampaignId } })
  } else {
    const recordedError = result.retryable ? `[${result.classification}] ${result.error}` : result.error
    await execRepo.updateExecution(execution.id, {
      attempts: execution.attempts + 1,
      error: recordedError,
      // Release the claim taken above on a retryable failure — otherwise
      // the execution would be stuck at 'creating' forever (every future
      // claim's WHERE status IN ('pending','validating') would match zero
      // rows), permanently breaking retries for the single most common
      // failure mode (any transient Meta error).
      status: result.retryable ? EXECUTION_STATUS.PENDING : EXECUTION_STATUS.FAILED,
    })
    await logMetaEvent({ campaignId, userId, action: 'execution_failed', error: recordedError })
  }
  return { path: 'execution', executionId: execution.id, ...result }
}

export async function validateCampaignDraft(userId, campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
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

  return preValidateCampaignForOwner(campaignId, userId)
}

export async function checkCreativeMediaForMeta({ mediaUrl, platformPlacement }) {
  return checkAdMediaForMeta({ mediaUrl, platformPlacement })
}

// Lightweight, pre-draft media check — no campaign needs to exist yet, so
// this can run the moment a user pastes a URL, uploads a file, or picks
// something from the media library while filling out the campaign form,
// before "Validate with Meta" or any Meta object is ever created.
export async function checkCampaignMedia({ mediaUrl, platformPlacement }) {
  if (!mediaUrl) return { ok: true, errorCode: null, message: null }
  const failure = await checkAdMediaForMeta({ mediaUrl, platformPlacement })
  return failure || { ok: true, errorCode: null, message: null }
}

export async function preValidateCampaignForOwner(campaignId, ownerId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')

  const { accountId: adAccountId, accessToken: systemToken } = await resolveAccountContext()
  if (!adAccountId || !systemToken) {
    return { valid: false, checks: [], error: 'Meta Ads not configured' }
  }

  const page = await repo.findVerifiedFacebookPage(ownerId)
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
  if (payload.bidAmountError) {
    return { valid: false, checks: [], error: payload.bidAmountError }
  }
  if (payload.placementError) {
    return { valid: false, checks: [], error: payload.placementError }
  }
  if (payload.locationConflictError) {
    return { valid: false, checks: [], error: payload.locationConflictError }
  }

  const checks = []
  const contentGate = await checkAdContentForMeta({ creative, metaSettings })
  if (!contentGate.ok) {
    checks.push({ object: 'creative', ok: false, error: contentGate.message })
  }
  const run = async (object, fn) => {
    try {
      await fn()
      checks.push({ object, ok: true })
    } catch (error) {
      const detail = extractMetaError(error)
      checks.push({ object, ok: false, error: detail?.userMsg || error.message })
    }
  }

  let creativeMediaUrlForValidate = payload.creativeMediaUrl
  let creativeExtraForValidate = payload.creativeExtra
  if (contentGate.ok && await detectVideoMedia(payload.creativeMediaUrl)) {
    const videoResolved = await resolveVideoForCampaignCreative({ campaignId, userId: ownerId, adAccountId, mediaUrl: payload.creativeMediaUrl, systemToken })
    if (videoResolved.outcome !== 'ready') {
      checks.push({ object: 'creative', ok: false, error: videoResolved.error })
    } else {
      creativeMediaUrlForValidate = null
      creativeExtraForValidate = { ...payload.creativeExtra, video: { videoId: videoResolved.videoId } }
    }
  }

  if (!checks.some(c => c.object === 'creative' && !c.ok)) {
    await run('creative', () =>
      createAdCreative(adAccountId, page.platformUserId, payload.creativeMessage, creativeMediaUrlForValidate, payload.creativeCallToAction, systemToken, creativeExtraForValidate, true),
    )
  }
  await run('campaign', () =>
    createAdCampaign(adAccountId, payload.fbCampaignName, payload.campaignObjective, 'PAUSED', systemToken, { spendCap: payload.spendCapInPaise, specialAdCategories: payload.specialAdCategories }, true),
  )

  const failed = checks.filter(c => !c.ok)
  await logMetaEvent({
    campaignId, userId: ownerId, action: 'pre_validate',
    error: failed.length ? failed.map(c => c.error).join('; ') : null,
  })

  return { valid: failed.length === 0, checks, error: failed[0]?.error || null }
}

// approveAndGoLive/confirmAndGoLive/forceGoLiveCampaign's established,
// test-proven contract is "permanent (ValidationError) by default" — on the
// legacy (non-resumable) buildOwnerMetaChain path, ordinary chain-step
// failures (validate_campaign, create_ad_set, ...) are deliberately reported
// with NO `retryable` flag (buildOwnerMetaChain forces `outcome:'permanent'`
// whenever `!resume`, since blindly retrying a partially-built legacy chain
// without reconciliation risks duplicate Meta objects). The ONLY thing that
// legitimately sets `retryable:true` there today is resolveVideoForCampaignCreative,
// which has its OWN idempotent persistence (campaign_ad_videos) making a
// retry safe independent of `resume` — so this helper's job is narrow: honor
// that one explicit, positive "safe to retry" signal, and otherwise keep the
// exact pre-existing permanent-by-default behavior untouched.
function throwGoLiveFailure(result, prefix) {
  const message = `${prefix}: ${result.error}`
  if (result.retryable) throw new Error(message)
  throw new ValidationError(message)
}

// goLiveForFilledCampaign has the OPPOSITE, equally test-proven contract:
// transient (bare Error, job backoff) by default, permanent only for the two
// failure classes that carry an explicit "this will never succeed on retry"
// signal — the ad-content gate (path==='gate') UNLESS the gate itself marked
// its own failure retryable (e.g. a network/timeout hiccup fetching the
// media to verify it — checkAdMediaForMeta's MEDIA_UNVERIFIABLE/
// MEDIA_TRUNCATED results, which literally tell the user "please retry" —
// treating those as permanent turned an ordinary transient blip into a dead
// job requiring manual intervention every time) — and a definitively-
// permanent video resolution failure (failedStep==='resolve_video' with no
// retryable flag, i.e. resolveVideoForCampaignCreative's own permanent
// classification).
// Do NOT unify this with throwGoLiveFailure — a real, currently-passing test
// (campaign-jobs.test.js: "retries transient failures with backoff and dies
// after max attempts", via CAMPAIGN_JOB_TYPES.PUBLISHER_GO_LIVE) depends on
// ordinary chain-step failures staying transient here specifically, even
// though the exact same failure shape is treated as permanent by
// throwGoLiveFailure above.
function throwClientLegFailure(result, prefix) {
  const message = `${prefix}: ${result.error}`
  const isPermanent = (result.path === 'gate' && !result.retryable) || (result.failedStep === 'resolve_video' && !result.retryable)
  if (isPermanent) throw new ValidationError(message)
  throw new Error(message)
}

async function publishAdForClient(campaignId, options = {}) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) return { success: false, error: 'Campaign not found' }

  const page = await repo.findVerifiedFacebookPage(campaign.clientId)
  if (!page) {
    const error = 'Client has no verified Facebook page'
    await repo.updateCampaign(campaignId, { metaStatus: 'failed', metaError: error })
    await logMetaEvent({ campaignId, userId: campaign.clientId, action: 'publish_client', error })
    return { success: false, error }
  }

  const result = await routeOwnerChainCreation(campaignId, campaign.clientId, page.platformUserId, options)

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

    // Publisher flow — await publishers before creating Meta ads.
    // Async since Step 13: validate + stage here, spend/transition/requests run
    // in the approve_publisher worker. Client-only approve keeps its 202 below.
    if (campaign.categoryId && campaign.publisherCount && campaign.coinsPerPublisher) {
      return queuePublisherApprovalFlow(campaign, { flow: 'approve', actorId: adminId, notes: data.notes || null })
    }

    // Mirrors queuePublisherApprovalFlow's staging call — without it, the
    // execution runtime's fail-closed guard in runExecutionChainCreation has
    // no row to find once the approve_go_live job actually runs, and every
    // brand-new client-only campaign dies with "Campaign execution required
    // but missing (no row for owner/kind)" the first time it's approved.
    //
    // The rearm is equally required: campaign.status stays PENDING_REVIEW
    // even after a permanently-failed publish attempt (the status transition
    // only happens after publishAdForClient succeeds), so an admin can — and
    // routinely does, e.g. after fixing a schedule/budget issue — click
    // Approve again on the SAME campaign. Without rearming, this second
    // approval finds the execution row already in its terminal 'failed'
    // state from the first attempt and immediately fails closed with
    // "Execution terminal (failed)" instead of actually retrying — only
    // retryCampaignMeta used to rearm, but re-approving is the more natural
    // action for a still-pending_review campaign than clicking Retry.
    await findOrCreatePendingExecution(campaignId, campaign.clientId, EXECUTION_KIND.CLIENT)
    await rearmFailedExecution(campaignId, campaign.clientId, EXECUTION_KIND.CLIENT)

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

export async function queuePublisherApprovalFlow(campaign, { flow, actorId, notes = null }) {
  const entries = await repo.findBillingEntries(campaign.id)
  const quarantine = classifyRuntimeQuarantine({
    campaign,
    chargeCount: entries.filter(e => e.kind === 'charge').length,
  })
  if (quarantine) {
    throw new ValidationError(`Campaign quarantined (${quarantine}) — manual review required`)
  }
  const pre = await preValidateCampaignForOwner(campaign.id, campaign.clientId)
  if (!pre.valid) {
    throw new ValidationError(pre.error || 'Meta pre-validation failed')
  }
  const { execution } = await findOrCreatePendingExecution(campaign.id, campaign.clientId, EXECUTION_KIND.CLIENT)
  const activeJob = await repo.findActiveCampaignJob(campaign.id, CAMPAIGN_JOB_TYPES.APPROVE_PUBLISHER)
  if (activeJob) {
    return { queued: true, jobId: activeJob.id, campaign, executionId: execution.id, duplicate: true }
  }
  await enqueueCampaignJob(campaign.id, CAMPAIGN_JOB_TYPES.APPROVE_PUBLISHER, actorId, { flow, notes })
  const staged = await repo.findActiveCampaignJob(campaign.id, CAMPAIGN_JOB_TYPES.APPROVE_PUBLISHER)
  return { queued: true, jobId: staged ? staged.id : null, campaign, executionId: execution.id }
}

export async function approvePublisherFlow(campaignId, actorId, payload = {}) {
  const flow = payload?.flow === 'confirm' ? 'confirm' : 'approve'
  const sourceStatus = flow === 'confirm' ? CAMPAIGN_STATUS.APPROVED : CAMPAIGN_STATUS.PENDING_REVIEW
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (![sourceStatus, CAMPAIGN_STATUS.AWAITING_PUBLISHERS].includes(campaign.status)) {
    throw new ValidationError(`Campaign must be in ${sourceStatus} status`)
  }
  if (!campaign.categoryId || !campaign.publisherCount || !campaign.coinsPerPublisher) {
    throw new ValidationError('Campaign is not a publisher campaign')
  }

  await findOrCreatePendingExecution(campaignId, campaign.clientId, EXECUTION_KIND.CLIENT)

  const coinService = await import('../../../shared/services/coin.service.js')
  await transaction(async () => {
    await repo.lockCampaignById(campaignId)
    const locked = await repo.findCampaignById(campaignId)
    if (locked.status === CAMPAIGN_STATUS.AWAITING_PUBLISHERS) {
      return
    }
    if (locked.status !== sourceStatus) {
      throw new ValidationError(`Campaign must be in ${sourceStatus} status`)
    }
    if (!locked.coinsEscrowedAt) {
      const totalEscrow = calculateTotalEscrow(locked)
      const metaSettings = await repo.findMetaSettingsByCampaignId(campaignId)
      const adBudgetCost = calculateAdBudget(metaSettings, locked.publisherCount)
      const totalDeduction = totalEscrow + adBudgetCost
      const available = await coinService.getAvailable(locked.clientId)
      if (available.total < totalDeduction) {
        throw new ValidationError('Client has insufficient coins. Campaign cannot be approved.')
      }
      await coinService.spend(locked.clientId, totalDeduction, 'campaign_escrow', campaignId, `Campaign escrow: ${locked.name}`)
      await repo.updateCampaign(campaignId, {
        escrowAmount: totalEscrow,
        coinsEscrowedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      })
    }
    if (flow === 'confirm') {
      const deadlineDays = await getPublisherResponseDeadlineDays()
      const deadlineAt = new Date()
      deadlineAt.setDate(deadlineAt.getDate() + deadlineDays)
      await repo.updateCampaignWithStatusGuard(campaignId, {
        status: CAMPAIGN_STATUS.AWAITING_PUBLISHERS,
        escrowAmount: calculateTotalEscrow(locked),
        coinsEscrowedAt: locked.coinsEscrowedAt || new Date().toISOString().slice(0, 19).replace('T', ' '),
        publisherResponseDeadlineAt: deadlineAt.toISOString().slice(0, 19).replace('T', ' '),
        clientConfirmed: true,
        clientConfirmedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      }, CAMPAIGN_STATUS.APPROVED)
      await repo.createReviewLog(campaignId, actorId || locked.clientId, REVIEW_ACTIONS.CONFIRMED, CAMPAIGN_STATUS.APPROVED,
        `Client confirmed — awaiting ${locked.publisherCount} publishers`)
    } else {
      const deadlineAt = await effectivePublisherDeadline(locked.scheduledAt)
      await repo.updateCampaignWithStatusGuard(campaignId, {
        status: CAMPAIGN_STATUS.AWAITING_PUBLISHERS,
        escrowAmount: calculateTotalEscrow(locked),
        coinsEscrowedAt: locked.coinsEscrowedAt || new Date().toISOString().slice(0, 19).replace('T', ' '),
        publisherResponseDeadlineAt: deadlineAt.toISOString().slice(0, 19).replace('T', ' '),
        reviewedBy: actorId,
        reviewedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
        reviewNotes: payload?.notes || null,
      }, CAMPAIGN_STATUS.PENDING_REVIEW)
      await repo.createReviewLog(campaignId, actorId, REVIEW_ACTIONS.APPROVED, CAMPAIGN_STATUS.PENDING_REVIEW,
        `Approved — awaiting ${locked.publisherCount} publishers`)
    }
  })

  // Live-verified bug: after reopenFailedAwaitingPublishersCampaign cancels
  // every request (including already-accepted ones) and resets the campaign
  // to draft for a fix-and-resubmit cycle, the cancelled rows are kept (not
  // deleted) for audit history. Re-approving then found existingRequests
  // non-empty (10 cancelled rows) and silently skipped inviting anyone —
  // the campaign went to AWAITING_PUBLISHERS with zero live requests, so
  // every row a client/admin saw was the stale 'cancelled' batch forever.
  // The guard must only suppress re-inviting when a request from the
  // CURRENT cycle is still outstanding (pending/accepted) — terminal rows
  // (cancelled/rejected) from a prior cycle must never block a fresh batch.
  const existingRequests = await repo.findPublisherRequestsByCampaignId(campaignId)
  const hasLiveRequest = existingRequests.some(r => ['pending', 'accepted'].includes(r.status))
  if (!hasLiveRequest) {
    const multiplier = await getPublisherRequestMultiplier()
    await createPublisherRequestsForCampaign(campaignId, campaign.categoryId, campaign.publisherCount, campaign.coinsPerPublisher, multiplier)
  }
  return repo.findCampaignById(campaignId)
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
    throwGoLiveFailure(publishResult, 'Failed to publish campaign on Meta')
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

  const page = await repo.findVerifiedFacebookPage(publisherId)
  if (!page) {
    throw new ValidationError('You must have a verified Facebook page before accepting campaign requests')
  }

  return await transaction(async () => {
    await repo.lockCampaignById(request.campaignId)
    const lockedCampaign = await repo.findCampaignById(request.campaignId)
    if (!lockedCampaign || lockedCampaign.status !== CAMPAIGN_STATUS.AWAITING_PUBLISHERS) {
      throw new ValidationError('Campaign is no longer awaiting publishers')
    }
    const acceptedCount = await repo.countPublisherRequestsByStatus(request.campaignId, 'accepted')
    if (acceptedCount >= (lockedCampaign.publisherCount || Infinity)) {
      throw new ValidationError('Publisher capacity reached for this campaign')
    }
    const liveDuplicates = await repo.countLivePublisherRequestsByPublisher(request.campaignId, publisherId, requestId)
    if (liveDuplicates > 0) {
      throw new ConflictError('You already hold a live request for this campaign')
    }
    await repo.updatePublisherRequestStatusWithGuard(requestId, 'accepted', new Date().toISOString().slice(0, 19).replace('T', ' '), 'pending')
    // Earliest execution-eligibility point: the publisher is now accepted.
    // Flag-gated like retry staging; idempotent via find-or-create + unique key.
    if (await isCampaignExecutionRuntimeEnabled()) {
      const { execution, created } = await findOrCreatePendingExecution(request.campaignId, publisherId, EXECUTION_KIND.PUBLISHER)
      if (created) {
        await logMetaEvent({ campaignId: request.campaignId, userId: publisherId, action: 'execution_created', params: { executionId: execution.id, kind: EXECUTION_KIND.PUBLISHER } })
      }
    }

    const newAcceptedCount = await repo.countPublisherRequestsByStatus(request.campaignId, 'accepted')

    if (newAcceptedCount >= (lockedCampaign.publisherCount || Infinity)) {
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

  // Phase 1 — short, locked: verify preconditions and stage the client
  // execution. Held only for a few DB statements, never across a Meta API
  // call — the row lock's job is just to fail fast if a concurrent operation
  // already changed the campaign's status; per-owner safety against
  // concurrent chain creation comes from the atomic claim inside
  // runExecutionChainCreation, not from holding this lock across slow I/O.
  await transaction(async () => {
    await repo.lockCampaignById(campaignId)
    const lockedCampaign = await repo.findCampaignById(campaignId)
    if (!lockedCampaign || lockedCampaign.status !== CAMPAIGN_STATUS.AWAITING_PUBLISHERS) {
      throw new ValidationError('Campaign is no longer awaiting publishers')
    }

    // Defense in depth (symmetric with publishers): the approve flow stages the
    // client execution, but any path that bypassed approve must still satisfy
    // the rowless fail-closed gate below. Idempotent; never overwrites.
    if (await isCampaignExecutionRuntimeEnabled()) {
      const { execution: stagedClient, created: clientStaged } = await findOrCreatePendingExecution(campaignId, lockedCampaign.clientId, EXECUTION_KIND.CLIENT)
      if (clientStaged) {
        await logMetaEvent({ campaignId, userId: lockedCampaign.clientId, action: 'execution_created', params: { executionId: stagedClient.id, kind: EXECUTION_KIND.CLIENT } })
      }
    }
  })

  // Phase 2 — unlocked: every Meta call and its DB persistence commits
  // immediately and independently (no wrapping transaction), so a later
  // failure can never roll back an earlier success. This is the actual C1
  // fix — previously this whole phase ran inside phase 1's transaction, so
  // a throw anywhere here erased DB records for Meta objects already
  // created moments earlier, causing duplicates on retry.
  const clientResult = await publishAdForClient(campaignId)
  if (!clientResult.success) {
    throwClientLegFailure(clientResult, 'Failed to create Meta ads for client')
  }

  const acceptedRequests = await repo.findAcceptedPublisherRequests(campaignId)
  for (const ar of acceptedRequests) {
    // Each publisher's leg is independent — one publisher's DB-guard
    // mismatch (e.g. a concurrent status change) must never stop the
    // remaining publishers in this same call from being built.
    try {
      const page = await repo.findVerifiedFacebookPage(ar.publisherId)
      if (page) {
        // Defense in depth: covers publishers accepted while the flag was OFF
        // or any missed staging — idempotent, never overwrites existing rows.
        if (await isCampaignExecutionRuntimeEnabled()) {
          await findOrCreatePendingExecution(campaignId, ar.publisherId, EXECUTION_KIND.PUBLISHER)
        }
        const result = await routeOwnerChainCreation(campaignId, ar.publisherId, page.platformUserId)
        if (result.success) {
          await repo.updatePublisherRequestPublishedWithGuard(ar.id, 'accepted')
        } else {
          await repo.updatePublisherRequestStatusWithGuard(ar.id, 'failed', new Date().toISOString().slice(0, 19).replace('T', ' '), 'accepted')
        }
      }
    } catch (err) {
      await logMetaEvent({ campaignId, userId: ar.publisherId, action: 'publish_publisher', error: err.message })
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

  // Phase 3 — no lock needed: updateCampaignWithStatusGuard is already a
  // self-atomic guarded single-row UPDATE, and there's no more Meta I/O
  // left to protect.
  const scheduledAt = campaign.scheduledAt ? new Date(campaign.scheduledAt) : null
  const isFutureSchedule = scheduledAt && scheduledAt.getTime() > Date.now()
  const afterPublishStatus = isFutureSchedule ? CAMPAIGN_STATUS.SCHEDULED : CAMPAIGN_STATUS.RUNNING
  await repo.updateCampaignWithStatusGuard(campaignId, { status: afterPublishStatus }, CAMPAIGN_STATUS.AWAITING_PUBLISHERS)
  await repo.createReviewLog(campaignId, null, REVIEW_ACTIONS.SUBMITTED, CAMPAIGN_STATUS.AWAITING_PUBLISHERS,
    `All ${campaign.publisherCount} publisher slots filled — campaign ${afterPublishStatus === CAMPAIGN_STATUS.RUNNING ? 'is now running' : 'scheduled'}`)

  return repo.findCampaignById(campaignId)
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

// Step 14 retry eligibility matrix (per execution; enforced by rearm + runner):
//   pending/validating/creating → route directly (idempotent resume)
//   failed                      → guarded rearm to pending, then route (explicit operator retry only;
//                                 go-live flows never auto-rearm, so failed chains stay failed there)
//   active/paused + complete IDs → adopt-skip, zero Meta calls (never recreated)
//   active/paused without IDs   → fail closed (inconsistent, needs operator review)
//   cancelled/completed         → runner skips deterministically (terminal stays terminal)
//   quarantined                 → runner refuses (quarantine never bypassed)
// Retry = resume/reconcile the SAME execution (identity, snapshot, page, IDs preserved).
// No campaign-wide delete, no new executions, no financial mutations on this path.
export async function retryCampaignMeta(campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')

  const { accountId: adAccountId, accessToken: systemToken } = await getCampaignAccountContext(campaignId)

  if (!adAccountId || !systemToken) {
    throw new ValidationError('Meta Ads not configured — add a meta ad account or set META_AD_ACCOUNT_ID and META_SYSTEM_USER_TOKEN')
  }

  // Phase 1 — short, locked: fetch the publisher request list once and
  // stage/rearm every owner's execution. No Meta I/O here — see
  // goLiveForFilledCampaign for why that matters.
  const requests = await transaction(async () => {
    await repo.lockCampaignById(campaignId)
    const isRuntimeOn = await isCampaignExecutionRuntimeEnabled()
    const publisherRequests = await repo.findPublisherRequestsByCampaignId(campaignId)

    if (isRuntimeOn) {
      await findOrCreatePendingExecution(campaignId, campaign.clientId, EXECUTION_KIND.CLIENT)
      await rearmFailedExecution(campaignId, campaign.clientId, EXECUTION_KIND.CLIENT)
      for (const r of publisherRequests.filter(r => r.status === 'accepted' || r.status === 'published')) {
        await findOrCreatePendingExecution(campaignId, r.publisherId, EXECUTION_KIND.PUBLISHER)
        await rearmFailedExecution(campaignId, r.publisherId, EXECUTION_KIND.PUBLISHER)
      }
    }
    return publisherRequests
  })

  // Phase 2 — unlocked: see goLiveForFilledCampaign for why the actual
  // Meta-calling work must not run inside phase 1's transaction.
  const outcome = await (async () => {
    // The client leg and every publisher leg are independent Meta chains —
    // a client-side problem (e.g. a revoked page token) must never stop
    // otherwise-fixable publisher legs from being retried, and vice versa.
    // Each leg's own outcome is tracked and folded into the final verdict
    // below instead of bailing out on the first failure.
    const clientResult = await publishAdForClient(campaignId, { skipCampaignStatusGate: true })
    // A deliberate campaign-wide skip (quarantined / terminal execution
    // state) applies to every owner, not just the client — there is nothing
    // for the publisher loop to do, and this is not an actionable failure,
    // so it keeps the original non-throwing contract exactly as-is. A
    // per-owner "claimed by a concurrent caller" skip is NOT campaign-wide
    // and must fall through to the normal per-owner-independent flow below.
    if (!clientResult.success && (clientResult.skipped === 'quarantined' || clientResult.skipped === 'terminal')) {
      return clientResult
    }
    let anyActionable = clientResult.success && clientResult.actionable !== false
    let anySucceeded = clientResult.success
    if (!clientResult.success) {
      await logMetaEvent({ campaignId, userId: campaign.clientId, action: 'retry_client', error: clientResult.error })
    }

    for (const r of requests.filter(r => r.status === 'accepted' || r.status === 'published')) {
      const page = await repo.findVerifiedFacebookPage(r.publisherId)
      if (!page) continue
      const pubResult = await routeOwnerChainCreation(campaignId, r.publisherId, page.platformUserId, { skipCampaignStatusGate: true })
      if (pubResult.success) {
        anySucceeded = true
        if (pubResult.actionable !== false) anyActionable = true
        if (r.status === 'accepted') {
          try {
            await repo.updatePublisherRequestPublishedWithGuard(r.id, 'accepted')
          } catch (err) {
            await logMetaEvent({ campaignId, userId: r.publisherId, action: 'retry_publisher_guard', error: err.message })
          }
        }
      } else {
        await logMetaEvent({
          campaignId, userId: r.publisherId, action: 'retry_publisher', error: pubResult.error,
        })
      }
    }

    if (!clientResult.success) {
      const note = anySucceeded
        ? `Retry: client leg failed (${clientResult.error}) — publisher leg(s) were retried successfully`
        : `Retry failed: ${clientResult.error}`
      await repo.createReviewLog(campaignId, null, REVIEW_ACTIONS.SUBMITTED, campaign.status, note)
    } else if (!anyActionable && anySucceeded) {
      // actionable:false (with at least one leg succeeding/adopting) means
      // every owner's Meta chain was already fully live — retry adopted,
      // did zero Meta calls, and fixed nothing. Retry runs as an async job
      // (202 queued) with no synchronous response channel back to the
      // caller, so this is surfaced via a review log entry — the same
      // mechanism every other system-driven status note already uses.
      await repo.createReviewLog(campaignId, null, REVIEW_ACTIONS.SUBMITTED, campaign.status,
        "Retry found nothing to do — this campaign's Meta ad objects are already live. Edit the campaign to fix the content and rebuild the ad.")
    }

    return {
      success: true,
      actionable: anyActionable,
      anySucceeded,
      clientFailure: clientResult.success ? null : clientResult,
    }
  })()

  // Checked and thrown OUTSIDE the transaction: by this point every write
  // above (diagnostics, review log, any successfully-created Meta object
  // rows) has already committed, so surfacing this as a real failure to the
  // job queue here can never roll any of that back (unlike throwing from
  // inside the transaction, which would undo the very diagnostics it's
  // trying to report).
  if (outcome.clientFailure && !outcome.anySucceeded) {
    throwClientLegFailure(outcome.clientFailure, 'Retry failed')
  }
  if (outcome.skipped) return outcome
  return { success: true, actionable: outcome.actionable }
}

// Client-initiated fix for a FAILED campaign whose Meta chain is already
// live (DISAPPROVED/REJECTED, or WITH_ISSUES with no automated repair
// path — see applyMetaStatusTransition). Editing name/schedule/targeting
// on such a campaign still goes through the ordinary updateCampaign
// DRAFT-reset-and-resubmit path (nothing live to preserve there); this is
// specifically for amending the CREATIVE ONLY on a chain that must be
// rebuilt in place — budget/targeting/schedule/placement/objective stay
// frozen. Reuses the execution-repair generation state machine (same
// worker, same kill switch) via repair.service.js's requestContentAmendment,
// gated by campaign_repair_category_client_edit.
//
// The repair worker's own preflight requires campaign.status to be
// running/paused throughout the whole rebuild (that's how it knows it's
// safe to hot-swap a live ad) — so before enqueueing, this optimistically
// resumes the campaign to PAUSED. If the rebuild succeeds, the periodic
// Meta status sync observes the new ad's ACTIVE effective_status and
// naturally flips PAUSED -> RUNNING on its own (existing sync behavior,
// no new code needed). If the rebuild fails, runRepairCreation's own
// failure path fails the repair row; the campaign stays PAUSED with the
// new failure surfaced via the execution's issue/repair status rather than
// campaign.metaError, so it never silently reverts to looking healthy.
// A campaign with publisherCount > 0 has ONE execution per owner — the
// client's own (if any) PLUS one per accepted/published publisher — all
// built from the SAME creative (per the campaign's own publisherCount
// model: every publisher runs the identical caption/media the client
// configured). When that shared media/content is what got flagged,
// EVERY owner's ad shows the same problem, not just the client's own —
// so a single client-submitted fix must rebuild every owner's live chain,
// not only the one the client happens to own themselves. Each owner gets
// its own independent repair row (campaign_execution_repairs is keyed by
// execution, not campaign), so one owner's failure never blocks another's.
export async function requestClientCreativeAmendment(userId, campaignId, creative) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.clientId !== userId) throw new ForbiddenError('Not your campaign')
  if (campaign.status !== CAMPAIGN_STATUS.FAILED) {
    throw new ValidationError(`Campaign must be in failed status to amend its live creative (currently ${campaign.status})`)
  }

  const executions = await execRepo.findExecutionsByCampaignId(campaignId)
  const targets = executions.filter((e) => executionHasCompleteIds(e))
  if (!targets.length) {
    throw new ValidationError('Campaign has no live Meta chain to amend — use the normal edit and resubmit flow instead')
  }

  // Campaign stays FAILED until a worker actually starts on one of these
  // repairs (see runRepairJob) — flipping it here, synchronously, would
  // make a second request before any worker runs fail this function's own
  // status guard instead of converging on the same repair rows via the
  // existing dedupe/rearm logic requestContentAmendment already has.
  const repairService = await import('./repair.service.js')
  const results = []
  for (const execution of targets) {
    try {
      const result = await repairService.requestContentAmendment({
        campaignId, executionId: execution.id, actorId: userId, creative,
      })
      results.push({
        executionId: execution.id, kind: execution.kind, ownerUserId: execution.ownerUserId,
        queued: result.queued, repairId: result.repair.id, runKey: result.runKey,
        status: result.status, duplicate: result.duplicate, rearmed: result.rearmed,
      })
    } catch (err) {
      await logMetaEvent({ campaignId, userId, action: 'content_amendment_owner_failed', error: err.message, params: { executionId: execution.id, kind: execution.kind } })
      results.push({ executionId: execution.id, kind: execution.kind, ownerUserId: execution.ownerUserId, queued: false, error: err.message })
    }
  }

  // duplicate:true (already in flight from an earlier submission) is a
  // successful convergence, not a failure — only a real per-owner
  // exception (captured as `error` above) counts against this.
  const anySucceeded = results.some((r) => r.queued || r.duplicate)
  if (!anySucceeded) {
    throw new ValidationError(results[0]?.error || 'Could not queue a creative fix for any owner')
  }

  const succeeded = results.filter((r) => r.queued || r.duplicate)
  const clientCount = succeeded.filter((r) => r.kind === EXECUTION_KIND.CLIENT).length
  const publisherCount = succeeded.filter((r) => r.kind === EXECUTION_KIND.PUBLISHER).length
  const ownerParts = []
  if (clientCount) ownerParts.push('client')
  if (publisherCount) ownerParts.push(`${publisherCount} publisher${publisherCount === 1 ? '' : 's'}`)
  await repo.createReviewLog(campaignId, userId, REVIEW_ACTIONS.SUBMITTED, campaign.status,
    `Client submitted a creative fix — rebuilding ${succeeded.length} live ad${succeeded.length === 1 ? '' : 's'} (${ownerParts.join(' + ')}) with the new content.`)

  return { queued: true, owners: results }
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

  const { historicalObjectIds } = await loadActiveAdIndex([campaignId])
  const chains = []
  for (const group of groups.values()) {
    const live = historicalObjectIds.size
      ? group.filter((obj) => !historicalObjectIds.has(obj.objectId))
      : group
    const resolved = resolveMetaObjects(live.length ? live : group)
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

export async function completePublisherRequest(publisherId, requestId) {
  const request = await repo.findPublisherRequestById(requestId)
  if (!request) throw new NotFoundError('Request not found')
  if (request.publisherId !== publisherId) throw new ForbiddenError('Not your request')

  if (request.status !== 'published') {
    throw new ValidationError(`Cannot complete request with status '${request.status}' — must be 'published'`)
  }

  const completedAt = new Date().toISOString().slice(0, 19).replace('T', ' ')

  await transaction(async () => {
    await repo.updatePublisherRequestStatusWithGuard(requestId, 'completed', completedAt, 'published')
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
  if (!(await isCampaignDuplicateEnabled())) {
    throw new ForbiddenError('Duplicate is temporarily disabled')
  }
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

        // The campaign never activated, so settleCampaignJob's spend-vs-charged
        // math resolves to a full refund of chargedAdBudgetPaise (zero actual
        // spend) — this campaign is terminal (FAILED), not merely paused, so
        // there is no "retry later" path that a premature refund would race.
        await repo.requeueAutoJob(campaign.id, CAMPAIGN_JOB_TYPES.SETTLE_CAMPAIGN)
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

  // Phase 1 — short, locked: cancel pending requests, refund escrow for
  // unfilled slots, stage the client execution. See goLiveForFilledCampaign
  // for why the lock is no longer held across the Meta I/O in phase 2.
  const acceptedRequests = await transaction(async () => {
    await repo.lockCampaignById(campaignId)
    const pendingRequests = await repo.findPublisherRequestsByStatus(campaignId, 'pending')
    for (const p of pendingRequests) {
      await repo.updatePublisherRequestStatus(p.id, 'cancelled', new Date().toISOString().slice(0, 19).replace('T', ' '))
    }

    const accepted = await repo.findAcceptedPublisherRequests(campaignId)

    // Refund escrow for unfilled slots — gated on pendingRequests.length > 0
    // so a retried call (after phase 2 fails downstream) never double-
    // refunds: those requests are already cancelled by the first attempt,
    // so a second attempt sees zero pending requests here and skips this.
    const unfilledSlots = (campaign.publisherCount || 0) - accepted.length
    if (unfilledSlots > 0 && campaign.coinsPerPublisher && pendingRequests.length > 0) {
      const refundAmount = unfilledSlots * campaign.coinsPerPublisher * 1.1
      const coinService = await import('../../../shared/services/coin.service.js')
      await coinService.refund(campaign.clientId, Math.round(refundAmount), 'campaign_escrow', campaignId,
        `Refund for ${unfilledSlots} unfilled publisher slots`)
    }

    // Defense in depth (symmetric with publishers): see goLiveForFilledCampaign.
    if (await isCampaignExecutionRuntimeEnabled()) {
      const { execution: stagedClient, created: clientStaged } = await findOrCreatePendingExecution(campaignId, campaign.clientId, EXECUTION_KIND.CLIENT)
      if (clientStaged) {
        await logMetaEvent({ campaignId, userId: campaign.clientId, action: 'execution_created', params: { executionId: stagedClient.id, kind: EXECUTION_KIND.CLIENT } })
      }
    }

    return accepted
  })

  // Phase 2 — unlocked: see goLiveForFilledCampaign for why this must not
  // run inside phase 1's transaction (a later throw would otherwise erase
  // DB records for Meta objects already created moments earlier).
  const clientResult = await publishAdForClient(campaignId)
  if (!clientResult.success) {
    throwGoLiveFailure(clientResult, 'Failed to create Meta ads for client')
  }

  const publisherRequests = await repo.findPublisherRequestsByCampaignId(campaignId)
  for (const ar of publisherRequests.filter(r => r.status === 'accepted' || r.status === 'published')) {
    // Each publisher's leg is independent — one publisher's DB-guard
    // mismatch must never stop the remaining publishers from being built.
    try {
      const page = await repo.findVerifiedFacebookPage(ar.publisherId)
      if (page) {
        // Defense in depth: same guarantee as goLiveForFilledCampaign.
        if (await isCampaignExecutionRuntimeEnabled()) {
          await findOrCreatePendingExecution(campaignId, ar.publisherId, EXECUTION_KIND.PUBLISHER)
        }
        const result = await routeOwnerChainCreation(campaignId, ar.publisherId, page.platformUserId)
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
    } catch (err) {
      await logMetaEvent({ campaignId, userId: ar.publisherId, action: 'publish_publisher', error: err.message })
    }
  }

  const activateResult = await activateAllMetaObjects(campaignId)

  if (!activateResult.success) {
    const activationError = activateResult.results.find(r => !r.success)?.error || 'Meta activation failed'
    await logMetaEvent({ campaignId, userId: campaign.clientId, action: 'activate_all', error: activationError })
    await repo.updateCampaign(campaignId, { metaStatus: 'failed', metaError: activationError })
    await repo.createReviewLog(campaignId, adminId, REVIEW_ACTIONS.APPROVED, CAMPAIGN_STATUS.AWAITING_PUBLISHERS,
      `Meta activation failed — campaign stays awaiting publishers: ${activationError}`)
    return repo.findCampaignById(campaignId)
  }

  // Phase 3 — no lock needed, see goLiveForFilledCampaign.
  const scheduledAt = campaign.scheduledAt ? new Date(campaign.scheduledAt) : null
  const isFutureSchedule = scheduledAt && scheduledAt.getTime() > Date.now()
  const afterPublishStatus = isFutureSchedule ? CAMPAIGN_STATUS.SCHEDULED : CAMPAIGN_STATUS.RUNNING
  await repo.updateCampaignWithStatusGuard(campaignId, { status: afterPublishStatus }, CAMPAIGN_STATUS.AWAITING_PUBLISHERS)
  await repo.createReviewLog(campaignId, adminId, REVIEW_ACTIONS.APPROVED, CAMPAIGN_STATUS.AWAITING_PUBLISHERS,
    `Admin force go-live with ${acceptedRequests.length} publishers — campaign ${afterPublishStatus === CAMPAIGN_STATUS.RUNNING ? 'running' : 'scheduled'}`)

  return repo.findCampaignById(campaignId)
}

// Recovery path for a campaign permanently stuck in AWAITING_PUBLISHERS with
// metaStatus='failed' — e.g. a targeting conflict Meta will reject
// identically on every retry ("Remove a conflicting location to continue").
// updateCampaign normally blocks editing this status because escrow money
// is already committed and a partial Meta chain may already exist for one
// or more owner executions (confirmed live: the top-level Facebook Campaign
// object gets created before the failing ad-set step) — this does the same
// safe unwind forceCancelCampaign uses (refund escrow, cancel outstanding
// publisher requests) plus deleting any partially-created Meta objects and
// resetting execution rows to a clean slate, landing the campaign back in
// DRAFT instead of CANCELLED so the client can actually fix the problem and
// resubmit through the normal pipeline.
export async function reopenFailedAwaitingPublishersCampaign(userId, campaignId) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')
  if (campaign.clientId !== userId) throw new ForbiddenError('Not your campaign')
  if (campaign.status !== CAMPAIGN_STATUS.AWAITING_PUBLISHERS || campaign.metaStatus !== 'failed') {
    throw new ValidationError('Campaign must be awaiting publishers with a failed Meta status to reopen')
  }

  const { accessToken: systemToken } = await getCampaignAccountContext(campaignId)
  const executions = await execRepo.findExecutionsByCampaignId(campaignId)

  return transaction(async () => {
    await repo.lockCampaignById(campaignId)
    const locked = await repo.findCampaignById(campaignId)
    if (!locked || locked.status !== CAMPAIGN_STATUS.AWAITING_PUBLISHERS || locked.metaStatus !== 'failed') {
      throw new ValidationError('Campaign state changed — refresh and try again')
    }

    for (const execution of executions) {
      const objects = [
        execution.platformAdId && { type: 'ad', id: execution.platformAdId },
        execution.platformCreativeId && { type: 'ad_creative', id: execution.platformCreativeId },
        execution.platformAdsetId && { type: 'ad_set', id: execution.platformAdsetId },
        execution.platformCampaignId && { type: 'facebook_campaign', id: execution.platformCampaignId },
      ].filter(Boolean)
      for (const obj of objects) {
        try {
          if (systemToken) await META_ROLLBACK_FN[obj.type](obj.id, systemToken)
          await logMetaEvent({ campaignId, userId, action: `delete_${obj.type}`, objectType: obj.type, objectId: obj.id })
        } catch (err) {
          await logMetaEvent({ campaignId, userId, action: `delete_${obj.type}_failed`, objectType: obj.type, objectId: obj.id, error: err.message })
        }
      }
      await execRepo.updateExecution(execution.id, {
        status: EXECUTION_STATUS.PENDING,
        platformCampaignId: null,
        platformAdsetId: null,
        platformCreativeId: null,
        platformAdId: null,
        configHash: null,
        error: null,
        attempts: 0,
      })
    }

    const requests = await repo.findPublisherRequestsByCampaignId(campaignId)
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
    for (const r of requests) {
      if (['pending', 'accepted'].includes(r.status)) {
        await repo.updatePublisherRequestStatus(r.id, 'cancelled', now)
      }
    }

    if (Number(locked.escrowAmount) > 0) {
      const coinService = await import('../../../shared/services/coin.service.js')
      await coinService.refund(locked.clientId, locked.escrowAmount, 'campaign_escrow', campaignId,
        `Refund: campaign reopened for edit — ${locked.name}`)
    }

    await repo.updateCampaign(campaignId, {
      status: CAMPAIGN_STATUS.DRAFT,
      metaStatus: 'pending',
      metaError: null,
      escrowAmount: 0,
      coinsEscrowedAt: null,
    })
    await repo.createReviewLog(campaignId, userId, REVIEW_ACTIONS.CHANGES_REQUESTED, CAMPAIGN_STATUS.AWAITING_PUBLISHERS,
      'Campaign reopened for edit after a permanent Meta failure — escrow refunded, publisher requests cancelled')

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

    // The campaign never activated, so this resolves to a full refund of
    // chargedAdBudgetPaise (zero actual spend recorded) — CANCELLED is
    // terminal, so there is no later retry this could race against.
    await repo.requeueAutoJob(campaignId, CAMPAIGN_JOB_TYPES.SETTLE_CAMPAIGN)

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

  const execRows = await repo.findExecutionDailyStatsByCampaignId(campaignId, { from, to })
  const execMap = new Map()
  for (const er of execRows) {
    const key = er.executionId
    if (!execMap.has(key)) {
      execMap.set(key, {
        executionId: er.executionId,
        kind: er.kind,
        status: er.status,
        platformCampaignId: er.platformCampaignId,
        adAccountActId: er.adAccountActId,
        owner: er.owner,
        publisher: er.publisher,
        rows: [],
      })
    }
    execMap.get(key).rows.push({
      id: er.id,
      statDate: er.statDate,
      impressions: er.impressions,
      reach: er.reach,
      frequency: er.frequency,
      clicks: er.clicks,
      uniqueClicks: er.uniqueClicks,
      ctr: er.ctr,
      cpc: er.cpc,
      cpm: er.cpm,
      spendPaise: er.spendPaise,
      actions: er.actions,
      costPerActionType: er.costPerActionType,
      updatedAt: er.updatedAt,
    })
  }
  const executions = []
  for (const exec of execMap.values()) {
    const totals = exec.rows.reduce((acc, r) => {
      acc.impressions += r.impressions
      acc.clicks += r.clicks
      acc.uniqueClicks += r.uniqueClicks
      acc.spendPaise += r.spendPaise
      acc.reach += r.reach || 0
      for (const [k, v] of Object.entries(r.actions || {})) {
        acc.actions[k] = (acc.actions[k] || 0) + Number(v)
      }
      return acc
    }, { impressions: 0, clicks: 0, uniqueClicks: 0, spendPaise: 0, reach: 0, actions: {} })
    totals.ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0
    totals.cpc = totals.clicks > 0 ? totals.spendPaise / totals.clicks : 0
    totals.cpm = totals.impressions > 0 ? (totals.spendPaise / totals.impressions) * 1000 : 0
    totals.frequency = totals.reach > 0 ? totals.impressions / totals.reach : 0
    const latestSpendUpdatedAt = exec.rows.reduce((latest, r) => {
      if (!r.updatedAt) return latest
      const t = new Date(r.updatedAt).getTime()
      if (Number.isNaN(t)) return latest
      return !latest || t > new Date(latest).getTime() ? r.updatedAt : latest
    }, null)
    executions.push({ ...exec, stats: { rows: exec.rows, totals }, latestSpendUpdatedAt })
  }

  return {
    cached: true,
    campaignId,
    rows,
    totalSpendPaise: rows.reduce((sum, r) => sum + r.spendPaise, 0),
    liveSpendPaise: campaign.metaSpentPaise || 0,
    chargedAdBudgetPaise: campaign.chargedAdBudgetPaise || 0,
    lastInsightsSyncAt: campaign.lastInsightsSyncAt || null,
    insightsError: campaign.insightsError || null,
    executions,
  }
}

export async function getCampaignInsightsAdmin(campaignId, query = {}) {
  const campaign = await repo.findCampaignById(campaignId)
  if (!campaign) throw new NotFoundError('Campaign not found')

  if (query?.refresh) {
    const enqueued = await repo.requeueAutoJob(campaignId, CAMPAIGN_JOB_TYPES.SYNC_INSIGHTS)
    return { queued: true, enqueued }
  }

  const from = query?.from || null
  const to = query?.to || null
  const rows = await repo.findDailyStats(campaignId, { from, to })

  const execRows = await repo.findExecutionDailyStatsByCampaignId(campaignId, { from, to })
  const execMap = new Map()
  for (const er of execRows) {
    const key = er.executionId
    if (!execMap.has(key)) {
      execMap.set(key, {
        executionId: er.executionId,
        kind: er.kind,
        status: er.status,
        platformCampaignId: er.platformCampaignId,
        adAccountActId: er.adAccountActId,
        owner: er.owner,
        publisher: er.publisher,
        rows: [],
      })
    }
    execMap.get(key).rows.push({
      id: er.id,
      statDate: er.statDate,
      impressions: er.impressions,
      reach: er.reach,
      frequency: er.frequency,
      clicks: er.clicks,
      uniqueClicks: er.uniqueClicks,
      ctr: er.ctr,
      cpc: er.cpc,
      cpm: er.cpm,
      spendPaise: er.spendPaise,
      actions: er.actions,
      costPerActionType: er.costPerActionType,
      updatedAt: er.updatedAt,
    })
  }
  const executions = []
  for (const exec of execMap.values()) {
    const totals = exec.rows.reduce((acc, r) => {
      acc.impressions += r.impressions
      acc.clicks += r.clicks
      acc.uniqueClicks += r.uniqueClicks
      acc.spendPaise += r.spendPaise
      acc.reach += r.reach || 0
      for (const [k, v] of Object.entries(r.actions || {})) {
        acc.actions[k] = (acc.actions[k] || 0) + Number(v)
      }
      return acc
    }, { impressions: 0, clicks: 0, uniqueClicks: 0, spendPaise: 0, reach: 0, actions: {} })
    totals.ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0
    totals.cpc = totals.clicks > 0 ? totals.spendPaise / totals.clicks : 0
    totals.cpm = totals.impressions > 0 ? (totals.spendPaise / totals.impressions) * 1000 : 0
    totals.frequency = totals.reach > 0 ? totals.impressions / totals.reach : 0
    const latestSpendUpdatedAt = exec.rows.reduce((latest, r) => {
      if (!r.updatedAt) return latest
      const t = new Date(r.updatedAt).getTime()
      if (Number.isNaN(t)) return latest
      return !latest || t > new Date(latest).getTime() ? r.updatedAt : latest
    }, null)
    executions.push({ ...exec, stats: { rows: exec.rows, totals }, latestSpendUpdatedAt })
  }

  return {
    cached: true,
    campaignId,
    rows,
    totalSpendPaise: rows.reduce((sum, r) => sum + r.spendPaise, 0),
    liveSpendPaise: campaign.metaSpentPaise || 0,
    chargedAdBudgetPaise: campaign.chargedAdBudgetPaise || 0,
    lastInsightsSyncAt: campaign.lastInsightsSyncAt || null,
    insightsError: campaign.insightsError || null,
    executions,
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
  const activeAd = await findActiveSyncAd(campaignId, metaObjects)
  const { facebook_campaign: fbCampaignObj } = resolveMetaObjects(metaObjects)
  const ad = activeAd
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

    const transition = await applyMetaStatusTransition(campaign, metaAdStatus, adStatusData.issues_info)
    result.statusAfter = transition.statusAfter
    result.statusChanged = transition.statusChanged
    try {
      await ingestAdIssues(campaignId, ad.objectId, adStatusData.issues_info)
    } catch (err) {
      await logMetaEvent({ campaignId, action: 'sync_issues', error: err.message })
    }
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

async function applyMetaStatusTransition(campaign, metaAdStatus, issuesInfo = null) {
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
    // Settles any charged-but-unspent ad budget — settleCampaignJob computes
    // the refund as charged minus actual recorded spend, so a campaign that
    // had genuinely been running keeps its already-spent portion charged.
    await repo.requeueAutoJob(campaign.id, CAMPAIGN_JOB_TYPES.SETTLE_CAMPAIGN)
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
    const pauseUpdate = { metaStatus: META_STATUS.PAUSED }
    if (campaign.metaError && campaign.metaStatus !== META_STATUS.PAUSED) pauseUpdate.metaError = null
    await repo.updateCampaign(campaign.id, pauseUpdate)
    await repo.createReviewLog(campaign.id, null, REVIEW_ACTIONS.SUBMITTED, CAMPAIGN_STATUS.RUNNING, 'Campaign paused from Meta')
    newStatus = CAMPAIGN_STATUS.PAUSED
    newMetaStatus = META_STATUS.PAUSED
    statusChanged = true
    metaStatusChanged = true
  } else if (status === 'ACTIVE' && campaign.status === CAMPAIGN_STATUS.PAUSED) {
    await repo.updateCampaignStatus(campaign.id, CAMPAIGN_STATUS.RUNNING)
    const resumeUpdate = { metaStatus: META_STATUS.ACTIVE }
    if (campaign.metaError && campaign.metaStatus !== META_STATUS.ACTIVE) resumeUpdate.metaError = null
    await repo.updateCampaign(campaign.id, resumeUpdate)
    await repo.createReviewLog(campaign.id, null, REVIEW_ACTIONS.SUBMITTED, CAMPAIGN_STATUS.PAUSED, 'Campaign resumed from Meta')
    newStatus = CAMPAIGN_STATUS.RUNNING
    newMetaStatus = META_STATUS.ACTIVE
    statusChanged = true
    metaStatusChanged = true
  } else if (status === 'ACTIVE') {
    const update = { metaStatus: META_STATUS.ACTIVE }
    if (campaign.metaError && campaign.metaStatus !== META_STATUS.ACTIVE) update.metaError = null
    await repo.updateCampaign(campaign.id, update)
    newMetaStatus = META_STATUS.ACTIVE
    metaStatusChanged = true
  } else if (status === 'PAUSED') {
    const update = { metaStatus: META_STATUS.PAUSED }
    if (campaign.metaError && campaign.metaStatus !== META_STATUS.PAUSED) update.metaError = null
    await repo.updateCampaign(campaign.id, update)
    newMetaStatus = META_STATUS.PAUSED
    metaStatusChanged = true
  } else if (status === 'PENDING_REVIEW') {
    const newlyObserved = campaign.metaStatus !== META_STATUS.PENDING_REVIEW
    await repo.updateCampaign(campaign.id, { metaStatus: META_STATUS.PENDING_REVIEW, metaError: META_ISSUE_MESSAGES[META_STATUS.PENDING_REVIEW] })
    if (newlyObserved) {
      await repo.createReviewLog(campaign.id, null, REVIEW_ACTIONS.SUBMITTED, campaign.status,
        'Meta is reviewing this campaign — delivery may be limited until review completes.')
    }
    newMetaStatus = META_STATUS.PENDING_REVIEW
    metaStatusChanged = true
  } else if (status === 'PENDING_BILLING_INFO') {
    const newlyObserved = campaign.metaStatus !== META_STATUS.PENDING_BILLING_INFO
    await repo.updateCampaign(campaign.id, { metaStatus: META_STATUS.PENDING_BILLING_INFO, metaError: META_ISSUE_MESSAGES[META_STATUS.PENDING_BILLING_INFO] })
    if (newlyObserved) {
      await repo.createReviewLog(campaign.id, null, REVIEW_ACTIONS.SUBMITTED, campaign.status,
        'Meta reported that billing information requires attention — delivery may be limited.')
      await sendAdminAlert('Meta campaign billing info required',
        `Campaign ${campaign.name} (${campaign.id}) requires billing info on Meta.`)
    }
    newMetaStatus = META_STATUS.PENDING_BILLING_INFO
    metaStatusChanged = true
  } else if (status === 'WITH_ISSUES'
    && [CAMPAIGN_STATUS.RUNNING, CAMPAIGN_STATUS.PAUSED].includes(campaign.status)
    && !hasRepairableIssue(issuesInfo)) {
    // Repairable issues (e.g. MEDIA_DIMENSION) stay alert-only so the
    // execution-repair pipeline can fix them without the campaign ever
    // leaving running/paused (repair.service.js requires exactly that
    // status to consider an execution eligible). Only issues with no
    // automated fix path fail the campaign, unlocking manual edit+resubmit.
    const detail = describeIssuesForCampaign(issuesInfo) || META_ISSUE_MESSAGES[META_STATUS.WITH_ISSUES]
    await repo.updateCampaignWithStatusGuard(campaign.id, {
      status: CAMPAIGN_STATUS.FAILED,
      metaStatus: META_STATUS.WITH_ISSUES,
      metaError: detail,
    }, campaign.status)
    await repo.createReviewLog(campaign.id, null, REVIEW_ACTIONS.SUBMITTED, campaign.status, detail)
    await sendAdminAlert('Meta campaign has issues',
      `Campaign ${campaign.name} (${campaign.id}) has issues on Meta: ${detail}`)
    // Settles any charged-but-unspent ad budget (see the DISAPPROVED/REJECTED
    // branch above for why this is safe against a genuinely-running spend).
    await repo.requeueAutoJob(campaign.id, CAMPAIGN_JOB_TYPES.SETTLE_CAMPAIGN)
    newStatus = CAMPAIGN_STATUS.FAILED
    newMetaStatus = META_STATUS.WITH_ISSUES
    statusChanged = true
    metaStatusChanged = true
  } else if (status === 'WITH_ISSUES') {
    const newlyObserved = campaign.metaStatus !== META_STATUS.WITH_ISSUES
    const detail = describeIssuesForCampaign(issuesInfo) || META_ISSUE_MESSAGES[META_STATUS.WITH_ISSUES]
    await repo.updateCampaign(campaign.id, { metaStatus: META_STATUS.WITH_ISSUES, metaError: detail })
    if (newlyObserved) {
      await repo.createReviewLog(campaign.id, null, REVIEW_ACTIONS.SUBMITTED, campaign.status, detail)
      await sendAdminAlert('Meta campaign has issues',
        `Campaign ${campaign.name} (${campaign.id}) has issues on Meta: ${detail}`)
    }
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

export async function enforceAccountBudgetCap(dbAccount) {
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
      const ads = await findActiveSyncAds(campaign.id, metaObjects)
      for (const ad of ads) {
        if (!ad?.objectId || !systemToken) continue
        try {
          await updateAdStatus(ad.objectId, 'PAUSED', systemToken)
          await repo.saveMetaObjectStatus(ad.objectId, 'PAUSED')
        } catch (adErr) {
          await logMetaEvent({ campaignId: campaign.id, action: 'budget_cap', objectId: ad.objectId, error: adErr.message })
        }
      }
      await applyMetaStatusTransition(campaign, 'PAUSED')
      await repo.createReviewLog(campaign.id, null, REVIEW_ACTIONS.SUBMITTED, campaign.status,
        `Paused by budget cap — account charged ${spent} of ${cap} paise (${ads.length} ad${ads.length === 1 ? '' : 's'} paused)`)
      paused.push(campaign.id)
    } catch (err) {
      await logMetaEvent({ campaignId: campaign.id, action: 'budget_cap', error: err.message })
    }
  }

  await repo.saveMetaSyncState(`cap_pause:${dbAccount.id}`, { pausedAt: Date.now(), pausedCount: paused.length })
  return { success: true, checked: true, ratio, atCap: true, paused }
}

export async function ingestAdIssues(campaignId, adObjectId, issuesInfo) {
  const normalized = normalizeIssuesInfo(issuesInfo)
  const execution = await execRepo.findExecutionByMetaId(adObjectId)
  if (!execution || execution.campaignId !== campaignId) {
    return { success: true, skipped: true, reason: execution ? 'execution-campaign-mismatch' : 'no-execution' }
  }
  const seen = []
  for (const issue of normalized) {
    await repo.upsertMetaObjectIssue(execution.id, {
      objectId: adObjectId,
      creativeId: execution.platformCreativeId,
      ...issue,
    })
    seen.push(issue.errorCode)
  }
  const cleared = await repo.deactivateMissingMetaObjectIssues(execution.id, adObjectId, seen)
  return { success: true, executionId: execution.id, observed: seen, cleared }
}

async function loadActiveAdIndex(campaignIds) {
  const rows = await execRepo.findGenerationAdIndexByCampaignIds([...new Set(campaignIds)])
  const activeAdIds = new Set()
  const historicalAdIds = new Set()
  const historicalObjectIds = new Set()
  for (const row of rows) {
    if (row.generationNo === null) continue
    if (row.activeGenerationNo === null || row.activeGenerationNo === undefined) continue
    const ids = [row.platformCampaignId, row.platformAdsetId, row.platformCreativeId, row.platformAdId].filter(Boolean)
    if (Number(row.generationNo) === Number(row.activeGenerationNo)) {
      if (row.platformAdId) activeAdIds.add(row.platformAdId)
    } else {
      for (const id of ids) {
        historicalAdIds.add(id)
        historicalObjectIds.add(id)
      }
    }
  }
  return { activeAdIds, historicalAdIds, historicalObjectIds }
}

async function findActiveSyncAd(campaignId, metaObjects) {
  const ads = metaObjects.filter((o) => o.objectType === 'ad')
  if (!ads.length) return null
  const { activeAdIds, historicalAdIds } = await loadActiveAdIndex([campaignId])
  if (!activeAdIds.size && !historicalAdIds.size) {
    return resolveMetaObjects(metaObjects).ad || null
  }
  return ads.find((o) => activeAdIds.has(o.objectId))
    || ads.find((o) => !historicalAdIds.has(o.objectId))
    || null
}

// Owner-aware variant of findActiveSyncAd: a multi-publisher campaign has one
// live ad per owner (client + each accepted publisher), each tracked by its
// own execution/generation. Returns every currently-active ad, not just one,
// so account-wide actions (e.g. budget-cap pause) cover every owner.
async function findActiveSyncAds(campaignId, metaObjects) {
  const ads = metaObjects.filter((o) => o.objectType === 'ad')
  if (!ads.length) return []
  const { activeAdIds, historicalAdIds } = await loadActiveAdIndex([campaignId])
  if (!activeAdIds.size && !historicalAdIds.size) {
    // No generation tracking available — fall back to the latest ad per
    // owner (client + each publisher), not just the single most recent ad
    // overall, so a multi-publisher campaign's other owners aren't skipped.
    const latestByOwner = new Map()
    for (const ad of [...ads].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))) {
      latestByOwner.set(ad.createdForUserId ?? ad.objectId, ad)
    }
    return [...latestByOwner.values()]
  }
  const active = ads.filter((o) => activeAdIds.has(o.objectId))
  if (active.length) return active
  return ads.filter((o) => !historicalAdIds.has(o.objectId))
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
  const generationIndex = await loadActiveAdIndex(rows.map(r => r.campaignId))

  for (const ad of ads) {
    const row = byObjectId.get(ad.id)
    if (!row) continue
    if (generationIndex.historicalAdIds.has(ad.id)) continue
    seen.add(ad.id)
    try {
      const campaign = await repo.findCampaignById(row.campaignId)
      if (!campaign) continue
      const metaAdStatus = ad.effective_status || ad.status || 'UNKNOWN'
      if (metaAdStatus !== row.adStatus) {
        await repo.saveMetaObjectStatus(ad.id, metaAdStatus)
      }
      const transition = await applyMetaStatusTransition(campaign, metaAdStatus, ad.issues_info)
      const spend = await applySpendFromDailyStats(campaign)
      try {
        await ingestAdIssues(campaign.id, ad.id, ad.issues_info)
      } catch (err) {
        await logMetaEvent({ campaignId: campaign.id, action: 'sync_account_issues', error: err.message })
      }
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
      if (generationIndex.historicalAdIds.has(row.objectId)) continue
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
  // A healthy campaign object never clears a delivery-blocking ad-level signal:
  // the ad-level issue is authoritative until the ad itself reports healthy.
  const AD_ACTIONABLE_STATUSES = [
    META_STATUS.WITH_ISSUES,
    META_STATUS.PENDING_REVIEW,
    META_STATUS.PENDING_BILLING_INFO,
  ]
  const needCampaignCheck = results
    .filter(r => CAMPAIGN_LEVEL_STATUSES.includes(r.metaStatusAfter))
    .map(r => {
      const row = rows.find(x => x.campaignId === r.campaignId)
      return row?.fbCampaignId
    })
    .filter(Boolean)

  if (needCampaignCheck.length > 0 && !isRateLimited(adAccountId)) {
    try {
      const campaignStatuses = await getCampaignStatusesBatch(adAccountId, systemToken, needCampaignCheck)
      for (const fbId of needCampaignCheck) {
        const metaStatus = campaignStatuses[fbId]
        if (!metaStatus) continue
        const row = rows.find(r => r.fbCampaignId === fbId)
        if (!row) continue
        const campaignLevel = String(metaStatus).toUpperCase()
        const adActionable = results.some(r => r.campaignId === row.campaignId
          && AD_ACTIONABLE_STATUSES.includes(r.metaStatusAfter))
        if (adActionable && (campaignLevel === 'ACTIVE' || campaignLevel === 'PAUSED')) continue
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
  const execMap = await repo.findExecutionIdsByFbObjectIds(fbIds)
  const grouped = {}
  const execGrouped = {}
  for (const row of rowsData || []) {
    const campaignId = idMap.get(row.campaign_id)
    if (!campaignId) continue
    if (!grouped[campaignId]) grouped[campaignId] = []
    grouped[campaignId].push(row)
    const execInfo = execMap.get(row.campaign_id)
    if (execInfo) {
      if (!execGrouped[execInfo.id]) execGrouped[execInfo.id] = []
      execGrouped[execInfo.id].push(row)
    }
  }
  let count = 0
  for (const campaignId of Object.keys(grouped)) {
    count += await persistInsightsRows(campaignId, grouped[campaignId])
  }
  let execCount = 0
  for (const executionId of Object.keys(execGrouped)) {
    execCount += await persistExecutionInsightsRows(executionId, execGrouped[executionId])
  }
  return { count, campaignIds: Object.keys(grouped), executionRows: execCount }
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
  const snapshots = []
  for (const row of rows || []) {
    const actions = {}
    for (const action of row.actions || []) {
      if (action?.action_type) actions[action.action_type] = action.value
    }
    const costPerActionType = {}
    for (const cost of row.cost_per_action_type || []) {
      if (cost?.action_type) costPerActionType[cost.action_type] = cost.value
    }
    snapshots.push({
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
  }
  if (!snapshots.length) return 0
  return repo.upsertDailyStatsBulk(campaignId, snapshots)
}

async function persistExecutionInsightsRows(executionId, rows) {
  const snapshots = []
  for (const row of rows || []) {
    const actions = {}
    for (const action of row.actions || []) {
      if (action?.action_type) actions[action.action_type] = action.value
    }
    const costPerActionType = {}
    for (const cost of row.cost_per_action_type || []) {
      if (cost?.action_type) costPerActionType[cost.action_type] = cost.value
    }
    snapshots.push({
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
  }
  if (!snapshots.length) return 0
  return repo.upsertExecutionDailyStatsBulk(executionId, snapshots)
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
        const fbIds = [...new Set((rowsData || []).map(r => r.campaign_id).filter(Boolean))]
        const execMap = fbIds.length ? await repo.findExecutionIdsByFbObjectIds(fbIds) : new Map()
        let execCount = 0
        for (const row of rowsData || []) {
          const execInfo = execMap.get(row.campaign_id)
          if (execInfo) {
            execCount += await persistExecutionInsightsRows(execInfo.id, [row])
          }
        }
        await repo.saveInsightsSyncState(campaignId, {
          lastInsightsSyncAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
          insightsError: null,
        })
        return { success: true, rows: count, executionRows: execCount }
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

  try {
    return await transaction(async () => {
      await repo.lockCampaignById(campaignId)
      const locked = await repo.findCampaignById(campaignId)
      if (locked.settledAt) return { success: true, alreadySettled: true }
      const lockedCharged = locked.chargedAdBudgetPaise || 0
      if (lockedCharged <= 0) return { success: true, nothingCharged: true }
      const claimed = await repo.claimCampaignSettlement(campaignId)
      if (!claimed) return { success: true, alreadySettled: true }
      const charge = await repo.findCampaignCharge(campaignId)
      const rate = charge?.rate || (await getCoinConversionRate())
      const paisePerCoin = Math.max(rate * 100, 1)
      const coinService = await import('../../../shared/services/coin.service.js')

      if ([CAMPAIGN_STATUS.RUNNING, CAMPAIGN_STATUS.PAUSED].includes(locked.status)) {
        await repo.updateCampaignWithStatusGuard(campaignId, { status: CAMPAIGN_STATUS.COMPLETED }, locked.status)
        await repo.createReviewLog(campaignId, null, REVIEW_ACTIONS.SUBMITTED, locked.status, 'Campaign ended — Meta settlement triggered')
      }

      const actualPaise = await repo.sumDailyStatsSpend(campaignId)
      const settledEntries = await repo.findBillingEntries(campaignId)
      const alreadyRefundedPaise = settledEntries
        .filter(e => e.kind === BILLING_ENTRY_KINDS.REFUND)
        .reduce((sum, e) => sum + (Number(e.paise) || 0), 0)
      const netPaise = lockedCharged - alreadyRefundedPaise - actualPaise

      if (netPaise >= 0) {
        const refundCoins = Math.round(netPaise / paisePerCoin)

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
          await coinService.refundWithDetail(locked.clientId, refundCoins, 'campaign_escrow', campaignId,
            `Meta spend settlement refund: ${locked.name}`, { fromMonthly: monthlyShare, fromWallet: walletShare })
          await repo.insertBillingEntry(campaignId, {
            kind: BILLING_ENTRY_KINDS.REFUND,
            paise: netPaise,
            coins: refundCoins,
            rate,
            paidFromMonthly: monthlyShare,
            paidFromWallet: walletShare,
            reason: `Settlement refund: charged ${lockedCharged} paise, previously refunded ${alreadyRefundedPaise} paise, spent ${actualPaise} paise`,
          })
        }

        await repo.insertBillingEntry(campaignId, {
          kind: BILLING_ENTRY_KINDS.SETTLE,
          paise: actualPaise,
          coins: Math.round(actualPaise / paisePerCoin),
          rate,
          reason: `Campaign settled: charged ${lockedCharged} paise, actual spend ${actualPaise} paise`,
        })
        return { success: true, refundCoins, actualPaise, chargedPaise: lockedCharged, lockedCharged, alreadyRefundedPaise }
      }

      const overspendPaise = -netPaise
      const overspendCoins = Math.ceil(overspendPaise / paisePerCoin)

      try {
        await coinService.spend(locked.clientId, overspendCoins, 'campaign_escrow', campaignId,
          `Meta overspend settlement: ${locked.name}`)
        await repo.insertBillingEntry(campaignId, {
          kind: BILLING_ENTRY_KINDS.OVERSPEND,
          paise: overspendPaise,
          coins: overspendCoins,
          rate,
          reason: `Overspend settlement: spent ${actualPaise} paise vs charged ${lockedCharged} paise`,
        })
        await repo.insertBillingEntry(campaignId, {
          kind: BILLING_ENTRY_KINDS.SETTLE,
          paise: actualPaise,
          coins: Math.round(actualPaise / paisePerCoin),
          rate,
          reason: 'Campaign settled with overspend deduction',
        })
        return { success: true, overspendCoins, actualPaise, chargedPaise: lockedCharged, lockedCharged, alreadyRefundedPaise }
      } catch (err) {
        if (err?.statusCode === 422 || err?.code === 'INSUFFICIENT_COINS') {
          await repo.insertBillingEntry(campaignId, {
            kind: BILLING_ENTRY_KINDS.OVERSPEND,
            paise: overspendPaise,
            coins: overspendCoins,
            rate,
            reason: `Overspend on hold — insufficient wallet coins for ${overspendCoins} coins`,
          })
          await repo.releaseCampaignSettlement(campaignId)
          await sendAdminAlert('Campaign overspend hold', `Campaign ${locked.name} (${campaignId}) spent ${actualPaise} paise vs ${lockedCharged} charged; could not deduct ${overspendCoins} coins (insufficient balance).`)
          return { success: true, held: true, overspendCoins, actualPaise, chargedPaise: lockedCharged, lockedCharged, alreadyRefundedPaise }
        }
        throw err
      }
    })
  } catch (err) {
    if (err?.statusCode !== 422 && err?.code !== 'INSUFFICIENT_COINS') {
      await repo.releaseCampaignSettlement(campaignId).catch(() => {})
    }
    throw err
  }
}

export async function getMetaSyncHealth() {
  const [staleCampaigns, failedJobs, unsettledCount, runningCount, pausedCount, accountSnapshot, rateLimit, accounts, rateLimits, schedulerLease, chargedBudget, activeQueueJobs, deadQueueJobs, oldestQueued, webhookStats, webhookSubs] = await Promise.all([
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
    repo.countActiveCampaignJobs(),
    repo.countDeadJobs(),
    repo.oldestQueuedJob(),
    repo.getWebhookInboxStats().catch(() => null),
    (async () => {
      try {
        const { query } = await import('../../../shared/database/connection.js')
        const [active, failed, total] = await Promise.all([
          query('SELECT COUNT(*) as c FROM user_platform_accounts WHERE webhook_status = ?', ['active']).then(r => Number(r[0]?.c || 0)),
          query('SELECT COUNT(*) as c FROM user_platform_accounts WHERE webhook_status = ?', ['failed']).then(r => Number(r[0]?.c || 0)),
          query('SELECT COUNT(*) as c FROM user_platform_accounts WHERE token_type = ?', ['page']).then(r => Number(r[0]?.c || 0)),
        ])
        return { active, failed, total }
      } catch { return null }
    })(),
  ])

  const { getGateStats } = await import('../../../shared/services/meta-request-gate.js')

  const health = {
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
    workerLease: await repo.getSchedulerLease('campaign_job_worker'),
    chargedBudget,
    metaTraffic: getGateStats(),
    queue: {
      active: activeQueueJobs,
      dead: deadQueueJobs,
      oldestQueuedAgeSeconds: oldestQueued ? Math.max(0, Math.floor((Date.now() - new Date(oldestQueued.runAfter).getTime()) / 1000)) : null,
    },
    webhooks: webhookStats ? { ...webhookStats, subscriptions: webhookSubs } : null,
  }

  try {
    const { getDbGrowthSnapshot } = await import('../../../shared/database/retention.js')
    const growth = await getDbGrowthSnapshot()
    if (growth) {
      health.dbGrowth = growth
    }
  } catch {
    // backend-only telemetry — never fails the health endpoint
  }

  try {
    const { readRetentionHealth } = await import('../../../shared/database/retention.js')
    health.retention = await readRetentionHealth()
  } catch {
    // backend-only telemetry — never fails the health endpoint
  }

  try {
    const { countUnresolvedPromotions } = await import('../posts/promotion.repository.js')
    health.promotionsUnresolved = await countUnresolvedPromotions()
  } catch {
    // backend-only telemetry — never fails the health endpoint
  }

  return health
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
