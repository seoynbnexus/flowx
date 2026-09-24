async function columnExists(pool, table, column) {
  const [rows] = await pool.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  )
  return rows.length > 0
}

async function addColumn(pool, table, column, ddl) {
  if (await columnExists(pool, table, column)) {
    console.log(`  ~ ${table}.${column} already present`)
  } else {
    await pool.execute(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
    console.log(`  + Added ${table}.${column}`)
  }
}

async function dropColumn(pool, table, column) {
  if (await columnExists(pool, table, column)) {
    await pool.execute(`ALTER TABLE ${table} DROP COLUMN ${column}`)
    console.log(`  - Dropped ${table}.${column}`)
  }
}

export async function up({ context: pool }) {
  await addColumn(pool, 'posts', 'boost_bid_amount', 'boost_bid_amount DECIMAL(12,2) NULL DEFAULT NULL AFTER boost_bid_strategy')
  await addColumn(pool, 'posts', 'boost_special_ad_categories', "boost_special_ad_categories JSON NOT NULL DEFAULT (JSON_ARRAY()) AFTER boost_placement")
  await addColumn(pool, 'promotions', 'bid_amount', 'bid_amount DECIMAL(12,2) NULL DEFAULT NULL AFTER bid_strategy')
  await addColumn(pool, 'promotions', 'special_ad_categories', "special_ad_categories JSON NOT NULL DEFAULT (JSON_ARRAY()) AFTER placement")
}

export async function down({ context: pool }) {
  await dropColumn(pool, 'promotions', 'special_ad_categories')
  await dropColumn(pool, 'promotions', 'bid_amount')
  await dropColumn(pool, 'posts', 'boost_special_ad_categories')
  await dropColumn(pool, 'posts', 'boost_bid_amount')
}

export default { up, down }
