import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as execRepo from '../../src/modules/campaigns/campaign-execution.repository.js'
import * as subRepo from '../../src/modules/subscriptions/subscription.repository.js'
import * as coinService from '../../shared/services/coin.service.js'
import { query, queryOne } from '../../shared/database/connection.js'
import { drainCampaignJobs } from '../../src/modules/campaigns/campaign.jobs.js'
import { CAMPAIGN_JOB_TYPES } from '../../src/modules/campaigns/campaign.model.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    __counter: 0,
    __nextMetaId: prefix => {
      mocks.__counter += 1
      return `pubasy_${prefix}_${mocks.__counter}`
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
    getMetaObject: vi.fn().mockImplementation(async id => ({ id })),
    listAccountCampaigns: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    listCampaignAdSets: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    listAdSetAds: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
  }
  metaMocks = mocks
  return mocks
})

const dateTag = Date.now()

async function setFlag(key, on) {
  await query(
    `INSERT INTO app_config (id, config_key, config_value, is_public, description, version)
     VALUES (?, ?, ?, 0, 'test', 1)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [uuidToBuffer(generateUuid()), key, JSON.stringify(on)]
  )
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

async function addVerifiedPage(userId, platformUserId) {
  const fbPlatform = await queryOne("SELECT id FROM platforms WHERE code = 'facebook'")
  if (!fbPlatform) return
  await query(
    `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id, platform_username, token_type, token_expires_at, verification_status)
     VALUES (?, ?, ?, ?, ?, ?, 'page', DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
    [uuidToBuffer(generateUuid()), uuidToBuffer(userId), fbPlatform.id, 'https://fb.com/test', platformUserId, 'TestPage']
  )
}

async function techCategoryId() {
  const cat = await queryOne("SELECT id FROM ad_categories WHERE code = 'technology'")
  return bufferToUuid(cat.id)
}

let freshCounter = 0

async function freshClient(tag) {
  freshCounter += 1
  const user = await createTestUser({ email: `pubasy-${tag}-${freshCounter}-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 20000 })
  await ensurePlan(user.id)
  await addVerifiedPage(user.id, `pubasy_page_${tag}_${freshCounter}_${dateTag}`)
  return user
}

async function seedPublisherCampaign(clientId, { publisherCount = 1, coinsPerPublisher = 50 } = {}) {
  const owner = clientId || (await freshClient('owner')).id
  const categoryId = await techCategoryId()
  const campaign = await campaignService.createCampaign(owner, {
    name: `PubAsync ${dateTag} ${generateUuid().substring(0, 4)}`,
    type: 'post',
    categoryId,
    publisherCount,
    coinsPerPublisher,
  })
  await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'async publisher', mediaUrl: 'https://example.com/img.jpg' })
  await campaignRepo.createMetaSettings(generateUuid(), campaign.id, {
    objective: 'OUTCOME_TRAFFIC',
    budgetType: 'lifetime',
    budgetAmount: 500,
    endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  })
  await campaignService.submitCampaign(owner, campaign.id)
  return campaign.id
}

async function activeJobs(campaignId, jobType) {
  const rows = await query(
    `SELECT HEX(id) AS id, status FROM campaign_jobs WHERE campaign_id = ? AND job_type = ? AND status IN ('queued','running')`,
    [uuidToBuffer(campaignId), jobType]
  )
  return rows
}

describe('publisher async 202 approval flow (Step 13)', () => {
  let client, publisher, adminId

  beforeAll(async () => {
    await setFlag('campaign_execution_runtime_enabled', false)
    client = await createTestUser({ email: `pubasy-client-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 20000 })
    publisher = await createTestUser({ email: `pubasy-pub-${dateTag}@flowx-test.com`, password: 'Test@123', role: 'publisher' })
    await ensurePlan(client.id)
    await addVerifiedPage(client.id, `pubasy_page_${dateTag}`)
    await addVerifiedPage(publisher.id, `pubasy_pub_page_${dateTag}`)
    await campaignRepo.setPublisherCategories(publisher.id, [await techCategoryId()])
    const adminRow = await queryOne("SELECT id FROM users WHERE email = 'admin@flowx.com'")
    adminId = adminRow ? bufferToUuid(adminRow.id) : client.id
  })

  afterAll(async () => {
    await setFlag('campaign_execution_runtime_enabled', false)
  })

  it('1. publisher approve returns 202 with job/execution identity and changes nothing yet', async () => {
    const owner1 = await freshClient('t1')
    const campaignId = await seedPublisherCampaign(owner1.id)
    const before = await coinService.getAvailable(owner1.id)
    const result = await campaignService.approveCampaign(adminId, campaignId, {})
    expect(result.queued).toBe(true)
    expect(result.jobId).toBeTruthy()
    expect(result.executionId).toBeTruthy()
    expect(result.campaign).toBeTruthy()
    expect(result.campaign.id).toBe(campaignId)
    const updated = await campaignRepo.findCampaignById(campaignId)
    expect(updated.status).toBe('pending_review')
    expect((await coinService.getAvailable(owner1.id)).total).toBe(before.total)
    expect(await campaignRepo.findPublisherRequestsByCampaignId(campaignId)).toHaveLength(0)
    const execution = await execRepo.findExecutionByOwner(campaignId, owner1.id, 'client')
    expect(execution.id).toBe(result.executionId)
    expect(execution.status).toBe('pending')
  })

  it('2/3. insufficient coins and Meta pre-validation failure reject synchronously with no side effects', async () => {
    const poor = await createTestUser({ email: `pubasy-poor-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 0 })
    await query('UPDATE user_wallets SET coins = 0 WHERE user_id = ?', [uuidToBuffer(poor.id)])
    await query('DELETE FROM user_subscriptions WHERE user_id = ?', [uuidToBuffer(poor.id)])
    const poorId = await seedPublisherCampaign(poor.id, { publisherCount: 100, coinsPerPublisher: 100000 })
    await expect(campaignService.approveCampaign(adminId, poorId, {})).rejects.toThrow(/insufficient coins/i)
    expect(await activeJobs(poorId, CAMPAIGN_JOB_TYPES.APPROVE_PUBLISHER)).toHaveLength(0)
    expect(await execRepo.findExecutionsByCampaignId(poorId)).toHaveLength(0)

    const campaignId = await seedPublisherCampaign()
    metaMocks.createAdCreative.mockImplementationOnce((...args) => {
      if (args[args.length - 1] === true) {
        return Promise.reject(new Error(`Graph API failed: ${JSON.stringify({ error: { error_user_msg: 'bad page', error_subcode: 100 } })}`))
      }
      return Promise.resolve({ id: 'pubasy_should_not_exist' })
    })
    await expect(campaignService.approveCampaign(adminId, campaignId, {})).rejects.toThrow(/bad page/)
    expect(await activeJobs(campaignId, CAMPAIGN_JOB_TYPES.APPROVE_PUBLISHER)).toHaveLength(0)
    expect(await execRepo.findExecutionsByCampaignId(campaignId)).toHaveLength(0)
    const updated = await campaignRepo.findCampaignById(campaignId)
    expect(updated.status).toBe('pending_review')
  })

  it('4/17/18/19. quarantined campaigns are refused with no job, spend, or execution', async () => {
    const escrowId = await seedPublisherCampaign()
    await query('UPDATE campaigns SET escrow_amount = 550 WHERE id = ?', [uuidToBuffer(escrowId)])
    await expect(campaignService.approveCampaign(adminId, escrowId, {})).rejects.toThrow(/uarantined/)
    expect(await activeJobs(escrowId, CAMPAIGN_JOB_TYPES.APPROVE_PUBLISHER)).toHaveLength(0)
    expect(await execRepo.findExecutionsByCampaignId(escrowId)).toHaveLength(0)

    const anomalyId = await seedPublisherCampaign()
    await query('UPDATE campaigns SET charged_ad_budget_paise = 10000 WHERE id = ?', [uuidToBuffer(anomalyId)])
    for (let i = 0; i < 2; i += 1) {
      await campaignRepo.insertBillingEntry(anomalyId, {
        kind: 'charge', paise: 10000, coins: 100, rate: 1, paidFromMonthly: 0, paidFromWallet: 100, reason: `dup ${i}`,
      })
    }
    await expect(campaignService.approveCampaign(adminId, anomalyId, {})).rejects.toThrow(/uarantined/)
    expect(await activeJobs(anomalyId, CAMPAIGN_JOB_TYPES.APPROVE_PUBLISHER)).toHaveLength(0)
  })

  it('5. existing executions are reused, never overwritten', async () => {
    const owner5 = await freshClient('t5')
    const campaignId = await seedPublisherCampaign(owner5.id)
    await execRepo.createExecution({
      campaignId, ownerUserId: owner5.id, kind: 'client', status: 'failed',
      fbPageId: 'frozen_page', platformCampaignId: 'old_camp',
    })
    const result = await campaignService.approveCampaign(adminId, campaignId, {})
    expect(result.queued).toBe(true)
    const execution = await execRepo.findExecutionByOwner(campaignId, owner5.id, 'client')
    expect(execution.id).toBe(result.executionId)
    expect(execution.status).toBe('failed')
    expect(execution.fbPageId).toBe('frozen_page')
    expect(execution.platformCampaignId).toBe('old_camp')
    const rows = await execRepo.findExecutionsByCampaignId(campaignId)
    expect(rows).toHaveLength(1)
  })

  it('6/7/14. duplicate and concurrent approvals converge on one execution and one job', async () => {
    const campaignId = await seedPublisherCampaign()
    const [first, second] = await Promise.all([
      campaignService.approveCampaign(adminId, campaignId, {}),
      campaignService.approveCampaign(adminId, campaignId, {}),
    ])
    expect(first.queued).toBe(true)
    expect(second.queued).toBe(true)
    expect(second.jobId).toBe(first.jobId)
    expect(second.executionId).toBe(first.executionId)
    expect(await activeJobs(campaignId, CAMPAIGN_JOB_TYPES.APPROVE_PUBLISHER)).toHaveLength(1)
    expect(await execRepo.findExecutionsByCampaignId(campaignId)).toHaveLength(1)
    const third = await campaignService.approveCampaign(adminId, campaignId, {})
    expect(third.jobId).toBe(first.jobId)
    expect(await activeJobs(campaignId, CAMPAIGN_JOB_TYPES.APPROVE_PUBLISHER)).toHaveLength(1)
  })

  it('8. worker completes the staged approval: spend once, transition, requests', async () => {
    const owner8 = await freshClient('t8')
    const campaignId = await seedPublisherCampaign(owner8.id)
    const before = await coinService.getAvailable(owner8.id)
    await campaignService.approveCampaign(adminId, campaignId, {})
    await drainCampaignJobs()
    const updated = await campaignRepo.findCampaignById(campaignId)
    expect(updated.status).toBe('awaiting_publishers')
    expect(Number(updated.escrowAmount)).toBe(55)
    expect(updated.coinsEscrowedAt).toBeTruthy()
    expect((await coinService.getAvailable(owner8.id)).total).toBe(before.total - 1055)
    const requests = await campaignRepo.findPublisherRequestsByCampaignId(campaignId)
    expect(requests.length).toBeGreaterThan(0)
    expect(await activeJobs(campaignId, CAMPAIGN_JOB_TYPES.APPROVE_PUBLISHER)).toHaveLength(0)
  })

  it('worker failure leaves money untouched and the campaign retryable', async () => {
    const ownerFail = await freshClient('fail')
    const campaignId = await seedPublisherCampaign(ownerFail.id)
    await campaignService.approveCampaign(adminId, campaignId, {})
    const funds = await coinService.getAvailable(ownerFail.id)
    if (funds.total > 0) {
      await coinService.spend(ownerFail.id, funds.total, 'campaign_escrow', generateUuid(), 'drain probe')
    }
    await drainCampaignJobs()
    const updated = await campaignRepo.findCampaignById(campaignId)
    expect(updated.status).toBe('pending_review')
    expect(updated.coinsEscrowedAt).toBeNull()
    expect(updated.metaStatus).toBe('failed')
  })

  it('13/20/21. repeated workers spend exactly once; repeated approval after completion is rejected', async () => {
    const owner13 = await freshClient('t13')
    const campaignId = await seedPublisherCampaign(owner13.id)
    const before = await coinService.getAvailable(owner13.id)
    await campaignService.approveCampaign(adminId, campaignId, {})
    await campaignService.approvePublisherFlow(campaignId, adminId, { flow: 'approve' })
    await campaignService.approvePublisherFlow(campaignId, adminId, { flow: 'approve' })
    expect((await coinService.getAvailable(owner13.id)).total).toBe(before.total - 1055)
    const requests = await campaignRepo.findPublisherRequestsByCampaignId(campaignId)
    const requestCount = requests.length
    expect(requestCount).toBeGreaterThan(0)
    await campaignService.approvePublisherFlow(campaignId, adminId, { flow: 'approve' })
    expect((await coinService.getAvailable(owner13.id)).total).toBe(before.total - 1055)
    expect(await campaignRepo.findPublisherRequestsByCampaignId(campaignId)).toHaveLength(requestCount)
    await expect(campaignService.approveCampaign(adminId, campaignId, {})).rejects.toThrow(/pending review/)
  })

  it('concurrent workers spend exactly once', async () => {
    const ownerConc = await freshClient('conc')
    const campaignId = await seedPublisherCampaign(ownerConc.id)
    const before = await coinService.getAvailable(ownerConc.id)
    await campaignService.approveCampaign(adminId, campaignId, {})
    const results = await Promise.allSettled([
      campaignService.approvePublisherFlow(campaignId, adminId, { flow: 'approve' }),
      campaignService.approvePublisherFlow(campaignId, adminId, { flow: 'approve' }),
    ])
    const rejected = results.filter(r => r.status === 'rejected')
    if (rejected.length) {
      const { writeFileSync } = await import('node:fs')
      writeFileSync('/tmp/dbg-conc2.txt', rejected.map(r => String(r.reason?.stack || r.reason)).join('\n---\n'))
    }
    expect(results.every(r => r.status === 'fulfilled')).toBe(true)
    expect((await coinService.getAvailable(ownerConc.id)).total).toBe(before.total - 1055)
    const updated = await campaignRepo.findCampaignById(campaignId)
    expect(updated.status).toBe('awaiting_publishers')
  })

  it('confirm publisher branch is async with the same guarantees', async () => {
    const ownerConfirm = await freshClient('confirm')
    const categoryId = await techCategoryId()
    const campaign = await campaignService.createCampaign(ownerConfirm.id, {
      name: `PubAsyncConfirm ${dateTag}`, type: 'post', categoryId, publisherCount: 1, coinsPerPublisher: 50,
    })
    await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'confirm', mediaUrl: 'https://example.com/img.jpg' })
    await campaignRepo.createMetaSettings(generateUuid(), campaign.id, {
      objective: 'OUTCOME_TRAFFIC', budgetType: 'lifetime', budgetAmount: 500,
      endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    })
    await campaignService.submitCampaign(ownerConfirm.id, campaign.id)
    await campaignService.approveCampaign(adminId, campaign.id, { publisherCount: 1 })
    const before = await coinService.getAvailable(ownerConfirm.id)
    const result = await campaignService.confirmAdjustments(ownerConfirm.id, campaign.id)
    expect(result.queued).toBe(true)
    expect(result.jobId).toBeTruthy()
    expect(result.executionId).toBeTruthy()
    expect((await campaignRepo.findCampaignById(campaign.id)).status).toBe('approved')
    await drainCampaignJobs()
    const updated = await campaignRepo.findCampaignById(campaign.id)
    expect(updated.status).toBe('awaiting_publishers')
    expect(updated.clientConfirmed).toBe(true)
    expect((await coinService.getAvailable(ownerConfirm.id)).total).toBe(before.total - 1055)
  })

  it('client-only approve and adjustments approve keep their existing contracts', async () => {
    const ownerContracts = await freshClient('contracts')
    const solo = await campaignService.createCampaign(ownerContracts.id, { name: `PubAsync Solo ${dateTag}`, type: 'post' })
    await campaignRepo.createCreative(generateUuid(), solo.id, { caption: 'solo', mediaUrl: 'https://example.com/img.jpg' })
    await campaignService.submitCampaign(ownerContracts.id, solo.id)
    const queued = await campaignService.approveCampaign(adminId, solo.id, {})
    expect(queued.queued).toBe(true)
    const jobs = await activeJobs(solo.id, CAMPAIGN_JOB_TYPES.APPROVE_GO_LIVE)
    expect(jobs).toHaveLength(1)
    expect(await activeJobs(solo.id, CAMPAIGN_JOB_TYPES.APPROVE_PUBLISHER)).toHaveLength(0)

    const adjusted = await seedPublisherCampaign(ownerContracts.id)
    const syncResult = await campaignService.approveCampaign(adminId, adjusted, { publisherCount: 2 })
    expect(syncResult.queued).toBeFalsy()
    expect(syncResult.status).toBe('approved')
  })

  it('24. worker never touches snapshots, pages, or Meta objects', async () => {
    const campaignId = await seedPublisherCampaign()
    await campaignService.approveCampaign(adminId, campaignId, {})
    await drainCampaignJobs()
    expect(await campaignRepo.findCampaignSnapshot(campaignId)).toBeNull()
    const executions24 = await execRepo.findExecutionsByCampaignId(campaignId)
    expect(executions24).toHaveLength(1)
    const execution = executions24[0]
    expect(execution.configHash).toBeNull()
    expect(execution.fbPageId).toBeNull()
    const objects = await campaignRepo.findMetaObjectsByCampaignId(campaignId)
    expect(objects).toHaveLength(0)
  })

  it('10/11/12/16/22/23. end to end: 202 to RUNNING with one chain per owner', async () => {
    await setFlag('campaign_execution_runtime_enabled', true)
    try {
      const ownerE2E = await freshClient('e2e')
      const campaignId = await seedPublisherCampaign(ownerE2E.id)
      const staged = await campaignService.approveCampaign(adminId, campaignId, {})
      expect(staged.queued).toBe(true)
      await drainCampaignJobs()
      expect((await campaignRepo.findCampaignById(campaignId)).status).toBe('awaiting_publishers')
      const requests = await campaignRepo.findPublisherRequestsByCampaignId(campaignId)
      expect(requests.length).toBeGreaterThan(0)
      const request = requests.find(r => r.publisherId === publisher.id) || requests[0]
      const acceptingPublisher = request.publisherId
      if (acceptingPublisher !== publisher.id) {
        await addVerifiedPage(acceptingPublisher, `pubasy_fill_${dateTag}`)
      }
      await campaignService.acceptPublisherRequest(acceptingPublisher, request.id)
      await drainCampaignJobs()
      const updated = await campaignRepo.findCampaignById(campaignId)
      expect(updated.status).toBe('running')
      const clientObjects = await campaignRepo.findMetaObjectsForUser(campaignId, ownerE2E.id)
      expect(clientObjects).toHaveLength(4)
      expect(new Set(clientObjects.map(o => o.objectType)).size).toBe(4)
      const pubObjects = await campaignRepo.findMetaObjectsForUser(campaignId, acceptingPublisher)
      expect(pubObjects).toHaveLength(4)
      const clientExecution = await execRepo.findExecutionByOwner(campaignId, ownerE2E.id, 'client')
      expect(clientExecution.id).toBe(staged.executionId)
      expect(clientExecution.platformCampaignId).toBeTruthy()
      expect(clientExecution.fbPageId).toBeTruthy()
      const snapshot = await campaignRepo.findCampaignSnapshot(campaignId)
      expect(snapshot).toBeTruthy()
      const executions = await execRepo.findExecutionsByCampaignId(campaignId)
      expect(executions.map(e => `${e.ownerUserId}:${e.kind}`).sort()).toEqual(
        [...new Set(executions.map(e => `${e.ownerUserId}:${e.kind}`))].sort()
      )
    } finally {
      await setFlag('campaign_execution_runtime_enabled', false)
    }
  }, 120000)
})
