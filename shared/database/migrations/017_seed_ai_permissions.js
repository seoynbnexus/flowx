const AI_PERMISSIONS = [
  { code: 'ai.generate', name: 'Generate AI Content', module: 'ai' },
  { code: 'ai.save', name: 'Save AI Content', module: 'ai' },
  { code: 'ai.read', name: 'Read AI Content', module: 'ai' },
  { code: 'ai.admin', name: 'Admin AI Settings', module: 'ai' },
];

const ROLE_PERMISSION_MAP = [
  { role: 'client', permissions: ['ai.generate', 'ai.save', 'ai.read'] },
  { role: 'admin', permissions: ['ai.admin'] },
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

export async function up({ context: pool }) {
  for (const perm of AI_PERMISSIONS) {
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

  const codes = AI_PERMISSIONS.map(p => p.code);
  for (const code of codes) {
    await pool.execute('DELETE FROM permissions WHERE code = ?', [code]);
  }
}
