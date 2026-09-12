import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as repo from '../../src/modules/campaigns/campaign.repository.js'
import { runJobMaintenance } from '../../src/modules/campaigns/campaign.jobs.js'
import * as campaignService from '../../src/modules/campaigns/campaign.service.js'
import { query, queryOne } from '../../shared/database/connection.js'
import {
  runTablePurge,
  runRetentionSweep,
  findTablePurge,
  sampleDbGrowth,
  getDbGrowthSnapshot,
  retentionOptions,
  _clampDays,
  _clampBatch,
} from '../../shared/database/retention.js'
import { logger } from '../../shared/utils/logger.js'

const RUN_KEY_PREFIX = `retention-test-${Date.now()}`
const OWNED_ROWS = []
const OWNED_USERS = []

// TTL-aware fixture ages: fixtures are placed JUST BEYOND / JUST INSIDE the
// live policy (whatever the env configures) so tests are env-agnostic.
const ttlDays = (table) => {
  const entry = findTablePurge(table)
  const days = entry?.retentionDays
  return Number.isFinite(Number(days)) && Number(days) >= 1 ? Number(days) : 1
}
const beyond = (table) => ttlDays(table) + 1
const within = (table) => Math.max(1, Math.floor(ttlDays(table) / 2))

async function bulkInsertEngagement(rows) {
  // rows: [{ postId, targetId, ageDays }] — stat_date varies per row index so
  // uk_post_engagement(post_id, target_id, stat_date) never collides on bulk fixtures
  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const placeholders = []
    const args = []
    chunk.forEach((r, idx) => {
      const id = generateUuid()
      OWNED_ROWS.push({ table: 'post_engagement_daily', id })
      const dateOffset = r.ageDays + i + idx
      placeholders.push(`(?, ?, ?, DATE_SUB(CURDATE(), INTERVAL ${dateOffset} DAY), DATE_SUB(NOW(), INTERVAL ${r.ageDays} DAY), NOW())`)
      args.push(uuidToBuffer(id), uuidToBuffer(r.postId), uuidToBuffer(r.targetId))
    })
    await query(
      `INSERT INTO post_engagement_daily (id, post_id, target_id, stat_date, created_at, updated_at) VALUES ${placeholders.join(', ')}`,
      args
    )
  }
}

function trackOwned(table, id, literalId = false) {
  OWNED_ROWS.push({ table, id, literalId })
}

async function seedPostFixture(user) {
  const postId = generateUuid()
  await query(
    `INSERT INTO posts (id, client_id, name, type, status, created_at)
     VALUES (?, ?, ?, 'post', 'draft', NOW())`,
    [uuidToBuffer(postId), uuidToBuffer(user.id), `Retention Post ${Date.now()}`]
  )
  trackOwned('posts', postId)

  const platform = await queryOne("SELECT id FROM platforms WHERE code = 'facebook'")
  const accountId = generateUuid()
  await query(
    `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id,
       platform_username, followers_count, token_type, token_expires_at, verification_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 'page', DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified', NOW())`,
    [uuidToBuffer(accountId), uuidToBuffer(user.id), platform.id, 'https://fb.com/retention',
      `retention_fb_${Date.now()}`, 'RetentionPage']
  )
  trackOwned('user_platform_accounts', accountId)

  const targetId = generateUuid()
  await query(
    `INSERT INTO post_targets (id, post_id, platform_account_id, status, created_at)
     VALUES (?, ?, ?, 'pending', NOW())`,
    [uuidToBuffer(targetId), uuidToBuffer(postId), uuidToBuffer(accountId)]
  )
  trackOwned('post_targets', targetId)
  return { postId, targetId, accountId }
}

async function seedCampaignFixture(user) {
  const campaignId = generateUuid()
  await query(
    `INSERT INTO campaigns (id, client_id, name, status, created_at, updated_at)
     VALUES (?, ?, ?, 'draft', NOW(), NOW())`,
    [uuidToBuffer(campaignId), uuidToBuffer(user.id), `Retention Campaign ${Date.now()}`]
  )
  trackOwned('campaigns', campaignId)
  return campaignId
}

async function seedFinancialAndAnalyticsRows(user) {
  const campaignId = await seedCampaignFixture(user)
  const { postId, targetId } = await seedPostFixture(user)

  await query(
    `INSERT INTO campaign_daily_stats (id, campaign_id, stat_date, spend_paise, created_at)
     VALUES (?, ?, DATE_SUB(CURDATE(), INTERVAL 400 DAY), 100, DATE_SUB(NOW(), INTERVAL 400 DAY))`,
    [uuidToBuffer(generateUuid()), uuidToBuffer(campaignId)]
  )
  await query(
    `INSERT INTO post_boost_daily_stats (id, post_id, post_target_id, stat_date, spend_paise, created_at)
     VALUES (?, ?, ?, DATE_SUB(CURDATE(), INTERVAL 400 DAY), 100, DATE_SUB(NOW(), INTERVAL 400 DAY))`,
    [uuidToBuffer(generateUuid()), uuidToBuffer(postId), uuidToBuffer(targetId)]
  )
  await query(
    `INSERT INTO usage_ledger (id, user_id, feature_key, resource_type, transaction_type, quantity, created_at)
     VALUES (?, ?, 'ai_generation', 'post', 'consume', 5, DATE_SUB(NOW(), INTERVAL 400 DAY))`,
    [uuidToBuffer(generateUuid()), uuidToBuffer(user.id)]
  )
  await query(
    `INSERT INTO transactions (id, user_id, label, amount, type, created_at)
     VALUES (?, ?, 'ancient retention test', -100, 'debit', DATE_SUB(NOW(), INTERVAL 400 DAY))`,
    [uuidToBuffer(generateUuid()), uuidToBuffer(user.id)]
  )
  await query(
    `INSERT INTO campaign_billing_entries (id, campaign_id, kind, created_at)
     VALUES (?, ?, 'charge', DATE_SUB(NOW(), INTERVAL 400 DAY))`,
    [uuidToBuffer(generateUuid()), uuidToBuffer(campaignId)]
  )
  await query(
    `INSERT INTO post_billing_entries (id, post_id, kind, paise, coins, rate, created_at)
     VALUES (?, ?, 'charge', 100, 1, 1, DATE_SUB(NOW(), INTERVAL 400 DAY))`,
    [uuidToBuffer(generateUuid()), uuidToBuffer(postId)]
  )
  return { campaignId, postId, targetId }
}

async function insertJob({ status = 'queued', finishedAtAgeDays = null, jobType = 'retry_meta' }) {
  const id = generateUuid()
  const runKey = `rt-${id.slice(0, 24)}-${id.slice(24)}`.slice(0, 64)
  const finishedAt = finishedAtAgeDays == null ? 'NULL' : `DATE_SUB(NOW(), INTERVAL ${finishedAtAgeDays} DAY)`
  await query(
    `INSERT INTO campaign_jobs (id, job_type, entity_type, status, run_key, run_after, finished_at, created_at, updated_at)
     VALUES (?, ?, 'campaign', ?, ?, DATE_SUB(NOW(), INTERVAL 1 HOUR), ${finishedAt}, NOW(), NOW())`,
    [uuidToBuffer(id), jobType, status, runKey]
  )
  trackOwned('campaign_jobs', id)
  return id
}

async function insertWebhookRow(ageDays) {
  const id = `rtwh-${generateUuid()}`.slice(0, 64)
  await query(
    `INSERT INTO meta_webhook_events (id, event_type, payload, created_at)
     VALUES (?, 'campaign.status_update', '{}', DATE_SUB(NOW(), INTERVAL ${ageDays} DAY))`,
    [id]
  )
  trackOwned('meta_webhook_events', id, true)
  return id
}

async function insertSnapshotRow(ageDays) {
  const id = generateUuid()
  await query(
    `INSERT INTO meta_account_snapshots (id, ad_account_id, balance_paise, currency, account_status, created_at)
     VALUES (?, 'act_retention_test', 100, 'INR', 'ACTIVE', DATE_SUB(NOW(), INTERVAL ${ageDays} DAY))`,
    [uuidToBuffer(id)]
  )
  trackOwned('meta_account_snapshots', id)
  return id
}

async function insertLoginHistoryRow(user, ageDays) {
  const id = generateUuid()
  const provider = await queryOne('SELECT id FROM oauth_providers LIMIT 1')
  await query(
    `INSERT INTO auth_login_history (id, user_id, provider_id, login_method, ip_address, user_agent, success, created_at)
     VALUES (?, ?, ?, 'password', '127.0.0.1', 'retention-test-agent', 1, DATE_SUB(NOW(), INTERVAL ${ageDays} DAY))`,
    [uuidToBuffer(id), uuidToBuffer(user.id), provider?.id || null]
  )
  trackOwned('auth_login_history', id)
  return id
}

async function insertAuditRow(user, ageDays) {
  const id = generateUuid()
  await query(
    `INSERT INTO audit_logs (id, actor_id, entity_type, action, created_at)
     VALUES (?, ?, 'user', 'test_action', DATE_SUB(NOW(), INTERVAL ${ageDays} DAY))`,
    [uuidToBuffer(id), uuidToBuffer(user.id)]
  )
  trackOwned('audit_logs', id)
  return id
}

async function insertExpiredSession(user, ageDays = 2) {
  const id = generateUuid()
  await query(
    `INSERT INTO user_sessions (id, user_id, refresh_token_hash, expires_at, created_at)
     VALUES (?, ?, ?, DATE_SUB(NOW(), INTERVAL ${ageDays} DAY), DATE_SUB(NOW(), INTERVAL ${ageDays + 1} DAY))`,
    [uuidToBuffer(id), uuidToBuffer(user.id), `expired_hash_${id}`]
  )
  trackOwned('user_sessions', id)
  return id
}

async function insertPhoneOtp(user, ageDays = 2) {
  const id = generateUuid()
  await query(
    `INSERT INTO phone_otps (id, user_id, phone, otp_hash, purpose, expires_at, created_at)
     VALUES (?, ?, ?, 'hash', 'login', DATE_SUB(NOW(), INTERVAL ${ageDays} DAY), DATE_SUB(NOW(), INTERVAL ${ageDays} DAY))`,
    [uuidToBuffer(id), uuidToBuffer(user.id), `+9199${String(Date.now()).slice(-8)}`]
  )
  trackOwned('phone_otps', id)
  return id
}

async function purgeAllOwnedAndLeftovers(userId) {
  await query("DELETE FROM meta_sync_state WHERE run_key LIKE 'retention:%'")
  await query("DELETE FROM meta_sync_state WHERE run_key LIKE 'db_growth:%'")
  for (const row of OWNED_ROWS) {
    try {
      if (row.literal) await query(`DELETE FROM ${row.table} WHERE id = ?`, [row.id])
      else await query(`DELETE FROM ${row.table} WHERE id = ?`, [uuidToBuffer(row.id)])
    } catch { }
  }
  OWNED_ROWS.length = 0
  if (userId) {
    await query('DELETE FROM phone_otps WHERE user_id = ?', [uuidToBuffer(userId)])
    await query('DELETE FROM auth_login_history WHERE user_id = ?', [uuidToBuffer(userId)])
    await query('DELETE FROM audit_logs WHERE actor_id = ?', [uuidToBuffer(userId)])
    await query('DELETE FROM user_sessions WHERE user_id = ?', [uuidToBuffer(userId)])
    await query('DELETE FROM usage_ledger WHERE user_id = ?', [uuidToBuffer(userId)])
    await query('DELETE FROM transactions WHERE user_id = ?', [uuidToBuffer(userId)])
    await query('DELETE FROM post_billing_entries WHERE post_id IN (SELECT id FROM posts WHERE client_id = ?)', [uuidToBuffer(userId)])
    await query('DELETE FROM post_boost_daily_stats WHERE post_id IN (SELECT id FROM posts WHERE client_id = ?)', [uuidToBuffer(userId)])
    await query('DELETE FROM post_targets WHERE post_id IN (SELECT id FROM posts WHERE client_id = ?)', [uuidToBuffer(userId)])
    await query('DELETE FROM posts WHERE client_id = ?', [uuidToBuffer(userId)])
    await query('DELETE FROM campaign_billing_entries WHERE campaign_id IN (SELECT id FROM campaigns WHERE client_id = ?)', [uuidToBuffer(userId)])
    await query('DELETE FROM campaign_daily_stats WHERE campaign_id IN (SELECT id FROM campaigns WHERE client_id = ?)', [uuidToBuffer(userId)])
    await query('DELETE FROM campaigns WHERE client_id = ?', [uuidToBuffer(userId)])
  }
}

describe('retention sweep', () => {
  let user

  beforeAll(async () => {
    user = await createTestUser({ email: `retention-main-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    OWNED_USERS.push(user.id)
  })

  afterAll(async () => {
    for (const uid of OWNED_USERS) await purgeAllOwnedAndLeftovers(uid)
    await query("DELETE FROM campaign_jobs WHERE run_key LIKE ?", [`${RUN_KEY_PREFIX}-%`])
    await query("DELETE FROM meta_webhook_events WHERE id LIKE ?", [`${RUN_KEY_PREFIX}-%`])
    await query("DELETE FROM meta_account_snapshots WHERE ad_account_id = 'act_retention_test'")
    await query("DELETE FROM meta_sync_state WHERE run_key LIKE 'retention:%'")
    await query("DELETE FROM meta_sync_state WHERE run_key LIKE 'db_growth:%'")
  })

  it('1. cap-hit reporting: 12k eligible, cap removes only ceiling, partial + backlog exposed', async () => {
    const { postId, targetId } = await seedFinancialAndAnalyticsRows(user)
    await bulkInsertEngagement(Array.from({ length: 12000 }, () => ({ postId, targetId, ageDays: beyond('post_engagement_daily') })))

    const entry = findTablePurge('post_engagement_daily')
    const first = await runTablePurge(entry, { deleteBatch: 5000, maxBatchesPerRun: 1 })
    expect(first.rowsDeleted).toBe(5000)
    expect(first.capped).toBe(true)
    expect(first.complete).toBe(false)
    expect(first.partial).toBe(true)
    expect(first.backlogRows).toBe(7000)

    const second = await runTablePurge(entry, { deleteBatch: 5000, maxBatchesPerRun: 1 })
    expect(second.rowsDeleted).toBe(5000)
    expect(second.consecutivePartialRuns).toBe(2)

    const third = await runTablePurge(entry, { deleteBatch: 5000, maxBatchesPerRun: 50 })
    expect(third.rowsDeleted).toBe(2000)
    expect(third.complete).toBe(true)
    expect(third.consecutivePartialRuns).toBe(0)
  }, 240000)

  it('2. under-cap completeness: all eligible deleted, complete=true comes from the residual probe', async () => {
    const { postId, targetId } = await seedFinancialAndAnalyticsRows(user)
    await bulkInsertEngagement(Array.from({ length: 3000 }, () => ({ postId, targetId, ageDays: beyond('post_engagement_daily') })))

    const entry = findTablePurge('post_engagement_daily')
    const result = await runTablePurge(entry, { deleteBatch: 5000, maxBatchesPerRun: 50 })
    expect(result.rowsDeleted).toBe(3000)
    expect(result.capped).toBe(false)
    expect(result.complete).toBe(true)
    expect(result.partial).toBe(false)
    expect(result.backlogRows).toBe(0)
  }, 120000)

  it('3. consecutive partial tracking: increments on partial, resets on complete', async () => {
    await query("DELETE FROM meta_sync_state WHERE run_key LIKE 'retention:%'")
    const entry = findTablePurge('meta_webhook_events')
    await insertWebhookRow(beyond('meta_webhook_events'))
    await insertWebhookRow(beyond('meta_webhook_events'))
    await insertWebhookRow(beyond('meta_webhook_events'))

    const first = await runTablePurge(entry, { deleteBatch: 1, maxBatchesPerRun: 1 })
    expect(first.partial).toBe(true)
    const state1 = await queryOne("SELECT state FROM meta_sync_state WHERE run_key = 'retention:meta_webhook_events'")
    expect(JSON.parse(state1.state).consecutivePartialRuns).toBe(1)

    const second = await runTablePurge(entry, { deleteBatch: 1, maxBatchesPerRun: 1 })
    expect(second.partial).toBe(true)
    expect(second.consecutivePartialRuns).toBe(2)

    const third = await runTablePurge(entry, { deleteBatch: 5000, maxBatchesPerRun: 50 })
    expect(third.complete).toBe(true)
    expect(third.consecutivePartialRuns).toBe(0)
    const state2 = await queryOne("SELECT state FROM meta_sync_state WHERE run_key = 'retention:meta_webhook_events'")
    expect(JSON.parse(state2.state).consecutivePartialRuns).toBe(0)
  })

  it('4. partial logs warn, complete logs info', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => { })
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => { })
    const origBatch = retentionOptions.deleteBatch
    const origMax = retentionOptions.maxBatchesPerRun
    try {
      await insertWebhookRow(beyond('meta_webhook_events'))
      await insertWebhookRow(beyond('meta_webhook_events'))
      await insertWebhookRow(beyond('meta_webhook_events'))

      // force maintenance itself to cap out (1 row/batch, 1 batch/run) — the
      // exported-mutable-tunables pattern used for igContainerPoll etc.
      retentionOptions.deleteBatch = 1
      retentionOptions.maxBatchesPerRun = 1
      const maintenancePartial = await runJobMaintenance()
      expect(Array.isArray(maintenancePartial.partial)).toBe(true)
      expect(maintenancePartial.partial.length).toBeGreaterThan(0)
      expect(warnSpy).toHaveBeenCalled()

      // restore full capacity: next maintenance completes everything -> info
      retentionOptions.deleteBatch = 5000
      retentionOptions.maxBatchesPerRun = 50
      warnSpy.mockClear()
      const maintenanceClean = await runJobMaintenance()
      expect(maintenanceClean.partial).toEqual([])
      expect(infoSpy).toHaveBeenCalled()
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      retentionOptions.deleteBatch = origBatch
      retentionOptions.maxBatchesPerRun = origMax
      infoSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it('5. health exposure: partial tables listed, healthy shows empty partial list', async () => {
    await query("DELETE FROM meta_sync_state WHERE run_key LIKE 'retention:%'")
    await insertWebhookRow(beyond('meta_webhook_events'))
    await insertWebhookRow(beyond('meta_webhook_events'))
    const entry = findTablePurge('meta_webhook_events')
    await runTablePurge(entry, { deleteBatch: 1, maxBatchesPerRun: 1 })

    const health = await campaignService.getMetaSyncHealth()
    expect(health.retention).toBeTruthy()
    expect(health.retention.tables['meta_webhook_events'].partial).toBe(true)
    expect(health.retention.partial).toContain('meta_webhook_events')

    await runTablePurge(entry, { deleteBatch: 5000, maxBatchesPerRun: 50 })
    const health2 = await campaignService.getMetaSyncHealth()
    expect(health2.retention.partial).not.toContain('meta_webhook_events')
    expect(health2.retention.tables['meta_webhook_events'].complete).toBe(true)
  })

  it('6. residual probe independence: under-delete scenario reports incomplete truthfully', async () => {
    const { postId, targetId } = await seedFinancialAndAnalyticsRows(user)
    await bulkInsertEngagement(Array.from({ length: 3 }, () => ({ postId, targetId, ageDays: beyond('post_engagement_daily') })))

    const entry = findTablePurge('post_engagement_daily')
    const one = await runTablePurge(entry, { deleteBatch: 1, maxBatchesPerRun: 1 })
    expect(one.rowsDeleted).toBe(1)
    expect(one.capped).toBe(true)
    expect(one.complete).toBe(false)
    expect(one.backlogRows).toBe(2)

    const rest = await runTablePurge(entry, { deleteBatch: 5000, maxBatchesPerRun: 50 })
    expect(rest.rowsDeleted).toBe(2)
    expect(rest.complete).toBe(true)
  })

  it('7. financial tables immune: 400-day-old rows survive a full sweep', async () => {
    const rows = await seedFinancialAndAnalyticsRows(user)
    await runRetentionSweep({ deleteBatch: 5000, maxBatchesPerRun: 50 })

    const ledger = await queryOne('SELECT COUNT(*) AS c FROM usage_ledger WHERE user_id = ?', [uuidToBuffer(user.id)])
    const tx = await queryOne('SELECT COUNT(*) AS c FROM transactions WHERE user_id = ?', [uuidToBuffer(user.id)])
    const cbe = await queryOne('SELECT COUNT(*) AS c FROM campaign_billing_entries WHERE campaign_id = ?', [uuidToBuffer(rows.campaignId)])
    const pbe = await queryOne('SELECT COUNT(*) AS c FROM post_billing_entries WHERE post_id = ?', [uuidToBuffer(rows.postId)])
    expect(Number(ledger.c)).toBeGreaterThan(0)
    expect(Number(tx.c)).toBeGreaterThan(0)
    expect(Number(cbe.c)).toBeGreaterThan(0)
    expect(Number(pbe.c)).toBeGreaterThan(0)
  })

  it('8. analytics immunity: campaign_daily_stats and post_boost_daily_stats survive a full sweep', async () => {
    const rows = await seedFinancialAndAnalyticsRows(user)
    await runRetentionSweep({ deleteBatch: 5000, maxBatchesPerRun: 50 })

    const cds = await queryOne('SELECT COUNT(*) AS c FROM campaign_daily_stats WHERE campaign_id = ?', [uuidToBuffer(rows.campaignId)])
    const pbds = await queryOne('SELECT COUNT(*) AS c FROM post_boost_daily_stats WHERE post_id = ?', [uuidToBuffer(rows.postId)])
    expect(Number(cds.c)).toBeGreaterThan(0)
    expect(Number(pbds.c)).toBeGreaterThan(0)
  })

  it('9. batch limit: never exceeds batch x maxBatches per table per run', async () => {
    const { postId, targetId } = await seedFinancialAndAnalyticsRows(user)
    await bulkInsertEngagement(Array.from({ length: 12000 }, () => ({ postId, targetId, ageDays: beyond('post_engagement_daily') })))

    const entry = findTablePurge('post_engagement_daily')
    const result = await runTablePurge(entry, { deleteBatch: 5000, maxBatchesPerRun: 2 })
    expect(result.rowsDeleted).toBe(10000)
    expect(result.capped).toBe(true)
    expect(result.complete).toBe(false)

    const finish = await runTablePurge(entry, { deleteBatch: 5000, maxBatchesPerRun: 50 })
    expect(finish.complete).toBe(true)
  }, 120000)

  it('10. idempotence: running purge twice is safe', async () => {
    const { postId, targetId } = await seedFinancialAndAnalyticsRows(user)
    await bulkInsertEngagement([
      { postId, targetId, ageDays: beyond('post_engagement_daily') },
      { postId, targetId, ageDays: beyond('post_engagement_daily') },
    ])
    const entry = findTablePurge('post_engagement_daily')

    const first = await runTablePurge(entry)
    const second = await runTablePurge(entry)
    expect(first.complete).toBe(true)
    expect(second.complete).toBe(true)
    expect(second.rowsDeleted).toBe(0)
  })

  it('11. partial resume: second run removes remaining eligible rows', async () => {
    const { postId, targetId } = await seedFinancialAndAnalyticsRows(user)
    await bulkInsertEngagement(Array.from({ length: 6500 }, () => ({ postId, targetId, ageDays: beyond('post_engagement_daily') })))

    const entry = findTablePurge('post_engagement_daily')
    const first = await runTablePurge(entry, { deleteBatch: 5000, maxBatchesPerRun: 1 })
    expect(first.complete).toBe(false)
    expect(first.backlogRows).toBe(1500)

    const second = await runTablePurge(entry, { deleteBatch: 5000, maxBatchesPerRun: 50 })
    expect(second.rowsDeleted).toBe(1500)
    expect(second.complete).toBe(true)
  }, 120000)

  it('12. active jobs protected: queued/running never deleted, done/dead purged', async () => {
    const queued = await insertJob({ status: 'queued' })
    const running = await insertJob({ status: 'running' })
    const oldDone = await insertJob({ status: 'done', finishedAtAgeDays: beyond('campaign_jobs') })
    const oldDead = await insertJob({ status: 'dead', finishedAtAgeDays: beyond('campaign_jobs') })

    const entry = findTablePurge('campaign_jobs')
    const result = await runTablePurge(entry, { deleteBatch: 5000, maxBatchesPerRun: 50 })

    expect(await queryOne('SELECT id FROM campaign_jobs WHERE id = ?', [uuidToBuffer(queued)])).not.toBeNull()
    expect(await queryOne('SELECT id FROM campaign_jobs WHERE id = ?', [uuidToBuffer(running)])).not.toBeNull()
    expect(await queryOne('SELECT id FROM campaign_jobs WHERE id = ?', [uuidToBuffer(oldDone)])).toBeNull()
    expect(await queryOne('SELECT id FROM campaign_jobs WHERE id = ?', [uuidToBuffer(oldDead)])).toBeNull()
    expect(result.rowsDeleted).toBeGreaterThanOrEqual(2)
  })

  it('13. FK safety: purging expired child rows never deletes the parent user', async () => {
    const fkUser = await createTestUser({ email: `retention-fk-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    OWNED_USERS.push(fkUser.id)
    const sessionId = await insertExpiredSession(fkUser, 2)
    const otpId = await insertPhoneOtp(fkUser, 2)
    await insertLoginHistoryRow(fkUser, beyond('auth_login_history'))
    await insertAuditRow(fkUser, beyond('audit_logs'))

    await runRetentionSweep({ deleteBatch: 5000, maxBatchesPerRun: 50 })

    const userRow = await queryOne('SELECT id FROM users WHERE id = ?', [uuidToBuffer(fkUser.id)])
    expect(userRow).not.toBeNull()
    expect(await queryOne('SELECT id FROM user_sessions WHERE id = ?', [uuidToBuffer(sessionId)])).toBeNull()
    expect(await queryOne('SELECT id FROM phone_otps WHERE id = ?', [uuidToBuffer(otpId)])).toBeNull()
  })

  it('14. boundary behavior: just-inside survives, beyond deleted — every table family', async () => {
    const { postId, targetId } = await seedFinancialAndAnalyticsRows(user)

    await bulkInsertEngagement([
      { postId, targetId, ageDays: 91 },
      { postId, targetId, ageDays: 1 },
    ])
    const webhookOld = await insertWebhookRow(beyond('meta_webhook_events'))
    const webhookFresh = await insertWebhookRow(1)
    const snapshotOld = await insertSnapshotRow(31)
    const snapshotFresh = await insertSnapshotRow(1)
    const loginOld = await insertLoginHistoryRow(user, 366)
    const loginFresh = await insertLoginHistoryRow(user, 1)
    const auditOld = await insertAuditRow(user, 366)
    const auditFresh = await insertAuditRow(user, 1)

    await runRetentionSweep({ deleteBatch: 5000, maxBatchesPerRun: 50 })

    const count = async (sql, params) => Number((await queryOne(sql, params))?.c || 0)
    expect(await count('SELECT COUNT(*) AS c FROM meta_webhook_events WHERE id = ?', [webhookOld])).toBe(0)
    expect(await count('SELECT COUNT(*) AS c FROM meta_webhook_events WHERE id = ?', [webhookFresh])).toBe(1)
    expect(await count('SELECT COUNT(*) AS c FROM meta_account_snapshots WHERE ad_account_id = ? AND created_at < NOW() - INTERVAL ? DAY', ['act_retention_test', String(beyond('meta_account_snapshots'))])).toBe(0)
    expect(await count('SELECT COUNT(*) AS c FROM meta_account_snapshots WHERE id = ?', [uuidToBuffer(snapshotFresh)])).toBe(1)
    expect(await count('SELECT COUNT(*) AS c FROM auth_login_history WHERE id = ?', [uuidToBuffer(loginOld)])).toBe(0)
    expect(await count('SELECT COUNT(*) AS c FROM auth_login_history WHERE id = ?', [uuidToBuffer(loginFresh)])).toBe(1)
    expect(await count('SELECT COUNT(*) AS c FROM audit_logs WHERE id = ?', [uuidToBuffer(auditOld)])).toBe(0)
    expect(await count('SELECT COUNT(*) AS c FROM audit_logs WHERE id = ?', [uuidToBuffer(auditFresh)])).toBe(1)
    const engOld = await queryOne(
      'SELECT COUNT(*) AS c FROM post_engagement_daily WHERE post_id = ? AND created_at < NOW() - INTERVAL ? DAY',
      [uuidToBuffer(postId), String(ttlDays('post_engagement_daily'))]
    )
    expect(Number(engOld.c)).toBe(0)
    const engFresh = await queryOne(
      'SELECT COUNT(*) AS c FROM post_engagement_daily WHERE post_id = ? AND created_at >= NOW() - INTERVAL ? DAY',
      [uuidToBuffer(postId), String(ttlDays('post_engagement_daily'))]
    )
    expect(Number(engFresh.c)).toBeGreaterThan(0)
    void webhookOld; void snapshotOld; void loginOld; void auditOld
  })

  it('15. migration 080: four indexes exist and re-running is idempotent', async () => {
    const rows = await query(
      `SELECT TABLE_NAME, INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
       AND INDEX_NAME IN ('idx_meta_snapshot_created_at','idx_user_sessions_expires_at','idx_audit_logs_created_at','idx_auth_login_history_created_at')`
    )
    const found = new Set(rows.map(r => `${r.TABLE_NAME}:${r.INDEX_NAME}`))
    expect(found.has('meta_account_snapshots:idx_meta_snapshot_created_at')).toBe(true)
    expect(found.has('user_sessions:idx_user_sessions_expires_at')).toBe(true)
    expect(found.has('audit_logs:idx_audit_logs_created_at')).toBe(true)
    expect(found.has('auth_login_history:idx_auth_login_history_created_at')).toBe(true)

    const { up } = await import('../../shared/database/migrations/080_retention_indexes.js')
    const { getPool } = await import('../../shared/database/connection.js')
    await up({ context: getPool() })
    const after = await query(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'meta_account_snapshots'`
    )
    expect(after.filter(r => r.INDEX_NAME === 'idx_meta_snapshot_created_at').length).toBe(1)
  })

  it('16. configuration: invalid values resolve to safe bounded defaults', () => {
    expect(_clampDays('abc', 7)).toBe(7)
    expect(_clampDays(0, 7)).toBe(7)
    expect(_clampDays(-5, 7)).toBe(7)
    expect(_clampDays(2.9, 7)).toBe(2)
    expect(_clampDays('90', 90)).toBe(90)
    expect(_clampBatch('abc', 5000)).toBe(5000)
    expect(_clampBatch(0, 5000)).toBe(5000)
    expect(_clampBatch(-3, 50)).toBe(50)
    expect(_clampBatch('5000', 5000)).toBe(5000)
    expect(retentionOptions.deleteBatch).toBeGreaterThan(0)
    expect(retentionOptions.maxBatchesPerRun).toBeGreaterThan(0)
  })

  it('db_growth: daily sample stored, capped at 31 keys, deltas exposed in health', async () => {
    await query("DELETE FROM meta_sync_state WHERE run_key LIKE 'db_growth:%'")
    const sample = await sampleDbGrowth()
    expect(sample).not.toBeNull()
    expect(sample.tables.posts).toBeTruthy()

    const growth = await getDbGrowthSnapshot()
    expect(growth.latestSampleDate).toBe(new Date().toISOString().slice(0, 10))
    expect(growth.tables.campaign_jobs).toBeTruthy()
    expect(growth.deltas['24h']).toBeNull()

    const staleDate = '2020-01-01'
    await query(
      `INSERT INTO meta_sync_state (run_key, state) VALUES (?, ?)`,
      [`db_growth:${staleDate}`, JSON.stringify({ sampledAt: staleDate, tables: {} })]
    )
    const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    await query(
      `INSERT INTO meta_sync_state (run_key, state) VALUES (?, ?)`,
      [`db_growth:${recentDate}`, JSON.stringify({ sampledAt: recentDate, tables: { posts: { rows: 1, dataKB: 1, indexKB: 1 } } })]
    )
    await sampleDbGrowth()

    const keys = await query("SELECT run_key FROM meta_sync_state WHERE run_key LIKE 'db_growth:%'")
    expect(keys.length).toBeLessThanOrEqual(31)
    expect(keys.find(k => k.run_key === 'db_growth:2020-01-01')).toBeUndefined()

    const growth2 = await getDbGrowthSnapshot()
    expect(growth2.deltas['24h']).toBeTruthy()
    expect(growth2.deltas['24h'].posts.rows).toBeGreaterThanOrEqual(0)
  })
})
