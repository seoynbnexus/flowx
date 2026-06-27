const NEW_PERMISSIONS = [
  { code: 'identity_documents.upload', name: 'Upload Identity Document', module: 'identity_documents' },
  { code: 'identity_documents.read', name: 'Read Identity Documents', module: 'identity_documents' },
  { code: 'identity_documents.verify', name: 'Verify Identity Documents', module: 'identity_documents' },
];

function generateUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

const INSERT_PERMISSIONS = NEW_PERMISSIONS.map(
  (p) => `INSERT IGNORE INTO permissions (id, code, name, module, is_system) VALUES (?, ?, ?, ?, 1)`
);

const ROLE_PERMISSION_MAP = [
  { role: 'publisher', permissions: ['identity_documents.upload', 'identity_documents.read'] },
  { role: 'client', permissions: ['identity_documents.upload', 'identity_documents.read'] },
  { role: 'admin', permissions: ['identity_documents.read', 'identity_documents.verify'] },
];

export async function up({ context: pool }) {
  for (let i = 0; i < NEW_PERMISSIONS.length; i++) {
    const p = NEW_PERMISSIONS[i];
    await pool.execute(INSERT_PERMISSIONS[i], [
      uuidToBuffer(generateUuid()), p.code, p.name, p.module,
    ]);
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

  const codes = NEW_PERMISSIONS.map((p) => p.code);
  for (const code of codes) {
    await pool.execute('DELETE FROM permissions WHERE code = ?', [code]);
  }
}

export default { up, down };
