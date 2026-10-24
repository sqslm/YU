import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startServer, startMailServer, testConfig } from './helpers.mjs'
import { issueSession } from '../src/session.mjs'
import { createApp } from '../src/app.mjs'

async function fixture(t, overrides = {}) {
  const s = await startServer({ registrationEnabled: false, logLevel: 'info', refreshTtlSeconds: 86400, smtp: { port: 587, password: 'private-initial-secret' }, ...overrides })
  t.after(() => s.close())
  const admin = { id: randomUUID(), email: 'admin@example.com' }
  const ordinary = { id: randomUUID(), email: 'user@example.com' }
  for (const [u, role] of [[admin, 1], [ordinary, 0]]) s.db.prepare(`INSERT INTO users (id,email,password_salt,password_hash,created_at,is_admin) VALUES (?,?,'salt','hash',?,?)`).run(u.id, u.email, Date.now(), role)
  const token = issueSession(s.db, s.config, admin).accessToken
  const ordinaryToken = issueSession(s.db, s.config, ordinary).accessToken
  const call = (method, body) => s.call(method, '/api/v1/admin/settings', { token, body })
  const save = async values => call('PUT', { revision: (await call('GET')).body.revision, values })
  return { ...s, settings: call, save, ordinaryToken }
}

test('settings require admin, never return SMTP password, validate atomically and reject stale updates', async t => {
  const s = await fixture(t)
  assert.equal((await s.call('GET','/api/v1/admin/settings')).status,401)
  assert.equal((await s.call('PUT','/api/v1/admin/settings',{token:s.ordinaryToken,body:{}})).status,403)
  const original = (await s.settings('GET')).body
  assert.equal(original.smtpPasswordSet,true); assert.equal(JSON.stringify(original).includes('private-initial-secret'),false)
  const result = await s.save({DEFAULT_USER_STORAGE_MB:8,CODE_TTL_SECONDS:600})
  assert.equal(result.status,200,JSON.stringify(result.body)); assert.equal(s.config.defaultStorageQuotaBytes,8*1048576)
  assert.equal(s.config.smtp.password,'private-initial-secret')
  assert.equal(s.config.codeTtlSeconds,600)
  assert.equal((await s.call('GET','/api/v1/meta')).body.limits.defaultStorageQuotaBytes,8*1048576)
  for (const values of [{SMTP_PORT:0},{PORT:9000},{PUBLIC_URL:'javascript:alert(1)'},{SMTP_FROM:'sender@example.com\r\nBcc: other@example.com'},{REGISTRATION_ENABLED:true},{TRUST_PROXY:'yes'}]) {
    assert.equal((await s.save(values)).status,400)
  }
  assert.equal((await s.settings('GET')).body.revision,result.body.revision)
  assert.equal((await s.settings('PUT',{revision:original.revision,values:{CODE_TTL_SECONDS:300}})).status,409)
})

test('web settings are restored on application startup; explicit secret replacement and removal work', async t => {
  const s=await fixture(t)
  assert.equal((await s.save({SMTP_PASSWORD:'replacement-secret',MAX_AUDIO_UPLOAD_MB:12})).status,200)
  const fresh = testConfig({dataDir:s.config.dataDir,registrationEnabled:false,logLevel:'info',refreshTtlSeconds:86400,smtp:{port:587,password:'environment-secret'}})
  const second=createApp({config:fresh,logger:{log(){},warn(){},error(){}}})
  try {
    assert.equal(fresh.maxAudioUploadBytes,12*1048576);assert.equal(fresh.smtp.password,'replacement-secret')
  } finally { second.close() }
  assert.equal((await s.save({SMTP_PASSWORD:''})).body.smtpPasswordSet,false)
  assert.equal(s.config.smtp.password,'')
  execFileSync(process.execPath,[fileURLToPath(new URL('../src/cli.mjs',import.meta.url)),'reset-web-settings'],{
    env:{...process.env,DATA_DIR:s.config.dataDir,NODE_ENV:'development',SMTP_HOST:'',SMTP_FROM:'',REGISTRATION_ENABLED:'false'},stdio:'pipe'
  })
  assert.equal(s.db.prepare("SELECT value FROM meta WHERE key = 'web_settings'").get(),undefined)
})

test('saved SMTP configuration is used immediately by the real mailer and registration capability', async t => {
  const mail=await startMailServer();t.after(()=>mail.close())
  const s=await fixture(t)
  const result=await s.save({SMTP_HOST:'127.0.0.1',SMTP_PORT:mail.port,SMTP_FROM:'YU <no-reply@example.com>',SMTP_TLS_MODE:'none',SMTP_USERNAME:'',SMTP_PASSWORD:'',REGISTRATION_ENABLED:true})
  assert.equal(result.status,200);assert.equal(result.body.smtpConfigured,true)
  const code=await s.call('POST','/api/v1/auth/code',{body:{email:'new@example.com',purpose:'register'}})
  assert.equal(code.status,200);assert.equal(mail.messages.length,1)
  assert.equal((await s.call('GET','/api/v1/meta')).body.registrationEnabled,true)
})

test('runtime global and authentication limits actually reject excess requests', async t => {
  const s=await fixture(t)
  assert.equal((await s.save({AUTH_LIMIT_PER_MINUTE:1})).status,200)
  const login={body:{email:'missing@example.com',password:'invalid'}}
  assert.equal((await s.call('POST','/api/v1/auth/login',login)).status,401)
  assert.equal((await s.call('POST','/api/v1/auth/login',login)).status,429)
  assert.equal((await s.save({RATE_LIMIT_PER_MINUTE:2})).status,200)
  assert.equal((await s.call('GET','/health')).status,200)
  assert.equal((await s.call('GET','/health')).status,200)
  assert.equal((await s.call('GET','/health')).status,429)
})
