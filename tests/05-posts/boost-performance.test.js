import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import supertest from 'supertest'
import * as webhookService from '../../src/modules/campaigns/meta-webhook.service.js'
import * as boostService from '../../src/modules/posts/boost-performance.service.js'
import * as bpRepo from '../../src/modules/posts/boost-performance.repository.js'
import * as postRepo from '../../src/modules/posts/post.repository.js'
import * as promoRepo from '../../src/modules/posts/promotion.repository.js'
import * as campaignJobs from '../../src/modules/campaigns/campaign.jobs.js'
import { query, queryOne } from '../../shared/database/connection.js'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { encrypt } from '../../shared/utils/crypto.utils.js'
import { createTestUser } from '../helpers/create-user.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    createInsightsReport: vi.fn().mockResolvedValue({ report_run_id: 'mock_boost_report_1' }),
    getInsightsReport: vi.fn().mockResolvedValue({ async_status: 'Job Completed' }),
    getInsightsReportData: vi.fn().mockResolvedValue([]),
    getCampaignStatusesBatch: vi.fn().mockResolvedValue({}),
  }
  metaMocks = mocks
  return mocks
})

let app

function statusUpdateEvent(fbCampaignId, status) {
  return {
    object: 'ad_account',
    entry: [{
      id: `entry_${generateUuid()}`,
      time: Math.floor(Date.now() / 1000),
      changes: [{
        field: 'campaign.status_update',
        value: { campaign_id: fbCampaignId, ad_account_id: 'act_test_account', status },
      }],
    }],
  }
}

function spendEvent(fbCampaignId, amount, date = '2026-08-04') {
  return {
    object: 'ad_account',
    entry: [{
      id: `entry_${generateUuid()}`,
      time: Math.floor(Date.now() / 1000),
      changes: [{
        field: 'campaign_daily_spend',
        value: { campaign_id: fbCampaignId, ad_account_id: 'act_test_account', amount, currency: 'INR', date },
      }],
    }],
  }
}

function deliverySignalEvent(fbCampaignId, adId, status) {
  return {
    object: 'ad_account',
    entry: [{
      id: `entry_${generateUuid()}`,
      time: Math.floor(Date.now() / 1000),
      changes: [{
        field: 'ad.delivery_signals',
        value: { campaign_id: fbCampaignId, ad_id: adId, status },
      }],
    }],
  }
}

async function cleanup() {
  await query('SET FOREIGN_KEY_CHECKS = 0')
  await query('DELETE FROM meta_webhook_events')
  await query('DELETE FROM post_boost_daily_stats')
  await query('DELETE FROM post_boost_targets')
  await query('DELETE FROM promotion_targets')
  await query('DELETE FROM promotions')
  await query('DELETE FROM post_engagement_daily')
  await query('DELETE FROM campaign_jobs')
  await query('DELETE FROM meta_sync_state')
  await query('DELETE FROM post_targets')
  await query("DELETE FROM posts WHERE name LIKE 'BoostPerf %'")
  await query("DELETE FROM user_platform_accounts WHERE platform_username LIKE 'bp_page_%'")
  await query('SET FOREIGN_KEY_CHECKS = 1')
}

async function insertPageAccount(userId) {
  const pageId = `bp_page_${generateUuid().replace(/[^0-9]/g, '').slice(-10)}`
  const { encrypt: enc } = await import('../../shared/utils/crypto.utils.js')
  const platform = await queryOne('SELECT id FROM platforms WHERE code = ?', ['facebook'])
  const accountId = generateUuid()
  await query(
    `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id, platform_username, platform_display_name, token_type, access_token, token_expires_at, verification_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'page', ?, DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
    [uuidToBuffer(accountId), uuidToBuffer(userId), platform.id, `https://fb.com/${pageId}`, pageId, pageId, `Page ${pageId}`, enc('mock_page_token')]
  )
  return { accountId, pageId }
}

async function insertBoostedPost(userId, accountId, name, { legacy = true, promotion = false, targetType = 'client', secondTarget = false, publisherRequestUserId = null } = {}) {
  const postId = generateUuid()
  await query(
    `INSERT INTO posts (id, client_id, name, type, status, boost_enabled, caption, media_url, created_at, updated_at)
     VALUES (?, ?, ?, 'post', 'completed', 1, 'caption', 'https://example.com/img.jpg', NOW(), NOW())`,
    [uuidToBuffer(postId), uuidToBuffer(userId), name]
  )
  const targets = []
  const makeTarget = async (tt, acctId) => {
    const targetId = generateUuid()
    await query(
      `INSERT INTO post_targets (id, post_id, platform_account_id, target_type, status, publish_state, meta_object_id, posted_at, created_at)
       VALUES (?, ?, ?, ?, 'posted', 'published', ?, NOW(), NOW())`,
      [uuidToBuffer(targetId), uuidToBuffer(postId), uuidToBuffer(acctId), tt, `bp_post_${generateUuid().replace(/[^a-z0-9]/gi, '').slice(-12)}`]
    )
    return targetId
  }
  const targetId = await makeTarget(targetType, accountId)
  targets.push({ id: targetId, accountId })
  if (secondTarget) {
    // post_targets is UNIQUE(post_id, platform_account_id) — the publisher
    // copy lives on its own connected account
    const second = await insertPageAccount(userId)
    const pubTargetId = await makeTarget('publisher', second.accountId)
    targets.push({ id: pubTargetId, accountId: second.accountId })
    if (publisherRequestUserId) {
      // mirror the real go-live shape: the publisher target is owned by a
      // publisher request row pointing at the publisher user
      const requestId = generateUuid()
      await query(
        `INSERT INTO post_publisher_requests (id, post_id, publisher_id, coins_offered, status, published_at)
         VALUES (?, ?, ?, ?, 'published', NOW())`,
        [uuidToBuffer(requestId), uuidToBuffer(postId), uuidToBuffer(publisherRequestUserId), 100]
      )
      await query('UPDATE post_targets SET publisher_request_id = ? WHERE id = ?', [uuidToBuffer(requestId), uuidToBuffer(pubTargetId)])
    }
  }

  const targetIds = targets.map(t => t.id)
  const out = { postId, targetIds, targetAccounts: Object.fromEntries(targets.map(t => [t.id, t.accountId])), fbCampaignIds: {}, fbAdIds: {} }
  if (legacy) {
    for (const tid of targetIds) {
      const campId = `bp_camp_${generateUuid().replace(/[^a-z0-9]/gi, '').slice(-14)}`
      await postRepo.createPostBoostTarget(postId, tid, { objectType: 'facebook_campaign', objectId: campId, status: 'ACTIVE', boostStatus: 'active', createdForUserId: userId })
      const adId = `bp_ad_${generateUuid().replace(/[^a-z0-9]/gi, '').slice(-14)}`
      await postRepo.createPostBoostTarget(postId, tid, { objectType: 'ad', objectId: adId, status: 'ACTIVE', boostStatus: 'active', createdForUserId: userId })
      out.fbCampaignIds[tid] = campId
      out.fbAdIds[tid] = adId
    }
  }
  if (promotion) {
    const promotionId = generateUuid()
    await promoRepo.createPromotion(promotionId, postId, userId, { status: 'active', budgetType: 'daily', budgetAmount: 500 })
    for (const tid of targetIds) {
      const ptgtId = generateUuid()
      await promoRepo.createPromotionTarget(ptgtId, promotionId, tid, 'facebook', out.targetAccounts[tid])
      const campId = `bp_pc_${generateUuid().replace(/[^a-z0-9]/gi, '').slice(-14)}`
      const adId = `bp_pa_${generateUuid().replace(/[^a-z0-9]/gi, '').slice(-14)}`
      await promoRepo.updatePromotionTarget(ptgtId, { status: 'active', platformCampaignId: campId, platformAdId: adId })
      out.fbCampaignIds[tid] = campId
      out.fbAdIds[tid] = adId
      out.promotionId = promotionId
      out.promotionTargetId = ptgtId
    }
  }
  return out
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
  metaMocks.createInsightsReport.mockClear()
  metaMocks.getInsightsReport.mockClear()
  metaMocks.getInsightsReportData.mockClear()
  metaMocks.getCampaignStatusesBatch.mockClear()
  metaMocks.getInsightsReport.mockResolvedValue({ async_status: 'Job Completed' })
  metaMocks.getInsightsReportData.mockResolvedValue([])
  metaMocks.getCampaignStatusesBatch.mockResolvedValue({})
})

afterAll(async () => {
  await cleanup()
})

async function runAccountJob(forcePostId = null, rounds = 3) {
  // one parked async report needs several job ticks: fudge run_after +
  // the FSM poll throttle so consecutive processDueJobs() ticks advance it
  const { requeueAutoJob } = await import('../../src/modules/campaigns/campaign.repository.js')
  await requeueAutoJob(null, 'post_sync_boost_performance', forcePostId ? { forcePostId } : {}, { runKey: 'boost-perf:act_test_account', entityType: 'post' })
  for (let i = 0; i < rounds; i += 1) {
    await campaignJobs.processDueJobs()
    await query("UPDATE campaign_jobs SET run_after = NOW() WHERE run_key = 'boost-perf:act_test_account' AND status = 'queued'")
    await query("UPDATE meta_sync_state SET state = JSON_SET(state, '$.nextPollAt', 0) WHERE run_key = 'boost-perf:act_test_account'")
  }
}

describe('boost resolver', () => {
  it('resolves a legacy campaign id to its post target', async () => {
    const user = await createTestUser({ email: `bp1-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf legacy ${Date.now()}`)
    const tid = seed.targetIds[0]
    const refs = await bpRepo.resolveBoostObjectRefs([seed.fbCampaignIds[tid]])
    const ref = refs.get(seed.fbCampaignIds[tid])
    expect(ref).toBeTruthy()
    expect(ref.path).toBe('legacy')
    expect(ref.postTargetId).toBe(tid)
    expect(ref.postId).toBe(seed.postId)
  })

  it('resolves promotion campaign and ad ids to the promotion target', async () => {
    const user = await createTestUser({ email: `bp2-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf promo ${Date.now()}`, { legacy: false, promotion: true })
    const tid = seed.targetIds[0]
    const refs = await bpRepo.resolveBoostObjectRefs([seed.fbCampaignIds[tid], seed.fbAdIds[tid]])
    const byCamp = refs.get(seed.fbCampaignIds[tid])
    const byAd = refs.get(seed.fbAdIds[tid])
    expect(byCamp?.path).toBe('promotion')
    expect(byCamp?.promotionTargetId).toBe(seed.promotionTargetId)
    expect(byAd?.path).toBe('promotion')
    expect(byAd?.postTargetId).toBe(tid)
  })

  it('resolves legacy ad-level ids', async () => {
    const user = await createTestUser({ email: `bp3-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf adlevel ${Date.now()}`)
    const tid = seed.targetIds[0]
    const refs = await bpRepo.resolveBoostObjectRefs([seed.fbAdIds[tid]])
    expect(refs.get(seed.fbAdIds[tid])?.postTargetId).toBe(tid)
  })

  it('returns an empty map for unknown ids', async () => {
    const refs = await bpRepo.resolveBoostObjectRefs([`nope_${generateUuid()}`])
    expect(refs.size).toBe(0)
  })
})

describe('boost webhook spend', () => {
  it('writes a spend row for the correct post target and stamps webhook freshness', async () => {
    const user = await createTestUser({ email: `bp4-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf spend ${Date.now()}`)
    const tid = seed.targetIds[0]

    const result = await webhookService.processMetaWebhookEvents(spendEvent(seed.fbCampaignIds[tid], 123.45))
    expect(result.processed).toBe(1)
    expect(result.results[0].outcome.boost).toBe(true)

    const rows = await bpRepo.findBoostDailyStatsByPostId(seed.postId)
    expect(rows.length).toBe(1)
    expect(rows[0].postTargetId).toBe(tid)
    expect(rows[0].spendPaise).toBe(12345)
    expect(rows[0].lastSource).toBe('webhook')

    const target = await queryOne('SELECT last_boost_webhook_at FROM post_targets WHERE id = ?', [uuidToBuffer(tid)])
    expect(target.last_boost_webhook_at).toBeTruthy()
  })

  it('keeps same-day spend monotonic and ignores duplicates', async () => {
    const user = await createTestUser({ email: `bp5-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf monot ${Date.now()}`)
    const tid = seed.targetIds[0]
    const fbId = seed.fbCampaignIds[tid]

    await webhookService.processMetaWebhookEvents(spendEvent(fbId, 500))
    // lower value on a retry must not decrease the bucket
    await webhookService.processMetaWebhookEvents(spendEvent(fbId, 100))
    let rows = await bpRepo.findBoostDailyStatsByPostId(seed.postId)
    expect(rows.length).toBe(1)
    expect(rows[0].spendPaise).toBe(50000)

    // exact duplicate provider event is deduped at ingress (no second row)
    const dup = spendEvent(fbId, 700)
    await webhookService.processMetaWebhookEvents(dup)
    await webhookService.processMetaWebhookEvents(dup)
    rows = await bpRepo.findBoostDailyStatsByPostId(seed.postId)
    expect(rows.length).toBe(1)
    expect(rows[0].spendPaise).toBe(70000)
  })
})

describe('boost webhook status', () => {
  it('pauses a promotion target while the sibling stays active (partial success)', async () => {
    const user = await createTestUser({ email: `bp6-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf partial ${Date.now()}`, { legacy: false, promotion: true, secondTarget: true })
    const [t1, t2] = seed.targetIds

    const result = await webhookService.processMetaWebhookEvents(statusUpdateEvent(seed.fbCampaignIds[t1], 'PAUSED'))
    expect(result.results[0].outcome.boost).toBe(true)

    const { findPromotionTargetByPostTargetId } = await import('../../src/modules/posts/promotion.repository.js')
    const paused = await findPromotionTargetByPostTargetId(t1)
    const other = await findPromotionTargetByPostTargetId(t2)
    expect(paused.status).toBe('paused')
    expect(other.status).toBe('active')

    const promo = await promoRepo.findPromotionById(seed.promotionId)
    expect(promo.status).toBe('active')
  })

  it('fails a disapproved promotion target and leaves billing untouched', async () => {
    const user = await createTestUser({ email: `bp7-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf disap ${Date.now()}`, { legacy: false, promotion: true })
    const tid = seed.targetIds[0]

    await webhookService.processMetaWebhookEvents(statusUpdateEvent(seed.fbCampaignIds[tid], 'DISAPPROVED'))

    const { findPromotionTargetByPostTargetId } = await import('../../src/modules/posts/promotion.repository.js')
    const after = await findPromotionTargetByPostTargetId(tid)
    expect(after.status).toBe('failed')
    expect(after.error).toContain('disapproved')
    expect(after.refundedPaise).toBe(0)
    expect(after.consumedPaise).toBe(0)
  })

  it('does not transition terminal or in-flight promotion targets', async () => {
    const user = await createTestUser({ email: `bp8-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf guard ${Date.now()}`, { legacy: false, promotion: true })
    const tid = seed.targetIds[0]
    await promoRepo.updatePromotionTarget(seed.promotionTargetId, { status: 'cancelled' })

    await webhookService.processMetaWebhookEvents(statusUpdateEvent(seed.fbCampaignIds[tid], 'PAUSED'))

    const { findPromotionTargetByPostTargetId } = await import('../../src/modules/posts/promotion.repository.js')
    const after = await findPromotionTargetByPostTargetId(tid)
    expect(after.status).toBe('cancelled')
  })

  it('applies ad-level delivery signals to legacy boost rows', async () => {
    const user = await createTestUser({ email: `bp9-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf signal ${Date.now()}`)
    const tid = seed.targetIds[0]

    const result = await webhookService.processMetaWebhookEvents(
      deliverySignalEvent(seed.fbCampaignIds[tid], seed.fbAdIds[tid], 'PAUSED')
    )
    expect(result.results[0].outcome.boost).toBe(true)

    const rows = await postRepo.findPostBoostTargetsByTargetId(tid)
    expect(rows.every(r => r.boostStatus === 'paused')).toBe(true)
  })

  it('ignores unresolved boost objects without crashing', async () => {
    const result = await webhookService.processMetaWebhookEvents(statusUpdateEvent(`bp_nope_${generateUuid()}`, 'PAUSED'))
    expect(result.results[0].outcome.ignored).toBe(true)
    const stats = await query('SELECT COUNT(*) AS n FROM post_boost_daily_stats')
    expect(stats[0].n).toBe(0)
  })
})

describe('boost insights sync', () => {
  it('writes a fan-out chunk as one multi-row INSERT (genuinely bulk, spend stays monotonic)', async () => {
    const user = await createTestUser({ email: `bpb-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf bulk ${Date.now()}`, { secondTarget: true })
    const [t1, t2] = seed.targetIds
    const conn = await import('../../shared/database/connection.js')
    const querySpy = vi.spyOn(conn, 'query')
    const written = await bpRepo.upsertBoostDailyStatsBulk([
      { postId: seed.postId, postTargetId: t1, statDate: '2026-08-04', impressions: 100, spendPaise: 1000 },
      { postId: seed.postId, postTargetId: t1, statDate: '2026-08-05', impressions: 10, spendPaise: 100 },
      { postId: seed.postId, postTargetId: t2, statDate: '2026-08-04', impressions: 50, spendPaise: 500 },
    ])
    expect(written).toBe(3)
    const inserts = querySpy.mock.calls.filter(([sql]) => /INSERT INTO post_boost_daily_stats/.test(sql))
    expect(inserts).toHaveLength(1)
    expect(inserts[0][0]).toMatch(/VALUES \(.+\), \(.+\), \(.+\)/)
    expect(JSON.stringify(inserts[0][0])).toContain('ON DUPLICATE KEY UPDATE')
    expect(JSON.stringify(inserts[0][0])).toContain('GREATEST(spend_paise')
    querySpy.mockRestore()

    const rows = await bpRepo.findBoostDailyStatsByPostId(seed.postId)
    expect(rows.length).toBe(3)
    // re-run with lower spend: countables replace, spend never decreases
    await bpRepo.upsertBoostDailyStatsBulk([
      { postId: seed.postId, postTargetId: t1, statDate: '2026-08-04', impressions: 999, spendPaise: 1 },
    ])
    const rows2 = await bpRepo.findBoostDailyStatsByPostId(seed.postId)
    expect(rows2.length).toBe(3)
    const t1d4 = rows2.find(r => r.postTargetId === t1 && r.statDate.slice(0, 10) === '2026-08-04')
    expect(t1d4.impressions).toBe(999)
    expect(t1d4.spendPaise).toBe(1000)
  })

  it('fans out report rows to isolated per-target daily rows', async () => {
    const user = await createTestUser({ email: `bp10-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf fanout ${Date.now()}`, { secondTarget: true })
    const [t1, t2] = seed.targetIds
    metaMocks.getInsightsReportData.mockResolvedValue([
      { campaign_id: seed.fbCampaignIds[t1], date_start: '2026-08-04', impressions: '100', reach: '90', frequency: '1.11', clicks: '5', unique_clicks: '4', ctr: '5', cpc: '2', cpm: '100', spend: '10', actions: [{ action_type: 'comment', value: '2' }], cost_per_action_type: [] },
      { campaign_id: seed.fbCampaignIds[t2], date_start: '2026-08-04', impressions: '50', reach: '45', frequency: '1.1', clicks: '1', unique_clicks: '1', ctr: '2', cpc: '5', cpm: '100', spend: '5', actions: [], cost_per_action_type: [] },
    ])

    await runAccountJob(seed.postId)

    const rows = await bpRepo.findBoostDailyStatsByPostId(seed.postId)
    expect(rows.length).toBe(2)
    const byTarget = new Map(rows.map(r => [r.postTargetId, r]))
    expect(byTarget.get(t1).impressions).toBe(100)
    expect(byTarget.get(t1).spendPaise).toBe(1000)
    expect(byTarget.get(t1).actions).toEqual({ comment: 2 })
    expect(byTarget.get(t1).lastSource).toBe('insights')
    expect(byTarget.get(t2).impressions).toBe(50)

    const stamps = await query('SELECT last_boost_sync_at FROM post_targets WHERE id IN (?, ?)', [uuidToBuffer(t1), uuidToBuffer(t2)])
    expect(stamps.every(s => s.last_boost_sync_at)).toBe(true)
  })

  it('is idempotent and never lowers webhook-recorded spend', async () => {
    const user = await createTestUser({ email: `bp11-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf idem ${Date.now()}`)
    const tid = seed.targetIds[0]
    await webhookService.processMetaWebhookEvents(spendEvent(seed.fbCampaignIds[tid], 500))

    metaMocks.getInsightsReportData.mockResolvedValue([
      { campaign_id: seed.fbCampaignIds[tid], date_start: '2026-08-04', impressions: '100', reach: '90', frequency: '1', clicks: '5', unique_clicks: '4', ctr: '5', cpc: '2', cpm: '100', spend: '400', actions: [], cost_per_action_type: [] },
    ])
    await runAccountJob(seed.postId)
    await runAccountJob(seed.postId)

    const rows = await bpRepo.findBoostDailyStatsByPostId(seed.postId)
    expect(rows.length).toBe(1)
    expect(rows[0].impressions).toBe(100)
    // webhook recorded 500 (fresher), lagging insights says 400 → stays 500
    expect(rows[0].spendPaise).toBe(50000)
  })

  it('requests a bounded historical window on first sync', async () => {
    const user = await createTestUser({ email: `bp12-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf hist ${Date.now()}`)
    metaMocks.getInsightsReportData.mockResolvedValue([])

    await runAccountJob(seed.postId)

    expect(metaMocks.createInsightsReport).toHaveBeenCalled()
    const args = metaMocks.createInsightsReport.mock.calls[0][1]
    expect(args.level).toBe('campaign')
    expect(args.filtering[0].field).toBe('campaign.id')
    expect(new Date(args.since).getTime()).toBeLessThanOrEqual(Date.now())
    expect(Date.now() - new Date(args.since).getTime()).toBeLessThanOrEqual(90 * 24 * 3600 * 1000 + 60000)
  })

  it('requests campaign_id in report fields so rows resolve to targets', async () => {
    // regression: async report rows contain only explicitly requested fields.
    // Without campaign_id every row is dropped at fan-out (0 persisted live).
    // The job relies on createInsightsReport's default fields, so resolve the
    // default exactly like the real function does.
    const { INSIGHTS_FIELDS } = await import('../../shared/services/meta-ads.service.js')
    const user = await createTestUser({ email: `bp12b-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf fields ${Date.now()}`)
    metaMocks.getInsightsReportData.mockResolvedValue([])

    await runAccountJob(seed.postId)

    expect(metaMocks.createInsightsReport).toHaveBeenCalled()
    const callOpts = metaMocks.createInsightsReport.mock.calls[0][1] || {}
    const effectiveFields = String(callOpts.fields ?? INSIGHTS_FIELDS)
    expect(effectiveFields.split(',')).toContain('campaign_id')
  })

  it('stamps due targets even when the report returns zero rows', async () => {
    // regression: a valid empty window (e.g. zero-spend campaign) is a
    // completed reconciliation. Without the stamp the target stays due and
    // the scheduler recreates a report every sweep.
    const user = await createTestUser({ email: `bp12c-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf zerorows ${Date.now()}`)
    const tid = seed.targetIds[0]
    metaMocks.getInsightsReportData.mockResolvedValue([])

    await runAccountJob(seed.postId)

    const row = await queryOne('SELECT last_boost_sync_at FROM post_targets WHERE id = ?', [uuidToBuffer(tid)])
    expect(row.last_boost_sync_at).toBeTruthy()

    metaMocks.createInsightsReport.mockClear()
    const due = await bpRepo.findDueBoostPerformanceTargets({ fallbackSeconds: 3600, healthySeconds: 21600, freshSeconds: 21600, limit: 100 })
    expect(due.map(d => d.postTargetId)).not.toContain(tid)
  })

  it('reuses a parked report instead of creating a parallel one', async () => {
    const user = await createTestUser({ email: `bp13-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf fsm ${Date.now()}`)
    metaMocks.getInsightsReport.mockResolvedValue({ async_status: 'Job Running' })
    metaMocks.getInsightsReportData.mockResolvedValue([])

    await runAccountJob(seed.postId)
    expect(metaMocks.createInsightsReport).toHaveBeenCalledTimes(1)

    // further ticks poll the parked report, never create a parallel one
    metaMocks.createInsightsReport.mockClear()
    await runAccountJob(null, 2)
    expect(metaMocks.createInsightsReport).not.toHaveBeenCalled()
    expect(metaMocks.getInsightsReport).toHaveBeenCalledWith('mock_boost_report_1', 'test_system_user_token')
  })

  it('selects due targets with adaptive cadence and dedupes scheduled jobs', async () => {
    const user = await createTestUser({ email: `bp14-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf due ${Date.now()}`, { secondTarget: true })
    const [t1, t2] = seed.targetIds

    // webhook-fresh t1 synced 2h ago → not due (6h healthy cadence)
    await query('UPDATE post_targets SET last_boost_sync_at = DATE_SUB(NOW(), INTERVAL 2 HOUR), last_boost_webhook_at = NOW() WHERE id = ?', [uuidToBuffer(t1)])
    // webhook-stale t2 synced 2h ago → due (1h fallback)
    await query('UPDATE post_targets SET last_boost_sync_at = DATE_SUB(NOW(), INTERVAL 2 HOUR), last_boost_webhook_at = DATE_SUB(NOW(), INTERVAL 10 HOUR) WHERE id = ?', [uuidToBuffer(t2)])

    const due = await bpRepo.findDueBoostPerformanceTargets({ fallbackSeconds: 3600, healthySeconds: 21600, freshSeconds: 21600, limit: 100 })
    const dueIds = due.map(d => d.postTargetId)
    expect(dueIds).toContain(t2)
    expect(dueIds).not.toContain(t1)

    const sweep1 = await boostService.schedulePostBoostPerformanceSyncs()
    expect(sweep1.enqueued).toBe(true)
    boostService.boostPerfSweep.lastRunAt = 0
    const sweep2 = await boostService.schedulePostBoostPerformanceSyncs()
    expect(sweep2.skipped).toBe(true)
  })

  it('converges status for zero-spend campaigns in the due batch', async () => {
    // regression: status convergence used only campaigns present in the
    // insights data rows, so a zero-spend campaign never got status-checked.
    const user = await createTestUser({ email: `bp14b-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf zerostatus ${Date.now()}`, { secondTarget: true })
    const [t1, t2] = seed.targetIds
    // report returns rows only for t1 (t2 has zero spend → no data rows)
    metaMocks.getInsightsReportData.mockResolvedValue([
      { campaign_id: seed.fbCampaignIds[t1], date_start: '2026-08-04', impressions: '100', reach: '90', frequency: '1', clicks: '5', unique_clicks: '4', ctr: '5', cpc: '2', cpm: '100', spend: '10', actions: [], cost_per_action_type: [] },
    ])
    // Meta says t2's campaign is paused — only converge it when asked for it
    metaMocks.getCampaignStatusesBatch.mockImplementation(async (adAccountId, token, ids) => {
      const out = {}
      for (const id of ids || []) {
        if (id === seed.fbCampaignIds[t2]) out[id] = 'PAUSED'
      }
      return out
    })
    try {
      await runAccountJob(seed.postId)

      const rows = await postRepo.findPostBoostTargetsByTargetId(t2)
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every(r => r.boostStatus === 'paused')).toBe(true)
      const t1Rows = await postRepo.findPostBoostTargetsByTargetId(t1)
      expect(t1Rows.every(r => r.boostStatus === 'active')).toBe(true)
      const perf = await bpRepo.findBoostDailyStatsByPostId(seed.postId)
      expect(perf.map(r => r.postTargetId)).toContain(t1)
    } finally {
      metaMocks.getCampaignStatusesBatch.mockReset()
      metaMocks.getCampaignStatusesBatch.mockResolvedValue({})
    }
  })
})

describe('boost performance read API', () => {
  it('returns per-target stats, totals and boosted counts', async () => {
    const user = await createTestUser({ email: `bp15-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf read ${Date.now()}`)
    const tid = seed.targetIds[0]
    await bpRepo.upsertBoostDailyStat({
      postId: seed.postId, postTargetId: tid, statDate: '2026-08-04',
      impressions: 100, reach: 90, frequency: 1.11, clicks: 5, uniqueClicks: 4,
      ctr: 5, cpc: 2, cpm: 100, spendPaise: 1000,
      actions: { comment: 2 }, costPerActionType: {},
    })

    const result = await boostService.getBoostPerformance(user.id, seed.postId)
    expect(result.postId).toBe(seed.postId)
    expect(result.boostedCount).toBe(1)
    expect(result.queued).toBeFalsy()
    const target = result.targets[0]
    expect(target.postTargetId).toBe(tid)
    expect(target.hasBoost).toBe(true)
    expect(target.daily.length).toBe(1)
    expect(target.totals.spendPaise).toBe(1000)
    expect(target.totals.impressions).toBe(100)
    expect(target.totals.actions).toEqual({ comment: 2 })
    // raw Meta ids and internal path must not leak to clients
    expect(JSON.stringify(result)).not.toContain(seed.fbCampaignIds[tid])
    expect(JSON.stringify(result)).not.toContain('"legacy"')
    expect(JSON.stringify(result)).not.toContain('"promotion"')
  })

  it('lists no fabricated performance for unmapped targets', async () => {
    const user = await createTestUser({ email: `bp16-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf nomap ${Date.now()}`, { legacy: false })
    const result = await boostService.getBoostPerformance(user.id, seed.postId)
    expect(result.boostedCount).toBe(0)
    expect(result.targets).toEqual([])
  })

  it('exposes publisher identity for publisher boost targets', async () => {
    const user = await createTestUser({ email: `bp16b-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const publisher = await createTestUser({ email: `bp16b-pub-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    await query('UPDATE user_profiles SET first_name = ?, last_name = ? WHERE user_id = ?', ['Pub', 'Lisher', uuidToBuffer(publisher.id)])
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf pubid ${Date.now()}`, { secondTarget: true, publisherRequestUserId: publisher.id })
    const [t1, t2] = seed.targetIds

    const result = await boostService.getBoostPerformance(user.id, seed.postId)
    expect(result.boostedCount).toBe(2)
    const clientEntry = result.targets.find(t => t.postTargetId === t1)
    const pubEntry = result.targets.find(t => t.postTargetId === t2)
    expect(clientEntry.targetType).toBe('client')
    expect(clientEntry.publisherName).toBeNull()
    expect(clientEntry.publisherEmail).toBeNull()
    expect(pubEntry.targetType).toBe('publisher')
    expect(pubEntry.publisherName).toBe('Pub Lisher')
    expect(pubEntry.publisherEmail).toBe(publisher.email)
  })

  it('refresh=true enqueues a sync and returns stored data with queued flag', async () => {
    const user = await createTestUser({ email: `bp17-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf refresh ${Date.now()}`)

    const first = await boostService.getBoostPerformance(user.id, seed.postId, { refresh: 'true' })
    expect(first.queued).toBe(true)
    const jobs = await query("SELECT COUNT(*) AS n FROM campaign_jobs WHERE run_key = 'boost-perf:act_test_account' AND status = 'queued'")
    expect(jobs[0].n).toBe(1)

    // second refresh click is a no-op (no duplicate job)
    const second = await boostService.getBoostPerformance(user.id, seed.postId, { refresh: 'true' })
    expect(second.queued).toBe(true)
    const jobs2 = await query("SELECT COUNT(*) AS n FROM campaign_jobs WHERE run_key = 'boost-perf:act_test_account' AND status = 'queued'")
    expect(jobs2[0].n).toBe(1)
  })

  it('forbids other clients and allows admins', async () => {
    const user = await createTestUser({ email: `bp18-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const other = await createTestUser({ email: `bp18b-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf auth ${Date.now()}`)

    await expect(boostService.getBoostPerformance(other.id, seed.postId)).rejects.toThrow('Not your post')

    const adminRow = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    const adminResult = await boostService.getBoostPerformance(bufferToUuid(adminRow.id), seed.postId, {}, { skipOwnership: true, includeDebug: true })
    expect(adminResult.targets.length).toBe(1)
    expect(adminResult.targets[0].debug.fbCampaignId).toBe(seed.fbCampaignIds[seed.targetIds[0]])

    const res = await supertest(app).get('/api/v1/admin/posts/does-not-exist/boost-performance')
    expect([401, 403, 404]).toContain(res.status)
  })

  it('a failing insights run never marks the post failed', async () => {
    const user = await createTestUser({ email: `bp19-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const { accountId } = await insertPageAccount(user.id)
    const seed = await insertBoostedPost(user.id, accountId, `BoostPerf neverfail ${Date.now()}`)
    metaMocks.createInsightsReport.mockRejectedValue(new Error('Meta exploded'))

    await runAccountJob(seed.postId, 1)

    const post = await queryOne('SELECT status FROM posts WHERE id = ?', [uuidToBuffer(seed.postId)])
    expect(post.status).toBe('completed')
    // transient failure reschedules (queued) instead of dying or failing the post
    const jobs = await query("SELECT status FROM campaign_jobs WHERE run_key = 'boost-perf:act_test_account' ORDER BY created_at DESC LIMIT 1")
    expect(jobs[0]?.status).toBe('queued')
  })
})
