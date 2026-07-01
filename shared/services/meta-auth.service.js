import { META_CONFIG } from './meta-oauth.config.js';

export function generateOAuthUrl(state, platformCode = 'instagram') {
  const params = new URLSearchParams({
    client_id: META_CONFIG.appId,
    redirect_uri: META_CONFIG.redirectUri,
    state: JSON.stringify({ state, platformCode }),
    scope: META_CONFIG.scopes.join(','),
    response_type: 'code',
  });
  return `${META_CONFIG.authUrl}?${params.toString()}`;
}

export async function exchangeCodeForToken(code) {
  const params = new URLSearchParams({
    client_id: META_CONFIG.appId,
    client_secret: META_CONFIG.appSecret,
    redirect_uri: META_CONFIG.redirectUri,
    code,
  });

  const res = await fetch(`${META_CONFIG.tokenUrl}?${params.toString()}`);
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  return res.json();
}

export async function exchangeForLongLivedToken(shortLivedToken) {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: META_CONFIG.appId,
    client_secret: META_CONFIG.appSecret,
    fb_exchange_token: shortLivedToken,
  });

  const res = await fetch(`${META_CONFIG.graphUrl}/oauth/access_token?${params.toString()}`);
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Long-lived token exchange failed: ${error}`);
  }

  return res.json();
}

export async function debugToken(inputToken) {
  const params = new URLSearchParams({
    input_token: inputToken,
    access_token: `${META_CONFIG.appId}|${META_CONFIG.appSecret}`,
  });

  const res = await fetch(`${META_CONFIG.graphUrl}/debug_token?${params.toString()}`);
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Token debug failed: ${error}`);
  }

  return res.json();
}

export async function refreshPageToken(pageId, userToken) {
  const params = new URLSearchParams({
    fields: 'access_token',
    access_token: userToken,
  });

  const res = await fetch(`${META_CONFIG.graphUrl}/${pageId}?${params.toString()}`);
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Page token refresh failed: ${error}`);
  }

  return res.json();
}

export function computeExpiresAt(expiresInSeconds) {
  if (!expiresInSeconds) return null;
  const date = new Date();
  date.setSeconds(date.getSeconds() + expiresInSeconds);
  return date;
}
