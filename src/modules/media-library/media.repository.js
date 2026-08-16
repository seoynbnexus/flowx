import { query, queryOne } from '../../../shared/database/connection.js'
import { uuidToBuffer, bufferToUuid } from '../../../shared/utils/uuid.utils.js'

function mapMediaRow(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    userId: bufferToUuid(row.user_id),
    name: row.name,
    storagePath: row.storage_path,
    mimeType: row.mime_type || null,
    mediaKind: row.media_kind,
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function createMediaAsset(id, userId, data) {
  await query(
    `INSERT INTO media_assets (id, user_id, name, storage_path, mime_type, media_kind, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(userId),
      data.name,
      data.storagePath,
      data.mimeType || null,
      data.mediaKind,
      data.sizeBytes,
    ]
  )
  return findMediaAssetById(id)
}

export async function findMediaAssetById(id) {
  const row = await queryOne('SELECT * FROM media_assets WHERE id = ?', [uuidToBuffer(id)])
  return mapMediaRow(row)
}

export async function sumUserMediaBytes(userId) {
  const row = await queryOne(
    'SELECT COALESCE(SUM(size_bytes), 0) as total FROM media_assets WHERE user_id = ?',
    [uuidToBuffer(userId)]
  )
  return Number(row?.total || 0)
}

export async function findMediaByUserId(userId, { page = 1, limit = 20, kind }) {
  const offset = (page - 1) * limit
  const where = ['user_id = ?']
  const params = [uuidToBuffer(userId)]

  if (kind) {
    where.push('media_kind = ?')
    params.push(kind)
  }

  const whereClause = `WHERE ${where.join(' AND ')}`

  const countRow = await queryOne(`SELECT COUNT(*) as total FROM media_assets ${whereClause}`, params)
  const rows = await query(
    `SELECT * FROM media_assets ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, String(limit), String(offset)]
  )

  return {
    items: rows.map(mapMediaRow),
    total: countRow.total,
    page,
    limit,
  }
}

export async function deleteMediaAsset(id) {
  await query('DELETE FROM media_assets WHERE id = ?', [uuidToBuffer(id)])
}

export async function countPostsReferencingMedia(url, storagePath) {
  const row = await queryOne(
    'SELECT COUNT(*) as total FROM posts WHERE deleted_at IS NULL AND (media_url = ? OR media_url = ?)',
    [url, storagePath]
  )
  return Number(row?.total || 0)
}