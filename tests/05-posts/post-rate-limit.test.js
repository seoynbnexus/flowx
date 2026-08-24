import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { encrypt } from '../../shared/utils/crypto.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as postService from '../../src/modules/posts/post.service.js'
import { queryOne, query } from '../../shared/database/connection.js'
import { processDueJobs } from '../../src/modules/campaigns/campaign.jobs.js'
import * as limiter from '../../shared/services/meta-rate-limiter.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    createPagePhotoPost: vi.fn().mockResolvedValue({ id: 'mock_fb_post_1' }),
    createInstagramMedia: vi.fn().mockResolvedValue({ id: 'mock_ig_container_1' }),
    publishInstagramMedia: vi.fn().mockResolvedValue({ id: 'mock_ig_post_1' }),
    getContainerStatus: vi.fn().mockResolvedValue({ status_code: 'FINISHED' }),
    getMediaEngagement: vi.fn().mockResolvedValue({ mediaType: 'photo', permalink: 'https://ig.me/p/1', insights: {} }),
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

describe('post rate-limit backoff', () => {
  let client, admin, fbAccountId, igAccountId

  beforeAll(async () => {
    client = await createTestUser({ email: `post-rl-client-${dateTag}@flowx-test.com`, password: 'Test@123' })
    fbAccountId = await addPlatformAccount(client.id, { code: 'facebook', platformUserId: `rl_fb_${dateTag}` })
    igAccountId = await addPlatformAccount(client.id, {
      code: 'instagram',
      platformUserId: `rl_ig_${dateTag}`,
      igId: `178414${dateTag.toString().slice(-11)}`,
    })
    const adminRow = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    admin = { id: adminRow ? bufferToUuid(adminRow.id) : null }
  })

  beforeEach(() => {
    limiter.resetRateLimitState()
    metaMocks.createPagePhotoPost.mockReset().mockResolvedValue({ id: 'mock_fb_post_1' })
    metaMocks.createInstagramMedia.mockReset().mockResolvedValue({ id: 'mock_ig_container_1' })
    metaMocks.publishInstagramMedia.mockReset().mockResolvedValue({ id: 'mock_ig_post_1' })
    metaMocks.getContainerStatus.mockReset().mockResolvedValue({ status_code: 'FINISHED' })
    metaMocks.getMediaEngagement.mockReset().mockResolvedValue({ mediaType: 'photo', permalink: 'https://ig.me/p/1', insights: {} })
  })

  async function createApprovedPost(targets) {
    const post = await postService.createPost(client.id, {
      name: `RL Post ${generateUuid()}`,
      type: 'post',
      caption: 'Rate limit test',
      mediaUrl: 'https://example.com/img.jpg',
      targetAccountIds: targets,
    })
    await postService.submitPost(client.id, post.id)
    await postService.approvePost(admin.id, post.id, {})
    return post.id
  }

  it('backs off without touching Meta when the token bucket is rate limited, then succeeds', async () => {
    const postId = await createApprovedPost([fbAccountId])

    limiter.setCooldown(120, limiter.tokenKeyFor('mock_page_token'))
    await processDueJobs()

    expect(metaMocks.createPagePhotoPost).not.toHaveBeenCalled()

    const target = await queryOne('SELECT publish_state, status FROM post_targets WHERE post_id = ?', [uuidToBuffer(postId)])
    expect(target.publish_state).toBe('retryable_failure')
    expect(target.status).not.toBe('posted')

    const job = await queryOne("SELECT attempts, status FROM campaign_jobs WHERE campaign_id = ? AND job_type = 'post_publish'", [uuidToBuffer(postId)])
    expect(job.status).toBe('queued')
    expect(job.attempts).toBe(1)

    const detail = await postService.getPost(client.id, postId)
    expect(detail.status).toBe('approved')

    limiter.resetRateLimitState()
    await query('UPDATE campaign_jobs SET run_after = NOW() WHERE campaign_id = ?', [uuidToBuffer(postId)])
    await processDueJobs()

    expect(metaMocks.createPagePhotoPost).toHaveBeenCalledTimes(1)
    const published = await postService.getPost(client.id, postId)
    expect(published.status).toBe('completed')
  })

  it('engagement sync skips a rate-limited target and records an error row instead of throwing', async () => {
    const postId = await createApprovedPost([igAccountId])
    await processDueJobs()
    const postedTarget = await queryOne(
      "SELECT id, meta_object_id FROM post_targets WHERE post_id = ? AND status = 'posted'",
      [uuidToBuffer(postId)]
    )
    expect(postedTarget).toBeTruthy()

    limiter.setCooldown(120, limiter.tokenKeyFor('mock_page_token'))
    const result = await postService.syncPostEngagementJob(postId)

    expect(result.synced).toBe(0)
    expect(metaMocks.getMediaEngagement).not.toHaveBeenCalled()

    const row = await queryOne(
      'SELECT error FROM post_engagement_daily WHERE target_id = ? ORDER BY created_at DESC LIMIT 1',
      [postedTarget.id]
    )
    expect(row).toBeTruthy()
    expect(row.error).toContain('rate limited')
  })
})