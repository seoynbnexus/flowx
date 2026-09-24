import { describe, it, expect, beforeAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as execRepo from '../../src/modules/campaigns/campaign-execution.repository.js'
import * as execService from '../../src/modules/campaigns/campaign-execution.service.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'
import { query, queryOne } from '../../shared/database/connection.js'
import { drainCampaignJobs } from '../../src/modules/campaigns/campaign.jobs.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    __counter: 0,
    __nextMetaId: prefix => {
      mocks.__counter += 1
      return `exec_${prefix}_${mocks.__counter}`
    },
    createAdCampaign: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('mock_campaign') })),
    createAdSet: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('mock_adset') })),
    createAdCreative: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('mock_creative') })),
    createAd: vi.fn().mockImplementation(async () => ({ id: mocks.__nextMetaId('mock_ad') })),
    updateAdStatus: vi.fn().mockResolvedValue({ success: true }),
    deleteAd: vi.fn().mockResolvedValue({}),
    deleteAdSet: vi.fn().mockResolvedValue({}),
    deleteAdCreative: vi.fn().mockResolvedValue({}),
    deleteAdCampaign: vi.fn().mockResolvedValue({}),
    getObjectStatus: vi.fn().mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' }),
  }
  metaMocks = mocks
  return mocks
})

const dateTag = Date.now()

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

async function addVerifiedPage(userId, platformUserId) {
  const fbPlatform = await queryOne("SELECT id FROM platforms WHERE code = 'facebook'")
  if (!fbPlatform) return
  await query(
    `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id, platform_username, token_type, token_expires_at, verification_status)
     VALUES (?, ?, ?, ?, ?, ?, 'page', DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
    [uuidToBuffer(generateUuid()), uuidToBuffer(userId), fbPlatform.id, 'https://fb.com/test', platformUserId, 'TestPage']
  )
}

function chainObjects(campaignId, ownerId, prefix) {
  return [
    { objectType: 'facebook_campaign', objectId: `${prefix}_camp`, createdForUserId: ownerId, createdAt: new Date('2026-01-01') },
    { objectType: 'ad_set', objectId: `${prefix}_set`, createdForUserId: ownerId, createdAt: new Date('2026-01-01') },
    { objectType: 'ad_creative', objectId: `${prefix}_cr`, createdForUserId: ownerId, createdAt: new Date('2026-01-01') },
    { objectType: 'ad', objectId: `${prefix}_ad`, createdForUserId: ownerId, createdAt: new Date('2026-01-01') },
  ]
}

describe('campaign executions (Phase 2 — shadow identity, no runtime wiring)', () => {
  let client, publisher, adminId

  beforeAll(async () => {
    await query(
      `INSERT INTO app_config (id, config_key, config_value, is_public, description, version)
       VALUES (?, 'campaign_execution_runtime_enabled', 'false', 0, 'test', 1)
       ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
      [uuidToBuffer(generateUuid())]
    )
    client = await createTestUser({ email: `exec-client-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    publisher = await createTestUser({ email: `exec-pub-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    await ensurePlan(client.id)
    await addVerifiedPage(client.id, `exec_page_${dateTag}`)
    await addVerifiedPage(publisher.id, `exec_pub_page_${dateTag}`)
    const adminRow = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    adminId = adminRow ? bufferToUuid(adminRow.id) : client.id
  })

  it('plans one client execution adopting the complete chain', async () => {
    const campaignId = generateUuid()
    const plans = execService.planExecutionsForCampaign({
      campaign: { id: campaignId, clientId: client.id, status: 'paused' },
      metaObjects: chainObjects(campaignId, client.id, 'solo'),
      publisherRequests: [],
    })
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({
      ownerUserId: client.id,
      kind: 'client',
      status: 'active',
      platformCampaignId: 'solo_camp',
      platformAdsetId: 'solo_set',
      platformCreativeId: 'solo_cr',
      platformAdId: 'solo_ad',
    })
    expect(plans[0].fbPageId).toBeNull()
  })

  it('plans per-owner executions and resolves duplicates latest-wins', async () => {
    const campaignId = generateUuid()
    const oldChain = chainObjects(campaignId, publisher.id, 'old').map(r => ({ ...r, createdAt: new Date('2026-01-01') }))
    const newChain = chainObjects(campaignId, publisher.id, 'new').map(r => ({ ...r, createdAt: new Date('2026-02-01') }))
    const plans = execService.planExecutionsForCampaign({
      campaign: { id: campaignId, clientId: client.id, status: 'running' },
      metaObjects: [...chainObjects(campaignId, client.id, 'cli'), ...oldChain, ...newChain],
      publisherRequests: [],
    })
    expect(plans).toHaveLength(2)
    const pub = plans.find(p => p.kind === 'publisher')
    expect(pub.platformCampaignId).toBe('new_camp')
    expect(pub.status).toBe('active')
  })

  it('plans pending executions for published requests missing chains, failed stays failed', async () => {
    const campaignId = generateUuid()
    const missingId = generateUuid()
    const failedId = generateUuid()
    const plans = execService.planExecutionsForCampaign({
      campaign: { id: campaignId, clientId: client.id, status: 'awaiting_publishers' },
      metaObjects: chainObjects(campaignId, client.id, 'cli'),
      publisherRequests: [
        { id: missingId, publisherId: publisher.id, status: 'published', createdAt: new Date() },
        { id: failedId, publisherId: generateUuid(), status: 'failed', createdAt: new Date() },
      ],
    })
    const missing = plans.find(p => p.publisherRequestId === missingId)
    expect(missing.status).toBe('pending')
    expect(missing.platformCampaignId).toBeNull()
    const failed = plans.find(p => p.publisherRequestId === failedId)
    expect(failed.status).toBe('failed')
  })

  it('plans nothing for zero-activity drafts and cancelled terminals', async () => {
    const draft = execService.planExecutionsForCampaign({
      campaign: { id: generateUuid(), clientId: client.id, status: 'draft' },
      metaObjects: [],
      publisherRequests: [],
    })
    expect(draft).toHaveLength(0)
    const cancelled = execService.planExecutionsForCampaign({
      campaign: { id: generateUuid(), clientId: client.id, status: 'cancelled' },
      metaObjects: [],
      publisherRequests: [],
    })
    expect(cancelled).toHaveLength(0)
  })

  it('marks chainless accepted requests on terminal parents failed, never pending', async () => {
    const campaignId = generateUuid()
    const requestId = generateUuid()
    const plans = execService.planExecutionsForCampaign({
      campaign: { id: campaignId, clientId: client.id, status: 'failed' },
      metaObjects: [],
      publisherRequests: [{ id: requestId, publisherId: publisher.id, status: 'accepted', createdAt: new Date() }],
    })
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ kind: 'publisher', status: 'failed', publisherRequestId: requestId })
  })

  it('maps terminal parents to terminal execution states without inventing money', async () => {
    const campaignId = generateUuid()
    for (const parent of ['completed', 'cancelled', 'failed']) {
      const plans = execService.planExecutionsForCampaign({
        campaign: { id: campaignId, clientId: client.id, status: parent },
        metaObjects: chainObjects(campaignId, client.id, `term_${parent}`),
        publisherRequests: [],
      })
      expect(plans).toHaveLength(1)
      expect(['completed', 'cancelled', 'failed']).toContain(plans[0].status)
    }
  })

  it('supports client-as-publisher dual role as two kinds', async () => {
    const campaignId = generateUuid()
    const requestId = generateUuid()
    const plans = execService.planExecutionsForCampaign({
      campaign: { id: campaignId, clientId: client.id, status: 'running' },
      metaObjects: chainObjects(campaignId, client.id, 'dual'),
      publisherRequests: [{ id: requestId, publisherId: client.id, status: 'published', createdAt: new Date() }],
    })
    expect(plans).toHaveLength(2)
    expect(plans.map(p => p.kind).sort()).toEqual(['client', 'publisher'])
  })

  it('adopt is idempotent and never overwrites existing rows', async () => {
    const campaignId = generateUuid()
    await campaignRepo.createCampaign(campaignId, client.id, { name: `Adopt ${dateTag}`, type: 'post' })
    const plans = execService.planExecutionsForCampaign({
      campaign: { id: campaignId, clientId: client.id, status: 'paused' },
      metaObjects: chainObjects(campaignId, client.id, 'idem'),
      publisherRequests: [],
    })
    const first = await execService.adoptExecution(plans[0])
    expect(first.created).toBe(true)
    await execRepo.updateExecution(first.execution.id, { error: 'operator note' })
    const second = await execService.adoptExecution({ ...plans[0], platformCampaignId: 'different_camp' })
    expect(second.created).toBe(false)
    expect(second.execution.id).toBe(first.execution.id)
    expect(second.execution.platformCampaignId).toBe('idem_camp')
    expect(second.execution.error).toBe('operator note')
  })

  it('enforces one live execution per campaign, owner and kind at the database', async () => {
    const campaignId = generateUuid()
    await campaignRepo.createCampaign(campaignId, client.id, { name: `Uniq ${dateTag}`, type: 'post' })
    await execRepo.createExecution({ campaignId, ownerUserId: client.id, kind: 'client', status: 'pending' })
    await expect(
      execRepo.createExecution({ campaignId, ownerUserId: client.id, kind: 'client', status: 'pending' })
    ).rejects.toThrow(/Duplicate entry/)
    await execRepo.createExecution({ campaignId, ownerUserId: client.id, kind: 'publisher', status: 'pending' })
    const rows = await execRepo.findExecutionsByCampaignId(campaignId)
    expect(rows).toHaveLength(2)
  })

  it('dual-write audit inserts missing meta object rows and ignores reruns', async () => {
    const campaignId = generateUuid()
    await campaignRepo.createCampaign(campaignId, client.id, { name: `Audit ${dateTag}`, type: 'post' })
    const chain = { facebook_campaign: 'audit_camp', ad_set: 'audit_set', ad_creative: 'audit_cr', ad: 'audit_ad' }
    const inserted = await execRepo.appendExecutionObjectAudit(campaignId, publisher.id, chain)
    expect(inserted).toBe(4)
    const again = await execRepo.appendExecutionObjectAudit(campaignId, publisher.id, chain)
    expect(again).toBe(0)
    const rows = await campaignRepo.findMetaObjectsForUser(campaignId, publisher.id)
    expect(rows).toHaveLength(4)
  })

  it('shadow rows are invisible to existing flows', async () => {
    const campaign = await campaignService.createCampaign(client.id, { name: `Shadow ${dateTag}`, type: 'post' })
    await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'shadow', mediaUrl: 'https://example.com/img.jpg' })
    await campaignRepo.createMetaSettings(generateUuid(), campaign.id, {
      objective: 'OUTCOME_TRAFFIC',
      budgetType: 'lifetime',
      budgetAmount: 500,
      endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    })
    await execRepo.createExecution({ campaignId: campaign.id, ownerUserId: client.id, kind: 'client', status: 'pending' })
    await campaignService.submitCampaign(client.id, campaign.id)
    const approved = await campaignService.approveCampaign(adminId, campaign.id, {})
    expect(approved.queued).toBe(true)
    await drainCampaignJobs()
    const updated = await campaignRepo.findCampaignById(campaign.id)
    expect(['running', 'scheduled']).toContain(updated.status)
    const shadow = await execRepo.findExecutionByOwner(campaign.id, client.id, 'client')
    expect(shadow.status).toBe('pending')
    const objects = await campaignRepo.findMetaObjectsByCampaignId(campaign.id)
    expect(objects).toHaveLength(4)
  })

  it('D1 guard rejects a second live accept for the same publisher', async () => {
    const campaignId = generateUuid()
    await campaignRepo.createCampaign(campaignId, client.id, { name: `D1 ${dateTag}`, type: 'post', publisherCount: 2 })
    await campaignRepo.createCreative(generateUuid(), campaignId, { caption: 'd1', mediaUrl: 'https://example.com/img.jpg' })
    await query('UPDATE campaigns SET status = ? WHERE id = ?', ['awaiting_publishers', uuidToBuffer(campaignId)])
    const firstId = generateUuid()
    const secondId = generateUuid()
    await query(
      `INSERT INTO campaign_publisher_requests (id, campaign_id, publisher_id, coins_offered, status) VALUES (?, ?, ?, 10, 'pending'), (?, ?, ?, 10, 'pending')`,
      [uuidToBuffer(firstId), uuidToBuffer(campaignId), uuidToBuffer(publisher.id), uuidToBuffer(secondId), uuidToBuffer(campaignId), uuidToBuffer(publisher.id)]
    )
    await campaignService.acceptPublisherRequest(publisher.id, firstId)
    await expect(campaignService.acceptPublisherRequest(publisher.id, secondId)).rejects.toThrow(/already hold a live request/)
  })
})
