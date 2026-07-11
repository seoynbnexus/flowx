import { v7 as generateUuid } from 'uuid';

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

const UP = `
CREATE TABLE IF NOT EXISTS ai_generated_images (
  id BINARY(16) NOT NULL,
  user_id BINARY(16) NOT NULL,
  prompt VARCHAR(1000) NOT NULL,
  image_url VARCHAR(500) NOT NULL,
  style VARCHAR(50) DEFAULT NULL,
  size VARCHAR(20) DEFAULT '1024x1024',
  generation_cost INT NOT NULL DEFAULT 0,
  metadata JSON NOT NULL DEFAULT (JSON_OBJECT()),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ai_images_user (user_id, created_at),
  CONSTRAINT fk_ai_images_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const DOWN = `
DROP TABLE IF EXISTS ai_generated_images;
`;

const SEEDS = [
  {
    key: 'ai_image_base_cost',
    value: 500,
    isPublic: 0,
    description: 'Base coin cost per image generation (added to markup coins)',
  },
];

export async function up({ context: pool }) {
  const statements = UP.split(';').filter(s => s.trim().length > 0);
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';');
  }

  for (const seed of SEEDS) {
    await pool.execute(
      `INSERT IGNORE INTO app_config (id, config_key, config_value, is_public, description, version)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [uuidToBuffer(generateUuid()), seed.key, JSON.stringify(seed.value), seed.isPublic ?? 1, seed.description]
    );
  }
}

export async function down({ context: pool }) {
  const statements = DOWN.split(';').filter(s => s.trim().length > 0);
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';');
  }

  for (const seed of SEEDS) {
    await pool.execute('DELETE FROM app_config WHERE config_key = ?', [seed.key]);
  }
}
