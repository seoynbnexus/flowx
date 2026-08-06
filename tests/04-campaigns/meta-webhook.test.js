import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import crypto from 'node:crypto'
import supertest from 'supertest'
import * as repo from '../../src/modules/campaigns/campaign.repository.js'
import * as webhookService from '../../src/modules/campaigns/meta-webhook.service.js'
import { query } from '../../shared/database/connection.js'
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
})
