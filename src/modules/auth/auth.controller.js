import * as authService from './auth.service.js';
import { sendSuccess, sendCreated, sendError } from '../../../shared/utils/response.utils.js';
import { AUTH_COOKIE_NAME, REFRESH_TOKEN_COOKIE_OPTIONS } from './auth.model.js';

function setRefreshCookie(res, refreshToken) {
  res.cookie(AUTH_COOKIE_NAME, refreshToken, REFRESH_TOKEN_COOKIE_OPTIONS);
}

function clearRefreshCookie(res) {
  res.clearCookie(AUTH_COOKIE_NAME, { path: REFRESH_TOKEN_COOKIE_OPTIONS.path });
}

export async function sendRegistrationOtp(req, res, next) {
  try {
    await authService.sendRegistrationOtp(req.body.email);
    return sendSuccess(res, null, 'OTP sent to your email');
  } catch (error) {
    next(error);
  }
}

export async function verifyRegistrationOtp(req, res, next) {
  try {
    const result = await authService.verifyRegistrationOtp(req.body.email, req.body.otp);
    return sendSuccess(res, { verificationToken: result.verificationToken }, 'Email verified successfully');
  } catch (error) {
    next(error);
  }
}

export async function register(req, res, next) {
  try {
    const result = await authService.register(req.body, req.ip, req.headers['user-agent']);
    setRefreshCookie(res, result.refreshToken);
    return sendCreated(res, {
      user: result.user,
      accessToken: result.accessToken,
    }, 'Registration successful');
  } catch (error) {
    next(error);
  }
}

export async function login(req, res, next) {
  try {
    const { email, password, deviceName } = req.body;
    const result = await authService.login(email, password, deviceName, req.ip, req.headers['user-agent']);
    setRefreshCookie(res, result.refreshToken);
    return sendSuccess(res, {
      user: result.user,
      accessToken: result.accessToken,
    }, 'Login successful');
  } catch (error) {
    next(error);
  }
}

export async function refresh(req, res, next) {
  try {
    const refreshToken = req.cookies?.[AUTH_COOKIE_NAME] || req.body?.refreshToken;
    const result = await authService.refresh(refreshToken);
    setRefreshCookie(res, result.refreshToken);
    return sendSuccess(res, {
      user: result.user,
      accessToken: result.accessToken,
    }, 'Token refreshed');
  } catch (error) {
    next(error);
  }
}

export async function logout(req, res, next) {
  try {
    const refreshToken = req.cookies?.[AUTH_COOKIE_NAME] || req.body?.refreshToken;
    await authService.logout(refreshToken);
    clearRefreshCookie(res);
    return sendSuccess(res, null, 'Logged out successfully');
  } catch (error) {
    next(error);
  }
}

export async function forgotPassword(req, res, next) {
  try {
    await authService.forgotPassword(req.body.email);
    return sendSuccess(res, null, 'If an account with that email exists, a password reset link has been sent.');
  } catch (error) {
    next(error);
  }
}

export async function resetPassword(req, res, next) {
  try {
    const { token, password } = req.body;
    await authService.resetPassword(token, password);
    return sendSuccess(res, null, 'Password reset successfully');
  } catch (error) {
    next(error);
  }
}

export async function sendOtp(req, res, next) {
  try {
    const { phone, purpose } = req.body;
    const result = await authService.sendOtp(phone, purpose);
    return sendSuccess(res, { otp: result.otp }, 'OTP sent successfully');
  } catch (error) {
    next(error);
  }
}

export async function verifyOtp(req, res, next) {
  try {
    const { phone, otp, purpose } = req.body;
    const result = await authService.verifyOtp(phone, otp, purpose, req.ip, req.headers['user-agent']);
    if (result.accessToken) {
      setRefreshCookie(res, result.refreshToken);
      return sendSuccess(res, {
        user: result.user,
        accessToken: result.accessToken,
      }, 'OTP login successful');
    }
    return sendSuccess(res, result, 'OTP verified successfully');
  } catch (error) {
    next(error);
  }
}

export async function googleAuth(req, res, next) {
  try {
    const { accessToken } = req.body;
    const result = await authService.googleLogin(accessToken, req.ip, req.headers['user-agent']);
    setRefreshCookie(res, result.refreshToken);
    return sendSuccess(res, {
      user: result.user,
      accessToken: result.accessToken,
    }, 'Google login successful');
  } catch (error) {
    next(error);
  }
}
