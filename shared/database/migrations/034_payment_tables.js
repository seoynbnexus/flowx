import crypto from 'crypto'

function generateUuid() {
  return crypto.randomUUID()
}

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex')
}

export async function up({ context: pool }) {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS payment_orders (
      id BINARY(16) PRIMARY KEY,
      user_id BINARY(16) NOT NULL,
      type ENUM('subscription', 'topup') NOT NULL,
      status ENUM('pending', 'paid', 'failed', 'refunded') NOT NULL DEFAULT 'pending',
      amount INT NOT NULL,
      currency VARCHAR(3) NOT NULL DEFAULT 'INR',
      tax_amount INT NOT NULL DEFAULT 0,
      razorpay_order_id VARCHAR(100) DEFAULT NULL,
      razorpay_payment_id VARCHAR(100) DEFAULT NULL,
      razorpay_subscription_id VARCHAR(100) DEFAULT NULL,
      description TEXT DEFAULT NULL,
      metadata JSON DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_user_id (user_id),
      INDEX idx_razorpay_order_id (razorpay_order_id),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  console.log('  + Created table: payment_orders')

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS payment_transactions (
      id BINARY(16) PRIMARY KEY,
      order_id BINARY(16) NOT NULL,
      gateway VARCHAR(50) NOT NULL DEFAULT 'razorpay',
      gateway_txn_id VARCHAR(100) DEFAULT NULL,
      gateway_status VARCHAR(50) DEFAULT NULL,
      amount INT NOT NULL,
      currency VARCHAR(3) NOT NULL DEFAULT 'INR',
      response_data JSON DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_order_id (order_id),
      INDEX idx_gateway_txn_id (gateway_txn_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  console.log('  + Created table: payment_transactions')

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS subscription_schedules (
      id BINARY(16) PRIMARY KEY,
      user_id BINARY(16) NOT NULL,
      user_subscription_id BINARY(16) NOT NULL,
      plan_id BINARY(16) NOT NULL,
      razorpay_subscription_id VARCHAR(100) NOT NULL,
      billing_cycle ENUM('monthly', 'yearly') NOT NULL DEFAULT 'monthly',
      status ENUM('active', 'paused', 'completed', 'cancelled', 'expired') NOT NULL DEFAULT 'active',
      current_start TIMESTAMP NULL DEFAULT NULL,
      current_end TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_user_id (user_id),
      INDEX idx_razorpay_subscription_id (razorpay_subscription_id),
      INDEX idx_user_subscription_id (user_subscription_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  console.log('  + Created table: subscription_schedules')

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS subscription_invoices (
      id BINARY(16) PRIMARY KEY,
      user_id BINARY(16) NOT NULL,
      user_subscription_id BINARY(16) DEFAULT NULL,
      order_id BINARY(16) DEFAULT NULL,
      period_start TIMESTAMP NULL DEFAULT NULL,
      period_end TIMESTAMP NULL DEFAULT NULL,
      amount INT NOT NULL,
      currency VARCHAR(3) NOT NULL DEFAULT 'INR',
      tax_amount INT NOT NULL DEFAULT 0,
      status ENUM('pending', 'paid', 'failed', 'refunded') NOT NULL DEFAULT 'pending',
      paid_at TIMESTAMP NULL DEFAULT NULL,
      invoice_url TEXT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user_id (user_id),
      INDEX idx_order_id (order_id),
      INDEX idx_user_subscription_id (user_subscription_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  console.log('  + Created table: subscription_invoices')

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS coin_topup_packages (
      id BINARY(16) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      slug VARCHAR(100) NOT NULL UNIQUE,
      coins INT NOT NULL,
      price INT NOT NULL,
      currency VARCHAR(3) NOT NULL DEFAULT 'INR',
      tax_rate DECIMAL(5,2) NOT NULL DEFAULT 18.00,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      display_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)
  console.log('  + Created table: coin_topup_packages')

  const packages = [
    { name: 'Starter Pack', slug: 'starter', coins: 10000, price: 10000 },
    { name: 'Growth Pack', slug: 'growth', coins: 50000, price: 45000 },
    { name: 'Pro Pack', slug: 'pro', coins: 100000, price: 85000 },
  ]
  for (let i = 0; i < packages.length; i++) {
    const pkg = packages[i]
    await pool.execute(
      `INSERT IGNORE INTO coin_topup_packages (id, name, slug, coins, price, currency, tax_rate, display_order)
       VALUES (?, ?, ?, ?, ?, 'INR', 18.00, ?)`,
      [uuidToBuffer(generateUuid()), pkg.name, pkg.slug, pkg.coins, pkg.price, i]
    )
    console.log(`  + Seeded coin package: ${pkg.name} (${pkg.coins} coins for ₹${(pkg.price / 100).toFixed(2)})`)
  }
}

export async function down({ context: pool }) {
  await pool.execute('DROP TABLE IF EXISTS coin_topup_packages')
  await pool.execute('DROP TABLE IF EXISTS subscription_invoices')
  await pool.execute('DROP TABLE IF EXISTS subscription_schedules')
  await pool.execute('DROP TABLE IF EXISTS payment_transactions')
  await pool.execute('DROP TABLE IF EXISTS payment_orders')
  console.log('  - Dropped payment tables')
}

export default { up, down }
