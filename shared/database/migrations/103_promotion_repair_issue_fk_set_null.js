// 100_promotion_target_repairs.js originally created fk_ptgt_repair_issue with
// the default RESTRICT delete rule. Deleting a promotion (which CASCADEs to
// promotion_targets, which CASCADEs to BOTH promotion_target_issues and
// promotion_target_repairs) can hit InnoDB's cross-sibling-cascade ordering:
// it may attempt to delete a promotion_target_issues row while a
// promotion_target_repairs row still references it via the plain RESTRICT
// FK, failing the whole statement. Widening this one FK to ON DELETE SET
// NULL removes that ordering hazard — the repair row's own CASCADE (from its
// own promotion_target_id) still cleans it up, this only relaxes the
// secondary cross-reference to the issue it was created against.
async function getDeleteRule(pool) {
  const [rows] = await pool.query(
    `SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'promotion_target_repairs' AND CONSTRAINT_NAME = 'fk_ptgt_repair_issue'`
  )
  return rows.length ? rows[0].DELETE_RULE : null
}

export async function up({ context: pool }) {
  const rule = await getDeleteRule(pool)
  if (rule === null) {
    console.log('  ~ fk_ptgt_repair_issue not present (promotion_target_repairs table absent) — skipping')
    return
  }
  if (rule === 'SET NULL') {
    console.log('  ~ fk_ptgt_repair_issue already ON DELETE SET NULL')
    return
  }
  await pool.execute('ALTER TABLE promotion_target_repairs DROP FOREIGN KEY fk_ptgt_repair_issue')
  await pool.execute(`
    ALTER TABLE promotion_target_repairs
      ADD CONSTRAINT fk_ptgt_repair_issue FOREIGN KEY (promotion_target_issue_id)
        REFERENCES promotion_target_issues (id) ON DELETE SET NULL
  `)
  console.log('  + Widened fk_ptgt_repair_issue to ON DELETE SET NULL')
}

export async function down({ context: pool }) {
  const rule = await getDeleteRule(pool)
  if (rule !== 'SET NULL') {
    console.log('  ~ fk_ptgt_repair_issue not ON DELETE SET NULL — skipping')
    return
  }
  await pool.execute('ALTER TABLE promotion_target_repairs DROP FOREIGN KEY fk_ptgt_repair_issue')
  await pool.execute(`
    ALTER TABLE promotion_target_repairs
      ADD CONSTRAINT fk_ptgt_repair_issue FOREIGN KEY (promotion_target_issue_id)
        REFERENCES promotion_target_issues (id)
  `)
  console.log('  - Reverted fk_ptgt_repair_issue to default RESTRICT')
}

export default { up, down }
