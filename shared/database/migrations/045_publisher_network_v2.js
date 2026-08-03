export async function up({ context: pool }) {
  // 1. Add run_on_publishers column
  const [rpCols] = await pool.execute(
    "SHOW COLUMNS FROM campaigns WHERE Field = 'run_on_publishers'"
  )
  if (rpCols.length === 0) {
    await pool.execute(
      "ALTER TABLE campaigns ADD COLUMN run_on_publishers TINYINT(1) NOT NULL DEFAULT 0 AFTER coins_per_publisher"
    )
    console.log('  + Added run_on_publishers to campaigns')
  }

  // 2. Add publisher_response_deadline_at column
  const [dlCols] = await pool.execute(
    "SHOW COLUMNS FROM campaigns WHERE Field = 'publisher_response_deadline_at'"
  )
  if (dlCols.length === 0) {
    await pool.execute(
      'ALTER TABLE campaigns ADD COLUMN publisher_response_deadline_at TIMESTAMP NULL AFTER coins_escrowed_at'
    )
    console.log('  + Added publisher_response_deadline_at to campaigns')
  }

  // 3. Add awaiting_publishers to status ENUM
  const [statusCols] = await pool.execute(
    "SHOW COLUMNS FROM campaigns WHERE Field = 'status'"
  )
  if (statusCols.length > 0 && !statusCols[0].Type.includes('awaiting_publishers')) {
    await pool.execute(
      "ALTER TABLE campaigns MODIFY COLUMN status ENUM('draft','pending_review','approved','rejected','changes_requested','scheduled','running','paused','completed','cancelled','failed','awaiting_publishers') NOT NULL DEFAULT 'draft'"
    )
    console.log('  + Added awaiting_publishers to campaigns.status ENUM')
  }

  // 4. Seed app_config: publisher_request_multiplier
  const { v4: uuidv4 } = await import('uuid')
  const [multRow] = await pool.execute(
    "SELECT id FROM app_config WHERE config_key = 'publisher_request_multiplier'"
  )
  if (multRow.length === 0) {
    const id = uuidv4().replace(/-/g, '')
    await pool.execute(
      'INSERT INTO app_config (id, config_key, config_value, is_public, description, version) VALUES (?, ?, ?, ?, ?, ?)',
      [Buffer.from(id, 'hex'), 'publisher_request_multiplier', '2', 0, 'Over-provisioning multiplier for publisher requests (e.g., 2 = invite 2x the requested count)', 1]
    )
    console.log('  + Seeded publisher_request_multiplier = 2')
  }

  // 5. Seed app_config: publisher_response_deadline_days
  const [ddRow] = await pool.execute(
    "SELECT id FROM app_config WHERE config_key = 'publisher_response_deadline_days'"
  )
  if (ddRow.length === 0) {
    const id = uuidv4().replace(/-/g, '')
    await pool.execute(
      'INSERT INTO app_config (id, config_key, config_value, is_public, description, version) VALUES (?, ?, ?, ?, ?, ?)',
      [Buffer.from(id, 'hex'), 'publisher_response_deadline_days', '7', 0, 'Number of days publishers have to respond to campaign requests before the campaign expires', 1]
    )
    console.log('  + Seeded publisher_response_deadline_days = 7')
  }

  // 6. Seed permission: campaigns.force-manage for admin force go-live / cancel
  const [permRow] = await pool.execute(
    "SELECT id FROM permissions WHERE code = 'campaigns.force-manage'"
  )
  if (permRow.length === 0) {
    const id = uuidv4().replace(/-/g, '')
    await pool.execute(
      'INSERT INTO permissions (id, code, name, description, module) VALUES (?, ?, ?, ?, ?)',
      [Buffer.from(id, 'hex'), 'campaigns.force-manage', 'Force Manage Campaigns', 'Force campaigns to go live or cancel while awaiting publishers', 'campaigns']
    )
    console.log('  + Seeded permission: campaigns.force-manage')
  }
}

export async function down({ context: pool }) {
  // 1. Remove awaiting_publishers from status ENUM
  const [statusCols] = await pool.execute(
    "SHOW COLUMNS FROM campaigns WHERE Field = 'status'"
  )
  if (statusCols.length > 0 && statusCols[0].Type.includes('awaiting_publishers')) {
    await pool.execute(
      "ALTER TABLE campaigns MODIFY COLUMN status ENUM('draft','pending_review','approved','rejected','changes_requested','scheduled','running','paused','completed','cancelled','failed') NOT NULL DEFAULT 'draft'"
    )
    console.log('  - Removed awaiting_publishers from campaigns.status ENUM')
  }

  // 2. Drop publisher_response_deadline_at
  const [dlCols] = await pool.execute(
    "SHOW COLUMNS FROM campaigns WHERE Field = 'publisher_response_deadline_at'"
  )
  if (dlCols.length > 0) {
    await pool.execute('ALTER TABLE campaigns DROP COLUMN publisher_response_deadline_at')
    console.log('  - Dropped publisher_response_deadline_at from campaigns')
  }

  // 3. Drop run_on_publishers
  const [rpCols] = await pool.execute(
    "SHOW COLUMNS FROM campaigns WHERE Field = 'run_on_publishers'"
  )
  if (rpCols.length > 0) {
    await pool.execute('ALTER TABLE campaigns DROP COLUMN run_on_publishers')
    console.log('  - Dropped run_on_publishers from campaigns')
  }

  // 4. Remove app_config seed
  await pool.execute("DELETE FROM app_config WHERE config_key IN ('publisher_request_multiplier', 'publisher_response_deadline_days')")
  console.log('  - Removed publisher_request_multiplier and publisher_response_deadline_days from app_config')

  // 5. Remove permission
  await pool.execute("DELETE FROM permissions WHERE code = 'campaigns.force-manage'")
  console.log('  - Removed permission: campaigns.force-manage')
}

export default { up, down }
