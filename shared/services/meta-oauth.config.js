const META_APP_ID = process.env.META_APP_ID || ''
const META_APP_SECRET = process.env.META_APP_SECRET || ''
const META_REDIRECT_URI = process.env.META_REDIRECT_URI || 'http://localhost:3001/api/v1/publisher/accounts/oauth/callback'
const GRAPH_VERSION = 'v22.0'

const SCOPES = [
  'instagram_basic',
  'pages_show_list',
  'pages_read_engagement',
]

const AUTH_URL = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`
const TOKEN_URL = `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`

export const META_CONFIG = {
  appId: META_APP_ID,
  appSecret: META_APP_SECRET,
  redirectUri: META_REDIRECT_URI,
  graphVersion: GRAPH_VERSION,
  scopes: SCOPES,
  authUrl: AUTH_URL,
  tokenUrl: TOKEN_URL,
  graphUrl: GRAPH_URL,
}

export function isMetaConfigured() {
  return !!(META_APP_ID && META_APP_SECRET)
}
