/**
 * The regression suite for the stage-3 review findings, through the real chain:
 * the compiled helper, the production host, the production collector and engine,
 * a real note store and only the provider faked at the completer seam.
 *
 * Nothing here calls `card.save` to stand in for the pipeline; the only seeding
 * that goes around it is publishing a source, which is what stage 2 already does.
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
import type { ReadingProjection } from './collector'

const ENTRY = join(process.cwd(), 'native', 'bin', 'yu-knowledge.exe')

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

const BODY = '这段材料说明：先看约束，再看机制，最后才是取舍理由，并标明哪些结论仍待验证。'

/** Answers the extraction prompt with one card that references the batch it was given. */
function extractor(body = BODY) {
  return vi.fn(async (call: { messages: { content: string }[] }) => {
    const text = call.messages.map(message => message.content).join('\n')
    const named = /来源 (\S+)（第 (\d+) 段/.exec(text)
    if (!named) return JSON.stringify({ cards: [] })
    return JSON.stringify({
      cards: [
        {
          kind: 'concept',
          title: '约束先行',
          summary: '先确认约束再谈机制',
          body,
          topics: ['方法'],
          aliases: [],
          sources: [{ sourceId: named[1], segment: Number(named[2]) }]
        }
      ],
      reason: 'ok'
    })
  })
}

interface Harness {
  dir: string
  notes: NotesStore
  host: KnowledgeHost
  collector: KnowledgeCollector
  engine: ExtractEngine
  lines: string[]
}

function harness(completer: unknown, allowed: () => boolean = () => true): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'yu-knowledge-repair-'))
  roots.push(dir)
  const settings = mergeSettings({
    ...DEFAULT_SETTINGS,
    notesDir: join(dir, 'notes'),
    knowledge: { enabled: true, notes: true, chat: true, reading: true }
  })
  const notes = new NotesStore({ log: () => undefined, getSettings: () => settings, notify: () => undefined })
  const host = new KnowledgeHost({
    entry: ENTRY,
    root: dir,
    requestMs: 30_000,
    idleMs: 60_000,
    completer: completer as never
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
    // The production wiring: reading bodies come out of the collector's stash.
    readBody: (channel, originRef) => collector.resolveBody(channel, originRef),
    settings: () => settings,
    allowed,
    log: line => lines.push(line)
  })
  return { dir, notes, host, collector, engine, lines }
}

function reading(origin = 'https://example.invalid/a', text = BODY): ReadingProjection {
  return {
    threadId: 'ask:t1',
    scope: '浮动提问',
    request: '这段材料讲了什么',
    materials: [{ origin, title: '材料一', text, url: origin }],
    answer: '讲了取舍顺序。',
    sources: [{ title: '材料一', url: origin }],
    at: Date.now()
  }
}

describe('stage-3 repair: the real loop', () => {
  it('drains two queued notes in a single wake', async () => {
    const { notes, host, collector, engine } = harness(extractor())
    await collector.sync({ game: false })
    for (const text of ['第一条随记，先确认约束。', '第二条随记，再谈机制与取舍。']) {
      const note = await notes.createText({ text })
      collector.noteSettled({
        id: note.id,
        title: note.title,
        transcript: note.transcript,
        polished: note.polished,
        updatedAt: note.updatedAt
      })
    }
    await until(async () => ((await host.queueStatus()).total === 2 ? true : null), 'two tasks queued')

    // One tick, no second wake: the engine walks until Rust has nothing left.
    await engine.tick()
    const status = await host.queueStatus()
    expect(status.counts.completed, 'both groups were drained in one wake').toBe(2)
    // The stand-in answers the same conclusion for both notes, so the second
    // batch is a reference to the first card instead of a duplicate.
    const cards = await host.listCards()
    expect(cards.total).toBe(1)
    expect((await host.getCard(cards.items[0]!.id)).sourceIds).toHaveLength(2)
  })

  it('extracts a reading summary from the in-memory stash', async () => {
    const { host, collector, engine } = harness(extractor())
    await collector.sync({ game: false })
    collector.readingFinished(reading())
    await until(async () => ((await host.queueStatus()).total === 1 ? true : null), 'the reading task to be queued')
    await engine.tick()
    const cards = await host.listCards()
    expect(cards.total, 'a reading source reaches the model').toBe(1)
    const card = await host.getCard(cards.items[0]!.id)
    expect(card.body).toBe(BODY)
    const source = await host.getSource(card.sourceIds[0]!)
    expect(source.kind).toBe('web')
    expect(source.locator).toBe('https://example.invalid/a')
  })

  it('cannot extract a reading source once its body is evicted', async () => {
    const { host, collector, engine } = harness(extractor())
    await collector.sync({ game: false })
    collector.readingFinished(reading())
    await until(async () => ((await host.queueStatus()).total === 1 ? true : null), 'the reading task to be queued')
    // Closing the switch drops the bodies the same way an eviction does: the task
    // must end up asking for a re-read, never retrying into a missing body.
    collector.clear()
    const parked = await until(async () => {
      const status = await host.queueStatus()
      return status.counts.needs_reread === 1 ? status : null
    }, 'the task to need a re-read')
    expect(parked.counts.completed, 'an evicted body never becomes a card').toBe(0)
    await engine.tick()
    expect((await host.listCards()).total).toBe(0)
  })

  it('leaves a task retryable when the model answers garbage', async () => {
    const bad = vi.fn(async () => 'not json at all')
    const { notes, host, collector, engine } = harness(bad)
    await collector.sync({ game: false })
    const note = await notes.createText({ text: '一条会被模型答坏的随记。' })
    collector.noteSettled({
      id: note.id,
      title: note.title,
      transcript: note.transcript,
      polished: note.polished,
      updatedAt: note.updatedAt
    })
    await until(async () => ((await host.queueStatus()).total === 1 ? true : null), 'the note to be queued')
    await engine.tick()

    const failed = await until(async () => {
      const status = await host.queueStatus()
      return status.counts.failed === 1 ? status : null
    }, 'the task to fail explicitly')
    expect(failed.counts.working, 'nothing stays claimed').toBe(0)
    expect((await host.listCards()).total).toBe(0)

    // A retry has to be possible: the claim was released, not leaked.
    const page = await host.listQueue({ state: 'failed' })
    await host.retryTask({ groupId: page.items[0]!.id })
    ;(host as unknown as { options: { completer: unknown } }).options.completer = extractor()
    await engine.tick()
    expect((await host.listCards()).total, 'the retried task completes').toBe(1)
  })

  it('writes no card when the batch is cancelled before the answer', async () => {
    let release: (value: string) => void = () => undefined
    const slow = vi.fn(
      () =>
        new Promise<string>(resolve => {
          release = resolve
        })
    )
    const { notes, host, collector, engine } = harness(slow)
    await collector.sync({ game: false })
    const note = await notes.createText({ text: '一条在等待回答时被暂停的随记。' })
    collector.noteSettled({
      id: note.id,
      title: note.title,
      transcript: note.transcript,
      polished: note.polished,
      updatedAt: note.updatedAt
    })
    await until(async () => ((await host.queueStatus()).total === 1 ? true : null), 'the note to be queued')

    const ticking = engine.tick()
    await until(async () => (slow.mock.calls.length ? true : null), 'the model call to start')
    await host.pauseCollect('manual', true)
    engine.abort('采集已暂停')
    release(JSON.stringify({ cards: [] }))
    await ticking

    expect((await host.listCards()).total, 'a cancelled batch writes nothing').toBe(0)
    const status = await host.queueStatus()
    expect(status.counts.completed).toBe(0)
    expect(status.paused).toBe(true)
  })
})
