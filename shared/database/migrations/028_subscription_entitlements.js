import crypto from 'crypto'

function generateUuid() {
  return crypto.randomUUID()
}

function uuidToBuffer(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex')
}

const UP = `
CREATE TABLE IF NOT EXISTS subscription_plans (
  id BINARY(16) NOT NULL,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) NOT NULL,
  description TEXT NULL DEFAULT NULL,
  monthly_price DECIMAL(10,2) NOT NULL DEFAULT 0,
  yearly_price DECIMAL(10,2) NOT NULL DEFAULT 0,
  currency VARCHAR(3) NOT NULL DEFAULT 'INR',
  trial_days INT NOT NULL DEFAULT 0,
  display_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_plan_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS features (
  id BINARY(16) NOT NULL,
  feature_key VARCHAR(100) NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT NULL DEFAULT NULL,
  category VARCHAR(100) NULL DEFAULT NULL,
  unit VARCHAR(50) NULL DEFAULT NULL,
  is_boolean TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_feature_key (feature_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS plan_features (
  id BINARY(16) NOT NULL,
  plan_id BINARY(16) NOT NULL,
  feature_id BINARY(16) NOT NULL,
  is_enabled TINYINT(1) NOT NULL DEFAULT 0,
  value_type ENUM('boolean','integer','unlimited') NOT NULL DEFAULT 'boolean',
  value_int INT NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_plan_feature (plan_id, feature_id),
  KEY idx_plan_features_plan (plan_id),
  CONSTRAINT fk_pf_plan FOREIGN KEY (plan_id) REFERENCES subscription_plans (id) ON DELETE CASCADE,
  CONSTRAINT fk_pf_feature FOREIGN KEY (feature_id) REFERENCES features (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id BINARY(16) NOT NULL,
  user_id BINARY(16) NOT NULL,
  plan_id BINARY(16) NOT NULL,
  status ENUM('active','canceled','past_due','trialing') NOT NULL DEFAULT 'active',
  trial_ends_at TIMESTAMP NULL DEFAULT NULL,
  current_period_start TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  current_period_end TIMESTAMP NULL DEFAULT NULL,
  billing_cycle ENUM('monthly','yearly') NOT NULL DEFAULT 'monthly',
  canceled_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_subscription (user_id),
  KEY idx_user_sub_plan (plan_id),
  CONSTRAINT fk_us_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_us_plan FOREIGN KEY (plan_id) REFERENCES subscription_plans (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS feature_usage (
  id BINARY(16) NOT NULL,
  user_id BINARY(16) NOT NULL,
  feature_key VARCHAR(100) NOT NULL,
  period_start TIMESTAMP NOT NULL,
  period_end TIMESTAMP NOT NULL,
  used INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_feature_period (user_id, feature_key, period_start),
  KEY idx_fu_user (user_id),
  CONSTRAINT fk_fu_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS feature_topups (
  id BINARY(16) NOT NULL,
  user_id BINARY(16) NOT NULL,
  feature_key VARCHAR(100) NOT NULL,
  quantity INT NOT NULL,
  remaining INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ft_user_feature (user_id, feature_key),
  CONSTRAINT fk_ft_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`

const DOWN = `
DROP TABLE IF EXISTS feature_topups;
DROP TABLE IF EXISTS feature_usage;
DROP TABLE IF EXISTS user_subscriptions;
DROP TABLE IF EXISTS plan_features;
DROP TABLE IF EXISTS features;
DROP TABLE IF EXISTS subscription_plans;
`

const PLANS = [
  { name: 'Free', slug: 'free', description: 'Get started with basic features at no cost', monthly_price: 0, yearly_price: 0, trial_days: 0, display_order: 0 },
  { name: 'Starter', slug: 'starter', description: 'Perfect for small businesses getting started', monthly_price: 999, yearly_price: 9999, trial_days: 7, display_order: 1 },
  { name: 'Pro', slug: 'pro', description: 'For growing teams that need more power', monthly_price: 2499, yearly_price: 24999, trial_days: 7, display_order: 2 },
  { name: 'Agency', slug: 'agency', description: 'For agencies managing multiple clients', monthly_price: 4999, yearly_price: 49999, trial_days: 7, display_order: 3 },
]

const FEATURES = [
  { feature_key: 'ai_assistant', name: 'AI Assistant', description: 'AI content and image generation', category: 'creative', unit: 'requests/mo', is_boolean: 0 },
  { feature_key: 'ai_content', name: 'AI Content Generation', description: 'AI-powered text content generation', category: 'creative', unit: 'requests/mo', is_boolean: 0 },
  { feature_key: 'ai_image', name: 'AI Image Generation', description: 'AI-powered image generation', category: 'creative', unit: 'requests/mo', is_boolean: 0 },
  { feature_key: 'campaigns', name: 'Campaigns', description: 'Maximum active ad campaigns', category: 'campaigns', unit: 'campaigns', is_boolean: 0 },
  { feature_key: 'publishers_per_campaign', name: 'Publishers per Campaign', description: 'Maximum publishers per campaign', category: 'campaigns', unit: 'publishers', is_boolean: 0 },
]

const PLAN_ENTITLEMENTS = {
  free: {
    ai_assistant: { value_type: 'integer', value_int: 10, is_enabled: 1 },
    ai_content: { value_type: 'boolean', value_int: null, is_enabled: 0 },
    ai_image: { value_type: 'boolean', value_int: null, is_enabled: 0 },
    campaigns: { value_type: 'integer', value_int: 1, is_enabled: 1 },
    publishers_per_campaign: { value_type: 'integer', value_int: 1, is_enabled: 1 },
  },
  starter: {
    ai_assistant: { value_type: 'integer', value_int: 100, is_enabled: 1 },
    ai_content: { value_type: 'boolean', value_int: null, is_enabled: 1 },
    ai_image: { value_type: 'boolean', value_int: null, is_enabled: 1 },
    campaigns: { value_type: 'integer', value_int: 5, is_enabled: 1 },
    publishers_per_campaign: { value_type: 'integer', value_int: 3, is_enabled: 1 },
  },
  pro: {
    ai_assistant: { value_type: 'integer', value_int: 500, is_enabled: 1 },
    ai_content: { value_type: 'boolean', value_int: null, is_enabled: 1 },
    ai_image: { value_type: 'boolean', value_int: null, is_enabled: 1 },
    campaigns: { value_type: 'integer', value_int: 20, is_enabled: 1 },
    publishers_per_campaign: { value_type: 'integer', value_int: 10, is_enabled: 1 },
  },
  agency: {
    ai_assistant: { value_type: 'unlimited', value_int: null, is_enabled: 1 },
    ai_content: { value_type: 'boolean', value_int: null, is_enabled: 1 },
    ai_image: { value_type: 'boolean', value_int: null, is_enabled: 1 },
    campaigns: { value_type: 'integer', value_int: 100, is_enabled: 1 },
    publishers_per_campaign: { value_type: 'integer', value_int: 50, is_enabled: 1 },
  },
}

const SUBSCRIPTION_PERMISSIONS = [
  { code: 'subscriptions.admin', name: 'Manage Subscription Plans', description: 'Create, edit, and manage subscription plans and entitlements' },
  { code: 'subscriptions.read', name: 'Read Subscriptions', description: 'View subscription and entitlement data' },
]

export async function up({ context: pool }) {
  const statements = UP.split(';').filter(s => s.trim().length > 0)
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';')
  }
  console.log('  + Created subscription tables')

  const planIds = {}
  for (const plan of PLANS) {
    const id = generateUuid()
    planIds[plan.slug] = id
    await pool.execute(
      `INSERT INTO subscription_plans (id, name, slug, description, monthly_price, yearly_price, trial_days, display_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [uuidToBuffer(id), plan.name, plan.slug, plan.description, plan.monthly_price, plan.yearly_price, plan.trial_days, plan.display_order]
    )
    console.log(`  + Seeded plan: ${plan.name}`)
  }

  const featureIds = {}
  for (const feat of FEATURES) {
    const id = generateUuid()
    featureIds[feat.feature_key] = id
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
        [uuidToBuffer(id), uuidToBuffer(planIds[planSlug]), uuidToBuffer(featureIds[featureKey]), ent.is_enabled, ent.value_type, ent.value_int]
      )
    }
    console.log(`  + Seeded entitlements for plan: ${planSlug}`)
  }

  for (const perm of SUBSCRIPTION_PERMISSIONS) {
    const permissionId = generateUuid()
    try {
      await pool.query(
        `INSERT IGNORE INTO permissions (id, module, code, name, description)
         VALUES (?, 'subscriptions', ?, ?, ?)`,
        [uuidToBuffer(permissionId), perm.code, perm.name, perm.description]
      )
      console.log(`  + Seeded permission: ${perm.code}`)
    } catch (error) {
      console.error(`  ! Error seeding permission ${perm.code}: ${error.message}`)
    }
  }
}

export async function down({ context: pool }) {
  for (const perm of SUBSCRIPTION_PERMISSIONS) {
    await pool.query('DELETE FROM permissions WHERE code = ?', [perm.code])
  }
  const statements = DOWN.split(';').filter(s => s.trim().length > 0)
  for (const stmt of statements) {
    await pool.execute(stmt.trim() + ';')
  }
  console.log('  - Dropped subscription tables')
}

export default { up, down }
