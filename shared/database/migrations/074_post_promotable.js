export async function up({ context: pool }) {
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets'"
  )
  const has = (name) => cols.some(c => c.COLUMN_NAME === name)
  const add = async (name, ddl) => {
    if (!has(name)) {
      await pool.execute(`ALTER TABLE post_targets ADD COLUMN ${ddl}`)
      console.log(`  + post_targets.${name}`)
    } else {
      console.log(`  ~ post_targets.${name} present`)
    }
  }
  await add('promotable_id', "promotable_id VARCHAR(255) NULL AFTER meta_object_id")
  await add('is_eligible_for_promotion', "is_eligible_for_promotion TINYINT(1) NULL AFTER promotable_id")
  await add('allowed_objectives', "allowed_objectives JSON NULL AFTER is_eligible_for_promotion")
  await add('eligibility_checked_at', "eligibility_checked_at TIMESTAMP NULL AFTER allowed_objectives")
  await add('eligibility_reason', "eligibility_reason TEXT NULL AFTER eligibility_checked_at")

  const [idx] = await pool.query(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets' AND INDEX_NAME = 'idx_pt_promotable'"
  )
  if (idx.length === 0) {
    try {
      await pool.execute('ALTER TABLE post_targets ADD KEY idx_pt_promotable (promotable_id)')
      console.log('  + idx_pt_promotable')
    } catch (e) { console.log('  ~ idx_pt_promotable not added', e.message) }
  }
}

export async function down({ context: pool }) {
  const drop = async (name) => {
    const [cols] = await pool.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets' AND COLUMN_NAME = ?",
      [name]
    )
    if (cols.length > 0) {
      await pool.execute(`ALTER TABLE post_targets DROP COLUMN ${name}`)
      console.log(`  - post_targets.${name}`)
    }
  }
  const [idx] = await pool.query(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets' AND INDEX_NAME = 'idx_pt_promotable'"
  )
  if (idx.length > 0) {
    await pool.execute('ALTER TABLE post_targets DROP INDEX idx_pt_promotable')
    console.log('  - idx_pt_promotable')
  }
  await drop('eligibility_reason')
  await drop('eligibility_checked_at')
  await drop('allowed_objectives')
  await drop('is_eligible_for_promotion')
  await drop('promotable_id')
}

export default { up, down }
