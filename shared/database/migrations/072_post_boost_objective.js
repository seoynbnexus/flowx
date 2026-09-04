export async function up({ context: pool }) {
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts' AND COLUMN_NAME = 'boost_objective'"
  )
  if (cols.length === 0) {
    await pool.execute("ALTER TABLE posts ADD COLUMN boost_objective VARCHAR(50) NULL AFTER boost_optimization_goal")
    console.log('  + posts.boost_objective')
  } else {
    console.log('  ~ posts.boost_objective present')
  }
}

export async function down({ context: pool }) {
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts' AND COLUMN_NAME = 'boost_objective'"
  )
  if (cols.length > 0) {
    await pool.execute('ALTER TABLE posts DROP COLUMN boost_objective')
    console.log('  - posts.boost_objective')
  }
}

export default { up, down }
