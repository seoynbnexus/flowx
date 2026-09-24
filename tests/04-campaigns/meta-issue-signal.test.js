import { describe, it, expect, beforeAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as webhookService from '../../src/modules/campaigns/meta-webhook.service.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'
import { query } from '../../shared/database/connection.js'
import { resetRateLimitState } from '../../shared/services/meta-rate-limiter.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    listAccountAds: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    getCampaignStatusesBatch: vi.fn().mockResolvedValue({}),
    getAdAccount: vi.fn().mockResolvedValue({ balance: '10.00', currency: 'INR', account_status: 1, disable_reason: null }),
  }
  metaMocks = mocks
  return mocks
})

const dateTag = Date.now()
let seq = 0
function tag(prefix) {
  seq += 1
  return `${prefix}_${seq}_${generateUuid()}`
}

async function ensurePlan(userId) {
  const sub = await subRepo.findUserSubscription(userId)
  if (sub) return
  const starter = await subRepo.findPlanBySlug('starter')
  if (starter) {
    await subRepo.upsertUserSubscription(userId, starter.id, {
      status: 'active',
      billingCycle: 'monthly',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    })
  }
}

async function seedRunningCampaign(userId, suffix) {
  const campaign = await campaignService.createCampaign(userId, {
    name: `MetaIssue ${suffix}`,
    type: 'post',
  })
  await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'issue signal', mediaUrl: 'https://example.com/x.jpg' })
  const adId = `ad_miss_${suffix}`
  await campaignRepo.createMetaObject(campaign.id, 'facebook_campaign', `fb_miss_${suffix}`, null, 'ACTIVE', userId)
  await campaignRepo.createMetaObject(campaign.id, 'ad_set', `adset_miss_${suffix}`, null, 'ACTIVE', userId)
  await campaignRepo.createMetaObject(campaign.id, 'ad_creative', `creative_miss_${suffix}`, null, 'ACTIVE', userId)
  await campaignRepo.createMetaObject(campaign.id, 'ad', adId, null, 'ACTIVE', userId)
  await campaignRepo.updateCampaignStatus(campaign.id, 'running')
  return { campaignId: campaign.id, adId, fbId: `fb_miss_${suffix}` }
}

async function seedWebhookCampaign(userId, suffix) {
  const campaign = await campaignRepo.createCampaign(generateUuid(), userId, {
    name: `MetaIssueWhk ${suffix}`,
    type: 'post',
  })
  const fbId = `fb_missw_${suffix}`
  await campaignRepo.createMetaObject(campaign.id, 'facebook_campaign', fbId, null, 'ACTIVE', userId)
  await campaignRepo.createMetaObject(campaign.id, 'ad_set', `as_missw_${suffix}`, null, 'ACTIVE', userId)
  const adId = `ad_missw_${suffix}`
  await campaignRepo.createMetaObject(campaign.id, 'ad', adId, null, 'ACTIVE', userId)
  await campaignRepo.updateCampaignStatus(campaign.id, 'running')
  return { campaignId: campaign.id, adId, fbId }
}

function statusUpdateEvent(fbCampaignId, status) {
  return {
    object: 'ad_account',
    entry: [{
      id: `entry_miss_${generateUuid()}`,
      time: Math.floor(Date.now() / 1000),
      changes: [{
        field: 'campaign.status_update',
        value: { campaign_id: fbCampaignId, ad_account_id: 'act_x', status },
      }],
    }],
  }
}

async function issueLogCount(campaignId) {
  const rows = await query('SELECT notes FROM campaign_review_log WHERE campaign_id = ?', [uuidToBuffer(campaignId)])
  return rows.filter(r => (r.notes || '').includes('Meta reported') || (r.notes || '').includes('Meta is reviewing')).length
}

describe('meta issue signal', () => {
  let client

  beforeAll(async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'test_system_user_token'
    process.env.META_AD_ACCOUNT_ID = 'act_test_account'
    resetRateLimitState()
    client = await createTestUser({
      email: `meta-issue-${dateTag}@flowx-test.com`,
      password: 'Test@123',
      coins: 10000,
    })
    await ensurePlan(client.id)
    await query('DELETE FROM campaign_jobs')
    await query('DELETE FROM campaign_daily_stats')
    await query('DELETE FROM campaign_billing_entries')
    await query('DELETE FROM meta_sync_state')
  })

  describe('sync path', () => {
    it('1. WITH_ISSUES with no repairable issue fails the campaign and unlocks edit+resubmit', async () => {
      const { campaignId, adId } = await seedRunningCampaign(client.id, tag('s'))
      metaMocks.listAccountAds.mockResolvedValue({
        rows: [{ id: adId, status: 'WITH_ISSUES', effective_status: 'WITH_ISSUES' }],
        truncated: false,
      })
      const result = await campaignService.syncAccountStatusJob('act_test_account')
      expect(result.success).toBe(true)
      const after = await campaignRepo.findCampaignById(campaignId)
      expect(after.metaStatus).toBe('with_issues')
      expect(after.metaError).toContain('may not be delivering')
      expect(after.metaError).toContain('Ads Manager')
      expect(after.status).toBe('failed')
      expect(await issueLogCount(campaignId)).toBe(1)
    })

    it('2. repeated WITH_ISSUES does not duplicate the review log', async () => {
      const { campaignId, adId } = await seedRunningCampaign(client.id, tag('s'))
      metaMocks.listAccountAds.mockResolvedValue({
        rows: [{ id: adId, status: 'WITH_ISSUES', effective_status: 'WITH_ISSUES' }],
        truncated: false,
      })
      await campaignService.syncAccountStatusJob('act_test_account')
      await campaignService.syncAccountStatusJob('act_test_account')
      const after = await campaignRepo.findCampaignById(campaignId)
      expect(after.metaStatus).toBe('with_issues')
      expect(await issueLogCount(campaignId)).toBe(1)
    })

    it('3. PENDING_BILLING_INFO sets meta_error and review log', async () => {
      const { campaignId, adId } = await seedRunningCampaign(client.id, tag('s'))
      metaMocks.listAccountAds.mockResolvedValue({
        rows: [{ id: adId, status: 'PENDING_BILLING_INFO', effective_status: 'PENDING_BILLING_INFO' }],
        truncated: false,
      })
      await campaignService.syncAccountStatusJob('act_test_account')
      const after = await campaignRepo.findCampaignById(campaignId)
      expect(after.metaStatus).toBe('pending_billing_info')
      expect(after.metaError).toContain('billing')
      expect(await issueLogCount(campaignId)).toBe(1)
    })

    it('4. PENDING_REVIEW sets meta_error and review log', async () => {
      const { campaignId, adId } = await seedRunningCampaign(client.id, tag('s'))
      metaMocks.listAccountAds.mockResolvedValue({
        rows: [{ id: adId, status: 'PENDING_REVIEW', effective_status: 'PENDING_REVIEW' }],
        truncated: false,
      })
      await campaignService.syncAccountStatusJob('act_test_account')
      const after = await campaignRepo.findCampaignById(campaignId)
      expect(after.metaStatus).toBe('pending_review')
      expect(after.metaError).toContain('review')
      expect(await issueLogCount(campaignId)).toBe(1)
    })

    it('5. ACTIVE after a repairable WITH_ISSUES clears the stale meta_error (campaign stays live for repair)', async () => {
      const { campaignId, adId } = await seedRunningCampaign(client.id, tag('s'))
      metaMocks.listAccountAds.mockResolvedValue({
        rows: [{
          id: adId, status: 'WITH_ISSUES', effective_status: 'WITH_ISSUES',
          issues_info: [{ level: 'AD', error_code: 2875006, error_summary: 'Media not wide enough', error_message: "Media not wide enough: Your ad won't run on Instagram.", error_type: 'HARD_ERROR' }],
        }],
        truncated: false,
      })
      await campaignService.syncAccountStatusJob('act_test_account')
      let after = await campaignRepo.findCampaignById(campaignId)
      expect(after.metaError).not.toBeNull()
      metaMocks.listAccountAds.mockResolvedValue({
        rows: [{ id: adId, status: 'ACTIVE', effective_status: 'ACTIVE' }],
        truncated: false,
      })
      await campaignService.syncAccountStatusJob('act_test_account')
      after = await campaignRepo.findCampaignById(campaignId)
      expect(after.metaStatus).toBe('active')
      expect(after.metaError).toBeNull()
      expect(after.status).toBe('running')
    })

    it('6. PAUSED behavior is preserved with no issue signal', async () => {
      const { campaignId, adId } = await seedRunningCampaign(client.id, tag('s'))
      metaMocks.listAccountAds.mockResolvedValue({
        rows: [{ id: adId, status: 'PAUSED', effective_status: 'PAUSED' }],
        truncated: false,
      })
      await campaignService.syncAccountStatusJob('act_test_account')
      const after = await campaignRepo.findCampaignById(campaignId)
      expect(after.status).toBe('paused')
      expect(after.metaStatus).toBe('paused')
      expect(after.metaError).toBeNull()
      expect(await issueLogCount(campaignId)).toBe(0)
    })

    it('7. DISAPPROVED still fails the campaign with the existing message', async () => {
      const { campaignId, adId } = await seedRunningCampaign(client.id, tag('s'))
      metaMocks.listAccountAds.mockResolvedValue({
        rows: [{ id: adId, status: 'DISAPPROVED', effective_status: 'DISAPPROVED' }],
        truncated: false,
      })
      await campaignService.syncAccountStatusJob('act_test_account')
      const after = await campaignRepo.findCampaignById(campaignId)
      expect(after.status).toBe('failed')
      expect(after.metaStatus).toBe('failed')
      expect(after.metaError).toBe('Ad disapproved by Meta')
    })

    it('13. campaign-level ACTIVE does not bury ad-level WITH_ISSUES', async () => {
      const { campaignId, adId, fbId } = await seedRunningCampaign(client.id, tag('s'))
      metaMocks.listAccountAds.mockResolvedValue({
        rows: [{ id: adId, status: 'WITH_ISSUES', effective_status: 'WITH_ISSUES' }],
        truncated: false,
      })
      metaMocks.getCampaignStatusesBatch.mockResolvedValue({ [fbId]: 'ACTIVE' })
      await campaignService.syncAccountStatusJob('act_test_account')
      const after = await campaignRepo.findCampaignById(campaignId)
      expect(after.metaStatus).toBe('with_issues')
      expect(after.metaError).toContain('Ads Manager')
      expect(await issueLogCount(campaignId)).toBe(1)
      metaMocks.getCampaignStatusesBatch.mockResolvedValue({})
    })

    it('14. campaign-level actionable status still refines ad-level WITH_ISSUES', async () => {
      const { campaignId, adId, fbId } = await seedRunningCampaign(client.id, tag('s'))
      metaMocks.listAccountAds.mockResolvedValue({
        rows: [{ id: adId, status: 'WITH_ISSUES', effective_status: 'WITH_ISSUES' }],
        truncated: false,
      })
      metaMocks.getCampaignStatusesBatch.mockResolvedValue({ [fbId]: 'PENDING_BILLING_INFO' })
      await campaignService.syncAccountStatusJob('act_test_account')
      const after = await campaignRepo.findCampaignById(campaignId)
      expect(after.metaStatus).toBe('pending_billing_info')
      expect(after.metaError).toContain('billing')
      metaMocks.getCampaignStatusesBatch.mockResolvedValue({})
    })
  })

  describe('webhook path', () => {
    it('8. WITH_ISSUES via webhook sets meta_error and one review log', async () => {
      const { campaignId, fbId } = await seedWebhookCampaign(client.id, tag('w'))
      const result = await webhookService.processMetaWebhookEvents(statusUpdateEvent(fbId, 'WITH_ISSUES'))
      expect(result.processed).toBeGreaterThanOrEqual(1)
      const after = await campaignRepo.findCampaignById(campaignId)
      expect(after.metaStatus).toBe('with_issues')
      expect(after.metaError).toContain('Ads Manager')
      expect(after.status).toBe('running')
      expect(await issueLogCount(campaignId)).toBe(1)
    })

    it('9. repeated WITH_ISSUES via webhook does not duplicate the review log', async () => {
      const { campaignId, fbId } = await seedWebhookCampaign(client.id, tag('w'))
      await webhookService.processMetaWebhookEvents(statusUpdateEvent(fbId, 'WITH_ISSUES'))
      await webhookService.processMetaWebhookEvents(statusUpdateEvent(fbId, 'WITH_ISSUES'))
      const after = await campaignRepo.findCampaignById(campaignId)
      expect(after.metaStatus).toBe('with_issues')
      expect(await issueLogCount(campaignId)).toBe(1)
    })

    it('10. PENDING_BILLING_INFO via webhook sets meta_error and review log', async () => {
      const { campaignId, fbId } = await seedWebhookCampaign(client.id, tag('w'))
      await webhookService.processMetaWebhookEvents(statusUpdateEvent(fbId, 'PENDING_BILLING_INFO'))
      const after = await campaignRepo.findCampaignById(campaignId)
      expect(after.metaStatus).toBe('pending_billing_info')
      expect(after.metaError).toContain('billing')
      expect(await issueLogCount(campaignId)).toBe(1)
    })

    it('11. PENDING_REVIEW via webhook sets meta_error and review log', async () => {
      const { campaignId, fbId } = await seedWebhookCampaign(client.id, tag('w'))
      await webhookService.processMetaWebhookEvents(statusUpdateEvent(fbId, 'PENDING_REVIEW'))
      const after = await campaignRepo.findCampaignById(campaignId)
      expect(after.metaStatus).toBe('pending_review')
      expect(after.metaError).toContain('review')
      expect(await issueLogCount(campaignId)).toBe(1)
    })

    it('12. ACTIVE via webhook after WITH_ISSUES clears the stale meta_error', async () => {
      const { campaignId, fbId } = await seedWebhookCampaign(client.id, tag('w'))
      await webhookService.processMetaWebhookEvents(statusUpdateEvent(fbId, 'WITH_ISSUES'))
      let after = await campaignRepo.findCampaignById(campaignId)
      expect(after.metaError).not.toBeNull()
      await webhookService.processMetaWebhookEvents(statusUpdateEvent(fbId, 'ACTIVE'))
      after = await campaignRepo.findCampaignById(campaignId)
      expect(after.metaStatus).toBe('active')
      expect(after.metaError).toBeNull()
    })
  })
})
