/**
 * The history scan through the real entry points: a real `NotesStore`, a real
 * `ChatStore`, the real bounded readers and the compiled Rust helper. The test
 * never hands a body to the helper itself — if the scan worked, the pages did.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
    const driver = new HistoryDriver({ host: () => knowledge, pages: createHistoryPages({ notes: () => notes, chats: () => chats }) })
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
    const pages = createHistoryPages({ notes: () => ({ list: () => ({ notes: [] }) }), chats: () => chats })
    const seen: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 20; guard += 1) {
      const page = pages.chat(cursor, 4)
      seen.push(...page.rows.map(row => row.originRef))
      if (page.done) break
      expect(page.cursor).not.toBe(cursor)
      cursor = page.cursor
    }
    expect(seen).toEqual(ids)
    expect(new Set(seen).size).toBe(25)
    chats.close()
  })

  it('pages notes by a cursor that survives an insertion during the scan', async () => {
    const dir = root()
    const current = settings(dir)
    const notes = new NotesStore({ log: () => undefined, getSettings: () => current, notify: () => undefined })
    await notes.load()
    const older = [await notes.createText({ text: '最早的一页' }), await notes.createText({ text: '第二页' }), await notes.createText({ text: '第三页' })]
    const pages = createHistoryPages({ notes: () => notes, chats: () => ({ list: () => ({ threads: [] }), get: () => { throw Error('unused') } }) })
    const firstPage = pages.notes(null, 1)
    expect(firstPage.rows.map(row => row.originRef)).toEqual([older[0]!.id])
    expect(firstPage.done).toBe(false)
    const inserted = await notes.createText({ text: '扫描期间新增' })
    const secondPage = pages.notes(firstPage.cursor, 10)
    const second = secondPage.rows.map(row => row.originRef)
    const remaining = older.filter(note => note.id !== older[0]!.id).map(note => note.id)
    // Every older note is reached exactly once, and the page already delivered is
    // never repeated. Whether the note written during the scan lands in this page or
    // the next depends on its timestamp, but it can never be lost or duplicated.
    expect(second).not.toContain(older[0]!.id)
    for (const id of remaining) expect(second).toContain(id)
    const third = secondPage.done ? [] : pages.notes(secondPage.cursor, 10).rows.map(row => row.originRef)
    const seen = [...second, ...third]
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen).toEqual(expect.arrayContaining([...remaining, inserted.id]))
  })
})
