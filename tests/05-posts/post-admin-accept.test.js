import { describe, it, expect, beforeAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { encrypt } from '../../shared/utils/crypto.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as postService from '../../src/modules/posts/post.service.js'
import * as postRepo from '../../src/modules/posts/post.repository.js'
import { queryOne, query } from '../../shared/database/connection.js'
import { drainCampaignJobs } from '../../src/modules/campaigns/campaign.jobs.js'
import { POST_STATUS, PUBLISHER_REQUEST_STATUS } from '../../src/modules/posts/post.model.js'

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
  }
  metaMocks = mocks
  return mocks
})

const dateTag = Date.now()

async function addPlatformAccount(userId, { code, platformUserId }) {
  const platform = await queryOne('SELECT id FROM platforms WHERE code = ?', [code])
  const accountId = generateUuid()
  await query(
    `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id,
       platform_username, platform_display_name, token_type,
       access_token, token_expires_at, verification_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'page', ?, DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
    [
      uuidToBuffer(accountId),
      uuidToBuffer(userId),
      platform.id,
      `https://fb.com/${platformUserId}`,
      platformUserId,
      `user_${platformUserId}`,
      `Display ${platformUserId}`,
      encrypt('mock_page_token'),
    ]
  )
  return accountId
}

async function assignCategory(userId, categoryId) {
  await query(
    'INSERT INTO publisher_ad_categories (id, publisher_id, category_id) VALUES (?, ?, ?)',
    [uuidToBuffer(generateUuid()), uuidToBuffer(userId), uuidToBuffer(categoryId)]
  )
}

describe('admin accept post publisher request', () => {
  let client, admin, publisher, publisher2
  let clientAccountId, publisherAccountId, publisher2AccountId

  beforeAll(async () => {
    client = await createTestUser({ email: `admin-accept-client-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    publisher = await createTestUser({ email: `admin-accept-pub1-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    publisher2 = await createTestUser({ email: `admin-accept-pub2-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    const adminRow = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    admin = { id: adminRow ? bufferToUuid(adminRow.id) : null }

    clientAccountId = await addPlatformAccount(client.id, { code: 'facebook', platformUserId: 'aac_fb_client' })
    publisherAccountId = await addPlatformAccount(publisher.id, { code: 'facebook', platformUserId: 'aac_fb_pub1' })
    publisher2AccountId = await addPlatformAccount(publisher2.id, { code: 'facebook', platformUserId: 'aac_fb_pub2' })
  })

  async function createPublisherPost({ count = 2, coins = 10 } = {}) {
    const post = await postService.createPost(client.id, {
      name: `AdminAccept ${generateUuid()}`,
      type: 'post',
      caption: 'Admin accept test',
      mediaUrl: 'https://example.com/img.jpg',
      runOnPublishers: true,
      publisherCount: count,
      coinsPerPublisher: coins,
      targetAccountIds: [clientAccountId],
    })
    await postService.submitPost(client.id, post.id)
    return post.id
  }

  it('accepts a pending request on behalf of a publisher', async () => {
    const postId = await createPublisherPost({ count: 2, coins: 10 })
    await postService.approvePost(admin.id, postId, {})

    const requests = await postRepo.findPostPublisherRequestsByPostId(postId)
    const pending = requests.find(r => r.publisherId === publisher.id)

    const result = await postService.adminAcceptPostPublisherRequest(admin.id, postId, pending.id, {
      platformAccountIds: [publisherAccountId],
    })
    expect(result.status).toBe(PUBLISHER_REQUEST_STATUS.ACCEPTED)
    expect(result.platformAccountIds).toContain(publisherAccountId)
  })

  it('auto-selects all verified accounts when platformAccountIds omitted', async () => {
    const postId = await createPublisherPost({ count: 1, coins: 10 })
    await postService.approvePost(admin.id, postId, {})

    const requests = await postRepo.findPostPublisherRequestsByPostId(postId)
    const pending = requests[0]
    if (!pending) return

    const result = await postService.adminAcceptPostPublisherRequest(admin.id, postId, pending.id)
    expect(result.status).toBe(PUBLISHER_REQUEST_STATUS.ACCEPTED)
    expect(result.platformAccountIds).toBeDefined()
  })

  it('fills capacity and triggers go-live', async () => {
    const postId = await createPublisherPost({ count: 2, coins: 10 })
    await postService.approvePost(admin.id, postId, {})

    const requests = await postRepo.findPostPublisherRequestsByPostId(postId)
    const pub1 = requests.find(r => r.publisherId === publisher.id)
    const pub2 = requests.find(r => r.publisherId === publisher2.id)

    await postService.adminAcceptPostPublisherRequest(admin.id, postId, pub1.id, {
      platformAccountIds: [publisherAccountId],
    })

    let detail = await postService.getPost(client.id, postId)
    expect(detail.status).toBe(POST_STATUS.AWAITING_PUBLISHERS)

    await postService.adminAcceptPostPublisherRequest(admin.id, postId, pub2.id, {
      platformAccountIds: [publisher2AccountId],
    })

    await drainCampaignJobs()

    detail = await postService.getPost(client.id, postId)
    expect(detail.status).toBe(POST_STATUS.COMPLETED)
  })

  it('creates a review log entry', async () => {
    const postId = await createPublisherPost({ count: 1, coins: 10 })
    await postService.approvePost(admin.id, postId, {})

    const requests = await postRepo.findPostPublisherRequestsByPostId(postId)
    const pending = requests[0]
    if (!pending) return

    await postService.adminAcceptPostPublisherRequest(admin.id, postId, pending.id)

    const logs = await query(
      'SELECT * FROM post_review_log WHERE post_id = ? ORDER BY created_at DESC LIMIT 1',
      [uuidToBuffer(postId)]
    )
    expect(logs.length).toBe(1)
    expect(logs[0].notes).toContain('Admin accepted publisher request')
  })

  it('rejects when request not found', async () => {
    const fakeId = generateUuid()
    await expect(
      postService.adminAcceptPostPublisherRequest(admin.id, fakeId, fakeId, {})
    ).rejects.toThrow('Request not found')
  })

  it('rejects when request is not pending', async () => {
    const postId = await createPublisherPost({ count: 1, coins: 10 })
    await postService.approvePost(admin.id, postId, {})

    const requests = await postRepo.findPostPublisherRequestsByPostId(postId)
    const pending = requests[0]
    if (!pending) return

    await postService.adminAcceptPostPublisherRequest(admin.id, postId, pending.id)

    await expect(
      postService.adminAcceptPostPublisherRequest(admin.id, postId, pending.id)
    ).rejects.toThrow('no longer pending')
  })

  it('rejects when request belongs to different post', async () => {
    const post1 = await createPublisherPost({ count: 1, coins: 10 })
    const post2 = await createPublisherPost({ count: 1, coins: 10 })
    await postService.approvePost(admin.id, post1, {})
    await postService.approvePost(admin.id, post2, {})

    const reqs1 = await postRepo.findPostPublisherRequestsByPostId(post1)
    const pending1 = reqs1[0]
    if (!pending1) return

    await expect(
      postService.adminAcceptPostPublisherRequest(admin.id, post2, pending1.id, {})
    ).rejects.toThrow('does not belong to this post')
  })

  it('rejects when publisher has no verified accounts', async () => {
    const noAccountPublisher = await createTestUser({
      email: `admin-accept-noacc-${dateTag}@flowx-test.com`,
      password: 'Test@123',
      role: 'publisher',
    })

    const postId = await createPublisherPost({ count: 1, coins: 10 })
    await postService.approvePost(admin.id, postId, {})

    const requests = await postRepo.findPostPublisherRequestsByPostId(postId)
    const pending = requests.find(r => r.publisherId === noAccountPublisher.id)

    if (pending) {
      await expect(
        postService.adminAcceptPostPublisherRequest(admin.id, postId, pending.id, {})
      ).rejects.toThrow('no verified accounts')
    }
  })

  it('rejects when selected account does not belong to publisher', async () => {
    const postId = await createPublisherPost({ count: 1, coins: 10 })
    await postService.approvePost(admin.id, postId, {})

    const requests = await postRepo.findPostPublisherRequestsByPostId(postId)
    const pending = requests.find(r => r.status === PUBLISHER_REQUEST_STATUS.PENDING)
    if (!pending) return

    await expect(
      postService.adminAcceptPostPublisherRequest(admin.id, postId, pending.id, {
        platformAccountIds: [publisher2AccountId],
      })
    ).rejects.toThrow('does not belong to this publisher')
  })
})
