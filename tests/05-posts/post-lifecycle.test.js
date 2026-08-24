import { describe, it, expect, beforeAll, vi } from 'vitest'
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
    createPagePhotoPost: vi.fn().mockResolvedValue({ id: 'mock_fb_post_1' }),
    createPageVideoPost: vi.fn().mockResolvedValue({ id: 'mock_fb_video_1' }),
    createFeedPost: vi.fn().mockResolvedValue({ id: 'mock_fb_link_1' }),
    createInstagramMedia: vi.fn().mockResolvedValue({ id: 'mock_ig_container_1' }),
    publishInstagramMedia: vi.fn().mockResolvedValue({ id: 'mock_ig_post_1' }),
    createInstagramStory: vi.fn().mockResolvedValue({ id: 'mock_ig_story_1' }),
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

describe('post lifecycle', () => {
  let client, admin, otherUser, fbAccountId, igAccountId, postId

  beforeAll(async () => {
    client = await createTestUser({ email: `post-client-${dateTag}@flowx-test.com`, password: 'Test@123' })
    otherUser = await createTestUser({ email: `post-other-${dateTag}@flowx-test.com`, password: 'Test@123' })
    fbAccountId = await addPlatformAccount(client.id, { code: 'facebook', platformUserId: 'test_fb_page_1' })
    igAccountId = await addPlatformAccount(client.id, {
      code: 'instagram',
      platformUserId: 'test_ig_acct_1',
      igId: '17841400000000000',
    })
    const adminRow = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    admin = { id: adminRow ? bufferToUuid(adminRow.id) : null }
    const { DEFAULT_FEATURE_VISIBILITY } = await import('../../src/modules/config/feature.controller.js')
    const { generateUuid, uuidToBuffer } = await import('../../shared/utils/uuid.utils.js')
    const vis = { ...DEFAULT_FEATURE_VISIBILITY, post_duplicate: true, campaign_duplicate: true }
    const ex = await queryOne("SELECT id FROM app_config WHERE config_key = 'feature_visibility'")
    if (ex) {
      await query("UPDATE app_config SET config_value = ? WHERE config_key = 'feature_visibility'", [JSON.stringify(vis)])
    } else {
      await query("INSERT INTO app_config (id, config_key, config_value, is_public, description, version) VALUES (?, ?, ?, 1, ?, 1)", [uuidToBuffer(generateUuid()), 'feature_visibility', JSON.stringify(vis), 'test'])
    }
  })

  it('should create a post in draft status with targets', async () => {
    const post = await postService.createPost(client.id, {
      name: `Lifecycle Post ${dateTag}`,
      type: 'post',
      caption: 'Hello world',
      mediaUrl: 'https://example.com/img.jpg',
      hashtags: '#test #flowx',
      targetAccountIds: [fbAccountId, igAccountId],
    })
    expect(post.status).toBe('draft')
    expect(post.clientId).toBe(client.id)
    postId = post.id
    const detail = await postService.getPost(client.id, postId)
    expect(detail.targets).toHaveLength(2)
  })

  it('should get post details with review log', async () => {
    const post = await postService.getPost(client.id, postId)
    expect(post.name).toContain('Lifecycle Post')
    expect(Array.isArray(post.reviewLog)).toBe(true)
  })

  it('should reject access to another user\'s post', async () => {
    await expect(postService.getPost(otherUser.id, postId)).rejects.toThrow(/access/i)
  })

  it('should list client posts', async () => {
    const result = await postService.listPosts(client.id, {})
    expect(Array.isArray(result.items)).toBe(true)
  })

  it('should update a draft post', async () => {
    const updated = await postService.updatePost(client.id, postId, { caption: 'Updated caption' })
    expect(updated.caption).toBe('Updated caption')
  })

  it('should reject updating a non-existent post', async () => {
    await expect(postService.updatePost(client.id, generateUuid(), { name: 'Nope' })).rejects.toThrow(/not found/i)
  })

  it('should reject selecting accounts not owned by the user', async () => {
    const foreignAccount = await addPlatformAccount(otherUser.id, { code: 'facebook', platformUserId: 'other_page' })
    await expect(postService.setPostTargets(client.id, postId, [foreignAccount])).rejects.toThrow(/not connected/i)
  })

  it('should reject submit without targets', async () => {
    const bare = await postService.createPost(client.id, { name: 'Bare post', type: 'post', caption: 'x' })
    await expect(postService.submitPost(client.id, bare.id)).rejects.toThrow(/target/i)
  })

  it('should submit a post for review', async () => {
    const submitted = await postService.submitPost(client.id, postId)
    expect(submitted.status).toBe('pending_review')
    const detail = await postService.getPost(client.id, postId)
    expect(detail.reviewLog[0].action).toBe('submitted')
  })

  it('should reset to draft when edited after submission', async () => {
    const updated = await postService.updatePost(client.id, postId, { caption: 'Back to draft' })
    expect(updated.status).toBe('draft')
    await postService.submitPost(client.id, postId)
  })

  it('should reject submit when not in draft', async () => {
    const rejected = await postService.createPost(client.id, { name: 'Direct submit', type: 'post', caption: 'x', targetAccountIds: [fbAccountId] })
    await postService.submitPost(client.id, rejected.id)
    await expect(postService.submitPost(client.id, rejected.id)).rejects.toThrow(/transition/i)
  })

  it('should reject approve without targets', async () => {
    const noTargets = await postService.createPost(client.id, { name: 'No targets', type: 'post', caption: 'x', targetAccountIds: [fbAccountId] })
    await postService.submitPost(client.id, noTargets.id)
    await postService.setPostTargets(client.id, noTargets.id, [])
    await expect(postService.approvePost(admin.id, noTargets.id, {})).rejects.toThrow(/target/i)
  })

  it('should approve a post and queue publish', async () => {
    const result = await postService.approvePost(admin.id, postId, { notes: 'Looks good' })
    expect(result.queued).toBe(true)
    expect(result.jobId).toBeTruthy()
    expect(result.status).toBe('approved')
    await drainCampaignJobs()
    const detail = await postService.getPost(client.id, postId)
    expect(detail.status).toBe('completed')
    expect(detail.publishedAt).toBeTruthy()
    expect(metaMocks.createPagePhotoPost).toHaveBeenCalled()
    expect(metaMocks.createInstagramMedia).toHaveBeenCalled()
  })

  it('should reject approve when not pending review', async () => {
    await expect(postService.approvePost(admin.id, postId, {})).rejects.toThrow(/pending review/i)
  })

  it('should reject a post', async () => {
    const toReject = await postService.createPost(client.id, { name: 'Reject me', type: 'post', caption: 'x', targetAccountIds: [fbAccountId] })
    await postService.submitPost(client.id, toReject.id)
    const rejected = await postService.rejectPost(admin.id, toReject.id, { notes: 'No good' })
    expect(rejected.status).toBe('rejected')
    expect(rejected.reviewNotes).toBe('No good')
  })

  it('should duplicate a post with targets', async () => {
    const copy = await postService.duplicatePost(client.id, postId, { name: 'Duplicated post' })
    expect(copy.name).toBe('Duplicated post')
    expect(copy.status).toBe('draft')
    const detail = await postService.getPost(client.id, copy.id)
    expect(detail.targets).toHaveLength(2)
  })

  it('should cancel a draft post', async () => {
    const draft = await postService.createPost(client.id, { name: 'Cancel me', type: 'post' })
    const cancelled = await postService.cancelPost(client.id, draft.id)
    expect(cancelled.status).toBe('cancelled')
  })

  it('should block edits on completed posts', async () => {
    await expect(postService.updatePost(client.id, postId, { caption: 'Nope' })).rejects.toThrow(/current status/i)
  })

  it('should queue publish retry for failed posts', async () => {
    const failedPost = await postService.createPost(client.id, { name: 'Retry me', type: 'post', caption: 'x', targetAccountIds: [fbAccountId] })
    await postService.submitPost(client.id, failedPost.id)
    await postService.approvePost(admin.id, failedPost.id, {})
    await drainCampaignJobs()
    const detail = await postService.getPost(client.id, failedPost.id)
    expect(detail.status).toBe('completed')
    await expect(postService.retryPostPublish(failedPost.id)).rejects.toThrow(/retried/i)
  })
})
