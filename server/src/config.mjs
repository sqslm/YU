/**
 * Everything the server reads from the environment, in one place.
 *
 * Two rules govern this file:
 *  - a value that cannot be understood fails at boot with a sentence naming the
 *    variable, instead of surfacing as a mystery 500 on the first request;
 *  - a configuration that makes the deployment unsafe (plain-text SMTP auth in
 *    production, public registration without a mailer) is refused or switched
 *    off with a loud warning. Silently downgrading to something unsafe is worse
 *    than refusing to start.
 */
import { resolve } from 'node:path'

const DAY_MS = 86_400_000

function text(env, name, fallback = '') {
  const raw = env[name]
  if (raw === undefined || raw === null) return fallback
  const value = String(raw).trim()
  return value === '' ? fallback : value
}

function number(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer, got "${raw}"`)
  }
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got ${value}`)
  }
  return value
}

function bool(env, name, fallback) {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = String(raw).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'off'].includes(value)) return false
  throw new Error(`${name} must be one of 1/0, true/false, yes/no, got "${raw}"`)
}

/**
 * A private instance with no mailer can only create accounts from the admin CLI.
 * Public registration defaults to "only if mail works": with no SMTP every
 * sign-up would be unverifiable, and pretending otherwise is how open relays of
 * accounts happen.
 */
export function loadConfig(env = process.env) {
  const warnings = []
  const production = env.NODE_ENV === 'production'

  const smtpHost = text(env, 'SMTP_HOST')
  const smtpFrom = text(env, 'SMTP_FROM')
  const smtpUsername = text(env, 'SMTP_USERNAME')
  const smtpPassword = text(env, 'SMTP_PASSWORD')
  const smtpTls = text(env, 'SMTP_TLS_MODE', 'starttls').toLowerCase()
  if (!['starttls', 'implicit', 'none'].includes(smtpTls)) {
    throw new Error('SMTP_TLS_MODE must be one of starttls, implicit, none')
  }
  const smtpConfigured = Boolean(smtpHost && smtpFrom)
  if (smtpConfigured && production && smtpTls === 'none' && smtpUsername) {
    // Sending a password over a plaintext TCP connection hands it to anyone on
    // the path; a mail server that offers no TLS needs a local relay instead.
    throw new Error('SMTP_TLS_MODE=none with SMTP_USERNAME is refused in production: use starttls or implicit')
  }

  const emailVerificationRequired = bool(env, 'EMAIL_VERIFICATION_REQUIRED', true)
  let registrationEnabled = bool(env, 'REGISTRATION_ENABLED', smtpConfigured)
  if (registrationEnabled && emailVerificationRequired && !smtpConfigured) {
    registrationEnabled = false
    warnings.push(
      '公开注册已关闭：EMAIL_VERIFICATION_REQUIRED 打开但没有配置 SMTP_HOST/SMTP_FROM。' +
        '用管理命令创建账号，或配置 SMTP 后设置 REGISTRATION_ENABLED=1。'
    )
  }
  if (!emailVerificationRequired && !smtpConfigured) {
    warnings.push('EMAIL_VERIFICATION_REQUIRED=0 且没有 SMTP：注册不需要邮箱验证码，只适合完全私有的实例。')
  }
  if (!smtpConfigured) {
    warnings.push('SMTP 未配置：无法发送验证码，也无法通过邮件找回密码。')
  }

  const defaultStorageMb = number(env, 'DEFAULT_USER_STORAGE_MB', 1024, { min: 1, max: 1024 * 1024 })
  const maxAudioUploadMb = number(env, 'MAX_AUDIO_UPLOAD_MB', 50, { min: 1, max: 2048 })

  return {
    production,
    host: text(env, 'HOST', '0.0.0.0'),
    port: number(env, 'PORT', 8787, { min: 0, max: 65535 }),
    dataDir: resolve(text(env, 'DATA_DIR', './data')),
    publicUrl: text(env, 'PUBLIC_URL'),

    /** Access tokens are short-lived; refresh rotation keeps desktops signed in. */
    accessTtlSeconds: number(env, 'ACCESS_TTL_SECONDS', 43_200, { min: 60, max: 30 * 86_400 }),
    refreshTtlSeconds: number(env, 'REFRESH_TTL_DAYS', 90, { min: 1, max: 3650 }) * (DAY_MS / 1000),

    codeTtlSeconds: number(env, 'CODE_TTL_SECONDS', 300, { min: 30, max: 3600 }),
    codeCooldownSeconds: number(env, 'CODE_COOLDOWN_SECONDS', 60, { min: 0, max: 3600 }),
    codeMaxAttempts: number(env, 'CODE_MAX_ATTEMPTS', 5, { min: 1, max: 20 }),

    registrationEnabled,
    emailVerificationRequired,
    defaultStorageQuotaBytes: defaultStorageMb * 1024 * 1024,
    maxAudioUploadBytes: maxAudioUploadMb * 1024 * 1024,
    maxJsonBytes: number(env, 'MAX_BODY_BYTES', 2 * 1024 * 1024, { min: 4096, max: 32 * 1024 * 1024 }),

    smtp: {
      configured: smtpConfigured,
      host: smtpHost,
      port: number(env, 'SMTP_PORT', smtpTls === 'implicit' ? 465 : 587, { min: 1, max: 65535 }),
      username: smtpUsername,
      password: smtpPassword,
      from: smtpFrom,
      tls: smtpTls,
      timeoutMs: number(env, 'SMTP_TIMEOUT_SECONDS', 15, { min: 1, max: 120 }) * 1000
    },
    smtpConfigured,

    /** Requests per minute per IP for the whole API. `0` disables the limiter. */
    rateLimitPerMinute: number(env, 'RATE_LIMIT_PER_MINUTE', 240, { min: 0, max: 100_000 }),
    /** Stricter bucket for the endpoints that guess passwords. */
    authLimitPerMinute: number(env, 'AUTH_LIMIT_PER_MINUTE', 20, { min: 0, max: 100_000 }),
    /** Per-source limits on mailing codes; the e-mail bucket is the important one. */
    codeLimitPerHourPerIp: number(env, 'CODE_LIMIT_PER_HOUR_PER_IP', 20, { min: 0, max: 10_000 }),
    codeLimitPerHourPerEmail: number(env, 'CODE_LIMIT_PER_HOUR_PER_EMAIL', 5, { min: 0, max: 10_000 }),

    corsOrigin: text(env, 'CORS_ORIGIN', '*'),
    /**
     * The desktop client sends `X-Forwarded-For` only through a proxy, so this
     * stays off unless an operator says otherwise: trusting the header without a
     * proxy lets any client pick its own rate-limit bucket.
     */
    trustProxy: bool(env, 'TRUST_PROXY', false),

    trialDays: number(env, 'TRIAL_DAYS', 14, { min: 0, max: 3650 }),

    logLevel: text(env, 'LOG_LEVEL', 'info'),

    warnings
  }
}
