export async function up({ context: pool }) {
  const [eventsCols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meta_webhook_events'"
  )
  const has = (name) => eventsCols.some(c => c.COLUMN_NAME === name)

  if (!has('provider_event_key')) {
    await pool.execute("ALTER TABLE meta_webhook_events ADD COLUMN provider_event_key VARCHAR(255) NULL AFTER id")
    console.log('  + Added provider_event_key to meta_webhook_events')
  }
  if (!has('object_type')) {
    await pool.execute("ALTER TABLE meta_webhook_events ADD COLUMN object_type VARCHAR(32) NULL AFTER provider_event_key")
    console.log('  + Added object_type')
  }
  if (!has('source_id')) {
    await pool.execute("ALTER TABLE meta_webhook_events ADD COLUMN source_id VARCHAR(64) NULL AFTER object_type")
    console.log('  + Added source_id')
  }
  if (!has('platform')) {
    await pool.execute("ALTER TABLE meta_webhook_events ADD COLUMN platform VARCHAR(32) NULL AFTER source_id")
    console.log('  + Added platform')
  }
  if (!has('external_account_id')) {
    await pool.execute("ALTER TABLE meta_webhook_events ADD COLUMN external_account_id VARCHAR(64) NULL AFTER platform")
    console.log('  + Added external_account_id')
  }
  if (!has('external_object_id')) {
    await pool.execute("ALTER TABLE meta_webhook_events ADD COLUMN external_object_id VARCHAR(255) NULL AFTER external_account_id")
    console.log('  + Added external_object_id')
  }
  if (!has('event_time')) {
    await pool.execute("ALTER TABLE meta_webhook_events ADD COLUMN event_time TIMESTAMP NULL AFTER external_object_id")
    console.log('  + Added event_time')
  }
  if (!has('received_at')) {
    await pool.execute("ALTER TABLE meta_webhook_events ADD COLUMN received_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP AFTER event_time")
    console.log('  + Added received_at')
  }
  if (!has('processing_status')) {
    await pool.execute("ALTER TABLE meta_webhook_events ADD COLUMN processing_status VARCHAR(16) NOT NULL DEFAULT 'received' AFTER received_at")
    console.log('  + Added processing_status')
  }
  if (!has('attempts')) {
    await pool.execute("ALTER TABLE meta_webhook_events ADD COLUMN attempts INT NOT NULL DEFAULT 0 AFTER processing_status")
    console.log('  + Added attempts')
  }
  if (!has('next_attempt_at')) {
    await pool.execute("ALTER TABLE meta_webhook_events ADD COLUMN next_attempt_at TIMESTAMP NULL AFTER attempts")
    console.log('  + Added next_attempt_at')
  }
  if (!has('processing_started_at')) {
    await pool.execute("ALTER TABLE meta_webhook_events ADD COLUMN processing_started_at TIMESTAMP NULL AFTER next_attempt_at")
    console.log('  + Added processing_started_at')
  }
  if (!has('last_error')) {
    await pool.execute("ALTER TABLE meta_webhook_events ADD COLUMN last_error TEXT NULL AFTER processing_started_at")
    console.log('  + Added last_error')
  }

  const [idx] = await pool.query(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meta_webhook_events' AND INDEX_NAME = 'uk_meta_webhook_provider_key'"
  )
  if (idx.length === 0) {
    try {
      await pool.execute("ALTER TABLE meta_webhook_events ADD UNIQUE KEY uk_meta_webhook_provider_key (provider_event_key)")
      console.log('  + Added UNIQUE(provider_event_key)')
    } catch (e) {
      console.log('  ~ uk_meta_webhook_provider_key not added (duplicate nulls or existing)', e.message)
    }
  }

  const [idx2] = await pool.query(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meta_webhook_events' AND INDEX_NAME = 'idx_meta_webhook_status_next'"
  )
  if (idx2.length === 0) {
    await pool.execute("ALTER TABLE meta_webhook_events ADD KEY idx_meta_webhook_status_next (processing_status, next_attempt_at)")
    console.log('  + Added idx_meta_webhook_status_next')
  }

  const [idx3] = await pool.query(
    "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meta_webhook_events' AND INDEX_NAME = 'idx_meta_webhook_object'"
  )
  if (idx3.length === 0) {
    await pool.execute("ALTER TABLE meta_webhook_events ADD KEY idx_meta_webhook_object (external_object_id)")
    console.log('  + Added idx_meta_webhook_object')
  }

  const [targetsCols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'post_targets'"
  )
  const tHas = (name) => targetsCols.some(c => c.COLUMN_NAME === name)
  if (!tHas('meta_remote_status')) {
    await pool.execute("ALTER TABLE post_targets ADD COLUMN meta_remote_status VARCHAR(32) NULL AFTER last_engagement_sync_at")
    console.log('  + Added post_targets.meta_remote_status')
  }
  if (!tHas('meta_deleted_at')) {
    await pool.execute("ALTER TABLE post_targets ADD COLUMN meta_deleted_at TIMESTAMP NULL AFTER meta_remote_status")
    console.log('  + Added post_targets.meta_deleted_at')
  }
  if (!tHas('last_meta_event_at')) {
    await pool.execute("ALTER TABLE post_targets ADD COLUMN last_meta_event_at TIMESTAMP NULL AFTER meta_deleted_at")
    console.log('  + Added post_targets.last_meta_event_at')
  }
  if (!tHas('last_engagement_event_at')) {
    await pool.execute("ALTER TABLE post_targets ADD COLUMN last_engagement_event_at TIMESTAMP NULL AFTER last_meta_event_at")
    console.log('  + Added post_targets.last_engagement_event_at')
  }

  const [upaCols] = await pool.query(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_platform_accounts'"
  )
  const uHas = (name) => upaCols.some(c => c.COLUMN_NAME === name)
  if (!uHas('webhook_status')) {
    await pool.execute("ALTER TABLE user_platform_accounts ADD COLUMN webhook_status VARCHAR(16) NULL DEFAULT 'unknown' AFTER verification_status")
    console.log('  + Added user_platform_accounts.webhook_status')
  }
  if (!uHas('webhook_fields')) {
    await pool.execute("ALTER TABLE user_platform_accounts ADD COLUMN webhook_fields JSON NULL AFTER webhook_status")
    console.log('  + Added webhook_fields')
  }
  if (!uHas('webhook_subscribed_at')) {
    await pool.execute("ALTER TABLE user_platform_accounts ADD COLUMN webhook_subscribed_at TIMESTAMP NULL AFTER webhook_fields")
    console.log('  + Added webhook_subscribed_at')
  }
  if (!uHas('webhook_last_checked_at')) {
    await pool.execute("ALTER TABLE user_platform_accounts ADD COLUMN webhook_last_checked_at TIMESTAMP NULL AFTER webhook_subscribed_at")
    console.log('  + Added webhook_last_checked_at')
  }
  if (!uHas('webhook_last_error')) {
    await pool.execute("ALTER TABLE user_platform_accounts ADD COLUMN webhook_last_error TEXT NULL AFTER webhook_last_checked_at")
    console.log('  + Added webhook_last_error')
  }
}

export async function down({ context: pool }) {
  const drop = async (table, col) => {
    const [cols] = await pool.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?", [table, col]
    )
    if (cols.length > 0) {
      await pool.execute(`ALTER TABLE ${table} DROP COLUMN ${col}`)
      console.log(`  - Dropped ${table}.${col}`)
    }
  }
  const dropIdx = async (table, idx) => {
    const [rows] = await pool.query(
      "SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?", [table, idx]
    )
    if (rows.length > 0) {
      await pool.execute(`ALTER TABLE ${table} DROP INDEX ${idx}`)
      console.log(`  - Dropped index ${idx}`)
    }
  }
  await dropIdx('meta_webhook_events', 'uk_meta_webhook_provider_key')
  await dropIdx('meta_webhook_events', 'idx_meta_webhook_status_next')
  await dropIdx('meta_webhook_events', 'idx_meta_webhook_object')
  for (const c of ['last_error','processing_started_at','next_attempt_at','attempts','processing_status','received_at','event_time','external_object_id','external_account_id','platform','source_id','object_type','provider_event_key']) {
    await drop('meta_webhook_events', c)
  }
  for (const c of ['last_engagement_event_at','last_meta_event_at','meta_deleted_at','meta_remote_status']) {
    await drop('post_targets', c)
  }
  for (const c of ['webhook_last_error','webhook_last_checked_at','webhook_subscribed_at','webhook_fields','webhook_status']) {
    await drop('user_platform_accounts', c)
  }
}

export default { up, down }
