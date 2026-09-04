import { v7 as generateUuid } from 'uuid'

export async function up({ context: pool }) {
  const [ptCols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets'"
  )
  const hasCol = (name) => ptCols.some(c => c.COLUMN_NAME === name)
  if (hasCol('meta_object_id') && hasCol('remote_video_id') && hasCol('container_id')) {
    const [idxRows] = await pool.query(
      "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets'"
    )
    const hasIdx = (name) => idxRows.some(r => r.INDEX_NAME === name)
    if (!hasIdx('idx_pt_meta_object_id')) {
      await pool.execute('ALTER TABLE post_targets ADD KEY idx_pt_meta_object_id (meta_object_id)')
      console.log('  + Added idx_pt_meta_object_id')
    }
    if (!hasIdx('idx_pt_remote_video_id')) {
      await pool.execute('ALTER TABLE post_targets ADD KEY idx_pt_remote_video_id (remote_video_id)')
      console.log('  + Added idx_pt_remote_video_id')
    }
    if (!hasIdx('idx_pt_container_id')) {
      await pool.execute('ALTER TABLE post_targets ADD KEY idx_pt_container_id (container_id)')
      console.log('  + Added idx_pt_container_id')
    }
    if (!hasIdx('idx_pt_last_meta_event')) {
      await pool.execute('ALTER TABLE post_targets ADD KEY idx_pt_last_meta_event (last_meta_event_at)')
      console.log('  + Added idx_pt_last_meta_event')
    }
    if (!hasIdx('idx_pt_meta_deleted')) {
      await pool.execute('ALTER TABLE post_targets ADD KEY idx_pt_meta_deleted (meta_deleted_at)')
      console.log('  + Added idx_pt_meta_deleted')
    }
  }

  const [idxMeta] = await pool.query(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meta_webhook_events' AND INDEX_NAME = 'idx_mwe_received_at'"
  )
  if (idxMeta.length === 0) {
    try {
      await pool.execute('ALTER TABLE meta_webhook_events ADD KEY idx_mwe_received_at (received_at)')
      console.log('  + Added idx_mwe_received_at')
    } catch (e) { console.log('  ~ idx_mwe_received_at not added', e.message) }
  }

  const permId = generateUuid()
  const { randomUUID } = await import('node:crypto')
  const idBuf = Buffer.from(permId.replace(/-/g, ''), 'hex')
  try {
    const [existing] = await pool.execute('SELECT id FROM permissions WHERE code = ?', ['webhooks.manage'])
    if (existing.length === 0) {
      await pool.execute(
        'INSERT INTO permissions (id, code, name, module, is_system) VALUES (?, ?, ?, ?, 1)',
        [idBuf, 'webhooks.manage', 'Manage Webhooks', 'webhooks']
      )
      console.log('  + Permission webhooks.manage created')
    } else {
      console.log('  ~ Permission webhooks.manage already present')
    }
    const [roleRow] = await pool.execute("SELECT id FROM roles WHERE code = 'admin' LIMIT 1")
    if (roleRow.length) {
      const [permRow] = await pool.execute('SELECT id FROM permissions WHERE code = ? LIMIT 1', ['webhooks.manage'])
      if (permRow.length) {
        await pool.execute(
          'INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r, permissions p WHERE r.code = ? AND p.code = ?',
          ['admin', 'webhooks.manage']
        )
        console.log('  + Granted webhooks.manage to admin')
      }
    }
    const [superRow] = await pool.execute("SELECT id FROM roles WHERE code = 'super_admin' LIMIT 1")
    if (superRow.length) {
      await pool.execute(
        'INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r, permissions p WHERE r.code = ? AND p.code = ?',
        ['super_admin', 'webhooks.manage']
      )
      console.log('  + Granted webhooks.manage to super_admin (idempotent)')
    }
  } catch (e) {
    console.log('  ~ webhooks.manage permission not added', e.message)
  }
}

export async function down({ context: pool }) {
  const dropIdx = async (table, idx) => {
    const [rows] = await pool.query(
      'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
      [table, idx]
    )
    if (rows.length) {
      await pool.execute(`ALTER TABLE ${table} DROP INDEX ${idx}`)
      console.log(`  - Dropped ${idx}`)
    }
  }
  await dropIdx('post_targets', 'idx_pt_meta_object_id')
  await dropIdx('post_targets', 'idx_pt_remote_video_id')
  await dropIdx('post_targets', 'idx_pt_container_id')
  await dropIdx('post_targets', 'idx_pt_last_meta_event')
  await dropIdx('post_targets', 'idx_pt_meta_deleted')
  await dropIdx('meta_webhook_events', 'idx_mwe_received_at')
  try {
    const [permRow] = await pool.execute('SELECT id FROM permissions WHERE code = ? LIMIT 1', ['webhooks.manage'])
    if (permRow.length) {
      await pool.execute('DELETE FROM role_permissions WHERE permission_id = ?', [permRow[0].id])
      await pool.execute('DELETE FROM permissions WHERE code = ?', ['webhooks.manage'])
      console.log('  - Removed webhooks.manage permission')
    }
  } catch {}
}
