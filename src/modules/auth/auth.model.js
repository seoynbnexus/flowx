export const AUTH_COOKIE_NAME = 'refresh_token';

export const TOKEN_EXPIRY = {
  ACCESS: process.env.JWT_ACCESS_EXPIRY || '2m',
  REFRESH: process.env.JWT_REFRESH_EXPIRY || '30d',
};

export const REFRESH_TOKEN_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/api/v1/auth/refresh',
  maxAge: 30 * 24 * 60 * 60 * 1000,
};
