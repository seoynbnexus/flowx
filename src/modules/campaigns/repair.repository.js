import { query, queryOne } from '../../../shared/database/connection.js'
import { uuidToBuffer, bufferToUuid, generateUuid } from '../../../shared/utils/uuid.utils.js'
import { buildRepairRunKey } from './repair.model.js'

export function mapRepairRow(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    executionId: bufferToUuid(row.campaign_execution_id),
    generationNo: Number(row.generation_no),
    objectId: row.object_id,
    creativeId: row.creative_id || null,
    errorCode: row.error_code,
    runKey: row.run_key,
    status: row.status,
    attempts: Number(row.attempts) || 0,
    error: row.error || null,
    mediaAssetId: row.media_asset_id ? bufferToUuid(row.media_asset_id) : null,
    mediaUrl: row.media_url || null,
    mediaWidth: row.media_width === null || row.media_width === undefined ? null : Number(row.media_width),
    mediaHeight: row.media_height === null || row.media_height === undefined ? null : Number(row.media_height),
    amendmentCreative: row.amendment_creative
      ? (typeof row.amendment_creative === 'string' ? JSON.parse(row.amendment_creative) : row.amendment_creative)
      : null,
    metaIssueId: row.meta_issue_id ? bufferToUuid(row.meta_issue_id) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function createRepair(data) {
  const id = data.id || generateUuid()
  await query(
    `INSERT INTO campaign_execution_repairs
       (id, campaign_execution_id, generation_no, object_id, creative_id, error_code, run_key,
        status, attempts, error, media_asset_id, media_url, media_width, media_height, amendment_creative, meta_issue_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(data.executionId),
      data.generationNo ?? 0,
      data.objectId,
      data.creativeId || null,
      data.errorCode,
      data.runKey || buildRepairRunKey(id),
      data.status || 'pending',
      data.attempts || 0,
      data.error || null,
      data.mediaAssetId ? uuidToBuffer(data.mediaAssetId) : null,
      data.mediaUrl || null,
      data.mediaWidth ?? null,
      data.mediaHeight ?? null,
      data.amendmentCreative ? JSON.stringify(data.amendmentCreative) : null,
      data.metaIssueId ? uuidToBuffer(data.metaIssueId) : null,
    ]
  )
  return id
}

export async function findRepairById(id) {
  const row = await queryOne('SELECT * FROM campaign_execution_repairs WHERE id = ?', [uuidToBuffer(id)])
  return mapRepairRow(row)
}

export async function findRepairByTriple(executionId, objectId, errorCode) {
  const row = await queryOne(
    'SELECT * FROM campaign_execution_repairs WHERE campaign_execution_id = ? AND object_id = ? AND error_code = ?',
    [uuidToBuffer(executionId), objectId, String(errorCode)]
  )
  return mapRepairRow(row)
}

export async function findRepairByRunKey(runKey) {
  const row = await queryOne('SELECT * FROM campaign_execution_repairs WHERE run_key = ?', [runKey])
  return mapRepairRow(row)
}

export async function listRepairsForExecution(executionId) {
  const rows = await query(
    'SELECT * FROM campaign_execution_repairs WHERE campaign_execution_id = ? ORDER BY created_at ASC',
    [uuidToBuffer(executionId)]
  )
  return rows.map(mapRepairRow)
}

export async function updateRepairState(id, fromStatuses, toStatus) {
  const placeholders = fromStatuses.map(() => '?').join(',')
  const result = await query(
    `UPDATE campaign_execution_repairs SET status = ? WHERE status IN (${placeholders}) AND id = ?`,
    [toStatus, ...fromStatuses, uuidToBuffer(id)]
  )
  return result.affectedRows || 0
}

export async function stampRepairAmendment(id, { config, hash }) {
  const result = await query(
    'UPDATE campaign_execution_repairs SET amended_config = ?, amended_config_hash = ? WHERE id = ?',
    [JSON.stringify(config), hash, uuidToBuffer(id)]
  )
  return result.affectedRows || 0
}

export async function recordRepairRun(id, { error = null, attemptsIncrement = 1 } = {}) {
  const result = await query(
    'UPDATE campaign_execution_repairs SET attempts = attempts + ?, error = ? WHERE id = ?',
    [attemptsIncrement, error, uuidToBuffer(id)]
  )
  return result.affectedRows || 0
}

export async function rearmRepair(id, data = {}) {
  const fields = ['status = ?']
  const params = ['pending']
  if (data.mediaAssetId !== undefined) {
    fields.push('media_asset_id = ?')
    params.push(data.mediaAssetId ? uuidToBuffer(data.mediaAssetId) : null)
  }
  if (data.mediaUrl !== undefined) {
    fields.push('media_url = ?')
    params.push(data.mediaUrl || null)
  }
  if (data.mediaWidth !== undefined) {
    fields.push('media_width = ?')
    params.push(data.mediaWidth ?? null)
  }
  if (data.mediaHeight !== undefined) {
    fields.push('media_height = ?')
    params.push(data.mediaHeight ?? null)
  }
  if (data.metaIssueId !== undefined) {
    fields.push('meta_issue_id = ?')
    params.push(data.metaIssueId ? uuidToBuffer(data.metaIssueId) : null)
  }
  if (data.amendmentCreative !== undefined) {
    fields.push('amendment_creative = ?')
    params.push(data.amendmentCreative ? JSON.stringify(data.amendmentCreative) : null)
  }
  fields.push('attempts = 0', 'error = NULL')
  params.push(uuidToBuffer(id))
  const result = await query(
    `UPDATE campaign_execution_repairs SET ${fields.join(', ')}
     WHERE id = ? AND status IN ('completed','failed','superseded')`,
    params
  )
  return result.affectedRows || 0
}
