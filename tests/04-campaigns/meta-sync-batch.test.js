import { describe, it, expect, beforeAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'
import { query, queryOne } from '../../shared/database/connection.js'
import { resetRateLimitState, recordUsage, isSoftThrottled, isRateLimited } from '../../shared/services/meta-rate-limiter.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    listAccountAds: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    getCampaignStatusesBatch: vi.fn().mockResolvedValue({}),
    createInsightsReport: vi.fn().mockResolvedValue({ report_run_id: 'run_batch_1' }),
    getInsightsReport: vi.fn().mockResolvedValue({ async_status: 'Job Running', data: [] }),
    getInsightsReportData: vi.fn().mockResolvedValue([]),
    getAdAccount: vi.fn().mockResolvedValue({ balance: '10.00', currency: 'INR', account_status: 1, disable_reason: null }),
  }
  metaMocks = mocks
  return mocks
})

const dateTag = Date.now()

async function ensurePlan(userId) {
  const sub = await subRepo.findUserSubscription(userId)
  if (sub) return
  const starter = await subRepo.findPlanBySlug('starter')
  if (starter) {
    await subRepo.upsertUserSubscription(userId, starter.id, {
      status: 'active',
      billingCycle: 'monthly',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    })
  }
}

async function seedRunningCampaign(userId, { status = 'running', metaStatus = 'created', scheduledAt = null, adSuffix } = {}) {
  const campaign = await campaignService.createCampaign(userId, {
    name: `MetaBatch ${generateUuid().substring(0, 8)}`,
    type: 'post',
    scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
  })
  await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'batch test', mediaUrl: 'https://example.com/x.jpg' })
  await campaignRepo.createMetaSettings(generateUuid(), campaign.id, {
    objective: 'OUTCOME_TRAFFIC',
    budgetType: 'lifetime',
    budgetAmount: 500,
    endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  })
  const suffix = adSuffix || generateUuid().substring(0, 8)
  const fbCampaignId = `fb_camp_${suffix}`
  const adId = `ad_${suffix}`
  await campaignRepo.createMetaObject(campaign.id, 'facebook_campaign', fbCampaignId, null, 'ACTIVE', userId)
  await campaignRepo.createMetaObject(campaign.id, 'ad_set', `adset_${suffix}`, null, 'ACTIVE', userId)
  await campaignRepo.createMetaObject(campaign.id, 'ad_creative', `creative_${suffix}`, null, 'ACTIVE', userId)
  await campaignRepo.createMetaObject(campaign.id, 'ad', adId, null, 'ACTIVE', userId)
  await campaignRepo.updateCampaignStatus(campaign.id, status)
  if (metaStatus === 'paused') await campaignRepo.updateCampaign(campaign.id, { metaStatus: 'paused' })
  return { campaignId: campaign.id, adId, fbCampaignId }
}

describe('campaign meta batch sync', () => {
  let client

  beforeAll(async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'test_system_user_token'
    process.env.META_AD_ACCOUNT_ID = 'act_test_account'
    client = await createTestUser({
      email: `meta-batch-${dateTag}@flowx-test.com`,
      password: 'Test@123',
      coins: 10000,
    })
    await ensurePlan(client.id)
    await query('DELETE FROM campaign_jobs')
    await query('DELETE FROM campaign_daily_stats')
    await query('DELETE FROM campaign_billing_entries')
    await query('DELETE FROM meta_sync_state')
  })

  describe('account-level status batch', () => {
    it('syncs every campaign with a single account ads call', async () => {
      const first = await seedRunningCampaign(client.id, { adSuffix: 'aaa' })
      const second = await seedRunningCampaign(client.id, { adSuffix: 'bbb' })
      metaMocks.listAccountAds.mockResolvedValue({
        rows: [
          { id: first.adId, status: 'PAUSED', effective_status: 'PAUSED' },
          { id: second.adId, status: 'ACTIVE', effective_status: 'ACTIVE' },
        ],
        truncated: false,
      })

      const result = await campaignService.syncAccountStatusJob('act_test_account')

      expect(result.success).toBe(true)
      expect(result.ads).toBe(2)
      expect(metaMocks.listAccountAds).toHaveBeenCalledTimes(1)
      expect(metaMocks.listAccountAds).toHaveBeenCalledWith('act_test_account', process.env.META_SYSTEM_USER_TOKEN)

      const firstAfter = await campaignRepo.findCampaignById(first.campaignId)
      expect(firstAfter.status).toBe('paused')
      expect(firstAfter.metaStatus).toBe('paused')
      const secondAfter = await campaignRepo.findCampaignById(second.campaignId)
      expect(secondAfter.status).toBe('running')

      const reviewLogs = await query(
        `SELECT * FROM campaign_review_log WHERE campaign_id = ?`,
        [uuidToBuffer(first.campaignId)]
      )
      expect(reviewLogs.some(r => r.notes.includes('paused from Meta'))).toBe(true)
    })

    it('marks a campaign failed when its ad is disapproved', async () => {
      const { campaignId, adId } = await seedRunningCampaign(client.id, { adSuffix: 'rej1' })
      metaMocks.listAccountAds.mockResolvedValue({
        rows: [{ id: adId, status: 'DISAPPROVED', effective_status: 'DISAPPROVED' }],
        truncated: false,
      })

      const result = await campaignService.syncAccountStatusJob('act_test_account')

      const updated = await campaignRepo.findCampaignById(campaignId)
      expect(updated.status).toBe('failed')
      expect(updated.metaStatus).toBe('failed')
      expect(updated.metaError).toContain('disapproved')
      const reviewLogs = await query(
        `SELECT * FROM campaign_review_log WHERE campaign_id = ?`,
        [uuidToBuffer(campaignId)]
      )
      expect(reviewLogs.some(r => r.notes.includes('disapproved by Meta'))).toBe(true)
      expect(result.campaigns).toBeGreaterThan(0)
    })

    it('marks a paused campaign failed when its ad is disapproved', async () => {
      const { campaignId, adId } = await seedRunningCampaign(client.id, {
        status: 'paused',
        metaStatus: 'paused',
        adSuffix: 'rej2',
      })
      metaMocks.listAccountAds.mockResolvedValue({
        rows: [{ id: adId, status: 'DISAPPROVED', effective_status: 'DISAPPROVED' }],
        truncated: false,
      })

      await campaignService.syncAccountStatusJob('act_test_account')

      const updated = await campaignRepo.findCampaignById(campaignId)
      expect(updated.status).toBe('failed')
      expect(updated.metaStatus).toBe('failed')
    })

    it('archives campaigns whose ad disappeared from the account', async () => {
      const { campaignId } = await seedRunningCampaign(client.id, { adSuffix: 'gone' })
      metaMocks.listAccountAds.mockResolvedValue({ rows: [], truncated: false })

      const result = await campaignService.syncAccountStatusJob('act_test_account')

      const updated = await campaignRepo.findCampaignById(campaignId)
      expect(updated.metaStatus).toBe('archived')
      expect(result.campaigns).toBeGreaterThan(0)
    })

    it('skips the missing-ad archive sweep when the account list is truncated', async () => {
      const { campaignId } = await seedRunningCampaign(client.id, { adSuffix: 'trunc' })
      metaMocks.listAccountAds.mockResolvedValue({ rows: [], truncated: true })

      await campaignService.syncAccountStatusJob('act_test_account')

      const updated = await campaignRepo.findCampaignById(campaignId)
      expect(updated.metaStatus).not.toBe('archived')
    })

    it('fetches campaign-level status in a batch for campaigns in review that need it', async () => {
      const { campaignId, fbCampaignId } = await seedRunningCampaign(client.id, { adSuffix: 'cplvl' })
      metaMocks.listAccountAds.mockResolvedValue({
        rows: [{ id: `ad_cplvl`, status: 'PENDING_REVIEW', effective_status: 'PENDING_REVIEW' }],
        truncated: false,
      })
      metaMocks.getCampaignStatusesBatch.mockResolvedValue({
        [fbCampaignId]: 'DISAPPROVED',
      })

      const result = await campaignService.syncAccountStatusJob('act_test_account')

      expect(metaMocks.getCampaignStatusesBatch).toHaveBeenCalledTimes(1)
      expect(metaMocks.getCampaignStatusesBatch).toHaveBeenCalledWith(
        'act_test_account',
        process.env.META_SYSTEM_USER_TOKEN,
        expect.arrayContaining([fbCampaignId])
      )
      const updated = await campaignRepo.findCampaignById(campaignId)
      expect(updated.status).toBe('failed')
      expect(updated.metaStatus).toBe('failed')
      expect(result.campaigns).toBeGreaterThan(0)
    })

    it('does not call campaign-level batch when no campaign needs a check', async () => {
      const { campaignId } = await seedRunningCampaign(client.id, { adSuffix: 'nocp' })
      metaMocks.listAccountAds.mockResolvedValue({
        rows: [{ id: `ad_nocp`, status: 'ACTIVE', effective_status: 'ACTIVE' }],
        truncated: false,
      })
      metaMocks.getCampaignStatusesBatch.mockClear()

      await campaignService.syncAccountStatusJob('act_test_account')

      expect(metaMocks.getCampaignStatusesBatch).not.toHaveBeenCalled()
      const updated = await campaignRepo.findCampaignById(campaignId)
      expect(updated.status).toBe('running')
    })
  })

  describe('account-level insights batch', () => {
    it('creates one batched report for all due campaigns and fans out rows', async () => {
      const first = await seedRunningCampaign(client.id, {
        adSuffix: 'ins1',
        scheduledAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      })
      const second = await seedRunningCampaign(client.id, { adSuffix: 'ins2' })

      metaMocks.createInsightsReport.mockResolvedValue({ report_run_id: 'run_batch_2' })
      const created = await campaignService.syncAccountInsightsJob('act_test_account')

      expect(created.success).toBe(true)
      expect(created.pending).toBe(true)
      expect(metaMocks.createInsightsReport).toHaveBeenCalledTimes(1)
      const [accountId, opts] = metaMocks.createInsightsReport.mock.calls[0]
      expect(accountId).toBe('act_test_account')
      expect(opts.filtering[0].value).toEqual(expect.arrayContaining([first.fbCampaignId, second.fbCampaignId]))

      const state = await campaignRepo.getMetaSyncState('insights:act_test_account')
      expect(state.reportRunId).toBe('run_batch_2')

      await campaignRepo.saveMetaSyncState('insights:act_test_account', {
        reportRunId: 'run_batch_2',
        nextPollAt: Date.now() - 1000,
      })

      metaMocks.getInsightsReport.mockResolvedValue({ async_status: 'Job Completed' })
      metaMocks.getInsightsReportData.mockResolvedValue([
        {
          campaign_id: first.fbCampaignId,
          date_start: '2026-07-01',
          impressions: '1000',
          clicks: '40',
          spend: '50.00',
        },
        {
          campaign_id: second.fbCampaignId,
          date_start: '2026-07-01',
          impressions: '2000',
          clicks: '80',
          spend: '70.00',
        },
      ])

      const completed = await campaignService.syncAccountInsightsJob('act_test_account')

      expect(completed.rows).toBe(2)
      expect(completed.campaigns).toBe(2)

      const firstStats = await campaignRepo.findDailyStats(first.campaignId)
      expect(firstStats).toHaveLength(1)
      expect(firstStats[0].spendPaise).toBe(5000)
      const secondStats = await campaignRepo.findDailyStats(second.campaignId)
      expect(secondStats).toHaveLength(1)
      expect(secondStats[0].impressions).toBe(2000)

      const firstAfter = await campaignRepo.findCampaignById(first.campaignId)
      expect(firstAfter.lastInsightsSyncAt).toBeTruthy()
      expect(firstAfter.insightsError).toBeNull()

      const stateAfter = await campaignRepo.getMetaSyncState('insights:act_test_account')
      expect(stateAfter).toBeNull()
    })

    it('throttles report polling to once per minute', async () => {
      await seedRunningCampaign(client.id, { adSuffix: 'poll' })
      metaMocks.createInsightsReport.mockResolvedValue({ report_run_id: 'run_poll_1' })
      metaMocks.getInsightsReport.mockClear()

      await campaignService.syncAccountInsightsJob('act_test_account')
      const callsBefore = metaMocks.getInsightsReport.mock.calls.length

      const throttled = await campaignService.syncAccountInsightsJob('act_test_account')

      expect(throttled.pending).toBe(true)
      expect(throttled.throttled).toBe(true)
      expect(metaMocks.getInsightsReport.mock.calls.length).toBe(callsBefore)
    })
  })

  describe('scheduler enqueueing', () => {
    it('enqueues account-level jobs instead of per-campaign jobs', async () => {
      await seedRunningCampaign(client.id, { adSuffix: 'sched1' })
      await query('DELETE FROM campaign_jobs')
      await query('DELETE FROM meta_sync_state')

      const result = await campaignService.scheduleCampaignSyncs()

      expect(result.statusEnqueued).toBe(1)
      expect(result.insightsEnqueued).toBe(1)

      const statusJob = await queryOne(
        `SELECT * FROM campaign_jobs WHERE job_type = 'sync_account_status' AND run_key = 'status:act_test_account'`,
        []
      )
      expect(statusJob).toBeTruthy()
      expect(statusJob.status).toBe('queued')

      const insightsJob = await queryOne(
        `SELECT * FROM campaign_jobs WHERE job_type = 'sync_account_insights' AND run_key = 'insights:act_test_account'`,
        []
      )
      expect(insightsJob).toBeTruthy()

      const perCampaign = await query(
        `SELECT id FROM campaign_jobs WHERE job_type = 'sync_status' AND run_key IS NULL`,
        []
      )
      expect(perCampaign).toHaveLength(0)

      const again = await campaignService.scheduleCampaignSyncs()
      expect(again.statusEnqueued).toBe(0)
      expect(again.insightsEnqueued).toBe(0)
    })

    it('skips enqueueing while soft-throttled but resumes after reset', async () => {
      resetRateLimitState()
      await seedRunningCampaign(client.id, { adSuffix: 'soft' })
      await query('DELETE FROM campaign_jobs')

      recordUsage({ 'x-app-usage': { used: { call_count: 0.6, total_cputime: 0.1 } } })
      expect(isSoftThrottled()).toBe(true)
      expect(isRateLimited()).toBe(false)

      const result = await campaignService.scheduleCampaignSyncs()
      expect(result.skipped).toBe(true)
      expect(result.reason).toBe('soft_throttled')

      resetRateLimitState()
      expect(isSoftThrottled()).toBe(false)
    })

    it('skips enqueueing while hard rate limited', async () => {
      resetRateLimitState()
      recordUsage({ 'x-app-usage': { used: { call_count: 0.9, total_cputime: 0.9 } } })
      expect(isRateLimited()).toBe(true)

      const result = await campaignService.scheduleCampaignSyncs()
      expect(result.skipped).toBe(true)
      expect(result.reason).toBe('rate_limited')

      resetRateLimitState()
    })
  })
})
