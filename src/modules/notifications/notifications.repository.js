import { query, queryOne } from '../../../shared/database/connection.js'
import { uuidToBuffer, bufferToUuid } from '../../../shared/utils/uuid.utils.js'
import { generateUuid } from '../../../shared/utils/uuid.utils.js'

const rowToNotification = (row) => ({
  id: bufferToUuid(row.id),
  userId: bufferToUuid(row.user_id),
  type: row.type,
  title: row.title,
  body: row.body,
  data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
  isRead: !!row.is_read,
  createdAt: row.created_at,
})

export async function createNotification(userId, type, title, body, data = null) {
  const id = generateUuid()
  await query(
    'INSERT INTO notifications (id, user_id, type, title, body, data) VALUES (?, ?, ?, ?, ?, ?)',
    [uuidToBuffer(id), uuidToBuffer(userId), type, title, body, data ? JSON.stringify(data) : null]
  )
  return id
}

export async function getUnreadCount(userId) {
  const rows = await query(
    'SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0',
    [uuidToBuffer(userId)]
  )
  return rows[0].cnt
}

export async function getNotifications(userId, page = 1, limit = 20) {
  const offset = (page - 1) * limit
  const rows = await query(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [uuidToBuffer(userId), limit, offset]
  )
  const totalRows = await query(
    'SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ?',
    [uuidToBuffer(userId)]
  )
  return {
    items: rows.map(rowToNotification),
    total: totalRows[0].cnt,
    page,
    limit,
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
