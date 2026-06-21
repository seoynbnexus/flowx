import { HTTP_STATUS } from '../constants/httpStatus.js';
import { ERROR_CODES } from './errorCodes.js';

export class AppError extends Error {
  constructor(message, statusCode = HTTP_STATUS.INTERNAL_SERVER_ERROR, code = ERROR_CODES.INTERNAL_ERROR) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, HTTP_STATUS.NOT_FOUND, ERROR_CODES.NOT_FOUND);
    this.name = 'NotFoundError';
  }
}

export class AuthError extends AppError {
  constructor(message = 'Authentication failed', code = ERROR_CODES.AUTH_FAILED) {
    super(message, HTTP_STATUS.UNAUTHORIZED, code);
    this.name = 'AuthError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access denied') {
    super(message, HTTP_STATUS.FORBIDDEN, ERROR_CODES.FORBIDDEN);
    this.name = 'ForbiddenError';
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', errors = null, code = ERROR_CODES.VALIDATION_ERROR) {
    super(message, HTTP_STATUS.UNPROCESSABLE_ENTITY, code);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, HTTP_STATUS.CONFLICT, ERROR_CODES.CONFLICT);
    this.name = 'ConflictError';
  }
}
