const COLUMNS = [
  { name: 'resolved_targeting', ddl: 'resolved_targeting JSON NULL AFTER description' },
  { name: 'resolved_placement', ddl: 'resolved_placement JSON NULL AFTER resolved_targeting' },
  { name: 'resolved_graph_version', ddl: "resolved_graph_version VARCHAR(8) NULL AFTER resolved_placement" },
  { name: 'resolved_at', ddl: 'resolved_at TIMESTAMP NULL AFTER resolved_graph_version' },
]

export async function up({ context: pool }) {
  for (const col of COLUMNS) {
    const [existing] = await pool.query(
      'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      ['promotions', col.name]
    )
    if (existing.length === 0) {
      await pool.execute(`ALTER TABLE promotions ADD COLUMN ${col.ddl}`)
      console.log(`  + Added promotions.${col.name} (resolved boost snapshot; backfilled by promotions:backfill-resolved job, not here)`)
    } else {
      console.log(`  ~ promotions.${col.name} already present`)
    }
  }
  const [idx] = await pool.query(
    'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
    ['promotions', 'idx_promotions_resolved_at']
  )
  if (idx.length === 0) {
    await pool.execute('ALTER TABLE promotions ADD KEY idx_promotions_resolved_at (resolved_at)')
    console.log('  + Added idx_promotions_resolved_at (backfill cursor + unresolved health count)')
  } else {
    console.log('  ~ idx_promotions_resolved_at already present')
  }
}

export async function down({ context: pool }) {
  const [idx] = await pool.query(
    'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
    ['promotions', 'idx_promotions_resolved_at']
  )
  if (idx.length > 0) {
    await pool.execute('ALTER TABLE promotions DROP INDEX idx_promotions_resolved_at')
    console.log('  - Dropped idx_promotions_resolved_at')
  }
  for (const col of COLUMNS) {
    const [existing] = await pool.query(
      'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      ['promotions', col.name]
    )
    if (existing.length > 0) {
      await pool.execute(`ALTER TABLE promotions DROP COLUMN ${col.name}`)
      console.log(`  - Dropped promotions.${col.name}`)
    }
  }
}

export default { up, down }
