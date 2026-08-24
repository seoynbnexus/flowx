import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { encrypt } from '../../shared/utils/crypto.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as postService from '../../src/modules/posts/post.service.js'
import * as postRepo from '../../src/modules/posts/post.repository.js'
import { queryOne, query } from '../../shared/database/connection.js'
import { drainCampaignJobs } from '../../src/modules/campaigns/campaign.jobs.js'
import { ForbiddenError, NotFoundError } from '../../shared/errors/AppError.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    createPagePhotoPost: vi.fn().mockResolvedValue({ id: 'mock_fb_post_1' }),
    createPageVideoPost: vi.fn().mockResolvedValue({ id: 'mock_fb_video_1' }),
    createFeedPost: vi.fn().mockResolvedValue({ id: 'mock_fb_link_1' }),
    createInstagramMedia: vi.fn().mockResolvedValue({ id: 'mock_ig_container_1' }),
    publishInstagramMedia: vi.fn().mockResolvedValue({ id: 'mock_ig_post_1' }),
    createInstagramStory: vi.fn().mockResolvedValue({ id: 'mock_ig_story_1' }),
    createPagePhotoStory: vi.fn().mockResolvedValue({ id: 'mock_fb_story_1', photoId: 'mock_fb_photo_1' }),
    createPageVideoStory: vi.fn().mockResolvedValue({ id: 'mock_fb_story_video_1', videoId: 'mock_fb_video_1' }),
    getContainerStatus: vi.fn().mockResolvedValue({ status_code: 'FINISHED' }),
    deleteInstagramContainer: vi.fn().mockResolvedValue({ success: true }),
    getMediaEngagement: vi.fn().mockResolvedValue({
      mediaId: 'mock_ig_post_1',
      mediaType: 'VIDEO',
      mediaProductType: 'REELS',
      permalink: 'https://instagram.com/p/mock-reel/',
      timestamp: '2026-08-12T10:00:00+0000',
      likeCount: 12,
      commentsCount: 3,
      insights: { reach: 1000, likes: 12, comments: 3, saved: 5, shares: 2, views: 800, total_interactions: 30 },
      comments: [
        { id: 'c1', text: 'nice', username: 'user1', timestamp: '2026-08-12T11:00:00+0000' },
      ],
    }),
  }
  metaMocks = mocks
  return mocks
})

const dateTag = Date.now()

async function addPlatformAccount(userId, { code, platformUserId, igId = null }) {
  const platform = await queryOne('SELECT id FROM platforms WHERE code = ?', [code])
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

describe('post engagement sync', () => {
  let client, otherClient, admin, fbAccountId, igAccountId

  beforeAll(async () => {
    client = await createTestUser({ email: `post-eng-client-${dateTag}@flowx-test.com`, password: 'Test@123' })
    otherClient = await createTestUser({ email: `post-eng-other-${dateTag}@flowx-test.com`, password: 'Test@123' })
    fbAccountId = await addPlatformAccount(client.id, { code: 'facebook', platformUserId: 'eng_fb_page_1' })
    igAccountId = await addPlatformAccount(client.id, {
      code: 'instagram',
      platformUserId: 'eng_ig_acct_1',
      igId: '17841422222222222',
    })
    const adminRow = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    admin = { id: adminRow ? bufferToUuid(adminRow.id) : null }
  })

  beforeEach(() => {
    metaMocks.getMediaEngagement.mockReset()
    metaMocks.getMediaEngagement.mockResolvedValue({
      mediaId: 'mock_ig_post_1',
      mediaType: 'VIDEO',
      mediaProductType: 'REELS',
      permalink: 'https://instagram.com/p/mock-reel/',
      timestamp: '2026-08-12T10:00:00+0000',
      likeCount: 12,
      commentsCount: 3,
      insights: { reach: 1000, likes: 12, comments: 3, saved: 5, shares: 2, views: 800, total_interactions: 30 },
      comments: [
        { id: 'c1', text: 'nice', username: 'user1', timestamp: '2026-08-12T11:00:00+0000' },
      ],
    })
  })

  async function createPublishedPost(targets, extra = {}) {
    const post = await postService.createPost(client.id, {
      name: `Eng Post ${generateUuid()}`,
      type: 'post',
      caption: 'Engage me',
      mediaUrl: 'https://example.com/img.jpg',
      ...extra,
      targetAccountIds: targets,
    })
    await postService.submitPost(client.id, post.id)
    await postService.approvePost(admin.id, post.id, {})
    await drainCampaignJobs()
    return post.id
  }

  async function createSubmittedOnlyPost(targets, extra = {}) {
    const data = {
      name: `Eng Post ${generateUuid()}`,
      type: 'post',
      caption: 'Engage me',
      mediaUrl: 'https://example.com/img.jpg',
      ...extra,
      targetAccountIds: targets,
    }
    if (data.type === 'story') delete data.caption
    const post = await postService.createPost(client.id, data)
    await postService.submitPost(client.id, post.id)
    await postService.approvePost(admin.id, post.id, {})
    await drainCampaignJobs()
    const posted = await postRepo.findPostTargetsByPostId(post.id)
    for (const t of posted) {
      await postRepo.updatePostTargetStatus(t.id, {
        status: 'posted',
        metaObjectId: `mock_ig_story_${t.id}`,
        postedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      })
    }
    return post.id
  }

  it('should sync engagement into a daily row and stamp the target', async () => {
    const postId = await createPublishedPost([igAccountId])
    const targets = await postRepo.findPostTargetsByPostId(postId)
    const target = targets.find(t => t.status === 'posted')
    expect(target).toBeTruthy()

    const result = await postService.syncPostEngagementJob(postId)
    expect(result.synced).toBe(1)

    const rows = await postRepo.findPostEngagement(postId)
    expect(rows).toHaveLength(1)
    expect(rows[0].likes).toBe(12)
    expect(rows[0].reach).toBe(1000)
    expect(rows[0].views).toBe(800)
    expect(rows[0].comments).toBe(3)
    expect(rows[0].saved).toBe(5)
    expect(rows[0].shares).toBe(2)
    expect(rows[0].interactions).toBe(30)
    expect(rows[0].permalink).toBe('https://instagram.com/p/mock-reel/')
    expect(rows[0].commentsJson).toHaveLength(1)
    expect(rows[0].error).toBeNull()

    const stamped = await queryOne('SELECT last_engagement_sync_at FROM post_targets WHERE id = ?', [uuidToBuffer(target.id)])
    expect(stamped.last_engagement_sync_at).toBeTruthy()

    const due = await postRepo.findPostsDueForEngagementSync({ stalenessSeconds: 3600, limit: 20 })
    expect(due).not.toContain(postId)
  })

  it('should upsert the same stat date instead of duplicating', async () => {
    const postId = await createPublishedPost([igAccountId])
    await postService.syncPostEngagementJob(postId)
    metaMocks.getMediaEngagement.mockResolvedValue({
      mediaId: 'mock_ig_post_1',
      mediaType: 'VIDEO',
      mediaProductType: 'REELS',
      permalink: 'https://instagram.com/p/mock-reel/',
      timestamp: '2026-08-12T10:00:00+0000',
      likeCount: 20,
      commentsCount: 5,
      insights: { reach: 1200, likes: 20, comments: 5, saved: 7, shares: 3, views: 900, total_interactions: 40 },
      comments: [],
    })
    await postService.syncPostEngagementJob(postId)

    const rows = await postRepo.findPostEngagement(postId)
    expect(rows).toHaveLength(1)
    expect(rows[0].likes).toBe(20)
  })

  it('should isolate per-target failures and record the error row', async () => {
    const postId = await createPublishedPost([igAccountId])
    metaMocks.getMediaEngagement.mockRejectedValue(new Error('Graph API down'))

    const result = await postService.syncPostEngagementJob(postId)
    expect(result.synced).toBe(0)
    expect(result.total).toBe(1)

    const rows = await postRepo.findPostEngagement(postId)
    expect(rows).toHaveLength(1)
    expect(rows[0].error).toBe('Graph API down')
    expect(rows[0].likes).toBe(0)

    const stamped = await queryOne('SELECT last_engagement_sync_at FROM post_targets WHERE id = ?', [uuidToBuffer(rows[0].targetId)])
    expect(stamped.last_engagement_sync_at).toBeTruthy()
  })

  it('should skip non-posted targets and posts without meta ids', async () => {
    const post = await postService.createPost(client.id, {
      name: `Eng Pending ${generateUuid()}`,
      type: 'post',
      caption: 'Pending',
      mediaUrl: 'https://example.com/img.jpg',
      targetAccountIds: [fbAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const result = await postService.syncPostEngagementJob(post.id)
    expect(result.synced).toBe(0)
    expect(metaMocks.getMediaEngagement).not.toHaveBeenCalled()
  })

  it('should throw NotFoundError for unknown post', async () => {
    await expect(postService.syncPostEngagementJob(generateUuid())).rejects.toThrow(NotFoundError)
  })

  it('should enqueue via schedulePostEngagementSyncs and dedupe', async () => {
    const postId = await createPublishedPost([igAccountId])
    const first = await postService.schedulePostEngagementSyncs()
    expect(first.enqueued).toContain(postId)
    const second = await postService.schedulePostEngagementSyncs()
    expect(second.enqueued).not.toContain(postId)

    await drainCampaignJobs()
    const rows = await postRepo.findPostEngagement(postId)
    expect(rows.length).toBeGreaterThan(0)
  })

  it('should return cached engagement grouped by target for the owner', async () => {
    const postId = await createPublishedPost([igAccountId])
    await postService.syncPostEngagementJob(postId)

    const result = await postService.getPostEngagement(client.id, postId)
    expect(result.cached).toBe(true)
    expect(result.postId).toBe(postId)
    expect(result.targets).toHaveLength(1)
    expect(result.targets[0].latest.likes).toBe(12)
    expect(result.targets[0].platformDisplayName).toBe('Display eng_ig_acct_1')
  })

  it('should forbid non-owners and queue refresh for owners', async () => {
    const postId = await createPublishedPost([igAccountId])

    await expect(postService.getPostEngagement(otherClient.id, postId)).rejects.toThrow(ForbiddenError)
    await expect(postService.getPostEngagement(otherClient.id, postId, { refresh: true })).rejects.toThrow(ForbiddenError)

    const refreshed = await postService.getPostEngagement(client.id, postId, { refresh: true })
    expect(refreshed.queued).toBe(true)
    expect(refreshed.enqueued).toBe(true)

    await drainCampaignJobs()
    const rows = await postRepo.findPostEngagement(postId)
    expect(rows.length).toBeGreaterThan(0)
  })

  it('should expose admin access without ownership', async () => {
    const postId = await createPublishedPost([igAccountId])
    await postService.syncPostEngagementJob(postId)
    const result = await postService.getPostEngagement(null, postId, {}, { skipOwnership: true })
    expect(result.cached).toBe(true)
    expect(result.targets).toHaveLength(1)
  })

  it('should use the system token as the primary token for engagement reads', async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'test_system_token'
    const postId = await createPublishedPost([igAccountId])
    const result = await postService.syncPostEngagementJob(postId)
    expect(result.synced).toBe(1)
    expect(metaMocks.getMediaEngagement).toHaveBeenCalledTimes(1)
    expect(metaMocks.getMediaEngagement).toHaveBeenCalledWith(expect.any(String), 'test_system_token', { mediaKind: 'post', platform: 'instagram' })
    const rows = await postRepo.findPostEngagement(postId)
    expect(rows).toHaveLength(1)
    expect(rows[0].likes).toBe(12)
    expect(rows[0].error).toBeNull()
    delete process.env.META_SYSTEM_USER_TOKEN
  })

  it('should fall back to the client token when the system token fails', async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'test_system_token'
    const postId = await createPublishedPost([igAccountId])
    metaMocks.getMediaEngagement.mockRejectedValueOnce(new Error('Graph API down'))
    const result = await postService.syncPostEngagementJob(postId)
    expect(result.synced).toBe(1)
    expect(metaMocks.getMediaEngagement).toHaveBeenCalledTimes(2)
    expect(metaMocks.getMediaEngagement).toHaveBeenLastCalledWith(expect.any(String), 'mock_page_token', { mediaKind: 'post', platform: 'instagram' })
    const rows = await postRepo.findPostEngagement(postId)
    expect(rows).toHaveLength(1)
    expect(rows[0].likes).toBe(12)
    expect(rows[0].error).toBeNull()
    delete process.env.META_SYSTEM_USER_TOKEN
  })

  it('should record the error when both tokens fail', async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'test_system_token'
    const postId = await createPublishedPost([igAccountId])
    metaMocks.getMediaEngagement.mockRejectedValue(new Error('Graph API down'))
    const result = await postService.syncPostEngagementJob(postId)
    expect(result.synced).toBe(0)
    expect(metaMocks.getMediaEngagement).toHaveBeenCalledTimes(2)
    const rows = await postRepo.findPostEngagement(postId)
    expect(rows[0].error).toBe('Graph API down')
    delete process.env.META_SYSTEM_USER_TOKEN
  })

  it('should use story-only fields and store story insights for story media', async () => {
    const postId = await createSubmittedOnlyPost([igAccountId], { type: 'story' })
    metaMocks.getMediaEngagement.mockResolvedValue({
      mediaId: 'mock_ig_story_1',
      mediaType: 'VIDEO',
      mediaProductType: null,
      permalink: 'https://instagram.com/stories/eng_ig_acct_1/123/',
      timestamp: '2026-08-12T10:00:00+0000',
      likeCount: null,
      commentsCount: null,
      insights: { impressions: 240, reach: 180, views: 200, taps_forward: 12, taps_back: 3, exits: 7, replies: 5 },
      comments: [],
    })
    await postService.syncPostEngagementJob(postId)

    expect(metaMocks.getMediaEngagement).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { mediaKind: 'story', platform: 'instagram' }
    )
    const rows = await postRepo.findPostEngagement(postId)
    expect(rows).toHaveLength(1)
    expect(rows[0].impressions).toBe(240)
    expect(rows[0].reach).toBe(180)
    expect(rows[0].views).toBe(200)
    expect(rows[0].tapsForward).toBe(12)
    expect(rows[0].tapsBack).toBe(3)
    expect(rows[0].exits).toBe(7)
    expect(rows[0].replies).toBe(5)
    expect(rows[0].error).toBeNull()
  })

  it('should store FB video story engagement through the video node', async () => {
    const postId = await createSubmittedOnlyPost([fbAccountId], { type: 'story' })
    metaMocks.getMediaEngagement.mockResolvedValue({
      mediaId: 'fb_story_video_1',
      mediaType: 'video',
      mediaProductType: null,
      permalink: 'https://www.facebook.com/reel/1051217994554694/',
      timestamp: '2026-08-12T10:00:00+0000',
      likeCount: 9,
      commentsCount: 2,
      insights: { views: 500 },
      comments: [],
    })
    const result = await postService.syncPostEngagementJob(postId)
    expect(result.synced).toBe(1)
    expect(metaMocks.getMediaEngagement).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { mediaKind: 'story', platform: 'facebook' }
    )
    const rows = await postRepo.findPostEngagement(postId)
    expect(rows[0].mediaType).toBe('video')
    expect(rows[0].views).toBe(500)
    expect(rows[0].likes).toBe(9)
    expect(rows[0].comments).toBe(2)
    expect(rows[0].error).toBeNull()
  })

  it('should record a clean no-data row when an FB story node is not queryable', async () => {
    const postId = await createSubmittedOnlyPost([fbAccountId], { type: 'story' })
    metaMocks.getMediaEngagement.mockResolvedValue({
      mediaId: 'fb_story_1',
      mediaType: null,
      mediaProductType: null,
      permalink: null,
      timestamp: null,
      likeCount: null,
      commentsCount: null,
      insights: {},
      comments: [],
      storyInsightError: 'unsupported story object',
    })
    const result = await postService.syncPostEngagementJob(postId)
    expect(result.synced).toBe(1)
    const rows = await postRepo.findPostEngagement(postId)
    expect(rows[0].mediaType).toBeNull()
    expect(rows[0].impressions).toBe(0)
    expect(rows[0].views).toBe(0)
    expect(rows[0].error).toBeNull()
  })

  it('should not schedule engagement for stories older than the 24h window', async () => {
    const postId = await createSubmittedOnlyPost([igAccountId], { type: 'story' })
    const targets = await postRepo.findPostTargetsByPostId(postId)
    const t = targets[0]
    await postRepo.updatePostTargetStatus(t.id, {
      postedAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' '),
    })
    const due = await postRepo.findPostsDueForEngagementSync({ stalenessSeconds: 3600, limit: 20 })
    expect(due).not.toContain(postId)
    const dueFresh = await postRepo.findPostsDueForEngagementSync({ stalenessSeconds: 3600, limit: 20, storyMaxAgeHours: 48 })
    expect(dueFresh).toContain(postId)
  })

  it('should pass facebook platform for FB targets and store FB photo engagement', async () => {
    const postId = await createPublishedPost([fbAccountId])
    metaMocks.getMediaEngagement.mockResolvedValue({
      mediaId: 'fb_photo_1',
      mediaType: 'photo',
      mediaProductType: null,
      permalink: 'https://www.facebook.com/photo.php?fbid=122121852308927287',
      timestamp: '2026-08-12T09:00:00+0000',
      likeCount: 4,
      commentsCount: 1,
      insights: {},
      comments: [],
    })

    const result = await postService.syncPostEngagementJob(postId)
    expect(result.synced).toBe(1)
    expect(metaMocks.getMediaEngagement).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { mediaKind: 'post', platform: 'facebook' }
    )

    const rows = await postRepo.findPostEngagement(postId)
    expect(rows).toHaveLength(1)
    expect(rows[0].mediaType).toBe('photo')
    expect(rows[0].likes).toBe(4)
    expect(rows[0].comments).toBe(1)
    expect(rows[0].views).toBe(0)
    expect(rows[0].permalink).toBe('https://www.facebook.com/photo.php?fbid=122121852308927287')
    expect(rows[0].error).toBeNull()
  })

  it('should record FB video views from video_insights', async () => {
    const postId = await createPublishedPost([fbAccountId])
    metaMocks.getMediaEngagement.mockResolvedValue({
      mediaId: 'fb_video_1',
      mediaType: 'video',
      mediaProductType: null,
      permalink: 'https://www.facebook.com/reel/1366664162336603',
      timestamp: '2026-08-12T09:00:00+0000',
      likeCount: 8,
      commentsCount: 2,
      insights: { views: 340 },
      comments: [],
    })

    const result = await postService.syncPostEngagementJob(postId)
    expect(result.synced).toBe(1)

    const rows = await postRepo.findPostEngagement(postId)
    expect(rows[0].mediaType).toBe('video')
    expect(rows[0].views).toBe(340)
    expect(rows[0].likes).toBe(8)
  })

  it('should use the owner page token (not the system token) for FB targets', async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'test_system_token'
    const postId = await createPublishedPost([fbAccountId])
    metaMocks.getMediaEngagement.mockResolvedValue({
      mediaId: 'fb_video_1',
      mediaType: 'video',
      mediaProductType: null,
      permalink: 'https://www.facebook.com/reel/1366664162336603',
      timestamp: '2026-08-12T09:00:00+0000',
      likeCount: 8,
      commentsCount: 2,
      insights: { views: 340 },
      comments: [],
    })

    const result = await postService.syncPostEngagementJob(postId)
    expect(result.synced).toBe(1)
    expect(metaMocks.getMediaEngagement).toHaveBeenCalledTimes(1)
    expect(metaMocks.getMediaEngagement).toHaveBeenCalledWith(expect.any(String), 'mock_page_token', {
      mediaKind: 'post',
      platform: 'facebook',
    })
    delete process.env.META_SYSTEM_USER_TOKEN
  })

  it('should not fall back to the system token when the FB owner token fails', async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'test_system_token'
    const postId = await createPublishedPost([fbAccountId])
    metaMocks.getMediaEngagement.mockRejectedValue(new Error('Graph API down'))
    const result = await postService.syncPostEngagementJob(postId)
    expect(result.synced).toBe(0)
    expect(metaMocks.getMediaEngagement).toHaveBeenCalledTimes(1)
    const rows = await postRepo.findPostEngagement(postId)
    expect(rows[0].error).toBe('Graph API down')
    delete process.env.META_SYSTEM_USER_TOKEN
  })

  it('should delete the orphan container and null the meta id via cleanupOrphanContainers', async () => {
    const postId = await createPublishedPost([igAccountId])
    const targets = await postRepo.findPostTargetsByPostId(postId)
    const target = targets.find(t => t.status === 'posted')
    expect(target.metaObjectId).toBe('mock_ig_post_1')

    const results = await postService.cleanupOrphanContainers()
    expect(results.deleted).toBeGreaterThanOrEqual(1)
    expect(metaMocks.deleteInstagramContainer).toHaveBeenCalledWith('mock_ig_post_1', 'mock_page_token')

    const after = await postRepo.findPostTargetsByPostId(postId)
    expect(after.find(t => t.id === target.id).metaObjectId).toBeNull()
  })

  it('should keep published media in cleanupOrphanContainers', async () => {
    const postId = await createPublishedPost([igAccountId])
    metaMocks.getContainerStatus.mockResolvedValue({ status_code: 'PUBLISHED' })
    metaMocks.deleteInstagramContainer.mockClear()

    const results = await postService.cleanupOrphanContainers()
    expect(results.deleted).toBe(0)
    expect(metaMocks.deleteInstagramContainer).not.toHaveBeenCalled()

    const targets = await postRepo.findPostTargetsByPostId(postId)
    expect(targets.find(t => t.status === 'posted').metaObjectId).toBe('mock_ig_post_1')
  })

  it('should skip targets whose container probe fails in cleanupOrphanContainers', async () => {
    await createPublishedPost([igAccountId])
    metaMocks.getContainerStatus.mockRejectedValue(new Error('Graph API down'))
    metaMocks.deleteInstagramContainer.mockClear()

    const results = await postService.cleanupOrphanContainers()
    expect(results.deleted).toBe(0)
    expect(results.skipped).toBeGreaterThanOrEqual(1)
    expect(metaMocks.deleteInstagramContainer).not.toHaveBeenCalled()
  })

  it('should null the meta id when Meta reports the orphan container no longer exists', async () => {
    const postId = await createPublishedPost([igAccountId])
    metaMocks.getContainerStatus.mockResolvedValue({ status_code: 'FINISHED' })
    metaMocks.deleteInstagramContainer.mockRejectedValue(
      new Error('Graph API DELETE mock_ig_post_1 failed: {"error":{"message":"Object with ID \'mock_ig_post_1\' does not exist, cannot be loaded due to missing permissions, or does not support this operation","type":"GraphMethodException","code":100,"error_subcode":33}}')
    )

    const results = await postService.cleanupOrphanContainers()
    expect(results.deleted).toBeGreaterThanOrEqual(1)

    const targets = await postRepo.findPostTargetsByPostId(postId)
    expect(targets.find(t => t.status === 'posted').metaObjectId).toBeNull()
  })

  it('should delete the unpublished container when media publish fails', async () => {
    const post = await postService.createPost(client.id, {
      name: `Eng Fail ${generateUuid()}`,
      type: 'reel',
      caption: 'Will fail',
      mediaUrl: 'https://example.com/vid.mp4',
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const permanent = new Error('(#100) something failed')
    permanent.metaHttpStatus = 400
    permanent.metaErrorCode = 100
    metaMocks.publishInstagramMedia.mockRejectedValue(permanent)
    metaMocks.publishInstagramMedia.mockClear()
    metaMocks.deleteInstagramContainer.mockClear()
    metaMocks.getContainerStatus.mockResolvedValue({ status_code: 'FINISHED' })
    postService.igVideoState.pollSeconds = 0
    try {
      await postService.approvePost(admin.id, post.id, {})
      await drainCampaignJobs()
    } finally {
      postService.igVideoState.pollSeconds = 5
    }

    expect(metaMocks.deleteInstagramContainer).toHaveBeenCalledWith('mock_ig_container_1', 'mock_page_token')
    expect(metaMocks.deleteInstagramContainer).toHaveBeenCalledTimes(1)
    expect(metaMocks.publishInstagramMedia).toHaveBeenCalledTimes(1)
  })
})
