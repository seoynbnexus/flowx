import { HTTP_STATUS } from '../constants/httpStatus.js';

export function sendSuccess(res, data = null, message = 'Success', statusCode = HTTP_STATUS.OK) {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
  });
}

export function sendError(res, statusCode = HTTP_STATUS.INTERNAL_SERVER_ERROR, message = 'Internal server error', errors = null, code = null) {
  const body = { success: false, message };
  if (code) body.code = code;
  if (errors) body.errors = errors;
  return res.status(statusCode).json(body);
}

export function sendPaginated(res, data, pagination) {
  return res.status(HTTP_STATUS.OK).json({
    success: true,
    message: 'Success',
    data,
    pagination,
  });
}

export function sendCreated(res, data = null, message = 'Created successfully') {
  return sendSuccess(res, data, message, HTTP_STATUS.CREATED);
}

export function sendNoContent(res) {
  return res.status(HTTP_STATUS.NO_CONTENT).send();
}
