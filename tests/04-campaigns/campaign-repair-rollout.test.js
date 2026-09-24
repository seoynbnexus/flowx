import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import supertest from 'supertest'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import { loginAgent } from '../helpers/auth.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as execRepo from '../../src/modules/campaigns/campaign-execution.repository.js'
import * as repairRepo from '../../src/modules/campaigns/repair.repository.js'
import * as repairService from '../../src/modules/campaigns/repair.service.js'
import { freezeCampaignSnapshotFor } from '../../src/modules/campaigns/campaign-execution.service.js'
import * as mediaRepo from '../../src/modules/media-library/media.repository.js'
import { getRepairMetrics, checkRepairAlerts } from '../../src/modules/campaigns/repair.metrics.js'
import { query } from '../../shared/database/connection.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    listAccountAds: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    getObjectStatus: vi.fn().mockResolvedValue({ status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [{ level: 'AD', error_code: 2875006, error_summary: 's', error_message: 'm', error_type: 'HARD_ERROR' }] }),
    getMetaObject: vi.fn().mockResolvedValue({ id: 'x' }),
    getCampaignStatusesBatch: vi.fn().mockResolvedValue({}),
    getAdAccount: vi.fn().mockResolvedValue({}),
    listAccountCreatives: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    listAdSetAds: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    createAdCreative: vi.fn().mockResolvedValue({ id: 'mock_creative' }),
    createAdCampaign: vi.fn().mockResolvedValue({ id: 'mock_campaign' }),
    createAd: vi.fn().mockResolvedValue({ id: 'mock_ad' }),
    deleteAdCreative: vi.fn().mockResolvedValue({}),
    deleteAd: vi.fn().mockResolvedValue({}),
    updateAdStatus: vi.fn().mockResolvedValue({}),
  }
  metaMocks = mocks
  return mocks
})

const dateTag = Date.now()
let seq = 0
function tag(prefix) {
  seq += 1
  return `${prefix}_${seq}_${generateUuid()}`
}

let app
const campaignIds = []

async function setConfig(key, value) {
  if (value === undefined) {
    await query('DELETE FROM app_config WHERE config_key = ?', [key])
    return
  }
  await query(
    `INSERT INTO app_config (id, config_key, config_value, is_public, description, version)
     VALUES (?, ?, ?, 0, 'test', 1)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), version = version + 1`,
    [uuidToBuffer(generateUuid()), key, JSON.stringify(value)]
  )
}

describe('repair rollout, kill switch, metrics, and readiness (Phase 9)', () => {
  let client

  async function seedFixture(suffix) {
    const campaign = await campaignService.createCampaign(client.id, { name: `Rollout ${suffix}`, type: 'post' })
    campaignIds.push(campaign.id)
    await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'c', mediaUrl: 'https://example.com/old.png' })
    await campaignService.saveMetaSettings(client.id, campaign.id, {
      objective: 'OUTCOME_TRAFFIC', budgetAmount: 10000,
      targeting: { geo_locations: { countries: ['IN'] } },
      platformPlacement: { publisher_platforms: ['facebook', 'instagram'] },
    })
    const fb = `fb_roll_${suffix}`
    const adset = `adset_roll_${suffix}`
    const creative = `creative_roll_${suffix}`
    const ad = `ad_roll_${suffix}`
    await campaignRepo.createMetaObject(campaign.id, 'facebook_campaign', fb, null, 'ACTIVE', client.id)
    await campaignRepo.createMetaObject(campaign.id, 'ad_set', adset, null, 'ACTIVE', client.id)
    await campaignRepo.createMetaObject(campaign.id, 'ad_creative', creative, null, null, client.id)
    await campaignRepo.createMetaObject(campaign.id, 'ad', ad, null, 'PAUSED', client.id)
    const executionId = await execRepo.createExecution({
      campaignId: campaign.id, ownerUserId: client.id, kind: 'client', status: 'creating',
      platformCampaignId: fb, platformAdsetId: adset, platformCreativeId: creative, platformAdId: ad,
    })
    await campaignRepo.upsertMetaObjectIssue(executionId, {
      objectId: ad, creativeId: creative, level: 'AD', errorCode: '2875006',
      summary: 's', message: 'm', errorType: 'HARD_ERROR',
    })
    await campaignRepo.updateCampaignStatus(campaign.id, 'running')
    await freezeCampaignSnapshotFor(campaign.id)
    const asset = await mediaRepo.createMediaAsset(generateUuid(), client.id, {
      name: 'fix.png', storagePath: `/uploads/posts/roll-${suffix}.png`, mimeType: 'image/png',
      mediaKind: 'image', sizeBytes: 1024, width: 800, height: 600,
    })
    return { campaignId: campaign.id, executionId, fb, adset, creative, ad, asset }
  }

  beforeAll(async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'test_system_user_token'
    process.env.META_AD_ACCOUNT_ID = 'act_test_account'
    client = await createTestUser({ email: `repair-roll-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    const mod = await import('../../app.js')
    app = mod.default
    await setConfig('campaign_repair_rollout', 'admin_only')
    await setConfig('campaign_repair_execution_enabled', true)
  })

  afterAll(async () => {
    await setConfig('campaign_repair_rollout', undefined)
    await setConfig('campaign_repair_execution_enabled', undefined)
    await setConfig('campaign_repair_killed', undefined)
    await setConfig('campaign_repair_category_media_dimension', undefined)
    await query("DELETE FROM campaign_jobs WHERE job_type = 'execution_repair'").catch(() => {})
    for (const id of campaignIds) {
      await query('DELETE FROM campaigns WHERE id = ?', [uuidToBuffer(id)]).catch(() => {})
    }
  })

  beforeEach(async () => {
    await setConfig('campaign_repair_rollout', 'admin_only')
    await setConfig('campaign_repair_killed', undefined)
    await setConfig('campaign_repair_category_media_dimension', undefined)
    metaMocks.getObjectStatus.mockResolvedValue({ status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [{ level: 'AD', error_code: 2875006, error_summary: 's', error_message: 'm', error_type: 'HARD_ERROR' }] })
  })

  it('flag OFF blocks repair mutation at the service and the endpoint', async () => {
    await setConfig('campaign_repair_rollout', undefined)
    expect(await repairService.getRepairRolloutMode()).toBe('off')
    const seed = await seedFixture(tag('s'))
    await expect(repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null, mediaAssetId: seed.asset.id,
    })).rejects.toThrow(/rollout is off/i)
    const adminToken = await loginAgent(app, 'admin@flowx.com', 'Admin@123')
    const res = await supertest(app)
      .post(`/api/v1/admin/campaigns/${seed.campaignId}/executions/${seed.executionId}/repairs`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mediaAssetId: seed.asset.id })
    expect(res.status).toBe(403)
    expect(await repairRepo.listRepairsForExecution(seed.executionId)).toHaveLength(0)
    await setConfig('campaign_repair_rollout', 'admin_only')
  })

  it('kill switch blocks POST repair and worker mutations without corrupting state', async () => {
    const seed = await seedFixture(tag('s'))
    const created = await repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null, mediaAssetId: seed.asset.id,
    })
    await setConfig('campaign_repair_killed', true)
    expect(await repairService.isRepairKilled()).toBe(true)
    await expect(repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null, mediaAssetId: seed.asset.id,
    })).rejects.toThrow(/kill switch/i)
    await expect(repairService.runRepairJob(created.repair.id)).rejects.toThrow(/kill switch/i)
    const repair = await repairRepo.findRepairById(created.repair.id)
    expect(['pending', 'ready_for_creation']).toContain(repair.status)
    expect(metaMocks.createAdCreative).not.toHaveBeenCalled()
    expect(metaMocks.createAd).not.toHaveBeenCalled()
    expect(metaMocks.updateAdStatus).not.toHaveBeenCalled()
    expect(metaMocks.deleteAd).not.toHaveBeenCalled()
    await setConfig('campaign_repair_killed', undefined)
  })

  it('ADMIN_ONLY and ENABLED both authorize repair; preview stays non-mutating', async () => {
    const seed = await seedFixture(tag('s'))
    for (const mode of ['admin_only', 'enabled']) {
      await setConfig('campaign_repair_rollout', mode)
      expect(await repairService.getRepairRolloutMode()).toBe(mode)
    }
    await setConfig('campaign_repair_rollout', 'admin_only')
    const preview = await repairService.previewRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, mediaAssetId: seed.asset.id,
    })
    expect(preview.ok).toBe(true)
    expect(await repairRepo.listRepairsForExecution(seed.executionId)).toHaveLength(0)
  })

  it('per-category flags gate creation while the issue stays visible', async () => {
    const seed = await seedFixture(tag('s'))
    await setConfig('campaign_repair_category_media_dimension', false)
    expect(await repairService.isRepairCategoryEnabled('MEDIA_DIMENSION')).toBe(false)
    expect(await repairService.isRepairCategoryEnabled('BILLING')).toBe(false)
    await expect(repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null, mediaAssetId: seed.asset.id,
    })).rejects.toThrow(/not enabled/i)
    const status = await repairService.getExecutionRepairStatus(seed.executionId)
    expect(status.eligible).toBe(false)
    expect(status.reasons).toContain('issue-disabled')
    expect(status.issues).toHaveLength(1)
    const preview = await repairService.previewRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, mediaAssetId: seed.asset.id,
    })
    expect(preview.ok).toBe(false)
    await setConfig('campaign_repair_category_media_dimension', undefined)
    expect(await repairService.isRepairCategoryEnabled('MEDIA_DIMENSION')).toBe(true)
  })

  it('metrics record requests, outcomes, and durations without sensitive data', async () => {
    const seed = await seedFixture(tag('s'))
    await repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null, mediaAssetId: seed.asset.id,
    })
    await repairService.previewRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, mediaAssetId: seed.asset.id,
    })
    const metrics = await getRepairMetrics()
    expect(metrics.repair_requested.total).toBeGreaterThanOrEqual(1)
    expect(metrics.preview_pass.total).toBeGreaterThanOrEqual(1)
    const requested = metrics.repair_requested
    expect(requested.byCode['2875006']).toBeGreaterThanOrEqual(1)
    expect(requested.byCategory['MEDIA_DIMENSION']).toBeGreaterThanOrEqual(1)
    expect(requested.byKind['client']).toBeGreaterThanOrEqual(1)
    const blob = JSON.stringify(metrics)
    expect(blob).not.toMatch(/access_token|accessToken/)
    expect(blob.length).toBeLessThan(200000)
  })

  it('alerts fire on stuck repairs with dedupe and stay silent otherwise', async () => {
    const seed = await seedFixture(tag('s'))
    const created = await repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null, mediaAssetId: seed.asset.id,
    })
    await query('UPDATE campaign_execution_repairs SET updated_at = DATE_SUB(NOW(), INTERVAL 2 HOUR) WHERE id = ?', [uuidToBuffer(created.repair.id)])
    const alerts = await checkRepairAlerts()
    const stuck = alerts.find((a) => a.alert === 'stuck-repairs')
    expect(stuck).toBeTruthy()
    expect(stuck.count).toBeGreaterThanOrEqual(1)
    const again = await checkRepairAlerts()
    expect(again.find((a) => a.alert === 'stuck-repairs')?.fired).toBe(false)
    await query('DELETE FROM meta_sync_state WHERE run_key LIKE ?', ['repair_alert:%'])
  })

  it('readiness endpoint reports stage, checks, fleet, and metrics to admins only', async () => {
    await setConfig('campaign_repair_rollout', undefined)
    const adminToken = await loginAgent(app, 'admin@flowx.com', 'Admin@123')
    const res = await supertest(app)
      .get('/api/v1/admin/campaigns/repairs/readiness')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.data.stage).toBe(0)
    expect(res.body.data.ready).toBe(true)
    expect(res.body.data.flags).toMatchObject({ rollout: 'off', killed: false })
    expect(res.body.data.checks.every((c) => c.ok)).toBe(true)
    expect(res.body.data.fleet).toHaveProperty('byStatus')
    expect(res.body.data).toHaveProperty('metrics')
    const clientToken = await loginAgent(app, `repair-roll-${dateTag}@flowx-test.com`, 'Test@123')
    const denied = await supertest(app)
      .get('/api/v1/admin/campaigns/repairs/readiness')
      .set('Authorization', `Bearer ${clientToken}`)
    expect(denied.status).toBe(403)
    await setConfig('campaign_repair_rollout', 'admin_only')
  })

  it('financial fence holds across rollout-gated paths', async () => {
    const seed = await seedFixture(tag('s'))
    const billingBefore = await query('SELECT COUNT(*) AS n FROM campaign_billing_entries WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])
    const executionsBefore = await query('SELECT COUNT(*) AS n FROM campaign_executions WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])
    const chargedBefore = (await campaignRepo.findCampaignById(seed.campaignId)).chargedAdBudgetPaise
    await repairService.previewRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, mediaAssetId: seed.asset.id,
    })
    await repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null, mediaAssetId: seed.asset.id,
    })
    await repairService.getExecutionRepairStatus(seed.executionId)
    await repairService.getRepairReadiness()
    await checkRepairAlerts()
    expect(await query('SELECT COUNT(*) AS n FROM campaign_billing_entries WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])).toEqual(billingBefore)
    expect(await query('SELECT COUNT(*) AS n FROM campaign_executions WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])).toEqual(executionsBefore)
    expect((await campaignRepo.findCampaignById(seed.campaignId)).chargedAdBudgetPaise).toBe(chargedBefore)
    expect((await campaignRepo.findCampaignById(seed.campaignId)).settledAt).toBeNull()
    const src = fs.readFileSync(new URL('../../src/modules/campaigns/repair.metrics.js', import.meta.url), 'utf8')
    expect(src).not.toMatch(/coinService|insertBillingEntry|chargedAdBudgetPaise|claimCampaignSettlement/)
  })
})
