import { query, queryOne } from '../../../shared/database/connection.js';
import { uuidToBuffer, bufferToUuid } from '../../../shared/utils/uuid.utils.js';

function mapRow(row) {
  if (!row) return null;
  return {
    id: bufferToUuid(row.id),
    userId: bufferToUuid(row.user_id),
    documentType: row.document_type,
    documentUrl: row.document_url,
    status: row.status,
    rejectedReason: row.rejected_reason,
    verifiedBy: row.verified_by ? bufferToUuid(row.verified_by) : null,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function findById(id) {
  const row = await queryOne(
    'SELECT * FROM identity_documents WHERE id = ?',
    [uuidToBuffer(id)]
  );
  return mapRow(row);
}

export async function findByUserId(userId) {
  const rows = await query(
    'SELECT * FROM identity_documents WHERE user_id = ? ORDER BY created_at DESC',
    [uuidToBuffer(userId)]
  );
  return rows.map(mapRow);
}

export async function findByUserIdAndType(userId, documentType) {
  const row = await queryOne(
    'SELECT * FROM identity_documents WHERE user_id = ? AND document_type = ?',
    [uuidToBuffer(userId), documentType]
  );
  return mapRow(row);
}

export async function create(id, userId, documentType, documentUrl) {
  await query(
    `INSERT INTO identity_documents (id, user_id, document_type, document_url, status)
     VALUES (?, ?, ?, ?, 'pending')`,
    [uuidToBuffer(id), uuidToBuffer(userId), documentType, documentUrl]
  );
  return findById(id);
}

export async function update(id, documentType, documentUrl) {
  await query(
    `UPDATE identity_documents
     SET document_type = ?, document_url = ?, status = 'pending',
         rejected_reason = NULL, verified_by = NULL, verified_at = NULL,
         updated_at = NOW()
     WHERE id = ?`,
    [documentType, documentUrl, uuidToBuffer(id)]
  );
  return findById(id);
}

export async function verify(id, status, adminId, rejectedReason = null) {
  await query(
    `UPDATE identity_documents
     SET status = ?, verified_by = ?, verified_at = NOW(),
         rejected_reason = ?, updated_at = NOW()
     WHERE id = ?`,
    [status, uuidToBuffer(adminId), rejectedReason, uuidToBuffer(id)]
  );
  return findById(id);
}

export async function listAll({ status, page, limit }) {
  const offset = (page - 1) * limit;
  const where = ['u.deleted_at IS NULL'];
  const params = [];

  if (status) {
    where.push('d.status = ?');
    params.push(status);
  }

  const whereClause = `WHERE ${where.join(' AND ')}`;

  const countRow = await queryOne(
    `SELECT COUNT(*) as total FROM identity_documents d
     JOIN users u ON u.id = d.user_id ${whereClause}`,
    params
  );

  const rows = await query(
    `    SELECT d.*, u.email as user_email, up.first_name as user_first_name, up.last_name as user_last_name
     FROM identity_documents d
     JOIN users u ON u.id = d.user_id
     LEFT JOIN user_profiles up ON up.user_id = u.id
     ${whereClause}
     ORDER BY d.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, String(limit), String(offset)]
  );

  return {
    documents: rows.map(r => ({
      ...mapRow(r),
      userEmail: r.user_email,
      userFirstName: r.user_first_name,
      userLastName: r.user_last_name,
    })),
    total: countRow.total,
    page,
    limit,
  };
}
