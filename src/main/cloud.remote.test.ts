/** Opt-in contract tests against a deployed server, using disposable accounts. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mergeSettings } from '@shared/defaults'
import { AccountStore } from './account'
import { CloudClient, SyncEngine } from './cloud'
import { HistoryStore } from './history'
import { encodeWav } from './audio/wav'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

interface RemoteFixture {
  baseUrl: string
  accounts: Array<{ id: string; email: string; password: string }>
}
const fixturePath = process.env.TYPELESS_REMOTE_TEST_ACCOUNT
const fixture = fixturePath ? JSON.parse(readFileSync(fixturePath, 'utf8').replace(/^\uFEFF/, '')) as RemoteFixture : null
const suite = fixture ? describe : describe.skip

suite('deployed account, notes, audio and history contract', () => {
  let root = ''
  const stores: HistoryStore[] = []
  const clients: Array<{ client: CloudClient; accounts: AccountStore }> = []

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'typeless-deployed-'))
    for (const index of [0, 0, 1]) {
      const accounts = new AccountStore(join(root, `account-${clients.length}.json`))
      const client = new CloudClient(accounts)
      const user = fixture!.accounts[index]
      await client.authenticate(fixture!.baseUrl, 'login', user.email, user.password)
      clients.push({ client, accounts })
    }
  })

  afterAll(async () => {
    for (const store of stores) store.close()
    await Promise.all(clients.map(({ client }) => client.logout()))
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('matches capability flags and rotates one refresh token for concurrent calls', async () => {
    const { client, accounts } = clients[0]
    const meta = await client.meta(fixture!.baseUrl)
    expect(meta?.protocolVersion).toBe(1)
    expect(meta?.features.notesAudio).toBe(true)
    if (!meta?.smtpConfigured) expect(meta?.features.passwordReset).toBe(false)
    const session = accounts.get()!
    accounts.updateTokens('invalid-access-for-contract-test', session.refreshToken, 0)
    const [me, usage] = await Promise.all([client.me(), client.storage()])
    expect(me.userId).toBe(fixture!.accounts[0].id)
    expect(usage.quotaBytes).toBeGreaterThan(0)
    expect(accounts.get()?.accessToken).not.toBe('invalid-access-for-contract-test')
  }, 30_000)

  it('discovers audio uploaded after another device already pulled the text', async () => {
    const first = clients[0].client
    const second = clients[1].client
    const id = `release-audio-${randomUUID()}`
    const now = Date.now()
    await first.pushNotes([{ id, version: 0, createdAt: now, updatedAt: now, durationMs: 500,
      transcript: 'release audio contract', polished: '', polishStatus: 'skipped', tags: [] }])
    const before = await second.pullNotes(0, 200)
    const wav = encodeWav(new Int16Array(8000).fill(1000))
    await first.uploadNoteAudio(id, 'wav', wav)
    const after = await second.pullNotes(before.cursor, 200)
    const row = after.notes.find((raw) => (raw as { id: string }).id === id) as { audio?: { bytes: number } } | undefined
    expect(row?.audio?.bytes).toBe(wav.byteLength)
    expect(await second.downloadNoteAudio(id)).toEqual(wav)
    const denied = await fetch(`${fixture!.baseUrl}/api/v1/notes/${id}/audio`, {
      headers: { authorization: `Bearer ${clients[2].accounts.get()!.accessToken}` }
    })
    expect(denied.status).toBe(404)
    await first.pushNotes([{ id, version: 1, deleted: true }])
  }, 30_000)

  it('returns an explicit conflict and propagates deletion between devices', async () => {
    const [first, second] = clients.map(({ client }) => client)
    const id = `release-conflict-${randomUUID()}`
    const now = Date.now()
    const note = { id, createdAt: now, updatedAt: now, durationMs: 0, transcript: 'original', polished: '', polishStatus: 'skipped', tags: [] }
    await first.pushNotes([{ ...note, version: 0 }])
    await first.pushNotes([{ ...note, version: 1, updatedAt: now + 1, transcript: 'first device' }])
    const conflict = await second.pushNotes([{ ...note, version: 1, updatedAt: now + 2, transcript: 'second device' }])
    expect(conflict.status).toBe(409)
    expect(conflict.payload.conflicts?.[0].server?.transcript).toBe('first device')
    await first.pushNotes([{ id, version: 2, deleted: true }])
    const pulled = await second.pullNotes(0, 200)
    expect(pulled.notes.find((raw) => (raw as { id: string }).id === id)).toMatchObject({ deleted: true })
  }, 30_000)

  it('runs the real history sync engine between two devices and isolates accounts', async () => {
    const settings = mergeSettings({ syncEnabled: true, syncIntervalSeconds: 0, syncServerUrl: fixture!.baseUrl })
    const engines: SyncEngine[] = []
    for (let i = 0; i < clients.length; i++) {
      const dir = join(root, `device-${i}`)
      mkdirSync(dir)
      const store = new HistoryStore(join(dir, 'history.sqlite'))
      await store.load()
      stores.push(store)
      engines.push(new SyncEngine(store, clients[i].accounts, clients[i].client, () => settings, () => {}, join(dir, 'sync-state.json')))
    }
    const row = await stores[0].add({ mode: 'dictation', transcript: 'contract', final: 'deployed history', durationMs: 500 })
    expect((await engines[0].now()).lastError).toBe('')
    expect((await engines[1].now()).lastError).toBe('')
    expect(stores[1].get(row.id)?.final).toBe('deployed history')
    await engines[2].now()
    expect(stores[2].get(row.id)).toBeUndefined()
    await stores[1].update(row.id, { final: 'edited on second device' })
    await engines[1].now()
    await engines[0].now()
    expect(stores[0].get(row.id)?.final).toBe('edited on second device')
    await stores[0].remove(row.id)
    await engines[0].now()
    await engines[1].now()
    expect(stores[1].get(row.id)).toBeUndefined()
  }, 60_000)
})
