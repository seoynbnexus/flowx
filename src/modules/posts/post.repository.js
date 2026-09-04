import { query, queryOne, transaction } from '../../../shared/database/connection.js'
import { uuidToBuffer, bufferToUuid, generateUuid } from '../../../shared/utils/uuid.utils.js'
import { decrypt } from '../../../shared/utils/crypto.utils.js'
import { ValidationError } from '../../../shared/errors/AppError.js'
import { toMySqlTimestamp, fromMySqlTimestamp } from '../../../shared/utils/date.utils.js'
import { requeueAutoJob } from '../campaigns/campaign.repository.js'
export { requeueAutoJob }
import { POST_JOB_TYPES } from './post.model.js'

function mapPostRow(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    clientId: bufferToUuid(row.client_id),
    clientEmail: row.client_email || null,
    clientFirstName: row.client_first_name || null,
    clientLastName: row.client_last_name || null,
    name: row.name,
    type: row.type,
    status: row.status,
    scheduledAt: fromMySqlTimestamp(row.scheduled_at),
    caption: row.caption,
    mediaUrl: row.media_url,
    hashtags: row.hashtags,
    textBody: row.text_body,
    categoryId: row.category_id ? bufferToUuid(row.category_id) : null,
    runOnPublishers: !!row.run_on_publishers,
    publisherCount: row.publisher_count,
    coinsPerPublisher: row.coins_per_publisher ? Number(row.coins_per_publisher) : null,
    escrowAmount: Number(row.escrow_amount),
    escrowFromMonthly: Number(row.escrow_from_monthly) || 0,
    escrowFromWallet: Number(row.escrow_from_wallet) || 0,
    coinsEscrowedAt: row.coins_escrowed_at,
    publisherResponseDeadlineAt: row.publisher_response_deadline_at || null,
    clientConfirmed: !!row.client_confirmed,
    clientConfirmedAt: row.client_confirmed_at,
    adminNotes: row.admin_notes,
    reviewedBy: row.reviewed_by ? bufferToUuid(row.reviewed_by) : null,
    reviewedAt: row.reviewed_at,
    reviewNotes: row.review_notes,
    publishedAt: row.published_at,
    error: row.error || null,
    boostEnabled: !!row.boost_enabled,
    boostBudgetType: row.boost_budget_type || null,
    boostBudgetAmount: row.boost_budget_amount != null ? Number(row.boost_budget_amount) : null,
    boostSpendCap: row.boost_spend_cap != null ? Number(row.boost_spend_cap) : null,
    boostEndTime: row.boost_end_time || null,
    boostTargeting: typeof row.boost_targeting === 'string' ? JSON.parse(row.boost_targeting) : row.boost_targeting || null,
    boostPlacement: typeof row.boost_placement === 'string' ? JSON.parse(row.boost_placement) : row.boost_placement || null,
    boostBidStrategy: row.boost_bid_strategy || null,
    boostOptimizationGoal: row.boost_optimization_goal || null,
    boostObjective: row.boost_objective || null,
    boostCallToAction: row.boost_call_to_action || null,
    boostLink: row.boost_link || null,
    boostHeadline: row.boost_headline || null,
    boostDescription: row.boost_description || null,
    adAccountDbId: row.ad_account_id ? bufferToUuid(row.ad_account_id) : null,
    chargedBoostPaise: row.charged_boost_paise ? Number(row.charged_boost_paise) : 0,
    boostError: row.boost_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapPostTargetRow(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    postId: bufferToUuid(row.post_id),
    platformAccountId: bufferToUuid(row.platform_account_id),
    targetType: row.target_type,
    publisherRequestId: row.publisher_request_id ? bufferToUuid(row.publisher_request_id) : null,
    status: row.status,
    error: row.error || null,
    metaObjectId: row.meta_object_id || null,
    promotableId: row.promotable_id || null,
    isEligibleForPromotion: row.is_eligible_for_promotion != null ? !!row.is_eligible_for_promotion : null,
    allowedObjectives: typeof row.allowed_objectives === 'string' ? JSON.parse(row.allowed_objectives) : row.allowed_objectives || null,
    eligibilityCheckedAt: row.eligibility_checked_at || null,
    eligibilityReason: row.eligibility_reason || null,
    containerId: row.container_id || null,
    postedAt: row.posted_at,
    publishState: row.publish_state || 'none',
    remoteVideoId: row.remote_video_id || null,
    remoteUploadUrl: row.remote_upload_url || null,
    publishStateChangedAt: row.publish_state_changed_at || null,
    verificationAttempts: Number(row.verification_attempts) || 0,
    lastVerifyAt: row.last_verify_at || null,
    lastMetaStatus: row.last_meta_status || null,
    lastOperation: row.last_operation || null,
    lastOperationAt: row.last_operation_at || null,
    processingStartedAt: row.processing_started_at || null,
    unknownSince: row.unknown_since || null,
    createdAt: row.created_at,
    lastEngagementSyncAt: row.last_engagement_sync_at || null,
    metaRemoteStatus: row.meta_remote_status || null,
    metaDeletedAt: row.meta_deleted_at || null,
    lastMetaEventAt: row.last_meta_event_at || null,
    lastEngagementEventAt: row.last_engagement_event_at || null,
    platformCode: row.platform_code || null,
    platformUserId: row.platform_user_id || null,
    platformDisplayName: row.platform_display_name || null,
    platformUsername: row.platform_username || null,
    avatarUrl: row.avatar_url || null,
    igBusinessAccountId: row.instagram_business_account_id || null,
    accessToken: row.access_token ? decrypt(row.access_token) : null,
  }
}

function mapReviewLogRow(row) {
  if (!row) return null
  return {
    id: bufferToUuid(row.id),
    postId: bufferToUuid(row.post_id),
    reviewerId: row.reviewer_id ? bufferToUuid(row.reviewer_id) : null,
    action: row.action,
    previousStatus: row.previous_status,
    notes: row.notes,
    createdAt: row.created_at,
  }
}

export async function createPost(id, clientId, data) {
  await query(
    `INSERT INTO posts (id, client_id, category_id, name, type, scheduled_at, run_on_publishers,
       publisher_count, coins_per_publisher, caption, media_url, hashtags, text_body,
       boost_enabled, boost_budget_type, boost_budget_amount, boost_spend_cap, boost_end_time,
       boost_targeting, boost_placement, boost_bid_strategy, boost_optimization_goal, boost_objective,
       boost_call_to_action, boost_link, boost_headline, boost_description, ad_account_id, charged_boost_paise)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(clientId),
      data.categoryId ? uuidToBuffer(data.categoryId) : null,
      data.name,
      data.type || 'post',
      toMySqlTimestamp(data.scheduledAt),
      data.runOnPublishers ? 1 : 0,
      data.publisherCount || null,
      data.coinsPerPublisher || null,
      data.caption || null,
      data.mediaUrl || null,
      data.hashtags || null,
      data.textBody || null,
      data.boostEnabled ? 1 : 0,
      data.boostBudgetType || null,
      data.boostBudgetAmount || null,
      data.boostSpendCap || null,
      data.boostEndTime ? new Date(data.boostEndTime).toISOString().slice(0, 19).replace('T', ' ') : null,
      data.boostTargeting ? JSON.stringify(data.boostTargeting) : null,
      data.boostPlacement ? JSON.stringify(data.boostPlacement) : null,
      data.boostBidStrategy || null,
      data.boostOptimizationGoal || null,
      data.boostObjective || null,
      data.boostCallToAction || null,
      data.boostLink || null,
      data.boostHeadline || null,
      data.boostDescription || null,
      data.adAccountId ? uuidToBuffer(data.adAccountId) : null,
      data.chargedBoostPaise || 0,
    ]
  )
  return findPostById(id)
}

export async function findPostById(id) {
  const row = await queryOne('SELECT * FROM posts WHERE id = ?', [uuidToBuffer(id)])
  return mapPostRow(row)
}

export async function findPostsByClientId(clientId, { page = 1, limit = 20, status }) {
  const offset = (page - 1) * limit
  const where = ['client_id = ?', 'deleted_at IS NULL']
  const params = [uuidToBuffer(clientId)]

  if (status) {
    where.push('status = ?')
    params.push(status)
  }

  const whereClause = `WHERE ${where.join(' AND ')}`

  const countRow = await queryOne(
    `SELECT COUNT(*) as total FROM posts ${whereClause}`,
    params
  )

  const rows = await query(
    `SELECT * FROM posts ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, String(limit), String(offset)]
  )

  return {
    items: rows.map(mapPostRow),
    total: countRow.total,
    page,
    limit,
  }
}

export async function findAllPosts({ page = 1, limit = 20, status, clientId }) {
  const offset = (page - 1) * limit
  const where = ['p.deleted_at IS NULL']
  const params = []

  if (status) {
    where.push('p.status = ?')
    params.push(status)
  }

  if (clientId) {
    where.push('p.client_id = ?')
    params.push(uuidToBuffer(clientId))
  }

  const whereClause = `WHERE ${where.join(' AND ')}`

  const countRow = await queryOne(
    `SELECT COUNT(*) as total FROM posts p ${whereClause}`,
    params
  )

  const rows = await query(
    `SELECT p.*, u.email as client_email, up.first_name as client_first_name, up.last_name as client_last_name
     FROM posts p
     JOIN users u ON u.id = p.client_id
     LEFT JOIN user_profiles up ON up.user_id = u.id
     ${whereClause}
     ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
    [...params, String(limit), String(offset)]
  )

  return {
    items: rows.map(mapPostRow),
    total: countRow.total,
    page,
    limit,
  }
}

export async function updatePost(id, data) {
  const fields = []
  const params = []

  if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name) }
  if (data.type !== undefined) { fields.push('type = ?'); params.push(data.type) }
  if (data.categoryId !== undefined) { fields.push('category_id = ?'); params.push(data.categoryId ? uuidToBuffer(data.categoryId) : null) }
  if (data.scheduledAt !== undefined) { fields.push('scheduled_at = ?'); params.push(toMySqlTimestamp(data.scheduledAt)) }
  if (data.runOnPublishers !== undefined) { fields.push('run_on_publishers = ?'); params.push(data.runOnPublishers ? 1 : 0) }
  if (data.publisherCount !== undefined) { fields.push('publisher_count = ?'); params.push(data.publisherCount) }
  if (data.coinsPerPublisher !== undefined) { fields.push('coins_per_publisher = ?'); params.push(data.coinsPerPublisher) }
  if (data.caption !== undefined) { fields.push('caption = ?'); params.push(data.caption) }
  if (data.mediaUrl !== undefined) { fields.push('media_url = ?'); params.push(data.mediaUrl) }
  if (data.hashtags !== undefined) { fields.push('hashtags = ?'); params.push(data.hashtags) }
  if (data.textBody !== undefined) { fields.push('text_body = ?'); params.push(data.textBody) }
  if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status) }
  if (data.publishedAt !== undefined) { fields.push('published_at = ?'); params.push(data.publishedAt) }
  if (data.error !== undefined) { fields.push('error = ?'); params.push(data.error) }
  if (data.adminNotes !== undefined) { fields.push('admin_notes = ?'); params.push(data.adminNotes) }
  if (data.reviewedBy !== undefined) { fields.push('reviewed_by = ?'); params.push(data.reviewedBy ? uuidToBuffer(data.reviewedBy) : null) }
  if (data.reviewedAt !== undefined) { fields.push('reviewed_at = ?'); params.push(data.reviewedAt) }
  if (data.reviewNotes !== undefined) { fields.push('review_notes = ?'); params.push(data.reviewNotes) }
  if (data.escrowAmount !== undefined) { fields.push('escrow_amount = ?'); params.push(data.escrowAmount) }
  if (data.coinsEscrowedAt !== undefined) { fields.push('coins_escrowed_at = ?'); params.push(data.coinsEscrowedAt) }
  if (data.publisherResponseDeadlineAt !== undefined) { fields.push('publisher_response_deadline_at = ?'); params.push(data.publisherResponseDeadlineAt) }
  if (data.clientConfirmed !== undefined) { fields.push('client_confirmed = ?'); params.push(data.clientConfirmed ? 1 : 0) }
  if (data.clientConfirmedAt !== undefined) { fields.push('client_confirmed_at = ?'); params.push(data.clientConfirmedAt) }
  if (data.boostError !== undefined) { fields.push('boost_error = ?'); params.push(data.boostError) }
  if (data.chargedBoostPaise !== undefined) { fields.push('charged_boost_paise = ?'); params.push(data.chargedBoostPaise) }
  if (data.adAccountId !== undefined) { fields.push('ad_account_id = ?'); params.push(data.adAccountId ? uuidToBuffer(data.adAccountId) : null) }

  if (fields.length === 0) return findPostById(id)

  params.push(uuidToBuffer(id))
  await query(
    `UPDATE posts SET ${fields.join(', ')} WHERE id = ?`,
    params
  )
  return findPostById(id)
}

export async function updatePostWithStatusGuard(id, data, expectedStatus) {
  const fields = []
  const params = []

  if (data.name !== undefined) { fields.push('name = ?'); params.push(data.name) }
  if (data.type !== undefined) { fields.push('type = ?'); params.push(data.type) }
  if (data.categoryId !== undefined) { fields.push('category_id = ?'); params.push(data.categoryId ? uuidToBuffer(data.categoryId) : null) }
  if (data.scheduledAt !== undefined) { fields.push('scheduled_at = ?'); params.push(toMySqlTimestamp(data.scheduledAt)) }
  if (data.runOnPublishers !== undefined) { fields.push('run_on_publishers = ?'); params.push(data.runOnPublishers ? 1 : 0) }
  if (data.publisherCount !== undefined) { fields.push('publisher_count = ?'); params.push(data.publisherCount) }
  if (data.coinsPerPublisher !== undefined) { fields.push('coins_per_publisher = ?'); params.push(data.coinsPerPublisher) }
  if (data.caption !== undefined) { fields.push('caption = ?'); params.push(data.caption) }
  if (data.mediaUrl !== undefined) { fields.push('media_url = ?'); params.push(data.mediaUrl) }
  if (data.hashtags !== undefined) { fields.push('hashtags = ?'); params.push(data.hashtags) }
  if (data.textBody !== undefined) { fields.push('text_body = ?'); params.push(data.textBody) }
  if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status) }
  if (data.publishedAt !== undefined) { fields.push('published_at = ?'); params.push(data.publishedAt) }
  if (data.error !== undefined) { fields.push('error = ?'); params.push(data.error) }
  if (data.reviewedBy !== undefined) { fields.push('reviewed_by = ?'); params.push(data.reviewedBy ? uuidToBuffer(data.reviewedBy) : null) }
  if (data.reviewedAt !== undefined) { fields.push('reviewed_at = ?'); params.push(data.reviewedAt) }
  if (data.reviewNotes !== undefined) { fields.push('review_notes = ?'); params.push(data.reviewNotes) }
  if (data.adminNotes !== undefined) { fields.push('admin_notes = ?'); params.push(data.adminNotes) }
  if (data.escrowAmount !== undefined) { fields.push('escrow_amount = ?'); params.push(data.escrowAmount) }
  if (data.coinsEscrowedAt !== undefined) { fields.push('coins_escrowed_at = ?'); params.push(data.coinsEscrowedAt) }
  if (data.publisherResponseDeadlineAt !== undefined) { fields.push('publisher_response_deadline_at = ?'); params.push(data.publisherResponseDeadlineAt) }
  if (data.clientConfirmed !== undefined) { fields.push('client_confirmed = ?'); params.push(data.clientConfirmed ? 1 : 0) }
  if (data.clientConfirmedAt !== undefined) { fields.push('client_confirmed_at = ?'); params.push(data.clientConfirmedAt) }
  if (data.boostError !== undefined) { fields.push('boost_error = ?'); params.push(data.boostError) }
  if (data.chargedBoostPaise !== undefined) { fields.push('charged_boost_paise = ?'); params.push(data.chargedBoostPaise) }
  if (data.adAccountId !== undefined) { fields.push('ad_account_id = ?'); params.push(data.adAccountId ? uuidToBuffer(data.adAccountId) : null) }

  if (fields.length === 0) return findPostById(id)

  params.push(expectedStatus, uuidToBuffer(id))
  const result = await query(
    `UPDATE posts SET ${fields.join(', ')} WHERE status = ? AND id = ?`,
    params
  )
  if (result.affectedRows === 0) return null
  return findPostById(id)
}

export async function createReviewLog(postId, reviewerId, action, previousStatus, notes) {
  const id = generateUuid()
  await query(
    `INSERT INTO post_review_log (id, post_id, reviewer_id, action, previous_status, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(postId),
      reviewerId ? uuidToBuffer(reviewerId) : null,
      action,
      previousStatus,
      notes || null,
    ]
  )
}

export async function findReviewLogsByPostId(postId) {
  const rows = await query(
    'SELECT * FROM post_review_log WHERE post_id = ? ORDER BY created_at ASC',
    [uuidToBuffer(postId)]
  )
  return rows.map(mapReviewLogRow)
}

export async function findPostTargetsByPostId(postId) {
  const rows = await query(
    `SELECT pt.*, p.code as platform_code, upa.platform_user_id, upa.platform_display_name, upa.platform_username,
       upa.avatar_url, upa.instagram_business_account_id, upa.access_token
     FROM post_targets pt
     JOIN user_platform_accounts upa ON upa.id = pt.platform_account_id
     JOIN platforms p ON p.id = upa.platform_id
     WHERE pt.post_id = ?`,
    [uuidToBuffer(postId)]
  )
  return rows.map(mapPostTargetRow)
}

export async function findPostTargetById(id) {
  const row = await queryOne(
    `SELECT pt.*, p.code as platform_code, upa.platform_user_id, upa.platform_display_name, upa.platform_username,
       upa.avatar_url, upa.instagram_business_account_id, upa.access_token
     FROM post_targets pt
     JOIN user_platform_accounts upa ON upa.id = pt.platform_account_id
     JOIN platforms p ON p.id = upa.platform_id
     WHERE pt.id = ?`,
    [uuidToBuffer(id)]
  )
  return mapPostTargetRow(row)
}

export async function findInstagramTargetsWithMediaIds() {
  const rows = await query(
    `SELECT pt.id, pt.post_id, pt.meta_object_id, upa.access_token
     FROM post_targets pt
     JOIN user_platform_accounts upa ON upa.id = pt.platform_account_id
     JOIN platforms p ON p.id = upa.platform_id
     WHERE pt.meta_object_id IS NOT NULL AND p.code = 'instagram'
     ORDER BY pt.created_at ASC`
  )
  return rows.map(row => ({
    id: bufferToUuid(row.id),
    postId: bufferToUuid(row.post_id),
    metaObjectId: row.meta_object_id,
    accessToken: row.access_token ? decrypt(row.access_token) : null,
  }))
}

export async function findStaleIgContainers(staleMinutes) {
  const rows = await query(
    `SELECT pt.id, pt.post_id, pt.container_id, upa.access_token
     FROM post_targets pt
     JOIN user_platform_accounts upa ON upa.id = pt.platform_account_id
     JOIN platforms p ON p.id = upa.platform_id
     WHERE pt.container_id IS NOT NULL
       AND p.code = 'instagram'
       AND pt.publish_state_changed_at IS NOT NULL
       AND pt.publish_state_changed_at < NOW() - INTERVAL ? MINUTE
     ORDER BY pt.created_at ASC`,
    [String(staleMinutes)]
  )
  return rows.map(row => ({
    id: bufferToUuid(row.id),
    postId: bufferToUuid(row.post_id),
    containerId: row.container_id,
    accessToken: row.access_token ? decrypt(row.access_token) : null,
  }))
}

export async function clearPostTargetContainer(id) {
  await query(
    `UPDATE post_targets SET container_id = NULL, processing_started_at = NULL, unknown_since = NULL, publish_state_changed_at = NOW() WHERE id = ?`,
    [uuidToBuffer(id)]
  )
}

export async function resetPostTargetForRetry(id) {
  const result = await query(
    `UPDATE post_targets SET
       status = 'pending',
       error = NULL,
       meta_object_id = NULL,
       container_id = NULL,
       publish_state = 'none',
       publish_state_changed_at = NOW(),
       verification_attempts = 0,
       posted_at = NULL
     WHERE id = ? AND status != 'posted'`,
    [uuidToBuffer(id)]
  )
  return result.affectedRows > 0
}

export async function findInFlightIgTargetsWithoutJob(jobTypes) {
  const placeholders = jobTypes.map(() => '?').join(', ')
  const rows = await query(
    `SELECT pt.id, pt.post_id, p.code as platform_code, pt.publish_state, po.type as post_type
     FROM post_targets pt
     JOIN user_platform_accounts upa ON upa.id = pt.platform_account_id
     JOIN platforms p ON p.id = upa.platform_id
     JOIN posts po ON po.id = pt.post_id
     WHERE p.code = 'instagram'
       AND pt.status != 'posted'
       AND pt.publish_state IN ('none', 'uploading', 'processing', 'ready', 'retryable_failure', 'retry_pending')
       AND pt.container_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM campaign_jobs j
         WHERE j.job_type IN (${placeholders}) AND j.status IN ('queued', 'running')
           AND LOWER(REPLACE(JSON_UNQUOTE(JSON_EXTRACT(j.payload, '$.targetId')), '-', '')) = HEX(pt.id)
       )
     ORDER BY pt.created_at ASC`,
    jobTypes
  )
  return rows.map(row => ({
    id: bufferToUuid(row.id),
    postId: bufferToUuid(row.post_id),
    platformCode: row.platform_code,
    publishState: row.publish_state,
    postType: row.post_type,
  }))
}

export async function findPostTargetsByStatus(postId, status) {
  const rows = await query(
    `SELECT pt.*, p.code as platform_code, upa.platform_user_id, upa.platform_display_name, upa.platform_username,
       upa.avatar_url, upa.instagram_business_account_id, upa.access_token
     FROM post_targets pt
     JOIN user_platform_accounts upa ON upa.id = pt.platform_account_id
     JOIN platforms p ON p.id = upa.platform_id
     WHERE pt.post_id = ? AND pt.status = ?`,
    [uuidToBuffer(postId), status]
  )
  return rows.map(mapPostTargetRow)
}

export async function findPostTargetsByPostIdAndTargetType(postId, targetType) {
  const rows = await query(
    `SELECT pt.*, p.code as platform_code, upa.platform_user_id, upa.platform_display_name, upa.platform_username,
       upa.avatar_url, upa.instagram_business_account_id, upa.access_token
     FROM post_targets pt
     JOIN user_platform_accounts upa ON upa.id = pt.platform_account_id
     JOIN platforms p ON p.id = upa.platform_id
     WHERE pt.post_id = ? AND pt.target_type = ?`,
    [uuidToBuffer(postId), targetType]
  )
  return rows.map(mapPostTargetRow)
}

export async function replacePostTargets(postId, targetType, platformAccountIds) {
  return transaction(async (conn) => {
    const bufPostId = uuidToBuffer(postId)
    const existing = await conn.execute(
      'SELECT id, platform_account_id FROM post_targets WHERE post_id = ? AND target_type = ?',
      [bufPostId, targetType]
    )
    const existingIds = new Set(existing[0].map(r => r.platform_account_id.toString('hex')))
    const keepIds = new Set(platformAccountIds.map(id => uuidToBuffer(id).toString('hex')))
    const idsToDelete = [...existingIds].filter(id => !keepIds.has(id))

    for (const id of idsToDelete) {
      await conn.execute(
        'DELETE FROM post_targets WHERE post_id = ? AND platform_account_id = ? AND target_type = ?',
        [bufPostId, Buffer.from(id, 'hex'), targetType]
      )
    }

    const created = []
    for (const accountId of platformAccountIds) {
      const bufAccountId = uuidToBuffer(accountId)
      const [res] = await conn.execute(
        `INSERT IGNORE INTO post_targets (id, post_id, platform_account_id, target_type)
         VALUES (?, ?, ?, ?)`,
        [uuidToBuffer(generateUuid()), bufPostId, bufAccountId, targetType]
      )
      if (res.affectedRows > 0) created.push(accountId)
    }
    return created
  })
}

export async function updatePostTargetStatus(id, data) {
  const fields = []
  const params = []

  if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status) }
  if (data.error !== undefined) { fields.push('error = ?'); params.push(data.error) }
  if (data.metaObjectId !== undefined) { fields.push('meta_object_id = ?'); params.push(data.metaObjectId) }
  if (data.containerId !== undefined) { fields.push('container_id = ?'); params.push(data.containerId) }
  if (data.postedAt !== undefined) { fields.push('posted_at = ?'); params.push(data.postedAt) }
  if (data.publishState !== undefined) { fields.push('publish_state = ?'); params.push(data.publishState) }
  if (data.remoteVideoId !== undefined) { fields.push('remote_video_id = ?'); params.push(data.remoteVideoId) }
  if (data.remoteUploadUrl !== undefined) { fields.push('remote_upload_url = ?'); params.push(data.remoteUploadUrl) }
  if (data.publishStateChangedAt !== undefined) { fields.push('publish_state_changed_at = ?'); params.push(data.publishStateChangedAt) }
  if (data.verificationAttempts !== undefined) { fields.push('verification_attempts = ?'); params.push(data.verificationAttempts) }
  if (data.lastVerifyAt !== undefined) { fields.push('last_verify_at = ?'); params.push(data.lastVerifyAt) }
  if (data.lastMetaStatus !== undefined) { fields.push('last_meta_status = ?'); params.push(data.lastMetaStatus) }
  if (data.lastOperation !== undefined) { fields.push('last_operation = ?'); params.push(data.lastOperation) }
  if (data.lastOperationAt !== undefined) { fields.push('last_operation_at = ?'); params.push(data.lastOperationAt) }
  if (data.metaRemoteStatus !== undefined) { fields.push('meta_remote_status = ?'); params.push(data.metaRemoteStatus) }
  if (data.metaDeletedAt !== undefined) { fields.push('meta_deleted_at = ?'); params.push(data.metaDeletedAt) }
  if (data.lastMetaEventAt !== undefined) { fields.push('last_meta_event_at = ?'); params.push(data.lastMetaEventAt) }
  if (data.lastEngagementEventAt !== undefined) { fields.push('last_engagement_event_at = ?'); params.push(data.lastEngagementEventAt) }
  if (data.promotableId !== undefined) { fields.push('promotable_id = ?'); params.push(data.promotableId) }
  if (data.isEligibleForPromotion !== undefined) { fields.push('is_eligible_for_promotion = ?'); params.push(data.isEligibleForPromotion == null ? null : data.isEligibleForPromotion ? 1 : 0) }
  if (data.allowedObjectives !== undefined) { fields.push('allowed_objectives = ?'); params.push(data.allowedObjectives ? JSON.stringify(data.allowedObjectives) : null) }
  if (data.eligibilityCheckedAt !== undefined) { fields.push('eligibility_checked_at = ?'); params.push(data.eligibilityCheckedAt) }
  if (data.eligibilityReason !== undefined) { fields.push('eligibility_reason = ?'); params.push(data.eligibilityReason) }

  if (fields.length === 0) return

  params.push(uuidToBuffer(id))
  await query(
    `UPDATE post_targets SET ${fields.join(', ')} WHERE id = ?`,
    params
  )
}

export async function transitionPostTargetState(id, fromStates, toState, fields = {}) {
  const sets = ['publish_state = ?', 'publish_state_changed_at = NOW()']
  const params = [toState]

  if (fields.status !== undefined) { sets.push('status = ?'); params.push(fields.status) }
  if (fields.error !== undefined) { sets.push('error = ?'); params.push(fields.error) }
  if (fields.metaObjectId !== undefined) { sets.push('meta_object_id = ?'); params.push(fields.metaObjectId) }
  if (fields.containerId !== undefined) { sets.push('container_id = ?'); params.push(fields.containerId) }
  if (fields.postedAt !== undefined) { sets.push('posted_at = ?'); params.push(fields.postedAt) }
  if (fields.remoteVideoId !== undefined) { sets.push('remote_video_id = ?'); params.push(fields.remoteVideoId) }
  if (fields.remoteUploadUrl !== undefined) { sets.push('remote_upload_url = ?'); params.push(fields.remoteUploadUrl) }
  if (fields.verificationAttempts !== undefined) { sets.push('verification_attempts = ?'); params.push(fields.verificationAttempts) }
  if (fields.lastVerifyAt !== undefined) { sets.push('last_verify_at = ?'); params.push(fields.lastVerifyAt) }
  if (fields.lastMetaStatus !== undefined) { sets.push('last_meta_status = ?'); params.push(fields.lastMetaStatus) }
  if (fields.lastOperation !== undefined) { sets.push('last_operation = ?'); params.push(fields.lastOperation) }
  if (fields.lastOperationAt !== undefined) { sets.push('last_operation_at = ?'); params.push(fields.lastOperationAt) }
  if (fields.processingStartedAt !== undefined) { sets.push('processing_started_at = ?'); params.push(fields.processingStartedAt) }
  if (fields.unknownSince !== undefined) { sets.push('unknown_since = ?'); params.push(fields.unknownSince) }

  const placeholders = fromStates.map(() => '?').join(', ')
  params.push(uuidToBuffer(id), ...fromStates)
  const result = await query(
    `UPDATE post_targets SET ${sets.join(', ')} WHERE id = ? AND publish_state IN (${placeholders})`,
    params
  )
  return result.affectedRows > 0
}

export async function findPostTargetsWithPublishState(postId, publishState) {
  const rows = await query(
    `SELECT pt.*, p.code as platform_code, upa.platform_user_id, upa.platform_display_name, upa.platform_username,
       upa.avatar_url, upa.instagram_business_account_id, upa.access_token
     FROM post_targets pt
     JOIN user_platform_accounts upa ON upa.id = pt.platform_account_id
     JOIN platforms p ON p.id = upa.platform_id
     WHERE pt.post_id = ? AND pt.publish_state = ?`,
    [uuidToBuffer(postId), publishState]
  )
  return rows.map(mapPostTargetRow)
}

export async function findPostAccountsForUser(userId) {
  const rows = await query(
    `SELECT upa.id, upa.platform_user_id, upa.platform_username, upa.platform_display_name,
       upa.avatar_url, upa.followers_count, upa.instagram_business_account_id,
       upa.verification_status, upa.token_status, p.code as platform_code
     FROM user_platform_accounts upa
     JOIN platforms p ON p.id = upa.platform_id
     WHERE upa.user_id = ?
       AND upa.token_type = 'page'
       AND upa.verification_status = 'verified'
       AND p.code IN ('facebook', 'instagram')
     ORDER BY p.code, upa.platform_display_name`,
    [uuidToBuffer(userId)]
  )
  return rows.map(r => ({
    id: bufferToUuid(r.id),
    platformUserId: r.platform_user_id,
    platformUsername: r.platform_username,
    platformDisplayName: r.platform_display_name,
    avatarUrl: r.avatar_url,
    followersCount: r.followers_count,
    igBusinessAccountId: r.instagram_business_account_id,
    verificationStatus: r.verification_status,
    tokenStatus: r.token_status,
    platformCode: r.platform_code,
  }))
}

export async function findPostsDueForEngagementSync({ stalenessSeconds = 3600, webhookStalenessSeconds = 21600, limit = 20, storyMaxAgeHours = 26 } = {}) {
  const rows = await query(
    `SELECT DISTINCT p.id FROM posts p
     JOIN post_targets pt ON pt.post_id = p.id
     LEFT JOIN user_platform_accounts upa ON upa.id = pt.platform_account_id
     WHERE pt.status = 'posted'
       AND pt.meta_object_id IS NOT NULL
       AND pt.meta_deleted_at IS NULL
       AND (
         (upa.webhook_status = 'active'
          AND (pt.last_engagement_sync_at IS NULL OR pt.last_engagement_sync_at < NOW() - INTERVAL ? SECOND)
          AND (pt.last_engagement_event_at IS NULL OR pt.last_engagement_event_at < NOW() - INTERVAL 1800 SECOND))
         OR
         (COALESCE(upa.webhook_status, 'unknown') != 'active'
          AND (pt.last_engagement_sync_at IS NULL OR pt.last_engagement_sync_at < NOW() - INTERVAL ? SECOND))
       )
       AND (p.type != 'story' OR pt.posted_at IS NULL OR pt.posted_at >= NOW() - INTERVAL ? HOUR)
       AND NOT EXISTS (
         SELECT 1 FROM campaign_jobs j
         WHERE j.campaign_id = p.id AND j.job_type = 'post_sync_engagement' AND j.status IN ('queued', 'running')
       )
     ORDER BY p.updated_at ASC
     LIMIT ?`,
    [webhookStalenessSeconds, stalenessSeconds, String(storyMaxAgeHours), String(limit)]
  )
  return rows.map(r => bufferToUuid(r.id))
}

export async function upsertPostEngagement(targetId, postId, snapshot) {
  const id = generateUuid()
  await query(
    `INSERT INTO post_engagement_daily
       (id, post_id, target_id, stat_date, media_type, permalink, likes, comments, saved, shares, views, reach, interactions, impressions, taps_forward, taps_back, exits, replies, raw, comments_json, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       media_type = VALUES(media_type),
       permalink = VALUES(permalink),
       likes = VALUES(likes),
       comments = VALUES(comments),
       saved = VALUES(saved),
       shares = VALUES(shares),
       views = VALUES(views),
       reach = VALUES(reach),
       interactions = VALUES(interactions),
       impressions = VALUES(impressions),
       taps_forward = VALUES(taps_forward),
       taps_back = VALUES(taps_back),
       exits = VALUES(exits),
       replies = VALUES(replies),
       raw = VALUES(raw),
       comments_json = VALUES(comments_json),
       error = VALUES(error)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(postId),
      uuidToBuffer(targetId),
      snapshot.statDate,
      snapshot.mediaType || null,
      snapshot.permalink || null,
      snapshot.likes || 0,
      snapshot.comments || 0,
      snapshot.saved || 0,
      snapshot.shares || 0,
      snapshot.views || 0,
      snapshot.reach || 0,
      snapshot.interactions || 0,
      snapshot.impressions || 0,
      snapshot.tapsForward || 0,
      snapshot.tapsBack || 0,
      snapshot.exits || 0,
      snapshot.replies || 0,
      JSON.stringify(snapshot.raw || {}),
      JSON.stringify(snapshot.commentsJson || []),
      snapshot.error || null,
    ]
  )
}

export async function findPostEngagement(postId) {
  const rows = await query(
    `SELECT pe.*, pt.platform_account_id, pt.status as target_status, pt.meta_object_id, pt.last_engagement_sync_at,
       p.code as platform_code, upa.platform_display_name, upa.platform_username
     FROM post_engagement_daily pe
     JOIN post_targets pt ON pt.id = pe.target_id
     JOIN user_platform_accounts upa ON upa.id = pt.platform_account_id
     JOIN platforms p ON p.id = upa.platform_id
     WHERE pe.post_id = ?
     ORDER BY pe.stat_date ASC`,
    [uuidToBuffer(postId)]
  )
  return rows.map(r => ({
    id: bufferToUuid(r.id),
    postId: bufferToUuid(r.post_id),
    targetId: bufferToUuid(r.target_id),
    statDate: r.stat_date,
    mediaType: r.media_type || null,
    permalink: r.permalink || null,
    likes: Number(r.likes),
    comments: Number(r.comments),
    saved: Number(r.saved),
    shares: Number(r.shares),
    views: Number(r.views),
    reach: Number(r.reach),
    interactions: Number(r.interactions),
    impressions: Number(r.impressions),
    tapsForward: Number(r.taps_forward),
    tapsBack: Number(r.taps_back),
    exits: Number(r.exits),
    replies: Number(r.replies),
    raw: typeof r.raw === 'string' ? JSON.parse(r.raw) : r.raw,
    commentsJson: typeof r.comments_json === 'string' ? JSON.parse(r.comments_json) : r.comments_json,
    error: r.error || null,
    platformAccountId: bufferToUuid(r.platform_account_id),
    platformCode: r.platform_code,
    platformDisplayName: r.platform_display_name,
    platformUsername: r.platform_username,
    metaObjectId: r.meta_object_id || null,
    targetStatus: r.target_status,
    lastEngagementSyncAt: r.last_engagement_sync_at || null,
  }))
}

export async function stampPostEngagementSync(targetId) {
  await query(
    'UPDATE post_targets SET last_engagement_sync_at = NOW() WHERE id = ?',
    [uuidToBuffer(targetId)]
  )
}

export async function requeuePostEngagementJob(postId) {
  return requeueAutoJob(postId, POST_JOB_TYPES.SYNC_ENGAGEMENT, {}, { entityType: 'post' })
}

function mapPostPublisherRequestRow(row) {
  if (!row) return null
  let platformAccountIds = null
  if (row.platform_account_ids != null) {
    try {
      const parsed = typeof row.platform_account_ids === 'string' ? JSON.parse(row.platform_account_ids) : row.platform_account_ids
      if (Array.isArray(parsed)) platformAccountIds = parsed
    } catch {}
  }
  return {
    id: bufferToUuid(row.id),
    postId: bufferToUuid(row.post_id),
    publisherId: bufferToUuid(row.publisher_id),
    publisherEmail: row.publisher_email || null,
    publisherFirstName: row.publisher_first_name || null,
    publisherLastName: row.publisher_last_name || null,
    coinsOffered: Number(row.coins_offered),
    status: row.status,
    platformAccountId: row.platform_account_id ? bufferToUuid(row.platform_account_id) : null,
    platformAccountIds,
    platformCode: row.platform_code || null,
    platformDisplayName: row.platform_display_name || null,
    platformUsername: row.platform_username || null,
    creativeSnapshot: row.creative_snapshot || null,
    contentSnapshot: row.content_snapshot || null,
    contentSnapshotHash: row.content_snapshot_hash || null,
    respondedAt: row.responded_at || null,
    acceptedAt: row.accepted_at || null,
    rejectedAt: row.rejected_at || null,
    completedAt: row.completed_at || null,
    expiresAt: row.expires_at || null,
    publishedAt: row.published_at || null,
    failureReason: row.failure_reason || null,
    payoutStatus: row.payout_status || 'pending',
    payoutTransactionId: row.payout_transaction_id || null,
    requestGeneration: Number(row.request_generation) || 1,
    createdAt: row.created_at,
  }
}

export async function lockPostById(postId) {
  await query('SELECT id FROM posts WHERE id = ? FOR UPDATE', [uuidToBuffer(postId)])
}

export async function createPostPublisherRequests(postId, publisherIds, coinsOffered, { expiresAt = null, requestGeneration = 1, snapshot = null, snapshotHash = null } = {}) {
  const ids = publisherIds.map(() => generateUuid())
  const values = publisherIds.map((pubId, i) => [
    uuidToBuffer(ids[i]),
    uuidToBuffer(postId),
    uuidToBuffer(pubId),
    coinsOffered,
    expiresAt,
    requestGeneration,
    snapshot,
    snapshotHash,
  ])
  const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
  const flatValues = values.flat()
  await query(
    `INSERT INTO post_publisher_requests
       (id, post_id, publisher_id, coins_offered, expires_at, request_generation, content_snapshot, content_snapshot_hash)
     VALUES ${placeholders}`,
    flatValues
  )
  return ids.map((id, i) => ({ requestId: id, publisherId: publisherIds[i] }))
}

export async function findPostPublisherRequestsByPostId(postId) {
  const rows = await query(
    `SELECT r.*, u.email as publisher_email, up.first_name as publisher_first_name, up.last_name as publisher_last_name,
       p.code as platform_code, upa.platform_display_name, upa.platform_username
     FROM post_publisher_requests r
     JOIN users u ON u.id = r.publisher_id
     LEFT JOIN user_profiles up ON up.user_id = u.id
     LEFT JOIN user_platform_accounts upa ON upa.id = r.platform_account_id
     LEFT JOIN platforms p ON p.id = upa.platform_id
     WHERE r.post_id = ?
     ORDER BY r.created_at ASC`,
    [uuidToBuffer(postId)]
  )
  return rows.map(mapPostPublisherRequestRow)
}

export async function findPostPublisherRequestById(id) {
  const row = await queryOne(
    `SELECT r.*, u.email as publisher_email, up.first_name as publisher_first_name, up.last_name as publisher_last_name,
       p.code as platform_code, upa.platform_display_name, upa.platform_username
     FROM post_publisher_requests r
     JOIN users u ON u.id = r.publisher_id
     LEFT JOIN user_profiles up ON up.user_id = u.id
     LEFT JOIN user_platform_accounts upa ON upa.id = r.platform_account_id
     LEFT JOIN platforms p ON p.id = upa.platform_id
     WHERE r.id = ?`,
    [uuidToBuffer(id)]
  )
  return mapPostPublisherRequestRow(row)
}

export async function findPostPublisherRequestsByPublisherId(publisherId, { page = 1, limit = 20, status } = {}) {
  const offset = (page - 1) * limit
  const where = ['r.publisher_id = ?']
  const params = [uuidToBuffer(publisherId)]
  if (status) {
    where.push('r.status = ?')
    params.push(status)
  }
  const whereClause = `WHERE ${where.join(' AND ')}`
  const countRow = await queryOne(
    `SELECT COUNT(*) as total FROM post_publisher_requests r ${whereClause}`,
    params
  )
  const rows = await query(
    `SELECT r.*, po.name as post_name, po.type as post_type, po.status as post_status, po.caption, po.media_url,
       po.scheduled_at, u.email as client_email, up.first_name as client_first_name,
       p.code as platform_code, upa.platform_display_name, upa.platform_username
     FROM post_publisher_requests r
     JOIN posts po ON po.id = r.post_id
     JOIN users u ON u.id = po.client_id
     LEFT JOIN user_profiles up ON up.user_id = u.id
     LEFT JOIN user_platform_accounts upa ON upa.id = r.platform_account_id
     LEFT JOIN platforms p ON p.id = upa.platform_id
     ${whereClause}
     ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    [...params, String(limit), String(offset)]
  )
  return {
    total: countRow.total,
    items: rows.map(r => ({
      ...mapPostPublisherRequestRow(r),
      postName: r.post_name,
      postType: r.post_type,
      postStatus: r.post_status,
      postCaption: r.post_caption,
      postMediaUrl: r.post_media_url,
      clientEmail: r.client_email,
      clientFirstName: r.client_first_name,
    })),
  }
}

export async function countPostPublisherRequestsByStatus(postId, status) {
  const row = await queryOne(
    'SELECT COUNT(*) as count FROM post_publisher_requests WHERE post_id = ? AND status = ?',
    [uuidToBuffer(postId), status]
  )
  return row.count
}

export async function findPostPublisherRequestsByStatus(postId, status) {
  const rows = await query(
    'SELECT * FROM post_publisher_requests WHERE post_id = ? AND status = ?',
    [uuidToBuffer(postId), status]
  )
  return rows.map(mapPostPublisherRequestRow)
}

export async function findAcceptedPostPublisherRequests(postId) {
  const rows = await query(
    'SELECT * FROM post_publisher_requests WHERE post_id = ? AND status = ?',
    [uuidToBuffer(postId), 'accepted']
  )
  return rows.map(mapPostPublisherRequestRow)
}

export async function updatePostPublisherRequestStatusWithGuard(id, status, respondedAt, expectedStatus) {
  const result = await query(
    `UPDATE post_publisher_requests
     SET status = ?, responded_at = COALESCE(?, responded_at),
         accepted_at = IF(? = 'accepted', NOW(), accepted_at),
         rejected_at = IF(? = 'rejected', NOW(), rejected_at),
         completed_at = IF(? = 'completed', NOW(), completed_at)
     WHERE id = ? AND status = ?`,
    [status, respondedAt, status, status, status, uuidToBuffer(id), expectedStatus]
  )
  if (result.affectedRows === 0) {
    throw new ValidationError('Publisher request status conflict — concurrent modification detected')
  }
}

export async function updatePostPublisherRequestPublishedWithGuard(id, expectedStatus) {
  const result = await query(
    `UPDATE post_publisher_requests SET status = ?, published_at = NOW()
     WHERE id = ? AND status = ?`,
    ['published', uuidToBuffer(id), expectedStatus]
  )
  if (result.affectedRows === 0) {
    throw new ValidationError('Publisher request status conflict — concurrent modification detected')
  }
}

export async function updatePostPublisherRequest(id, data) {
  const fields = []
  const params = []
  if (data.platformAccountIds !== undefined) {
    const arr = data.platformAccountIds
    fields.push('platform_account_ids = ?')
    params.push(arr && arr.length ? JSON.stringify(arr) : null)
    fields.push('platform_account_id = ?')
    params.push(arr && arr.length ? uuidToBuffer(arr[0]) : null)
  } else if (data.platformAccountId !== undefined) {
    fields.push('platform_account_id = ?')
    params.push(data.platformAccountId ? uuidToBuffer(data.platformAccountId) : null)
    const legacyArr = data.platformAccountId ? [data.platformAccountId] : null
    fields.push('platform_account_ids = ?')
    params.push(legacyArr ? JSON.stringify(legacyArr) : null)
  }
  if (data.status !== undefined) { fields.push('status = ?'); params.push(data.status) }
  if (data.publishedAt !== undefined) { fields.push('published_at = ?'); params.push(data.publishedAt) }
  if (data.respondedAt !== undefined) { fields.push('responded_at = ?'); params.push(data.respondedAt) }
  if (data.failureReason !== undefined) { fields.push('failure_reason = ?'); params.push(data.failureReason) }
  if (data.payoutStatus !== undefined) { fields.push('payout_status = ?'); params.push(data.payoutStatus) }
  if (data.payoutTransactionId !== undefined) { fields.push('payout_transaction_id = ?'); params.push(data.payoutTransactionId) }
  if (!fields.length) return
  params.push(uuidToBuffer(id))
  await query(
    `UPDATE post_publisher_requests SET ${fields.join(', ')} WHERE id = ?`,
    params
  )
}

export async function createPublisherTarget(postId, requestId, platformAccountId) {
  const existing = await queryOne(
    'SELECT id FROM post_targets WHERE post_id = ? AND platform_account_id = ?',
    [uuidToBuffer(postId), uuidToBuffer(platformAccountId)]
  )
  if (existing) {
    await query(
      'UPDATE post_targets SET target_type = ?, publisher_request_id = ? WHERE id = ?',
      ['publisher', uuidToBuffer(requestId), existing.id]
    )
    return bufferToUuid(existing.id)
  }
  const id = generateUuid()
  await query(
    `INSERT INTO post_targets (id, post_id, platform_account_id, target_type, publisher_request_id)
     VALUES (?, ?, ?, 'publisher', ?)`,
    [uuidToBuffer(id), uuidToBuffer(postId), uuidToBuffer(platformAccountId), uuidToBuffer(requestId)]
  )
  return id
}

export async function findEligiblePublishersForPost({ categoryId, limit = 20 } = {}) {
  const params = []
  let categoryClause = ''
  if (categoryId) {
    categoryClause = `
      AND (
        EXISTS (SELECT 1 FROM publisher_ad_categories pac WHERE pac.publisher_id = u.id AND pac.category_id = ?)
        OR
        EXISTS (SELECT 1 FROM user_categories uc WHERE uc.user_id = u.id AND uc.category_id = ?)
      )`
    params.push(uuidToBuffer(categoryId), uuidToBuffer(categoryId))
  }
  const rows = await query(
    `SELECT DISTINCT u.id as publisher_id, u.email, up.first_name, up.last_name
     FROM users u
     LEFT JOIN user_profiles up ON up.user_id = u.id
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id AND r.code = 'publisher'
     WHERE u.deleted_at IS NULL AND u.status = 'active'
       ${categoryClause}
       AND EXISTS (
         SELECT 1 FROM user_platform_accounts upa
         JOIN platforms p ON p.id = upa.platform_id
         WHERE upa.user_id = u.id
           AND upa.token_type = 'page'
           AND upa.verification_status = 'verified'
           AND p.code IN ('facebook', 'instagram')
       )
     ORDER BY u.id
     LIMIT ?`,
    [...params, String(limit)]
  )
  return rows.map(r => ({
    publisherId: bufferToUuid(r.publisher_id),
    email: r.email,
    firstName: r.first_name,
    lastName: r.last_name,
  }))
}

export async function findVerifiedPublisherAccounts(publisherId) {
  const rows = await query(
    `SELECT upa.id, upa.platform_user_id, upa.platform_username, upa.platform_display_name,
       upa.avatar_url, upa.instagram_business_account_id, upa.verification_status, upa.token_status,
       p.code as platform_code
     FROM user_platform_accounts upa
     JOIN platforms p ON p.id = upa.platform_id
     WHERE upa.user_id = ?
       AND upa.token_type = 'page'
       AND upa.verification_status = 'verified'
       AND p.code IN ('facebook', 'instagram')
     ORDER BY p.code, upa.platform_display_name`,
    [uuidToBuffer(publisherId)]
  )
  return rows.map(r => ({
    id: bufferToUuid(r.id),
    platformUserId: r.platform_user_id,
    platformUsername: r.platform_username,
    platformDisplayName: r.platform_display_name,
    avatarUrl: r.avatar_url,
    igBusinessAccountId: r.instagram_business_account_id,
    verificationStatus: r.verification_status,
    tokenStatus: r.token_status,
    platformCode: r.platform_code,
  }))
}

export async function findExpiredPublisherPosts() {
  const rows = await query(
    `SELECT id FROM posts
     WHERE status = 'awaiting_publishers'
       AND publisher_response_deadline_at IS NOT NULL
       AND publisher_response_deadline_at <= NOW()`
  )
  return rows.map(r => bufferToUuid(r.id))
}

export async function createPostBoostTarget(postId, postTargetId, data) {
  const id = generateUuid()
  await query(
    `INSERT INTO post_boost_targets (id, post_id, post_target_id, platform_account_id, object_type, object_id, status, boost_status, created_for_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(postId),
      uuidToBuffer(postTargetId),
      data.platformAccountId ? uuidToBuffer(data.platformAccountId) : null,
      data.objectType,
      data.objectId,
      data.status || null,
      data.boostStatus || 'pending',
      data.createdForUserId ? uuidToBuffer(data.createdForUserId) : null,
    ]
  )
  return id
}

export async function findPostBoostTargetsByPostId(postId) {
  const rows = await query('SELECT * FROM post_boost_targets WHERE post_id = ? ORDER BY created_at ASC', [uuidToBuffer(postId)])
  return rows.map(r => ({
    id: bufferToUuid(r.id),
    postId: bufferToUuid(r.post_id),
    postTargetId: bufferToUuid(r.post_target_id),
    platformAccountId: r.platform_account_id ? bufferToUuid(r.platform_account_id) : null,
    objectType: r.object_type,
    objectId: r.object_id,
    status: r.status,
    boostStatus: r.boost_status,
    createdForUserId: r.created_for_user_id ? bufferToUuid(r.created_for_user_id) : null,
    createdAt: r.created_at,
  }))
}

export async function findPostBoostTargetsByTargetId(postTargetId) {
  const rows = await query('SELECT * FROM post_boost_targets WHERE post_target_id = ? ORDER BY created_at ASC', [uuidToBuffer(postTargetId)])
  return rows.map(r => ({
    id: bufferToUuid(r.id),
    postId: bufferToUuid(r.post_id),
    postTargetId: bufferToUuid(r.post_target_id),
    platformAccountId: r.platform_account_id ? bufferToUuid(r.platform_account_id) : null,
    objectType: r.object_type,
    objectId: r.object_id,
    status: r.status,
    boostStatus: r.boost_status,
    createdForUserId: r.created_for_user_id ? bufferToUuid(r.created_for_user_id) : null,
    createdAt: r.created_at,
  }))
}

export async function deletePostBoostTargetsByTargetId(postTargetId) {
  await query('DELETE FROM post_boost_targets WHERE post_target_id = ?', [uuidToBuffer(postTargetId)])
}

export async function updatePostBoostTargetStatus(postTargetId, status) {
  await query('UPDATE post_boost_targets SET boost_status = ? WHERE post_target_id = ?', [status, uuidToBuffer(postTargetId)])
}

export async function insertPostBillingEntry(postId, entry) {
  const id = generateUuid()
  await query(
    `INSERT INTO post_billing_entries (id, post_id, kind, paise, coins, rate, paid_from_monthly, paid_from_wallet, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidToBuffer(id),
      uuidToBuffer(postId),
      entry.kind,
      entry.paise || 0,
      entry.coins || 0,
      entry.rate || 0,
      entry.paidFromMonthly || 0,
      entry.paidFromWallet || 0,
      entry.reason || null,
    ]
  )
  return id
}

export async function findPostBillingEntries(postId) {
  const rows = await query('SELECT * FROM post_billing_entries WHERE post_id = ? ORDER BY created_at ASC', [uuidToBuffer(postId)])
  return rows.map(r => ({
    id: bufferToUuid(r.id),
    postId: bufferToUuid(r.post_id),
    kind: r.kind,
    paise: Number(r.paise),
    coins: Number(r.coins),
    rate: Number(r.rate),
    paidFromMonthly: Number(r.paid_from_monthly),
    paidFromWallet: Number(r.paid_from_wallet),
    reason: r.reason,
    createdAt: r.created_at,
  }))
}

export async function findPostAdAccount(postId) {
  const row = await queryOne(
    `SELECT ma.* FROM posts p JOIN meta_ad_accounts ma ON ma.id = p.ad_account_id WHERE p.id = ? LIMIT 1`,
    [uuidToBuffer(postId)]
  )
  return row ? {
    id: bufferToUuid(row.id),
    metaAccountId: row.account_id,
    accessToken: row.token_encrypted ? decrypt(row.token_encrypted) : null,
    monthlyCapPaise: Number(row.monthly_cap_paise) || 0,
    isPrimary: !!row.is_primary,
    status: row.status,
  } : null
}

