/**
 * A minimal SMTP client: greeting, EHLO, optional STARTTLS, AUTH LOGIN/PLAIN,
 * MAIL/RCPT/DATA, QUIT.
 *
 * Written against `node:net`/`node:tls` instead of a mail library because the
 * whole server is meant to stay dependency-free, and the subset needed here is
 * small and well specified. The two things it refuses to do are send credentials
 * over an unencrypted connection (config.mjs rejects that in production) and
 * echo a password into an error message.
 *
 * Nothing in this file logs a message body: the sign-up mail contains the code.
 */
import { hostname } from 'node:os'
import net from 'node:net'
import tls from 'node:tls'

const CRLF = '\r\n'

function waitFor(socket, event) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      cleanup()
      reject(err)
    }
    const onEvent = () => {
      cleanup()
      resolve()
    }
    const cleanup = () => {
      socket.off(event, onEvent)
      socket.off('error', onError)
    }
    socket.once(event, onEvent)
    socket.once('error', onError)
  })
}

function clientName() {
  const name = hostname().replace(/[^A-Za-z0-9.-]/g, '')
  return name || 'localhost'
}

/** `Typeless <no-reply@example.com>` → `no-reply@example.com`. */
export function bareAddress(from) {
  const match = /<([^>]+)>/.exec(from)
  return (match ? match[1] : from).trim()
}

class SmtpChannel {
  constructor(socket, timeoutMs) {
    this.timeoutMs = timeoutMs
    this.buffer = ''
    this.lines = []
    this.replies = []
    this.waiter = null
    this.failure = null
    this.socket = socket
    this.bind(socket)
  }

  bind(socket) {
    this.socket = socket
    this.onData = (chunk) => this.feed(chunk)
    this.onError = (err) => this.fail(err)
    this.onClose = () => this.fail(new Error('SMTP 连接被关闭'))
    this.onTimeout = () => this.fail(new Error('SMTP 连接超时'))
    socket.on('data', this.onData)
    socket.on('error', this.onError)
    socket.on('close', this.onClose)
    socket.on('timeout', this.onTimeout)
    socket.setTimeout(this.timeoutMs)
  }

  /** Drops our listeners so the raw socket can be wrapped by TLS. */
  unbind() {
    const socket = this.socket
    socket.off('data', this.onData)
    socket.off('error', this.onError)
    socket.off('close', this.onClose)
    socket.off('timeout', this.onTimeout)
    socket.setTimeout(0)
  }

  feed(chunk) {
    this.buffer += chunk.toString('utf8')
    for (;;) {
      const index = this.buffer.indexOf(CRLF)
      if (index < 0) break
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + CRLF.length)
      this.lines.push(line)
      // A reply is complete when the final line has a space after the code;
      // "250-" lines are continuations of a multi-line greeting/capability list.
      if (/^\d{3} /.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), text: this.lines.join('\n') }
        this.lines = []
        this.deliver(reply)
      }
    }
  }

  deliver(reply) {
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = null
      waiter.resolve(reply)
      return
    }
    this.replies.push(reply)
  }

  fail(error) {
    this.failure = error
    if (this.waiter) {
      const waiter = this.waiter
      this.waiter = null
      waiter.reject(error)
    }
  }

  next() {
    if (this.replies.length > 0) return Promise.resolve(this.replies.shift())
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }

  write(text) {
    this.socket.write(text)
  }

  async command(line) {
    this.write(`${line}${CRLF}`)
    return this.next()
  }

  async expect(line, codes) {
    const reply = await this.command(line)
    if (!codes.includes(reply.code)) {
      const head = reply.text.split('\n').pop() ?? ''
      throw new Error(`SMTP ${line.split(' ')[0]} 返回 ${reply.code}：${head.slice(0, 160)}`)
    }
    return reply
  }
}

async function authenticate(channel, smtp, capabilities) {
  const hasLogin = /AUTH[^\n]*\bLOGIN\b/i.test(capabilities)
  const hasPlain = /AUTH[^\n]*\bPLAIN\b/i.test(capabilities)
  if (hasPlain && !hasLogin) {
    const token = Buffer.from(`\u0000${smtp.username}\u0000${smtp.password}`, 'utf8').toString('base64')
    await channel.expect(`AUTH PLAIN ${token}`, [235])
    return
  }
  await channel.expect('AUTH LOGIN', [334])
  await channel.expect(Buffer.from(smtp.username, 'utf8').toString('base64'), [334])
  await channel.expect(Buffer.from(smtp.password, 'utf8').toString('base64'), [235])
}

function wrapBase64(value) {
  return value.replace(/.{1,76}/g, (line) => `${line}${CRLF}`).trimEnd()
}

/** A UTF-8 plain-text message; the body is base64 so long Chinese lines survive. */
function buildMessage(smtp, { to, subject, text }) {
  const body = wrapBase64(Buffer.from(text, 'utf8').toString('base64'))
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`
  return [
    `From: ${smtp.from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${bareAddress(smtp.from).split('@')[1] ?? 'localhost'}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body
  ].join(CRLF)
}

async function deliver(smtp, message) {
  const options = { host: smtp.host, port: smtp.port }
  const socket =
    smtp.tls === 'implicit'
      ? tls.connect({ ...options, servername: smtp.host, rejectUnauthorized: true })
      : net.connect(options)
  const channel = new SmtpChannel(socket, smtp.timeoutMs)
  try {
    await waitFor(socket, smtp.tls === 'implicit' ? 'secureConnect' : 'connect')
    const greeting = await channel.next()
    if (greeting.code !== 220) throw new Error(`SMTP 服务器拒绝了连接：${greeting.code}`)

    let ehlo = await channel.command(`EHLO ${clientName()}`)
    if (ehlo.code !== 250) throw new Error(`SMTP EHLO 失败：${ehlo.code}`)

    if (smtp.tls === 'starttls') {
      if (!/STARTTLS/i.test(ehlo.text)) throw new Error('SMTP 服务器没有提供 STARTTLS')
      await channel.expect('STARTTLS', [220])
      channel.unbind()
      const secure = tls.connect({ socket, servername: smtp.host, rejectUnauthorized: true })
      channel.bind(secure)
      await waitFor(secure, 'secureConnect')
      ehlo = await channel.command(`EHLO ${clientName()}`)
      if (ehlo.code !== 250) throw new Error(`SMTP STARTTLS 后的 EHLO 失败：${ehlo.code}`)
    }

    if (smtp.username) await authenticate(channel, smtp, ehlo.text)

    await channel.expect(`MAIL FROM:<${bareAddress(smtp.from)}>`, [250])
    await channel.expect(`RCPT TO:<${message.to}>`, [250, 251])
    await channel.expect('DATA', [354])
    channel.write(`${buildMessage(smtp, message)}${CRLF}.${CRLF}`)
    const accepted = await channel.next()
    if (accepted.code !== 250) throw new Error(`SMTP 服务器拒收了邮件：${accepted.code}`)
    await channel.command('QUIT').catch(() => undefined)
  } finally {
    try {
      channel.socket.destroy()
    } catch {
      // Already gone.
    }
  }
}

/**
 * The sign-up / password-reset mail, in Chinese like the rest of the client.
 * `minutes` is the code lifetime so the message never states a stale window.
 */
export function verificationEmail({ code, minutes, purpose }) {
  const action = purpose === 'reset' ? '重置密码' : '注册账号'
  return {
    subject: `Typeless ${action}验证码：${code}`,
    text: [
      `你的 Typeless ${action}验证码是：${code}`,
      '',
      `验证码 ${minutes} 分钟内有效，只能用一次。`,
      '如果不是你本人操作，忽略这封邮件即可，你的账号没有任何变化。',
      '',
      '—— Typeless 自建服务端'
    ].join('\n')
  }
}

export function createMailer(config, logger) {
  const smtp = config.smtp
  return {
    configured: Boolean(smtp.configured),
    /** Never throws: a mail failure becomes a 5xx at the route, not a crash. */
    async send({ to, subject, text }) {
      if (!smtp.configured) return { ok: false, reason: 'not_configured' }
      try {
        await deliver(smtp, { to, subject, text })
        return { ok: true }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        // The reason is a protocol line, never the message body or the password.
        logger.warn(`[mail] 发送失败（${bareAddress(to)} 未收到）：${reason}`)
        return { ok: false, reason }
      }
    }
  }
}
