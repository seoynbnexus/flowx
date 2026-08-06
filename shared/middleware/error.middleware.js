import { sendError } from '../utils/response.utils.js';
import { AppError } from '../errors/AppError.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { ERROR_CODES } from '../errors/errorCodes.js';
import { logger } from '../utils/logger.js';

function logError(level, statusCode, code, req, err) {
  const log = req.log || logger;
  const entry = {
    method: req.method,
    url: req.url,
    statusCode,
    code,
    message: err.message,
  };
  if (process.env.NODE_ENV === 'development') {
    entry.stack = err.stack;
  }
  log[level](entry);
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    const level = err.statusCode >= 500 ? 'error' : 'warn';
    logError(level, err.statusCode, err.code, req, err);
    const message = err.statusCode >= 500 && process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message;
    return sendError(res, err.statusCode, message, err.errors || null, err.code);
  }

  if (err.name === 'ZodError') {
    const errors = err.issues.map(e => ({
      field: e.path.join('.'),
      message: e.message,
    }));
    logError('warn', HTTP_STATUS.UNPROCESSABLE_ENTITY, ERROR_CODES.VALIDATION_ERROR, req, err);
    return sendError(res, HTTP_STATUS.UNPROCESSABLE_ENTITY, 'Validation failed', errors, ERROR_CODES.VALIDATION_ERROR);
  }

  if (err.name === 'JsonWebTokenError') {
    logError('warn', HTTP_STATUS.UNAUTHORIZED, ERROR_CODES.TOKEN_INVALID, req, err);
    return sendError(res, HTTP_STATUS.UNAUTHORIZED, 'Invalid or expired token', null, ERROR_CODES.TOKEN_INVALID);
  }

  if (err.name === 'TokenExpiredError') {
    logError('warn', HTTP_STATUS.UNAUTHORIZED, ERROR_CODES.TOKEN_EXPIRED, req, err);
    return sendError(res, HTTP_STATUS.UNAUTHORIZED, 'Invalid or expired token', null, ERROR_CODES.TOKEN_EXPIRED);
  }

  if (err.type === 'entity.too.large') {
    logError('warn', HTTP_STATUS.UNPROCESSABLE_ENTITY, ERROR_CODES.VALIDATION_ERROR, req, err);
    return sendError(res, HTTP_STATUS.UNPROCESSABLE_ENTITY, 'Request body too large', null, ERROR_CODES.VALIDATION_ERROR);
  }

  logError('error', HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_CODES.INTERNAL_ERROR, req, err);

  const message = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message;

  return sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, message, null, ERROR_CODES.INTERNAL_ERROR);
}
