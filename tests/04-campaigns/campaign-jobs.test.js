import { describe, it, expect, beforeAll, vi } from 'vitest'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as jobs from '../../src/modules/campaigns/campaign.jobs.js'
import { query, queryOne } from '../../shared/database/connection.js'
import { CAMPAIGN_JOB_TYPES } from '../../src/modules/campaigns/campaign.model.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    __counter: 0,
    __nextMetaId: (prefix) => {
      mocks.__counter += 1
      return `${prefix}_${mocks.__counter}`
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
    searchMeta: vi.fn().mockResolvedValue([]),
    getObjectStatus: vi.fn().mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' }),
  }
  metaMocks = mocks
  return mocks
})

const dateTag = Date.now()

async function createCampaign(userId, overrides = {}) {
  return campaignService.createCampaign(userId, {
    name: `JobTest ${generateUuid().substring(0, 8)}`,
    type: 'post',
    ...overrides,
  })
}

let pubCounter = 0

async function createAwaitingCampaign() {
  pubCounter += 1
  const user = await createTestUser({
    email: `job-pub-${dateTag}-${pubCounter}@flowx-test.com`,
    password: 'Test@123',
    coins: 5000,
  })
  const fbPlatform = await queryOne("SELECT id FROM platforms WHERE code = 'facebook'")
  if (fbPlatform) {
    const platformId = bufferToUuid(fbPlatform.id)
    await query(
      `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id, platform_username, token_type, token_expires_at, verification_status)
       VALUES (?, ?, ?, ?, ?, ?, 'page', DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
      [uuidToBuffer(generateUuid()), uuidToBuffer(user.id), uuidToBuffer(platformId), 'https://fb.com/jobtest', `fb_page_${dateTag}_${pubCounter}`, 'JobPage']
    )
  }
  const campaign = await createCampaign(user.id)
  await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'Job caption', mediaUrl: 'https://example.com/img.jpg' })
  await campaignRepo.updateCampaign(campaign.id, { status: 'awaiting_publishers' })
  return { campaign, userId: user.id }
}

async function jobRow(jobId) {
  return queryOne('SELECT * FROM campaign_jobs WHERE id = ?', [uuidToBuffer(jobId)])
}

describe('campaign job queue', () => {
  let clientId

  beforeAll(async () => {
    const client = await createTestUser({
      email: `job-client-${dateTag}@flowx-test.com`,
      password: 'Test@123',
      coins: 10000,
    })
    clientId = client.id
  })

  beforeEach(async () => {
    await query('DELETE FROM campaign_jobs')
  })

  it('dedupes identical queued/running jobs per campaign and type', async () => {
    const campaign = await createCampaign(clientId)

    const first = await campaignService.enqueueCampaignJob(campaign.id, CAMPAIGN_JOB_TYPES.FORCE_GO_LIVE)
    expect(first.enqueued).toBe(true)

    const dup = await campaignService.enqueueCampaignJob(campaign.id, CAMPAIGN_JOB_TYPES.FORCE_GO_LIVE)
    expect(dup.enqueued).toBe(false)

    const otherType = await campaignService.enqueueCampaignJob(campaign.id, CAMPAIGN_JOB_TYPES.RETRY_META)
    expect(otherType.enqueued).toBe(true)

    await campaignRepo.completeCampaignJob(first.jobId, 'done')
    const afterDone = await campaignService.enqueueCampaignJob(campaign.id, CAMPAIGN_JOB_TYPES.FORCE_GO_LIVE)
    expect(afterDone.enqueued).toBe(true)
    await campaignRepo.completeCampaignJob(otherType.jobId, 'done')
    await campaignRepo.completeCampaignJob(afterDone.jobId, 'done')
  })

  it('claims due jobs atomically and skips future run_after', async () => {
    const campaign = await createCampaign(clientId)

    const { jobId } = await campaignService.enqueueCampaignJob(campaign.id, CAMPAIGN_JOB_TYPES.RETRY_META)
    await query('UPDATE campaign_jobs SET run_after = DATE_ADD(NOW(), INTERVAL 60 SECOND) WHERE id = ?', [uuidToBuffer(jobId)])

    const claimed = await campaignRepo.claimDueCampaignJobs(2)
    expect(claimed).toEqual([])

    await query('UPDATE campaign_jobs SET run_after = NOW() WHERE id = ?', [uuidToBuffer(jobId)])
    const claimedNow = await campaignRepo.claimDueCampaignJobs(2)
    expect(claimedNow).toHaveLength(1)
    expect(claimedNow[0].id).toBe(jobId)
    expect(claimedNow[0].attempts).toBe(1)
    expect(claimedNow[0].status).toBe('running')
    expect(claimedNow[0].startedAt).toBeTruthy()

    const again = await campaignRepo.claimDueCampaignJobs(2)
    expect(again).toEqual([])
    await campaignRepo.completeCampaignJob(jobId, 'done')
  })

  it('concurrent claims never double-assign a job', async () => {
    const campaigns = []
    for (let i = 0; i < 6; i += 1) {
      campaigns.push(await createCampaign(clientId))
    }
    const jobIds = []
    for (const campaign of campaigns) {
      const { jobId } = await campaignService.enqueueCampaignJob(campaign.id, CAMPAIGN_JOB_TYPES.RETRY_META)
      jobIds.push(jobId)
    }

    const results = await Promise.all([
      campaignRepo.claimDueCampaignJobs(2),
      campaignRepo.claimDueCampaignJobs(2),
      campaignRepo.claimDueCampaignJobs(2),
    ])
    const claimedIds = results.flat().map(j => j.id)
    expect(claimedIds).toHaveLength(6)
    expect(new Set(claimedIds).size).toBe(6)

    for (const id of jobIds) {
      await campaignRepo.completeCampaignJob(id, 'done')
    }
  })

  it('requeues stale running jobs', async () => {
    const campaign = await createCampaign(clientId)
    const { jobId } = await campaignService.enqueueCampaignJob(campaign.id, CAMPAIGN_JOB_TYPES.RETRY_META)
    await campaignRepo.claimDueCampaignJobs(2)

    const stuck = await jobRow(jobId)
    expect(stuck.status).toBe('running')

    await query('UPDATE campaign_jobs SET started_at = DATE_SUB(NOW(), INTERVAL 20 MINUTE) WHERE id = ?', [uuidToBuffer(jobId)])
    await campaignRepo.requeueStaleCampaignJobs(10)
    const requeued = await jobRow(jobId)
    expect(requeued.status).toBe('queued')
    expect(requeued.started_at).toBeNull()
    await campaignRepo.completeCampaignJob(jobId, 'done')
  })

  it('kills jobs on permanent errors and marks the campaign failed', async () => {
    const { campaign } = await createAwaitingCampaign()
    await campaignRepo.updateCampaign(campaign.id, { status: 'pending_review' })

    metaMocks.createAdCampaign.mockRejectedValue(new Error('Graph API error: page not found'))

    const { jobId } = await campaignService.enqueueCampaignJob(campaign.id, CAMPAIGN_JOB_TYPES.APPROVE_GO_LIVE)
    await jobs.processDueJobs()

    const row = await jobRow(jobId)
    expect(row.status).toBe('dead')
    expect(row.error).toContain('page not found')

    const updated = await campaignRepo.findCampaignById(campaign.id)
    expect(updated.status).toBe('pending_review')
    expect(updated.metaStatus).toBe('failed')
    expect(updated.metaError).toContain('page not found')

    const logs = await query('SELECT * FROM campaign_review_log WHERE campaign_id = ?', [uuidToBuffer(campaign.id)])
    expect(logs.some(r => r.notes.includes('approve_go_live'))).toBe(true)
  })

  it('does not stamp metaStatus when the campaign is not in flight', async () => {
    const { campaign } = await createAwaitingCampaign()
    await campaignRepo.updateCampaign(campaign.id, { status: 'cancelled', metaStatus: 'created' })

    metaMocks.createAdCampaign.mockRejectedValue(new Error('boom'))
    const { jobId } = await campaignService.enqueueCampaignJob(campaign.id, CAMPAIGN_JOB_TYPES.APPROVE_GO_LIVE)
    await jobs.processDueJobs()

    const row = await jobRow(jobId)
    expect(row.status).toBe('dead')

    const updated = await campaignRepo.findCampaignById(campaign.id)
    expect(updated.metaStatus).toBe('created')
  })

  it('retries transient failures with backoff and dies after max attempts', async () => {
    const { campaign } = await createAwaitingCampaign()
    metaMocks.createAdCampaign.mockRejectedValue(new Error('transient network failure'))

    const { jobId } = await campaignService.enqueueCampaignJob(campaign.id, CAMPAIGN_JOB_TYPES.PUBLISHER_GO_LIVE)

    await jobs.processDueJobs()
    let row = await jobRow(jobId)
    expect(row.status).toBe('queued')
    expect(row.attempts).toBe(1)
    expect(row.error).toContain('transient network failure')
    expect(new Date(row.run_after).getTime()).toBeGreaterThan(Date.now())

    await query('UPDATE campaign_jobs SET run_after = NOW() WHERE id = ?', [uuidToBuffer(jobId)])
    await jobs.processDueJobs()
    row = await jobRow(jobId)
    expect(row.attempts).toBe(2)

    await query('UPDATE campaign_jobs SET run_after = NOW() WHERE id = ?', [uuidToBuffer(jobId)])
    await jobs.processDueJobs()
    row = await jobRow(jobId)
    expect(row.status).toBe('dead')
    expect(row.attempts).toBe(3)

    const updated = await campaignRepo.findCampaignById(campaign.id)
    expect(updated.metaStatus).toBe('failed')
    expect(updated.metaError).toContain('transient network failure')
  })

  it('drains queued jobs end to end and completes them', async () => {
    const { campaign } = await createAwaitingCampaign()
    metaMocks.createAdCampaign.mockReset().mockImplementation(async () => ({ id: metaMocks.__nextMetaId('mock_campaign') }))

    const { jobId } = await campaignService.enqueueCampaignJob(campaign.id, CAMPAIGN_JOB_TYPES.PUBLISHER_GO_LIVE)
    await jobs.drainCampaignJobs({ timeoutMs: 8000, pollMs: 100 })

    const row = await jobRow(jobId)
    expect(row.status).toBe('done')

    const updated = await campaignRepo.findCampaignById(campaign.id)
    expect(updated.status).toBe('running')
  })
})
