const NEW_PERMISSIONS = [
  { code: 'own.profile.read', name: 'Read Own Profile', module: 'profile' },
  { code: 'own.profile.update', name: 'Update Own Profile', module: 'profile' },
  { code: 'ad_categories.read', name: 'Read Ad Categories', module: 'ad_categories' },
  { code: 'ad_categories.create', name: 'Create Ad Categories', module: 'ad_categories' },
  { code: 'ad_categories.update', name: 'Update Ad Categories', module: 'ad_categories' },
  { code: 'ad_categories.delete', name: 'Delete Ad Categories', module: 'ad_categories' },
  { code: 'platform_accounts.read', name: 'Read Platform Accounts', module: 'platform_accounts' },
  { code: 'platform_accounts.verify', name: 'Verify Platform Accounts', module: 'platform_accounts' },
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
  { role: 'publisher', permissions: ['own.profile.read', 'own.profile.update', 'ad_categories.read'] },
  { role: 'client', permissions: ['own.profile.read', 'own.profile.update', 'ad_categories.read'] },
  { role: 'admin', permissions: [
    'users.read', 'users.create', 'users.update', 'users.delete',
    'roles.read', 'roles.create', 'roles.update', 'roles.delete',
    'permissions.read', 'permissions.assign',
    'auth.admin', 'audit.read',
    'ad_categories.read', 'ad_categories.create', 'ad_categories.update', 'ad_categories.delete',
    'platform_accounts.read', 'platform_accounts.verify',
  ]},
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
