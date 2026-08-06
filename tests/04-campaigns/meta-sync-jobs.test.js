import { describe, it, expect, beforeAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'
import { query, queryOne } from '../../shared/database/connection.js'
import { CAMPAIGN_JOB_TYPES } from '../../src/modules/campaigns/campaign.model.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    getObjectStatus: vi.fn().mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' }),
    listAccountAds: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    createInsightsReport: vi.fn().mockResolvedValue({ report_run_id: 'run_abc' }),
    getInsightsReport: vi.fn().mockResolvedValue({ async_status: 'Job Running', data: [] }),
    getInsightsReportData: vi.fn().mockResolvedValue([]),
    getAdAccount: vi.fn().mockResolvedValue({ balance: '123.45', currency: 'INR', account_status: 1, disable_reason: null }),
  }
  metaMocks = mocks
  return mocks
})

const dateTag = Date.now()
let walletOnlyPlanId = null

async function assignWalletOnlyPlan(userId) {
  await subRepo.upsertUserSubscription(userId, walletOnlyPlanId, {
    status: 'active',
    billingCycle: 'monthly',
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  })
}

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

async function seedRunningCampaign(userId, { status = 'running', metaStatus = 'created', scheduledAt = null } = {}) {
  const campaign = await campaignService.createCampaign(userId, {
    name: `MetaSync ${generateUuid().substring(0, 8)}`,
    type: 'post',
    scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
  })
  await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'sync test', mediaUrl: 'https://example.com/x.jpg' })
  await campaignRepo.createMetaSettings(generateUuid(), campaign.id, {
    objective: 'OUTCOME_TRAFFIC',
    budgetType: 'lifetime',
    budgetAmount: 500,
    endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  })
  await campaignRepo.createMetaObject(campaign.id, 'facebook_campaign', `fb_camp_${generateUuid()}`, null, 'ACTIVE', userId)
  await campaignRepo.createMetaObject(campaign.id, 'ad_set', `adset_${generateUuid()}`, null, 'ACTIVE', userId)
  await campaignRepo.createMetaObject(campaign.id, 'ad_creative', `creative_${generateUuid()}`, null, 'ACTIVE', userId)
  await campaignRepo.createMetaObject(campaign.id, 'ad', `ad_${generateUuid()}`, null, 'ACTIVE', userId)
  await campaignRepo.updateCampaignStatus(campaign.id, status)
  if (metaStatus === 'paused') await campaignRepo.updateCampaign(campaign.id, { metaStatus: 'paused' })
  return campaign.id
}

async function seedCharge(campaignId, { chargedPaise, coins, walletShare = coins, monthlyShare = 0 } = {}) {
  await campaignRepo.updateCampaign(campaignId, { chargedAdBudgetPaise: chargedPaise })
  await campaignRepo.insertBillingEntry(campaignId, {
    kind: 'charge',
    paise: chargedPaise,
    coins,
    rate: 1,
    paidFromMonthly: monthlyShare,
    paidFromWallet: walletShare,
    reason: 'test charge',
  })
}

describe('campaign meta sync jobs', () => {
  let client

  beforeAll(async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'test_system_user_token'
    process.env.META_AD_ACCOUNT_ID = 'act_test_account'
    const plan = await subRepo.createPlan({
      name: 'Wallet Only',
      slug: `wallet-only-${dateTag}`,
      description: 'test plan with no monthly coin allowance',
      monthlyPrice: 0,
      yearlyPrice: 0,
    })
    walletOnlyPlanId = plan.id
    const monthlyCoinsFeature = await subRepo.findFeatureByKey('monthly_coins')
    await subRepo.upsertPlanFeature(walletOnlyPlanId, monthlyCoinsFeature.id, {
      isEnabled: true,
      valueType: 'integer',
      valueInt: 0,
    })
    client = await createTestUser({
      email: `meta-sync-${dateTag}@flowx-test.com`,
      password: 'Test@123',
      coins: 10000,
    })
    await ensurePlan(client.id)
    await query('DELETE FROM campaign_jobs')
    await query('DELETE FROM campaign_daily_stats')
    await query('DELETE FROM campaign_billing_entries')
  })

  describe('status sync job', () => {
    it('pauses a running campaign when Meta reports PAUSED', async () => {
      const campaignId = await seedRunningCampaign(client.id)
      metaMocks.getObjectStatus.mockResolvedValue({ status: 'PAUSED', effective_status: 'PAUSED' })

      const result = await campaignService.syncCampaignStatusJob(campaignId)

      expect(result.success).toBe(true)
      expect(result.result.statusAfter).toBe('paused')
      expect(result.result.statusChanged).toBe(true)
      const updated = await campaignRepo.findCampaignById(campaignId)
      expect(updated.status).toBe('paused')

      metaMocks.getObjectStatus.mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' })
    })

    it('resumes a paused campaign when Meta reports ACTIVE', async () => {
      const campaignId = await seedRunningCampaign(client.id, { status: 'paused' })
      metaMocks.getObjectStatus.mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' })

      const result = await campaignService.syncCampaignStatusJob(campaignId)

      expect(result.success).toBe(true)
      expect(result.result.statusAfter).toBe('running')
      const updated = await campaignRepo.findCampaignById(campaignId)
      expect(updated.status).toBe('running')
      expect(updated.metaStatus).toBe('active')
    })

    it('never decreases meta_spent_paise', async () => {
      const campaignId = await seedRunningCampaign(client.id)
      await campaignRepo.upsertDailyStat(campaignId, {
        statDate: '2026-07-01',
        impressions: 100,
        reach: 90,
        clicks: 5,
        ctr: 0.05,
        cpc: 1,
        cpm: 10,
        spendPaise: 5000,
        actions: {},
        costPerActionType: {},
      })

      const result = await campaignService.syncCampaignStatusJob(campaignId)

      expect(result.success).toBe(true)
      expect(result.result.spendUpdated).toBe(true)
      expect(result.result.metaSpendPaise).toBe(5000)
      const updated = await campaignRepo.findCampaignById(campaignId)
      expect(updated.metaSpentPaise).toBe(5000)

      await campaignRepo.upsertDailyStat(campaignId, {
        statDate: '2026-07-01',
        impressions: 100,
        reach: 90,
        clicks: 5,
        ctr: 0.05,
        cpc: 1,
        cpm: 10,
        spendPaise: 2000,
        actions: {},
        costPerActionType: {},
      })
      const regressed = await campaignService.syncCampaignStatusJob(campaignId)
      expect(regressed.result.spendUpdated).toBe(false)
      const after = await campaignRepo.findCampaignById(campaignId)
      expect(after.metaSpentPaise).toBe(5000)
    })

    it('touches last_meta_sync_at on every sync attempt', async () => {
      const campaignId = await seedRunningCampaign(client.id)
      await campaignService.syncCampaignStatusJob(campaignId)
      const updated = await campaignRepo.findCampaignById(campaignId)
      expect(updated.lastMetaSyncAt).toBeTruthy()
    })

    it('marks a campaign archived when the Meta object is deleted (manual settle)', async () => {
      const campaignId = await seedRunningCampaign(client.id)
      metaMocks.getObjectStatus.mockImplementation(() =>
        Promise.reject(new Error('Graph API GET 123 failed: {"error":{"code":100,"error_user_msg":"Campaign could not be found"}}'))
      )

      const result = await campaignService.syncCampaignStatusJob(campaignId)

      expect(result.success).toBe(true)
      expect(result.result.archived).toBe(true)
      const updated = await campaignRepo.findCampaignById(campaignId)
      expect(updated.metaStatus).toBe('archived')
      expect(updated.metaError).toContain('could not be found')
      expect(updated.lastMetaSyncAt).toBeTruthy()

      const settleJob = await queryOne(
        `SELECT * FROM campaign_jobs WHERE campaign_id = ? AND job_type = 'settle_campaign'`,
        [uuidToBuffer(campaignId)]
      )
      expect(settleJob).toBeFalsy()

      metaMocks.getObjectStatus.mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' })
    })

    it('treats 80004 as a rate limit, not an archive, and throws transient', async () => {
      const campaignId = await seedRunningCampaign(client.id)
      metaMocks.getObjectStatus.mockImplementation(() =>
        Promise.reject(new Error('Graph API GET 123 failed: {"error":{"code":80004,"error_user_msg":"There have been too many calls to this ad-account. Wait a bit and try again."}}'))
      )

      await expect(campaignService.syncCampaignStatusJob(campaignId)).rejects.toThrow()

      const updated = await campaignRepo.findCampaignById(campaignId)
      expect(updated.metaStatus).not.toBe('archived')
      expect(updated.metaError).toBeNull()
      expect(updated.lastMetaSyncAt).toBeTruthy()

      const settleJob = await queryOne(
        `SELECT * FROM campaign_jobs WHERE campaign_id = ? AND job_type = 'settle_campaign'`,
        [uuidToBuffer(campaignId)]
      )
      expect(settleJob).toBeFalsy()

      metaMocks.getObjectStatus.mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' })
    })

    it('excludes archived campaigns from the due queries but lets dead jobs be requeued', async () => {
      const archivedId = await seedRunningCampaign(client.id, { status: 'paused' })
      await campaignRepo.updateCampaign(archivedId, { metaStatus: 'archived' })

      const deadId = await seedRunningCampaign(client.id)
      await campaignRepo.enqueueCampaignJob(generateUuid(), deadId, 'sync_status')
      await query(
        `UPDATE campaign_jobs SET status = 'dead' WHERE campaign_id = ? AND job_type = 'sync_status'`,
        [uuidToBuffer(deadId)]
      )

      const due = await campaignRepo.findCampaignsDueForStatusSync({ stalenessSeconds: 0, limit: 50 })
      const dueIds = due.map(c => c.id)
      expect(dueIds).not.toContain(archivedId)
      expect(dueIds).toContain(deadId)
    })
  })

  describe('insights sync job', () => {
    it('creates a report then persists daily rows on completion', async () => {
      const campaignId = await seedRunningCampaign(client.id)
      metaMocks.createInsightsReport.mockResolvedValue({ report_run_id: 'run_test_1' })
      metaMocks.getInsightsReport.mockResolvedValue({ async_status: 'Job Running', data: [] })

      const created = await campaignService.syncCampaignInsightsJob(campaignId)
      expect(created.success).toBe(true)
      expect(created.pending).toBe(true)
      const afterCreate = await campaignRepo.findCampaignById(campaignId)
      expect(afterCreate.insightsError).toContain('report_running:run_test_1')

      metaMocks.getInsightsReport.mockResolvedValue({ async_status: 'Job Completed' })
      metaMocks.getInsightsReportData.mockResolvedValue([
        {
          date_start: '2026-07-01',
          impressions: '1000',
          reach: '900',
          frequency: '1.11',
          clicks: '50',
          unique_clicks: '40',
          ctr: '0.05',
          cpc: '2.00',
          cpm: '100.00',
          spend: '100.00',
          actions: [{ action_type: 'link_click', value: '50' }],
          cost_per_action_type: [{ action_type: 'link_click', value: '2.00' }],
        },
      ])

      const completed = await campaignService.syncCampaignInsightsJob(campaignId)
      expect(completed.rows).toBe(1)

      const afterDone = await campaignRepo.findCampaignById(campaignId)
      expect(afterDone.insightsError).toBeNull()
      expect(afterDone.lastInsightsSyncAt).toBeTruthy()

      const stats = await campaignRepo.findDailyStats(campaignId)
      expect(stats).toHaveLength(1)
      expect(stats[0].impressions).toBe(1000)
      expect(stats[0].spendPaise).toBe(10000)
      expect(stats[0].actions.link_click).toBe('50')
    })

    it('re-upserts the same date idempotently', async () => {
      const campaignId = await seedRunningCampaign(client.id)
      await campaignService.syncCampaignInsightsJob(campaignId)
      metaMocks.getInsightsReport.mockResolvedValue({ async_status: 'Job Completed' })
      metaMocks.getInsightsReportData.mockResolvedValue([
        {
          date_start: '2026-07-01',
          impressions: '1200',
          reach: '1000',
          clicks: '60',
          ctr: '0.05',
          cpc: '1.80',
          cpm: '90.00',
          spend: '120.00',
        },
      ])
      const second = await campaignService.syncCampaignInsightsJob(campaignId)
      expect(second.rows).toBe(1)
      const stats = await campaignRepo.findDailyStats(campaignId)
      expect(stats).toHaveLength(1)
      expect(stats[0].impressions).toBe(1200)
      expect(stats[0].spendPaise).toBe(12000)
    })

    it('schedules the report since the campaign scheduledAt date', async () => {
      const scheduledAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
      const campaignId = await seedRunningCampaign(client.id, { scheduledAt })
      metaMocks.createInsightsReport.mockResolvedValue({ report_run_id: 'run_since_1' })

      await campaignService.syncCampaignInsightsJob(campaignId)

      const expectedSince = scheduledAt.slice(0, 10)
      const fbIds = await campaignRepo.findFacebookCampaignObjectIds(campaignId)
      expect(metaMocks.createInsightsReport).toHaveBeenCalledWith(
        process.env.META_AD_ACCOUNT_ID,
        expect.objectContaining({ since: expectedSince, filtering: [{ field: 'campaign.id', operator: 'IN', value: fbIds }] })
      )
    })
  })

  describe('billing settlement', () => {
    it('refunds the unspent ad budget to the wallet on settle', async () => {
      const campaignId = await seedRunningCampaign(client.id)
      await seedCharge(campaignId, { chargedPaise: 10000, coins: 100, walletShare: 100 })
      await campaignRepo.upsertDailyStat(campaignId, {
        statDate: '2026-07-01',
        impressions: 100,
        reach: 90,
        clicks: 5,
        ctr: 0.05,
        cpc: 1,
        cpm: 10,
        spendPaise: 4000,
        actions: {},
        costPerActionType: {},
      })

      const walletBefore = await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(client.id)])
      const result = await campaignService.settleCampaignJob(campaignId)

      expect(result.success).toBe(true)
      expect(result.refundCoins).toBe(60)

      const entries = await campaignRepo.findBillingEntries(campaignId)
      const refund = entries.find(e => e.kind === 'refund')
      expect(refund).toBeTruthy()
      expect(refund.paise).toBe(6000)
      expect(refund.coins).toBe(60)

      const settled = await campaignRepo.findCampaignById(campaignId)
      expect(settled.settledAt).toBeTruthy()
      expect(settled.status).toBe('completed')

      const walletAfter = await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(client.id)])
      expect(Number(walletAfter.coins)).toBe(Number(walletBefore.coins) + 60)
    })

    it('deducts the overspend delta from the wallet', async () => {
      const overUser = await createTestUser({
        email: `meta-over-${Date.now()}@flowx-test.com`,
        password: 'Test@123',
        coins: 500,
      })
      await assignWalletOnlyPlan(overUser.id)
      const campaignId = await seedRunningCampaign(overUser.id)
      await seedCharge(campaignId, { chargedPaise: 10000, coins: 100, walletShare: 100 })
      await campaignRepo.upsertDailyStat(campaignId, {
        statDate: '2026-07-01',
        impressions: 100,
        reach: 90,
        clicks: 50,
        ctr: 0.5,
        cpc: 1,
        cpm: 10,
        spendPaise: 16000,
        actions: {},
        costPerActionType: {},
      })

      const walletBefore = await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(overUser.id)])
      const result = await campaignService.settleCampaignJob(campaignId)

      expect(result.success).toBe(true)
      expect(result.overspendCoins).toBe(60)

      const walletAfter = await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(overUser.id)])
      expect(Number(walletAfter.coins)).toBe(Number(walletBefore.coins) - 60)

      const entries = await campaignRepo.findBillingEntries(campaignId)
      expect(entries.some(e => e.kind === 'overspend')).toBe(true)
      const settled = await campaignRepo.findCampaignById(campaignId)
      expect(settled.settledAt).toBeTruthy()
    })

    it('holds the overspend when wallet balance is insufficient', async () => {
      const brokeUser = await createTestUser({
        email: `meta-broke-${Date.now()}@flowx-test.com`,
        password: 'Test@123',
        coins: 0,
      })
      await assignWalletOnlyPlan(brokeUser.id)
      const campaignId = await seedRunningCampaign(brokeUser.id)
      await seedCharge(campaignId, { chargedPaise: 10000, coins: 100, walletShare: 100 })
      await campaignRepo.upsertDailyStat(campaignId, {
        statDate: '2026-07-01',
        impressions: 100,
        reach: 90,
        clicks: 50,
        ctr: 0.5,
        cpc: 1,
        cpm: 10,
        spendPaise: 20000,
        actions: {},
        costPerActionType: {},
      })

      const result = await campaignService.settleCampaignJob(campaignId)

      expect(result.success).toBe(true)
      expect(result.held).toBe(true)

      const entries = await campaignRepo.findBillingEntries(campaignId)
      expect(entries.some(e => e.kind === 'overspend' && e.reason.includes('hold'))).toBe(true)
      const settled = await campaignRepo.findCampaignById(campaignId)
      expect(settled.settledAt).toBeNull()
    })

    it('early-returns when nothing was charged or already settled', async () => {
      const freeId = await seedRunningCampaign(client.id)
      const nothing = await campaignService.settleCampaignJob(freeId)
      expect(nothing.nothingCharged).toBe(true)

      const campaignId = await seedRunningCampaign(client.id)
      await seedCharge(campaignId, { chargedPaise: 10000, coins: 100, walletShare: 100 })
      await campaignRepo.markCampaignSettled(campaignId)
      const already = await campaignService.settleCampaignJob(campaignId)
      expect(already.alreadySettled).toBe(true)
    })
  })

  describe('read path + health', () => {
    it('serves insights from cached daily stats', async () => {
      const campaignId = await seedRunningCampaign(client.id)
      await campaignRepo.upsertDailyStat(campaignId, {
        statDate: '2026-07-01',
        impressions: 500,
        reach: 400,
        clicks: 25,
        ctr: 0.05,
        cpc: 2,
        cpm: 40,
        spendPaise: 8000,
        actions: { link_click: '25' },
        costPerActionType: {},
      })

      const insights = await campaignService.getCampaignInsights(client.id, campaignId, {})
      expect(insights.cached).toBe(true)
      expect(insights.rows).toHaveLength(1)
      expect(insights.totalSpendPaise).toBe(8000)
    })

    it('enqueues an async insights refresh when requested', async () => {
      const campaignId = await seedRunningCampaign(client.id)

      const result = await campaignService.getCampaignInsights(client.id, campaignId, { refresh: true })

      expect(result.queued).toBe(true)
      const job = await queryOne(
        `SELECT id FROM campaign_jobs WHERE campaign_id = ? AND job_type = 'sync_insights' AND status = 'queued'`,
        [uuidToBuffer(campaignId)]
      )
      expect(job).toBeTruthy()
    })

    it('returns a structured sync health summary', async () => {
      const health = await campaignService.getMetaSyncHealth()
      expect(health).toHaveProperty('runningCount')
      expect(health).toHaveProperty('staleCampaigns')
      expect(Array.isArray(health.staleCampaigns)).toBe(true)
      expect(health).toHaveProperty('failedJobs')
      expect(health).toHaveProperty('unsettledCount')
      expect(health).toHaveProperty('rateLimit')
    })

    it('force-sync enqueues status and insights jobs', async () => {
      const campaignId = await seedRunningCampaign(client.id)
      const result = await campaignService.forceSyncCampaign(campaignId)
      expect(result.queued).toBe(true)
      const statusJob = await queryOne(
        `SELECT id FROM campaign_jobs WHERE campaign_id = ? AND job_type = 'sync_status' AND status = 'queued'`,
        [uuidToBuffer(campaignId)]
      )
      expect(statusJob).toBeTruthy()
    })
  })
})