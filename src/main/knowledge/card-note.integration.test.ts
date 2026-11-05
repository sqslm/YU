/**
 * Stage 6 C2: 「另存为随记」 saves the card as a note whose *first* source cites
 * that card — one publication, no plain publish racing an explicit one.
 *
 * Real helper, real `NotesStore`, the production collector and the real
 * extraction engine run here; only the Electron shell and the model transport
 * are stand-ins. The note is really written to disk and really published.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DatabaseSync } from 'node:sqlite'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS, mergeSettings } from '@shared/defaults'
import type { Settings } from '@shared/types'

const mock = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => mock.dir || tmpdir() },
  ipcMain: { handle: () => undefined },
  clipboard: { readText: () => '' },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  protocol: { handle: () => undefined },
  shell: { openPath: async () => '' },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }
}))

import { cardNoteText, saveCardAsNote } from './card-notes'
import { KnowledgeCollector } from './collector'
import { ExtractEngine } from './engine'
import { KnowledgeHost } from './host'
import { createSourceRecovery } from './recover'
import { NotesStore } from '../notes'

const ENTRY = join(process.cwd(), 'native', 'bin', 'yu-knowledge.exe')
const CARD_TITLE = '检索粒度基线'
const CARD_BODY = '知识图谱检索先命中标题，再落到正文；两三个字也能命中，所以短问题也找得到。'
const roots: string[] = []
const hosts: KnowledgeHost[] = []

beforeAll(() => {
  // The collector holds a note for a stable window before it becomes a task; the
  // window is what the app uses to avoid extracting a half-typed note.
  process.env.YU_KNOWLEDGE_STABLE_MS = '0'
})

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
  delete process.env.YU_KNOWLEDGE_STABLE_MS
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // a leftover root is reported by the caller, never hidden
    }
  }
})

interface SourceRow {
  kind: string
  origin_ref: string
  version: string
  cited_card_ids: string
}

function readSources(root: string): SourceRow[] {
  const db = new DatabaseSync(join(root, 'data', 'knowledge', 'knowledge.db'), { readOnly: true })
  try {
    return db.prepare('SELECT kind, origin_ref, version, cited_card_ids FROM sources ORDER BY rowid').all() as unknown as SourceRow[]
  } finally {
    db.close()
  }
}

async function until<T>(read: () => T, done: (value: T) => boolean, label: string, attempts = 400, delay = 25): Promise<T> {
  let last: T | undefined
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      last = read()
      if (done(last)) return last
    } catch {
      // the database file is not there yet, or the helper still holds it
    }
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`)
}

interface Rig {
  root: string
  settings: Settings
  host: KnowledgeHost
  notes: NotesStore
  collector: KnowledgeCollector
  engine: ExtractEngine
  /** What the de-duplicator said, in order, so a "reference" is provable. */
  comparisons: string[]
  saveAsNote: (cardId: string) => Promise<{ noteId: string }>
}

/**
 * The app's own wiring for this action: a citation registered for the note id
 * before the store writes, and the store's `onSettled` publishing that note with
 * whatever was registered. Nothing here publishes a second time.
 */
async function rig(options: { enabled?: boolean } = {}): Promise<Rig> {
  if (!existsSync(ENTRY)) throw new Error(`the knowledge helper is missing: ${ENTRY}`)
  const root = mkdtempSync(join(tmpdir(), 'yu-knowledge-card-note-'))
  roots.push(root)
  mock.dir = root
  const enabled = options.enabled !== false
  const settings = mergeSettings({
    ...DEFAULT_SETTINGS,
    notesDir: join(root, 'notes'),
    knowledge: { enabled, notes: enabled, chat: enabled, reading: enabled }
  })
  const comparisons: string[] = []
  let targetCard = ''
  // The helper's completer is the extraction model: it is told about the card the
  // note cites, and answers that the note restates it.
  const completer = async (call: { messages: { content: string }[] }): Promise<string> => {
    const text = call.messages.map((message) => message.content).join('\n')
    if (text.includes('知识库去重器')) {
      comparisons.push(text)
      expect(text, 'the card the note cites is a candidate').toContain(targetCard)
      return JSON.stringify({ decisions: [{ index: 0, action: 'reference', targetCardId: targetCard, reason: '同一结论的另一种说法' }] })
    }
    const named = /来源 (\S+)（第 0 段/.exec(text)
    expect(named, 'the prompt must name the source it read').not.toBeNull()
    return JSON.stringify({
      cards: [{ kind: 'concept', title: CARD_TITLE, summary: '检索先命中标题', body: CARD_BODY, topics: ['检索'], aliases: [], sources: [{ sourceId: named![1], segment: 0 }], reason: '可复用' }],
      reason: 'ok'
    })
  }
  const host = new KnowledgeHost({ entry: ENTRY, root, requestMs: 20_000, idleMs: 60_000, completer: completer as never })
  hosts.push(host)
  await host.configureCollect({ enabled, notes: enabled, chat: enabled, reading: enabled })
  // The production read path: a pending note task reads the note's current body
  // back out of the real store, never a stale copy.
  let notes: NotesStore
  const recovery = createSourceRecovery({ notes: () => notes, chats: () => ({ get: () => undefined }) })
  const collector = new KnowledgeCollector({ settings: () => settings, host: () => host, readBody: (channel, originRef) => recovery(channel, originRef) })
  await collector.sync()
  const citations = new Map<string, string[]>()
  notes = new NotesStore({
    log: () => undefined,
    getSettings: () => settings,
    onSettled: (note) => {
      const cited = citations.get(note.id)
      if (cited) {
        citations.delete(note.id)
        void collector.publishNote(note, cited)
      } else collector.noteSettled(note)
    },
    onRemoved: id => collector.noteRemoved(id)
  })
  const engine = new ExtractEngine({
    host: () => host,
    readBody: (channel, originRef) => collector.resolveBody(channel, originRef),
    settings: () => settings,
    allowed: () => true
  })
  return {
    root,
    settings,
    host,
    notes,
    collector,
    engine,
    comparisons,
    saveAsNote: (cardId: string) => {
      targetCard = cardId
      return saveCardAsNote({
        read: id => host.getCard(id),
        nextId: () => `note-${Math.random().toString(16).slice(2)}`,
        save: input => notes.createText(input),
        cite: (noteId, cardIds) => { citations.set(noteId, cardIds) }
      }, cardId)
    }
  }
}

describe('saving a card as a note', () => {
  it('publishes one source that cites the card, and extraction reuses that card', async () => {
    const current = await rig()
    const card = await current.host.saveCard({ kind: 'concept', title: CARD_TITLE, body: CARD_BODY, topics: ['检索'] })

    const { noteId } = await current.saveAsNote(card.id)
    const note = current.notes.list().notes.find(row => row.id === noteId)
    expect(note?.transcript, 'the note keeps the card text').toBe(cardNoteText({ title: CARD_TITLE, body: CARD_BODY }))

    const rows = await until(() => readSources(current.root), list => list.some(row => row.origin_ref === noteId), 'the note source')
    const mine = rows.filter(row => row.origin_ref === noteId)
    expect(mine, 'one save, one source').toHaveLength(1)
    expect(JSON.parse(mine[0]!.cited_card_ids), 'the first source carries the card').toEqual([card.id])

    await current.engine.tick()

    const cards = await current.host.listCards()
    expect(cards.total, 'a restatement mints no duplicate').toBe(1)
    const absorbed = await current.host.getCard(card.id)
    // The note restated the card it was saved from, so the card gains the note's
    // source and nothing else: same body, same identity, no second card.
    expect(absorbed.body, 'the original card body is untouched').toBe(CARD_BODY)
    expect(absorbed.sourceIds, 'the card now quotes the note').toHaveLength(1)
    // Either the helper recognised the exact restatement itself or it asked the
    // de-duplicator — both reuse the card; neither may mint a second one.
    if (current.comparisons.length) expect(current.comparisons.some(text => text.includes(card.id))).toBe(true)
  })

  it('saves a second note without minting a second card', async () => {
    const current = await rig()
    const card = await current.host.saveCard({ kind: 'concept', title: CARD_TITLE, body: CARD_BODY, topics: ['检索'] })
    const first = await current.saveAsNote(card.id)
    await current.engine.tick()
    const second = await current.saveAsNote(card.id)

    expect(second.noteId, 'the user may keep two notes of the same card').not.toBe(first.noteId)
    const rows = await until(() => readSources(current.root), list => list.filter(row => row.origin_ref === second.noteId).length > 0, 'the second note source')
    expect(JSON.parse(rows.find(row => row.origin_ref === second.noteId)!.cited_card_ids)).toEqual([card.id])
    await current.engine.tick()
    expect((await current.host.listCards()).total, 'still one card').toBe(1)
  })

  it('still saves the note when the knowledge base is off', async () => {
    const current = await rig({ enabled: false })
    const card = await current.host.saveCard({ kind: 'concept', title: CARD_TITLE, body: CARD_BODY })
    const { noteId } = await current.saveAsNote(card.id)
    expect(current.notes.list().notes.find(row => row.id === noteId)?.transcript).toContain(CARD_BODY)
    // Nothing is published while collection is off: the note is a note, not a source.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const db = join(current.root, 'data', 'knowledge', 'knowledge.db')
    if (existsSync(db)) expect(readSources(current.root).filter(row => row.origin_ref === noteId)).toHaveLength(0)
  })
})
