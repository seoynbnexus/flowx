async function columnExists(pool, table, column) {
  const [rows] = await pool.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  )
  return rows.length > 0
}

export async function up({ context: pool }) {
  if (await columnExists(pool, 'campaign_meta_settings', 'bid_amount')) {
    console.log('  ~ campaign_meta_settings.bid_amount already present')
  } else {
    await pool.execute(
      'ALTER TABLE campaign_meta_settings ADD COLUMN bid_amount DECIMAL(12,2) NULL DEFAULT NULL AFTER bid_strategy'
    )
    console.log('  + Added campaign_meta_settings.bid_amount')
  }

  if (await columnExists(pool, 'campaign_meta_settings', 'special_ad_categories')) {
    console.log('  ~ campaign_meta_settings.special_ad_categories already present')
  } else {
    await pool.execute(
      "ALTER TABLE campaign_meta_settings ADD COLUMN special_ad_categories JSON NOT NULL DEFAULT (JSON_ARRAY()) AFTER platform_placement"
    )
    console.log('  + Added campaign_meta_settings.special_ad_categories')
  }
}

export async function down({ context: pool }) {
  if (await columnExists(pool, 'campaign_meta_settings', 'special_ad_categories')) {
    await pool.execute('ALTER TABLE campaign_meta_settings DROP COLUMN special_ad_categories')
    console.log('  - Dropped campaign_meta_settings.special_ad_categories')
  }
  if (await columnExists(pool, 'campaign_meta_settings', 'bid_amount')) {
    await pool.execute('ALTER TABLE campaign_meta_settings DROP COLUMN bid_amount')
    console.log('  - Dropped campaign_meta_settings.bid_amount')
  }
}

export default { up, down }
