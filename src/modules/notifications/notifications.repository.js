import { query, queryOne } from '../../../shared/database/connection.js'
import { uuidToBuffer, bufferToUuid } from '../../../shared/utils/uuid.utils.js'
import { generateUuid } from '../../../shared/utils/uuid.utils.js'

const rowToNotification = (row) => {
  let parsed = null
  if (row.data != null) {
    if (typeof row.data === 'string') {
      try { parsed = JSON.parse(row.data) } catch { parsed = null }
    } else {
      parsed = row.data
    }
  }
  return {
    id: bufferToUuid(row.id),
    userId: bufferToUuid(row.user_id),
    type: row.type,
    title: row.title,
    body: row.body,
    data: parsed,
    isRead: !!row.is_read,
    createdAt: row.created_at,
  }
}

export async function createNotification(userId, type, title, body, data = null) {
  const id = generateUuid()
  await query(
    'INSERT INTO notifications (id, user_id, type, title, body, data) VALUES (?, ?, ?, ?, ?, ?)',
    [uuidToBuffer(id), uuidToBuffer(userId), type, title, body, data ? JSON.stringify(data) : null]
  )
  return id
}

export async function getUnreadCount(userId, type = null) {
  if (type) {
    const types = (Array.isArray(type) ? type : [type]).map((t) => String(t).trim()).filter(Boolean)
    if (types.length === 0) return 0
    const placeholders = types.map(() => '?').join(',')
    const rows = await query(
      `SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0 AND type IN (${placeholders})`,
      [uuidToBuffer(userId), ...types]
    )
    return rows[0].cnt
  }
  const rows = await query(
    'SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0',
    [uuidToBuffer(userId)]
  )
  return rows[0].cnt
}

export async function getUnreadCountsByType(userId) {
  const rows = await query(
    'SELECT type, COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0 GROUP BY type',
    [uuidToBuffer(userId)]
  )
  let campaign = 0
  let post = 0
  for (const r of rows) {
    if (r.type === 'new_campaign_request' || r.type === 'campaign_republish') campaign += Number(r.cnt)
    else if (r.type === 'new_post_request') post += Number(r.cnt)
  }
  const total = campaign + post + rows
    .filter(r => !['new_campaign_request','campaign_republish','new_post_request'].includes(r.type))
    .reduce((s, r) => s + Number(r.cnt), 0)
  return { count: total, byType: { campaign, post } }
}

export async function getNotifications(userId, page = 1, limit = 20) {
  const safePage = Math.max(1, parseInt(String(page), 10) || 1)
  const safeLimit = Math.min(Math.max(1, parseInt(String(limit), 10) || 20), 100)
  const offset = (safePage - 1) * safeLimit
  const rows = await query(
    `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ${safeLimit} OFFSET ${offset}`,
    [uuidToBuffer(userId)]
  )
  const totalRows = await query(
    'SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ?',
    [uuidToBuffer(userId)]
  )
  return {
    items: rows.map(rowToNotification),
    total: totalRows[0].cnt,
    page: safePage,
    limit: safeLimit,
  }
}

export async function markAsRead(notificationIds, userId) {
  if (notificationIds.length === 0) return 0
  const placeholders = notificationIds.map(() => '?').join(',')
  const ids = notificationIds.map(id => uuidToBuffer(id))
  const result = await query(
    `UPDATE notifications SET is_read = 1 WHERE id IN (${placeholders}) AND user_id = ?`,
    [...ids, uuidToBuffer(userId)]
  )
  return result.affectedRows
}

export async function markAllAsRead(userId) {
  const result = await query(
    'UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0',
    [uuidToBuffer(userId)]
  )
  return result.affectedRows
}
