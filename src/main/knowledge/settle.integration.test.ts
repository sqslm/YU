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

import { DatabaseSync } from 'node:sqlite'

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

import { CleanupRetries } from './cleanup'
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
  dir: string
  sourceStates: (originRef: string) => { id: string; state: string; version: string }[]
  knowledge: () => KnowledgeHost
  restart: () => Promise<void>
  settling: SettleRegistry
  /** The retries a failed ticked cleanup leaves behind, wired as the app wires them. */
  cleanups: CleanupRetries
  collector: KnowledgeCollector
  notes: NotesStore
  settings: Settings
  removeNote: (id: string, options?: { deleteKnowledge?: boolean; ticket?: string }) => Promise<unknown>
  rows: (channel: 'note' | 'chat', ref: string) => Promise<{ id: string; state: string; version: string }[]>
}

async function rig(options: { unreachableRelease?: boolean; stalePreview?: boolean } = {}): Promise<Rig> {
  if (!existsSync(ENTRY)) throw new Error(`the knowledge helper is missing: ${ENTRY}`)
  const dir = mkdtempSync(join(tmpdir(), 'yu-knowledge-settle-'))
  roots.push(dir)
  mock.dir = dir
  const settings = mergeSettings({
    ...DEFAULT_SETTINGS,
    notesDir: join(dir, 'notes'),
    knowledge: { enabled: true, notes: true, chat: true, reading: true }
  })
  // The app's own recovery wiring: whenever a helper answers `ready`, queued
  // cleanups are tried again. A helper that could not be spawned leaves no change
  // notification behind, so its first successful start is the only signal there is.
  let releaseQueue: { retry: () => Promise<number> } | undefined
  const open = (): KnowledgeHost => {
    const host = new KnowledgeHost({
      entry: ENTRY,
      root: dir,
      requestMs: 30_000,
      idleMs: 60_000,
      onReady: () => {
        void releaseQueue?.retry()
      }
    })
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
  releaseQueue = settling
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
    purgeCards: input => knowledge().purgeCards(input),
    log: () => undefined
  }
  const cleanups = new CleanupRetries(() => ({
    purgeCards: input => knowledge().purgeCards(input),
    release: (input, reason) => settling.release(input, reason),
    log: () => undefined
  }))
  registerNotesIpc({
    store: notes,
    persistDir: async () => undefined,
    broadcast: () => undefined,
    settle: (noteId, body) => settling.run('note', noteId, body),
    purgeKnowledge: (noteId, options) =>
      settleRecordKnowledge(deps, { channel: 'note', originRef: noteId }, { channel: 'note', originRef: noteId }, options),
    // The prod check runs while the record still exists; here the note has one
    // version, so the ticket the preview issued is the one to confirm with.
    verifyKnowledge: async () => {
      if (options.stalePreview) throw new Error('预览已失效，请重新确认')
    },
    pendingCleanup: (noteId, detail) =>
      cleanups.add({ channel: 'note', originRef: noteId }, { channel: 'note', originRef: noteId }, detail)
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
  const sourceStates = (originRef: string): { id: string; state: string; version: string }[] => {
    const db = new DatabaseSync(join(dir, 'data', 'knowledge', 'knowledge.db'), { readOnly: true })
    try {
      return db
        .prepare('SELECT id, state, version FROM sources WHERE origin_ref = ? ORDER BY rowid')
        .all(originRef) as { id: string; state: string; version: string }[]
    } finally {
      db.close()
    }
  }
  return {
    dir,
    sourceStates,
    knowledge,
    restart: async () => {
      current = open()
      // The host is the one cleanups will use before it is started, exactly as the
      // app wires it: the start is what fires `ready`, which is what retries.
      releaseHost = current
      await current.configureCollect(channels)
    },
    settling,
    cleanups,
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
    // Nothing here calls the retry: the next ordinary use of the library starts the
    // healthy helper, whose `ready` is what picks the waiting cleanup up again.
    await app.knowledge().findSources({ channel: 'note', originRef: note.id })
    await until(async () => app.settling.waiting === 0, 'the queued cleanup')
    await until(async () => (await app.rows('note', note.id)).every(row => row.state === 'invalid'), 'retired rows')
  }, 60_000)

  it('refuses before deleting anything when the preview no longer holds', async () => {
    const app = await rig({ stalePreview: true })
    const note = await app.notes.createText({ text: '只此一版：先认领版本再删卡片。' })
    await until(async () => (await app.rows('note', note.id)).length > 0, 'the note source')

    // This is the path the dialog promises: the proof runs while the record still
    // exists, so a stale ticket deletes nothing and creates no retry.
    await expect(app.removeNote(note.id, { deleteKnowledge: true, ticket: 'old' })).rejects.toThrow(
      '预览已失效，请重新确认'
    )
    // Nothing was deleted, so there is nothing to retry either.
    expect(app.notes.list().notes.some(entry => entry.id === note.id)).toBe(true)
    expect(app.cleanups.waiting).toBe(0)
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

  it('retires a version the paged preview never reached, through the handler', async () => {
    const app = await rig()
    const id = 'note-paged-versions'
    for (let version = 0; version < 201; version += 1) {
      await app.collector.publishNote({
        id,
        title: '分页随记',
        transcript: `第 ${version} 版正文`,
        polished: `第 ${version} 版正文`,
        updatedAt: Date.now() + version,
        polishStatus: 'ok'
      })
    }
    const all = app.sourceStates(id)
    expect(all.length).toBe(201)
    // The first page of the record goes stale on its own; the newest version — the
    // only live one, and the one the user can still read — is what the delete has to
    // take with it. Paging cannot see it, so the settlement must not go through paging.
    for (const row of all.slice(0, 200)) {
      await app.knowledge().invalidateSource(row.id, '旧版本')
    }
    const live = app.sourceStates(id).filter(row => row.state !== 'invalid')
    expect(live.length).toBe(1)

    await app.removeNote(id)

    expect(app.notes.list().notes.some(entry => entry.id === id)).toBe(false)
    expect(app.settling.waiting).toBe(0)
    // The newest version was never on the preview page; the settlement still took it.
    await until(() => Promise.resolve(app.sourceStates(id).every(row => row.state === 'invalid')), 'every version')
  }, 60_000)

  it('confirms exactly the rows the preview showed, including a stale one', async () => {
    const app = await rig()
    const note = await app.notes.createText({ text: '第一版：去重靠指纹。' })
    await until(async () => (await app.rows('note', note.id)).length > 0, 'the first version')
    const [first] = await app.rows('note', note.id)
    await app.knowledge().invalidateSource(first.id, '旧版本')
    await app.notes.update(note.id, { transcript: '第二版：去重靠指纹，指纹含问答。', polished: '' })
    await until(async () => (await app.rows('note', note.id)).length > 1, 'the second version')
    const current = (await app.rows('note', note.id)).find(row => row.state !== 'invalid')
    if (!current) throw new Error('the current version is missing')
    const card = await app.knowledge().saveCard({
      kind: 'concept',
      title: '指纹去重',
      body: '指纹由问题与回答一起算出。',
      topics: ['去重'],
      sourceIds: [current.id]
    })

    // The preview the user actually reads counts both versions and one card.
    const impact = await app.knowledge().cardImpact({ channel: 'note', originRef: note.id })
    expect(impact.sources.length).toBe(2)
    expect(impact.cards).toBe(1)
    expect(impact.single).toBe(1)

    // The same ticket, handed to the production settlement, must hold: the confirm is
    // the preview, and the stale row it listed does not widen anything.
    await app.removeNote(note.id, { deleteKnowledge: true, ticket: impact.ticket })

    expect(app.notes.list().notes.some(entry => entry.id === note.id)).toBe(false)
    await expect(app.knowledge().getCard(card.id)).rejects.toThrow('unknown card')
    expect((await app.rows('note', note.id)).every(row => row.state === 'invalid')).toBe(true)
  }, 60_000)

  it('hands the moved range back as a retry and keeps the card', async () => {
    const app = await rig()
    const note = await app.notes.createText({ text: '只此一版：先认领版本再删卡片。' })
    await until(async () => (await app.rows('note', note.id)).length > 0, 'the note source')
    const [source] = await app.rows('note', note.id)
    const card = await app.knowledge().saveCard({
      kind: 'concept',
      title: '写入顺序',
      body: '先认领版本再删卡片。',
      topics: ['写入'],
      sourceIds: [source.id]
    })
    const impact = await app.knowledge().cardImpact({ channel: 'note', originRef: note.id })
    // The record gains a version after the user read the preview, so the range the
    // ticket names is not the range that would be deleted now.
    await app.notes.update(note.id, { transcript: '第二版：先认领版本，再删卡片，最后收尾关系。', polished: '' })
    await until(async () => (await app.rows('note', note.id)).length > 1, 'the new version')

    const pending = (await app.removeNote(note.id, { deleteKnowledge: true, ticket: impact.ticket })) as
      | { id: string; reason: string }
      | undefined
    // The note is gone either way, so the refusal arrives as something the user can
    // act on: nothing was deleted, and the same handle still offers the downgrade.
    expect(pending?.reason).toBe('预览已失效，请重新确认')
    expect(app.notes.list().notes.some(entry => entry.id === note.id)).toBe(false)
    expect(app.cleanups.waiting).toBe(1)
    const kept = await app.knowledge().getCard(card.id)
    expect(kept.id).toBe(card.id)
    expect((await app.rows('note', note.id)).some(row => row.state !== 'invalid')).toBe(true)

    // Finishing it the same way refuses again: the range only moved once.
    await expect(app.cleanups.retry(pending!.id, 'purge')).resolves.toMatchObject({ status: 'stale' })
  }, 60_000)
})

describe('finishing a ticked cleanup after the record was already deleted', () => {
  /** Holds the helper's write lock, exactly like a second connection would. */
  function hold(dir: string): { release: () => void } {
    const db = new DatabaseSync(join(dir, 'data', 'knowledge', 'knowledge.db'))
    db.exec('BEGIN IMMEDIATE')
    return {
      release: () => {
        db.exec('ROLLBACK')
        db.close()
      }
    }
  }

  it('hands back a retry, then deletes exactly the confirmed cards once it can write', async () => {
    const app = await rig()
    const note = await app.notes.createText({ text: '指纹去重靠问题与回答一起算。' })
    await until(async () => (await app.rows('note', note.id)).length > 0, 'the note source')
    const [source] = await app.rows('note', note.id)
    const card = await app.knowledge().saveCard({
      kind: 'concept',
      title: '指纹去重',
      body: '指纹由问题与回答一起算出。',
      topics: ['去重'],
      sourceIds: [source.id]
    })
    const preview = await app.knowledge().cardImpact({ channel: 'note', originRef: note.id })
    expect(preview.cards).toBe(1)

    // The note is deleted while the write lock is held, so only the cleanup fails.
    const lock = hold(app.dir)
    let pending: { id: string; reason: string; cards: boolean } | undefined
    try {
      pending = (await app.removeNote(note.id, { deleteKnowledge: true, ticket: preview.ticket })) as
        | { id: string; reason: string; cards: boolean }
        | undefined
    } finally {
      lock.release()
    }
    expect(pending?.cards).toBe(true)
    expect(pending?.reason).toMatch(/lock/i)
    // The record really went; the knowledge did not move on its own.
    expect(app.notes.list().notes.some(entry => entry.id === note.id)).toBe(false)
    expect(app.cleanups.waiting).toBe(1)
    expect(app.sourceStates(note.id).every(row => row.state !== 'invalid')).toBe(true)
    expect((await app.knowledge().getCard(card.id)).id).toBe(card.id)

    const result = await app.cleanups.retry(pending!.id, 'purge')

    expect(result.status).toBe('done')
    expect(result.removed).toBe(1)
    expect(app.cleanups.waiting).toBe(0)
    expect(app.sourceStates(note.id).every(row => row.state === 'invalid')).toBe(true)
    await expect(app.knowledge().getCard(card.id)).rejects.toThrow()
  }, 90_000)

  it('refuses the moved range and keeps the cards when the user chooses the downgrade', async () => {
    const app = await rig()
    const note = await app.notes.createText({ text: '写入顺序先认领版本，再删卡片。' })
    await until(async () => (await app.rows('note', note.id)).length > 0, 'the note source')
    const [source] = await app.rows('note', note.id)
    const card = await app.knowledge().saveCard({
      kind: 'concept',
      title: '写入顺序',
      body: '先认领版本，再删卡片，最后收尾关系。',
      topics: ['写入'],
      sourceIds: [source.id]
    })
    const preview = await app.knowledge().cardImpact({ channel: 'note', originRef: note.id })

    const lock = hold(app.dir)
    let pending: { id: string } | undefined
    try {
      pending = (await app.removeNote(note.id, { deleteKnowledge: true, ticket: preview.ticket })) as
        | { id: string }
        | undefined
    } finally {
      lock.release()
    }
    expect(pending?.id).toBeTruthy()

    // The record moved: another version of the same origin is published, so the
    // ticket the user confirmed no longer describes the record.
    await app.collector.publishNote({
      id: note.id,
      title: '写入顺序',
      transcript: '写入顺序先认领版本，再删卡片。',
      polished: '第二版：先认领版本，再删卡片，最后收尾关系。',
      updatedAt: Date.now(),
      polishStatus: 'ok'
    })
    await until(async () => (await app.rows('note', note.id)).length > 1, 'the second version')

    const stale = await app.cleanups.retry(pending!.id, 'purge')

    expect(stale.status).toBe('stale')
    expect(stale.removed).toBe(0)
    // Nothing was deleted, and the offer to keep the cards is still open.
    expect((await app.knowledge().getCard(card.id)).id).toBe(card.id)
    expect(app.sourceStates(note.id).some(row => row.state !== 'invalid')).toBe(true)
    expect(app.cleanups.waiting).toBe(1)

    const released = await app.cleanups.retry(pending!.id, 'release')

    expect(released.status).toBe('done')
    expect(released.released).toBeGreaterThan(0)
    expect(app.cleanups.waiting).toBe(0)
    // The explicit downgrade withdraws every source and keeps the card with its
    // now-dead link, which is what the confirmation dialog promised.
    expect(app.sourceStates(note.id).every(row => row.state === 'invalid')).toBe(true)
    const kept = await app.knowledge().getCard(card.id)
    expect(kept.id).toBe(card.id)
    expect(kept.sourceIds).toContain(source.id)
  }, 90_000)

  it('keeps the downgrade open while the library is locked again, and leaves the other row alone', async () => {
    const app = await rig()
    const first = await app.notes.createText({ text: '第一条随记：卡片只依赖这一条来源。' })
    await until(async () => (await app.rows('note', first.id)).length > 0, 'the first source')
    const [firstSource] = await app.rows('note', first.id)
    const firstCard = await app.knowledge().saveCard({
      kind: 'concept',
      title: '第一条',
      body: '只依赖第一条随记。',
      topics: ['清理'],
      sourceIds: [firstSource.id]
    })
    const firstPreview = await app.knowledge().cardImpact({ channel: 'note', originRef: first.id })

    const second = await app.notes.createText({ text: '第二条随记：同样有自己的卡片。' })
    await until(async () => (await app.rows('note', second.id)).length > 0, 'the second source')
    const [secondSource] = await app.rows('note', second.id)
    const secondCard = await app.knowledge().saveCard({
      kind: 'concept',
      title: '第二条',
      body: '只依赖第二条随记。',
      topics: ['清理'],
      sourceIds: [secondSource.id]
    })
    const secondPreview = await app.knowledge().cardImpact({ channel: 'note', originRef: second.id })

    // Both deletions land while the library is locked, so both cleanups wait.
    let firstPending: { id: string } | undefined
    const lockOne = hold(app.dir)
    try {
      firstPending = (await app.removeNote(first.id, {
        deleteKnowledge: true,
        ticket: firstPreview.ticket
      })) as { id: string } | undefined
    } finally {
      lockOne.release()
    }
    let secondPending: { id: string } | undefined
    const lockTwo = hold(app.dir)
    try {
      secondPending = (await app.removeNote(second.id, {
        deleteKnowledge: true,
        ticket: secondPreview.ticket
      })) as { id: string } | undefined
    } finally {
      lockTwo.release()
    }
    expect(app.cleanups.waiting).toBe(2)

    // The first record moves on, so its ticket is refused and the downgrade opens.
    await app.collector.publishNote({
      id: first.id,
      title: '第一条',
      transcript: '第一条随记：卡片只依赖这一条来源。',
      polished: '第二版：第一条随记又多了一版。',
      updatedAt: Date.now(),
      polishStatus: 'ok'
    })
    await until(async () => (await app.rows('note', first.id)).length > 1, 'the second version')
    await expect(app.cleanups.retry(firstPending!.id, 'purge')).resolves.toMatchObject({ status: 'stale' })

    // The downgrade itself hits the lock: the offer has to survive that too.
    const lockThree = hold(app.dir)
    let blocked: { status: string; reason?: string }
    try {
      blocked = await app.cleanups.retry(firstPending!.id, 'release')
    } finally {
      lockThree.release()
    }
    expect(blocked.status).toBe('failed')
    expect(blocked.reason).toMatch(/lock/i)
    const listed = app.cleanups.list('note')
    expect(listed.map(row => row.id).sort()).toEqual([firstPending!.id, secondPending!.id].sort())
    expect(listed.find(row => row.id === firstPending!.id)?.stale).toBe(true)
    expect(listed.find(row => row.id === secondPending!.id)?.stale).toBe(false)

    const released = await app.cleanups.retry(firstPending!.id, 'release')

    expect(released.status).toBe('done')
    expect(app.cleanups.waiting).toBe(1)
    expect(app.cleanups.list('note').map(row => row.id)).toEqual([secondPending!.id])
    // The record that only asked to keep cards keeps them, with the dead link.
    const kept = await app.knowledge().getCard(firstCard.id)
    expect(kept.sourceIds).toContain(firstSource.id)
    expect(app.sourceStates(first.id).every(row => row.state === 'invalid')).toBe(true)
    // The other row never moved.
    expect(app.sourceStates(second.id).every(row => row.state !== 'invalid')).toBe(true)
    expect((await app.knowledge().getCard(secondCard.id)).id).toBe(secondCard.id)
  }, 120_000)

  it('shows an attempt as in flight while it runs, and drops the row once it settles', async () => {
    const app = await rig()
    const note = await app.notes.createText({ text: '在途状态要能从主进程读回来。' })
    await until(async () => (await app.rows('note', note.id)).length > 0, 'the note source')
    const [source] = await app.rows('note', note.id)
    const card = await app.knowledge().saveCard({
      kind: 'concept',
      title: '在途状态',
      body: '重试期间页面要看到忙碌。',
      topics: ['清理'],
      sourceIds: [source.id]
    })
    const preview = await app.knowledge().cardImpact({ channel: 'note', originRef: note.id })

    const first = hold(app.dir)
    let pending: { id: string } | undefined
    try {
      pending = (await app.removeNote(note.id, { deleteKnowledge: true, ticket: preview.ticket })) as
        | { id: string }
        | undefined
    } finally {
      first.release()
    }
    const idle = app.cleanups.snapshot('note')
    expect(idle.rows).toHaveLength(1)
    expect(idle.rows[0].busy).toBe(false)

    // A second lock keeps the retry running while the page reads the register.
    const second = hold(app.dir)
    const running = app.cleanups.retry(pending!.id, 'purge')
    try {
      const during = app.cleanups.snapshot('note')
      expect(during.revision).toBeGreaterThan(idle.revision)
      expect(during.rows[0]).toMatchObject({ id: pending!.id, busy: true })
      // The chat channel is a different page and never sees this row.
      expect(app.cleanups.snapshot('chat').rows).toEqual([])
    } finally {
      second.release()
    }

    const result = await running

    expect(result.status).toBe('done')
    const after = app.cleanups.snapshot('note')
    expect(after.revision).toBeGreaterThan(idle.revision)
    expect(after.rows).toEqual([])
    await expect(app.knowledge().getCard(card.id)).rejects.toThrow()
  }, 120_000)
})
