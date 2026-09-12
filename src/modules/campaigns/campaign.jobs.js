import * as repo from './campaign.repository.js'
import * as service from './campaign.service.js'
import * as postService from '../posts/post.service.js'
import * as promotionService from '../posts/promotion.service.js'
import * as boostPerfService from '../posts/boost-performance.service.js'
import * as deletionService from '../posts/deletion-monitoring.service.js'
import { AppError } from '../../../shared/errors/AppError.js'
import { CAMPAIGN_JOB_TYPES } from './campaign.model.js'
import { POST_JOB_TYPES } from '../posts/post.model.js'
import { isRateLimited } from '../../../shared/services/meta-rate-limiter.js'
import { runWithMetaRequestContext, GATE_PRIORITY } from '../../../shared/services/meta-request-gate.js'
import { logger } from '../../../shared/utils/logger.js'
import os from 'node:os'

const JOB_CONCURRENCY = Number(process.env.CAMPAIGN_JOB_CONCURRENCY) || 25
const STALE_JOB_MINUTES = 10
const MAX_BACKOFF_SECONDS = 3600
const SCHEDULER_LEASE_NAME = 'meta_sync_scheduler'
const SCHEDULER_LEASE_TTL_SECONDS = 30
const WORKER_LEASE_NAME = 'campaign_job_worker'
const WORKER_LEASE_TTL_SECONDS = 10
const instanceId = process.env.INSTANCE_ID || `${os.hostname()}:${process.pid}`

const HANDLERS = {
  [CAMPAIGN_JOB_TYPES.FORCE_GO_LIVE]: (campaignId, actorId) => service.forceGoLiveCampaign(actorId, campaignId),
  [CAMPAIGN_JOB_TYPES.PUBLISHER_GO_LIVE]: (campaignId) => service.goLiveForFilledCampaign(campaignId),
  [CAMPAIGN_JOB_TYPES.APPROVE_GO_LIVE]: (campaignId, actorId, payload) => service.approveAndGoLive(campaignId, actorId, payload),
  [CAMPAIGN_JOB_TYPES.CONFIRM_GO_LIVE]: (campaignId, actorId) => service.confirmAndGoLive(campaignId, actorId),
  [CAMPAIGN_JOB_TYPES.RETRY_META]: (campaignId) => service.retryCampaignMeta(campaignId),
  [CAMPAIGN_JOB_TYPES.SYNC_STATUS]: (campaignId) => service.syncCampaignStatusJob(campaignId),
  [CAMPAIGN_JOB_TYPES.SYNC_INSIGHTS]: (campaignId) => service.syncCampaignInsightsJob(campaignId),
  [CAMPAIGN_JOB_TYPES.SYNC_ACCOUNT_STATUS]: (campaignId, actorId, payload) => service.syncAccountStatusJob(payload?.adAccountId ?? undefined),
  [CAMPAIGN_JOB_TYPES.SYNC_ACCOUNT_INSIGHTS]: (campaignId, actorId, payload) => service.syncAccountInsightsJob(payload?.adAccountId ?? undefined),
  [CAMPAIGN_JOB_TYPES.SETTLE_CAMPAIGN]: (campaignId) => service.settleCampaignJob(campaignId),
  [CAMPAIGN_JOB_TYPES.META_WEBHOOK]: async (campaignId, actorId, payload) => {
    const { processWebhookEventById } = await import('./meta-webhook.service.js')
    const eventId = payload?.eventId || campaignId
    return processWebhookEventById(eventId)
  },
  [POST_JOB_TYPES.PUBLISH]: (postId) => postService.publishPostJob(postId),
  [POST_JOB_TYPES.VERIFY]: (postId) => postService.verifyPostJob(postId),
  [POST_JOB_TYPES.SYNC_ENGAGEMENT]: (postId, actorId, payload) => postService.syncPostEngagementJob(postId, payload),
  [POST_JOB_TYPES.SYNC_ENGAGEMENT_TARGET]: (postId, actorId, payload) => postService.syncPostEngagementJob(postId, { targetId: payload?.targetId }),
  [POST_JOB_TYPES.FB_REEL]: (campaignId, actorId, payload) => postService.fbReelJob(payload?.postId, payload?.targetId, payload),
  [POST_JOB_TYPES.IG_REEL]: (campaignId, actorId, payload) => postService.igReelJob(payload?.postId, payload?.targetId, payload),
  [POST_JOB_TYPES.IG_STORY]: (campaignId, actorId, payload) => postService.igVideoStoryJob(payload?.postId, payload?.targetId, payload),
  [POST_JOB_TYPES.PUBLISHER_GO_LIVE]: (postId) => postService.goLiveForFilledPost(postId),
  [POST_JOB_TYPES.EXPIRE_PUBLISHER_REQUESTS]: (postId) => postService.expirePublisherPosts([postId]),
  [POST_JOB_TYPES.BOOST]: (campaignId, actorId, payload) => postService.postBoostJob(payload?.postId, payload?.postTargetId, payload),
  [POST_JOB_TYPES.SYNC_BOOST_PERFORMANCE]: (campaignId, actorId, payload) => boostPerfService.syncBoostPerformanceJob(payload || {}),
  [POST_JOB_TYPES.REMOTE_HEALTH]: (campaignId, actorId, payload) => deletionService.runRemoteHealthJob(payload || {}),
  'promotion_execute': (campaignId, actorId, payload) => promotionService.runPromotionTargetJob(payload?.promotionTargetId, payload),
}

function isPermanentError(error) {
  return error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500
}

/**
 * Gate priority lanes per job type. User-critical publishing/boost work and
 * webhook reconciliation run HIGH; continuous background reconciliation
 * (status/insights/engagement/health) runs LOW so it yields to user actions
 * within the process-local Meta request gate.
 */
const JOB_GATE_PRIORITY = {
  [CAMPAIGN_JOB_TYPES.FORCE_GO_LIVE]: GATE_PRIORITY.HIGH,
  [CAMPAIGN_JOB_TYPES.PUBLISHER_GO_LIVE]: GATE_PRIORITY.HIGH,
  [CAMPAIGN_JOB_TYPES.APPROVE_GO_LIVE]: GATE_PRIORITY.HIGH,
  [CAMPAIGN_JOB_TYPES.CONFIRM_GO_LIVE]: GATE_PRIORITY.HIGH,
  [CAMPAIGN_JOB_TYPES.RETRY_META]: GATE_PRIORITY.HIGH,
  [CAMPAIGN_JOB_TYPES.SYNC_STATUS]: GATE_PRIORITY.LOW,
  [CAMPAIGN_JOB_TYPES.SYNC_INSIGHTS]: GATE_PRIORITY.LOW,
  [CAMPAIGN_JOB_TYPES.SYNC_ACCOUNT_STATUS]: GATE_PRIORITY.LOW,
  [CAMPAIGN_JOB_TYPES.SYNC_ACCOUNT_INSIGHTS]: GATE_PRIORITY.LOW,
  [CAMPAIGN_JOB_TYPES.SETTLE_CAMPAIGN]: GATE_PRIORITY.LOW,
  [CAMPAIGN_JOB_TYPES.META_WEBHOOK]: GATE_PRIORITY.HIGH,
  [POST_JOB_TYPES.PUBLISH]: GATE_PRIORITY.HIGH,
  [POST_JOB_TYPES.VERIFY]: GATE_PRIORITY.HIGH,
  [POST_JOB_TYPES.SYNC_ENGAGEMENT]: GATE_PRIORITY.LOW,
  [POST_JOB_TYPES.SYNC_ENGAGEMENT_TARGET]: GATE_PRIORITY.HIGH,
  [POST_JOB_TYPES.FB_REEL]: GATE_PRIORITY.HIGH,
  [POST_JOB_TYPES.IG_REEL]: GATE_PRIORITY.HIGH,
  [POST_JOB_TYPES.IG_STORY]: GATE_PRIORITY.HIGH,
  [POST_JOB_TYPES.PUBLISHER_GO_LIVE]: GATE_PRIORITY.HIGH,
  [POST_JOB_TYPES.EXPIRE_PUBLISHER_REQUESTS]: GATE_PRIORITY.HIGH,
  [POST_JOB_TYPES.BOOST]: GATE_PRIORITY.HIGH,
  [POST_JOB_TYPES.SYNC_BOOST_PERFORMANCE]: GATE_PRIORITY.LOW,
  [POST_JOB_TYPES.REMOTE_HEALTH]: GATE_PRIORITY.LOW,
  promotion_execute: GATE_PRIORITY.HIGH,
}

export async function processDueJobs() {
  if (isRateLimited()) return 0
  await repo.requeueStaleCampaignJobs(STALE_JOB_MINUTES)
  const jobs = await repo.claimDueCampaignJobs(JOB_CONCURRENCY)
  if (!jobs.length) return 0

  await Promise.all(jobs.map(async (job) => {
    const handler = HANDLERS[job.jobType]
    if (!handler) {
      await repo.completeCampaignJob(job.id, 'dead', `No handler for job type: ${job.jobType}`)
      return
    }
    try {
      const result = await runWithMetaRequestContext(
        { priority: JOB_GATE_PRIORITY[job.jobType] || GATE_PRIORITY.HIGH, source: 'job', jobType: job.jobType },
        () => handler(job.campaignId, job.actorId, job.payload)
      )
      if (result && typeof result.requeueAfterSeconds === 'number') {
        await repo.requeueReelJob(job.id, result.requeueAfterSeconds, result.attempts)
      } else {
        await repo.completeCampaignJob(job.id, 'done')
      }
    } catch (error) {
      const message = error?.message || String(error)
      if (isPermanentError(error) || job.attempts >= job.maxAttempts) {
        await repo.completeCampaignJob(job.id, 'dead', message)
        if (job.entityType === 'post' && job.jobType === POST_JOB_TYPES.PUBLISH) {
          await postService.markPostJobFailed(job.campaignId, message)
        } else if (job.entityType !== 'post' && job.entityType !== 'system' && job.campaignId) {
          await service.markCampaignJobFailed(job.campaignId, job.jobType, message)
        } else if (job.jobType === CAMPAIGN_JOB_TYPES.META_WEBHOOK) {
          const { query } = await import('../../../shared/database/connection.js')
          await query('UPDATE meta_webhook_events SET processing_status = ?, last_error = ? WHERE id = ?', ['dead', message.slice(0, 2000), job.payload?.eventId || job.campaignId])
        }
      } else {
        const backoffSeconds = Math.min(2 ** job.attempts * 30, MAX_BACKOFF_SECONDS)
        await repo.rescheduleCampaignJob(job.id, message, backoffSeconds)
        if (job.jobType === CAMPAIGN_JOB_TYPES.META_WEBHOOK) {
          const { query } = await import('../../../shared/database/connection.js')
          const nextAt = new Date(Date.now() + backoffSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ')
          await query('UPDATE meta_webhook_events SET processing_status = ?, last_error = ?, next_attempt_at = ?, attempts = attempts + 1 WHERE id = ?', ['retryable', message.slice(0, 2000), nextAt, job.payload?.eventId || job.campaignId])
        }
      }
    }
  }))
  return jobs.length
}

/**
 * One worker iteration, fenced by the fleet-wide `campaign_job_worker` DB
 * lease. The claim-per-tick is both heartbeat AND fence: claimSchedulerLease
 * only renews for the current owner, so a worker that lost the lease (another
 * process took over after TTL expiry) gets `false` and stands down before
 * claiming any new work. In-flight jobs still finish — claims are idempotent
 * row transitions (`status='queued'` guard), so a takeover can never
 * double-execute a job, and the stale worker never picks up NEW work.
 */
export async function workerTick() {
  const isOwner = await repo.claimSchedulerLease(WORKER_LEASE_NAME, instanceId, WORKER_LEASE_TTL_SECONDS)
  if (!isOwner) return 0
  return processDueJobs()
}

/**
 * Test seam: run a worker tick as an explicit owner id so lease-loss scenarios
 * can be simulated without process forking. Same fencing as workerTick.
 */
export async function workerTickForOwner(ownerId) {
  const isOwner = await repo.claimSchedulerLease(WORKER_LEASE_NAME, ownerId, WORKER_LEASE_TTL_SECONDS)
  if (!isOwner) return 0
  return processDueJobs()
}

export async function drainCampaignJobs({ timeoutMs = 15000, pollMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ran = await processDueJobs()
    const active = await repo.countActiveCampaignJobs()
    if (ran === 0 && active === 0) return
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  // test-only diagnostic: name the jobs blocking the drain so shared-DB
  // contamination is debuggable instead of a bare timeout
  if (process.env.NODE_ENV === 'test') {
    const { query } = await import('../../../shared/database/connection.js')
    const blockers = await query(
      "SELECT job_type, status, run_key, run_after, started_at, campaign_id FROM campaign_jobs WHERE status IN ('queued', 'running') ORDER BY created_at LIMIT 10"
    ).catch(() => [])
    throw new Error(`drainCampaignJobs timed out; blocking jobs: ${JSON.stringify(blockers.map(b => ({ job_type: b.job_type, status: b.status, run_key: b.run_key, run_after: b.run_after, started_at: b.started_at, campaign_id: b.campaign_id ? Buffer.from(b.campaign_id).toString('hex').slice(0, 8) : null })))}`)
  }
  throw new Error('drainCampaignJobs timed out')
}

let workerTimer = null

export function shouldRunWorker() {
  return process.env.WORKER_ENABLED !== '0'
}

export function shouldRunScheduler() {
  return process.env.SYNC_SCHEDULER_ENABLED !== '0'
}

export function startBackgroundWorkers() {
  const workerEnabled = shouldRunWorker()
  const schedulerEnabled = shouldRunScheduler()
  if (workerEnabled) startCampaignJobWorker()
  if (schedulerEnabled) startMetaSyncScheduler()
  return { workerEnabled, schedulerEnabled }
}

export function startCampaignJobWorker() {
  if (workerTimer) return workerTimer
  workerTick().catch((err) => console.error('Campaign job worker error:', err?.message))
  workerTimer = setInterval(() => {
    workerTick().catch((err) => console.error('Campaign job worker error:', err?.message))
  }, 2000)
  workerTimer.unref?.()
  return workerTimer
}

export function stopCampaignJobWorker() {
  if (workerTimer) {
    clearInterval(workerTimer)
    workerTimer = null
  }
  repo.releaseSchedulerLease(WORKER_LEASE_NAME, instanceId).catch(() => {})
}

let syncSchedulerTimer = null

export const balancePoll = {
  intervalMs: (Number(process.env.META_BALANCE_POLL_SECONDS) || 900) * 1000,
  lastRunAt: 0,
}

export function balancePollDue(now = Date.now()) {
  return now - balancePoll.lastRunAt >= balancePoll.intervalMs
}

export const maintenance = {
  intervalMs: 24 * 60 * 60 * 1000,
  lastRunAt: 0,
}

export function maintenanceDue(now = Date.now()) {
  return now - maintenance.lastRunAt >= maintenance.intervalMs
}

export const webhookCheck = {
  intervalMs: Number(process.env.META_WEBHOOK_CHECK_INTERVAL_HOURS || 24) * 60 * 60 * 1000,
  lastRunAt: 0,
}

export function webhookCheckDue(now = Date.now()) {
  return now - webhookCheck.lastRunAt >= webhookCheck.intervalMs
}

// Retention TTLs live in ONE place: shared/database/retention.js (TABLE_PURGES).
// JOB_RETENTION_DAYS / ENGAGEMENT_RETENTION_DAYS / WEBHOOK_RETENTION_DAYS
// are read there — do not redeclare retention windows here.
const META_RATE_ALERT_PER_MIN = Math.max(1, Number(process.env.META_RATE_ALERT_PER_MIN) || 120)
const META_RATE_ALERT_DEDUPE_KEY = 'meta_rate_alert'
const META_RATE_ALERT_DEDUPE_SECONDS = 3600

export async function runJobMaintenance() {
  const { runRetentionSweep, sampleDbGrowth } = await import('../../../shared/database/retention.js')
  const [retention, growth] = await Promise.all([
    runRetentionSweep().catch((err) => {
      logger.warn({ err: err?.message }, 'Retention sweep failed')
      return null
    }),
    sampleDbGrowth().catch(() => null),
  ])

  if (!retention) {
    logger.warn({ growthSampled: !!growth }, 'Job archival maintenance failed (retention sweep error)')
    return { removed: 0, rowsDeleted: 0, tables: {}, partial: ['retention_sweep_failed'] }
  }

  const result = {
    removed: retention.removed,
    rowsDeleted: retention.rowsDeleted,
    batches: retention.batches,
    durationMs: retention.durationMs,
    tables: retention.tables,
    partial: retention.partial,
    dbGrowthSampled: !!growth,
  }

  if (retention.partial.length > 0) {
    logger.warn(
      { partial: retention.partial, tables: retention.tables, removed: retention.removed, durationMs: retention.durationMs },
      'Job archival maintenance PARTIAL — retention backlog remains (next run continues)'
    )
  } else {
    logger.info(result, 'Job archival maintenance complete — all retention tables fully purged')
  }
  return result
}

/**
 * SUSTAINED-rate alert signal (not a correctness limiter): any account whose
 * rolling 60s request window through the process-local gate exceeds the
 * configured threshold triggers one admin alert per dedupe window. Evaluated
 * on the leader tick only. Uses meta_sync_state as the cross-restart dedupe.
 */
export async function checkMetaRateAlert() {
  try {
    const { getGateStats } = await import('../../../shared/services/meta-request-gate.js')
    const stats = getGateStats()
    const hot = []
    for (const [accountKey, st] of Object.entries(stats.byAccount || {})) {
      if (Number(st.windowRequests || 0) >= META_RATE_ALERT_PER_MIN) hot.push({ accountKey, windowRequests: st.windowRequests, errors: st.errors })
    }
    if (!hot.length) return { alert: false }

    const { getMetaSyncState, saveMetaSyncState } = await import('./campaign.repository.js')
    const state = await getMetaSyncState(META_RATE_ALERT_DEDUPE_KEY)
    const lastAt = state?.lastAlertAt ? new Date(state.lastAlertAt).getTime() : 0
    if (Date.now() - lastAt < META_RATE_ALERT_DEDUPE_SECONDS * 1000) return { alert: false, deduped: true }

    await saveMetaSyncState(META_RATE_ALERT_DEDUPE_KEY, { lastAlertAt: new Date().toISOString() })
    const { sendAdminAlert } = await import('../../../shared/mailer/alert.mailer.js')
    await sendAdminAlert(
      'Meta API request-rate threshold exceeded',
      `Accounts exceeding ${META_RATE_ALERT_PER_MIN} requests/min (process-local gate, this process): ${hot.map(h => `${h.accountKey}=${h.windowRequests}/min`).join(', ')}. Peak in-flight ${stats.peakGlobalInFlight}/${stats.globalLimit}. Investigate logs (metaGate entries) for the driving job type.`
    )
    logger.warn({ hot, threshold: META_RATE_ALERT_PER_MIN }, 'Meta request-rate alert')
    return { alert: true, hot }
  } catch (err) {
    logger.warn({ err: err?.message }, 'Meta rate alert check failed')
    return { alert: false, error: err?.message }
  }
}

async function tickSyncScheduler() {
  const isLeader = await repo.claimSchedulerLease(SCHEDULER_LEASE_NAME, instanceId, SCHEDULER_LEASE_TTL_SECONDS)
  if (!isLeader) return
  try {
    if (maintenanceDue()) {
      maintenance.lastRunAt = Date.now()
      try {
        await runJobMaintenance()
      } catch (err) {
        logger.warn({ err: err?.message }, 'Job archival maintenance failed')
      }
    }
    await checkMetaRateAlert()
    await service.scheduleCampaignSyncs()
    await postService.schedulePostEngagementSyncs()
    try {
      await boostPerfService.schedulePostBoostPerformanceSyncs()
    } catch (err) {
      logger.warn({ err: err?.message }, 'Boost performance scheduler sweep failed')
    }
    await postService.handleExpiredPublisherPosts()
    try {
      await promotionService.recoverStuckPromotionTargets()
    } catch (err) {
      logger.warn({ err: err?.message }, 'Promotion recovery sweep failed')
    }
    try {
      await deletionService.scheduleDeletionMonitoring()
    } catch (err) {
      logger.warn({ err: err?.message }, 'Deletion monitoring sweep failed')
    }
    if (webhookCheckDue()) {
      webhookCheck.lastRunAt = Date.now()
      try {
        const { checkWebhookSubscriptions } = await import('../../jobs/check-webhook-subscriptions.js')
        await runWithMetaRequestContext({ priority: GATE_PRIORITY.LOW, source: 'scheduler', jobType: 'webhook_health' }, () => checkWebhookSubscriptions())
      } catch (err) {
        logger.warn({ err: err?.message }, 'Webhook subscription auto-check failed')
      }
    }
    if (balancePollDue()) {
      balancePoll.lastRunAt = Date.now()
      if (!isRateLimited()) {
        await runWithMetaRequestContext({ priority: GATE_PRIORITY.LOW, source: 'scheduler', jobType: 'account_balance' }, () => service.pollAccountBalance())
      }
    }
  } catch (err) {
    console.error('Meta sync scheduler tick error:', err?.message)
  }
}

export function startMetaSyncScheduler() {
  if (syncSchedulerTimer) return syncSchedulerTimer
  syncSchedulerTimer = setInterval(() => {
    tickSyncScheduler().catch((err) => console.error('Meta sync scheduler error:', err?.message))
  }, 5000)
  syncSchedulerTimer.unref?.()
  return syncSchedulerTimer
}

export function stopMetaSyncScheduler() {
  if (syncSchedulerTimer) {
    clearInterval(syncSchedulerTimer)
    syncSchedulerTimer = null
  }
}
