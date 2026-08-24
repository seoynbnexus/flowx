import dotenv from 'dotenv'
dotenv.config()
import bcrypt from 'bcryptjs'
import { v7 as generateUuid } from 'uuid'
import { getPool, closePool } from './connection.js'
import { uuidToBuffer } from '../utils/uuid.utils.js'

const ROLES = [
  { code: 'super_admin', name: 'Super Admin', description: 'Super administrator role', is_super_admin: 1 },
  { code: 'admin', name: 'Admin', description: 'Administrator role', is_super_admin: 0 },
  { code: 'publisher', name: 'Publisher', description: 'Publisher role', is_super_admin: 0 },
  { code: 'client', name: 'Client', description: 'Client role', is_super_admin: 0 },
  { code: 'support_agent', name: 'Support Agent', description: 'Support agent role', is_super_admin: 0 },
]

const PERMISSIONS = [
  { code: 'users.read', name: 'Read Users', module: 'users' },
  { code: 'users.create', name: 'Create Users', module: 'users' },
  { code: 'users.update', name: 'Update Users', module: 'users' },
  { code: 'users.delete', name: 'Delete Users', module: 'users' },
  { code: 'roles.read', name: 'Read Roles', module: 'roles' },
  { code: 'roles.create', name: 'Create Roles', module: 'roles' },
  { code: 'roles.update', name: 'Update Roles', module: 'roles' },
  { code: 'roles.delete', name: 'Delete Roles', module: 'roles' },
  { code: 'permissions.read', name: 'Read Permissions', module: 'permissions' },
  { code: 'permissions.assign', name: 'Assign Permissions', module: 'permissions' },
  { code: 'auth.admin', name: 'Auth Admin', module: 'auth' },
  { code: 'audit.read', name: 'Read Audit Logs', module: 'audit' },
  { code: 'own.profile.read', name: 'Read Own Profile', module: 'profile' },
  { code: 'own.profile.update', name: 'Update Own Profile', module: 'profile' },
  { code: 'ad_categories.read', name: 'Read Ad Categories', module: 'ad_categories' },
  { code: 'ad_categories.create', name: 'Create Ad Categories', module: 'ad_categories' },
  { code: 'ad_categories.update', name: 'Update Ad Categories', module: 'ad_categories' },
  { code: 'ad_categories.delete', name: 'Delete Ad Categories', module: 'ad_categories' },
  { code: 'platform_accounts.read', name: 'Read Platform Accounts', module: 'platform_accounts' },
  { code: 'platform_accounts.verify', name: 'Verify Platform Accounts', module: 'platform_accounts' },
  { code: 'platform_accounts.oauth.connect', name: 'Connect OAuth', module: 'platform_accounts' },
  { code: 'identity_documents.upload', name: 'Upload Identity Document', module: 'identity_documents' },
  { code: 'identity_documents.read', name: 'Read Identity Documents', module: 'identity_documents' },
  { code: 'identity_documents.verify', name: 'Verify Identity Documents', module: 'identity_documents' },
  { code: 'identity_document_types.create', name: 'Create Document Types', module: 'identity_document_types' },
  { code: 'identity_document_types.read', name: 'Read Document Types', module: 'identity_document_types' },
  { code: 'identity_document_types.update', name: 'Update Document Types', module: 'identity_document_types' },
  { code: 'identity_document_types.delete', name: 'Delete Document Types', module: 'identity_document_types' },
  { code: 'ai.generate', name: 'Generate AI Content', module: 'ai' },
  { code: 'ai.save', name: 'Save AI Content', module: 'ai' },
  { code: 'ai.read', name: 'Read AI Content', module: 'ai' },
  { code: 'ai.admin', name: 'Admin AI Settings', module: 'ai' },
  { code: 'campaigns.read', name: 'Read Campaigns', module: 'campaigns' },
  { code: 'campaigns.create', name: 'Create Campaigns', module: 'campaigns' },
  { code: 'campaigns.review', name: 'Review Campaigns', module: 'campaigns' },
  { code: 'campaigns.manage', name: 'Manage Campaigns', module: 'campaigns' },
  { code: 'campaigns.force-manage', name: 'Force Manage Campaigns', module: 'campaigns' },
  { code: 'posts.read', name: 'Read Posts', module: 'posts' },
  { code: 'posts.create', name: 'Create Posts', module: 'posts' },
  { code: 'posts.review', name: 'Review Posts', module: 'posts' },
  { code: 'posts.manage', name: 'Manage Posts', module: 'posts' },
  { code: 'subscriptions.admin', name: 'Manage Subscription Plans', module: 'subscriptions' },
  { code: 'subscriptions.read', name: 'Read Subscriptions', module: 'subscriptions' },
]

const ROLE_PERMISSION_MAP = {
  admin: [
    'users.read', 'users.create', 'users.update', 'users.delete',
    'roles.read', 'roles.create', 'roles.update', 'roles.delete',
    'permissions.read', 'permissions.assign',
    'auth.admin', 'audit.read',
    'own.profile.read', 'own.profile.update',
    'ad_categories.read', 'ad_categories.create', 'ad_categories.update', 'ad_categories.delete',
    'platform_accounts.read', 'platform_accounts.verify',
    'identity_documents.read', 'identity_documents.verify',
    'identity_document_types.read', 'identity_document_types.create', 'identity_document_types.update', 'identity_document_types.delete',
    'ai.admin',
    'campaigns.review', 'campaigns.manage', 'campaigns.force-manage', 'campaigns.read',
    'posts.read', 'posts.review', 'posts.manage',
    'subscriptions.admin', 'subscriptions.read',
  ],
  client: [
    'own.profile.read', 'own.profile.update',
    'ad_categories.read',
    'identity_documents.upload', 'identity_documents.read',
    'ai.generate', 'ai.save', 'ai.read',
    'campaigns.read', 'campaigns.create',
    'posts.read', 'posts.create',
  ],
  publisher: [
    'own.profile.read', 'own.profile.update',
    'ad_categories.read',
    'identity_documents.upload', 'identity_documents.read',
    'platform_accounts.oauth.connect',
  ],
  support_agent: [
    'own.profile.read', 'own.profile.update',
    'users.read', 'audit.read',
  ],
}

const OAUTH_PROVIDERS = [{ code: 'google', name: 'Google' }]

const AD_CATEGORIES = [
  { code: 'technology', name: 'Technology', icon: '💻' },
  { code: 'fashion', name: 'Fashion & Beauty', icon: '👗' },
  { code: 'travel', name: 'Travel & Tourism', icon: '✈️' },
  { code: 'food', name: 'Food & Beverage', icon: '🍔' },
  { code: 'fitness', name: 'Health & Fitness', icon: '💪' },
  { code: 'finance', name: 'Finance & Banking', icon: '💰' },
  { code: 'entertainment', name: 'Entertainment', icon: '🎬' },
  { code: 'sports', name: 'Sports', icon: '⚽' },
  { code: 'education', name: 'Education', icon: '📚' },
  { code: 'music', name: 'Music', icon: '🎵' },
  { code: 'gaming', name: 'Gaming', icon: '🎮' },
  { code: 'realestate', name: 'Real Estate', icon: '🏠' },
  { code: 'automotive', name: 'Automotive', icon: '🚗' },
  { code: 'lifestyle', name: 'Lifestyle', icon: '✨' },
  { code: 'news', name: 'News & Media', icon: '📰' },
]

const IDENTITY_DOCUMENT_TYPES = [
  { code: 'aadhaar', name: 'Aadhaar Card', description: 'Government-issued Aadhaar card' },
  { code: 'drivers_license', name: "Driver's License", description: 'Government-issued driving license' },
]

const SUBSCRIPTION_PLANS = [
  { name: 'Free', slug: 'free', description: 'Get started with basic features at no cost', monthly_price: 0, yearly_price: 0, trial_days: 0, display_order: 0 },
  { name: 'Starter', slug: 'starter', description: 'Perfect for small businesses getting started', monthly_price: 999, yearly_price: 9999, trial_days: 7, display_order: 1 },
  { name: 'Pro', slug: 'pro', description: 'For growing teams that need more power', monthly_price: 2499, yearly_price: 24999, trial_days: 7, display_order: 2 },
  { name: 'Agency', slug: 'agency', description: 'For agencies managing multiple clients', monthly_price: 4999, yearly_price: 49999, trial_days: 7, display_order: 3 },
]

const SUBSCRIPTION_FEATURES = [
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

const APP_CONFIG_SEEDS = [
  { key: 'coin_conversion_rate', value: 1, is_public: 1, description: 'Conversion rate: 1 coin = X INR when calculating Meta ad budget from coin budget' },
  { key: 'ai_markup_coins', value: 200, is_public: 0, description: 'Admin markup coins added on top of LLM token cost per AI generation' },
  { key: 'publisher_request_multiplier', value: 2, is_public: 0, description: 'Over-provisioning multiplier for publisher requests (e.g., 2 = invite 2x the requested count)' },
  { key: 'publisher_response_deadline_days', value: 7, is_public: 0, description: 'Number of days publishers have to respond to campaign requests before the campaign expires' },
  { key: 'post_media_quota_bytes', value: Number(process.env.POST_MEDIA_QUOTA_BYTES) || 512 * 1024 * 1024, is_public: 1, description: 'Total media storage quota per user in bytes' },
  { key: 'post_media_max_file_bytes', value: Number(process.env.POST_MEDIA_MAX_FILE_BYTES) || 200 * 1024 * 1024, is_public: 1, description: 'Maximum size for a single uploaded media file in bytes' },
  { key: 'feature_visibility', value: {
    client_campaigns: true,
    publisher_campaign_requests: true,
    client_image_generation: true,
    client_support: true,
    campaign_duplicate: false,
    post_duplicate: false,
    publisher_registration: true,
  }, is_public: 1, description: 'Feature visibility toggles per role (true = visible). Managed by super admin via /admin/config/features.' },
  { key: 'publisher_max_accounts_per_request', value: 5, is_public: 1, description: 'Max verified accounts a publisher may select per post request (1..10). Managed by super admin.' },
  { key: 'publisher_response_deadline_hours', value: 48, is_public: 1, description: 'General waiting time for publishers to accept post/campaign requests (hours, 1..720). Capped by scheduled time if scheduled.' },
]

const report = []
const log = (msg) => {
  report.push(msg)
  console.log(msg)
}

async function main() {
  if (process.env.NODE_ENV === 'test') {
    console.error('db:seed refuses to run with NODE_ENV=test')
    process.exit(1)
  }

  const pool = getPool()
  log('=== FlowX database seed ===')

  for (const role of ROLES) {
    const [result] = await pool.execute(
      'INSERT IGNORE INTO roles (id, code, name, description, is_system, is_super_admin) VALUES (?, ?, ?, ?, 1, ?)',
      [uuidToBuffer(generateUuid()), role.code, role.name, role.description, role.is_super_admin]
    )
    if (result.affectedRows > 0) log(`  + Role created: ${role.code}`)
  }

  for (const perm of PERMISSIONS) {
    const [result] = await pool.execute(
      'INSERT IGNORE INTO permissions (id, code, name, module, is_system) VALUES (?, ?, ?, ?, 1)',
      [uuidToBuffer(generateUuid()), perm.code, perm.name, perm.module]
    )
    if (result.affectedRows > 0) log(`  + Permission created: ${perm.code}`)
  }

  for (const provider of OAUTH_PROVIDERS) {
    const [result] = await pool.execute(
      'INSERT IGNORE INTO oauth_providers (id, code, name, active) VALUES (?, ?, ?, 1)',
      [uuidToBuffer(generateUuid()), provider.code, provider.name]
    )
    if (result.affectedRows > 0) log(`  + OAuth provider created: ${provider.code}`)
  }

  for (const [roleCode, permCodes] of Object.entries(ROLE_PERMISSION_MAP)) {
    for (const permCode of permCodes) {
      const [result] = await pool.execute(
        `INSERT IGNORE INTO role_permissions (role_id, permission_id)
         SELECT r.id, p.id FROM roles r, permissions p
         WHERE r.code = ? AND p.code = ?`,
        [roleCode, permCode]
      )
      if (result.affectedRows > 0) log(`  + ${roleCode} granted ${permCode}`)
    }
  }

  for (const cat of AD_CATEGORIES) {
    const [result] = await pool.execute(
      'INSERT IGNORE INTO ad_categories (id, code, name, description, icon) VALUES (?, ?, ?, ?, ?)',
      [uuidToBuffer(generateUuid()), cat.code, cat.name, cat.name, cat.icon]
    )
    if (result.affectedRows > 0) log(`  + Ad category created: ${cat.code}`)
  }

  for (const doc of IDENTITY_DOCUMENT_TYPES) {
    const [result] = await pool.execute(
      'INSERT IGNORE INTO identity_document_types (id, code, name, description, is_mandatory) VALUES (?, ?, ?, ?, 0)',
      [uuidToBuffer(generateUuid()), doc.code, doc.name, doc.description]
    )
    if (result.affectedRows > 0) log(`  + Identity doc type created: ${doc.code}`)
  }

  const planIds = {}
  for (const plan of SUBSCRIPTION_PLANS) {
    const id = generateUuid()
    planIds[plan.slug] = id
    const [result] = await pool.execute(
      'INSERT IGNORE INTO subscription_plans (id, name, slug, description, monthly_price, yearly_price, trial_days, display_order, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)',
      [uuidToBuffer(id), plan.name, plan.slug, plan.description, plan.monthly_price, plan.yearly_price, plan.trial_days, plan.display_order]
    )
    if (result.affectedRows > 0) log(`  + Subscription plan created: ${plan.slug}`)
  }

  const featureIds = {}
  for (const feat of SUBSCRIPTION_FEATURES) {
    const id = generateUuid()
    featureIds[feat.feature_key] = id
    const [result] = await pool.execute(
      'INSERT IGNORE INTO features (id, feature_key, name, description, category, unit, is_boolean) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuidToBuffer(id), feat.feature_key, feat.name, feat.description, feat.category, feat.unit, feat.is_boolean]
    )
    if (result.affectedRows > 0) log(`  + Feature created: ${feat.feature_key}`)
  }

  for (const [planSlug, entitlements] of Object.entries(PLAN_ENTITLEMENTS)) {
    for (const [featureKey, ent] of Object.entries(entitlements)) {
      const [result] = await pool.execute(
        'INSERT IGNORE INTO plan_features (id, plan_id, feature_id, is_enabled, value_type, value_int) VALUES (?, ?, ?, ?, ?, ?)',
        [uuidToBuffer(generateUuid()), uuidToBuffer(planIds[planSlug]), uuidToBuffer(featureIds[featureKey]), ent.is_enabled, ent.value_type, ent.value_int]
      )
      if (result.affectedRows > 0) log(`  + Entitlement ${planSlug}.${featureKey} created`)
    }
  }

  for (const config of APP_CONFIG_SEEDS) {
    const [existing] = await pool.execute('SELECT id FROM app_config WHERE config_key = ?', [config.key])
    if (existing.length === 0) {
      await pool.execute(
        'INSERT INTO app_config (id, config_key, config_value, is_public, description, version) VALUES (?, ?, ?, ?, ?, 1)',
        [uuidToBuffer(generateUuid()), config.key, JSON.stringify(config.value), config.is_public ?? 1, config.description]
      )
      log(`  + Config created: ${config.key}=${config.value}`)
    }
  }

  const metaAccountId = process.env.META_AD_ACCOUNT_ID
  if (metaAccountId) {
    const [rows] = await pool.execute('SELECT id FROM meta_ad_accounts WHERE account_id = ?', [metaAccountId])
    const monthlyCapPaise = parseInt(process.env.META_MONTHLY_CAP_PAISE || '0', 10)
    if (rows.length === 0) {
      await pool.execute(
        'INSERT INTO meta_ad_accounts (id, account_id, name, token_encrypted, monthly_cap_paise, is_primary, status) VALUES (?, ?, ?, NULL, ?, 1, \'active\')',
        [uuidToBuffer(generateUuid()), metaAccountId, 'Primary', monthlyCapPaise]
      )
      log(`  + Meta ad account created: ${metaAccountId} (primary, token from env only)`)
    } else {
      await pool.execute('UPDATE meta_ad_accounts SET is_primary = 1 WHERE account_id = ?', [metaAccountId])
      if (process.env.META_MONTHLY_CAP_PAISE) {
        await pool.execute('UPDATE meta_ad_accounts SET monthly_cap_paise = ? WHERE account_id = ?', [monthlyCapPaise, metaAccountId])
        log(`  + Meta ad account cap set: ${metaAccountId} = ₹${(monthlyCapPaise / 100).toFixed(2)}`)
      } else {
        log(`  ~ Meta ad account already present: ${metaAccountId}`)
      }
    }
  } else {
    log('  ~ Skipped meta ad account: META_AD_ACCOUNT_ID not set')
  }

  await seedUser({
    email: process.env.SUPER_ADMIN_EMAIL || 'admin@flowx.com',
    password: process.env.SUPER_ADMIN_PASSWORD || 'Admin@123',
    role: 'super_admin',
    coins: 0,
    firstName: 'Super',
    lastName: 'Admin',
  }, 'super admin')

  const wantsDemoClient = process.argv.includes('--demo-client')
  if (wantsDemoClient) {
    await seedUser({
      email: process.env.DEMO_CLIENT_EMAIL || 'demo@flowx.com',
      password: process.env.DEMO_CLIENT_PASSWORD || 'Demo@123',
      role: 'client',
      coins: parseInt(process.env.DEMO_CLIENT_COINS || '10000', 10),
      firstName: 'Demo',
      lastName: 'Client',
    }, 'demo client')
  } else {
    log('  SKIP demo client: pass --demo-client to create one')
  }

  const counts = {}
  for (const table of ['roles', 'permissions', 'role_permissions', 'oauth_providers', 'ad_categories', 'identity_document_types', 'subscription_plans', 'features', 'plan_features', 'app_config', 'users', 'user_wallets', 'meta_ad_accounts']) {
    const [rows] = await pool.execute(`SELECT COUNT(*) AS count FROM ${table}`)
    counts[table] = Number(rows[0].count) || 0
  }

  log('')
  log('Seed summary:')
  for (const [table, count] of Object.entries(counts)) {
    log(`  ${table}: ${count}`)
  }
  log('Done.')

  await closePool()
}

async function seedUser({ email, password, role, coins, firstName, lastName }, label) {
  const pool = getPool()
  const [existing] = await pool.execute(
    `SELECT u.id FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE r.code = ? AND u.email = ?`,
    [role, email]
  )
  if (existing.length > 0) {
    log(`  ~ ${label} already exists: ${email} (left untouched)`)
    return
  }

  const userId = generateUuid()
  const userIdBuf = uuidToBuffer(userId)
  const saltRounds = parseInt(process.env.SALT || '10', 10)
  const passwordHash = await bcrypt.hash(password, saltRounds)

  await pool.execute(
    'INSERT INTO users (id, email, phone, status, email_verified_at) VALUES (?, ?, NULL, \'active\', NOW())',
    [userIdBuf, email]
  )
  await pool.execute('INSERT INTO user_passwords (user_id, password_hash) VALUES (?, ?)', [userIdBuf, passwordHash])
  await pool.execute('INSERT INTO user_profiles (id, user_id, first_name, last_name) VALUES (?, ?, ?, ?)', [uuidToBuffer(generateUuid()), userIdBuf, firstName, lastName])
  await pool.execute(
    'INSERT INTO user_roles (id, user_id, role_id) SELECT ?, ?, r.id FROM roles r WHERE r.code = ?',
    [uuidToBuffer(generateUuid()), userIdBuf, role]
  )
  await pool.execute('INSERT INTO user_wallets (user_id, coins) VALUES (?, ?) ON DUPLICATE KEY UPDATE coins = coins', [userIdBuf, coins])
  log(`  + ${label} created: ${email} (role ${role})`)
}

main().catch((error) => {
  console.error('db:seed failed:', error)
  process.exit(1)
})