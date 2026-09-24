import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { encrypt } from '../../shared/utils/crypto.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as postService from '../../src/modules/posts/post.service.js'
import * as promotionService from '../../src/modules/posts/promotion.service.js'
import * as promoRepo from '../../src/modules/posts/promotion.repository.js'
import * as postRepo from '../../src/modules/posts/post.repository.js'
import { queryOne, query } from '../../shared/database/connection.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    isPostLiveForBoost: vi.fn().mockResolvedValue(true),
    isInstagramPostLive: vi.fn().mockResolvedValue(true),
    getInstagramBoostEligibility: vi.fn().mockResolvedValue({ ready: true, isEligible: true, allowedObjectives: [], reasons: [], raw: {} }),
    getPostPromotability: vi.fn().mockResolvedValue({ isEligible: true, promotableId: 'mock_promotable_1', allowedObjectives: [], instagramEligibility: 'eligible', raw: {} }),
    resolveFbPostObjectId: vi.fn().mockResolvedValue(null),
    getConnectedFacebookPage: vi.fn().mockResolvedValue(null),
    getCreativeStoryId: vi.fn().mockResolvedValue('mock_story_123'),
    createAdCampaign: vi.fn().mockImplementation(async () => ({ id: `mock_promo_campaign_${generateUuid().slice(0, 8)}` })),
    createAdSet: vi.fn().mockImplementation(async () => ({ id: `mock_promo_adset_${generateUuid().slice(0, 8)}` })),
    createAdCreativeFromPost: vi.fn().mockImplementation(async () => ({ id: `mock_promo_creative_${generateUuid().slice(0, 8)}` })),
    createAdCreativeFromInstagramPost: vi.fn().mockImplementation(async () => ({ id: `mock_promo_ig_creative_${generateUuid().slice(0, 8)}` })),
    createAd: vi.fn().mockImplementation(async () => ({ id: `mock_promo_ad_${generateUuid().slice(0, 8)}` })),
    updateAdStatus: vi.fn().mockResolvedValue({ success: true }),
    deleteAdCampaign: vi.fn().mockResolvedValue({ success: true }),
    deleteAdSet: vi.fn().mockResolvedValue({ success: true }),
    deleteAdCreative: vi.fn().mockResolvedValue({ success: true }),
    deleteAd: vi.fn().mockResolvedValue({ success: true }),
  }
  metaMocks = mocks
  return mocks
})

const dateTag = Date.now()
const futureBoostEndTime = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

async function addPlatformAccount(userId, { code, platformUserId, igId = null }) {
  const platform = await queryOne('SELECT id FROM platforms WHERE code = ?', [code])
  const accountId = generateUuid()
  await query(
    `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id,
       platform_username, platform_display_name, instagram_business_account_id, token_type,
       access_token, token_expires_at, verification_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'page', ?, DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
    [
      uuidToBuffer(accountId), uuidToBuffer(userId), platform.id,
      `https://fb.com/${platformUserId}`, platformUserId,
      `user_${platformUserId}`, `Display ${platformUserId}`, igId,
      encrypt('mock_page_token'),
    ]
  )
  return accountId
}

async function setFlag(key, value) {
  const raw = JSON.stringify(value)
  await query(
    `INSERT INTO app_config (id, config_key, config_value, is_public, description, version)
     VALUES (?, ?, ?, 0, 'test flag', 1)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [uuidToBuffer(generateUuid()), key, raw]
  )
}

async function makeClientWithIgAccount() {
  const client = await createTestUser({ email: `promo-client-${generateUuid()}@flowx-test.com`, password: 'Test@123' })
  await query('INSERT IGNORE INTO user_wallets (user_id, coins) VALUES (?, 0)', [uuidToBuffer(client.id)])
  const igAccountId = await addPlatformAccount(client.id, { code: 'instagram', platformUserId: `ig_promo_${generateUuid()}`, igId: '17841400000000001' })
  const fbAccountId = await addPlatformAccount(client.id, { code: 'facebook', platformUserId: `fb_promo_${generateUuid()}` })
  return { client, igAccountId, fbAccountId }
}

async function markTargetPosted(postId, targetId, metaId) {
  await query("UPDATE post_targets SET status = 'posted', publish_state = 'published', meta_object_id = ?, posted_at = NOW() WHERE id = ?", [metaId, uuidToBuffer(targetId)])
  await query("UPDATE posts SET status = 'completed' WHERE id = ?", [uuidToBuffer(postId)])
}

async function grantCoins(userId, amount) {
  await query('INSERT INTO user_wallets (user_id, coins) VALUES (?, ?) ON DUPLICATE KEY UPDATE coins = coins + VALUES(coins)', [uuidToBuffer(userId), amount])
}

async function totalAvailable(userId) {
  const { clearCache } = await import('../../src/modules/subscriptions/subscription.service.js')
  clearCache(userId)
  const coinService = await import('../../shared/services/coin.service.js')
  return (await coinService.getAvailable(userId)).total
}

beforeAll(async () => {
  await setFlag('promotions_enabled', false)
  await setFlag('promotion_publish_trigger_enabled', false)
})

afterAll(async () => {
  await setFlag('promotions_enabled', false)
  await setFlag('promotion_publish_trigger_enabled', false)
  await query("DELETE FROM campaign_jobs WHERE job_type = 'promotion_execute'")
  await query('DELETE FROM promotions')
})

describe('promotions architecture', () => {
  let client, igAccountId, fbAccountId

  beforeEach(async () => {
    ({ client, igAccountId, fbAccountId } = await makeClientWithIgAccount())
    await setFlag('promotions_enabled', false)
    await setFlag('promotion_publish_trigger_enabled', false)
    metaMocks.isPostLiveForBoost.mockReset().mockResolvedValue(true)
    metaMocks.isInstagramPostLive.mockReset().mockResolvedValue(true)
    metaMocks.getInstagramBoostEligibility.mockReset().mockResolvedValue({ ready: true, isEligible: true, allowedObjectives: [], reasons: [], raw: {} })
    metaMocks.getPostPromotability.mockReset().mockResolvedValue({ isEligible: true, promotableId: 'mock_promotable_1', allowedObjectives: [], instagramEligibility: 'eligible', raw: {} })
    metaMocks.resolveFbPostObjectId.mockReset().mockResolvedValue(null)
    metaMocks.getCreativeStoryId.mockReset().mockResolvedValue('mock_story_123')
    metaMocks.createAdCampaign.mockReset().mockImplementation(async () => ({ id: `mock_promo_campaign_${generateUuid().slice(0, 8)}` }))
    metaMocks.createAdSet.mockReset().mockImplementation(async () => ({ id: `mock_promo_adset_${generateUuid().slice(0, 8)}` }))
    metaMocks.createAdCreativeFromPost.mockReset().mockImplementation(async () => ({ id: `mock_promo_creative_${generateUuid().slice(0, 8)}` }))
    metaMocks.createAdCreativeFromInstagramPost.mockReset().mockImplementation(async () => ({ id: `mock_promo_ig_creative_${generateUuid().slice(0, 8)}` }))
    metaMocks.createAd.mockReset().mockImplementation(async () => ({ id: `mock_promo_ad_${generateUuid().slice(0, 8)}` }))
    metaMocks.updateAdStatus.mockReset().mockResolvedValue({ success: true })
    await query("DELETE FROM campaign_jobs WHERE job_type IN ('promotion_execute', 'post_boost')")
    await query('DELETE FROM promotions')
  })

  it('flag off: no promotion created on boost post creation (legacy untouched)', async () => {
    const post = await postService.createPost(client.id, {
      name: `Promo Flag Off ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'flag off', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostObjective: 'OUTCOME_ENGAGEMENT', boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    const promotion = await promoRepo.findPromotionByPostId(post.id)
    expect(promotion).toBeNull()
  })

  it('Flow A: boost post creation creates one promotion + one promotion target (WAITING_FOR_POST)', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo FlowA ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'flow a', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostObjective: 'OUTCOME_ENGAGEMENT', boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    const promotion = await promoRepo.findPromotionByPostId(post.id)
    expect(promotion).not.toBeNull()
    expect(promotion.status).toBe('waiting_for_post')
    expect(promotion.chargedPaise).toBe(0)
    expect(post.chargedBoostPaise).toBe(0)
    const targets = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)
    expect(targets.length).toBe(1)
    expect(targets[0].status).toBe('pending')
    expect(targets[0].platform).toBe('instagram')
    const metaJobs = await query("SELECT COUNT(*) as c FROM campaign_jobs WHERE job_type = 'promotion_execute'")
    expect(metaJobs[0].c).toBe(0)
  })

  it('scheduled post: promotion stays WAITING_FOR_POST, no Meta calls, no premature enqueue', async () => {
    await setFlag('promotions_enabled', true)
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
    const post = await postService.createPost(client.id, {
      name: `Promo Sched ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'sched', mediaUrl: 'https://example.com/img.jpg',
      scheduledAt: tomorrow,
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostObjective: 'OUTCOME_ENGAGEMENT', boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    const promotion = await promoRepo.findPromotionByPostId(post.id)
    expect(promotion.status).toBe('waiting_for_post')
    expect(metaMocks.createAdCampaign).not.toHaveBeenCalled()
    const jobs = await query("SELECT COUNT(*) as c FROM campaign_jobs WHERE job_type = 'promotion_execute'")
    expect(jobs[0].c).toBe(0)
  })

  it('wake hook: posted target triggers promotion_execute enqueue (flag on)', async () => {
    await setFlag('promotions_enabled', true)
    await setFlag('promotion_publish_trigger_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Wake ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'wake', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostObjective: 'OUTCOME_ENGAGEMENT', boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    await markTargetPosted(post.id, targets[0].id, `ig_wake_${generateUuid().slice(0, 8)}`)
    const refreshed = await postRepo.findPostTargetById(targets[0].id)
    await promotionService.onPostTargetPosted(refreshed)
    const jobs = await query("SELECT COUNT(*) as c FROM campaign_jobs WHERE job_type = 'promotion_execute'")
    expect(jobs[0].c).toBe(1)
  })

  it('wake hook: flag off does not enqueue', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Wake Off ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'wake off', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostObjective: 'OUTCOME_ENGAGEMENT', boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    await markTargetPosted(post.id, targets[0].id, `ig_wakeoff_${generateUuid().slice(0, 8)}`)
    const refreshed = await postRepo.findPostTargetById(targets[0].id)
    await promotionService.onPostTargetPosted(refreshed)
    const jobs = await query("SELECT COUNT(*) as c FROM campaign_jobs WHERE job_type = 'promotion_execute'")
    expect(jobs[0].c).toBe(0)
  })

  it('worker: executes full chain and marks PromotionTarget ACTIVE with Meta IDs', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Exec ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'exec', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostObjective: 'OUTCOME_ENGAGEMENT', boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    await grantCoins(client.id, 10000)
    await postService.submitPost(client.id, post.id)
    const adminExec = await createTestUser({ email: `promo-admx-exec-${generateUuid()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    await postService.approvePost(adminExec.id, post.id, {})
    await markTargetPosted(post.id, targets[0].id, `ig_exec_${generateUuid().slice(0, 8)}`)
    const promotion = await promoRepo.findPromotionByPostId(post.id)
    const ptgts = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)
    const result = await promotionService.runPromotionTargetJob(ptgts[0].id, {})
    expect(result.done).toBe(true)
    const updated = await promoRepo.findPromotionTargetById(ptgts[0].id)
    expect(updated.status).toBe('active')
    expect(updated.platformCampaignId).toBeTruthy()
    expect(updated.platformAdsetId).toBeTruthy()
    expect(updated.platformCreativeId).toBeTruthy()
    expect(updated.platformAdId).toBeTruthy()
    expect(metaMocks.updateAdStatus).toHaveBeenCalledWith(expect.any(String), 'ACTIVE', expect.any(String))
    const refreshedPromotion = await promoRepo.findPromotionById(promotion.id)
    expect(refreshedPromotion.status).toBe('active')
  })

  it('worker idempotency: re-running a completed PromotionTarget creates no duplicate Meta objects', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Idem ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'idem', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostObjective: 'OUTCOME_ENGAGEMENT', boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    await grantCoins(client.id, 10000)
    await postService.submitPost(client.id, post.id)
    const adminIdem = await createTestUser({ email: `promo-admx-idem-${generateUuid()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    await postService.approvePost(adminIdem.id, post.id, {})
    await markTargetPosted(post.id, targets[0].id, `ig_idem_${generateUuid().slice(0, 8)}`)
    const promotion = await promoRepo.findPromotionByPostId(post.id)
    const ptgts = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)
    await promotionService.runPromotionTargetJob(ptgts[0].id, {})
    const campaignCalls = metaMocks.createAdCampaign.mock.calls.length
    const adCalls = metaMocks.createAd.mock.calls.length
    await promotionService.runPromotionTargetJob(ptgts[0].id, {})
    expect(metaMocks.createAdCampaign.mock.calls.length).toBe(campaignCalls)
    expect(metaMocks.createAd.mock.calls.length).toBe(adCalls)
    const updated = await promoRepo.findPromotionTargetById(ptgts[0].id)
    expect(updated.status).toBe('active')
  })

  it('worker resumption: partial Meta IDs are reused (check-then-create)', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Resume ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'resume', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostObjective: 'OUTCOME_ENGAGEMENT', boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    await grantCoins(client.id, 10000)
    await postService.submitPost(client.id, post.id)
    const adminResume = await createTestUser({ email: `promo-admx-resume-${generateUuid()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    await postService.approvePost(adminResume.id, post.id, {})
    await markTargetPosted(post.id, targets[0].id, `ig_resume_${generateUuid().slice(0, 8)}`)
    const promotion = await promoRepo.findPromotionByPostId(post.id)
    const ptgts = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)
    await promoRepo.updatePromotionTarget(ptgts[0].id, { platformCampaignId: 'preexisting_campaign_1' })
    await promotionService.runPromotionTargetJob(ptgts[0].id, {})
    expect(metaMocks.createAdCampaign).not.toHaveBeenCalled()
    const updated = await promoRepo.findPromotionTargetById(ptgts[0].id)
    expect(updated.platformCampaignId).toBe('preexisting_campaign_1')
    expect(updated.status).toBe('active')
  })

  it('partial platform independence: IG succeeds while FB fails independently', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Multi ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'multi', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostObjective: 'OUTCOME_ENGAGEMENT', boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId, fbAccountId],
    })
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    const igTarget = targets.find(t => t.platformCode === 'instagram')
    const fbTarget = targets.find(t => t.platformCode === 'facebook')
    await grantCoins(client.id, 10000)
    await postService.submitPost(client.id, post.id)
    const adminMulti = await createTestUser({ email: `promo-admx-multi-${generateUuid()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    await postService.approvePost(adminMulti.id, post.id, {})
    await markTargetPosted(post.id, igTarget.id, `ig_multi_${generateUuid().slice(0, 8)}`)
    await markTargetPosted(post.id, fbTarget.id, `fb_multi_${generateUuid().slice(0, 8)}`)
    const promotion = await promoRepo.findPromotionByPostId(post.id)
    const ptgts = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)
    expect(ptgts.length).toBe(2)

    metaMocks.getPostPromotability.mockResolvedValueOnce({ isEligible: false, promotableId: null, allowedObjectives: [], instagramEligibility: 'not eligible', raw: {} })
    const igResult = await promotionService.runPromotionTargetJob(ptgts.find(p => p.platform === 'instagram').id, {})
    const fbResult = await promotionService.runPromotionTargetJob(ptgts.find(p => p.platform === 'facebook').id, {})
    expect(igResult.done).toBe(true)
    expect(fbResult.done).toBe(true)

    const finalTargets = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)
    const igFinal = finalTargets.find(t => t.platform === 'instagram')
    const fbFinal = finalTargets.find(t => t.platform === 'facebook')
    expect(igFinal.status).toBe('active')
    expect(fbFinal.status).toBe('failed')
    expect(fbFinal.eligibilityStatus).toBe('ineligible')

    const refreshedPromotion = await promoRepo.findPromotionById(promotion.id)
    expect(refreshedPromotion.status).toBe('active')
  })

  it('retry: not-ready eligibility requeues without creating Meta objects', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Retry ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'retry', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostObjective: 'OUTCOME_ENGAGEMENT', boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    await markTargetPosted(post.id, targets[0].id, `ig_retry_${generateUuid().slice(0, 8)}`)
    const promotion = await promoRepo.findPromotionByPostId(post.id)
    const ptgts = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)
    metaMocks.getInstagramBoostEligibility.mockResolvedValueOnce({ ready: false, transient: true, raw: {} })
    const result = await promotionService.runPromotionTargetJob(ptgts[0].id, {})
    expect(result.requeueAfterSeconds).toBe(60)
    expect(metaMocks.createAdCampaign).not.toHaveBeenCalled()
    const updated = await promoRepo.findPromotionTargetById(ptgts[0].id)
    expect(updated.status).not.toBe('active')
  })

  it('ineligible: permanent failure with eligibility recorded', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Inel ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'inel', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostObjective: 'OUTCOME_ENGAGEMENT', boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    await markTargetPosted(post.id, targets[0].id, `ig_inel_${generateUuid().slice(0, 8)}`)
    const promotion = await promoRepo.findPromotionByPostId(post.id)
    const ptgts = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)
    metaMocks.getInstagramBoostEligibility.mockResolvedValueOnce({ ready: true, isEligible: false, allowedObjectives: [], reasons: ['MEDIA_TYPE_NOT_SUPPORTED'], raw: {} })
    const result = await promotionService.runPromotionTargetJob(ptgts[0].id, {})
    expect(result.done).toBe(true)
    const updated = await promoRepo.findPromotionTargetById(ptgts[0].id)
    expect(updated.status).toBe('failed')
    expect(updated.eligibilityStatus).toBe('ineligible')
    expect(updated.eligibilityReason).toContain('MEDIA_TYPE_NOT_SUPPORTED')
  })

  it('legacy suppression: promotion exists → queuePostBoosts does not enqueue post_boost', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Sup ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'sup', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostObjective: 'OUTCOME_ENGAGEMENT', boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    await markTargetPosted(post.id, targets[0].id, `ig_sup_${generateUuid().slice(0, 8)}`)
    await setFlag('promotions_enabled', false)
    const result = await postService.queuePostBoosts(post.id)
    expect(result.suppressedByPromotion).toBe(true)
    const jobs = await query("SELECT COUNT(*) as c FROM campaign_jobs WHERE job_type = 'post_boost'")
    expect(jobs[0].c).toBe(0)
  })

  it('rollback invariant: flag off + promotion exists → no legacy post_boost job for that target', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Roll ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'roll', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostObjective: 'OUTCOME_ENGAGEMENT', boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    const postTargetId = targets[0].id
    await markTargetPosted(post.id, postTargetId, `ig_roll_${generateUuid().slice(0, 8)}`)

    await setFlag('promotions_enabled', false)
    await setFlag('promotion_publish_trigger_enabled', false)
    await postService.queuePostBoosts(post.id)
    const legacyJobs = await query(
      "SELECT COUNT(*) as c FROM campaign_jobs WHERE job_type = 'post_boost' AND campaign_id = ?",
      [uuidToBuffer(post.id)]
    )
    expect(legacyJobs[0].c).toBe(0)
  })

  it('Flow B: published post → create promotion via service (charge once, targets execute)', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo FlowB ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'flow b', mediaUrl: 'https://example.com/img.jpg',
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    await markTargetPosted(post.id, targets[0].id, `ig_flowb_${generateUuid().slice(0, 8)}`)
    await grantCoins(client.id, 10000)

    const result = await promotionService.createPromotionForPublishedPost(client.id, post.id, {
      budgetType: 'daily', budgetAmount: 500, endTime: futureBoostEndTime,
      targeting: { geo_locations: { countries: ['IN'] } },
    })
    expect(result.promotion.status).toBe('waiting_for_post')
    expect(result.promotionTargetIds.length).toBe(1)

    const runResult = await promotionService.runPromotionTargetJob(result.promotionTargetIds[0], {})
    expect(runResult.done).toBe(true)
    const ptgt = await promoRepo.findPromotionTargetById(result.promotionTargetIds[0])
    expect(ptgt.status).toBe('active')
  })

  it('Flow B invalid config: THRUPLAY goal → 422 before charge, zero coins moved', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo BadGoal ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'bad goal', mediaUrl: 'https://example.com/img.jpg',
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    await markTargetPosted(post.id, targets[0].id, `ig_badgeoal_${generateUuid().slice(0, 8)}`)
    await grantCoins(client.id, 10000)
    const walletBefore = (await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(client.id)])).coins

    await expect(promotionService.createPromotionForPublishedPost(client.id, post.id, {
      budgetType: 'daily', budgetAmount: 500, endTime: futureBoostEndTime,
      objective: 'OUTCOME_ENGAGEMENT', optimizationGoal: 'THRUPLAY',
      targeting: { geo_locations: { countries: ['IN'] } },
    })).rejects.toMatchObject({ statusCode: 422 })

    expect(await promoRepo.findPromotionByPostId(post.id)).toBeNull()
    const walletAfter = (await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(client.id)])).coins
    expect(walletAfter).toBe(walletBefore)
    const billing = await query('SELECT COUNT(*) as c FROM post_billing_entries WHERE post_id = ?', [uuidToBuffer(post.id)])
    expect(billing[0].c).toBe(0)
  })

  it('Flow B invalid config: story post → 422 before charge (stories not boostable)', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Story ${generateUuid().slice(0, 8)}`,
      type: 'story', caption: '', mediaUrl: 'https://example.com/img.jpg',
      targetAccountIds: [fbAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    const fbTarget = targets.find(t => t.platformCode === 'facebook')
    await markTargetPosted(post.id, fbTarget.id, `fb_story_${generateUuid().slice(0, 8)}`)
    await grantCoins(client.id, 10000)

    await expect(promotionService.createPromotionForPublishedPost(client.id, post.id, {
      budgetType: 'daily', budgetAmount: 500, endTime: futureBoostEndTime,
      targeting: { geo_locations: { countries: ['IN'] } },
    })).rejects.toMatchObject({ statusCode: 422 })
    expect(await promoRepo.findPromotionByPostId(post.id)).toBeNull()
  })

  it('Flow B invalid config: no geo → 422 before charge (no silent IN default)', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo NoGeo ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'no geo', mediaUrl: 'https://example.com/img.jpg',
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    await markTargetPosted(post.id, targets[0].id, `ig_nogeo_${generateUuid().slice(0, 8)}`)
    await grantCoins(client.id, 10000)
    const walletBefore = (await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(client.id)])).coins

    await expect(promotionService.createPromotionForPublishedPost(client.id, post.id, {
      budgetType: 'daily', budgetAmount: 500, endTime: futureBoostEndTime,
      targeting: { geo_locations: { countries: [] } },
    })).rejects.toMatchObject({ statusCode: 422 })

    expect(await promoRepo.findPromotionByPostId(post.id)).toBeNull()
    const walletAfter = (await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(client.id)])).coins
    expect(walletAfter).toBe(walletBefore)
  })

  it('Flow B persists resolved snapshot at charge; raw config untouched', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Snap ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'snap', mediaUrl: 'https://example.com/img.jpg',
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    await markTargetPosted(post.id, targets[0].id, `ig_snap_${generateUuid().slice(0, 8)}`)
    await grantCoins(client.id, 10000)

    const result = await promotionService.createPromotionForPublishedPost(client.id, post.id, {
      budgetType: 'daily', budgetAmount: 500, endTime: futureBoostEndTime,
      targeting: { geo_locations: { countries: ['IN'] } },
      placement: { publisher_platforms: ['facebook', 'instagram'], facebook_positions: ['feed'] },
    })
    const promo = await promoRepo.findPromotionById(result.promotion.id)
    expect(promo.resolvedAt).toBeTruthy()
    expect(promo.resolvedGraphVersion).toBe('v25.0')
    expect(promo.resolvedTargeting.targets[targets[0].id].geo_locations.countries).toEqual(['IN'])
    expect(promo.resolvedTargeting.objective).toBe('OUTCOME_ENGAGEMENT')
    expect(promo.resolvedPlacement.targets[targets[0].id].publisher_platforms).toEqual(['facebook', 'instagram'])
    expect(promo.resolvedPlacement.targets[targets[0].id].facebook_positions).toEqual(['feed'])
    expect(promo.targeting).toEqual({ geo_locations: { countries: ['IN'] } })
    expect(promo.placement.publisher_platforms).toEqual(['facebook', 'instagram'])
  })

  it('execution uses the frozen snapshot even after raw config is tampered', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Frozen ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'frozen', mediaUrl: 'https://example.com/img.jpg',
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    await markTargetPosted(post.id, targets[0].id, `ig_frozen_${generateUuid().slice(0, 8)}`)
    await grantCoins(client.id, 10000)

    const result = await promotionService.createPromotionForPublishedPost(client.id, post.id, {
      budgetType: 'daily', budgetAmount: 500, endTime: futureBoostEndTime,
      targeting: { geo_locations: { countries: ['IN'] } },
    })
    await query('UPDATE promotions SET targeting = ? WHERE id = ?', [JSON.stringify({ geo_locations: { countries: ['US'] } }), uuidToBuffer(result.promotion.id)])

    metaMocks.createAdSet.mockClear()
    const runResult = await promotionService.runPromotionTargetJob(result.promotionTargetIds[0], {})
    expect(runResult.done).toBe(true)
    expect(metaMocks.createAdSet.mock.calls.length).toBeGreaterThan(0)
    const adsetTargeting = metaMocks.createAdSet.mock.calls[0][2]
    expect(adsetTargeting.geo_locations.countries).toEqual(['IN'])
    const ptgt = await promoRepo.findPromotionTargetById(result.promotionTargetIds[0])
    expect(ptgt.status).toBe('active')
  })

  it('execution without snapshot fails safe: no Meta calls, surfaced for handling', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Nosnap ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'nosnap', mediaUrl: 'https://example.com/img.jpg',
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    await markTargetPosted(post.id, targets[0].id, `ig_nosnap_${generateUuid().slice(0, 8)}`)

    const promotionId = generateUuid()
    await promoRepo.createPromotion(promotionId, post.id, client.id, {
      status: 'waiting_for_post', budgetType: 'daily', budgetAmount: 500,
      objective: 'OUTCOME_ENGAGEMENT', targeting: { geo_locations: { countries: ['IN'] } },
      chargedPaise: 0,
    })
    const ptgtId = generateUuid()
    await promoRepo.createPromotionTarget(ptgtId, promotionId, targets[0].id, 'instagram', targets[0].platformAccountId)

    metaMocks.createAdCampaign.mockClear()
    metaMocks.createAdSet.mockClear()
    const runResult = await promotionService.runPromotionTargetJob(ptgtId, {})
    expect(runResult.done).toBe(true)
    expect(metaMocks.createAdCampaign).not.toHaveBeenCalled()
    expect(metaMocks.createAdSet).not.toHaveBeenCalled()
    const ptgt = await promoRepo.findPromotionTargetById(ptgtId)
    expect(ptgt.status).toBe('failed')
    expect(ptgt.error).toContain('explicit handling')
    const promo = await promoRepo.findPromotionById(promotionId)
    expect(promo.error).toContain('manual review')
  })

  it('backfill resolves valid legacy promotions, flags invalid ones, and is idempotent', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Backfill ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'backfill', mediaUrl: 'https://example.com/img.jpg',
      targetAccountIds: [igAccountId],
    })
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    const goodId = generateUuid()
    await promoRepo.createPromotion(goodId, post.id, client.id, {
      status: 'waiting_for_post', budgetType: 'daily', budgetAmount: 500,
      objective: 'OUTCOME_ENGAGEMENT', targeting: { geo_locations: { countries: ['IN'] } },
    })
    await promoRepo.createPromotionTarget(generateUuid(), goodId, targets[0].id, 'instagram', targets[0].platformAccountId)
    const badPost = await postService.createPost(client.id, {
      name: `Promo Backfill Bad ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'backfill bad', mediaUrl: 'https://example.com/img.jpg',
      targetAccountIds: [igAccountId],
    })
    const badTargets = await postRepo.findPostTargetsByPostId(badPost.id)
    const badId = generateUuid()
    await promoRepo.createPromotion(badId, badPost.id, client.id, {
      status: 'waiting_for_post', budgetType: 'daily', budgetAmount: 500,
      objective: 'OUTCOME_AWARENESS', targeting: { geo_locations: { countries: ['IN'] } },
    })
    await promoRepo.createPromotionTarget(generateUuid(), badId, badTargets[0].id, 'instagram', badTargets[0].platformAccountId)

    const goodOutcome = await promotionService.backfillPromotionSnapshot(goodId)
    expect(goodOutcome.status).toBe('resolved')
    const badOutcome = await promotionService.backfillPromotionSnapshot(badId)
    expect(badOutcome.status).toBe('unresolved')

    const good = await promoRepo.findPromotionById(goodId)
    expect(good.resolvedAt).toBeTruthy()
    expect(good.resolvedTargeting.targets[targets[0].id].geo_locations.countries).toEqual(['IN'])
    expect(good.targeting).toEqual({ geo_locations: { countries: ['IN'] } })
    const bad = await promoRepo.findPromotionById(badId)
    expect(bad.resolvedAt).toBeNull()
    expect(bad.resolvedTargeting).toBeNull()
    expect(bad.error).toContain('Unresolved boost configuration')
    expect(bad.targeting).toEqual({ geo_locations: { countries: ['IN'] } })
    expect(await promoRepo.countUnresolvedPromotions()).toBeGreaterThanOrEqual(1)

    const resolvedAtBefore = good.resolvedAt
    const repeat = await promotionService.backfillPromotionSnapshot(goodId)
    expect(repeat.status).toBe('skipped')
    const goodAfter = await promoRepo.findPromotionById(goodId)
    expect(new Date(goodAfter.resolvedAt).getTime()).toBe(new Date(resolvedAtBefore).getTime())
  })

  it('Flow B invalid: unpublished post → 422, no promotion, no charge', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo FlowB Bad ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'flow b bad', mediaUrl: 'https://example.com/img.jpg',
      targetAccountIds: [igAccountId],
    })
    await grantCoins(client.id, 10000)
    await expect(promotionService.createPromotionForPublishedPost(client.id, post.id, {
      budgetType: 'daily', budgetAmount: 500, endTime: futureBoostEndTime,
    })).rejects.toMatchObject({ statusCode: 422 })
    const promotion = await promoRepo.findPromotionByPostId(post.id)
    expect(promotion).toBeNull()
  })

  it('Flow B duplicate: same request ×3 → one promotion, one charge', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Dup ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'dup', mediaUrl: 'https://example.com/img.jpg',
      targetAccountIds: [igAccountId],
    })
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    await markTargetPosted(post.id, targets[0].id, `ig_dup_${generateUuid().slice(0, 8)}`)
    await grantCoins(client.id, 10000)

    const dupArgs = { budgetType: 'daily', budgetAmount: 500, endTime: futureBoostEndTime, targeting: { geo_locations: { countries: ['IN'] } } }
    const first = await promotionService.createPromotionForPublishedPost(client.id, post.id, dupArgs)
    const walletAfterFirst = (await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(client.id)])).coins

    await expect(promotionService.createPromotionForPublishedPost(client.id, post.id, dupArgs))
      .rejects.toMatchObject({ statusCode: 409 })
    await expect(promotionService.createPromotionForPublishedPost(client.id, post.id, dupArgs))
      .rejects.toMatchObject({ statusCode: 409 })
    const walletAfterAll = (await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(client.id)])).coins
    expect(Number(walletAfterAll)).toBe(Number(walletAfterFirst))

    const promotions = await query('SELECT COUNT(*) as c FROM promotions WHERE post_id = ?', [uuidToBuffer(post.id)])
    expect(promotions[0].c).toBe(1)
    const billing = await query('SELECT COUNT(*) as c FROM post_billing_entries WHERE post_id = ? AND kind = \'charge\'', [uuidToBuffer(post.id)])
    expect(billing[0].c).toBe(1)
    expect(first.promotion.id).toBeTruthy()
  })

  it('cancellation: WAITING_FOR_POST cancels without Meta calls', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Cancel Wait ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'cancel wait', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostObjective: 'OUTCOME_ENGAGEMENT', boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    const promotion = await promoRepo.findPromotionByPostId(post.id)
    const cancelled = await promotionService.cancelPromotion(client.id, promotion.id)
    expect(cancelled.status).toBe('cancelled')
    expect(metaMocks.deleteAdCampaign).not.toHaveBeenCalled()
    const targets = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)
    expect(targets.every(t => t.status === 'cancelled')).toBe(true)
  })

  it('cancellation: after activation cleans up all Meta objects', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Cancel Act ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'cancel act', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostObjective: 'OUTCOME_ENGAGEMENT', boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    await grantCoins(client.id, 10000)
    await postService.submitPost(client.id, post.id)
    const adminCancelAct = await createTestUser({ email: `promo-admx-cancelact-${generateUuid()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    await postService.approvePost(adminCancelAct.id, post.id, {})
    await markTargetPosted(post.id, targets[0].id, `ig_cancelact_${generateUuid().slice(0, 8)}`)
    const promotion = await promoRepo.findPromotionByPostId(post.id)
    const ptgts = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)
    await promotionService.runPromotionTargetJob(ptgts[0].id, {})

    const cancelled = await promotionService.cancelPromotion(client.id, promotion.id)
    expect(cancelled.status).toBe('cancelled')
    expect(metaMocks.deleteAd).toHaveBeenCalled()
    expect(metaMocks.deleteAdCreative).toHaveBeenCalled()
    expect(metaMocks.deleteAdSet).toHaveBeenCalled()
    expect(metaMocks.deleteAdCampaign).toHaveBeenCalled()
    const finalTargets = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)
    expect(finalTargets[0].status).toBe('cancelled')
    expect(finalTargets[0].platformCampaignId).toBeNull()
  })

  it('dead-job isolation: promotion failure does NOT mark the Post failed', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Dead ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'dead', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostObjective: 'OUTCOME_ENGAGEMENT', boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    await markTargetPosted(post.id, targets[0].id, `ig_dead_${generateUuid().slice(0, 8)}`)
    const promotion = await promoRepo.findPromotionByPostId(post.id)
    const ptgts = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)

    metaMocks.createAdCampaign.mockRejectedValueOnce(new Error('Meta API hard failure'))
    const result = await promotionService.runPromotionTargetJob(ptgts[0].id, {})
    expect(result.done).toBe(true)
    const updatedPtgt = await promoRepo.findPromotionTargetById(ptgts[0].id)
    expect(updatedPtgt.status).toBe('failed')

    const refreshedPost = await postRepo.findPostById(post.id)
    expect(refreshedPost.status).toBe('completed')
    expect(refreshedPost.error).toBeNull()
  })

  it('recovery: recoverStuckPromotionTargets re-enqueues pending targets of posted posts', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Stuck ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'stuck', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostObjective: 'OUTCOME_ENGAGEMENT', boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    await markTargetPosted(post.id, targets[0].id, `ig_stuck_${generateUuid().slice(0, 8)}`)
    const promotion = await promoRepo.findPromotionByPostId(post.id)
    expect(promotion.status).toBe('waiting_for_post')

    const { recovered } = await promotionService.recoverStuckPromotionTargets()
    expect(recovered).toBeGreaterThanOrEqual(1)
    const jobs = await query(
      "SELECT COUNT(*) as c FROM campaign_jobs WHERE job_type = 'promotion_execute' AND status IN ('queued','running')"
    )
    expect(jobs[0].c).toBeGreaterThanOrEqual(1)
  })

  it('goLiveForFilledPost: publisher targets get promotion targets when promotion exists', async () => {
    await setFlag('promotions_enabled', true)
    const client2 = await createTestUser({ email: `promo-pub-${generateUuid()}@flowx-test.com`, password: 'Test@123' })
    const pubAccount = await addPlatformAccount(client2.id, { code: 'instagram', platformUserId: `ig_pub_${generateUuid()}`, igId: '17841400000000002' })

    const catRow = await queryOne("SELECT id FROM ad_categories LIMIT 1")
    const post = await postService.createPost(client.id, {
      name: `Promo GoLive ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'golive', mediaUrl: 'https://example.com/img.jpg',
      runOnPublishers: true, publisherCount: 1, coinsPerPublisher: 100,
      categoryId: bufferToUuid(catRow.id),
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostObjective: 'OUTCOME_ENGAGEMENT', boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)

    const promotion = await promoRepo.findPromotionByPostId(post.id)
    expect(promotion).not.toBeNull()
    const initialTargets = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)
    expect(initialTargets.length).toBe(1)

    await query(
      `INSERT INTO post_publisher_requests (id, post_id, publisher_id, coins_offered, status, platform_account_id)
       VALUES (?, ?, ?, 100, 'accepted', ?)`,
      [uuidToBuffer(generateUuid()), uuidToBuffer(post.id), uuidToBuffer(client2.id), uuidToBuffer(pubAccount)]
    )
    await query("UPDATE posts SET status = 'awaiting_publishers' WHERE id = ?", [uuidToBuffer(post.id)])
    await postService.goLiveForFilledPost(post.id)

    const finalTargets = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)
    expect(finalTargets.length).toBe(2)
    const allPostTargets = await postRepo.findPostTargetsByPostId(post.id)
    const publisherTarget = allPostTargets.find(t => t.targetType === 'publisher')
    expect(publisherTarget).toBeTruthy()
    const publisherPromoTarget = finalTargets.find(t => t.postTargetId === publisherTarget.id)
    expect(publisherPromoTarget).toBeTruthy()
  })

  it('billing: flag-on createPost charges nothing; charge lands at admin approval', async () => {
    await setFlag('promotions_enabled', true)
    const before = await totalAvailable(client.id)

    const post = await postService.createPost(client.id, {
      name: `Promo Billing ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'billing', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostObjective: 'OUTCOME_ENGAGEMENT', boostOptimizationGoal: 'POST_ENGAGEMENT',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    expect(await totalAvailable(client.id)).toBe(before)
    let promotion = await promoRepo.findPromotionByPostId(post.id)
    expect(promotion.chargedPaise).toBe(0)

    await postService.submitPost(client.id, post.id)
    const admin = await createTestUser({ email: `promo-admin-${generateUuid()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    await postService.approvePost(admin.id, post.id, {})

    expect(await totalAvailable(client.id)).toBe(before - 500)
    promotion = await promoRepo.findPromotionByPostId(post.id)
    expect(promotion.chargedPaise).toBe(50000)
    const chargedPost = await postRepo.findPostById(post.id)
    expect(chargedPost.chargedBoostPaise).toBe(50000)
    const entries = await query("SELECT kind, coins, paise FROM post_billing_entries WHERE post_id = ? ORDER BY created_at", [uuidToBuffer(post.id)])
    expect(entries.some(e => e.kind === 'charge' && Number(e.coins) === 500)).toBe(true)
  })

  it('billing: approvePost idempotent — second charge attempt does not double-charge', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Idem ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'idem', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    const before = await totalAvailable(client.id)
    await postService.submitPost(client.id, post.id)
    const admin = await createTestUser({ email: `promo-admin2-${generateUuid()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    await postService.approvePost(admin.id, post.id, {})
    await promotionService.chargePromotionForApproval(await postRepo.findPostById(post.id))
    expect(await totalAvailable(client.id)).toBe(before - 500)
  })

  it('billing: approvePost with insufficient coins → 422, no charge, post stays pending_review', async () => {
    await setFlag('promotions_enabled', true)
    const drained = await totalAvailable(client.id)
    const budget = drained + 50000
    const post = await postService.createPost(client.id, {
      name: `Promo Poor ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'poor', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: budget, boostEndTime: futureBoostEndTime,
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const admin = await createTestUser({ email: `promo-admin3-${generateUuid()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    await expect(postService.approvePost(admin.id, post.id, {})).rejects.toMatchObject({ statusCode: 422 })
    const stillPending = await postRepo.findPostById(post.id)
    expect(stillPending.status).toBe('pending_review')
    const promotion = await promoRepo.findPromotionByPostId(post.id)
    expect(promotion.chargedPaise).toBe(0)
    expect(await totalAvailable(client.id)).toBe(drained)
  })

  it('billing: cancelPost on charged promotion-owned post cancels promotion, refunds targets, settles leftover', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo CancelCharged ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'cancel charged', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId, fbAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const admin = await createTestUser({ email: `promo-admin8-${generateUuid()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    await postService.approvePost(admin.id, post.id, {})
    const promotion = await promoRepo.findPromotionByPostId(post.id)
    expect(promotion.chargedPaise).toBe(100000)

    const cancelled = await postService.cancelPost(client.id, post.id)
    expect(cancelled.status).toBe('cancelled')

    const refreshedPromotion = await promoRepo.findPromotionById(promotion.id)
    expect(refreshedPromotion.status).toBe('cancelled')
    expect(refreshedPromotion.settledAt).toBeTruthy()
    const targets = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)
    expect(targets.every(t => t.status === 'cancelled')).toBe(true)
    expect(targets.every(t => Number(t.refundedPaise) === 50000)).toBe(true)
  })

  it('billing: target permanent failure refunds exactly one share (idempotent)', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Refund ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'refund', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const admin = await createTestUser({ email: `promo-admin4-${generateUuid()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    await postService.approvePost(admin.id, post.id, {})
    const charged = await totalAvailable(client.id)

    const targets = await postRepo.findPostTargetsByPostId(post.id)
    await markTargetPosted(post.id, targets[0].id, `ig_refund_${generateUuid().slice(0, 8)}`)
    const promotion = await promoRepo.findPromotionByPostId(post.id)
    const promoTargets = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)

    metaMocks.getInstagramBoostEligibility.mockReset().mockResolvedValue({ ready: true, isEligible: false, allowedObjectives: [], reasons: ['not eligible'], raw: {} })
    await promotionService.runPromotionTargetJob(promoTargets[0].id, {})

    const failedTarget = await promoRepo.findPromotionTargetById(promoTargets[0].id)
    expect(failedTarget.status).toBe('failed')
    expect(failedTarget.refundedPaise).toBe(50000)

    expect(await totalAvailable(client.id)).toBe(charged + 500)

    const promoRow = await promoRepo.findPromotionById(promotion.id)
    expect(promoRow.status).toBe('failed')
    const entries = await query("SELECT kind, coins FROM post_billing_entries WHERE post_id = ? AND kind = 'refund'", [uuidToBuffer(post.id)])
    expect(entries.filter(e => Number(e.coins) === 500).length).toBe(1)
  })

  it('infra: requeueReelJob accepts object payload without mysqld error', async () => {
    const campaignRepo = await import('../../src/modules/campaigns/campaign.repository.js')
    const { enqueueTargetJob } = campaignRepo
    const ok = await enqueueTargetJob('promotion_execute', `promotion:${generateUuid()}`, { promotionTargetId: 'x' })
    expect(ok).toBe(true)
    const job = await queryOne("SELECT id, status FROM campaign_jobs WHERE job_type = 'promotion_execute' ORDER BY created_at DESC LIMIT 1")
    await query("UPDATE campaign_jobs SET status = 'running' WHERE id = ?", [job.id])
    const { requeueReelJob } = campaignRepo
    await requeueReelJob(bufferToUuid(job.id), 5, { promotionTargetId: 'x', liveAttempts: 2 })
    const requeued = await queryOne('SELECT status, payload FROM campaign_jobs WHERE id = ?', [job.id])
    expect(requeued.status).toBe('queued')
    const payload = JSON.parse(requeued.payload)
    expect(payload.liveAttempts).toBe(2)
    expect(payload.promotionTargetId).toBe('x')
  })

  it('infra: enqueueTargetJob resurrects dead rows and never clobbers queued/running', async () => {
    const campaignRepo = await import('../../src/modules/campaigns/campaign.repository.js')
    const { enqueueTargetJob } = campaignRepo
    const runKey = `promotion:${generateUuid()}`
    const first = await enqueueTargetJob('promotion_execute', runKey, { promotionTargetId: 'r' })
    expect(first).toBe(true)
    const second = await enqueueTargetJob('promotion_execute', runKey, { promotionTargetId: 'r' })
    expect(second).toBe(false)

    const job = await queryOne('SELECT id, status FROM campaign_jobs WHERE run_key = ?', [runKey])
    await query("UPDATE campaign_jobs SET status = 'dead', error = 'dead once' WHERE id = ?", [job.id])
    const third = await enqueueTargetJob('promotion_execute', runKey, { promotionTargetId: 'r2' })
    expect(third).toBe(true)
    const resurrected = await queryOne('SELECT status, error, payload FROM campaign_jobs WHERE run_key = ?', [runKey])
    expect(resurrected.status).toBe('queued')
    expect(resurrected.error).toBeNull()
    expect(JSON.parse(resurrected.payload).promotionTargetId).toBe('r2')

    await query("UPDATE campaign_jobs SET status = 'running' WHERE id = ?", [job.id])
    const fourth = await enqueueTargetJob('promotion_execute', runKey, { promotionTargetId: 'r3' })
    expect(fourth).toBe(false)
    const stillRunning = await queryOne('SELECT status, payload FROM campaign_jobs WHERE run_key = ?', [runKey])
    expect(stillRunning.status).toBe('running')
    expect(JSON.parse(stillRunning.payload).promotionTargetId).toBe('r2')
  })

  it('live gate: bare FB id resolves via resolveFbPostObjectId and proceeds', async () => {
    await setFlag('promotions_enabled', true)
    await grantCoins(client.id, 10000)
    const post = await postService.createPost(client.id, {
      name: `Promo BareId ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'bare', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [fbAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const admin = await createTestUser({ email: `promo-admin5-${generateUuid()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    await postService.approvePost(admin.id, post.id, {})
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    const bareId = `12345${generateUuid().slice(0, 8).replace(/[^0-9]/g, '')}`.slice(0, 15)
    await markTargetPosted(post.id, targets[0].id, bareId)
    await query("UPDATE post_targets SET remote_video_id = ? WHERE id = ?", [bareId, uuidToBuffer(targets[0].id)])

    metaMocks.resolveFbPostObjectId.mockReset().mockResolvedValue(`111111_${bareId}`)
    metaMocks.isPostLiveForBoost.mockReset().mockResolvedValue(true)

    const promotion = await promoRepo.findPromotionByPostId(post.id)
    const promoTargets = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)
    const result = await promotionService.runPromotionTargetJob(promoTargets[0].id, {})
    expect(result.requeueAfterSeconds).toBeUndefined()
    expect(metaMocks.resolveFbPostObjectId).toHaveBeenCalled()
    const refreshedTarget = await postRepo.findPostTargetById(targets[0].id)
    expect(refreshedTarget.metaObjectId).toBe(`111111_${bareId}`)
  })

  it('photo post: promotable_id from eligibility replaces the stored photo-node id in object_story_id', async () => {
    await setFlag('promotions_enabled', true)
    await grantCoins(client.id, 10000)
    const post = await postService.createPost(client.id, {
      name: `Promo PhotoId ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'photo id', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [fbAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const admin = await createTestUser({ email: `promo-admin6-${generateUuid()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    await postService.approvePost(admin.id, post.id, {})
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    const fbTarget = targets.find(t => t.platformCode === 'facebook')
    const photoNodeId = `99999${generateUuid().slice(0, 8).replace(/[^0-9]/g, '')}`.slice(0, 15)
    await markTargetPosted(post.id, fbTarget.id, photoNodeId)

    metaMocks.isPostLiveForBoost.mockReset().mockResolvedValue(true)
    const feedPostId = `111111_88888${generateUuid().slice(0, 8).replace(/[^0-9]/g, '')}`.slice(0, 30)
    metaMocks.getPostPromotability.mockReset().mockResolvedValue({
      isEligible: true, promotableId: feedPostId, allowedObjectives: [], instagramEligibility: 'eligible', raw: {},
    })

    const promotion = await promoRepo.findPromotionByPostId(post.id)
    const promoTargets = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)
    const result = await promotionService.runPromotionTargetJob(promoTargets[0].id, {})
    expect(result.done).toBe(true)

    const creativeCalls = metaMocks.createAdCreativeFromPost.mock.calls
    expect(creativeCalls.length).toBeGreaterThan(0)
    expect(creativeCalls[0][1]).toBe(feedPostId)
    expect(creativeCalls[0][1]).not.toContain(photoNodeId)

    const refreshedTarget = await postRepo.findPostTargetById(fbTarget.id)
    expect(refreshedTarget.promotableId).toBe(feedPostId)
    const finalTarget = await promoRepo.findPromotionTargetById(promoTargets[0].id)
    expect(finalTarget.status).toBe('active')
  })

  it('FB boost: boostCallToAction forwards as call_to_action_type on the ad creative (existing-post object_story_id, no link/headline/description override)', async () => {
    await setFlag('promotions_enabled', true)
    await grantCoins(client.id, 10000)
    const post = await postService.createPost(client.id, {
      name: `Promo CTA ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'cta fb', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostCallToAction: 'LEARN_MORE',
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [fbAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const admin = await createTestUser({ email: `promo-admin-cta-${generateUuid()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    await postService.approvePost(admin.id, post.id, {})
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    const fbTarget = targets.find(t => t.platformCode === 'facebook')
    await markTargetPosted(post.id, fbTarget.id, `987654_${generateUuid().slice(0, 8).replace(/[^0-9]/g, '')}`.slice(0, 20))

    const promotion = await promoRepo.findPromotionByPostId(post.id)
    const promoTargets = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)
    const result = await promotionService.runPromotionTargetJob(promoTargets[0].id, {})
    expect(result.done).toBe(true)

    const creativeCalls = metaMocks.createAdCreativeFromPost.mock.calls
    expect(creativeCalls.length).toBeGreaterThan(0)
    // (adAccountId, objectStoryId, name, accessToken, validateOnly, callToActionType)
    for (const call of creativeCalls) {
      expect(call[5]).toBe('LEARN_MORE')
    }
  })

  it('photo post: null promotable_id falls back to the qualified stored id', async () => {
    await setFlag('promotions_enabled', true)
    await grantCoins(client.id, 10000)
    const post = await postService.createPost(client.id, {
      name: `Promo PhotoNull ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'photo null', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [fbAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const admin = await createTestUser({ email: `promo-admin7-${generateUuid()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    await postService.approvePost(admin.id, post.id, {})
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    const fbTarget = targets.find(t => t.platformCode === 'facebook')
    const qualifiedId = `222222_77777${generateUuid().slice(0, 8).replace(/[^0-9]/g, '')}`.slice(0, 30)
    await markTargetPosted(post.id, fbTarget.id, qualifiedId)

    metaMocks.isPostLiveForBoost.mockReset().mockResolvedValue(true)
    metaMocks.getPostPromotability.mockReset().mockResolvedValue({
      isEligible: true, promotableId: null, allowedObjectives: [], instagramEligibility: 'eligible', raw: {},
    })

    const promotion = await promoRepo.findPromotionByPostId(post.id)
    const promoTargets = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)
    const result = await promotionService.runPromotionTargetJob(promoTargets[0].id, {})
    expect(result.done).toBe(true)

    const creativeCalls = metaMocks.createAdCreativeFromPost.mock.calls
    expect(creativeCalls.length).toBeGreaterThan(0)
    expect(creativeCalls[0][1]).toBe(qualifiedId)
    const finalTarget = await promoRepo.findPromotionTargetById(promoTargets[0].id)
    expect(finalTarget.status).toBe('active')
  })

  it('transient: executeBoostCreation Meta 5xx requeues instead of permanent failure', async () => {
    await setFlag('promotions_enabled', true)
    await grantCoins(client.id, 10000)
    const post = await postService.createPost(client.id, {
      name: `Promo Trans ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'trans', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const admin = await createTestUser({ email: `promo-admin6-${generateUuid()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    await postService.approvePost(admin.id, post.id, {})
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    await markTargetPosted(post.id, targets[0].id, `ig_trans_${generateUuid().slice(0, 8)}`)
    const promotion = await promoRepo.findPromotionByPostId(post.id)
    const promoTargets = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)

    const transientError = new Error('Graph API POST act_1/adcreatives failed: {"error":{"code":1,"message":"Please reduce the amount of data you are asking for, then retry your request"}}')
    transientError.statusCode = 500
    metaMocks.createAdCreativeFromInstagramPost.mockReset().mockImplementation(async () => { throw transientError })
    metaMocks.createAdCampaign.mockReset().mockImplementation(async () => { throw transientError })

    const result = await promotionService.runPromotionTargetJob(promoTargets[0].id, {})
    expect(result.requeueAfterSeconds).toBe(30)
    expect(result.transient).toBe(true)
    const ptgtAfter = await promoRepo.findPromotionTargetById(promoTargets[0].id)
    expect(ptgtAfter.status).not.toBe('failed')
    expect(ptgtAfter.refundedPaise).toBe(0)
  })

  it('stuck-charge fix: post publishing failing on every target cancels+settles the live promotion (refreshPostStatus)', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo AllFail ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'all fail', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const admin = await createTestUser({ email: `promo-admin-allfail-${generateUuid()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    await postService.approvePost(admin.id, post.id, {})

    const promotion = await promoRepo.findPromotionByPostId(post.id)
    expect(promotion.chargedPaise).toBe(50000)

    // Simulate the publish job permanently failing on the post's only target
    // (never posted anywhere) instead of actually draining the publish job.
    const targets = await postRepo.findPostTargetsByPostId(post.id)
    await query("UPDATE post_targets SET status = 'failed', error = 'permanent failure' WHERE id = ?", [uuidToBuffer(targets[0].id)])

    const refreshed = await postService.refreshPostStatus(post.id)
    expect(refreshed.status).toBe('failed')

    const refreshedPromotion = await promoRepo.findPromotionById(promotion.id)
    expect(refreshedPromotion.status).toBe('cancelled')
    expect(refreshedPromotion.settledAt).toBeTruthy()
    const promoTargets = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)
    expect(promoTargets.every(t => t.status === 'cancelled')).toBe(true)
    expect(promoTargets.every(t => Number(t.refundedPaise) === 50000)).toBe(true)
  })

  it('stuck-charge fix: publisher deadline expiring with zero acceptance cancels+settles the live promotion (expirePublisherPosts)', async () => {
    await setFlag('promotions_enabled', true)
    const catRow = await queryOne('SELECT id FROM ad_categories LIMIT 1')
    const before = await totalAvailable(client.id)
    const post = await postService.createPost(client.id, {
      name: `Promo NoAccept ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'no accept', mediaUrl: 'https://example.com/img.jpg',
      runOnPublishers: true, publisherCount: 2, coinsPerPublisher: 100,
      categoryId: bufferToUuid(catRow.id),
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const admin = await createTestUser({ email: `promo-admin-noaccept-${generateUuid()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    await postService.approvePost(admin.id, post.id, {})

    const promotion = await promoRepo.findPromotionByPostId(post.id)
    // 1 client target + 2 publisher slots, at 500 coins each = 3 * 50000 paise
    expect(promotion.chargedPaise).toBe(150000)
    // Both the publisher escrow and the promotion charge left the wallet.
    expect(before).toBeGreaterThan(await totalAvailable(client.id))

    await query(
      'UPDATE posts SET publisher_response_deadline_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?',
      [uuidToBuffer(post.id)]
    )
    const results = await postService.expirePublisherPosts([post.id])
    const res = results.find(r => r.postId === post.id)
    expect(res.mode).toBe('no-acceptance')

    const refreshedPost = await postRepo.findPostById(post.id)
    expect(refreshedPost.status).toBe('failed')

    const refreshedPromotion = await promoRepo.findPromotionById(promotion.id)
    expect(refreshedPromotion.status).toBe('cancelled')
    expect(refreshedPromotion.settledAt).toBeTruthy()

    // Escrow refunded in full (no publishers accepted) AND the promotion's
    // full charge refunded (1 materialized target refunded directly, the 2
    // never-materialized publisher slots refunded via the settle-leftover
    // math) — net wallet effect versus the pre-approval balance is zero.
    expect(await totalAvailable(client.id)).toBe(before)
  })

  it('stuck-charge fix: publisher deadline expiring with PARTIAL acceptance refunds only the unfilled boost slots, promotion stays live', async () => {
    await setFlag('promotions_enabled', true)
    const catRow = await queryOne('SELECT id FROM ad_categories LIMIT 1')
    const publisher = await createTestUser({ email: `promo-partial-pub-${generateUuid()}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    const pubAccount = await addPlatformAccount(publisher.id, { code: 'instagram', platformUserId: `ig_partial_pub_${generateUuid()}`, igId: '17841400000000003' })

    const post = await postService.createPost(client.id, {
      name: `Promo Partial ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'partial fill', mediaUrl: 'https://example.com/img.jpg',
      runOnPublishers: true, publisherCount: 3, coinsPerPublisher: 100,
      categoryId: bufferToUuid(catRow.id),
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const admin = await createTestUser({ email: `promo-admin-partial-${generateUuid()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    await postService.approvePost(admin.id, post.id, {})

    const promotion = await promoRepo.findPromotionByPostId(post.id)
    // 1 client target + 3 publisher slots, at 500 coins each = 4 * 50000 paise
    expect(promotion.chargedPaise).toBe(200000)
    const afterApprove = await totalAvailable(client.id)

    // approvePost's createPostPublisherRequests already auto-generated a
    // pending request for this verified publisher — accept it for real
    // instead of inserting a second row (which collides on the
    // (post, publisher, generation) unique key).
    const requests = await postRepo.findPostPublisherRequestsByPostId(post.id)
    const mine = requests.find(r => r.publisherId === publisher.id)
    await postService.acceptPostPublisherRequest(publisher.id, mine.id, { platformAccountId: pubAccount })

    await query(
      'UPDATE posts SET publisher_response_deadline_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?',
      [uuidToBuffer(post.id)]
    )
    const results = await postService.expirePublisherPosts([post.id])
    const res = results.find(r => r.postId === post.id)
    expect(res.mode).toBe('partial-go-live')
    expect(res.accepted).toBe(1)

    const refreshedPromotion = await promoRepo.findPromotionById(promotion.id)
    // 2 unfilled slots refunded: 200000 - (2 * 50000) = 100000 remaining for
    // the client's target + the 1 accepted publisher.
    expect(refreshedPromotion.chargedPaise).toBe(100000)
    expect(refreshedPromotion.unfilledSlotsSettledAt).toBeTruthy()
    expect(refreshedPromotion.status).not.toBe('cancelled')

    // Escrow refund is prorated across the full charged escrow (base +
    // the 10% platform fee), not just base cost: escrow = 3*100*1.1 = 330,
    // 2 of 3 slots unfilled -> round(2/3 * 330) = 220. Boost refund is
    // 2 unfilled * 500 coins = 1000. Total = 1220 coins back.
    expect((await totalAvailable(client.id)) - afterApprove).toBe(1220)

    // A repeat call (simulating a re-processed expiry) must never double-refund.
    const { refundUnfilledPromotionSlots } = await import('../../src/modules/posts/promotion.service.js')
    const second = await refundUnfilledPromotionSlots(post.id, 2, 're-run')
    expect(second.chargedPaise).toBe(100000)
    expect((await totalAvailable(client.id)) - afterApprove).toBe(1220)
  })

  it('cancelPromotionById: one target throwing never blocks cancelling the rest, nor skips the final status flip + settle', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Resilient ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'resilient', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId, fbAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const admin = await createTestUser({ email: `promo-admin-resilient-${generateUuid()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    await postService.approvePost(admin.id, post.id, {})

    const promotion = await promoRepo.findPromotionByPostId(post.id)
    const targetsBefore = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)
    expect(targetsBefore.length).toBe(2)
    const before = await totalAvailable(client.id)

    // Simulate a transient DB hiccup on the first target's cancel write —
    // must not stop the second target from being cancelled+refunded, and
    // must not skip the promotion's own status flip + leftover settle.
    const spy = vi.spyOn(promoRepo, 'updatePromotionTarget').mockRejectedValueOnce(new Error('transient db hiccup'))
    const result = await promotionService.cancelPromotionById(promotion.id)
    spy.mockRestore()

    expect(result.status).toBe('cancelled')
    expect(result.settledAt).toBeTruthy()
    // Whatever the failed target's own row didn't recover, the leftover
    // settle sweep (gated on the promotion having already reached
    // 'cancelled') makes the client whole regardless.
    expect(await totalAvailable(client.id)).toBe(before + 1000)
  })

  it('claimPromotionTargetForCreation: only one of two concurrent callers wins the pending -> creating transition', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo Claim ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'claim', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const admin = await createTestUser({ email: `promo-admin-claim-${generateUuid()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    await postService.approvePost(admin.id, post.id, {})
    const promotion = await promoRepo.findPromotionByPostId(post.id)
    const [ptgt] = await promoRepo.findPromotionTargetsByPromotionId(promotion.id)

    const [first, second] = await Promise.all([
      promoRepo.claimPromotionTargetForCreation(ptgt.id),
      promoRepo.claimPromotionTargetForCreation(ptgt.id),
    ])
    expect([first, second].filter(Boolean)).toHaveLength(1)
    const after = await promoRepo.findPromotionTargetById(ptgt.id)
    expect(after.status).toBe('creating')

    // Excludes 'creating' as a source — a third caller must never re-win
    // the same claim while the winner is still working.
    expect(await promoRepo.claimPromotionTargetForCreation(ptgt.id)).toBe(false)
  })

  it('a promotion_target whose underlying post_target permanently failed gets cancelled+refunded instead of staying pending forever', async () => {
    await setFlag('promotions_enabled', true)
    const post = await postService.createPost(client.id, {
      name: `Promo PartialFail ${generateUuid().slice(0, 8)}`,
      type: 'post', caption: 'partial fail', mediaUrl: 'https://example.com/img.jpg',
      boostEnabled: true, boostBudgetType: 'daily', boostBudgetAmount: 500, boostEndTime: futureBoostEndTime,
      boostTargeting: { geo_locations: { countries: ['IN'] } },
      targetAccountIds: [igAccountId, fbAccountId],
    })
    await postService.submitPost(client.id, post.id)
    const admin = await createTestUser({ email: `promo-admin-pfail-${generateUuid()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    await postService.approvePost(admin.id, post.id, {})

    const targets = await postRepo.findPostTargetsByPostId(post.id)
    const igTarget = targets.find(t => t.platformCode === 'instagram')
    const fbTarget = targets.find(t => t.platformCode === 'facebook')
    // IG target's underlying publish permanently failed; FB stays untouched
    // (still eligible to go live independently — partial-failure, not
    // all-targets-failed, so the post-level cancel path never fires).
    await query("UPDATE post_targets SET status = 'failed', error = 'permanent' WHERE id = ?", [uuidToBuffer(igTarget.id)])

    const promotion = await promoRepo.findPromotionByPostId(post.id)
    const igPtgt = (await promoRepo.findPromotionTargetsByPromotionId(promotion.id)).find(t => t.postTargetId === igTarget.id)
    const before = await totalAvailable(client.id)

    const result = await promotionService.runPromotionTargetJob(igPtgt.id, {})
    expect(result.done).toBe(true)
    const refreshed = await promoRepo.findPromotionTargetById(igPtgt.id)
    expect(refreshed.status).toBe('cancelled')
    expect(Number(refreshed.refundedPaise)).toBe(50000)
    expect(await totalAvailable(client.id)).toBe(before + 500)

    // findStuckPendingPromotionTargets must never re-surface an already
    // terminal (cancelled) target for this same reason.
    const stuck = await promoRepo.findStuckPendingPromotionTargets()
    expect(stuck.find(t => t.id === igPtgt.id)).toBeUndefined()
  })
})
