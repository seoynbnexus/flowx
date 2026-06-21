import jwt from 'jsonwebtoken';
import { AuthError, ForbiddenError } from '../errors/AppError.js';
import { ERROR_CODES } from '../errors/errorCodes.js';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';

export function authenticate(req, _res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new AuthError('Access token is required', ERROR_CODES.TOKEN_INVALID));
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      roles: decoded.roles || [],
      permissions: decoded.permissions || [],
    };
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return next(new AuthError('Access token expired', ERROR_CODES.TOKEN_EXPIRED));
    }
    return next(new AuthError('Invalid access token', ERROR_CODES.TOKEN_INVALID));
  }
}

export function optionalAuth(req, _res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      roles: decoded.roles || [],
      permissions: decoded.permissions || [],
    };
  } catch {
    req.user = null;
  }
  next();
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new AuthError('Authentication required', ERROR_CODES.AUTH_FAILED));
    }

    const hasRole = req.user.roles.some(role => roles.includes(role));
    if (!hasRole) {
      return next(new ForbiddenError('Insufficient role permissions'));
    }

    next();
  };
}

export function requirePermission(...permissions) {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new AuthError('Authentication required', ERROR_CODES.AUTH_FAILED));
    }

    if (req.user.roles.includes('super_admin')) {
      return next();
    }

    const hasPermission = permissions.some(p => req.user.permissions.includes(p));
    if (!hasPermission) {
      return next(new ForbiddenError('Insufficient permissions'));
    }

    next();
  };
}
