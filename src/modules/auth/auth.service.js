import jwt from 'jsonwebtoken';
import * as repo from './auth.repository.js';
import { generateUuid, uuidToBuffer } from '../../../shared/utils/uuid.utils.js';
import {
  hashPassword,
  comparePassword,
  generateRandomToken,
  hashToken,
  generateOtp,
} from '../../../shared/utils/crypto.utils.js';
import { query, transaction } from '../../../shared/database/connection.js';
import { AuthError, ConflictError, ValidationError, ForbiddenError, MethodMismatchError } from '../../../shared/errors/AppError.js';
import { ERROR_CODES } from '../../../shared/errors/errorCodes.js';
import { TOKEN_EXPIRY } from './auth.model.js';
import { USER_STATUS, LOGIN_METHOD, OTP_PURPOSE, ROLE_CODES } from '../../../shared/constants/index.js';
import { sendOtpEmail, sendPasswordResetEmail } from '../../../shared/mailer/mailer.js';
import disposableDomains from 'disposable-email-domains/index.js';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'fallback-refresh-secret';

const EMAIL_OTP_PURPOSE = 'registration';
const OTP_EXPIRY_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

function generateAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      roles: user.roles,
      permissions: user.permissions,
    },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY.ACCESS }
  );
}

function generateRefreshToken(userId, sessionId) {
  return jwt.sign(
    { sub: userId, sid: sessionId },
    JWT_REFRESH_SECRET,
    { expiresIn: TOKEN_EXPIRY.REFRESH }
  );
}

function verifyRefreshToken(token) {
  return jwt.verify(token, JWT_REFRESH_SECRET);
}

export async function sendRegistrationOtp(email) {
  const normalizedEmail = email.toLowerCase();
  const domain = normalizedEmail.split('@')[1];
  if (disposableDomains.includes(domain)) {
    throw new ValidationError('Disposable email addresses are not allowed');
  }
  const existing = await repo.findUserByEmail(normalizedEmail);
  if (existing) {
    throw new ConflictError('Email already registered');
  }

  const otp = generateOtp();
  const otpHash = hashToken(otp);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);

  await repo.createEmailOtp(generateUuid(), normalizedEmail, otpHash, EMAIL_OTP_PURPOSE, expiresAt);
  await sendOtpEmail(normalizedEmail, otp);
}

export async function verifyRegistrationOtp(email, otp) {
  const normalizedEmail = email.toLowerCase();

  const otpRecord = await repo.findEmailOtp(normalizedEmail, EMAIL_OTP_PURPOSE);
  if (!otpRecord) {
    throw new ValidationError('No OTP found. Request a new one.', null, ERROR_CODES.NOT_FOUND);
  }

  if (otpRecord.attempts >= OTP_MAX_ATTEMPTS) {
    throw new ValidationError('Too many attempts. Request a new OTP.', null, ERROR_CODES.RATE_LIMITED);
  }

  if (new Date(otpRecord.expires_at) < new Date()) {
    throw new ValidationError('OTP has expired', null, ERROR_CODES.TOKEN_EXPIRED);
  }

  const otpHash = hashToken(otp);
  if (otpRecord.otp_hash !== otpHash) {
    await repo.incrementEmailOtpAttempts(otpRecord.id);
    throw new ValidationError('Invalid OTP');
  }

  await repo.useEmailOtp(otpRecord.id);

  const verificationToken = jwt.sign(
    { sub: normalizedEmail, purpose: 'registration' },
    JWT_SECRET,
    { expiresIn: '15m' }
  );

  return { verificationToken };
}

export async function register(data, ipAddress, userAgent) {
  let payload;
  try {
    payload = jwt.verify(data.verificationToken, JWT_SECRET);
  } catch {
    throw new AuthError('Invalid or expired verification token', ERROR_CODES.TOKEN_INVALID);
  }

  if (payload.purpose !== 'registration') {
    throw new AuthError('Invalid verification token', ERROR_CODES.TOKEN_INVALID);
  }

  const email = payload.sub;

  const existing = await repo.findUserByEmail(email);
  if (existing) {
    throw new ConflictError('Email already registered');
  }

  const userId = generateUuid();
  const passwordHash = await hashPassword(data.password);

  return transaction(async (conn) => {
    await repo.createUser(userId, email, USER_STATUS.ACTIVE, data.phone || null);
    await query(
      'UPDATE users SET email_verified_at = NOW() WHERE id = ?',
      [uuidToBuffer(userId)]
    );
    await repo.createAuditLog(
      generateUuid(), userId, 'user', userId,
      'user.email_verified', null, { email_verified_at: new Date() }
    );
    await repo.createUserProfile(generateUuid(), userId, {
      firstName: data.firstName,
      lastName: data.lastName,
      countryCode: data.countryCode || 'IN',
      state: data.state,
      city: data.city,
      pincode: data.pincode,
    });
    await repo.createUserPassword(userId, passwordHash);

    const role = data.role || ROLE_CODES.PUBLISHER;
    await repo.assignUserRole(userId, role);

    if (role === ROLE_CODES.CLIENT) {
      await query(
        'INSERT INTO user_wallets (user_id, coins) VALUES (?, ?) ON DUPLICATE KEY UPDATE coins = coins',
        [uuidToBuffer(userId), 10000]
      );
      await repo.createAuditLog(
        generateUuid(), userId, 'wallet', userId,
        'wallet.signup_bonus', null, { coins: 10000 }
      );
    }

    await repo.createAuditLog(generateUuid(), userId, 'user', userId, 'user.registered', null, { email, role });

    const user = await repo.findUserById(userId);
    user.roles = await repo.findUserRoles(userId);
    user.permissions = await repo.findUserPermissions(userId);

    await repo.updateUserLogin(userId);

    const accessToken = generateAccessToken(user);
    const { refreshToken } = await createSession(userId, null, ipAddress, conn);

    return {
      user: sanitizeUser(user),
      accessToken,
      refreshToken,
    };
  });
}

export async function login(email, password, deviceName, ipAddress, userAgent) {
  const user = await repo.findUserByEmail(email);
  if (!user) {
    await repo.createLoginHistory(generateUuid(), null, LOGIN_METHOD.EMAIL_PASSWORD, ipAddress, userAgent, false);
    throw new AuthError('Invalid email or password', ERROR_CODES.AUTH_FAILED);
  }

  if (user.status === USER_STATUS.BLOCKED) {
    throw new ForbiddenError('Account is blocked');
  }

  if (user.status === USER_STATUS.INACTIVE) {
    throw new ForbiddenError('Account is inactive');
  }

  const passwordRecord = await repo.getUserPassword(user.id);
  if (!passwordRecord) {
    const oauthAccounts = await repo.findOauthAccountsByUserId(user.id);
    if (oauthAccounts.length > 0) {
      throw new MethodMismatchError(
        `This account uses ${oauthAccounts[0].provider_name} Sign-In. Please sign in with ${oauthAccounts[0].provider_name}.`
      );
    }
    throw new AuthError('Invalid email or password', ERROR_CODES.AUTH_FAILED);
  }

  if (passwordRecord.locked_until && new Date(passwordRecord.locked_until) > new Date()) {
    throw new ForbiddenError('Account is temporarily locked. Try again later.');
  }

  const valid = await comparePassword(password, passwordRecord.password_hash);
  if (!valid) {
    await repo.incrementFailedAttempts(user.id);
    await repo.createLoginHistory(generateUuid(), user.id, LOGIN_METHOD.EMAIL_PASSWORD, ipAddress, userAgent, false);

    if (passwordRecord.failed_attempts + 1 >= 5) {
      const lockUntil = new Date(Date.now() + 15 * 60 * 1000);
      await repo.lockUserAccount(user.id, lockUntil);
      await repo.createAuditLog(
        generateUuid(), user.id, 'user', user.id,
        'user.locked', null,
        { failed_attempts: passwordRecord.failed_attempts + 1, locked_until: lockUntil }
      );
    }

    throw new AuthError('Invalid email or password', ERROR_CODES.AUTH_FAILED);
  }

  user.roles = await repo.findUserRoles(user.id);
  user.permissions = await repo.findUserPermissions(user.id);

  const accessToken = generateAccessToken(user);

  let createdSession;
  await transaction(async () => {
    await repo.resetFailedAttempts(user.id);
    await repo.updateUserLogin(user.id);
    await repo.createLoginHistory(generateUuid(), user.id, LOGIN_METHOD.EMAIL_PASSWORD, ipAddress, userAgent, true);
    createdSession = await createSession(user.id, deviceName, ipAddress);
  });

  return {
    user: sanitizeUser(user),
    accessToken,
    refreshToken: createdSession.refreshToken,
  };
}

export async function refresh(refreshToken) {
  if (!refreshToken) {
    throw new AuthError('Refresh token is required', ERROR_CODES.TOKEN_INVALID);
  }

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new AuthError('Invalid or expired refresh token', ERROR_CODES.TOKEN_EXPIRED);
  }

  const session = await repo.findSessionById(payload.sid);
  if (!session) {
    throw new AuthError('Session not found', ERROR_CODES.SESSION_EXPIRED);
  }

  const tokenHash = hashToken(refreshToken);
  if (session.refresh_token_hash !== tokenHash) {
    await repo.deleteSession(payload.sid);
    throw new AuthError('Refresh token has been revoked', ERROR_CODES.SESSION_REVOKED);
  }

  if (new Date(session.expires_at) < new Date()) {
    await repo.deleteSession(payload.sid);
    throw new AuthError('Refresh token expired', ERROR_CODES.TOKEN_EXPIRED);
  }

  const user = await repo.findUserById(payload.sub);
  if (!user || user.status !== USER_STATUS.ACTIVE) {
    await repo.deleteSession(payload.sid);
    throw new AuthError('User account is not active', ERROR_CODES.ACCOUNT_INACTIVE);
  }

  user.roles = await repo.findUserRoles(user.id);
  user.permissions = await repo.findUserPermissions(user.id);

  const accessToken = generateAccessToken(user);
  const newRefreshToken = generateRefreshToken(user.id, payload.sid);
  const newRefreshTokenHash = hashToken(newRefreshToken);
  const newExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const rotated = await repo.rotateSession(payload.sid, tokenHash, newRefreshTokenHash, newExpiresAt);
  if (!rotated) {
    throw new AuthError('Session has already been rotated', ERROR_CODES.SESSION_EXPIRED);
  }

  return {
    user: sanitizeUser(user),
    accessToken,
    refreshToken: newRefreshToken,
  };
}

export async function logout(refreshToken) {
  if (!refreshToken) return;

  try {
    const payload = verifyRefreshToken(refreshToken);
    await repo.deleteSession(payload.sid);
  } catch {
    // Token already invalid, ignore
  }
}

export async function forgotPassword(email) {
  const user = await repo.findUserByEmail(email);
  if (!user) {
    return;
  }

  const resetToken = generateRandomToken();
  const tokenHash = hashToken(resetToken);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  await repo.createPasswordReset(generateUuid(), user.id, tokenHash, expiresAt);

  await sendPasswordResetEmail(user.email, resetToken);
}

export async function resetPassword(token, newPassword) {
  const tokenHash = hashToken(token);
  const resetRecord = await repo.findPasswordReset(tokenHash);

  if (!resetRecord) {
    throw new ValidationError('Invalid or expired reset token', null, ERROR_CODES.TOKEN_INVALID);
  }

  if (new Date(resetRecord.expires_at) < new Date()) {
    throw new ValidationError('Reset token has expired', null, ERROR_CODES.TOKEN_EXPIRED);
  }

  const passwordHash = await hashPassword(newPassword);
  await transaction(async () => {
    await repo.usePasswordReset(tokenHash);
    await repo.updateUserPassword(resetRecord.user_id, passwordHash);
    await repo.deleteUserSessions(resetRecord.user_id);
    await repo.createAuditLog(
      generateUuid(), resetRecord.user_id, 'user', resetRecord.user_id,
      'user.password_reset', null, { method: 'reset_token' }
    );
  });
}

export async function googleLogin(accessToken, ipAddress, userAgent, role) {
  const { OAuth2Client } = await import('google-auth-library');
  const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);

  const ticket = await client.verifyIdToken({
    idToken: accessToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  const { email, name, sub, email_verified } = payload;

  let user = await repo.findUserByEmail(email);

  if (user) {
    const passwordRecord = await repo.getUserPassword(user.id);
    if (passwordRecord) {
      throw new ConflictError('An account with this email already exists. Please sign in with email and password.');
    }
  }

  const provider = await repo.findOauthProviderByCode('google');
  if (!provider) {
    throw new Error('Google OAuth provider not configured');
  }

  let createdSession;
  let accessTokenJwt;
  await transaction(async () => {
    if (!user) {
      const userId = generateUuid();
      const names = (name || '').split(' ');
      const firstName = names[0] || '';
      const lastName = names.slice(1).join(' ') || '';

      await repo.createUser(userId, email, USER_STATUS.ACTIVE);
      await repo.createUserProfile(generateUuid(), userId, { firstName, lastName });
      if (email_verified) {
        await repo.updateUserStatus(userId, USER_STATUS.ACTIVE);
        await query(
          'UPDATE users SET email_verified_at = NOW() WHERE id = ?',
          [uuidToBuffer(userId)]
        );
      }
      const assignedRole = role || ROLE_CODES.CLIENT;
      await repo.assignUserRole(userId, assignedRole);

      if (assignedRole === ROLE_CODES.CLIENT) {
        await query(
          'INSERT INTO user_wallets (user_id, coins) VALUES (?, ?) ON DUPLICATE KEY UPDATE coins = coins',
          [uuidToBuffer(userId), 10000]
        );
      }

      user = await repo.findUserById(userId);

      await repo.createAuditLog(
        generateUuid(), userId, 'user', userId,
        'user.registered', null,
        { email, method: 'google', name, email_verified }
      );
    }

    const oauthAccount = await repo.findOauthAccount(provider.id, sub);

    if (!oauthAccount) {
      await repo.createOauthAccount(
        generateUuid(), user.id, provider.id, sub, email, name
      );

      await repo.createAuditLog(
        generateUuid(), user.id, 'oauth_account', user.id,
        'oauth_account.linked', null,
        { provider: 'google', provider_user_id: sub, email }
      );
    }

    await repo.updateUserLogin(user.id);
    await repo.createLoginHistory(generateUuid(), user.id, LOGIN_METHOD.GOOGLE, ipAddress, userAgent, true, provider.id);

    user.roles = await repo.findUserRoles(user.id);
    user.permissions = await repo.findUserPermissions(user.id);

    accessTokenJwt = generateAccessToken(user);
    createdSession = await createSession(user.id, null, ipAddress);
  });

  return {
    user: sanitizeUser(user),
    accessToken: accessTokenJwt,
    refreshToken: createdSession.refreshToken,
  };
}

export async function sendOtp(phone, purpose) {
  const otp = generateOtp();
  const otpHash = hashToken(otp);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);

  let userId = null;
  if (purpose === OTP_PURPOSE.LOGIN || purpose === OTP_PURPOSE.PASSWORD_RESET) {
    const user = await repo.findUserByPhone(phone);
    if (user) userId = user.id;
  }

  await repo.createPhoneOtp(generateUuid(), userId, phone, otpHash, purpose, expiresAt);

  return { otp };
}

export async function verifyOtp(phone, otp, purpose, ipAddress, userAgent) {
  const otpHash = hashToken(otp);
  const otpRecord = await repo.findPhoneOtp(phone, purpose);

  if (!otpRecord) {
    throw new ValidationError('No OTP found. Request a new one.', null, ERROR_CODES.NOT_FOUND);
  }

  if (otpRecord.attempts >= OTP_MAX_ATTEMPTS) {
    throw new ValidationError('Too many attempts. Request a new OTP.', null, ERROR_CODES.RATE_LIMITED);
  }

  if (new Date(otpRecord.expires_at) < new Date()) {
    throw new ValidationError('OTP has expired', null, ERROR_CODES.TOKEN_EXPIRED);
  }

  if (otpRecord.otp_hash !== otpHash) {
    await repo.incrementOtpAttempts(otpRecord.id);
    throw new ValidationError('Invalid OTP');
  }

  await repo.usePhoneOtp(otpRecord.id);

  if (purpose === OTP_PURPOSE.LOGIN && otpRecord.user_id) {
    const user = await repo.findUserById(otpRecord.user_id);
    if (!user || user.status === USER_STATUS.BLOCKED || user.status === USER_STATUS.INACTIVE) {
      throw new AuthError('Account is not accessible', user?.status === USER_STATUS.BLOCKED ? ERROR_CODES.ACCOUNT_BLOCKED : ERROR_CODES.ACCOUNT_INACTIVE);
    }

    await repo.updateUserLogin(user.id);
    await repo.createLoginHistory(generateUuid(), user.id, LOGIN_METHOD.PHONE_OTP, ipAddress, userAgent, true);

    user.roles = await repo.findUserRoles(user.id);
    user.permissions = await repo.findUserPermissions(user.id);

    const accessToken = generateAccessToken(user);
    const { refreshToken } = await createSession(user.id, null, ipAddress);

    return {
      user: sanitizeUser(user),
      accessToken,
      refreshToken,
    };
  }

  return { userId: otpRecord.user_id };
}

async function createSession(userId, deviceName, ipAddress) {
  const sessionId = generateUuid();
  const refreshToken = generateRefreshToken(userId, sessionId);
  const refreshTokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await repo.createSession(sessionId, userId, refreshTokenHash, expiresAt, deviceName, ipAddress);

  return { refreshToken, sessionId };
}

function sanitizeUser(user) {
  const { deleted_at, ...rest } = user;
  return rest;
}
