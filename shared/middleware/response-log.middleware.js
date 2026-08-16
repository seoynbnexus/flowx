export function responseLogger(req, res, next) {
  if (res.locals) res.locals._logBody = undefined

  const originalJson = res.json.bind(res)
  const originalSend = res.send.bind(res)

  res.json = (body) => {
    if (res.locals) {
      try {
        res.locals._logBody = typeof body === 'string' ? body : JSON.stringify(body)
      } catch {
        res.locals._logBody = undefined
      }
    }
    return originalJson(body)
  }

  res.send = (body) => {
    if (body != null && typeof body === 'object' && !Buffer.isBuffer(body)) {
      if (res.locals) {
        try {
          res.locals._logBody = JSON.stringify(body)
        } catch {
          res.locals._logBody = undefined
        }
      }
    } else if (typeof body === 'string' && res.locals) {
      res.locals._logBody = body
    }
    return originalSend(body)
  }

  next()
}
