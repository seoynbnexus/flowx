import crypto from 'crypto'

function generateUuid() {
  return crypto.randomUUID()
}

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex')
}

const UP = `
CREATE TABLE IF NOT EXISTS usage_ledger (
  id BINARY(16) NOT NULL,
  user_id BINARY(16) NOT NULL,
  subscription_id BINARY(16) NULL,
  feature_key VARCHAR(100) NOT NULL,
  resource_type VARCHAR(100) NOT NULL,
  resource_id VARCHAR(255) NULL,
  transaction_type ENUM('consume','refund','bonus','admin_adjustment') NOT NULL,
  quantity INT NOT NULL,
  billing_period_start TIMESTAMP NOT NULL,
  billing_period_end TIMESTAMP NOT NULL,
  notes TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ul_user_feature (user_id, feature_key, billing_period_start),
  KEY idx_ul_resource (resource_type, resource_id),
  KEY idx_ul_subscription (subscription_id),
  CONSTRAINT fk_ul_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_ul_subscription FOREIGN KEY (subscription_id) REFERENCES user_subscriptions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`

const DOWN = `
DROP TABLE IF EXISTS usage_ledger;
`

export async function up({ context: pool }) {
  const statements = UP.split(';').filter(s => s.trim().length > 0)
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';')
  }
  console.log('  + Created usage_ledger table')

  const oldRows = await pool.execute(
    `SELECT fu.*, us.id as sub_id
     FROM feature_usage fu
     LEFT JOIN user_subscriptions us ON us.user_id = fu.user_id
     WHERE fu.used > 0`
  )
  const rows = oldRows[0]
  if (rows.length > 0) {
    let migrated = 0
    for (const row of rows) {
      const id = generateUuid()
      const userId = row.user_id
      const subId = row.sub_id
      const billingStart = row.period_start
      const periodEnd = row.period_end
      const used = row.used
      try {
        const periodStart = new Date(billingStart)
        const end = periodEnd || new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000)
        await pool.execute(
          `INSERT INTO usage_ledger (id, user_id, subscription_id, feature_key, resource_type, resource_id, transaction_type, quantity, billing_period_start, billing_period_end, notes)
           VALUES (?, ?, ?, ?, 'migration', 'feature_usage', 'admin_adjustment', ?, ?, ?, 'Migrated from feature_usage table')`,
          [uuidToBuffer(id), userId, subId || null, row.feature_key, used, billingStart, end]
        )
        migrated++
      } catch (e) {
        console.error(`  ! Error migrating ${row.feature_key} for ${userId.toString('hex')}: ${e.message}`)
      }
    }
    console.log(`  + Migrated ${migrated} feature_usage records to usage_ledger`)
  } else {
    console.log('  + No feature_usage records to migrate')
  }
}

export async function down({ context: pool }) {
  const statements = DOWN.split(';').filter(s => s.trim().length > 0)
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';')
  }
  console.log('  - Dropped usage_ledger table')
}
