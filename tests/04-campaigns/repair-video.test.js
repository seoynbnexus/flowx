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
import { freezeCampaignSnapshotFor } from '../../src/modules/campaigns/campaign-execution.service.js'
import { VIDEO_DIMENSION_ISSUE_CODES } from '../../shared/services/meta-issue-catalog.js'
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
    deleteAdVideo: vi.fn().mockResolvedValue({}),
    updateAdStatus: vi.fn().mockResolvedValue({}),
    uploadRepairVideoFromUrl: vi.fn().mockResolvedValue({ videoId: 'mock_video' }),
    waitForAdVideoReady: vi.fn().mockResolvedValue({ video_status: 'ready' }),
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

function box(type, body) {
  const b = Buffer.alloc(8 + body.length)
  b.writeUInt32BE(8 + body.length, 0)
  b.write(type, 4, 'ascii')
  body.copy(b, 8)
  return b
}

function u32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n, 0)
  return b
}

function u16(n) {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n, 0)
  return b
}

function validMp4({ duration = 15000, timescale = 1000, width = 1080, height = 1920, codec = 'avc1' } = {}) {
  const matrix = Buffer.alloc(36)
  matrix.writeInt32BE(0x10000, 0)
  matrix.writeInt32BE(0x10000, 20)
  const mvhd = box('mvhd', Buffer.concat([
    u32(0), u32(0), u32(0), u32(timescale), u32(duration), u32(0x10000), u16(0x100), u16(0),
    Buffer.alloc(8), matrix, Buffer.alloc(24), u32(2),
  ]))
  const entry = box(codec, Buffer.concat([
    u16(0), u16(0), u16(0), u16(0), u16(0), u16(1), u16(0), u16(0), u16(0), u16(0),
    u16(0), u16(0), u16(0), u16(0), u16(width), u16(height), u32(0x480000), u16(0), u16(0),
    u32(0), u16(0x18), u16(0xffff), Buffer.alloc(32), u16(0x18), u16(0xffff),
  ]))
  const stsd = box('stsd', Buffer.concat([u32(0), u32(1), entry]))
  const stbl = box('stbl', stsd)
  const minf = box('minf', stbl)
  const mdia = box('mdia', minf)
  const tkhd = box('tkhd', Buffer.concat([
    u32(0), u32(9), u32(0), u32(1), u32(0), u32(duration), Buffer.alloc(8),
    u16(0), u16(0), u16(0x100), u16(0), matrix, u32(width << 16), u32(height << 16),
  ]))
  const moov = box('moov', Buffer.concat([mvhd, box('trak', Buffer.concat([tkhd, mdia]))]))
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom'), u32(0), Buffer.from('isom')]))
  return Buffer.concat([ftyp, moov])
}

const GOOD_MP4 = validMp4()

function fetchedOk(overrides = {}) {
  return {
    bytes: GOOD_MP4,
    truncated: false,
    contentType: 'video/mp4',
    statusCode: 200,
    finalUrl: 'https://cdn.example.com/fix.mp4',
    ...overrides,
  }
}

const VIDEO_TEST_CODE = '9900001'
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

async function seedFixture(suffix, errorCode = VIDEO_TEST_CODE) {
  const campaign = await campaignService.createCampaign(client.id, { name: `Video ${suffix}`, type: 'post' })
  campaignIds.push(campaign.id)
  await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'c', mediaUrl: 'https://example.com/old.mp4' })
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
      [uuidToBuffer(generateUuid()), uuidToBuffer(client.id), fbPlatform.id, 'https://fb.com/test', `fb_vid_${suffix}`, 'VidPage']
    )
  }
  const fb = `fb_vid_${suffix}`
  const adset = `adset_vid_${suffix}`
  const creative = `creative_vid_${suffix}`
  const ad = `ad_vid_${suffix}`
  await campaignRepo.createMetaObject(campaign.id, 'facebook_campaign', fb, null, 'ACTIVE', client.id)
  await campaignRepo.createMetaObject(campaign.id, 'ad_set', adset, null, 'ACTIVE', client.id)
  await campaignRepo.createMetaObject(campaign.id, 'ad_creative', creative, null, null, client.id)
  await campaignRepo.createMetaObject(campaign.id, 'ad', ad, null, 'PAUSED', client.id)
  const executionId = await execRepo.createExecution({
    campaignId: campaign.id, ownerUserId: client.id, kind: 'client', status: 'creating',
    platformCampaignId: fb, platformAdsetId: adset, platformCreativeId: creative, platformAdId: ad,
  })
  await campaignRepo.upsertMetaObjectIssue(executionId, {
    objectId: ad, creativeId: creative, level: 'AD', errorCode,
    summary: 's', message: 'm', errorType: 'HARD_ERROR',
  })
  await campaignRepo.updateCampaignStatus(campaign.id, 'running')
  await freezeCampaignSnapshotFor(campaign.id)
  return { campaignId: campaign.id, executionId, ad }
}

describe('repair video end to end (Phase 2)', () => {
  beforeAll(async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'test_system_user_token'
    process.env.META_AD_ACCOUNT_ID = 'act_test_account'
    client = await createTestUser({ email: `repair-video-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    const mod = await import('../../app.js')
    app = mod.default
    await setConfig('campaign_repair_rollout', 'admin_only')
    await setConfig('campaign_repair_execution_enabled', true)
    await setConfig('campaign_repair_category_video_dimension', true)
    VIDEO_DIMENSION_ISSUE_CODES.push(VIDEO_TEST_CODE)
  })

  afterAll(async () => {
    const index = VIDEO_DIMENSION_ISSUE_CODES.indexOf(VIDEO_TEST_CODE)
    if (index !== -1) VIDEO_DIMENSION_ISSUE_CODES.splice(index, 1)
    await setConfig('campaign_repair_rollout', undefined)
    await setConfig('campaign_repair_execution_enabled', undefined)
    await setConfig('campaign_repair_category_video_dimension', undefined)
    await query("DELETE FROM campaign_jobs WHERE job_type = 'execution_repair'").catch(() => {})
    for (const id of campaignIds) {
      await query('DELETE FROM campaigns WHERE id = ?', [uuidToBuffer(id)]).catch(() => {})
    }
  })

  beforeEach(() => {
    urlFetchMock.mockReset()
    urlFetchMock.mockResolvedValue(fetchedOk())
    for (const fn of Object.keys(metaMocks)) {
      if (typeof metaMocks[fn]?.mockClear === 'function') metaMocks[fn].mockClear()
    }
    metaMocks.getObjectStatus.mockResolvedValue({ status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [
      { level: 'AD', error_code: 2875006, error_summary: 's', error_message: 'm', error_type: 'HARD_ERROR' },
      { level: 'AD', error_code: VIDEO_TEST_CODE, error_summary: 'v', error_message: 'vm', error_type: 'HARD_ERROR' },
    ] })
    metaMocks.getMetaObject.mockResolvedValue({ id: 'x' })
    metaMocks.listAccountCreatives.mockResolvedValue({ rows: [], truncated: false })
    metaMocks.listAdSetAds.mockResolvedValue({ rows: [], truncated: false })
    metaMocks.uploadRepairVideoFromUrl.mockResolvedValue({ videoId: 'mock_video' })
    metaMocks.waitForAdVideoReady.mockResolvedValue({ video_status: 'ready' })
    metaMocks.deleteAdVideo.mockResolvedValue({})
  })

  function mockCreatedFlow(createdObjects) {
    // Tracks real updateAdStatus transitions so getObjectStatus/listAdSetAds
    // readbacks during activation reflect what was actually done, instead
    // of always reporting a hardcoded PAUSED for every created ad (which
    // made every activation attempt fail as "replacement-activation-
    // unverifiable" once runRepairJob started actually reaching activation).
    const adStatus = new Map()
    metaMocks.getObjectStatus.mockImplementation((id) => Promise.resolve(
      createdObjects.some((o) => o.kind === 'ad' && o.id === id)
        ? { status: adStatus.get(id) || 'PAUSED', effective_status: 'ACTIVE', issues_info: [] }
        : { status: adStatus.get(id) || 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [{ level: 'AD', error_code: VIDEO_TEST_CODE, error_summary: 'v', error_message: 'vm', error_type: 'HARD_ERROR' }] }
    ))
    metaMocks.listAdSetAds.mockImplementation((adsetId) => Promise.resolve({
      rows: createdObjects
        .filter((o) => o.kind === 'ad' && o.adsetId === adsetId)
        .map((o) => ({ id: o.id, name: o.name, status: adStatus.get(o.id) || 'PAUSED', effective_status: 'ACTIVE', creative: { id: o.creativeId } })),
      truncated: false,
    }))
    metaMocks.updateAdStatus.mockImplementation((id, status) => {
      adStatus.set(id, status)
      return Promise.resolve({})
    })
    let n = 0
    metaMocks.createAdCreative.mockImplementation((...args) => {
      n += 1
      const created = { id: `vid_creative_${n}_${generateUuid()}` }
      if (args[args.length - 1] !== true) {
        createdObjects.push({ kind: 'creative', id: created.id })
      }
      return Promise.resolve(created)
    })
    metaMocks.createAd.mockImplementation((...args) => {
      const created = { id: `vid_ad_${n}_${generateUuid()}` }
      if (args[args.length - 1] !== true) {
        createdObjects.push({ kind: 'ad', id: created.id, name: args[3], creativeId: args[2], adsetId: args[1] })
        adStatus.set(created.id, 'PAUSED')
      }
      return Promise.resolve(created)
    })
  }

  it('unpinned video codes stay informational; VIDEO_DIMENSION gates on flag + allowlist', async () => {
    expect(await repairService.isRepairCategoryEnabled('VIDEO_DIMENSION')).toBe(true)
    await setConfig('campaign_repair_category_video_dimension', false)
    expect(await repairService.isRepairCategoryEnabled('VIDEO_DIMENSION')).toBe(false)
    await setConfig('campaign_repair_category_video_dimension', true)
    const seed = await seedFixture(tag('s'), '9900002')
    const status = await repairService.getExecutionRepairStatus(seed.executionId)
    expect(status.eligible).toBe(false)
    expect(status.reasons).toContain('issue-unsupported')
    expect(status.issues).toHaveLength(1)
  })

  it('requests a video repair and surfaces VIDEO_DIMENSION as repairable', async () => {
    const seed = await seedFixture(tag('s'))
    const created = await repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null,
      mediaUrl: 'https://cdn.example.com/fix.mp4',
    })
    expect(created.queued).toBe(true)
    const status = await repairService.getExecutionRepairStatus(seed.executionId)
    const issue = status.issues.find((entry) => entry.errorCode === VIDEO_TEST_CODE)
    expect(issue.category).toBe('VIDEO_DIMENSION')
    expect(issue.repairable).toBe(true)
  })

  it('rejects narrow, short, and non-video URLs for video issues', async () => {
    const seed = await seedFixture(tag('s'))
    urlFetchMock.mockResolvedValue(fetchedOk({ bytes: validMp4({ width: 400, height: 800 }) }))
    await expect(repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null, mediaUrl: 'https://cdn.example.com/narrow.mp4',
    })).rejects.toThrow(/500px/)
    urlFetchMock.mockResolvedValue(fetchedOk({ bytes: validMp4({ duration: 500, timescale: 1000 }) }))
    await expect(repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null, mediaUrl: 'https://cdn.example.com/short.mp4',
    })).rejects.toThrow(/1s/)
    urlFetchMock.mockResolvedValue(fetchedOk({ bytes: Buffer.from('not a video'), contentType: 'text/html' }))
    await expect(repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null, mediaUrl: 'https://cdn.example.com/x.html',
    })).rejects.toThrow(/valid image or video/)
    expect(await repairRepo.listRepairsForExecution(seed.executionId)).toHaveLength(0)
  })

  it('runs video creation end to end via advideos upload to NEW_VERIFIED', async () => {
    const createdObjects = []
    mockCreatedFlow(createdObjects)
    const seed = await seedFixture(tag('s'))
    const created = await repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null,
      mediaUrl: 'https://cdn.example.com/fix.mp4',
    })
    const out = await repairService.runRepairJob(created.repair.id)
    expect(out).toMatchObject({ done: true, state: 'completed' })
    expect(metaMocks.uploadRepairVideoFromUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fileUrl: 'https://cdn.example.com/fix.mp4' }),
      expect.anything()
    )
    expect(metaMocks.waitForAdVideoReady).toHaveBeenCalledWith('mock_video', expect.anything())
    const videoCall = metaMocks.createAdCreative.mock.calls.find((args) => args[6]?.video?.videoId === 'mock_video' && args[args.length - 1] !== true)
    expect(videoCall).toBeTruthy()
    const repair = await repairRepo.findRepairById(created.repair.id)
    expect(repair.status).toBe('completed')
  })

  it('adopts a same-name video creative without re-uploading', async () => {
    const createdObjects = []
    mockCreatedFlow(createdObjects)
    const seed = await seedFixture(tag('s'))
    const created = await repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null,
      mediaUrl: 'https://cdn.example.com/fix.mp4',
    })
    const shortId = created.repair.id.replace(/-/g, '').substring(0, 8)
    metaMocks.listAccountCreatives.mockResolvedValue({
      rows: [{
        id: 'adopted_creative',
        name: `Repair ${shortId} g1`,
        object_story_spec: { video_data: { video_id: 'adopted_video' } },
      }],
      truncated: false,
    })
    const out = await repairService.runRepairJob(created.repair.id)
    expect(out).toMatchObject({ done: true })
    expect(metaMocks.uploadRepairVideoFromUrl).not.toHaveBeenCalled()
    const repair = await repairRepo.findRepairById(created.repair.id)
    expect(['new_verified', 'ready_for_creation', 'completed']).toContain(repair.status)
  })

  it('fails closed with cleanup on video upload and readiness failures', async () => {
    const seed = await seedFixture(tag('s'))
    const created = await repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null,
      mediaUrl: 'https://cdn.example.com/fix.mp4',
    })
    metaMocks.uploadRepairVideoFromUrl.mockRejectedValue(
      Object.assign(new Error('(#389) Unable to fetch video file from URL'), { statusCode: 400 })
    )
    await repairService.runRepairJob(created.repair.id)
    const failedUpload = await repairRepo.findRepairById(created.repair.id)
    expect(failedUpload.status).toBe('failed')
    expect(failedUpload.error || '').toMatch(/upload-video:/)
    expect(metaMocks.deleteAdVideo).not.toHaveBeenCalled()

    const seed2 = await seedFixture(tag('s'))
    const created2 = await repairService.requestRepair({
      campaignId: seed2.campaignId, executionId: seed2.executionId, actorId: null,
      mediaUrl: 'https://cdn.example.com/fix.mp4',
    })
    metaMocks.uploadRepairVideoFromUrl.mockResolvedValue({ videoId: 'stuck_video' })
    metaMocks.waitForAdVideoReady.mockRejectedValue(new Error('Timed out waiting for ad video stuck_video to finish processing'))
    await expect(repairService.runRepairJob(created2.repair.id)).rejects.toThrow(/readiness/)
    const parked = await repairRepo.findRepairById(created2.repair.id)
    expect(parked.status).toBe('ready_for_creation')
  })
})
