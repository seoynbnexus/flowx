import { query, queryOne } from '../../../shared/database/connection.js'
import { uuidToBuffer, bufferToUuid, generateUuid } from '../../../shared/utils/uuid.utils.js'

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
    `INSERT INTO campaigns (id, client_id, category_id, name, type, scheduled_at, publisher_count, coins_per_publisher)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(clientId),
      data.categoryId ? uuidToBuffer(data.categoryId) : null,
      data.name,
      data.type || 'post',
      data.scheduledAt || null,
      data.publisherCount || null,
      data.coinsPerPublisher || null,
    ]
  )
  return findCampaignById(id)
}

export async function findCampaignById(id) {
  const row = await queryOne('SELECT * FROM campaigns WHERE id = ?', [uuidToBuffer(id)])
  return mapCampaignRow(row)
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
  if (data.categoryId !== undefined) { fields.push('category_id = ?'); params.push(uuidToBuffer(data.categoryId)) }
  if (data.scheduledAt !== undefined) { fields.push('scheduled_at = ?'); params.push(data.scheduledAt) }
  if (data.publisherCount !== undefined) { fields.push('publisher_count = ?'); params.push(data.publisherCount) }
  if (data.coinsPerPublisher !== undefined) { fields.push('coins_per_publisher = ?'); params.push(data.coinsPerPublisher) }
  if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status) }
  if (data.escrowAmount !== undefined) { fields.push('escrow_amount = ?'); params.push(data.escrowAmount) }
  if (data.coinsEscrowedAt !== undefined) { fields.push('coins_escrowed_at = ?'); params.push(data.coinsEscrowedAt) }
  if (data.clientConfirmed !== undefined) { fields.push('client_confirmed = ?'); params.push(data.clientConfirmed ? 1 : 0) }
  if (data.clientConfirmedAt !== undefined) { fields.push('client_confirmed_at = ?'); params.push(data.clientConfirmedAt) }
  if (data.adminNotes !== undefined) { fields.push('admin_notes = ?'); params.push(data.adminNotes) }
  if (data.reviewedBy !== undefined) { fields.push('reviewed_by = ?'); params.push(uuidToBuffer(data.reviewedBy)) }
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

export async function softDeleteCampaign(id) {
  await query('UPDATE campaigns SET deleted_at = NOW() WHERE id = ?', [uuidToBuffer(id)])
}

export async function createCreative(id, campaignId, data) {
  await query(
    `INSERT INTO campaign_creatives (id, campaign_id, media_url, caption, hashtags, text_body, call_to_action)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE media_url = VALUES(media_url), caption = VALUES(caption),
       hashtags = VALUES(hashtags), text_body = VALUES(text_body), call_to_action = VALUES(call_to_action)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(campaignId),
      data.mediaUrl || null,
      data.caption || null,
      data.hashtags || null,
      data.textBody || null,
      data.callToAction || null,
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
    `INSERT INTO campaign_meta_settings (id, campaign_id, objective, ad_account_id, bid_strategy, optimization_goal, budget_type, budget_amount, targeting, platform_placement)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE objective = VALUES(objective), ad_account_id = VALUES(ad_account_id),
       bid_strategy = VALUES(bid_strategy), optimization_goal = VALUES(optimization_goal),
       budget_type = VALUES(budget_type), budget_amount = VALUES(budget_amount),
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

export async function createMetaObject(campaignId, objectType, objectId, platformAccountId, status) {
  const id = generateUuid()
  await query(
    `INSERT INTO campaign_meta_objects (id, campaign_id, object_type, object_id, platform_account_id, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(campaignId),
      objectType,
      objectId,
      platformAccountId ? uuidToBuffer(platformAccountId) : null,
      status || null,
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

export async function createReviewLog(campaignId, reviewerId, action, previousStatus, notes) {
  const id = generateUuid()
  await query(
    `INSERT INTO campaign_review_log (id, campaign_id, reviewer_id, action, previous_status, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(campaignId),
      uuidToBuffer(reviewerId),
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
  const values = publisherIds.map(pubId => [
    uuidToBuffer(generateUuid()),
    uuidToBuffer(campaignId),
    uuidToBuffer(pubId),
    coinsOffered,
  ])

  const placeholders = values.map(() => '(?, ?, ?, ?, ?)').join(', ')
  const flatValues = values.flat()

  await query(
    `INSERT INTO campaign_publisher_requests (id, campaign_id, publisher_id, coins_offered, status)
     VALUES ${placeholders}`,
    flatValues
  )
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
  const rows = await query(
    `SELECT DISTINCT pac.publisher_id, u.email, up.first_name, up.last_name
     FROM publisher_ad_categories pac
     JOIN users u ON u.id = pac.publisher_id
     LEFT JOIN user_profiles up ON up.user_id = u.id
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id AND r.code = 'publisher'
     WHERE pac.category_id = ? AND u.deleted_at IS NULL AND u.status = 'active'`,
    [uuidToBuffer(categoryId)]
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
  }
}

export async function findVerifiedFacebookPage(userId) {
  const row = await queryOne(
    `SELECT upa.*, p.code as platform_code
     FROM user_platform_accounts upa
     JOIN platforms p ON p.id = upa.platform_id
     WHERE upa.user_id = ?
       AND p.code = 'facebook'
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
  await query('UPDATE campaigns SET status = ? WHERE id = ?', [status, uuidToBuffer(id)])
}
