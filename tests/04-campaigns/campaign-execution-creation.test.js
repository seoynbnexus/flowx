import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import { loginAgent } from '../helpers/auth.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as execRepo from '../../src/modules/campaigns/campaign-execution.repository.js'
import * as repairRepo from '../../src/modules/campaigns/repair.repository.js'
import * as repairService from '../../src/modules/campaigns/repair.service.js'
import { buildRepairCreativeName, buildRepairAdName } from '../../src/modules/campaigns/repair.model.js'
import { freezeCampaignSnapshotFor } from '../../src/modules/campaigns/campaign-execution.service.js'
import { diffSnapshotForMediaRepair } from '../../src/modules/campaigns/repair.snapshot.js'
import * as mediaRepo from '../../src/modules/media-library/media.repository.js'
import { query } from '../../shared/database/connection.js'

var metaMocks
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
    updateAdStatus: vi.fn(() => { throw new Error('updateAdStatus must not run in repair creation tests') }),
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

const ISSUE_2875006 = {
  level: 'AD',
  error_code: 2875006,
  error_summary: 'Media not wide enough',
  error_message: "Media not wide enough: Your ad won't run on Instagram.",
  error_type: 'HARD_ERROR',
}

function missingObjectError(objectId) {
  return new Error(`Graph API GET ${objectId} failed: ${JSON.stringify({ error: { message: '(#100) Object does not exist', code: 100, error_subcode: 33 } })}`)
}

let app
const campaignIds = []
const createdObjects = []

describe('repair execution creation (Phase 5)', () => {
  let client
  let partner

  async function seedFixture(suffix) {
    const campaign = await campaignService.createCampaign(client.id, { name: `RepairExec ${suffix}`, type: 'post' })
    campaignIds.push(campaign.id)
    await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'frozen caption', mediaUrl: 'https://example.com/old.png' })
    await campaignService.saveMetaSettings(client.id, campaign.id, {
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
        [uuidToBuffer(generateUuid()), uuidToBuffer(client.id), fbPlatform.id, 'https://fb.com/test', `fb_exec5_${suffix}`, 'ExecPage']
      )
    }
    const fb = `fb_exec5_${suffix}`
    const adset = `adset_exec5_${suffix}`
    const creative = `creative_exec5_${suffix}`
    const ad = `ad_exec5_${suffix}`
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
      summary: 'Media not wide enough', message: "Won't run on Instagram.", errorType: 'HARD_ERROR',
    })
    await campaignRepo.updateCampaignStatus(campaign.id, 'running')
    await freezeCampaignSnapshotFor(campaign.id)
    const asset = await mediaRepo.createMediaAsset(generateUuid(), client.id, {
      name: 'fix.png', storagePath: `/uploads/posts/fix-${suffix}.png`, mimeType: 'image/png',
      mediaKind: 'image', sizeBytes: 1024, width: 800, height: 600,
    })
    const requested = await repairService.requestRepair({
      campaignId: campaign.id, executionId, actorId: null, mediaAssetId: asset.id,
    })
    return { campaignId: campaign.id, executionId, fb, adset, creative, ad, asset, repair: requested.repair }
  }

  function mockHealthyFlow() {
    metaMocks.getObjectStatus.mockImplementation((id) => Promise.resolve(
      createdObjects.some((o) => o.kind === 'ad' && o.id === id)
        ? { status: 'PAUSED', effective_status: 'ACTIVE', issues_info: [] }
        : { status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006] }
    ))
    metaMocks.listAdSetAds.mockImplementation((adsetId) => Promise.resolve({
      rows: createdObjects
        .filter((o) => o.kind === 'ad' && o.adsetId === adsetId)
        .map((o) => ({ id: o.id, name: o.name, status: 'PAUSED', effective_status: 'ACTIVE', creative: { id: o.creativeId } })),
      truncated: false,
    }))
  }

  function trackCreations() {
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

  async function generationOne(executionId) {
    const gens = await execRepo.listGenerationsForExecution(executionId)
    return gens.find((g) => g.generationNo === 1) || null
  }

  beforeAll(async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'test_system_user_token'
    process.env.META_AD_ACCOUNT_ID = 'act_test_account'
    client = await createTestUser({ email: `repair-exec-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    partner = await createTestUser({ email: `repair-exec-partner-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    const mod = await import('../../app.js')
    app = mod.default
    await setRepairFlag(true)
    // This file deliberately tests the CREATION phase in isolation
    // (updateAdStatus is asserted to never fire — see the mock at the top
    // of this file). Production always chains creation -> activation via
    // runRepairJob; opt out here only, and restore it so later files in
    // the same vitest run keep the real, chained behavior.
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
    for (const fn of ['getObjectStatus', 'getMetaObject', 'listAdSetAds', 'listAccountCreatives', 'createAdCreative', 'createAd', 'deleteAdCreative', 'deleteAd', 'listAccountAds', 'updateAdStatus']) {
      metaMocks[fn].mockClear()
    }
    metaMocks.getObjectStatus.mockResolvedValue({ status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006] })
    metaMocks.getMetaObject.mockResolvedValue({ id: 'x' })
    metaMocks.listAdSetAds.mockResolvedValue({ rows: [], truncated: false })
    metaMocks.listAccountCreatives.mockResolvedValue({ rows: [], truncated: false })
    metaMocks.createAdCreative.mockImplementation((...args) => args[args.length - 1] === true
      ? Promise.resolve({})
      : Promise.resolve({ id: `gen1_creative_${generateUuid()}` }))
    metaMocks.createAd.mockImplementation((...args) => args[args.length - 1] === true
      ? Promise.resolve({})
      : Promise.resolve({ id: `gen1_ad_${generateUuid()}` }))
    metaMocks.deleteAdCreative.mockResolvedValue({})
    metaMocks.deleteAd.mockResolvedValue({})
    metaMocks.updateAdStatus.mockImplementation(() => { throw new Error('updateAdStatus must not run in repair creation tests') })
  })

  it('flag OFF parks the worker at READY_FOR_CREATION with zero Meta creation', async () => {
    const seed = await seedFixture(tag('s'))
    await setRepairFlag(false)
    const first = await repairService.runRepairJob(seed.repair.id)
    expect(first).toMatchObject({ done: true, state: 'ready_for_creation' })
    const second = await repairService.runRepairJob(seed.repair.id)
    expect(second).toMatchObject({ done: true, gated: true })
    expect((await repairRepo.findRepairById(seed.repair.id)).status).toBe('ready_for_creation')
    expect(metaMocks.createAdCreative).not.toHaveBeenCalled()
    expect(metaMocks.createAd).not.toHaveBeenCalled()
    await setRepairFlag(true)
  })

  it('full creation run reaches NEW_VERIFIED with Gen 1 staging and pointer still 0', async () => {
    const seed = await seedFixture(tag('s'))
    trackCreations()
    mockHealthyFlow()
    const out = await repairService.runRepairJob(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'new_verified' })
    expect((await repairRepo.findRepairById(seed.repair.id)).status).toBe('new_verified')
    const gens = await execRepo.listGenerationsForExecution(seed.executionId)
    expect(gens).toHaveLength(2)
    const gen1 = gens.find((g) => g.generationNo === 1)
    expect(gen1.status).toBe('verified')
    expect(gen1.platformCampaignId).toBe(seed.fb)
    expect(gen1.platformAdsetId).toBe(seed.adset)
    const createdCreative = createdObjects.find((o) => o.kind === 'creative')
    const createdAd = createdObjects.find((o) => o.kind === 'ad')
    expect(gen1.platformCreativeId).toBe(createdCreative.id)
    expect(gen1.platformAdId).toBe(createdAd.id)
    expect(createdAd.creativeId).toBe(createdCreative.id)
    expect(createdAd.adsetId).toBe(seed.adset)
    const gen0 = gens.find((g) => g.generationNo === 0)
    expect(gen0).toMatchObject({
      status: 'active', platformCampaignId: seed.fb, platformAdsetId: seed.adset,
      platformCreativeId: seed.creative, platformAdId: seed.ad,
    })
    const execution = await execRepo.findExecutionById(seed.executionId)
    expect(execution.activeGenerationNo).toBe(0)
    expect(execution.platformAdId).toBe(seed.ad)
  })

  it('uses corrected media with frozen copy fields and validates before creating', async () => {
    const seed = await seedFixture(tag('s'))
    trackCreations()
    mockHealthyFlow()
    await repairService.runRepairJob(seed.repair.id)
    const creativeCalls = metaMocks.createAdCreative.mock.calls
    const validates = creativeCalls.filter((c) => c[c.length - 1] === true)
    const creates = creativeCalls.filter((c) => c[c.length - 1] !== true)
    expect(validates.length).toBeGreaterThanOrEqual(1)
    expect(creates).toHaveLength(1)
    expect(creates[0][3]).toBe(seed.repair.mediaUrl)
    expect(creates[0][2]).toBe('frozen caption')
    const extra = creates[0][6]
    expect(extra.name).toBe(buildRepairCreativeName(seed.repair.id, 1))
    expect(extra.headline).toBeNull()
    const adCalls = metaMocks.createAd.mock.calls
    const adValidates = adCalls.filter((c) => c[c.length - 1] === true)
    const adCreates = adCalls.filter((c) => c[c.length - 1] !== true)
    expect(adValidates.length).toBeGreaterThanOrEqual(1)
    expect(adCreates).toHaveLength(1)
    expect(adCreates[0][1]).toBe(seed.adset)
    expect(adCreates[0][3]).toBe(buildRepairAdName(seed.repair.id, 1))
    expect(adCreates[0][5]).toBe('PAUSED')
  })

  it('persists the amended snapshot without touching the frozen one', async () => {
    const seed = await seedFixture(tag('s'))
    trackCreations()
    mockHealthyFlow()
    const frozenBefore = await campaignRepo.findCampaignSnapshot(seed.campaignId)
    await repairService.runRepairJob(seed.repair.id)
    const frozenAfter = await campaignRepo.findCampaignSnapshot(seed.campaignId)
    expect(frozenAfter.hash).toBe(frozenBefore.hash)
    expect(frozenAfter.config.creative.mediaUrl).toBe('https://example.com/old.png')
    const repair = await repairRepo.findRepairById(seed.repair.id)
    expect(repair.status).toBe('new_verified')
    const row = await query('SELECT amended_config, amended_config_hash FROM campaign_execution_repairs WHERE id = ?', [uuidToBuffer(seed.repair.id)]).then((r) => r[0])
    expect(row.amended_config_hash).toBeTruthy()
    const amended = typeof row.amended_config === 'string' ? JSON.parse(row.amended_config) : row.amended_config
    expect(amended.creative.mediaUrl).toBe(repair.mediaUrl)
    const recomputed = diffSnapshotForMediaRepair({ frozenConfig: frozenBefore.config, liveConfig: frozenBefore.config, amendment: { mediaUrl: repair.mediaUrl } })
    expect(recomputed.ok).toBe(true)
    expect(recomputed.hash).toBe(row.amended_config_hash)
  })

  it('adopts the creative after a creation timeout without duplicating', async () => {
    const seed = await seedFixture(tag('s'))
    trackCreations()
    mockHealthyFlow()
    const expectedName = buildRepairCreativeName(seed.repair.id, 1)
    let creativeAttempted = false
    metaMocks.createAdCreative.mockImplementation((...args) => {
      if (args[args.length - 1] === true) return Promise.resolve({})
      if (!creativeAttempted) {
        creativeAttempted = true
        return Promise.reject(new Error('socket hang up'))
      }
      const id = `gen1_creative_${generateUuid()}`
      createdObjects.push({ kind: 'creative', id, name: args[6]?.name || null })
      return Promise.resolve({ id })
    })
    metaMocks.listAccountCreatives.mockImplementation(() => Promise.resolve(creativeAttempted
      ? { rows: [{ id: 'adopted_creative_1', name: expectedName, object_story_spec: { link_data: { link: seed.repair.mediaUrl } } }], truncated: false }
      : { rows: [], truncated: false }))
    const out = await repairService.runRepairJob(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'new_verified' })
    expect(metaMocks.createAdCreative.mock.calls.filter((c) => c[c.length - 1] !== true)).toHaveLength(1)
    expect((await generationOne(seed.executionId)).platformCreativeId).toBe('adopted_creative_1')
    const adCreates = metaMocks.createAd.mock.calls.filter((c) => c[c.length - 1] !== true)
    expect(adCreates).toHaveLength(1)
    expect(adCreates[0][2]).toBe('adopted_creative_1')
  })

  it('marks UNKNOWN when creation is ambiguous with no recoverable candidate', async () => {
    const seed = await seedFixture(tag('s'))
    metaMocks.createAdCreative.mockImplementation((...args) => args[args.length - 1] === true
      ? Promise.resolve({})
      : Promise.reject(new Error('socket hang up')))
    metaMocks.listAccountCreatives.mockResolvedValue({ rows: [], truncated: false })
    const out = await repairService.runRepairJob(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'unknown' })
    expect((await repairRepo.findRepairById(seed.repair.id)).status).toBe('unknown')
  })

  it('fails closed on ambiguous duplicates', async () => {
    const seed = await seedFixture(tag('s'))
    const expectedName = buildRepairCreativeName(seed.repair.id, 1)
    metaMocks.createAdCreative.mockImplementation((...args) => args[args.length - 1] === true
      ? Promise.resolve({})
      : Promise.reject(new Error('socket hang up')))
    metaMocks.listAccountCreatives.mockResolvedValue({
      rows: [
        { id: 'dup_a', name: expectedName, object_story_spec: {} },
        { id: 'dup_b', name: expectedName, object_story_spec: {} },
      ],
      truncated: false,
    })
    const out = await repairService.runRepairJob(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'failed' })
    const repair = await repairRepo.findRepairById(seed.repair.id)
    expect(repair.error).toMatch(/ambiguous/)
  })

  it('creative reconcile tolerates Meta-appended name suffixes when the spec matches', async () => {
    const seed = await seedFixture(tag('s'))
    const expectedName = buildRepairCreativeName(seed.repair.id, 1)
    metaMocks.listAccountCreatives.mockResolvedValue({
      rows: [{
        id: 'suffixed_creative_1',
        name: `${expectedName} 2026-09-20-3e86c536dffcfb7a4ec97b45dbb7eb8c`,
        object_story_spec: { page_id: 'p1', link_data: { link: seed.repair.mediaUrl } },
      }],
      truncated: false,
    })
    expect(await repairService.findRepairCreative({
      adAccountId: 'act_test_account', accessToken: 'token', name: expectedName,
      link: seed.repair.mediaUrl, pageId: 'p1',
    })).toMatchObject({ outcome: 'found', id: 'suffixed_creative_1' })
    expect(await repairService.findRepairCreative({
      adAccountId: 'act_test_account', accessToken: 'token', name: expectedName,
      link: seed.repair.mediaUrl, pageId: 'unrelated-page',
    })).toMatchObject({ outcome: 'absent' })
    expect(await repairService.findRepairCreative({
      adAccountId: 'act_test_account', accessToken: 'token', name: 'Totally Different Name',
      link: seed.repair.mediaUrl, pageId: 'p1',
    })).toMatchObject({ outcome: 'absent' })
  })

  it('rolls back staging objects on permanent ad failure without touching Gen 0', async () => {
    const seed = await seedFixture(tag('s'))
    trackCreations()
    mockHealthyFlow()
    metaMocks.createAd.mockImplementation((...args) => args[args.length - 1] === true
      ? Promise.resolve({})
      : Promise.reject(new Error(`Graph API POST act_x/ads failed: ${JSON.stringify({ error: { message: 'Invalid parameter', code: 100, error_subcode: 1487472 } })}`)))
    const out = await repairService.runRepairJob(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'failed' })
    const stagingCreative = createdObjects.find((o) => o.kind === 'creative').id
    expect(metaMocks.deleteAdCreative.mock.calls.map((c) => c[0])).toContain(stagingCreative)
    expect(metaMocks.deleteAd).not.toHaveBeenCalled()
    const gens = await execRepo.listGenerationsForExecution(seed.executionId)
    expect(gens.find((g) => g.generationNo === 0).platformAdId).toBe(seed.ad)
    expect(gens.find((g) => g.generationNo === 1).status).toBe('failed')
  })

  it('adopts the ad after a creation timeout via the parent adset listing', async () => {
    const seed = await seedFixture(tag('s'))
    trackCreations()
    let adAttempted = false
    metaMocks.createAd.mockImplementation((...args) => {
      if (args[args.length - 1] === true) return Promise.resolve({})
      adAttempted = true
      return Promise.reject(new Error('socket hang up'))
    })
    const adName = buildRepairAdName(seed.repair.id, 1)
    metaMocks.getObjectStatus.mockImplementation((id) => Promise.resolve(id === 'adopted_ad_7'
      ? { status: 'PAUSED', effective_status: 'ACTIVE', issues_info: [] }
      : { status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006] }))
    metaMocks.listAdSetAds.mockImplementation(() => {
      const creative = createdObjects.filter((o) => o.kind === 'creative').at(-1)
      if (!adAttempted || !creative) return Promise.resolve({ rows: [], truncated: false })
      return Promise.resolve({
        rows: [{ id: 'adopted_ad_7', name: adName, status: 'PAUSED', effective_status: 'ACTIVE', creative: { id: creative.id } }],
        truncated: false,
      })
    })
    const out = await repairService.runRepairJob(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'new_verified' })
    expect(metaMocks.createAd.mock.calls.filter((c) => c[c.length - 1] !== true)).toHaveLength(1)
    expect((await generationOne(seed.executionId)).platformAdId).toBe('adopted_ad_7')
  })

  it('resumes a crashed creative step without re-creating the creative', async () => {
    const seed = await seedFixture(tag('s'))
    trackCreations()
    mockHealthyFlow()
    const genId = await execRepo.createGeneration({
      executionId: seed.executionId, generationNo: 1, status: 'creating',
      platformCampaignId: seed.fb, platformAdsetId: seed.adset,
      platformCreativeId: 'crashed_creative_9', platformAdId: null,
    })
    const out = await repairService.runRepairJob(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'new_verified' })
    expect(metaMocks.createAdCreative.mock.calls.filter((c) => c[c.length - 1] !== true)).toHaveLength(0)
    const gens = await execRepo.listGenerationsForExecution(seed.executionId)
    expect(gens.filter((g) => g.generationNo === 1)).toHaveLength(1)
    expect(gens.find((g) => g.id === genId).platformCreativeId).toBe('crashed_creative_9')
  })

  it('second worker run is a no-op and creates no Generation 2', async () => {
    const seed = await seedFixture(tag('s'))
    trackCreations()
    mockHealthyFlow()
    await repairService.runRepairJob(seed.repair.id)
    const second = await repairService.runRepairJob(seed.repair.id)
    expect(second).toMatchObject({ done: true, ignored: 'repair-status-new_verified' })
    expect(metaMocks.createAdCreative.mock.calls.filter((c) => c[c.length - 1] !== true)).toHaveLength(1)
    expect(metaMocks.createAd.mock.calls.filter((c) => c[c.length - 1] !== true)).toHaveLength(1)
    const gens = await execRepo.listGenerationsForExecution(seed.executionId)
    expect(gens.filter((g) => g.generationNo > 0)).toHaveLength(1)
  })

  it('fails closed on drift, terminal execution, settled campaign, rotated context, and version drift', async () => {
    const drift = await seedFixture(tag('s'))
    await campaignRepo.createMetaSettings(generateUuid(), drift.campaignId, {
      objective: 'OUTCOME_TRAFFIC', budgetAmount: 10000,
      targeting: { geo_locations: { countries: ['US'] } },
      platformPlacement: { publisher_platforms: ['facebook', 'instagram'] },
    })
    expect(await repairService.runRepairJob(drift.repair.id)).toMatchObject({ done: true, state: 'failed' })
    expect((await repairRepo.findRepairById(drift.repair.id)).error).toMatch(/snapshot-diff/)

    const terminal = await seedFixture(tag('s'))
    await execRepo.updateExecution(terminal.executionId, { status: 'cancelled' })
    expect(await repairService.runRepairJob(terminal.repair.id)).toMatchObject({ done: true, state: 'failed' })

    const settled = await seedFixture(tag('s'))
    await campaignRepo.claimCampaignSettlement(settled.campaignId)
    expect(await repairService.runRepairJob(settled.repair.id)).toMatchObject({ done: true, state: 'failed' })
    await campaignRepo.releaseCampaignSettlement(settled.campaignId)

    const rotated = await seedFixture(tag('s'))
    await execRepo.updateExecution(rotated.executionId, { fbPageId: 'rotated_page_999' })
    expect(await repairService.runRepairJob(rotated.repair.id)).toMatchObject({ done: true, state: 'failed' })

    const versioned = await seedFixture(tag('s'))
    await query("UPDATE campaigns SET resolved_graph_version = 'v22.0' WHERE id = ?", [uuidToBuffer(versioned.campaignId)])
    expect(await repairService.runRepairJob(versioned.repair.id)).toMatchObject({ done: true, state: 'failed' })
    expect((await repairRepo.findRepairById(versioned.repair.id)).error).toMatch(/snapshot-version-mismatch/)
  })

  it('fails closed on a conflicting mid-creation repair for the same ad', async () => {
    const seed = await seedFixture(tag('s'))
    await repairRepo.createRepair({
      executionId: seed.executionId, generationNo: 0, objectId: seed.ad, creativeId: seed.creative,
      errorCode: '1234567', status: 'ready_for_creation',
    })
    expect(await repairService.runRepairJob(seed.repair.id)).toMatchObject({ done: true, state: 'failed' })
    expect((await repairRepo.findRepairById(seed.repair.id)).error).toMatch(/conflicting-repair/)
  })

  it('verify blocks a replacement that still reports 2875006', async () => {
    const seed = await seedFixture(tag('s'))
    trackCreations()
    metaMocks.getObjectStatus.mockResolvedValue({
      status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006],
    })
    metaMocks.listAdSetAds.mockImplementation(() => Promise.resolve({
      rows: createdObjects
        .filter((o) => o.kind === 'ad')
        .map((o) => ({ id: o.id, name: o.name, status: 'PAUSED', effective_status: 'WITH_ISSUES', creative: { id: o.creativeId } })),
      truncated: false,
    }))
    const out = await repairService.runRepairJob(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'failed' })
    expect((await repairRepo.findRepairById(seed.repair.id)).error).toMatch(/issue-persists:2875006/)
  })

  it('generation-aware sync, webhook, governor, reconcile, and lookup stay correct', async () => {
    const seed = await seedFixture(tag('s'))
    trackCreations()
    mockHealthyFlow()
    await repairService.runRepairJob(seed.repair.id)
    const gens = await execRepo.listGenerationsForExecution(seed.executionId)
    const gen1 = gens.find((g) => g.generationNo === 1)
    await campaignRepo.createMetaObject(seed.campaignId, 'ad_creative', gen1.platformCreativeId, null, null, client.id)
    await campaignRepo.createMetaObject(seed.campaignId, 'ad', gen1.platformAdId, null, 'ACTIVE', client.id)

    metaMocks.listAccountAds.mockResolvedValue({
      rows: [
        { id: seed.ad, status: 'PAUSED', effective_status: 'ACTIVE', issues_info: [] },
        { id: gen1.platformAdId, status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006] },
      ],
      truncated: true,
    })
    await campaignService.syncAccountStatusJob('act_test_account')
    const campaign = await campaignRepo.findCampaignById(seed.campaignId)
    expect(campaign.metaStatus).toBe('active')
    expect((await campaignRepo.findMetaObjectByObjectId(gen1.platformAdId)).status).toBe('ACTIVE')

    const { findForeignTracker } = await import('../../src/modules/campaigns/campaign.service.js')
    expect(await findForeignTracker(gen1.platformAdId, seed.campaignId, client.id)).toMatchObject({ tracked: true })
    expect(await findForeignTracker(seed.ad, seed.campaignId, client.id)).toMatchObject({ tracked: false })
    expect((await execRepo.findExecutionByMetaId(seed.ad)).id).toBe(seed.executionId)
    expect((await execRepo.findExecutionByMetaId(gen1.platformAdId)).id).toBe(seed.executionId)

    const accountId = generateUuid()
    await query(
      'INSERT INTO meta_ad_accounts (id, account_id, name, monthly_cap_paise, is_primary, status) VALUES (?, ?, ?, ?, ?, ?)',
      [uuidToBuffer(accountId), `act_gov_${tag('s')}`, 'gov-test', 1, 0, 'active']
    )
    try {
      await query('UPDATE campaigns SET ad_account_id = ?, charged_ad_budget_paise = 50000 WHERE id = ?', [uuidToBuffer(accountId), uuidToBuffer(seed.campaignId)])
      const { enforceAccountBudgetCap } = await import('../../src/modules/campaigns/campaign.service.js')
      const capped = await enforceAccountBudgetCap({ id: accountId, metaAccountId: 'act_test_account', monthlyCapPaise: 1, name: 't' })
      expect(capped.atCap).toBe(true)
      const pausedCalls = metaMocks.updateAdStatus.mock.calls.map((c) => c[0])
      expect(pausedCalls).toContain(seed.ad)
      expect(pausedCalls).not.toContain(gen1.platformAdId)
    } finally {
      await query('UPDATE campaigns SET ad_account_id = NULL, charged_ad_budget_paise = 0 WHERE id = ?', [uuidToBuffer(seed.campaignId)]).catch(() => {})
      await query('DELETE FROM meta_ad_accounts WHERE id = ?', [uuidToBuffer(accountId)]).catch(() => {})
      await query('DELETE FROM meta_sync_state WHERE run_key = ? OR run_key = ?', [`cap_alert:${accountId}`, `cap_pause:${accountId}`]).catch(() => {})
    }
  })

  it('financial fence holds across the full creation run', async () => {
    const seed = await seedFixture(tag('s'))
    trackCreations()
    mockHealthyFlow()
    const billingBefore = await query('SELECT COUNT(*) AS n FROM campaign_billing_entries WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])
    const executionsBefore = await query('SELECT COUNT(*) AS n FROM campaign_executions WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])
    const chargedBefore = (await campaignRepo.findCampaignById(seed.campaignId)).chargedAdBudgetPaise
    await repairService.runRepairJob(seed.repair.id)
    expect(await query('SELECT COUNT(*) AS n FROM campaign_billing_entries WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])).toEqual(billingBefore)
    expect(await query('SELECT COUNT(*) AS n FROM campaign_executions WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])).toEqual(executionsBefore)
    expect((await campaignRepo.findCampaignById(seed.campaignId)).chargedAdBudgetPaise).toBe(chargedBefore)
    expect((await campaignRepo.findCampaignById(seed.campaignId)).settledAt).toBeNull()
    const repairSrc = fs.readFileSync(new URL('../../src/modules/campaigns/repair.service.js', import.meta.url), 'utf8')
    expect(repairSrc).not.toMatch(/coinService|insertBillingEntry|chargedAdBudgetPaise|claimCampaignSettlement|approveAndGoLive|confirmAndGoLive|consumeExecutionShare|refundExecutionShare/)
  })
})
