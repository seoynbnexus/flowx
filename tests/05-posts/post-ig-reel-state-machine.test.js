import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { encrypt } from '../../shared/utils/crypto.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as postService from '../../src/modules/posts/post.service.js'
import * as postRepo from '../../src/modules/posts/post.repository.js'
import { query, queryOne } from '../../shared/database/connection.js'
import { drainCampaignJobs } from '../../src/modules/campaigns/campaign.jobs.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    createInstagramMedia: vi.fn().mockResolvedValue({ id: 'mock_ig_container_1' }),
    createInstagramStory: vi.fn().mockResolvedValue({ id: 'mock_ig_story_container_1' }),
    publishInstagramMedia: vi.fn().mockResolvedValue({ id: 'mock_ig_post_1' }),
    getContainerStatus: vi.fn().mockResolvedValue({ status_code: 'FINISHED' }),
    deleteInstagramContainer: vi.fn().mockResolvedValue({ success: true }),
    createPagePhotoPost: vi.fn().mockResolvedValue({ id: 'mock_fb_post_1' }),
    createPageVideoPost: vi.fn().mockResolvedValue({ id: 'mock_fb_video_1' }),
    createFeedPost: vi.fn().mockResolvedValue({ id: 'mock_fb_link_1' }),
    createPagePhotoStory: vi.fn().mockResolvedValue({ id: 'mock_fb_story_1' }),
    createPageVideoStory: vi.fn().mockResolvedValue({ id: 'mock_fb_video_story_1' }),
  }
  metaMocks = mocks
  return mocks
})

var graphMocks
vi.mock('../../shared/services/meta-graph.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-graph.service.js')
  const mocks = {
    ...actual,
    getInstagramMedia: vi.fn().mockResolvedValue([]),
  }
  graphMocks = mocks
  return mocks
})

var limiterMocks
vi.mock('../../shared/services/meta-rate-limiter.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-rate-limiter.js')
  const mocks = {
    ...actual,
    isRateLimited: vi.fn().mockReturnValue(false),
  }
  limiterMocks = mocks
  return mocks
})

const dateTag = Date.now()

async function addIgAccount(userId, platformUserId, igId) {
  const platform = await queryOne('SELECT id FROM platforms WHERE code = ?', ['instagram'])
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
      `https://instagram.com/${platformUserId}`,
      platformUserId,
      `user_${platformUserId}`,
      `Display ${platformUserId}`,
      igId,
      encrypt('mock_ig_page_token'),
    ]
  )
  return accountId
}

async function createApprovedPost(client, admin, type, mediaUrl, igAccountId, caption = null) {
  const post = await postService.createPost(client.id, {
    name: `IG ${type} ${generateUuid()}`,
    type,
    caption,
    mediaUrl,
    targetAccountIds: [igAccountId],
  })
  await postService.submitPost(client.id, post.id)
  await postService.approvePost(admin.id, post.id, {})
  await query('DELETE FROM campaign_jobs WHERE job_type = ? AND campaign_id = ?', [
    'post_publish',
    uuidToBuffer(post.id),
  ])
  const target = await queryOne(
    'SELECT id FROM post_targets WHERE post_id = ? LIMIT 1',
    [uuidToBuffer(post.id)]
  )
  return { postId: post.id, targetId: bufferToUuid(target.id) }
}

describe('instagram durable video publish state machine', () => {
  let client, admin, igAccountId

  beforeAll(async () => {
    client = await createTestUser({ email: `post-ig-sm-${dateTag}@flowx-test.com`, password: 'Test@123' })
    igAccountId = await addIgAccount(client.id, `ig_reel_sm_${dateTag}`, `1784${String(dateTag).slice(-11)}`)
    const adminRow = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    admin = { id: adminRow ? bufferToUuid(adminRow.id) : null }
  })

  beforeEach(async () => {
    await query(
      'DELETE FROM campaign_jobs WHERE campaign_id IN (SELECT id FROM posts WHERE client_id = ?)',
      [uuidToBuffer(client.id)]
    )
    metaMocks.createInstagramMedia.mockReset().mockResolvedValue({ id: 'mock_ig_container_1' })
    metaMocks.createInstagramStory.mockReset().mockResolvedValue({ id: 'mock_ig_story_container_1' })
    metaMocks.publishInstagramMedia.mockReset().mockResolvedValue({ id: 'mock_ig_post_1' })
    metaMocks.getContainerStatus.mockReset().mockResolvedValue({ status_code: 'FINISHED' })
    metaMocks.deleteInstagramContainer.mockReset().mockResolvedValue({ success: true })
    graphMocks.getInstagramMedia.mockReset().mockResolvedValue([])
    limiterMocks.isRateLimited.mockReset().mockReturnValue(false)
    postService.igVideoState.pollSeconds = 0
    postService.igVideoState.processingCapMs = 30 * 60 * 1000
    postService.igVideoState.backoffSteps = [0, 0, 0, 0, 0, 0]
    postService.igVideoState.verifyBackoffSeconds = 0
  })

  afterEach(async () => {
    limiterMocks.isRateLimited.mockReset().mockReturnValue(false)
    await query(
      'DELETE FROM campaign_jobs WHERE campaign_id IN (SELECT id FROM posts WHERE client_id = ?)',
      [uuidToBuffer(client.id)]
    )
  })

  it('walks the full state machine from none to published with parked polls', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'reel', 'https://example.com/reel.mp4', igAccountId, 'ig reel sm')

    metaMocks.getContainerStatus.mockResolvedValue({ status_code: 'IN_PROGRESS' })
    const first = await postService.igReelJob(postId, targetId, {})
    expect(first.requeueAfterSeconds).toBe(0)
    expect(first.attempts).toBe(0)
    let target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('uploading')
    expect(target.containerId).toBe('mock_ig_container_1')
    expect(metaMocks.createInstagramMedia).toHaveBeenCalledTimes(1)

    const second = await postService.igReelJob(postId, targetId, {})
    expect(second.requeueAfterSeconds).toBe(0)
    expect(second.attempts).toBe(0)
    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('processing')
    expect(target.lastOperation).toBe('status')

    metaMocks.getContainerStatus.mockResolvedValue({ status_code: 'FINISHED' })
    await postService.igReelJob(postId, targetId, {})
    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('published')
    expect(target.status).toBe('posted')
    expect(target.metaObjectId).toBe('mock_ig_post_1')
    expect(target.containerId).toBeNull()
    expect(target.postedAt).toBeTruthy()
    expect(metaMocks.publishInstagramMedia).toHaveBeenCalledTimes(1)
    expect(metaMocks.publishInstagramMedia).toHaveBeenCalledWith(expect.any(String), 'mock_ig_container_1', expect.any(String))

    const detail = await postService.getPost(client.id, postId)
    expect(detail.status).toBe('completed')
  })

  it('never creates a second container while one exists after a transient failure', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'reel', 'https://example.com/reel.mp4', igAccountId, 'ig reel l2')

    await postService.igReelJob(postId, targetId, {})
    let target = await postRepo.findPostTargetById(targetId)
    expect(target.containerId).toBe('mock_ig_container_1')
    expect(metaMocks.createInstagramMedia).toHaveBeenCalledTimes(1)

    metaMocks.getContainerStatus.mockRejectedValueOnce(new Error('network blip'))
    await postService.igReelJob(postId, targetId, {})
    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('retryable_failure')

    metaMocks.getContainerStatus.mockResolvedValue({ status_code: 'FINISHED' })
    await postService.igReelJob(postId, targetId, {})
    expect(metaMocks.createInstagramMedia).toHaveBeenCalledTimes(1)
    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('published')
  })

  it('9007 publish retries with the same container instead of re-creating', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'reel', 'https://example.com/reel.mp4', igAccountId, 'ig reel 9007')

    metaMocks.getContainerStatus.mockResolvedValue({ status_code: 'FINISHED' })
    const notReady = new Error('(#9007) Media ID is not available')
    notReady.metaErrorCode = 9007
    metaMocks.publishInstagramMedia.mockRejectedValueOnce(notReady)

    const first = await postService.igReelJob(postId, targetId, {})
    expect(first.requeueAfterSeconds).toBe(0)
    let target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('uploading')
    expect(target.containerId).toBe('mock_ig_container_1')

    const second = await postService.igReelJob(postId, targetId, {})
    expect(second.requeueAfterSeconds).toBe(0)
    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('processing')
    expect(target.containerId).toBe('mock_ig_container_1')

    await postService.igReelJob(postId, targetId, {})
    expect(metaMocks.createInstagramMedia).toHaveBeenCalledTimes(1)
    expect(metaMocks.publishInstagramMedia).toHaveBeenCalledTimes(2)
    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('published')
    expect(target.metaObjectId).toBe('mock_ig_post_1')
  })

  it('ambiguous publish failure cleans the container, goes unknown and enqueues verify', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'reel', 'https://example.com/reel.mp4', igAccountId, 'ig reel ambiguous')

    const ambiguous = new Error('unreachable publish result')
    ambiguous.metaAmbiguous = true
    metaMocks.publishInstagramMedia.mockRejectedValueOnce(ambiguous)

    await postService.igReelJob(postId, targetId, {})
    await postService.igReelJob(postId, targetId, {})
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('unknown')
    expect(target.containerId).toBeNull()
    expect(metaMocks.deleteInstagramContainer).toHaveBeenCalledWith('mock_ig_container_1', expect.any(String))
    const verifyJob = await queryOne(
      "SELECT id FROM campaign_jobs WHERE campaign_id = ? AND job_type = 'post_verify' AND status IN ('queued', 'running')",
      [uuidToBuffer(postId)]
    )
    expect(verifyJob).toBeTruthy()
    await query("UPDATE campaign_jobs SET status = 'done' WHERE campaign_id = ?", [uuidToBuffer(postId)])
  })

  it('container ERROR becomes permanent failure with the Meta message and deletes the container', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'reel', 'https://example.com/reel.mp4', igAccountId, 'ig reel error')

    await postService.igReelJob(postId, targetId, {})
    metaMocks.getContainerStatus.mockResolvedValue({ status_code: 'ERROR', status: { error: { message: 'media too long' } } })
    const result = await postService.igReelJob(postId, targetId, {})
    expect(result.done).toBe(true)

    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('permanent_failure')
    expect(target.status).toBe('failed')
    expect(target.error).toContain('media too long')
    expect(target.containerId).toBeNull()
    expect(metaMocks.deleteInstagramContainer).toHaveBeenCalledWith('mock_ig_container_1', expect.any(String))

    const post = await postService.getPost(client.id, postId)
    expect(post.status).toBe('failed')
  })

  it('expired container is cleared and a fresh container is created', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'reel', 'https://example.com/reel.mp4', igAccountId, 'ig reel expired')

    metaMocks.createInstagramMedia
      .mockResolvedValueOnce({ id: 'mock_ig_container_1' })
      .mockResolvedValueOnce({ id: 'mock_ig_container_2' })
    await postService.igReelJob(postId, targetId, {})

    metaMocks.getContainerStatus.mockResolvedValue({ status_code: 'EXPIRED' })
    const result = await postService.igReelJob(postId, targetId, {})
    expect(result.requeueAfterSeconds).toBe(0)

    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('uploading')
    expect(target.containerId).toBe('mock_ig_container_2')
    expect(metaMocks.createInstagramMedia).toHaveBeenCalledTimes(2)
  })

  it('stuck IN_PROGRESS beyond the processing cap goes unknown and enqueues verify', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'reel', 'https://example.com/reel.mp4', igAccountId, 'ig reel cap')

    metaMocks.getContainerStatus.mockResolvedValue({ status_code: 'IN_PROGRESS' })
    await postService.igReelJob(postId, targetId, {})

    postService.igVideoState.processingCapMs = 0
    const result = await postService.igReelJob(postId, targetId, {})
    expect(result.done).toBe(true)

    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('unknown')
    expect(target.containerId).toBeNull()
    const verifyJob = await queryOne(
      "SELECT id FROM campaign_jobs WHERE campaign_id = ? AND job_type = 'post_verify' AND status IN ('queued', 'running')",
      [uuidToBuffer(postId)]
    )
    expect(verifyJob).toBeTruthy()
    await query("UPDATE campaign_jobs SET status = 'done' WHERE campaign_id = ?", [uuidToBuffer(postId)])
  })

  it('rate-limited token backs off without any Meta call or state churn', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'reel', 'https://example.com/reel.mp4', igAccountId, 'ig reel limited')

    limiterMocks.isRateLimited.mockReturnValue(true)
    const result = await postService.igReelJob(postId, targetId, {})
    expect(result.requeueAfterSeconds).toBe(30)
    expect(result.attempts).toBe(0)
    expect(metaMocks.createInstagramMedia).not.toHaveBeenCalled()
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('none')
  })

  it('cancelled post during flight deletes the container', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'reel', 'https://example.com/reel.mp4', igAccountId, 'ig reel cancel')

    await postService.igReelJob(postId, targetId, {})
    await postService.cancelPost(client.id, postId)
    const result = await postService.igReelJob(postId, targetId, {})
    expect(result.done).toBe(true)
    expect(metaMocks.deleteInstagramContainer).toHaveBeenCalledWith('mock_ig_container_1', expect.any(String))
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.containerId).toBeNull()
  })

  it('publishes a video story through the durable story job', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'story', 'https://example.com/story.mp4', igAccountId)

    metaMocks.getContainerStatus.mockResolvedValue({ status_code: 'IN_PROGRESS' })
    await postService.igVideoStoryJob(postId, targetId, {})
    let target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('uploading')
    expect(target.containerId).toBe('mock_ig_story_container_1')
    expect(metaMocks.createInstagramStory).toHaveBeenCalledTimes(1)
    expect(metaMocks.createInstagramStory).toHaveBeenCalledWith(expect.any(String), 'https://example.com/story.mp4', expect.any(String), { videoUrl: 'https://example.com/story.mp4' })

    metaMocks.getContainerStatus.mockResolvedValue({ status_code: 'FINISHED' })
    await postService.igVideoStoryJob(postId, targetId, {})
    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('published')
    expect(target.metaObjectId).toBe('mock_ig_post_1')
  })

  it('publishPostJob routes IG reels to the durable job and completes via drain', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'reel', 'https://example.com/reel.mp4', igAccountId, 'ig reel routing')

    await postService.publishPostJob(postId)
    const job = await queryOne(
      "SELECT id FROM campaign_jobs WHERE job_type = 'post_ig_reel' AND run_key = ? AND status IN ('queued', 'running')",
      [`ig_reel:${targetId}`]
    )
    expect(job).toBeTruthy()
    expect(metaMocks.createInstagramMedia).not.toHaveBeenCalled()

    await drainCampaignJobs()
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('published')
    expect(metaMocks.createInstagramMedia).toHaveBeenCalledTimes(1)
    expect(metaMocks.publishInstagramMedia).toHaveBeenCalledTimes(1)
  })

  it('publishes an image story inline without a durable job', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'story', 'https://example.com/story.jpg', igAccountId)

    await postService.publishPostJob(postId)
    const job = await queryOne(
      "SELECT id FROM campaign_jobs WHERE job_type = 'post_ig_story' AND run_key = ?",
      [`ig_story:${targetId}`]
    )
    expect(job).toBeFalsy()
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('published')
    expect(metaMocks.createInstagramStory).toHaveBeenCalledTimes(1)
    expect(metaMocks.createInstagramStory).toHaveBeenCalledWith(expect.any(String), 'https://example.com/story.jpg', expect.any(String), { videoUrl: undefined })
    expect(metaMocks.getContainerStatus).not.toHaveBeenCalled()
  })

  it('video story verify resolves via STORIES media type match', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'story', 'https://example.com/story.mp4', igAccountId)

    const ok = await postRepo.transitionPostTargetState(targetId, ['none'], 'unknown', {
      status: 'failed',
      error: 'ambiguous publish',
      verificationAttempts: 0,
      unknownSince: new Date().toISOString().slice(0, 19).replace('T', ' '),
    })
    expect(ok).toBe(true)

    graphMocks.getInstagramMedia.mockResolvedValue([
      {
        id: 'mock_story_media',
        media_type: 'STORIES',
        caption: '',
        timestamp: new Date().toISOString(),
        permalink: 'https://instagram.com/stories/x/1',
      },
    ])

    const result = await postService.verifyPostJob(postId)
    expect(result.status).toBe('processed')
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('published')
    expect(target.metaObjectId).toBe('mock_story_media')
  })

  it('cleanup sweeps stale abandoned containers but repo query excludes fresh in-flight ones', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'reel', 'https://example.com/reel.mp4', igAccountId, 'ig reel sweep')

    const ok = await postRepo.transitionPostTargetState(targetId, ['none'], 'processing', {
      containerId: 'stale_container_1',
    })
    expect(ok).toBe(true)
    await query(
      'UPDATE post_targets SET publish_state_changed_at = DATE_SUB(NOW(), INTERVAL 120 MINUTE) WHERE id = ?',
      [uuidToBuffer(targetId)]
    )

    const stale = await postRepo.findStaleIgContainers(40)
    expect(stale.some(t => t.id === targetId)).toBe(true)

    const freshTarget = await createApprovedPost(client, admin, 'reel', 'https://example.com/reel2.mp4', igAccountId, 'ig reel fresh')
    await postRepo.transitionPostTargetState(freshTarget.targetId, ['none'], 'uploading', {
      containerId: 'fresh_container_1',
    })
    const freshList = await postRepo.findStaleIgContainers(40)
    expect(freshList.some(t => t.id === freshTarget.targetId)).toBe(false)

    metaMocks.getContainerStatus.mockResolvedValue({ status_code: 'FINISHED' })
    const results = await postService.cleanupOrphanContainers()
    expect(results.deleted).toBeGreaterThanOrEqual(1)
    expect(metaMocks.deleteInstagramContainer).toHaveBeenCalledWith('stale_container_1', expect.any(String))
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.containerId).toBeNull()

    void postId
  })

  it('retryPostPublish resets a permanently failed target and re-enqueues publish', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'reel', 'https://example.com/reel.mp4', igAccountId, 'ig reel retry')

    await postService.igReelJob(postId, targetId, {})
    metaMocks.getContainerStatus.mockResolvedValue({ status_code: 'ERROR', status: { error: { message: 'nope' } } })
    await postService.igReelJob(postId, targetId, {})

    let target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('permanent_failure')

    const result = await postService.retryPostPublish(postId)
    expect(result.queued).toBe(true)

    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('none')
    expect(target.status).toBe('pending')
    expect(target.containerId).toBeNull()
    expect(target.verificationAttempts).toBe(0)
    const job = await queryOne(
      "SELECT id FROM campaign_jobs WHERE campaign_id = ? AND job_type = 'post_publish' AND status IN ('queued', 'running')",
      [uuidToBuffer(postId)]
    )
    expect(job).toBeTruthy()
    await query("UPDATE campaign_jobs SET status = 'done' WHERE campaign_id = ?", [uuidToBuffer(postId)])
  })

  it('watchdog re-enqueues in-flight ig targets whose job died', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'reel', 'https://example.com/reel.mp4', igAccountId, 'ig reel watchdog')

    const ok = await postRepo.transitionPostTargetState(targetId, ['none'], 'uploading', {
      containerId: 'watchdog_container_1',
    })
    expect(ok).toBe(true)

    const result = await postService.watchdogIgVideoTargets()
    expect(result.reenqueued).toContain(targetId)
    const job = await queryOne(
      "SELECT id FROM campaign_jobs WHERE job_type = 'post_ig_reel' AND status IN ('queued', 'running')",
    )
    expect(job).toBeTruthy()

    const second = await postService.watchdogIgVideoTargets()
    expect(second.reenqueued).not.toContain(targetId)

    await query("UPDATE campaign_jobs SET status = 'done' WHERE campaign_id = ?", [uuidToBuffer(postId)])
  })
})
