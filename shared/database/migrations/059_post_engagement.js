export async function up({ context: pool }) {
  const [tables] = await pool.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_engagement_daily'"
  )
  if (tables.length === 0) {
    await pool.execute(`
      CREATE TABLE post_engagement_daily (
        id BINARY(16) NOT NULL,
        post_id BINARY(16) NOT NULL,
        target_id BINARY(16) NOT NULL,
        stat_date DATE NOT NULL,
        media_type VARCHAR(32) NULL DEFAULT NULL,
        permalink TEXT NULL DEFAULT NULL,
        likes BIGINT NOT NULL DEFAULT 0,
        comments BIGINT NOT NULL DEFAULT 0,
        saved BIGINT NOT NULL DEFAULT 0,
        shares BIGINT NOT NULL DEFAULT 0,
        views BIGINT NOT NULL DEFAULT 0,
        reach BIGINT NOT NULL DEFAULT 0,
        interactions BIGINT NOT NULL DEFAULT 0,
        raw JSON NOT NULL DEFAULT (JSON_OBJECT()),
        comments_json JSON NOT NULL DEFAULT (JSON_OBJECT()),
        error TEXT NULL DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_post_engagement (post_id, target_id, stat_date),
        KEY idx_pe_post (post_id, stat_date),
        CONSTRAINT fk_pe_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
        CONSTRAINT fk_pe_target FOREIGN KEY (target_id) REFERENCES post_targets (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
  }

  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets' AND COLUMN_NAME = 'last_engagement_sync_at'"
  )
  if (cols.length === 0) {
    await pool.execute('ALTER TABLE post_targets ADD COLUMN last_engagement_sync_at TIMESTAMP NULL DEFAULT NULL')
  }
}

export async function down({ context: pool }) {
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets' AND COLUMN_NAME = 'last_engagement_sync_at'"
  )
  if (cols.length > 0) {
    await pool.execute('ALTER TABLE post_targets DROP COLUMN last_engagement_sync_at')
  }
  await pool.execute('DROP TABLE IF EXISTS post_engagement_daily')
}

export default { up, down }
