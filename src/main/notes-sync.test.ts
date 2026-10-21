/**
 * 随记 sync, end to end: the real NotesStore on disk, the real CloudClient over
 * HTTP, and the real self-hosted server running in this process.
 *
 * The point of an integration test here is that none of the three pieces can be
 * trusted alone. A version that agrees with itself in memory can still lose a
 * conflict on the wire, and an audio upload that the server stores under the
 * wrong row only shows up when a second device asks for it.
 *
 * The providers are mocked because no note in this test is ever recorded: the
 * notes are written straight to `notes.json`, which is also what a machine that
 * upgraded from a local-only build looks like.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mergeSettings } from '@shared/defaults'
import type { NoteEntry, Settings } from '@shared/types'
import { NotesStore } from './notes'
import { CloudClient, SyncEngine } from './cloud'
import type { AccountStore, Session } from './account'
import type { HistoryStore } from './history'

const mocks = vi.hoisted(() => ({ userData: '', transcribe: vi.fn(), complete: vi.fn(), toOggOpus: vi.fn() }))

vi.mock('electron', () => ({ app: { getPath: () => mocks.userData } }))
vi.mock('./providers/asr', () => ({ transcribe: mocks.transcribe }))
vi.mock('./providers/llm', async () => {
  const actual = await vi.importActual<typeof import('./providers/llm')>('./providers/llm')
  return { ...actual, complete: mocks.complete }
})
vi.mock('./audio/transcode', () => ({ toOggOpus: mocks.toOggOpus }))

interface AuthPayload {
  accessToken: string
  refreshToken: string
  expiresIn: number
  user: { id: string; email: string }
}

interface NotesPage {
  cursor: number
  notes: Array<Record<string, unknown>>
  hasMore: boolean
}

let root: string
let base: string
let server: Server
let closeServer: () => void

/**
 * The server is plain ESM JavaScript and lives outside the TypeScript project, so
 * a literal specifier would be a compile error and `allowJs` would drag the whole
 * server tree into this program. A computed specifier keeps the compiler out of
 * it; the shape each module has to satisfy is asserted by the cast at the call.
 */
const serverRoot = new URL('../../server/src/', import.meta.url).href

function loadServerModule(name: string): Promise<Record<string, unknown>> {
  return import(/* @vite-ignore */ `${serverRoot}${name}`) as Promise<Record<string, unknown>>
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'notes-sync-'))
  mocks.userData = join(root, 'userdata')
  mkdirSync(mocks.userData, { recursive: true })

  const { loadConfig } = (await loadServerModule('config.mjs')) as {
    loadConfig: (env: Record<string, string>) => unknown
  }
  const { createApp } = (await loadServerModule('app.mjs')) as {
    createApp: (input: { config: unknown; logger: unknown }) => {
      server: Server
      db: { close: () => void }
    }
  }
  const { silentLogger } = (await loadServerModule('log.mjs')) as {
    silentLogger: unknown
  }

  const config = loadConfig({
    DATA_DIR: join(root, 'server'),
    // No mailer in this test, so registration has to be opened by hand and the
    // address check turned off — exactly the private-instance recipe from the docs.
    REGISTRATION_ENABLED: '1',
    EMAIL_VERIFICATION_REQUIRED: '0',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_PER_MINUTE: '0',
    AUTH_LIMIT_PER_MINUTE: '0'
  })
  const app = createApp({ config, logger: silentLogger })
  server = app.server
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  closeServer = () => {
    server.close()
    app.db.close()
  }
})

afterAll(() => {
  closeServer?.()
  rmSync(root, { recursive: true, force: true })
})

async function signUp(email: string): Promise<Session> {
  const response = await fetch(`${base}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery' })
  })
  expect(response.status).toBeLessThan(300)
  const payload = (await response.json()) as AuthPayload
  return {
    serverUrl: base,
    email: payload.user.email,
    userId: payload.user.id,
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    accessExpiresAt: Date.now() + payload.expiresIn * 1000,
    subscription: null
  }
}

function accountsStub(initial: Session): AccountStore {
  let current: Session | null = initial
  return {
    get: () => current,
    set: (next: Session) => {
      current = next
    },
    updateTokens: (access: string, refresh: string, expiresIn: number) => {
      if (current) {
        current = { ...current, accessToken: access, refreshToken: refresh, accessExpiresAt: Date.now() + expiresIn * 1000 }
      }
    },
    expire: () => {
      current = null
    },
    clear: () => {
      current = null
    },
    needsSignIn: () => current === null,
    knownAccount: () => initial,
    setSubscription: () => undefined
  } as unknown as AccountStore
}

/**
 * A HistoryStore that holds nothing.
 *
 * The engine syncs history and notes in one pass; this test is about the notes
 * half, and an empty history keeps the request log readable.
 */
const emptyHistory = {
  pendingSince: () => 0,
  changesSince: () => [],
  deletionsSince: () => [],
  applyRemote: () => undefined,
  newestStamp: () => 0
} as unknown as HistoryStore

interface Device {
  dir: string
  settings: Settings
  store: NotesStore
  client: CloudClient
  engine: SyncEngine
}

async function device(name: string, session: Session, seed?: (dir: string) => void): Promise<Device> {
  const dir = join(root, name)
  mkdirSync(join(dir, 'notes', 'audio'), { recursive: true })
  const settings = mergeSettings({
    notesDir: dir,
    syncEnabled: true,
    syncIntervalSeconds: 0,
    syncServerUrl: base
  })
  seed?.(dir)
  const store = new NotesStore({ log: () => undefined, getSettings: () => settings })
  await store.load()
  const accounts = accountsStub(session)
  const client = new CloudClient(accounts)
  const engine = new SyncEngine(
    emptyHistory,
    accounts,
    client,
    () => settings,
    () => undefined,
    join(dir, 'sync-state.json'),
    store
  )
  return { dir, settings, store, client, engine }
}

/** Writes a note the way a local-only install already has it on disk. */
function seedNote(dir: string, note: Partial<NoteEntry> & { id: string }, audio?: Uint8Array): NoteEntry {
  const rel = audio ? `notes/audio/${note.id}.ogg` : undefined
  if (audio && rel) writeFileSync(join(dir, rel), audio)
  const entry: NoteEntry = {
    id: note.id,
    createdAt: note.createdAt ?? 1_700_000_000_000,
    updatedAt: note.updatedAt ?? 1_700_000_000_000,
    durationMs: note.durationMs ?? 2400,
    transcript: note.transcript ?? '把这句话记下来',
    polished: note.polished ?? '把这句话记下来。',
    polishStatus: note.polishStatus ?? 'ok',
    tags: note.tags ?? [],
    pending: true,
    ...(rel ? { audioPath: rel, audioFormat: 'ogg' as const, audioBytes: audio?.byteLength ?? 0 } : {})
  }
  writeFileSync(
    join(dir, 'notes.json'),
    `${JSON.stringify({ notes: [entry], categories: [], deleted: [] }, null, 2)}\n`,
    'utf8'
  )
  return entry
}

const audioBytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00, 0x11, 0x22, 0x33, 0x44])

describe('notes sync against the real server', () => {
  it('reports an audio upload failure and keeps the recording pending until retry succeeds', async () => {
    const session = await signUp('audio-upload-retry@example.com')
    const desktop = await device('audio-upload-retry', session, (dir) => seedNote(dir, { id: 'upload-retry' }, audioBytes))
    vi.spyOn(desktop.client, 'uploadNoteAudio').mockRejectedValueOnce(new Error('upload interrupted'))
    const failed = await desktop.engine.now()
    expect(failed.lastError).toContain('upload interrupted')
    expect(failed.pending).toBe(1)
    expect(desktop.store.audioPending()).toHaveLength(1)
    expect((await desktop.engine.now()).lastError).toBe('')
    expect(desktop.store.audioPending()).toHaveLength(0)
    expect(await desktop.client.downloadNoteAudio('upload-retry')).toEqual(audioBytes)
  })

  it('retries a failed recording download after the device restarts', async () => {
    const session = await signUp('audio-download-retry@example.com')
    const desktop = await device('audio-download-source', session, (dir) => seedNote(dir, { id: 'download-retry' }, audioBytes))
    await desktop.engine.now()
    const laptop = await device('audio-download-target', session)
    vi.spyOn(laptop.client, 'downloadNoteAudio').mockRejectedValueOnce(new Error('download interrupted'))
    expect((await laptop.engine.now()).lastError).toContain('download interrupted')
    expect(laptop.store.hasAudio('download-retry')).toBe(false)
    const restarted = await device('audio-download-target', session)
    expect((await restarted.engine.now()).lastError).toBe('')
    expect(new Uint8Array(restarted.store.audioData('download-retry')!.data)).toEqual(audioBytes)
  })

  it('propagates deletion of a new note removed while its first push is in flight', async () => {
    const session = await signUp('inflight-delete@example.com')
    const desktop = await device('inflight-delete', session, (dir) => seedNote(dir, { id: 'inflight-delete' }))
    const push = desktop.client.pushNotes.bind(desktop.client)
    let removed = false
    vi.spyOn(desktop.client, 'pushNotes').mockImplementation(async (changes) => {
      const result = await push(changes)
      if (!removed) {
        removed = true
        await desktop.store.remove('inflight-delete')
      }
      return result
    })
    await desktop.engine.now()
    expect(desktop.store.list().notes).toHaveLength(0)
    expect(desktop.store.pendingCount()).toBe(1)
    await desktop.engine.now()
    const remote = await desktop.client.request<NotesPage>('GET', '/api/v1/notes?since=0')
    expect(remote.notes[0].deleted).toBe(true)
    expect(desktop.store.pendingCount()).toBe(0)
  })

  it('keeps edits made while a note push is in flight for the next sync', async () => {
    const session = await signUp('inflight-note@example.com')
    const desktop = await device('inflight-note', session, (dir) => seedNote(dir, { id: 'inflight-note' }))
    const push = desktop.client.pushNotes.bind(desktop.client)
    let edited = false
    vi.spyOn(desktop.client, 'pushNotes').mockImplementation(async (changes) => {
      const result = await push(changes)
      if (!edited) {
        edited = true
        await desktop.store.update('inflight-note', { transcript: 'edited during sync' })
      }
      return result
    })
    await desktop.engine.now()
    expect(desktop.store.list().notes[0].transcript).toBe('edited during sync')
    expect(desktop.store.pendingCount()).toBe(1)
    await desktop.engine.now()
    const remote = await desktop.client.request<NotesPage>('GET', '/api/v1/notes?since=0')
    expect(remote.notes[0].transcript).toBe('edited during sync')
    expect(desktop.store.pendingCount()).toBe(0)
  })

  it('keeps an offline deletion pending when another device edited the note', async () => {
    const session = await signUp('delete-conflict@example.com')
    const desktop = await device('delete-conflict-desktop', session, (dir) => seedNote(dir, { id: 'delete-conflict' }))
    await desktop.engine.now()
    const laptop = await device('delete-conflict-laptop', session)
    await laptop.engine.now()
    desktop.store.remove('delete-conflict')
    laptop.store.update('delete-conflict', { transcript: 'updated elsewhere' })
    await laptop.engine.now()
    await desktop.engine.now()
    expect(desktop.store.list().notes).toHaveLength(0)
    expect(desktop.store.pendingCount()).toBe(1)
    await desktop.engine.now()
    await laptop.engine.now()
    expect(desktop.store.pendingCount()).toBe(0)
    expect(laptop.store.list().notes).toHaveLength(0)
  })

  it('pages a mixed batch of new notes and deletions within the server limit', async () => {
    const session = await signUp('mixed-batch@example.com')
    const desktop = await device('mixed-batch', session)
    const notes = Array.from({ length: 201 }, (_, i) => ({
      id: `mixed-${i}`, createdAt: 1700000000000, updatedAt: 1700000000000,
      durationMs: 0, transcript: 'note', polished: '', polishStatus: 'skipped', tags: [], pending: true
    }))
    writeFileSync(join(desktop.dir, 'notes.json'), JSON.stringify({ notes, categories: [] }))
    await desktop.store.load()
    // 200 unsent notes plus one deletion used to produce a 201-row request.
    const remote = notes[200]
    await desktop.client.pushNotes([{ ...remote, version: 0 }])
    desktop.store.markPushed([{ id: remote.id, version: 1 }])
    desktop.store.remove(remote.id)
    const status = await desktop.engine.now()
    expect(status.lastError).toBe('')
    expect(desktop.store.pendingCount()).toBe(0)
  })

  it('pushes a note with its recording and pulls both on another machine', async () => {
    const alice = await signUp('alice@example.com')
    const desktop = await device('desktop', alice, (dir) => seedNote(dir, { id: 'note-one' }, audioBytes))

    const status = await desktop.engine.now()
    expect(status.state).toBe('idle')
    expect(status.pending).toBe(0)

    const remote = await desktop.client.request<NotesPage>('GET', '/api/v1/notes?since=0')
    expect(remote.notes).toHaveLength(1)
    expect(remote.notes[0].transcript).toBe('把这句话记下来')
    expect(remote.notes[0].version).toBe(1)
    expect((remote.notes[0].audio as { bytes: number }).bytes).toBe(audioBytes.byteLength)

    const laptop = await device('laptop', alice)
    const pulled = await laptop.engine.now()
    expect(pulled.state).toBe('idle')

    const notes = laptop.store.list().notes
    expect(notes).toHaveLength(1)
    expect(notes[0].id).toBe('note-one')
    expect(notes[0].transcript).toBe('把这句话记下来')
    expect(notes[0].version).toBe(1)
    expect(laptop.store.hasAudio('note-one')).toBe(true)
    expect(new Uint8Array(readFileSync(join(laptop.dir, 'notes/audio/note-one.ogg')))).toEqual(audioBytes)
  })

  it('keeps both sides of a conflict instead of overwriting', async () => {
    const bob = await signUp('bob@example.com')
    const desktop = await device('bob-desktop', bob, (dir) => seedNote(dir, { id: 'note-two', transcript: '原始内容', polished: '原始内容' }))
    await desktop.engine.now()

    const laptop = await device('bob-laptop', bob)
    await laptop.engine.now()
    expect(laptop.store.list().notes).toHaveLength(1)

    desktop.store.update('note-two', { transcript: '桌面上的修改' })
    laptop.store.update('note-two', { transcript: '笔记本上的修改' })

    await desktop.engine.now()
    await laptop.engine.now()

    // The laptop lost the race, so it now holds the server's text plus its own as
    // a separate note. Nothing the user typed disappeared.
    const texts = laptop.store.list().notes.map((note) => note.transcript).sort()
    expect(texts).toEqual(['桌面上的修改', '笔记本上的修改'])
    const fork = laptop.store.list().notes.find((note) => note.transcript === '笔记本上的修改')
    expect(fork?.tags).toContain('冲突副本')
    expect(fork?.version).toBeUndefined()

    // The next pass pushes the fork, so the server ends up holding both versions too.
    await laptop.engine.now()
    const remote = await laptop.client.request<NotesPage>('GET', '/api/v1/notes?since=0')
    const live = remote.notes.filter((note) => note.deleted !== true)
    expect(live.map((note) => note.transcript).sort()).toEqual(['桌面上的修改', '笔记本上的修改'])
  })

  it('propagates a deletion to the other machine', async () => {
    const carol = await signUp('carol@example.com')
    const desktop = await device('carol-desktop', carol, (dir) => seedNote(dir, { id: 'note-three' }))
    await desktop.engine.now()

    const laptop = await device('carol-laptop', carol)
    await laptop.engine.now()
    expect(laptop.store.list().notes).toHaveLength(1)

    desktop.store.remove('note-three')
    await desktop.engine.now()
    await laptop.engine.now()

    expect(laptop.store.list().notes).toHaveLength(0)
    expect(laptop.store.hasAudio('note-three')).toBe(false)
  })

  it('syncs text-only creation, edits and deletion without requesting recording uploads', async () => {
    const session = await signUp('text-notes@example.com')
    const desktop = await device('text-desktop', session)
    const created = await desktop.store.createText({ text: '文字随记 😀\n跨端同步' })
    await desktop.engine.now()
    const laptop = await device('text-laptop', session)
    await laptop.engine.now()
    const received = laptop.store.list().notes[0]
    expect(received).toMatchObject({ id: created.id, transcript: created.transcript, durationMs: 0, polishStatus: 'skipped' })
    expect(received.audioPath).toBeUndefined()
    expect(laptop.store.hasAudio(created.id)).toBe(false)
    const usage = await desktop.client.storage()
    expect(usage.noteCount).toBe(1)
    expect(usage.audioCount).toBe(0)
    expect(usage.usedBytes).toBe(0)
    await laptop.store.update(created.id, { transcript: '另一端修订', tags: ['重点'] })
    await laptop.engine.now()
    await desktop.engine.now()
    expect(desktop.store.list().notes[0]).toMatchObject({ transcript: '另一端修订', tags: ['重点'] })
    await desktop.store.remove(created.id)
    await desktop.engine.now()
    await laptop.engine.now()
    expect(laptop.store.list().notes).toHaveLength(0)
  })

  it('reports usage from the server, not from the local files', async () => {
    const dave = await signUp('dave@example.com')
    const desktop = await device('dave-desktop', dave, (dir) => seedNote(dir, { id: 'note-four' }, audioBytes))
    await desktop.engine.now()

    const usage = await desktop.client.storage()
    expect(usage.noteCount).toBe(1)
    expect(usage.audioCount).toBe(1)
    expect(usage.usedBytes).toBe(audioBytes.byteLength)
    expect(usage.quotaBytes).toBeGreaterThanOrEqual(audioBytes.byteLength)
  })
})
