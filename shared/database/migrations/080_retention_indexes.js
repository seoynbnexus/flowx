const INDEXES = [
  {
    table: 'meta_account_snapshots',
    name: 'idx_meta_snapshot_created_at',
    column: 'created_at',
    reason: 'retention purge predicate (created_at < TTL) + fixes findLatestAccountSnapshot ORDER BY created_at DESC LIMIT 1 filesort',
  },
  {
    table: 'user_sessions',
    name: 'idx_user_sessions_expires_at',
    column: 'expires_at',
    reason: 'retention purge predicate (expires_at < NOW())',
  },
  {
    table: 'audit_logs',
    name: 'idx_audit_logs_created_at',
    column: 'created_at',
    reason: 'retention purge predicate (created_at < 365d) + analytics time-window scans',
  },
  {
    table: 'auth_login_history',
    name: 'idx_auth_login_history_created_at',
    column: 'created_at',
    reason: 'retention purge predicate (created_at < 365d) + DAU/WAU/MAU range scans',
  },
]

export async function up({ context: pool }) {
  for (const idx of INDEXES) {
    const [existing] = await pool.query(
      'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
      [idx.table, idx.name]
    )
    if (existing.length === 0) {
      await pool.execute(`ALTER TABLE ${idx.table} ADD KEY ${idx.name} (${idx.column})`)
      console.log(`  + Added ${idx.name} to ${idx.table} (${idx.reason})`)
    } else {
      console.log(`  ~ ${idx.table} ${idx.name} already present`)
    }
  }
}

export async function down({ context: pool }) {
  for (const idx of INDEXES) {
    const [existing] = await pool.query(
      'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
      [idx.table, idx.name]
    )
    if (existing.length > 0) {
      await pool.execute(`ALTER TABLE ${idx.table} DROP INDEX ${idx.name}`)
      console.log(`  - Dropped ${idx.name} from ${idx.table}`)
    }
  }
}

export default { up, down }
