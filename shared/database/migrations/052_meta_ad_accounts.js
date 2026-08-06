import { encrypt } from '../../utils/crypto.utils.js'
import { generateUuid, uuidToBuffer } from '../../utils/uuid.utils.js'

export async function up({ context: pool }) {
  const [tables] = await pool.execute(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meta_ad_accounts'"
  )
  if (tables.length === 0) {
    await pool.execute(`
      CREATE TABLE meta_ad_accounts (
        id BINARY(16) NOT NULL,
        account_id VARCHAR(64) NOT NULL,
        name VARCHAR(255) NULL,
        token_encrypted TEXT NULL,
        monthly_cap_paise BIGINT NOT NULL DEFAULT 0,
        is_primary TINYINT(1) NOT NULL DEFAULT 0,
        status ENUM('active','disabled') NOT NULL DEFAULT 'active',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uk_meta_ad_accounts_account (account_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    console.log('  + Created meta_ad_accounts')
  } else {
    console.log('  ~ meta_ad_accounts already present')
  }

  const [seedRows] = await pool.execute('SELECT COUNT(*) AS count FROM meta_ad_accounts')
  const seedCount = Number(seedRows[0].count) || 0
  const metaAccountId = process.env.META_AD_ACCOUNT_ID
  const metaToken = process.env.META_SYSTEM_USER_TOKEN
  if (seedCount === 0 && metaAccountId && metaToken && process.env.NODE_ENV !== 'test') {
    await pool.execute(
      `INSERT INTO meta_ad_accounts (id, account_id, name, token_encrypted, monthly_cap_paise, is_primary, status)
       VALUES (?, ?, 'Primary', ?, 0, 1, 'active')
       ON DUPLICATE KEY UPDATE is_primary = 1`,
      [uuidToBuffer(generateUuid()), metaAccountId, encrypt(metaToken)]
    )
    console.log(`  + Seeded primary meta ad account ${metaAccountId}`)
  } else if (seedCount > 0) {
    console.log('  ~ meta_ad_accounts already seeded')
  } else {
    console.log('  ~ no META_AD_ACCOUNT_ID/META_SYSTEM_USER_TOKEN to seed (or test env)')
  }

  const [cols] = await pool.execute(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaigns' AND COLUMN_NAME = 'ad_account_id'"
  )
  if (cols.length === 0) {
    await pool.execute('ALTER TABLE campaigns ADD COLUMN ad_account_id BINARY(16) NULL AFTER id')
    await pool.execute(
      'ALTER TABLE campaigns ADD CONSTRAINT fk_campaigns_ad_account FOREIGN KEY (ad_account_id) REFERENCES meta_ad_accounts (id)'
    )
    console.log('  + Added campaigns.ad_account_id')
  } else {
    console.log('  ~ campaigns.ad_account_id already present')
  }

  await pool.execute(
    `UPDATE campaigns c JOIN meta_ad_accounts ma ON ma.is_primary = 1 SET c.ad_account_id = ma.id WHERE c.ad_account_id IS NULL`
  )
  console.log('  + Backfilled campaigns.ad_account_id to primary account')
}

export async function down({ context: pool }) {
  const [fks] = await pool.execute(
    "SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaigns' AND CONSTRAINT_NAME = 'fk_campaigns_ad_account'"
  )
  if (fks.length > 0) {
    await pool.execute('ALTER TABLE campaigns DROP FOREIGN KEY fk_campaigns_ad_account')
  }
  const [cols] = await pool.execute(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'campaigns' AND COLUMN_NAME = 'ad_account_id'"
  )
  if (cols.length > 0) {
    await pool.execute('ALTER TABLE campaigns DROP COLUMN ad_account_id')
  }
  const [tables] = await pool.execute(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meta_ad_accounts'"
  )
  if (tables.length > 0) {
    await pool.execute('DROP TABLE meta_ad_accounts')
  }
}
