import { describe, it, expect, beforeAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { encrypt } from '../../shared/utils/crypto.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as postService from '../../src/modules/posts/post.service.js'
import * as postRepo from '../../src/modules/posts/post.repository.js'
import { queryOne, query } from '../../shared/database/connection.js'
import { drainCampaignJobs } from '../../src/modules/campaigns/campaign.jobs.js'

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
    getContainerStatus: vi.fn().mockResolvedValue({ status_code: 'FINISHED' }),
    getPostPromotability: vi.fn().mockResolvedValue({ isEligible: true, promotableId: 'mock_promotable_1', allowedObjectives: [], instagramEligibility: 'eligible', raw: {} }),
  }
  metaMocks = mocks
  return mocks
})

vi.mock('../../shared/services/meta-graph.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-graph.service.js')
  return {
    ...actual,
    getInstagramMedia: vi.fn().mockResolvedValue([]),
  }
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

describe('post publishing', () => {
  let client, admin, fbAccountId, igAccountId

  beforeAll(async () => {
    client = await createTestUser({ email: `post-pub-client-${dateTag}@flowx-test.com`, password: 'Test@123' })
    fbAccountId = await addPlatformAccount(client.id, { code: 'facebook', platformUserId: 'pub_fb_page_1' })
    igAccountId = await addPlatformAccount(client.id, {
      code: 'instagram',
      platformUserId: 'pub_ig_acct_1',
      igId: '17841411111111111',
    })
    const adminRow = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    admin = { id: adminRow ? bufferToUuid(adminRow.id) : null }
  })

  beforeEach(() => {
    metaMocks.createPagePhotoPost.mockReset().mockResolvedValue({ id: 'mock_fb_post_1' })
    metaMocks.createPageVideoPost.mockReset().mockResolvedValue({ id: 'mock_fb_video_1' })
    metaMocks.createFeedPost.mockReset().mockResolvedValue({ id: 'mock_fb_link_1' })
    metaMocks.createInstagramMedia.mockReset().mockResolvedValue({ id: 'mock_ig_container_1' })
    metaMocks.publishInstagramMedia.mockReset().mockResolvedValue({ id: 'mock_ig_post_1' })
    metaMocks.createInstagramStory.mockReset().mockResolvedValue({ id: 'mock_ig_story_1' })
    metaMocks.getContainerStatus.mockReset().mockResolvedValue({ status_code: 'FINISHED' })
  })

  async function withFastPolling(fn) {
    const interval = postService.igContainerPoll.intervalMs
    const timeout = postService.igContainerPoll.timeoutMs
    const pollSeconds = postService.igVideoState.pollSeconds
    const cap = postService.igVideoState.processingCapMs
    const verifyBackoff = postService.igVideoState.verifyBackoffSeconds
    const backoffSteps = postService.igVideoState.backoffSteps
    postService.igContainerPoll.intervalMs = 5
    postService.igContainerPoll.timeoutMs = 500
    postService.igVideoState.pollSeconds = 0
    postService.igVideoState.processingCapMs = 1000
    postService.igVideoState.verifyBackoffSeconds = 0
    postService.igVideoState.backoffSteps = [0, 0, 0, 0, 0, 0]
    try {
      return await fn()
    } finally {
      postService.igContainerPoll.intervalMs = interval
      postService.igContainerPoll.timeoutMs = timeout
      postService.igVideoState.pollSeconds = pollSeconds
      postService.igVideoState.processingCapMs = cap
      postService.igVideoState.verifyBackoffSeconds = verifyBackoff
      postService.igVideoState.backoffSteps = backoffSteps
    }
  }

  async function createSubmittedPost(targets, extra = {}) {
    const post = await postService.createPost(client.id, {
      name: `Pub Post ${generateUuid()}`,
      type: 'post',
      caption: 'Publish me',
      mediaUrl: 'https://example.com/img.jpg',
      ...extra,
      targetAccountIds: targets,
    })
    await postService.submitPost(client.id, post.id)
    return post.id
  }

  it('should publish to all targets and complete the post', async () => {
    const postId = await createSubmittedPost([fbAccountId, igAccountId])
    const result = await postService.approvePost(admin.id, postId, {})
    expect(result.status).toBe('approved')
    await drainCampaignJobs()

    const detail = await postService.getPost(client.id, postId)
    expect(detail.status).toBe('completed')
    expect(detail.publishedAt).toBeTruthy()
    expect(detail.targets.every(t => t.status === 'posted')).toBe(true)
    expect(metaMocks.createPagePhotoPost).toHaveBeenCalledTimes(1)
    expect(metaMocks.createInstagramMedia).toHaveBeenCalledTimes(1)
    expect(metaMocks.publishInstagramMedia).toHaveBeenCalledTimes(1)
  })

  it('should isolate per-target failures and keep post running', async () => {
    metaMocks.createPagePhotoPost.mockRejectedValueOnce(new Error('Photo API down'))
    const postId = await createSubmittedPost([fbAccountId, igAccountId])
    await postService.approvePost(admin.id, postId, {})
    await drainCampaignJobs()

    const detail = await postService.getPost(client.id, postId)
    expect(detail.status).toBe('running')
    const fbTarget = detail.targets.find(t => t.platformCode === 'facebook')
    const igTarget = detail.targets.find(t => t.platformCode === 'instagram')
    expect(fbTarget.status).toBe('failed')
    expect(fbTarget.error).toContain('Photo API down')
    expect(igTarget.status).toBe('posted')
  })

  it('should retry only the failed target and complete the post', async () => {
    metaMocks.createPagePhotoPost.mockRejectedValueOnce(new Error('Photo API down'))
    const postId = await createSubmittedPost([fbAccountId, igAccountId])
    await postService.approvePost(admin.id, postId, {})
    await drainCampaignJobs()
    let detail = await postService.getPost(client.id, postId)
    expect(detail.status).toBe('running')

    const retry = await postService.retryPostPublish(postId)
    expect(retry.queued).toBe(true)
    await drainCampaignJobs()

    detail = await postService.getPost(client.id, postId)
    expect(detail.status).toBe('completed')
    expect(detail.targets.every(t => t.status === 'posted')).toBe(true)
    expect(metaMocks.createPagePhotoPost).toHaveBeenCalledTimes(2)
    expect(metaMocks.createInstagramMedia).toHaveBeenCalledTimes(1)
  })

  it('should throw when every target fails', async () => {
    metaMocks.createPagePhotoPost.mockRejectedValue(new Error('FB down'))
    metaMocks.createInstagramMedia.mockRejectedValue(new Error('IG down'))
    const postId = await createSubmittedPost([fbAccountId, igAccountId])
    await postService.approvePost(admin.id, postId, {})
    await expect(drainCampaignJobs({ timeoutMs: 4000 })).rejects.toThrow(/timed out/i)

    const detail = await postService.getPost(client.id, postId)
    expect(detail.status).toBe('approved')
    expect(detail.targets.every(t => t.status === 'failed')).toBe(true)
    const job = await queryOne('SELECT * FROM campaign_jobs WHERE campaign_id = ?', [uuidToBuffer(postId)])
    expect(job.status).toBe('queued')

    await query('DELETE FROM campaign_jobs WHERE campaign_id = ?', [uuidToBuffer(postId)])
  })

  it('should respect future run_after for scheduled posts', async () => {
    const scheduledAt = new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
    const post = await postService.createPost(client.id, {
      name: 'Scheduled post',
      type: 'post',
      caption: 'Later',
      scheduledAt,
      targetAccountIds: [fbAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const result = await postService.approvePost(admin.id, post.id, {})
    expect(result.status).toBe('scheduled')

    const job = await queryOne(
      "SELECT * FROM campaign_jobs WHERE campaign_id = ? AND job_type = 'post_publish'",
      [uuidToBuffer(post.id)]
    )
    expect(job).toBeTruthy()
    expect(job.status).toBe('queued')
    expect(new Date(job.run_after).getTime()).toBeGreaterThan(Date.now())

    const after = await postService.getPost(client.id, post.id)
    expect(after.status).toBe('scheduled')
    await query('DELETE FROM campaign_jobs WHERE campaign_id = ?', [uuidToBuffer(post.id)])
  })

  it('should publish a story type post via story endpoints', async () => {
    const post = await postService.createPost(client.id, {
      name: 'Story post',
      type: 'story',
      mediaUrl: 'https://example.com/story.jpg',
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    await postService.approvePost(admin.id, post.id, {})
    await drainCampaignJobs()

    const detail = await postService.getPost(client.id, post.id)
    expect(detail.status).toBe('completed')
    expect(metaMocks.createInstagramStory).toHaveBeenCalledTimes(1)
    expect(metaMocks.createInstagramMedia).not.toHaveBeenCalled()
  })

  it('should publish a video story after waiting for the container to be ready', async () => {
    metaMocks.getContainerStatus
      .mockResolvedValueOnce({ status_code: 'IN_PROGRESS' })
      .mockResolvedValue({ status_code: 'FINISHED' })
    const post = await postService.createPost(client.id, {
      name: 'Video story',
      type: 'story',
      mediaUrl: 'https://example.com/story_video.mp4',
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    await withFastPolling(async () => {
      await postService.approvePost(admin.id, post.id, {})
      await drainCampaignJobs()
    })

    const detail = await postService.getPost(client.id, post.id)
    expect(detail.status).toBe('completed')
    expect(metaMocks.createInstagramStory).toHaveBeenCalledWith(
      '17841411111111111',
      'https://example.com/story_video.mp4',
      'mock_page_token',
      { videoUrl: 'https://example.com/story_video.mp4' }
    )
    expect(metaMocks.getContainerStatus).toHaveBeenCalledTimes(2)
    expect(metaMocks.publishInstagramMedia).toHaveBeenCalledTimes(1)
  })

  it('should fail the video story target when the container never becomes ready', async () => {
    metaMocks.getContainerStatus.mockResolvedValue({ status_code: 'IN_PROGRESS' })
    const post = await postService.createPost(client.id, {
      name: 'Stuck story',
      type: 'story',
      mediaUrl: 'https://example.com/stuck.mp4',
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    await withFastPolling(async () => {
      await postService.approvePost(admin.id, post.id, {})
      await drainCampaignJobs()
    })

    const detail = await postService.getPost(client.id, post.id)
    expect(detail.targets[0].status).toBe('failed')
    expect(detail.targets[0].error).toContain('Timed out waiting for Instagram to process the media container')
    expect(metaMocks.publishInstagramMedia).not.toHaveBeenCalled()
  })

  it('should surface story publish errors instead of marking the target posted', async () => {
    const permanent = new Error('Story publish denied')
    permanent.metaHttpStatus = 400
    permanent.metaErrorCode = 100
    metaMocks.publishInstagramMedia.mockRejectedValue(permanent)
    const post = await postService.createPost(client.id, {
      name: 'Denied story',
      type: 'story',
      mediaUrl: 'https://example.com/denied.mp4',
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    await withFastPolling(async () => {
      await postService.approvePost(admin.id, post.id, {})
      await drainCampaignJobs()
    })

    const detail = await postService.getPost(client.id, post.id)
    expect(detail.targets[0].status).toBe('failed')
    expect(detail.targets[0].error).toContain('Story publish denied')
  })

  it('should sniff extension-less video URLs for stories', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'video/mp4' },
    })
    try {
      const post = await postService.createPost(client.id, {
        name: 'Sniffed story',
        type: 'story',
        mediaUrl: 'https://cdn.example.com/story123',
        targetAccountIds: [igAccountId],
      })
      await postService.submitPost(client.id, post.id)
      await postService.approvePost(admin.id, post.id, {})
      await drainCampaignJobs()

      const detail = await postService.getPost(client.id, post.id)
      expect(detail.status).toBe('completed')
      expect(metaMocks.createInstagramStory).toHaveBeenCalledWith(
        '17841411111111111',
        'https://cdn.example.com/story123',
        'mock_page_token',
        { videoUrl: 'https://cdn.example.com/story123' }
      )
      expect(metaMocks.getContainerStatus).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('should publish a video post via createPageVideoPost for video media', async () => {
    const post = await postService.createPost(client.id, {
      name: 'Video post',
      type: 'post',
      caption: 'Watch this',
      mediaUrl: 'https://example.com/clip.mp4',
      targetAccountIds: [fbAccountId],
    })
    await postService.submitPost(client.id, post.id)
    await postService.approvePost(admin.id, post.id, {})
    await drainCampaignJobs()

    const detail = await postService.getPost(client.id, post.id)
    expect(detail.status).toBe('completed')
    expect(metaMocks.createPageVideoPost).toHaveBeenCalledTimes(1)
    expect(metaMocks.createPageVideoPost).toHaveBeenCalledWith(
      'pub_fb_page_1', 'mock_page_token', { url: 'https://example.com/clip.mp4', message: 'Watch this' }
    )
    expect(metaMocks.createPagePhotoPost).not.toHaveBeenCalled()
    expect(metaMocks.createFeedPost).not.toHaveBeenCalled()
  })

  it('should sniff content type and publish extension-less image URLs as photos', async () => {
    const realFetch = globalThis.fetch
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/jpeg' },
    })
    globalThis.fetch = fetchMock
    try {
      const post = await postService.createPost(client.id, {
        name: 'Sniffed image',
        type: 'post',
        caption: 'Pic',
        mediaUrl: 'https://cdn.example.com/abc123',
        targetAccountIds: [fbAccountId],
      })
      await postService.submitPost(client.id, post.id)
      await postService.approvePost(admin.id, post.id, {})
      await drainCampaignJobs()

      const detail = await postService.getPost(client.id, post.id)
      expect(detail.status).toBe('completed')
      expect(globalThis.fetch).toHaveBeenCalledTimes(1)
      expect(metaMocks.createPagePhotoPost).toHaveBeenCalledTimes(1)
      expect(metaMocks.createPageVideoPost).not.toHaveBeenCalled()
      expect(metaMocks.createFeedPost).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('should fall back to a link post when media type cannot be determined', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network unreachable'))
    try {
      const post = await postService.createPost(client.id, {
        name: 'Unknown media',
        type: 'post',
        caption: 'Fallback',
        mediaUrl: 'https://cdn.example.com/abc123',
        targetAccountIds: [fbAccountId],
      })
      await postService.submitPost(client.id, post.id)
      await postService.approvePost(admin.id, post.id, {})
      await drainCampaignJobs()

      const detail = await postService.getPost(client.id, post.id)
      expect(detail.status).toBe('completed')
      expect(metaMocks.createFeedPost).toHaveBeenCalledTimes(1)
      expect(metaMocks.createPagePhotoPost).not.toHaveBeenCalled()
      expect(metaMocks.createPageVideoPost).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('should publish a link post via createFeedPost for non-media URLs', async () => {
    const post = await postService.createPost(client.id, {
      name: 'Link post',
      type: 'post',
      caption: 'Read this',
      mediaUrl: 'https://invalid.invalid/article',
      targetAccountIds: [fbAccountId],
    })
    await postService.submitPost(client.id, post.id)
    await postService.approvePost(admin.id, post.id, {})
    await drainCampaignJobs()

    const detail = await postService.getPost(client.id, post.id)
    expect(detail.status).toBe('completed')
    expect(metaMocks.createFeedPost).toHaveBeenCalledTimes(1)
    expect(metaMocks.createFeedPost).toHaveBeenCalledWith(
      'pub_fb_page_1', 'Read this', 'https://invalid.invalid/article', null, 'mock_page_token'
    )
    expect(metaMocks.createPagePhotoPost).not.toHaveBeenCalled()
    expect(metaMocks.createPageVideoPost).not.toHaveBeenCalled()
  })

  it('should stamp failed status via markPostJobFailed', async () => {
    const post = await postService.createPost(client.id, {
      name: 'Job failed post',
      type: 'post',
      caption: 'x',
      targetAccountIds: [fbAccountId],
    })
    await postService.submitPost(client.id, post.id)
    await postService.approvePost(admin.id, post.id, {})
    await postService.markPostJobFailed(post.id, 'Meta rejected the post')
    const detail = await postService.getPost(client.id, post.id)
    expect(detail.status).toBe('failed')
    expect(detail.error).toContain('Meta rejected')
    await query('DELETE FROM campaign_jobs WHERE campaign_id = ?', [uuidToBuffer(post.id)])
  })

  it('should not publish when post is not in publishable status', async () => {
    const post = await postService.createPost(client.id, { name: 'Draft only', type: 'post' })
    await expect(postService.publishPostJob(post.id)).rejects.toThrow(/cannot be published/i)
  })

  it('should publish a reel after waiting for the container to be ready', async () => {
    const post = await postService.createPost(client.id, {
      name: 'Reel post',
      type: 'reel',
      caption: 'Reel time',
      mediaUrl: 'https://example.com/reel.mp4',
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    await postService.approvePost(admin.id, post.id, {})
    await drainCampaignJobs()

    const detail = await postService.getPost(client.id, post.id)
    expect(detail.status).toBe('completed')
    expect(metaMocks.createInstagramMedia).toHaveBeenCalledWith(
      '17841411111111111',
      'https://example.com/reel.mp4',
      'Reel time',
      'mock_page_token',
      { mediaType: 'REELS', videoUrl: 'https://example.com/reel.mp4' }
    )
    expect(metaMocks.getContainerStatus).toHaveBeenCalledTimes(1)
    expect(metaMocks.getContainerStatus).toHaveBeenCalledWith('mock_ig_container_1', 'mock_page_token')
    expect(metaMocks.publishInstagramMedia).toHaveBeenCalledTimes(1)
  })

  it('should keep polling while the reel container is still processing', async () => {
    metaMocks.getContainerStatus
      .mockResolvedValueOnce({ status_code: 'IN_PROGRESS' })
      .mockResolvedValueOnce({ status_code: 'IN_PROGRESS' })
      .mockResolvedValue({ status_code: 'FINISHED' })
    const post = await postService.createPost(client.id, {
      name: 'Reel processing',
      type: 'reel',
      caption: 'Wait for it',
      mediaUrl: 'https://example.com/reel2.mp4',
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    await withFastPolling(async () => {
      await postService.approvePost(admin.id, post.id, {})
      await drainCampaignJobs()
    })

    const detail = await postService.getPost(client.id, post.id)
    expect(detail.status).toBe('completed')
    expect(metaMocks.getContainerStatus).toHaveBeenCalledTimes(3)
    expect(metaMocks.publishInstagramMedia).toHaveBeenCalledTimes(1)
  })

  it('should surface the container error when the reel fails processing', async () => {
    metaMocks.getContainerStatus.mockResolvedValue({
      status_code: 'ERROR',
      status: { error: { message: 'Video failed to process' } },
    })
    const post = await postService.createPost(client.id, {
      name: 'Reel error',
      type: 'reel',
      caption: 'Will fail',
      mediaUrl: 'https://example.com/reel3.mp4',
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    await withFastPolling(async () => {
      await postService.approvePost(admin.id, post.id, {})
      await drainCampaignJobs()
    })

    const detail = await postService.getPost(client.id, post.id)
    expect(detail.status).toBe('failed')
    expect(detail.targets[0].status).toBe('failed')
    expect(detail.targets[0].error).toContain('Video failed to process')
    expect(metaMocks.publishInstagramMedia).not.toHaveBeenCalled()
  })

  it('should reject a reel with a clear error when media is not a video', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/jpeg' },
    })
    try {
      const post = await postService.createPost(client.id, {
        name: 'Bad reel',
        type: 'reel',
        caption: 'Image in reel',
        mediaUrl: 'https://example.com/pic.jpg',
        targetAccountIds: [igAccountId],
      })
      await expect(postService.submitPost(client.id, post.id)).rejects.toMatchObject({
        code: 'POST_VALIDATION_ERROR',
      })
      const detail = await postService.getPost(client.id, post.id)
      expect(detail.targets[0].status).toBe('pending')
      expect(metaMocks.createInstagramMedia).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('should fail the reel target when the container never becomes ready', async () => {
    metaMocks.getContainerStatus.mockResolvedValue({ status_code: 'IN_PROGRESS' })
    const post = await postService.createPost(client.id, {
      name: 'Reel timeout',
      type: 'reel',
      caption: 'Never ready',
      mediaUrl: 'https://example.com/reel4.mp4',
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    await withFastPolling(async () => {
      await postService.approvePost(admin.id, post.id, {})
      await drainCampaignJobs()
    })

    const detail = await postService.getPost(client.id, post.id)
    expect(detail.targets[0].status).toBe('failed')
    expect(detail.targets[0].error).toContain('Timed out waiting for Instagram to process the media container')
    expect(metaMocks.publishInstagramMedia).not.toHaveBeenCalled()
  })

  it('should publish extension-less video URLs on Instagram as reels', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'video/mp4' },
    })
    try {
      const post = await postService.createPost(client.id, {
        name: 'Sniffed video',
        type: 'post',
        caption: 'Video',
        mediaUrl: 'https://cdn.example.com/abc123',
        targetAccountIds: [igAccountId],
      })
      await postService.submitPost(client.id, post.id)
      await postService.approvePost(admin.id, post.id, {})
      await drainCampaignJobs()

      const detail = await postService.getPost(client.id, post.id)
      expect(detail.status).toBe('completed')
      expect(metaMocks.createInstagramMedia).toHaveBeenCalledWith(
        '17841411111111111',
        'https://cdn.example.com/abc123',
        'Video',
        'mock_page_token',
        { mediaType: 'REELS', videoUrl: 'https://cdn.example.com/abc123' }
      )
      expect(metaMocks.getContainerStatus).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
