async function columnExists(pool, table, column) {
  const [rows] = await pool.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  )
  return rows.length > 0
}

export async function up({ context: pool }) {
  if (await columnExists(pool, 'promotions', 'unfilled_slots_settled_at')) {
    console.log('  ~ promotions.unfilled_slots_settled_at already present')
  } else {
    await pool.execute(
      'ALTER TABLE promotions ADD COLUMN unfilled_slots_settled_at TIMESTAMP NULL DEFAULT NULL AFTER settled_at'
    )
    console.log('  + Added promotions.unfilled_slots_settled_at')
  }
}

export async function down({ context: pool }) {
  if (await columnExists(pool, 'promotions', 'unfilled_slots_settled_at')) {
    await pool.execute('ALTER TABLE promotions DROP COLUMN unfilled_slots_settled_at')
    console.log('  - Dropped promotions.unfilled_slots_settled_at')
  }
}

export default { up, down }
