const UP = `
CREATE TABLE IF NOT EXISTS user_wallets (
  user_id BINARY(16) NOT NULL,
  coins BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_wallet_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS transactions (
  id BINARY(16) NOT NULL,
  user_id BINARY(16) NOT NULL,
  label VARCHAR(255) NOT NULL,
  amount INT NOT NULL,
  type ENUM('credit', 'debit') NOT NULL,
  reference_type VARCHAR(50) DEFAULT NULL,
  reference_id BINARY(16) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_transactions_user (user_id, created_at),
  CONSTRAINT fk_transactions_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_restrictions (
  id BINARY(16) NOT NULL,
  user_id BINARY(16) NOT NULL,
  ai_generation_blocked TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_restrictions_user (user_id),
  CONSTRAINT fk_restrictions_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_generated_content (
  id BINARY(16) NOT NULL,
  user_id BINARY(16) NOT NULL,
  prompt TEXT NOT NULL,
  content_type VARCHAR(50) NOT NULL,
  generated_content TEXT NOT NULL,
  metadata JSON NOT NULL DEFAULT (JSON_OBJECT()),
  generation_cost INT NOT NULL DEFAULT 0,
  prompt_tokens INT DEFAULT 0,
  completion_tokens INT DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ai_content_user (user_id, created_at),
  CONSTRAINT fk_ai_content_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_usage_log (
  id BINARY(16) NOT NULL,
  user_id BINARY(16) NOT NULL,
  prompt_text TEXT DEFAULT NULL,
  content_type VARCHAR(50) DEFAULT NULL,
  was_blocked TINYINT(1) NOT NULL DEFAULT 0,
  block_reason VARCHAR(255) DEFAULT NULL,
  tokens_used INT NOT NULL DEFAULT 0,
  coins_spent INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ai_usage_user_time (user_id, created_at),
  CONSTRAINT fk_ai_usage_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const DOWN = `
DROP TABLE IF EXISTS ai_usage_log;
DROP TABLE IF EXISTS ai_generated_content;
DROP TABLE IF EXISTS user_restrictions;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS user_wallets;
`;

export async function up({ context: pool }) {
  const statements = UP.split(';').filter(s => s.trim().length > 0);
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';');
  }
}

export async function down({ context: pool }) {
  const statements = DOWN.split(';').filter(s => s.trim().length > 0);
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';');
  }
}
