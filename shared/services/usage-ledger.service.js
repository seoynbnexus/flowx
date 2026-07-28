import { query, queryOne } from '../database/connection.js'
import { generateUuid, uuidToBuffer } from '../utils/uuid.utils.js'

function rowToEntry(row) {
  return {
    id: row.id ? row.id.toString('hex') : undefined,
    userId: row.user_id.toString('hex'),
    subscriptionId: row.subscription_id ? row.subscription_id.toString('hex') : null,
    featureKey: row.feature_key,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    transactionType: row.transaction_type,
    quantity: row.quantity,
    billingPeriodStart: row.billing_period_start,
    billingPeriodEnd: row.billing_period_end,
    notes: row.notes,
    createdAt: row.created_at,
  }
}

export async function getUsage(userId, featureKey, periodStart, periodEnd) {
  const rows = await query(
    `SELECT COALESCE(SUM(CASE WHEN transaction_type = 'consume' THEN quantity ELSE 0 END), 0)
            - COALESCE(SUM(CASE WHEN transaction_type = 'refund' THEN quantity ELSE 0 END), 0)
            + COALESCE(SUM(CASE WHEN transaction_type = 'bonus' THEN quantity ELSE 0 END), 0)
            + COALESCE(SUM(CASE WHEN transaction_type = 'admin_adjustment' THEN quantity ELSE 0 END), 0)
            AS total_used
     FROM usage_ledger
     WHERE user_id = ?
       AND feature_key = ?
       AND billing_period_start = ?
       AND billing_period_end = ?`,
    [uuidToBuffer(userId), featureKey, periodStart, periodEnd]
  )
  return rows[0] ? Math.max(0, Number(rows[0].total_used)) : 0
}

export async function hasConsumedResource(userId, featureKey, resourceType, resourceId) {
  if (!resourceId) return false
  const row = await queryOne(
    `SELECT id FROM usage_ledger ul
     WHERE user_id = ?
       AND feature_key = ?
       AND resource_type = ?
       AND resource_id = ?
       AND transaction_type = 'consume'
       AND NOT EXISTS (
         SELECT 1 FROM usage_ledger ul2
         WHERE ul2.user_id = ul.user_id
           AND ul2.feature_key = ul.feature_key
           AND ul2.resource_type = ul.resource_type
           AND ul2.resource_id = ul.resource_id
           AND ul2.transaction_type = 'refund'
           AND ul2.created_at > ul.created_at
       )
     LIMIT 1`,
    [uuidToBuffer(userId), featureKey, resourceType, resourceId]
  )
  return !!row
}

export async function consume(userId, featureKey, resourceType, resourceId, notes, periodStart, periodEnd, subscriptionId, quantity = 1) {
  if (resourceId && quantity === 1) {
    const already = await hasConsumedResource(userId, featureKey, resourceType, resourceId)
    if (already) return false
  }

  const id = generateUuid()
  await query(
    `INSERT INTO usage_ledger (id, user_id, subscription_id, feature_key, resource_type, resource_id, transaction_type, quantity, billing_period_start, billing_period_end, notes)
     VALUES (?, ?, ?, ?, ?, ?, 'consume', ?, ?, ?, ?)`,
    [uuidToBuffer(id), uuidToBuffer(userId), subscriptionId ? uuidToBuffer(subscriptionId) : null, featureKey, resourceType, resourceId, quantity, periodStart, periodEnd, notes || null]
  )
  return true
}

export async function refund(userId, featureKey, resourceType, resourceId, notes, periodStart, periodEnd, subscriptionId, quantity = 1) {
  const id = generateUuid()
  await query(
    `INSERT INTO usage_ledger (id, user_id, subscription_id, feature_key, resource_type, resource_id, transaction_type, quantity, billing_period_start, billing_period_end, notes)
     VALUES (?, ?, ?, ?, ?, ?, 'refund', ?, ?, ?, ?)`,
    [uuidToBuffer(id), uuidToBuffer(userId), subscriptionId ? uuidToBuffer(subscriptionId) : null, featureKey, resourceType, resourceId, quantity, periodStart, periodEnd, notes || null]
  )
}

export async function adminAdjust(userId, featureKey, quantity, reason, periodStart, periodEnd, subscriptionId) {
  const id = generateUuid()
  await query(
    `INSERT INTO usage_ledger (id, user_id, subscription_id, feature_key, resource_type, resource_id, transaction_type, quantity, billing_period_start, billing_period_end, notes)
     VALUES (?, ?, ?, ?, 'admin', ?, 'admin_adjustment', ?, ?, ?, ?)`,
    [uuidToBuffer(id), uuidToBuffer(userId), subscriptionId ? uuidToBuffer(subscriptionId) : null, featureKey, featureKey, quantity, periodStart, periodEnd, reason || null]
  )
}

export async function grantBonus(userId, featureKey, quantity, reason, periodStart, periodEnd, subscriptionId) {
  const id = generateUuid()
  await query(
    `INSERT INTO usage_ledger (id, user_id, subscription_id, feature_key, resource_type, resource_id, transaction_type, quantity, billing_period_start, billing_period_end, notes)
     VALUES (?, ?, ?, ?, 'bonus', ?, 'bonus', ?, ?, ?, ?)`,
    [uuidToBuffer(id), uuidToBuffer(userId), subscriptionId ? uuidToBuffer(subscriptionId) : null, featureKey, featureKey, quantity, periodStart, periodEnd, reason || null]
  )
}

export async function getHistory(userId, featureKey, filters = {}) {
  const conditions = ['user_id = ?']
  const params = [uuidToBuffer(userId)]

  if (featureKey) {
    conditions.push('feature_key = ?')
    params.push(featureKey)
  }
  if (filters.transactionType) {
    conditions.push('transaction_type = ?')
    params.push(filters.transactionType)
  }
  if (filters.dateFrom) {
    conditions.push('created_at >= ?')
    params.push(filters.dateFrom)
  }
  if (filters.dateTo) {
    conditions.push('created_at <= ?')
    params.push(filters.dateTo)
  }

  const page = filters.page || 1
  const limit = Math.min(filters.limit || 20, 100)
  const offset = (page - 1) * limit

  const countRow = await queryOne(
    `SELECT COUNT(*) as total FROM usage_ledger WHERE ${conditions.join(' AND ')}`,
    params
  )

  const rows = await query(
    `SELECT * FROM usage_ledger WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  )

  return {
    entries: rows.map(rowToEntry),
    pagination: {
      page,
      limit,
      total: countRow ? countRow.total : 0,
    },
  }
}
