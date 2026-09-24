import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import { loginAgent } from '../helpers/auth.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import * as campaignRepo from '../../src/modules/campaigns/campaign.repository.js'
import * as execRepo from '../../src/modules/campaigns/campaign-execution.repository.js'
import * as repairRepo from '../../src/modules/campaigns/repair.repository.js'
import * as repairService from '../../src/modules/campaigns/repair.service.js'
import { freezeCampaignSnapshotFor } from '../../src/modules/campaigns/campaign-execution.service.js'
import * as mediaRepo from '../../src/modules/media-library/media.repository.js'
import { query } from '../../shared/database/connection.js'

var metaMocks
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    listAccountAds: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    getObjectStatus: vi.fn().mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE' }),
    getMetaObject: vi.fn().mockResolvedValue({ id: 'x' }),
    getCampaignStatusesBatch: vi.fn().mockResolvedValue({}),
    getAdAccount: vi.fn().mockResolvedValue({ balance: '10.00', currency: 'INR', account_status: 1, disable_reason: null }),
    listAccountCreatives: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    listAdSetAds: vi.fn().mockResolvedValue({ rows: [], truncated: false }),
    createAdCreative: vi.fn(() => { throw new Error('Meta mutation attempted in status tests') }),
    createAdCampaign: vi.fn(() => { throw new Error('Meta mutation attempted in status tests') }),
    createAd: vi.fn(() => { throw new Error('Meta mutation attempted in status tests') }),
    deleteAdCreative: vi.fn(() => { throw new Error('Meta mutation attempted in status tests') }),
    deleteAd: vi.fn(() => { throw new Error('Meta mutation attempted in status tests') }),
    updateAdStatus: vi.fn(() => { throw new Error('Meta mutation attempted in status tests') }),
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

const ISSUE_2875006 = {
  level: 'AD',
  error_code: 2875006,
  error_summary: 'Media not wide enough',
  error_message: "Media not wide enough: Your ad won't run on Instagram.",
  error_type: 'HARD_ERROR',
}

const ISSUE_OTHER = {
  level: 'AD',
  error_code: 9990001,
  error_summary: 'Some future problem',
  error_message: 'Something new.',
  error_type: 'HARD_ERROR',
}

let app
const campaignIds = []

describe('execution repair status and preview (Phase 8)', () => {
  let client

  async function seedFixture(suffix, { issue = ISSUE_2875006 } = {}) {
    const campaign = await campaignService.createCampaign(client.id, { name: `RepairStatus ${suffix}`, type: 'post' })
    campaignIds.push(campaign.id)
    await campaignRepo.createCreative(generateUuid(), campaign.id, { caption: 'frozen caption', mediaUrl: 'https://example.com/old.png' })
    await campaignService.saveMetaSettings(client.id, campaign.id, {
      objective: 'OUTCOME_TRAFFIC',
      budgetAmount: 10000,
      targeting: { geo_locations: { countries: ['IN'] } },
      platformPlacement: { publisher_platforms: ['facebook', 'instagram'] },
    })
    const fb = `fb_rst_${suffix}`
    const adset = `adset_rst_${suffix}`
    const creative = `creative_rst_${suffix}`
    const ad = `ad_rst_${suffix}`
    await campaignRepo.createMetaObject(campaign.id, 'facebook_campaign', fb, null, 'ACTIVE', client.id)
    await campaignRepo.createMetaObject(campaign.id, 'ad_set', adset, null, 'ACTIVE', client.id)
    await campaignRepo.createMetaObject(campaign.id, 'ad_creative', creative, null, null, client.id)
    await campaignRepo.createMetaObject(campaign.id, 'ad', ad, null, 'PAUSED', client.id)
    const executionId = await execRepo.createExecution({
      campaignId: campaign.id, ownerUserId: client.id, kind: 'client', status: 'creating',
      platformCampaignId: fb, platformAdsetId: adset, platformCreativeId: creative, platformAdId: ad,
    })
    if (issue) {
      await campaignRepo.upsertMetaObjectIssue(executionId, {
        objectId: ad, creativeId: creative, level: issue.level, errorCode: String(issue.error_code),
        summary: issue.error_summary, message: issue.error_message, errorType: issue.error_type,
      })
    }
    await campaignRepo.updateCampaignStatus(campaign.id, 'running')
    await freezeCampaignSnapshotFor(campaign.id)
    const asset = await mediaRepo.createMediaAsset(generateUuid(), client.id, {
      name: 'fix.png', storagePath: `/uploads/posts/rst-${suffix}.png`, mimeType: 'image/png',
      mediaKind: 'image', sizeBytes: 1024, width: 800, height: 600,
    })
    return { campaignId: campaign.id, executionId, fb, adset, creative, ad, asset }
  }

  beforeAll(async () => {
    process.env.META_SYSTEM_USER_TOKEN = 'test_system_user_token'
    process.env.META_AD_ACCOUNT_ID = 'act_test_account'
    client = await createTestUser({ email: `repair-status-${dateTag}@flowx-test.com`, password: 'Test@123', coins: 10000 })
    const mod = await import('../../app.js')
    app = mod.default
    await query(
      `INSERT INTO app_config (id, config_key, config_value, is_public, description, version)
       VALUES (?, 'campaign_repair_rollout', '"admin_only"', 0, 'test', 1)
       ON DUPLICATE KEY UPDATE config_value = '"admin_only"', version = version + 1`,
      [uuidToBuffer(generateUuid())]
    )
  })

  afterAll(async () => {
    await query("DELETE FROM app_config WHERE config_key = 'campaign_repair_rollout'").catch(() => {})
    for (const id of campaignIds) {
      await query('DELETE FROM campaigns WHERE id = ?', [uuidToBuffer(id)]).catch(() => {})
    }
  })

  beforeEach(() => {
    metaMocks.getObjectStatus.mockResolvedValue({ status: 'PAUSED', effective_status: 'WITH_ISSUES', issues_info: [ISSUE_2875006] })
  })

  it('HEALTHY when no issue and no repairs exist', async () => {
    const seed = await seedFixture(tag('s'), { issue: null })
    const status = await repairService.getExecutionRepairStatus(seed.executionId)
    expect(status).toMatchObject({ health: 'HEALTHY', workflowState: 'HEALTHY', eligible: false })
    expect(status.reasons).toContain('no-active-issue')
    expect(status.issues).toEqual([])
    expect(status.activeRepair).toBeNull()
  })

  it('ACTION_REQUIRED when a supported issue exists with no repair', async () => {
    const seed = await seedFixture(tag('s'))
    const status = await repairService.getExecutionRepairStatus(seed.executionId)
    expect(status).toMatchObject({ health: 'ACTION_REQUIRED', workflowState: 'ACTION_REQUIRED', eligible: true })
    expect(status.reasons).toEqual([])
    expect(status.issues).toHaveLength(1)
    expect(status.issues[0]).toMatchObject({ errorCode: '2875006', supported: true, category: 'MEDIA_DIMENSION' })
    expect(status.issues[0].guidance).toMatch(/500px/)
  })

  it('REPAIR_IN_PROGRESS and REPAIR_READY while a repair advances, without touching reconciliation strictness', async () => {
    const seed = await seedFixture(tag('s'))
    const created = await repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null, mediaAssetId: seed.asset.id,
    })
    expect((await repairService.getExecutionRepairStatus(seed.executionId)).workflowState).toBe('REPAIR_IN_PROGRESS')
    await repairRepo.updateRepairState(created.repair.id, ['pending'], 'new_verified')
    const ready = await repairService.getExecutionRepairStatus(seed.executionId)
    expect(ready.workflowState).toBe('REPAIR_READY')
    expect(ready.health).toBe('ACTION_REQUIRED')
    expect(ready.eligible).toBe(false)
    expect(ready.reasons).toContain('repair-in-progress')
  })

  it('FAILED and UNKNOWN repairs surface ACTION_REQUIRED with the stored reason', async () => {
    const seed = await seedFixture(tag('s'))
    const created = await repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null, mediaAssetId: seed.asset.id,
    })
    await repairRepo.updateRepairState(created.repair.id, ['pending'], 'failed')
    const failed = await repairService.getExecutionRepairStatus(seed.executionId)
    expect(failed.workflowState).toBe('ACTION_REQUIRED')
    expect(failed.lastRepair.status).toBe('failed')
    expect(failed.eligible).toBe(true)
    await repairRepo.updateRepairState(created.repair.id, ['failed'], 'pending')
    await repairRepo.updateRepairState(created.repair.id, ['pending'], 'unknown')
    const unknown = await repairService.getExecutionRepairStatus(seed.executionId)
    expect(unknown.workflowState).toBe('ACTION_REQUIRED')
    expect(unknown.lastRepair.status).toBe('unknown')
  })

  it('COMPLETED with no active issue reports completed health', async () => {
    const seed = await seedFixture(tag('s'))
    const created = await repairService.requestRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, actorId: null, mediaAssetId: seed.asset.id,
    })
    await repairRepo.updateRepairState(created.repair.id, ['pending'], 'completed')
    await campaignRepo.deactivateMissingMetaObjectIssues(seed.executionId, seed.ad, [])
    const status = await repairService.getExecutionRepairStatus(seed.executionId)
    expect(status.workflowState).toBe('COMPLETED')
    expect(status.health).toBe('HEALTHY')
    expect(status.completedRepairs).toBe(1)
  })

  it('eligibility names every blocking factor without inferring on the caller side', async () => {
    const seed = await seedFixture(tag('s'))
    await campaignRepo.claimCampaignSettlement(seed.campaignId)
    const settled = await repairService.getExecutionRepairStatus(seed.executionId)
    expect(settled.eligible).toBe(false)
    expect(settled.reasons).toContain('campaign-settled')
    await campaignRepo.releaseCampaignSettlement(seed.campaignId)

    const other = await seedFixture(tag('s'), { issue: ISSUE_OTHER })
    const unsupported = await repairService.getExecutionRepairStatus(other.executionId)
    expect(unsupported.eligible).toBe(false)
    expect(unsupported.reasons).toContain('issue-unsupported')
    expect(unsupported.issues[0].supported).toBe(false)

    const terminal = await seedFixture(tag('s'))
    await execRepo.updateExecution(terminal.executionId, { status: 'cancelled' })
    const terminalStatus = await repairService.getExecutionRepairStatus(terminal.executionId)
    expect(terminalStatus.eligible).toBe(false)
    expect(terminalStatus.reasons).toContain('execution-terminal')
  })

  it('preview returns structured pass/fail without writing anything', async () => {
    const seed = await seedFixture(tag('s'))
    const repairsBefore = await query('SELECT COUNT(*) AS n FROM campaign_execution_repairs')
    const jobsBefore = await query('SELECT COUNT(*) AS n FROM campaign_jobs')
    const preview = await repairService.previewRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, mediaAssetId: seed.asset.id,
    })
    expect(preview.ok).toBe(true)
    expect(preview.checks.every((c) => c.ok)).toBe(true)
    expect(preview.checks.map((c) => c.key)).toEqual(
      expect.arrayContaining(['campaign', 'execution', 'execution-scope', 'generation-target', 'issue-selected', 'issue-supported', 'media', 'snapshot-frozen', 'snapshot-live', 'snapshot-diff', 'account', 'issue-live', 'no-conflict'])
    )
    expect(preview.issue).toMatchObject({ errorCode: '2875006', category: 'MEDIA_DIMENSION' })
    expect(preview.media).toMatchObject({ width: 800, height: 600 })
    expect(preview.execution).toMatchObject({ executionId: seed.executionId, adId: seed.ad })
    expect(await query('SELECT COUNT(*) AS n FROM campaign_execution_repairs')).toEqual(repairsBefore)
    expect(await query('SELECT COUNT(*) AS n FROM campaign_jobs')).toEqual(jobsBefore)
    expect(metaMocks.createAdCreative).not.toHaveBeenCalled()
    expect(metaMocks.createAd).not.toHaveBeenCalled()
    expect(metaMocks.updateAdStatus).not.toHaveBeenCalled()
    expect(metaMocks.deleteAd).not.toHaveBeenCalled()
  })

  it('preview fails closed on bad media, unsupported issues, and missing issues', async () => {
    const seed = await seedFixture(tag('s'))
    const small = await mediaRepo.createMediaAsset(generateUuid(), client.id, {
      name: 'small.png', storagePath: '/uploads/posts/small.png', mimeType: 'image/png',
      mediaKind: 'image', sizeBytes: 512, width: 400, height: 400,
    })
    const badMedia = await repairService.previewRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, mediaAssetId: small.id,
    })
    expect(badMedia.ok).toBe(false)
    expect(badMedia.checks.find((c) => c.key === 'media').ok).toBe(false)
    expect(badMedia.checks.find((c) => c.key === 'media').message).toMatch(/500px/)

    const other = await seedFixture(tag('s'), { issue: ISSUE_OTHER })
    const unsupported = await repairService.previewRepair({
      campaignId: other.campaignId, executionId: other.executionId, mediaAssetId: other.asset.id,
    })
    expect(unsupported.ok).toBe(false)
    expect(unsupported.checks.find((c) => c.key === 'issue-supported').ok).toBe(false)

    const empty = await seedFixture(tag('s'), { issue: null })
    const missing = await repairService.previewRepair({
      campaignId: empty.campaignId, executionId: empty.executionId, mediaAssetId: empty.asset.id,
    })
    expect(missing.ok).toBe(false)
    expect(missing.checks.find((c) => c.key === 'issue-selected').ok).toBe(false)
  })

  it('preview detects a cleared live issue without mutating', async () => {
    const seed = await seedFixture(tag('s'))
    metaMocks.getObjectStatus.mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE', issues_info: [] })
    const preview = await repairService.previewRepair({
      campaignId: seed.campaignId, executionId: seed.executionId, mediaAssetId: seed.asset.id,
    })
    expect(preview.ok).toBe(false)
    expect(preview.checks.find((c) => c.key === 'issue-live').ok).toBe(false)
    expect(await repairRepo.listRepairsForExecution(seed.executionId)).toHaveLength(0)
  })

  it('existing active repair blocks eligibility and duplicates converge on 202', async () => {
    const seed = await seedFixture(tag('s'))
    const adminToken = await loginAgent(app, 'admin@flowx.com', 'Admin@123')
    const first = await supertest(app)
      .post(`/api/v1/admin/campaigns/${seed.campaignId}/executions/${seed.executionId}/repairs`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mediaAssetId: seed.asset.id })
    expect(first.status).toBe(202)
    const blocked = await repairService.getExecutionRepairStatus(seed.executionId)
    expect(blocked.eligible).toBe(false)
    expect(blocked.reasons).toContain('repair-in-progress')
    const second = await supertest(app)
      .post(`/api/v1/admin/campaigns/${seed.campaignId}/executions/${seed.executionId}/repairs`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mediaAssetId: seed.asset.id })
    expect(second.status).toBe(202)
    expect(second.body.data.duplicate).toBe(true)
    expect(second.body.data.repairId).toBe(first.body.data.repairId)
    expect(await repairRepo.listRepairsForExecution(seed.executionId)).toHaveLength(1)
  })

  it('repair-status and preview endpoints authorize admin-only', async () => {
    const seed = await seedFixture(tag('s'))
    const clientToken = await loginAgent(app, `repair-status-${dateTag}@flowx-test.com`, 'Test@123')
    const deniedStatus = await supertest(app)
      .get(`/api/v1/admin/campaigns/${seed.campaignId}/executions/${seed.executionId}/repair-status`)
      .set('Authorization', `Bearer ${clientToken}`)
    expect(deniedStatus.status).toBe(403)
    const deniedPreview = await supertest(app)
      .post(`/api/v1/admin/campaigns/${seed.campaignId}/executions/${seed.executionId}/repair-preview`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ mediaAssetId: seed.asset.id })
    expect(deniedPreview.status).toBe(403)
    const adminToken = await loginAgent(app, 'admin@flowx.com', 'Admin@123')
    const status = await supertest(app)
      .get(`/api/v1/admin/campaigns/${seed.campaignId}/executions/${seed.executionId}/repair-status`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(status.status).toBe(200)
    expect(status.body.data).toMatchObject({ executionId: seed.executionId, workflowState: 'ACTION_REQUIRED', eligible: true })
    const preview = await supertest(app)
      .post(`/api/v1/admin/campaigns/${seed.campaignId}/executions/${seed.executionId}/repair-preview`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ mediaAssetId: seed.asset.id })
    expect(preview.status).toBe(200)
    expect(preview.body.data.ok).toBe(true)
    const mismatched = await supertest(app)
      .get(`/api/v1/admin/campaigns/${generateUuid()}/executions/${seed.executionId}/repair-status`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(mismatched.status).toBe(422)
  })
})
