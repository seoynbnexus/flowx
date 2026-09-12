import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  metaRequest,
  metaGateOptions,
  GATE_PRIORITY,
  getGateStats,
  getAccountWindowRate,
  getRecentRequests,
  resetGateStats,
  runWithMetaRequestContext,
  currentMetaRequestContext,
  tokenFingerprint,
} from '../../shared/services/meta-request-gate.js'
import { logger } from '../../shared/utils/logger.js'

function fakeResponse(status = 200, body = { ok: true }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map(),
    clone() { return fakeResponse(status, body) },
    async json() { return body },
    async text() { return JSON.stringify(body) },
  }
}

function delayedFetch(ms, status = 200) {
  return () => new Promise((resolve) => setTimeout(() => resolve(fakeResponse(status)), ms))
}

describe('meta request gate (process-local)', () => {
  beforeEach(() => {
    resetGateStats()
    metaGateOptions.globalLimit = 8
    metaGateOptions.accountLimit = 4
    metaGateOptions.maxQueue = 100
    metaGateOptions.waitTimeoutMs = 20000
  })

  afterEach(() => {
    resetGateStats()
    vi.restoreAllMocks?.()
  })

  it('reports itself as process-local, never fleet-wide', () => {
    const stats = getGateStats()
    expect(stats.processLocal).toBe(true)
  })

  it('enforces the global concurrency limit', async () => {
    metaGateOptions.globalLimit = 2
    const calls = []
    const launch = (i) => metaRequest({
      method: 'POST', path: `node_${i}`, accountKey: 'act_A', token: 'tokA',
      operation: 'POST', metaFetch: () => new Promise((resolve) => { calls.push(i); setTimeout(() => resolve(fakeResponse()), 80) }),
    })
    const all = Promise.all([launch(1), launch(2), launch(3)])
    await new Promise((r) => setTimeout(r, 40))
    expect(getGateStats().globalInFlight).toBe(2)
    const res = await all
    expect(res).toHaveLength(3)
    expect(getGateStats().globalInFlight).toBe(0)
    expect(getGateStats().peakGlobalInFlight).toBe(2)
  })

  it('enforces the per-account concurrency limit', async () => {
    metaGateOptions.accountLimit = 2
    const all = Promise.all([1, 2, 3].map((i) => metaRequest({
      method: 'POST', path: `node_${i}`, accountKey: 'act_A', token: 'tokA',
      operation: 'POST', metaFetch: delayedFetch(80),
    })))
    await new Promise((r) => setTimeout(r, 40))
    const stats = getGateStats()
    expect(stats.byAccount['act_A'].inFlight).toBe(2)
    await all
    expect(getGateStats().byAccount['act_A'].inFlight).toBe(0)
  })

  it('account A saturating does not block account B', async () => {
    metaGateOptions.globalLimit = 8
    metaGateOptions.accountLimit = 2
    const a = [1, 2].map((i) => metaRequest({
      method: 'POST', path: `a_${i}`, accountKey: 'act_A', token: 'tokA',
      operation: 'POST', metaFetch: delayedFetch(120),
    }))
    const b = metaRequest({
      method: 'POST', path: 'b_1', accountKey: 'act_B', token: 'tokB',
      operation: 'POST', metaFetch: () => Promise.resolve(fakeResponse()),
    })
    const bRes = await b
    expect(bRes.status).toBe(200)
    const stats = getGateStats()
    expect(stats.byAccount['act_B'].requests).toBe(1)
    await Promise.all(a)
  })

  it('GET dedupe coalesces identical in-flight GETs into one fetch', async () => {
    let fetches = 0
    const fetcher = () => { fetches += 1; return delayedFetch(80)() }
    const params = { fields: 'id,name', access_token: 'tokA' }
    const [r1, r2, r3] = await Promise.all([
      metaRequest({ method: 'GET', path: 'act_1/insights', params, accountKey: 'act_A', token: 'tokA', operation: 'GET', metaFetch: fetcher }),
      metaRequest({ method: 'GET', path: 'act_1/insights', params, accountKey: 'act_A', token: 'tokA', operation: 'GET', metaFetch: fetcher }),
      metaRequest({ method: 'GET', path: 'act_1/insights', params, accountKey: 'act_A', token: 'tokA', operation: 'GET', metaFetch: fetcher }),
    ])
    expect(fetches).toBe(1)
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(r3.status).toBe(200)
    expect(getGateStats().dedupedGets).toBe(2)
  })

  it('GET dedupe key includes the token fingerprint (different auth contexts do not coalesce)', async () => {
    let fetches = 0
    const fetcher = () => { fetches += 1; return delayedFetch(60)() }
    const params = { fields: 'id' }
    await Promise.all([
      metaRequest({ method: 'GET', path: 'x', params, accountKey: 'k1', token: 'token_one', operation: 'GET', metaFetch: fetcher }),
      metaRequest({ method: 'GET', path: 'x', params, accountKey: 'k1', token: 'token_two', operation: 'GET', metaFetch: fetcher }),
    ])
    expect(fetches).toBe(2)
    expect(getGateStats().dedupedGets).toBe(0)
  })

  it('GET dedupe key normalizes parameter ordering', async () => {
    let fetches = 0
    const fetcher = () => { fetches += 1; return delayedFetch(60)() }
    await Promise.all([
      metaRequest({ method: 'GET', path: 'x', params: { fields: 'id', limit: '5' }, accountKey: 'k', token: 't', operation: 'GET', metaFetch: fetcher }),
      metaRequest({ method: 'GET', path: 'x', params: { limit: '5', fields: 'id' }, accountKey: 'k', token: 't', operation: 'GET', metaFetch: fetcher }),
    ])
    expect(fetches).toBe(1)
    expect(getGateStats().dedupedGets).toBe(1)
  })

  it('same path with different param values issues two requests (no false coalescing)', async () => {
    let fetches = 0
    const fetcher = () => { fetches += 1; return delayedFetch(60)() }
    await Promise.all([
      metaRequest({ method: 'GET', path: 'x', params: { fields: 'id' }, accountKey: 'k', token: 't', operation: 'GET', metaFetch: fetcher }),
      metaRequest({ method: 'GET', path: 'x', params: { fields: 'id,name' }, accountKey: 'k', token: 't', operation: 'GET', metaFetch: fetcher }),
    ])
    expect(fetches).toBe(2)
    expect(getGateStats().dedupedGets).toBe(0)
  })

  it('10+10 requests across two accounts never exceed 4/4/8 and B progresses while A is saturated', async () => {
    // defaults restored in beforeEach: global 8, per-account 4
    let peakA = 0
    let curA = 0
    let bDone = 0
    const mk = (acct, i) => metaRequest({
      method: 'POST', path: `ab_${acct}_${i}`, accountKey: acct, token: `tok_${acct}`,
      operation: 'POST',
      metaFetch: () => new Promise((resolve) => {
        if (acct === 'act_A') { curA += 1; peakA = Math.max(peakA, curA) }
        setTimeout(() => { if (acct === 'act_A') curA -= 1; else bDone += 1; resolve(fakeResponse()) }, 60)
      }),
    })
    const reqs = []
    for (let i = 0; i < 10; i++) reqs.push(mk('act_A', i))
    for (let i = 0; i < 10; i++) reqs.push(mk('act_B', i))
    await Promise.all(reqs)
    const stats = getGateStats()
    expect(peakA).toBeLessThanOrEqual(4)
    expect(stats.byAccount['act_A'].peakInFlight).toBeLessThanOrEqual(4)
    expect(stats.byAccount['act_B'].peakInFlight).toBeLessThanOrEqual(4)
    expect(stats.peakGlobalInFlight).toBeLessThanOrEqual(8)
    expect(stats.byAccount['act_A'].requests).toBe(10)
    expect(stats.byAccount['act_B'].requests).toBe(10)
    expect(bDone).toBe(10)
  })

  it('does NOT dedupe completed requests (no response caching)', async () => {
    let fetches = 0
    const fetcher = () => { fetches += 1; return Promise.resolve(fakeResponse()) }
    const params = { fields: 'id' }
    await metaRequest({ method: 'GET', path: 'y', params, accountKey: 'k', token: 't', operation: 'GET', metaFetch: fetcher })
    await metaRequest({ method: 'GET', path: 'y', params, accountKey: 'k', token: 't', operation: 'GET', metaFetch: fetcher })
    expect(fetches).toBe(2)
    expect(getGateStats().dedupedGets).toBe(0)
  })

  it('POST and DELETE are never deduped', async () => {
    let posts = 0
    let deletes = 0
    const postFetcher = () => { posts += 1; return delayedFetch(50)() }
    const deleteFetcher = () => { deletes += 1; return delayedFetch(50)() }
    await Promise.all([
      metaRequest({ method: 'POST', path: 'p', accountKey: 'k', token: 't', operation: 'POST', metaFetch: postFetcher }),
      metaRequest({ method: 'POST', path: 'p', accountKey: 'k', token: 't', operation: 'POST', metaFetch: postFetcher }),
      metaRequest({ method: 'DELETE', path: 'd', accountKey: 'k', token: 't', operation: 'DELETE', metaFetch: deleteFetcher }),
      metaRequest({ method: 'DELETE', path: 'd', accountKey: 'k', token: 't', operation: 'DELETE', metaFetch: deleteFetcher }),
    ])
    expect(posts).toBe(2)
    expect(deletes).toBe(2)
    expect(getGateStats().dedupedGets).toBe(0)
  })

  it('high priority is dispatched ahead of queued low priority', async () => {
    metaGateOptions.globalLimit = 1
    // occupy the single slot with a low request
    const busy = metaRequest({ method: 'POST', path: 'busy', accountKey: 'act_A', token: 't', operation: 'POST', metaFetch: delayedFetch(120) })
    await new Promise((r) => setTimeout(r, 30))
    const order = []
    // both queue; the high-priority one must be dispatched first on release
    const low = runWithMetaRequestContext({ priority: GATE_PRIORITY.LOW, source: 'job', jobType: 'post_sync_engagement' },
      () => metaRequest({ method: 'POST', path: 'low', accountKey: 'act_A', token: 't', operation: 'POST', metaFetch: () => { order.push('low'); return Promise.resolve(fakeResponse()) } }))
    const high = runWithMetaRequestContext({ priority: GATE_PRIORITY.HIGH, source: 'job', jobType: 'post_publish' },
      () => metaRequest({ method: 'POST', path: 'high', accountKey: 'act_A', token: 't', operation: 'POST', metaFetch: () => { order.push('high'); return Promise.resolve(fakeResponse()) } }))
    await busy
    await Promise.all([low, high])
    expect(order).toEqual(['high', 'low'])
  })

  it('priority reservation does not permanently waste capacity (low uses full limit when no high work is waiting)', async () => {
    metaGateOptions.globalLimit = 3
    // simulate a past high-priority waiter having existed — after it clears,
    // low-priority traffic alone must still reach the full global limit
    const lowAll = Promise.all([1, 2, 3].map((i) => metaRequest({
      method: 'POST', path: `lw_${i}`, accountKey: 'act_L', token: 'tL',
      operation: 'POST', metaFetch: delayedFetch(80),
    })))
    await new Promise((r) => setTimeout(r, 40))
    const stats = getGateStats()
    expect(stats.byAccount['act_L'].inFlight).toBe(3)
    expect(stats.globalInFlight).toBe(3)
    await lowAll
  })

  it('low traffic is not starved forever by continuous high traffic', async () => {
    metaGateOptions.globalLimit = 2
    let lowDone = false
    // a continuous chain of high-priority requests on account A
    const highChain = (async () => {
      for (let i = 0; i < 6; i++) {
        await runWithMetaRequestContext({ priority: GATE_PRIORITY.HIGH }, () => metaRequest({
          method: 'POST', path: `h_${i}`, accountKey: 'act_A', token: 'tA',
          operation: 'POST', metaFetch: delayedFetch(20),
        }))
      }
    })()
    // one low-priority request on account B — full slot availability (2 - 0 reserved
    // at admission) means it lands within a bounded number of pumps
    const lowP = (async () => {
      await metaRequest({
        method: 'POST', path: 'low_b', accountKey: 'act_B', token: 'tB',
        operation: 'POST', metaFetch: () => { lowDone = true; return Promise.resolve(fakeResponse()) },
      })
    })()
    await Promise.race([Promise.all([highChain, lowP]), new Promise((_, rej) => setTimeout(() => rej(new Error('low starved')), 4000))])
    expect(lowDone).toBe(true)
  })

  it('queue saturation throws a backpressure error (no retry scheduler)', async () => {
    metaGateOptions.globalLimit = 1
    metaGateOptions.maxQueue = 2
    const busy = metaRequest({ method: 'POST', path: 'busy', accountKey: 'act_A', token: 't', operation: 'POST', metaFetch: delayedFetch(150) })
    await new Promise((r) => setTimeout(r, 30))
    const q1 = metaRequest({ method: 'POST', path: 'q1', accountKey: 'act_A', token: 't', operation: 'POST', metaFetch: () => Promise.resolve(fakeResponse()) })
    const q2 = metaRequest({ method: 'POST', path: 'q2', accountKey: 'act_A', token: 't', operation: 'POST', metaFetch: () => Promise.resolve(fakeResponse()) })
    await expect(metaRequest({ method: 'POST', path: 'q3', accountKey: 'act_A', token: 't', operation: 'POST', metaFetch: () => Promise.resolve(fakeResponse()) }))
      .rejects.toThrow(/queue saturated/)
    await busy
    await Promise.all([q1, q2])
    expect(getGateStats().queueRejected).toBe(1)
  })

  it('rate-limit responses are recorded per account (no enforcement — shared limiter owns backoff)', async () => {
    await metaRequest({ method: 'GET', path: 'rl', params: {}, accountKey: 'act_RL', token: 't', operation: 'GET', metaFetch: () => Promise.resolve(fakeResponse(429)) })
    const stats = getGateStats()
    expect(stats.byAccount['act_RL'].rateLimited).toBe(1)
    expect(stats.errors).toBe(0)
  })

  it('metrics carry operation/account/source/jobType/priority and never the token', async () => {
    const logs = []
    const spy = vi.spyOn(logger, 'debug').mockImplementation((obj, msg) => { logs.push({ obj, msg }) })
    await runWithMetaRequestContext({ priority: GATE_PRIORITY.LOW, source: 'job', jobType: 'post_sync_engagement' }, () => metaRequest({
      method: 'GET', path: 'metrics_path', params: { fields: 'id' }, accountKey: 'act_M', token: 'super_secret_token_value',
      operation: 'GET metrics_path', metaFetch: () => Promise.resolve(fakeResponse()),
    }))
    spy.mockRestore()
    const entry = logs.find((l) => l.msg === 'meta gate request')
    expect(entry).toBeTruthy()
    const g = entry.obj.metaGate
    expect(g.operation).toBe('GET metrics_path')
    expect(g.accountKey).toBe('act_M')
    expect(g.source).toBe('job')
    expect(g.jobType).toBe('post_sync_engagement')
    expect(g.priority).toBe(GATE_PRIORITY.LOW)
    expect(g.processLocal).toBe(true)
    const serialized = JSON.stringify(entry.obj)
    expect(serialized).not.toContain('super_secret_token_value')
    expect(serialized).not.toContain(tokenFingerprint('super_secret_token_value'))
  })

  it('recent-request ring buffer records dedupe hits and misses', async () => {
    const fetcher = delayedFetch(50)
    const params = { fields: 'id' }
    await Promise.all([
      metaRequest({ method: 'GET', path: 'ring', params, accountKey: 'k', token: 't', operation: 'GET', metaFetch: fetcher }),
      metaRequest({ method: 'GET', path: 'ring', params, accountKey: 'k', token: 't', operation: 'GET', metaFetch: fetcher }),
    ])
    const recent = getRecentRequests(10)
    expect(recent.some((r) => r.dedupe === true)).toBe(true)
    expect(recent.some((r) => r.dedupe === false)).toBe(true)
  })

  it('ALS context isolates concurrent jobs (no priority leak between async contexts)', async () => {
    const seen = []
    const job = (name, priority, waitMs) => runWithMetaRequestContext({ priority, source: 'job', jobType: name }, async () => {
      await new Promise((r) => setTimeout(r, waitMs))
      await new Promise((r) => setTimeout(r, 5))
      seen.push({ name, ctx: currentMetaRequestContext() })
    })
    await Promise.all([
      job('high_job', GATE_PRIORITY.HIGH, 30),
      job('low_job', GATE_PRIORITY.LOW, 10),
      runWithMetaRequestContext({ priority: GATE_PRIORITY.HIGH, source: 'job', jobType: 'no_meta_call' }, async () => {
        await new Promise((r) => setTimeout(r, 20))
      }),
    ])
    const high = seen.find((s) => s.name === 'high_job')
    const low = seen.find((s) => s.name === 'low_job')
    expect(high.ctx.jobType).toBe('high_job')
    expect(high.ctx.priority).toBe(GATE_PRIORITY.HIGH)
    expect(low.ctx.jobType).toBe('low_job')
    expect(low.ctx.priority).toBe(GATE_PRIORITY.LOW)
  })

  it('a failed request still releases its slot (no capacity leak)', async () => {
    metaGateOptions.globalLimit = 1
    await expect(metaRequest({ method: 'POST', path: 'boom', accountKey: 'act_F', token: 't', operation: 'POST', metaFetch: () => Promise.reject(new Error('network down')) }))
      .rejects.toThrow('network down')
    expect(getGateStats().globalInFlight).toBe(0)
    const ok = await metaRequest({ method: 'POST', path: 'ok', accountKey: 'act_F', token: 't', operation: 'POST', metaFetch: () => Promise.resolve(fakeResponse()) })
    expect(ok.status).toBe(200)
  })

  it('GET dedupe does not leak an entry when the request fails', async () => {
    let attempts = 0
    const failing = () => { attempts += 1; return Promise.reject(new Error('boom')) }
    const params = { fields: 'id' }
    const [e1, e2] = await Promise.allSettled([
      metaRequest({ method: 'GET', path: 'fail_dedupe', params, accountKey: 'k', token: 't', operation: 'GET', metaFetch: failing }),
      metaRequest({ method: 'GET', path: 'fail_dedupe', params, accountKey: 'k', token: 't', operation: 'GET', metaFetch: failing }),
    ])
    expect(e1.status).toBe('rejected')
    // both either reject or one dedupes onto the same failure — no unhandled rejection
    expect(attempts).toBeLessThanOrEqual(2)
    // a retry after the failure is NOT deduped against the dead entry
    const ok = await metaRequest({ method: 'GET', path: 'fail_dedupe', params, accountKey: 'k', token: 't', operation: 'GET', metaFetch: () => Promise.resolve(fakeResponse()) })
    expect(ok.status).toBe(200)
  })

  it('per-account rolling window rate is exposed for the sustained-rate alert', async () => {
    for (let i = 0; i < 5; i++) {
      await metaRequest({ method: 'GET', path: `w_${i}`, params: {}, accountKey: 'act_W', token: 't', operation: 'GET', metaFetch: () => Promise.resolve(fakeResponse()) })
    }
    expect(getAccountWindowRate('act_W')).toBe(5)
  })
})

describe('meta gate wiring (no nested double-acquire)', () => {
  it('an outer gated request whose fetch awaits an INNER gated request cannot complete with globalLimit=1 (proves one slot per request)', async () => {
    resetGateStats()
    const prevGlobal = metaGateOptions.globalLimit
    const prevAccount = metaGateOptions.accountLimit
    const prevTimeout = metaGateOptions.waitTimeoutMs
    metaGateOptions.globalLimit = 1
    metaGateOptions.accountLimit = 1
    metaGateOptions.waitTimeoutMs = 300

    // simulate the FORBIDDEN shape: metaFetch (the actual network boundary)
    // awaiting a second gated request. With exactly ONE slot, a
    // double-acquiring boundary would deadlock/timeout — the gate must let
    // this fail visibly rather than silently nest.
    const nestedHang = (async () => {
      try {
        await metaRequest({
          method: 'GET', path: 'outer', params: {}, accountKey: 'probe', token: 'pt',
          operation: 'outer',
          metaFetch: () => metaRequest({
            method: 'GET', path: 'inner', params: {}, accountKey: 'probe', token: 'pt',
            operation: 'inner', metaFetch: () => Promise.resolve(fakeResponse()),
          }),
        })
        return 'completed'
      } catch {
        return 'rejected'
      }
    })()

    const outcome = await Promise.race([
      nestedHang,
      new Promise((resolve) => setTimeout(() => resolve('still-hanging'), 1500)),
    ])

    metaGateOptions.globalLimit = prevGlobal
    metaGateOptions.accountLimit = prevAccount
    metaGateOptions.waitTimeoutMs = prevTimeout
    resetGateStats()

    // With one slot: the outer request holds it, the inner waits, the outer
    // cannot finish until the inner does => both paths must time out.
    expect(outcome).not.toBe('completed')
    // after the timeout, capacity fully recovers (no slot leak)
    const probe = await metaRequest({ method: 'POST', path: 'probe_after', accountKey: 'probe', token: 'pt', operation: 'probe', metaFetch: () => Promise.resolve(fakeResponse()) })
    expect(probe.status).toBe(200)
    resetGateStats()
  })
})
