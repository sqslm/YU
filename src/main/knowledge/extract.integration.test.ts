/**
 * The stage-3 loop through the real chain: a real note store, the production
 * collector and recovery, the compiled helper and the production host, with only
 * the provider faked at the completer seam the host already exposes.
 *
 * Nothing here feeds `card.save` directly: the card has to come out of the Rust
 * pipeline that read the note body itself.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS, mergeSettings } from '@shared/defaults'

import { NotesStore } from '../notes'
import { KnowledgeCollector } from './collector'
import { ExtractEngine } from './engine'
import { KnowledgeHost } from './host'
import { createSourceRecovery } from './recover'

const ENTRY = join(process.cwd(), 'native', 'bin', 'yu-knowledge.exe')

/** The collector publishes in the background, so wait for the helper to report it. */
async function until<T>(check: () => Promise<T | null>, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
const roots: string[] = []
const instances: KnowledgeHost[] = []

vi.mock('electron', () => ({ app: { getPath: () => roots[0] ?? tmpdir() } }))

beforeAll(() => {
  // The settling window is real in production; the test shortens it.
  process.env.YU_KNOWLEDGE_STABLE_MS = '0'
})

afterAll(() => {
  delete process.env.YU_KNOWLEDGE_STABLE_MS
  for (const dir of roots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // a leftover root is reported, never hidden
    }
  }
})

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.stop()
})

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yu-knowledge-extract-'))
  roots.push(dir)
  return dir
}

const BODY = '这段随记说明：先看约束，再看机制，最后才是取舍理由，并标明哪些结论仍待验证。'

/** A provider stand-in that answers the extraction prompt with one card. */
function answerWith(sourceId: string) {
  return vi.fn(async () => {
    const card = {
      kind: 'concept',
      title: '约束先行',
      summary: '先确认约束再谈机制',
      body: BODY,
      topics: ['方法'],
      aliases: [],
      sources: [{ sourceId, segment: 0 }],
      reason: '可复用'
    }
    return JSON.stringify({ cards: [card], reason: 'ok' })
  })
}

describe('extraction through the real helper', () => {
  it('turns a queued note into a card with its source attached', async () => {
    const dir = root()
    const settings = mergeSettings({
      ...DEFAULT_SETTINGS,
      notesDir: join(dir, 'notes'),
      knowledge: { enabled: true, notes: true, chat: true, reading: true }
    })
    const notes = new NotesStore({
      log: () => undefined,
      getSettings: () => settings,
      notify: () => undefined
    })
    const host = new KnowledgeHost({
      entry: ENTRY,
      root: dir,
      requestMs: 30_000,
      idleMs: 60_000,
      completer: answerWith('src-placeholder') as never
    })
    instances.push(host)

    const recovery = createSourceRecovery({ notes: () => notes, chats: () => ({ get: () => undefined }) })
    const collector = new KnowledgeCollector({
      settings: () => settings,
      host: () => host,
      readBody: (channel, originRef) => recovery(channel, originRef)
    })
    const lines: string[] = []
    const engine = new ExtractEngine({
      host: () => host,
      readBody: (channel, originRef) => recovery(channel, originRef),
      settings: () => settings,
      allowed: () => true,
      log: line => lines.push(line)
    })

    const note = await notes.createText({ text: '先确认约束，再谈机制与取舍。' })
    await collector.sync({ game: false })
    collector.noteSettled({ id: note.id, title: note.title, transcript: note.transcript, polished: note.polished, updatedAt: note.updatedAt })

    const queue = await until(async () => {
      const status = await host.queueStatus()
      return status.total === 1 ? status : null
    }, 'the note to be queued')
    expect(queue.total, 'the note must be queued').toBe(1)

    // Read the prompt the helper built, so the stand-in answers with the id the
    // helper itself put in front of it.
    const prompt = vi.fn(async (call: { messages: { content: string }[] }) => {
      const text = call.messages.map(message => message.content).join('\n')
      const found = /来源 (\S+)（第 0 段/.exec(text)
      expect(found, 'the prompt must name the source').not.toBeNull()
      return answerWith(found![1])().then(answer => answer)
    })
    ;(host as unknown as { options: { completer: unknown } }).options.completer = prompt

    await engine.tick()
    if (lines.length) console.log('ENGINE', lines.join('\n'))

    const cards = await host.listCards()
    expect(cards.total, 'exactly one card').toBe(1)
    const card = await host.getCard(cards.items[0].id)
    expect(card.body).toBe(BODY)
    expect(card.sourceIds).toHaveLength(1)
    const queueAfter = await host.queueStatus()
    expect(queueAfter.counts.completed).toBe(1)

  })
})

describe('proposals through the real helper', () => {
  it('offers a merge for an edited card and applies it only when accepted', async () => {
    const dir = root()
    const settings = mergeSettings({
      ...DEFAULT_SETTINGS,
      notesDir: join(dir, 'notes'),
      knowledge: { enabled: true, notes: true, chat: true, reading: true }
    })
    const notes = new NotesStore({
      log: () => undefined,
      getSettings: () => settings,
      notify: () => undefined
    })
    const first = '先确认约束，再谈机制与取舍；这条结论需要附上适用条件与判断依据。'
    const second = '先确认约束，再谈机制与取舍；这条结论需要附上适用条件、判断依据与一个反例。'
    let call = 0
    const completer = vi.fn(async (request: { messages: { role: string; content: string }[] }) => {
      const all = request.messages.map(message => message.content).join('\n')
      call += 1
      if (all.includes('知识库去重器')) {
        const target = /card_[0-9a-f]+/.exec(all)?.[0]
        expect(target, 'the candidate list must name the card').toBeTruthy()
        return JSON.stringify({
          decisions: [{ index: 0, action: 'merge', targetCardId: target, reason: '同一结论补充细节' }]
        })
      }
      const body = call === 1 ? first : second
      // A card must reference a segment that was really in this batch.
      const named = /来源 (\S+)（第 (\d+) 段/.exec(all)
      expect(named, 'the prompt must name the source').not.toBeNull()
      return JSON.stringify({
        cards: [
          {
            kind: 'concept',
            title: '约束先行',
            summary: '先确认约束再谈机制',
            body,
            topics: ['方法'],
            aliases: [],
            sources: [{ sourceId: named![1], segment: Number(named![2]) }]
          }
        ],
        reason: 'ok'
      })
    })
    const host = new KnowledgeHost({ entry: ENTRY, root: dir, requestMs: 30_000, idleMs: 60_000, completer })
    instances.push(host)
    const recovery = createSourceRecovery({ notes: () => notes, chats: () => ({ get: () => undefined }) })
    const collector = new KnowledgeCollector({
      settings: () => settings,
      host: () => host,
      readBody: (channel, originRef) => recovery(channel, originRef)
    })
    const engine = new ExtractEngine({
      host: () => host,
      readBody: (channel, originRef) => recovery(channel, originRef),
      settings: () => settings,
      allowed: () => true
    })

    const note = await notes.createText({ text: '先确认约束，再谈机制与取舍。' })
    await collector.sync({ game: false })
    collector.noteSettled({ id: note.id, title: note.title, transcript: note.transcript, polished: note.polished, updatedAt: note.updatedAt })
    await until(async () => ((await host.queueStatus()).total === 1 ? true : null), 'the note to be queued')
    await engine.tick()
    const listed = await host.listCards()
    expect(listed.total).toBe(1)
    const cardId = listed.items[0].id

    // A person edits the card, so the next batch may only propose.
    await host.updateCard({ id: cardId, title: '约束先行（人工）' })

    const other = await notes.createText({ text: '第二条随记，讲同一件事但多了细节。' })
    collector.noteSettled({ id: other.id, title: other.title, transcript: other.transcript, polished: other.polished, updatedAt: other.updatedAt })
    await until(async () => ((await host.queueStatus()).total === 2 ? true : null), 'the second note to be queued')
    await engine.tick()

    const open = await until(async () => {
      const page = await host.listSuggestions({ state: 'open' })
      return page.total === 1 ? page : null
    }, 'a merge for the edited card to become a proposal')
    expect(open.total, 'a merge for an edited card becomes a proposal').toBe(1)
    expect(open.items[0].targetCardId).toBe(cardId)
    expect(open.items[0].draft.body).toBe(second)
    expect((await host.getCard(cardId)).body, 'nothing is written before acceptance').toBe(first)

    const accepted = await host.acceptSuggestion(open.items[0].id)
    expect(accepted.state).toBe('accepted')
    const card = await host.getCard(cardId)
    expect(card.body).toBe(second)
    expect(card.revision).toBeGreaterThan(1)
    expect(await host.listSuggestions({ state: 'open' })).toMatchObject({ total: 0 })
  })
})
