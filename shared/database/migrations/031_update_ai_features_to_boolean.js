export async function up({ context: pool }) {
  const [features] = await pool.query(
    "SELECT id, feature_key FROM features WHERE feature_key IN ('ai_content', 'ai_image')"
  )
  const featureIds = {}
  for (const row of features) {
    featureIds[row.feature_key] = row.id
  }

  const [plans] = await pool.query('SELECT id, slug FROM subscription_plans')
  const planIds = {}
  for (const row of plans) {
    planIds[row.slug] = row.id
  }

  for (const slug of Object.keys(planIds)) {
    const enabled = slug !== 'free' ? 1 : 0
    for (const key of ['ai_content', 'ai_image']) {
      await pool.execute(
        `UPDATE plan_features SET value_type = 'boolean', value_int = NULL, is_enabled = ? WHERE plan_id = ? AND feature_id = ?`,
        [enabled, planIds[slug], featureIds[key]]
      )
    }
  }
  console.log('  + Updated ai_content and ai_image to boolean across all plans')
}

export async function down({ context: pool }) {
  const [features] = await pool.query(
    "SELECT id, feature_key FROM features WHERE feature_key IN ('ai_content', 'ai_image')"
  )
  const featureIds = {}
  for (const row of features) {
    featureIds[row.feature_key] = row.id
  }

  const [plans] = await pool.query('SELECT id, slug FROM subscription_plans')
  const planIds = {}
  for (const row of plans) {
    planIds[row.slug] = row.id
  }

  const restore = { free: 5, starter: 30, pro: 100, agency: null }
  for (const slug of Object.keys(planIds)) {
    const valueInt = restore[slug]
    const valueType = valueInt === null ? 'unlimited' : 'integer'
    for (const key of ['ai_content', 'ai_image']) {
      await pool.execute(
        `UPDATE plan_features SET value_type = ?, value_int = ?, is_enabled = 1 WHERE plan_id = ? AND feature_id = ?`,
        [valueType, valueInt, planIds[slug], featureIds[key]]
      )
    }
  }
  console.log('  - Restored ai_content and ai_image to integer values')
}

export default { up, down }
