import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Settings } from '@shared/types'
import { AccountStore } from './account'
import { CloudClient, CloudError, SyncEngine } from './cloud'
import { HistoryStore } from './history'

/**
 * The sync client against a fake server.
 *
 * These lock down the two things that are invisible until someone runs two
 * machines: the token refresh has to be transparent (a stale access token must not
 * surface as "登录已过期" every fifteen minutes), and a sync must be idempotent — a
 * second run with nothing new has to send nothing, because the pull cursor is what
 * stops the same rows ping-ponging between machines forever.
 */

const mocks = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

interface Reply {
  status: number
  body: unknown
}

interface Call {
  url: string
  method: string
  body: Record<string, unknown> | undefined
  auth: string
}

interface Route {
  match: (url: string, method: string) => boolean
  /** Consumed one per call while more than one remains; the last one sticks. */
  replies: Reply[]
}

let dir = ''
let routes: Route[] = []
let calls: Call[] = []
let stores: HistoryStore[] = []

function route(fragment: string, method: string, ...replies: Reply[]): void {
  routes.push({ match: (url, verb) => url.includes(fragment) && verb === method, replies })
}

function callsTo(fragment: string, method?: string): Call[] {
  return calls.filter((call) => call.url.includes(fragment) && (!method || call.method === method))
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, syncEnabled: true, syncIntervalSeconds: 0, ...overrides }
}

function openStore(): HistoryStore {
  const store = new HistoryStore(join(dir, 'history.sqlite'))
  stores.push(store)
  return store
}

function signIn(accounts: AccountStore, accessToken = 'access-1'): void {
  accounts.set({
    serverUrl: 'http://server.test:8787',
    email: 'a@b.test',
    userId: 'u1',
    accessToken,
    refreshToken: 'refresh-1',
    accessExpiresAt: Date.now() + 60_000,
    subscription: null
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'typeless-cloud-'))
  mocks.userData = dir
  routes = []
  calls = []
  stores = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      const method = (init?.method ?? 'GET').toUpperCase()
      const headers = (init?.headers ?? {}) as Record<string, string>
      const raw = init?.body
      calls.push({
        url,
        method,
        body: typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
        auth: headers.authorization ?? headers.Authorization ?? ''
      })
      const hit = routes.find((entry) => entry.match(url, method))
      const reply = !hit
        ? { status: 404, body: { error: 'not_found' } }
        : hit.replies.length > 1
          ? hit.replies.shift()!
          : hit.replies[0]
      return {
        ok: reply.status < 400,
        status: reply.status,
        text: async () => (typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body))
      }
    })
  )
})

afterEach(() => {
  for (const store of stores) store.close()
  stores = []
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

describe('CloudClient', () => {
  it('reads server registration and password-reset capabilities before login', async () => {
    const client = new CloudClient(new AccountStore(join(dir, 'account.json')))
    route('/api/v1/meta', 'GET', { status: 200, body: {
      version: '2.0.1', protocolVersion: 1, registrationEnabled: false,
      emailVerificationRequired: true, smtpConfigured: false,
      features: { passwordReset: false, notes: true, notesAudio: true, history: true }
    } })
    const meta = await client.meta('server.test:8787')
    expect(meta?.registrationEnabled).toBe(false)
    expect(meta?.features.passwordReset).toBe(false)
    expect(callsTo('/meta')[0].auth).toBe('')
  })

  it('shares a token rotation between simultaneous unauthorized requests', async () => {
    const accounts = new AccountStore(join(dir, 'account.json'))
    const client = new CloudClient(accounts)
    signIn(accounts)
    route('/api/v1/auth/me', 'GET',
      { status: 401, body: { error: 'token_expired' } },
      { status: 401, body: { error: 'token_expired' } },
      { status: 200, body: { user: { id: 'u1', email: 'a@b.test' } } })
    route('/api/v1/auth/refresh', 'POST',
      { status: 200, body: { accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 900 } },
      { status: 401, body: { error: 'invalid_refresh' } })
    await expect(Promise.all([client.me(), client.me()])).resolves.toHaveLength(2)
    expect(callsTo('/auth/refresh')).toHaveLength(1)
    expect(accounts.get()?.refreshToken).toBe('refresh-2')
  })

  it('keeps the session when token rotation temporarily fails', async () => {
    const accounts = new AccountStore(join(dir, 'account.json'))
    const client = new CloudClient(accounts)
    signIn(accounts)
    route('/api/v1/auth/refresh', 'POST', { status: 503, body: { error: 'unavailable' } })
    await expect(client.refresh()).rejects.toBeInstanceOf(CloudError)
    expect(accounts.get()?.refreshToken).toBe('refresh-1')
    expect(accounts.needsSignIn()).toBe(false)
  })

  it('normalizes the same scheme-less address used by settings before login', async () => {
    const accounts = new AccountStore(join(dir, 'account.json'))
    const client = new CloudClient(accounts)
    route('/api/v1/auth/login', 'POST', { status: 200, body: {
      accessToken: 'a', refreshToken: 'r', expiresIn: 900, user: { id: 'u1', email: 'a@b.test' }
    } })
    await client.authenticate(' server.test:8787/ ', 'login', 'a@b.test', 'password')
    expect(callsTo('/auth/login')[0].url).toBe('http://server.test:8787/api/v1/auth/login')
    expect(accounts.get()?.serverUrl).toBe('http://server.test:8787')
  })

  it('refreshes a stale access token and replays the request once', async () => {
    const accounts = new AccountStore(join(dir, 'account.json'))
    const client = new CloudClient(accounts)
    signIn(accounts)

    route(
      '/api/v1/auth/me',
      'GET',
      { status: 401, body: { error: 'token_expired' } },
      { status: 200, body: { user: { id: 'u1', email: 'a@b.test', subscription: null } } }
    )
    route('/api/v1/auth/refresh', 'POST', {
      status: 200,
      body: {
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
        expiresIn: 900,
        user: { id: 'u1', email: 'a@b.test', subscription: null }
      }
    })

    const me = await client.me()

    expect(me.email).toBe('a@b.test')
    expect(callsTo('/auth/me')).toHaveLength(2)
    // The replay has to carry the new token: a literal `${...}` in the URL would
    // have produced a request to a nonsense path instead.
    expect(callsTo('/auth/me')[1].url).toBe('http://server.test:8787/api/v1/auth/me')
    expect(callsTo('/auth/me')[1].auth).toBe('Bearer access-2')
    expect(callsTo('/auth/refresh')[0].body?.refreshToken).toBe('refresh-1')
    expect(accounts.get()?.refreshToken).toBe('refresh-2')
  })

  it('drops the session when the refresh token is rejected', async () => {
    const accounts = new AccountStore(join(dir, 'account.json'))
    const client = new CloudClient(accounts)
    signIn(accounts)
    route('/api/v1/auth/me', 'GET', { status: 401, body: { error: 'token_expired' } })
    route('/api/v1/auth/refresh', 'POST', { status: 401, body: { error: 'refresh_expired' } })

    await expect(client.me()).rejects.toBeInstanceOf(CloudError)
    expect(accounts.get()).toBeNull()
    expect(accounts.needsSignIn()).toBe(true)
  })

  it('surfaces the server message instead of a bare status code', async () => {
    const accounts = new AccountStore(join(dir, 'account.json'))
    const client = new CloudClient(accounts)
    signIn(accounts)
    route('/api/v1/transcription_history/push', 'POST', {
      status: 413,
      body: { error: 'too_large', message: '这一页太大了' }
    })

    await expect(client.request('POST', '/api/v1/transcription_history/push', {})).rejects.toThrow('这一页太大了')
  })

  it('asks for a sign-up code by default and a reset code on demand', async () => {
    const accounts = new AccountStore(join(dir, 'account.json'))
    const client = new CloudClient(accounts)
    route('/api/v1/auth/code', 'POST', { status: 200, body: { ok: true, sent: true, required: true } })

    await expect(client.requestCode('http://server.test:8787', 'a@b.test')).resolves.toEqual({ required: true })
    await expect(client.requestCode('http://server.test:8787', 'a@b.test', 'reset')).resolves.toEqual({
      required: true
    })

    // The purpose is what stops a sign-up code from resetting a password on the
    // server, so the default has to be explicit on the wire.
    expect(callsTo('/auth/code')[0].body).toMatchObject({ email: 'a@b.test', purpose: 'register' })
    expect(callsTo('/auth/code')[1].body).toMatchObject({ email: 'a@b.test', purpose: 'reset' })
  })

  it('posts a password reset without a session', async () => {
    const accounts = new AccountStore(join(dir, 'account.json'))
    const client = new CloudClient(accounts)
    route('/api/v1/auth/password/reset', 'POST', { status: 200, body: { ok: true, revokedSessions: 2 } })

    await client.resetPassword('http://server.test:8787', 'a@b.test', '123456', 'correct horse')

    const call = callsTo('/auth/password/reset')[0]
    expect(call.body).toEqual({ email: 'a@b.test', code: '123456', password: 'correct horse' })
    // Resetting happens while signed out; sending the stale bearer here would
    // make the server revoke a session the caller is trying to recover.
    expect(call.auth).toBe('')
  })
})

describe('SyncEngine', () => {
  it('keeps a history edit made while the push/pull cycle is in flight pending', async () => {
    const store = openStore()
    await store.load()
    const row = await store.add({ mode: 'dictation', transcript: 'old', final: 'old', durationMs: 0 })
    const accounts = new AccountStore(join(dir, 'account.json'))
    signIn(accounts)
    route('/transcription_history/push', 'POST', { status: 200, body: { accepted: 1 } })
    route('/transcription_history/pull', 'GET', { status: 200, body: { entries: [], hasMore: false, nextSince: 0 } })
    route('/transcription_history/sync_status', 'GET', { status: 200, body: { count: 1 } })
    const transport = globalThis.fetch
    let edited = false
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes('/pull') && !edited) {
        edited = true
        await store.update(row.id, { final: 'edited during sync' })
      }
      return transport(input, init)
    })
    const sync = engine(store, accounts)
    expect((await sync.now()).pending).toBe(1)
    await sync.now()
    expect(callsTo('/push')).toHaveLength(2)
    expect((callsTo('/push')[1].body?.entries as Array<{ final: string }>)[0].final).toBe('edited during sync')
  })

  function engine(store: HistoryStore, accounts: AccountStore, overrides: Partial<Settings> = {}): SyncEngine {
    const client = new CloudClient(accounts)
    return new SyncEngine(store, accounts, client, () => settings(overrides), () => undefined, join(dir, 'sync-state.json'))
  }

  it('pushes local rows once and sends nothing on the next run', async () => {
    const store = openStore()
    await store.load()
    await store.add({ mode: 'dictation', transcript: '一', final: '一。', durationMs: 500 })
    await store.add({ mode: 'dictation', transcript: '二', final: '二。', durationMs: 600 })
    const accounts = new AccountStore(join(dir, 'account.json'))
    signIn(accounts)
    route('/transcription_history/push', 'POST', { status: 200, body: { revision: 1, accepted: 2, deleted: 0 } })
    route('/transcription_history/pull', 'GET', {
      status: 200,
      body: { revision: 1, entries: [], hasMore: false, nextSince: 0 }
    })
    route('/transcription_history/sync_status', 'GET', { status: 200, body: { revision: 1, count: 2 } })

    const sync = engine(store, accounts)
    const first = await sync.now()

    expect(first.lastError).toBe('')
    const pushes = callsTo('/push')
    expect(pushes).toHaveLength(1)
    const entries = pushes[0].body?.entries as Array<Record<string, unknown>>
    expect(entries).toHaveLength(2)
    // The wav is a local fact; sending the path would leak it and mean nothing on
    // the other machine.
    expect(entries.every((row) => !('audioPath' in row))).toBe(true)

    await sync.now()

    expect(callsTo('/push')).toHaveLength(1)
    expect(sync.status().pending).toBe(0)
  })

  it('applies pulled rows and honours tombstones', async () => {
    const store = openStore()
    await store.load()
    const doomed = await store.add({ mode: 'dictation', transcript: '删', final: '删。', durationMs: 400 })
    const remote = {
      id: 'remote-1',
      createdAt: 1000,
      updatedAt: 2000,
      mode: 'dictation',
      transcript: '远端',
      final: '远端。',
      durationMs: 700,
      deleted: false
    }
    const accounts = new AccountStore(join(dir, 'account.json'))
    signIn(accounts)
    route('/transcription_history/push', 'POST', { status: 200, body: { revision: 2, accepted: 0, deleted: 1 } })
    route('/transcription_history/pull', 'GET', {
      status: 200,
      body: {
        revision: 2,
        entries: [remote, { id: doomed.id, deleted: true, updatedAt: Date.now() + 1000 }],
        hasMore: false,
        nextSince: Date.now() + 1000
      }
    })
    route('/transcription_history/sync_status', 'GET', { status: 200, body: { revision: 2, count: 1 } })

    const sync = engine(store, accounts)
    await sync.now()

    expect(store.get('remote-1')?.final).toBe('远端。')
    expect(store.get(doomed.id)).toBeUndefined()
    expect(sync.accountView().remoteCount).toBe(1)
    // The deleted row came from the server, so it must not be echoed back as a
    // local deletion on the next push.
    expect(callsTo('/push')[0].body?.deleted).toEqual([])
  })

  it('stays inert when sync is switched off', async () => {
    const store = openStore()
    await store.load()
    const accounts = new AccountStore(join(dir, 'account.json'))
    signIn(accounts)
    const sync = engine(store, accounts, { syncEnabled: false })

    const status = await sync.now()

    expect(status.enabled).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('records the failure and keeps the session when the server is unreachable', async () => {
    const store = openStore()
    await store.load()
    const accounts = new AccountStore(join(dir, 'account.json'))
    signIn(accounts)
    route('/transcription_history/pull', 'GET', { status: 500, body: { error: 'boom', message: '服务器打嗝了' } })

    const sync = engine(store, accounts)
    const status = await sync.now()

    expect(status.state).toBe('error')
    expect(status.lastError).toBe('服务器打嗝了')
    expect(accounts.get()).not.toBeNull()
  })

  it('does not undo a wipe by pushing the local rows straight back', async () => {
    const store = openStore()
    await store.load()
    await store.add({ mode: 'dictation', transcript: '留着', final: '留着。', durationMs: 500 })
    const accounts = new AccountStore(join(dir, 'account.json'))
    signIn(accounts)
    route('/transcription_history/wipe', 'DELETE', { status: 200, body: { revision: 3, cursor: 42 } })
    route('/transcription_history/push', 'POST', { status: 200, body: { revision: 4, accepted: 0, deleted: 0 } })
    route('/transcription_history/pull', 'GET', {
      status: 200,
      body: { revision: 4, entries: [], hasMore: false, nextSince: 42 }
    })
    route('/transcription_history/sync_status', 'GET', { status: 200, body: { revision: 4, count: 0 } })

    const sync = engine(store, accounts)
    await sync.wipeRemote()

    expect(callsTo('/wipe', 'DELETE')).toHaveLength(1)
    // The button empties the server, not this machine. Rewinding both cursors to
    // zero — the obvious implementation — would upload every row again on the next
    // run and hand the pull the very tombstones the wipe had just created.
    await sync.now()

    expect(store.changesSince(0)).toHaveLength(1)
    expect(callsTo('/push')).toHaveLength(0)
    expect(callsTo('/pull')[0].url).toContain('since=42')
    expect(sync.status().pending).toBe(0)
  })
})
