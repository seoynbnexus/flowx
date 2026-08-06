import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as repo from '../../src/modules/campaigns/campaign.repository.js'
import { query } from '../../shared/database/connection.js'

const LEASE = 'test_scheduler_lease'

async function cleanup() {
  await query("DELETE FROM scheduler_leases WHERE lease_name = 'test_scheduler_lease'")
}

beforeAll(async () => {
  await cleanup()
})

afterAll(async () => {
  await cleanup()
})

describe('scheduler leader election', () => {
  it('acquires a fresh lease', async () => {
    const acquired = await repo.claimSchedulerLease(LEASE, 'instance_a', 30)
    expect(acquired).toBe(true)

    const lease = await repo.getSchedulerLease(LEASE)
    expect(lease.ownerId).toBe('instance_a')
    expect(new Date(lease.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('blocks a second owner while the lease is unexpired', async () => {
    const acquired2 = await repo.claimSchedulerLease(LEASE, 'instance_b', 30)
    expect(acquired2).toBe(false)

    const lease = await repo.getSchedulerLease(LEASE)
    expect(lease.ownerId).toBe('instance_a')
  })

  it('renews the lease for the current owner (heartbeat)', async () => {
    const renewed = await repo.claimSchedulerLease(LEASE, 'instance_a', 30)
    expect(renewed).toBe(true)

    const lease = await repo.getSchedulerLease(LEASE)
    expect(lease.ownerId).toBe('instance_a')
  })

  it('allows takeover after the lease expires', async () => {
    await query("UPDATE scheduler_leases SET expires_at = DATE_SUB(NOW(), INTERVAL 5 SECOND) WHERE lease_name = ?", [LEASE])

    const acquired = await repo.claimSchedulerLease(LEASE, 'instance_b', 30)
    expect(acquired).toBe(true)

    const lease = await repo.getSchedulerLease(LEASE)
    expect(lease.ownerId).toBe('instance_b')
  })

  it('release removes the lease only for its owner', async () => {
    await repo.releaseSchedulerLease(LEASE, 'instance_a')
    const stillOwned = await repo.getSchedulerLease(LEASE)
    expect(stillOwned.ownerId).toBe('instance_b')

    await repo.releaseSchedulerLease(LEASE, 'instance_b')
    expect(await repo.getSchedulerLease(LEASE)).toBeNull()
  })

  it('returns null for an unknown lease', async () => {
    expect(await repo.getSchedulerLease('no_such_lease')).toBeNull()
  })
})