const DEFAULT_KEY = 'default'

import { createHash } from 'node:crypto'

const state = new Map()

export function tokenKeyFor(accessToken) {
  if (!accessToken) return undefined
  return createHash('sha256').update(String(accessToken)).digest('hex').slice(0, 16)
}

function bucket(key = DEFAULT_KEY) {
  const accountId = key || DEFAULT_KEY
  if (!state.has(accountId)) {
    state.set(accountId, {
      callCount: 0,
      cputime: 0,
      totalTime: 0,
      used: null,
      lastUpdated: null,
      cooldownUntil: null,
    })
  }
  return state.get(accountId)
}

function parseUsageHeader(header) {
  if (!header) return null
  try {
    if (typeof header === 'string') {
      return JSON.parse(header)
    }
    return header
  } catch {
    return null
  }
}

export function recordUsage(headers = {}, accountId) {
  const src = typeof headers.get === 'function'
    ? { 'x-app-usage': headers.get('x-app-usage'), 'x-ad-account-usage': headers.get('x-ad-account-usage') }
    : headers
  const merged = { ...parseUsageHeader(src['x-app-usage']), ...parseUsageHeader(src['x-ad-account-usage']) }
  if (!merged || Object.keys(merged).length === 0) return
  const st = bucket(accountId)
  st.callCount = Number(merged.call_count) || 0
  st.cputime = Number(merged.total_cputime) || 0
  st.totalTime = Number(merged.total_time) || 0
  st.used = merged.used || null
  st.lastUpdated = Date.now()
}

export function setCooldown(seconds, accountId) {
  bucket(accountId).cooldownUntil = Date.now() + seconds * 1000
}

function usageRatio(st) {
  const usage = st.used || {}
  return {
    call: Number(usage.call_count) || 0,
    cputime: Number(usage.total_cputime) || 0,
  }
}

function throttled(st, threshold) {
  if (st.cooldownUntil && Date.now() < st.cooldownUntil) return true
  const { call, cputime } = usageRatio(st)
  return call >= threshold || cputime >= threshold
}

export function isRateLimited(accountId) {
  return throttled(bucket(accountId), 0.8)
}

export function isSoftThrottled(accountId) {
  return throttled(bucket(accountId), 0.5)
}

export function getRateLimitState(accountId) {
  const st = bucket(accountId)
  return {
    callCount: st.callCount,
    cputime: st.cputime,
    totalTime: st.totalTime,
    used: st.used,
    lastUpdated: st.lastUpdated,
    rateLimited: throttled(st, 0.8),
  }
}

export function getAllRateLimitStates() {
  const out = []
  for (const [accountId, st] of state.entries()) {
    out.push({
      accountId,
      callCount: st.callCount,
      cputime: st.cputime,
      totalTime: st.totalTime,
      used: st.used,
      lastUpdated: st.lastUpdated,
      rateLimited: throttled(st, 0.8),
    })
  }
  return out
}

export function resetRateLimitState(accountId) {
  if (accountId) {
    state.delete(accountId)
  } else {
    state.clear()
  }
}