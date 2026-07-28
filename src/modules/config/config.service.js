import * as authRepo from '../auth/auth.repository.js';
import * as adCategoryRepo from '../ad-categories/ad-category.repository.js';
import * as publisherRepo from '../publisher-platforms/publisher.repository.js';
import * as identityRepo from '../identity-documents/identity.repository.js';
import * as aiRepo from '../ai/ai.repository.js';
import * as subService from '../subscriptions/subscription.service.js';
import { query } from '../../../shared/database/connection.js';
import {
  IDENTITY_STATUS,
  USER_STATUS,
} from '../../../shared/constants/index.js';

const STATUS_LABELS = {
  pending: 'Pending',
  verified: 'Verified',
  rejected: 'Rejected',
  active: 'Active',
  inactive: 'Inactive',
  blocked: 'Blocked',
};

function transformConfigRows(rows) {
  const config = {};
  for (const row of rows) {
    const value = typeof row.config_value === 'string'
      ? JSON.parse(row.config_value)
      : row.config_value;
    config[row.config_key] = value;
  }
  return config;
}

function mapEnumToOptions(enumObj, labelMap) {
  return Object.values(enumObj).map(value => ({
    value,
    label: labelMap[value] || value,
  }));
}

async function getCountryCodes() {
  const rows = await query(
    'SELECT code, iso2, name, pattern FROM country_codes WHERE is_active = 1 ORDER BY priority ASC, name ASC'
  );
  return rows.map(r => ({
    code: r.code,
    iso2: r.iso2,
    name: r.name,
    pattern: r.pattern,
  }));
}

async function getDropdownOptions() {
  const [platforms, roles, docTypes] = await Promise.all([
    publisherRepo.findAllPlatforms(),
    query("SELECT code, name FROM roles WHERE code IN ('publisher', 'client', 'admin')"),
    query('SELECT code, name, is_mandatory FROM identity_document_types WHERE is_active = 1 ORDER BY code'),
  ]);

  return {
    documentTypes: docTypes.map(d => ({
      value: d.code,
      label: d.name,
      isMandatory: !!d.is_mandatory,
    })),
    platformTypes: platforms.map(p => ({ value: p.code, label: p.name })),
    roleOptions: roles.map(r => ({ value: r.code, label: r.name })),
    identityStatuses: mapEnumToOptions(IDENTITY_STATUS, STATUS_LABELS),
    accountStatuses: mapEnumToOptions(IDENTITY_STATUS, STATUS_LABELS),
    userStatuses: mapEnumToOptions(USER_STATUS, STATUS_LABELS),
  };
}

export async function getPublicConfig() {
  const [staticRows, dropdownOptions, countryCodes] = await Promise.all([
    query('SELECT config_key, config_value FROM app_config WHERE is_public = 1'),
    getDropdownOptions(),
    getCountryCodes(),
  ]);
  const raw = transformConfigRows(staticRows);

  return {
    theme: raw.theme || null,
    app: raw.app_settings || null,
    features: raw.feature_flags || null,
    formRules: raw.form_rules || null,
    dropdownOptions,
    countryCodes,
    pagination: raw.pagination || null,
    uploads: raw.uploads || null,
    coinConversionRate: raw.coin_conversion_rate ?? null,
  };
}

export async function getFullConfig(userId) {
  const publicConfig = await getPublicConfig();

  const user = await authRepo.findUserById(userId);
  if (!user) {
    return { ...publicConfig, user: null };
  }

  const roles = await authRepo.findUserRoles(userId);
  const permissions = await authRepo.findUserPermissions(userId);
  const categories = await adCategoryRepo.findAllCategories(false);
  const userCategoryRows = await adCategoryRepo.findUserCategories(userId);
  const platformAccounts = await publisherRepo.listAccountsByUser(userId);
  const identityDocuments = await identityRepo.findByUserId(userId);

  const isPublisher = roles.includes('publisher')
  const coinService = await import('../../../shared/services/coin.service.js')
  const coinInfo = isPublisher ? null : await coinService.getAvailable(userId).catch(() => null)
  const [aiHistoryResult, aiBlocked] = await Promise.all([
    aiRepo.findContentByUserId(userId, { page: 1, limit: 5, type: undefined }),
    aiRepo.findBlockedStatus(userId),
  ]);
  let subscription = null
  if (!isPublisher) {
    const [entitlements, allUsage] = await Promise.all([
      subService.getUserEntitlements(userId),
      subService.getAllUsage(userId),
    ])
    subscription = {
      plan: entitlements.plan,
      features: entitlements.features,
      usage: allUsage,
    }
  }

  return {
    ...publicConfig,
    subscription,
    user: {
      id: user.id,
      email: user.email,
      phone: user.phone || null,
      firstName: user.first_name || null,
      lastName: user.last_name || null,
      avatarUrl: user.avatar_url || null,
      state: user.state || null,
      city: user.city || null,
      pincode: user.pincode || null,
      roles,
      permissions,
      isEmailVerified: !!user.email_verified_at,
      countryCode: user.country_code || 'IN',
      status: user.status,
      createdAt: user.created_at,
    },
    categories,
    userCategories: userCategoryRows.map(c => c.id),
    platformAccounts,
    identityDocuments,
    ai: {
      balance: coinInfo ? coinInfo.total : 0,
      monthlyRemaining: coinInfo ? coinInfo.monthlyRemaining : null,
      topupBalance: coinInfo ? coinInfo.topupBalance : 0,
      monthlyLimit: coinInfo ? coinInfo.limit : null,
      monthlyUsed: coinInfo ? coinInfo.used : 0,
      periodStart: coinInfo ? coinInfo.periodStart : null,
      periodEnd: coinInfo ? coinInfo.periodEnd : null,
      history: aiHistoryResult.items,
      isBlocked: aiBlocked,
    },
  };
}
