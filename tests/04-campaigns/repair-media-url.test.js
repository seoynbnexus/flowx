import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import { loginAgent } from '../helpers/auth.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as execRepo from '../../src/modules/campaigns/campaign-execution.repository.js'
import * as repairRepo from '../../src/modules/campaigns/repair.repository.js'
import * as repairService from '../../src/modules/campaigns/repair.service.js'
import * as mediaRepo from '../../src/modules/media-library/media.repository.js'
import { freezeCampaignSnapshotFor } from '../../src/modules/campaigns/campaign-execution.service.js'
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

function fetchedOk(overrides = {}) {
  return {
    bytes: GOOD_PNG,
    truncated: false,
    contentType: 'image/png',
    statusCode: 200,
    finalUrl: 'https://cdn.example.com/fix.png',
    ...overrides,
  }
}

const dateTag = Date.now()
let seq = 0
function tag(prefix) {
  seq += 1
  return `${prefix}_${seq}_${generateUuid()}`
}

let app
let client
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

async function seedFixture(suffix) {
  const campaign = await campaignService.createCampaign(client.id, { name: `URL ${suffix}`, type: 'post' })
  campaignIds.push(campaign.id)
  await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'c', mediaUrl: 'https://example.com/old.png' })
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
      [uuidToBuffer(generateUuid()), uuidToBuffer(client.id), fbPlatform.id, 'https://fb.com/test', `fb_url_${suffix}`, 'UrlPage']
    )
  }
  const fb = `fb_url_${suffix}`
  const adset = `adset_url_${suffix}`
  const creative = `creative_url_${suffix}`
  const ad = `ad_url_${suffix}`
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
  return { campaignId: campaign.id, executionId }
}

describe('repair direct media URL (campaign parity)', () => {
  beforeAll(async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'test_system_user_token'
    process.env.META_AD_ACCOUNT_ID = 'act_test_account'
    client = await createTestUser({ email: `repair-url-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    const mod = await import('../../app.js')
    app = mod.default
    await setConfig('campaign_repair_rollout', 'admin_only')
    await setConfig('campaign_repair_execution_enabled', true)
  })

  afterAll(async () => {
    await setConfig('campaign_repair_rollout', undefined)
    await setConfig('campaign_repair_execution_enabled', undefined)
    await query("DELETE FROM campaign_jobs WHERE job_type = 'execution_repair'").catch(() => {})
    for (const id of campaignIds) {
      await query('DELETE FROM campaigns WHERE id = ?', [uuidToBuffer(id)]).catch(() => {})
    }
  })

  beforeEach(() => {
    urlFetchMock.mockReset()
    urlFetchMock.mockResolvedValue(fetchedOk())
  })

  it('stores the submitted URL verbatim with NULL asset id', async () => {
    const seed = await seedFixture(tag('s'))
    const submitted = 'https://cdn.example.com/fix.png?sig=abc123&x=1'
    const created = await repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null, mediaUrl: submitted,
    })
    expect(created.queued).toBe(true)
    const repair = await repairRepo.findRepairById(created.repair.id)
    expect(repair.mediaAssetId).toBeNull()
    expect(repair.mediaUrl).toBe(submitted)
    expect(repair.mediaWidth).toBe(800)
    expect(repair.mediaHeight).toBe(600)
  })

  it('rejects SSRF-blocked, non-image, truncated, and narrow URLs', async () => {
    const seed = await seedFixture(tag('s'))
    const blocked = new Error('Media URL host evil.local is a blocked address')
    blocked.code = 'MEDIA_SSRF_BLOCKED'
    urlFetchMock.mockRejectedValue(blocked)
    await expect(repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null, mediaUrl: 'http://evil.local/x.png',
    })).rejects.toThrow(/blocked address/)
    urlFetchMock.mockResolvedValue(fetchedOk({ bytes: Buffer.from('not an image'), contentType: 'text/html' }))
    await expect(repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null, mediaUrl: 'https://cdn.example.com/x.html',
    })).rejects.toThrow(/valid image/)
    urlFetchMock.mockResolvedValue(fetchedOk({ truncated: true }))
    await expect(repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null, mediaUrl: 'https://cdn.example.com/big.png',
    })).rejects.toThrow(/truncated/)
    urlFetchMock.mockResolvedValue(fetchedOk({ bytes: pngBuffer(400, 400) }))
    await expect(repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null, mediaUrl: 'https://cdn.example.com/small.png',
    })).rejects.toThrow(/500px/)
    expect(await repairRepo.listRepairsForExecution(seed.executionId)).toHaveLength(0)
  })

  it('schema enforces exactly one of mediaAssetId or mediaUrl', async () => {
    const seed = await seedFixture(tag('s'))
    const adminToken = await loginAgent(app, 'admin@flowx.com', 'Admin@123')
    const path = `/api/v1/admin/campaigns/${seed.campaignId}/executions/${seed.executionId}/repairs`
    const both = await supertest(app)
      .post(path)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mediaAssetId: generateUuid(), mediaUrl: 'https://cdn.example.com/fix.png' })
    expect(both.status).toBe(422)
    const neither = await supertest(app)
      .post(path)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    expect(neither.status).toBe(422)
    const preview = await supertest(app)
      .post(`/api/v1/admin/campaigns/${seed.campaignId}/executions/${seed.executionId}/repair-preview`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mediaUrl: 'https://cdn.example.com/fix.png' })
    expect(preview.status).toBe(200)
    expect(preview.body.data.ok).toBe(true)
    expect(preview.body.data.media.assetId).toBeNull()
    expect(preview.body.data.media.url).toBe('https://cdn.example.com/fix.png')
  })

  it('hard-rejects asset rows outside Facebook/Instagram criteria', async () => {
    const seed = await seedFixture(tag('s'))
    const bmp = await mediaRepo.createMediaAsset(generateUuid(), client.id, {
      name: 'photo.bmp', storagePath: '/uploads/posts/photo.bmp', mimeType: 'image/bmp',
      mediaKind: 'image', sizeBytes: 1024, width: 800, height: 600,
    })
    await expect(repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null, mediaAssetId: bmp.id,
    })).rejects.toThrow(/Facebook and Instagram ads accept JPEG, PNG, GIF, or WebP/i)
    const huge = await mediaRepo.createMediaAsset(generateUuid(), client.id, {
      name: 'huge.jpg', storagePath: '/uploads/posts/huge.jpg', mimeType: 'image/jpeg',
      mediaKind: 'image', sizeBytes: 31 * 1024 * 1024, width: 2000, height: 2000,
    })
    await expect(repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null, mediaAssetId: huge.id,
    })).rejects.toThrow(/cap ad images at 30 MB/i)
    expect(await repairRepo.listRepairsForExecution(seed.executionId)).toHaveLength(0)
  })

  it('worker re-probe fails closed on changed or vanished URLs', async () => {    const createdObjects = []
    metaMocks.getObjectStatus.mockImplementation((id) => Promise.resolve(
      createdObjects.some((o) => o.kind === 'ad' && o.id === id)
        ? { status: 'PAUSED', effective_status: 'ACTIVE', issues_info: [] }
        : { status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [{ level: 'AD', error_code: 2875006, error_summary: 's', error_message: 'm', error_type: 'HARD_ERROR' }] }
    ))
    metaMocks.listAdSetAds.mockImplementation((adsetId) => Promise.resolve({
      rows: createdObjects
        .filter((o) => o.kind === 'ad' && o.adsetId === adsetId)
        .map((o) => ({ id: o.id, name: o.name, status: 'PAUSED', effective_status: 'ACTIVE', creative: { id: o.creativeId } })),
      truncated: false,
    }))
    const baseCreative = metaMocks.createAdCreative.getMockImplementation()
    const baseAd = metaMocks.createAd.getMockImplementation()
    metaMocks.createAdCreative.mockImplementation((...args) => {
      const result = (baseCreative || (() => Promise.resolve({ id: `url_creative_${generateUuid()}` })))(...args)
      if (args[args.length - 1] !== true) {
        return result.then((created) => {
          createdObjects.push({ kind: 'creative', id: created.id, name: args[6]?.name || null })
          return created
        })
      }
      return result
    })
    metaMocks.createAd.mockImplementation((...args) => {
      const result = (baseAd || (() => Promise.resolve({ id: `url_ad_${generateUuid()}` })))(...args)
      if (args[args.length - 1] !== true) {
        return result.then((created) => {
          createdObjects.push({ kind: 'ad', id: created.id, name: args[3], creativeId: args[2], adsetId: args[1] })
          return created
        })
      }
      return result
    })

    await setConfig('campaign_repair_execution_enabled', false)
    const seed = await seedFixture(tag('s'))
    const created = await repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null,
      mediaUrl: 'https://cdn.example.com/fix.png',
    })
    const parked = await repairService.runRepairJob(created.repair.id)
    expect(parked).toMatchObject({ done: true, state: 'ready_for_creation' })
    await setConfig('campaign_repair_execution_enabled', true)

    urlFetchMock.mockResolvedValue(fetchedOk({ bytes: pngBuffer(700, 700) }))
    await repairService.runRepairCreation(created.repair.id)
    const changed = await repairRepo.findRepairById(created.repair.id)
    expect(changed.status).toBe('failed')
    expect(changed.error || '').toMatch(/replacement-media-changed:700x700/)
    expect(metaMocks.createAdCreative).not.toHaveBeenCalled()

    const seed2 = await seedFixture(tag('s'))
    const created2 = await repairService.requestRepair({
      campaignId: seed2.campaignId, executionId: seed2.executionId, actorId: null,
      mediaUrl: 'https://cdn.example.com/fix.png',
    })
    urlFetchMock.mockResolvedValue(fetchedOk())
    await setConfig('campaign_repair_execution_enabled', false)
    await repairService.runRepairJob(created2.repair.id)
    await setConfig('campaign_repair_execution_enabled', true)
    urlFetchMock.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
    await repairService.runRepairCreation(created2.repair.id)
    const gone = await repairRepo.findRepairById(created2.repair.id)
    expect(gone.status).toBe('failed')
    expect(gone.error || '').toMatch(/replacement-media-unavailable/)
  })
})
