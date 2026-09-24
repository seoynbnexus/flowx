const FULL_STATUS_SET = ['pending', 'validating', 'creating', 'active', 'paused', 'failed', 'cancelled', 'needs_repair']

async function columnExists(pool, table, column) {
  const [rows] = await pool.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  )
  return rows.length > 0
}

export async function up({ context: pool }) {
  const [rows] = await pool.query(
    "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'promotion_targets' AND COLUMN_NAME = 'status'"
  )
  const match = rows.length ? String(rows[0].COLUMN_TYPE).match(/^enum\((.*)\)$/i) : null
  const values = match ? match[1].split(',').map((v) => v.trim().replace(/^'(.*)'$/, '$1')) : []
  const missing = FULL_STATUS_SET.filter((v) => !values.includes(v))
  if (!missing.length) {
    console.log('  ~ promotion_targets.status already complete')
  } else {
    const list = FULL_STATUS_SET.map((v) => `'${v}'`).join(',')
    await pool.execute(
      `ALTER TABLE promotion_targets MODIFY COLUMN status ENUM(${list}) NOT NULL DEFAULT 'pending'`
    )
    console.log(`  + Extended promotion_targets.status with: ${missing.join(', ')}`)
  }

  if (await columnExists(pool, 'promotion_targets', 'status_synced_at')) {
    console.log('  ~ promotion_targets.status_synced_at already present')
  } else {
    await pool.execute('ALTER TABLE promotion_targets ADD COLUMN status_synced_at TIMESTAMP NULL DEFAULT NULL AFTER status')
    console.log('  + Added promotion_targets.status_synced_at')
  }
}

export async function down({ context: pool }) {
  if (await columnExists(pool, 'promotion_targets', 'status_synced_at')) {
    await pool.execute('ALTER TABLE promotion_targets DROP COLUMN status_synced_at')
    console.log('  - Dropped promotion_targets.status_synced_at')
  }

  const [stuck] = await pool.query("SELECT COUNT(*) AS n FROM promotion_targets WHERE status = 'needs_repair'")
  if (Number(stuck[0]?.n) > 0) {
    console.log('  ~ promotion_targets has rows at needs_repair — leaving enum widened (best-effort down)')
    return
  }
  const narrowed = ['pending', 'validating', 'creating', 'active', 'paused', 'failed', 'cancelled']
  const list = narrowed.map((v) => `'${v}'`).join(',')
  await pool.execute(`ALTER TABLE promotion_targets MODIFY COLUMN status ENUM(${list}) NOT NULL DEFAULT 'pending'`)
  console.log('  - Narrowed promotion_targets.status (removed needs_repair)')
}

export default { up, down }
