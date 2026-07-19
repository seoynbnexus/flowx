import * as repo from './subscription.repository.js'
import * as authRepo from '../auth/auth.repository.js'
import * as ledger from '../../../shared/services/usage-ledger.service.js'
import { ForbiddenError } from '../../../shared/errors/AppError.js'

const entitlementCache = new Map()
const ENTR_CACHE_TTL = 5 * 60 * 1000

function getCached(key) {
  const entry = entitlementCache.get(key)
  if (entry && Date.now() - entry.ts < ENTR_CACHE_TTL) return entry.data
  entitlementCache.delete(key)
  return null
}

function setCache(key, data) {
  entitlementCache.set(key, { data, ts: Date.now() })
}

export function clearCache(userId) {
  entitlementCache.delete(`entitlements:${userId}`)
  for (const key of entitlementCache.keys()) {
    if (key.startsWith(`usage:${userId}:`)) entitlementCache.delete(key)
  }
}

export async function getCurrentPeriod(userId) {
  const sub = await repo.findUserSubscription(userId)
  if (sub?.currentPeriodStart && sub?.currentPeriodEnd) {
    return { periodStart: sub.currentPeriodStart, periodEnd: sub.currentPeriodEnd }
  }
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return { periodStart: start, periodEnd: end }
}

export async function hasFeature(userId, featureKey) {
  const entitlements = await getUserEntitlements(userId)
  const value = entitlements.features[featureKey]
  if (value === undefined || value === false) return false
  if (value === null) return true
  if (typeof value === 'number') return value > 0
  return Boolean(value)
}

export async function getLimit(userId, featureKey) {
  const entitlements = await getUserEntitlements(userId)
  const value = entitlements.features[featureKey]
  if (value === undefined) return 0
  if (value === null) return null
  if (typeof value === 'boolean') return value ? null : 0
  return value
}

export async function getUsage(userId, featureKey) {
  const limit = await getLimit(userId, featureKey)
  const { periodStart, periodEnd } = await getCurrentPeriod(userId)
  const cacheKey = `usage:${userId}:${featureKey}:${periodStart.toISOString()}`
  const cached = getCached(cacheKey)
  const used = cached !== null ? cached : await ledger.getUsage(userId, featureKey, periodStart, periodEnd)
  if (cached === null) setCache(cacheKey, used)
  const topupAvailable = await repo.getAvailableTopup(userId, featureKey)
  let remaining = 0
  if (limit === null) {
    remaining = null
  } else {
    remaining = Math.max(0, limit - used) + topupAvailable
  }
  return { used, limit, remaining, periodStart, periodEnd, topupAvailable }
}

export async function canPerform(userId, featureKey, options = {}) {
  const limit = await getLimit(userId, featureKey)
  if (limit === null) return

  const { periodStart, periodEnd } = await getCurrentPeriod(userId)
  const cacheKey = `usage:${userId}:${featureKey}:${periodStart.toISOString()}`
  const cached = getCached(cacheKey)
  const used = cached !== null ? cached : await ledger.getUsage(userId, featureKey, periodStart, periodEnd)
  if (used < limit) return

  if (!options.skipTopup) {
    const topupAvailable = await repo.getAvailableTopup(userId, featureKey)
    if (topupAvailable > 0) return
  }

  throw new ForbiddenError(
    `You've reached your monthly limit for this feature. Upgrade your plan or purchase a top-up to continue.`
  )
}

export async function consumeUsage(userId, featureKey, resourceType, resourceId, notes, quantity = 1) {
  const limit = await getLimit(userId, featureKey)
  if (limit !== null) {
    await canPerform(userId, featureKey)
  }
  const { periodStart, periodEnd } = await getCurrentPeriod(userId)
  const subscription = await repo.findUserSubscription(userId)

  const consumed = await ledger.consume(userId, featureKey, resourceType || featureKey, resourceId || null, notes || null, periodStart, periodEnd, subscription?.id || null, quantity)
  if (consumed) {
    clearCache(userId)
    return
  }

  const topupAvailable = await repo.getAvailableTopup(userId, featureKey)
  if (topupAvailable >= quantity) {
    for (let i = 0; i < quantity; i++) {
      await repo.consumeTopup(userId, featureKey)
    }
  }
}

export async function refundUsage(userId, featureKey, resourceType, resourceId, notes, quantity = 1) {
  const { periodStart, periodEnd } = await getCurrentPeriod(userId)
  const subscription = await repo.findUserSubscription(userId)
  await ledger.refund(userId, featureKey, resourceType || featureKey, resourceId || null, notes || null, periodStart, periodEnd, subscription?.id || null, quantity)
  clearCache(userId)
}

export async function getUserEntitlements(userId) {
  const roles = await authRepo.findUserRoles(userId)
  if (roles.includes('publisher')) {
    return { plan: null, features: {} }
  }

  const cacheKey = `entitlements:${userId}`
  const cached = getCached(cacheKey)
  if (cached) return cached

  let subscription = await repo.findUserSubscription(userId)

  const isExpired = subscription?.currentPeriodEnd && new Date(subscription.currentPeriodEnd) < new Date()
  if (!subscription || subscription.status === 'canceled' || isExpired) {
    const freePlan = await repo.findPlanBySlug('free')
    if (!freePlan) return { plan: null, features: {} }
    subscription = await repo.upsertUserSubscription(userId, freePlan.id, {
      status: 'active',
      billingCycle: 'monthly',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    })
  }

  const planFeatures = await repo.findPlanFeatures(subscription.planId)
  const features = {}
  for (const pf of planFeatures) {
    if (!pf.isEnabled) {
      features[pf.featureKey] = false
    } else if (pf.valueType === 'unlimited') {
      features[pf.featureKey] = null
    } else if (pf.isBoolean) {
      features[pf.featureKey] = true
    } else {
      features[pf.featureKey] = pf.valueInt
    }
  }

  const result = {
    plan: subscription.plan || { name: 'Free', slug: 'free' },
    features,
    currentPeriodEnd: subscription.currentPeriodEnd,
    currentPeriodStart: subscription.currentPeriodStart,
    status: subscription.status,
    billingCycle: subscription.billingCycle,
    trialEndsAt: subscription.trialEndsAt,
  }

  setCache(cacheKey, result)
  return result
}

export async function getAllUsage(userId) {
  const features = await repo.findAllFeatures()
  const usage = {}
  for (const feat of features) {
    const u = await getUsage(userId, feat.featureKey)
    usage[feat.featureKey] = u
  }
  return usage
}
