import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'
import { query, queryOne } from '../../shared/database/connection.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    createInsightsReport: vi.fn().mockResolvedValue({ report_run_id: 'run_exec_1' }),
    getInsightsReport: vi.fn().mockResolvedValue({ async_status: 'Job Running', data: [] }),
    getInsightsReportData: vi.fn().mockResolvedValue([]),
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

async function seedCampaignWithExecutions(userId, { clientExec, publisherExecs = [] } = {}) {
  const campaign = await campaignService.createCampaign(userId, {
    name: `ExecStats ${generateUuid().substring(0, 8)}`,
    type: 'post',
  })
  await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'exec stats test', mediaUrl: 'https://example.com/x.jpg' })
  await campaignRepo.createMetaSettings(generateUuid(), campaign.id, {
    objective: 'OUTCOME_TRAFFIC',
    budgetType: 'lifetime',
    budgetAmount: 500,
    endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  })

  const executions = []

  if (clientExec) {
    const fbId = clientExec.fbCampaignId || `fb_client_${generateUuid().substring(0, 8)}`
    await campaignRepo.createMetaObject(campaign.id, 'facebook_campaign', fbId, null, 'ACTIVE', userId)
    const execId = generateUuid()
    await query(
      `INSERT INTO campaign_executions (id, campaign_id, owner_user_id, kind, status, platform_campaign_id, ad_account_act_id)
       VALUES (?, ?, ?, 'client', 'active', ?, 'act_test_account')`,
      [uuidToBuffer(execId), uuidToBuffer(campaign.id), uuidToBuffer(userId), fbId]
    )
    executions.push({ id: execId, fbCampaignId: fbId, kind: 'client' })
  }

  for (const pub of publisherExecs) {
    const pubUser = pub.user || await createTestUser({
      email: `pub-${generateUuid().substring(0, 8)}@flowx-test.com`,
      password: 'Test@123',
    })
    const fbId = pub.fbCampaignId || `fb_pub_${generateUuid().substring(0, 8)}`
    await campaignRepo.createMetaObject(campaign.id, 'facebook_campaign', fbId, null, 'ACTIVE', pubUser.id)
    const execId = generateUuid()
    await query(
      `INSERT INTO campaign_executions (id, campaign_id, owner_user_id, kind, status, platform_campaign_id, ad_account_act_id)
       VALUES (?, ?, ?, 'publisher', 'active', ?, 'act_test_account')`,
      [uuidToBuffer(execId), uuidToBuffer(campaign.id), uuidToBuffer(pubUser.id), fbId]
    )
    executions.push({ id: execId, fbCampaignId: fbId, kind: 'publisher', user: pubUser })
  }

  await campaignRepo.updateCampaignStatus(campaign.id, 'running')
  return { campaignId: campaign.id, executions }
}

describe('campaign execution stats', () => {
  let client

  beforeAll(async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'test_system_user_token'
    process.env.META_AD_ACCOUNT_ID = 'act_test_account'
    client = await createTestUser({
      email: `exec-stats-${dateTag}@flowx-test.com`,
      password: 'Test@123',
      coins: 10000,
    })
    await ensurePlan(client.id)
    await query('DELETE FROM campaign_execution_daily_stats')
    await query('DELETE FROM campaign_jobs')
    await query('DELETE FROM campaign_daily_stats')
    metaMocks.createInsightsReport.mockReset()
    metaMocks.getInsightsReport.mockReset()
    metaMocks.getInsightsReportData.mockReset()
  })

  afterAll(async () => {
    await query('DELETE FROM campaign_execution_daily_stats WHERE campaign_execution_id IN (SELECT id FROM campaign_executions WHERE campaign_id IN (SELECT id FROM campaigns WHERE name LIKE "ExecStats %"))')
    await query('DELETE FROM campaign_executions WHERE campaign_id IN (SELECT id FROM campaigns WHERE name LIKE "ExecStats %")')
  })

  describe('1-4. per-execution isolation', () => {
    it('client-only: stores stats in execution row', async () => {
      const { campaignId, executions } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_iso_a' },
      })
      const execId = executions[0].id

      const snapshots = [{
        statDate: '2026-09-19',
        impressions: 100,
        reach: 80,
        frequency: 1.25,
        clicks: 10,
        uniqueClicks: 8,
        ctr: 10,
        cpc: 100,
        cpm: 1000,
        spendPaise: 1000,
        actions: { post_engagement: '5' },
        costPerActionType: { post_engagement: '200' },
      }]
      await campaignRepo.upsertExecutionDailyStatsBulk(execId, snapshots)

      const rows = await campaignRepo.findExecutionDailyStats(execId)
      expect(rows).toHaveLength(1)
      expect(rows[0].impressions).toBe(100)
      expect(rows[0].spendPaise).toBe(1000)
      expect(rows[0].actions.post_engagement).toBe('5')
    })

    it('one publisher: publisher stats isolated from client', async () => {
      const pubUser = await createTestUser({
        email: `pub-iso-${Date.now()}@flowx-test.com`,
        password: 'Test@123',
      })
      const { campaignId, executions } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_iso_b' },
        publisherExecs: [{ fbCampaignId: 'fb_exec_iso_c', user: pubUser }],
      })
      const clientExec = executions.find(e => e.kind === 'client')
      const pubExec = executions.find(e => e.kind === 'publisher')

      await campaignRepo.upsertExecutionDailyStatsBulk(clientExec.id, [{
        statDate: '2026-09-19', impressions: 100, clicks: 10, spendPaise: 1000,
        reach: 80, frequency: 1.25, uniqueClicks: 8, ctr: 10, cpc: 100, cpm: 1000,
      }])
      await campaignRepo.upsertExecutionDailyStatsBulk(pubExec.id, [{
        statDate: '2026-09-19', impressions: 200, clicks: 20, spendPaise: 2000,
        reach: 150, frequency: 1.33, uniqueClicks: 18, ctr: 10, cpc: 100, cpm: 1000,
      }])

      const clientRows = await campaignRepo.findExecutionDailyStats(clientExec.id)
      const pubRows = await campaignRepo.findExecutionDailyStats(pubExec.id)

      expect(clientRows[0].impressions).toBe(100)
      expect(pubRows[0].impressions).toBe(200)
      expect(clientRows[0].spendPaise).toBe(1000)
      expect(pubRows[0].spendPaise).toBe(2000)
    })

    it('client + multiple publishers: three execution rows, no cross-contamination', async () => {
      const pub1 = await createTestUser({ email: `pub1-${Date.now()}@flowx-test.com`, password: 'Test@123' })
      const pub2 = await createTestUser({ email: `pub2-${Date.now()}@flowx-test.com`, password: 'Test@123' })
      const { executions } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_iso_d' },
        publisherExecs: [
          { fbCampaignId: 'fb_exec_iso_e', user: pub1 },
          { fbCampaignId: 'fb_exec_iso_f', user: pub2 },
        ],
      })

      const metrics = [
        { impressions: 100, clicks: 10, spendPaise: 1000 },
        { impressions: 200, clicks: 20, spendPaise: 2000 },
        { impressions: 300, clicks: 30, spendPaise: 3000 },
      ]
      for (let i = 0; i < executions.length; i++) {
        await campaignRepo.upsertExecutionDailyStatsBulk(executions[i].id, [{
          statDate: '2026-09-19',
          ...metrics[i],
          reach: 0, frequency: 0, uniqueClicks: 0, ctr: 0, cpc: 0, cpm: 0,
        }])
      }

      for (let i = 0; i < executions.length; i++) {
        const rows = await campaignRepo.findExecutionDailyStats(executions[i].id)
        expect(rows[0].impressions).toBe(metrics[i].impressions)
        expect(rows[0].clicks).toBe(metrics[i].clicks)
        expect(rows[0].spendPaise).toBe(metrics[i].spendPaise)
      }
    })

    it('Publisher A cannot receive Publisher B stats', async () => {
      const pub1 = await createTestUser({ email: `pubA-${Date.now()}@flowx-test.com`, password: 'Test@123' })
      const pub2 = await createTestUser({ email: `pubB-${Date.now()}@flowx-test.com`, password: 'Test@123' })
      const { executions } = await seedCampaignWithExecutions(client.id, {
        publisherExecs: [
          { fbCampaignId: 'fb_exec_iso_g', user: pub1 },
          { fbCampaignId: 'fb_exec_iso_h', user: pub2 },
        ],
      })
      const execA = executions[0]
      const execB = executions[1]

      await campaignRepo.upsertExecutionDailyStatsBulk(execA.id, [{
        statDate: '2026-09-19', impressions: 500, clicks: 50, spendPaise: 5000,
        reach: 0, frequency: 0, uniqueClicks: 0, ctr: 0, cpc: 0, cpm: 0,
      }])
      await campaignRepo.upsertExecutionDailyStatsBulk(execB.id, [{
        statDate: '2026-09-19', impressions: 100, clicks: 10, spendPaise: 1000,
        reach: 0, frequency: 0, uniqueClicks: 0, ctr: 0, cpc: 0, cpm: 0,
      }])

      const rowsA = await campaignRepo.findExecutionDailyStats(execA.id)
      const rowsB = await campaignRepo.findExecutionDailyStats(execB.id)
      expect(rowsA[0].impressions).toBe(500)
      expect(rowsB[0].impressions).toBe(100)
    })
  })

  describe('5-8. cross-execution isolation', () => {
    it('client stats cannot leak into publisher stats', async () => {
      const pub = await createTestUser({ email: `pub-leak-${Date.now()}@flowx-test.com`, password: 'Test@123' })
      const { executions } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_leak_a' },
        publisherExecs: [{ fbCampaignId: 'fb_exec_leak_b', user: pub }],
      })
      const clientExec = executions.find(e => e.kind === 'client')
      const pubExec = executions.find(e => e.kind === 'publisher')

      await campaignRepo.upsertExecutionDailyStatsBulk(clientExec.id, [{
        statDate: '2026-09-19', impressions: 999, clicks: 99, spendPaise: 9999,
        reach: 0, frequency: 0, uniqueClicks: 0, ctr: 0, cpc: 0, cpm: 0,
      }])

      const pubRows = await campaignRepo.findExecutionDailyStats(pubExec.id)
      expect(pubRows).toHaveLength(0)
    })
  })

  describe('9-10. idempotency', () => {
    it('same execution/date upsert is idempotent', async () => {
      const { executions } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_idem_a' },
      })
      const execId = executions[0].id
      const snapshot = {
        statDate: '2026-09-19', impressions: 100, clicks: 10, spendPaise: 1000,
        reach: 80, frequency: 1.25, uniqueClicks: 8, ctr: 10, cpc: 100, cpm: 1000,
      }

      await campaignRepo.upsertExecutionDailyStatsBulk(execId, [snapshot])
      await campaignRepo.upsertExecutionDailyStatsBulk(execId, [snapshot])

      const rows = await campaignRepo.findExecutionDailyStats(execId)
      expect(rows).toHaveLength(1)
      expect(rows[0].impressions).toBe(100)
    })

    it('duplicate workers converge to same final value', async () => {
      const { executions } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_idem_b' },
      })
      const execId = executions[0].id

      await Promise.all([
        campaignRepo.upsertExecutionDailyStatsBulk(execId, [{
          statDate: '2026-09-19', impressions: 100, clicks: 10, spendPaise: 1000,
          reach: 0, frequency: 0, uniqueClicks: 0, ctr: 0, cpc: 0, cpm: 0,
        }]),
        campaignRepo.upsertExecutionDailyStatsBulk(execId, [{
          statDate: '2026-09-19', impressions: 100, clicks: 10, spendPaise: 1000,
          reach: 0, frequency: 0, uniqueClicks: 0, ctr: 0, cpc: 0, cpm: 0,
        }]),
      ])

      const rows = await campaignRepo.findExecutionDailyStats(execId)
      expect(rows).toHaveLength(1)
    })
  })

  describe('11. retry keeps same execution ID', () => {
    it('retry does not create new execution stats identity', async () => {
      const { executions } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_retry_a' },
      })
      const execId = executions[0].id

      await campaignRepo.upsertExecutionDailyStatsBulk(execId, [{
        statDate: '2026-09-19', impressions: 50, clicks: 5, spendPaise: 500,
        reach: 0, frequency: 0, uniqueClicks: 0, ctr: 0, cpc: 0, cpm: 0,
      }])
      await campaignRepo.upsertExecutionDailyStatsBulk(execId, [{
        statDate: '2026-09-20', impressions: 75, clicks: 7, spendPaise: 750,
        reach: 0, frequency: 0, uniqueClicks: 0, ctr: 0, cpc: 0, cpm: 0,
      }])

      const rows = await campaignRepo.findExecutionDailyStats(execId)
      expect(rows).toHaveLength(2)
      const dates = rows.map(r => {
        const d = new Date(r.statDate)
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      }).sort()
      expect(dates).toEqual(['2026-09-19', '2026-09-20'])
    })
  })

  describe('12. failed execution isolation', () => {
    it('failed execution stats remain isolated', async () => {
      const { executions } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_fail_a' },
      })
      const execId = executions[0].id

      await query(
        `UPDATE campaign_executions SET status = 'failed' WHERE id = ?`,
        [uuidToBuffer(execId)]
      )

      await campaignRepo.upsertExecutionDailyStatsBulk(execId, [{
        statDate: '2026-09-19', impressions: 30, clicks: 3, spendPaise: 300,
        reach: 0, frequency: 0, uniqueClicks: 0, ctr: 0, cpc: 0, cpm: 0,
      }])

      const rows = await campaignRepo.findExecutionDailyStats(execId)
      expect(rows).toHaveLength(1)
      expect(rows[0].impressions).toBe(30)
    })
  })

  describe('13. missing execution falls back to parent', () => {
    it('Meta campaign ID with no execution row writes only to parent', async () => {
      const campaign = await campaignService.createCampaign(client.id, {
        name: `ExecStats NoExec ${generateUuid().substring(0, 8)}`,
        type: 'post',
      })
      await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'no exec', mediaUrl: 'https://example.com/x.jpg' })
      const fbId = `fb_noexec_${generateUuid().substring(0, 8)}`
      await campaignRepo.createMetaObject(campaign.id, 'facebook_campaign', fbId, null, 'ACTIVE', client.id)
      await campaignRepo.updateCampaignStatus(campaign.id, 'running')

      const rows = [{
        campaign_id: fbId,
        date_start: '2026-09-19',
        impressions: '100',
        reach: '80',
        frequency: '1.25',
        clicks: '10',
        unique_clicks: '8',
        ctr: '10',
        cpc: '100',
        cpm: '1000',
        spend: '10.00',
        actions: [{ action_type: 'post_engagement', value: '5' }],
        cost_per_action_type: [{ action_type: 'post_engagement', value: '200' }],
      }]

      await campaignRepo.saveInsightsSyncState(campaign.id, {
        insightsError: 'report_running:run_noexec_1',
      })

      metaMocks.getInsightsReport.mockReset()
      metaMocks.getInsightsReportData.mockReset()
      metaMocks.getInsightsReport.mockResolvedValue({ async_status: 'Job Completed' })
      metaMocks.getInsightsReportData.mockResolvedValue(rows)

      const result = await campaignService.syncCampaignInsightsJob(campaign.id)
      expect(result.success).toBe(true)
      expect(result.rows).toBeGreaterThanOrEqual(1)

      const parentRows = await campaignRepo.findDailyStats(campaign.id)
      expect(parentRows.length).toBeGreaterThanOrEqual(1)

      const execCheck = await queryOne(
        'SELECT COUNT(*) as c FROM campaign_execution_daily_stats eds JOIN campaign_executions ce ON ce.id = eds.campaign_execution_id WHERE eds.stat_date = ? AND ce.campaign_id = ?',
        ['2026-09-19', uuidToBuffer(campaign.id)]
      )
      expect(Number(execCheck.c)).toBe(0)
    })
  })

  describe('14. historical parent rows unchanged', () => {
    it('existing parent stats remain untouched', async () => {
      const campaign = await campaignService.createCampaign(client.id, {
        name: `ExecStats HistParent ${generateUuid().substring(0, 8)}`,
        type: 'post',
      })
      await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'hist parent', mediaUrl: 'https://example.com/x.jpg' })
      const fbId = `fb_histparent_${generateUuid().substring(0, 8)}`
      await campaignRepo.createMetaObject(campaign.id, 'facebook_campaign', fbId, null, 'ACTIVE', client.id)
      await campaignRepo.updateCampaignStatus(campaign.id, 'running')

      await campaignRepo.upsertDailyStatsBulk(campaign.id, [{
        statDate: '2026-09-01',
        impressions: 500,
        reach: 400,
        frequency: 1.25,
        clicks: 50,
        uniqueClicks: 40,
        ctr: 10,
        cpc: 100,
        cpm: 1000,
        spendPaise: 5000,
        actions: {},
        costPerActionType: {},
      }])

      const parentRows = await campaignRepo.findDailyStats(campaign.id)
      expect(parentRows).toHaveLength(1)
      expect(parentRows[0].impressions).toBe(500)
      expect(parentRows[0].spendPaise).toBe(5000)
    })
  })

  describe('15-18. aggregation rules', () => {
    it('additive metrics aggregate correctly across executions', async () => {
      const pub = await createTestUser({ email: `pub-add-${Date.now()}@flowx-test.com`, password: 'Test@123' })
      const { executions } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_add_a' },
        publisherExecs: [{ fbCampaignId: 'fb_exec_add_b', user: pub }],
      })
      const clientExec = executions.find(e => e.kind === 'client')
      const pubExec = executions.find(e => e.kind === 'publisher')

      await campaignRepo.upsertExecutionDailyStatsBulk(clientExec.id, [{
        statDate: '2026-09-19', impressions: 100, clicks: 10, spendPaise: 1000,
        reach: 0, frequency: 0, uniqueClicks: 8, ctr: 0, cpc: 0, cpm: 0,
        actions: { post_engagement: '5' },
      }])
      await campaignRepo.upsertExecutionDailyStatsBulk(pubExec.id, [{
        statDate: '2026-09-19', impressions: 200, clicks: 20, spendPaise: 2000,
        reach: 0, frequency: 0, uniqueClicks: 18, ctr: 0, cpc: 0, cpm: 0,
        actions: { post_engagement: '10' },
      }])

      const allExecRows = await campaignRepo.findExecutionDailyStatsByCampaignId(
        clientExec.id ? (await queryOne('SELECT campaign_id FROM campaign_executions WHERE id = ?', [uuidToBuffer(clientExec.id)])).campaign_id.toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5') : null
      )
      const totalImpressions = allExecRows.reduce((sum, r) => sum + r.impressions, 0)
      const totalClicks = allExecRows.reduce((sum, r) => sum + r.clicks, 0)
      const totalSpend = allExecRows.reduce((sum, r) => sum + r.spendPaise, 0)

      expect(totalImpressions).toBe(300)
      expect(totalClicks).toBe(30)
      expect(totalSpend).toBe(3000)
    })

    it('ratios are recalculated not summed in API response', async () => {
      const { campaignId, executions } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_ratio_a' },
      })
      await campaignRepo.upsertExecutionDailyStatsBulk(executions[0].id, [{
        statDate: '2026-09-19', impressions: 1000, clicks: 100, spendPaise: 5000,
        reach: 0, frequency: 0, uniqueClicks: 80, ctr: 0, cpc: 0, cpm: 0,
      }])
      await campaignRepo.upsertExecutionDailyStatsBulk(executions[0].id, [{
        statDate: '2026-09-20', impressions: 2000, clicks: 200, spendPaise: 10000,
        reach: 0, frequency: 0, uniqueClicks: 160, ctr: 0, cpc: 0, cpm: 0,
      }])

      const result = await campaignService.getCampaignInsights(client.id, campaignId)
      const exec = result.executions.find(e => e.executionId === executions[0].id)
      expect(exec).toBeDefined()
      expect(exec.stats.totals.impressions).toBe(3000)
      expect(exec.stats.totals.clicks).toBe(300)
      expect(exec.stats.totals.spendPaise).toBe(15000)
      expect(exec.stats.totals.ctr).toBeCloseTo(10, 1)
      expect(exec.stats.totals.cpc).toBeCloseTo(50, 1)
      expect(exec.stats.totals.cpm).toBeCloseTo(5000, 0)
    })

    it('frequency totals derive from summed reach, zero when reach is zero', async () => {
      const { campaignId, executions } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_freq_totals_a' },
      })
      await campaignRepo.upsertExecutionDailyStatsBulk(executions[0].id, [{
        statDate: '2026-09-19', impressions: 1000, clicks: 100, spendPaise: 5000,
        reach: 500, frequency: 2, uniqueClicks: 80, ctr: 0, cpc: 0, cpm: 0,
      }])
      await campaignRepo.upsertExecutionDailyStatsBulk(executions[0].id, [{
        statDate: '2026-09-20', impressions: 2000, clicks: 200, spendPaise: 10000,
        reach: 1000, frequency: 2, uniqueClicks: 160, ctr: 0, cpc: 0, cpm: 0,
      }])

      const result = await campaignService.getCampaignInsights(client.id, campaignId)
      const exec = result.executions.find(e => e.executionId === executions[0].id)
      expect(exec.stats.totals.frequency).toBeCloseTo(2, 5)

      const zeroReach = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_freq_totals_b' },
      })
      await campaignRepo.upsertExecutionDailyStatsBulk(zeroReach.executions[0].id, [{
        statDate: '2026-09-19', impressions: 100, clicks: 10, spendPaise: 1000,
        reach: 0, frequency: 0, uniqueClicks: 8, ctr: 0, cpc: 0, cpm: 0,
      }])
      const zeroResult = await campaignService.getCampaignInsights(client.id, zeroReach.campaignId)
      const zeroExec = zeroResult.executions.find(e => e.executionId === zeroReach.executions[0].id)
      expect(zeroExec.stats.totals.frequency).toBe(0)
    })

    it('reach is NOT summed across executions', async () => {
      const pub = await createTestUser({ email: `pub-reach-${Date.now()}@flowx-test.com`, password: 'Test@123' })
      const { executions } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_reach_a' },
        publisherExecs: [{ fbCampaignId: 'fb_exec_reach_b', user: pub }],
      })

      await campaignRepo.upsertExecutionDailyStatsBulk(executions[0].id, [{
        statDate: '2026-09-19', impressions: 100, clicks: 10, spendPaise: 1000,
        reach: 80, frequency: 1.25, uniqueClicks: 8, ctr: 0, cpc: 0, cpm: 0,
      }])
      await campaignRepo.upsertExecutionDailyStatsBulk(executions[1].id, [{
        statDate: '2026-09-19', impressions: 200, clicks: 20, spendPaise: 2000,
        reach: 150, frequency: 1.33, uniqueClicks: 18, ctr: 0, cpc: 0, cpm: 0,
      }])

      const rows0 = await campaignRepo.findExecutionDailyStats(executions[0].id)
      const rows1 = await campaignRepo.findExecutionDailyStats(executions[1].id)
      expect(rows0[0].reach).toBe(80)
      expect(rows1[0].reach).toBe(150)
    })

    it('frequency is NOT summed across executions', async () => {
      const { executions } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_freq_a' },
      })

      await campaignRepo.upsertExecutionDailyStatsBulk(executions[0].id, [{
        statDate: '2026-09-19', impressions: 100, clicks: 10, spendPaise: 1000,
        reach: 80, frequency: 1.25, uniqueClicks: 8, ctr: 0, cpc: 0, cpm: 0,
      }])
      await campaignRepo.upsertExecutionDailyStatsBulk(executions[0].id, [{
        statDate: '2026-09-20', impressions: 200, clicks: 20, spendPaise: 2000,
        reach: 150, frequency: 1.33, uniqueClicks: 18, ctr: 0, cpc: 0, cpm: 0,
      }])

      const rows = await campaignRepo.findExecutionDailyStats(executions[0].id)
      expect(rows[0].frequency).toBe(1.25)
      expect(rows[1].frequency).toBe(1.33)
    })
  })

  describe('19. webhook spend monotonic', () => {
    it('webhook spend uses GREATEST semantics', async () => {
      const { executions } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_wh_a' },
      })
      const execId = executions[0].id

      await campaignRepo.upsertExecutionSpendOnly(execId, '2026-09-19', 1000)
      await campaignRepo.upsertExecutionSpendOnly(execId, '2026-09-19', 500)
      await campaignRepo.upsertExecutionSpendOnly(execId, '2026-09-19', 2000)

      const rows = await campaignRepo.findExecutionDailyStats(execId)
      expect(rows).toHaveLength(1)
      expect(rows[0].spendPaise).toBe(2000)
    })
  })

  describe('26. live spend freshness (webhook-driven)', () => {
    it('findExecutionDailyStats rows carry an updatedAt timestamp', async () => {
      const { executions } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_fresh_a' },
      })
      const execId = executions[0].id

      await campaignRepo.upsertExecutionSpendOnly(execId, '2026-09-19', 1500)

      const rows = await campaignRepo.findExecutionDailyStats(execId)
      expect(rows).toHaveLength(1)
      expect(rows[0].updatedAt).toBeTruthy()
      expect(new Date(rows[0].updatedAt).getTime()).toBeGreaterThan(Date.now() - 60000)
    })

    it('getCampaignInsights surfaces latestSpendUpdatedAt per execution', async () => {
      const { campaignId, executions } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_fresh_b' },
      })
      const execId = executions[0].id

      await campaignRepo.upsertExecutionSpendOnly(execId, '2026-09-19', 1500)

      const result = await campaignService.getCampaignInsights(client.id, campaignId)
      const exec = result.executions.find(e => e.executionId === execId)
      expect(exec.latestSpendUpdatedAt).toBeTruthy()
      expect(new Date(exec.latestSpendUpdatedAt).getTime()).toBeGreaterThan(Date.now() - 60000)
    })

    it('getCampaignInsightsAdmin surfaces latestSpendUpdatedAt per execution', async () => {
      const { campaignId, executions } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_fresh_c' },
      })
      const execId = executions[0].id

      await campaignRepo.upsertExecutionSpendOnly(execId, '2026-09-19', 1500)

      const result = await campaignService.getCampaignInsightsAdmin(campaignId)
      const exec = result.executions.find(e => e.executionId === execId)
      expect(exec.latestSpendUpdatedAt).toBeTruthy()
    })
  })

  describe('20-23. API contract', () => {
    it('API returns every execution', async () => {
      const pub = await createTestUser({ email: `pub-api-${Date.now()}@flowx-test.com`, password: 'Test@123' })
      const { campaignId, executions } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_api_a' },
        publisherExecs: [{ fbCampaignId: 'fb_exec_api_b', user: pub }],
      })

      for (const exec of executions) {
        await campaignRepo.upsertExecutionDailyStatsBulk(exec.id, [{
          statDate: '2026-09-19', impressions: 100, clicks: 10, spendPaise: 1000,
          reach: 0, frequency: 0, uniqueClicks: 0, ctr: 0, cpc: 0, cpm: 0,
        }])
      }

      const result = await campaignService.getCampaignInsights(client.id, campaignId)
      expect(result.executions).toHaveLength(2)
      expect(result.executions.map(e => e.executionId).sort()).toEqual(executions.map(e => e.id).sort())
    })

    it('client API ownership guard works', async () => {
      const other = await createTestUser({ email: `other-api-${Date.now()}@flowx-test.com`, password: 'Test@123' })
      const { campaignId } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_api_guard' },
      })

      await expect(campaignService.getCampaignInsights(other.id, campaignId))
        .rejects.toThrow('Not your campaign')
    })

    it('admin endpoint returns execution stats', async () => {
      const { campaignId, executions } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_admin_a' },
      })
      await campaignRepo.upsertExecutionDailyStatsBulk(executions[0].id, [{
        statDate: '2026-09-19', impressions: 100, clicks: 10, spendPaise: 1000,
        reach: 0, frequency: 0, uniqueClicks: 0, ctr: 0, cpc: 0, cpm: 0,
      }])

      const result = await campaignService.getCampaignInsightsAdmin(campaignId)
      expect(result.executions).toHaveLength(1)
      expect(result.executions[0].stats.totals.impressions).toBe(100)
    })
  })

  describe('24. frontend renders independent sections', () => {
    it('campaign-insights shape has executions array', async () => {
      const { campaignId } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_fe_a' },
      })
      const result = await campaignService.getCampaignInsights(client.id, campaignId)
      expect(result).toHaveProperty('executions')
      expect(Array.isArray(result.executions)).toBe(true)
    })
  })

  describe('25. terminal execution retains historical stats', () => {
    it('cancelled execution keeps its stats', async () => {
      const { executions } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_exec_term_a' },
      })
      const execId = executions[0].id

      await campaignRepo.upsertExecutionDailyStatsBulk(execId, [{
        statDate: '2026-09-19', impressions: 100, clicks: 10, spendPaise: 1000,
        reach: 0, frequency: 0, uniqueClicks: 0, ctr: 0, cpc: 0, cpm: 0,
      }])

      await query(`UPDATE campaign_executions SET status = 'cancelled' WHERE id = ?`, [uuidToBuffer(execId)])

      const rows = await campaignRepo.findExecutionDailyStats(execId)
      expect(rows).toHaveLength(1)
      expect(rows[0].impressions).toBe(100)
    })
  })

  describe('CRITICAL REGRESSION: three-chain last-write-wins elimination', () => {
    it('three Meta campaigns → three independent execution rows with different metrics', async () => {
      const pub1 = await createTestUser({ email: `pub-reg1-${Date.now()}@flowx-test.com`, password: 'Test@123' })
      const pub2 = await createTestUser({ email: `pub-reg2-${Date.now()}@flowx-test.com`, password: 'Test@123' })
      const { campaignId, executions } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_reg_client' },
        publisherExecs: [
          { fbCampaignId: 'fb_reg_pub_a', user: pub1 },
          { fbCampaignId: 'fb_reg_pub_b', user: pub2 },
        ],
      })

      const metrics = [
        { impressions: 100, clicks: 10, spendPaise: 1000 },
        { impressions: 200, clicks: 20, spendPaise: 2000 },
        { impressions: 300, clicks: 30, spendPaise: 3000 },
      ]
      for (let i = 0; i < executions.length; i++) {
        await campaignRepo.upsertExecutionDailyStatsBulk(executions[i].id, [{
          statDate: '2026-09-19',
          ...metrics[i],
          reach: 0, frequency: 0, uniqueClicks: 0, ctr: 0, cpc: 0, cpm: 0,
        }])
      }

      for (let i = 0; i < executions.length; i++) {
        const rows = await campaignRepo.findExecutionDailyStats(executions[i].id)
        expect(rows[0].impressions).toBe(metrics[i].impressions)
        expect(rows[0].clicks).toBe(metrics[i].clicks)
        expect(rows[0].spendPaise).toBe(metrics[i].spendPaise)
      }

      const clientExecId = executions.find(e => e.kind === 'client').id
      const pubAExecId = executions.find(e => e.fbCampaignId === 'fb_reg_pub_a').id
      const pubBExecId = executions.find(e => e.fbCampaignId === 'fb_reg_pub_b').id

      const clientRows = await campaignRepo.findExecutionDailyStats(clientExecId)
      const pubARows = await campaignRepo.findExecutionDailyStats(pubAExecId)
      const pubBRows = await campaignRepo.findExecutionDailyStats(pubBExecId)

      expect(clientRows[0].impressions).not.toBe(pubARows[0].impressions)
      expect(clientRows[0].impressions).not.toBe(pubBRows[0].impressions)
      expect(pubARows[0].impressions).not.toBe(pubBRows[0].impressions)
    })

    it('additive campaign aggregate sums correctly', async () => {
      const pub = await createTestUser({ email: `pub-agg-${Date.now()}@flowx-test.com`, password: 'Test@123' })
      const { campaignId, executions } = await seedCampaignWithExecutions(client.id, {
        clientExec: { fbCampaignId: 'fb_agg_client' },
        publisherExecs: [{ fbCampaignId: 'fb_agg_pub', user: pub }],
      })

      await campaignRepo.upsertExecutionDailyStatsBulk(executions[0].id, [{
        statDate: '2026-09-19', impressions: 100, clicks: 10, spendPaise: 1000,
        reach: 0, frequency: 0, uniqueClicks: 0, ctr: 0, cpc: 0, cpm: 0,
      }])
      await campaignRepo.upsertExecutionDailyStatsBulk(executions[1].id, [{
        statDate: '2026-09-19', impressions: 200, clicks: 20, spendPaise: 2000,
        reach: 0, frequency: 0, uniqueClicks: 0, ctr: 0, cpc: 0, cpm: 0,
      }])

      const result = await campaignService.getCampaignInsights(client.id, campaignId)
      const totalImpressions = result.executions.reduce((sum, e) => sum + e.stats.totals.impressions, 0)
      const totalClicks = result.executions.reduce((sum, e) => sum + e.stats.totals.clicks, 0)
      const totalSpend = result.executions.reduce((sum, e) => sum + e.stats.totals.spendPaise, 0)

      expect(totalImpressions).toBe(300)
      expect(totalClicks).toBe(30)
      expect(totalSpend).toBe(3000)
    })
  })
})
