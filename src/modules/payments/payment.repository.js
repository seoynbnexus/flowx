import { query, queryOne, transaction } from '../../../shared/database/connection.js'
import { bufferToUuid, uuidToBuffer } from '../../../shared/utils/uuid.utils.js'

function rowToOrder(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    userId: bufferToUuid(row.user_id),
    type: row.type,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    taxAmount: row.tax_amount,
    razorpayOrderId: row.razorpay_order_id,
    razorpayPaymentId: row.razorpay_payment_id,
    razorpaySubscriptionId: row.razorpay_subscription_id,
    description: row.description,
    metadata: row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToTransaction(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    orderId: bufferToUuid(row.order_id),
    gateway: row.gateway,
    gatewayTxnId: row.gateway_txn_id,
    gatewayStatus: row.gateway_status,
    amount: row.amount,
    currency: row.currency,
    responseData: row.response_data ? (typeof row.response_data === 'string' ? JSON.parse(row.response_data) : row.response_data) : null,
    createdAt: row.created_at,
  }
}

function rowToSchedule(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    userId: bufferToUuid(row.user_id),
    userSubscriptionId: bufferToUuid(row.user_subscription_id),
    planId: bufferToUuid(row.plan_id),
    razorpaySubscriptionId: row.razorpay_subscription_id,
    billingCycle: row.billing_cycle,
    status: row.status,
    currentStart: row.current_start,
    currentEnd: row.current_end,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToInvoice(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    userId: bufferToUuid(row.user_id),
    userSubscriptionId: row.user_subscription_id ? bufferToUuid(row.user_subscription_id) : null,
    orderId: row.order_id ? bufferToUuid(row.order_id) : null,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    amount: row.amount,
    currency: row.currency,
    taxAmount: row.tax_amount,
    status: row.status,
    paidAt: row.paid_at,
    invoiceUrl: row.invoice_url,
    createdAt: row.created_at,
  }
}

function rowToPackage(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    name: row.name,
    slug: row.slug,
    coins: row.coins,
    price: row.price,
    currency: row.currency,
    taxRate: row.tax_rate,
    isActive: Boolean(row.is_active),
    displayOrder: row.display_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function createOrder({ id, userId, type, amount, currency, taxAmount, razorpayOrderId, description, metadata }) {
  await query(
    `INSERT INTO payment_orders (id, user_id, type, amount, currency, tax_amount, razorpay_order_id, description, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(id), uuidToBuffer(userId), type, amount, currency, taxAmount, razorpayOrderId, description, metadata ? JSON.stringify(metadata) : null]
  )
  return { id, userId, type, amount, currency, taxAmount, razorpayOrderId, description, metadata }
}

export async function updateOrder(id, updates) {
  const sets = []
  const params = []
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      const col = key.replace(/([A-Z])/g, '_$1').toLowerCase()
      sets.push(`${col} = ?`)
      params.push(value)
    }
  }
  if (sets.length === 0) return
  params.push(uuidToBuffer(id))
  await query(`UPDATE payment_orders SET ${sets.join(', ')} WHERE id = ?`, params)
}

export async function findOrderById(id) {
  const row = await queryOne('SELECT * FROM payment_orders WHERE id = ?', [uuidToBuffer(id)])
  return rowToOrder(row)
}

export async function findOrderByRazorpayId(razorpayOrderId) {
  const row = await queryOne('SELECT * FROM payment_orders WHERE razorpay_order_id = ?', [razorpayOrderId])
  return rowToOrder(row)
}

export async function findOrdersByUserId(userId, limit = 20, offset = 0) {
  const rows = await query(
    'SELECT * FROM payment_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [uuidToBuffer(userId), limit, offset]
  )
  return rows.map(rowToOrder)
}

export async function countOrdersByUserId(userId) {
  const row = await queryOne('SELECT COUNT(*) as total FROM payment_orders WHERE user_id = ?', [uuidToBuffer(userId)])
  return row?.total || 0
}

export async function createTransaction({ id, orderId, gateway, gatewayTxnId, gatewayStatus, amount, currency, responseData }) {
  await query(
    `INSERT INTO payment_transactions (id, order_id, gateway, gateway_txn_id, gateway_status, amount, currency, response_data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(id), uuidToBuffer(orderId), gateway, gatewayTxnId, gatewayStatus, amount, currency, responseData ? JSON.stringify(responseData) : null]
  )
  return { id, orderId, gateway, gatewayTxnId, gatewayStatus, amount, currency, responseData }
}

export async function findActiveSchedule(userId) {
  const row = await queryOne(
    "SELECT * FROM subscription_schedules WHERE user_id = ? AND status = 'active' LIMIT 1",
    [uuidToBuffer(userId)]
  )
  return rowToSchedule(row)
}

export async function findScheduleByRazorpayId(razorpaySubscriptionId) {
  const row = await queryOne(
    'SELECT * FROM subscription_schedules WHERE razorpay_subscription_id = ?',
    [razorpaySubscriptionId]
  )
  return rowToSchedule(row)
}

export async function createSchedule({ id, userId, userSubscriptionId, planId, razorpaySubscriptionId, billingCycle, status, currentStart, currentEnd }) {
  await query(
    `INSERT INTO subscription_schedules (id, user_id, user_subscription_id, plan_id, razorpay_subscription_id, billing_cycle, status, current_start, current_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(id), uuidToBuffer(userId), uuidToBuffer(userSubscriptionId), uuidToBuffer(planId), razorpaySubscriptionId, billingCycle, status, currentStart, currentEnd]
  )
  return { id, userId, userSubscriptionId, planId, razorpaySubscriptionId, billingCycle, status, currentStart, currentEnd }
}

export async function updateSchedule(id, updates) {
  const sets = []
  const params = []
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      const col = key.replace(/([A-Z])/g, '_$1').toLowerCase()
      sets.push(`${col} = ?`)
      params.push(value)
    }
  }
  if (sets.length === 0) return
  params.push(uuidToBuffer(id))
  await query(`UPDATE subscription_schedules SET ${sets.join(', ')} WHERE id = ?`, params)
}

export async function createInvoice({ id, userId, userSubscriptionId, orderId, periodStart, periodEnd, amount, currency, taxAmount, status }) {
  await query(
    `INSERT INTO subscription_invoices (id, user_id, user_subscription_id, order_id, period_start, period_end, amount, currency, tax_amount, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(id), uuidToBuffer(userId), userSubscriptionId ? uuidToBuffer(userSubscriptionId) : null, orderId ? uuidToBuffer(orderId) : null, periodStart, periodEnd, amount, currency, taxAmount, status]
  )
  return { id, userId, userSubscriptionId, orderId, periodStart, periodEnd, amount, currency, taxAmount, status }
}

export async function updateInvoice(id, updates) {
  const sets = []
  const params = []
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      const col = key.replace(/([A-Z])/g, '_$1').toLowerCase()
      sets.push(`${col} = ?`)
      params.push(value)
    }
  }
  if (sets.length === 0) return
  params.push(uuidToBuffer(id))
  await query(`UPDATE subscription_invoices SET ${sets.join(', ')} WHERE id = ?`, params)
}

export async function findInvoicesByUserId(userId, limit = 20, offset = 0) {
  const rows = await query(
    'SELECT * FROM subscription_invoices WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [uuidToBuffer(userId), limit, offset]
  )
  return rows.map(rowToInvoice)
}

export async function findAllPackages() {
  const rows = await query('SELECT * FROM coin_topup_packages ORDER BY display_order ASC')
  return rows.map(rowToPackage)
}

export async function findActivePackages() {
  const rows = await query('SELECT * FROM coin_topup_packages WHERE is_active = 1 ORDER BY display_order ASC')
  return rows.map(rowToPackage)
}

export async function findPackageById(id) {
  const row = await queryOne('SELECT * FROM coin_topup_packages WHERE id = ?', [uuidToBuffer(id)])
  return rowToPackage(row)
}

export async function findPackageBySlug(slug) {
  const row = await queryOne('SELECT * FROM coin_topup_packages WHERE slug = ?', [slug])
  return rowToPackage(row)
}

export async function createPackage({ id, name, slug, coins, price, currency, taxRate, isActive, displayOrder }) {
  await query(
    `INSERT INTO coin_topup_packages (id, name, slug, coins, price, currency, tax_rate, is_active, display_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidToBuffer(id), name, slug, coins, price, currency, taxRate, isActive ? 1 : 0, displayOrder]
  )
  return { id, name, slug, coins, price, currency, taxRate, isActive, displayOrder }
}

export async function updatePackage(id, updates) {
  const sets = []
  const params = []
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      const col = key.replace(/([A-Z])/g, '_$1').toLowerCase()
      if (key === 'isActive') {
        sets.push(`${col} = ?`)
        params.push(value ? 1 : 0)
      } else {
        sets.push(`${col} = ?`)
        params.push(value)
      }
    }
  }
  if (sets.length === 0) return
  params.push(uuidToBuffer(id))
  await query(`UPDATE coin_topup_packages SET ${sets.join(', ')} WHERE id = ?`, params)
}

export async function deletePackage(id) {
  await query('DELETE FROM coin_topup_packages WHERE id = ?', [uuidToBuffer(id)])
}
