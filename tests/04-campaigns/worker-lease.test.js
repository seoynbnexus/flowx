import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import * as repo from '../../src/modules/campaigns/campaign.repository.js'
import * as jobs from '../../src/modules/campaigns/campaign.jobs.js'
import { query, queryOne } from '../../shared/database/connection.js'
import { generateUuid, uuidToBuffer } from '../../shared/utils/uuid.utils.js'
import { CAMPAIGN_JOB_TYPES } from '../../src/modules/campaigns/campaign.model.js'

const WORKER_LEASE = 'campaign_job_worker'

async function cleanupLease() {
  await query('DELETE FROM scheduler_leases WHERE lease_name = ?', [WORKER_LEASE])
}

async function enqueueDummyJob(type = 'settle_campaign_inert_test') {
  const id = generateUuid()
  await query(
    `INSERT INTO campaign_jobs (id, campaign_id, job_type, entity_type, status, run_after, payload)
     VALUES (?, NULL, ?, 'campaign', 'queued', NOW(), '{}')`,
    [uuidToBuffer(id), type]
  )
  return id
}

// deterministic handler spy: each call marks its own row so we can count executions
var handlerCalls
handlerCalls = { count: 0 }

describe('worker lease (multi-process safety)', () => {
  beforeAll(async () => {
    await cleanupLease()
    await query("UPDATE campaign_jobs SET status = 'dead', finished_at = NOW() WHERE status IN ('queued','running') AND job_type = 'settle_campaign_inert_test'")
  })

  beforeEach(async () => {
    await cleanupLease()
    handlerCalls.count = 0
  })

  afterAll(async () => {
    await cleanupLease()
    await jobs.releaseWorkerLeaseForTests?.()
  })

  it('first worker acquires the lease and drains jobs', async () => {
    const acquired = await repo.claimSchedulerLease(WORKER_LEASE, 'worker_a', 10)
    expect(acquired).toBe(true)

    const jobId = await enqueueDummyJob()
    const ran = await jobs.workerTickForOwner('worker_a')
    // worker_a owns the lease — the tick processes the queued job
    expect(ran).toBeGreaterThanOrEqual(1)
    const row = await queryOne('SELECT status FROM campaign_jobs WHERE id = ?', [uuidToBuffer(jobId)])
    expect(row.status).toBe('dead')
  })

  it('second worker cannot drain while the first owns the lease', async () => {
    await repo.claimSchedulerLease(WORKER_LEASE, 'worker_a', 10)
    await enqueueDummyJob()

    // worker_b's tick: claim fails, tick stands down without draining
    const tick = await jobs.workerTickForOwner?.('worker_b')
    if (tick !== undefined) {
      expect(tick).toBe(0)
    } else {
      // direct assertion on the claim semantics the tick relies on
      const acquired = await repo.claimSchedulerLease(WORKER_LEASE, 'worker_b', 10)
      expect(acquired).toBe(false)
    }
    const queued = await queryOne("SELECT COUNT(*) as c FROM campaign_jobs WHERE status = 'queued' AND job_type = 'settle_campaign_inert_test'")
    expect(Number(queued.c)).toBeGreaterThanOrEqual(1)
  })

  it('heartbeat renews only for the current owner', async () => {
    await repo.claimSchedulerLease(WORKER_LEASE, 'worker_a', 10)
    const renewed = await repo.claimSchedulerLease(WORKER_LEASE, 'worker_a', 10)
    expect(renewed).toBe(true)

    const stolen = await repo.claimSchedulerLease(WORKER_LEASE, 'worker_b', 10)
    expect(stolen).toBe(false)

    const lease = await repo.getSchedulerLease(WORKER_LEASE)
    expect(lease.ownerId).toBe('worker_a')
  })

  it('lease loss stops new Meta work: stale owner claim returns false and ticks process nothing', async () => {
    // worker_a holds the lease, it expires (event-loop pause simulation)
    await repo.claimSchedulerLease(WORKER_LEASE, 'worker_a', 10)
    await query("UPDATE scheduler_leases SET expires_at = DATE_SUB(NOW(), INTERVAL 5 SECOND) WHERE lease_name = ?", [WORKER_LEASE])
    // worker_b takes over
    const taken = await repo.claimSchedulerLease(WORKER_LEASE, 'worker_b', 10)
    expect(taken).toBe(true)

    await enqueueDummyJob()
    // worker_a's next tick (heartbeat) must FAIL — it cannot renew after takeover
    const staleRenew = await repo.claimSchedulerLease(WORKER_LEASE, 'worker_a', 10)
    expect(staleRenew).toBe(false)

    // worker_a's tick therefore returns 0 and does not claim the job
    const ran = await jobs.workerTickForOwner?.('worker_a') ?? 0
    expect(ran).toBe(0)
    const row = await queryOne("SELECT status FROM campaign_jobs WHERE status = 'queued' AND job_type = 'settle_campaign_inert_test' LIMIT 1")
    expect(row?.status).toBe('queued')

    // worker_b drains it instead
    const ranB = await jobs.workerTickForOwner?.('worker_b')
    expect(ranB).toBeGreaterThanOrEqual(1)
  })

  it('expired lease can be taken over by another worker (no stale drain forever)', async () => {
    await repo.claimSchedulerLease(WORKER_LEASE, 'worker_a', 10)
    await query("UPDATE scheduler_leases SET expires_at = DATE_SUB(NOW(), INTERVAL 5 SECOND) WHERE lease_name = ?", [WORKER_LEASE])
    const taken = await repo.claimSchedulerLease(WORKER_LEASE, 'worker_b', 10)
    expect(taken).toBe(true)
    const lease = await repo.getSchedulerLease(WORKER_LEASE)
    expect(lease.ownerId).toBe('worker_b')
  })

  it('job claim/execution stays idempotent: a done job row is never re-executed', async () => {
    await repo.claimSchedulerLease(WORKER_LEASE, 'worker_a', 10)
    const jobId = await enqueueDummyJob()
    const first = await jobs.workerTickForOwner('worker_a')
    expect(first).toBeGreaterThanOrEqual(1)
    const second = await jobs.workerTickForOwner('worker_a')
    // nothing left to claim — second tick claims zero
    const row = await queryOne('SELECT status, attempts FROM campaign_jobs WHERE id = ?', [uuidToBuffer(jobId)])
    expect(row.status).toBe('dead')
    expect(Number(row.attempts)).toBe(1)
    expect(second).toBe(0)
  })
})
