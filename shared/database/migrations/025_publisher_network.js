const UP = `
CREATE TABLE IF NOT EXISTS publisher_ad_categories (
  id BINARY(16) NOT NULL,
  publisher_id BINARY(16) NOT NULL,
  category_id BINARY(16) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_publisher_category (publisher_id, category_id),
  KEY idx_publisher_categories_category (category_id),
  CONSTRAINT fk_pac_publisher FOREIGN KEY (publisher_id) REFERENCES users (id),
  CONSTRAINT fk_pac_category FOREIGN KEY (category_id) REFERENCES ad_categories (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campaign_publisher_requests (
  id BINARY(16) NOT NULL,
  campaign_id BINARY(16) NOT NULL,
  publisher_id BINARY(16) NOT NULL,
  coins_offered DECIMAL(15,2) NOT NULL,
  status ENUM('pending','accepted','rejected','cancelled','completed') NOT NULL DEFAULT 'pending',
  responded_at TIMESTAMP NULL DEFAULT NULL,
  published_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cpr_campaign (campaign_id, status),
  KEY idx_cpr_publisher (publisher_id, status),
  CONSTRAINT fk_cpr_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns (id) ON DELETE CASCADE,
  CONSTRAINT fk_cpr_publisher FOREIGN KEY (publisher_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const DOWN = `
DROP TABLE IF EXISTS campaign_publisher_requests;
DROP TABLE IF EXISTS publisher_ad_categories;
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
