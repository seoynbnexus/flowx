import { v7 as generateUuid } from 'uuid';

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

const UP = `
CREATE TABLE IF NOT EXISTS platforms (
  id BINARY(16) NOT NULL,
  code VARCHAR(50) NOT NULL,
  name VARCHAR(100) NOT NULL,
  icon_url TEXT DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_platforms_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_platform_accounts (
  id BINARY(16) NOT NULL,
  user_id BINARY(16) NOT NULL,
  platform_id BINARY(16) NOT NULL,
  profile_url TEXT NOT NULL,
  platform_username VARCHAR(255) DEFAULT NULL,
  platform_display_name VARCHAR(255) DEFAULT NULL,
  avatar_url TEXT DEFAULT NULL,
  followers_count INT NOT NULL DEFAULT 0,
  platform_user_id VARCHAR(255) DEFAULT NULL,
  access_token TEXT DEFAULT NULL,
  refresh_token TEXT DEFAULT NULL,
  token_expires_at TIMESTAMP NULL DEFAULT NULL,
  verification_status ENUM('pending','verified','rejected') NOT NULL DEFAULT 'pending',
  verified_at TIMESTAMP NULL DEFAULT NULL,
  verified_by BINARY(16) DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  revoked_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_platform (user_id, platform_id),
  KEY idx_verification_status (verification_status),
  KEY fk_upa_platform (platform_id),
  KEY fk_upa_verified_by (verified_by),
  CONSTRAINT fk_upa_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_upa_platform FOREIGN KEY (platform_id) REFERENCES platforms (id),
  CONSTRAINT fk_upa_verified_by FOREIGN KEY (verified_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const DOWN = `
DROP TABLE IF EXISTS user_platform_accounts;
DROP TABLE IF EXISTS platforms;
`;

export async function up({ context: pool }) {
  const statements = UP.split(';').filter(s => s.trim().length > 0);
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';');
  }

  const platforms = [
    { code: 'instagram', name: 'Instagram' },
    { code: 'facebook', name: 'Facebook' },
  ];

  for (const p of platforms) {
    await pool.execute(
      'INSERT IGNORE INTO platforms (id, code, name, is_active) VALUES (?, ?, ?, 1)',
      [uuidToBuffer(generateUuid()), p.code, p.name]
    );
  }
}

export async function down({ context: pool }) {
  const statements = DOWN.split(';').filter(s => s.trim().length > 0);
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';');
  }
}

export default { up, down };
