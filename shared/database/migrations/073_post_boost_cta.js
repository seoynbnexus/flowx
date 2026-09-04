export async function up({ context: pool }) {
  const [cols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts'"
  )
  const has = (name) => cols.some(c => c.COLUMN_NAME === name)
  const add = async (name, ddl) => {
    if (!has(name)) {
      await pool.execute(`ALTER TABLE posts ADD COLUMN ${ddl}`)
      console.log(`  + posts.${name}`)
    } else {
      console.log(`  ~ posts.${name} present`)
    }
  }
  await add('boost_call_to_action', "boost_call_to_action VARCHAR(100) NULL AFTER boost_objective")
  await add('boost_link', "boost_link TEXT NULL AFTER boost_call_to_action")
  await add('boost_headline', "boost_headline VARCHAR(255) NULL AFTER boost_link")
  await add('boost_description', "boost_description VARCHAR(255) NULL AFTER boost_headline")
}

export async function down({ context: pool }) {
  const drop = async (name) => {
    const [cols] = await pool.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts' AND COLUMN_NAME = ?",
      [name]
    )
    if (cols.length > 0) {
      await pool.execute(`ALTER TABLE posts DROP COLUMN ${name}`)
      console.log(`  - posts.${name}`)
    }
  }
  await drop('boost_description')
  await drop('boost_headline')
  await drop('boost_link')
  await drop('boost_call_to_action')
}

export default { up, down }
