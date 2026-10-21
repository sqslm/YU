/** An error with an HTTP status, so handlers can `throw` instead of plumbing codes. */
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // Account data must never sit in a shared cache.
    'cache-control': 'no-store',
    ...headers
  })
  res.end(payload)
}

/**
 * Reads and parses a JSON body, refusing anything larger than `limit`.
 *
 * The size check happens while streaming, so a hostile client cannot make the
 * server buffer a gigabyte before the check runs.
 */
export async function readJson(req, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new HttpError(413, 'payload_too_large', '请求体过大')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'bad_json', '请求体不是合法的 JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'bad_json', '请求体必须是 JSON 对象')
  }
  return parsed
}

/** `'/users/:id'` → a regex plus the ordered parameter names. */
function compile(pattern) {
  const keys = []
  const source = pattern
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      keys.push(segment.slice(1))
      return '([^/]+)'
    })
    .join('/')
  return { regex: new RegExp(`^${source}$`), keys }
}

export class Router {
  constructor() {
    this.routes = []
  }

  add(method, pattern, handler) {
    this.routes.push({ method, ...compile(pattern), handler })
    return this
  }

  get(pattern, handler) {
    return this.add('GET', pattern, handler)
  }

  post(pattern, handler) {
    return this.add('POST', pattern, handler)
  }

  put(pattern, handler) {
    return this.add('PUT', pattern, handler)
  }

  delete(pattern, handler) {
    return this.add('DELETE', pattern, handler)
  }

  /**
   * Returns the matching route and its decoded parameters, or a 404/405 error.
   * The method is part of the lookup so that `/x` with the wrong verb reports
   * "method not allowed" instead of a confusing 404. `HEAD` falls back to the
   * `GET` handler, which is the only correct default for a read-only route.
   */
  find(method, pathname) {
    let pathMatched = false
    let headFallback = null
    for (const route of this.routes) {
      const match = route.regex.exec(pathname)
      if (!match) continue
      pathMatched = true
      if (route.method !== method) {
        if (method === 'HEAD' && route.method === 'GET') headFallback = { route, match }
        continue
      }
      const params = {}
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(match[index + 1])
      })
      return { handler: route.handler, params }
    }
    if (headFallback) {
      const params = {}
      headFallback.route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(headFallback.match[index + 1])
      })
      return { handler: headFallback.route.handler, params }
    }
    if (pathMatched) throw new HttpError(405, 'method_not_allowed', '不支持该请求方法')
    throw new HttpError(404, 'not_found', '没有这个接口')
  }
}
