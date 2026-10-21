import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Settings } from '@shared/types'
import { AccountStore } from './account'
import { CloudClient, SyncEngine } from './cloud'
import { HistoryStore } from './history'

/**
 * The client against a real server, two machines, one account.
 *
 * Starts the actual server on an ephemeral local port by default. Set
 * `TYPELESS_LIVE_SERVER` to test a separate private test deployment instead.
 * These exercise field names, cursor semantics and tombstones over real HTTP.
 */

let LIVE = process.env.TYPELESS_LIVE_SERVER ?? ''
const live = it
let serverRoot = ''
let localApp: { server: Server; db: { close(): void } } | null = null

beforeAll(async () => {
  if (LIVE) return
  serverRoot = mkdtempSync(join(tmpdir(), 'typeless-live-server-'))
  const moduleRoot = new URL('../../server/src/', import.meta.url).href
  const { loadConfig } = await import(/* @vite-ignore */ `${moduleRoot}config.mjs`)
  const { createApp } = await import(/* @vite-ignore */ `${moduleRoot}app.mjs`)
  const { silentLogger } = await import(/* @vite-ignore */ `${moduleRoot}log.mjs`)
  const instance = createApp({ config: loadConfig({
    DATA_DIR: serverRoot, REGISTRATION_ENABLED: '1', EMAIL_VERIFICATION_REQUIRED: '0',
    LOG_LEVEL: 'silent', RATE_LIMIT_PER_MINUTE: '0', AUTH_LIMIT_PER_MINUTE: '0'
  }), logger: silentLogger }) as { server: Server; db: { close(): void } }
  localApp = instance
  await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve))
  LIVE = `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`
})

afterAll(async () => {
  if (!localApp) return
  await new Promise<void>((resolve) => localApp!.server.close(() => resolve()))
  localApp.db.close()
  rmSync(serverRoot, { recursive: true, force: true })
})

const mocks = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

interface Machine {
  dir: string
  store: HistoryStore
  accounts: AccountStore
  client: CloudClient
  sync: SyncEngine
}

let root = ''
const machines: Machine[] = []

function settings(): Settings {
  return { ...DEFAULT_SETTINGS, syncEnabled: true, syncIntervalSeconds: 0, syncServerUrl: LIVE }
}

/** A fresh `<userData>` with an empty history and its own session, like a second PC. */
async function machine(email: string, password: string, register: boolean): Promise<Machine> {
  const dir = join(root, `machine-${machines.length + 1}`)
  mkdirSync(dir, { recursive: true })
  mocks.userData = dir
  const store = new HistoryStore(join(dir, 'history.sqlite'))
  await store.load()
  const accounts = new AccountStore(join(dir, 'account.json'))
  const client = new CloudClient(accounts)
  if (register) await client.authenticate(LIVE, 'register', email, password)
  else await client.authenticate(LIVE, 'login', email, password)
  const sync = new SyncEngine(store, accounts, client, settings, () => undefined, join(dir, 'sync-state.json'))
  const built: Machine = { dir, store, accounts, client, sync }
  machines.push(built)
  return built
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'typeless-live-'))
})

afterEach(() => {
  for (const entry of machines) entry.store.close()
  machines.length = 0
  rmSync(root, { recursive: true, force: true })
})

describe('live sync', () => {
  live('carries rows, edits and deletions between two machines', async () => {
    const email = `live-${Date.now()}@test.local`
    const password = 'correct horse'
    const first = await machine(email, password, true)
    const added = await first.store.add({
      mode: 'dictation',
      transcript: '语音输入',
      final: '语音输入，一次说完。',
      durationMs: 1400
    })

    const pushed = await first.sync.now()
    expect(pushed.lastError).toBe('')
    expect(pushed.state).toBe('idle')

    // Second machine, same account, empty disk: the row has to arrive verbatim.
    const second = await machine(email, password, false)
    const pulled = await second.sync.now()
    expect(pulled.lastError).toBe('')
    const remote = second.store.get(added.id)
    expect(remote?.final).toBe('语音输入，一次说完。')
    expect(remote?.durationMs).toBe(1400)
    // Audio never travels: the wav belongs to the machine that recorded it.
    expect(remote?.audioPath).toBeUndefined()

    // An edit on the second machine travels back by last-write-wins.
    await second.store.update(added.id, { final: '语音输入，改过一遍。' })
    await second.sync.now()
    await first.sync.now()
    expect(first.store.get(added.id)?.final).toBe('语音输入，改过一遍。')

    // Deleting on the first machine has to remove it on the second, and the pull
    // must not resurrect it as a local row to push back.
    await first.store.remove(added.id)
    await first.sync.now()
    await second.sync.now()
    expect(second.store.get(added.id)).toBeUndefined()
    await second.sync.now()
    expect(second.sync.status().pending).toBe(0)
  }, 60_000)

  live('keeps one account out of another account\'s rows', async () => {
    const mine = await machine(`mine-${Date.now()}@test.local`, 'correct horse', true)
    const theirs = await machine(`theirs-${Date.now()}@test.local`, 'correct horse', true)
    const secret = await mine.store.add({
      mode: 'dictation',
      transcript: '私有内容',
      final: '私有内容。',
      durationMs: 800
    })
    await mine.sync.now()
    await theirs.sync.now()
    expect(theirs.store.get(secret.id)).toBeUndefined()
    expect(theirs.sync.accountView().remoteCount).toBe(0)
  }, 60_000)

  live('reports the server plan and storage quota without billing endpoints', async () => {
    const solo = await machine(`plan-${Date.now()}@test.local`, 'correct horse', true)
    const before = await solo.client.me()
    expect(before.subscription?.plan).toBe('trial')
    const usage = await solo.client.storage()
    expect(usage.noteCount).toBe(0)
    expect(usage.usedBytes).toBe(0)
    expect(usage.quotaBytes).toBeGreaterThan(0)
  }, 60_000)
})
