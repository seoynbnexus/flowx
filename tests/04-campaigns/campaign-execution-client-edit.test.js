import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as execRepo from '../../src/modules/campaigns/campaign-execution.repository.js'
import * as repairRepo from '../../src/modules/campaigns/repair.repository.js'
import * as repairService from '../../src/modules/campaigns/repair.service.js'
import { freezeCampaignSnapshotFor } from '../../src/modules/campaigns/campaign-execution.service.js'
import { diffSnapshotForContentAmendment } from '../../src/modules/campaigns/repair.snapshot.js'
import { query } from '../../shared/database/connection.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    listAccountAds: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    getObjectStatus: vi.fn(),
    getMetaObject: vi.fn().mockResolvedValue({ id: 'x' }),
    getCampaignStatusesBatch: vi.fn().mockResolvedValue({}),
    getAdAccount: vi.fn().mockResolvedValue({}),
    listAccountCreatives: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    listAdSetAds: vi.fn(),
    createAdCreative: vi.fn(),
    createAd: vi.fn(),
    deleteAdCreative: vi.fn().mockResolvedValue({}),
    deleteAd: vi.fn().mockResolvedValue({}),
    updateAdStatus: vi.fn().mockResolvedValue({}),
  }
  metaMocks = mocks
  return mocks
})

var urlFetchMock
vi.mock('../../shared/services/media-url.js', async () => {
  const actual = await vi.importActual('../../shared/services/media-url.js')
  urlFetchMock = vi.fn()
  return { ...actual, fetchBoundedBytes: (...args) => urlFetchMock(...args) }
})

function pngBuffer(width, height) {
  const bytes = Buffer.alloc(29)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

const GOOD_PNG = pngBuffer(800, 600)

const dateTag = Date.now()
let seq = 0
function tag(prefix) {
  seq += 1
  return `${prefix}_${seq}_${generateUuid()}`
}

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

function mockCreatedFlow() {
  metaMocks.createAdCreative.mockClear()
  metaMocks.createAd.mockClear()
  const createdAds = []
  // Tracks the live status of ANY ad this test's mocks are asked about —
  // both newly-created replacement ads (start PAUSED, may be activated)
  // and the pre-existing "old" ad from the fixture (starts ACTIVE, gets
  // paused during cutover). Ads never explicitly transitioned default to
  // ACTIVE, matching a normal healthy pre-existing ad.
  const adStatus = new Map()
  metaMocks.getObjectStatus.mockImplementation((id) => Promise.resolve({
    status: adStatus.get(id) || 'ACTIVE',
    effective_status: 'ACTIVE',
    issues_info: [],
  }))
  metaMocks.listAdSetAds.mockImplementation((adsetId) => Promise.resolve({
    rows: createdAds
      .filter((o) => o.adsetId === adsetId)
      .map((o) => ({ id: o.id, name: o.name, status: adStatus.get(o.id) || 'PAUSED', effective_status: 'ACTIVE', creative: { id: o.creativeId } })),
    truncated: false,
  }))
  metaMocks.createAdCreative.mockImplementation(() => Promise.resolve({ id: `edit_creative_${generateUuid()}` }))
  metaMocks.createAd.mockImplementation((...args) => {
    const created = { id: `edit_ad_${generateUuid()}` }
    if (args[args.length - 1] !== true) {
      createdAds.push({ id: created.id, name: args[3], creativeId: args[2], adsetId: args[1] })
      adStatus.set(created.id, 'PAUSED')
    }
    return Promise.resolve(created)
  })
  metaMocks.updateAdStatus.mockImplementation((id, status) => {
    adStatus.set(id, status)
    return Promise.resolve({})
  })
  return createdAds
}

let client, publisher1, publisher2
const campaignIds = []

async function seedFailedLiveCampaign(suffix, { creative = {} } = {}) {
  const campaign = await campaignService.createCampaign(client.id, { name: `ClientEdit ${suffix}`, type: 'post' })
  campaignIds.push(campaign.id)
  await campaignRepo.createCreative(generateUuid(), campaign.id, {
    caption: 'original caption', mediaUrl: 'https://example.com/original.jpg', callToAction: 'LEARN_MORE', ...creative,
  })
  await campaignService.saveMetaSettings(client.id, campaign.id, {
    objective: 'OUTCOME_TRAFFIC', budgetAmount: 10000,
    targeting: { geo_locations: { countries: ['IN'] } },
    platformPlacement: { publisher_platforms: ['facebook', 'instagram'] },
  })
  const fbPlatform = await query("SELECT id FROM platforms WHERE code = 'facebook' LIMIT 1").then((r) => r[0])
  if (fbPlatform) {
    await query(
      `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id, platform_username, token_type, token_expires_at, verification_status)
       VALUES (?, ?, ?, ?, ?, ?, 'page', DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
      [uuidToBuffer(generateUuid()), uuidToBuffer(client.id), fbPlatform.id, 'https://fb.com/test', `fb_edit_${suffix}`, 'EditPage']
    )
  }
  const fb = `fb_edit_${suffix}`
  const adset = `adset_edit_${suffix}`
  const creativeId = `creative_edit_${suffix}`
  const ad = `ad_edit_${suffix}`
  await campaignRepo.createMetaObject(campaign.id, 'facebook_campaign', fb, null, 'ACTIVE', client.id)
  await campaignRepo.createMetaObject(campaign.id, 'ad_set', adset, null, 'ACTIVE', client.id)
  await campaignRepo.createMetaObject(campaign.id, 'ad_creative', creativeId, null, null, client.id)
  await campaignRepo.createMetaObject(campaign.id, 'ad', ad, null, 'DISAPPROVED', client.id)
  const executionId = await execRepo.createExecution({
    campaignId: campaign.id, ownerUserId: client.id, kind: 'client', status: 'active',
    platformCampaignId: fb, platformAdsetId: adset, platformCreativeId: creativeId, platformAdId: ad,
  })
  await freezeCampaignSnapshotFor(campaign.id)
  await campaignRepo.updateCampaignStatus(campaign.id, 'failed')
  await campaignRepo.updateCampaign(campaign.id, { metaStatus: 'failed', metaError: 'Ad disapproved by Meta' })
  return { campaignId: campaign.id, executionId, ad, adset, fb, creativeId }
}

// Mirrors a publisher who accepted the campaign and got their own,
// independent Meta chain built from the SAME shared creative (this is the
// publisherCount model: every accepted publisher runs the identical
// caption/media the client configured, on their own page/ad account).
async function addPublisherExecution(campaignId, publisherId, suffix) {
  const fbPlatform = await query("SELECT id FROM platforms WHERE code = 'facebook' LIMIT 1").then((r) => r[0])
  if (fbPlatform) {
    await query(
      `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id, platform_username, token_type, token_expires_at, verification_status)
       VALUES (?, ?, ?, ?, ?, ?, 'page', DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
      [uuidToBuffer(generateUuid()), uuidToBuffer(publisherId), fbPlatform.id, 'https://fb.com/pub', `fb_pub_${suffix}`, 'PubPage']
    )
  }
  const fb = `fb_pub_${suffix}`
  const adset = `adset_pub_${suffix}`
  const creativeId = `creative_pub_${suffix}`
  const ad = `ad_pub_${suffix}`
  await campaignRepo.createMetaObject(campaignId, 'facebook_campaign', fb, null, 'ACTIVE', publisherId)
  await campaignRepo.createMetaObject(campaignId, 'ad_set', adset, null, 'ACTIVE', publisherId)
  await campaignRepo.createMetaObject(campaignId, 'ad_creative', creativeId, null, null, publisherId)
  await campaignRepo.createMetaObject(campaignId, 'ad', ad, null, 'DISAPPROVED', publisherId)
  const executionId = await execRepo.createExecution({
    campaignId, ownerUserId: publisherId, kind: 'publisher', status: 'active',
    platformCampaignId: fb, platformAdsetId: adset, platformCreativeId: creativeId, platformAdId: ad,
  })
  return { executionId, ad, adset, fb, creativeId }
}

describe('client-initiated creative amendment on a FAILED live campaign', () => {
  beforeAll(async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'test_system_user_token'
    process.env.META_AD_ACCOUNT_ID = 'act_test_account'
    client = await createTestUser({ email: `client-edit-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    publisher1 = await createTestUser({ email: `client-edit-pub1-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    publisher2 = await createTestUser({ email: `client-edit-pub2-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    await setConfig('campaign_repair_rollout', 'enabled')
    await setConfig('campaign_repair_execution_enabled', true)
    await setConfig('campaign_repair_category_client_edit', true)
    urlFetchMock.mockResolvedValue({
      bytes: GOOD_PNG, truncated: false, contentType: 'image/png', statusCode: 200, finalUrl: 'https://example.com/original.jpg',
    })
  })

  afterAll(async () => {
    // backfillExecutionGenerations (088, a one-time migration helper also
    // exercised directly by campaign-execution-generations.test.js) scans
    // ALL of campaign_executions unscoped and throws if any execution's
    // active_generation_no != 0 without an exact-matching Generation 0 —
    // a pre-generation-system assumption that predates repairs ever moving
    // the active pointer. Every repair test file that leaves such rows
    // around (including this one, and any real repaired execution) can
    // trip that unrelated file's tests if it runs afterward. Clean up
    // fully rather than leave any repaired execution in the shared DB.
    await setConfig('campaign_repair_rollout', undefined)
    await setConfig('campaign_repair_execution_enabled', undefined)
    await setConfig('campaign_repair_category_client_edit', undefined)
    await query("DELETE FROM campaign_jobs WHERE job_type = 'execution_repair'").catch(() => {})
    for (const id of campaignIds) {
      await query('DELETE FROM campaigns WHERE id = ?', [uuidToBuffer(id)]).catch(() => {})
    }
  })

  it('rejects the amendment when the client-edit category flag is off', async () => {
    await setConfig('campaign_repair_category_client_edit', false)
    const seed = await seedFailedLiveCampaign(tag('s'))
    await expect(
      campaignService.requestClientCreativeAmendment(client.id, seed.campaignId, { caption: 'new caption' })
    ).rejects.toThrow(/not enabled/i)
    await setConfig('campaign_repair_category_client_edit', true)
  })

  it('rejects when the campaign is not in failed status', async () => {
    const campaign = await campaignService.createCampaign(client.id, { name: `NotFailed ${tag('s')}`, type: 'post' })
    campaignIds.push(campaign.id)
    await expect(
      campaignService.requestClientCreativeAmendment(client.id, campaign.id, { caption: 'x' })
    ).rejects.toThrow(/must be in failed status/i)
  })

  it('rejects when there is no live Meta chain to amend', async () => {
    const campaign = await campaignService.createCampaign(client.id, { name: `NoChain ${tag('s')}`, type: 'post' })
    campaignIds.push(campaign.id)
    await campaignRepo.updateCampaignStatus(campaign.id, 'failed')
    await expect(
      campaignService.requestClientCreativeAmendment(client.id, campaign.id, { caption: 'x' })
    ).rejects.toThrow(/no live meta chain/i)
  })

  it('runs the full creative amendment end to end: new ad built, old ad untouched by direct writes, campaign resumes to paused', async () => {
    const createdAdIds = mockCreatedFlow()
    const seed = await seedFailedLiveCampaign(tag('s'))

    const result = await campaignService.requestClientCreativeAmendment(client.id, seed.campaignId, {
      caption: 'fixed caption', callToAction: 'SHOP_NOW',
    })
    expect(result.queued).toBe(true)
    expect(result.owners).toHaveLength(1)
    expect(result.owners[0].kind).toBe('client')
    expect(result.owners[0].queued).toBe(true)

    const repair = await repairRepo.findRepairById(result.owners[0].repairId)
    expect(repair.errorCode).toBe('CLIENT_EDIT')
    expect(repair.amendmentCreative).toMatchObject({ caption: 'fixed caption', callToAction: 'SHOP_NOW' })

    const out = await repairService.runRepairJob(repair.id)
    expect(out).toMatchObject({ done: true, state: 'completed' })

    const creativeCall = metaMocks.createAdCreative.mock.calls.find((args) => args[args.length - 1] !== true)
    expect(creativeCall[2]).toBe('fixed caption')
    expect(creativeCall[4]).toBe('SHOP_NOW')

    const campaign = await campaignRepo.findCampaignById(seed.campaignId)
    expect(campaign.status).toBe('paused')

    expect(createdAdIds.length).toBe(1)
  })

  it('a repair stuck at new_verified (e.g. from before this fix existed) is picked back up and completed by a fresh runRepairJob call (regression: activation was never wired into any production trigger)', async () => {
    mockCreatedFlow()
    const seed = await seedFailedLiveCampaign(tag('s'))
    const result = await campaignService.requestClientCreativeAmendment(client.id, seed.campaignId, { caption: 'stuck then resumed' })
    const repairId = result.owners[0].repairId

    // Land the repair at READY_FOR_CREATION without running creation at
    // all, by disabling the execution flag first.
    await setConfig('campaign_repair_execution_enabled', false)
    const staged = await repairService.runRepairJob(repairId)
    expect(staged).toMatchObject({ done: true, state: 'ready_for_creation' })
    await setConfig('campaign_repair_execution_enabled', true)

    // Call runRepairCreation directly (bypassing runRepairJob's chaining
    // wrapper) to reproduce exactly the pre-fix world: creation succeeds
    // and reaches new_verified, but nothing ever calls runRepairActivation
    // — the real repairs found stuck in production were built and
    // verified on Meta, never actually cut over.
    const created = await repairService.runRepairCreation(repairId)
    expect(created).toMatchObject({ done: true, state: 'new_verified' })

    // A later, independent runRepairJob call (e.g. a retried job, or an
    // operator re-triggering the same repair id) must finish the cutover
    // via the dispatch fix, not just re-run creation or silently ignore it.
    const resumed = await repairService.runRepairJob(repairId)
    expect(resumed).toMatchObject({ done: true, state: 'completed' })

    const campaign = await campaignRepo.findCampaignById(seed.campaignId)
    expect(campaign.status).toBe('paused')
  })

  it('a campaign with N accepted publishers rebuilds every owner\'s ad from ONE client submission (shared creative, per-owner isolation)', async () => {
    const createdAds = mockCreatedFlow()
    const suffix = tag('s')
    const seed = await seedFailedLiveCampaign(suffix)
    const pub1 = await addPublisherExecution(seed.campaignId, publisher1.id, `${suffix}_p1`)
    const pub2 = await addPublisherExecution(seed.campaignId, publisher2.id, `${suffix}_p2`)

    const result = await campaignService.requestClientCreativeAmendment(client.id, seed.campaignId, {
      caption: 'fixed for everyone', callToAction: 'SHOP_NOW',
    })
    expect(result.queued).toBe(true)
    expect(result.owners).toHaveLength(3)
    expect(result.owners.filter((o) => o.queued)).toHaveLength(3)
    expect(result.owners.filter((o) => o.kind === 'client')).toHaveLength(1)
    expect(result.owners.filter((o) => o.kind === 'publisher')).toHaveLength(2)
    // Every owner gets its OWN repair row — never a shared/collapsed one.
    expect(new Set(result.owners.map((o) => o.repairId)).size).toBe(3)

    for (const owner of result.owners) {
      const out = await repairService.runRepairJob(owner.repairId)
      expect(out).toMatchObject({ done: true, state: 'completed' })
    }

    // Each owner's OWN execution now points at its OWN newly-built ad,
    // and each new creative carries the SAME shared amendment.
    for (const execId of [seed.executionId, pub1.executionId, pub2.executionId]) {
      const gens = await execRepo.listGenerationsForExecution(execId)
      const active = gens.find((g) => g.status === 'active')
      expect(active).toBeTruthy()
      expect(active.generationNo).toBeGreaterThan(0)
    }
    expect(createdAds.length).toBe(3)
    const creativeCalls = metaMocks.createAdCreative.mock.calls.filter((args) => args[args.length - 1] !== true)
    expect(creativeCalls).toHaveLength(3)
    for (const call of creativeCalls) {
      expect(call[2]).toBe('fixed for everyone')
      expect(call[4]).toBe('SHOP_NOW')
    }

    const campaign = await campaignRepo.findCampaignById(seed.campaignId)
    expect(campaign.status).toBe('paused')
  })

  it('duplicate submission before completion converges on one repair row (no double-build)', async () => {
    mockCreatedFlow()
    const seed = await seedFailedLiveCampaign(tag('s'))
    const first = await campaignService.requestClientCreativeAmendment(client.id, seed.campaignId, { caption: 'v1' })
    const second = await campaignService.requestClientCreativeAmendment(client.id, seed.campaignId, { caption: 'v2' })
    expect(second.owners[0].repairId).toBe(first.owners[0].repairId)
    expect(second.owners[0].duplicate).toBe(true)
  })

  it('a second repair on an execution whose first repair already went active builds generation 2 (regression: generation-1-active bug)', async () => {
    const createdAdIds = mockCreatedFlow()
    const seed = await seedFailedLiveCampaign(tag('s'))

    // Simulate a PRIOR, already-completed repair: gen0 (original, now
    // superseded) + gen1 (that repair's replacement, now active and
    // pointed at by the execution) — exactly the live-observed state that
    // made a second repair's own generation-numbering collide with it.
    const gen0Id = await execRepo.createGeneration({
      executionId: seed.executionId, generationNo: 0, status: 'superseded',
      platformCampaignId: seed.fb, platformAdsetId: seed.adset,
      platformCreativeId: 'old_creative', platformAdId: 'old_ad',
    })
    await execRepo.createGeneration({
      executionId: seed.executionId, generationNo: 1, status: 'active',
      platformCampaignId: seed.fb, platformAdsetId: seed.adset,
      platformCreativeId: seed.creativeId, platformAdId: seed.ad,
    })
    await execRepo.updateExecution(seed.executionId, { activeGenerationNo: 1 })
    expect(gen0Id).toBeTruthy()

    const result = await campaignService.requestClientCreativeAmendment(client.id, seed.campaignId, {
      caption: 'second fix',
    })
    expect(result.queued).toBe(true)
    const repair = await repairRepo.findRepairById(result.owners[0].repairId)
    expect(repair.generationNo).toBe(1)

    const out = await repairService.runRepairJob(repair.id)
    expect(out).toMatchObject({ done: true, state: 'completed' })

    const gens = await execRepo.listGenerationsForExecution(seed.executionId)
    const gen2 = gens.find((g) => g.generationNo === 2)
    expect(gen2).toBeTruthy()
    expect(gen2.status).toBe('active')
    const oldGen1 = gens.find((g) => g.generationNo === 1)
    expect(oldGen1.status).toBe('superseded')
    expect(createdAdIds.length).toBe(1)
  })

  it('a new repair skips a dead, abandoned generation left by a completely different failed attempt instead of adopting its stale ad (regression: replacement-ad-identity-unverifiable)', async () => {
    const createdAdIds = mockCreatedFlow()
    const seed = await seedFailedLiveCampaign(tag('s'))

    // Execution is still on generation 0 (active) — but a PRIOR, unrelated
    // repair attempt already tried and failed, leaving generation 1
    // sitting there dead/abandoned, pointing at an ad that no longer
    // reliably resolves on Meta. This is exactly the live-observed state:
    // execution.active_generation_no stayed 0 the whole time.
    await execRepo.createGeneration({
      executionId: seed.executionId, generationNo: 1, status: 'failed',
      platformCampaignId: seed.fb, platformAdsetId: seed.adset,
      platformCreativeId: 'abandoned_creative', platformAdId: 'abandoned_ad',
    })

    const result = await campaignService.requestClientCreativeAmendment(client.id, seed.campaignId, {
      caption: 'fix around the dead generation',
    })
    const repair = await repairRepo.findRepairById(result.owners[0].repairId)
    // Baseline is still generation 0 — the dead generation 1 was never the
    // execution's active one, so ensureGenerationZero correctly ignores it.
    expect(repair.generationNo).toBe(0)

    const out = await repairService.runRepairJob(repair.id)
    expect(out).toMatchObject({ done: true, state: 'completed' })

    const gens = await execRepo.listGenerationsForExecution(seed.executionId)
    // A genuinely NEW generation 2 was created — the dead generation 1
    // was correctly skipped, not adopted, and stays exactly as it was.
    const gen2 = gens.find((g) => g.generationNo === 2)
    expect(gen2).toBeTruthy()
    expect(gen2.status).toBe('active')
    expect(gen2.platformAdId).not.toBe('abandoned_ad')
    const deadGen1 = gens.find((g) => g.generationNo === 1)
    expect(deadGen1.status).toBe('failed')
    expect(deadGen1.platformAdId).toBe('abandoned_ad')
    expect(createdAdIds.length).toBe(1)
  })

  it('financial fence: amendment writes no billing entries and spends no coins', async () => {
    mockCreatedFlow()
    const seed = await seedFailedLiveCampaign(tag('s'))
    const before = await query('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(client.id)])
    const result = await campaignService.requestClientCreativeAmendment(client.id, seed.campaignId, { caption: 'fixed' })
    await repairService.runRepairJob(result.owners[0].repairId)
    const after = await query('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(client.id)])
    expect(after[0]?.coins).toBe(before[0]?.coins)
    const billing = await query('SELECT * FROM campaign_billing_entries WHERE campaign_id = ?', [uuidToBuffer(seed.campaignId)])
    expect(billing).toHaveLength(0)
  })
})

describe('diffSnapshotForContentAmendment', () => {
  const frozenConfig = {
    campaign: { name: 'c' },
    settings: { budgetAmount: 100 },
    creative: { caption: 'old', callToAction: 'LEARN_MORE', mediaUrl: 'https://x/old.jpg' },
  }

  it('accepts an amendment restricted to declared creative fields', () => {
    const result = diffSnapshotForContentAmendment({
      frozenConfig, liveConfig: frozenConfig, amendment: { caption: 'new' },
    })
    expect(result.ok).toBe(true)
    expect(result.config.creative.caption).toBe('new')
    expect(result.config.creative.callToAction).toBe('LEARN_MORE')
  })

  it('fails closed on an empty amendment', () => {
    const result = diffSnapshotForContentAmendment({ frozenConfig, liveConfig: frozenConfig, amendment: {} })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('empty-amendment')
  })

  it('fails closed when the live campaign/settings section drifted from frozen', () => {
    const liveConfig = { ...frozenConfig, settings: { budgetAmount: 999 } }
    const result = diffSnapshotForContentAmendment({ frozenConfig, liveConfig, amendment: { caption: 'new' } })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('drift:settings')
  })

  it('fails closed when the live creative already drifted from frozen outside the amendment mechanism', () => {
    const liveConfig = { ...frozenConfig, creative: { ...frozenConfig.creative, headline: 'tampered' } }
    const result = diffSnapshotForContentAmendment({ frozenConfig, liveConfig, amendment: { caption: 'new' } })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('drift:creative')
  })
})
