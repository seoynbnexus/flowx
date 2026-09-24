import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { encrypt } from '../../shared/utils/crypto.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import { query, queryOne } from '../../shared/database/connection.js'
import * as promoRepo from '../../src/modules/posts/promotion.repository.js'
import * as repairRepo from '../../src/modules/posts/promotion-repair.repository.js'
import * as repairService from '../../src/modules/posts/promotion-repair.service.js'
import * as statusSyncService from '../../src/modules/posts/promotion-status-sync.service.js'
import * as issueCatalog from '../../shared/services/meta-issue-catalog.js'
import { PROMOTION_JOB_TYPES } from '../../src/modules/posts/promotion.model.js'
import { findAutoJobByRunKey } from '../../src/modules/campaigns/campaign.repository.js'
import { resolveBoostTargetContext, BOOST_GRAPH_VERSION } from '../../shared/services/boost-capabilities.js'

var metaMocks
let mockIdSeq = 0
function nextMockId(prefix) {
  mockIdSeq += 1
  return `${prefix}_${Date.now()}_${mockIdSeq}`
}
vi.mock('../../shared/services/meta-ads.service.js', async () => {
  const actual = await vi.importActual('../../shared/services/meta-ads.service.js')
  const mocks = {
    ...actual,
    getObjectStatus: vi.fn().mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE', issues_info: [] }),
    getAdStatusesWithIssuesBatch: vi.fn().mockResolvedValue({}),
    createAdCampaign: vi.fn().mockImplementation(async () => ({ id: nextMockId('mockcampaign') })),
    createAdSet: vi.fn().mockImplementation(async () => ({ id: nextMockId('mockadset') })),
    createAdCreativeFromPost: vi.fn().mockImplementation(async () => ({ id: nextMockId('mockcreative') })),
    createAdCreativeFromInstagramPost: vi.fn().mockImplementation(async () => ({ id: nextMockId('mockigcreative') })),
    createAd: vi.fn().mockImplementation(async () => ({ id: nextMockId('mockad') })),
    updateAdStatus: vi.fn().mockResolvedValue({ success: true }),
    deleteAdCampaign: vi.fn().mockResolvedValue({ success: true }),
    deleteAdSet: vi.fn().mockResolvedValue({ success: true }),
    deleteAdCreative: vi.fn().mockResolvedValue({ success: true }),
    deleteAd: vi.fn().mockResolvedValue({ success: true }),
  }
  metaMocks = mocks
  return mocks
})

async function setFlag(key, value) {
  await query(
    `INSERT INTO app_config (id, config_key, config_value, is_public, description, version)
     VALUES (?, ?, ?, 0, 'test flag', 1)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
    [uuidToBuffer(generateUuid()), key, JSON.stringify(value)]
  )
}

let idSeq = 0
function nextTestId(prefix) {
  idSeq += 1
  return `${prefix}${Date.now()}${idSeq}`
}

async function insertAccount(userId, platform, slug) {
  const platformRow = await queryOne('SELECT id FROM platforms WHERE code = ?', [platform])
  const platformUserId = nextTestId(`br_${slug}_`)
  const accountId = generateUuid()
  await query(
    `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id, platform_username, platform_display_name, token_type, access_token, token_expires_at, verification_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'page', ?, DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
    [uuidToBuffer(accountId), uuidToBuffer(userId), platformRow.id, `https://fb.com/${platformUserId}`, platformUserId, platformUserId, `Display ${platformUserId}`, encrypt('mock_page_token')]
  )
  return accountId
}

async function insertPost(userId, name) {
  const postId = generateUuid()
  await query(
    `INSERT INTO posts (id, client_id, name, type, status, boost_enabled, caption, media_url, created_at, updated_at)
     VALUES (?, ?, ?, 'post', 'completed', 1, 'caption', 'https://example.com/img.jpg', NOW(), NOW())`,
    [uuidToBuffer(postId), uuidToBuffer(userId), name]
  )
  return postId
}

async function insertTarget(postId, accountId) {
  const targetId = generateUuid()
  const objectId = nextTestId('br_obj_')
  await query(
    `INSERT INTO post_targets (id, post_id, platform_account_id, target_type, status, publish_state, meta_object_id, posted_at, created_at)
     VALUES (?, ?, ?, 'client', 'posted', 'published', ?, NOW(), NOW())`,
    [uuidToBuffer(targetId), uuidToBuffer(postId), uuidToBuffer(accountId), objectId]
  )
  return { targetId, objectId }
}

async function insertActiveBoostTarget(postId, userId, postTargetId, accountId, { budgetAmount = 500 } = {}) {
  const existing = await promoRepo.findPromotionByPostId(postId)
  let promotionId
  if (existing) {
    promotionId = existing.id
  } else {
    promotionId = generateUuid()
    await promoRepo.createPromotion(promotionId, postId, userId, {
      status: 'active',
      budgetType: 'daily',
      budgetAmount,
      chargedPaise: Math.round(budgetAmount * 100),
      endAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
  }
  const resolved = resolveBoostTargetContext(
    { geo_locations: { countries: ['IN'] } },
    { publisher_platforms: ['facebook'] },
    { platformCode: 'facebook', postType: 'post', objective: 'OUTCOME_ENGAGEMENT' }
  )
  if (!resolved.ok) throw new Error(`test fixture snapshot invalid: ${JSON.stringify(resolved.errors)}`)
  await promoRepo.updatePromotion(promotionId, {
    resolvedTargeting: { targets: { [postTargetId]: resolved.resolved.targeting }, platforms: { facebook: resolved.resolved.targeting }, objective: resolved.resolved.objective, optimizationGoal: resolved.resolved.optimizationGoal },
    resolvedPlacement: { targets: { [postTargetId]: resolved.resolved.placement }, platforms: { facebook: resolved.resolved.placement } },
    resolvedGraphVersion: BOOST_GRAPH_VERSION,
  })
  const ptgtId = generateUuid()
  await promoRepo.createPromotionTarget(ptgtId, promotionId, postTargetId, 'facebook', accountId)
  await promoRepo.updatePromotionTarget(ptgtId, {
    status: 'active',
    platformCampaignId: nextTestId('br_camp_'),
    platformAdsetId: nextTestId('br_adset_'),
    platformCreativeId: nextTestId('br_creative_'),
    platformAdId: nextTestId('br_ad_'),
  })
  const ptgt = await promoRepo.findPromotionTargetById(ptgtId)
  return { promotionId, ptgtId, ptgt }
}

const dateTag = Date.now()
let userSeq = 0
async function makeUser() {
  userSeq += 1
  return createTestUser({ email: `boost-repair-${dateTag}-${userSeq}@flowx-test.com`, password: 'Test@123' })
}

beforeAll(async () => {
  await setFlag('boost_repair_rollout', 'off')
  await setFlag('boost_repair_execution_enabled', false)
  await setFlag('boost_repair_killed', false)
})

afterAll(async () => {
  await setFlag('boost_repair_rollout', 'off')
  await setFlag('boost_repair_execution_enabled', false)
  await setFlag('boost_repair_killed', false)
  await query("DELETE FROM campaign_jobs WHERE job_type = ?", [PROMOTION_JOB_TYPES.REPAIR])
})

describe('boost repair: financial fence', () => {
  it('repair modules never touch financial code paths', () => {
    for (const file of [
      '../../src/modules/posts/promotion-repair.service.js',
      '../../src/modules/posts/promotion-repair.repository.js',
      '../../src/modules/posts/promotion-repair.model.js',
      '../../src/modules/posts/promotion-status-sync.service.js',
    ]) {
      const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(src).not.toMatch(/coinService|chargePromotionForApproval|refundPromotionTargetShare|claimPromotionTargetConsume|settlePromotionLeftover|refundUnfilledPromotionSlots/)
    }
  })
})

describe('boost repair: rollout flags', () => {
  it('defaults are fail-closed', async () => {
    await setFlag('boost_repair_rollout', 'off')
    await setFlag('boost_repair_execution_enabled', false)
    await setFlag('boost_repair_killed', false)
    expect(await repairService.getRepairRolloutMode()).toBe('off')
    expect(await repairService.isRepairKilled()).toBe(false)
    expect(await repairService.isRepairExecutionEnabled()).toBe(false)
  })

  it('an unrecognized rollout value is treated as off, not truthy-coerced', async () => {
    await setFlag('boost_repair_rollout', 'garbage')
    expect(await repairService.getRepairRolloutMode()).toBe('off')
    await setFlag('boost_repair_rollout', 'off')
  })

  it('requestRepair throws ForbiddenError when rollout is off', async () => {
    await expect(repairService.requestRepair({ promotionTargetId: generateUuid() })).rejects.toMatchObject({ statusCode: 403 })
  })

  it('BOOST_SUPPORTED_REPAIR_CATEGORIES ships empty — no category is repairable out of the box', () => {
    expect(issueCatalog.BOOST_SUPPORTED_REPAIR_CATEGORIES).toEqual([])
    expect(issueCatalog.isBoostRepairableCategory('MEDIA_DIMENSION')).toBe(false)
    // Confirmed disjoint from campaigns' allowlist even though the shared
    // classifier would report MEDIA_DIMENSION for this code.
    expect(issueCatalog.classifyIssueCode(2875006).category).toBe('MEDIA_DIMENSION')
    expect(issueCatalog.isBoostRepairableCategory(issueCatalog.classifyIssueCode(2875006).category)).toBe(false)
  })
})

describe('boost repair: with a test-pinned repairable category', () => {
  const TEST_CODE = '999901'

  beforeAll(() => {
    issueCatalog.VIDEO_DIMENSION_ISSUE_CODES.push(TEST_CODE)
    issueCatalog.BOOST_SUPPORTED_REPAIR_CATEGORIES.push('VIDEO_DIMENSION')
  })

  afterAll(() => {
    issueCatalog.VIDEO_DIMENSION_ISSUE_CODES.length = 0
    issueCatalog.BOOST_SUPPORTED_REPAIR_CATEGORIES.length = 0
  })

  beforeEach(async () => {
    await setFlag('boost_repair_rollout', 'admin_only')
    await setFlag('boost_repair_execution_enabled', true)
    await setFlag('boost_repair_killed', false)
    await setFlag('boost_repair_category_video_dimension', true)
    metaMocks.getObjectStatus.mockReset().mockResolvedValue({ status: 'ACTIVE', effective_status: 'ACTIVE', issues_info: [] })
    metaMocks.getAdStatusesWithIssuesBatch.mockReset().mockResolvedValue({})
    metaMocks.createAdCampaign.mockReset().mockImplementation(async () => ({ id: `mock_campaign_${generateUuid().slice(0, 8)}` }))
    metaMocks.createAdSet.mockReset().mockImplementation(async () => ({ id: `mock_adset_${generateUuid().slice(0, 8)}` }))
    metaMocks.createAdCreativeFromPost.mockReset().mockImplementation(async () => ({ id: `mock_creative_${generateUuid().slice(0, 8)}` }))
    metaMocks.createAd.mockReset().mockImplementation(async () => ({ id: `mock_ad_${generateUuid().slice(0, 8)}` }))
    metaMocks.updateAdStatus.mockReset().mockResolvedValue({ success: true })
    metaMocks.deleteAd.mockReset().mockResolvedValue({ success: true })
    metaMocks.deleteAdCreative.mockReset().mockResolvedValue({ success: true })
  })

  it('sync job detects a repairable issue and flips the target to needs_repair, leaving the promotion status untouched', async () => {
    const user = await makeUser()
    const accountId = await insertAccount(user.id, 'facebook', 'sync')
    const postId = await insertPost(user.id, 'Sync Test')
    const { targetId } = await insertTarget(postId, accountId)
    const { promotionId, ptgtId, ptgt } = await insertActiveBoostTarget(postId, user.id, targetId, accountId)

    metaMocks.getAdStatusesWithIssuesBatch.mockResolvedValueOnce({
      [ptgt.platformAdId]: {
        status: 'DISAPPROVED',
        issuesInfo: [{ error_code: TEST_CODE, error_summary: 'test', error_message: 'test issue', error_type: 'HARD_ERROR', level: 'AD' }],
      },
    })

    const result = await statusSyncService.syncPromotionTargetStatusJob()
    expect(result.processed).toBeGreaterThan(0)

    const refreshedTarget = await promoRepo.findPromotionTargetById(ptgtId)
    expect(refreshedTarget.status).toBe('needs_repair')

    const issues = await repairRepo.findActivePromotionTargetIssues(ptgtId)
    expect(issues.some((i) => i.errorCode === TEST_CODE)).toBe(true)

    // The core "invisible bucket" claim: needs_repair is in none of
    // refreshPromotionStatus's buckets, so the promotion never regresses.
    const promotion = await promoRepo.findPromotionById(promotionId)
    expect(promotion.status).toBe('active')
  })

  it('sync job leaves the target FAILED (unchanged today) when no repairable issue is reported', async () => {
    const user = await makeUser()
    const accountId = await insertAccount(user.id, 'facebook', 'syncfail')
    const postId = await insertPost(user.id, 'Sync Fail Test')
    const { targetId } = await insertTarget(postId, accountId)
    const { ptgtId, ptgt } = await insertActiveBoostTarget(postId, user.id, targetId, accountId)

    metaMocks.getAdStatusesWithIssuesBatch.mockResolvedValueOnce({
      [ptgt.platformAdId]: { status: 'DISAPPROVED', issuesInfo: [{ error_code: '424242', error_summary: 'unclassified', error_message: 'x', error_type: 'HARD_ERROR', level: 'AD' }] },
    })
    await statusSyncService.syncPromotionTargetStatusJob()
    const refreshedTarget = await promoRepo.findPromotionTargetById(ptgtId)
    expect(refreshedTarget.status).toBe('failed')
  })

  it('requestRepair + full worker run rebuilds the ad, restores active, and clears the issue', async () => {
    const user = await makeUser()
    const accountId = await insertAccount(user.id, 'facebook', 'happy')
    const postId = await insertPost(user.id, 'Happy Path')
    const { targetId } = await insertTarget(postId, accountId)
    const { ptgtId, ptgt } = await insertActiveBoostTarget(postId, user.id, targetId, accountId)
    const oldAdId = ptgt.platformAdId
    const oldCreativeId = ptgt.platformCreativeId
    await repairRepo.upsertPromotionTargetIssue(ptgtId, { objectId: oldAdId, errorCode: TEST_CODE, level: 'AD', summary: 's', message: 'm', errorType: 'HARD_ERROR' })
    await promoRepo.updatePromotionTarget(ptgtId, { status: 'needs_repair' })
    // Simulate the claim already having happened via the sync job, then a
    // client/admin flips it back to active momentarily isn't realistic —
    // instead exercise requestRepair's own claim from active directly:
    await promoRepo.updatePromotionTarget(ptgtId, { status: 'active' })

    metaMocks.getObjectStatus.mockResolvedValue({ status: 'DISAPPROVED', effective_status: 'DISAPPROVED', issues_info: [{ error_code: TEST_CODE }] })

    const req = await repairService.requestRepair({ promotionTargetId: ptgtId, issueCode: TEST_CODE, callToAction: 'SHOP_NOW' })
    expect(req.queued).toBe(true)
    expect(req.duplicate).toBe(false)

    const afterClaim = await promoRepo.findPromotionTargetById(ptgtId)
    expect(afterClaim.status).toBe('needs_repair')

    const result = await repairService.runRepairJob(req.repairId)
    expect(result.state).toBe('completed')

    const finalTarget = await promoRepo.findPromotionTargetById(ptgtId)
    expect(finalTarget.status).toBe('active')
    expect(finalTarget.platformAdId).not.toBe(oldAdId)
    expect(finalTarget.platformCreativeId).not.toBe(oldCreativeId)
    // Campaign/adset are never touched by repair (decision #2).
    expect(finalTarget.platformCampaignId).toBe(ptgt.platformCampaignId)
    expect(finalTarget.platformAdsetId).toBe(ptgt.platformAdsetId)

    expect(metaMocks.deleteAd).toHaveBeenCalledWith(oldAdId, expect.anything())
    expect(metaMocks.deleteAdCreative).toHaveBeenCalledWith(oldCreativeId, expect.anything())
    expect(metaMocks.createAdCampaign).not.toHaveBeenCalled()
    expect(metaMocks.createAdSet).not.toHaveBeenCalled()
    expect(metaMocks.updateAdStatus).toHaveBeenCalledWith(finalTarget.platformAdId, 'ACTIVE', expect.anything())

    const issues = await repairRepo.findActivePromotionTargetIssues(ptgtId)
    expect(issues).toHaveLength(0)

    const repair = await repairRepo.findRepairById(req.repairId)
    expect(repair.status).toBe('completed')
  })

  it('rollback on Meta failure cascades the target back to failed via the repair path, never leaving it stuck at needs_repair', async () => {
    const user = await makeUser()
    const accountId = await insertAccount(user.id, 'facebook', 'rollback')
    const postId = await insertPost(user.id, 'Rollback Test')
    const { targetId } = await insertTarget(postId, accountId)
    const { ptgtId, ptgt } = await insertActiveBoostTarget(postId, user.id, targetId, accountId)
    await repairRepo.upsertPromotionTargetIssue(ptgtId, { objectId: ptgt.platformAdId, errorCode: TEST_CODE, level: 'AD', summary: 's', message: 'm', errorType: 'HARD_ERROR' })
    metaMocks.getObjectStatus.mockResolvedValue({ status: 'DISAPPROVED', effective_status: 'DISAPPROVED', issues_info: [{ error_code: TEST_CODE }] })

    const req = await repairService.requestRepair({ promotionTargetId: ptgtId, issueCode: TEST_CODE })

    const permanentError = new Error('permanent creative rejection')
    permanentError.statusCode = 400
    metaMocks.createAdCreativeFromPost.mockRejectedValueOnce(permanentError)

    const result = await repairService.runRepairJob(req.repairId)
    expect(result.state).toBe('failed')

    const finalTarget = await promoRepo.findPromotionTargetById(ptgtId)
    expect(finalTarget.status).toBe('failed')

    const repair = await repairRepo.findRepairById(req.repairId)
    expect(repair.status).toBe('failed')
    expect(repair.error).toBeTruthy()
  })

  it('requeueAfterSeconds backoff when execution is disabled — never a bare done:true that silently drops the retry', async () => {
    const user = await makeUser()
    const accountId = await insertAccount(user.id, 'facebook', 'gated')
    const postId = await insertPost(user.id, 'Gated Test')
    const { targetId } = await insertTarget(postId, accountId)
    const { ptgtId, ptgt } = await insertActiveBoostTarget(postId, user.id, targetId, accountId)
    await repairRepo.upsertPromotionTargetIssue(ptgtId, { objectId: ptgt.platformAdId, errorCode: TEST_CODE, level: 'AD', summary: 's', message: 'm', errorType: 'HARD_ERROR' })
    metaMocks.getObjectStatus.mockResolvedValue({ status: 'DISAPPROVED', effective_status: 'DISAPPROVED', issues_info: [{ error_code: TEST_CODE }] })

    await setFlag('boost_repair_execution_enabled', false)
    const req = await repairService.requestRepair({ promotionTargetId: ptgtId, issueCode: TEST_CODE })
    const result = await repairService.runRepairJob(req.repairId)
    expect(result.requeueAfterSeconds).toBe(300)
    expect(result.gated).toBe(true)
    expect(metaMocks.createAd).not.toHaveBeenCalled()

    const repair = await repairRepo.findRepairById(req.repairId)
    expect(repair.status).toBe('ready_for_creation')
  })

  it('kill switch blocks every mutation entry point with zero state change', async () => {
    const user = await makeUser()
    const accountId = await insertAccount(user.id, 'facebook', 'killed')
    const postId = await insertPost(user.id, 'Killed Test')
    const { targetId } = await insertTarget(postId, accountId)
    const { ptgtId, ptgt } = await insertActiveBoostTarget(postId, user.id, targetId, accountId)
    await repairRepo.upsertPromotionTargetIssue(ptgtId, { objectId: ptgt.platformAdId, errorCode: TEST_CODE, level: 'AD', summary: 's', message: 'm', errorType: 'HARD_ERROR' })

    await setFlag('boost_repair_killed', true)
    await expect(repairService.requestRepair({ promotionTargetId: ptgtId, issueCode: TEST_CODE })).rejects.toThrow(/kill switch/)
    const targetAfter = await promoRepo.findPromotionTargetById(ptgtId)
    expect(targetAfter.status).toBe('active')
    await setFlag('boost_repair_killed', false)
  })

  it('guarded claim: two concurrent claims on the same active target — only one wins', async () => {
    const user = await makeUser()
    const accountId = await insertAccount(user.id, 'facebook', 'race')
    const postId = await insertPost(user.id, 'Race Test')
    const { targetId } = await insertTarget(postId, accountId)
    const { ptgtId } = await insertActiveBoostTarget(postId, user.id, targetId, accountId)

    const [a, b] = await Promise.all([
      promoRepo.claimPromotionTargetForRepairSwap(ptgtId),
      promoRepo.claimPromotionTargetForRepairSwap(ptgtId),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    const target = await promoRepo.findPromotionTargetById(ptgtId)
    expect(target.status).toBe('needs_repair')
  })

  it('job identity: the repair run_key never collides with a promotion_execute job for the same target', async () => {
    const user = await makeUser()
    const accountId = await insertAccount(user.id, 'facebook', 'jobid')
    const postId = await insertPost(user.id, 'Job Id Test')
    const { targetId } = await insertTarget(postId, accountId)
    const { ptgtId, ptgt } = await insertActiveBoostTarget(postId, user.id, targetId, accountId)
    await repairRepo.upsertPromotionTargetIssue(ptgtId, { objectId: ptgt.platformAdId, errorCode: TEST_CODE, level: 'AD', summary: 's', message: 'm', errorType: 'HARD_ERROR' })

    const req = await repairService.requestRepair({ promotionTargetId: ptgtId, issueCode: TEST_CODE })
    expect(req.runKey).toBe(`promotion_repair:${req.repairId.replace(/-/g, '').toLowerCase()}`)
    const hasJob = await findAutoJobByRunKey(req.runKey)
    expect(hasJob).toBe(true)

    const jobRow = await queryOne('SELECT campaign_id, job_type FROM campaign_jobs WHERE run_key = ?', [req.runKey])
    expect(jobRow.campaign_id).toBeNull()
    expect(jobRow.job_type).toBe(PROMOTION_JOB_TYPES.REPAIR)

    const collision = await findAutoJobByRunKey(`promotion:${ptgtId}`)
    expect(collision).toBe(false)
  })

  it('retry re-arms a terminal (failed) repair row rather than creating a duplicate', async () => {
    const user = await makeUser()
    const accountId = await insertAccount(user.id, 'facebook', 'rearm')
    const postId = await insertPost(user.id, 'Rearm Test')
    const { targetId } = await insertTarget(postId, accountId)
    const { ptgtId, ptgt } = await insertActiveBoostTarget(postId, user.id, targetId, accountId)
    await repairRepo.upsertPromotionTargetIssue(ptgtId, { objectId: ptgt.platformAdId, errorCode: TEST_CODE, level: 'AD', summary: 's', message: 'm', errorType: 'HARD_ERROR' })
    metaMocks.getObjectStatus.mockResolvedValue({ status: 'DISAPPROVED', effective_status: 'DISAPPROVED', issues_info: [{ error_code: TEST_CODE }] })

    const first = await repairService.requestRepair({ promotionTargetId: ptgtId, issueCode: TEST_CODE })
    const permanentError = new Error('permanent')
    permanentError.statusCode = 400
    metaMocks.createAdCreativeFromPost.mockRejectedValueOnce(permanentError)
    await repairService.runRepairJob(first.repairId)
    const failedRepair = await repairRepo.findRepairById(first.repairId)
    expect(failedRepair.status).toBe('failed')

    // Target is back to plain 'failed' (repair exhausted) — re-flag the same
    // issue and request again to prove rearm, not duplicate-row creation.
    await promoRepo.updatePromotionTarget(ptgtId, { status: 'active', platformAdId: ptgt.platformAdId, platformCreativeId: ptgt.platformCreativeId })
    await repairRepo.upsertPromotionTargetIssue(ptgtId, { objectId: ptgt.platformAdId, errorCode: TEST_CODE, level: 'AD', summary: 's', message: 'm', errorType: 'HARD_ERROR' })

    const second = await repairService.requestRepair({ promotionTargetId: ptgtId, issueCode: TEST_CODE })
    expect(second.repairId).toBe(first.repairId)
    expect(second.rearmed).toBe(true)
    expect(second.status).toBe('pending')

    const rows = await query('SELECT COUNT(*) as n FROM promotion_target_repairs WHERE promotion_target_id = ?', [uuidToBuffer(ptgtId)])
    expect(Number(rows[0].n)).toBe(1)
  })
})
