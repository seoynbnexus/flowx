import { v7 as generateUuid } from 'uuid';

const UP = `
CREATE TABLE IF NOT EXISTS users (
  id BINARY(16) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(50) DEFAULT NULL,
  status ENUM('active','inactive','blocked','pending') NOT NULL DEFAULT 'pending',
  email_verified_at TIMESTAMP NULL DEFAULT NULL,
  last_login_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_email (email),
  UNIQUE KEY uk_users_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_profiles (
  id BINARY(16) NOT NULL,
  user_id BINARY(16) NOT NULL,
  first_name VARCHAR(100) DEFAULT NULL,
  last_name VARCHAR(100) DEFAULT NULL,
  avatar_url TEXT DEFAULT NULL,
  country_code CHAR(2) DEFAULT 'IN',
  city VARCHAR(100) DEFAULT NULL,
  timezone VARCHAR(100) DEFAULT NULL,
  metadata JSON NOT NULL DEFAULT (JSON_OBJECT()),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_profiles_user_id (user_id),
  KEY idx_user_profiles_user_id (user_id),
  CONSTRAINT fk_user_profiles_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_passwords (
  user_id BINARY(16) NOT NULL,
  password_hash TEXT NOT NULL,
  password_changed_at TIMESTAMP NULL DEFAULT NULL,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_user_passwords_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_sessions (
  id BINARY(16) NOT NULL,
  user_id BINARY(16) NOT NULL,
  refresh_token_hash TEXT NOT NULL,
  device_name VARCHAR(255) DEFAULT NULL,
  ip_address VARCHAR(45) DEFAULT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_user_sessions_user_created (user_id, created_at),
  CONSTRAINT fk_user_sessions_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS roles (
  id BINARY(16) NOT NULL,
  code VARCHAR(50) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT DEFAULT NULL,
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  is_super_admin TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_roles_code (code),
  UNIQUE KEY uk_roles_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS permissions (
  id BINARY(16) NOT NULL,
  code VARCHAR(100) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description TEXT DEFAULT NULL,
  module VARCHAR(100) NOT NULL,
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_permissions_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id BINARY(16) NOT NULL,
  permission_id BINARY(16) NOT NULL,
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (role_id, permission_id),
  KEY fk_role_permissions_permission (permission_id),
  CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES roles (id),
  CONSTRAINT fk_role_permissions_permission FOREIGN KEY (permission_id) REFERENCES permissions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_roles (
  id BINARY(16) NOT NULL,
  user_id BINARY(16) NOT NULL,
  role_id BINARY(16) NOT NULL,
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_roles_user_role (user_id, role_id),
  KEY fk_user_roles_role (role_id),
  CONSTRAINT fk_user_roles_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_user_roles_role FOREIGN KEY (role_id) REFERENCES roles (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oauth_providers (
  id BINARY(16) NOT NULL,
  code VARCHAR(50) NOT NULL,
  name VARCHAR(100) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_oauth_providers_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oauth_accounts (
  id BINARY(16) NOT NULL,
  user_id BINARY(16) NOT NULL,
  provider_id BINARY(16) NOT NULL,
  provider_user_id VARCHAR(255) NOT NULL,
  provider_email VARCHAR(255) DEFAULT NULL,
  provider_username VARCHAR(255) DEFAULT NULL,
  metadata JSON NOT NULL DEFAULT (JSON_OBJECT()),
  linked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_oauth_provider_user (provider_id, provider_user_id),
  KEY idx_oauth_accounts_provider_id (provider_id),
  KEY idx_oauth_account_user_id (user_id),
  CONSTRAINT fk_oauth_accounts_provider FOREIGN KEY (provider_id) REFERENCES oauth_providers (id),
  CONSTRAINT fk_oauth_accounts_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id BINARY(16) NOT NULL,
  oauth_account_id BINARY(16) NOT NULL,
  encrypted_access_token TEXT DEFAULT NULL,
  encrypted_refresh_token TEXT DEFAULT NULL,
  encrypted_id_token TEXT DEFAULT NULL,
  token_type VARCHAR(50) DEFAULT NULL,
  expires_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_oauth_account_id (oauth_account_id),
  CONSTRAINT fk_oauth_tokens_account FOREIGN KEY (oauth_account_id) REFERENCES oauth_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS email_verifications (
  id BINARY(16) NOT NULL,
  user_id BINARY(16) NOT NULL,
  token_hash VARCHAR(255) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  verified_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_email_verifications_token_hash (token_hash),
  KEY idx_email_verification_user_id (user_id),
  CONSTRAINT fk_email_verifications_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS password_resets (
  id BINARY(16) NOT NULL,
  user_id BINARY(16) NOT NULL,
  token_hash VARCHAR(255) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_password_resets_user_used (user_id, used_at),
  CONSTRAINT fk_password_resets_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS phone_otps (
  id BINARY(16) NOT NULL,
  user_id BINARY(16) DEFAULT NULL,
  phone VARCHAR(20) NOT NULL,
  otp_hash VARCHAR(255) NOT NULL,
  purpose VARCHAR(50) NOT NULL,
  attempts INT DEFAULT 0,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_phone (phone),
  KEY idx_phone_purpose (phone, purpose),
  KEY idx_phone_otps_user_id (user_id),
  CONSTRAINT fk_phone_otps_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BINARY(16) NOT NULL,
  actor_id BINARY(16) DEFAULT NULL,
  entity_type ENUM('user','role','oauth_account','session') DEFAULT NULL,
  entity_id BINARY(16) DEFAULT NULL,
  action VARCHAR(100) DEFAULT NULL,
  old_values JSON DEFAULT NULL,
  new_values JSON DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_logs_entity (entity_type, entity_id),
  KEY idx_audit_logs_actor_id (actor_id),
  CONSTRAINT fk_audit_logs_actor FOREIGN KEY (actor_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_login_history (
  id BINARY(16) NOT NULL,
  user_id BINARY(16) DEFAULT NULL,
  provider_id BINARY(16) DEFAULT NULL,
  login_method VARCHAR(50) DEFAULT NULL,
  ip_address VARCHAR(45) DEFAULT NULL,
  user_agent TEXT DEFAULT NULL,
  success TINYINT(1) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_auth_login_history_provider_user_created (provider_id, user_id, created_at),
  KEY fk_auth_login_history_user (user_id),
  CONSTRAINT fk_auth_login_history_provider FOREIGN KEY (provider_id) REFERENCES oauth_providers (id),
  CONSTRAINT fk_auth_login_history_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const ROLES_SEED = [
  { code: 'super_admin', name: 'Super Admin', description: 'Super administrator role', is_super_admin: 1 },
  { code: 'admin', name: 'Admin', description: 'Administrator role', is_super_admin: 0 },
  { code: 'publisher', name: 'Publisher', description: 'Publisher role', is_super_admin: 0 },
  { code: 'client', name: 'Client', description: 'Client role', is_super_admin: 0 },
  { code: 'support_agent', name: 'Support Agent', description: 'Support agent role', is_super_admin: 0 },
];

const PERMISSIONS_SEED = [
  { code: 'users.read', name: 'Read Users', module: 'users' },
  { code: 'users.create', name: 'Create Users', module: 'users' },
  { code: 'users.update', name: 'Update Users', module: 'users' },
  { code: 'users.delete', name: 'Delete Users', module: 'users' },
  { code: 'roles.read', name: 'Read Roles', module: 'roles' },
  { code: 'roles.create', name: 'Create Roles', module: 'roles' },
  { code: 'roles.update', name: 'Update Roles', module: 'roles' },
  { code: 'roles.delete', name: 'Delete Roles', module: 'roles' },
  { code: 'permissions.read', name: 'Read Permissions', module: 'permissions' },
  { code: 'permissions.assign', name: 'Assign Permissions', module: 'permissions' },
  { code: 'auth.admin', name: 'Auth Admin', module: 'auth' },
  { code: 'audit.read', name: 'Read Audit Logs', module: 'audit' },
];

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

const DOWN = `
DROP TABLE IF EXISTS auth_login_history;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS phone_otps;
DROP TABLE IF EXISTS password_resets;
DROP TABLE IF EXISTS email_verifications;
DROP TABLE IF EXISTS oauth_tokens;
DROP TABLE IF EXISTS oauth_accounts;
DROP TABLE IF EXISTS oauth_providers;
DROP TABLE IF EXISTS user_roles;
DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS user_sessions;
DROP TABLE IF EXISTS user_passwords;
DROP TABLE IF EXISTS user_profiles;
DROP TABLE IF EXISTS users;
`;

export async function up({ context: pool }) {
  const statements = UP.split(';').filter(s => s.trim().length > 0);
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';');
  }

  for (const role of ROLES_SEED) {
    await pool.execute(
      'INSERT IGNORE INTO roles (id, code, name, description, is_system, is_super_admin) VALUES (?, ?, ?, ?, 1, ?)',
      [uuidToBuffer(generateUuid()), role.code, role.name, role.description, role.is_super_admin]
    );
  }

  for (const perm of PERMISSIONS_SEED) {
    await pool.execute(
      'INSERT IGNORE INTO permissions (id, code, name, module, is_system) VALUES (?, ?, ?, ?, 1)',
      [uuidToBuffer(generateUuid()), perm.code, perm.name, perm.module]
    );
  }

  await pool.execute(
    'INSERT IGNORE INTO oauth_providers (id, code, name, active) VALUES (?, ?, ?, ?)',
    [uuidToBuffer(generateUuid()), 'google', 'Google', 1]
  );
}

export async function down({ context: pool }) {
  const statements = DOWN.split(';').filter(s => s.trim().length > 0);
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';');
  }
}
