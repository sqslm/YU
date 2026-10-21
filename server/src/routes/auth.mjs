import { randomInt, randomUUID } from 'node:crypto'
import { HttpError } from '../http.mjs'
import { hashPassword, hashToken, verifyPassword } from '../password.mjs'
import { issueSession, publicUser, readBearer, requireUser, revokeAllSessions, revokeToken, rotateSession } from '../session.mjs'
import { readMeta } from '../db.mjs'
import { verificationEmail } from '../mail.mjs'

const MIN_PASSWORD = 8
const MAX_PASSWORD = 200
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const CODE = /^\d{6}$/

function normaliseEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (email.length < 3 || email.length > 254 || !EMAIL.test(email)) {
    throw new HttpError(400, 'bad_email', '邮箱格式不正确')
  }
  return email
}

function checkPassword(value) {
  const password = typeof value === 'string' ? value : ''
  if (password.length < MIN_PASSWORD) {
    throw new HttpError(400, 'weak_password', `密码至少 ${MIN_PASSWORD} 位`)
  }
  if (password.length > MAX_PASSWORD) {
    throw new HttpError(400, 'weak_password', '密码太长')
  }
  return password
}

/**
 * Six digits, uniformly drawn. Never `Math.random`: a code space this small is
 * one prediction away from an account.
 */
function newCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/**
 * Public registration can be switched at runtime by the admin CLI, which stores
 * the decision in `meta`. An absent key means "use the boot configuration".
 */
export function registrationOpen(ctx) {
  const override = readMeta(ctx.db, 'registration_enabled')
  if (override === '1') return true
  if (override === '0') return false
  return ctx.config.registrationEnabled
}

/**
 * Verifies and burns the code for `email`/`purpose`.
 *
 * Both sides are hashed and compared as strings of equal shape; a plain compare
 * of a six-digit code leaks the position of the first wrong digit through
 * timing, which is enough to walk the space. A spent code is deleted, so one
 * code authorises exactly one action.
 */
function consumeCode(ctx, email, purpose, raw) {
  const code = typeof raw === 'string' ? raw.trim() : ''
  if (!CODE.test(code)) throw new HttpError(400, 'bad_code', '请输入 6 位验证码')
  const row = ctx.db
    .prepare('SELECT * FROM email_codes WHERE email = ? AND purpose = ?')
    .get(email, purpose)
  if (!row) throw new HttpError(400, 'code_invalid', '验证码已失效，请重新发送')
  if (Number(row.expires_at) <= ctx.now) {
    ctx.db.prepare('DELETE FROM email_codes WHERE email = ? AND purpose = ?').run(email, purpose)
    throw new HttpError(400, 'code_expired', '验证码已过期，请重新发送')
  }
  if (Number(row.attempts) >= ctx.config.codeMaxAttempts) {
    ctx.db.prepare('DELETE FROM email_codes WHERE email = ? AND purpose = ?').run(email, purpose)
    throw new HttpError(429, 'too_many_attempts', '试错次数太多，请重新获取验证码')
  }
  if (hashToken(code) !== row.code_hash) {
    const attempts = Number(row.attempts) + 1
    if (attempts >= ctx.config.codeMaxAttempts) {
      ctx.db.prepare('DELETE FROM email_codes WHERE email = ? AND purpose = ?').run(email, purpose)
      ctx.log(`[auth] code for ${email} burnt after ${attempts} attempts`)
    } else {
      ctx.db
        .prepare('UPDATE email_codes SET attempts = ? WHERE email = ? AND purpose = ?')
        .run(attempts, email, purpose)
    }
    throw new HttpError(400, 'bad_code', '验证码不正确')
  }
  ctx.db.prepare('DELETE FROM email_codes WHERE email = ? AND purpose = ?').run(email, purpose)
}

function authPayload(ctx, user, tokens) {
  return { ...tokens, user: publicUser(user, ctx.now) }
}

export function registerAuthRoutes(router) {
  /**
   * Sends a sign-up or password-reset code.
   *
   * The response shape and status do not depend on whether the address exists:
   * an endpoint that answers "this mailbox is not registered" turns the
   * password-reset form into an account oracle. Registration itself is the one
   * place where a duplicate has to be reported, and that is documented.
   */
  router.post('/api/v1/auth/code', async (ctx) => {
    const body = ctx.body
    const email = normaliseEmail(body.email)
    const purpose = body.purpose === 'reset' ? 'reset' : 'register'

    if (!ctx.config.emailVerificationRequired && purpose === 'register') {
      return { ok: true, sent: false, required: false }
    }
    if (purpose === 'register' && !registrationOpen(ctx)) {
      throw new HttpError(403, 'registration_closed', '这个服务器没有开放注册')
    }
    if (!ctx.config.smtpConfigured) {
      throw new HttpError(503, 'email_not_configured', '服务器没有配置 SMTP，无法发送验证码')
    }

    const user = ctx.db.prepare('SELECT id FROM users WHERE email = ?').get(email)
    // Duplicate sign-up and unknown reset look identical from the outside.
    if ((purpose === 'register' && user) || (purpose === 'reset' && !user)) {
      return { ok: true, sent: true, required: true, expiresIn: ctx.config.codeTtlSeconds }
    }

    const ipLimited = ctx.codeIpLimiter.take(ctx.ip)
    if (!ipLimited.ok) {
      ctx.res.setHeader('retry-after', String(ipLimited.retryAfter))
      throw new HttpError(429, 'rate_limited', '获取验证码太频繁，请稍后再试')
    }
    const emailLimited = ctx.codeEmailLimiter.take(email)
    if (!emailLimited.ok) {
      ctx.res.setHeader('retry-after', String(emailLimited.retryAfter))
      throw new HttpError(429, 'rate_limited', '这个邮箱获取验证码太频繁，请稍后再试')
    }

    const previous = ctx.db
      .prepare('SELECT created_at FROM email_codes WHERE email = ? AND purpose = ?')
      .get(email, purpose)
    const cooldownMs = ctx.config.codeCooldownSeconds * 1000
    if (previous && ctx.now - Number(previous.created_at) < cooldownMs) {
      const wait = Math.ceil((cooldownMs - (ctx.now - Number(previous.created_at))) / 1000)
      throw new HttpError(429, 'code_cooldown', `请 ${wait} 秒后再获取验证码`)
    }

    const code = newCode()
    ctx.db
      .prepare(
        `INSERT INTO email_codes (email, purpose, code_hash, created_at, expires_at, attempts)
         VALUES (?, ?, ?, ?, ?, 0)
         ON CONFLICT(email, purpose) DO UPDATE SET
           code_hash = excluded.code_hash,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at,
           attempts = 0`
      )
      .run(email, purpose, hashToken(code), ctx.now, ctx.now + ctx.config.codeTtlSeconds * 1000)

    const mail = verificationEmail({
      code,
      minutes: Math.round(ctx.config.codeTtlSeconds / 60),
      purpose
    })
    const sent = await ctx.mailer.send({ to: email, ...mail })
    if (!sent.ok) {
      // The code never left the server, so it must not stay usable either.
      ctx.db.prepare('DELETE FROM email_codes WHERE email = ? AND purpose = ?').run(email, purpose)
      throw new HttpError(502, 'email_send_failed', '验证码邮件发送失败，请稍后再试或联系管理员')
    }
    ctx.log(`[auth] ${purpose} code mailed to ${email}`)
    return {
      ok: true,
      sent: true,
      required: true,
      expiresIn: ctx.config.codeTtlSeconds,
      cooldownSeconds: ctx.config.codeCooldownSeconds
    }
  })

  router.post('/api/v1/auth/register', async (ctx) => {
    const body = ctx.body
    const email = normaliseEmail(body.email)
    const password = checkPassword(body.password)

    if (!registrationOpen(ctx)) {
      throw new HttpError(403, 'registration_closed', '这个服务器没有开放注册')
    }
    if (ctx.config.emailVerificationRequired) {
      if (!ctx.config.smtpConfigured) {
        throw new HttpError(503, 'email_not_configured', '服务器没有配置 SMTP，无法完成邮箱验证')
      }
      consumeCode(ctx, email, 'register', body.code)
    }
    if (ctx.db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'email_taken', '这个邮箱已经注册过了')
    }

    const { salt, hash } = await hashPassword(password)
    const now = Date.now()
    const id = randomUUID()
    ctx.db
      .prepare(
        `INSERT INTO users (id, email, password_salt, password_hash, created_at, plan, trial_ends_at, current_period_end, cancel_at_period_end)
         VALUES (?, ?, ?, ?, ?, 'trial', ?, NULL, 0)`
      )
      .run(id, email, salt, hash, now, now + ctx.config.trialDays * 86_400_000)

    const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id)
    ctx.log(`[auth] registered ${email}`)
    return authPayload(ctx, user, issueSession(ctx.db, ctx.config, user, ctx.req.headers['user-agent']))
  })

  router.post('/api/v1/auth/login', async (ctx) => {
    const body = ctx.body
    const email = normaliseEmail(body.email)
    const password = typeof body.password === 'string' ? body.password : ''
    const user = ctx.db.prepare('SELECT * FROM users WHERE email = ?').get(email)
    // The same error for "no such account" and "wrong password": distinguishing
    // them turns the login form into an account-enumeration oracle.
    const ok = user
      ? await verifyPassword(password, { salt: user.password_salt, hash: user.password_hash })
      : false
    if (!ok) throw new HttpError(401, 'bad_credentials', '邮箱或密码不正确')
    if (Number(user.disabled) === 1) throw new HttpError(403, 'account_disabled', '账号已被停用')
    ctx.log(`[auth] login ${email}`)
    return authPayload(ctx, user, issueSession(ctx.db, ctx.config, user, ctx.req.headers['user-agent']))
  })

  router.post('/api/v1/auth/refresh', async (ctx) => {
    const body = ctx.body
    ctx.body = body
    const rotated = rotateSession(ctx)
    return authPayload(ctx, rotated.user, {
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      expiresIn: rotated.expiresIn
    })
  })

  router.post('/api/v1/auth/logout', async (ctx) => {
    const body = ctx.body ?? {}
    // Revoke whichever token the caller still has: the body's refresh token when
    // the client sends one, the bearer token otherwise.
    const presented =
      (typeof body.refreshToken === 'string' && body.refreshToken) || readBearer(ctx.req)
    if (presented) revokeToken(ctx.db, presented, ctx.now)
    return { ok: true }
  })

  router.get('/api/v1/auth/me', async (ctx) => {
    const user = requireUser(ctx)
    return { user: publicUser(user, ctx.now) }
  })

  /**
   * Password reset: a mailed code plus a new password.
   *
   * Every session is revoked afterwards — a reset is usually the reaction to a
   * compromised account, and leaving the attacker's session alive would defeat
   * the point.
   */
  router.post('/api/v1/auth/password/reset', async (ctx) => {
    const body = ctx.body
    const email = normaliseEmail(body.email)
    const password = checkPassword(body.password)
    if (!ctx.config.smtpConfigured) {
      throw new HttpError(503, 'email_not_configured', '服务器没有配置 SMTP，无法通过邮件重置密码')
    }
    consumeCode(ctx, email, 'reset', body.code)
    const user = ctx.db.prepare('SELECT * FROM users WHERE email = ?').get(email)
    if (!user) throw new HttpError(400, 'code_invalid', '验证码已失效，请重新发送')

    const { salt, hash } = await hashPassword(password)
    ctx.db
      .prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?')
      .run(salt, hash, user.id)
    const revoked = revokeAllSessions(ctx.db, user.id, ctx.now)
    ctx.log(`[auth] password reset for ${email}, ${revoked} session(s) revoked`)
    return { ok: true, revokedSessions: revoked }
  })
}
