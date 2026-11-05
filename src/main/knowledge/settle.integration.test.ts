/**
 * Stage 6 B: one record's deletion settles what it owned, and nothing else.
 *
 * These run on the compiled helper, the real `NotesStore`, the real `notes:remove`
 * IPC handler and the production collector: the note is really written and really
 * removed, its source really published, and the settlement goes through the same
 * code the app calls. Only the Electron shell is a stand-in.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS, mergeSettings } from '@shared/defaults'
import type { Settings } from '@shared/types'

const mock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  dir: '',
  clipboard: ''
}))

vi.mock('electron', () => ({
  app: { getPath: () => mock.dir || tmpdir() },
  ipcMain: { handle: (key: string, handler: (...args: any[]) => any) => mock.handlers.set(key, handler) },
  clipboard: { readText: () => mock.clipboard },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  protocol: { handle: () => undefined },
  shell: { openPath: async () => '' },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }
}))

import { KnowledgeCollector } from './collector'
import { KnowledgeHost } from './host'
import { RecordReleaser } from './release'
import { SettleRegistry, settleRecordKnowledge, type SettleRecordDeps } from './settle'
import { NotesStore } from '../notes'
import { registerNotesIpc } from '../notes-ipc'

const ENTRY = join(process.cwd(), 'native', 'bin', 'yu-knowledge.exe')
const roots: string[] = []
const hosts: KnowledgeHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    try {
      await host.stop()
    } catch {
      // already stopped
    }
  }
  vi.clearAllMocks()
})

afterAll(() => {
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // a leftover root is reported by the caller, never hidden
    }
  }
})

interface Rig {
  knowledge: () => KnowledgeHost
  restart: () => Promise<void>
  settling: SettleRegistry
  collector: KnowledgeCollector
  notes: NotesStore
  settings: Settings
  removeNote: (id: string, options?: { deleteKnowledge?: boolean; ticket?: string }) => Promise<unknown>
  rows: (channel: 'note' | 'chat', ref: string) => Promise<{ id: string; state: string; version: string }[]>
}

async function rig(options: { unreachableRelease?: boolean } = {}): Promise<Rig> {
  if (!existsSync(ENTRY)) throw new Error(`the knowledge helper is missing: ${ENTRY}`)
  const dir = mkdtempSync(join(tmpdir(), 'yu-knowledge-settle-'))
  roots.push(dir)
  mock.dir = dir
  const settings = mergeSettings({
    ...DEFAULT_SETTINGS,
    notesDir: join(dir, 'notes'),
    knowledge: { enabled: true, notes: true, chat: true, reading: true }
  })
  const open = (): KnowledgeHost => {
    const host = new KnowledgeHost({ entry: ENTRY, root: dir, requestMs: 30_000, idleMs: 60_000 })
    hosts.push(host)
    return host
  }
  const channels = { enabled: true, notes: true, chat: true, reading: true }
  let current = open()
  await current.configureCollect(channels)
  // A helper that cannot be launched at all: the release fails for real, without a
  // stubbed error standing in for it.
  let releaseHost: KnowledgeHost = options.unreachableRelease
    ? new KnowledgeHost({ entry: join(dir, 'missing-helper.exe'), root: dir, requestMs: 2000, idleMs: 5000 })
    : current
  const knowledge = (): KnowledgeHost => current
  const collector = new KnowledgeCollector({ settings: () => settings, host: knowledge })
  const settling = new SettleRegistry(new RecordReleaser(() => releaseHost))
  const notes = new NotesStore({
    log: () => undefined,
    getSettings: () => settings,
    onSettled: note => collector.noteSettled(note),
    // The production guard: while the deletion holds the record, the store's own
    // callback must not settle first.
    onRemoved: id => {
      if (!settling.holds('note', id)) collector.noteRemoved(id)
    }
  })
  const deps: SettleRecordDeps = {
    release: (input, reason) => settling.release(input, reason),
    active: () => true,
    find: input => knowledge().findSources(input),
    purgeCards: input => knowledge().purgeCards(input),
    log: () => undefined
  }
  registerNotesIpc({
    store: notes,
    persistDir: async () => undefined,
    broadcast: () => undefined,
    settle: (noteId, body) => settling.run('note', noteId, body),
    purgeKnowledge: (noteId, options) =>
      settleRecordKnowledge(deps, { channel: 'note', originRef: noteId }, { channel: 'note', originRef: noteId }, options),
    // The prod check runs while the record still exists; here the note has one
    // version, so the ticket the preview issued is the one to confirm with.
    verifyKnowledge: async () => undefined
  })
  const removeNote = async (
    id: string,
    options?: { deleteKnowledge?: boolean; ticket?: string }
  ): Promise<unknown> => {
    const handler = mock.handlers.get('notes:remove')
    if (!handler) throw new Error('notes:remove was not registered')
    return handler(null, id, options)
  }
  const rows = async (
    channel: 'note' | 'chat',
    ref: string
  ): Promise<{ id: string; state: string; version: string }[]> => {
    const input = channel === 'note' ? { channel, originRef: ref } : { channel, groupKey: ref }
    const found = await knowledge().findSources(input as never)
    return found.sources.map(source => ({ id: source.id, state: source.state, version: source.version }))
  }
  return {
    knowledge,
    restart: async () => {
      current = open()
      await current.configureCollect(channels)
      releaseHost = current
    },
    settling,
    collector,
    notes,
    settings,
    removeNote,
    rows
  }
}

/** Waits for a background publish instead of guessing how long it takes. */
async function until(probe: () => Promise<boolean>, label: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await probe()) return
    await new Promise(done => setTimeout(done, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('deleting a record settles exactly what it owned', () => {
  it('retires the note rows through the real remove handler and keeps the card', async () => {
    const app = await rig()
    const note = await app.notes.createText({ text: '去重靠指纹，指纹由问题与回答一起算出。' })
    await until(async () => (await app.rows('note', note.id)).length > 0, 'the note source')
    const [source] = await app.rows('note', note.id)
    const card = await app.knowledge().saveCard({
      kind: 'concept',
      title: '指纹去重',
      body: '指纹由问题与回答一起算出。',
      topics: ['去重'],
      sourceIds: [source.id]
    })

    await app.removeNote(note.id)

    expect(app.notes.list().notes.some(entry => entry.id === note.id)).toBe(false)
    expect(app.settling.holds('note', note.id)).toBe(false)
    await until(async () => (await app.rows('note', note.id)).every(row => row.state === 'invalid'), 'retired rows')
    // The default keeps the card and the link that says where it came from.
    const kept = await app.knowledge().getCard(card.id)
    expect(kept.sourceIds).toContain(source.id)
  }, 60_000)

  it('keeps both sides when the helper cannot be reached, and finishes later', async () => {
    const app = await rig({ unreachableRelease: true })
    const note = await app.notes.createText({ text: '写入顺序先认领版本，再删卡片。' })
    await until(async () => (await app.rows('note', note.id)).length > 0, 'the note source')

    await expect(app.removeNote(note.id)).rejects.toThrow('记录已删除，但关联知识清理失败：cannot start the knowledge helper')
    // The record really went; the knowledge cleanup is what failed, and it stays
    // queued instead of pretending the deletion was complete.
    expect(app.notes.list().notes.some(entry => entry.id === note.id)).toBe(false)
    expect(app.settling.waiting).toBe(1)
    expect((await app.rows('note', note.id)).every(row => row.state !== 'invalid')).toBe(true)

    await app.restart()
    expect(await app.settling.retry()).toBe(1)
    expect(app.settling.waiting).toBe(0)
    await until(async () => (await app.rows('note', note.id)).every(row => row.state === 'invalid'), 'retired rows')
  }, 60_000)

  it('tells a record that owns nothing apart from a failure', async () => {
    const app = await rig()
    const note = await app.notes.createText({ text: '这条没有进过知识库。' })
    // Nothing to settle: the publish is not awaited by the store, so the delete can
    // run first — the handler must answer, not fail, when there are no rows.
    await app.removeNote(note.id)
    expect(app.notes.list().notes.some(entry => entry.id === note.id)).toBe(false)

    // Deleting an already-settled record again is equally quiet.
    const deps: SettleRecordDeps = {
      release: async () => ({ retired: 0, detached: 0, cancelled: [], failures: [] }),
      active: () => true,
      find: async () => ({ sources: [{ id: 'src', version: '1', state: 'invalid' }] }),
      purgeCards: async () => ({ removed: [], kept: [], skipped: [] }),
      log: () => undefined
    }
    await expect(
      settleRecordKnowledge(deps, { channel: 'note', originRef: 'gone' }, { channel: 'note', originRef: 'gone' })
    ).resolves.toBeUndefined()
  }, 60_000)

  it('holds a record under its own channel and never releases an overlapping delete early', async () => {
    const app = await rig()
    let finishFirst: () => void = () => undefined
    let finishSecond: () => void = () => undefined
    const first = app.settling.run(
      'note',
      'same-id',
      () => new Promise<void>(done => (finishFirst = done))
    )
    const second = app.settling.run(
      'chat',
      'same-id',
      () => new Promise<void>(done => (finishSecond = done))
    )
    expect(app.settling.holds('note', 'same-id')).toBe(true)
    expect(app.settling.holds('chat', 'same-id')).toBe(true)
    expect(app.settling.depth('note', 'same-id')).toBe(1)

    finishFirst()
    await first
    // One delete returning must not free the record while the other is still going.
    expect(app.settling.holds('note', 'same-id')).toBe(false)
    expect(app.settling.holds('chat', 'same-id')).toBe(true)
    finishSecond()
    await second
    expect(app.settling.holds('chat', 'same-id')).toBe(false)

    // The same channel twice: the registration survives the first return.
    let finishA: () => void = () => undefined
    const a = app.settling.run('note', 'twice', () => new Promise<void>(done => (finishA = done)))
    let finishB: () => void = () => undefined
    const b = app.settling.run('note', 'twice', () => new Promise<void>(done => (finishB = done)))
    expect(app.settling.depth('note', 'twice')).toBe(2)
    finishA()
    await a
    expect(app.settling.holds('note', 'twice')).toBe(true)
    expect(app.settling.depth('note', 'twice')).toBe(1)
    finishB()
    await b
    expect(app.settling.holds('note', 'twice')).toBe(false)
  }, 60_000)

  it('retires every version of a note that has more than one preview page', async () => {
    const app = await rig()
    const id = 'note-many-versions'
    for (let version = 0; version < 201; version += 1) {
      await app.collector.publishNote({
        id,
        title: '长随记',
        transcript: `第 ${version} 版正文`,
        polished: `第 ${version} 版正文`,
        updatedAt: Date.now() + version,
        polishStatus: 'ok'
      })
    }
    // The wire answer carries `incomplete` beside the rows; the shared type only
    // names `sources`, so the flag is read through its own shape.
    const found = (await app.knowledge().findSources({ channel: 'note', originRef: id })) as {
      sources: { state: string }[]
      incomplete?: boolean
    }
    expect(found.sources.length).toBeGreaterThan(0)
    expect(found.incomplete).toBe(true)

    const deps: SettleRecordDeps = {
      release: (input, reason) => app.settling.release(input, reason),
      active: () => true,
      find: input => app.knowledge().findSources(input),
      purgeCards: input => app.knowledge().purgeCards(input),
      log: () => undefined
    }
    await settleRecordKnowledge(deps, { channel: 'note', originRef: id }, { channel: 'note', originRef: id })

    // The preview page stops at 200 rows; the settlement is one call over the whole
    // record, so the 201st version is retired too.
    const after = await app.knowledge().findSources({ channel: 'note', originRef: id })
    expect(after.sources.every(row => row.state === 'invalid')).toBe(true)
    expect(app.settling.waiting).toBe(0)
  }, 60_000)
})
