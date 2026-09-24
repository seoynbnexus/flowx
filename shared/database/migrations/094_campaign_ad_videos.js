async function tableExists(pool, name) {
  const [rows] = await pool.query(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [name]
  )
  return rows.length > 0
}

export async function up({ context: pool }) {
  if (await tableExists(pool, 'campaign_ad_videos')) {
    console.log('  ~ campaign_ad_videos table already present')
    return
  }
  await pool.execute(`
    CREATE TABLE campaign_ad_videos (
      id BINARY(16) NOT NULL,
      campaign_id BINARY(16) NOT NULL,
      created_for_user_id BINARY(16) NOT NULL,
      media_url VARCHAR(2048) NOT NULL,
      video_id VARCHAR(64) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_campaign_ad_videos_owner (campaign_id, created_for_user_id),
      CONSTRAINT fk_campaign_ad_videos_campaign FOREIGN KEY (campaign_id)
        REFERENCES campaigns (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  console.log('  + Created campaign_ad_videos table')
}

export async function down({ context: pool }) {
  if (!(await tableExists(pool, 'campaign_ad_videos'))) {
    console.log('  ~ campaign_ad_videos table already absent')
    return
  }
  await pool.execute('DROP TABLE IF EXISTS campaign_ad_videos')
  console.log('  - Dropped campaign_ad_videos table')
}

export default { up, down }
