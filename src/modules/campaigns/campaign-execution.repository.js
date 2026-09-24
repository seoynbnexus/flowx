import { query, queryOne } from '../../../shared/database/connection.js'
import { uuidToBuffer, bufferToUuid, generateUuid } from '../../../shared/utils/uuid.utils.js'

export function mapExecutionRow(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    campaignId: bufferToUuid(row.campaign_id),
    ownerUserId: bufferToUuid(row.owner_user_id),
    kind: row.kind,
    publisherRequestId: row.publisher_request_id ? bufferToUuid(row.publisher_request_id) : null,
    status: row.status,
    fbPageId: row.fb_page_id || null,
    adAccountActId: row.ad_account_act_id || null,
    configHash: row.config_hash || null,
    activeGenerationNo: row.active_generation_no === null || row.active_generation_no === undefined
      ? null
      : Number(row.active_generation_no),
    platformCampaignId: row.platform_campaign_id || null,
    platformAdsetId: row.platform_adset_id || null,
    platformCreativeId: row.platform_creative_id || null,
    platformAdId: row.platform_ad_id || null,
    attempts: Number(row.attempts) || 0,
    error: row.error || null,
    remoteState: row.remote_state || 'visible',
    remoteStateCheckedAt: row.remote_state_checked_at || null,
    remoteStateSource: row.remote_state_source || null,
    consumedPaise: Number(row.consumed_paise) || 0,
    refundedPaise: Number(row.refunded_paise) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function createExecution(data) {
  const id = data.id || generateUuid()
  await query(
    `INSERT INTO campaign_executions
      (id, campaign_id, owner_user_id, kind, publisher_request_id, status, fb_page_id, ad_account_act_id,
       config_hash, platform_campaign_id, platform_adset_id, platform_creative_id, platform_ad_id,
       attempts, error, remote_state, remote_state_checked_at, remote_state_source, consumed_paise, refunded_paise)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(data.campaignId),
      uuidToBuffer(data.ownerUserId),
      data.kind || 'publisher',
      data.publisherRequestId ? uuidToBuffer(data.publisherRequestId) : null,
      data.status || 'pending',
      data.fbPageId || null,
      data.adAccountActId || null,
      data.configHash || null,
      data.platformCampaignId || null,
      data.platformAdsetId || null,
      data.platformCreativeId || null,
      data.platformAdId || null,
      data.attempts || 0,
      data.error || null,
      data.remoteState || 'visible',
      data.remoteStateCheckedAt || null,
      data.remoteStateSource || null,
      data.consumedPaise || 0,
      data.refundedPaise || 0,
    ]
  )
  return id
}

export async function findExecutionByOwner(campaignId, ownerUserId, kind) {
  const row = await queryOne(
    'SELECT * FROM campaign_executions WHERE campaign_id = ? AND owner_user_id = ? AND kind = ?',
    [uuidToBuffer(campaignId), uuidToBuffer(ownerUserId), kind]
  )
  return mapExecutionRow(row)
}

export async function findExecutionById(id) {
  const row = await queryOne('SELECT * FROM campaign_executions WHERE id = ?', [uuidToBuffer(id)])
  return mapExecutionRow(row)
}

export async function findExecutionByMetaId(objectId) {
  const row = await queryOne(
    `SELECT * FROM campaign_executions
     WHERE platform_campaign_id = ? OR platform_adset_id = ? OR platform_creative_id = ? OR platform_ad_id = ?`,
    [objectId, objectId, objectId, objectId]
  )
  if (row) return mapExecutionRow(row)
  const generation = await findGenerationByMetaId(objectId)
  if (!generation) return null
  return findExecutionById(generation.executionId)
}

export async function findGenerationAdIndexByCampaignIds(campaignIds) {
  if (!campaignIds.length) return []
  const placeholders = campaignIds.map(() => '?').join(',')
  const rows = await query(
    `SELECT ce.campaign_id, ce.id AS execution_id, ce.active_generation_no,
            g.generation_no, g.platform_campaign_id, g.platform_adset_id,
            g.platform_creative_id, g.platform_ad_id
     FROM campaign_executions ce
     LEFT JOIN campaign_execution_generations g ON g.campaign_execution_id = ce.id
     WHERE ce.campaign_id IN (${placeholders})`,
    campaignIds.map((id) => uuidToBuffer(id))
  )
  return rows.map((row) => ({
    campaignId: bufferToUuid(row.campaign_id),
    executionId: bufferToUuid(row.execution_id),
    activeGenerationNo: row.active_generation_no === null || row.active_generation_no === undefined
      ? null
      : Number(row.active_generation_no),
    generationNo: row.generation_no === null || row.generation_no === undefined ? null : Number(row.generation_no),
    platformCampaignId: row.platform_campaign_id || null,
    platformAdsetId: row.platform_adset_id || null,
    platformCreativeId: row.platform_creative_id || null,
    platformAdId: row.platform_ad_id || null,
  }))
}

export async function findExecutionsByCampaignId(campaignId) {
  const rows = await query(
    'SELECT * FROM campaign_executions WHERE campaign_id = ? ORDER BY created_at',
    [uuidToBuffer(campaignId)]
  )
  return rows.map(mapExecutionRow)
}

const EXECUTION_UPDATE_FIELDS = {
  status: 'status = ?',
  publisherRequestId: 'publisher_request_id = ?',
  fbPageId: 'fb_page_id = ?',
  adAccountActId: 'ad_account_act_id = ?',
  configHash: 'config_hash = ?',
  activeGenerationNo: 'active_generation_no = ?',
  platformCampaignId: 'platform_campaign_id = ?',
  platformAdsetId: 'platform_adset_id = ?',
  platformCreativeId: 'platform_creative_id = ?',
  platformAdId: 'platform_ad_id = ?',
  attempts: 'attempts = ?',
  error: 'error = ?',
  remoteState: 'remote_state = ?',
  remoteStateCheckedAt: 'remote_state_checked_at = ?',
  remoteStateSource: 'remote_state_source = ?',
  consumedPaise: 'consumed_paise = ?',
  refundedPaise: 'refunded_paise = ?',
}

function executionUpdateValue(key, value) {
  if (key === 'publisherRequestId') return value ? uuidToBuffer(value) : null
  return value ?? null
}

export async function updateExecution(id, data) {
  const fields = []
  const params = []
  for (const [key, fragment] of Object.entries(EXECUTION_UPDATE_FIELDS)) {
    if (data[key] !== undefined) {
      fields.push(fragment)
      params.push(executionUpdateValue(key, data[key]))
    }
  }
  if (!fields.length) return 0
  params.push(uuidToBuffer(id))
  const result = await query(`UPDATE campaign_executions SET ${fields.join(', ')} WHERE id = ?`, params)
  return result.affectedRows || 0
}

export async function claimExecutionConsume(id, paise) {
  const result = await query(
    `UPDATE campaign_executions SET consumed_paise = ?
     WHERE id = ? AND consumed_paise = 0 AND refunded_paise = 0`,
    [paise, uuidToBuffer(id)]
  )
  return result.affectedRows || 0
}

export async function claimExecutionRefund(id, paise) {
  const result = await query(
    `UPDATE campaign_executions SET refunded_paise = ?
     WHERE id = ? AND consumed_paise = 0 AND refunded_paise = 0`,
    [paise, uuidToBuffer(id)]
  )
  return result.affectedRows || 0
}

export async function updateExecutionWithStatusGuard(id, fromStatuses, data) {
  const fields = []
  const params = []
  for (const [key, fragment] of Object.entries(EXECUTION_UPDATE_FIELDS)) {
    if (data[key] !== undefined) {
      fields.push(fragment)
      params.push(executionUpdateValue(key, data[key]))
    }
  }
  if (!fields.length) return 0
  const placeholders = fromStatuses.map(() => '?').join(',')
  params.push(...fromStatuses, uuidToBuffer(id))
  const result = await query(
    `UPDATE campaign_executions SET ${fields.join(', ')} WHERE status IN (${placeholders}) AND id = ?`,
    params
  )
  return result.affectedRows || 0
}

export async function appendExecutionObjectAudit(campaignId, ownerUserId, chain) {
  const pairs = [
    ['facebook_campaign', chain.facebook_campaign],
    ['ad_set', chain.ad_set],
    ['ad_creative', chain.ad_creative],
    ['ad', chain.ad],
  ]
  let inserted = 0
  for (const [objectType, objectId] of pairs) {
    if (!objectId) continue
    const result = await query(
      `INSERT IGNORE INTO campaign_meta_objects (id, campaign_id, object_type, object_id, platform_account_id, status, created_for_user_id)
       VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
      [uuidToBuffer(generateUuid()), uuidToBuffer(campaignId), objectType, objectId, uuidToBuffer(ownerUserId)]
    )
    inserted += result.affectedRows || 0
  }
  return inserted
}

export async function findBackfillCandidateCampaigns(batch, afterId) {
  const params = []
  let afterClause = ''
  if (afterId) {
    afterClause = 'AND c.id > ?'
    params.push(uuidToBuffer(afterId))
  }
  params.push(batch)
  const rows = await query(
    `SELECT c.id, c.client_id, c.status
     FROM campaigns c
     WHERE c.deleted_at IS NULL ${afterClause}
     ORDER BY c.id ASC
     LIMIT ?`,
    params
  )
  return rows.map(row => ({
    id: bufferToUuid(row.id),
    clientId: bufferToUuid(row.client_id),
    status: row.status,
  }))
}

export function mapGenerationRow(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    executionId: bufferToUuid(row.campaign_execution_id),
    generationNo: Number(row.generation_no),
    status: row.status,
    platformCampaignId: row.platform_campaign_id || null,
    platformAdsetId: row.platform_adset_id || null,
    platformCreativeId: row.platform_creative_id || null,
    platformAdId: row.platform_ad_id || null,
    repairRunId: row.repair_run_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function createGeneration(data) {
  const id = data.id || generateUuid()
  await query(
    `INSERT INTO campaign_execution_generations
       (id, campaign_execution_id, generation_no, status,
        platform_campaign_id, platform_adset_id, platform_creative_id, platform_ad_id, repair_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(data.executionId),
      data.generationNo ?? 0,
      data.status || 'active',
      data.platformCampaignId || null,
      data.platformAdsetId || null,
      data.platformCreativeId || null,
      data.platformAdId || null,
      data.repairRunId || null,
    ]
  )
  return id
}

export async function findGenerationById(id) {
  const row = await queryOne('SELECT * FROM campaign_execution_generations WHERE id = ?', [uuidToBuffer(id)])
  return mapGenerationRow(row)
}

export async function findGenerationByExecutionIdAndNumber(executionId, generationNo) {
  const row = await queryOne(
    'SELECT * FROM campaign_execution_generations WHERE campaign_execution_id = ? AND generation_no = ?',
    [uuidToBuffer(executionId), generationNo]
  )
  return mapGenerationRow(row)
}

export async function findActiveGeneration(executionId) {
  const execution = await findExecutionById(executionId)
  if (!execution) return null
  if (execution.activeGenerationNo === null || execution.activeGenerationNo === undefined) return null
  return findGenerationByExecutionIdAndNumber(executionId, execution.activeGenerationNo)
}

export async function listGenerationsForExecution(executionId) {
  const rows = await query(
    'SELECT * FROM campaign_execution_generations WHERE campaign_execution_id = ? ORDER BY generation_no ASC',
    [uuidToBuffer(executionId)]
  )
  return rows.map(mapGenerationRow)
}

export async function findActiveGenerationChain(executionId) {
  const execution = await findExecutionById(executionId)
  if (!execution) return null
  const generation = await findActiveGeneration(executionId)
  if (!generation) return { execution, generation: null }
  return { execution, generation }
}

export async function findGenerationByMetaId(objectId) {
  if (!objectId) return null
  const row = await queryOne(
    `SELECT * FROM campaign_execution_generations
     WHERE platform_campaign_id = ? OR platform_adset_id = ? OR platform_creative_id = ? OR platform_ad_id = ?`,
    [objectId, objectId, objectId, objectId]
  )
  return mapGenerationRow(row)
}

export async function updateGenerationState(id, fromStatuses, toStatus) {
  const placeholders = fromStatuses.map(() => '?').join(',')
  const result = await query(
    `UPDATE campaign_execution_generations SET status = ? WHERE status IN (${placeholders}) AND id = ?`,
    [toStatus, ...fromStatuses, uuidToBuffer(id)]
  )
  return result.affectedRows || 0
}

export async function updateGenerationObjects(id, fromStatuses, data) {  const fields = []
  const params = []
  for (const [key, column] of [
    ['platformCampaignId', 'platform_campaign_id'],
    ['platformAdsetId', 'platform_adset_id'],
    ['platformCreativeId', 'platform_creative_id'],
    ['platformAdId', 'platform_ad_id'],
  ]) {
    if (data[key] !== undefined) {
      fields.push(`${column} = ?`)
      params.push(data[key] || null)
    }
  }
  if (!fields.length) return 0
  const placeholders = fromStatuses.map(() => '?').join(',')
  params.push(...fromStatuses, uuidToBuffer(id))
  const result = await query(
    `UPDATE campaign_execution_generations SET ${fields.join(', ')} WHERE status IN (${placeholders}) AND id = ?`,
    params
  )
  return result.affectedRows || 0
}

export async function moveActiveGeneration(executionId, fromNo, toNo) {
  const result = await query(
    'UPDATE campaign_executions SET active_generation_no = ? WHERE id = ? AND active_generation_no = ?',
    [toNo, uuidToBuffer(executionId), fromNo]
  )
  return result.affectedRows || 0
}
