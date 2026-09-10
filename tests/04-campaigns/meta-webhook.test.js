import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import crypto from 'node:crypto'
import supertest from 'supertest'
import * as repo from '../../src/modules/campaigns/campaign.repository.js'
import * as webhookService from '../../src/modules/campaigns/meta-webhook.service.js'
import { query, queryOne } from '../../shared/database/connection.js'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'

const WEBHOOK_SECRET = 'test_webhook_secret'

let app

function sign(rawBody) {
  return `sha256=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex')}`
}

async function cleanup() {
  await query('SET FOREIGN_KEY_CHECKS = 0')
  await query('DELETE FROM meta_webhook_events')
  await query('DELETE FROM campaign_daily_stats')
  await query('DELETE FROM campaign_meta_objects')
  await query('DELETE FROM campaign_jobs')
  await query('DELETE FROM campaigns')
  await query('DELETE FROM meta_ad_accounts')
  await query('DELETE FROM post_engagement_daily')
  await query('DELETE FROM post_targets')
  await query("DELETE FROM posts WHERE name IN ('Webhook photo post', 'Webhook IG post')")
  await query("DELETE FROM user_platform_accounts WHERE platform_username LIKE ? OR platform_username = 'ig_user'", ['user_page_%'])
  await query('SET FOREIGN_KEY_CHECKS = 1')
}

async function seedRunningCampaign(userId) {
  const account = await repo.createMetaAdAccount({ metaAccountId: `whk_${generateUuid().substring(0, 10)}`, token: 't' })
  const campaign = await repo.createCampaign(generateUuid(), userId, {
    name: `Webhook ${generateUuid().substring(0, 8)}`,
    type: 'post',
    adAccountId: account.id,
  })
  const fbId = `fb_whk_${generateUuid()}`
  await repo.createMetaObject(campaign.id, 'facebook_campaign', fbId, null, 'ACTIVE', userId)
  await repo.createMetaObject(campaign.id, 'ad_set', `as_whk_${generateUuid()}`, null, 'ACTIVE', userId)
  const adId = `ad_whk_${generateUuid()}`
  await repo.createMetaObject(campaign.id, 'ad', adId, null, 'ACTIVE', userId)
  await repo.updateCampaignStatus(campaign.id, 'running')
  return { campaign, fbId, adId }
}

function statusUpdateEvent(fbCampaignId, status) {
  return {
    object: 'ad_account',
    entry: [{
      id: `entry_${generateUuid()}`,
      time: Math.floor(Date.now() / 1000),
      changes: [{
        field: 'campaign.status_update',
        value: { campaign_id: fbCampaignId, ad_account_id: 'act_x', status },
      }],
    }],
  }
}

function spendEvent(fbCampaignId, amount) {
  return {
    object: 'ad_account',
    entry: [{
      id: `entry_${generateUuid()}`,
      time: Math.floor(Date.now() / 1000),
      changes: [{
        field: 'campaign_daily_spend',
        value: { campaign_id: fbCampaignId, ad_account_id: 'act_x', amount, currency: 'INR', date: '2026-08-04' },
      }],
    }],
  }
}

async function insertFbPageAccount(userId, pageId) {
  const { encrypt } = await import('../../shared/utils/crypto.utils.js')
  const platform = await queryOne('SELECT id FROM platforms WHERE code = ?', ['facebook'])
  const accountId = generateUuid()
  await query(
    `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id, platform_username, platform_display_name, token_type, access_token, token_expires_at, verification_status, webhook_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'page', ?, DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified', 'active')`,
    [uuidToBuffer(accountId), uuidToBuffer(userId), platform.id, `https://fb.com/${pageId}`, pageId, `user_${pageId}`, `Page ${pageId}`, encrypt('mock_page_token')]
  )
  return accountId
}

async function insertFbPhotoPostTarget(userId, pageId) {
  const accountId = await insertFbPageAccount(userId, pageId)
  const postId = generateUuid()
  const targetId = generateUuid()
  const photoId = `77${generateUuid().replace(/[^0-9]/g, '').slice(0, 15)}`
  const promotableId = `${pageId}_88${generateUuid().replace(/[^0-9]/g, '').slice(0, 15)}`
  await query('DELETE FROM posts WHERE id = ?', [uuidToBuffer(postId)])
  await query(
    `INSERT INTO posts (id, client_id, name, type, status, boost_enabled, caption, media_url, created_at, updated_at)
     VALUES (?, ?, 'Webhook photo post', 'post', 'completed', 1, 'caption', 'https://example.com/img.jpg', NOW(), NOW())`,
    [uuidToBuffer(postId), uuidToBuffer(userId)]
  )
  await query(
    `INSERT INTO post_targets (id, post_id, platform_account_id, target_type, status, publish_state, meta_object_id, promotable_id, posted_at, created_at)
     VALUES (?, ?, ?, 'client', 'posted', 'published', ?, ?, NOW(), NOW())`,
    [uuidToBuffer(targetId), uuidToBuffer(postId), uuidToBuffer(accountId), photoId, promotableId]
  )
  return { postId, targetId, photoId, promotable: promotableId, accountId }
}

beforeAll(async () => {
  process.env.META_WEBHOOK_VERIFY_TOKEN = 'test_verify_token'
  process.env.META_WEBHOOK_APP_SECRET = WEBHOOK_SECRET
  process.env.META_SYSTEM_USER_TOKEN = 'test_system_user_token'
  process.env.META_AD_ACCOUNT_ID = 'act_env_fallback'
  const mod = await import('../../app.js')
  app = mod.default
  await cleanup()
})

beforeEach(async () => {
  await cleanup()
})

afterAll(async () => {
  await cleanup()
})

describe('meta webhook signature + verification', () => {
  it('verifies a correct X-Hub-Signature-256', () => {
    const raw = JSON.stringify({ hello: 'world' })
    expect(webhookService.verifyWebhookSignature(raw, sign(raw), WEBHOOK_SECRET)).toBe(true)
  })

  it('rejects a tampered signature', () => {
    const raw = JSON.stringify({ hello: 'world' })
    expect(webhookService.verifyWebhookSignature(raw, `sha256=${'0'.repeat(64)}`, WEBHOOK_SECRET)).toBe(false)
  })

  it('rejects when no secret or signature is present', () => {
    expect(webhookService.verifyWebhookSignature('raw', null, WEBHOOK_SECRET)).toBe(false)
    expect(webhookService.verifyWebhookSignature('raw', 'sha256=abc', null)).toBe(false)
  })

  it('GET challenge succeeds with the right verify token', async () => {
    const res = await supertest(app).get('/api/v1/meta/webhook')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'test_verify_token', 'hub.challenge': 'challenge_123' })
    expect(res.status).toBe(200)
    expect(res.text).toBe('challenge_123')
  })

  it('GET challenge fails with a wrong verify token', async () => {
    const res = await supertest(app).get('/api/v1/meta/webhook')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'challenge_123' })
    expect(res.status).toBe(403)
  })

  it('POST without a valid signature is rejected 401', async () => {
    const res = await supertest(app).post('/api/v1/meta/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=deadbeef')
      .send({ object: 'ad_account', entry: [] })
    expect(res.status).toBe(401)
  })
})

describe('meta webhook event processing', () => {
  it('applies a PAUSED status update to a running campaign', async () => {
    const user = await createTestUser({ email: `whk1-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 1000 })
    const { campaign, fbId } = await seedRunningCampaign(user.id)

    const body = statusUpdateEvent(fbId, 'PAUSED')
    const result = await webhookService.processMetaWebhookEvents(body)
    expect(result.processed).toBe(1)

    const after = await repo.findCampaignById(campaign.id)
    expect(after.status).toBe('paused')
    expect(after.metaStatus).toBe('paused')
  })

  it('applies an ACTIVE status update to a paused campaign (resume)', async () => {
    const user = await createTestUser({ email: `whk2-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 1000 })
    const { campaign, fbId } = await seedRunningCampaign(user.id)
    await repo.updateCampaignStatus(campaign.id, 'paused')

    const result = await webhookService.processMetaWebhookEvents(statusUpdateEvent(fbId, 'ACTIVE'))
    expect(result.processed).toBe(1)

    const after = await repo.findCampaignById(campaign.id)
    expect(after.status).toBe('running')
    expect(after.metaStatus).toBe('active')
  })

  it('marks a campaign failed when ad.delivery_signals reports DISAPPROVED', async () => {
    const user = await createTestUser({ email: `whk6-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 1000 })
    const { campaign, fbId, adId } = await seedRunningCampaign(user.id)

    const body = {
      object: 'ad_account',
      entry: [{
        id: `entry_${generateUuid()}`,
        time: Math.floor(Date.now() / 1000),
        changes: [{
          field: 'ad.delivery_signals',
          value: { campaign_id: fbId, ad_id: adId, status: 'DISAPPROVED' },
        }],
      }],
    }
    const result = await webhookService.processMetaWebhookEvents(body)
    expect(result.processed).toBe(1)
    expect(result.results[0].outcome.outcomes[0].statusAfter).toBe('failed')

    const after = await repo.findCampaignById(campaign.id)
    expect(after.status).toBe('failed')
    expect(after.metaStatus).toBe('failed')
    expect(after.metaError).toContain('disapproved')
  })

  it('archives on ARCHIVED status update and enqueues a settle job', async () => {
    const user = await createTestUser({ email: `whk3-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 1000 })
    const { campaign, fbId } = await seedRunningCampaign(user.id)

    const result = await webhookService.processMetaWebhookEvents(statusUpdateEvent(fbId, 'ARCHIVED'))
    expect(result.processed).toBe(1)
    expect(result.results[0].outcome.archived).toBe(true)

    const after = await repo.findCampaignById(campaign.id)
    expect(after.metaStatus).toBe('archived')

    const jobs = await query('SELECT job_type FROM campaign_jobs WHERE campaign_id = ?', [uuidToBuffer(campaign.id)])
    expect(jobs.map(j => j.job_type)).toContain('settle_campaign')
  })

  it('records spend via campaign_daily_spend and updates meta spend monotonically', async () => {
    const user = await createTestUser({ email: `whk4-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 1000 })
    const { campaign, fbId } = await seedRunningCampaign(user.id)

    const result = await webhookService.processMetaWebhookEvents(spendEvent(fbId, '125.50'))
    expect(result.processed).toBe(1)
    expect(result.results[0].outcome.spendPaise).toBe(12550)

    const after = await repo.findCampaignById(campaign.id)
    expect(after.metaSpentPaise).toBe(12550)

    await webhookService.processMetaWebhookEvents(spendEvent(fbId, '100.00'))
    const afterLower = await repo.findCampaignById(campaign.id)
    expect(afterLower.metaSpentPaise).toBe(12550)
  })

  it('tracks PENDING_REVIEW status without changing internal status', async () => {
    const user = await createTestUser({ email: `whk7-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 1000 })
    const { campaign, fbId } = await seedRunningCampaign(user.id)

    const result = await webhookService.processMetaWebhookEvents(statusUpdateEvent(fbId, 'PENDING_REVIEW'))
    expect(result.processed).toBe(1)

    const after = await repo.findCampaignById(campaign.id)
    expect(after.status).toBe('running')
    expect(after.metaStatus).toBe('pending_review')
  })

  it('tracks WITH_ISSUES status without failing the campaign', async () => {
    const user = await createTestUser({ email: `whk8-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 1000 })
    const { campaign, fbId } = await seedRunningCampaign(user.id)

    const result = await webhookService.processMetaWebhookEvents(statusUpdateEvent(fbId, 'WITH_ISSUES'))
    expect(result.processed).toBe(1)

    const after = await repo.findCampaignById(campaign.id)
    expect(after.status).toBe('running')
    expect(after.metaStatus).toBe('with_issues')
  })

  it('tracks PENDING_BILLING_INFO status without failing the campaign', async () => {
    const user = await createTestUser({ email: `whk9-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 1000 })
    const { campaign, fbId } = await seedRunningCampaign(user.id)

    const result = await webhookService.processMetaWebhookEvents(statusUpdateEvent(fbId, 'PENDING_BILLING_INFO'))
    expect(result.processed).toBe(1)

    const after = await repo.findCampaignById(campaign.id)
    expect(after.status).toBe('running')
    expect(after.metaStatus).toBe('pending_billing_info')
  })

  it('tracks PREAPPROVED status without changing internal status', async () => {
    const user = await createTestUser({ email: `whk10-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 1000 })
    const { campaign, fbId } = await seedRunningCampaign(user.id)

    const result = await webhookService.processMetaWebhookEvents(statusUpdateEvent(fbId, 'PREAPPROVED'))
    expect(result.processed).toBe(1)

    const after = await repo.findCampaignById(campaign.id)
    expect(after.status).toBe('running')
    expect(after.metaStatus).toBe('preapproved')
  })

  it('dedupes redelivered events by entry id', async () => {
    const user = await createTestUser({ email: `whk5-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 1000 })
    const { campaign, fbId } = await seedRunningCampaign(user.id)

    const body = statusUpdateEvent(fbId, 'PAUSED')
    await webhookService.processMetaWebhookEvents(body)
    const second = await webhookService.processMetaWebhookEvents(body)

    expect(second.duplicates).toBe(1)
    expect(second.processed).toBe(0)

    const rows = await query('SELECT COUNT(*) AS n FROM meta_webhook_events')
    expect(Number(rows[0].n)).toBe(1)
  })

  it('ignores unsupported fields and unknown campaigns', async () => {
    const result = await webhookService.processMetaWebhookEvents({
      object: 'ad_account',
      entry: [{
        id: `entry_${generateUuid()}`,
        time: Math.floor(Date.now() / 1000),
        changes: [{ field: 'some_random_field', value: { whatever: 1 } }],
      }],
    })
    expect(result.processed).toBe(1)
    expect(result.results[0].outcome.ignored).toBe(true)
    expect(result.results[0].outcome.reason).toBe('unsupported_field')

    const unknown = await webhookService.processMetaWebhookEvents(statusUpdateEvent(`fb_nonexistent_${generateUuid()}`, 'PAUSED'))
    expect(unknown.results[0].outcome.ignored).toBe(true)
    expect(unknown.results[0].outcome.reason).toBe('unknown_campaign')
  })

  it('POST end-to-end with valid signature processes and responds', async () => {
    const user = await createTestUser({ email: `whk6-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 1000 })
    const { campaign, fbId } = await seedRunningCampaign(user.id)

    const body = statusUpdateEvent(fbId, 'PAUSED')
    const raw = JSON.stringify(body)
    const res = await supertest(app).post('/api/v1/meta/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(raw))
      .send(body)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.processed).toBe(1)

    const after = await repo.findCampaignById(campaign.id)
    expect(after.status).toBe('paused')
  })

  it('feed reaction on a photo target matches via promotable_id, enqueues engagement sync and fixes the stored id', async () => {
    const user = await createTestUser({ email: `whk7-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 1000 })
    const pageId = `page_${generateUuid().substring(0, 8)}`
    const postId = await insertFbPhotoPostTarget(user.id, pageId)

    const result = await webhookService.processMetaWebhookEvents({
      object: 'page',
      entry: [{
        id: pageId,
        time: Math.floor(Date.now() / 1000),
        changes: [{
          field: 'feed',
          value: {
            from: { id: `user_${generateUuid().substring(0, 8)}`, name: 'Test User' },
            post_id: postId.promotable,
            parent_id: postId.promotable,
            item: 'reaction',
            reaction_type: 'like',
            verb: 'add',
            created_time: Math.floor(Date.now() / 1000),
          },
        }],
      }],
    })

    expect(result.queued).toBe(1)
    const inboxRow = await queryOne('SELECT id FROM meta_webhook_events WHERE object_type = ? AND external_object_id = ?', ['page', postId.promotable])
    const outcome = await webhookService.processWebhookEventById(inboxRow.id)
    expect(outcome.ignored).toBeUndefined()
    expect(outcome.engagementRefreshQueued).toBe(true)

    const jobs = await query(
      "SELECT run_key FROM campaign_jobs WHERE job_type = 'post_sync_engagement_target' AND campaign_id = ?",
      [uuidToBuffer(postId.postId)]
    )
    expect(jobs.length).toBeGreaterThan(0)
    expect(jobs[0].run_key).toBe(`eng-target:${postId.targetId}`)

    const target = await queryOne('SELECT meta_object_id, last_engagement_event_at FROM post_targets WHERE id = ?', [uuidToBuffer(postId.targetId)])
    expect(target.meta_object_id).toBe(postId.promotable)
    expect(target.last_engagement_event_at).not.toBeNull()

    const row = await queryOne('SELECT processing_status, last_error FROM meta_webhook_events WHERE object_type = ? AND external_object_id = ?', ['page', postId.promotable])
    expect(row.processing_status).toBe('processed')
    expect(row.last_error).toBeNull()
  })

  it('feed event for an unknown post records ignored with reason persisted', async () => {
    const user = await createTestUser({ email: `whk8-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 1000 })
    const pageId = `page_${generateUuid().substring(0, 8)}`
    await insertFbPageAccount(user.id, pageId)
    const unknownPostId = `${pageId}_99${generateUuid().replace(/[^0-9]/g, '').slice(0, 15)}`

    await webhookService.processMetaWebhookEvents({
      object: 'page',
      entry: [{
        id: pageId,
        time: Math.floor(Date.now() / 1000),
        changes: [{
          field: 'feed',
          value: {
            from: { id: `user_${generateUuid().substring(0, 8)}`, name: 'Test User' },
            post_id: unknownPostId,
            item: 'reaction',
            reaction_type: 'like',
            verb: 'add',
          },
        }],
      }],
    })

    const row0 = await queryOne('SELECT id FROM meta_webhook_events WHERE object_type = ? AND external_object_id = ?', ['page', unknownPostId])
    const outcome = await webhookService.processWebhookEventById(row0.id)
    expect(outcome.ignored).toBe(true)
    expect(outcome.reason).toBe('unknown_target')

    const row = await queryOne('SELECT processing_status, last_error FROM meta_webhook_events WHERE object_type = ? AND external_object_id = ?', ['page', unknownPostId])
    expect(row.processing_status).toBe('ignored')
    expect(row.last_error).toBe('unknown_target')
  })

  it('async worker path persists the ignore reason too', async () => {
    const user = await createTestUser({ email: `whk9-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 1000 })
    const pageId = `page_${generateUuid().substring(0, 8)}`
    await insertFbPageAccount(user.id, pageId)
    const unknownPostId = `${pageId}_88${generateUuid().replace(/[^0-9]/g, '').slice(0, 15)}`

    const result = await webhookService.processMetaWebhookEvents({
      object: 'page',
      entry: [{
        id: pageId,
        time: Math.floor(Date.now() / 1000),
        changes: [{
          field: 'feed',
          value: {
            post_id: unknownPostId,
            item: 'reaction',
            reaction_type: 'like',
            verb: 'add',
          },
        }],
      }],
    })
    expect(result.queued).toBe(1)
    const row0 = await queryOne('SELECT id, processing_status FROM meta_webhook_events WHERE object_type = ? AND external_object_id = ?', ['page', unknownPostId])
    expect(['received', 'processing', 'ignored']).toContain(row0.processing_status)

    const outcome = await webhookService.processWebhookEventById(row0.id)
    expect(outcome.ignored).toBe(true)
    expect(outcome.reason === 'unknown_target' || outcome.reason === 'already_processed').toBe(true)

    const row = await queryOne('SELECT processing_status, last_error FROM meta_webhook_events WHERE id = ?', [row0.id])
    expect(row.processing_status).toBe('ignored')
    expect(row.last_error).toBe('unknown_target')
  })

  it('IG comments with nested media.id matches the target and enqueues engagement sync', async () => {
    const user = await createTestUser({ email: `whk10-${Date.now()}@flowx-test.com`, password: 'Test@123', coins: 1000 })
    const igAccountId = generateUuid()
    const igMediaId = `18${generateUuid().replace(/[^0-9]/g, '').slice(0, 16)}`
    const postId = generateUuid()
    const targetId = generateUuid()
    const platform = await queryOne('SELECT id FROM platforms WHERE code = ?', ['instagram'])
    const { encrypt } = await import('../../shared/utils/crypto.utils.js')
    await query(
      `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id, platform_username, platform_display_name, instagram_business_account_id, token_type, access_token, token_expires_at, verification_status, webhook_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'page', ?, DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified', 'active')`,
      [uuidToBuffer(igAccountId), uuidToBuffer(user.id), platform.id, `https://ig.com/${igMediaId}`, `ig_${generateUuid().substring(0, 8)}`, 'ig_user', 'IG User', '17841400000000001', encrypt('mock_ig_token')]
    )
    await query(
      `INSERT INTO posts (id, client_id, name, type, status, caption, media_url, created_at, updated_at)
       VALUES (?, ?, 'Webhook IG post', 'post', 'completed', 'caption', 'https://example.com/img.jpg', NOW(), NOW())`,
      [uuidToBuffer(postId), uuidToBuffer(user.id)]
    )
    await query(
      `INSERT INTO post_targets (id, post_id, platform_account_id, target_type, status, publish_state, meta_object_id, posted_at, created_at)
       VALUES (?, ?, ?, 'client', 'posted', 'published', ?, NOW(), NOW())`,
      [uuidToBuffer(targetId), uuidToBuffer(postId), uuidToBuffer(igAccountId), igMediaId]
    )

    const result = await webhookService.processMetaWebhookEvents({
      object: 'instagram',
      entry: [{
        id: '17841400000000001',
        time: Math.floor(Date.now() / 1000),
        changes: [{
          field: 'comments',
          value: {
            from: { id: `from_${generateUuid().substring(0, 8)}`, username: ' commenter' },
            media: { id: igMediaId, media_product_type: 'FEED' },
            id: `18${generateUuid().replace(/[^0-9]/g, '').slice(0, 16)}`,
            text: 'nice post',
          },
        }],
      }],
    })
    expect(result.queued).toBe(1)
    const inboxRow = await queryOne('SELECT id, external_object_id FROM meta_webhook_events WHERE object_type = ? AND platform = ?', ['instagram', 'instagram'])
    expect(inboxRow.external_object_id).toBe(igMediaId)

    const outcome = await webhookService.processWebhookEventById(inboxRow.id)
    expect(outcome.ignored).toBeUndefined()
    expect(outcome.engagementRefreshQueued).toBe(true)

    const jobs = await query(
      "SELECT run_key FROM campaign_jobs WHERE job_type = 'post_sync_engagement_target' AND campaign_id = ?",
      [uuidToBuffer(postId)]
    )
    expect(jobs.length).toBeGreaterThan(0)
    expect(jobs[0].run_key).toBe(`eng-target:${targetId}`)

    const row = await queryOne('SELECT processing_status, last_error FROM meta_webhook_events WHERE id = ?', [inboxRow.id])
    expect(row.processing_status).toBe('processed')
    expect(row.last_error).toBeNull()
  })
})
