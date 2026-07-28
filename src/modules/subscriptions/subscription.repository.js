import { query, queryOne } from '../../../shared/database/connection.js'
import { generateUuid, uuidToBuffer, bufferToUuid } from '../../../shared/utils/uuid.utils.js'

function mapPlan(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    name: row.name,
    slug: row.slug,
    description: row.description,
    monthlyPrice: Number(row.monthly_price),
    yearlyPrice: Number(row.yearly_price),
    currency: row.currency,
    taxRate: row.tax_rate ? Number(row.tax_rate) : 18,
    trialDays: row.trial_days,
    displayOrder: row.display_order,
    isActive: !!row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapFeature(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    featureKey: row.feature_key,
    name: row.name,
    description: row.description,
    category: row.category,
    unit: row.unit,
    isBoolean: !!row.is_boolean,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapSubscription(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    userId: bufferToUuid(row.user_id),
    planId: bufferToUuid(row.plan_id),
    status: row.status,
    trialEndsAt: row.trial_ends_at,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    billingCycle: row.billing_cycle,
    canceledAt: row.canceled_at,
    plan: row.plan_slug ? { name: row.plan_name, slug: row.plan_slug } : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function findAllPlans() {
  const rows = await query('SELECT * FROM subscription_plans ORDER BY display_order ASC')
  return rows.map(mapPlan)
}

export async function findPlanById(id) {
  const row = await queryOne('SELECT * FROM subscription_plans WHERE id = ?', [uuidToBuffer(id)])
  return mapPlan(row)
}

export async function findPlanBySlug(slug) {
  const row = await queryOne('SELECT * FROM subscription_plans WHERE slug = ?', [slug])
  return mapPlan(row)
}

export async function createPlan(data) {
  const id = generateUuid()
  await query(
    `INSERT INTO subscription_plans (id, name, slug, description, monthly_price, yearly_price, currency, trial_days, display_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(id), data.name, data.slug, data.description || null, data.monthlyPrice, data.yearlyPrice, data.currency || 'INR', data.trialDays || 0, data.displayOrder || 0]
  )
  return findPlanById(id)
}

export async function updatePlan(id, data) {
  const fields = []
  const values = []
  for (const [key, value] of Object.entries(data)) {
    const col = key.replace(/([A-Z])/g, '_$1').toLowerCase()
    fields.push(`${col} = ?`)
    values.push(value)
  }
  if (fields.length === 0) return findPlanById(id)
  values.push(uuidToBuffer(id))
  await query(`UPDATE subscription_plans SET ${fields.join(', ')} WHERE id = ?`, values)
  return findPlanById(id)
}

export async function deletePlan(id) {
  await query('DELETE FROM subscription_plans WHERE id = ?', [uuidToBuffer(id)])
}

export async function reorderPlans(orderedIds) {
  for (let i = 0; i < orderedIds.length; i++) {
    await query('UPDATE subscription_plans SET display_order = ? WHERE id = ?', [i, uuidToBuffer(orderedIds[i])])
  }
}

export async function findAllFeatures() {
  const rows = await query('SELECT * FROM features ORDER BY category ASC, name ASC')
  return rows.map(mapFeature)
}

export async function findFeatureById(id) {
  const row = await queryOne('SELECT * FROM features WHERE id = ?', [uuidToBuffer(id)])
  return mapFeature(row)
}

export async function findFeatureByKey(key) {
  const row = await queryOne('SELECT * FROM features WHERE feature_key = ?', [key])
  return mapFeature(row)
}

export async function createFeature(data) {
  const id = generateUuid()
  await query(
    `INSERT INTO features (id, feature_key, name, description, category, unit, is_boolean)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(id), data.featureKey, data.name, data.description || null, data.category || null, data.unit || null, data.isBoolean || 0]
  )
  return findFeatureById(id)
}

export async function updateFeature(id, data) {
  const fields = []
  const values = []
  for (const [key, value] of Object.entries(data)) {
    const col = key.replace(/([A-Z])/g, '_$1').toLowerCase()
    fields.push(`${col} = ?`)
    values.push(value)
  }
  if (fields.length === 0) return findFeatureById(id)
  values.push(uuidToBuffer(id))
  await query(`UPDATE features SET ${fields.join(', ')} WHERE id = ?`, values)
  return findFeatureById(id)
}

export async function deleteFeature(id) {
  await query('DELETE FROM features WHERE id = ?', [uuidToBuffer(id)])
}

export async function findPlanFeatures(planId) {
  const rows = await query(
    `SELECT pf.*, f.feature_key, f.name as feature_name, f.category, f.unit, f.is_boolean
     FROM plan_features pf
     JOIN features f ON f.id = pf.feature_id
     WHERE pf.plan_id = ?
     ORDER BY f.category, f.name`,
    [uuidToBuffer(planId)]
  )
  return rows.map(row => ({
    id: bufferToUuid(row.id),
    planId: bufferToUuid(row.plan_id),
    featureId: bufferToUuid(row.feature_id),
    featureKey: row.feature_key,
    featureName: row.feature_name,
    category: row.category,
    unit: row.unit,
    isBoolean: !!row.is_boolean,
    isEnabled: !!row.is_enabled,
    valueType: row.value_type,
    valueInt: row.value_int,
  }))
}

export async function upsertPlanFeature(planId, featureId, data) {
  const id = generateUuid()
  const existing = await queryOne(
    'SELECT id FROM plan_features WHERE plan_id = ? AND feature_id = ?',
    [uuidToBuffer(planId), uuidToBuffer(featureId)]
  )
  if (existing) {
    await query(
      'UPDATE plan_features SET is_enabled = ?, value_type = ?, value_int = ? WHERE id = ?',
      [data.isEnabled ? 1 : 0, data.valueType || 'boolean', data.valueInt ?? null, existing.id]
    )
  } else {
    await query(
      `INSERT INTO plan_features (id, plan_id, feature_id, is_enabled, value_type, value_int)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidToBuffer(id), uuidToBuffer(planId), uuidToBuffer(featureId), data.isEnabled ? 1 : 0, data.valueType || 'boolean', data.valueInt ?? null]
    )
  }
}

export async function findUserSubscription(userId) {
  const row = await queryOne(
    `SELECT us.*, sp.name as plan_name, sp.slug as plan_slug
     FROM user_subscriptions us
     JOIN subscription_plans sp ON sp.id = us.plan_id
     WHERE us.user_id = ?`,
    [uuidToBuffer(userId)]
  )
  return mapSubscription(row)
}

export async function upsertUserSubscription(userId, planId, data) {
  const existing = await queryOne('SELECT id FROM user_subscriptions WHERE user_id = ?', [uuidToBuffer(userId)])
  if (existing) {
    const fields = []
    const values = []
    if (planId) { fields.push('plan_id = ?'); values.push(uuidToBuffer(planId)) }
    if (data.status) { fields.push('status = ?'); values.push(data.status) }
    if (data.currentPeriodStart) { fields.push('current_period_start = ?'); values.push(data.currentPeriodStart) }
    if (data.currentPeriodEnd) { fields.push('current_period_end = ?'); values.push(data.currentPeriodEnd) }
    if (data.billingCycle) { fields.push('billing_cycle = ?'); values.push(data.billingCycle) }
    if (fields.length > 0) {
      values.push(existing.id)
      await query(`UPDATE user_subscriptions SET ${fields.join(', ')} WHERE id = ?`, values)
    }
  } else {
    const id = generateUuid()
    await query(
      `INSERT INTO user_subscriptions (id, user_id, plan_id, status, current_period_start, current_period_end, billing_cycle)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuidToBuffer(id), uuidToBuffer(userId), uuidToBuffer(planId), data.status || 'active', data.currentPeriodStart || new Date(), data.currentPeriodEnd || null, data.billingCycle || 'monthly']
    )
  }
  return findUserSubscription(userId)
}

export async function getAvailableTopup(userId, featureKey) {
  const row = await queryOne(
    'SELECT COALESCE(SUM(remaining), 0) as total FROM feature_topups WHERE user_id = ? AND feature_key = ? AND remaining > 0',
    [uuidToBuffer(userId), featureKey]
  )
  return row ? Number(row.total) : 0
}

export async function consumeTopup(userId, featureKey) {
  await query(
    `UPDATE feature_topups SET remaining = remaining - 1
     WHERE user_id = ? AND feature_key = ? AND remaining > 0
     ORDER BY created_at ASC LIMIT 1`,
    [uuidToBuffer(userId), featureKey]
  )
}

export async function addTopup(userId, featureKey, quantity) {
  const id = generateUuid()
  await query(
    `INSERT INTO feature_topups (id, user_id, feature_key, quantity, remaining)
     VALUES (?, ?, ?, ?, ?)`,
    [uuidToBuffer(id), uuidToBuffer(userId), featureKey, quantity, quantity]
  )
}
