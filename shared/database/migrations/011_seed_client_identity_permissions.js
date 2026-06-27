export async function up({ context: pool }) {
  await pool.execute(
    `INSERT IGNORE INTO role_permissions (role_id, permission_id)
     SELECT r.id, p.id FROM roles r, permissions p
     WHERE r.code = 'client' AND p.code IN ('identity_documents.upload', 'identity_documents.read')`
  );
}

export async function down({ context: pool }) {
  await pool.execute(
    `DELETE rp FROM role_permissions rp
     JOIN roles r ON r.id = rp.role_id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE r.code = 'client' AND p.code IN ('identity_documents.upload', 'identity_documents.read')`
  );
}

export default { up, down };
