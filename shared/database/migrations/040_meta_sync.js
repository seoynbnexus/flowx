export async function up({ context: pool }) {
  const [statusCols] = await pool.execute(
    "SHOW COLUMNS FROM campaigns WHERE Field = 'status'"
  )
  if (statusCols.length > 0) {
    const currentType = statusCols[0].Type
    if (!currentType.includes('paused')) {
      await pool.execute(
        "ALTER TABLE campaigns MODIFY COLUMN status ENUM('draft','pending_review','approved','rejected','changes_requested','scheduled','running','paused','completed','cancelled','failed') NOT NULL DEFAULT 'draft'"
      )
      console.log('  + Added paused to campaigns.status ENUM')
    } else {
      console.log('  ~ paused already in campaigns.status ENUM')
    }
  }

  const [spendCols] = await pool.execute(
    "SHOW COLUMNS FROM campaigns LIKE 'meta_spent_paise'"
  )
  if (spendCols.length === 0) {
    await pool.execute(
      'ALTER TABLE campaigns ADD COLUMN meta_spent_paise BIGINT NOT NULL DEFAULT 0 AFTER meta_error'
    )
    await pool.execute(
      'ALTER TABLE campaigns ADD COLUMN last_meta_sync_at TIMESTAMP NULL AFTER meta_spent_paise'
    )
    console.log('  + Added meta_spent_paise and last_meta_sync_at to campaigns')
  } else {
    console.log('  ~ meta_spent_paise already exists')
  }
}

export async function down({ context: pool }) {
  const [spendCols] = await pool.execute(
    "SHOW COLUMNS FROM campaigns LIKE 'meta_spent_paise'"
  )
  if (spendCols.length > 0) {
    await pool.execute('ALTER TABLE campaigns DROP COLUMN last_meta_sync_at')
    await pool.execute('ALTER TABLE campaigns DROP COLUMN meta_spent_paise')
    console.log('  - Removed meta_spent_paise and last_meta_sync_at from campaigns')
  }

  const [statusCols] = await pool.execute(
    "SHOW COLUMNS FROM campaigns WHERE Field = 'status'"
  )
  if (statusCols.length > 0 && statusCols[0].Type.includes('paused')) {
    await pool.execute(
      "ALTER TABLE campaigns MODIFY COLUMN status ENUM('draft','pending_review','approved','rejected','changes_requested','scheduled','running','completed','cancelled','failed') NOT NULL DEFAULT 'draft'"
    )
    console.log('  - Removed paused from campaigns.status ENUM')
  }
}

export default { up, down }
