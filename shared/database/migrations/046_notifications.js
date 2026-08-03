export async function up({ context: pool }) {
  const [existingTable] = await pool.execute(
    "SHOW TABLES LIKE 'notifications'"
  )
  if (existingTable.length > 0) {
    console.log('  ~ notifications table already exists')
    return
  }

  await pool.execute(
    `CREATE TABLE notifications (
      id BINARY(16) NOT NULL PRIMARY KEY,
      user_id BINARY(16) NOT NULL,
      type VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      body TEXT,
      data JSON,
      is_read TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_notif_user_read (user_id, is_read, created_at DESC),
      CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  )
  console.log('  + Created notifications table')
}

export async function down({ context: pool }) {
  const [existingTable] = await pool.execute(
    "SHOW TABLES LIKE 'notifications'"
  )
  if (existingTable.length > 0) {
    await pool.execute('DROP TABLE notifications')
    console.log('  - Dropped notifications table')
  }
}

export default { up, down }
