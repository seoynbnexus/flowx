import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import supertest from 'supertest'
import * as webhookService from '../../src/modules/campaigns/meta-webhook.service.js'
import * as deletionService from '../../src/modules/posts/deletion-monitoring.service.js'
import * as dmRepo from '../../src/modules/posts/deletion-monitoring.repository.js'
import * as postRepo from '../../src/modules/posts/post.repository.js'
import * as promoRepo from '../../src/modules/posts/promotion.repository.js'
import * as promotionService from '../../src/modules/posts/promotion.service.js'
import * as postService from '../../src/modules/posts/post.service.js'
import * as campaignJobs from '../../src/modules/campaigns/campaign.jobs.js'
import { classifyRemoteStateError } from '../../shared/services/meta-ads.service.js'
import { query, queryOne } from '../../shared/database/connection.js'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { encrypt } from '../../shared/utils/crypto.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import { loginAgent } from '../helpers/auth.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    getObjectRemoteState: vi.fn().mockResolvedValue({ state: 'visible' }),
    getPageRemoteState: vi.fn().mockResolvedValue({ state: 'visible' }),
    updateAdStatus: vi.fn().mockResolvedValue({ success: true }),
    deleteAdCampaign: vi.fn().mockResolvedValue({ success: true }),
    deleteAdSet: vi.fn().mockResolvedValue({ success: true }),
    deleteAdCreative: vi.fn().mockResolvedValue({ success: true }),
    deleteAd: vi.fn().mockResolvedValue({ success: true }),
    getPostPromotability: vi.fn().mockResolvedValue({ isEligible: true, promotableId: 'mock_promotable_1', allowedObjectives: [], raw: {} }),
    getInstagramBoostEligibility: vi.fn().mockResolvedValue({ ready: true, isEligible: true, allowedObjectives: [], reasons: [], raw: {} }),
    createAdCampaign: vi.fn().mockImplementation(async () => ({ id: `mock_dm_campaign_${generateUuid().slice(0, 8)}` })),
    createAdSet: vi.fn().mockImplementation(async () => ({ id: `mock_dm_adset_${generateUuid().slice(0, 8)}` })),
    createAdCreativeFromPost: vi.fn().mockImplementation(async () => ({ id: `mock_dm_creative_${generateUuid().slice(0, 8)}` })),
    createAd: vi.fn().mockImplementation(async () => ({ id: `mock_dm_ad_${generateUuid().slice(0, 8)}` })),
  }
  metaMocks = mocks
  return mocks
})

let app

function tagError(message, httpStatus) {
  const err = new Error(message)
  err.metaHttpStatus = httpStatus
  err.metaAmbiguous = httpStatus == null
  return err
}

async function cleanup() {
  await query('SET FOREIGN_KEY_CHECKS = 0')
  await query('DELETE FROM campaign_jobs')
  await query('DELETE FROM meta_webhook_events')
  await query('DELETE FROM meta_sync_state')
  await query('DELETE FROM post_boost_targets')
  await query('DELETE FROM promotion_targets')
  await query('DELETE FROM promotions')
  await query('DELETE FROM post_targets')
  await query("DELETE r FROM post_publisher_requests r JOIN posts p ON p.id = r.post_id WHERE p.name LIKE 'DelMon %'")
  await query("DELETE FROM posts WHERE name LIKE 'DelMon %'")
  await query("DELETE FROM user_platform_accounts WHERE platform_username LIKE 'dm\\_%'")
  await query('SET FOREIGN_KEY_CHECKS = 1')
}

async function insertAccount(userId, platform, slug) {
  const platformRow = await queryOne('SELECT id FROM platforms WHERE code = ?', [platform])
  const platformUserId = `dm_${slug}_${generateUuid().replace(/[^a-z0-9]/gi, '').slice(-8)}`
  const accountId = generateUuid()
  await query(
    `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id, platform_username, platform_display_name, token_type, access_token, token_expires_at, verification_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'page', ?, DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
    [uuidToBuffer(accountId), uuidToBuffer(userId), platformRow.id, `https://fb.com/${platformUserId}`, platformUserId, platformUserId, `Display ${platformUserId}`, encrypt('mock_page_token')]
  )
  return { accountId, platformUserId }
}

async function insertPost(userId, name, type = 'post') {
  const postId = generateUuid()
  await query(
    `INSERT INTO posts (id, client_id, name, type, status, boost_enabled, caption, media_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'completed', 0, 'caption', 'https://example.com/img.jpg', NOW(), NOW())`,
    [uuidToBuffer(postId), uuidToBuffer(userId), name, type]
  )
  return postId
}

async function insertTarget(postId, accountId, { targetType = 'client', metaObjectId = null, postedAtExpr = 'NOW()' } = {}) {
  const targetId = generateUuid()
  const objectId = metaObjectId || `dm_obj_${generateUuid().replace(/[^a-z0-9]/gi, '').slice(-12)}`
  await query(
    `INSERT INTO post_targets (id, post_id, platform_account_id, target_type, status, publish_state, meta_object_id, posted_at, created_at)
     VALUES (?, ?, ?, ?, 'posted', 'published', ?, ${postedAtExpr}, NOW())`,
    [uuidToBuffer(targetId), uuidToBuffer(postId), uuidToBuffer(accountId), targetType, objectId]
  )
  return { targetId, objectId }
}

async function insertRequest(postId, publisherId, { coinsOffered = 100, status = 'published', accountId = null } = {}) {
  const requestId = generateUuid()
  await query(
    `INSERT INTO post_publisher_requests (id, post_id, publisher_id, platform_account_id, coins_offered, status, published_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())`,
    [uuidToBuffer(requestId), uuidToBuffer(postId), uuidToBuffer(publisherId), accountId ? uuidToBuffer(accountId) : null, coinsOffered, status]
  )
  return requestId
}

async function insertActivePromotion(postId, userId, targetId, accountId, { budgetAmount = 500, charged = true, campaignId = null, adId = null } = {}) {
  // promotions are UNIQUE(post_id) — reuse the post's promotion for siblings
  const existing = await promoRepo.findPromotionByPostId(postId)
  let promotionId
  if (existing) {
    promotionId = existing.id
  } else {
    promotionId = generateUuid()
    await promoRepo.createPromotion(promotionId, postId, userId, { status: 'active', budgetType: 'daily', budgetAmount })
    if (charged) {
      // charge exactly one per-target share so consume/refund math is exact
      // regardless of the configured coin rate
      const { getCoinConversionRate } = await import('../../src/modules/campaigns/campaign.service.js')
      const rate = await getCoinConversionRate()
      await promoRepo.updatePromotion(promotionId, { chargedPaise: Math.round(budgetAmount * rate * 100) })
    }
  }
  const ptgtId = generateUuid()
  await promoRepo.createPromotionTarget(ptgtId, promotionId, targetId, 'facebook', accountId)
  await promoRepo.updatePromotionTarget(ptgtId, {
    status: 'active',
    platformCampaignId: campaignId || `dm_camp_${generateUuid().replace(/[^a-z0-9]/gi, '').slice(-12)}`,
    platformAdId: adId || `dm_ad_${generateUuid().replace(/[^a-z0-9]/gi, '').slice(-12)}`,
  })
  const ptgt = await promoRepo.findPromotionTargetById(ptgtId)
  return { promotionId, ptgtId, ptgt }
}

async function insertLegacyBoost(postId, targetId, userId) {
  const campId = `dm_lcamp_${generateUuid().replace(/[^a-z0-9]/gi, '').slice(-12)}`
  const adId = `dm_lad_${generateUuid().replace(/[^a-z0-9]/gi, '').slice(-12)}`
  await postRepo.createPostBoostTarget(postId, targetId, { objectType: 'facebook_campaign', objectId: campId, status: 'ACTIVE', boostStatus: 'active', createdForUserId: userId })
  await postRepo.createPostBoostTarget(postId, targetId, { objectType: 'ad', objectId: adId, status: 'ACTIVE', boostStatus: 'active', createdForUserId: userId })
  return { campId, adId }
}

async function grantCoins(userId, amount) {
  await query('INSERT INTO user_wallets (user_id, coins) VALUES (?, ?) ON DUPLICATE KEY UPDATE coins = coins + VALUES(coins)', [uuidToBuffer(userId), amount])
}

async function walletCoins(userId) {
  const row = await queryOne('SELECT coins FROM user_wallets WHERE user_id = ?', [uuidToBuffer(userId)])
  return row ? Number(row.coins) : 0
}

async function totalAvailable(userId) {
  const { clearCache } = await import('../../src/modules/subscriptions/subscription.service.js')
  clearCache(userId)
  const coinService = await import('../../shared/services/coin.service.js')
  return (await coinService.getAvailable(userId)).total
}

async function flagAndConfirm(targetId, reason = 'Post not found on facebook (deleted)') {
  await deletionService.handleRemoteContentSignal({ postTargetId: targetId, remoteState: 'missing', source: 'poll', reason })
  await query('UPDATE post_targets SET deletion_flagged_at = DATE_SUB(NOW(), INTERVAL 49 HOUR) WHERE id = ?', [uuidToBuffer(targetId)])
  return deletionService.handleRemoteContentSignal({ postTargetId: targetId, remoteState: 'missing', source: 'poll', reason })
}

function code10Probe() {
  const err = new Error('Graph API GET x failed: {"error":{"message":"(#10) Object does not exist, cannot be loaded due to missing permission or reviewable feature","code":10,"error_subcode":0,"type":"OAuthException"}}')
  err.metaHttpStatus = 400
  err.metaErrorCode = 10
  return { state: 'unknown', detail: String(err.message).slice(0, 240), permissionAmbiguous: true, error: err }
}

function feedEvent(pageId, postId, { item = 'photo', verb = 'remove', reactionType = null, published = null } = {}) {
  const value = {
    from: { id: `user_${generateUuid().substring(0, 8)}`, name: 'Test User' },
    post_id: postId,
    item,
    verb,
    created_time: Math.floor(Date.now() / 1000),
  }
  if (reactionType) value.reaction_type = reactionType
  if (published !== null) value.published = published
  return {
    object: 'page',
    entry: [{
      id: pageId,
      time: Math.floor(Date.now() / 1000),
      changes: [{ field: 'feed', value }],
    }],
  }
}

beforeAll(async () => {
  process.env.META_SYSTEM_USER_TOKEN = 'test_system_user_token'
  process.env.META_AD_ACCOUNT_ID = 'act_test_account'
  const mod = await import('../../app.js')
  app = mod.default
  await cleanup()
})

beforeEach(async () => {
  await cleanup()
  for (const fn of ['getObjectRemoteState', 'getPageRemoteState', 'updateAdStatus', 'deleteAdCampaign', 'deleteAdSet', 'deleteAdCreative', 'deleteAd', 'getPostPromotability', 'getInstagramBoostEligibility', 'createAdCampaign', 'createAdSet', 'createAdCreativeFromPost', 'createAd']) {
    metaMocks[fn].mockClear()
  }
  metaMocks.getObjectRemoteState.mockResolvedValue({ state: 'visible' })
  metaMocks.getPageRemoteState.mockResolvedValue({ state: 'visible' })
  metaMocks.updateAdStatus.mockResolvedValue({ success: true })
  metaMocks.deleteAdCampaign.mockResolvedValue({ success: true })
  metaMocks.deleteAdSet.mockResolvedValue({ success: true })
  metaMocks.deleteAdCreative.mockResolvedValue({ success: true })
  metaMocks.deleteAd.mockResolvedValue({ success: true })
})

afterAll(async () => {
  await cleanup()
})

describe('remote-state classifier (strict)', () => {
  it('missing on HTTP 404', () => {
    expect(classifyRemoteStateError(tagError('Graph API GET x failed: nope', 404)).state).toBe('missing')
  })
  it('missing on code 100 + subcode 33', () => {
    const err = tagError('Graph API GET x failed: {"error":{"code":100,"error_subcode":33}}', 400)
    expect(classifyRemoteStateError(err).state).toBe('missing')
  })
  it('missing on code 100 + documented message patterns', () => {
    expect(classifyRemoteStateError(tagError('Graph API GET x failed: {"error":{"code":100,"message":"post does not exist"}}', 400)).state).toBe('missing')
    expect(classifyRemoteStateError(tagError('Graph API GET x failed: {"error":{"code":100,"message":"this object has been deleted"}}', 400)).state).toBe('missing')
  })
  it('unknown on code 100 + "nonexisting field" (field-level error, not deletion)', () => {
    expect(classifyRemoteStateError(tagError('Graph API GET x failed: {"error":{"code":100,"message":"(#100) Tried accessing nonexisting field (is_hidden)"}}', 400)).state).toBe('unknown')
    expect(classifyRemoteStateError(tagError('Graph API GET x failed: {"error":{"code":100,"message":"(#100) Tried accessing nonexisting field"}}', 400)).state).toBe('unknown')
  })
  it('code-less deletion-worded messages are UNKNOWN (regex gated on code 100 — code 10 says "does not exist" too)', () => {
    expect(classifyRemoteStateError(tagError('post does not exist', 400)).state).toBe('unknown')
    expect(classifyRemoteStateError(tagError('(#100) Tried accessing nonexisting field', 400)).state).toBe('unknown')
    expect(classifyRemoteStateError(tagError('this object has been deleted', 400)).state).toBe('unknown')
  })
  it('unknown on permission failures', () => {
    expect(classifyRemoteStateError(tagError('failed: {"error":{"code":200,"error_subcode":123}}', 400)).state).toBe('unknown')
    expect(classifyRemoteStateError(tagError('failed: {"error":{"code":10,"error_subcode":123}}', 400)).state).toBe('unknown')
  })
  it('unknown on session invalidation', () => {
    expect(classifyRemoteStateError(tagError('failed: {"error":{"code":190,"error_subcode":460}}', 400)).state).toBe('unknown')
  })
  it('unknown on rate limits', () => {
    expect(classifyRemoteStateError(tagError('failed: {"error":{"code":80004,"error_subcode":1}}', 429)).state).toBe('unknown')
    expect(classifyRemoteStateError(tagError('failed: {"error":{"code":613,"error_subcode":1}}', 400)).state).toBe('unknown')
    expect(classifyRemoteStateError(tagError('throttled', 429)).state).toBe('unknown')
  })
  it('unknown on timeouts / ambiguous failures', () => {
    expect(classifyRemoteStateError(tagError('socket hangup', null)).state).toBe('unknown')
    expect(classifyRemoteStateError(tagError('unparseable garbage', 500)).state).toBe('unknown')
  })
})

describe('remote-state classifier evidence chain (code 10 — live-proven deleted-object response)', () => {
  const DELETED_MSG = 'Graph API GET x failed: {"error":{"message":"(#10) Object does not exist, cannot be loaded due to missing permission or reviewable feature, or does not support this operation. This endpoint requires the \'pages_read_engagement\' permission or the \'Page Public Content Access\' feature.","code":10,"error_subcode":0,"type":"OAuthException"}}'
  const FULL_CTX = { ownerTokenUsed: true, tokenHealthy: true, hasVerifiedBaseline: true, tokenKeyMatches: true }

  it('full evidence: owner token + healthy page + verified baseline + key match → MISSING', () => {
    const out = classifyRemoteStateError(tagError(DELETED_MSG, 400), FULL_CTX)
    expect(out.state).toBe('missing')
    expect(out.evidence).toBe('owner_token_page_health_verified_baseline')
  })
  it('no token-health proof → permissionAmbiguous UNKNOWN (error attached for re-classification)', () => {
    const out = classifyRemoteStateError(tagError(DELETED_MSG, 400), { ...FULL_CTX, tokenHealthy: false })
    expect(out.state).toBe('unknown')
    expect(out.permissionAmbiguous).toBe(true)
    expect(out.error).toBeInstanceOf(Error)
  })
  it('no verified baseline (never verified) → UNKNOWN even with healthy token', () => {
    expect(classifyRemoteStateError(tagError(DELETED_MSG, 400), { ...FULL_CTX, hasVerifiedBaseline: false }).state).toBe('unknown')
  })
  it('token key mismatch (rotated token) → UNKNOWN', () => {
    expect(classifyRemoteStateError(tagError(DELETED_MSG, 400), { ...FULL_CTX, tokenKeyMatches: false }).state).toBe('unknown')
  })
  it('non-owner token (IG/system-token probe) → UNKNOWN', () => {
    expect(classifyRemoteStateError(tagError(DELETED_MSG, 400), { ...FULL_CTX, ownerTokenUsed: false }).state).toBe('unknown')
  })
  it('empty context → permissionAmbiguous UNKNOWN', () => {
    const out = classifyRemoteStateError(tagError(DELETED_MSG, 400))
    expect(out.state).toBe('unknown')
    expect(out.permissionAmbiguous).toBe(true)
  })
})

describe('poller detection pipeline', () => {
  it('FB missing flags the candidate and pauses the active boost', async () => {
    const user = await createTestUser({ email: `dm1-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon fb-missing ${Date.now()}`)
    const { targetId, objectId } = await insertTarget(postId, accountId)
    const { ptgt, ptgtId } = await insertActivePromotion(postId, user.id, targetId, accountId)

    metaMocks.getObjectRemoteState.mockImplementation(async (id) => (id === objectId ? { state: 'missing', detail: 'does not exist' } : { state: 'visible' }))
    const outcome = await deletionService.runRemoteHealthJob()

    expect(outcome.flagged).toBe(1)
    const row = await queryOne('SELECT remote_content_state, deletion_review_state, boost_paused_by_deletion, meta_deleted_at FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(row.remote_content_state).toBe('missing')
    expect(row.deletion_review_state).toBe('flagged')
    expect(Number(row.boost_paused_by_deletion)).toBe(1)
    expect(row.meta_deleted_at).toBeNull()
    expect(metaMocks.updateAdStatus).toHaveBeenCalledWith(ptgt.platformCampaignId, 'PAUSED', expect.anything())
    const after = await promoRepo.findPromotionTargetById(ptgtId)
    expect(after.status).toBe('paused')
  })

  it('IG missing flags only the IG target (FB sibling untouched, post intact)', async () => {
    const user = await createTestUser({ email: `dm2-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const fb = await insertAccount(user.id, 'facebook', 'page')
    const ig = await insertAccount(user.id, 'instagram', 'ig')
    const postId = await insertPost(user.id, `DelMon isolation ${Date.now()}`)
    const fbT = await insertTarget(postId, fb.accountId, { metaObjectId: `${fb.platformUserId}_881234567890123` })
    const igT = await insertTarget(postId, ig.accountId)

    metaMocks.getObjectRemoteState.mockImplementation(async (id) => (id === igT.objectId ? { state: 'missing' } : { state: 'visible' }))
    await deletionService.runRemoteHealthJob()

    const igRow = await queryOne('SELECT deletion_review_state FROM post_targets WHERE id = ?', [uuidToBuffer(igT.targetId)])
    const fbRow = await queryOne('SELECT deletion_review_state, remote_content_state FROM post_targets WHERE id = ?', [uuidToBuffer(fbT.targetId)])
    expect(igRow.deletion_review_state).toBe('flagged')
    expect(fbRow.deletion_review_state).toBe('none')
    expect(fbRow.remote_content_state).toBe('visible')
    const post = await postRepo.findPostById(postId)
    expect(post.status).toBe('completed')
  })

  it('unknown observations stamp checks but never flag', async () => {
    const user = await createTestUser({ email: `dm3-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon unknown ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId)

    metaMocks.getObjectRemoteState.mockResolvedValue({ state: 'unknown', detail: 'session invalidated' })
    await deletionService.runRemoteHealthJob()

    const row = await queryOne('SELECT deletion_review_state, remote_content_state, remote_state_checked_at FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(row.deletion_review_state).toBe('none')
    expect(row.remote_content_state).toBe('unknown')
    expect(row.remote_state_checked_at).not.toBeNull()
    expect(metaMocks.updateAdStatus).not.toHaveBeenCalled()
  })

  it('hidden marks reversible state without flagging or meta_deleted_at', async () => {
    const user = await createTestUser({ email: `dm4-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon hidden ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId)

    const outcome = await deletionService.handleRemoteContentSignal({ postTargetId: targetId, remoteState: 'hidden', source: 'webhook' })
    expect(outcome.hidden).toBe(true)
    const row = await queryOne('SELECT deletion_review_state, remote_content_state, meta_deleted_at FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(row.deletion_review_state).toBe('none')
    expect(row.remote_content_state).toBe('hidden')
    expect(row.meta_deleted_at).toBeNull()
  })

  it('expired monitoring window excludes old targets', async () => {
    const user = await createTestUser({ email: `dm5-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon window ${Date.now()}`)
    await insertTarget(postId, accountId, { postedAtExpr: 'DATE_SUB(NOW(), INTERVAL 31 DAY)' })

    const due = await dmRepo.findRemoteHealthDueTargets({ checkSeconds: 21600, graceSeconds: 172800, monitorDays: 30, limit: 100 })
    expect(due.map(d => d.postId)).not.toContain(postId)
  })

  it('confirmed targets never poll again', async () => {
    const user = await createTestUser({ email: `dm6-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon nodue ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId)
    await flagAndConfirm(targetId)

    const due = await dmRepo.findRemoteHealthDueTargets({ checkSeconds: 21600, graceSeconds: 172800, monitorDays: 30, limit: 100 })
    expect(due.map(d => d.postTargetId)).not.toContain(targetId)
  })
})

describe('poller evidence chain (code 10 + owner token + page-health control)', () => {
  it('code 10 under owner token with verified baseline + healthy page flags the candidate (live-probe scenario)', async () => {
    const user = await createTestUser({ email: `dm20-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon code10 ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId)
    const { ptgt, ptgtId } = await insertActivePromotion(postId, user.id, targetId, accountId)
    // baseline: a visible poll arms verified_at + token key
    metaMocks.getObjectRemoteState.mockResolvedValue({ state: 'visible' })
    await deletionService.runRemoteHealthJob()
    await query('UPDATE post_targets SET remote_state_checked_at = DATE_SUB(NOW(), INTERVAL 7 HOUR) WHERE id = ?', [uuidToBuffer(targetId)])

    metaMocks.getObjectRemoteState.mockImplementation(async () => {
      const err = new Error('Graph API GET x failed: {"error":{"message":"(#10) Object does not exist, cannot be loaded due to missing permission or reviewable feature","code":10,"error_subcode":0,"type":"OAuthException"}}')
      err.metaHttpStatus = 400
      err.metaErrorCode = 10
      return { state: 'unknown', detail: String(err.message).slice(0, 240), permissionAmbiguous: true, error: err }
    })
    const outcome = await deletionService.runRemoteHealthJob()

    expect(outcome.flagged).toBe(1)
    expect(metaMocks.getPageRemoteState).toHaveBeenCalled()
    const row = await queryOne('SELECT remote_content_state, deletion_review_state, boost_paused_by_deletion FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(row.remote_content_state).toBe('missing')
    expect(row.deletion_review_state).toBe('flagged')
    expect(Number(row.boost_paused_by_deletion)).toBe(1)
    expect(metaMocks.updateAdStatus).toHaveBeenCalledWith(ptgt.platformCampaignId, 'PAUSED', expect.anything())
    expect((await promoRepo.findPromotionTargetById(ptgtId)).status).toBe('paused')
  })

  it('code 10 with page node ALSO failing stays UNKNOWN — evidence baseline survives', async () => {
    const user = await createTestUser({ email: `dm21-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon pagefail ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId)
    metaMocks.getObjectRemoteState.mockResolvedValue({ state: 'visible' })
    await deletionService.runRemoteHealthJob()
    await query('UPDATE post_targets SET remote_state_checked_at = DATE_SUB(NOW(), INTERVAL 7 HOUR) WHERE id = ?', [uuidToBuffer(targetId)])

    const ambiguous = { state: 'unknown', detail: 'code 10', permissionAmbiguous: true, error: new Error('code 10') }
    metaMocks.getObjectRemoteState.mockResolvedValue(ambiguous)
    metaMocks.getPageRemoteState.mockResolvedValue({ state: 'unknown', detail: 'page token broken too' })
    const outcome = await deletionService.runRemoteHealthJob()

    expect(outcome.unknown).toBe(1)
    expect(outcome.flagged || 0).toBe(0)
    const row = await queryOne('SELECT remote_content_state, deletion_review_state, remote_verified_at FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(row.remote_content_state).toBe('unknown')
    expect(row.deletion_review_state).toBe('none')
    expect(row.remote_verified_at).not.toBeNull()
  })

  it('code 10 without a verified baseline stays UNKNOWN (deleted-before-first-verification closed by 079 backfill)', async () => {
    const user = await createTestUser({ email: `dm22-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon nobaseline ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId)
    await query('UPDATE post_targets SET remote_verified_at = NULL WHERE id = ?', [uuidToBuffer(targetId)])

    const ambiguous = { state: 'unknown', detail: 'code 10', permissionAmbiguous: true, error: new Error('code 10') }
    metaMocks.getObjectRemoteState.mockResolvedValue(ambiguous)
    const outcome = await deletionService.runRemoteHealthJob()

    expect(outcome.unknown).toBe(1)
    expect(outcome.flagged || 0).toBe(0)
    const row = await queryOne('SELECT deletion_review_state FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(row.deletion_review_state).toBe('none')
  })

  it('IG (system-token) code 10 stays UNKNOWN — no page-health path for IG probes', async () => {
    const user = await createTestUser({ email: `dm23-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const ig = await insertAccount(user.id, 'instagram', 'ig')
    const postId = await insertPost(user.id, `DelMon ig10 ${Date.now()}`)
    const { targetId } = await insertTarget(postId, ig.accountId)

    const ambiguous = { state: 'unknown', detail: 'code 10', permissionAmbiguous: true, error: new Error('code 10') }
    metaMocks.getObjectRemoteState.mockResolvedValue(ambiguous)
    const outcome = await deletionService.runRemoteHealthJob()

    expect(metaMocks.getPageRemoteState).not.toHaveBeenCalled()
    expect(outcome.unknown).toBe(1)
    const row = await queryOne('SELECT deletion_review_state FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(row.deletion_review_state).toBe('none')
  })

  it('token rotation disarms code-10 evidence until re-verified under the new token', async () => {
    const user = await createTestUser({ email: `dm24-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon rotate ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId)
    const { tokenKeyFor } = await import('../../shared/services/meta-rate-limiter.js')

    // 1. visible under token A arms the key
    metaMocks.getObjectRemoteState.mockResolvedValue({ state: 'visible' })
    await deletionService.runRemoteHealthJob()
    const armed = await queryOne('SELECT remote_token_key, remote_verified_at FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(armed.remote_token_key).toBe(tokenKeyFor('mock_page_token'))
    expect(armed.remote_verified_at).not.toBeNull()

    // 2. token rotated (simulate: armed key no longer matches) — code 10 disarmed
    await query('UPDATE post_targets SET remote_token_key = ?, remote_state_checked_at = DATE_SUB(NOW(), INTERVAL 7 HOUR) WHERE id = ?', ['stale_key_value', uuidToBuffer(targetId)])
    metaMocks.getObjectRemoteState.mockImplementation(async () => code10Probe())
    let outcome = await deletionService.runRemoteHealthJob()
    expect(outcome.unknown).toBe(1)
    expect(outcome.flagged || 0).toBe(0)

    // 3. visible under the new token re-arms with the current key
    await query('UPDATE post_targets SET remote_state_checked_at = DATE_SUB(NOW(), INTERVAL 7 HOUR) WHERE id = ?', [uuidToBuffer(targetId)])
    metaMocks.getObjectRemoteState.mockResolvedValue({ state: 'visible' })
    await deletionService.runRemoteHealthJob()
    const rearmed = await queryOne('SELECT remote_token_key FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(rearmed.remote_token_key).toBe(tokenKeyFor('mock_page_token'))

    // 4. code 10 under the now-matching key + healthy page → flagged
    await query('UPDATE post_targets SET remote_state_checked_at = DATE_SUB(NOW(), INTERVAL 7 HOUR) WHERE id = ?', [uuidToBuffer(targetId)])
    metaMocks.getObjectRemoteState.mockImplementation(async () => code10Probe())
    outcome = await deletionService.runRemoteHealthJob()
    expect(outcome.flagged).toBe(1)
    const row = await queryOne('SELECT deletion_review_state FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(row.deletion_review_state).toBe('flagged')
  })

  it('visible poll stamps verified_at + token key; UNKNOWN poll preserves both', async () => {
    const user = await createTestUser({ email: `dm25-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon stamps ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId)
    const { tokenKeyFor } = await import('../../shared/services/meta-rate-limiter.js')

    metaMocks.getObjectRemoteState.mockResolvedValue({ state: 'visible' })
    await deletionService.runRemoteHealthJob()
    const vis = await queryOne('SELECT remote_token_key, remote_verified_at FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(vis.remote_token_key).toBe(tokenKeyFor('mock_page_token'))
    expect(vis.remote_verified_at).not.toBeNull()

    await query('UPDATE post_targets SET remote_state_checked_at = DATE_SUB(NOW(), INTERVAL 7 HOUR) WHERE id = ?', [uuidToBuffer(targetId)])
    metaMocks.getObjectRemoteState.mockResolvedValue({ state: 'unknown', detail: 'session invalidated' })
    await deletionService.runRemoteHealthJob()
    const unk = await queryOne('SELECT remote_token_key, remote_verified_at, remote_content_state FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(unk.remote_content_state).toBe('unknown')
    expect(unk.remote_token_key).toBe(tokenKeyFor('mock_page_token'))
    expect(unk.remote_verified_at).not.toBeNull()
  })

  it('targeted mode (payload.targetId) probes exactly the requested target and skips ineligible ones', async () => {
    const user = await createTestUser({ email: `dm26-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const siblingAcct = await insertAccount(user.id, 'facebook', 'page2')
    const postId = await insertPost(user.id, `DelMon targeted ${Date.now()}`)
    const { targetId, objectId } = await insertTarget(postId, accountId)
    const sibling = await insertTarget(postId, siblingAcct.accountId)
    metaMocks.getObjectRemoteState.mockResolvedValue({ state: 'visible' })
    await deletionService.runRemoteHealthJob() // arm both baselines

    metaMocks.getObjectRemoteState.mockImplementation(async (id) => (id === objectId ? { state: 'missing', detail: 'gone' } : { state: 'visible' }))
    const outcome = await deletionService.runRemoteHealthJob({ targetId })

    expect(outcome.checked).toBe(1)
    expect(outcome.flagged).toBe(1)
    const flaggedRow = await queryOne('SELECT deletion_review_state FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(flaggedRow.deletion_review_state).toBe('flagged')
    const siblingRow = await queryOne('SELECT deletion_review_state FROM post_targets WHERE id = ?', [uuidToBuffer(sibling.targetId)])
    expect(siblingRow.deletion_review_state).toBe('none')
  })

  it('long code-10 reasons are truncated to the 255-char column (live regression: Data too long)', async () => {
    const user = await createTestUser({ email: `dm31-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon truncate ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId)

    const longReason = `Post not found on facebook (${'x'.repeat(400)})`
    const outcome = await deletionService.handleRemoteContentSignal({ postTargetId: targetId, remoteState: 'missing', source: 'poll', reason: longReason })
    expect(outcome.flagged).toBe(true)
    const row = await queryOne('SELECT deletion_reason, CHAR_LENGTH(deletion_reason) AS len FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(Number(row.len)).toBeLessThanOrEqual(255)
    expect(row.deletion_reason).toBe(longReason.slice(0, 250))

    await query('UPDATE post_targets SET deletion_flagged_at = DATE_SUB(NOW(), INTERVAL 49 HOUR) WHERE id = ?', [uuidToBuffer(targetId)])
    const confirmed = await deletionService.handleRemoteContentSignal({ postTargetId: targetId, remoteState: 'missing', source: 'poll', reason: longReason })
    expect(confirmed.confirmed).toBe(true)
  })

  it('targeted fetch excludes stories, confirmed targets, and meta-deleted targets', async () => {
    const user = await createTestUser({ email: `dm27-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const storyPost = await insertPost(user.id, `DelMon tgtstory ${Date.now()}`, 'story')
    const { targetId: storyT } = await insertTarget(storyPost, accountId)
    const postId = await insertPost(user.id, `DelMon tgtterm ${Date.now()}`)
    const { targetId: confirmedT } = await insertTarget(postId, accountId)
    await flagAndConfirm(confirmedT)
    const postId2 = await insertPost(user.id, `DelMon tgtmeta ${Date.now()}`)
    const { targetId: metaDelT } = await insertTarget(postId2, accountId)
    await query('UPDATE post_targets SET meta_deleted_at = NOW() WHERE id = ?', [uuidToBuffer(metaDelT)])

    expect(await dmRepo.findRemoteHealthTargetById(storyT)).toBeNull()
    expect(await dmRepo.findRemoteHealthTargetById(confirmedT)).toBeNull()
    expect(await dmRepo.findRemoteHealthTargetById(metaDelT)).toBeNull()
  })
})

describe('grace recovery and confirmation', () => {
  it('candidate recovers during grace: flag cleared, boost resumed', async () => {
    const user = await createTestUser({ email: `dm7-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon recover ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId)
    const { ptgt, ptgtId } = await insertActivePromotion(postId, user.id, targetId, accountId)

    metaMocks.getObjectRemoteState.mockResolvedValue({ state: 'missing' })
    await deletionService.runRemoteHealthJob()
    expect((await promoRepo.findPromotionTargetById(ptgtId)).status).toBe('paused')

    metaMocks.getObjectRemoteState.mockResolvedValue({ state: 'visible' })
    const outcome = await deletionService.handleRemoteContentSignal({ postTargetId: targetId, remoteState: 'visible', source: 'poll' })
    expect(outcome.recovered).toBe(true)
    expect(outcome.resumed).toBe(true)
    const row = await queryOne('SELECT deletion_review_state, remote_content_state, boost_paused_by_deletion FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(row.deletion_review_state).toBe('none')
    expect(row.remote_content_state).toBe('visible')
    expect(Number(row.boost_paused_by_deletion)).toBe(0)
    expect(metaMocks.updateAdStatus).toHaveBeenCalledWith(ptgt.platformCampaignId, 'ACTIVE', expect.anything())
    expect((await promoRepo.findPromotionTargetById(ptgtId)).status).toBe('active')
  })

  it('client-paused boost is never resumed by the deletion system', async () => {
    const user = await createTestUser({ email: `dm8-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon clientpaused ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId)
    const { ptgt, ptgtId } = await insertActivePromotion(postId, user.id, targetId, accountId)
    // client paused it in Ads Manager first (no deletion flag set by us)
    await promoRepo.updatePromotionTarget(ptgtId, { status: 'paused' })

    await deletionService.handleRemoteContentSignal({ postTargetId: targetId, remoteState: 'missing', source: 'poll', reason: 'gone' })
    const flagged = await queryOne('SELECT boost_paused_by_deletion FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(Number(flagged.boost_paused_by_deletion)).toBe(0)
    expect(metaMocks.updateAdStatus).not.toHaveBeenCalled()

    const outcome = await deletionService.handleRemoteContentSignal({ postTargetId: targetId, remoteState: 'visible', source: 'poll' })
    expect(outcome.recovered).toBe(true)
    expect(outcome.resumed).toBe(false)
    expect((await promoRepo.findPromotionTargetById(ptgtId)).status).toBe('paused')
  })

  it('failed boosts are never resurrected on recovery', async () => {
    const user = await createTestUser({ email: `dm9-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon failedstay ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId)
    const { ptgtId } = await insertActivePromotion(postId, user.id, targetId, accountId)
    await promoRepo.updatePromotionTarget(ptgtId, { status: 'failed', error: 'earlier failure' })
    await postRepo.updatePostTargetStatus(targetId, { remoteContentState: 'missing', deletionReviewState: 'flagged', deletionFlaggedAt: new Date().toISOString().slice(0, 19).replace('T', ' '), boostPausedByDeletion: true })

    const outcome = await deletionService.handleRemoteContentSignal({ postTargetId: targetId, remoteState: 'visible', source: 'poll' })
    expect(outcome.recovered).toBe(true)
    expect(outcome.resumed).toBe(false)
    expect((await promoRepo.findPromotionTargetById(ptgtId)).status).toBe('failed')
  })

  it('second missing after grace confirms: terminal + single enforcement', async () => {
    const publisher = await createTestUser({ email: `dm10p-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 0 })
    const user = await createTestUser({ email: `dm10-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon confirm ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId, { targetType: 'publisher' })
    const requestId = await insertRequest(postId, publisher.id, { accountId })
    await query('UPDATE post_targets SET publisher_request_id = ? WHERE id = ?', [uuidToBuffer(requestId), uuidToBuffer(targetId)])
    await insertActivePromotion(postId, user.id, targetId, accountId)

    const outcome = await flagAndConfirm(targetId)
    expect(outcome.confirmed).toBe(true)
    const row = await queryOne('SELECT deletion_review_state, remote_content_state, meta_deleted_at, deletion_confirmed_at, violation_counted FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(row.deletion_review_state).toBe('confirmed')
    expect(row.remote_content_state).toBe('missing')
    expect(row.meta_deleted_at).not.toBeNull()
    expect(row.deletion_confirmed_at).not.toBeNull()
    expect(Number(row.violation_counted)).toBe(1)
    const req = await queryOne('SELECT violation_count FROM post_publisher_requests WHERE id = ?', [uuidToBuffer(requestId)])
    expect(Number(req.violation_count)).toBe(1)

    // repeat signals are terminal no-ops (single enforcement)
    const second = await deletionService.handleRemoteContentSignal({ postTargetId: targetId, remoteState: 'missing', source: 'poll' })
    expect(second.ignored).toBe(true)
    const req2 = await queryOne('SELECT violation_count FROM post_publisher_requests WHERE id = ?', [uuidToBuffer(requestId)])
    expect(Number(req2.violation_count)).toBe(1)
    const logs = await query('SELECT COUNT(*) AS n FROM post_review_log WHERE post_id = ? AND notes LIKE ?', [uuidToBuffer(postId), '%ublisher deleted the post%'])
    expect(Number(logs[0].n)).toBe(1)
  })

  it('concurrent confirmations converge on a single enforcement', async () => {
    const publisher = await createTestUser({ email: `dm10c-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 0 })
    const user = await createTestUser({ email: `dm10d-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon concurr ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId, { targetType: 'publisher' })
    const requestId = await insertRequest(postId, publisher.id, { accountId })
    await query('UPDATE post_targets SET publisher_request_id = ? WHERE id = ?', [uuidToBuffer(requestId), uuidToBuffer(targetId)])
    await deletionService.handleRemoteContentSignal({ postTargetId: targetId, remoteState: 'missing', source: 'poll', reason: 'gone' })
    await query('UPDATE post_targets SET deletion_flagged_at = DATE_SUB(NOW(), INTERVAL 49 HOUR) WHERE id = ?', [uuidToBuffer(targetId)])

    const results = await Promise.all([
      deletionService.handleRemoteContentSignal({ postTargetId: targetId, remoteState: 'missing', source: 'poll', reason: 'gone' }),
      deletionService.handleRemoteContentSignal({ postTargetId: targetId, remoteState: 'missing', source: 'webhook', reason: 'gone' }),
    ])
    expect(results.filter(r => r.confirmed).length).toBe(1)
    const req = await queryOne('SELECT violation_count FROM post_publisher_requests WHERE id = ?', [uuidToBuffer(requestId)])
    expect(Number(req.violation_count)).toBe(1)

    // repo-level guard: two raw concurrent claims converge on one winner
    const postId2 = await insertPost(user.id, `DelMon concurr2 ${Date.now()}`)
    const t2 = await insertTarget(postId2, accountId, { targetType: 'publisher' })
    await dmRepo.flagDeletionCandidate(t2.targetId, { remoteState: 'missing', source: 'poll' })
    const claims = await Promise.all([
      dmRepo.confirmFlaggedDeletion(t2.targetId, 'gone'),
      dmRepo.confirmFlaggedDeletion(t2.targetId, 'gone'),
    ])
    expect(claims.filter(Boolean).length).toBe(1)
  })

  it('confirmed deletion is terminal: late visible never un-terminalizes', async () => {
    const user = await createTestUser({ email: `dm11-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon terminal ${Date.now()}`)
    const { targetId, objectId } = await insertTarget(postId, accountId)
    await flagAndConfirm(targetId)

    const outcome = await deletionService.handleRemoteContentSignal({ postTargetId: targetId, remoteState: 'visible', source: 'poll' })
    expect(outcome.ignored).toBe(true)
    expect(outcome.reason).toBe('terminal')
    const row = await queryOne('SELECT deletion_review_state, remote_content_state, meta_object_id FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(row.deletion_review_state).toBe('confirmed')
    expect(row.remote_content_state).toBe('missing')
    expect(row.meta_object_id).toBe(objectId)
  })

  it('publisher repost with a new Meta ID never restores the target', async () => {
    const user = await createTestUser({ email: `dm12-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const pageId = `dmrepost${Date.now()}`
    const accountId = (await insertAccount(user.id, 'facebook', 'page')).accountId
    await query('UPDATE user_platform_accounts SET platform_user_id = ? WHERE id = ?', [pageId, uuidToBuffer(accountId)])
    const postId = await insertPost(user.id, `DelMon repost ${Date.now()}`)
    const oldObjectId = `${pageId}_881111111111111`
    const { targetId } = await insertTarget(postId, accountId, { metaObjectId: oldObjectId })
    await flagAndConfirm(targetId)

    // the "repost" is a different object id — webhook lookup finds nothing
    await webhookService.processMetaWebhookEvents(feedEvent(pageId, `${pageId}_882222222222222`, { verb: 'add', item: 'photo' }))
    const inbox = await queryOne('SELECT id FROM meta_webhook_events WHERE external_object_id = ?', [`${pageId}_882222222222222`])
    const outcome = await webhookService.processWebhookEventById(inbox.id)
    expect(outcome.ignored).toBe(true)
    expect(outcome.reason).toBe('unknown_target')
    const row = await queryOne('SELECT deletion_review_state, meta_object_id FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(row.deletion_review_state).toBe('confirmed')
    expect(row.meta_object_id).toBe(oldObjectId)
  })
})

describe('campaign-deleted is boost-health only, never a deletion verdict', () => {
  it('Meta campaign DELETED converges boost FAILED without flagging the post', async () => {
    const user = await createTestUser({ email: `dm13-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon campdel ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId)
    const { ptgt, ptgtId } = await insertActivePromotion(postId, user.id, targetId, accountId)

    const { applyBoostMetaStatus } = await import('../../src/modules/posts/boost-performance.service.js')
    const refs = await (await import('../../src/modules/posts/boost-performance.repository.js')).resolveBoostObjectRefs([ptgt.platformCampaignId])
    const outcome = await applyBoostMetaStatus(refs.get(ptgt.platformCampaignId), 'DELETED')
    expect(outcome.applied).toBe(true)
    expect((await promoRepo.findPromotionTargetById(ptgtId)).status).toBe('failed')

    const row = await queryOne('SELECT deletion_review_state, remote_content_state FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(row.deletion_review_state).toBe('none')
    expect(row.remote_content_state).toBe('visible')
  })
})

describe('webhook signals', () => {
  it('feed remove flags the target, keeps compat columns, pauses boost', async () => {
    const user = await createTestUser({ email: `dm14-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId, platformUserId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon webhookdel ${Date.now()}`)
    const objectId = `${platformUserId}_88${Date.now().toString().slice(-13)}`
    const { targetId } = await insertTarget(postId, accountId, { metaObjectId: objectId })
    const { ptgt } = await insertActivePromotion(postId, user.id, targetId, accountId)

    await webhookService.processMetaWebhookEvents(feedEvent(platformUserId, objectId, { verb: 'remove' }))
    const inbox = await queryOne('SELECT id FROM meta_webhook_events WHERE external_object_id = ?', [objectId])
    const outcome = await webhookService.processWebhookEventById(inbox.id)
    expect(outcome.deleted).toBe(true)

    const row = await queryOne('SELECT deletion_review_state, remote_content_state, meta_deleted_at FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(row.deletion_review_state).toBe('flagged')
    expect(row.remote_content_state).toBe('missing')
    expect(row.meta_deleted_at).not.toBeNull()
    expect(metaMocks.updateAdStatus).toHaveBeenCalledWith(ptgt.platformCampaignId, 'PAUSED', expect.anything())
  })

  it('feed hide marks hidden only: no flag, no meta_deleted_at', async () => {
    const user = await createTestUser({ email: `dm15-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId, platformUserId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon webhookhide ${Date.now()}`)
    const objectId = `${platformUserId}_88${Date.now().toString().slice(-13)}`
    const { targetId } = await insertTarget(postId, accountId, { metaObjectId: objectId })

    await webhookService.processMetaWebhookEvents(feedEvent(platformUserId, objectId, { verb: 'hide', item: 'photo' }))
    const inbox = await queryOne('SELECT id FROM meta_webhook_events WHERE external_object_id = ?', [objectId])
    const outcome = await webhookService.processWebhookEventById(inbox.id)
    expect(outcome.hidden).toBe(true)

    const row = await queryOne('SELECT deletion_review_state, remote_content_state, meta_deleted_at FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(row.deletion_review_state).toBe('none')
    expect(row.remote_content_state).toBe('hidden')
    expect(row.meta_deleted_at).toBeNull()
  })

  it('story targets keep legacy compat columns only, never the review pipeline', async () => {
    const user = await createTestUser({ email: `dm16-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId, platformUserId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon story ${Date.now()}`, 'story')
    const objectId = `${platformUserId}_88${Date.now().toString().slice(-13)}`
    const { targetId } = await insertTarget(postId, accountId, { metaObjectId: objectId })

    await webhookService.processMetaWebhookEvents(feedEvent(platformUserId, objectId, { verb: 'remove' }))
    const inbox = await queryOne('SELECT id FROM meta_webhook_events WHERE external_object_id = ?', [objectId])
    const outcome = await webhookService.processWebhookEventById(inbox.id)
    expect(outcome.deleted).toBe(true)
    expect(outcome.story).toBe(true)

    const row = await queryOne('SELECT deletion_review_state, remote_content_state, meta_deleted_at FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(row.deletion_review_state).toBe('none')
    expect(row.meta_deleted_at).not.toBeNull()
  })

  it('feed verb:edited on a photo (live deletion signal) expedite-enqueues a targeted remote-health recheck', async () => {
    const user = await createTestUser({ email: `dm28-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId, platformUserId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon expedite ${Date.now()}`)
    const objectId = `${platformUserId}_88${Date.now().toString().slice(-13)}`
    const { targetId } = await insertTarget(postId, accountId, { metaObjectId: objectId })

    await webhookService.processMetaWebhookEvents(feedEvent(platformUserId, objectId, { verb: 'edited', item: 'photo', published: 1 }))
    const inbox = await queryOne('SELECT id FROM meta_webhook_events WHERE external_object_id = ?', [objectId])
    const outcome = await webhookService.processWebhookEventById(inbox.id)

    expect(outcome.remoteHealthQueued).toBe(true)
    expect(outcome.engagementRefreshQueued).toBe(true)
    const healthJobs = await query(
      'SELECT run_key FROM campaign_jobs WHERE job_type = ? AND campaign_id = ?',
      ['post_remote_health', uuidToBuffer(postId)]
    )
    expect(healthJobs.length).toBeGreaterThan(0)
    expect(healthJobs.map(j => j.run_key)).toContain(`remote-health:${targetId}`)
    // no review state touched by the event itself — the expedited probe classifies
    const row = await queryOne('SELECT deletion_review_state, remote_content_state FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(row.deletion_review_state).toBe('none')
  })

  it('feed add/update verbs on a post item also expedite the recheck; reaction events never do', async () => {
    const user = await createTestUser({ email: `dm29-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId, platformUserId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon expedite2 ${Date.now()}`)
    const objectId = `${platformUserId}_88${Date.now().toString().slice(-13)}`
    const { targetId } = await insertTarget(postId, accountId, { metaObjectId: objectId })

    await webhookService.processMetaWebhookEvents(feedEvent(platformUserId, objectId, { verb: 'add', item: 'post' }))
    let inbox = await queryOne('SELECT id FROM meta_webhook_events WHERE external_object_id = ?', [objectId])
    const added = await webhookService.processWebhookEventById(inbox.id)
    expect(added.remoteHealthQueued).toBe(true)

    await query('DELETE FROM campaign_jobs WHERE campaign_id = ?', [uuidToBuffer(postId)])
    await webhookService.processMetaWebhookEvents(feedEvent(platformUserId, objectId, { verb: 'add', item: 'reaction', reactionType: 'like' }))
    inbox = await queryOne('SELECT id FROM meta_webhook_events WHERE external_object_id = ? AND id != ?', [objectId, inbox.id])
    const reacted = await webhookService.processWebhookEventById(inbox.id)
    expect(reacted.remoteHealthQueued).toBeUndefined()
    expect(reacted.engagementRefreshQueued).toBe(true)
    const healthJobs = await query('SELECT COUNT(*) AS n FROM campaign_jobs WHERE job_type = ? AND campaign_id = ?', ['post_remote_health', uuidToBuffer(postId)])
    expect(Number(healthJobs[0].n)).toBe(0)
  })

  it('expedited job classifies with full evidence: edited → targeted probe → flagged', async () => {
    const user = await createTestUser({ email: `dm30-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId, platformUserId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon expedite3 ${Date.now()}`)
    const objectId = `${platformUserId}_88${Date.now().toString().slice(-13)}`
    const { targetId } = await insertTarget(postId, accountId, { metaObjectId: objectId })

    // arm the baseline first (publish-backfill + a visible poll)
    metaMocks.getObjectRemoteState.mockResolvedValue({ state: 'visible' })
    await deletionService.runRemoteHealthJob()

    // webhook fires edited → expedited job (drain-run it directly with the payload)
    await webhookService.processMetaWebhookEvents(feedEvent(platformUserId, objectId, { verb: 'edited', item: 'photo' }))
    const inbox = await queryOne('SELECT id FROM meta_webhook_events WHERE external_object_id = ?', [objectId])
    const outcome = await webhookService.processWebhookEventById(inbox.id)
    expect(outcome.remoteHealthQueued).toBe(true)

    metaMocks.getObjectRemoteState.mockImplementation(async () => {
      const err = new Error('Graph API GET x failed: {"error":{"message":"(#10) Object does not exist, cannot be loaded due to missing permission or reviewable feature","code":10,"error_subcode":0,"type":"OAuthException"}}')
      err.metaHttpStatus = 400
      err.metaErrorCode = 10
      return { state: 'unknown', detail: String(err.message).slice(0, 240), permissionAmbiguous: true, error: err }
    })
    const run = await deletionService.runRemoteHealthJob({ targetId })
    expect(run.flagged).toBe(1)
    const row = await queryOne('SELECT deletion_review_state, remote_content_state FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(row.deletion_review_state).toBe('flagged')
    expect(row.remote_content_state).toBe('missing')
  })
})

describe('enforcement: settlement, payout, ownership', () => {
  it('was-active boost settles consumed (no refund) on confirm', async () => {
    const publisher = await createTestUser({ email: `dm17p-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 0 })
    const user = await createTestUser({ email: `dm17-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon consume ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId, { targetType: 'publisher' })
    const requestId = await insertRequest(postId, publisher.id, { accountId })
    await query('UPDATE post_targets SET publisher_request_id = ? WHERE id = ?', [uuidToBuffer(requestId), uuidToBuffer(targetId)])
    const { ptgt, promotionId } = await insertActivePromotion(postId, user.id, targetId, accountId, { budgetAmount: 500 })
    const ownCamp = ptgt.platformCampaignId
    const ownAd = ptgt.platformAdId

    await flagAndConfirm(targetId)

    // scoped cleanup hit only this target's objects
    expect(metaMocks.deleteAdCampaign).toHaveBeenCalledWith(ownCamp, expect.anything())
    expect(metaMocks.deleteAd).toHaveBeenCalledWith(ownAd, expect.anything())
    const after = await promoRepo.findPromotionTargetById(ptgt.id)
    expect(after.status).toBe('failed')
    expect(after.platformCampaignId).toBeNull()
    expect(Number(after.consumedPaise)).toBeGreaterThan(0)
    expect(Number(after.refundedPaise)).toBe(0)
    const entries = await query('SELECT COUNT(*) AS n FROM post_billing_entries WHERE post_id = ? AND kind = ?', [uuidToBuffer(postId), 'refund'])
    expect(Number(entries[0].n)).toBe(0)
    // parity with the disapproved path: a lone failed target does not flip an
    // ACTIVE promotion (pre-existing VALID_PROMOTION_TRANSITIONS guard); the
    // share is stamped consumed so nothing is locked or double-settled
    const promo = await promoRepo.findPromotionById(promotionId)
    expect(promo.status).toBe('active')
  })

  it('never-active boost refunds the share exactly once under concurrency', async () => {
    const user = await createTestUser({ email: `dm18-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon refundonce ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId, { targetType: 'publisher' })
    const promotionId = generateUuid()
    await promoRepo.createPromotion(promotionId, postId, user.id, { status: 'creating', budgetType: 'daily', budgetAmount: 500 })
    await promoRepo.updatePromotion(promotionId, { chargedPaise: 50000 })
    const ptgtId = generateUuid()
    await promoRepo.createPromotionTarget(ptgtId, promotionId, targetId, 'facebook', accountId)

    const [a, b] = await Promise.all([
      promotionService.settleBoostShareForDeletedPostTarget(targetId, 'Publisher deleted the post'),
      promotionService.settleBoostShareForDeletedPostTarget(targetId, 'Publisher deleted the post'),
    ])
    expect(a && b).toBeTruthy()
    const entries = await query('SELECT COUNT(*) AS n FROM post_billing_entries WHERE post_id = ? AND kind = ?', [uuidToBuffer(postId), 'refund'])
    expect(Number(entries[0].n)).toBe(1)
    const after = await promoRepo.findPromotionTargetById(ptgtId)
    expect(Number(after.refundedPaise)).toBeGreaterThan(0)
  })

  it('unpaid payout is blocked after confirm; clean payout still works', async () => {
    const publisher = await createTestUser({ email: `dm19p-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 0 })
    const user = await createTestUser({ email: `dm19-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon payoutblock ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId, { targetType: 'publisher' })
    const requestId = await insertRequest(postId, publisher.id, { coinsOffered: 100, accountId })
    await query('UPDATE post_targets SET publisher_request_id = ? WHERE id = ?', [uuidToBuffer(requestId), uuidToBuffer(targetId)])

    await flagAndConfirm(targetId)
    await expect(postService.completePostPublisherRequest(publisher.id, requestId)).rejects.toThrow('payout blocked')
    expect(await walletCoins(publisher.id)).toBe(0)
    const req = await postRepo.findPostPublisherRequestById(requestId)
    expect(req.payoutStatus).toBe('pending')

    // clean request (no deletion) still pays out
    const postId2 = await insertPost(user.id, `DelMon payoutok ${Date.now()}`)
    const t2 = await insertTarget(postId2, accountId, { targetType: 'publisher' })
    const requestId2 = await insertRequest(postId2, publisher.id, { coinsOffered: 100, accountId })
    await query('UPDATE post_targets SET publisher_request_id = ? WHERE id = ?', [uuidToBuffer(requestId2), uuidToBuffer(t2.targetId)])
    await postService.completePostPublisherRequest(publisher.id, requestId2)
    expect(await walletCoins(publisher.id)).toBe(100)
  })

  it('already-paid payout is unchanged by later deletion (clawback only via admin)', async () => {
    const publisher = await createTestUser({ email: `dm20p-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 0 })
    const user = await createTestUser({ email: `dm20-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon paidstay ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId, { targetType: 'publisher' })
    const requestId = await insertRequest(postId, publisher.id, { coinsOffered: 100, accountId })
    await query('UPDATE post_targets SET publisher_request_id = ? WHERE id = ?', [uuidToBuffer(requestId), uuidToBuffer(targetId)])
    await postService.completePostPublisherRequest(publisher.id, requestId)
    expect(await walletCoins(publisher.id)).toBe(100)

    await flagAndConfirm(targetId)
    expect(await walletCoins(publisher.id)).toBe(100)
    const req = await postRepo.findPostPublisherRequestById(requestId)
    expect(req.payoutStatus).toBe('paid')
  })

  it('client-owned deletion: terminal + settled, zero publisher violation', async () => {
    const user = await createTestUser({ email: `dm21-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon clientdel ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId, { targetType: 'client' })
    await insertLegacyBoost(postId, targetId, user.id)

    const outcome = await flagAndConfirm(targetId)
    expect(outcome.confirmed).toBe(true)
    const row = await queryOne('SELECT deletion_review_state, violation_counted FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(row.deletion_review_state).toBe('confirmed')
    expect(Number(row.violation_counted)).toBe(0)
    const boosts = await postRepo.findPostBoostTargetsByTargetId(targetId)
    expect(boosts.every(b => b.boostStatus === 'failed')).toBe(true)
    const violations = await dmRepo.findViolationTargetsByPostId(postId)
    expect(violations[0].publisherRequestId).toBeNull()
  })

  it('multi-target post: one publisher deletion leaves siblings untouched', async () => {
    const publisher = await createTestUser({ email: `dm22p-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 0 })
    const user = await createTestUser({ email: `dm22-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const fb = await insertAccount(user.id, 'facebook', 'page')
    const ig = await insertAccount(user.id, 'instagram', 'ig')
    const postId = await insertPost(user.id, `DelMon multi ${Date.now()}`)
    const pubT = await insertTarget(postId, fb.accountId, { targetType: 'publisher' })
    const clientT = await insertTarget(postId, ig.accountId, { targetType: 'client' })
    const requestId = await insertRequest(postId, publisher.id, { accountId: fb.accountId })
    await query('UPDATE post_targets SET publisher_request_id = ? WHERE id = ?', [uuidToBuffer(requestId), uuidToBuffer(pubT.targetId)])
    const { ptgtId: pubPtgt } = await insertActivePromotion(postId, user.id, pubT.targetId, fb.accountId)
    const { ptgtId: clientPtgt } = await insertActivePromotion(postId, user.id, clientT.targetId, ig.accountId)

    await flagAndConfirm(pubT.targetId)

    const pubRow = await queryOne('SELECT deletion_review_state FROM post_targets WHERE id = ?', [uuidToBuffer(pubT.targetId)])
    const clientRow = await queryOne('SELECT deletion_review_state, status FROM post_targets WHERE id = ?', [uuidToBuffer(clientT.targetId)])
    expect(pubRow.deletion_review_state).toBe('confirmed')
    expect(clientRow.deletion_review_state).toBe('none')
    expect(clientRow.status).toBe('posted')
    expect((await promoRepo.findPromotionTargetById(clientPtgt)).status).toBe('active')
    expect((await promoRepo.findPromotionTargetById(pubPtgt)).status).toBe('failed')
  })

  it('execution job on a deleted target cancels + refunds without any Meta call', async () => {
    const user = await createTestUser({ email: `dm23-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon execguard ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId, { targetType: 'publisher' })
    const promotionId = generateUuid()
    await promoRepo.createPromotion(promotionId, postId, user.id, { status: 'creating', budgetType: 'daily', budgetAmount: 500 })
    await promoRepo.updatePromotion(promotionId, { chargedPaise: 50000 })
    const ptgtId = generateUuid()
    await promoRepo.createPromotionTarget(ptgtId, promotionId, targetId, 'facebook', accountId)
    await query("UPDATE post_targets SET deletion_review_state = 'confirmed', remote_content_state = 'missing' WHERE id = ?", [uuidToBuffer(targetId)])

    const result = await promotionService.runPromotionTargetJob(ptgtId, {})
    expect(result.done).toBe(true)
    expect(metaMocks.getPostPromotability).not.toHaveBeenCalled()
    const after = await promoRepo.findPromotionTargetById(ptgtId)
    expect(after.status).toBe('cancelled')
    expect(Number(after.refundedPaise)).toBeGreaterThan(0)
  })
})

describe('admin review', () => {
  it('dismiss clears the violation decision only — deletion stays terminal', async () => {
    const admin = await createTestUser({ email: `dm24a-${Date.now()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    const publisher = await createTestUser({ email: `dm24p-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 0 })
    const user = await createTestUser({ email: `dm24-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon dismiss ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId, { targetType: 'publisher' })
    const requestId = await insertRequest(postId, publisher.id, { accountId })
    await query('UPDATE post_targets SET publisher_request_id = ? WHERE id = ?', [uuidToBuffer(requestId), uuidToBuffer(targetId)])
    const { ptgtId } = await insertActivePromotion(postId, user.id, targetId, accountId)
    await flagAndConfirm(targetId)

    const out = await deletionService.reviewDeletionViolation(targetId, admin.id, 'dismiss')
    expect(out.dismissed).toBe(true)
    const row = await queryOne('SELECT deletion_review_state, remote_content_state, meta_deleted_at, deletion_confirmed_at, violation_counted FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(row.deletion_review_state).toBe('dismissed')
    expect(row.remote_content_state).toBe('missing')
    expect(row.meta_deleted_at).not.toBeNull()
    expect(row.deletion_confirmed_at).not.toBeNull()
    expect(Number(row.violation_counted)).toBe(0)
    const req = await queryOne('SELECT violation_count FROM post_publisher_requests WHERE id = ?', [uuidToBuffer(requestId)])
    expect(Number(req.violation_count)).toBe(0)
    // boost stays stopped, payout block lifted
    expect((await promoRepo.findPromotionTargetById(ptgtId)).status).toBe('failed')
    await postService.completePostPublisherRequest(publisher.id, requestId)
    expect(await walletCoins(publisher.id)).toBe(100)
  })

  it('clawback is strict all-or-nothing and idempotent', async () => {
    const admin = await createTestUser({ email: `dm25a-${Date.now()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    const publisher = await createTestUser({ email: `dm25p-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 0 })
    const user = await createTestUser({ email: `dm25-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon clawback ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId, { targetType: 'publisher' })
    const requestId = await insertRequest(postId, publisher.id, { coinsOffered: 100, accountId })
    await query('UPDATE post_targets SET publisher_request_id = ? WHERE id = ?', [uuidToBuffer(requestId), uuidToBuffer(targetId)])
    await postService.completePostPublisherRequest(publisher.id, requestId)
    await flagAndConfirm(targetId)

    const before = await totalAvailable(publisher.id)
    const out = await deletionService.reviewDeletionViolation(targetId, admin.id, 'clawback')
    expect(out.clawedBack).toBe(true)
    expect(out.coins).toBe(100)
    expect(await totalAvailable(publisher.id)).toBe(before - 100)
    const info = await dmRepo.findRequestViolationInfo(requestId)
    expect(info.clawbackPaise).toBeGreaterThan(0)

    await expect(deletionService.reviewDeletionViolation(targetId, admin.id, 'clawback')).rejects.toThrow()
    expect(await totalAvailable(publisher.id)).toBe(before - 100)
  })

  it('clawback with insufficient balance mutates nothing and stays pending', async () => {
    const admin = await createTestUser({ email: `dm26a-${Date.now()}@flowx-test.com`, password: 'Test@123', role: 'admin' })
    const publisher = await createTestUser({ email: `dm26p-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 0 })
    const user = await createTestUser({ email: `dm26-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon clawinsuf ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId, { targetType: 'publisher' })
    const requestId = await insertRequest(postId, publisher.id, { coinsOffered: 100, accountId })
    await query('UPDATE post_targets SET publisher_request_id = ? WHERE id = ?', [uuidToBuffer(requestId), uuidToBuffer(targetId)])
    await postService.completePostPublisherRequest(publisher.id, requestId)
    // publisher spends almost everything elsewhere first
    const coinService = await import('../../shared/services/coin.service.js')
    const drained = await totalAvailable(publisher.id)
    await coinService.spend(publisher.id, drained - 10, 'test_drain', generateUuid())
    expect(await totalAvailable(publisher.id)).toBe(10)

    await flagAndConfirm(targetId)
    await expect(deletionService.reviewDeletionViolation(targetId, admin.id, 'clawback')).rejects.toThrow('Insufficient coins')
    // all-or-nothing: no wallet/ledger mutation, claim rolled back
    expect(await totalAvailable(publisher.id)).toBe(10)
    const info = await dmRepo.findRequestViolationInfo(requestId)
    expect(info.clawbackPaise).toBe(0)
    expect(info.clawbackAt).toBeNull()
    const spends = await query(
      "SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND reference_type = 'publisher_violation'",
      [uuidToBuffer(publisher.id)]
    )
    expect(Number(spends[0].n)).toBe(0)
  })

  it('admin HTTP: violations list + dismiss, client gets 403', async () => {
    const publisher = await createTestUser({ email: `dm27p-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 0 })
    const user = await createTestUser({ email: `dm27-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon http ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId, { targetType: 'publisher' })
    const requestId = await insertRequest(postId, publisher.id, { accountId })
    await query('UPDATE post_targets SET publisher_request_id = ? WHERE id = ?', [uuidToBuffer(requestId), uuidToBuffer(targetId)])
    await flagAndConfirm(targetId)

    const adminToken = await loginAgent(app, 'admin@flowx.com', 'Admin@123')
    const list = await supertest(app).get(`/api/v1/admin/posts/${postId}/violations`).set('Authorization', `Bearer ${adminToken}`)
    expect(list.status).toBe(200)
    expect(list.body.data.targets.map((t) => t.postTargetId)).toContain(targetId)
    expect(list.body.data.requests[requestId].violationCount).toBe(1)

    const dismiss = await supertest(app).post(`/api/v1/admin/posts/${postId}/violations/${targetId}/review`).set('Authorization', `Bearer ${adminToken}`).send({ action: 'dismiss' })
    expect(dismiss.status).toBe(200)
    expect(dismiss.body.data.dismissed).toBe(true)

    const bad = await supertest(app).post(`/api/v1/admin/posts/${postId}/violations/${targetId}/review`).set('Authorization', `Bearer ${adminToken}`).send({ action: 'clawback' })
    expect(bad.status).toBe(422)

    const clientToken = await loginAgent(app, user.email, 'Test@123')
    const forbidden = await supertest(app).get(`/api/v1/admin/posts/${postId}/violations`).set('Authorization', `Bearer ${clientToken}`)
    expect(forbidden.status).toBe(403)
  })
})

describe('scheduler + wiring + consumer guards', () => {
  it('sweep enqueues once, dedupes while queued, throttles itself', async () => {
    const user = await createTestUser({ email: `dm28-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon sweep ${Date.now()}`)
    await insertTarget(postId, accountId)

    deletionService.remoteHealthSweep.lastRunAt = 0
    const first = await deletionService.scheduleDeletionMonitoring()
    expect(first.enqueued).toBe(true)
    deletionService.remoteHealthSweep.lastRunAt = 0
    const second = await deletionService.scheduleDeletionMonitoring()
    expect(second.skipped).toBe(true)
    expect(second.reason).toBe('already_queued')
    deletionService.remoteHealthSweep.lastRunAt = 0
  })

  it('remote-health job is dispatched through the worker', async () => {
    const user = await createTestUser({ email: `dm29-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon worker ${Date.now()}`)
    const { targetId } = await insertTarget(postId, accountId)
    metaMocks.getObjectRemoteState.mockResolvedValue({ state: 'missing', detail: 'gone' })

    const { requeueAutoJob } = await import('../../src/modules/campaigns/campaign.repository.js')
    await requeueAutoJob(null, 'post_remote_health', {}, { runKey: 'remote-health', entityType: 'post' })
    await campaignJobs.processDueJobs()

    const row = await queryOne('SELECT deletion_review_state FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(row.deletion_review_state).toBe('flagged')
  })

  it('deleted targets are excluded from new boost creation paths', async () => {
    const user = await createTestUser({ email: `dm30-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const del = await insertAccount(user.id, 'facebook', 'page')
    const ok = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon noguard ${Date.now()}`)
    await query('UPDATE posts SET boost_enabled = 1 WHERE id = ?', [uuidToBuffer(postId)])
    const { targetId } = await insertTarget(postId, del.accountId)
    const healthy = await insertTarget(postId, ok.accountId)
    await query("UPDATE post_targets SET deletion_review_state = 'confirmed', remote_content_state = 'missing' WHERE id = ?", [uuidToBuffer(targetId)])

    const queued = await postService.queuePostBoosts(postId)
    expect(queued.enqueued).toBe(1)
    expect(queued.total).toBe(1)
    const jobs = await query("SELECT run_key FROM campaign_jobs WHERE job_type = 'post_boost' AND run_key LIKE 'post_boost:%'")
    expect(jobs.map(j => j.run_key)).toEqual([`post_boost:${healthy.targetId}`])

    // a stuck pending promotion target on the deleted target is never recovered
    const promotionId = generateUuid()
    await promoRepo.createPromotion(promotionId, postId, user.id, { status: 'creating', budgetType: 'daily', budgetAmount: 500 })
    const ptgtId = generateUuid()
    await promoRepo.createPromotionTarget(ptgtId, promotionId, targetId, 'facebook', del.accountId)
    const stuck = await promoRepo.findStuckPendingPromotionTargets()
    expect(stuck.map((s) => s.postTargetId)).not.toContain(targetId)
  })

  it('retry leaves confirmed-deleted targets untouched (no repost surface)', async () => {
    const user = await createTestUser({ email: `dm31-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertAccount(user.id, 'facebook', 'page')
    const postId = await insertPost(user.id, `DelMon norepost ${Date.now()}`)
    const { targetId, objectId } = await insertTarget(postId, accountId)
    await query("UPDATE posts SET status = 'failed' WHERE id = ?", [uuidToBuffer(postId)])
    await flagAndConfirm(targetId)

    const before = await queryOne('SELECT status, meta_object_id, deletion_review_state FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    await postService.retryPostPublish(postId).catch(() => null)
    const after = await queryOne('SELECT status, meta_object_id, deletion_review_state FROM post_targets WHERE id = ?', [uuidToBuffer(targetId)])
    expect(after.status).toBe(before.status)
    expect(after.meta_object_id).toBe(objectId)
    expect(after.deletion_review_state).toBe('confirmed')

    const fs = await import('node:fs')
    const routes = fs.readFileSync('src/modules/posts/post.routes.js', 'utf8') + fs.readFileSync('src/modules/posts/admin.routes.js', 'utf8')
    expect(routes).not.toMatch(/repost/i)
  })
})
