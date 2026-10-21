import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'

/** A config that is valid for a throwaway server on an ephemeral port. */
export function testConfig(overrides = {}) {
  const base = {
    production: false,
    host: '127.0.0.1',
    port: 0,
    dataDir: mkdtempSync(join(tmpdir(), 'typeless-server-')),
    publicUrl: '',
    accessTtlSeconds: 3600,
    refreshTtlSeconds: 3600,
    codeTtlSeconds: 300,
    // The suite asks for one code per flow; waiting 60s between them would only
    // make the run slower.
    codeCooldownSeconds: 0,
    codeMaxAttempts: 5,
    defaultStorageQuotaBytes: 4 * 1024 * 1024,
    maxAudioUploadBytes: 1024 * 1024,
    maxJsonBytes: 1024 * 1024,
    smtp: {
      configured: false,
      host: '',
      port: 0,
      username: '',
      password: '',
      from: 'Typeless <no-reply@test.local>',
      tls: 'none',
      timeoutMs: 4000
    },
    smtpConfigured: false,
    rateLimitPerMinute: 0,
    authLimitPerMinute: 0,
    codeLimitPerHourPerIp: 0,
    codeLimitPerHourPerEmail: 0,
    corsOrigin: '*',
    trustProxy: false,
    trialDays: 14,
    planPriceCents: 0,
    planCurrency: 'CNY',
    allowMockPayment: false,
    registrationEnabled: true,
    emailVerificationRequired: true,
    logLevel: 'silent',
    warnings: []
  }
  const merged = { ...base, ...overrides }
  merged.smtp = { ...base.smtp, ...(overrides.smtp ?? {}) }
  merged.smtpConfigured = merged.smtp.configured
  return merged
}

/**
 * A loopback SMTP server: enough of the protocol for the client in src/mail.mjs,
 * and it keeps each message so a test can read the code that was actually mailed.
 */
export async function startMailServer() {
  const messages = []
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    let buffer = ''
    let data = null
    socket.write('220 test.local ESMTP\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\r\n')
        if (index < 0) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        if (data !== null) {
          if (line === '.') {
            messages.push(data)
            data = null
            socket.write('250 OK\r\n')
          } else {
            data += `${line}\n`
          }
          continue
        }
        const command = line.split(' ')[0].toUpperCase()
        if (command === 'EHLO' || command === 'HELO') {
          // No AUTH advertised: the test config has no credentials.
          socket.write('250-test.local\r\n250 8BITMIME\r\n')
        } else if (command === 'MAIL' || command === 'RCPT' || command === 'RSET' || command === 'NOOP') {
          socket.write('250 OK\r\n')
        } else if (command === 'DATA') {
          data = ''
          socket.write('354 end with <CRLF>.<CRLF>\r\n')
        } else if (command === 'QUIT') {
          socket.write('221 Bye\r\n')
          socket.end()
        } else {
          socket.write('250 OK\r\n')
        }
      }
    })
    socket.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    messages,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

/** Pulls the 6-digit code out of the base64 body of a captured message. */
export function codeFromMessage(message) {
  const separator = message.indexOf('\n\n')
  const headers = separator < 0 ? message : message.slice(0, separator)
  const body = separator < 0 ? '' : message.slice(separator + 2)
  const decoded = /base64/i.test(headers)
    ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
    : body
  const match = /\b(\d{6})\b/.exec(decoded)
  if (!match) throw new Error(`邮件里没有验证码：${decoded.slice(0, 200)}`)
  return match[1]
}

/** Starts a server on an ephemeral port plus helpers bound to it. */
export async function startServer(overrides = {}) {
  const { createApp } = await import('../src/app.mjs')
  const config = testConfig(overrides)
  const app = createApp({
    config,
    // The suite asserts on responses; per-request log lines would drown the report.
    logger: process.env.TEST_LOG ? console : { log: () => {}, warn: () => {}, error: () => {} }
  })
  const { server, db } = app
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`

  async function call(method, path, { body, token, headers: extra } = {}) {
    const headers = { ...extra }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (token) headers.authorization = `Bearer ${token}`
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = { raw: text }
    }
    return { status: res.status, body: json, headers: res.headers }
  }

  /** Binary variant for audio upload/download; the body is never JSON-parsed. */
  async function callBytes(method, path, { body, contentType = 'application/octet-stream', token } = {}) {
    const headers = {}
    if (contentType) headers['content-type'] = contentType
    if (token) headers.authorization = `Bearer ${token}`
    const res = await fetch(`${base}${path}`, { method, headers, body })
    const buffer = Buffer.from(await res.arrayBuffer())
    return { status: res.status, buffer, headers: res.headers }
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve))
    try {
      app.close()
    } catch {
      // Already closed by a test.
    }
    rmSync(config.dataDir, { recursive: true, force: true })
  }

  return { config, db, base, call, callBytes, close, server }
}

/** Asks for a code and returns the code the SMTP fixture received. */
export async function requestCode(call, mail, email, purpose = 'register') {
  const before = mail.messages.length
  const res = await call('POST', '/api/v1/auth/code', { body: { email, purpose } })
  if (res.status !== 200) throw new Error(`code failed: ${JSON.stringify(res.body)}`)
  return codeFromMessage(mail.messages[before])
}

export async function register(call, mail, email = 'user@example.com', password = 'correct horse') {
  const code = await requestCode(call, mail, email)
  const res = await call('POST', '/api/v1/auth/register', { body: { email, password, code } })
  if (res.status !== 200) throw new Error(`register failed: ${JSON.stringify(res.body)}`)
  return res.body
}
