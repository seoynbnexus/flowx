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
    isInstagramPostLive: vi.fn().mockResolvedValue(true),
    getInstagramBoostEligibility: vi.fn().mockResolvedValue({ ready: true, isEligible: true, allowedObjectives: [], reasons: [], raw: {} }),
    getConnectedFacebookPage: vi.fn().mockResolvedValue(null),
    getCreativeStoryId: vi.fn().mockResolvedValue('mock_story_123'),
    deleteAdCreative: vi.fn().mockResolvedValue({ success: true }),
    deleteAdCampaign: vi.fn().mockResolvedValue({ success: true }),
    deleteAdSet: vi.fn().mockResolvedValue({ success: true }),
    createAdCampaign: vi.fn().mockImplementation(async () => ({ id: `mock_boost_campaign_${generateUuid()}` })),
    createAdSet: vi.fn().mockImplementation(async () => ({ id: `mock_boost_adset_${generateUuid()}` })),
    createAdCreativeFromPost: vi.fn().mockImplementation(async () => ({ id: `mock_boost_creative_${generateUuid()}` })),
    createAdCreativeFromInstagramPost: vi.fn().mockImplementation(async () => ({ id: `mock_boost_ig_creative_${generateUuid()}` })),
    createAd: vi.fn().mockImplementation(async () => ({ id: `mock_boost_ad_${generateUuid()}` })),
    updateAdStatus: vi.fn().mockResolvedValue({ success: true }),
    getCreativeStoryId: vi.fn().mockResolvedValue('1271564729365147_122124400341383247'),  // NEW: default to null (unresolved)
    deleteAdCreative: vi.fn(),  // NEW: mock the delete
  }
  metaMocks = mocks
  return mocks
})

const dateTag = Date.now()

async function addPlatformAccount(userId, { code, platformUserId, igId = null }) {
  const platform = await queryOne("SELECT id FROM platforms WHERE code = ?", [code])
  const accountId = generateUuid()
  await query(
    `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id,
       platform_username, platform_display_name, instagram_business_account_id, token_type,
       access_token, token_expires_at, verification_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'page', ?, DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
    [
      uuidToBuffer(accountId),
      uuidToBuffer(userId),
      platform.id,
      `https://fb.com/${platformUserId}`,
      platformUserId,
      `user_${platformUserId}`,
      `Display ${platformUserId}`,
      igId,
      encrypt('mock_page_token'),
    ]
  )
  return accountId
}

describe('instagram post boost via boost_eligibility_info', () => {
  let client, admin, igAccountId

  beforeAll(async () => {
    client = await createTestUser({ email: `ig-boost-client-${dateTag}@flowx-test.com`, password: 'Test@123' })
    igAccountId = await addPlatformAccount(client.id, { code: 'instagram', platformUserId: 'ig_boost_page_1', igId: '17841111111111111' })
    await addPlatformAccount(client.id, { code: 'facebook', platformUserId: 'fb_page_for_ig_1', igId: '17841111111111111' })
    const adminRow = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    admin = { id: adminRow ? bufferToUuid(adminRow.id) : null }
  })

  beforeEach(async () => {
    metaMocks.getPostPromotability.mockReset().mockResolvedValue({ isEligible: true, promotableId: 'mock_promotable_1', allowedObjectives: [], instagramEligibility: 'eligible', raw: {} })
    metaMocks.resolveFbPostObjectId.mockReset()
    metaMocks.isPostLiveForBoost.mockReset().mockResolvedValue(true)
    metaMocks.isInstagramPostLive.mockReset().mockResolvedValue(true)
    metaMocks.getInstagramBoostEligibility.mockReset().mockResolvedValue({ ready: true, isEligible: true, allowedObjectives: [], reasons: [], raw: {} })
    metaMocks.getCreativeStoryId.mockReset().mockResolvedValue('mock_story_123')
    metaMocks.deleteAdCreative.mockReset().mockResolvedValue({ success: true })
    metaMocks.deleteAdCampaign.mockReset().mockResolvedValue({ success: true })
    metaMocks.deleteAdSet.mockReset().mockResolvedValue({ success: true })
    metaMocks.getConnectedFacebookPage.mockReset().mockResolvedValue(null)
    metaMocks.createAdCampaign.mockReset().mockImplementation(async () => ({ id: `mock_boost_campaign_${generateUuid()}` }))
    metaMocks.createAdSet.mockReset().mockImplementation(async () => ({ id: `mock_boost_adset_${generateUuid()}` }))
    metaMocks.createAdCreativeFromPost.mockReset().mockImplementation(async () => ({ id: `mock_boost_creative_${generateUuid()}` }))
    metaMocks.createAdCreativeFromInstagramPost.mockReset().mockImplementation(async () => ({ id: `mock_boost_ig_creative_${generateUuid()}` }))
    metaMocks.createAd.mockReset().mockImplementation(async () => ({ id: `mock_boost_ad_${generateUuid()}` }))
    metaMocks.updateAdStatus.mockReset().mockResolvedValue({ success: true })
    await query("DELETE FROM campaign_jobs WHERE job_type = 'post_boost'")
  })

  async function createIgPost({ type = 'post', mediaUrl = 'https://example.com/img.jpg' } = {}) {
    const post = await postService.createPost(client.id, {
      name: `IG Boost ${type} ${generateUuid()}`,
      type,
      caption: type === 'story' ? null : 'IG boost me',
      mediaUrl,
      boostEnabled: true,
      boostBudgetType: 'daily',
      boostBudgetAmount: 500,
      boostObjective: 'OUTCOME_ENGAGEMENT',
      boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    await postService.approvePost(admin.id, post.id, {})

    // Simulate IG publish: directly set posted + metaObjectId (bypass real IG media_publish)
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    const target = targets[0]
    const igMediaId = `ig_${type}_${generateUuid().slice(0, 8)}`
    await query("UPDATE post_targets SET status = 'posted', publish_state = 'published', meta_object_id = ?, posted_at = NOW() WHERE id = ?", [igMediaId, uuidToBuffer(target.id)])
    await query("UPDATE posts SET status = 'completed' WHERE id = ?", [uuidToBuffer(post.id)])
    return { postId: post.id, targetId: target.id, igMediaId }
  }

  it('should boost IG feed image post via boost_eligibility_info (eligible)', async () => {
    const { postId, targetId, igMediaId } = await createIgPost({ type: 'post', mediaUrl: 'https://example.com/img.jpg' })
    const result = await postService.postBoostJob(postId, targetId, {})
    expect(result.done).toBe(true)
    expect(metaMocks.getInstagramBoostEligibility).toHaveBeenCalledWith(igMediaId, 'mock_page_token')
    expect(metaMocks.createAdCreativeFromInstagramPost).toHaveBeenCalled()
    const [, , targeting, budget, schedule, placement] = metaMocks.createAdSet.mock.calls[metaMocks.createAdSet.mock.calls.length - 1]
    expect(placement.publisherPlatforms).toEqual(['instagram'])
    expect(budget.promotedPageId).toBeNull()
    expect(schedule.startTime).toBeUndefined()
    expect(schedule.endTime).toBeUndefined()
    const boosts = await postRepo.findPostBoostTargetsByTargetId(targetId)
    expect(boosts.length).toBe(4)
    await query('DELETE FROM campaign_jobs WHERE campaign_id = ?', [uuidToBuffer(postId)])
  })

  it('should boost IG reel post', async () => {
    const { postId, targetId } = await createIgPost({ type: 'reel', mediaUrl: 'https://example.com/reel.mp4' })
    const result = await postService.postBoostJob(postId, targetId, {})
    expect(result.done).toBe(true)
    const boosts = await postRepo.findPostBoostTargetsByTargetId(targetId)
    expect(boosts.length).toBe(4)
    await query('DELETE FROM campaign_jobs WHERE campaign_id = ?', [uuidToBuffer(postId)])
  })

  it('should wait for IG post to be live before boosting', async () => {
    const { postId, targetId, igMediaId } = await createIgPost({ type: 'post' })
    metaMocks.isInstagramPostLive.mockResolvedValueOnce(false)
    const first = await postService.postBoostJob(postId, targetId, {})
    expect(first.requeueAfterSeconds).toBe(30)
    expect(metaMocks.getInstagramBoostEligibility).not.toHaveBeenCalled()

    metaMocks.isInstagramPostLive.mockResolvedValueOnce(true)
    const second = await postService.postBoostJob(postId, targetId, { liveAttempts: 1 })
    expect(second.done).toBe(true)
    expect(metaMocks.getInstagramBoostEligibility).toHaveBeenCalledWith(igMediaId, 'mock_page_token')
    await query('DELETE FROM campaign_jobs WHERE campaign_id = ?', [uuidToBuffer(postId)])
  })

  it('should hard-fail IG story posts (not boostable)', async () => {
    const { postId, targetId } = await createIgPost({ type: 'story', mediaUrl: 'https://example.com/story.jpg' })
    const result = await postService.postBoostJob(postId, targetId, {})
    expect(result.done).toBe(true)
    const post = await postRepo.findPostById(postId)
    expect(post.boostError).toContain('Instagram stories cannot be boosted')
    await query('DELETE FROM campaign_jobs WHERE campaign_id = ?', [uuidToBuffer(postId)])
  })

  it('should requeue when boost_eligibility_info not yet ready and park after eligibility is false', async () => {
    const { postId, targetId } = await createIgPost({ type: 'post' })
    metaMocks.getInstagramBoostEligibility.mockResolvedValueOnce({ ready: false, transient: true, raw: {} })
    const first = await postService.postBoostJob(postId, targetId, {})
    expect(first.requeueAfterSeconds).toBe(60)

    metaMocks.getInstagramBoostEligibility.mockResolvedValueOnce({ ready: true, isEligible: false, allowedObjectives: [], reasons: ['MEDIA_TYPE_NOT_SUPPORTED'], raw: {} })
    const second = await postService.postBoostJob(postId, targetId, {})
    expect(second.done).toBe(true)
    const post = await postRepo.findPostById(postId)
    expect(post.boostError).toContain("isn't eligible to be boosted")
    await query('DELETE FROM campaign_jobs WHERE campaign_id = ?', [uuidToBuffer(postId)])
  })

  it('should enforce allowedObjectives from boost_eligibility_info', async () => {
    const { postId, targetId } = await createIgPost({ type: 'post' })
    metaMocks.getInstagramBoostEligibility.mockResolvedValueOnce({ ready: true, isEligible: true, allowedObjectives: ['OUTCOME_AWARENESS'], reasons: [], raw: {} })
    const result = await postService.postBoostJob(postId, targetId, {})
    expect(result.done).toBe(true)
    const post = await postRepo.findPostById(postId)
    expect(post.boostError).toContain('not allowed for this Instagram post')
    await query('DELETE FROM campaign_jobs WHERE campaign_id = ?', [uuidToBuffer(postId)])
  })

  it('should send start_time when the post has a future schedule but omit it for unscheduled posts', async () => {
    // scheduled post: scheduledAt in the future → start_time present
    const post = await postService.createPost(client.id, {
      name: `IG Boost Scheduled ${generateUuid()}`,
      type: 'post',
      caption: 'Scheduled boost',
      mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true,
      boostBudgetType: 'daily',
      boostBudgetAmount: 500,
      boostObjective: 'OUTCOME_ENGAGEMENT',
      boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      scheduledAt: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '),
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    await postService.approvePost(admin.id, post.id, {})
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    const target = targets[0]
    await query("UPDATE post_targets SET status = 'posted', publish_state = 'published', meta_object_id = ?, posted_at = NOW() WHERE id = ?", [`ig_sched_${generateUuid().slice(0, 8)}`, uuidToBuffer(target.id)])
    await query("UPDATE posts SET status = 'completed' WHERE id = ?", [uuidToBuffer(post.id)])
    const result = await postService.postBoostJob(post.id, target.id, {})
    expect(result.done).toBe(true)
    const schedCall = metaMocks.createAdSet.mock.calls[metaMocks.createAdSet.mock.calls.length - 1]
    expect(schedCall[4].startTime).toBeGreaterThan(Math.floor(Date.now() / 1000))
    await query('DELETE FROM campaign_jobs WHERE campaign_id = ?', [uuidToBuffer(post.id)])
  })

  it('should resolve the owning FB page via Graph connected_facebook_page when the DB has no exact IG link', async () => {
    // fresh user with ONLY an IG account — no FB row at all → DB lookup misses → Graph resolution kicks in
    const soloClient = await createTestUser({ email: `ig-boost-solo-${dateTag}-${generateUuid().slice(0, 6)}@flowx-test.com`, password: 'Test@123' })
    const soloIgAccount = await addPlatformAccount(soloClient.id, { code: 'instagram', platformUserId: 'ig_solo_page_1', igId: '17849999999999999' })
    const post = await postService.createPost(soloClient.id, {
      name: `IG Boost Solo ${generateUuid()}`,
      type: 'post',
      caption: 'Graph-resolved boost',
      mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true,
      boostBudgetType: 'daily',
      boostBudgetAmount: 500,
      boostObjective: 'OUTCOME_ENGAGEMENT',
      boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [soloIgAccount],
    })
    await postService.submitPost(soloClient.id, post.id)
    await postService.approvePost(admin.id, post.id, {})
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    const target = targets[0]
    await query("UPDATE post_targets SET status = 'posted', publish_state = 'published', meta_object_id = ?, posted_at = NOW() WHERE id = ?", [`ig_solo_${generateUuid().slice(0, 8)}`, uuidToBuffer(target.id)])
    await query("UPDATE posts SET status = 'completed' WHERE id = ?", [uuidToBuffer(post.id)])

    metaMocks.getConnectedFacebookPage.mockReset().mockResolvedValueOnce('graph_resolved_page_1')
    const result = await postService.postBoostJob(post.id, target.id, {})
    expect(result.done).toBe(true)
    expect(metaMocks.getConnectedFacebookPage).toHaveBeenCalled()
    expect(metaMocks.createAdCreativeFromInstagramPost).toHaveBeenCalled()
    const boosts = await postRepo.findPostBoostTargetsByTargetId(target.id)
    expect(boosts.length).toBe(4)
    await query('DELETE FROM campaign_jobs WHERE campaign_id = ?', [uuidToBuffer(post.id)])
  })
})
