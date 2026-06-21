export const USER_STATUS = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  BLOCKED: 'blocked',
  PENDING: 'pending',
};

export const AUDIT_ENTITY_TYPE = {
  USER: 'user',
  ROLE: 'role',
  OAUTH_ACCOUNT: 'oauth_account',
  SESSION: 'session',
};

export const LOGIN_METHOD = {
  EMAIL_PASSWORD: 'email_password',
  GOOGLE: 'google',
  GITHUB: 'github',
  PHONE_OTP: 'phone_otp',
};

export const OTP_PURPOSE = {
  PHONE_VERIFICATION: 'phone_verification',
  LOGIN: 'login',
  PASSWORD_RESET: 'password_reset',
};

export const TOKEN_TYPE = {
  ACCESS: 'access',
  REFRESH: 'refresh',
};

export const ROLE_CODES = {
  SUPER_ADMIN: 'super_admin',
  ADMIN: 'admin',
  PUBLISHER: 'publisher',
  CLIENT: 'client',
  SUPPORT_AGENT: 'support_agent',
};

export const DEFAULT_COUNTRY_CODE = 'IN';

export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
};
