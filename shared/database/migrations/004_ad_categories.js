import { v7 as generateUuid } from 'uuid';

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

const UP = `
CREATE TABLE IF NOT EXISTS ad_categories (
  id BINARY(16) NOT NULL,
  name VARCHAR(100) NOT NULL,
  code VARCHAR(50) NOT NULL,
  description TEXT DEFAULT NULL,
  icon VARCHAR(50) DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ad_categories_code (code),
  UNIQUE KEY uk_ad_categories_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_categories (
  id BINARY(16) NOT NULL,
  user_id BINARY(16) NOT NULL,
  category_id BINARY(16) NOT NULL,
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_category (user_id, category_id),
  KEY fk_uc_category (category_id),
  CONSTRAINT fk_uc_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_uc_category FOREIGN KEY (category_id) REFERENCES ad_categories (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const SEED_CATEGORIES = [
  { code: 'technology', name: 'Technology', icon: '💻' },
  { code: 'fashion', name: 'Fashion & Beauty', icon: '👗' },
  { code: 'travel', name: 'Travel & Tourism', icon: '✈️' },
  { code: 'food', name: 'Food & Beverage', icon: '🍔' },
  { code: 'fitness', name: 'Health & Fitness', icon: '💪' },
  { code: 'finance', name: 'Finance & Banking', icon: '💰' },
  { code: 'entertainment', name: 'Entertainment', icon: '🎬' },
  { code: 'sports', name: 'Sports', icon: '⚽' },
  { code: 'education', name: 'Education', icon: '📚' },
  { code: 'music', name: 'Music', icon: '🎵' },
  { code: 'gaming', name: 'Gaming', icon: '🎮' },
  { code: 'realestate', name: 'Real Estate', icon: '🏠' },
  { code: 'automotive', name: 'Automotive', icon: '🚗' },
  { code: 'lifestyle', name: 'Lifestyle', icon: '✨' },
  { code: 'news', name: 'News & Media', icon: '📰' },
];

const DOWN = `
DROP TABLE IF EXISTS user_categories;
DROP TABLE IF EXISTS ad_categories;
`;

export async function up({ context: pool }) {
  const statements = UP.split(';').filter(s => s.trim().length > 0);
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';');
  }

  for (const cat of SEED_CATEGORIES) {
    await pool.execute(
      'INSERT IGNORE INTO ad_categories (id, code, name, description, icon) VALUES (?, ?, ?, ?, ?)',
      [uuidToBuffer(generateUuid()), cat.code, cat.name, cat.name, cat.icon]
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
