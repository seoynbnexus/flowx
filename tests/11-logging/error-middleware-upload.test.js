import { describe, it, expect } from 'vitest'
import { errorHandler } from '../../shared/middleware/error.middleware.js'
import { ValidationError } from '../../shared/errors/AppError.js'

function fakeRes() {
  const out = { statusCode: null, body: null }
  out.status = (code) => {
    out.statusCode = code
    return out
  }
  out.json = (body) => {
    out.body = body
    return out
  }
  return out
}

const fakeReq = { method: 'POST', url: '/api/v1/media', log: null }

describe('errorHandler — interrupted media uploads', () => {
  it.each([
    'Request aborted',
    'Request closed',
    'Request error',
    'Unexpected end of form',
  ])('maps multer "%s" to 400', (message) => {
    const res = fakeRes()
    const err = new Error(message)
    errorHandler(err, fakeReq, res, () => {})
    expect(res.statusCode).toBe(400)
    expect(res.body.message).toBe('Upload interrupted — please retry')
    expect(res.body.code).toBe('VALIDATION_ERROR')
  })

  it('keeps MulterError LIMIT_FILE_SIZE as 422', () => {
    const res = fakeRes()
    const err = new Error('File too large')
    err.name = 'MulterError'
    err.code = 'LIMIT_FILE_SIZE'
    errorHandler(err, fakeReq, res, () => {})
    expect(res.statusCode).toBe(422)
    expect(res.body.message).toBe('File exceeds the maximum allowed size')
  })

  it('keeps ValidationError status untouched', () => {
    const res = fakeRes()
    errorHandler(new ValidationError('Invalid media type'), fakeReq, res, () => {})
    expect(res.statusCode).toBe(422)
  })
})
