import crypto from 'crypto'

function generateUuid() {
  return crypto.randomUUID()
}

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex')
}

const PLANS_ORDER = ['free', 'starter', 'pro', 'agency']

const PLAN_COINS = {
  free:   10000,
  starter: 50000,
  pro:    200000,
  agency:  null,
}

export async function up({ context: pool }) {
  const [planRows] = await pool.query('SELECT id, slug FROM subscription_plans')
  const planIds = {}
  for (const row of planRows) {
    planIds[row.slug] = row.id
  }

  const featureId = generateUuid()
  await pool.execute(
    `INSERT IGNORE INTO features (id, feature_key, name, description, category, unit, is_boolean)
     VALUES (?, 'monthly_coins', 'Monthly Coins', 'Monthly coin allowance for AI generation and campaign publishing', 'economy', 'coins', 0)`,
    [uuidToBuffer(featureId)]
  )
  console.log('  + Seeded feature: monthly_coins')

  for (const slug of PLANS_ORDER) {
    const coins = PLAN_COINS[slug]
    const valueType = coins === null ? 'unlimited' : 'integer'
    await pool.execute(
      `INSERT IGNORE INTO plan_features (id, plan_id, feature_id, is_enabled, value_type, value_int)
       VALUES (?, ?, ?, 1, ?, ?)`,
      [uuidToBuffer(generateUuid()), planIds[slug], uuidToBuffer(featureId), valueType, coins]
    )
    console.log(`  + Seeded monthly_coins for plan: ${slug} (${coins === null ? 'unlimited' : coins})`)
  }
}

export async function down({ context: pool }) {
  await pool.execute(
    `DELETE pf FROM plan_features pf
     JOIN features f ON f.id = pf.feature_id
     WHERE f.feature_key = 'monthly_coins'`
  )
  await pool.execute("DELETE FROM features WHERE feature_key = 'monthly_coins'")
  console.log('  - Removed monthly_coins feature')
}

export default { up, down }
