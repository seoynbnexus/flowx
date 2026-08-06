export async function up({ context: pool }) {
  const [tables] = await pool.execute(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scheduler_leases'"
  )
  if (tables.length === 0) {
    await pool.execute(`
      CREATE TABLE scheduler_leases (
        lease_name VARCHAR(64) NOT NULL,
        owner_id VARCHAR(128) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (lease_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    console.log('  + Created scheduler_leases')
  } else {
    console.log('  ~ scheduler_leases already present')
  }
}

export async function down({ context: pool }) {
  await pool.execute('DROP TABLE IF EXISTS scheduler_leases')
}
