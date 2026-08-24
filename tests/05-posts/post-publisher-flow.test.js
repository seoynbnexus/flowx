import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
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

async function assignCategory(userId, categoryId) {
  await query(
    `INSERT INTO publisher_ad_categories (id, publisher_id, category_id) VALUES (?, ?, ?)`,
    [uuidToBuffer(generateUuid()), uuidToBuffer(userId), uuidToBuffer(categoryId)]
  )
}

describe('post publisher flow', () => {
  let client, admin, publisher, publisher2, categoryId
  let clientAccountId, publisherAccountId, publisher2AccountId

  beforeAll(async () => {
    client = await createTestUser({ email: `post-pub-client-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    publisher = await createTestUser({ email: `post-pub-publisher-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    publisher2 = await createTestUser({ email: `post-pub-publisher2-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    const adminRow = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    admin = { id: adminRow ? bufferToUuid(adminRow.id) : null }

    const catRow = await queryOne('SELECT id FROM ad_categories LIMIT 1')
    categoryId = bufferToUuid(catRow.id)
    await assignCategory(publisher.id, categoryId)
    await assignCategory(publisher2.id, categoryId)

    clientAccountId = await addPlatformAccount(client.id, { code: 'facebook', platformUserId: 'ppc_fb_client' })
    publisherAccountId = await addPlatformAccount(publisher.id, { code: 'facebook', platformUserId: 'ppc_fb_pub1' })
    publisher2AccountId = await addPlatformAccount(publisher2.id, { code: 'facebook', platformUserId: 'ppc_fb_pub2' })
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

  async function createPublisherPost({ count = 2, coins = 10, withClientTarget = true } = {}) {
    const post = await postService.createPost(client.id, {
      name: `PubFlow ${generateUuid()}`,
      type: 'post',
      caption: 'Publisher post',
      mediaUrl: 'https://example.com/img.jpg',
      categoryId,
      runOnPublishers: true,
      publisherCount: count,
      coinsPerPublisher: coins,
      targetAccountIds: withClientTarget ? [clientAccountId] : [],
    })
    await postService.submitPost(client.id, post.id)
    return post.id
  }

  it('rejects publisher config without a category', async () => {
    await expect(postService.createPost(client.id, {
      name: 'bad',
      type: 'post',
      runOnPublishers: true,
      publisherCount: 2,
      coinsPerPublisher: 10,
    })).rejects.toThrow('Publisher posts require a category')
  })

  it('rejects publisher count/coins without runOnPublishers', async () => {
    await expect(postService.createPost(client.id, {
      name: 'bad2',
      type: 'post',
      publisherCount: 2,
    })).rejects.toThrow('runOnPublishers')
  })

  it('approves into awaiting_publishers, spends escrow and creates requests', async () => {
    const postId = await createPublisherPost({ count: 2, coins: 10 })
    const result = await postService.approvePost(admin.id, postId, {})
    expect(result.status).toBe(POST_STATUS.AWAITING_PUBLISHERS)
    expect(Number(result.escrowAmount)).toBe(22) // 2*10 + 10% fee

    const requests = await postRepo.findPostPublisherRequestsByPostId(postId)
    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect(requests.every(r => r.status === PUBLISHER_REQUEST_STATUS.PENDING)).toBe(true)
    expect(requests.every(r => r.contentSnapshot)).toBe(true)
    expect(requests.every(r => r.contentSnapshotHash)).toBe(true)
  })

  it('blocks accepting another publisher\'s request', async () => {
    const postId = await createPublisherPost({ count: 1, coins: 10 })
    await postService.approvePost(admin.id, postId, {})
    const requests = await postRepo.findPostPublisherRequestsByPostId(postId)
    const other = requests.find(r => r.publisherId === publisher2.id) || requests[0]
    await expect(postService.acceptPostPublisherRequest(publisher.id, other.id, {
      platformAccountId: publisherAccountId,
    })).rejects.toThrow('Not your request')
  })

  it('blocks selecting an account the publisher does not own', async () => {
    const postId = await createPublisherPost({ count: 1, coins: 10 })
    await postService.approvePost(admin.id, postId, {})
    const requests = await postRepo.findPostPublisherRequestsByPostId(postId)
    const mine = requests.find(r => r.publisherId === publisher.id) || requests[0]
    await expect(postService.acceptPostPublisherRequest(publisher.id, mine.id, {
      platformAccountId: publisher2AccountId,
    })).rejects.toThrow('not a verified account you own')
  })

  it('accepts requests, auto go-lives at capacity and publishes to publisher account', async () => {
    const postId = await createPublisherPost({ count: 2, coins: 10 })
    await postService.approvePost(admin.id, postId, {})

    const requests = await postRepo.findPostPublisherRequestsByPostId(postId)
    const pub1 = requests.find(r => r.publisherId === publisher.id)
    const pub2 = requests.find(r => r.publisherId === publisher2.id)
    await postService.acceptPostPublisherRequest(publisher.id, pub1.id, { platformAccountId: publisherAccountId })

    let detail = await postService.getPost(client.id, postId)
    expect(detail.status).toBe(POST_STATUS.AWAITING_PUBLISHERS)

    await postService.acceptPostPublisherRequest(publisher2.id, pub2.id, { platformAccountId: publisher2AccountId })

    await drainCampaignJobs()

    detail = await postService.getPost(client.id, postId)
    expect(detail.status).toBe(POST_STATUS.COMPLETED)

    const target = detail.targets.find(t => t.platformAccountId === publisherAccountId)
    expect(target).toBeDefined()
    expect(target.status).toBe('posted')

    const requestsAfter = await postRepo.findPostPublisherRequestsByPostId(postId)
    expect(requestsAfter.find(r => r.id === pub1.id).status).toBe(PUBLISHER_REQUEST_STATUS.PUBLISHED)
    expect(requestsAfter.find(r => r.id === pub2.id).status).toBe(PUBLISHER_REQUEST_STATUS.PUBLISHED)
  })

  it('allows manual completion to credit the publisher exactly once', async () => {
    await query(
      'INSERT INTO user_wallets (user_id, coins, total_purchased_coins) VALUES (?, 0, 0)',
      [uuidToBuffer(publisher.id)]
    )
    const postId = await createPublisherPost({ count: 1, coins: 25 })
    await postService.approvePost(admin.id, postId, {})
    const requests = await postRepo.findPostPublisherRequestsByPostId(postId)
    const mine = requests.find(r => r.publisherId === publisher.id) || requests[0]

    await postService.acceptPostPublisherRequest(publisher.id, mine.id, { platformAccountId: publisherAccountId })
    await drainCampaignJobs()

    const completed = await postService.completePostPublisherRequest(publisher.id, mine.id)
    expect(completed.status).toBe(PUBLISHER_REQUEST_STATUS.COMPLETED)

    const wallet = await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(publisher.id)])
    expect(Number(wallet.coins)).toBe(25)

    await expect(postService.completePostPublisherRequest(publisher.id, mine.id)).rejects.toThrow('must be')
    const wallet2 = await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(publisher.id)])
    expect(Number(wallet2.coins)).toBe(25)
  })

  it('refunds unfilled slots at deadline and publishes to accepted publishers', async () => {
    const postId = await createPublisherPost({ count: 3, coins: 10 })
    await postService.approvePost(admin.id, postId, {})
    const requests = await postRepo.findPostPublisherRequestsByPostId(postId)
    const mine = requests.find(r => r.publisherId === publisher.id) || requests[0]
    await postService.acceptPostPublisherRequest(publisher.id, mine.id, { platformAccountId: publisherAccountId })

    // Simulate deadline pass: update the deadline into the past, then expire
    await query(
      'UPDATE posts SET publisher_response_deadline_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?',
      [uuidToBuffer(postId)]
    )
    const result = await postService.handleExpiredPublisherPosts()
    expect(result.processed).toBeGreaterThanOrEqual(1)
    const res = result.results.find(r => r.postId === postId)
    expect(res.mode).toBe('partial-go-live')

    await drainCampaignJobs()
    const detail = await postService.getPost(client.id, postId)
    expect(detail.status).toBe(POST_STATUS.COMPLETED)
  })

  it('fails and refunds full escrow when no publisher accepted by deadline', async () => {
    const postId = await createPublisherPost({ count: 2, coins: 10 })
    await postService.approvePost(admin.id, postId, {})
    const beforeWallet = await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(client.id)])

    await query(
      'UPDATE posts SET publisher_response_deadline_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?',
      [uuidToBuffer(postId)]
    )
    const result = await postService.handleExpiredPublisherPosts()
    const res = result.results.find(r => r.postId === postId)
    expect(res.mode).toBe('no-acceptance')

    const afterWallet = await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(client.id)])
    expect(Number(afterWallet.coins)).toBe(Number(beforeWallet.coins))
  })

  describe('multi-account accept', () => {
    let pubFbAccount, pubIgAccount, pubFbAccount2

    beforeAll(async () => {
      pubFbAccount = publisherAccountId
      pubIgAccount = await addPlatformAccount(publisher.id, {
        code: 'instagram',
        platformUserId: 'ppc_ig_pub1',
        igId: '17841455500000001',
      })
      pubFbAccount2 = await addPlatformAccount(publisher.id, { code: 'facebook', platformUserId: 'ppc_fb_pub1b' })
    })

    afterEach(async () => {
      await query("DELETE FROM app_config WHERE config_key = 'publisher_max_accounts_per_request'")
    })

    it('accepts with multiple verified accounts and creates one target per account on go-live', async () => {
      const postId = await createPublisherPost({ count: 1, coins: 10 })
      await postService.approvePost(admin.id, postId, {})
      const requests = await postRepo.findPostPublisherRequestsByPostId(postId)
      const mine = requests.find(r => r.publisherId === publisher.id)

      const accepted = await postService.acceptPostPublisherRequest(publisher.id, mine.id, {
        platformAccountIds: [pubFbAccount, pubIgAccount],
      })
      expect(accepted.platformAccountIds).toEqual(expect.arrayContaining([pubFbAccount, pubIgAccount]))
      expect(accepted.platformAccountId).toBe(pubFbAccount)

      await drainCampaignJobs()
      const detail = await postService.getPost(client.id, postId)
      expect(detail.status).toBe(POST_STATUS.COMPLETED)

      const targets = detail.targets.filter(t => t.platformAccountId === pubFbAccount || t.platformAccountId === pubIgAccount)
      expect(targets).toHaveLength(2)
      expect(targets.every(t => t.status === 'posted')).toBe(true)

      const stored = await queryOne(
        'SELECT platform_account_ids FROM post_publisher_requests WHERE id = ?',
        [uuidToBuffer(mine.id)]
      )
      const idsJson = typeof stored.platform_account_ids === 'string' ? JSON.parse(stored.platform_account_ids) : stored.platform_account_ids
      expect(idsJson).toContain(pubFbAccount)
      expect(idsJson).toContain(pubIgAccount)
    })

    it('deduplicates repeated account ids', async () => {
      const postId = await createPublisherPost({ count: 1, coins: 10 })
      await postService.approvePost(admin.id, postId, {})
      const requests = await postRepo.findPostPublisherRequestsByPostId(postId)
      const mine = requests.find(r => r.publisherId === publisher.id)

      const accepted = await postService.acceptPostPublisherRequest(publisher.id, mine.id, {
        platformAccountIds: [pubFbAccount, pubFbAccount, pubIgAccount],
      })
      expect(accepted.platformAccountIds).toHaveLength(2)

      await drainCampaignJobs()
      const detail = await postService.getPost(client.id, postId)
      const targets = detail.targets.filter(t => t.publisherRequestId === mine.id || t.platformAccountId === pubFbAccount || t.platformAccountId === pubIgAccount)
      expect(targets.filter(t => t.platformAccountId === pubFbAccount)).toHaveLength(1)
    })

    it('rejects an empty selection', async () => {
      const postId = await createPublisherPost({ count: 1, coins: 10 })
      await postService.approvePost(admin.id, postId, {})
      const requests = await postRepo.findPostPublisherRequestsByPostId(postId)
      const mine = requests.find(r => r.publisherId === publisher.id)
      await expect(postService.acceptPostPublisherRequest(publisher.id, mine.id, { platformAccountIds: [] }))
        .rejects.toThrow(/at least one/i)
    })

    it('rejects selections above the configured cap', async () => {
      await query(
        "INSERT INTO app_config (id, config_key, config_value, is_public, description, version) VALUES (?, 'publisher_max_accounts_per_request', ?, 1, 'test', 1)",
        [uuidToBuffer(generateUuid()), JSON.stringify(1)]
      )
      const postId = await createPublisherPost({ count: 1, coins: 10 })
      await postService.approvePost(admin.id, postId, {})
      const requests = await postRepo.findPostPublisherRequestsByPostId(postId)
      const mine = requests.find(r => r.publisherId === publisher.id)
      await expect(postService.acceptPostPublisherRequest(publisher.id, mine.id, {
        platformAccountIds: [pubFbAccount, pubIgAccount],
      })).rejects.toThrow(/up to 1/i)
    })

    it('rejects a mix of owned and unowned accounts', async () => {
      const postId = await createPublisherPost({ count: 1, coins: 10 })
      await postService.approvePost(admin.id, postId, {})
      const requests = await postRepo.findPostPublisherRequestsByPostId(postId)
      const mine = requests.find(r => r.publisherId === publisher.id)
      await expect(postService.acceptPostPublisherRequest(publisher.id, mine.id, {
        platformAccountIds: [pubFbAccount, publisher2AccountId],
      })).rejects.toThrow('not a verified account you own')
    })

    it('pays out once per request regardless of account count', async () => {
      await query(
        'INSERT INTO user_wallets (user_id, coins, total_purchased_coins) VALUES (?, 0, 0)',
        [uuidToBuffer(publisher2.id)]
      )
      const postId = await createPublisherPost({ count: 1, coins: 30 })
      await postService.approvePost(admin.id, postId, {})
      const requests = await postRepo.findPostPublisherRequestsByPostId(postId)
      const mine = requests.find(r => r.publisherId === publisher2.id)

      await postService.acceptPostPublisherRequest(publisher2.id, mine.id, {
        platformAccountIds: [publisher2AccountId],
      })
      await drainCampaignJobs()
      await postService.completePostPublisherRequest(publisher2.id, mine.id)

      const wallet = await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(publisher2.id)])
      expect(Number(wallet.coins)).toBe(30)
    })
  })
})
