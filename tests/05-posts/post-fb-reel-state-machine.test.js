import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { encrypt } from '../../shared/utils/crypto.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as postService from '../../src/modules/posts/post.service.js'
import * as postRepo from '../../src/modules/posts/post.repository.js'
import { enqueueTargetJob, requeueReelJob } from '../../src/modules/campaigns/campaign.repository.js'
import { query, queryOne } from '../../shared/database/connection.js'
import { getPool } from '../../shared/database/connection.js'
import { qualifyFbPostId } from '../../shared/services/meta-ads.service.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
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

async function addFbAccount(userId, platformUserId) {
  const platform = await queryOne('SELECT id FROM platforms WHERE code = ?', ['facebook'])
  const accountId = generateUuid()
  await query(
    `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id,
       platform_username, platform_display_name, token_type, access_token, token_expires_at, verification_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'page', ?, DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
    [
      uuidToBuffer(accountId),
      uuidToBuffer(userId),
      platform.id,
      `https://fb.com/${platformUserId}`,
      platformUserId,
      `user_${platformUserId}`,
      `Display ${platformUserId}`,
      encrypt('mock_fb_page_token'),
    ]
  )
  return accountId
}

describe('facebook reel durable publish state machine', () => {
  let client, admin, fbAccountId

  beforeAll(async () => {
    client = await createTestUser({ email: `post-fb-reel-sm-${dateTag}@flowx-test.com`, password: 'Test@123' })
    fbAccountId = await addFbAccount(client.id, 'fb_reel_sm')
    const adminRow = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    admin = { id: adminRow ? bufferToUuid(adminRow.id) : null }
  })

  beforeEach(() => {
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

  async function createApprovedReel() {
    const post = await postService.createPost(client.id, {
      name: `FB reel ${generateUuid()}`,
      type: 'reel',
      caption: 'state machine reel',
      mediaUrl: 'https://example.com/reel.mp4',
      targetAccountIds: [fbAccountId],
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

  it('walks the full state machine from none to published', async () => {
    const { postId, targetId } = await createApprovedReel()

    const afterAllocate = await postService.fbReelJob(postId, targetId, {})
    expect(afterAllocate.requeueAfterSeconds).toBe(0)
    let target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('uploaded')
    expect(target.remoteVideoId).toBe('mock_fb_video_id')
    expect(target.remoteUploadUrl).toBe('https://rupload.facebook.com/mock_reel')
    expect(metaMocks.startPageReel).toHaveBeenCalledTimes(1)
    expect(metaMocks.uploadPageReelMedia).toHaveBeenCalledTimes(1)

    metaMocks.getPageReelStatus.mockResolvedValue({ video_status: 'processing' })
    await postService.fbReelJob(postId, targetId, {})
    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('processing')
    expect(target.lastMetaStatus).toBe('processing')
    expect(target.lastOperation).toBe('status')

    await postService.fbReelJob(postId, targetId, {})
    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('processing')

    metaMocks.getPageReelStatus.mockResolvedValue({ video_status: 'ready' })
    await postService.fbReelJob(postId, targetId, {})
    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('ready')

    await postService.fbReelJob(postId, targetId, {})
    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('published')
    expect(target.status).toBe('posted')
    expect(target.metaObjectId).toBe('mock_fb_reel_post')
    expect(target.postedAt).toBeTruthy()
    expect(target.lastMetaStatus).toBe('published')

    const detail = await postService.getPost(client.id, postId)
    expect(detail.status).toBe('completed')
  })

  it('prefers the qualified post_id over video_id as meta_object_id when Meta finishes a reel (boostable object)', async () => {
    const { postId, targetId } = await createApprovedReel()
    await postService.fbReelJob(postId, targetId, {})
    metaMocks.getPageReelStatus.mockResolvedValue({ video_status: 'processing' })
    await postService.fbReelJob(postId, targetId, {})
    metaMocks.getPageReelStatus.mockResolvedValue({ video_status: 'ready' })
    await postService.fbReelJob(postId, targetId, {})
    metaMocks.finishPageReel.mockResolvedValue({ video_id: 'mock_echoed_video', post_id: '98765432', success: true })
    await postService.fbReelJob(postId, targetId, {})
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('published')
    expect(target.metaObjectId).toBe('fb_reel_sm_98765432')
  })

  it('qualifies a bare numeric post_id when Meta finishes without an echoed video_id', async () => {
    const { postId, targetId } = await createApprovedReel()
    await postService.fbReelJob(postId, targetId, {})
    metaMocks.getPageReelStatus.mockResolvedValue({ video_status: 'processing' })
    await postService.fbReelJob(postId, targetId, {})
    metaMocks.getPageReelStatus.mockResolvedValue({ video_status: 'ready' })
    await postService.fbReelJob(postId, targetId, {})
    metaMocks.finishPageReel.mockResolvedValue({ post_id: '98765432', success: true })
    await postService.fbReelJob(postId, targetId, {})
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('published')
    expect(target.metaObjectId).toBe('fb_reel_sm_98765432')
  })

  describe('qualifyFbPostId', () => {
    it('prefixes bare numeric ids with the page id', () => {
      expect(qualifyFbPostId('123_page', '456')).toBe('123_page_456')
    })
    it('leaves already-qualified ids unchanged', () => {
      expect(qualifyFbPostId('x', '123_456')).toBe('123_456')
    })
    it('leaves non-numeric ids untouched', () => {
      expect(qualifyFbPostId('x', 'mock_fb_reel_post')).toBe('mock_fb_reel_post')
    })
    it('handles nullish ids', () => {
      expect(qualifyFbPostId('x', null)).toBeNull()
      expect(qualifyFbPostId('x', undefined)).toBeUndefined()
    })
  })

  it('replays a crash at uploaded without re-uploading the media', async () => {
    const { postId, targetId } = await createApprovedReel()
    await postService.fbReelJob(postId, targetId, {})
    let target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('uploaded')

    metaMocks.uploadPageReelMedia.mockClear()
    await postService.fbReelJob(postId, targetId, {})
    expect(metaMocks.uploadPageReelMedia).not.toHaveBeenCalled()

    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('ready')
  })

  it('transitions to ready when Meta reports upload complete with processing not started', async () => {
    const { postId, targetId } = await createApprovedReel()
    await postService.fbReelJob(postId, targetId, {})
    let target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('uploaded')

    metaMocks.getPageReelStatus.mockResolvedValue({
      video_status: 'upload_complete',
      uploading_phase: { status: 'complete' },
      processing_phase: { status: 'not_started' },
    })
    await postService.fbReelJob(postId, targetId, {})

    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('ready')
    expect(target.lastMetaStatus).toBe('upload_complete')

    await postService.fbReelJob(postId, targetId, {})
    expect(metaMocks.finishPageReel).toHaveBeenCalledTimes(1)
    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('published')
  })

  it('probes persisted upload status before re-uploading after a crash in uploading', async () => {
    const { postId, targetId } = await createApprovedReel()
    const ok = await postRepo.transitionPostTargetState(targetId, ['none'], 'uploading', {
      remoteVideoId: 'persisted_video_id',
      remoteUploadUrl: 'https://rupload.facebook.com/persisted',
    })
    expect(ok).toBe(true)

    metaMocks.getPageReelStatus.mockResolvedValue({ uploading_phase: { status: 'finished' } })
    await postService.fbReelJob(postId, targetId, {})

    expect(metaMocks.uploadPageReelMedia).not.toHaveBeenCalled()
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('uploaded')
    expect(target.remoteVideoId).toBe('persisted_video_id')
  })

  it('accepts uploading_phase complete (not just finished) without re-uploading', async () => {
    const { postId, targetId } = await createApprovedReel()
    const ok = await postRepo.transitionPostTargetState(targetId, ['none'], 'uploading', {
      remoteVideoId: 'persisted_video_id',
      remoteUploadUrl: 'https://rupload.facebook.com/persisted',
    })
    expect(ok).toBe(true)

    metaMocks.getPageReelStatus.mockResolvedValue({ uploading_phase: { status: 'complete' } })
    await postService.fbReelJob(postId, targetId, {})

    expect(metaMocks.uploadPageReelMedia).not.toHaveBeenCalled()
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('uploaded')
  })

  it('probes persisted upload status and re-uploads only when Meta confirms it was incomplete', async () => {
    const { postId, targetId } = await createApprovedReel()
    const ok = await postRepo.transitionPostTargetState(targetId, ['none'], 'uploading', {
      remoteVideoId: 'persisted_video_id',
      remoteUploadUrl: 'https://rupload.facebook.com/persisted',
    })
    expect(ok).toBe(true)

    metaMocks.getPageReelStatus.mockResolvedValue({ uploading_phase: { status: 'in_progress' } })
    await postService.fbReelJob(postId, targetId, {})

    expect(metaMocks.getPageReelStatus).toHaveBeenCalledTimes(1)
    expect(metaMocks.uploadPageReelMedia).toHaveBeenCalledWith(
      'https://rupload.facebook.com/persisted',
      'https://example.com/reel.mp4',
      expect.any(String)
    )
    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('uploaded')
  })

  it('recovers a transient upload failure by verifying status before re-uploading', async () => {
    const { postId, targetId } = await createApprovedReel()
    metaMocks.uploadPageReelMedia.mockRejectedValueOnce(new Error('ECONNRESET'))

    await postService.fbReelJob(postId, targetId, {})
    let target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('retryable_failure')

    metaMocks.getPageReelStatus.mockResolvedValue({ uploading_phase: { status: 'in_progress' } })
    await postService.fbReelJob(postId, targetId, { attempts: 1 })

    expect(metaMocks.getPageReelStatus).toHaveBeenCalledTimes(1)
    expect(metaMocks.uploadPageReelMedia).toHaveBeenCalledTimes(2)
    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('uploaded')
  })

  it('permanently fails when Meta rejects a reel status as error', async () => {
    const { postId, targetId } = await createApprovedReel()
    await postService.fbReelJob(postId, targetId, {})

    metaMocks.getPageReelStatus.mockResolvedValue({
      video_status: 'error',
      status_errors: [{ message: 'video too spicy' }],
    })
    await postService.fbReelJob(postId, targetId, {})

    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('permanent_failure')
    expect(target.status).toBe('failed')
    expect(target.error).toContain('video too spicy')
  })

  it('marks the post failed (not stuck running) when all actionable targets permanently fail', async () => {
    const { postId, targetId } = await createApprovedReel()
    await postService.fbReelJob(postId, targetId, {})
    metaMocks.getPageReelStatus.mockResolvedValue({
      video_status: 'error',
      status_errors: [{ message: 'cdn.pixabay.com denied by filter' }],
    })
    await postService.fbReelJob(postId, targetId, {})

    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('permanent_failure')

    await postService.refreshPostStatus(postId)
    const post = await postService.getPost(client.id, postId)
    expect(post.status).toBe('failed')
    expect(post.error).toContain('cdn.pixabay.com denied by filter')
  })

  it('resolves a missing post_id via strict verification', async () => {
    const { postId, targetId } = await createApprovedReel()
    await postService.fbReelJob(postId, targetId, {})
    metaMocks.getPageReelStatus.mockResolvedValue({ video_status: 'ready' })
    await postService.fbReelJob(postId, targetId, {})

    metaMocks.finishPageReel.mockResolvedValue({ message: 'Video is Processing...' })
    await postService.fbReelJob(postId, targetId, {})
    let target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('verifying')

    metaMocks.getPageReelStatus.mockResolvedValue({
      video_status: 'ready',
      publishing_phase: { publish_status: 'published' },
    })
    metaMocks.resolvePageReelPostId.mockResolvedValue({ postId: 'fb_found_post', ambiguous: false })
    await postService.fbReelJob(postId, targetId, {})

    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('published')
    expect(target.metaObjectId).toBe('fb_found_post')
  })

  it('sends multiple matching reels to manual review instead of picking the newest', async () => {
    const { postId, targetId } = await createApprovedReel()
    await postService.fbReelJob(postId, targetId, {})
    metaMocks.getPageReelStatus.mockResolvedValue({ video_status: 'ready' })
    await postService.fbReelJob(postId, targetId, {})

    metaMocks.finishPageReel.mockResolvedValue({ message: 'Video is Processing...' })
    await postService.fbReelJob(postId, targetId, {})
    metaMocks.getPageReelStatus.mockResolvedValue({
      video_status: 'ready',
      publishing_phase: { publish_status: 'published' },
    })
    metaMocks.resolvePageReelPostId.mockResolvedValue({ postId: null, ambiguous: true })
    await postService.fbReelJob(postId, targetId, {})

    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('manual_review')
    expect(target.status).toBe('failed')
    expect(target.error).toContain('multiple')
  })

  it('moves an ambiguous upload to unknown and verifies before any retry', async () => {
    const { postId, targetId } = await createApprovedReel()
    metaMocks.uploadPageReelMedia.mockRejectedValueOnce((() => {
      const err = new Error('connection reset during upload')
      err.metaAmbiguous = true
      return err
    })())

    await postService.fbReelJob(postId, targetId, {})
    let target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('unknown')
    expect(target.unknownSince).toBeTruthy()

    metaMocks.getPageReelStatus.mockResolvedValue({
      video_status: 'ready',
      publishing_phase: { publish_status: 'published' },
    })
    metaMocks.resolvePageReelPostId.mockResolvedValue({ postId: 'fb_verified', ambiguous: false })
    await postService.fbReelJob(postId, targetId, {})

    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('published')
    expect(target.metaObjectId).toBe('fb_verified')
    expect(metaMocks.uploadPageReelMedia).toHaveBeenCalledTimes(1)
  })

  it('rescues an unknown target whose finish never ran by finishing the completed upload', async () => {
    const { postId, targetId } = await createApprovedReel()
    metaMocks.uploadPageReelMedia.mockRejectedValueOnce((() => {
      const err = new Error('connection reset during upload')
      err.metaAmbiguous = true
      return err
    })())

    await postService.fbReelJob(postId, targetId, {})
    let target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('unknown')

    metaMocks.getPageReelStatus.mockResolvedValue({
      video_status: 'upload_complete',
      uploading_phase: { status: 'complete' },
      processing_phase: { status: 'not_started' },
      publishing_phase: { publish_status: 'not_started' },
    })
    metaMocks.finishPageReel.mockResolvedValue({ post_id: 'fb_rescued', success: true })
    await postService.fbReelJob(postId, targetId, {})

    expect(metaMocks.uploadPageReelMedia).toHaveBeenCalledTimes(1)
    expect(metaMocks.finishPageReel).toHaveBeenCalledTimes(1)
    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('published')
    expect(target.metaObjectId).toBe('fb_rescued')
  })

  it('does not re-upload a completed upload while processing is in progress during verify', async () => {
    const { postId, targetId } = await createApprovedReel()
    metaMocks.uploadPageReelMedia.mockRejectedValueOnce((() => {
      const err = new Error('connection reset during upload')
      err.metaAmbiguous = true
      return err
    })())

    await postService.fbReelJob(postId, targetId, {})
    let target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('unknown')

    metaMocks.getPageReelStatus.mockResolvedValue({
      video_status: 'processing',
      uploading_phase: { status: 'complete' },
      processing_phase: { status: 'processing' },
      publishing_phase: { publish_status: 'pending' },
    })
    await postService.fbReelJob(postId, targetId, {})

    expect(metaMocks.uploadPageReelMedia).toHaveBeenCalledTimes(1)
    expect(metaMocks.finishPageReel).not.toHaveBeenCalled()
    target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('verifying')
  })

  it('marks a processing timeout as unknown after the processing cap', async () => {
    const { postId, targetId } = await createApprovedReel()
    await postService.fbReelJob(postId, targetId, {})
    metaMocks.getPageReelStatus.mockResolvedValue({ video_status: 'processing' })
    const ok = await postRepo.transitionPostTargetState(targetId, ['uploaded'], 'processing', {
      processingStartedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' '),
    })
    expect(ok).toBe(true)
    await postService.fbReelJob(postId, targetId, {})

    const target = await postRepo.findPostTargetById(targetId)
    expect(target.publishState).toBe('unknown')
  })
})

describe('reel job enqueue + requeue CAS', () => {
  it('enqueues a single sentinel row per run key (dual-target safety)', async () => {
    const runKeyA = `fb_reel:${generateUuid()}`
    const runKeyB = `fb_reel:${generateUuid()}`
    const first = await enqueueTargetJob('post_fb_reel', runKeyA, { postId: 'p', targetId: 't' })
    const duplicate = await enqueueTargetJob('post_fb_reel', runKeyA, { postId: 'p', targetId: 't' })
    await enqueueTargetJob('post_fb_reel', runKeyB, { postId: 'p', targetId: 't2' })

    expect(first).toBe(true)
    expect(duplicate).toBe(false)
    const rows = await query(
      `SELECT campaign_id, run_key FROM campaign_jobs WHERE run_key IN (?, ?)`,
      [runKeyA, runKeyB]
    )
    expect(rows.length).toBe(2)
    for (const row of rows) {
      expect(row.campaign_id).toBeNull()
    }
    await query('DELETE FROM campaign_jobs WHERE run_key IN (?, ?)', [runKeyA, runKeyB])
  })

  it('requeue only resets a running row — stale replays are inert', async () => {
    const jobId = generateUuid()
    await query(
      `INSERT INTO campaign_jobs (id, campaign_id, job_type, run_key, entity_type, status, attempts, payload)
       VALUES (?, NULL, 'post_fb_reel', ?, 'post', 'running', 3, '{"postId":"p","targetId":"t","attempts":1}')`,
      [uuidToBuffer(jobId), `fb_reel:${generateUuid()}`]
    )

    await requeueReelJob(jobId, 5, 0)
    let row = await queryOne('SELECT status, attempts, run_after FROM campaign_jobs WHERE id = ?', [uuidToBuffer(jobId)])
    expect(row.status).toBe('queued')
    expect(row.attempts).toBe(0)
    const firstAfter = new Date(row.run_after).getTime()

    await requeueReelJob(jobId, 99, 0)
    row = await queryOne('SELECT status, attempts, run_after FROM campaign_jobs WHERE id = ?', [uuidToBuffer(jobId)])
    expect(row.status).toBe('queued')
    expect(row.attempts).toBe(0)
    expect(new Date(row.run_after).getTime()).toBe(firstAfter)

    await query('DELETE FROM campaign_jobs WHERE id = ?', [uuidToBuffer(jobId)])
  })
})

describe('migration 061 post reel observability', () => {
  it('is idempotent, reversible, and drops no sibling data', async () => {
    const migration = await import('../../shared/database/migrations/061_post_reel_observability.js')
    const pool = getPool()

    await migration.up({ context: pool })
    await migration.up({ context: pool })

    const [cols] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets' AND COLUMN_NAME IN ('last_meta_status','last_operation','last_operation_at','processing_started_at','unknown_since')`
    )
    const names = cols.map(c => c.COLUMN_NAME).sort()
    expect(names).toEqual(['last_meta_status', 'last_operation', 'last_operation_at', 'processing_started_at', 'unknown_since'])

    await migration.down({ context: pool })
    const [afterDown] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets' AND COLUMN_NAME = 'last_meta_status'`
    )
    expect(afterDown.length).toBe(0)

    await migration.up({ context: pool })
    const [afterUp] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets' AND COLUMN_NAME = 'last_meta_status'`
    )
    expect(afterUp.length).toBe(1)
  })
})