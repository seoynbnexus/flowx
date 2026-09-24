import { describe, it, expect, beforeAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import { queryOne, query } from '../../shared/database/connection.js'
import { drainCampaignJobs, processDueJobs } from '../../src/modules/campaigns/campaign.jobs.js'

// Regression coverage for the "video sent as link_data, Meta scrapes a tiny
// fallback thumbnail, ad gets rejected as < 500px wide" bug — see
// campaign.service.js: buildOwnerMetaChain / resolveVideoForCampaignCreative.
var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    __counter: 0,
    __nextMetaId: (prefix) => {
      mocks.__counter += 1
      return `${prefix}_${mocks.__counter}`
    },
    createAdCampaign: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('vidcamp_campaign') })),
    createAdSet: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('vidcamp_adset') })),
    createAdCreative: vi.fn().mockImplementation(async (...args) => ({ id: mocks.__nextMetaId('vidcamp_creative'), __args: args })),
    createAd: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('vidcamp_ad') })),
    updateAdStatus: vi.fn().mockResolvedValue({ success: true }),
    deleteAd: vi.fn().mockResolvedValue({}),
    deleteAdSet: vi.fn().mockResolvedValue({}),
    deleteAdCreative: vi.fn().mockResolvedValue({}),
    deleteAdCampaign: vi.fn().mockResolvedValue({}),
    uploadRepairVideoFromUrl: vi.fn().mockResolvedValue({ videoId: 'mock_video' }),
    waitForAdVideoReady: vi.fn().mockResolvedValue({ video_status: 'ready' }),
    deleteAdVideo: vi.fn().mockResolvedValue({}),
  }
  metaMocks = mocks
  return mocks
})

var inspectSizeMock
vi.mock('../../shared/services/media-url.js', async () => {
  const actual = await vi.importActual('../../shared/services/media-url.js')
  inspectSizeMock = vi.fn().mockResolvedValue({ status: 'UNKNOWN_SIZE', sizeBytes: null, contentType: null })
  return { ...actual, inspectMediaSize: inspectSizeMock }
})

const dateTag = Date.now()
let counter = 0

async function createGateClient() {
  counter += 1
  const user = await createTestUser({
    email: `camp-video-${dateTag}-${counter}@flowx-test.com`,
    password: 'Test@123',
    coins: 10000,
  })
  const fbPlatform = await queryOne("SELECT id FROM platforms WHERE code = 'facebook'")
  if (fbPlatform) {
    const platformId = bufferToUuid(fbPlatform.id)
    await query(
      `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id, platform_username, token_type, token_expires_at, verification_status)
       VALUES (?, ?, ?, ?, ?, ?, 'page', DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
      [uuidToBuffer(generateUuid()), uuidToBuffer(user.id), uuidToBuffer(platformId), 'https://fb.com/test', `fb_video_${dateTag}_${counter}`, 'VideoGatePage']
    )
  }
  return user
}

function resetMetaMocks() {
  metaMocks.createAdCampaign.mockClear()
  metaMocks.createAdSet.mockClear()
  metaMocks.createAdCreative.mockClear()
  metaMocks.createAd.mockClear()
  metaMocks.uploadRepairVideoFromUrl.mockClear().mockResolvedValue({ videoId: 'mock_video' })
  metaMocks.waitForAdVideoReady.mockClear().mockResolvedValue({ video_status: 'ready' })
  metaMocks.deleteAdVideo.mockClear()
}

async function createVideoCampaign(client, mediaUrl = 'https://example.com/ad.mp4') {
  const campaign = await campaignService.createCampaign(client.id, {
    name: `Video Campaign ${generateUuid().substring(0, 8)}`,
    type: 'post',
  })
  await campaignRepo.createCreative(generateUuid(), campaign.id, {
    caption: 'video creative test',
    mediaUrl,
    callToAction: 'LEARN_MORE',
  })
  await campaignRepo.createMetaSettings(generateUuid(), campaign.id, {
    objective: 'OUTCOME_TRAFFIC',
    budgetAmount: 500,
    endTime: new Date(Date.now() + 10 * 24 * 3600000).toISOString(),
  })
  await campaignService.submitCampaign(client.id, campaign.id)
  return campaign
}

describe('campaign video creative (fixes video sent as link_data)', () => {
  let admin

  beforeAll(async () => {
    process.env.META_SYSTEM_USER_TOKEN = process.env.META_SYSTEM_USER_TOKEN || 'test_system_user_token'
    process.env.META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || 'act_test_account'
    const adminRow = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    admin = { id: adminRow ? bufferToUuid(adminRow.id) : null }
  })

  it('uploads the video and builds the creative with video_data, never link_data', async () => {
    resetMetaMocks()
    const client = await createGateClient()
    const campaign = await createVideoCampaign(client)

    const approved = await campaignService.approveCampaign(admin?.id || client.id, campaign.id, {})
    expect(approved.queued).toBe(true)
    await drainCampaignJobs()

    expect(metaMocks.uploadRepairVideoFromUrl).toHaveBeenCalledTimes(1)
    expect(metaMocks.uploadRepairVideoFromUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fileUrl: 'https://example.com/ad.mp4' }),
      expect.anything(),
    )
    expect(metaMocks.waitForAdVideoReady).toHaveBeenCalledWith('mock_video', expect.anything())

    // The real (non-validate) creative-create call: 4th positional arg is
    // mediaUrl, 7th is extra — must be null / { video: { videoId } }, never both.
    const realCreateCall = metaMocks.createAdCreative.mock.calls.find(c => c[c.length - 1] !== true)
    expect(realCreateCall[3]).toBeNull()
    expect(realCreateCall[6]).toMatchObject({ video: { videoId: 'mock_video' } })

    const updated = await campaignRepo.findCampaignById(campaign.id)
    expect(updated.status).toBe('running')

    const videoRow = await queryOne(
      'SELECT * FROM campaign_ad_videos WHERE campaign_id = ? AND created_for_user_id = ?',
      [uuidToBuffer(campaign.id), uuidToBuffer(client.id)]
    )
    expect(videoRow).toBeTruthy()
    expect(videoRow.video_id).toBe('mock_video')
    expect(videoRow.media_url).toBe('https://example.com/ad.mp4')
  })

  it('never calls the video upload path for an image campaign (regression guard)', async () => {
    resetMetaMocks()
    const client = await createGateClient()
    const campaign = await createVideoCampaign(client, 'https://example.com/ad.jpg')

    const approved = await campaignService.approveCampaign(admin?.id || client.id, campaign.id, {})
    expect(approved.queued).toBe(true)
    await drainCampaignJobs()

    expect(metaMocks.uploadRepairVideoFromUrl).not.toHaveBeenCalled()
    const realCreateCall = metaMocks.createAdCreative.mock.calls.find(c => c[c.length - 1] !== true)
    expect(realCreateCall[3]).toBe('https://example.com/ad.jpg')
    expect(realCreateCall[6]?.video).toBeUndefined()

    const updated = await campaignRepo.findCampaignById(campaign.id)
    expect(updated.status).toBe('running')
  })

  it('dies permanently without creating any campaign objects when video upload fails permanently', async () => {
    resetMetaMocks()
    metaMocks.uploadRepairVideoFromUrl.mockRejectedValue(
      Object.assign(new Error('(#389) Unable to fetch video file from URL'), { statusCode: 400 })
    )
    const client = await createGateClient()
    const campaign = await createVideoCampaign(client)

    const approved = await campaignService.approveCampaign(admin?.id || client.id, campaign.id, {})
    expect(approved.queued).toBe(true)
    await drainCampaignJobs()

    expect(metaMocks.createAdCampaign).not.toHaveBeenCalled()
    expect(metaMocks.createAdSet).not.toHaveBeenCalled()
    expect(metaMocks.createAdCreative).not.toHaveBeenCalled()
    expect(await campaignRepo.findMetaObjectsByCampaignId(campaign.id)).toEqual([])

    const updated = await campaignRepo.findCampaignById(campaign.id)
    expect(updated.status).toBe('pending_review')
    expect(updated.metaStatus).toBe('failed')
    expect(updated.metaError).toContain('Unable to fetch video file')

    const videoRow = await queryOne(
      'SELECT * FROM campaign_ad_videos WHERE campaign_id = ? AND created_for_user_id = ?',
      [uuidToBuffer(campaign.id), uuidToBuffer(client.id)]
    )
    expect(videoRow).toBeNull()
  })

  it('retries a transient video-readiness failure and reuses the already-uploaded video (no re-upload)', async () => {
    resetMetaMocks()
    metaMocks.waitForAdVideoReady.mockRejectedValueOnce(new Error('Timed out waiting for ad video mock_video to finish processing'))
    const client = await createGateClient()
    const campaign = await createVideoCampaign(client)

    const approved = await campaignService.approveCampaign(admin?.id || client.id, campaign.id, {})
    expect(approved.queued).toBe(true)
    // A single pass — the job fails transiently and backs off ~60s, which
    // drainCampaignJobs' internal poll-loop would never see resolve within
    // its 15s timeout (it treats a still-queued backed-off job as "active").
    await processDueJobs()

    // First attempt: uploaded once, wait-for-ready failed transiently -> job backed off.
    expect(metaMocks.uploadRepairVideoFromUrl).toHaveBeenCalledTimes(1)
    let updated = await campaignRepo.findCampaignById(campaign.id)
    expect(updated.status).toBe('pending_review')

    // Force the backed-off job due now, then let it succeed on retry.
    await query("UPDATE campaign_jobs SET run_after = NOW() WHERE campaign_id = ?", [uuidToBuffer(campaign.id)])
    await drainCampaignJobs()

    // Still only ONE upload call total — the persisted video_id was reused.
    expect(metaMocks.uploadRepairVideoFromUrl).toHaveBeenCalledTimes(1)
    updated = await campaignRepo.findCampaignById(campaign.id)
    expect(updated.status).toBe('running')
  })

  it('the "Validate with Meta" pre-check also resolves video correctly (video_data, not link_data)', async () => {
    resetMetaMocks()
    const client = await createGateClient()
    const campaign = await campaignService.createCampaign(client.id, {
      name: `Video Validate ${generateUuid().substring(0, 8)}`,
      type: 'post',
    })
    await campaignRepo.createCreative(generateUuid(), campaign.id, {
      caption: 'validate video',
      mediaUrl: 'https://example.com/validate.mp4',
    })
    await campaignRepo.createMetaSettings(generateUuid(), campaign.id, {
      objective: 'OUTCOME_TRAFFIC',
      budgetAmount: 500,
      endTime: new Date(Date.now() + 10 * 24 * 3600000).toISOString(),
    })

    const result = await campaignService.validateCampaignDraft(client.id, campaign.id)
    expect(result.valid).toBe(true)
    expect(metaMocks.uploadRepairVideoFromUrl).toHaveBeenCalledTimes(1)

    const validateCall = metaMocks.createAdCreative.mock.calls.find(c => c[c.length - 1] === true)
    expect(validateCall[3]).toBeNull()
    expect(validateCall[6]).toMatchObject({ video: { videoId: 'mock_video' } })
  })
})
