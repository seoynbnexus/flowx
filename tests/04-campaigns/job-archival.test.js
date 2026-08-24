import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { createTestUser } from '../helpers/create-user.js'
import * as repo from '../../src/modules/campaigns/campaign.repository.js'
import { maintenance, maintenanceDue, runJobMaintenance } from '../../src/modules/campaigns/campaign.jobs.js'
import { query, queryOne } from '../../shared/database/connection.js'
import { encrypt } from '../../shared/utils/crypto.utils.js'

const RUN_KEY_PREFIX = `archival-test-${Date.now()}`

async function insertJob({ status = 'queued', finishedAtAgeDays = null, runAfterAgeHours = 1, jobType = 'retry_meta' }) {
  const id = generateUuid()
  const runKey = `${RUN_KEY_PREFIX}-${id}`
  const params = [uuidToBuffer(id), jobType, status, runKey]
  const finishedAt = finishedAtAgeDays == null
    ? 'NULL'
    : `DATE_SUB(NOW(), INTERVAL ${finishedAtAgeDays} DAY)`
  const runAfter = `DATE_SUB(NOW(), INTERVAL ${runAfterAgeHours} HOUR)`
  await query(
    `INSERT INTO campaign_jobs (id, job_type, entity_type, status, run_key, run_after, finished_at, created_at, updated_at)
     VALUES (?, ?, 'campaign', ?, ?, ${runAfter}, ${finishedAt}, NOW(), NOW())`,
    params
  )
  return { id, runKey }
}

async function jobById(id) {
  return queryOne('SELECT status FROM campaign_jobs WHERE id = ?', [uuidToBuffer(id)])
}

describe('job archival', () => {
  const created = { jobs: [], webhooks: [] }

  afterAll(async () => {
    await query("DELETE FROM campaign_jobs WHERE run_key LIKE ?", [`${RUN_KEY_PREFIX}-%`])
    await query("DELETE FROM meta_webhook_events WHERE id LIKE ?", [`${RUN_KEY_PREFIX}-%`])
    for (const id of created.jobs) {
      await query('DELETE FROM post_engagement_daily WHERE id = ?', [uuidToBuffer(id)])
    }
  })

  it('purges only terminal jobs older than the retention window', async () => {
    const oldDone = await insertJob({ status: 'done', finishedAtAgeDays: 8 })
    const oldDead = await insertJob({ status: 'dead', finishedAtAgeDays: 8 })
    const recentDone = await insertJob({ status: 'done', finishedAtAgeDays: 1 })
    const oldQueued = await insertJob({ status: 'queued', finishedAtAgeDays: null })
    const oldRunning = await insertJob({ status: 'running', finishedAtAgeDays: null })

    const result = await repo.purgeTerminalJobs(7)

    expect(await jobById(oldDone.id)).toBeNull()
    expect(await jobById(oldDead.id)).toBeNull()
    expect(await jobById(recentDone.id)).not.toBeNull()
    expect(await jobById(oldQueued.id)).not.toBeNull()
    expect(await jobById(oldRunning.id)).not.toBeNull()
    expect(result.removed).toBeGreaterThanOrEqual(2)

    await query("DELETE FROM campaign_jobs WHERE id IN (?, ?, ?)",
      [uuidToBuffer(recentDone.id), uuidToBuffer(oldQueued.id), uuidToBuffer(oldRunning.id)])
  })

  it('purges old engagement rows only', async () => {
    const user = await createTestUser({ email: `arch-eng-${Date.now()}@flowx-test.com`, password: 'Test@123' })
    const platform = await queryOne("SELECT id FROM platforms WHERE code = 'facebook'")
    const accountId = generateUuid()
    await query(
      `INSERT INTO user_platform_accounts (id, user_id, platform_id, profile_url, platform_user_id,
         platform_username, access_token, token_type, token_expires_at, verification_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'page', DATE_ADD(NOW(), INTERVAL 60 DAY), 'verified')`,
      [uuidToBuffer(accountId), uuidToBuffer(user.id), platform.id, 'https://fb.com/arch', `arch_fb_${Date.now()}`, 'ArchPage', encrypt('mock_page_token')]
    )
    const { createPost, setPostTargets } = await import('../../src/modules/posts/post.service.js')
    const post = await createPost(user.id, {
      name: `Archival Post ${Date.now()}`,
      type: 'post',
      caption: 'c',
      mediaUrl: 'https://example.com/img.jpg',
      targetAccountIds: [accountId],
    })
    const target = await queryOne('SELECT id FROM post_targets WHERE post_id = ?', [uuidToBuffer(post.id)])

    const oldRowId = generateUuid()
    created.jobs.push(oldRowId)
    await query(
      `INSERT INTO post_engagement_daily (id, post_id, target_id, stat_date, created_at, updated_at)
       VALUES (?, ?, ?, CURDATE() - INTERVAL 95 DAY, DATE_SUB(NOW(), INTERVAL 95 DAY), DATE_SUB(NOW(), INTERVAL 95 DAY))`,
      [uuidToBuffer(oldRowId), uuidToBuffer(post.id), target.id]
    )
    const freshRowId = generateUuid()
    created.jobs.push(freshRowId)
    await query(
      `INSERT INTO post_engagement_daily (id, post_id, target_id, stat_date, created_at, updated_at)
       VALUES (?, ?, ?, CURDATE() - INTERVAL 1 DAY, DATE_SUB(NOW(), INTERVAL 1 DAY), DATE_SUB(NOW(), INTERVAL 1 DAY))`,
      [uuidToBuffer(freshRowId), uuidToBuffer(post.id), target.id]
    )

    const result = await repo.purgeOldEngagementRows(90)

    expect(await queryOne('SELECT id FROM post_engagement_daily WHERE id = ?', [uuidToBuffer(oldRowId)])).toBeNull()
    expect(await queryOne('SELECT id FROM post_engagement_daily WHERE id = ?', [uuidToBuffer(freshRowId)])).not.toBeNull()
    expect(result.removed).toBeGreaterThanOrEqual(1)

    await query('DELETE FROM post_targets WHERE id = ?', [target.id])
  })

  it('purges old webhook events only', async () => {
    const oldId = `${RUN_KEY_PREFIX}-old-${Date.now()}`
    const freshId = `${RUN_KEY_PREFIX}-fresh-${Date.now()}`
    created.webhooks.push(oldId, freshId)
    await query(
      "INSERT INTO meta_webhook_events (id, event_type, payload, created_at) VALUES (?, 'campaign.status_update', '{}', DATE_SUB(NOW(), INTERVAL 95 DAY))",
      [oldId]
    )
    await query(
      "INSERT INTO meta_webhook_events (id, event_type, payload, created_at) VALUES (?, 'campaign.status_update', '{}', DATE_SUB(NOW(), INTERVAL 1 DAY))",
      [freshId]
    )

    const result = await repo.purgeOldWebhookEvents(90)

    expect(await queryOne('SELECT id FROM meta_webhook_events WHERE id = ?', [oldId])).toBeNull()
    expect(await queryOne('SELECT id FROM meta_webhook_events WHERE id = ?', [freshId])).not.toBeNull()
    expect(result.removed).toBeGreaterThanOrEqual(1)
  })

  it('counts dead jobs and reports the oldest queued job', async () => {
    const newish = await insertJob({ status: 'queued', runAfterAgeHours: 1 })
    const older = await insertJob({ status: 'queued', runAfterAgeHours: 5 })
    await insertJob({ status: 'dead', finishedAtAgeDays: 8 })

    const deadCount = await repo.countDeadJobs()
    expect(deadCount).toBeGreaterThanOrEqual(1)

    const [newishRow, olderRow] = await Promise.all([
      queryOne('SELECT run_after FROM campaign_jobs WHERE id = ?', [uuidToBuffer(newish.id)]),
      queryOne('SELECT run_after FROM campaign_jobs WHERE id = ?', [uuidToBuffer(older.id)]),
    ])

    const oldest = await repo.oldestQueuedJob()
    expect(oldest.runAfter).toBeTruthy()
    const oldestMs = new Date(oldest.runAfter).getTime()
    expect(oldestMs).toBeLessThanOrEqual(new Date(newishRow.run_after).getTime())
    expect(Math.abs(oldestMs - new Date(olderRow.run_after).getTime())).toBeLessThan(60 * 60 * 1000)

    await query("DELETE FROM campaign_jobs WHERE id IN (?, ?)", [uuidToBuffer(newish.id), uuidToBuffer(older.id)])
  })

  it('maintenance runs at most once per interval and reports removed counts', async () => {
    await insertJob({ status: 'done', finishedAtAgeDays: 8, jobType: 'sync_status' })

    const previousRun = maintenance.lastRunAt
    maintenance.lastRunAt = Date.now()
    expect(maintenanceDue()).toBe(false)
    maintenance.lastRunAt = Date.now() - maintenance.intervalMs - 1
    expect(maintenanceDue()).toBe(true)
    maintenance.lastRunAt = previousRun

    const result = await runJobMaintenance()
    expect(typeof result.removed).toBe('number')
  })
})