import { v7 as generateUuid } from 'uuid';

const TABLE_NAME = 'email_otps';

const UP = `
CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
  id BINARY(16) NOT NULL,
  email VARCHAR(255) NOT NULL,
  otp_hash VARCHAR(255) NOT NULL,
  purpose ENUM('registration') NOT NULL,
  attempts TINYINT NOT NULL DEFAULT 0,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_email_otps_email (email),
  KEY idx_email_otps_purpose_email (purpose, email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const DOWN = `DROP TABLE IF EXISTS ${TABLE_NAME};`;

export async function up({ context: pool }) {
  await pool.execute(UP);
}

export async function down({ context: pool }) {
  await pool.execute(DOWN);
}

export default { up, down };
