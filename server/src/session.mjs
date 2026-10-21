import { randomUUID } from 'node:crypto'
import { HttpError } from './http.mjs'
import { hashToken, newToken } from './password.mjs'

/**
 * Server-side, revocable sessions.
 *
 * The first version used self-contained JWTs, which look simpler until the first
 * "log out everywhere" or "this account is disabled" requirement: a signed token
 * stays valid until it expires and there is nothing to revoke. Two random tokens
 * in a table cost one indexed lookup per request and make logout, password reset
 * and admin disable instantaneous.
 *
 * Only hashes are stored. The access token is short-lived; the refresh token is
 * rotated on every use, so a stolen copy stops working the moment the real client
 * refreshes.
 */

/** `Authorization: Bearer <token>` → token, or null. */
export function readBearer(req) {
  const header = req.headers.authorization
  if (typeof header !== 'string') return null
  const [scheme, token] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null
  return token
}

function sessionRowByAccess(db, token) {
  return db.prepare('SELECT * FROM sessions WHERE access_hash = ?').get(hashToken(token))
}

function sessionRowByRefresh(db, token) {
  return db.prepare('SELECT * FROM sessions WHERE refresh_hash = ?').get(hashToken(token))
}

/** Creates a session and returns the two tokens plus the lifetime to publish. */
export function issueSession(db, config, user, userAgent) {
  const accessToken = newToken()
  const refreshToken = newToken()
  const now = Date.now()
  db.prepare(
    `INSERT INTO sessions
       (id, user_id, access_hash, refresh_hash, created_at, access_expires_at, refresh_expires_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    user.id,
    hashToken(accessToken),
    hashToken(refreshToken),
    now,
    now + config.accessTtlSeconds * 1000,
    now + config.refreshTtlSeconds * 1000,
    typeof userAgent === 'string' ? userAgent.slice(0, 200) : null
  )
  return { accessToken, refreshToken, expiresIn: config.accessTtlSeconds }
}

/**
 * Resolves the caller, re-reading the account row.
 *
 * The row is re-read on every request on purpose: a disabled account or a
 * revoked session must take effect now, not when a cached token happens to
 * expire.
 */
export function requireUser(ctx) {
  const token = readBearer(ctx.req)
  if (!token) throw new HttpError(401, 'unauthorized', '请先登录')
  const session = sessionRowByAccess(ctx.db, token)
  if (!session || session.revoked_at !== null || Number(session.access_expires_at) <= ctx.now) {
    throw new HttpError(401, 'unauthorized', '登录状态已失效，请重新登录')
  }
  const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id)
  if (!user) throw new HttpError(401, 'unauthorized', '账号不存在')
  if (Number(user.disabled) === 1) throw new HttpError(403, 'account_disabled', '账号已被停用')
  user.session_id = session.id
  return user
}

/** The caller when a token is present and valid, otherwise null. */
export function optionalUser(ctx) {
  try {
    return requireUser(ctx)
  } catch {
    return null
  }
}

/**
 * Spends a refresh token and hands back a fresh pair.
 *
 * Rotation is what makes a leaked refresh token short-lived: the second use of
 * the old value is a miss because the row no longer carries its hash.
 */
export function rotateSession(ctx) {
  const presented = typeof ctx.body?.refreshToken === 'string' ? ctx.body.refreshToken.trim() : ''
  if (!presented) throw new HttpError(400, 'missing_token', '缺少 refreshToken')
  const session = sessionRowByRefresh(ctx.db, presented)
  if (!session || session.revoked_at !== null || Number(session.refresh_expires_at) <= ctx.now) {
    throw new HttpError(401, 'refresh_invalid', '登录已过期，请重新登录')
  }
  const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id)
  if (!user || Number(user.disabled) === 1) {
    ctx.db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').run(ctx.now, session.id)
    throw new HttpError(401, 'refresh_invalid', '登录已过期，请重新登录')
  }
  const accessToken = newToken()
  const refreshToken = newToken()
  ctx.db
    .prepare(
      `UPDATE sessions
          SET access_hash = ?, refresh_hash = ?, access_expires_at = ?, refresh_expires_at = ?
        WHERE id = ?`
    )
    .run(
      hashToken(accessToken),
      hashToken(refreshToken),
      ctx.now + ctx.config.accessTtlSeconds * 1000,
      ctx.now + ctx.config.refreshTtlSeconds * 1000,
      session.id
    )
  return {
    accessToken,
    refreshToken,
    expiresIn: ctx.config.accessTtlSeconds,
    user
  }
}

/** Revokes one session by whichever token the caller still holds. */
export function revokeToken(db, token, now = Date.now()) {
  if (!token) return 0
  const hash = hashToken(token)
  const result = db
    .prepare('UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL AND (refresh_hash = ? OR access_hash = ?)')
    .run(now, hash, hash)
  return Number(result.changes ?? 0)
}

export function revokeSession(db, sessionId, now = Date.now()) {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, sessionId)
}

/** Logout everywhere: used by a password reset. */
export function revokeAllSessions(db, userId, now = Date.now()) {
  const result = db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now, userId)
  return Number(result.changes ?? 0)
}

export function subscriptionOf(user, now = Date.now()) {
  const trialActive = user.plan === 'trial' && Number(user.trial_ends_at ?? 0) > now
  const paidActive =
    user.plan === 'pro' && (user.current_period_end === null || Number(user.current_period_end) > now)
  return {
    plan: user.plan,
    active: trialActive || paidActive,
    trialEndsAt: user.trial_ends_at ? Number(user.trial_ends_at) : null,
    currentPeriodEnd: user.current_period_end ? Number(user.current_period_end) : null,
    cancelAtPeriodEnd: Boolean(user.cancel_at_period_end)
  }
}

/** The account as the client sees it: no hash, no salt, no internal flags. */
export function publicUser(user, now = Date.now()) {
  return {
    id: user.id,
    email: user.email,
    createdAt: Number(user.created_at),
    isAdmin: Number(user.is_admin ?? 0) === 1,
    subscription: subscriptionOf(user, now)
  }
}

/** Per-user quota: an explicit admin value, otherwise the deployment default. */
export function quotaBytesFor(user, config) {
  const explicit = Number(user.storage_quota_bytes ?? 0)
  return explicit > 0 ? explicit : config.defaultStorageQuotaBytes
}
