import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { encrypt } from '../../shared/utils/crypto.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as postService from '../../src/modules/posts/post.service.js'
import { queryOne, query } from '../../shared/database/connection.js'
import { drainCampaignJobs } from '../../src/modules/campaigns/campaign.jobs.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    createPagePhotoPost: vi.fn().mockResolvedValue({ id: 'mock_fb_photo' }),
    createPageVideoPost: vi.fn().mockResolvedValue({ id: 'mock_fb_video' }),
    createFeedPost: vi.fn().mockResolvedValue({ id: 'mock_fb_link' }),
    createPageVideoStory: vi.fn().mockResolvedValue({ id: 'mock_fb_video_story' }),
    createPagePhotoStory: vi.fn().mockResolvedValue({ id: 'mock_fb_photo_story' }),
    createInstagramMedia: vi.fn().mockResolvedValue({ id: 'mock_ig_container' }),
    publishInstagramMedia: vi.fn().mockResolvedValue({ id: 'mock_ig_post' }),
    getContainerStatus: vi.fn().mockResolvedValue({ status_code: 'FINISHED' }),
    startPageReel: vi.fn().mockResolvedValue({
      video_id: 'mock_fb_video_id',
      upload_url: 'https://rupload.facebook.com/mock_reel',
    }),
    uploadPageReelMedia: vi.fn().mockResolvedValue({ success: true }),
    getPageReelStatus: vi.fn().mockResolvedValue({ video_status: 'ready' }),
    finishPageReel: vi.fn().mockResolvedValue({ post_id: 'mock_fb_reel_post', success: true }),
    resolvePageReelPostId: vi.fn().mockResolvedValue({ postId: 'mock_fb_reel_post', ambiguous: false }),
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
      encrypt('mock_fb_page_token'),
    ]
  )
  return accountId
}

describe('facebook story and reel publishing', () => {
  let client, admin, fbAccountId, igAccountId

  beforeAll(async () => {
    client = await createTestUser({ email: `post-fb-sr-${dateTag}@flowx-test.com`, password: 'Test@123' })
    fbAccountId = await addPlatformAccount(client.id, { code: 'facebook', platformUserId: 'fb_sr_page_1' })
    igAccountId = await addPlatformAccount(client.id, {
      code: 'instagram',
      platformUserId: 'ig_sr_acct_1',
      igId: '17841422222222222',
    })
    const adminRow = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    admin = { id: adminRow ? bufferToUuid(adminRow.id) : null }
  })

  beforeEach(() => {
    metaMocks.createPageVideoStory.mockReset().mockResolvedValue({ id: 'mock_fb_video_story' })
    metaMocks.createPagePhotoStory.mockReset().mockResolvedValue({ id: 'mock_fb_photo_story' })
    metaMocks.createPagePhotoPost.mockReset().mockResolvedValue({ id: 'mock_fb_photo' })
    metaMocks.createPageVideoPost.mockReset().mockResolvedValue({ id: 'mock_fb_video' })
    metaMocks.createFeedPost.mockReset().mockResolvedValue({ id: 'mock_fb_link' })
    metaMocks.createInstagramMedia.mockReset().mockResolvedValue({ id: 'mock_ig_container' })
    metaMocks.publishInstagramMedia.mockReset().mockResolvedValue({ id: 'mock_ig_post' })
    metaMocks.getContainerStatus.mockReset().mockResolvedValue({ status_code: 'FINISHED' })
    metaMocks.startPageReel.mockReset().mockResolvedValue({
      video_id: 'mock_fb_video_id',
      upload_url: 'https://rupload.facebook.com/mock_reel',
    })
    metaMocks.uploadPageReelMedia.mockReset().mockResolvedValue({ success: true })
    metaMocks.getPageReelStatus.mockReset().mockResolvedValue({ video_status: 'ready' })
    metaMocks.finishPageReel.mockReset().mockResolvedValue({ post_id: 'mock_fb_reel_post', success: true })
    metaMocks.resolvePageReelPostId.mockReset().mockResolvedValue({ postId: 'mock_fb_reel_post', ambiguous: false })
    postService.fbReelState.backoffSteps = [0, 0, 0, 0, 0, 0]
    postService.fbReelState.verifyBackoffSeconds = 0
  })

  async function withFastPolling(fn) {
    const interval = postService.igContainerPoll.intervalMs
    const timeout = postService.igContainerPoll.timeoutMs
    postService.igContainerPoll.intervalMs = 5
    postService.igContainerPoll.timeoutMs = 500
    try {
      return await fn()
    } finally {
      postService.igContainerPoll.intervalMs = interval
      postService.igContainerPoll.timeoutMs = timeout
    }
  }

  async function createSubmitted({ type, mediaUrl, caption, targetIds = [fbAccountId], extra = {} }) {
    const post = await postService.createPost(client.id, {
      name: `FB ${type} ${generateUuid()}`,
      type,
      caption: type === 'story' ? undefined : caption,
      mediaUrl,
      ...extra,
      targetAccountIds: targetIds,
    })
    await postService.submitPost(client.id, post.id)
    return post.id
  }

  it('publishes a reel through the durable reel job pipeline', async () => {
    const postId = await createSubmitted({ type: 'reel', mediaUrl: 'https://example.com/reel.mp4', caption: 'hello reel' })
    await postService.approvePost(admin.id, postId, {})
    await drainCampaignJobs()

    const detail = await postService.getPost(client.id, postId)
    expect(detail.status).toBe('completed')
    const target = detail.targets[0]
    expect(target.status).toBe('posted')
    expect(target.publishState).toBe('published')
    expect(metaMocks.startPageReel).toHaveBeenCalledTimes(1)
    expect(metaMocks.startPageReel).toHaveBeenCalledWith('fb_sr_page_1', 'mock_fb_page_token')
    expect(metaMocks.uploadPageReelMedia).toHaveBeenCalledTimes(1)
    expect(metaMocks.uploadPageReelMedia).toHaveBeenCalledWith(
      'https://rupload.facebook.com/mock_reel',
      'https://example.com/reel.mp4',
      'mock_fb_page_token'
    )
    expect(metaMocks.finishPageReel).toHaveBeenCalledWith(
      'fb_sr_page_1',
      'mock_fb_page_token',
      expect.objectContaining({ videoId: 'mock_fb_video_id' })
    )
  })

  it('publishes a video story via the 2-phase video_stories endpoint', async () => {
    const postId = await createSubmitted({ type: 'story', mediaUrl: 'https://example.com/story.mp4' })
    await postService.approvePost(admin.id, postId, {})
    await drainCampaignJobs()

    const detail = await postService.getPost(client.id, postId)
    expect(detail.status).toBe('completed')
    expect(metaMocks.createPageVideoStory).toHaveBeenCalledTimes(1)
    expect(metaMocks.createPageVideoStory).toHaveBeenCalledWith(
      'fb_sr_page_1',
      'mock_fb_page_token',
      { url: 'https://example.com/story.mp4' }
    )
    expect(metaMocks.createPagePhotoStory).not.toHaveBeenCalled()
  })

  it('publishes a photo story via the staged photo_stories flow', async () => {
    const postId = await createSubmitted({ type: 'story', mediaUrl: 'https://example.com/story.jpg' })
    await postService.approvePost(admin.id, postId, {})
    await drainCampaignJobs()

    const detail = await postService.getPost(client.id, postId)
    expect(detail.status).toBe('completed')
    expect(metaMocks.createPagePhotoStory).toHaveBeenCalledTimes(1)
    expect(metaMocks.createPageVideoStory).not.toHaveBeenCalled()
    expect(metaMocks.createPagePhotoPost).not.toHaveBeenCalled()
  })

  it('fails the reel target permanently on a 4xx Meta error', async () => {
    const metaError = new Error('meta (#100) invalid reel')
    metaError.metaHttpStatus = 400
    metaError.metaErrorCode = 100
    metaMocks.startPageReel.mockRejectedValueOnce(metaError)

    const postId = await createSubmitted({ type: 'reel', mediaUrl: 'https://example.com/bad.mp4', caption: 'bad reel' })
    await postService.approvePost(admin.id, postId, {})
    await drainCampaignJobs()

    const detail = await postService.getPost(client.id, postId)
    expect(detail.targets[0].status).toBe('failed')
    expect(detail.targets[0].publishState).toBe('permanent_failure')
    expect(detail.targets[0].error).toContain('invalid reel')
  })

  it('publishes to a Facebook reel and Instagram target in the same post', async () => {
    const postId = await createSubmitted({
      type: 'reel',
      mediaUrl: 'https://example.com/reel.mp4',
      caption: 'multi dest',
      targetIds: [fbAccountId, igAccountId],
    })
    await postService.approvePost(admin.id, postId, {})
    await withFastPolling(async () => {
      await drainCampaignJobs()
    })

    const detail = await postService.getPost(client.id, postId)
    expect(detail.status).toBe('completed')
    expect(detail.targets.every(t => t.status === 'posted')).toBe(true)
    expect(metaMocks.createInstagramMedia).toHaveBeenCalledTimes(1)
    expect(metaMocks.startPageReel).toHaveBeenCalledTimes(1)
  })

  it('never leaks access tokens or rupload URLs in post/target responses', async () => {
    const postId = await createSubmitted({ type: 'reel', mediaUrl: 'https://example.com/reel.mp4', caption: 'secret' })
    await postService.approvePost(admin.id, postId, {})
    await drainCampaignJobs()

    const detail = await postService.getPost(client.id, postId)
    for (const target of detail.targets) {
      expect(target.accessToken).toBeUndefined()
      expect(target.remoteUploadUrl).toBeUndefined()
    }

    const targets = await postService.setPostTargets(client.id, postId, [fbAccountId])
    for (const target of targets) {
      expect(target.accessToken).toBeUndefined()
      expect(target.remoteUploadUrl).toBeUndefined()
    }
  })

  it('rejects a reel without a video URL at submit time', async () => {
    const post = await postService.createPost(client.id, {
      name: 'reel no media',
      type: 'reel',
      caption: 'no',
      mediaUrl: undefined,
      targetAccountIds: [fbAccountId],
    })
    await expect(postService.submitPost(client.id, post.id)).rejects.toThrow('Post validation failed')
  })
})