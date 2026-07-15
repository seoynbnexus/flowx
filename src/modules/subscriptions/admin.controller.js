import * as repo from './subscription.repository.js'
import * as ledgerService from '../../../shared/services/usage-ledger.service.js'
import * as subService from './subscription.service.js'
import * as authRepo from '../auth/auth.repository.js'
import * as aiRepo from '../ai/ai.repository.js'
import { sendSuccess, sendCreated, sendPaginated } from '../../../shared/utils/response.utils.js'
import { NotFoundError, ConflictError, ValidationError } from '../../../shared/errors/AppError.js'
import { query } from '../../../shared/database/connection.js'
import { uuidToBuffer } from '../../../shared/utils/uuid.utils.js'

export async function listPlans(req, res, next) {
  try {
    const plans = await repo.findAllPlans()
    return sendSuccess(res, plans)
  } catch (error) { next(error) }
}

export async function getPlan(req, res, next) {
  try {
    const plan = await repo.findPlanById(req.params.id)
    if (!plan) throw new NotFoundError('Plan not found')
    return sendSuccess(res, plan)
  } catch (error) { next(error) }
}

export async function createPlan(req, res, next) {
  try {
    const existing = await repo.findPlanBySlug(req.body.slug)
    if (existing) throw new ConflictError('A plan with this slug already exists')
    const plan = await repo.createPlan(req.body)
    return sendCreated(res, plan, 'Plan created')
  } catch (error) { next(error) }
}

export async function updatePlan(req, res, next) {
  try {
    const existing = await repo.findPlanById(req.params.id)
    if (!existing) throw new NotFoundError('Plan not found')
    const plan = await repo.updatePlan(req.params.id, req.body)
    return sendSuccess(res, plan, 'Plan updated')
  } catch (error) { next(error) }
}

export async function deletePlan(req, res, next) {
  try {
    const existing = await repo.findPlanById(req.params.id)
    if (!existing) throw new NotFoundError('Plan not found')
    await repo.deletePlan(req.params.id)
    return sendSuccess(res, null, 'Plan deleted')
  } catch (error) { next(error) }
}

export async function reorderPlans(req, res, next) {
  try {
    await repo.reorderPlans(req.body.planIds)
    return sendSuccess(res, null, 'Plans reordered')
  } catch (error) { next(error) }
}

export async function listFeatures(req, res, next) {
  try {
    const features = await repo.findAllFeatures()
    return sendSuccess(res, features)
  } catch (error) { next(error) }
}

export async function getFeature(req, res, next) {
  try {
    const feature = await repo.findFeatureById(req.params.id)
    if (!feature) throw new NotFoundError('Feature not found')
    return sendSuccess(res, feature)
  } catch (error) { next(error) }
}

export async function createFeature(req, res, next) {
  try {
    const existing = await repo.findFeatureByKey(req.body.featureKey)
    if (existing) throw new ConflictError('A feature with this key already exists')
    const feature = await repo.createFeature(req.body)
    return sendCreated(res, feature, 'Feature created')
  } catch (error) { next(error) }
}

export async function updateFeature(req, res, next) {
  try {
    const existing = await repo.findFeatureById(req.params.id)
    if (!existing) throw new NotFoundError('Feature not found')
    const feature = await repo.updateFeature(req.params.id, req.body)
    return sendSuccess(res, feature, 'Feature updated')
  } catch (error) { next(error) }
}

export async function deleteFeature(req, res, next) {
  try {
    const existing = await repo.findFeatureById(req.params.id)
    if (!existing) throw new NotFoundError('Feature not found')
    await repo.deleteFeature(req.params.id)
    return sendSuccess(res, null, 'Feature deleted')
  } catch (error) { next(error) }
}

export async function getPlanFeatures(req, res, next) {
  try {
    const plan = await repo.findPlanById(req.params.id)
    if (!plan) throw new NotFoundError('Plan not found')
    const features = await repo.findPlanFeatures(req.params.id)
    return sendSuccess(res, features)
  } catch (error) { next(error) }
}

export async function bulkSetEntitlements(req, res, next) {
  try {
    const plan = await repo.findPlanById(req.params.id)
    if (!plan) throw new NotFoundError('Plan not found')
    for (const ent of req.body.entitlements) {
      await repo.upsertPlanFeature(req.params.id, ent.featureId, ent)
    }
    const features = await repo.findPlanFeatures(req.params.id)
    return sendSuccess(res, features, 'Entitlements updated')
  } catch (error) { next(error) }
}

export async function listUsers(req, res, next) {
  try {
    const { default: authRepo } = await import('../auth/auth.repository.js')
    const { query: rawQuery } = await import('../../../shared/database/connection.js')
    const rows = await rawQuery(
      "SELECT u.id, u.email FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE r.code = 'client' ORDER BY u.created_at DESC"
    )
    const result = []
    for (const row of rows) {
      const { bufferToUuid: b2u } = await import('../../../shared/utils/uuid.utils.js')
      const userId = b2u(row.id)
      const sub = await repo.findUserSubscription(userId)
      result.push({
        userId,
        email: row.email,
        subscription: sub || null,
      })
    }
    return sendSuccess(res, result)
  } catch (error) { next(error) }
}

export async function assignPlan(req, res, next) {
  try {
    const plan = await repo.findPlanById(req.body.planId)
    if (!plan) throw new NotFoundError('Plan not found')
    const now = new Date()
    const sub = await repo.upsertUserSubscription(req.params.userId, req.body.planId, {
      status: req.body.status || 'active',
      billingCycle: req.body.billingCycle || 'monthly',
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    })
    subService.clearCache(req.params.userId)
    return sendSuccess(res, sub, 'Plan assigned')
  } catch (error) { next(error) }
}

export async function getUserUsageHistory(req, res, next) {
  try {
    const { userId } = req.params
    const { featureKey, transactionType, dateFrom, dateTo, page, limit } = req.query
    const result = await ledgerService.getHistory(userId, featureKey || null, {
      transactionType: transactionType || null,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
    })
    return sendPaginated(res, result.entries, result.pagination)
  } catch (error) { next(error) }
}

export async function getFeatureUsageDetail(req, res, next) {
  try {
    const { userId, featureKey } = req.params
    const [usage, history] = await Promise.all([
      subService.getUsage(userId, featureKey),
      ledgerService.getHistory(userId, featureKey, { limit: 50 }),
    ])
    return sendSuccess(res, { ...usage, history: history.entries })
  } catch (error) { next(error) }
}

export async function adminAdjustUsage(req, res, next) {
  try {
    const { userId, featureKey, quantity, reason } = req.body
    if (quantity === 0) throw new ValidationError('Quantity must be non-zero')

    const { periodStart, periodEnd } = await subService.getCurrentPeriod(userId)
    const subscription = await repo.findUserSubscription(userId)
    await ledgerService.adminAdjust(userId, featureKey, quantity, reason || 'Admin adjustment', periodStart, periodEnd, subscription?.id || null)
    subService.clearCache(userId)
    return sendSuccess(res, null, 'Usage adjusted')
  } catch (error) { next(error) }
}

export async function adminForceRefund(req, res, next) {
  try {
    const { userId, featureKey, resourceType, resourceId, reason } = req.body
    const { periodStart, periodEnd } = await subService.getCurrentPeriod(userId)
    const subscription = await repo.findUserSubscription(userId)
    await ledgerService.refund(userId, featureKey, resourceType || 'admin', resourceId || null, reason || 'Admin refund', periodStart, periodEnd, subscription?.id || null)
    subService.clearCache(userId)
    return sendSuccess(res, null, 'Refund recorded')
  } catch (error) { next(error) }
}

export async function getUserUsageOverview(req, res, next) {
  try {
    const { userId } = req.params
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const limit = Math.min(Math.max(1, parseInt(req.query.limit) || 50), 100)
    const { startDate, endDate } = req.query

    const user = await authRepo.findUserById(userId)
    if (!user) throw new NotFoundError('User not found')

    const subscription = await repo.findUserSubscription(userId)
    const { periodStart, periodEnd } = subscription?.currentPeriodStart
      ? { periodStart: subscription.currentPeriodStart, periodEnd: subscription.currentPeriodEnd }
      : await subService.getCurrentPeriod(userId)

    const [allUsage, aiSummary, aiByType] = await Promise.all([
      subService.getAllUsage(userId),
      aiRepo.getAiUsageSummary(userId, periodStart),
      aiRepo.getAiUsageByType(userId, periodStart),
    ])

    const coinService = await import('../../../shared/services/coin.service.js')
    const wallet = await coinService.getAvailable(userId)

    const rawFilters = {
      page,
      limit,
      dateFrom: startDate || null,
      dateTo: endDate || null,
    }
    const rawHistory = await ledgerService.getHistory(userId, null, rawFilters)

    const rows = await query(
      `SELECT 'ai' as source, id, content_type, coins_spent, tokens_used, prompt_text, was_blocked, created_at
       FROM ai_usage_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
      [uuidToBuffer(userId)]
    )
    const aiLogs = rows.map(r => ({
      ...r,
      id: r.id.toString('hex'),
    }))

    const txRows = await query(
      `SELECT 'transaction' as source, id, label, amount, type, reference_type, reference_id, created_at
       FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
      [uuidToBuffer(userId)]
    )
    const transactions = txRows.map(r => ({
      ...r,
      id: r.id.toString('hex'),
      reference_id: r.reference_id ? r.reference_id.toString('hex') : null,
    }))

    const activityItems = [
      ...ledgerEntriesToActivity(rawHistory.entries),
      ...aiLogs.map(l => ({
        type: 'ai_generation',
        category: 'ai',
        icon: 'sparkles',
        summary: l.was_blocked ? 'Blocked AI generation attempt' : 'AI generation',
        detail: `Content type: ${l.content_type || 'unknown'}, ${l.coins_spent || 0} coins, ${l.tokens_used || 0} tokens`,
        amount: l.coins_spent || 0,
        timestamp: l.created_at,
        raw: l,
      })),
      ...transactions.map(t => ({
        type: t.type === 'credit' ? 'wallet_credit' : 'wallet_debit',
        category: 'wallet',
        icon: 'wallet',
        summary: `${t.label || (t.type === 'credit' ? 'Coins added' : 'Coins deducted')}`,
        detail: `${t.type === 'credit' ? '+' : '-'}${t.amount} coins${t.reference_type ? ` (${t.reference_type})` : ''}`,
        amount: t.amount,
        timestamp: t.created_at,
        raw: t,
      })),
    ]
    activityItems.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    const topItems = activityItems.slice(0, limit)

    const featureList = Object.entries(allUsage)
      .filter(([key]) => key !== 'monthly_coins')
      .map(([key, val]) => ({
        featureKey: key,
        used: val.used,
        limit: val.limit,
        remaining: val.remaining,
        percentage: val.limit !== null && val.limit > 0
          ? Math.min(100, Math.round((val.used / val.limit) * 100))
          : val.limit === null ? null : 0,
        status: !val.limit ? 'ok'
          : val.used >= val.limit ? 'critical'
          : val.used / val.limit >= 0.9 ? 'critical'
          : val.used / val.limit >= 0.6 ? 'warning'
          : 'ok',
      }))

    const daysTotalCalc = periodStart && periodEnd
      ? Math.round((new Date(periodEnd) - new Date(periodStart)) / (1000 * 60 * 60 * 24))
      : 30
    const daysRemainingCalc = periodEnd
      ? Math.max(0, Math.round((new Date(periodEnd) - new Date()) / (1000 * 60 * 60 * 24)))
      : 0

    return sendSuccess(res, {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        status: user.status,
        createdAt: user.created_at,
      },
      subscription: subscription ? {
        planName: subscription.plan?.name || null,
        planSlug: subscription.plan?.slug || null,
        status: subscription.status,
        billingCycle: subscription.billingCycle,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        daysRemaining: daysRemainingCalc,
        daysTotal: daysTotalCalc,
      } : null,
      features: featureList,
      aiUsage: {
        totalGenerations: Number(aiSummary.total_generations || 0),
        coinsSpent: Number(aiSummary.total_coins_spent || 0),
        tokensUsed: Number(aiSummary.total_tokens_used || 0),
        tokensEstimate: `${Math.round(Number(aiSummary.total_tokens_used || 0) / 400)} pages of text`,
        blockedCount: Number(aiSummary.total_blocked || 0),
        byType: Object.fromEntries(aiByType.map(t => [t.type, { count: t.count, coinsSpent: t.coins_spent }])),
      },
      wallet: {
        topupBalance: wallet.topupBalance,
        monthlyRemaining: wallet.monthlyRemaining,
        monthlyLimit: wallet.limit,
        monthlyUsed: wallet.used,
        totalAvailable: wallet.total,
        periodStart: wallet.periodStart,
        periodEnd: wallet.periodEnd,
      },
      activity: {
        items: topItems,
        rawEntries: rawHistory.entries,
        pagination: rawHistory.pagination,
      },
    })
  } catch (error) { next(error) }
}

function ledgerEntriesToActivity(entries) {
  return entries.map(e => {
    let category = 'other'
    let icon = 'activity'
    let summary = ''
    let detail = ''

    if (e.transactionType === 'admin_adjustment') {
      category = 'adjustments'
      icon = 'sliders'
      summary = `Admin adjusted ${e.featureKey} by ${e.quantity > 0 ? '+' : ''}${e.quantity}`
      detail = e.notes || `Feature: ${e.featureKey}`
    } else if (e.featureKey === 'monthly_coins') {
      category = 'wallet'
      icon = 'wallet'
      summary = e.transactionType === 'consume' ? `${e.quantity} coins spent` : `${e.quantity} coins refunded`
      detail = e.notes || ''
    } else if (e.featureKey === 'campaigns') {
      category = 'campaigns'
      icon = 'target'
      if (e.transactionType === 'consume') {
        summary = `Used ${e.quantity} campaign slot for ${e.resourceType || 'campaign'}`
        detail = e.notes || 'Campaign consumed'
      } else if (e.transactionType === 'refund') {
        summary = `Refunded ${e.quantity} campaign slot`
        detail = e.notes || 'Campaign refunded'
      }
    } else {
      summary = `${e.transactionType} ${e.quantity}x ${e.featureKey}`
      detail = e.notes || ''
    }

    return {
      type: e.transactionType,
      category,
      icon,
      summary,
      detail,
      quantity: e.quantity,
      timestamp: e.createdAt,
      raw: e,
    }
  })
}
