import { query, queryOne } from '../../../shared/database/connection.js'
import { uuidToBuffer, bufferToUuid, generateUuid } from '../../../shared/utils/uuid.utils.js'
import { buildRepairRunKey } from './promotion-repair.model.js'

export function mapRepairRow(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    promotionTargetId: bufferToUuid(row.promotion_target_id),
    objectId: row.object_id,
    errorCode: row.error_code,
    runKey: row.run_key,
    status: row.status,
    attempts: Number(row.attempts) || 0,
    error: row.error || null,
    amendmentFields: row.amendment_fields
      ? (typeof row.amendment_fields === 'string' ? JSON.parse(row.amendment_fields) : row.amendment_fields)
      : null,
    promotionTargetIssueId: row.promotion_target_issue_id ? bufferToUuid(row.promotion_target_issue_id) : null,
    oldCreativeId: row.old_creative_id || null,
    oldAdId: row.old_ad_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function mapIssueRow(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    promotionTargetId: bufferToUuid(row.promotion_target_id),
    objectId: row.object_id,
    level: row.level || null,
    errorCode: row.error_code,
    summary: row.error_summary || null,
    message: row.error_message || null,
    errorType: row.error_type || null,
    active: Number(row.active) === 1,
    observedAt: row.observed_at,
    clearedAt: row.cleared_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function createRepair(data) {
  const id = data.id || generateUuid()
  await query(
    `INSERT INTO promotion_target_repairs
       (id, promotion_target_id, object_id, error_code, run_key, status, attempts, error,
        amendment_fields, promotion_target_issue_id, old_creative_id, old_ad_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(data.promotionTargetId),
      data.objectId,
      data.errorCode,
      data.runKey || buildRepairRunKey(id),
      data.status || 'pending',
      data.attempts || 0,
      data.error || null,
      data.amendmentFields ? JSON.stringify(data.amendmentFields) : null,
      data.promotionTargetIssueId ? uuidToBuffer(data.promotionTargetIssueId) : null,
      data.oldCreativeId || null,
      data.oldAdId || null,
    ]
  )
  return id
}

export async function findRepairById(id) {
  const row = await queryOne('SELECT * FROM promotion_target_repairs WHERE id = ?', [uuidToBuffer(id)])
  return mapRepairRow(row)
}

export async function findRepairByTriple(promotionTargetId, objectId, errorCode) {
  const row = await queryOne(
    'SELECT * FROM promotion_target_repairs WHERE promotion_target_id = ? AND object_id = ? AND error_code = ?',
    [uuidToBuffer(promotionTargetId), objectId, String(errorCode)]
  )
  return mapRepairRow(row)
}

export async function findRepairByRunKey(runKey) {
  const row = await queryOne('SELECT * FROM promotion_target_repairs WHERE run_key = ?', [runKey])
  return mapRepairRow(row)
}

export async function listRepairsForTarget(promotionTargetId) {
  const rows = await query(
    'SELECT * FROM promotion_target_repairs WHERE promotion_target_id = ? ORDER BY created_at ASC',
    [uuidToBuffer(promotionTargetId)]
  )
  return rows.map(mapRepairRow)
}

export async function findActiveRepairForTarget(promotionTargetId) {
  const row = await queryOne(
    `SELECT * FROM promotion_target_repairs
     WHERE promotion_target_id = ? AND status NOT IN ('completed','failed','unknown')
     ORDER BY created_at DESC LIMIT 1`,
    [uuidToBuffer(promotionTargetId)]
  )
  return mapRepairRow(row)
}

export async function findLastRepairForTarget(promotionTargetId) {
  const row = await queryOne(
    'SELECT * FROM promotion_target_repairs WHERE promotion_target_id = ? ORDER BY created_at DESC LIMIT 1',
    [uuidToBuffer(promotionTargetId)]
  )
  return mapRepairRow(row)
}

export async function updateRepairState(id, fromStatuses, toStatus) {
  const placeholders = fromStatuses.map(() => '?').join(',')
  const result = await query(
    `UPDATE promotion_target_repairs SET status = ? WHERE status IN (${placeholders}) AND id = ?`,
    [toStatus, ...fromStatuses, uuidToBuffer(id)]
  )
  return result.affectedRows || 0
}

export async function recordRepairRun(id, { error = null, attemptsIncrement = 1 } = {}) {
  const result = await query(
    'UPDATE promotion_target_repairs SET attempts = attempts + ?, error = ? WHERE id = ?',
    [attemptsIncrement, error, uuidToBuffer(id)]
  )
  return result.affectedRows || 0
}

export async function rearmRepair(id, data = {}) {
  const fields = ['status = ?']
  const params = ['pending']
  if (data.amendmentFields !== undefined) {
    fields.push('amendment_fields = ?')
    params.push(data.amendmentFields ? JSON.stringify(data.amendmentFields) : null)
  }
  if (data.promotionTargetIssueId !== undefined) {
    fields.push('promotion_target_issue_id = ?')
    params.push(data.promotionTargetIssueId ? uuidToBuffer(data.promotionTargetIssueId) : null)
  }
  if (data.oldCreativeId !== undefined) {
    fields.push('old_creative_id = ?')
    params.push(data.oldCreativeId || null)
  }
  if (data.oldAdId !== undefined) {
    fields.push('old_ad_id = ?')
    params.push(data.oldAdId || null)
  }
  fields.push('attempts = 0', 'error = NULL')
  params.push(uuidToBuffer(id))
  const result = await query(
    `UPDATE promotion_target_repairs SET ${fields.join(', ')}
     WHERE id = ? AND status IN ('completed','failed','unknown')`,
    params
  )
  return result.affectedRows || 0
}

// --- promotion_target_issues ---

export async function upsertPromotionTargetIssue(promotionTargetId, issue) {
  const id = generateUuid()
  await query(
    `INSERT INTO promotion_target_issues
       (id, promotion_target_id, object_id, level, error_code, error_summary, error_message, error_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       active = 1,
       cleared_at = NULL,
       level = VALUES(level),
       error_summary = VALUES(error_summary),
       error_message = VALUES(error_message),
       error_type = VALUES(error_type)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(promotionTargetId),
      issue.objectId,
      issue.level || null,
      issue.errorCode,
      issue.summary || null,
      issue.message || null,
      issue.errorType || null,
    ]
  )
  return findIssueByTriple(promotionTargetId, issue.objectId, issue.errorCode)
}

export async function findIssueByTriple(promotionTargetId, objectId, errorCode) {
  const row = await queryOne(
    'SELECT * FROM promotion_target_issues WHERE promotion_target_id = ? AND object_id = ? AND error_code = ?',
    [uuidToBuffer(promotionTargetId), objectId, String(errorCode)]
  )
  return mapIssueRow(row)
}

export async function deactivateMissingPromotionTargetIssues(promotionTargetId, objectId, activeCodes) {
  const codes = (activeCodes || []).map(String)
  let sql = `UPDATE promotion_target_issues
     SET active = 0, cleared_at = COALESCE(cleared_at, NOW())
     WHERE promotion_target_id = ? AND object_id = ? AND active = 1`
  const params = [uuidToBuffer(promotionTargetId), objectId]
  if (codes.length) {
    sql += ` AND error_code NOT IN (${codes.map(() => '?').join(',')})`
    params.push(...codes)
  }
  const result = await query(sql, params)
  return Number(result?.affectedRows || 0)
}

export async function findActivePromotionTargetIssues(promotionTargetId) {
  const rows = await query(
    'SELECT * FROM promotion_target_issues WHERE promotion_target_id = ? AND active = 1 ORDER BY observed_at ASC',
    [uuidToBuffer(promotionTargetId)]
  )
  return rows.map(mapIssueRow)
}

export async function clearPromotionTargetIssue(issueId) {
  if (!issueId) return
  await query(
    "UPDATE promotion_target_issues SET active = 0, cleared_at = COALESCE(cleared_at, NOW()) WHERE id = ?",
    [uuidToBuffer(issueId)]
  )
}
