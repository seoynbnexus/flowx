import * as repo from './campaign.repository.js'
import * as service from './campaign.service.js'
import * as postService from '../posts/post.service.js'
import { AppError } from '../../../shared/errors/AppError.js'
import { CAMPAIGN_JOB_TYPES } from './campaign.model.js'
import { POST_JOB_TYPES } from '../posts/post.model.js'
import { isRateLimited } from '../../../shared/services/meta-rate-limiter.js'
import os from 'node:os'

const JOB_CONCURRENCY = Number(process.env.CAMPAIGN_JOB_CONCURRENCY) || 10
const STALE_JOB_MINUTES = 10
const MAX_BACKOFF_SECONDS = 3600
const SCHEDULER_LEASE_NAME = 'meta_sync_scheduler'
const SCHEDULER_LEASE_TTL_SECONDS = 30
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
  [POST_JOB_TYPES.PUBLISH]: (postId) => postService.publishPostJob(postId),
  [POST_JOB_TYPES.VERIFY]: (postId) => postService.verifyPostJob(postId),
  [POST_JOB_TYPES.SYNC_ENGAGEMENT]: (postId) => postService.syncPostEngagementJob(postId),
  [POST_JOB_TYPES.FB_REEL]: (campaignId, actorId, payload) => postService.fbReelJob(payload?.postId, payload?.targetId, payload),
  [POST_JOB_TYPES.PUBLISHER_GO_LIVE]: (postId) => postService.goLiveForFilledPost(postId),
  [POST_JOB_TYPES.EXPIRE_PUBLISHER_REQUESTS]: (postId) => postService.expirePublisherPosts([postId]),
}

function isPermanentError(error) {
  return error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500
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
      const result = await handler(job.campaignId, job.actorId, job.payload)
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
        } else if (job.entityType !== 'post') {
          await service.markCampaignJobFailed(job.campaignId, job.jobType, message)
        }
      } else {
        const backoffSeconds = Math.min(2 ** job.attempts * 30, MAX_BACKOFF_SECONDS)
        await repo.rescheduleCampaignJob(job.id, message, backoffSeconds)
      }
    }
  }))
  return jobs.length
}

export async function drainCampaignJobs({ timeoutMs = 15000, pollMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ran = await processDueJobs()
    const active = await repo.countActiveCampaignJobs()
    if (ran === 0 && active === 0) return
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  throw new Error('drainCampaignJobs timed out')
}

let workerTimer = null

export function startCampaignJobWorker() {
  if (workerTimer) return workerTimer
  processDueJobs().catch((err) => console.error('Campaign job worker error:', err?.message))
  workerTimer = setInterval(() => {
    processDueJobs().catch((err) => console.error('Campaign job worker error:', err?.message))
  }, 2000)
  workerTimer.unref?.()
  return workerTimer
}

export function stopCampaignJobWorker() {
  if (workerTimer) {
    clearInterval(workerTimer)
    workerTimer = null
  }
}

let syncSchedulerTimer = null
let balanceTick = 0

async function tickSyncScheduler() {
  const isLeader = await repo.claimSchedulerLease(SCHEDULER_LEASE_NAME, instanceId, SCHEDULER_LEASE_TTL_SECONDS)
  if (!isLeader) return
  try {
    await service.scheduleCampaignSyncs()
    await postService.schedulePostEngagementSyncs()
    await postService.handleExpiredPublisherPosts()
    balanceTick += 1
    if (balanceTick % 12 === 0) {
      balanceTick = 0
      if (!isRateLimited()) {
        await service.pollAccountBalance()
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
