/**
 * PROCESS-LOCAL Meta Graph API request gate.
 *
 * Scope — this is NOT a distributed/fleet-wide concurrency limiter:
 * - This gate bounds concurrency ONLY within the current Node process.
 * - The DB-backed worker lease (`campaign_job_worker`) serializes
 *   BACKGROUND job draining fleet-wide, so queued/scheduled Meta traffic is
 *   fleet-controlled at the queue level.
 * - Direct user-triggered HTTP requests in OTHER app processes still enter
 *   their own process-local gate independently.
 * - Shared account/provider rate-limit + backoff state lives in the DB-backed
 *   limiter (`meta-rate-limiter.js`, per-account buckets + cooldowns) — that
 *   is the cross-process source of truth for account throttling. This gate
 *   does NOT enforce rate limits; it only records them (no second source of
 *   truth).
 *
 * What this gate adds per process:
 * - global concurrency ceiling (META_GLOBAL_CONCURRENCY)
 * - per-account/token concurrency ceiling (META_ACCOUNT_CONCURRENCY)
 * - IN-FLIGHT coalescing of safe idempotent GETs (key = method + path +
 *   normalized params + token fingerprint — never across authorization
 *   contexts; no completed-response caching)
 * - priority lanes with dynamic high-priority reservation: slots are only
 *   withheld from low-priority WHILE high-priority work is queued; with no
 *   high work waiting, low uses full capacity (no starvation, no permanently
 *   wasted slots)
 * - bounded waiting queue with backpressure errors (callers integrate with
 *   the existing job backoff; the gate introduces no retry scheduler)
 * - per-request metrics + per-account rolling 60s request counts
 *
 * One outbound Meta HTTP request consumes exactly ONE gate slot: the gate is
 * acquired at the lowest-level HTTP boundary (graphGet/graphPost/graphDelete
 * and the hosted-upload apiFetch), and those boundaries never call each
 * other, so a single outbound request can never double-acquire.
 *
 * Tokens never appear in metrics or logs — only sha256 fingerprints.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { logger } from '../utils/logger.js'

export const metaGateOptions = {
  globalLimit: Math.max(1, Number(process.env.META_GLOBAL_CONCURRENCY) || 8),
  accountLimit: Math.max(1, Number(process.env.META_ACCOUNT_CONCURRENCY) || 4),
  maxQueue: Math.max(1, Number(process.env.META_GATE_MAX_QUEUE) || 100),
  waitTimeoutMs: Math.max(1000, Number(process.env.META_GATE_WAIT_TIMEOUT_MS) || 20000),
  queueWarnMs: 5000,
}

export const GATE_PRIORITY = { HIGH: 'high', LOW: 'low' }

const requestContext = new AsyncLocalStorage()

const state = {
  totalRequests: 0,
  dedupedGets: 0,
  queueRejected: 0,
  queueTimedOut: 0,
  errors: 0,
  globalInFlight: 0,
  peakGlobalInFlight: 0,
  byAccount: new Map(),
  recent: [],
}

const waiters = []
const inflightGets = new Map()

function accountKeyOf(key) {
  return key || 'unknown'
}

function accountStats(key) {
  const id = accountKeyOf(key)
  let st = state.byAccount.get(id)
  if (!st) {
    st = {
      requests: 0, errors: 0, inFlight: 0, peakInFlight: 0, rateLimited: 0,
      windowStart: Date.now(), windowRequests: 0, totalDurationMs: 0,
    }
    state.byAccount.set(id, st)
  }
  return st
}

export function tokenFingerprint(token) {
  if (!token) return undefined
  return createHash('sha256').update(String(token)).digest('hex').slice(0, 16)
}

function normalizeGetKey(path, params, fingerprint) {
  const keys = Object.keys(params || {}).filter(k => k !== 'access_token').sort()
  const normalized = keys.map(k => `${k}=${typeof params[k] === 'object' ? JSON.stringify(params[k]) : String(params[k])}`).join('&')
  return `GET|${path}|${normalized}|${fingerprint || 'no-token'}`
}

export function runWithMetaRequestContext(context, fn) {
  return requestContext.run(context || {}, fn)
}

export function currentMetaRequestContext() {
  return requestContext.getStore() || null
}

function highPriorityWaiting() {
  return waiters.some(w => w.priority === GATE_PRIORITY.HIGH)
}

function reservedSlots() {
  if (!highPriorityWaiting()) return 0
  return Math.min(2, Math.max(0, metaGateOptions.globalLimit - 1))
}

function grantSlot(accountKey) {
  const st = accountStats(accountKey)
  state.globalInFlight += 1
  if (state.globalInFlight > state.peakGlobalInFlight) state.peakGlobalInFlight = state.globalInFlight
  st.inFlight += 1
  if (st.inFlight > st.peakInFlight) st.peakInFlight = st.inFlight
  st.requests += 1
  const now = Date.now()
  if (now - st.windowStart >= 60000) {
    st.windowStart = now
    st.windowRequests = 0
  }
  st.windowRequests += 1
  state.totalRequests += 1
}

function releaseSlot(accountKey) {
  const st = accountStats(accountKey)
  st.inFlight = Math.max(0, st.inFlight - 1)
  state.globalInFlight = Math.max(0, state.globalInFlight - 1)
  setImmediate(pump)
}

function tryDispatch(item, now) {
  const cap = item.priority === GATE_PRIORITY.HIGH
    ? metaGateOptions.globalLimit
    : metaGateOptions.globalLimit - reservedSlots()
  const st = accountStats(item.accountKey)
  if (state.globalInFlight >= cap) return false
  if (st.inFlight >= metaGateOptions.accountLimit) return false
  grantSlot(item.accountKey)
  item.dispatched = true
  item.resolve({ queueWaitMs: now - item.enqueuedAt })
  return true
}

function pump() {
  const now = Date.now()
  // expire timed-out waiters first
  for (let i = 0; i < waiters.length;) {
    const item = waiters[i]
    if (item.dispatched) { waiters.splice(i, 1); continue }
    if (now - item.enqueuedAt > metaGateOptions.waitTimeoutMs) {
      waiters.splice(i, 1)
      state.queueTimedOut += 1
      item.reject(new Error('Meta request gate wait timed out'))
      continue
    }
    i += 1
  }
  // dispatch HIGH first, then LOW: a queued high-priority waiter must never
  // lose a freed slot to an earlier-enqueued low-priority waiter (the
  // reservation math alone cannot express this when globalLimit is small)
  for (const priority of [GATE_PRIORITY.HIGH, GATE_PRIORITY.LOW]) {
    for (let i = 0; i < waiters.length;) {
      const item = waiters[i]
      if (item.dispatched) { waiters.splice(i, 1); continue }
      if (item.priority !== priority) { i += 1; continue }
      if (tryDispatch(item, now)) {
        waiters.splice(i, 1)
      } else {
        i += 1
      }
    }
  }
}

function enqueue(accountKey, priority, operation, path) {
  return new Promise((resolve, reject) => {
    const item = {
      accountKey: accountKeyOf(accountKey),
      priority,
      operation,
      path,
      enqueuedAt: Date.now(),
      dispatched: false,
      resolve,
      reject,
    }
    waiters.push(item)
    pump()
  })
}

function acquire(accountKey, priority, operation, path) {
  if (waiters.length === 0) {
    const st = accountStats(accountKey)
    if (state.globalInFlight < metaGateOptions.globalLimit && st.inFlight < metaGateOptions.accountLimit) {
      grantSlot(accountKey)
      return Promise.resolve({ queueWaitMs: 0 })
    }
  }
  if (waiters.length >= metaGateOptions.maxQueue) {
    state.queueRejected += 1
    throw new Error(`Meta request gate queue saturated (${metaGateOptions.maxQueue})`)
  }
  return enqueue(accountKey, priority, operation, path)
}

function pushRecent(entry) {
  state.recent.push(entry)
  if (state.recent.length > 200) state.recent.splice(0, state.recent.length - 200)
}

function recordOutcome({ accountKey, operation, path, priority, status, durationMs, queueWaitMs, error, dedupe, rateLimited }) {
  if (error) state.errors += 1
  const st = accountStats(accountKey)
  if (error) st.errors += 1
  if (rateLimited) st.rateLimited += 1
  if (!dedupe) st.totalDurationMs += durationMs
  const ctx = currentMetaRequestContext()
  const entry = {
    at: Date.now(),
    operation,
    path,
    accountKey: accountKeyOf(accountKey),
    priority,
    source: ctx?.source || null,
    jobType: ctx?.jobType || null,
    status: status ?? null,
    error: error ? String(error?.message || error).slice(0, 200) : null,
    rateLimited: !!rateLimited,
    dedupe: !!dedupe,
    durationMs,
    queueWaitMs: queueWaitMs || 0,
  }
  pushRecent(entry)
  logger.debug({ metaGate: { ...entry, processLocal: true } }, 'meta gate request')
}

function isRateLimitStatus(status) {
  return status === 429 || status === 408
}

/**
 * Run one outbound Meta HTTP request through the gate — exactly one slot per
 * outbound request. `metaFetch` performs the actual network call and returns
 * the Response WITHOUT consuming its body.
 *
 * GET requests coalesce while in flight: the caller whose request is already
 * running consumes the original Response; concurrent callers with the same
 * key (method + path + normalized params + token fingerprint) receive a
 * clone(). Entries are removed as soon as the request settles — no
 * completed-response caching. POST/DELETE are never deduped.
 */
export async function metaRequest({ method = 'GET', path, params, accountKey, token, operation, metaFetch }) {
  const priority = currentMetaRequestContext()?.priority || GATE_PRIORITY.HIGH
  const fingerprint = tokenFingerprint(token)

  if (method === 'GET') {
    const key = normalizeGetKey(path, params, fingerprint)
    const existing = inflightGets.get(key)
    if (existing) {
      state.dedupedGets += 1
      recordOutcome({ accountKey, operation, path, priority, status: null, durationMs: 0, queueWaitMs: 0, dedupe: true })
      return existing.then(entry => entry.shared)
    }

    const run = (async () => {
      const slot = await acquire(accountKey, priority, operation, path)
      const startedAt = Date.now()
      try {
        const res = await metaFetch()
        const durationMs = Date.now() - startedAt
        const shared = res?.clone ? res.clone() : res
        recordOutcome({
          accountKey, operation, path, priority,
          status: res?.status ?? null,
          durationMs, queueWaitMs: slot.queueWaitMs,
          rateLimited: isRateLimitStatus(res?.status),
        })
        return { res, shared }
      } catch (err) {
        recordOutcome({ accountKey, operation, path, priority, status: null, durationMs: Date.now() - startedAt, queueWaitMs: slot.queueWaitMs, error: err })
        throw err
      } finally {
        releaseSlot(accountKey)
      }
    })()

    inflightGets.set(key, run)
    run.catch(() => {}).finally(() => {
      if (inflightGets.get(key) === run) inflightGets.delete(key)
    })
    return run.then(entry => entry.res)
  }

  const slot = await acquire(accountKey, priority, operation, path)
  const startedAt = Date.now()
  try {
    const res = await metaFetch()
    recordOutcome({
      accountKey, operation, path, priority,
      status: res?.status ?? null,
      durationMs: Date.now() - startedAt,
      queueWaitMs: slot.queueWaitMs,
      rateLimited: isRateLimitStatus(res?.status),
    })
    return res
  } catch (err) {
    recordOutcome({ accountKey, operation, path, priority, status: null, durationMs: Date.now() - startedAt, queueWaitMs: slot.queueWaitMs, error: err })
    throw err
  } finally {
    releaseSlot(accountKey)
  }
}

export function getGateStats() {
  const byAccount = {}
  for (const [key, st] of state.byAccount.entries()) {
    byAccount[key] = {
      requests: st.requests,
      errors: st.errors,
      inFlight: st.inFlight,
      peakInFlight: st.peakInFlight,
      rateLimited: st.rateLimited,
      windowRequests: st.windowRequests,
      windowStart: st.windowStart,
      avgDurationMs: st.requests ? Math.round(st.totalDurationMs / st.requests) : 0,
    }
  }
  return {
    processLocal: true,
    globalLimit: metaGateOptions.globalLimit,
    accountLimit: metaGateOptions.accountLimit,
    globalInFlight: state.globalInFlight,
    peakGlobalInFlight: state.peakGlobalInFlight,
    queued: waiters.length,
    totalRequests: state.totalRequests,
    dedupedGets: state.dedupedGets,
    queueRejected: state.queueRejected,
    queueTimedOut: state.queueTimedOut,
    errors: state.errors,
    byAccount,
  }
}

export function getAccountWindowRate(accountKey, nowMs = Date.now()) {
  const st = state.byAccount.get(accountKeyOf(accountKey))
  if (!st) return 0
  if (nowMs - st.windowStart >= 60000) return 0
  return st.windowRequests
}

export function getRecentRequests(limit = 50) {
  return state.recent.slice(-limit)
}

export function resetGateStats() {
  state.totalRequests = 0
  state.dedupedGets = 0
  state.queueRejected = 0
  state.queueTimedOut = 0
  state.errors = 0
  state.globalInFlight = 0
  state.peakGlobalInFlight = 0
  state.byAccount.clear()
  state.recent = []
  waiters.length = 0
  inflightGets.clear()
}
