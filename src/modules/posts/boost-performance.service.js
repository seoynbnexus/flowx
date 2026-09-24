import * as bpRepo from './boost-performance.repository.js'
import * as postRepo from './post.repository.js'
import * as promoRepo from './promotion.repository.js'
import { NotFoundError, ForbiddenError } from '../../../shared/errors/AppError.js'
import { POST_JOB_TYPES } from './post.model.js'
import { PROMOTION_TARGET_STATUS } from './promotion.model.js'
import { classifyIssueCode, normalizeIssuesInfo, isBoostRepairableCategory } from '../../../shared/services/meta-issue-catalog.js'
import { isRepairCategoryEnabled } from './promotion-repair.service.js'
import { resolveAccountContext } from '../campaigns/campaign.service.js'
import {
  findAutoJobByRunKey,
  requeueAutoJob,
  getMetaSyncState,
  saveMetaSyncState,
  clearMetaSyncState,
} from '../campaigns/campaign.repository.js'
import {
  createInsightsReport,
  getInsightsReport,
  getInsightsReportData,
  getCampaignStatusesBatch,
} from '../../../shared/services/meta-ads.service.js'
import { isRateLimited, tokenKeyFor } from '../../../shared/services/meta-rate-limiter.js'
import { logMetaEvent } from '../../../shared/services/meta-logger.service.js'

export const BOOST_PERF_RUN_KEY_PREFIX = 'boost-perf:'
export const BOOST_PERF_POLL_SECONDS = 60
const BOOST_PERF_POLL_MIN_INTERVAL_MS = 60 * 1000
const BOOST_PERF_MAX_HISTORY_DAYS = 90
const BOOST_PERF_MAX_TARGETS_PER_BATCH = 100

export const POST_BOOST_FALLBACK_SECONDS = Number(process.env.POST_BOOST_SYNC_SECONDS) || 3600
export const POST_BOOST_HEALTHY_SECONDS = Number(process.env.POST_BOOST_WEBHOOK_SYNC_SECONDS) || 21600
export const POST_BOOST_WEBHOOK_FRESH_SECONDS = Number(process.env.POST_BOOST_WEBHOOK_FRESH_SECONDS) || 21600

export const boostPerfSweep = {
  intervalMs: 60 * 1000,
  lastRunAt: 0,
}

async function refreshPromotionStatus(promotionId) {
  const { refreshPromotionStatus: refresh } = await import('./promotion.service.js')
  return refresh(promotionId)
}

async function notifyAdmin(subject, message) {
  try {
    const { sendAdminAlert } = await import('../../../shared/mailer/alert.mailer.js')
    await sendAdminAlert(subject, message)
  } catch {}
}

/**
 * Meta operational status -> boost lifecycle mapping (safeguard: lifecycle-safe).
 *
 * Guards:
 * - Only targets currently `active` or `paused` transition. Targets in
 *   pending/validating/creating are owned by the execution flow and terminal
 *   (failed/cancelled) targets are never overwritten by a late webhook.
 * - Meta status is conceptually separate from PromotionTarget lifecycle: we
 *   only ever write ACTIVE/PAUSED/FAILED on the target, never invent states,
 *   never touch consumed/refunded billing, never touch the parent promotion —
 *   the parent is recomputed via the existing refreshPromotionStatus, which
 *   keeps it active while ANY target is active (partial success preserved).
 * - DISAPPROVED/REJECTED/ARCHIVED/DELETED -> FAILED: delivery is permanently
 *   over, matching the existing FAILED semantics ("Ad disapproved by Meta").
 *   ARCHIVED deliberately maps to FAILED (not CANCELLED) because CANCELLED is
 *   reserved for FlowX-initiated cancellation with billing cleanup.
 * - PENDING_REVIEW/PENDING_BILLING_INFO/WITH_ISSUES/PREAPPROVED and unknown
 *   states -> log-only, no state churn.
 */
export async function applyBoostMetaStatus(ref, metaStatus, issuesInfo = null) {
  const status = String(metaStatus || '').toUpperCase()
  if (!ref || !status) return { applied: false }

  if (ref.path === 'promotion') {
    const ptgt = await promoRepo.findPromotionTargetById(ref.promotionTargetId)
    if (!ptgt) return { applied: false, reason: 'promotion_target_not_found' }
    const current = String(ptgt.status || '').toLowerCase()
    if (!['active', 'paused'].includes(current)) {
      await logMetaEvent({ action: 'boost_status_skip', promotionTargetId: ref.promotionTargetId, postTargetId: ref.postTargetId, current, status })
      return { applied: false, reason: 'target_not_live' }
    }
    if (status === 'ACTIVE') {
      if (current !== 'active') {
        await promoRepo.updatePromotionTarget(ptgt.id, { status: PROMOTION_TARGET_STATUS.ACTIVE, error: null })
        await refreshPromotionStatus(ptgt.promotionId)
        await logMetaEvent({ action: 'boost_target_resumed', promotionTargetId: ptgt.id, postTargetId: ref.postTargetId, status })
      }
      return { applied: true, statusAfter: 'active' }
    }
    if (status === 'PAUSED') {
      if (current !== 'paused') {
        await promoRepo.updatePromotionTarget(ptgt.id, { status: PROMOTION_TARGET_STATUS.PAUSED })
        await refreshPromotionStatus(ptgt.promotionId)
        await logMetaEvent({ action: 'boost_target_paused', promotionTargetId: ptgt.id, postTargetId: ref.postTargetId, status })
      }
      return { applied: true, statusAfter: 'paused' }
    }
    if (['DISAPPROVED', 'REJECTED'].includes(status)) {
      // Only the new status-sync job ever passes issuesInfo — the webhook
      // handlers and the Insights-piggyback poll never fetch issues_info,
      // so they keep hitting today's exact FAILED write below, unchanged.
      if (Array.isArray(issuesInfo) && issuesInfo.length) {
        try {
          const normalized = normalizeIssuesInfo(issuesInfo)
          const repairableIssue = normalized.find((issue) => isBoostRepairableCategory(classifyIssueCode(issue.errorCode).category))
          if (repairableIssue && await isRepairCategoryEnabled(classifyIssueCode(repairableIssue.errorCode).category)) {
            const claimed = await promoRepo.claimPromotionTargetForRepairSwap(ptgt.id)
            if (claimed) {
              await refreshPromotionStatus(ptgt.promotionId)
              await logMetaEvent({ action: 'boost_target_needs_repair', promotionTargetId: ptgt.id, postTargetId: ref.postTargetId, status, errorCode: repairableIssue.errorCode })
              return { applied: true, statusAfter: 'needs_repair' }
            }
          }
        } catch (err) {
          await logMetaEvent({ action: 'boost_repair_classification_error', promotionTargetId: ptgt.id, error: err?.message || String(err) })
        }
      }
      await promoRepo.updatePromotionTarget(ptgt.id, {
        status: PROMOTION_TARGET_STATUS.FAILED,
        error: 'Ad disapproved by Meta',
        attempts: ptgt.attempts + 1,
      })
      await refreshPromotionStatus(ptgt.promotionId)
      await notifyAdmin('Boosted post ad disapproved by Meta', `Promotion target ${ptgt.id} (post ${ref.postId}, target ${ref.postTargetId}) was ${status.toLowerCase()} on Meta.`)
      await logMetaEvent({ action: 'boost_target_disapproved', promotionTargetId: ptgt.id, postTargetId: ref.postTargetId, status })
      return { applied: true, statusAfter: 'failed' }
    }
    if (['ARCHIVED', 'DELETED'].includes(status)) {
      await promoRepo.updatePromotionTarget(ptgt.id, {
        status: PROMOTION_TARGET_STATUS.FAILED,
        error: `Campaign ${status.toLowerCase()} on Meta`,
        attempts: ptgt.attempts + 1,
      })
      await refreshPromotionStatus(ptgt.promotionId)
      await notifyAdmin('Boosted post campaign removed on Meta', `Promotion target ${ptgt.id} (post ${ref.postId}, target ${ref.postTargetId}) was ${status.toLowerCase()} on Meta.`)
      await logMetaEvent({ action: 'boost_target_archived', promotionTargetId: ptgt.id, postTargetId: ref.postTargetId, status })
      return { applied: true, statusAfter: 'failed' }
    }
    await logMetaEvent({ action: 'boost_status_noop', promotionTargetId: ptgt.id, postTargetId: ref.postTargetId, status })
    return { applied: false, reason: 'status_not_mapped' }
  }

  // legacy path: boost_status is an operational mirror, free to write
  if (status === 'ACTIVE') {
    await postRepo.updatePostBoostTargetStatus(ref.postTargetId, 'active')
    await logMetaEvent({ action: 'boost_status_active', postTargetId: ref.postTargetId, postId: ref.postId })
    return { applied: true, statusAfter: 'active' }
  }
  if (status === 'PAUSED') {
    await postRepo.updatePostBoostTargetStatus(ref.postTargetId, 'paused')
    await logMetaEvent({ action: 'boost_status_paused', postTargetId: ref.postTargetId, postId: ref.postId })
    return { applied: true, statusAfter: 'paused' }
  }
  if (['DISAPPROVED', 'REJECTED'].includes(status)) {
    await postRepo.updatePostBoostTargetStatus(ref.postTargetId, 'failed')
    await notifyAdmin('Boosted post ad disapproved by Meta', `Boost for post ${ref.postId} (target ${ref.postTargetId}) was ${status.toLowerCase()} on Meta.`)
    await logMetaEvent({ action: 'boost_status_disapproved', postTargetId: ref.postTargetId, postId: ref.postId, status })
    return { applied: true, statusAfter: 'failed' }
  }
  if (['ARCHIVED', 'DELETED'].includes(status)) {
    await postRepo.updatePostBoostTargetStatus(ref.postTargetId, 'archived')
    await notifyAdmin('Boosted post campaign removed on Meta', `Boost for post ${ref.postId} (target ${ref.postTargetId}) was ${status.toLowerCase()} on Meta.`)
    await logMetaEvent({ action: 'boost_status_archived', postTargetId: ref.postTargetId, postId: ref.postId, status })
    return { applied: true, statusAfter: 'archived' }
  }
  await logMetaEvent({ action: 'boost_status_noop', postTargetId: ref.postTargetId, postId: ref.postId, status })
  return { applied: false, reason: 'status_not_mapped' }
}

function parseActionsRow(row) {
  const actions = {}
  for (const action of row.actions || []) {
    if (action?.action_type) actions[action.action_type] = Number(action.value) || 0
  }
  const costPerActionType = {}
  for (const cost of row.cost_per_action_type || []) {
    if (cost?.action_type) costPerActionType[cost.action_type] = Number(cost.value) || 0
  }
  return { actions, costPerActionType }
}

async function fanOutBoostInsightsRows(rowsData) {
  const fbIds = [...new Set((rowsData || []).map(r => String(r.campaign_id || '')).filter(Boolean))]
  if (!fbIds.length) return { rows: 0, targets: [] }
  const refs = await bpRepo.resolveBoostObjectRefs(fbIds)
  const bulkRows = []
  const targetIds = new Set()
  for (const row of rowsData || []) {
    const ref = refs.get(String(row.campaign_id || ''))
    if (!ref || !ref.postTargetId) continue
    // stat_date is the Meta ad-account timezone date (time_increment=1).
    const statDate = String(row.date_start || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(statDate)) continue
    const { actions, costPerActionType } = parseActionsRow(row)
    bulkRows.push({
      postId: ref.postId,
      postTargetId: ref.postTargetId,
      statDate,
      impressions: Number(row.impressions) || 0,
      reach: Number(row.reach) || 0,
      frequency: Number(row.frequency) || 0,
      clicks: Number(row.clicks) || 0,
      uniqueClicks: Number(row.unique_clicks) || 0,
      ctr: Number(row.ctr) || 0,
      cpc: Number(row.cpc) || 0,
      cpm: Number(row.cpm) || 0,
      spendPaise: Math.round(parseFloat(row.spend || '0') * 100),
      actions,
      costPerActionType,
    })
    targetIds.add(ref.postTargetId)
  }
  let count = 0
  try {
    count = await bpRepo.upsertBoostDailyStatsBulk(bulkRows)
  } catch (err) {
    // bulk-write failure falls back to per-row writes with per-row isolation
    for (const r of bulkRows) {
      try {
        await bpRepo.upsertBoostDailyStat(r)
        count += 1
      } catch (rowErr) {
        await logMetaEvent({ action: 'boost_insights_row_error', postTargetId: r.postTargetId, postId: r.postId, error: rowErr?.message || String(rowErr) })
      }
    }
    await logMetaEvent({ action: 'boost_insights_bulk_fallback', rows: bulkRows.length, error: err?.message || String(err) })
  }
  const stamped = [...targetIds]
  return { rows: count, targets: stamped }
}

async function piggybackBoostStatuses(adAccountId, systemToken, fbCampaignIds) {
  // Webhook-down convergence: one batched Meta GET for the same ids, then
  // the exact lifecycle-safe mapping the webhook path uses.
  if (!fbCampaignIds.length) return { checked: 0, applied: 0 }
  if (isRateLimited(tokenKeyFor(systemToken))) {
    await logMetaEvent({ action: 'boost_status_piggyback_skipped', reason: 'rate_limited' })
    return { checked: 0, applied: 0, skipped: true }
  }
  let statuses
  try {
    statuses = await getCampaignStatusesBatch(adAccountId, systemToken, fbCampaignIds)
  } catch (err) {
    await logMetaEvent({ action: 'boost_status_piggyback_error', error: err?.message || String(err) })
    return { checked: 0, applied: 0, error: err?.message || String(err) }
  }
  const refs = await bpRepo.resolveBoostObjectRefs(Object.keys(statuses))
  let applied = 0
  for (const [fbId, metaStatus] of Object.entries(statuses)) {
    const ref = refs.get(String(fbId))
    if (!ref) continue
    try {
      const result = await applyBoostMetaStatus(ref, metaStatus)
      if (result.applied) applied += 1
    } catch (err) {
      await logMetaEvent({ action: 'boost_status_piggyback_row_error', postTargetId: ref.postTargetId, error: err?.message || String(err) })
    }
  }
  return { checked: Object.keys(statuses).length, applied }
}

function computeBoostBackfillStart(earliestMappingAt) {
  const start = earliestMappingAt ? new Date(earliestMappingAt) : null
  const min = new Date(Date.now() - BOOST_PERF_MAX_HISTORY_DAYS * 24 * 60 * 60 * 1000)
  const chosen = start && Number.isFinite(start.getTime()) && start > min ? start : min
  return chosen.toISOString().slice(0, 10)
}

/**
 * Account-level boost Insights reconciliation. Converges scheduler-driven
 * batches and manual refreshes onto ONE async report FSM per ad account
 * (meta_sync_state `boost-perf:<acct>` holds reportRunId + nextPollAt).
 * Never throws for target-level failures — every row write is isolated and
 * the job returns {done:true} so it cannot mark posts failed.
 */
export async function syncBoostPerformanceJob(payload = {}) {
  const { accountId: adAccountId, accessToken: systemToken } = await resolveAccountContext()
  if (!adAccountId || !systemToken) {
    return { done: true, skipped: true, reason: 'meta_not_configured' }
  }
  const runKey = `${BOOST_PERF_RUN_KEY_PREFIX}${adAccountId}`

  try {
    const state = await getMetaSyncState(runKey)
    const reportRunId = state?.reportRunId || null
    if (reportRunId) {
      if (state?.nextPollAt && Date.now() < Number(state.nextPollAt)) {
        return { requeueAfterSeconds: Math.max(5, Math.ceil((Number(state.nextPollAt) - Date.now()) / 1000)), attempts: 0 }
      }
      const report = await getInsightsReport(reportRunId, systemToken)
      const status = report.async_status || report.status || ''
      if (status === 'Job Completed' || status === 'COMPLETED') {
        const rowsData = await getInsightsReportData(reportRunId, systemToken)
        const fanout = await fanOutBoostInsightsRows(rowsData)
        // stamp the whole requested due set, not just targets with rows: an
        // empty-but-valid window (e.g. zero-spend campaign) is a completed
        // reconciliation and must not re-poll. Falls back to fan-out targets
        // for FSM rows parked by older code (no dueTargetIds stored).
        const requested = Array.isArray(state?.dueTargetIds) && state.dueTargetIds.length ? state.dueTargetIds : fanout.targets
        if (requested.length) await bpRepo.stampBoostSyncAt(requested)
        await clearMetaSyncState(runKey)
        // converge the whole requested due set, not just campaigns with rows:
        // a zero-spend campaign has no insights row (no date_start entry) and
        // would otherwise skip status convergence every run. Same single
        // batched ?ids= GET — zero extra API cost.
        const dueTargetIds = Array.isArray(state?.dueTargetIds) && state.dueTargetIds.length ? state.dueTargetIds : []
        const requestedCampaigns = dueTargetIds.length
          ? Object.values(await bpRepo.findBoostCampaignIdsByTargets(dueTargetIds)).filter(Boolean)
          : []
        const fbIds = [...new Set([
          ...((rowsData || []).map(r => String(r.campaign_id || '')).filter(Boolean)),
          ...requestedCampaigns,
        ])]
        const converge = await piggybackBoostStatuses(adAccountId, systemToken, fbIds)
        await logMetaEvent({ action: 'boost_insights_synced', adAccountId, ...fanout, statusConverged: converge.applied })
        return { done: true, ...fanout }
      }
      if (status === 'Job Failed' || status === 'FAILED') {
        await clearMetaSyncState(runKey)
        throw new Error(`Boost insights report failed: ${report.error || 'unknown error'}`)
      }
      await saveMetaSyncState(runKey, { reportRunId, nextPollAt: Date.now() + BOOST_PERF_POLL_MIN_INTERVAL_MS, dueTargetIds: state.dueTargetIds || [] })
      return { requeueAfterSeconds: BOOST_PERF_POLL_SECONDS, attempts: 0 }
    }

    if (isRateLimited(tokenKeyFor(systemToken))) {
      await logMetaEvent({ action: 'boost_insights_deferred', reason: 'rate_limited' })
      return { requeueAfterSeconds: 300, attempts: 0 }
    }

    const due = await bpRepo.findDueBoostPerformanceTargets({
      fallbackSeconds: POST_BOOST_FALLBACK_SECONDS,
      healthySeconds: POST_BOOST_HEALTHY_SECONDS,
      freshSeconds: POST_BOOST_WEBHOOK_FRESH_SECONDS,
      forcePostId: payload?.forcePostId || null,
      limit: BOOST_PERF_MAX_TARGETS_PER_BATCH,
    })
    const postTargetIds = due.map(d => d.postTargetId)
    if (!postTargetIds.length) return { done: true, skipped: true }

    const campaignRows = await bpRepo.findBoostCampaignIdsByTargets(postTargetIds)
    const fbIds = [...new Set(Object.values(campaignRows).filter(Boolean))]
    if (!fbIds.length) {
      await bpRepo.stampBoostSyncAt(postTargetIds)
      return { done: true, skipped: true, reason: 'no_campaign_mappings' }
    }

    const earliest = await bpRepo.findEarliestBoostMappingAt(postTargetIds)
    const since = computeBoostBackfillStart(earliest)
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
      throw new Error(`Boost insights report created without report_run_id: ${JSON.stringify(report)}`)
    }
    await saveMetaSyncState(runKey, { reportRunId: runId, nextPollAt: Date.now() + BOOST_PERF_POLL_MIN_INTERVAL_MS, dueTargetIds: postTargetIds })
    await logMetaEvent({ action: 'boost_insights_report_started', adAccountId, campaigns: fbIds.length, since, until, forcePostId: payload?.forcePostId || null })
    return { requeueAfterSeconds: BOOST_PERF_POLL_SECONDS, attempts: 0 }
  } catch (err) {
    await logMetaEvent({ action: 'boost_insights_error', error: err?.message || String(err) })
    throw err
  }
}

async function requeueBoostPerfJob(accountId, payload = {}) {
  const runKey = `${BOOST_PERF_RUN_KEY_PREFIX}${accountId}`
  const existing = await findAutoJobByRunKey(runKey)
  if (existing) return { enqueued: false, alreadyQueued: true }
  await requeueAutoJob(null, POST_JOB_TYPES.SYNC_BOOST_PERFORMANCE, payload, { runKey, entityType: 'post' })
  return { enqueued: true }
}

/**
 * Leader-tick sweep: one account-level job at most (run_key dedupe, backoff
 * never reset). The sweep itself is interval-gated (60s) so the 5s tick does
 * at most a cheap due-probe most of the time.
 */
export async function schedulePostBoostPerformanceSyncs() {
  if (Date.now() - boostPerfSweep.lastRunAt < boostPerfSweep.intervalMs) {
    return { skipped: true, reason: 'sweep_throttle' }
  }
  boostPerfSweep.lastRunAt = Date.now()
  let accountId
  try {
    ;({ accountId } = await resolveAccountContext())
  } catch {
    return { skipped: true, reason: 'meta_not_configured' }
  }
  if (!accountId) return { skipped: true, reason: 'meta_not_configured' }
  const runKey = `${BOOST_PERF_RUN_KEY_PREFIX}${accountId}`
  if (await findAutoJobByRunKey(runKey)) return { skipped: true, reason: 'already_queued' }
  const due = await bpRepo.findDueBoostPerformanceTargets({
    fallbackSeconds: POST_BOOST_FALLBACK_SECONDS,
    healthySeconds: POST_BOOST_HEALTHY_SECONDS,
    freshSeconds: POST_BOOST_WEBHOOK_FRESH_SECONDS,
    limit: 1,
  })
  if (!due.length) return { skipped: true, reason: 'nothing_due' }
  await requeueAutoJob(null, POST_JOB_TYPES.SYNC_BOOST_PERFORMANCE, {}, { runKey, entityType: 'post' })
  await logMetaEvent({ action: 'boost_insights_scheduled', adAccountId: accountId })
  return { enqueued: true }
}

function totalsFor(rows) {
  const totals = {
    spendPaise: 0,
    impressions: 0,
    reach: 0,
    clicks: 0,
    uniqueClicks: 0,
    ctr: 0,
    cpc: 0,
    cpm: 0,
    frequency: 0,
    actions: {},
    costPerActionType: {},
    days: rows.length,
  }
  for (const row of rows) {
    totals.spendPaise += row.spendPaise || 0
    totals.impressions += row.impressions || 0
    totals.reach += row.reach || 0
    totals.clicks += row.clicks || 0
    totals.uniqueClicks += row.uniqueClicks || 0
    for (const [k, v] of Object.entries(row.actions || {})) {
      totals.actions[k] = (totals.actions[k] || 0) + (Number(v) || 0)
    }
  }
  const spendInr = totals.spendPaise / 100
  totals.ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0
  totals.cpc = totals.clicks > 0 ? spendInr / totals.clicks : 0
  totals.cpm = totals.impressions > 0 ? (spendInr / totals.impressions) * 1000 : 0
  totals.frequency = totals.reach > 0 ? totals.impressions / totals.reach : 0
  const latest = rows[rows.length - 1]
  totals.costPerActionType = latest?.costPerActionType || {}
  return totals
}

/**
 * Read API backing store. Returns stored rows + target-level boosts; never
 * fabricates data (unmapped targets carry hasBoost:false and no daily rows).
 * Raw Meta ids and the internal legacy/promotion path are exposed only when
 * includeDebug is true (admin endpoint).
 */
export async function getBoostPerformance(userId, postId, query = {}, { skipOwnership = false, includeDebug = false } = {}) {
  const post = await postRepo.findPostById(postId)
  if (!post) throw new NotFoundError('Post not found')
  if (!skipOwnership && post.clientId !== userId) throw new ForbiddenError('Not your post')

  let queued = false
  if (query?.refresh) {
    const resetCount = await bpRepo.resetBoostSyncForPost(postId)
    try {
      const { accountId } = await resolveAccountContext()
      if (accountId) {
        const result = await requeueBoostPerfJob(accountId, { forcePostId: postId })
        // second refresh click while queued/running is a deliberate no-op,
        // but the post's targets are now marked due, so the converged run or
        // the next cadence pass picks them up
        queued = resetCount > 0 && (result.enqueued || result.alreadyQueued)
      }
    } catch {
      queued = false
    }
  }

  const mappings = await bpRepo.findBoostMappingsByPostId(postId)
  const rows = await bpRepo.findBoostDailyStatsByPostId(postId)
  const rowsByTarget = new Map()
  for (const row of rows) {
    if (!rowsByTarget.has(row.postTargetId)) rowsByTarget.set(row.postTargetId, [])
    rowsByTarget.get(row.postTargetId).push({
      statDate: row.statDate,
      impressions: row.impressions,
      reach: row.reach,
      frequency: row.frequency,
      clicks: row.clicks,
      uniqueClicks: row.uniqueClicks,
      ctr: row.ctr,
      cpc: row.cpc,
      cpm: row.cpm,
      spendPaise: row.spendPaise,
      actions: row.actions,
      costPerActionType: row.costPerActionType,
      lastSource: row.lastSource,
    })
  }

  const targets = mappings.map(m => {
    const daily = rowsByTarget.get(m.postTargetId) || []
    const entry = {
      postTargetId: m.postTargetId,
      targetType: m.targetType,
      platform: m.platform,
      platformCode: m.platformCode,
      platformDisplayName: m.platformDisplayName,
      platformUsername: m.platformUsername,
      // FlowX publisher identity (not raw Meta ids): safe for client
      // responses — the client owns the post and charged these boosts.
      publisherName: m.publisherName || null,
      publisherEmail: m.publisherEmail || null,
      hasBoost: true,
      boostStatus: m.boostStatus,
      error: m.error,
      daily,
      latest: daily[daily.length - 1] || null,
      totals: totalsFor(daily),
      freshness: {
        lastWebhookAt: m.lastBoostWebhookAt,
        lastInsightsSyncAt: m.lastBoostSyncAt,
      },
    }
    if (includeDebug) {
      entry.debug = {
        path: m.path,
        promotionTargetId: m.promotionTargetId,
        fbCampaignId: m.fbCampaignId,
        fbAdsetId: m.fbAdsetId,
        fbCreativeId: m.fbCreativeId,
        fbAdId: m.fbAdId,
      }
    }
    return entry
  })

  const posted = await postRepo.findPostTargetsByPostId(postId)
  const postedTargetCount = posted.filter(t => t.status === 'posted').length

  return {
    postId,
    postType: post.type,
    boostedCount: mappings.length,
    postedTargetCount,
    queued,
    lastSyncAt: targets.reduce((acc, t) => {
      const v = t.freshness.lastInsightsSyncAt
      return v && (!acc || v > acc) ? v : acc
    }, null),
    targets,
  }
}
