import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { encrypt } from '../../shared/utils/crypto.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as postService from '../../src/modules/posts/post.service.js'
import * as postRepo from '../../src/modules/posts/post.repository.js'
import { queryOne, query } from '../../shared/database/connection.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    createPageVideoPost: vi.fn().mockResolvedValue({ id: 'mock_fb_video_1', videoId: 'mock_fb_video_1' }),
    createPagePhotoPost: vi.fn().mockResolvedValue({ id: 'mock_fb_post_1' }),
    getPostPromotability: vi.fn().mockResolvedValue({ isEligible: true, promotableId: 'mock_promotable_1', allowedObjectives: [], instagramEligibility: 'eligible', raw: {} }),
    resolveFbPostObjectId: vi.fn(),
    isPostLiveForBoost: vi.fn().mockResolvedValue(true),
    createAdCampaign: vi.fn().mockImplementation(async () => ({ id: `mock_boost_campaign_${generateUuid()}` })),
    createAdSet: vi.fn().mockImplementation(async () => ({ id: `mock_boost_adset_${generateUuid()}` })),
    createAdCreativeFromPost: vi.fn().mockImplementation(async () => ({ id: `mock_boost_creative_${generateUuid()}` })),
    createAd: vi.fn().mockImplementation(async () => ({ id: `mock_boost_ad_${generateUuid()}` })),
    updateAdStatus: vi.fn().mockResolvedValue({ success: true }),
  }
  metaMocks = mocks
  return mocks
})

const dateTag = Date.now()

async function addPlatformAccount(userId, { code, platformUserId }) {
  const platform = await queryOne("SELECT id FROM platforms WHERE code = ?", [code])
  const accountId = generateUuid()
  await query(
    `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id,
       platform_username, platform_display_name, instagram_business_account_id, token_type,
       access_token, token_expires_at, verification_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'page', ?, DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
    [
      uuidToBuffer(accountId),
      uuidToBuffer(userId),
      platform.id,
      `https://fb.com/${platformUserId}`,
      platformUserId,
      `user_${platformUserId}`,
      `Display ${platformUserId}`,
      encrypt('mock_page_token'),
    ]
  )
  return accountId
}

describe('post boost video/reel id resolution', () => {
  let client, admin, fbAccountId

  beforeAll(async () => {
    client = await createTestUser({ email: `boost-video-client-${dateTag}@flowx-test.com`, password: 'Test@123' })
    fbAccountId = await addPlatformAccount(client.id, { code: 'facebook', platformUserId: 'boost_video_page_1' })
    const adminRow = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    admin = { id: adminRow ? bufferToUuid(adminRow.id) : null }
  })

  beforeEach(async () => {
    metaMocks.createPageVideoPost.mockReset().mockResolvedValue({ id: 'mock_fb_video_1', videoId: 'mock_fb_video_1' })
    metaMocks.createPagePhotoPost.mockReset().mockResolvedValue({ id: 'mock_fb_post_1' })
    metaMocks.getPostPromotability.mockReset().mockResolvedValue({ isEligible: true, promotableId: 'mock_promotable_1', allowedObjectives: [], instagramEligibility: 'eligible', raw: {} })
    metaMocks.resolveFbPostObjectId.mockReset()
    metaMocks.isPostLiveForBoost.mockReset().mockResolvedValue(true)
    metaMocks.createAdCampaign.mockReset().mockImplementation(async () => ({ id: `mock_boost_campaign_${generateUuid()}` }))
    metaMocks.createAdSet.mockReset().mockImplementation(async () => ({ id: `mock_boost_adset_${generateUuid()}` }))
    metaMocks.createAdCreativeFromPost.mockReset().mockImplementation(async () => ({ id: `mock_boost_creative_${generateUuid()}` }))
    metaMocks.createAd.mockReset().mockImplementation(async () => ({ id: `mock_boost_ad_${generateUuid()}` }))
    metaMocks.updateAdStatus.mockReset().mockResolvedValue({ success: true })
    await query("DELETE FROM campaign_jobs WHERE job_type = 'post_boost'")
  })

  async function createBoostedVideoPost() {
    const post = await postService.createPost(client.id, {
      name: `Boost Video ${generateUuid()}`,
      type: 'post',
      caption: 'Video to boost',
      mediaUrl: 'https://example.com/video.mp4',
      boostEnabled: true,
      boostBudgetType: 'daily',
      boostBudgetAmount: 500,
      boostObjective: 'OUTCOME_ENGAGEMENT',
      boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [fbAccountId],
    })
    await postService.submitPost(client.id, post.id)
    await postService.approvePost(admin.id, post.id, {})
    await postService.publishPostJob(post.id)
    await query('DELETE FROM campaign_jobs WHERE campaign_id = ?', [uuidToBuffer(post.id)])
    return post.id
  }

  async function getTarget(postId) {
    const targets = await postRepo.findPostTargetsByPostId(postId)
    return targets[0]
  }

  it('should store the post id when video create resolves post_id immediately', async () => {
    metaMocks.createPageVideoPost.mockResolvedValueOnce({
      id: 'boost_video_page_1_123456',
      videoId: 'mock_fb_video_1',
      postId: 'boost_video_page_1_123456',
    })
    const postId = await createBoostedVideoPost()
    const target = await getTarget(postId)
    expect(target.status).toBe('posted')
    expect(target.metaObjectId).toBe('boost_video_page_1_123456')
    expect(target.remoteVideoId).toBe('mock_fb_video_1')
    expect(metaMocks.getPostPromotability).toHaveBeenCalledWith('boost_video_page_1_123456', 'mock_page_token')
    const result = await postService.postBoostJob(postId, target.id)
    expect(result.done).toBe(true)
    const boosts = await postRepo.findPostBoostTargetsByTargetId(target.id)
    expect(boosts.length).toBeGreaterThan(0)
    await query('DELETE FROM campaign_jobs WHERE campaign_id = ?', [uuidToBuffer(postId)])
  })

  it('should store video id + remote_video_id when post_id is delayed, then boost job lazily resolves', async () => {
    metaMocks.createPageVideoPost.mockResolvedValueOnce({
      id: '123456789012345',
      videoId: '123456789012345',
      postId: null,
    })
    const postId = await createBoostedVideoPost()
    const target = await getTarget(postId)
    expect(target.metaObjectId).toBe('123456789012345')
    expect(target.remoteVideoId).toBe('123456789012345')
    // promotability NOT captured for video-shaped id (no false poison)
    expect(metaMocks.getPostPromotability).not.toHaveBeenCalledWith('123456789012345', 'mock_page_token')

    // first boost attempt: resolver pending → requeue
    metaMocks.resolveFbPostObjectId.mockResolvedValueOnce(null)
    const first = await postService.postBoostJob(postId, target.id)
    expect(first.requeueAfterSeconds).toBe(60)
    expect(metaMocks.resolveFbPostObjectId).toHaveBeenCalledWith('boost_video_page_1', '123456789012345', 'mock_page_token')

    // second boost attempt: resolver returns the real post id → boost proceeds
    metaMocks.resolveFbPostObjectId.mockResolvedValueOnce('boost_video_page_1_778899')
    const second = await postService.postBoostJob(postId, target.id)
    expect(second.done).toBe(true)
    const refreshed = await postRepo.findPostTargetById(target.id)
    expect(refreshed.metaObjectId).toBe('boost_video_page_1_778899')
    expect(metaMocks.getPostPromotability).toHaveBeenCalledWith('boost_video_page_1_778899', 'mock_page_token')
    const boosts = await postRepo.findPostBoostTargetsByTargetId(target.id)
    expect(boosts.length).toBeGreaterThan(0)
    await query('DELETE FROM campaign_jobs WHERE campaign_id = ?', [uuidToBuffer(postId)])
  })

  it('should not capture promotability for non-boost posts (saves a Graph call)', async () => {
    const post = await postService.createPost(client.id, {
      name: `Plain Video ${generateUuid()}`,
      type: 'post',
      caption: 'No boost',
      mediaUrl: 'https://example.com/video.mp4',
      targetAccountIds: [fbAccountId],
    })
    await postService.submitPost(client.id, post.id)
    await postService.approvePost(admin.id, post.id, {})
    await postService.publishPostJob(post.id)
    expect(metaMocks.getPostPromotability).not.toHaveBeenCalled()
    await query('DELETE FROM campaign_jobs WHERE campaign_id = ?', [uuidToBuffer(post.id)])
  })

  it('should send IMPRESSIONS billing for POST_ENGAGEMENT optimization goal (ON_POST boost)', async () => {
    const { GOAL_BILLING_MAP } = await import('../../shared/services/meta-ads.service.js')
    expect(GOAL_BILLING_MAP.POST_ENGAGEMENT).toBe('IMPRESSIONS')
    expect(GOAL_BILLING_MAP.LANDING_PAGE_VIEWS).toBe('IMPRESSIONS')
    expect(GOAL_BILLING_MAP.THRUPLAY).toBe('THRUPLAY')
    expect(GOAL_BILLING_MAP.LINK_CLICKS).toBe('LINK_CLICKS')
  })

  it('should wait for post to be live before boosting (live gate requeue)', async () => {
    metaMocks.createPageVideoPost.mockResolvedValueOnce({
      id: 'boost_video_page_1_123456',
      videoId: 'mock_fb_video_1',
      postId: 'boost_video_page_1_123456',
    })
    const postId = await createBoostedVideoPost()
    const target = await getTarget(postId)

    // first boost attempt: post not yet live → requeue with backoff
    metaMocks.isPostLiveForBoost.mockResolvedValueOnce(false)
    const first = await postService.postBoostJob(postId, target.id, {})
    expect(first.requeueAfterSeconds).toBe(30)
    expect(metaMocks.createAdCampaign).not.toHaveBeenCalled()
    let boosts = await postRepo.findPostBoostTargetsByTargetId(target.id)
    expect(boosts.length).toBe(0)

    // second boost attempt: post now live → boost proceeds
    metaMocks.isPostLiveForBoost.mockResolvedValueOnce(true)
    const second = await postService.postBoostJob(postId, target.id, { liveAttempts: 1 })
    expect(second.done).toBe(true)
    boosts = await postRepo.findPostBoostTargetsByTargetId(target.id)
    expect(boosts.length).toBeGreaterThan(0)
    await query('DELETE FROM campaign_jobs WHERE campaign_id = ?', [uuidToBuffer(postId)])
  })

  it('should park boost job after 8 failed live checks', async () => {
    metaMocks.createPageVideoPost.mockResolvedValueOnce({
      id: 'boost_video_page_1_123456',
      videoId: 'mock_fb_video_1',
      postId: 'boost_video_page_1_123456',
    })
    const postId = await createBoostedVideoPost()
    const target = await getTarget(postId)

    metaMocks.isPostLiveForBoost.mockResolvedValue(false)
    const result = await postService.postBoostJob(postId, target.id, { liveAttempts: 7 })
    expect(result.done).toBe(true)
    const post = await postRepo.findPostById(postId)
    expect(post.boostError).toContain('not yet live after 8 checks')
    await query('DELETE FROM campaign_jobs WHERE campaign_id = ?', [uuidToBuffer(postId)])
  })
})
