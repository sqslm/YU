import { createServer } from 'node:http'
import { openDatabase } from './db.mjs'
import { HttpError, Router, readJson, send } from './http.mjs'
import { createLogger } from './log.mjs'
import { createMailer } from './mail.mjs'
import { RateLimiter } from './ratelimit.mjs'
import { registerAuthRoutes } from './routes/auth.mjs'
import { registerMetaRoutes } from './routes/meta.mjs'
import { registerNoteRoutes } from './routes/notes.mjs'
import { registerSyncRoutes } from './routes/sync.mjs'
import { registerUserRoutes } from './routes/user.mjs'
import { SERVER_VERSION } from './version.mjs'

const CLIENT_IP_TRUSTED = Symbol('clientIp')

/**
 * Builds the HTTP server, the database handle and the router.
 *
 * Everything mutable is created here and torn down by `server.close()`, so tests
 * can start a real server on port 0 without touching environment variables.
 */
export function createApp({ config, logger, db = openDatabase(config.dataDir) }) {
  const log = logger ?? createLogger({ level: config.logLevel })
  const mailer = createMailer(config, log)
  const startedAt = Date.now()

  const rateLimiter = new RateLimiter(config.rateLimitPerMinute)
  const authLimiter = new RateLimiter(config.authLimitPerMinute)
  const codeIpLimiter = new RateLimiter(config.codeLimitPerHourPerIp, 3600_000)
  const codeEmailLimiter = new RateLimiter(config.codeLimitPerHourPerEmail, 3600_000)

  const router = new Router()
  router.get('/health', async (ctx) => ({
    ok: true,
    version: SERVER_VERSION,
    uptimeSeconds: Math.floor((ctx.now - startedAt) / 1000),
    time: new Date(ctx.now).toISOString()
  }))
  router.get('/api/v1/health', async (ctx) => ({
    ok: true,
    version: SERVER_VERSION,
    uptimeSeconds: Math.floor((ctx.now - startedAt) / 1000),
    time: new Date(ctx.now).toISOString()
  }))

  registerMetaRoutes(router)
  registerAuthRoutes(router)
  registerUserRoutes(router)
  registerNoteRoutes(router)
  // Kept so existing builds that already sync the dictation history stay working.
  registerSyncRoutes(router)

  function clientIp(req) {
    if (config.trustProxy) {
      const header = req.headers['x-forwarded-for']
      const first = Array.isArray(header) ? header[0] : header
      if (typeof first === 'string') {
        const candidate = first.split(',')[0].trim()
        if (candidate) return candidate
      }
    }
    return req.socket.remoteAddress ?? 'unknown'
  }

  /** Last-resort mapping for unexpected throws; internal text never leaves. */
  function errorBody(error) {
    if (error instanceof HttpError) {
      return { status: error.status, body: { error: error.code, message: error.message } }
    }
    log.error('unhandled request error', error)
    return { status: 500, body: { error: 'internal_error', message: '服务器内部错误' } }
  }

  const server = createServer(async (req, res) => {
    const startedAtRequest = Date.now()
    const url = new URL(req.url ?? '/', 'http://localhost')
    const ip = clientIp(req)

    res.setHeader('x-content-type-options', 'nosniff')
    if (config.corsOrigin) {
      res.setHeader('access-control-allow-origin', config.corsOrigin)
      res.setHeader('access-control-allow-headers', 'authorization, content-type')
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
      res.setHeader('access-control-expose-headers', 'content-type, content-length, etag, retry-after')
    }

    let status = 0
    try {
      if (req.method === 'OPTIONS') {
        status = 204
        res.writeHead(204)
        res.end()
        return
      }

      if (rateLimiter.enabled && !rateLimiter.take(ip).ok) {
        throw new HttpError(429, 'rate_limited', '请求过于频繁，请稍后再试')
      }

      const authPath = url.pathname.startsWith('/api/v1/auth/')
      if (authPath && authLimiter.enabled && !authLimiter.take(`${ip}:${url.pathname}`).ok) {
        throw new HttpError(429, 'rate_limited', '请求过于频繁，请稍后再试')
      }

      const match = router.find(req.method ?? 'GET', url.pathname)
      if (!match) throw new HttpError(404, 'not_found', '没有这个接口')

      const contentType = String(req.headers['content-type'] ?? '')
      // Audio uploads keep their body for the streaming reader; JSON endpoints
      // get a parsed object and never see the raw stream.
      const body = contentType.includes('application/json')
        ? await readJson(req, config.maxJsonBytes)
        : {}

      const ctx = {
        db,
        config,
        log: (message) => log.log(message),
        logger: log,
        mailer,
        now: Date.now(),
        ip,
        req,
        res,
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        params: match.params,
        body,
        rateLimiter,
        authLimiter,
        codeIpLimiter,
        codeEmailLimiter,
        setClientIp: undefined,
        reply: (statusCode, payload) => {
          send(res, statusCode, payload)
          return undefined
        }
      }

      let result
      try {
        result = await match.handler(ctx)
      } catch (error) {
        if (res.headersSent) {
          // A streamed response already started; all we can do is cut it.
          log.error(`${req.method} ${url.pathname} failed mid-response`, error)
          res.destroy()
          status = 500
          return
        }
        throw error
      }

      if (res.headersSent || res.writableEnded) {
        if (!status) status = 200
        return
      }
      if (result === undefined) {
        status = 204
        res.writeHead(204)
        res.end()
        return
      }
      status = 200
      send(res, 200, result)
    } catch (error) {
      if (res.headersSent || res.writableEnded) {
        log.error(`${req.method} ${url.pathname} failed after headers`, error)
        res.destroy()
        return
      }
      const { status: code, body: payload } = errorBody(error)
      status = code
      const headers = {}
      applyRetryAfter(res, headers)
      send(res, code, payload, headers)
    } finally {
      log.log(
        `${req.method} ${url.pathname} ${status || 0} ${Date.now() - startedAtRequest}ms ${ip}`
      )
    }
  })

  // Keeps the in-memory limiter maps from growing with every port scanner.
  const sweeper = setInterval(() => {
    const now = Date.now()
    rateLimiter.sweep(now)
    authLimiter.sweep(now)
    codeIpLimiter.sweep(now)
    codeEmailLimiter.sweep(now)
  }, 60_000)
  sweeper.unref()

  const close = () => {
    clearInterval(sweeper)
    db.close()
  }

  return { server, db, router, log, mailer, close }
}

function applyRetryAfter(res, headers) {
  const value = res.getHeader('retry-after')
  if (value !== undefined) headers['retry-after'] = String(value)
}

export { CLIENT_IP_TRUSTED }
