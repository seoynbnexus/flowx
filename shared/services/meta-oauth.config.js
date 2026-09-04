const META_APP_ID = process.env.META_APP_ID || ''
const META_APP_SECRET = process.env.META_APP_SECRET || ''
const META_REDIRECT_URI = process.env.META_REDIRECT_URI || 'http://localhost:3001/api/v1/publisher/accounts/oauth/callback'
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || ''
const META_SYSTEM_USER_TOKEN = process.env.META_SYSTEM_USER_TOKEN || ''
const GRAPH_VERSION = 'v25.0'

const SCOPES = [
  'instagram_basic',
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'pages_manage_metadata',
  'instagram_content_publish',
  'instagram_manage_comments',
  'instagram_manage_insights',
  'business_management',
  'ads_management',
  'ads_read',
  'pages_manage_ads',
]

if (process.env.META_OAUTH_INSIGHTS_SCOPE === '1') SCOPES.push('read_insights')

const AUTH_URL = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`
const TOKEN_URL = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`

export const META_CONFIG = {
  appId: META_APP_ID,
  appSecret: META_APP_SECRET,
  redirectUri: META_REDIRECT_URI,
  adAccountId: META_AD_ACCOUNT_ID,
  systemUserToken: META_SYSTEM_USER_TOKEN,
  graphVersion: GRAPH_VERSION,
  scopes: SCOPES,
  authUrl: AUTH_URL,
  tokenUrl: TOKEN_URL,
  graphUrl: GRAPH_URL,
}

export function isMetaConfigured() {
  return !!(META_APP_ID && META_APP_SECRET)
}

export function isAdsConfigured() {
  return !!(META_AD_ACCOUNT_ID && META_SYSTEM_USER_TOKEN)
}
