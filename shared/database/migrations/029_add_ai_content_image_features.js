import crypto from 'crypto'

function generateUuid() {
  return crypto.randomUUID()
}

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex')
}

const NEW_FEATURES = [
  { feature_key: 'ai_content', name: 'AI Content Generation', description: 'AI-powered text content generation', category: 'creative', unit: 'requests/mo', is_boolean: 0 },
  { feature_key: 'ai_image', name: 'AI Image Generation', description: 'AI-powered image generation', category: 'creative', unit: 'requests/mo', is_boolean: 0 },
]

const PLAN_ENTITLEMENTS = {
  free:   { ai_content: { value_type: 'integer', value_int: 5, is_enabled: 1 }, ai_image: { value_type: 'integer', value_int: 5, is_enabled: 1 } },
  starter:{ ai_content: { value_type: 'integer', value_int: 30, is_enabled: 1 }, ai_image: { value_type: 'integer', value_int: 20, is_enabled: 1 } },
  pro:    { ai_content: { value_type: 'integer', value_int: 100, is_enabled: 1 }, ai_image: { value_type: 'integer', value_int: 100, is_enabled: 1 } },
  agency: { ai_content: { value_type: 'unlimited', value_int: null, is_enabled: 1 }, ai_image: { value_type: 'unlimited', value_int: null, is_enabled: 1 } },
}

export async function up({ context: pool }) {
  const [planRows] = await pool.query('SELECT id, slug FROM subscription_plans ORDER BY display_order ASC')
  const planIds = {}
  for (const row of planRows) {
    planIds[row.slug] = row.id
  }

  const featureIds = {}
  for (const feat of NEW_FEATURES) {
    const id = generateUuid()
    featureIds[feat.feature_key] = uuidToBuffer(id)
    await pool.execute(
      `INSERT IGNORE INTO features (id, feature_key, name, description, category, unit, is_boolean)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuidToBuffer(id), feat.feature_key, feat.name, feat.description, feat.category, feat.unit, feat.is_boolean]
    )
    console.log(`  + Seeded feature: ${feat.feature_key}`)
  }

  for (const [planSlug, entitlements] of Object.entries(PLAN_ENTITLEMENTS)) {
    for (const [featureKey, ent] of Object.entries(entitlements)) {
      const id = generateUuid()
      await pool.execute(
        `INSERT IGNORE INTO plan_features (id, plan_id, feature_id, is_enabled, value_type, value_int)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidToBuffer(id), planIds[planSlug], featureIds[featureKey], ent.is_enabled, ent.value_type, ent.value_int]
      )
    }
    console.log(`  + Seeded entitlements for plan: ${planSlug}`)
  }

  await pool.execute(
    `UPDATE plan_features pf
     JOIN features f ON f.id = pf.feature_id
     SET pf.is_enabled = 0, pf.value_type = 'integer', pf.value_int = 0
     WHERE f.feature_key = 'ai_assistant'`
  )
  console.log('  - Disabled legacy ai_assistant feature in all plans')
}

export async function down({ context: pool }) {
  await pool.execute(
    `DELETE pf FROM plan_features pf
     JOIN features f ON f.id = pf.feature_id
     WHERE f.feature_key IN ('ai_content', 'ai_image')`
  )
  await pool.execute("DELETE FROM features WHERE feature_key IN ('ai_content', 'ai_image')")
  console.log('  - Removed ai_content and ai_image features')
}

export default { up, down }
