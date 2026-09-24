import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as execRepo from '../../src/modules/campaigns/campaign-execution.repository.js'
import * as repairRepo from '../../src/modules/campaigns/repair.repository.js'
import * as repairService from '../../src/modules/campaigns/repair.service.js'
import { REPAIR_STATUS, assertValidRepairTransition } from '../../src/modules/campaigns/repair.model.js'
import { freezeCampaignSnapshotFor } from '../../src/modules/campaigns/campaign-execution.service.js'
import * as mediaRepo from '../../src/modules/media-library/media.repository.js'
import { processMetaWebhookEvents } from '../../src/modules/campaigns/meta-webhook.service.js'
import { getPool, query } from '../../shared/database/connection.js'
import migration092 from '../../shared/database/migrations/092_repair_activation_states.js'

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

function permanentError(message) {
  return new Error(`Graph API POST act_x/ads failed: ${JSON.stringify({ error: { message, code: 100, error_subcode: 1487472 } })}`)
}

const campaignIds = []
const createdObjects = []
let trackingActive = false
let statusTrackingActive = false
const activatedAdIds = new Set()

describe('repair activation and cutover (Phase 6)', () => {
  let client

  async function seedFixture(suffix) {
    const campaign = await campaignService.createCampaign(client.id, { name: `RepairCutover ${suffix}`, type: 'post' })
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
        [uuidToBuffer(generateUuid()), uuidToBuffer(client.id), fbPlatform.id, 'https://fb.com/test', `fb_cut_${suffix}`, 'CutPage']
      )
    }
    const fb = `fb_cut_${suffix}`
    const adset = `adset_cut_${suffix}`
    const creative = `creative_cut_${suffix}`
    const ad = `ad_cut_${suffix}`
    await campaignRepo.createMetaObject(campaign.id, 'facebook_campaign', fb, null, 'ACTIVE', client.id)
    await campaignRepo.createMetaObject(campaign.id, 'ad_set', adset, null, 'ACTIVE', client.id)
    await campaignRepo.createMetaObject(campaign.id, 'ad_creative', creative, null, null, client.id)
    await campaignRepo.createMetaObject(campaign.id, 'ad', ad, null, 'ACTIVE', client.id)
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

  async function driveToVerified(suffix) {
    const seed = await seedFixture(suffix)
    trackCreations()
    mockHealthyFlow()
    const out = await repairService.runRepairJob(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'new_verified' })
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

  beforeAll(async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'test_system_user_token'
    process.env.META_AD_ACCOUNT_ID = 'act_test_account'
    client = await createTestUser({ email: `repair-cut-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    await setRepairFlag(true)
    // driveToVerified relies on runRepairJob stopping exactly at
    // NEW_VERIFIED so each test can then drive its own specific
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
      : Promise.resolve({ id: `cut_creative_${generateUuid()}` }))
    metaMocks.createAd.mockImplementation((...args) => args[args.length - 1] === true
      ? Promise.resolve({})
      : Promise.resolve({ id: `cut_ad_${generateUuid()}` }))
    metaMocks.deleteAdCreative.mockResolvedValue({})
    metaMocks.deleteAd.mockResolvedValue({})
    metaMocks.updateAdStatus.mockResolvedValue({})
  })

  it('migration 092 extends the repair status enum idempotently', async () => {
    await migration092.up({ context: getPool() })
    await migration092.up({ context: getPool() })
    const rows = await query(
      "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaign_execution_repairs' AND COLUMN_NAME = 'status'"
    )
    for (const value of ['new_activating', 'new_active_verified', 'old_pausing', 'old_paused_verified', 'active_pointer_moved', 'old_cleanup']) {
      expect(String(rows[0].COLUMN_TYPE)).toContain(`'${value}'`)
    }
  })

  it('rejects invalid direct transitions in the model', () => {
    expect(() => assertValidRepairTransition('new_verified', 'completed')).toThrow(/invalid repair transition/i)
    expect(() => assertValidRepairTransition('new_verified', 'new_activating')).not.toThrow()
    expect(() => assertValidRepairTransition('old_cleanup', 'completed')).not.toThrow()
    expect(() => assertValidRepairTransition('completed', 'pending')).not.toThrow()
  })

  it('full cutover reaches COMPLETED with exact ordering and pointer 1', async () => {
    const seed = await driveToVerified(tag('s'))
    const gen1Before = (await execRepo.listGenerationsForExecution(seed.executionId)).find((g) => g.generationNo === 1)
    mockHealthyFlow()
    activatedAdIds.add(seed.ad)
    const issuesBefore = await campaignRepo.findMetaObjectIssuesByCampaignId(seed.campaignId)
    expect(issuesBefore.filter((i) => i.active && i.objectId === seed.ad)).toHaveLength(1)
    const out = await repairService.runRepairActivation(seed.repair.id)
    const diagRepair = await repairRepo.findRepairById(seed.repair.id)
    const diagGens = await execRepo.listGenerationsForExecution(seed.executionId)
    if (out.state !== 'completed') {
      expect(`DIAG state=${out.state} ignored=${out.ignored} repair=${diagRepair.status}/${diagRepair.error} gens=${JSON.stringify(diagGens.map((g) => [g.generationNo, g.status]))} calls=${JSON.stringify(metaMocks.updateAdStatus.mock.calls)}`).toBe('COMPLETED')
    }
    expect(out).toMatchObject({ done: true, state: 'completed' })
    const statusCalls = metaMocks.updateAdStatus.mock.calls.map((c) => [c[0], c[1]])
    expect(statusCalls).toEqual([[gen1Before.platformAdId, 'ACTIVE'], [seed.ad, 'PAUSED']])
    expect(metaMocks.deleteAd.mock.calls.map((c) => c[0])).toEqual([seed.ad])
    expect(metaMocks.deleteAdCreative.mock.calls.map((c) => c[0])).toEqual([seed.creative])
    const repair = await repairRepo.findRepairById(seed.repair.id)
    expect(repair.status).toBe('completed')
    const execution = await execRepo.findExecutionById(seed.executionId)
    expect(execution.activeGenerationNo).toBe(1)
    const gens = await execRepo.listGenerationsForExecution(seed.executionId)
    expect(gens.find((g) => g.generationNo === 1).status).toBe('active')
    expect(gens.find((g) => g.generationNo === 0).status).toBe('superseded')
    expect(gens.find((g) => g.generationNo === 0).platformAdId).toBe(seed.ad)
    expect((await campaignRepo.findMetaObjectByObjectId(seed.ad)).status).toBe('DELETED')
    const issuesAfter = await campaignRepo.findMetaObjectIssuesByCampaignId(seed.campaignId)
    expect(issuesAfter.filter((i) => i.active && i.objectId === seed.ad)).toHaveLength(0)
    expect(issuesAfter.find((i) => i.objectId === seed.ad && !i.active)?.clearedAt).toBeTruthy()
  })

  it('A. permanent activation failure leaves Gen-0 untouched', async () => {
    const seed = await driveToVerified(tag('s'))
    metaMocks.updateAdStatus.mockImplementationOnce(() => Promise.reject(permanentError('Cannot activate')))
    const out = await repairService.runRepairActivation(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'failed' })
    expect(metaMocks.updateAdStatus.mock.calls.map((c) => c[0]).filter((id) => id === seed.ad)).toHaveLength(0)
    expect((await execRepo.findExecutionById(seed.executionId)).activeGenerationNo).toBe(0)
  })

  it('B. ambiguous activation adopts the observed ACTIVE state without duplicating', async () => {
    const seed = await driveToVerified(tag('s'))
    const gen1 = (await execRepo.listGenerationsForExecution(seed.executionId)).find((g) => g.generationNo === 1)
    metaMocks.updateAdStatus.mockImplementationOnce(() => Promise.reject(new Error('socket hang up')))
    metaMocks.getObjectStatus.mockImplementation((id) => Promise.resolve(id === gen1.platformAdId
      ? { status: 'ACTIVE', effective_status: 'ACTIVE', issues_info: [] }
      : { status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006] }))
    const out = await repairService.runRepairActivation(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'completed' })
    expect(metaMocks.updateAdStatus.mock.calls.filter((c) => c[0] === gen1.platformAdId && c[1] === 'ACTIVE')).toHaveLength(0)
  })

  it('B2. ambiguous activation with still-PAUSED state becomes UNKNOWN', async () => {
    const seed = await driveToVerified(tag('s'))
    const gen1 = (await execRepo.listGenerationsForExecution(seed.executionId)).find((g) => g.generationNo === 1)
    let newAdReads = 0
    metaMocks.getObjectStatus.mockImplementation((id) => {
      if (id !== gen1.platformAdId) {
        return Promise.resolve({ status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006] })
      }
      newAdReads += 1
      return Promise.resolve(newAdReads <= 1
        ? { status: 'PAUSED', effective_status: 'ACTIVE', issues_info: [] }
        : { status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [] })
    })
    metaMocks.updateAdStatus.mockImplementationOnce(() => Promise.reject(new Error('socket hang up')))
    const out = await repairService.runRepairActivation(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'unknown' })
    expect((await execRepo.findExecutionById(seed.executionId)).activeGenerationNo).toBe(0)
  })

  it('C. blocking issue on read-back pauses the new ad back and never touches Gen-0', async () => {
    const seed = await driveToVerified(tag('s'))
    const gen1 = (await execRepo.listGenerationsForExecution(seed.executionId)).find((g) => g.generationNo === 1)
    let newAdReads = 0
    metaMocks.getObjectStatus.mockImplementation((id) => {
      if (id !== gen1.platformAdId) {
        return Promise.resolve({ status: 'ACTIVE', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006] })
      }
      newAdReads += 1
      return Promise.resolve(newAdReads <= 3
        ? { status: 'PAUSED', effective_status: 'ACTIVE', issues_info: [] }
        : { status: 'ACTIVE', effective_status: 'WITH_ISSUES', issues_info: [{ ...ISSUE_2875006, error_code: 9990001 }] })
    })
    const out = await repairService.runRepairActivation(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'failed' })
    const repair = await repairRepo.findRepairById(seed.repair.id)
    expect(repair.error).toMatch(/replacement-blocked-after-activation:9990001/)
    const pauseCalls = metaMocks.updateAdStatus.mock.calls.map((c) => [c[0], c[1]])
    expect(pauseCalls).toEqual([[gen1.platformAdId, 'ACTIVE'], [gen1.platformAdId, 'PAUSED']])
    expect((await execRepo.findExecutionById(seed.executionId)).activeGenerationNo).toBe(0)
  })

  it('D. old pause failure stops before the pointer move with the new ad left explicit', async () => {
    const seed = await driveToVerified(tag('s'))
    mockHealthyFlow()
    activatedAdIds.add(seed.ad)
    metaMocks.updateAdStatus.mockImplementation((...args) => {
      if (args[1] === 'ACTIVE') activatedAdIds.add(args[0])
      if (args[1] === 'PAUSED' && args[0] !== seed.ad) activatedAdIds.delete(args[0])
      if (args[0] === seed.ad) return Promise.reject(permanentError('Cannot pause'))
      return Promise.resolve({})
    })
    const out = await repairService.runRepairActivation(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'failed' })
    expect((await repairRepo.findRepairById(seed.repair.id)).error).toMatch(/pause-old/)
    expect((await execRepo.findExecutionById(seed.executionId)).activeGenerationNo).toBe(0)
  })

  it('E. concurrent pointer moves converge with exactly one winner', async () => {
    const seed = await driveToVerified(tag('s'))
    const results = await Promise.all([
      execRepo.moveActiveGeneration(seed.executionId, 0, 1),
      execRepo.moveActiveGeneration(seed.executionId, 0, 1),
    ])
    expect(results.reduce((sum, n) => sum + n, 0)).toBe(1)
    await query('UPDATE campaign_executions SET active_generation_no = 0 WHERE id = ?', [uuidToBuffer(seed.executionId)])
  })

  it('F. cleanup failure keeps Gen-1 authoritative without moving the pointer back', async () => {
    const seed = await driveToVerified(tag('s'))
    metaMocks.deleteAd.mockImplementation(() => Promise.reject(new Error('socket hang up')))
    const out = await repairService.runRepairActivation(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'old_cleanup', retryable: true })
    expect((await execRepo.findExecutionById(seed.executionId)).activeGenerationNo).toBe(1)
    expect((await execRepo.findGenerationByExecutionIdAndNumber(seed.executionId, 1)).status).toBe('active')
    metaMocks.deleteAd.mockResolvedValue({})
    const retry = await repairService.runRepairActivation(seed.repair.id)
    expect(retry).toMatchObject({ done: true, state: 'completed' })
  })

  it('G. crash after activation resumes from observed ACTIVE state', async () => {
    const seed = await driveToVerified(tag('s'))
    const gen1 = (await execRepo.listGenerationsForExecution(seed.executionId)).find((g) => g.generationNo === 1)
    await repairRepo.updateRepairState(seed.repair.id, ['new_verified'], 'new_activating')
    metaMocks.getObjectStatus.mockImplementation((id) => Promise.resolve(id === gen1.platformAdId
      ? { status: 'ACTIVE', effective_status: 'ACTIVE', issues_info: [] }
      : { status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006] }))
    metaMocks.listAdSetAds.mockImplementation(() => Promise.resolve({
      rows: [{ id: gen1.platformAdId, name: 'x', status: 'ACTIVE', effective_status: 'ACTIVE', creative: { id: gen1.platformCreativeId } }],
      truncated: false,
    }))
    const out = await repairService.runRepairActivation(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'completed' })
    expect(metaMocks.updateAdStatus.mock.calls.filter((c) => c[0] === gen1.platformAdId && c[1] === 'ACTIVE')).toHaveLength(0)
  })

  it('H. crash after old pause resumes without re-pausing or recreating', async () => {
    const seed = await driveToVerified(tag('s'))
    await repairRepo.updateRepairState(seed.repair.id, ['new_verified'], 'old_pausing')
    metaMocks.createAdCreative.mockClear()
    metaMocks.createAd.mockClear()
    const out = await repairService.runRepairActivation(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'completed' })
    expect(metaMocks.updateAdStatus.mock.calls.filter((c) => c[0] === seed.ad && c[1] === 'PAUSED')).toHaveLength(0)
    expect(metaMocks.createAdCreative.mock.calls.filter((c) => c[c.length - 1] !== true)).toHaveLength(0)
    expect(metaMocks.createAd.mock.calls.filter((c) => c[c.length - 1] !== true)).toHaveLength(0)
  })

  it('I. crash after pointer move resumes cleanup only', async () => {
    const seed = await driveToVerified(tag('s'))
    await execRepo.moveActiveGeneration(seed.executionId, 0, 1)
    await execRepo.updateGenerationState(
      (await execRepo.listGenerationsForExecution(seed.executionId)).find((g) => g.generationNo === 1).id,
      ['verified'], 'active'
    )
    await execRepo.updateGenerationState(
      (await execRepo.listGenerationsForExecution(seed.executionId)).find((g) => g.generationNo === 0).id,
      ['active'], 'superseded'
    )
    await repairRepo.updateRepairState(seed.repair.id, ['new_verified'], 'active_pointer_moved')
    metaMocks.createAdCreative.mockClear()
    metaMocks.createAd.mockClear()
    const out = await repairService.runRepairActivation(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'completed' })
    expect(metaMocks.updateAdStatus).not.toHaveBeenCalled()
    expect(metaMocks.createAdCreative.mock.calls.filter((c) => c[c.length - 1] !== true)).toHaveLength(0)
  })

  it('J. sequential duplicate runs converge with single mutations', async () => {
    const seed = await driveToVerified(tag('s'))
    trackCreations()
    mockHealthyFlow()
    const first = await repairService.runRepairActivation(seed.repair.id)
    expect(first).toMatchObject({ done: true, state: 'completed' })
    metaMocks.updateAdStatus.mockClear()
    metaMocks.deleteAd.mockClear()
    metaMocks.deleteAdCreative.mockClear()
    const second = await repairService.runRepairActivation(seed.repair.id)
    expect(second).toMatchObject({ done: true, state: 'completed' })
    expect(metaMocks.updateAdStatus).not.toHaveBeenCalled()
    expect(metaMocks.deleteAd).not.toHaveBeenCalled()
    expect(metaMocks.deleteAdCreative).not.toHaveBeenCalled()
    const gens = await execRepo.listGenerationsForExecution(seed.executionId)
    expect(gens.filter((g) => g.generationNo > 0)).toHaveLength(1)
  })

  it('K. retry after COMPLETED performs zero Meta calls', async () => {
    const seed = await driveToVerified(tag('s'))
    trackCreations()
    mockHealthyFlow()
    await repairService.runRepairActivation(seed.repair.id)
    for (const fn of ['getObjectStatus', 'getMetaObject', 'listAdSetAds', 'listAccountCreatives', 'createAdCreative', 'createAd', 'deleteAdCreative', 'deleteAd', 'updateAdStatus']) {
      metaMocks[fn].mockClear()
    }
    const out = await repairService.runRepairActivation(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'completed' })
    for (const fn of ['getObjectStatus', 'getMetaObject', 'listAdSetAds', 'createAdCreative', 'createAd', 'deleteAdCreative', 'deleteAd', 'updateAdStatus']) {
      expect(metaMocks[fn]).not.toHaveBeenCalled()
    }
  })

  it('pre-flight refuses terminal, settled, drifted, rotated, and version-mismatched contexts', async () => {
    const terminal = await driveToVerified(tag('s'))
    await execRepo.updateExecution(terminal.executionId, { status: 'cancelled' })
    expect(await repairService.runRepairActivation(terminal.repair.id)).toMatchObject({ done: true, state: 'failed' })

    const settled = await driveToVerified(tag('s'))
    await campaignRepo.claimCampaignSettlement(settled.campaignId)
    expect(await repairService.runRepairActivation(settled.repair.id)).toMatchObject({ done: true, state: 'failed' })
    await campaignRepo.releaseCampaignSettlement(settled.campaignId)

    const drifted = await driveToVerified(tag('s'))
    await campaignRepo.createMetaSettings(generateUuid(), drifted.campaignId, {
      objective: 'OUTCOME_TRAFFIC', budgetAmount: 10000,
      targeting: { geo_locations: { countries: ['US'] } },
      platformPlacement: { publisher_platforms: ['facebook', 'instagram'] },
    })
    const driftOut = await repairService.runRepairActivation(drifted.repair.id)
    expect(driftOut).toMatchObject({ done: true, state: 'failed' })
    expect((await repairRepo.findRepairById(drifted.repair.id)).error).toMatch(/snapshot-diff/)

    const rotated = await driveToVerified(tag('s'))
    await execRepo.updateExecution(rotated.executionId, { fbPageId: 'rotated_page_999' })
    expect(await repairService.runRepairActivation(rotated.repair.id)).toMatchObject({ done: true, state: 'failed' })

    const versioned = await driveToVerified(tag('s'))
    await query("UPDATE campaigns SET resolved_graph_version = 'v22.0' WHERE id = ?", [uuidToBuffer(versioned.campaignId)])
    const versionOut = await repairService.runRepairActivation(versioned.repair.id)
    expect(versionOut).toMatchObject({ done: true, state: 'failed' })
    expect((await repairRepo.findRepairById(versioned.repair.id)).error).toMatch(/snapshot-version-mismatch/)
  })

  it('cleanup skips a creative still referenced by another ad and still completes', async () => {
    const seed = await driveToVerified(tag('s'))
    trackCreations()
    mockHealthyFlow()
    const gen1 = (await execRepo.listGenerationsForExecution(seed.executionId)).find((g) => g.generationNo === 1)
    metaMocks.listAdSetAds.mockImplementation(() => Promise.resolve({
      rows: [
        ...createdObjects.filter((o) => o.kind === 'ad').map((o) => ({ id: o.id, name: o.name, status: 'PAUSED', effective_status: 'ACTIVE', creative: { id: o.creativeId } })),
        { id: 'other_ad_9', name: 'Other', status: 'ACTIVE', effective_status: 'ACTIVE', creative: { id: seed.creative } },
      ],
      truncated: false,
    }))
    const out = await repairService.runRepairActivation(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'completed' })
    expect(metaMocks.deleteAd.mock.calls.map((c) => c[0])).toContain(seed.ad)
    expect(metaMocks.deleteAdCreative.mock.calls.map((c) => c[0])).not.toContain(seed.creative)
    void gen1
  })

  it('L + readers: post-cutover sync, webhooks, governor, and lookup follow Gen-1', async () => {
    const seed = await driveToVerified(tag('s'))
    trackCreations()
    mockHealthyFlow()
    await repairService.runRepairActivation(seed.repair.id)
    const gens = await execRepo.listGenerationsForExecution(seed.executionId)
    const gen1 = gens.find((g) => g.generationNo === 1)
    // campaign_meta_objects rows for gen1's creative+ad are now written by
    // the repair path itself (emitObjectEvent -> appendExecutionObjectAudit,
    // see the M. test below) — no manual insert needed here any more.

    metaMocks.listAccountAds.mockResolvedValue({
      rows: [
        { id: gen1.platformAdId, status: 'ACTIVE', effective_status: 'ACTIVE', issues_info: [] },
        { id: seed.ad, status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006] },
      ],
      truncated: true,
    })
    await campaignService.syncAccountStatusJob('act_test_account')
    expect((await campaignRepo.findCampaignById(seed.campaignId)).metaStatus).toBe('active')

    const oldEvent = {
      object: 'ad_account',
      entry: [{ id: `entry_old_${tag('s')}`, time: Math.floor(Date.now() / 1000), changes: [
        { field: 'ad.delivery_signals', value: { ad_id: seed.ad, campaign_id: seed.fb, status: 'ACTIVE' } },
      ] }],
    }
    const oldOutcome = await processMetaWebhookEvents(oldEvent)
    expect(JSON.stringify(oldOutcome)).toMatch(/historical-generation/)
    expect((await campaignRepo.findCampaignById(seed.campaignId)).metaStatus).toBe('active')

    const newEvent = {
      object: 'ad_account',
      entry: [{ id: `entry_new_${tag('s')}`, time: Math.floor(Date.now() / 1000), changes: [
        { field: 'ad.delivery_signals', value: { ad_id: gen1.platformAdId, campaign_id: seed.fb, status: 'PAUSED' } },
      ] }],
    }
    await processMetaWebhookEvents(newEvent)
    expect((await campaignRepo.findCampaignById(seed.campaignId)).metaStatus).toBe('paused')

    expect((await execRepo.findExecutionByMetaId(seed.ad)).id).toBe(seed.executionId)
    expect((await execRepo.findExecutionByMetaId(gen1.platformAdId)).id).toBe(seed.executionId)
    expect((await execRepo.findGenerationByMetaId(seed.ad)).generationNo).toBe(0)
    expect((await execRepo.findGenerationByMetaId(gen1.platformAdId)).generationNo).toBe(1)
  })

  // Regression for a production bug found live on campaign A-5: a completed
  // repair advanced campaign_execution_generations to the new creative/ad,
  // and old_cleanup correctly marked the Gen-0 objects DELETED in
  // campaign_meta_objects — but nothing ever wrote a row for the NEW
  // objects there. findActiveSyncAd/findActiveSyncAds filter
  // campaign_meta_objects rows against the generation index, so with no row
  // matching the now-active generation's ad id, syncCampaignStatusJob /
  // syncAccountStatusJob's campaign-level batch check had nothing to check
  // and silently stopped syncing forever — campaigns.meta_status/meta_error
  // stayed frozen on the pre-repair issue even though Meta had long since
  // cleared it. Unlike the 'L' test above, this one takes ZERO manual
  // campaign_meta_objects shortcuts — it proves the repair path itself now
  // dual-writes those rows (via emitObjectEvent -> appendExecutionObjectAudit).
  it('M. repair completion alone (no manual campaign_meta_objects insert) lets status sync find and clear the new ad', async () => {
    const seed = await driveToVerified(tag('s'))
    trackCreations()
    mockHealthyFlow()
    const out = await repairService.runRepairActivation(seed.repair.id)
    expect(out).toMatchObject({ done: true, state: 'completed' })

    const gens = await execRepo.listGenerationsForExecution(seed.executionId)
    const gen1 = gens.find((g) => g.generationNo === 1)

    const rows = await query(
      'SELECT object_type, object_id, status FROM campaign_meta_objects WHERE campaign_id = ? AND object_id IN (?, ?)',
      [uuidToBuffer(seed.campaignId), gen1.platformCreativeId, gen1.platformAdId]
    )
    const byType = Object.fromEntries(rows.map((r) => [r.object_type, r]))
    expect(byType.ad_creative?.object_id).toBe(gen1.platformCreativeId)
    expect(byType.ad?.object_id).toBe(gen1.platformAdId)

    const oldRows = await query(
      'SELECT status FROM campaign_meta_objects WHERE campaign_id = ? AND object_id = ?',
      [uuidToBuffer(seed.campaignId), seed.ad]
    )
    expect(oldRows[0].status).toBe('DELETED')

    metaMocks.getObjectStatus.mockResolvedValue({ status: 'PAUSED', effective_status: 'PAUSED', issues_info: [] })
    const synced = await campaignService.syncCampaignStatusJob(seed.campaignId)
    expect(synced.success).toBe(true)

    const campaign = await campaignRepo.findCampaignById(seed.campaignId)
    expect(campaign.metaStatus).toBe('paused')
    expect(campaign.metaError).toBeFalsy()
  })

  it('financial fence holds across activation, cutover, and cleanup', async () => {
    const seed = await driveToVerified(tag('s'))
    trackCreations()
    mockHealthyFlow()
    const billingBefore = await query('SELECT COUNT(*) AS n FROM campaign_billing_entries WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])
    const executionsBefore = await query('SELECT COUNT(*) AS n FROM campaign_executions WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])
    const before = await campaignRepo.findCampaignById(seed.campaignId)
    const beforeExec = await execRepo.findExecutionById(seed.executionId)
    await repairService.runRepairActivation(seed.repair.id)
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
