import crypto from 'crypto'

function generateUuid() {
  return crypto.randomUUID()
}

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex')
}

export async function up({ context: pool }) {
  const dbName = pool.pool.config.connectionConfig.database

  const [planCols] = await pool.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'subscription_plans' AND COLUMN_NAME = 'tax_rate'`,
    [dbName]
  )
  if (planCols.length === 0) {
    await pool.execute(
      "ALTER TABLE subscription_plans ADD COLUMN tax_rate DECIMAL(5,2) NOT NULL DEFAULT 18.00 AFTER currency"
    )
    console.log('  + Added tax_rate column to subscription_plans')
  } else {
    console.log('  ~ tax_rate column already exists in subscription_plans')
  }

  const [txnCols] = await pool.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'payment_order_id'`,
    [dbName]
  )
  if (txnCols.length === 0) {
    await pool.execute(
      "ALTER TABLE transactions ADD COLUMN payment_order_id BINARY(16) DEFAULT NULL AFTER reference_id"
    )
    console.log('  + Added payment_order_id column to transactions')
  } else {
    console.log('  ~ payment_order_id column already exists in transactions')
  }

  const [walletCols] = await pool.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'user_wallets' AND COLUMN_NAME = 'total_purchased_coins'`,
    [dbName]
  )
  if (walletCols.length === 0) {
    await pool.execute(
      "ALTER TABLE user_wallets ADD COLUMN total_purchased_coins BIGINT NOT NULL DEFAULT 0 AFTER coins"
    )
    console.log('  + Added total_purchased_coins column to user_wallets')
  } else {
    console.log('  ~ total_purchased_coins column already exists in user_wallets')
  }
}

export async function down({ context: pool }) {
  const dbName = pool.pool.config.connectionConfig.database

  const [planCols] = await pool.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'subscription_plans' AND COLUMN_NAME = 'tax_rate'`,
    [dbName]
  )
  if (planCols.length > 0) {
    await pool.execute('ALTER TABLE subscription_plans DROP COLUMN tax_rate')
    console.log('  - Dropped tax_rate from subscription_plans')
  }

  const [txnCols] = await pool.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'transactions' AND COLUMN_NAME = 'payment_order_id'`,
    [dbName]
  )
  if (txnCols.length > 0) {
    await pool.execute('ALTER TABLE transactions DROP COLUMN payment_order_id')
    console.log('  - Dropped payment_order_id from transactions')
  }

  const [walletCols] = await pool.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'user_wallets' AND COLUMN_NAME = 'total_purchased_coins'`,
    [dbName]
  )
  if (walletCols.length > 0) {
    await pool.execute('ALTER TABLE user_wallets DROP COLUMN total_purchased_coins')
    console.log('  - Dropped total_purchased_coins from user_wallets')
  }
}

export default { up, down }
