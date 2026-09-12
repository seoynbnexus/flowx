import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
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
    getMediaEngagement: vi.fn().mockResolvedValue({
      mediaId: 'mock_ig_post_1',
      mediaType: 'VIDEO',
      mediaProductType: 'REELS',
      permalink: 'https://instagram.com/p/mock-reel/',
      timestamp: '2026-08-12T10:00:00+0000',
      likeCount: 12,
      commentsCount: 3,
      insights: { reach: 1000, likes: 12, comments: 3, saved: 5, shares: 2, views: 800, total_interactions: 30 },
      comments: [],
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

describe('engagement sync safety floors', () => {
  let client, admin, fbAccountId, igAccountId
  const createdPostIds = []

  beforeAll(async () => {
    client = await createTestUser({ email: `eng-floor-client-${dateTag}@flowx-test.com`, password: 'Test@123' })
    fbAccountId = await addPlatformAccount(client.id, { code: 'facebook', platformUserId: `eng_floor_fb_${dateTag}` })
    igAccountId = await addPlatformAccount(client.id, {
      code: 'instagram',
      platformUserId: `eng_floor_ig_${dateTag}`,
      igId: '17841433333333333',
    })
    const adminRow = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    admin = { id: adminRow ? bufferToUuid(adminRow.id) : null }
  })

  beforeEach(() => {
    metaMocks.getMediaEngagement.mockClear()
    postService.engagementSweep.lastRunAt = 0
  })

  afterEach(async () => {
    // shared test DB: remove this test's posts/jobs/rows immediately so
    // parallel files' LIMIT-bounded sweeps are never crowded by our fixtures
    // (max live residue from this file is ~1 post at any moment)
    for (const postId of createdPostIds.splice(0)) {
      const buf = uuidToBuffer(postId)
      await query('DELETE FROM campaign_jobs WHERE campaign_id = ?', [buf]).catch(() => {})
      await query('DELETE FROM post_engagement_daily WHERE post_id = ?', [buf]).catch(() => {})
      await query('DELETE FROM post_targets WHERE post_id = ?', [buf]).catch(() => {})
      await query('DELETE FROM post_review_log WHERE post_id = ?', [buf]).catch(() => {})
      await query('DELETE FROM posts WHERE id = ?', [buf]).catch(() => {})
    }
  })

  async function createPostedPost(targets, extra = {}) {
    const post = await postService.createPost(client.id, {
      name: `Floor Post ${generateUuid()}`,
      type: 'post',
      caption: 'Floor check',
      mediaUrl: 'https://example.com/img.jpg',
      ...extra,
      targetAccountIds: targets,
    })
    createdPostIds.push(post.id)
    await postService.submitPost(client.id, post.id)
    await postService.approvePost(admin.id, post.id, {})
    await drainCampaignJobs()
    return post.id
  }

  async function setTargetState(targetId, patch) {
    await postRepo.updatePostTargetStatus(targetId, patch)
  }

  it('a missing target cannot keep its post perpetually due (due-query excludes remote_content_state=missing)', async () => {
    const postId = await createPostedPost([fbAccountId, igAccountId])
    const targets = await postRepo.findPostTargetsByPostId(postId)
    const posted = targets.filter(t => t.status === 'posted' && t.metaObjectId)
    expect(posted.length).toBe(2)
    // one target missing, the healthy sibling ALREADY synced (fresh)
    await setTargetState(posted[1].id, { remoteContentState: 'missing' })
    await query("UPDATE post_targets SET last_engagement_sync_at = NOW() WHERE id = ?", [uuidToBuffer(posted[0].id)])

    const due = await postRepo.findPostsDueForEngagementSync({ stalenessSeconds: 3600, limit: 50 })
    expect(due).not.toContain(postId)

    // control: with the sibling stale, the post IS due (missing target is irrelevant)
    await query('UPDATE post_targets SET last_engagement_sync_at = NULL WHERE id = ?', [uuidToBuffer(posted[0].id)])
    const dueAgain = await postRepo.findPostsDueForEngagementSync({ stalenessSeconds: 3600, limit: 50 })
    expect(dueAgain).toContain(postId)
  })

  it('a meta_deleted_at target cannot keep its post perpetually due', async () => {
    const postId = await createPostedPost([fbAccountId, igAccountId])
    const targets = await postRepo.findPostTargetsByPostId(postId)
    const posted = targets.filter(t => t.status === 'posted' && t.metaObjectId)
    expect(posted.length).toBe(2)
    await setTargetState(posted[1].id, { metaDeletedAt: new Date().toISOString().slice(0, 19).replace('T', ' ') })
    await query("UPDATE post_targets SET last_engagement_sync_at = NOW() WHERE id = ?", [uuidToBuffer(posted[0].id)])

    const due = await postRepo.findPostsDueForEngagementSync({ stalenessSeconds: 3600, limit: 50 })
    expect(due).not.toContain(postId)
  })

  it('healthy sibling targets on the same post are not excluded by one missing target', async () => {
    const postId = await createPostedPost([fbAccountId, igAccountId])
    const targets = await postRepo.findPostTargetsByPostId(postId)
    const first = targets.find(t => t.status === 'posted' && t.metaObjectId)
    const second = targets.find(t => t.id !== first.id)
    await setTargetState(second.id, { remoteContentState: 'missing' })
    // null out the healthy target's sync stamp so ONLY it drives due-ness
    await query('UPDATE post_targets SET last_engagement_sync_at = NULL WHERE id = ?', [uuidToBuffer(first.id)])

    const due = await postRepo.findPostsDueForEngagementSync({ stalenessSeconds: 3600, limit: 50 })
    expect(due).toContain(postId)
  })

  it('worker defensively stamps skipped missing targets so they cannot remain perpetually stale', async () => {
    const postId = await createPostedPost([fbAccountId, igAccountId])
    const targets = await postRepo.findPostTargetsByPostId(postId)
    const healthy = targets.find(t => t.status === 'posted' && t.metaObjectId)
    const missing = targets.find(t => t.id !== healthy.id)
    await setTargetState(missing.id, { remoteContentState: 'missing' })
    await query('UPDATE post_targets SET last_engagement_sync_at = NULL WHERE id = ?', [uuidToBuffer(missing.id)])

    const result = await postService.syncPostEngagementJob(postId)
    expect(result.synced).toBe(1)
    expect(metaMocks.getMediaEngagement).toHaveBeenCalledTimes(1)

    const stamped = await queryOne('SELECT last_engagement_sync_at FROM post_targets WHERE id = ?', [uuidToBuffer(missing.id)])
    expect(stamped.last_engagement_sync_at).toBeTruthy()
  })

  it('confirmed missing targets are never polled by the worker', async () => {
    const postId = await createPostedPost([fbAccountId])
    const targets = await postRepo.findPostTargetsByPostId(postId)
    const t = targets.find(x => x.status === 'posted' && x.metaObjectId)
    await setTargetState(t.id, { remoteContentState: 'missing' })

    const result = await postService.syncPostEngagementJob(postId)
    expect(result.synced).toBe(0)
    expect(metaMocks.getMediaEngagement).not.toHaveBeenCalled()
  })

  it('per-target freshness: fresh siblings are skipped while the stale target is synced', async () => {
    const postId = await createPostedPost([fbAccountId, igAccountId])
    const targets = await postRepo.findPostTargetsByPostId(postId)
    const first = targets.find(t => t.status === 'posted' && t.metaObjectId)
    const second = targets.find(t => t.id !== first.id)
    const justNow = new Date().toISOString().slice(0, 19).replace('T', ' ')
    // first synced 10 seconds ago (fresh), second never synced (stale)
    await query("UPDATE post_targets SET last_engagement_sync_at = DATE_SUB(NOW(), INTERVAL 10 SECOND) WHERE id = ?", [uuidToBuffer(first.id)])
    await query('UPDATE post_targets SET last_engagement_sync_at = NULL WHERE id = ?', [uuidToBuffer(second.id)])

    const result = await postService.syncPostEngagementJob(postId)
    expect(result.synced).toBe(1)
    expect(result.skippedFresh).toBe(1)
    expect(metaMocks.getMediaEngagement).toHaveBeenCalledTimes(1)
    const calledTargetId = metaMocks.getMediaEngagement.mock.calls[0][0]
    expect(calledTargetId).toBe(second.metaObjectId)
  })

  it('scheduled (full-post) mode skips a target synced 3 seconds ago (A+C stale, B fresh)', async () => {
    const postId = await createPostedPost([fbAccountId, igAccountId])
    const targets = await postRepo.findPostTargetsByPostId(postId)
    const posted = targets.filter(t => t.status === 'posted' && t.metaObjectId)
    expect(posted.length).toBe(2)
    await query("UPDATE post_targets SET last_engagement_sync_at = DATE_SUB(NOW(), INTERVAL 3 SECOND) WHERE id = ?", [uuidToBuffer(posted[0].id)])
    await query('UPDATE post_targets SET last_engagement_sync_at = NULL WHERE id = ?', [uuidToBuffer(posted[1].id)])

    const result = await postService.syncPostEngagementJob(postId)
    expect(result.synced).toBe(1)
    expect(result.skippedFresh).toBe(1)
    expect(metaMocks.getMediaEngagement).toHaveBeenCalledTimes(1)
    expect(metaMocks.getMediaEngagement.mock.calls[0][0]).toBe(posted[1].metaObjectId)
  })

  it('targeted (webhook) mode: first reconciliation is never delayed — never-synced target syncs immediately', async () => {
    const postId = await createPostedPost([igAccountId])
    const targets = await postRepo.findPostTargetsByPostId(postId)
    const t = targets.find(x => x.status === 'posted' && x.metaObjectId)
    await query('UPDATE post_targets SET last_engagement_sync_at = NULL WHERE id = ?', [uuidToBuffer(t.id)])

    const result = await postService.syncPostEngagementJob(postId, { targetId: t.id })
    expect(result.synced).toBe(1)
    expect(metaMocks.getMediaEngagement).toHaveBeenCalledTimes(1)
  })

  it('targeted (webhook) mode: target synced 10s ago is NOT re-synced (60s per-target floor)', async () => {
    const postId = await createPostedPost([igAccountId])
    const targets = await postRepo.findPostTargetsByPostId(postId)
    const t = targets.find(x => x.status === 'posted' && x.metaObjectId)
    await query("UPDATE post_targets SET last_engagement_sync_at = DATE_SUB(NOW(), INTERVAL 10 SECOND) WHERE id = ?", [uuidToBuffer(t.id)])

    const result = await postService.syncPostEngagementJob(postId, { targetId: t.id })
    expect(result.synced).toBe(0)
    expect(result.skippedFresh).toBe(1)
    expect(metaMocks.getMediaEngagement).not.toHaveBeenCalled()
  })

  it('targeted (webhook) mode: target synced 70s ago is eligible again', async () => {
    const postId = await createPostedPost([igAccountId])
    const targets = await postRepo.findPostTargetsByPostId(postId)
    const t = targets.find(x => x.status === 'posted' && x.metaObjectId)
    await query("UPDATE post_targets SET last_engagement_sync_at = DATE_SUB(NOW(), INTERVAL 70 SECOND) WHERE id = ?", [uuidToBuffer(t.id)])

    const result = await postService.syncPostEngagementJob(postId, { targetId: t.id })
    expect(result.synced).toBe(1)
    expect(metaMocks.getMediaEngagement).toHaveBeenCalledTimes(1)
  })

  it('manual refresh uses a shorter explicit floor (30s) than the scheduler floor (300s)', async () => {
    const postId = await createPostedPost([igAccountId])
    const targets = await postRepo.findPostTargetsByPostId(postId)
    const t = targets.find(x => x.status === 'posted' && x.metaObjectId)

    // finished 60s ago: beyond the manual floor (30s), inside the scheduler floor (300s)
    const res1 = await postRepo.requeuePostEngagementJob(postId, { floorSeconds: postService.POST_ENGAGEMENT_MIN_REQUEUE_SECONDS })
    expect(res1.enqueued).toBe(true)
    await drainCampaignJobs()
    await query("UPDATE campaign_jobs SET finished_at = DATE_SUB(NOW(), INTERVAL 60 SECOND), status = 'done' WHERE run_key = ?", [`eng:${postId}`])

    const res2 = await postRepo.requeuePostEngagementJob(postId, { floorSeconds: postService.POST_ENGAGEMENT_MIN_REQUEUE_SECONDS })
    expect(res2.floored).toBe(true)

    const res3 = await postRepo.requeuePostEngagementJob(postId, { floorSeconds: postService.POST_ENGAGEMENT_MANUAL_REFRESH_SECONDS })
    expect(res3.enqueued).toBe(true)
  })

  it('repeated scheduler attempts create at most one queued/running engagement job (stable run key)', async () => {
    const postId = await createPostedPost([igAccountId])
    const targets = await postRepo.findPostTargetsByPostId(postId)
    const t = targets.find(x => x.status === 'posted' && x.metaObjectId)
    await query('UPDATE post_targets SET last_engagement_sync_at = NULL WHERE id = ?', [uuidToBuffer(t.id)])

    for (let i = 0; i < 100; i++) {
      await postRepo.requeuePostEngagementJob(postId, { floorSeconds: 0 })
    }
    const rows = await query(
      "SELECT id, status, run_key FROM campaign_jobs WHERE job_type = 'post_sync_engagement' AND campaign_id = ?",
      [uuidToBuffer(postId)]
    )
    expect(rows.length).toBe(1)
    expect(rows[0].run_key).toBe(`eng:${postId}`)
    expect(rows[0].run_key).not.toBeNull()

    await drainCampaignJobs()
    const after = await query(
      "SELECT id, status FROM campaign_jobs WHERE job_type = 'post_sync_engagement' AND campaign_id = ?",
      [uuidToBuffer(postId)]
    )
    expect(after.length).toBe(1)
    expect(after[0].status).toBe('done')
  })

  it('DONE engagement job is not resurrected by the scheduler before the 300s floor', async () => {
    const postId = await createPostedPost([igAccountId])
    const targets = await postRepo.findPostTargetsByPostId(postId)
    const t = targets.find(x => x.status === 'posted' && x.metaObjectId)
    await query('UPDATE post_targets SET last_engagement_sync_at = NULL WHERE id = ?', [uuidToBuffer(t.id)])

    await postRepo.requeuePostEngagementJob(postId, { floorSeconds: 0 })
    await drainCampaignJobs()

    // job finished "now" — repeated scheduler attempts must all be floored
    for (let i = 0; i < 10; i++) {
      const res = await postRepo.requeuePostEngagementJob(postId, { floorSeconds: postService.POST_ENGAGEMENT_MIN_REQUEUE_SECONDS })
      expect(res.floored).toBe(true)
    }
    const rows = await query(
      "SELECT status FROM campaign_jobs WHERE job_type = 'post_sync_engagement' AND campaign_id = ?",
      [uuidToBuffer(postId)]
    )
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('done')
  })

  it('schedulePostEngagementSyncs sweeps at most once per interval and floors completed posts', async () => {
    const postId = await createPostedPost([igAccountId])
    const targets = await postRepo.findPostTargetsByPostId(postId)
    const t = targets.find(x => x.status === 'posted' && x.metaObjectId)
    await query('UPDATE post_targets SET last_engagement_sync_at = NULL WHERE id = ?', [uuidToBuffer(t.id)])

    const first = await postService.schedulePostEngagementSyncs()
    expect(first.enqueued).toContain(postId)
    await drainCampaignJobs()

    // reset the target as stale again, but the sweep gate must throttle
    await query('UPDATE post_targets SET last_engagement_sync_at = NULL WHERE id = ?', [uuidToBuffer(t.id)])
    const second = await postService.schedulePostEngagementSyncs()
    expect(second.skipped).toBe(true)
    expect(second.reason).toBe('sweep_throttle')

    postService.engagementSweep.lastRunAt = 0
    // after the sweep gate resets, the 300s resurrection floor still applies
    const third = await postService.schedulePostEngagementSyncs()
    expect(third.floored).toContain(postId)
    expect(third.enqueued).not.toContain(postId)
  })

  it('NULL posted_at story cannot bypass the 26h expiry window (COALESCE falls back to created_at)', async () => {
    const post = await postService.createPost(client.id, {
      name: `Story Null ${generateUuid()}`,
      type: 'story',
      mediaUrl: 'https://example.com/story.jpg',
      targetAccountIds: [igAccountId],
    })
    createdPostIds.push(post.id)
    await postService.submitPost(client.id, post.id)
    await postService.approvePost(admin.id, post.id, {})
    await drainCampaignJobs()
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    for (const t of targets) {
      await postRepo.updatePostTargetStatus(t.id, {
        status: 'posted',
        metaObjectId: `mock_ig_story_floor_${t.id}`,
      })
    }
    // simulate an old row whose posted_at is NULL (created_at long ago)
    await query("UPDATE post_targets SET posted_at = NULL, created_at = DATE_SUB(NOW(), INTERVAL 48 HOUR), last_engagement_sync_at = NULL WHERE post_id = ?", [uuidToBuffer(post.id)])

    const due = await postRepo.findPostsDueForEngagementSync({ stalenessSeconds: 3600, limit: 50 })
    expect(due).not.toContain(post.id)
    const dueWide = await postRepo.findPostsDueForEngagementSync({ stalenessSeconds: 3600, limit: 50, storyMaxAgeHours: 72 })
    expect(dueWide).toContain(post.id)
  })

  it('NULL posted_at story created recently is still due (no over-exclusion)', async () => {
    const post = await postService.createPost(client.id, {
      name: `Story Recent ${generateUuid()}`,
      type: 'story',
      mediaUrl: 'https://example.com/story.jpg',
      targetAccountIds: [igAccountId],
    })
    createdPostIds.push(post.id)
    await postService.submitPost(client.id, post.id)
    await postService.approvePost(admin.id, post.id, {})
    await drainCampaignJobs()
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    for (const t of targets) {
      await postRepo.updatePostTargetStatus(t.id, {
        status: 'posted',
        metaObjectId: `mock_ig_story_recent_${t.id}`,
      })
    }
    await query('UPDATE post_targets SET posted_at = NULL, last_engagement_sync_at = NULL WHERE post_id = ?', [uuidToBuffer(post.id)])

    const due = await postRepo.findPostsDueForEngagementSync({ stalenessSeconds: 3600, limit: 50 })
    expect(due).toContain(post.id)
  })

  it('webhook coalescing: repeated eng-target requeues keep one row (existing run key) and cannot hot-loop', async () => {
    const postId = await createPostedPost([igAccountId])
    const targets = await postRepo.findPostTargetsByPostId(postId)
    const t = targets.find(x => x.status === 'posted' && x.metaObjectId)

    const { requeueAutoJob } = await import('../../src/modules/campaigns/campaign.repository.js')
    const { POST_JOB_TYPES } = await import('../../src/modules/posts/post.model.js')
    for (let i = 0; i < 20; i++) {
      await requeueAutoJob(postId, POST_JOB_TYPES.SYNC_ENGAGEMENT_TARGET, { targetId: t.id }, {
        runKey: `eng-target:${t.id}`,
        entityType: 'post',
        runAfterSeconds: 15,
      })
    }
    const rows = await query(
      "SELECT id, status, run_key FROM campaign_jobs WHERE job_type = 'post_sync_engagement_target' AND campaign_id = ?",
      [uuidToBuffer(postId)]
    )
    expect(rows.length).toBe(1)
    expect(rows[0].run_key).toBe(`eng-target:${t.id}`)
  })
})
