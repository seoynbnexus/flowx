async function columnExists(pool, table, column) {
  const [rows] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    [table, column]
  )
  return rows.length > 0
}

export async function up({ context: pool }) {
  if (!(await columnExists(pool, 'promotion_targets', 'refunded_paise'))) {
    await pool.execute('ALTER TABLE promotion_targets ADD COLUMN refunded_paise BIGINT NOT NULL DEFAULT 0')
    console.log('  + promotion_targets.refunded_paise')
  } else {
    console.log('  ~ promotion_targets.refunded_paise present')
  }
  if (!(await columnExists(pool, 'promotion_targets', 'consumed_paise'))) {
    await pool.execute('ALTER TABLE promotion_targets ADD COLUMN consumed_paise BIGINT NOT NULL DEFAULT 0')
    console.log('  + promotion_targets.consumed_paise')
  } else {
    console.log('  ~ promotion_targets.consumed_paise present')
  }
  if (!(await columnExists(pool, 'promotions', 'settled_at'))) {
    await pool.execute('ALTER TABLE promotions ADD COLUMN settled_at TIMESTAMP NULL')
    console.log('  + promotions.settled_at')
  } else {
    console.log('  ~ promotions.settled_at present')
  }
}

export async function down({ context: pool }) {
  if (await columnExists(pool, 'promotion_targets', 'refunded_paise')) {
    await pool.execute('ALTER TABLE promotion_targets DROP COLUMN refunded_paise')
    console.log('  - promotion_targets.refunded_paise')
  }
  if (await columnExists(pool, 'promotion_targets', 'consumed_paise')) {
    await pool.execute('ALTER TABLE promotion_targets DROP COLUMN consumed_paise')
    console.log('  - promotion_targets.consumed_paise')
  }
  if (await columnExists(pool, 'promotions', 'settled_at')) {
    await pool.execute('ALTER TABLE promotions DROP COLUMN settled_at')
    console.log('  - promotions.settled_at')
  }
}

export default { up, down }
