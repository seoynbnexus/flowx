export async function up({ context: pool }) {
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'publisher_suspended'"
  )
  if (cols.length === 0) {
    await pool.execute('ALTER TABLE users ADD COLUMN publisher_suspended TINYINT(1) NOT NULL DEFAULT 0 AFTER status')
    console.log('  + Added publisher_suspended to users')
  } else {
    console.log('  ~ publisher_suspended already exists')
  }
}

export async function down({ context: pool }) {
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'publisher_suspended'"
  )
  if (cols.length > 0) {
    await pool.execute('ALTER TABLE users DROP COLUMN publisher_suspended')
    console.log('  - Dropped publisher_suspended from users')
  }
}

export default { up, down }
