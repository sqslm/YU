import { randomUUID } from 'node:crypto'
import { loadConfig } from './config.mjs'
import { readMeta, writeMeta } from './db.mjs'
import { HttpError } from './http.mjs'
import { registrationOpen } from './routes/auth.mjs'

const KEY = 'web_settings'
// The same environment contract is used at boot and by the management page.
function environment(c) {
  return {
    NODE_ENV: c.production ? 'production' : 'development', HOST: c.host, PORT: c.port, DATA_DIR: c.dataDir,
    PUBLIC_URL: c.publicUrl, LOG_LEVEL: c.logLevel,
    REGISTRATION_ENABLED: c.registrationEnabled, EMAIL_VERIFICATION_REQUIRED: c.emailVerificationRequired,
    CODE_TTL_SECONDS: c.codeTtlSeconds, CODE_COOLDOWN_SECONDS: c.codeCooldownSeconds, CODE_MAX_ATTEMPTS: c.codeMaxAttempts,
    ACCESS_TTL_SECONDS: c.accessTtlSeconds, REFRESH_TTL_DAYS: c.refreshTtlSeconds / 86400, TRIAL_DAYS: c.trialDays,
    DEFAULT_USER_STORAGE_MB: c.defaultStorageQuotaBytes / 1048576, MAX_AUDIO_UPLOAD_MB: c.maxAudioUploadBytes / 1048576, MAX_BODY_BYTES: c.maxJsonBytes,
    SMTP_HOST: c.smtp.host, SMTP_PORT: c.smtp.port, SMTP_USERNAME: c.smtp.username, SMTP_PASSWORD: c.smtp.password,
    SMTP_FROM: c.smtp.from, SMTP_TLS_MODE: c.smtp.tls, SMTP_TIMEOUT_SECONDS: c.smtp.timeoutMs / 1000,
    RATE_LIMIT_PER_MINUTE: c.rateLimitPerMinute, AUTH_LIMIT_PER_MINUTE: c.authLimitPerMinute,
    CODE_LIMIT_PER_HOUR_PER_IP: c.codeLimitPerHourPerIp, CODE_LIMIT_PER_HOUR_PER_EMAIL: c.codeLimitPerHourPerEmail,
    CORS_ORIGIN: c.corsOrigin, TRUST_PROXY: c.trustProxy
  }
}
const READ_ONLY = new Set(['NODE_ENV', 'HOST', 'PORT', 'DATA_DIR'])
function saved(db) { return JSON.parse(readMeta(db, KEY) ?? '{"revision":"0","values":{}}') }

export function applyStoredSettings(config, db) {
  const stored = saved(db)
  if (stored.revision !== '0') Object.assign(config, loadConfig({ ...environment(config), ...stored.values }))
}

export function publicSettings(ctx) {
  const values = environment(ctx.config)
  for (const key of READ_ONLY) delete values[key]
  delete values.SMTP_PASSWORD
  values.REGISTRATION_ENABLED = registrationOpen(ctx)
  return { values, revision: saved(ctx.db).revision, smtpPasswordSet: Boolean(ctx.config.smtp.password),
    smtpConfigured: ctx.config.smtpConfigured, warnings: ctx.config.warnings,
    deployment: { host: ctx.config.host, port: ctx.config.port, dataDir: ctx.config.dataDir, production: ctx.config.production } }
}

export function saveSettings(ctx) {
  const current = saved(ctx.db)
  if (ctx.body.revision !== current.revision) throw new HttpError(409, 'settings_conflict', '设置已被其他管理员修改，请重新加载后再保存')
  const patch = ctx.body.values
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'bad_settings', '缺少设置项')
  const base = environment(ctx.config)
  for (const [key, value] of Object.entries(patch)) {
    if (READ_ONLY.has(key) || !Object.hasOwn(base, key)) throw new HttpError(400, 'bad_settings', '包含不支持修改的设置项')
    if (typeof value !== typeof base[key]) throw new HttpError(400, 'bad_settings', `${key} 的类型不正确`)
    if (typeof value === 'string' && (value.length > 2048 || /[\r\n\0]/.test(value))) throw new HttpError(400, 'bad_settings', `${key} 包含不合法的内容`)
  }
  const env = { ...base, REGISTRATION_ENABLED: registrationOpen(ctx), ...patch }
  let next
  try {
    if (!['debug', 'info', 'warn', 'error'].includes(env.LOG_LEVEL)) throw new Error('日志级别不合法')
    for (const key of ['PUBLIC_URL', 'CORS_ORIGIN']) {
      if (!env[key] || (key === 'CORS_ORIGIN' && env[key] === '*')) continue
      const url = new URL(env[key])
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (key === 'CORS_ORIGIN' && url.origin !== env[key])) throw new Error(`${key} 应为有效的 HTTP/HTTPS 地址`)
    }
    if (env.SMTP_FROM && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test((/<([^>]+)>/.exec(env.SMTP_FROM)?.[1] ?? env.SMTP_FROM).trim())) throw new Error('发件人邮箱不合法')
    next = loadConfig(env)
    if (env.REGISTRATION_ENABLED && env.EMAIL_VERIFICATION_REQUIRED && !next.smtpConfigured) throw new Error('启用邮箱验证注册前，请先配置 SMTP 主机和发件人')
  } catch (error) { throw new HttpError(400, 'bad_settings', error.message) }
  const values = { ...current.values, ...patch }
  ctx.db.exec('BEGIN')
  try {
    writeMeta(ctx.db, KEY, JSON.stringify({ revision: randomUUID(), values }))
    if (patch.REGISTRATION_ENABLED !== undefined) writeMeta(ctx.db, 'registration_enabled', patch.REGISTRATION_ENABLED ? '1' : '0')
    ctx.db.exec('COMMIT')
  } catch (error) { ctx.db.exec('ROLLBACK'); throw error }
  ctx.applySettings(next)
  return publicSettings(ctx)
}
