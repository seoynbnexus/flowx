export async function up({ context: pool }) {
  const [cols] = await pool.execute(
    "SHOW COLUMNS FROM campaigns LIKE 'meta_status'"
  )
  if (cols.length === 0) {
    await pool.execute(
      "ALTER TABLE campaigns ADD COLUMN meta_status ENUM('pending','created','failed') DEFAULT 'pending' AFTER coins_escrowed_at"
    )
    await pool.execute(
      'ALTER TABLE campaigns ADD COLUMN meta_error TEXT NULL AFTER meta_status'
    )
    console.log('  + Added meta_status and meta_error to campaigns')
  } else {
    console.log('  ~ meta_status already exists')
  }
}

export async function down({ context: pool }) {
  const [cols] = await pool.execute(
    "SHOW COLUMNS FROM campaigns LIKE 'meta_status'"
  )
  if (cols.length > 0) {
    await pool.execute('ALTER TABLE campaigns DROP COLUMN meta_error')
    await pool.execute('ALTER TABLE campaigns DROP COLUMN meta_status')
    console.log('  - Removed meta_status and meta_error from campaigns')
  }
}

export default { up, down }
