/**
 * The history scan through the real entry points: a real `NotesStore`, a real
 * `ChatStore`, the real bounded readers and the compiled Rust helper. The test
 * never hands a body to the helper itself — if the scan worked, the pages did.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS, mergeSettings } from '@shared/defaults'
import type { Settings } from '@shared/types'

import { ChatStore } from '../chat-store'
import { NotesStore } from '../notes'
import { HistoryDriver } from './history'
import { KnowledgeHost } from './host'
import { createHistoryPages } from './pages'

const ENTRY = join(process.cwd(), 'native', 'bin', 'yu-knowledge.exe')
const roots: string[] = []
const instances: KnowledgeHost[] = []

vi.mock('electron', () => ({ app: { getPath: () => roots[0] ?? tmpdir() } }))

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yu-knowledge-scan-'))
  roots.push(dir)
  return dir
}

function settings(dir: string): Settings {
  return mergeSettings({ ...DEFAULT_SETTINGS, notesDir: join(dir, 'notes'), knowledge: { enabled: true, notes: true, chat: true, reading: true } })
}

function host(dir: string): KnowledgeHost {
  const instance = new KnowledgeHost({ entry: ENTRY, root: dir, requestMs: 30_000, idleMs: 60_000 })
  instances.push(instance)
  return instance
}

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.stop()
})

afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('history scan through the real stores', () => {
  it('collects every saved note and completed turn without a row from the renderer', async () => {
    if (!existsSync(ENTRY)) throw new Error(`the knowledge helper is missing: ${ENTRY}`)
    const dir = root()
    const current = settings(dir)

    const notes = new NotesStore({ log: () => undefined, getSettings: () => current, notify: () => undefined })
    await notes.load()
    const first = await notes.createText({ text: '第一条历史笔记' })
    const second = await notes.createText({ text: '第二条历史笔记' })
    await notes.createText({ text: '   ' })

    const chats = new ChatStore(join(dir, 'chats.db'))
    const kept = chats.create(null), temporary = chats.create(null), unfinished = chats.create(null)
    const answered = chats.begin(kept.id, '历史问题')
    chats.finish(answered.answerId, '历史回答', 'done')
    const transient = chats.begin(unfinished.id, '还没答完')
    chats.finish(transient.answerId, '等确认', 'working')
    chats.markTemporary(temporary.id)
    const hidden = chats.begin(temporary.id, '临时问题')
    chats.finish(hidden.answerId, '临时回答', 'done')

    const knowledge = host(dir)
    await knowledge.configureCollect({ enabled: true, notes: true, chat: true })
    const driver = new HistoryDriver({
      host: () => knowledge,
      pages: createHistoryPages({ notes: () => notes, chats: () => chats }),
      // The same bounds the app fixes when a scan starts; without them the chat
      // reader has no upper limit and emits nothing.
      bounds: () => ({ noteBound: null, chatBound: chats.historyBound() })
    })
    const job = await driver.start({ notes: true, chat: true })
    await vi.waitFor(async () => {
      const status = await knowledge.historyStatus(job!.id)
      expect(status.job?.state).toBe('completed')
    }, { timeout: 20_000 })

    const status = await knowledge.queueStatus()
    expect(status.total).toBe(3)
    const list = await knowledge.listQueue({})
    expect(list.total).toBe(3)
    const origins = list.items.flatMap(task => task.items.map(item => item.originRef))
    expect(origins).toEqual(expect.arrayContaining([first.id, second.id, `${kept.id}:${answered.userId}:${answered.answerId}`]))
    // The temporary thread and the unfinished answer never became sources.
    expect(origins.some(origin => origin.startsWith(temporary.id))).toBe(false)
    expect(origins.some(origin => origin.startsWith(unfinished.id))).toBe(false)
    chats.close()
  })

  it('walks a long conversation in pages without skipping or repeating a turn', async () => {
    const dir = root()
    const chats = new ChatStore(join(dir, 'chats.db'))
    const thread = chats.create(null)
    const ids: string[] = []
    for (let index = 0; index < 25; index += 1) {
      const turn = chats.begin(thread.id, `问题 ${index}`)
      chats.finish(turn.answerId, `回答 ${index}`, 'done')
      ids.push(`${thread.id}:${turn.userId}:${turn.answerId}`)
    }
    const pages = createHistoryPages({ notes: () => ({ list: () => ({ notes: [] }) }), chats: () => chats, limit: 4 })
    const seen: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 20; guard += 1) {
      const page = pages.chat(cursor, chats.historyBound())
      seen.push(...page.rows.map(row => row.originRef))
      if (page.done) break
      expect(page.cursor).not.toBe(cursor)
      cursor = page.cursor
    }
    expect(seen).toEqual(ids)
    expect(new Set(seen).size).toBe(25)
    chats.close()
  })

  it('pages notes inside a bound that an insertion during the scan cannot move', async () => {
    const dir = root()
    const current = settings(dir)
    const notes = new NotesStore({ log: () => undefined, getSettings: () => current, notify: () => undefined })
    await notes.load()
    const older = [
      await notes.createText({ text: '最早的一页' }),
      await notes.createText({ text: '第二页' }),
      await notes.createText({ text: '第三页' })
    ]
    const unusedChats = {
      historyThreads: () => [],
      historyTurns: () => ({ turns: [], nextSeq: 0, done: true }),
      get: () => ({})
    }
    const pages = createHistoryPages({ notes: () => notes, chats: () => unusedChats, limit: 1 })
    // The bound is the store's highest note id at the moment the scan starts.
    const bound = older.map(note => note.id).sort()[older.length - 1]!
    const firstPage = pages.notes(null, bound)
    expect(firstPage.done).toBe(false)
    const inserted = await notes.createText({ text: '扫描期间新增' })

    const seen = [...firstPage.rows.map(row => row.originRef)]
    let cursor = firstPage.cursor
    for (let guard = 0; guard < 20; guard += 1) {
      const page = pages.notes(cursor, bound)
      seen.push(...page.rows.map(row => row.originRef))
      if (page.done) break
      expect(page.cursor).not.toBe(cursor)
      cursor = page.cursor
    }
    // Nothing repeats and every note that existed when the scan started is reached.
    expect(new Set(seen).size).toBe(seen.length)
    for (const note of older) expect(seen).toContain(note.id)
    // The bound is fixed at start, so a note written afterwards belongs to the live
    // path: the scan may see it once when its id still falls inside the bound, and it
    // must never be reached twice either way.
    expect(seen.every(id => older.some(note => note.id === id) || id === inserted.id)).toBe(true)
    expect(seen.filter(id => id === inserted.id).length).toBeLessThanOrEqual(1)
  })

  it('keeps the first turn of a thread longer than the old message window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yu-knowledge-scan-'))
    roots.push(dir)
    const chats = new ChatStore(join(dir, 'chats.db'))
    const thread = chats.create(null)
    // 5 001 turns is 10 002 messages: more than the 10 000-message window the
    // reader used to take, which silently dropped the oldest questions.
    const db = new DatabaseSync(join(dir, 'chats.db'))
    const insert = db.prepare(
      'INSERT INTO chat_messages (id, threadId, role, text, state, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
    )
    db.exec('BEGIN')
    for (let index = 0; index < 5001; index += 1) {
      insert.run(`u${index}`, thread.id, 'user', `问题${index}`, 'done', 1_000 + index)
      insert.run(`a${index}`, thread.id, 'assistant', `回答${index}`, 'done', 1_001 + index)
    }
    db.exec('COMMIT')
    db.close()

    const pages = createHistoryPages({ notes: () => ({ list: () => ({ notes: [] }) }), chats: () => chats, limit: 200 })
    const bound = chats.historyBound()
    const seen: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 40; guard += 1) {
      const page = pages.chat(cursor, bound)
      for (const row of page.rows) seen.push((row as { text: string }).text.split(String.fromCharCode(10))[0])
      if (page.done) break
      cursor = page.cursor
    }
    expect(seen).toHaveLength(5001)
    expect(seen[0]).toBe('问题0')
    expect(seen[5000]).toBe('问题5000')
    expect(new Set(seen).size).toBe(5001)
    chats.close()
  }, 60_000)
})
