import assert from 'node:assert/strict'
import test from 'node:test'
import { codeFromMessage, register, requestCode, startMailServer, startServer } from './helpers.mjs'

async function mailServerConfig(mail) {
  return {
    smtp: { configured: true, host: '127.0.0.1', port: mail.port },
    smtpConfigured: true
  }
}

test('注册、登录、退出与当前用户', async (t) => {
  const mail = await startMailServer()
  const app = await startServer(await mailServerConfig(mail))
  t.after(async () => {
    await app.close()
    await mail.close()
  })

  const meta = await app.call('GET', '/api/v1/meta')
  assert.equal(meta.status, 200)
  assert.equal(meta.body.registrationEnabled, true)
  assert.equal(meta.body.emailVerificationRequired, true)
  assert.equal(meta.body.smtpConfigured, true)
  assert.equal(meta.body.protocolVersion, 1)

  const code = await requestCode(app.call, mail, 'user@example.com')
  assert.match(code, /^\d{6}$/)

  const registered = await app.call('POST', '/api/v1/auth/register', {
    body: { email: 'User@Example.com', password: 'correct horse', code }
  })
  assert.equal(registered.status, 200, JSON.stringify(registered.body))
  assert.ok(registered.body.accessToken)
  assert.ok(registered.body.refreshToken)
  assert.equal(registered.body.user.email, 'user@example.com')

  const me = await app.call('GET', '/api/v1/auth/me', { token: registered.body.accessToken })
  assert.equal(me.status, 200)
  assert.equal(me.body.user.email, 'user@example.com')
  assert.equal(me.body.user.isAdmin, false)

  const loggedIn = await app.call('POST', '/api/v1/auth/login', {
    body: { email: 'user@example.com', password: 'correct horse' }
  })
  assert.equal(loggedIn.status, 200)

  const loggedOut = await app.call('POST', '/api/v1/auth/logout', {
    body: { refreshToken: loggedIn.body.refreshToken }
  })
  assert.equal(loggedOut.status, 200)

  const afterLogout = await app.call('GET', '/api/v1/auth/me', { token: loggedIn.body.accessToken })
  assert.equal(afterLogout.status, 401)

  // The other device's session is untouched by this logout.
  const stillValid = await app.call('GET', '/api/v1/auth/me', { token: registered.body.accessToken })
  assert.equal(stillValid.status, 200)
})

test('刷新令牌会轮换，旧的立刻失效', async (t) => {
  const mail = await startMailServer()
  const app = await startServer(await mailServerConfig(mail))
  t.after(async () => {
    await app.close()
    await mail.close()
  })

  const session = await register(app.call, mail)
  const refreshed = await app.call('POST', '/api/v1/auth/refresh', {
    body: { refreshToken: session.refreshToken }
  })
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body))
  assert.ok(refreshed.body.accessToken)
  assert.notEqual(refreshed.body.refreshToken, session.refreshToken)

  const replay = await app.call('POST', '/api/v1/auth/refresh', {
    body: { refreshToken: session.refreshToken }
  })
  assert.equal(replay.status, 401)
  assert.equal(replay.body.error, 'refresh_invalid')
})

test('重复注册、错误验证码与验证码过期都被拒绝', async (t) => {
  const mail = await startMailServer()
  const app = await startServer(await mailServerConfig(mail))
  t.after(async () => {
    await app.close()
    await mail.close()
  })

  await register(app.call, mail, 'dup@example.com')

  const duplicate = await app.call('POST', '/api/v1/auth/code', {
    body: { email: 'dup@example.com', purpose: 'register' }
  })
  // Same answer as a fresh address: the endpoint is not an account oracle.
  assert.equal(duplicate.status, 200)
  assert.equal(duplicate.body.sent, true)
  assert.equal(mail.messages.length, 1)

  const code = await requestCode(app.call, mail, 'wrong@example.com')
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const bad = await app.call('POST', '/api/v1/auth/register', {
      body: { email: 'wrong@example.com', password: 'correct horse', code: '000000' }
    })
    assert.ok([400, 429].includes(bad.status), `unexpected ${bad.status}`)
  }
  const afterLockout = await app.call('POST', '/api/v1/auth/register', {
    body: { email: 'wrong@example.com', password: 'correct horse', code }
  })
  assert.equal(afterLockout.status, 400)
  assert.ok(['code_invalid', 'bad_code'].includes(afterLockout.body.error))

  const expiredCode = await requestCode(app.call, mail, 'late@example.com')
  app.db
    .prepare('UPDATE email_codes SET expires_at = ? WHERE email = ? AND purpose = ?')
    .run(Date.now() - 1000, 'late@example.com', 'register')
  const expired = await app.call('POST', '/api/v1/auth/register', {
    body: { email: 'late@example.com', password: 'correct horse', code: expiredCode }
  })
  assert.equal(expired.status, 400)
  assert.equal(expired.body.error, 'code_expired')
})

test('密码重置会撤销该账号的全部会话', async (t) => {
  const mail = await startMailServer()
  const app = await startServer(await mailServerConfig(mail))
  t.after(async () => {
    await app.close()
    await mail.close()
  })

  const first = await register(app.call, mail, 'reset@example.com', 'old password')
  const second = await app.call('POST', '/api/v1/auth/login', {
    body: { email: 'reset@example.com', password: 'old password' }
  })

  const before = mail.messages.length
  const resetCode = await requestCode(app.call, mail, 'reset@example.com', 'reset')
  assert.equal(mail.messages.length, before + 1)
  const reset = await app.call('POST', '/api/v1/auth/password/reset', {
    body: { email: 'reset@example.com', password: 'new password', code: resetCode }
  })
  assert.equal(reset.status, 200, JSON.stringify(reset.body))
  assert.equal(reset.body.revokedSessions, 2)

  const staleAccess = await app.call('GET', '/api/v1/auth/me', { token: first.accessToken })
  assert.equal(staleAccess.status, 401)
  const staleRefresh = await app.call('POST', '/api/v1/auth/refresh', {
    body: { refreshToken: second.body.refreshToken }
  })
  assert.equal(staleRefresh.status, 401)

  const oldLogin = await app.call('POST', '/api/v1/auth/login', {
    body: { email: 'reset@example.com', password: 'old password' }
  })
  assert.equal(oldLogin.status, 401)
  const newLogin = await app.call('POST', '/api/v1/auth/login', {
    body: { email: 'reset@example.com', password: 'new password' }
  })
  assert.equal(newLogin.status, 200)
})

test('未知邮箱与错误密码给出同一个答案', async (t) => {
  const mail = await startMailServer()
  const app = await startServer(await mailServerConfig(mail))
  t.after(async () => {
    await app.close()
    await mail.close()
  })

  await register(app.call, mail, 'known@example.com')
  const wrongPassword = await app.call('POST', '/api/v1/auth/login', {
    body: { email: 'known@example.com', password: 'not the password' }
  })
  const unknownEmail = await app.call('POST', '/api/v1/auth/login', {
    body: { email: 'nobody@example.com', password: 'not the password' }
  })
  assert.equal(wrongPassword.status, 401)
  assert.equal(unknownEmail.status, 401)
  assert.deepEqual(wrongPassword.body, unknownEmail.body)

  // A reset request for an unknown address also looks like a success.
  const unknownReset = await app.call('POST', '/api/v1/auth/code', {
    body: { email: 'nobody@example.com', purpose: 'reset' }
  })
  assert.equal(unknownReset.status, 200)
  assert.equal(mail.messages.length, 1)
})

test('关闭注册后老账号仍可登录，新账号被拒', async (t) => {
  const mail = await startMailServer()
  const app = await startServer(await mailServerConfig(mail))
  t.after(async () => {
    await app.close()
    await mail.close()
  })

  const session = await register(app.call, mail, 'member@example.com')
  app.db
    .prepare(
      "INSERT INTO meta (key, value) VALUES ('registration_enabled', '0') ON CONFLICT(key) DO UPDATE SET value = '0'"
    )
    .run()

  const meta = await app.call('GET', '/api/v1/meta')
  assert.equal(meta.body.registrationEnabled, false)

  const code = await app.call('POST', '/api/v1/auth/code', {
    body: { email: 'newcomer@example.com' }
  })
  assert.equal(code.status, 403)
  assert.equal(code.body.error, 'registration_closed')

  const signup = await app.call('POST', '/api/v1/auth/register', {
    body: { email: 'newcomer@example.com', password: 'correct horse', code: '123456' }
  })
  assert.equal(signup.status, 403)

  const login = await app.call('POST', '/api/v1/auth/login', {
    body: { email: 'member@example.com', password: 'correct horse' }
  })
  assert.equal(login.status, 200)
  assert.equal(login.body.user.id, session.user.id)
})

test('没有 SMTP 时明确拒绝发码，而不是假装成功', async (t) => {
  const app = await startServer()
  t.after(() => app.close())

  const res = await app.call('POST', '/api/v1/auth/code', { body: { email: 'someone@example.com' } })
  assert.equal(res.status, 503)
  assert.equal(res.body.error, 'email_not_configured')
})

test('禁用账号后登录与已签发令牌都失效', async (t) => {
  const mail = await startMailServer()
  const app = await startServer(await mailServerConfig(mail))
  t.after(async () => {
    await app.close()
    await mail.close()
  })

  const session = await register(app.call, mail, 'blocked@example.com')
  app.db.prepare('UPDATE users SET disabled = 1 WHERE email = ?').run('blocked@example.com')

  const me = await app.call('GET', '/api/v1/auth/me', { token: session.accessToken })
  assert.equal(me.status, 403)
  assert.equal(me.body.error, 'account_disabled')

  const login = await app.call('POST', '/api/v1/auth/login', {
    body: { email: 'blocked@example.com', password: 'correct horse' }
  })
  assert.equal(login.status, 403)
  assert.equal(login.body.error, 'account_disabled')
})

test('验证码只能使用一次', async (t) => {
  const mail = await startMailServer()
  const app = await startServer(await mailServerConfig(mail))
  t.after(async () => {
    await app.close()
    await mail.close()
  })

  const code = await requestCode(app.call, mail, 'once@example.com')
  const first = await app.call('POST', '/api/v1/auth/register', {
    body: { email: 'once@example.com', password: 'correct horse', code }
  })
  assert.equal(first.status, 200)
  const replay = await app.call('POST', '/api/v1/auth/register', {
    body: { email: 'once@example.com', password: 'correct horse', code }
  })
  // The code was consumed by the first call, so the replay cannot get as far as
  // the duplicate-email check.
  assert.equal(replay.status, 400)
  assert.ok(['code_invalid', 'bad_code'].includes(replay.body.error))
  assert.equal(codeFromMessage(mail.messages[0]), code)
})
