import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as limiter from '../../shared/services/meta-rate-limiter.js'
import { getContainerStatus, listAccountAds } from '../../shared/services/meta-ads.service.js'
import { getInstagramMedia } from '../../shared/services/meta-graph.service.js'

const APP_USAGE = (used) => JSON.stringify({ call_count: 2, total_cputime: 1, total_time: 1, used })

describe('per-token rate limiting', () => {
  beforeEach(() => {
    limiter.resetRateLimitState()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mockFetchOnce(response) {
    const fn = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fn)
    return fn
  }

  it('tokenKeyFor is deterministic, stable and distinct per token', () => {
    const a = limiter.tokenKeyFor('token-a')
    expect(a).toBe(limiter.tokenKeyFor('token-a'))
    expect(a).not.toBe(limiter.tokenKeyFor('token-b'))
    expect(a).toHaveLength(16)
    expect(limiter.tokenKeyFor('')).toBeUndefined()
    expect(limiter.tokenKeyFor(null)).toBeUndefined()
    expect(limiter.tokenKeyFor(undefined)).toBeUndefined()
  })

  it('keyes a page-endpoint 429 to the token bucket, not the default bucket', async () => {
    mockFetchOnce(new Response('{"error":{}}', { status: 429 }))
    await expect(getContainerStatus('17841400000000000', 'page-token-1')).rejects.toMatchObject({ metaHttpStatus: 429 })

    const key = limiter.tokenKeyFor('page-token-1')
    expect(limiter.isRateLimited(key)).toBe(true)
    expect(limiter.isRateLimited()).toBe(false)
    expect(limiter.isRateLimited(limiter.tokenKeyFor('other-token'))).toBe(false)
  })

  it('records page-endpoint X-App-Usage headers to the token bucket on success', async () => {
    mockFetchOnce(new Response('{"id":"1","status_code":"FINISHED"}', {
      status: 200,
      headers: { 'x-app-usage': APP_USAGE({ call_count: 0.95, total_cputime: 0.9 }) },
    }))

    const data = await getContainerStatus('17841400000000000', 'page-token-2')
    expect(data.status_code).toBe('FINISHED')
    expect(limiter.isRateLimited()).toBe(false)
    expect(limiter.isRateLimited(limiter.tokenKeyFor('page-token-2'))).toBe(true)
  })

  it('keyes ad-account endpoints to the ad-account bucket, never the token bucket', async () => {
    mockFetchOnce(new Response('{"data":[]}', {
      status: 200,
      headers: { 'x-app-usage': APP_USAGE({ call_count: 0.99, total_cputime: 0.99 }) },
    }))

    const result = await listAccountAds('123456', 'act-token')
    expect(Array.isArray(result.rows)).toBe(true)
    expect(limiter.isRateLimited('act_123456')).toBe(true)
    expect(limiter.isRateLimited()).toBe(false)
    expect(limiter.isRateLimited(limiter.tokenKeyFor('act-token'))).toBe(false)
  })

  it('keyes meta-graph page reads to the token bucket', async () => {
    mockFetchOnce(new Response('{"data":[]}', {
      status: 200,
      headers: { 'x-app-usage': APP_USAGE({ call_count: 0.99, total_cputime: 0.99 }) },
    }))

    await getInstagramMedia('1784141', 'graph-token')
    expect(limiter.isRateLimited(limiter.tokenKeyFor('graph-token'))).toBe(true)
    expect(limiter.isRateLimited()).toBe(false)
  })

  it('keyes meta-graph 429 cooldown to the token bucket', async () => {
    mockFetchOnce(new Response('{"error":{}}', { status: 429 }))
    await expect(getInstagramMedia('1784141', 'graph-token-2')).rejects.toThrow()
    expect(limiter.isRateLimited(limiter.tokenKeyFor('graph-token-2'))).toBe(true)
    expect(limiter.isRateLimited()).toBe(false)
  })

  it('keeps independent tokens on independent buckets', async () => {
    mockFetchOnce(new Response('{"error":{}}', { status: 429 }))
    await expect(getContainerStatus('17841400000000000', 'page-token-3')).rejects.toThrow()
    expect(limiter.isRateLimited(limiter.tokenKeyFor('page-token-3'))).toBe(true)
    expect(limiter.isRateLimited(limiter.tokenKeyFor('page-token-4'))).toBe(false)
  })

  it('recordUsage with empty or headerless responses is a no-op', async () => {
    mockFetchOnce(new Response('{"id":"1"}', { status: 200 }))
    await getContainerStatus('17841400000000000', 'no-header-token')
    expect(limiter.getRateLimitState(limiter.tokenKeyFor('no-header-token')).lastUpdated).toBeNull()
  })
})