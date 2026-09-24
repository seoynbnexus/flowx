async function columnExists(pool, table, name) {
  const [rows] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    [table, name]
  )
  return rows.length > 0
}

const SNAPSHOT_COLUMNS = [
  "ADD COLUMN resolved_config JSON NULL",
  "ADD COLUMN resolved_config_hash CHAR(8) NULL",
  "ADD COLUMN resolved_graph_version VARCHAR(8) NULL",
  "ADD COLUMN resolved_at TIMESTAMP NULL",
]

export async function up({ context: pool }) {
  for (const clause of SNAPSHOT_COLUMNS) {
    const name = clause.split(' ')[2].toLowerCase()
    if (!(await columnExists(pool, 'campaigns', name))) {
      await pool.execute(`ALTER TABLE campaigns ${clause}`)
      console.log(`  + campaigns.${name}`)
    } else {
      console.log(`  ~ campaigns.${name} present`)
    }
  }
}

export async function down({ context: pool }) {
  for (const clause of [...SNAPSHOT_COLUMNS].reverse()) {
    const name = clause.split(' ')[2].toLowerCase()
    if (await columnExists(pool, 'campaigns', name)) {
      await pool.execute(`ALTER TABLE campaigns DROP COLUMN ${name}`)
      console.log(`  - campaigns.${name}`)
    }
  }
}

export default { up, down }
