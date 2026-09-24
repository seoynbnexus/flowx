import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { encrypt } from '../../shared/utils/crypto.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as postService from '../../src/modules/posts/post.service.js'
import * as postRepo from '../../src/modules/posts/post.repository.js'
import { query, queryOne } from '../../shared/database/connection.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    createInstagramMedia: vi.fn().mockResolvedValue({ id: 'mock_ig_image_container_1' }),
    createInstagramStory: vi.fn().mockResolvedValue({ id: 'mock_ig_story_container_1' }),
    publishInstagramMedia: vi.fn().mockResolvedValue({ id: 'mock_ig_image_post_1' }),
    getContainerStatus: vi.fn().mockResolvedValue({ status_code: 'FINISHED' }),
    deleteInstagramContainer: vi.fn().mockResolvedValue({ success: true }),
    createPagePhotoPost: vi.fn().mockResolvedValue({ id: 'mock_fb_post_1' }),
    createPageVideoPost: vi.fn().mockResolvedValue({ id: 'mock_fb_video_1' }),
    createFeedPost: vi.fn().mockResolvedValue({ id: 'mock_fb_link_1' }),
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

function err9007() {
  const err = new Error('Graph API POST 1784/media_publish failed: {"error":{"message":"Media ID is not available","code":9007,"error_subcode":2207027}}')
  err.metaHttpStatus = 400
  err.metaErrorCode = 9007
  err.metaErrorSubcode = 2207027
  err.metaAmbiguous = false
  return err
}

function errRaw9007() {
  // Same condition but untagged — classifier must extract code 9007 from the body.
  return new Error('Graph API POST 1784/media_publish failed: {"error":{"message":"Media ID is not available","code":9007,"error_subcode":2207027}}')
}

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

async function createApprovedPost(client, admin, type, mediaUrl, igAccountId, caption = 'ig image sm') {
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

async function jobRow(postId, jobType) {
  return queryOne(
    'SELECT * FROM campaign_jobs WHERE campaign_id = ? AND job_type = ? LIMIT 1',
    [uuidToBuffer(postId), jobType]
  )
}

// FSM target jobs (ig_reel/ig_story/ig_image) are stored with campaign_id NULL
// and matched by run_key — see enqueueTargetJob.
async function targetJobRow(runKey, jobType) {
  return queryOne(
    'SELECT * FROM campaign_jobs WHERE run_key = ? AND job_type = ? LIMIT 1',
    [runKey, jobType]
  )
}

describe('instagram image container readiness FSM', () => {
  let client, admin, igAccountId

  beforeAll(async () => {
    client = await createTestUser({ email: `post-ig-img-${dateTag}@flowx-test.com`, password: 'Test@123' })
    igAccountId = await addIgAccount(client.id, `ig_img_sm_${dateTag}`, `1784${String(dateTag).slice(-11)}`)
    const adminRow = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    admin = { id: adminRow ? bufferToUuid(adminRow.id) : null }
  })

  beforeEach(async () => {
    await query(
      'DELETE FROM campaign_jobs WHERE campaign_id IN (SELECT id FROM posts WHERE client_id = ?)',
      [uuidToBuffer(client.id)]
    )
    // FSM target jobs store campaign_id NULL (matched by run_key) — no other
    // file creates post_ig_image jobs, so a job-type sweep is leak-proof here
    // and keeps other files' global drains from picking up our leftovers.
    await query("DELETE FROM campaign_jobs WHERE job_type = 'post_ig_image'")
    metaMocks.createInstagramMedia.mockReset().mockResolvedValue({ id: 'mock_ig_image_container_1' })
    metaMocks.createInstagramStory.mockReset().mockResolvedValue({ id: 'mock_ig_story_container_1' })
    metaMocks.publishInstagramMedia.mockReset().mockResolvedValue({ id: 'mock_ig_image_post_1' })
    metaMocks.getContainerStatus.mockReset().mockResolvedValue({ status_code: 'FINISHED' })
    metaMocks.deleteInstagramContainer.mockReset().mockResolvedValue({ success: true })
    graphMocks.getInstagramMedia.mockReset().mockResolvedValue([])
    limiterMocks.isRateLimited.mockReset().mockReturnValue(false)
    postService.igImageState.pollSeconds = 0
    postService.igImageState.processingCapMs = 10 * 60 * 1000
    process.env.INSTAGRAM_IMAGE_CONTAINER_READINESS_ENABLED = '1'
  })

  afterEach(async () => {
    delete process.env.INSTAGRAM_IMAGE_CONTAINER_READINESS_ENABLED
    limiterMocks.isRateLimited.mockReset().mockReturnValue(false)
    await query(
      'DELETE FROM campaign_jobs WHERE campaign_id IN (SELECT id FROM posts WHERE client_id = ?)',
      [uuidToBuffer(client.id)]
    )
    await query("DELETE FROM campaign_jobs WHERE job_type = 'post_ig_image'")
  })

  it('flag OFF keeps the inline path and classifies image 9007 retryable, never permanent', async () => {
    delete process.env.INSTAGRAM_IMAGE_CONTAINER_READINESS_ENABLED
    const { postId, targetId } = await createApprovedPost(client, admin, 'post', 'https://example.com/flagoff.jpg', igAccountId)
    metaMocks.publishInstagramMedia.mockRejectedValueOnce(err9007())
    await expect(postService.publishPostJob(postId)).rejects.toThrow(/9007|not available|all targets/i)
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('retryable_failure')
    expect(target.status).toBe('failed')
    // Inline path: single create + single publish, no status polling, no FSM job.
    expect(metaMocks.createInstagramMedia).toHaveBeenCalledTimes(1)
    expect(metaMocks.publishInstagramMedia).toHaveBeenCalledTimes(1)
    expect(metaMocks.getContainerStatus).not.toHaveBeenCalled()
    expect(await jobRow(postId, 'post_ig_image')).toBeNull()
  })

  it('flag OFF + raw untagged 9007 body is still retryable via code extraction', async () => {
    delete process.env.INSTAGRAM_IMAGE_CONTAINER_READINESS_ENABLED
    const { postId, targetId } = await createApprovedPost(client, admin, 'post', 'https://example.com/flagoff-raw.jpg', igAccountId)
    metaMocks.publishInstagramMedia.mockRejectedValueOnce(errRaw9007())
    await expect(postService.publishPostJob(postId)).rejects.toThrow()
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('retryable_failure')
  })

  it('flag OFF + non-9007 400 on image publish stays permanent', async () => {
    delete process.env.INSTAGRAM_IMAGE_CONTAINER_READINESS_ENABLED
    const { postId, targetId } = await createApprovedPost(client, admin, 'post', 'https://example.com/flagoff-400.jpg', igAccountId)
    const bad = new Error('Graph API failed: {"error":{"message":"Invalid parameter","code":100}}')
    bad.metaHttpStatus = 400
    bad.metaErrorCode = 100
    bad.metaAmbiguous = false
    metaMocks.publishInstagramMedia.mockRejectedValueOnce(bad)
    await expect(postService.publishPostJob(postId)).rejects.toThrow()
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('permanent_failure')
  })

  it('flag ON routes image posts to the FSM: no immediate publish, job enqueued', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'post', 'https://example.com/fsm-route.jpg', igAccountId)
    await postService.publishPostJob(postId)
    expect(metaMocks.createInstagramMedia).not.toHaveBeenCalled()
    expect(metaMocks.publishInstagramMedia).not.toHaveBeenCalled()
    const job = await targetJobRow(`ig_image:${targetId}`, 'post_ig_image')
    expect(job).not.toBeNull()
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.status).not.toBe('posted')
  })

  it('flag ON leaves image stories on the inline path, never the FSM', async () => {
    const { postId } = await createApprovedPost(client, admin, 'story', 'https://example.com/story.jpg', igAccountId, null)
    await postService.publishPostJob(postId)
    expect(metaMocks.createInstagramStory).toHaveBeenCalledTimes(1)
    expect(metaMocks.publishInstagramMedia).toHaveBeenCalledTimes(1)
  })

  it('walks create -> uploading -> processing -> ready -> published with parked requeues', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'post', 'https://example.com/fsm-walk.jpg', igAccountId)
    metaMocks.getContainerStatus
      .mockResolvedValueOnce({ status_code: 'IN_PROGRESS' })
      .mockResolvedValueOnce({ status_code: 'FINISHED' })

    const created = await postService.igImageJob(postId, targetId, {})
    expect(created.requeueAfterSeconds).toBeDefined()
    let target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('uploading')
    expect(target.containerId).toBe('mock_ig_image_container_1')
    expect(metaMocks.publishInstagramMedia).not.toHaveBeenCalled()

    // Worker restart between steps: fresh invocation resumes from persisted state.
    const polled = await postService.igImageJob(postId, targetId, {})
    expect(polled.requeueAfterSeconds).toBeDefined()
    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('processing')
    expect(metaMocks.publishInstagramMedia).not.toHaveBeenCalled()

    const done = await postService.igImageJob(postId, targetId, {})
    expect(done.done).toBe(true)
    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('published')
    expect(target.status).toBe('posted')
    expect(target.metaObjectId).toBe('mock_ig_image_post_1')
    expect(target.containerId).toBeNull()
    expect(metaMocks.createInstagramMedia).toHaveBeenCalledTimes(1)
    expect(metaMocks.publishInstagramMedia).toHaveBeenCalledTimes(1)
  })

  it('PUBLISHED status is also a Meta-backed ready signal', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'post', 'https://example.com/fsm-published.jpg', igAccountId)
    await postService.igImageJob(postId, targetId, {})
    metaMocks.getContainerStatus.mockResolvedValueOnce({ status_code: 'PUBLISHED' })
    const done = await postService.igImageJob(postId, targetId, {})
    expect(done.done).toBe(true)
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('published')
  })

  it('unexpected status falls back to a durable processing requeue without publishing', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'post', 'https://example.com/fsm-weird.jpg', igAccountId)
    await postService.igImageJob(postId, targetId, {})
    metaMocks.getContainerStatus.mockResolvedValueOnce({ status_code: 'SOMETHING_ELSE' })
    const res = await postService.igImageJob(postId, targetId, {})
    expect(res.requeueAfterSeconds).toBeDefined()
    expect(metaMocks.publishInstagramMedia).not.toHaveBeenCalled()
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('processing')
  })

  it('9007 after READY recreates the container and publishes on retry (never reuses)', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'post', 'https://example.com/fsm-9007.jpg', igAccountId)
    await postService.igImageJob(postId, targetId, {}) // create -> container_1, UPLOADING
    metaMocks.createInstagramMedia.mockResolvedValueOnce({ id: 'mock_ig_image_container_2' })
    metaMocks.publishInstagramMedia.mockRejectedValueOnce(err9007())
    const retry = await postService.igImageJob(postId, targetId, {}) // FINISHED -> READY -> 9007 -> cleanup + recreate
    expect(retry.requeueAfterSeconds).toBeDefined()
    // Old container cleaned up, never republished; fresh container persisted.
    expect(metaMocks.deleteInstagramContainer).toHaveBeenCalledWith('mock_ig_image_container_1', expect.anything())
    let target = await postRepo.findPostTargetById(targetId)
    expect(target.containerId).toBe('mock_ig_image_container_2')
    expect(target.publishState).toBe('uploading')

    const done = await postService.igImageJob(postId, targetId, {}) // FINISHED -> publish succeeds
    expect(done.done).toBe(true)
    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('published')
    expect(target.metaObjectId).toBe('mock_ig_image_post_1')
    expect(metaMocks.createInstagramMedia).toHaveBeenCalledTimes(2)
    expect(metaMocks.publishInstagramMedia).toHaveBeenCalledTimes(2)
  })

  it('readiness clock survives 9007 recreates, then the 10-minute cap converges to UNKNOWN + verify', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'post', 'https://example.com/fsm-9007-loop.jpg', igAccountId)
    await postService.igImageJob(postId, targetId, {}) // create stamps the clock
    const created = await postRepo.findPostTargetById(targetId)
    expect(created.processingStartedAt).not.toBeNull()

    metaMocks.publishInstagramMedia.mockRejectedValueOnce(err9007())
    await postService.igImageJob(postId, targetId, {}) // READY -> 9007 -> cleanup + recreate
    const recreated = await postRepo.findPostTargetById(targetId)
    expect(recreated.containerId).toBe('mock_ig_image_container_1')
    // Clock preserved across the recreate: repeated 9007s accumulate toward the
    // cap instead of restarting it (no infinite recreate loop).
    expect(new Date(recreated.processingStartedAt).getTime()).toBe(new Date(created.processingStartedAt).getTime())

    // Age the clock past the 10-minute cap, then poll: must converge, not loop.
    await query('UPDATE post_targets SET processing_started_at = DATE_SUB(NOW(), INTERVAL 11 MINUTE) WHERE id = ?', [uuidToBuffer(targetId)])
    metaMocks.getContainerStatus.mockResolvedValueOnce({ status_code: 'IN_PROGRESS' })
    const res = await postService.igImageJob(postId, targetId, {})
    expect(res.done).toBe(true)
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('unknown')
    expect(await jobRow(postId, 'post_verify')).not.toBeNull()
  })

  it('non-9007 400 in the FSM stays permanent', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'post', 'https://example.com/fsm-400.jpg', igAccountId)
    const bad = new Error('Graph API failed: {"error":{"message":"Invalid parameter","code":100}}')
    bad.metaHttpStatus = 400
    bad.metaErrorCode = 100
    bad.metaAmbiguous = false
    metaMocks.createInstagramMedia.mockRejectedValueOnce(bad)
    const res = await postService.igImageJob(postId, targetId, {})
    expect(res.done).toBe(true)
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('permanent_failure')
  })

  it('429 in the FSM keeps existing retry behavior', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'post', 'https://example.com/fsm-429.jpg', igAccountId)
    const limited = new Error('rate limited')
    limited.metaHttpStatus = 429
    limited.metaAmbiguous = false
    metaMocks.createInstagramMedia.mockRejectedValueOnce(limited)
    const res = await postService.igImageJob(postId, targetId, {})
    expect(res.requeueAfterSeconds).toBeDefined()
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('retryable_failure')
  })

  it('ambiguous publish goes to UNKNOWN + verify, never blind republish', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'post', 'https://example.com/fsm-ambiguous.jpg', igAccountId)
    await postService.igImageJob(postId, targetId, {}) // create
    const ambiguous = new Error('socket hangup')
    ambiguous.metaAmbiguous = true
    metaMocks.publishInstagramMedia.mockRejectedValueOnce(ambiguous)
    const res = await postService.igImageJob(postId, targetId, {}) // READY -> ambiguous
    expect(res.done).toBe(true)
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('unknown')
    expect(await jobRow(postId, 'post_verify')).not.toBeNull()
    // UNKNOWN stands down: no further publish attempts from the FSM.
    expect(metaMocks.publishInstagramMedia).toHaveBeenCalledTimes(1)
    const again = await postService.igImageJob(postId, targetId, {})
    expect(again.done).toBe(true)
    expect(metaMocks.publishInstagramMedia).toHaveBeenCalledTimes(1)
  })

  it('container ERROR is permanent with Meta message; EXPIRED recreates', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'post', 'https://example.com/fsm-error.jpg', igAccountId)
    await postService.igImageJob(postId, targetId, {})
    metaMocks.getContainerStatus.mockResolvedValueOnce({ status_code: 'ERROR', status: { error: { message: 'transcode exploded' } } })
    const res = await postService.igImageJob(postId, targetId, {})
    expect(res.done).toBe(true)
    let target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('permanent_failure')
    expect(target.error).toMatch(/transcode exploded/)

    const second = await createApprovedPost(client, admin, 'post', 'https://example.com/fsm-expired.jpg', igAccountId)
    await postService.igImageJob(second.postId, second.targetId, {})
    metaMocks.getContainerStatus.mockResolvedValueOnce({ status_code: 'EXPIRED' })
    metaMocks.createInstagramMedia.mockResolvedValueOnce({ id: 'mock_ig_image_container_9' })
    const recreated = await postService.igImageJob(second.postId, second.targetId, {})
    expect(recreated.requeueAfterSeconds).toBeDefined()
    target = await postRepo.findPostTargetById(second.targetId)
    expect(target.containerId).toBe('mock_ig_image_container_9')
    expect(target.publishState).toBe('uploading')
  })

  it('code-100 status probe clears the dead container and recreates', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'post', 'https://example.com/fsm-100.jpg', igAccountId)
    await postService.igImageJob(postId, targetId, {})
    const gone = new Error('Graph API failed: {"error":{"message":"does not exist","code":100,"error_subcode":33}}')
    gone.metaHttpStatus = 400
    gone.metaErrorCode = 100
    gone.metaErrorSubcode = 33
    gone.metaAmbiguous = false
    metaMocks.getContainerStatus.mockRejectedValueOnce(gone)
    metaMocks.createInstagramMedia.mockResolvedValueOnce({ id: 'mock_ig_image_container_7' })
    const res = await postService.igImageJob(postId, targetId, {})
    expect(res.requeueAfterSeconds).toBeDefined()
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.containerId).toBe('mock_ig_image_container_7')
  })

  it('duplicate workers converge: single POSTED, no duplicate publish chain', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'post', 'https://example.com/fsm-dupe.jpg', igAccountId)
    await postService.igImageJob(postId, targetId, {}) // create
    await postService.igImageJob(postId, targetId, {}) // READY
    const [first, second] = await Promise.all([
      postService.igImageJob(postId, targetId, {}),
      postService.igImageJob(postId, targetId, {}),
    ])
    expect(first.done || first.requeueAfterSeconds !== undefined).toBe(true)
    expect(second.done || second.requeueAfterSeconds !== undefined).toBe(true)
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('published')
    expect(target.status).toBe('posted')
    expect(target.metaObjectId).toBe('mock_ig_image_post_1')
    const posts = await query('SELECT id FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(posts.length).toBe(1)
  })

  it('terminal states stand down: posted, cancelled post, missing token', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'post', 'https://example.com/fsm-standdown.jpg', igAccountId)
    await postService.igImageJob(postId, targetId, {}) // create
    await postService.igImageJob(postId, targetId, {}) // READY
    await postService.igImageJob(postId, targetId, {}) // published
    const again = await postService.igImageJob(postId, targetId, {})
    expect(again.done).toBe(true)
    expect(metaMocks.publishInstagramMedia).toHaveBeenCalledTimes(1)
    expect(await postService.igImageJob(null, targetId, {})).toEqual({ done: true })
  })

  it('watchdog re-enqueues orphaned image FSM jobs when flag ON, skips when OFF', async () => {
    const { postId, targetId } = await createApprovedPost(client, admin, 'post', 'https://example.com/fsm-watchdog.jpg', igAccountId)
    await postService.igImageJob(postId, targetId, {}) // create -> uploading + container
    await query('DELETE FROM campaign_jobs WHERE run_key = ?', [`ig_image:${targetId}`])
    const recovered = await postService.watchdogIgVideoTargets()
    expect(recovered.reenqueued).toContain(targetId)
    expect(await targetJobRow(`ig_image:${targetId}`, 'post_ig_image')).not.toBeNull()

    await query('DELETE FROM campaign_jobs WHERE run_key = ?', [`ig_image:${targetId}`])
    delete process.env.INSTAGRAM_IMAGE_CONTAINER_READINESS_ENABLED
    const skipped = await postService.watchdogIgVideoTargets()
    expect(skipped.reenqueued).not.toContain(targetId)
    expect(await targetJobRow(`ig_image:${targetId}`, 'post_ig_image')).toBeNull()
  })
})
