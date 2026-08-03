import { query, queryOne, transaction } from '../../../shared/database/connection.js'
import { uuidToBuffer, bufferToUuid, generateUuid } from '../../../shared/utils/uuid.utils.js'
import { decrypt } from '../../../shared/utils/crypto.utils.js'
import { ValidationError } from '../../../shared/errors/AppError.js'

function mapCampaignRow(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    clientId: bufferToUuid(row.client_id),
    categoryId: row.category_id ? bufferToUuid(row.category_id) : null,
    name: row.name,
    type: row.type,
    status: row.status,
    scheduledAt: row.scheduled_at,
    publisherCount: row.publisher_count,
    coinsPerPublisher: row.coins_per_publisher ? Number(row.coins_per_publisher) : null,
    escrowAmount: Number(row.escrow_amount),
    coinsEscrowedAt: row.coins_escrowed_at,
    runOnPublishers: !!row.run_on_publishers,
    publisherResponseDeadlineAt: row.publisher_response_deadline_at || null,
    metaStatus: row.meta_status || 'pending',
    metaError: row.meta_error || null,
    metaSpentPaise: row.meta_spent_paise ? Number(row.meta_spent_paise) : 0,
    lastMetaSyncAt: row.last_meta_sync_at || null,
    clientConfirmed: !!row.client_confirmed,
    clientConfirmedAt: row.client_confirmed_at,
    adminNotes: row.admin_notes,
    reviewedBy: row.reviewed_by ? bufferToUuid(row.reviewed_by) : null,
    reviewedAt: row.reviewed_at,
    reviewNotes: row.review_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapCreativeRow(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    campaignId: bufferToUuid(row.campaign_id),
    mediaUrl: row.media_url,
    caption: row.caption,
    hashtags: row.hashtags,
    textBody: row.text_body,
    callToAction: row.call_to_action,
    headline: row.headline || null,
    description: row.description || null,
    utmSource: row.utm_source || null,
    utmMedium: row.utm_medium || null,
    utmCampaign: row.utm_campaign || null,
    utmContent: row.utm_content || null,
    utmTerm: row.utm_term || null,
    createdAt: row.created_at,
  }
}

function mapMetaSettingsRow(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    campaignId: bufferToUuid(row.campaign_id),
    objective: row.objective,
    adAccountId: row.ad_account_id,
    bidStrategy: row.bid_strategy,
    optimizationGoal: row.optimization_goal,
    budgetType: row.budget_type,
    budgetAmount: row.budget_amount ? Number(row.budget_amount) : null,
    billingEvent: row.billing_event || null,
    spendCap: row.spend_cap ? Number(row.spend_cap) : null,
    endTime: row.end_time || null,
    targeting: typeof row.targeting === 'string' ? JSON.parse(row.targeting) : row.targeting || {},
    platformPlacement: typeof row.platform_placement === 'string' ? JSON.parse(row.platform_placement) : row.platform_placement || {},
  }
}

function mapMetaObjectRow(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    campaignId: bufferToUuid(row.campaign_id),
    objectType: row.object_type,
    objectId: row.object_id,
    platformAccountId: row.platform_account_id ? bufferToUuid(row.platform_account_id) : null,
    createdForUserId: row.created_for_user_id ? bufferToUuid(row.created_for_user_id) : null,
    status: row.status,
    createdAt: row.created_at,
  }
}

function mapReviewLogRow(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    campaignId: bufferToUuid(row.campaign_id),
    reviewerId: bufferToUuid(row.reviewer_id),
    action: row.action,
    previousStatus: row.previous_status,
    notes: row.notes,
    createdAt: row.created_at,
  }
}

function mapPublisherRequestRow(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    campaignId: bufferToUuid(row.campaign_id),
    publisherId: bufferToUuid(row.publisher_id),
    coinsOffered: Number(row.coins_offered),
    status: row.status,
    respondedAt: row.responded_at,
    publishedAt: row.published_at,
    createdAt: row.created_at,
  }
}

function mapPublisherCategoryRow(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    publisherId: bufferToUuid(row.publisher_id),
    categoryId: bufferToUuid(row.category_id),
    createdAt: row.created_at,
  }
}

export async function createCampaign(id, clientId, data) {
  await query(
    `INSERT INTO campaigns (id, client_id, category_id, name, type, scheduled_at, publisher_count, coins_per_publisher, run_on_publishers)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(clientId),
      data.categoryId ? uuidToBuffer(data.categoryId) : null,
      data.name,
      data.type || 'post',
      data.scheduledAt || null,
      data.publisherCount || null,
      data.coinsPerPublisher || null,
      data.runOnPublishers ? 1 : 0,
    ]
  )
  return findCampaignById(id)
}

export async function findCampaignById(id) {
  const row = await queryOne('SELECT * FROM campaigns WHERE id = ?', [uuidToBuffer(id)])
  return  mapCampaignRow(row)
}

export async function findCampaignsByClientId(clientId, { page = 1, limit = 20, status }) {
  const offset = (page - 1) * limit
  const where = ['client_id = ?', 'deleted_at IS NULL']
  const params = [uuidToBuffer(clientId)]

  if (status) {
    where.push('status = ?')
    params.push(status)
  }

  const whereClause = `WHERE ${where.join(' AND ')}`

  const countRow = await queryOne(
    `SELECT COUNT(*) as total FROM campaigns ${whereClause}`,
    params
  )

  const rows = await query(
    `SELECT * FROM campaigns ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, String(limit), String(offset)]
  )

  return {
    items: rows.map(mapCampaignRow),
    total: countRow.total,
    page,
    limit,
  }
}

export async function findAllCampaigns({ page = 1, limit = 20, status, clientId }) {
  const offset = (page - 1) * limit
  const where = ['c.deleted_at IS NULL']
  const params = []

  if (status) {
    where.push('c.status = ?')
    params.push(status)
  }

  if (clientId) {
    where.push('c.client_id = ?')
    params.push(uuidToBuffer(clientId))
  }

  const whereClause = `WHERE ${where.join(' AND ')}`

  const countRow = await queryOne(
    `SELECT COUNT(*) as total FROM campaigns c ${whereClause}`,
    params
  )

  const rows = await query(
    `SELECT c.*, u.email as client_email, up.first_name as client_first_name, up.last_name as client_last_name
     FROM campaigns c
     JOIN users u ON u.id = c.client_id
     LEFT JOIN user_profiles up ON up.user_id = u.id
     ${whereClause}
     ORDER BY c.created_at DESC LIMIT ? OFFSET ?`,
    [...params, String(limit), String(offset)]
  )

  return {
    items: rows.map(r => ({
      ...mapCampaignRow(r),
      clientEmail: r.client_email,
      clientFirstName: r.client_first_name,
      clientLastName: r.client_last_name,
    })),
    total: countRow.total,
    page,
    limit,
  }
}

export async function updateCampaign(id, data) {
  const fields = []
  const params = []

  if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name) }
  if (data.type !== undefined) { fields.push('type = ?'); params.push(data.type) }
  if (data.categoryId !== undefined) { fields.push('category_id = ?'); params.push(data.categoryId ? uuidToBuffer(data.categoryId) : null) }
  if (data.scheduledAt !== undefined) { fields.push('scheduled_at = ?'); params.push(data.scheduledAt) }
  if (data.publisherCount !== undefined) { fields.push('publisher_count = ?'); params.push(data.publisherCount) }
  if (data.coinsPerPublisher !== undefined) { fields.push('coins_per_publisher = ?'); params.push(data.coinsPerPublisher) }
  if (data.runOnPublishers !== undefined) { fields.push('run_on_publishers = ?'); params.push(data.runOnPublishers ? 1 : 0) }
  if (data.publisherResponseDeadlineAt !== undefined) { fields.push('publisher_response_deadline_at = ?'); params.push(data.publisherResponseDeadlineAt) }
  if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status) }
  if (data.escrowAmount !== undefined) { fields.push('escrow_amount = ?'); params.push(data.escrowAmount) }
  if (data.coinsEscrowedAt !== undefined) { fields.push('coins_escrowed_at = ?'); params.push(data.coinsEscrowedAt) }
  if (data.clientConfirmed !== undefined) { fields.push('client_confirmed = ?'); params.push(data.clientConfirmed ? 1 : 0) }
  if (data.clientConfirmedAt !== undefined) { fields.push('client_confirmed_at = ?'); params.push(data.clientConfirmedAt) }
  if (data.metaStatus !== undefined) { fields.push('meta_status = ?'); params.push(data.metaStatus) }
  if (data.metaError !== undefined) { fields.push('meta_error = ?'); params.push(data.metaError) }
  if (data.adminNotes !== undefined) { fields.push('admin_notes = ?'); params.push(data.adminNotes) }
  if (data.reviewedBy !== undefined) { fields.push('reviewed_by = ?'); params.push(data.reviewedBy ? uuidToBuffer(data.reviewedBy) : null) }
  if (data.reviewedAt !== undefined) { fields.push('reviewed_at = ?'); params.push(data.reviewedAt) }
  if (data.reviewNotes !== undefined) { fields.push('review_notes = ?'); params.push(data.reviewNotes) }

  if (fields.length === 0) return findCampaignById(id)

  params.push(uuidToBuffer(id))
  await query(
    `UPDATE campaigns SET ${fields.join(', ')} WHERE id = ?`,
    params
  )
  return findCampaignById(id)
}

export async function updateCampaignWithStatusGuard(id, data, expectedStatus) {
  const fields = []
  const params = []

  if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name) }
  if (data.type !== undefined) { fields.push('type = ?'); params.push(data.type) }
  if (data.categoryId !== undefined) { fields.push('category_id = ?'); params.push(data.categoryId ? uuidToBuffer(data.categoryId) : null) }
  if (data.scheduledAt !== undefined) { fields.push('scheduled_at = ?'); params.push(data.scheduledAt) }
  if (data.publisherCount !== undefined) { fields.push('publisher_count = ?'); params.push(data.publisherCount) }
  if (data.coinsPerPublisher !== undefined) { fields.push('coins_per_publisher = ?'); params.push(data.coinsPerPublisher) }
  if (data.runOnPublishers !== undefined) { fields.push('run_on_publishers = ?'); params.push(data.runOnPublishers ? 1 : 0) }
  if (data.publisherResponseDeadlineAt !== undefined) { fields.push('publisher_response_deadline_at = ?'); params.push(data.publisherResponseDeadlineAt) }
  if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status) }
  if (data.escrowAmount !== undefined) { fields.push('escrow_amount = ?'); params.push(data.escrowAmount) }
  if (data.coinsEscrowedAt !== undefined) { fields.push('coins_escrowed_at = ?'); params.push(data.coinsEscrowedAt) }
  if (data.clientConfirmed !== undefined) { fields.push('client_confirmed = ?'); params.push(data.clientConfirmed ? 1 : 0) }
  if (data.clientConfirmedAt !== undefined) { fields.push('client_confirmed_at = ?'); params.push(data.clientConfirmedAt) }
  if (data.metaStatus !== undefined) { fields.push('meta_status = ?'); params.push(data.metaStatus) }
  if (data.metaError !== undefined) { fields.push('meta_error = ?'); params.push(data.metaError) }
  if (data.adminNotes !== undefined) { fields.push('admin_notes = ?'); params.push(data.adminNotes) }
  if (data.reviewedBy !== undefined) { fields.push('reviewed_by = ?'); params.push(data.reviewedBy ? uuidToBuffer(data.reviewedBy) : null) }
  if (data.reviewedAt !== undefined) { fields.push('reviewed_at = ?'); params.push(data.reviewedAt) }
  if (data.reviewNotes !== undefined) { fields.push('review_notes = ?'); params.push(data.reviewNotes) }

  if (fields.length === 0) return findCampaignById(id)

  params.push(expectedStatus, uuidToBuffer(id))
  const result = await query(
    `UPDATE campaigns SET ${fields.join(', ')} WHERE status = ? AND id = ?`,
    params
  )
  if (result.affectedRows === 0) {
    throw new ValidationError('Campaign status conflict — concurrent modification detected')
  }
  return findCampaignById(id)
}

export async function softDeleteCampaign(id) {
  await query('UPDATE campaigns SET deleted_at = NOW() WHERE id = ?', [uuidToBuffer(id)])
}

export async function createCreative(id, campaignId, data) {
  await query(
    `INSERT INTO campaign_creatives (id, campaign_id, media_url, caption, hashtags, text_body, call_to_action, headline, description, utm_source, utm_medium, utm_campaign, utm_content, utm_term)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE media_url = VALUES(media_url), caption = VALUES(caption),
       hashtags = VALUES(hashtags), text_body = VALUES(text_body), call_to_action = VALUES(call_to_action),
       headline = VALUES(headline), description = VALUES(description),
       utm_source = VALUES(utm_source), utm_medium = VALUES(utm_medium),
       utm_campaign = VALUES(utm_campaign), utm_content = VALUES(utm_content),
       utm_term = VALUES(utm_term)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(campaignId),
      data.mediaUrl || null,
      data.caption || null,
      data.hashtags || null,
      data.textBody || null,
      data.callToAction || null,
      data.headline || null,
      data.description || null,
      data.utmSource || null,
      data.utmMedium || null,
      data.utmCampaign || null,
      data.utmContent || null,
      data.utmTerm || null,
    ]
  )
  return findCreativeByCampaignId(campaignId)
}

export async function findCreativeByCampaignId(campaignId) {
  const row = await queryOne('SELECT * FROM campaign_creatives WHERE campaign_id = ?', [uuidToBuffer(campaignId)])
  return mapCreativeRow(row)
}

export async function createMetaSettings(id, campaignId, data) {
  await query(
    `INSERT INTO campaign_meta_settings (id, campaign_id, objective, ad_account_id, bid_strategy, optimization_goal, budget_type, budget_amount, billing_event, spend_cap, end_time, targeting, platform_placement)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE objective = VALUES(objective), ad_account_id = VALUES(ad_account_id),
       bid_strategy = VALUES(bid_strategy), optimization_goal = VALUES(optimization_goal),
       budget_type = VALUES(budget_type), budget_amount = VALUES(budget_amount),
       billing_event = VALUES(billing_event), spend_cap = VALUES(spend_cap), end_time = VALUES(end_time),
       targeting = VALUES(targeting), platform_placement = VALUES(platform_placement)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(campaignId),
      data.objective,
      data.adAccountId || null,
      data.bidStrategy || null,
      data.optimizationGoal || null,
      data.budgetType || null,
      data.budgetAmount || null,
      data.billingEvent || null,
      data.spendCap || null,
      data.endTime ? new Date(data.endTime).toISOString().slice(0, 19).replace('T', ' ') : null,
      JSON.stringify(data.targeting || {}),
      JSON.stringify(data.platformPlacement || {}),
    ]
  )
  return findMetaSettingsByCampaignId(campaignId)
}

export async function findMetaSettingsByCampaignId(campaignId) {
  const row = await queryOne('SELECT * FROM campaign_meta_settings WHERE campaign_id = ?', [uuidToBuffer(campaignId)])
  return mapMetaSettingsRow(row)
}

export async function saveMetaObjectStatus(objectId, status) {
  await query(
    'UPDATE campaign_meta_objects SET status = ? WHERE object_id = ?',
    [status, objectId]
  )
}

export async function saveMetaSpend(campaignId, spentPaise) {
  await query(
    'UPDATE campaigns SET meta_spent_paise = ?, last_meta_sync_at = NOW() WHERE id = ?',
    [spentPaise, uuidToBuffer(campaignId)]
  )
}

export async function findSyncableCampaigns() {
  const rows = await query(
    `SELECT c.* FROM campaigns c
     WHERE c.status IN ('running', 'paused')
       AND EXISTS (SELECT 1 FROM campaign_meta_objects mo WHERE mo.campaign_id = c.id)
     ORDER BY
  c.last_meta_sync_at IS NOT NULL,
  c.last_meta_sync_at ASC`
  )
  // const rows = await query(
  //   `SELECT c.* FROM campaigns c
  //    WHERE c.status IN ('running', 'paused')
  //      AND EXISTS (SELECT 1 FROM campaign_meta_objects mo WHERE mo.campaign_id = c.id)
  //    ORDER BY c.last_meta_sync_at ASC NULLS FIRST`
  // )
  return rows.map(mapCampaignRow)
}

export async function createMetaObject(campaignId, objectType, objectId, platformAccountId, status, createdForUserId) {
  const id = generateUuid()
  await query(
    `INSERT INTO campaign_meta_objects (id, campaign_id, object_type, object_id, platform_account_id, status, created_for_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(campaignId),
      objectType,
      objectId,
      platformAccountId ? uuidToBuffer(platformAccountId) : null,
      status || null,
      createdForUserId ? uuidToBuffer(createdForUserId) : null,
    ]
  )
  return id
}

export async function findMetaObjectsByCampaignId(campaignId) {
  const rows = await query(
    'SELECT * FROM campaign_meta_objects WHERE campaign_id = ?',
    [uuidToBuffer(campaignId)]
  )
  return rows.map(mapMetaObjectRow)
}

export async function findMetaObjectsForUser(campaignId, userId) {
  const rows = await query(
    'SELECT * FROM campaign_meta_objects WHERE campaign_id = ? AND created_for_user_id = ?',
    [uuidToBuffer(campaignId), uuidToBuffer(userId)]
  )
  return rows.map(mapMetaObjectRow)
}

export async function deleteMetaObjectsForUser(campaignId, userId) {
  await query(
    'DELETE FROM campaign_meta_objects WHERE campaign_id = ? AND created_for_user_id = ?',
    [uuidToBuffer(campaignId), uuidToBuffer(userId)]
  )
}

export async function lockCampaignById(campaignId) {
  await query('SELECT id FROM campaigns WHERE id = ? FOR UPDATE', [uuidToBuffer(campaignId)])
}

export async function createReviewLog(campaignId, reviewerId, action, previousStatus, notes) {
  const id = generateUuid()
  await query(
    `INSERT INTO campaign_review_log (id, campaign_id, reviewer_id, action, previous_status, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(campaignId),
      reviewerId ? uuidToBuffer(reviewerId) : null,
      action,
      previousStatus,
      notes || null,
    ]
  )
  return id
}

export async function findReviewLogsByCampaignId(campaignId) {
  const rows = await query(
    `SELECT l.*, u.email as reviewer_email, up.first_name as reviewer_first_name, up.last_name as reviewer_last_name
     FROM campaign_review_log l
     JOIN users u ON u.id = l.reviewer_id
     LEFT JOIN user_profiles up ON up.user_id = u.id
     WHERE l.campaign_id = ?
     ORDER BY l.created_at ASC`,
    [uuidToBuffer(campaignId)]
  )
  return rows.map(r => ({
    ...mapReviewLogRow(r),
    reviewerEmail: r.reviewer_email,
    reviewerFirstName: r.reviewer_first_name,
    reviewerLastName: r.reviewer_last_name,
  }))
}

export async function createPublisherRequests(campaignId, publisherIds, coinsOffered) {
  const ids = publisherIds.map(() => generateUuid())
  const values = publisherIds.map((pubId, i) => [
    uuidToBuffer(ids[i]),
    uuidToBuffer(campaignId),
    uuidToBuffer(pubId),
    coinsOffered,
  ])

  const placeholders = values.map(() => '(?, ?, ?, ?)').join(', ')
  const flatValues = values.flat()

  await query(
    `INSERT INTO campaign_publisher_requests (id, campaign_id, publisher_id, coins_offered)
     VALUES ${placeholders}`,
    flatValues
  )

  return ids.map((id, i) => ({ requestId: id, publisherId: publisherIds[i] }))
}

export async function findPublisherRequestsByCampaignId(campaignId) {
  const rows = await query(
    `SELECT r.*, u.email as publisher_email, up.first_name as publisher_first_name, up.last_name as publisher_last_name
     FROM campaign_publisher_requests r
     JOIN users u ON u.id = r.publisher_id
     LEFT JOIN user_profiles up ON up.user_id = u.id
     WHERE r.campaign_id = ?
     ORDER BY r.created_at DESC`,
    [uuidToBuffer(campaignId)]
  )
  return rows.map(r => ({
    ...mapPublisherRequestRow(r),
    publisherEmail: r.publisher_email,
    publisherFirstName: r.publisher_first_name,
    publisherLastName: r.publisher_last_name,
  }))
}

export async function findPublisherRequestsByPublisherId(publisherId, { page = 1, limit = 20, status }) {
  const offset = (page - 1) * limit
  const where = ['r.publisher_id = ?']
  const params = [uuidToBuffer(publisherId)]

  if (status) {
    where.push('r.status = ?')
    params.push(status)
  }

  const whereClause = `WHERE ${where.join(' AND ')}`

  const countRow = await queryOne(
    `SELECT COUNT(*) as total FROM campaign_publisher_requests r ${whereClause}`,
    params
  )

  const rows = await query(
    `SELECT r.*, c.name as campaign_name, c.type as campaign_type, c.status as campaign_status,
            c.scheduled_at, u.email as client_email, up.first_name as client_first_name
     FROM campaign_publisher_requests r
     JOIN campaigns c ON c.id = r.campaign_id
     JOIN users u ON u.id = c.client_id
     LEFT JOIN user_profiles up ON up.user_id = u.id
     ${whereClause}
     ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    [...params, String(limit), String(offset)]
  )

  return {
    items: rows.map(r => ({
      ...mapPublisherRequestRow(r),
      campaignName: r.campaign_name,
      campaignType: r.campaign_type,
      campaignStatus: r.campaign_status,
      scheduledAt: r.scheduled_at,
      clientEmail: r.client_email,
      clientFirstName: r.client_first_name,
    })),
    total: countRow.total,
    page,
    limit,
  }
}

export async function findPublisherRequestById(id) {
  const row = await queryOne(
    `SELECT r.*, c.name as campaign_name, c.type as campaign_type
     FROM campaign_publisher_requests r
     JOIN campaigns c ON c.id = r.campaign_id
     WHERE r.id = ?`,
    [uuidToBuffer(id)]
  )
  if (!row) return null
  return {
    ...mapPublisherRequestRow(row),
    campaignName: row.campaign_name,
    campaignType: row.campaign_type,
  }
}

export async function updatePublisherRequestStatus(id, status, respondedAt) {
  const fields = ['status = ?']
  const params = [status]

  if (respondedAt) {
    fields.push('responded_at = ?')
    params.push(respondedAt)
  }

  params.push(uuidToBuffer(id))
  await query(
    `UPDATE campaign_publisher_requests SET ${fields.join(', ')} WHERE id = ?`,
    params
  )
}

export async function updatePublisherRequestStatusWithGuard(id, status, respondedAt, expectedStatus) {
  const fields = ['status = ?']
  const params = [status]

  if (respondedAt) {
    fields.push('responded_at = ?')
    params.push(respondedAt)
  }

  params.push(expectedStatus, uuidToBuffer(id))
  const result = await query(
    `UPDATE campaign_publisher_requests SET ${fields.join(', ')} WHERE status = ? AND id = ?`,
    params
  )
  if (result.affectedRows === 0) {
    throw new ValidationError('Publisher request status conflict — concurrent modification detected')
  }
}

export async function updatePublisherRequestPublishedWithGuard(id, expectedStatus) {
  const result = await query(
    'UPDATE campaign_publisher_requests SET status = ?, published_at = NOW() WHERE status = ? AND id = ?',
    ['published', expectedStatus, uuidToBuffer(id)]
  )
  if (result.affectedRows === 0) {
    throw new ValidationError('Publisher request status conflict — concurrent modification detected')
  }
}

export async function setPublisherCategories(publisherId, categoryIds) {
  await query('DELETE FROM publisher_ad_categories WHERE publisher_id = ?', [uuidToBuffer(publisherId)])

  if (!categoryIds || categoryIds.length === 0) return []

  const values = categoryIds.map(catId => [
    uuidToBuffer(generateUuid()),
    uuidToBuffer(publisherId),
    uuidToBuffer(catId),
  ])

  const placeholders = values.map(() => '(?, ?, ?)').join(', ')
  const flatValues = values.flat()

  await query(
    `INSERT INTO publisher_ad_categories (id, publisher_id, category_id) VALUES ${placeholders}`,
    flatValues
  )

  return findPublisherCategories(publisherId)
}

export async function findPublisherCategories(publisherId) {
  const rows = await query(
    `SELECT pac.*, c.name as category_name, c.code as category_code
     FROM publisher_ad_categories pac
     JOIN ad_categories c ON c.id = pac.category_id
     WHERE pac.publisher_id = ?`,
    [uuidToBuffer(publisherId)]
  )
  return rows.map(r => ({
    ...mapPublisherCategoryRow(r),
    categoryName: r.category_name,
    categoryCode: r.category_code,
  }))
}

export async function findPublisherIdsByCategoryId(categoryId) {
  const rows = await query(
    `SELECT pac.publisher_id, u.email
     FROM publisher_ad_categories pac
     JOIN users u ON u.id = pac.publisher_id AND u.deleted_at IS NULL
     WHERE pac.category_id = ?`,
    [uuidToBuffer(categoryId)]
  )
  return rows.map(r => ({
    publisherId: bufferToUuid(r.publisher_id),
    email: r.email,
  }))
}

export async function findActivePublishersByCategoryId(categoryId) {
  const buf = uuidToBuffer(categoryId)
  const rows = await query(
    `SELECT DISTINCT u.id as publisher_id, u.email, up.first_name, up.last_name
     FROM users u
     LEFT JOIN user_profiles up ON up.user_id = u.id
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id AND r.code = 'publisher'
     WHERE u.deleted_at IS NULL AND u.status = 'active'
     AND (
       EXISTS (SELECT 1 FROM publisher_ad_categories WHERE publisher_id = u.id AND category_id = ?)
       OR
       EXISTS (SELECT 1 FROM user_categories WHERE user_id = u.id AND category_id = ?)
     )`,
    [buf, buf]
  )
  return rows.map(r => ({
    publisherId: bufferToUuid(r.publisher_id),
    email: r.email,
    firstName: r.first_name,
    lastName: r.last_name,
  }))
}

function mapPlatformAccountRow(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    userId: bufferToUuid(row.user_id),
    platformUserId: row.platform_user_id,
    platformDisplayName: row.platform_display_name,
    verificationStatus: row.verification_status,
    platformCode: row.platform_code,
    accessToken: row.access_token ? decrypt(row.access_token) : null,
  }
}

export async function findVerifiedFacebookPage(userId) {
  const row = await queryOne(
    `SELECT upa.*, p.code as platform_code
     FROM user_platform_accounts upa
     JOIN platforms p ON p.id = upa.platform_id
     WHERE upa.user_id = ?
       AND p.code = 'facebook'
       AND upa.token_type = 'page'
       AND upa.verification_status = 'verified'
     LIMIT 1`,
    [uuidToBuffer(userId)]
  )
  return mapPlatformAccountRow(row)
}

export async function countPublisherRequestsByStatus(campaignId, status) {
  const row = await queryOne(
    'SELECT COUNT(*) as count FROM campaign_publisher_requests WHERE campaign_id = ? AND status = ?',
    [uuidToBuffer(campaignId), status]
  )
  return row.count
}

export async function findPublisherRequestsByStatus(campaignId, status) {
  const rows = await query(
    'SELECT * FROM campaign_publisher_requests WHERE campaign_id = ? AND status = ?',
    [uuidToBuffer(campaignId), status]
  )
  return rows.map(mapPublisherRequestRow)
}

export async function updatePublisherRequestPublished(id) {
  await query(
    'UPDATE campaign_publisher_requests SET status = ?, published_at = NOW() WHERE id = ?',
    ['published', uuidToBuffer(id)]
  )
}

export async function updateCampaignStatus(id, status) {
  const result = await query('UPDATE campaigns SET status = ? WHERE id = ?', [status, uuidToBuffer(id)])
  return result
}

export async function findExpiredAwaitingCampaigns() {
  const rows = await query(
    `SELECT * FROM campaigns
     WHERE status = 'awaiting_publishers'
       AND publisher_response_deadline_at IS NOT NULL
       AND publisher_response_deadline_at <= NOW()`
  )
  return rows.map(mapCampaignRow)
}

export async function findAcceptedPublisherRequests(campaignId) {
  const rows = await query(
    'SELECT * FROM campaign_publisher_requests WHERE campaign_id = ? AND status = ?',
    [uuidToBuffer(campaignId), 'accepted']
  )
  return rows.map(mapPublisherRequestRow)
}

export async function findDueScheduledCampaigns() {
  const rows = await query(
    `SELECT c.id, c.client_id, c.name, c.scheduled_at
     FROM campaigns c
     WHERE c.status = 'scheduled'
       AND c.scheduled_at IS NOT NULL
       AND c.scheduled_at <= NOW()`,
  )
  return rows.map(r => ({
    id: bufferToUuid(r.id),
    clientId: bufferToUuid(r.client_id),
    name: r.name,
    scheduledAt: r.scheduled_at,
  }))
}

export async function deleteMetaObjectsByCampaignId(campaignId) {
  await query('DELETE FROM campaign_meta_objects WHERE campaign_id = ?', [uuidToBuffer(campaignId)])
}

export async function deleteMetaObjectById(id) {
  await query('DELETE FROM campaign_meta_objects WHERE id = ?', [uuidToBuffer(id)])
}

function mapCampaignJobRow(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    campaignId: bufferToUuid(row.campaign_id),
    jobType: row.job_type,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: row.run_after,
    error: row.error,
    actorId: row.actor_id ? bufferToUuid(row.actor_id) : null,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload || {},
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function enqueueCampaignJob(id, campaignId, jobType, actorId = null, payload = {}) {
  const result = await query(
    `INSERT INTO campaign_jobs (id, campaign_id, job_type, status, run_after, actor_id, payload)
     SELECT ?, ?, ?, 'queued', NOW(), ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM campaign_jobs
       WHERE campaign_id = ? AND job_type = ? AND status IN ('queued', 'running')
     )`,
    [
      uuidToBuffer(id), uuidToBuffer(campaignId), jobType,
      actorId ? uuidToBuffer(actorId) : null,
      JSON.stringify(payload),
      uuidToBuffer(campaignId), jobType,
    ]
  )
  return result.affectedRows > 0
}

export async function findCampaignJobById(id) {
  const row = await queryOne('SELECT * FROM campaign_jobs WHERE id = ?', [uuidToBuffer(id)])
  return mapCampaignJobRow(row)
}

export async function countActiveCampaignJobs() {
  const row = await queryOne(
    "SELECT COUNT(*) as count FROM campaign_jobs WHERE status IN ('queued', 'running')"
  )
  return row.count
}

export async function claimDueCampaignJobs(limit = 2) {
  return transaction(async (conn) => {
    const [candidates] = await conn.execute(
      `SELECT id FROM campaign_jobs
       WHERE status = 'queued' AND run_after <= NOW()
       ORDER BY created_at ASC
       LIMIT ${Math.max(1, Math.floor(Number(limit)))} FOR UPDATE`
    )
    const claimed = []
    for (const candidate of candidates) {
      const [res] = await conn.execute(
        `UPDATE campaign_jobs SET status = 'running', attempts = attempts + 1, started_at = NOW()
         WHERE id = ? AND status = 'queued'`,
        [candidate.id]
      )
      if (res.affectedRows > 0) {
        const [rows] = await conn.execute('SELECT * FROM campaign_jobs WHERE id = ?', [candidate.id])
        claimed.push(mapCampaignJobRow(rows[0]))
      }
    }
    return claimed
  })
}

export async function completeCampaignJob(id, status, error = null) {
  await query(
    'UPDATE campaign_jobs SET status = ?, error = ?, finished_at = NOW() WHERE id = ?',
    [status, error, uuidToBuffer(id)]
  )
}

export async function rescheduleCampaignJob(id, error, backoffSeconds) {
  await query(
    'UPDATE campaign_jobs SET status = ?, error = ?, run_after = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = ?',
    ['queued', error, backoffSeconds, uuidToBuffer(id)]
  )
}

export async function requeueStaleCampaignJobs(minutes = 10) {
  await query(
    `UPDATE campaign_jobs SET status = 'queued', run_after = NOW(), started_at = NULL
     WHERE status = 'running' AND started_at IS NOT NULL AND started_at < NOW() - INTERVAL ? MINUTE`,
    [minutes]
  )
}
