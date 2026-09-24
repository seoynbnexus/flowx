async function columnExists(pool, table, column) {
  const [rows] = await pool.query(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  )
  return rows.length > 0
}

const COLUMNS = ['ADD COLUMN width INT NULL DEFAULT NULL', 'ADD COLUMN height INT NULL DEFAULT NULL']

export async function up({ context: pool }) {
  for (const clause of COLUMNS) {
    const name = clause.split(' ')[2]
    if (await columnExists(pool, 'media_assets', name)) {
      console.log(`  ~ media_assets.${name} already present`)
      continue
    }
    await pool.execute(`ALTER TABLE media_assets ${clause}`)
    console.log(`  + Added media_assets.${name}`)
  }
}

export async function down({ context: pool }) {
  for (const name of ['height', 'width']) {
    if (!(await columnExists(pool, 'media_assets', name))) {
      console.log(`  ~ media_assets.${name} already absent`)
      continue
    }
    await pool.execute(`ALTER TABLE media_assets DROP COLUMN ${name}`)
    console.log(`  - Dropped media_assets.${name}`)
  }
}

export default { up, down }
