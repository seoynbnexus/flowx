const UP = `
CREATE TABLE IF NOT EXISTS identity_documents (
  id BINARY(16) NOT NULL,
  user_id BINARY(16) NOT NULL,
  document_type ENUM('aadhaar', 'drivers_license') NOT NULL,
  document_url VARCHAR(500) NOT NULL,
  status ENUM('pending', 'verified', 'rejected') NOT NULL DEFAULT 'pending',
  rejected_reason TEXT DEFAULT NULL,
  verified_by BINARY(16) DEFAULT NULL,
  verified_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_identity_user (user_id),
  KEY idx_identity_status (status),
  CONSTRAINT fk_identity_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_identity_verifier FOREIGN KEY (verified_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const DOWN = 'DROP TABLE IF EXISTS identity_documents;';

export async function up({ context: pool }) {
  const statements = UP.split(';').filter(s => s.trim().length > 0);
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';');
  }
}

export async function down({ context: pool }) {
  await pool.execute(DOWN);
}

export default { up, down };
