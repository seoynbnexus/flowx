import { v7 as generateUuid } from 'uuid';

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

const NEW_TABLE = `
CREATE TABLE IF NOT EXISTS identity_document_types (
  id          BINARY(16) NOT NULL,
  code        VARCHAR(100) NOT NULL,
  name        VARCHAR(200) NOT NULL,
  description TEXT DEFAULT NULL,
  is_mandatory TINYINT(1) NOT NULL DEFAULT 0,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_id_doc_type_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const ALTER_DOCUMENTS = [
  `ALTER TABLE identity_documents MODIFY document_type VARCHAR(100) NOT NULL`,
  `ALTER TABLE identity_documents ADD UNIQUE KEY uk_identity_user_type (user_id, document_type)`,
  `ALTER TABLE identity_documents DROP FOREIGN KEY fk_identity_user`,
  `DROP INDEX uk_identity_user ON identity_documents`,
  `ALTER TABLE identity_documents ADD CONSTRAINT fk_identity_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE`,
];

const SEED_TYPES = [
  { code: 'aadhaar', name: 'Aadhaar Card', description: 'Government-issued Aadhaar card', is_mandatory: 0 },
  { code: 'drivers_license', name: "Driver's License", description: 'Government-issued driving license', is_mandatory: 0 },
];

const NEW_PERMISSIONS = [
  { code: 'identity_document_types.create', name: 'Create Document Types', module: 'identity_document_types' },
  { code: 'identity_document_types.read', name: 'Read Document Types', module: 'identity_document_types' },
  { code: 'identity_document_types.update', name: 'Update Document Types', module: 'identity_document_types' },
  { code: 'identity_document_types.delete', name: 'Delete Document Types', module: 'identity_document_types' },
];

const ROLE_PERMISSION_MAP = [
  { role: 'admin', permissions: ['identity_document_types.create', 'identity_document_types.read', 'identity_document_types.update', 'identity_document_types.delete'] },
  { role: 'super_admin', permissions: ['identity_document_types.create', 'identity_document_types.read', 'identity_document_types.update', 'identity_document_types.delete'] },
];

export async function up({ context: pool }) {
  await pool.execute(NEW_TABLE);

  for (const stmt of ALTER_DOCUMENTS) {
    await pool.execute(stmt);
  }

  for (const t of SEED_TYPES) {
    await pool.execute(
      'INSERT IGNORE INTO identity_document_types (id, code, name, description, is_mandatory) VALUES (?, ?, ?, ?, ?)',
      [uuidToBuffer(generateUuid()), t.code, t.name, t.description, t.is_mandatory]
    );
  }

  for (const perm of NEW_PERMISSIONS) {
    await pool.execute(
      'INSERT IGNORE INTO permissions (id, code, name, module, is_system) VALUES (?, ?, ?, ?, 1)',
      [uuidToBuffer(generateUuid()), perm.code, perm.name, perm.module]
    );
  }

  for (const mapping of ROLE_PERMISSION_MAP) {
    for (const permCode of mapping.permissions) {
      await pool.execute(
        `INSERT IGNORE INTO role_permissions (role_id, permission_id)
         SELECT r.id, p.id FROM roles r, permissions p
         WHERE r.code = ? AND p.code = ?`,
        [mapping.role, permCode]
      );
    }
  }
}

export async function down({ context: pool }) {
  for (const mapping of ROLE_PERMISSION_MAP) {
    for (const permCode of mapping.permissions) {
      await pool.execute(
        `DELETE rp FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE r.code = ? AND p.code = ?`,
        [mapping.role, permCode]
      );
    }
  }

  for (const perm of NEW_PERMISSIONS) {
    await pool.execute('DELETE FROM permissions WHERE code = ?', [perm.code]);
  }

  await pool.execute('DROP TABLE IF EXISTS identity_document_types');
}

export default { up, down };
