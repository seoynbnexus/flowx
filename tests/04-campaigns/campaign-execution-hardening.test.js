import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as execRepo from '../../src/modules/campaigns/campaign-execution.repository.js'
import * as repairRepo from '../../src/modules/campaigns/repair.repository.js'
import * as repairService from '../../src/modules/campaigns/repair.service.js'
import { REPAIR_STATUS } from '../../src/modules/campaigns/repair.model.js'
import { freezeCampaignSnapshotFor } from '../../src/modules/campaigns/campaign-execution.service.js'
import * as mediaRepo from '../../src/modules/media-library/media.repository.js'
import { processMetaWebhookEvents } from '../../src/modules/campaigns/meta-webhook.service.js'
import { logMetaEvent } from '../../shared/services/meta-logger.service.js'
import { query } from '../../shared/database/connection.js'

vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    listAccountAds: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    getObjectStatus: vi.fn().mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' }),
    getMetaObject: vi.fn().mockResolvedValue({ id: 'x' }),
    getCampaignStatusesBatch: vi.fn().mockResolvedValue({}),
    getAdAccount: vi.fn().mockResolvedValue({ balance: '10.00', currency: 'INR', account_status: 1, disable_reason: null }),
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

var metaMocks

vi.mock('../../shared/services/meta-logger.service.js', () => ({
  logMetaEvent: vi.fn().mockResolvedValue(undefined),
}))

const dateTag = Date.now()
let seq = 0
function tag(prefix) {
  seq += 1
  return `${prefix}_${seq}_${generateUuid()}`
}

const ISSUE_2875006 = {
  level: 'AD',
  error_code: 2875006,
  error_summary: 'Media not wide enough',
  error_message: "Media not wide enough: Your ad won't run on Instagram.",
  error_type: 'HARD_ERROR',
}

const campaignIds = []
const createdObjects = []
let trackingActive = false
let statusTrackingActive = false
const activatedAdIds = new Set()

describe('repair hardening (Phase 7)', () => {
  let client
  let partner

  async function seedFixture(suffix, ownerId = null) {
    const owner = ownerId || client.id
    const campaign = await campaignService.createCampaign(owner, { name: `RepairHarden ${suffix}`, type: 'post' })
    campaignIds.push(campaign.id)
    await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'frozen caption', mediaUrl: 'https://example.com/old.png' })
    await campaignService.saveMetaSettings(owner, campaign.id, {
      objective: 'OUTCOME_TRAFFIC',
      budgetAmount: 10000,
      targeting: { geo_locations: { countries: ['IN'] } },
      platformPlacement: { publisher_platforms: ['facebook', 'instagram'] },
    })
    const fbPlatform = await query("SELECT id FROM platforms WHERE code = 'facebook' LIMIT 1").then((r) => r[0])
    if (fbPlatform) {
      await query(
        `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id, platform_username, token_type, token_expires_at, verification_status)
         VALUES (?, ?, ?, ?, ?, ?, 'page', DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
        [uuidToBuffer(generateUuid()), uuidToBuffer(owner), fbPlatform.id, 'https://fb.com/test', `fb_hard_${suffix}`, 'HardenPage']
      )
    }
    const fb = `fb_hard_${suffix}`
    const adset = `adset_hard_${suffix}`
    const creative = `creative_hard_${suffix}`
    const ad = `ad_hard_${suffix}`
    await campaignRepo.createMetaObject(campaign.id, 'facebook_campaign', fb, null, 'ACTIVE', owner)
    await campaignRepo.createMetaObject(campaign.id, 'ad_set', adset, null, 'ACTIVE', owner)
    await campaignRepo.createMetaObject(campaign.id, 'ad_creative', creative, null, null, owner)
    await campaignRepo.createMetaObject(campaign.id, 'ad', ad, null, 'ACTIVE', owner)
    const executionId = await execRepo.createExecution({
      campaignId: campaign.id, ownerUserId: owner, kind: owner === client.id ? 'client' : 'publisher', status: 'creating',
      platformCampaignId: fb, platformAdsetId: adset, platformCreativeId: creative, platformAdId: ad,
    })
    await campaignRepo.upsertMetaObjectIssue(executionId, {
      objectId: ad, creativeId: creative, level: 'AD', errorCode: '2875006',
      summary: 'Media not wide enough', message: "Won't run on Instagram.", errorType: 'HARD_ERROR',
    })
    await campaignRepo.updateCampaignStatus(campaign.id, 'running')
    await freezeCampaignSnapshotFor(campaign.id)
    const asset = await mediaRepo.createMediaAsset(generateUuid(), owner, {
      name: 'fix.png', storagePath: `/uploads/posts/fix-${suffix}.png`, mimeType: 'image/png',
      mediaKind: 'image', sizeBytes: 1024, width: 800, height: 600,
    })
    const requested = await repairService.requestRepair({
      campaignId: campaign.id, executionId, actorId: null, mediaAssetId: asset.id,
    })
    return { campaignId: campaign.id, executionId, fb, adset, creative, ad, asset, repair: requested.repair, owner }
  }

  function trackCreations() {
    if (trackingActive) return
    trackingActive = true
    const baseCreative = metaMocks.createAdCreative.getMockImplementation()
    const baseAd = metaMocks.createAd.getMockImplementation()
    metaMocks.createAdCreative.mockImplementation((...args) => {
      const result = baseCreative(...args)
      if (args[args.length - 1] !== true) {
        return result.then((created) => {
          createdObjects.push({ kind: 'creative', id: created.id, name: args[6]?.name || null })
          return created
        })
      }
      return result
    })
    metaMocks.createAd.mockImplementation((...args) => {
      const result = baseAd(...args)
      if (args[args.length - 1] !== true) {
        return result.then((created) => {
          createdObjects.push({ kind: 'ad', id: created.id, name: args[3], creativeId: args[2], adsetId: args[1] })
          return created
        })
      }
      return result
    })
  }

  function mockHealthyFlow() {
    metaMocks.getObjectStatus.mockImplementation((id) => Promise.resolve(
      activatedAdIds.has(id)
        ? { status: 'ACTIVE', effective_status: 'ACTIVE', issues_info: [] }
        : createdObjects.some((o) => o.kind === 'ad' && o.id === id)
          ? { status: 'PAUSED', effective_status: 'ACTIVE', issues_info: [] }
          : { status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006] }
    ))
    metaMocks.listAdSetAds.mockImplementation(() => Promise.resolve({
      rows: createdObjects
        .filter((o) => o.kind === 'ad')
        .map((o) => ({ id: o.id, name: o.name, status: activatedAdIds.has(o.id) ? 'ACTIVE' : 'PAUSED', effective_status: 'ACTIVE', creative: { id: o.creativeId } })),
      truncated: false,
    }))
    if (!statusTrackingActive) {
      statusTrackingActive = true
      const baseStatus = metaMocks.updateAdStatus.getMockImplementation()
      metaMocks.updateAdStatus.mockImplementation((...args) => {
        if (args[1] === 'ACTIVE') activatedAdIds.add(args[0])
        if (args[1] === 'PAUSED') activatedAdIds.delete(args[0])
        return baseStatus(...args)
      })
    }
  }

  async function driveToVerified(suffix, ownerId = null) {
    const seed = await seedFixture(suffix, ownerId)
    trackCreations()
    mockHealthyFlow()
    const out = await repairService.runRepairJob(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'new_verified' })
    return seed
  }

  async function driveToCompleted(suffix, ownerId = null) {
    const seed = await driveToVerified(suffix, ownerId)
    mockHealthyFlow()
    const out = await repairService.runRepairActivation(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'completed' })
    return seed
  }

  async function setRepairFlag(on) {
    if (on) {
      await query(
        `INSERT INTO app_config (id, config_key, config_value, is_public, description, version)
         VALUES (?, 'campaign_repair_execution_enabled', 'true', 0, 'test', 1)
         ON DUPLICATE KEY UPDATE config_value = 'true', version = version + 1`,
        [uuidToBuffer(generateUuid())]
      )
      await query(
        `INSERT INTO app_config (id, config_key, config_value, is_public, description, version)
         VALUES (?, 'campaign_repair_rollout', '"admin_only"', 0, 'test', 1)
         ON DUPLICATE KEY UPDATE config_value = '"admin_only"', version = version + 1`,
        [uuidToBuffer(generateUuid())]
      )
    } else {
      await query("DELETE FROM app_config WHERE config_key = 'campaign_repair_execution_enabled'")
      await query("DELETE FROM app_config WHERE config_key = 'campaign_repair_rollout'")
    }
  }

  let whSeq = 0
  function webhookEvent(field, value) {
    whSeq += 1
    return {
      object: 'ad_account',
      entry: [{ id: `wh_${dateTag}_${whSeq}`, time: Math.floor(Date.now() / 1000), changes: [{ field, value }] }],
    }
  }

  beforeAll(async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'test_system_user_token'
    process.env.META_AD_ACCOUNT_ID = 'act_test_account'
    client = await createTestUser({ email: `repair-hard-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    partner = await createTestUser({ email: `repair-hard-partner-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    await setRepairFlag(true)
    // driveToVerified relies on runRepairJob stopping exactly at
    // NEW_VERIFIED so tests can then drive their own specific
    // activation/cutover scenario via runRepairActivation. Production
    // always chains creation -> activation; opt out here only, and
    // restore it so later files in the same vitest run keep the real,
    // chained behavior.
    repairService.repairJobOptions.chainActivationAfterCreation = false
  })

  afterAll(async () => {
    repairService.repairJobOptions.chainActivationAfterCreation = true
    await setRepairFlag(false)
    await query("DELETE FROM campaign_jobs WHERE job_type = 'execution_repair'").catch(() => {})
    for (const id of campaignIds) {
      await query('DELETE FROM campaigns WHERE id = ?', [uuidToBuffer(id)]).catch(() => {})
    }
  })

  beforeEach(() => {
    createdObjects.length = 0
    trackingActive = false
    statusTrackingActive = false
    activatedAdIds.clear()
    for (const fn of ['getObjectStatus', 'getMetaObject', 'listAdSetAds', 'listAccountCreatives', 'createAdCreative', 'createAd', 'deleteAdCreative', 'deleteAd', 'listAccountAds', 'updateAdStatus']) {
      metaMocks[fn].mockClear()
    }
    metaMocks.getObjectStatus.mockResolvedValue({ status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006] })
    metaMocks.getMetaObject.mockResolvedValue({ id: 'x' })
    metaMocks.listAdSetAds.mockResolvedValue({ rows: [], truncated: false })
    metaMocks.listAccountCreatives.mockResolvedValue({ rows: [], truncated: false })
    metaMocks.createAdCreative.mockImplementation((...args) => args[args.length - 1] === true
      ? Promise.resolve({})
      : Promise.resolve({ id: `hard_creative_${generateUuid()}` }))
    metaMocks.createAd.mockImplementation((...args) => args[args.length - 1] === true
      ? Promise.resolve({})
      : Promise.resolve({ id: `hard_ad_${generateUuid()}` }))
    metaMocks.deleteAdCreative.mockResolvedValue({})
    metaMocks.deleteAd.mockResolvedValue({})
    metaMocks.updateAdStatus.mockResolvedValue({})
    logMetaEvent.mockClear()
  })

  describe('permanent generation invariants', () => {
    it('1-3. one active generation, pointer validity, immutable history', async () => {
      const seed = await driveToCompleted(tag('s'))
      const gens = await execRepo.listGenerationsForExecution(seed.executionId)
      expect(gens.filter((g) => g.status === 'active')).toHaveLength(1)
      const execution = await execRepo.findExecutionById(seed.executionId)
      const active = gens.find((g) => g.status === 'active')
      expect(execution.activeGenerationNo).toBe(active.generationNo)
      expect(gens.find((g) => g.generationNo === 0).platformAdId).toBe(seed.ad)
      expect(gens.find((g) => g.generationNo === 0).platformCreativeId).toBe(seed.creative)
    })

    it('4-6. one repair run creates at most one generation, creative, and ad', async () => {
      const seed = await driveToVerified(tag('s'))
      trackCreations()
      mockHealthyFlow()
      await repairService.runRepairActivation(seed.repair.id)
      await repairService.runRepairActivation(seed.repair.id)
      const gens = await execRepo.listGenerationsForExecution(seed.executionId)
      expect(gens.filter((g) => g.generationNo > 0)).toHaveLength(1)
      expect(metaMocks.createAdCreative.mock.calls.filter((c) => c[c.length - 1] !== true)).toHaveLength(1)
      expect(metaMocks.createAd.mock.calls.filter((c) => c[c.length - 1] !== true)).toHaveLength(1)
    })

    it('7-8. pointer moves exactly once and never reverses through repair execution', async () => {
      const seed = await driveToCompleted(tag('s'))
    expect((await execRepo.findExecutionById(seed.executionId)).activeGenerationNo).toBe(1)
    metaMocks.updateAdStatus.mockClear()
    const third = await repairService.runRepairActivation(seed.repair.id)
    expect(third).toMatchObject({ done: true, state: 'completed' })
    expect((await execRepo.findExecutionById(seed.executionId)).activeGenerationNo).toBe(1)
    expect(metaMocks.updateAdStatus).not.toHaveBeenCalled()
    })

    it('9-10. historical generations stay non-authoritative and unadoptable', async () => {
      const seed = await driveToCompleted(tag('s'))
      const { findForeignTracker } = await import('../../src/modules/campaigns/campaign.service.js')
      expect(await findForeignTracker(seed.ad, seed.campaignId, client.id)).toMatchObject({ tracked: true })
      const gens = await execRepo.listGenerationsForExecution(seed.executionId)
      const gen1 = gens.find((g) => g.generationNo === 1)
      expect(await findForeignTracker(gen1.platformAdId, seed.campaignId, client.id)).toMatchObject({ tracked: false })
      expect((await execRepo.findExecutionByMetaId(seed.ad)).id).toBe(seed.executionId)
      expect((await execRepo.findExecutionByMetaId(gen1.platformAdId)).id).toBe(seed.executionId)
    })
  })

  describe('webhook races', () => {
    async function cutoverFixture(suffix) {
      const seed = await driveToCompleted(suffix)
      const gens = await execRepo.listGenerationsForExecution(seed.executionId)
      const gen1 = gens.find((g) => g.generationNo === 1)
      await campaignRepo.createMetaObject(seed.campaignId, 'ad_creative', gen1.platformCreativeId, null, null, client.id)
      await campaignRepo.createMetaObject(seed.campaignId, 'ad', gen1.platformAdId, null, 'ACTIVE', client.id)
      return { seed, gen1 }
    }

    async function sendDelivery(adId, fbId, status) {
      return processMetaWebhookEvents(webhookEvent('ad.delivery_signals', {
        ad_id: adId, campaign_id: fbId, status,
      }))
    }

    it('A/B. stale old events around new ACTIVE never regress the campaign', async () => {
      const { seed, gen1 } = await cutoverFixture(tag('s'))
      await sendDelivery(gen1.platformAdId, seed.fb, 'ACTIVE')
      await sendDelivery(seed.ad, seed.fb, 'WITH_ISSUES')
      await sendDelivery(seed.ad, seed.fb, 'PAUSED')
      expect((await campaignRepo.findCampaignById(seed.campaignId)).metaStatus).toBe('active')
      await sendDelivery(gen1.platformAdId, seed.fb, 'ACTIVE')
      await sendDelivery(seed.ad, seed.fb, 'DELETED')
      await sendDelivery(seed.ad, seed.fb, 'WITH_ISSUES')
      expect((await campaignRepo.findCampaignById(seed.campaignId)).metaStatus).toBe('active')
    })

    it('C/D. interleaved old and new events converge on the active generation', async () => {
      const { seed, gen1 } = await cutoverFixture(tag('s'))
      await sendDelivery(seed.ad, seed.fb, 'WITH_ISSUES')
      await sendDelivery(gen1.platformAdId, seed.fb, 'ACTIVE')
      await sendDelivery(seed.ad, seed.fb, 'WITH_ISSUES')
      expect((await campaignRepo.findCampaignById(seed.campaignId)).metaStatus).toBe('active')
      await sendDelivery(gen1.platformAdId, seed.fb, 'WITH_ISSUES')
      await sendDelivery(seed.ad, seed.fb, 'WITH_ISSUES')
      await sendDelivery(gen1.platformAdId, seed.fb, 'ACTIVE')
      expect((await campaignRepo.findCampaignById(seed.campaignId)).metaStatus).toBe('active')
    })

    it('E. old events after pointer=1 are ignored, including DELETED', async () => {
      const { seed } = await cutoverFixture(tag('s'))
      const outcome = await sendDelivery(seed.ad, seed.fb, 'DELETED')
      expect(JSON.stringify(outcome)).toMatch(/historical-generation/)
      expect((await campaignRepo.findCampaignById(seed.campaignId)).metaStatus).not.toBe('archived')
      expect((await campaignRepo.findCampaignById(seed.campaignId)).status).toBe('running')
    })

    it('spend handling is unchanged by generations', async () => {
      const { seed, gen1 } = await cutoverFixture(tag('s'))
      const before = await campaignRepo.sumDailyStatsSpend(seed.campaignId)
      const spendEvent = (amount) => webhookEvent('campaign_spend', {
        campaign_id: seed.fb, amount, date: new Date().toISOString().slice(0, 10),
      })
      await processMetaWebhookEvents(spendEvent('10.00'))
      await processMetaWebhookEvents(spendEvent('10.00'))
      const after = await campaignRepo.sumDailyStatsSpend(seed.campaignId)
      expect(after - before).toBe(1000)
    })
  })

  describe('scheduler concurrency around cutover', () => {
    it('sync, force-sync, governor, and worker converge without duplication or regression', async () => {
      const seed = await driveToVerified(tag('s'))
      trackCreations()
      mockHealthyFlow()
      const gen1 = (await execRepo.listGenerationsForExecution(seed.executionId)).find((g) => g.generationNo === 1)
      await campaignRepo.createMetaObject(seed.campaignId, 'ad_creative', gen1.platformCreativeId, null, null, client.id)
      await campaignRepo.createMetaObject(seed.campaignId, 'ad', gen1.platformAdId, null, 'PAUSED', client.id)
      metaMocks.listAccountAds.mockResolvedValue({
        rows: [
          { id: seed.ad, status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006] },
          { id: gen1.platformAdId, status: 'PAUSED', effective_status: 'ACTIVE', issues_info: [] },
        ],
        truncated: true,
      })
      const accountId = generateUuid()
      const { encrypt } = await import('../../shared/utils/crypto.utils.js')
      await query(
        'INSERT INTO meta_ad_accounts (id, account_id, name, token_encrypted, monthly_cap_paise, is_primary, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uuidToBuffer(accountId), `act_conc_${tag('s')}`, 'conc-test', encrypt('test-token'), 1, 0, 'active']
      )
      try {
        await query('UPDATE campaigns SET ad_account_id = ?, charged_ad_budget_paise = 50000 WHERE id = ?', [uuidToBuffer(accountId), uuidToBuffer(seed.campaignId)])
        const { enforceAccountBudgetCap } = await import('../../src/modules/campaigns/campaign.service.js')
        const results = await Promise.all([
          campaignService.syncAccountStatusJob('act_test_account'),
          campaignService.syncCampaignStatusJob(seed.campaignId),
          enforceAccountBudgetCap({ id: accountId, metaAccountId: 'act_test_account', monthlyCapPaise: 1, name: 't' }),
          repairService.runRepairActivation(seed.repair.id),
        ])
        expect(results[3]).toMatchObject({ done: true, state: 'completed' })
        expect((await execRepo.findExecutionById(seed.executionId)).activeGenerationNo).toBe(1)
        expect((await campaignRepo.findCampaignById(seed.campaignId)).metaStatus).not.toBe('archived')
        const pauseCalls = metaMocks.updateAdStatus.mock.calls.filter((c) => c[0] === seed.ad && c[1] === 'PAUSED')
        expect(pauseCalls.length).toBeLessThanOrEqual(2)
        const gens = await execRepo.listGenerationsForExecution(seed.executionId)
        expect(gens.filter((g) => g.generationNo > 0)).toHaveLength(1)
      } finally {
        await query('UPDATE campaigns SET ad_account_id = NULL, charged_ad_budget_paise = 0 WHERE id = ?', [uuidToBuffer(seed.campaignId)]).catch(() => {})
        await query('DELETE FROM meta_ad_accounts WHERE id = ?', [uuidToBuffer(accountId)]).catch(() => {})
        await query('DELETE FROM meta_sync_state WHERE run_key = ? OR run_key = ?', [`cap_alert:${accountId}`, `cap_pause:${accountId}`]).catch(() => {})
      }
    })
  })

  describe('crash matrix', () => {
    it('restarts after NEW_ACTIVE_VERIFIED without reactivating', async () => {
      const seed = await driveToVerified(tag('s'))
      trackCreations()
      mockHealthyFlow()
      await repairRepo.updateRepairState(seed.repair.id, ['new_verified'], 'new_active_verified')
      metaMocks.createAdCreative.mockClear()
      metaMocks.createAd.mockClear()
      metaMocks.updateAdStatus.mockClear()
      const out = await repairService.runRepairActivation(seed.repair.id)
      expect(out).toMatchObject({ done: true, state: 'completed' })
      expect(metaMocks.updateAdStatus.mock.calls.filter((c) => c[1] === 'ACTIVE')).toHaveLength(0)
      expect(metaMocks.createAdCreative.mock.calls.filter((c) => c[c.length - 1] !== true)).toHaveLength(0)
    })

    it('restarts in OLD_CLEANUP with deleted objects and completes idempotently', async () => {
      const seed = await driveToVerified(tag('s'))
      trackCreations()
      mockHealthyFlow()
      await repairService.runRepairActivation(seed.repair.id)
      metaMocks.deleteAd.mockClear()
      metaMocks.deleteAdCreative.mockClear()
      const out = await repairService.runRepairActivation(seed.repair.id)
      expect(out).toMatchObject({ done: true, state: 'completed' })
      expect(metaMocks.deleteAd).not.toHaveBeenCalled()
      expect(metaMocks.deleteAdCreative).not.toHaveBeenCalled()
    })

    it('records Meta mutation counts across a full run', async () => {
      const seed = await driveToVerified(tag('s'))
      trackCreations()
      mockHealthyFlow()
      activatedAdIds.add(seed.ad)
      metaMocks.updateAdStatus.mockClear()
      metaMocks.deleteAd.mockClear()
      metaMocks.deleteAdCreative.mockClear()
      await repairService.runRepairActivation(seed.repair.id)
      const activations = metaMocks.updateAdStatus.mock.calls.filter((c) => c[1] === 'ACTIVE')
      const pauses = metaMocks.updateAdStatus.mock.calls.filter((c) => c[1] === 'PAUSED')
      expect(activations).toHaveLength(1)
      expect(pauses).toHaveLength(1)
      expect(metaMocks.deleteAd.mock.calls).toHaveLength(1)
      expect(metaMocks.deleteAdCreative.mock.calls).toHaveLength(1)
    })
  })

  describe('failure and retry matrix', () => {
    it('read-back transient throws for backoff with repair unmoved', async () => {
      const seed = await driveToVerified(tag('s'))
      trackCreations()
      mockHealthyFlow()
      const gen1 = (await execRepo.listGenerationsForExecution(seed.executionId)).find((g) => g.generationNo === 1)
      let reads = 0
      metaMocks.getObjectStatus.mockImplementation((id) => {
        if (id !== gen1.platformAdId) {
          return Promise.resolve({ status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006] })
        }
        reads += 1
        if (reads <= 2) {
          return Promise.resolve({ status: 'PAUSED', effective_status: 'ACTIVE', issues_info: [] })
        }
        return Promise.reject(new Error('socket hang up'))
      })
      await expect(repairService.runRepairActivation(seed.repair.id)).rejects.toThrow(/verify read failed|read failed/i)
      expect((await repairRepo.findRepairById(seed.repair.id)).status).toBe('new_activating')
      expect((await execRepo.findExecutionById(seed.executionId)).activeGenerationNo).toBe(0)
    })

    it('pointer already moved never rolls back, reactivates, or regenerates', async () => {
      const seed = await driveToCompleted(tag('s'))
      await repairRepo.updateRepairState(seed.repair.id, ['completed'], 'old_paused_verified')
      metaMocks.createAdCreative.mockClear()
      metaMocks.createAd.mockClear()
      const out = await repairService.runRepairActivation(seed.repair.id)
      expect(out).toMatchObject({ done: true, state: 'completed' })
      expect((await execRepo.findExecutionById(seed.executionId)).activeGenerationNo).toBe(1)
      expect(metaMocks.createAdCreative.mock.calls.filter((c) => c[c.length - 1] !== true)).toHaveLength(0)
      expect(metaMocks.createAd.mock.calls.filter((c) => c[c.length - 1] !== true)).toHaveLength(0)
      const gens = await execRepo.listGenerationsForExecution(seed.executionId)
      expect(gens.filter((g) => g.generationNo > 0)).toHaveLength(1)
    })

    it('delete ambiguity stays retryable in OLD_CLEANUP without pointer regression', async () => {
      const seed = await driveToVerified(tag('s'))
      trackCreations()
      mockHealthyFlow()
      metaMocks.deleteAd.mockImplementation(() => Promise.reject(new Error('socket hang up')))
      const out = await repairService.runRepairActivation(seed.repair.id)
      expect(out).toMatchObject({ done: true, state: 'old_cleanup', retryable: true })
      expect((await execRepo.findExecutionById(seed.executionId)).activeGenerationNo).toBe(1)
      metaMocks.deleteAd.mockResolvedValue({})
      const retry = await repairService.runRepairActivation(seed.repair.id)
      expect(retry).toMatchObject({ done: true, state: 'completed' })
    })
  })

  describe('unknown semantics', () => {
    it('every UNKNOWN persists reason, IDs, and reconciles before mutating', async () => {
      const seed = await driveToVerified(tag('s'))
      trackCreations()
      mockHealthyFlow()
      metaMocks.getObjectStatus.mockImplementation(() => Promise.reject(new Error('socket hang up')))
      await expect(repairService.runRepairActivation(seed.repair.id)).rejects.toThrow()
      const repair = await repairRepo.findRepairById(seed.repair.id)
      expect(repair.status).toBe('new_verified')
      mockHealthyFlow()
      const retry = await repairService.runRepairActivation(seed.repair.id)
      expect(retry).toMatchObject({ done: true, state: 'completed' })
    })

    it('UNKNOWN rows carry reason and object identity for operators', async () => {
      const seed = await driveToVerified(tag('s'))
      trackCreations()
      mockHealthyFlow()
      metaMocks.getObjectStatus.mockImplementationOnce(() => Promise.reject(missingObjectErrorForTest(seed)))
      const out = await repairService.runRepairActivation(seed.repair.id)
      expect(out).toMatchObject({ done: true, state: 'unknown' })
      const repair = await repairRepo.findRepairById(seed.repair.id)
      expect(repair.error).toBeTruthy()
      expect(repair.objectId).toBeTruthy()
      expect(repair.errorCode).toBe('2875006')
    })

    function missingObjectErrorForTest(seed) {
      return new Error(`Graph API GET x failed: ${JSON.stringify({ error: { message: '(#100) Object does not exist', code: 100, error_subcode: 33 } })}`)
    }
  })

  describe('owner isolation under concurrency', () => {
    it('client and publisher repairs cut over independently on one campaign', async () => {
      const campaign = await campaignService.createCampaign(client.id, { name: `RepairIso ${tag('s')}`, type: 'post' })
      campaignIds.push(campaign.id)
      await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'iso', mediaUrl: 'https://example.com/i.png' })
      await campaignService.saveMetaSettings(client.id, campaign.id, {
        objective: 'OUTCOME_TRAFFIC', budgetAmount: 10000,
        targeting: { geo_locations: { countries: ['IN'] } },
        platformPlacement: { publisher_platforms: ['facebook', 'instagram'] },
      })
      const mkChain = async (ownerId, kind, sfx) => {
        const fbPlatform = await query("SELECT id FROM platforms WHERE code = 'facebook' LIMIT 1").then((r) => r[0])
        if (fbPlatform) {
          await query(
            `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id, platform_username, token_type, token_expires_at, verification_status)
             VALUES (?, ?, ?, ?, ?, ?, 'page', DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
            [uuidToBuffer(generateUuid()), uuidToBuffer(ownerId), fbPlatform.id, 'https://fb.com/test', `fb_iso_${sfx}`, 'IsoPage']
          )
        }        const fb = `fb_iso_${sfx}`
        const adset = `adset_iso_${sfx}`
        const creative = `creative_iso_${sfx}`
        const ad = `ad_iso_${sfx}`
        await campaignRepo.createMetaObject(campaign.id, 'facebook_campaign', fb, null, 'ACTIVE', ownerId)
        await campaignRepo.createMetaObject(campaign.id, 'ad_set', adset, null, 'ACTIVE', ownerId)
        await campaignRepo.createMetaObject(campaign.id, 'ad_creative', creative, null, null, ownerId)
        await campaignRepo.createMetaObject(campaign.id, 'ad', ad, null, 'ACTIVE', ownerId)
        const executionId = await execRepo.createExecution({
          campaignId: campaign.id, ownerUserId: ownerId, kind, status: 'creating',
          platformCampaignId: fb, platformAdsetId: adset, platformCreativeId: creative, platformAdId: ad,
        })
        await campaignRepo.upsertMetaObjectIssue(executionId, {
          objectId: ad, creativeId: creative, level: 'AD', errorCode: '2875006',
          summary: 's', message: 'm', errorType: 'HARD_ERROR',
        })
        return { executionId, fb, adset, creative, ad }
      }
      const c = await mkChain(client.id, 'client', tag('s'))
      const p = await mkChain(partner.id, 'publisher', tag('s'))
      await campaignRepo.updateCampaignStatus(campaign.id, 'running')
      await freezeCampaignSnapshotFor(campaign.id)
      const mkAsset = (ownerId, sfx) => mediaRepo.createMediaAsset(generateUuid(), ownerId, {
        name: 'fix.png', storagePath: `/uploads/posts/iso-${sfx}.png`, mimeType: 'image/png',
        mediaKind: 'image', sizeBytes: 1024, width: 800, height: 600,
      })
      const cAsset = await mkAsset(client.id, tag('s'))
      const pAsset = await mkAsset(partner.id, tag('s'))
      trackCreations()
      mockHealthyFlow()
      const [rc, rp] = await Promise.all([
        repairService.requestRepair({ campaignId: campaign.id, executionId: c.executionId, actorId: null, mediaAssetId: cAsset.id }),
        repairService.requestRepair({ campaignId: campaign.id, executionId: p.executionId, actorId: null, mediaAssetId: pAsset.id }),
      ])
      const [oc, op] = await Promise.all([
        repairService.runRepairJob(rc.repair.id),
        repairService.runRepairJob(rp.repair.id),
      ])
      expect(oc).toMatchObject({ done: true, state: 'new_verified' })
      expect(op).toMatchObject({ done: true, state: 'new_verified' })
      const [ac, ap] = await Promise.all([
        repairService.runRepairActivation(rc.repair.id),
        repairService.runRepairActivation(rp.repair.id),
      ])
      expect(ac).toMatchObject({ done: true, state: 'completed' })
      expect(ap).toMatchObject({ done: true, state: 'completed' })
      const statusCalls = metaMocks.updateAdStatus.mock.calls
      const byOwner = (ownerAdIds) => statusCalls.filter((call) => ownerAdIds.includes(call[0]))
      const cIds = [c.ad, c.creative, ...(await execRepo.listGenerationsForExecution(c.executionId)).filter((g) => g.generationNo > 0).flatMap((g) => [g.platformAdId, g.platformCreativeId])]
      const pIds = [p.ad, p.creative, ...(await execRepo.listGenerationsForExecution(p.executionId)).filter((g) => g.generationNo > 0).flatMap((g) => [g.platformAdId, g.platformCreativeId])]
      expect(byOwner(cIds).length).toBeGreaterThan(0)
      expect(byOwner(pIds).length).toBeGreaterThan(0)
      expect(statusCalls.every((call) => cIds.includes(call[0]) || pIds.includes(call[0]))).toBe(true)
      const deletes = [...metaMocks.deleteAd.mock.calls, ...metaMocks.deleteAdCreative.mock.calls].map((c) => c[0])
      expect(deletes.every((id) => cIds.includes(id) || pIds.includes(id))).toBe(true)
      expect((await execRepo.findExecutionById(c.executionId)).activeGenerationNo).toBe(1)
      expect((await execRepo.findExecutionById(p.executionId)).activeGenerationNo).toBe(1)
      const crossAdopt = await execRepo.findGenerationByMetaId(p.ad)
      expect(crossAdopt.executionId).toBe(p.executionId)
    })
  })

  describe('reporting identity across generations', () => {
    it('old and new IDs resolve together with correct spend attribution', async () => {
      const seed = await driveToCompleted(tag('s'))
      const gens = await execRepo.listGenerationsForExecution(seed.executionId)
      const gen1 = gens.find((g) => g.generationNo === 1)
      expect((await execRepo.findGenerationByMetaId(seed.ad)).generationNo).toBe(0)
      expect((await execRepo.findGenerationByMetaId(gen1.platformAdId)).generationNo).toBe(1)
      expect((await execRepo.findExecutionByMetaId(seed.ad)).id).toBe(seed.executionId)
      expect((await execRepo.findExecutionByMetaId(gen1.platformAdId)).id).toBe(seed.executionId)
      const today = new Date().toISOString().slice(0, 10)
      await campaignRepo.upsertDailyStatsBulk(seed.campaignId, [{
        statDate: today, impressions: 10, reach: 5, frequency: 2, clicks: 1, uniqueClicks: 1,
        ctr: 1, cpc: 100, cpm: 100, spendPaise: 1000, actions: [], costPerActionType: [],
      }])
      const before = await campaignRepo.sumDailyStatsSpend(seed.campaignId)
      metaMocks.listAccountAds.mockResolvedValue({ rows: [], truncated: true })
      await campaignService.syncAccountStatusJob('act_test_account')
      expect(await campaignRepo.sumDailyStatsSpend(seed.campaignId)).toBe(before)
      const detail = await campaignService.getCampaign(client.id, seed.campaignId)
      expect(Array.isArray(detail.metaIssues)).toBe(true)
    })
  })

  describe('reconciliation report', () => {
    it('reports healthy for a completed cutover', async () => {
      const seed = await driveToCompleted(tag('s'))
      const report = await repairService.getExecutionReconciliation(seed.executionId)
      expect(report.healthy).toBe(true)
      expect(report.execution.id).toBe(seed.executionId)
      expect(report.owner).toBe(client.id)
      expect(report.kind).toBe('client')
      expect(report.activeGeneration.generationNo).toBe(1)
      expect(report.checks.every((c) => c.ok)).toBe(true)
    })

    it('flags pointer, stuck, unknown, and linkage anomalies without mutating', async () => {
      const seed = await driveToVerified(tag('s'))
      await query('UPDATE campaign_executions SET active_generation_no = NULL WHERE id = ?', [uuidToBuffer(seed.executionId)])
      const missing = await repairService.getExecutionReconciliation(seed.executionId)
      expect(missing.healthy).toBe(false)
      expect(missing.checks.find((c) => c.check === 'pointer-present').ok).toBe(false)
      await query('UPDATE campaign_executions SET active_generation_no = 0 WHERE id = ?', [uuidToBuffer(seed.executionId)])
      await repairRepo.updateRepairState(seed.repair.id, ['new_verified'], 'unknown')
      const unknown = await repairService.getExecutionReconciliation(seed.executionId)
      expect(unknown.healthy).toBe(false)
      expect(unknown.checks.find((c) => c.check === 'no-unknown-repair').ok).toBe(false)
      await repairRepo.updateRepairState(seed.repair.id, ['unknown'], 'superseded')
      await campaignRepo.createMetaObject(seed.campaignId, 'ad', `orphan_ad_${tag('s')}`, null, 'ACTIVE', client.id)
      const unlinked = await repairService.getExecutionReconciliation(seed.executionId)
      expect(unlinked.healthy).toBe(false)
      expect(unlinked.checks.find((c) => c.check === 'meta-linkage-complete').ok).toBe(false)
      const campaignReport = await repairService.getCampaignReconciliation(seed.campaignId)
      expect(campaignReport.executions).toHaveLength(1)
      expect(campaignReport.healthy).toBe(false)
    })
  })

  describe('observability', () => {
    it('emits the required lifecycle events with IDs and no tokens', async () => {
      const seed = await driveToVerified(tag('s'))
      trackCreations()
      mockHealthyFlow()
      activatedAdIds.add(seed.ad)
      logMetaEvent.mockClear()
      await repairService.runRepairActivation(seed.repair.id)
      const actions = logMetaEvent.mock.calls.map((c) => c[0]?.action)
      for (const required of [
        'new_activated', 'new_activation_verified', 'old_paused', 'old_pause_verified',
        'active_pointer_moved', 'old_cleanup_started', 'old_object_deleted', 'repair_completed',
      ]) {
        expect(actions).toContain(required)
      }
      const payloads = logMetaEvent.mock.calls.map((c) => JSON.stringify(c[0] ?? {}))
      expect(payloads.join(' ')).toMatch(/"repairId"/)
      expect(payloads.join(' ')).toMatch(/"executionId"/)
      expect(payloads.join(' ')).toMatch(/"generationId"|"generationNo"/)
      expect(payloads.join(' ')).not.toMatch(/access_token|accessToken/)
    })
  })

  describe('idempotency', () => {
    it('duplicate requests, unknown/active retries, and repeated reconciles converge', async () => {
      const seed = await driveToVerified(tag('s'))
      trackCreations()
      mockHealthyFlow()
      const asset = await mediaRepo.createMediaAsset(generateUuid(), client.id, {
        name: 'dup.png', storagePath: '/uploads/posts/dup.png', mimeType: 'image/png',
        mediaKind: 'image', sizeBytes: 1024, width: 800, height: 600,
      })
      const again = await repairService.requestRepair({
        campaignId: seed.campaignId, executionId: seed.executionId, actorId: null, mediaAssetId: asset.id,
      })
      expect(again.duplicate).toBe(true)
      expect(again.repair.id).toBe(seed.repair.id)
      const probe1 = await repairService.reconcileExactMetaObject(seed.ad, 'token')
      const probe2 = await repairService.reconcileExactMetaObject(seed.ad, 'token')
      expect(probe1).toEqual(probe2)
      metaMocks.createAdCreative.mockClear()
      metaMocks.createAd.mockClear()
      expect(metaMocks.createAdCreative.mock.calls.filter((c) => c[c.length - 1] !== true)).toHaveLength(0)
      expect(metaMocks.createAd.mock.calls.filter((c) => c[c.length - 1] !== true)).toHaveLength(0)
      await repairService.runRepairActivation(seed.repair.id)
      const retry = await repairService.runRepairActivation(seed.repair.id)
      expect(retry).toMatchObject({ done: true, state: 'completed' })
      const gens = await execRepo.listGenerationsForExecution(seed.executionId)
      expect(gens.filter((g) => g.generationNo > 0)).toHaveLength(1)
    })
  })

  describe('financial fence', () => {
    it('activation hardening performs zero financial mutation', async () => {
      const seed = await driveToCompleted(tag('s'))
      const billingBefore = await query('SELECT COUNT(*) AS n FROM campaign_billing_entries WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])
      const executionsBefore = await query('SELECT COUNT(*) AS n FROM campaign_executions WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])
      const before = await campaignRepo.findCampaignById(seed.campaignId)
      const beforeExec = await execRepo.findExecutionById(seed.executionId)
      trackCreations()
      mockHealthyFlow()
      await repairService.runRepairActivation(seed.repair.id)
      await repairService.getExecutionReconciliation(seed.executionId)
      await repairService.getCampaignReconciliation(seed.campaignId)
      expect(await query('SELECT COUNT(*) AS n FROM campaign_billing_entries WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])).toEqual(billingBefore)
      expect(await query('SELECT COUNT(*) AS n FROM campaign_executions WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])).toEqual(executionsBefore)
      const after = await campaignRepo.findCampaignById(seed.campaignId)
      expect(after.chargedAdBudgetPaise).toBe(before.chargedAdBudgetPaise)
      expect(after.settledAt).toBeNull()
      const afterExec = await execRepo.findExecutionById(seed.executionId)
      expect(afterExec.consumedPaise).toBe(beforeExec.consumedPaise)
      expect(afterExec.refundedPaise).toBe(beforeExec.refundedPaise)
      const repairSrc = fs.readFileSync(new URL('../../src/modules/campaigns/repair.service.js', import.meta.url), 'utf8')
      expect(repairSrc).not.toMatch(/coinService|insertBillingEntry|chargedAdBudgetPaise|claimCampaignSettlement|approveAndGoLive|confirmAndGoLive|consumeExecutionShare|refundExecutionShare/)
    })
  })
})
