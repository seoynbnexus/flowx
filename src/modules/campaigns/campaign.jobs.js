import * as repo from './campaign.repository.js'
import * as service from './campaign.service.js'
import { AppError } from '../../../shared/errors/AppError.js'
import { CAMPAIGN_JOB_TYPES } from './campaign.model.js'

const JOB_CONCURRENCY = 2
const STALE_JOB_MINUTES = 10
const MAX_BACKOFF_SECONDS = 3600

const HANDLERS = {
  [CAMPAIGN_JOB_TYPES.FORCE_GO_LIVE]: (campaignId, actorId) => service.forceGoLiveCampaign(actorId, campaignId),
  [CAMPAIGN_JOB_TYPES.PUBLISHER_GO_LIVE]: (campaignId) => service.goLiveForFilledCampaign(campaignId),
  [CAMPAIGN_JOB_TYPES.APPROVE_GO_LIVE]: (campaignId, actorId, payload) => service.approveAndGoLive(campaignId, actorId, payload),
  [CAMPAIGN_JOB_TYPES.CONFIRM_GO_LIVE]: (campaignId, actorId) => service.confirmAndGoLive(campaignId, actorId),
  [CAMPAIGN_JOB_TYPES.RETRY_META]: (campaignId) => service.retryCampaignMeta(campaignId),
}

function isPermanentError(error) {
  return error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500
}

export async function processDueJobs() {
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
      await handler(job.campaignId, job.actorId, job.payload)
      await repo.completeCampaignJob(job.id, 'done')
    } catch (error) {
      const message = error?.message || String(error)
      if (isPermanentError(error) || job.attempts >= job.maxAttempts) {
        await repo.completeCampaignJob(job.id, 'dead', message)
        await service.markCampaignJobFailed(job.campaignId, job.jobType, message)
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
