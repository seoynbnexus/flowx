export async function up({ context: pool }) {
  const [tables] = await pool.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'media_assets'"
  )
  if (tables.length === 0) {
    await pool.execute(`
      CREATE TABLE media_assets (
        id BINARY(16) NOT NULL,
        user_id BINARY(16) NOT NULL,
        name VARCHAR(255) NOT NULL,
        storage_path VARCHAR(500) NOT NULL,
        mime_type VARCHAR(127) NULL DEFAULT NULL,
        media_kind ENUM('image','video') NOT NULL DEFAULT 'image',
        size_bytes BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_media_assets_user (user_id, created_at),
        CONSTRAINT fk_media_assets_user FOREIGN KEY (user_id) REFERENCES users (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    console.log('  + Created media_assets table')
  } else {
    console.log('  ~ media_assets table already present')
  }
}

export async function down({ context: pool }) {
  const [tables] = await pool.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'media_assets'"
  )
  if (tables.length > 0) {
    await pool.execute('DROP TABLE IF EXISTS media_assets')
    console.log('  - Dropped media_assets table')
  }
}

export default { up, down }