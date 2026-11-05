/**
 * The residual stage-3 regressions (T1–T5), through the real chain: the compiled
 * helper, the production host, collector, engine and history driver, a real note
 * store, and only the provider faked at the completer seam.
 *
 * Each case exists because the previous round passed a test that never used the
 * production entry point. Nothing calls `card.save` to stand in for the pipeline
 * and no claim is released by hand.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS, mergeSettings } from '@shared/defaults'
import type { Settings } from '@shared/types'

import { NotesStore } from '../notes'
import { KnowledgeCollector } from './collector'
import { ExtractEngine } from './engine'
import { HistoryDriver } from './history'
import { KnowledgeHost } from './host'
import { createHistoryPages } from './pages'
import { createSourceRecovery } from './recover'
import { syncKnowledge, type KnowledgeWiring } from './session'

const ENTRY = join(process.cwd(), 'native', 'bin', 'yu-knowledge.exe')

async function until<T>(check: () => Promise<T | null>, what: string, timeoutMs = 30_000): Promise<T> {
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
      // A root that is still held shows up in the exit code, never hidden.
    }
  }
})

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.stop()
})

const BODY = '这段材料说明：先看约束，再看机制，最后才是取舍理由，并标明哪些结论仍待验证。'

interface Call {
  messages: { content: string }[]
  signal?: AbortSignal
}

type Completer = (call: Call) => Promise<string>

function promptOf(call: Call): string {
  return call.messages.map(message => message.content).join('\n')
}

/** One card that references the batch it was handed. */
function cardAnswer(text: string, body = BODY): string {
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
}

interface Harness {
  dir: string
  notes: NotesStore
  host: KnowledgeHost
  collector: KnowledgeCollector
  engine: ExtractEngine
  state: { allowed: boolean; broken: boolean; settings: Settings }
  lines: string[]
  threads: Map<string, FakeThread>
  wiring: {
    collector: KnowledgeCollector
    history: { resume: () => Promise<null> }
    engine: ExtractEngine
  }
}

interface FakeThread {
  userId: string
  answerId: string
  question: string
  answer: string
}

function harness(completer: Completer): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'yu-knowledge-residual-'))
  roots.push(dir)
  const state = {
    allowed: true,
    broken: false,
    settings: mergeSettings({
      ...DEFAULT_SETTINGS,
      notesDir: join(dir, 'notes'),
      knowledge: { enabled: true, notes: true, chat: true, reading: true }
    })
  }
  const notes = new NotesStore({
    log: () => undefined,
    getSettings: () => state.settings,
    notify: () => undefined
  })
  const host = new KnowledgeHost({
    entry: ENTRY,
    root: dir,
    requestMs: 30_000,
    idleMs: 60_000,
    completer: completer as never
  })
  instances.push(host)
  const threads = new Map<string, FakeThread>()
  const recovery = createSourceRecovery({
    notes: () => notes,
    chats: () => ({
      // A chat source is read back the way the real store is: by thread, anchored on
      // the user message, and only when the answer really finished.
      get: (id: string, _limit?: number, anchor?: string) => {
        const thread = threads.get(id)
        if (!thread || (anchor && anchor !== thread.userId)) return undefined
        return {
          memoryTemporary: false,
          messages: [
            { id: thread.userId, role: 'user', text: thread.question, state: 'done' },
            { id: thread.answerId, role: 'assistant', text: thread.answer, state: 'done' }
          ]
        }
      },
      historyThreads: () => [],
      historyTurns: () => ({ turns: [], nextSeq: 0, done: true })
    })
  })
  const collector = new KnowledgeCollector({
    settings: () => state.settings,
    host: () => host,
    readBody: (channel, originRef) => recovery(channel, originRef)
  })
  const lines: string[] = []
  const engine = new ExtractEngine({
    host: () => host,
    readBody: (channel, originRef) => {
      if (state.broken) throw new Error('EIO: the store raised while reading')
      return collector.resolveBody(channel, originRef)
    },
    settings: () => state.settings,
    allowed: () => state.allowed,
    log: line => lines.push(line)
  })
  return {
    dir,
    notes,
    host,
    collector,
    engine,
    state,
    lines,
    threads,
    wiring: { collector, history: { resume: async () => null }, engine }
  }
}

type SettledNote = Parameters<KnowledgeCollector['noteSettled']>[0]

function settle(collector: KnowledgeCollector, note: SettledNote): void {
  collector.noteSettled({
    id: note.id,
    title: note.title,
    transcript: note.transcript,
    polished: note.polished,
    updatedAt: note.updatedAt
  })
}

describe('T1: a history scan wakes extraction', () => {
  it('extracts what the scan queued without anybody calling tick', { timeout: 120_000 }, async () => {
    let calls = 0
    const { notes, host, collector, engine } = harness(async call => {
      calls += 1
      return cardAnswer(promptOf(call))
    })
    for (const text of ['第零条随记：先确认约束。', '第一条随记：再谈机制。', '第二条随记：最后谈取舍。']) {
      await notes.createText({ text })
    }
    await collector.sync({ game: false })
    const pages = createHistoryPages({
      notes: () => notes,
      chats: () => ({
        historyThreads: () => [],
        historyTurns: () => ({ turns: [], nextSeq: 0, done: true }),
        get: () => ({})
      })
    })
    const history = new HistoryDriver({
      host: () => host,
      pages,
      allowed: () => true,
      onBatch: () => engine.wake()
    })
    const started = await history.start({ notes: true, chat: false })
    expect(started?.scopes.notes, 'the scan really ran').toBe(true)

    const done = await until(async () => {
      const status = await host.queueStatus()
      return status.total > 0 && status.counts.completed === status.total ? status : null
    }, 'the scanned groups to be extracted')
    expect(done.counts.working, 'nothing stayed claimed').toBe(0)
    expect(calls, 'the scan itself reached the model').toBeGreaterThan(0)
    engine.stop()
  })
})

describe('T2: a raising read settles the claim', () => {
  it('fails the task at once and completes after the fault clears', async () => {
    const { notes, host, collector, engine, state } = harness(async call => cardAnswer(promptOf(call)))
    await collector.sync({ game: false })
    settle(collector, await notes.createText({ text: '一条读取会失败但可重试的随记。' }))
    await until(async () => ((await host.queueStatus()).total === 1 ? true : null), 'the note to be queued')

    const pid = host.pid
    state.broken = true
    await engine.tick()
    const failed = await until(async () => {
      const status = await host.queueStatus()
      return status.counts.failed === 1 ? status : null
    }, 'the task to fail while the helper keeps running')
    expect(failed.counts.working, 'the claim was released').toBe(0)
    expect(host.pid, 'the helper was not restarted').toBe(pid)

    const task = (await host.listQueue()).items[0]!
    expect(task.state).toBe('failed')
    expect(task.error ?? '').toContain('EIO')

    state.broken = false
    await host.retryTask({ groupId: task.id })
    await engine.tick()
    const completed = await until(async () => {
      const status = await host.queueStatus()
      return status.counts.completed === 1 ? status : null
    }, 'the retried task to complete')
    expect(completed.counts.failed).toBe(0)
  })
})

describe('T3: a target lost during the comparison', () => {
  type Action = 'reference' | 'merge' | 'propose'

  async function compareCase(
    action: Action,
    duringCompare: (card: string, host: KnowledgeHost) => Promise<void>,
    beforeSecond?: (card: string, host: KnowledgeHost) => Promise<void>
  ) {
    let target: string | null = null
    let compared = 0
    let extracted = 0
    let hostRef: KnowledgeHost | null = null
    const built = harness(async call => {
      const text = promptOf(call)
      if (/来源 \S+（第 \d+ 段/.test(text)) {
        extracted += 1
        // The second note concludes the same thing with one more detail, so it goes
        // through the comparison instead of matching exactly.
        return cardAnswer(text, extracted === 1 ? BODY : `${BODY}（补充：这条随记多一句。）`)
      }
      compared += 1
      if (target) {
        await duringCompare(target, hostRef!)
      }
      return JSON.stringify({
        decisions: [{ index: 0, action, targetCardId: target, reason: '按比较结论处理' }]
      })
    })
    const { notes, host, collector, engine } = built
    hostRef = host
    await collector.sync({ game: false })
    settle(collector, await notes.createText({ text: '第一条随记：约束先行的取舍。' }))
    await until(async () => ((await host.queueStatus()).total === 1 ? true : null), 'the first note to be queued')
    await engine.tick()
    const first = await host.listCards()
    expect(first.total, 'the target card exists').toBe(1)
    target = first.items[0]!.id
    if (beforeSecond) await beforeSecond(target, built.host)

    settle(collector, await notes.createText({ text: '第二条随记：同样先谈约束。' }))
    await until(async () => ((await host.queueStatus()).total === 2 ? true : null), 'the second note to be queued')
    await engine.tick()
    return { host, compared, target: target }
  }

  it.each(['reference', 'merge', 'propose'] as const)(
    'refuses a %s whose target was deleted, without writing a substitute card',
    { timeout: 120_000 },
    async action => {
      const { host, compared } = await compareCase(action, async (card, live) => {
        await live.deleteCard(card)
      })
      expect(compared, 'the comparison really ran').toBe(1)
      expect((await host.listCards()).total, 'no substitute card was written').toBe(0)
      const status = await host.queueStatus()
      expect(status.counts.completed, 'the stale judgement committed no progress').toBe(1)
      expect(status.counts.working, 'the claim was released').toBe(0)
    }
  )

  it('refuses a merge whose target changed while the model answered', { timeout: 120_000 }, async () => {
    const edited = `${BODY}（人工补充：这段是我改过的。）`
    const { host } = await compareCase('merge', async (card, live) => {
      await live.updateCard({ id: card, body: edited })
    })
    const cards = await host.listCards()
    expect(cards.total, 'the target is kept, no substitute').toBe(1)
    const card = await host.getCard(cards.items[0]!.id)
    expect(card.body, 'the human body was not overwritten').toBe(edited)
    expect(card.edited, 'the edit is recorded').toBe(true)
    expect(card.revision, 'the human revision stands').toBe(2)
    const open = await host.listSuggestions()
    expect(open.total, 'a stale draft cannot come back as a suggestion').toBe(0)
    const status = await host.queueStatus()
    expect(status.counts.working, 'the claim was released').toBe(0)
    expect(status.counts.needs_reread, 'the judge was refused as stale').toBe(1)
    expect(status.counts.completed, 'the refused batch committed no progress').toBe(1)
  })

  it('suggests against the revision the model actually saw', { timeout: 120_000 }, async () => {
    const edited = `${BODY}（人工补充：比较之前我就改过。）`
    const { host } = await compareCase(
      'merge',
      async () => undefined,
      async (card, live) => {
        await live.updateCard({ id: card, body: edited })
      }
    )
    const open = await host.listSuggestions({ state: 'open' })
    expect(open.total, 'the edited card yields one usable suggestion').toBe(1)
    const suggestion = open.items[0]!
    expect(suggestion.targetRevision, 'the suggestion is bound to the seen revision').toBe(2)

    const cards = await host.listCards()
    const target = cards.items[0]!.id
    const accepted = await host.acceptSuggestion(suggestion.id)
    expect(accepted.state).toBe('accepted')
    const card = await host.getCard(target)
    expect(card.revision, 'accepting bumps the card revision').toBe(3)
    expect(card.body, 'the accepted draft replaced the body').toContain('补充：这条随记多一句。')
    expect(card.edited, 'the human edit flag survives').toBe(true)
    expect(card.sourceIds.length, 'both sources stay attached').toBe(2)
  })

  it('refuses a suggestion once the card moved past its revision', { timeout: 120_000 }, async () => {
    const edited = `${BODY}（人工补充：比较之前我就改过。）`
    const later = `${edited}（后来又改了一次。）`
    const { host } = await compareCase(
      'merge',
      async () => undefined,
      async (card, live) => {
        await live.updateCard({ id: card, body: edited })
      }
    )
    const open = await host.listSuggestions({ state: 'open' })
    expect(open.total).toBe(1)
    const suggestion = open.items[0]!
    const target = (await host.listCards()).items[0]!.id
    await host.updateCard({ id: target, body: later })

    await expect(host.acceptSuggestion(suggestion.id)).rejects.toMatchObject({ code: 'source_changed' })
    const card = await host.getCard(target)
    expect(card.body, 'the newer human body is intact').toBe(later)
    expect(card.revision, 'no revision was applied on top').toBe(3)
    const after = await host.getSuggestion(suggestion.id)
    expect(after.state, 'the stale suggestion is closed').toBe('rejected')
  })
})

describe('T4: control operations park the task', () => {
  it('cancels the batch of a closed channel and resumes it when reopened', { timeout: 120_000 }, async () => {
    const signals: (AbortSignal | undefined)[] = []
    let blocked = true
    const gate: { release: (() => void) | null } = { release: null }
    const { notes, host, collector, engine, state, wiring } = harness(async call => {
      signals.push(call.signal)
      if (blocked) {
        blocked = false
        await new Promise<void>(resolve => {
          gate.release = resolve
        })
      }
      return cardAnswer(promptOf(call))
    })
    await collector.sync({ game: false })
    settle(collector, await notes.createText({ text: '一条在等待模型时被关掉渠道的随记。' }))
    await until(async () => ((await host.queueStatus()).total === 1 ? true : null), 'the note to be queued')

    const running = engine.tick()
    await until(async () => (signals.length ? true : null), 'the model call to start')
    expect(signals[0]?.aborted ?? false).toBe(false)

    // Only the note channel closes; the master switch stays on.
    state.settings.knowledge!.notes = false
    await syncKnowledge(wiring as unknown as KnowledgeWiring, false)
    await until(async () => (signals[0]?.aborted ? true : null), 'the provider call to be aborted')
    gate.release?.()
    await running

    const parked = await host.queueStatus()
    expect(parked.counts.working, 'the claim was released').toBe(0)
    expect(parked.counts.completed, 'a cancelled batch writes no card').toBe(0)
    expect(parked.counts.ready, 'the task stays runnable').toBe(1)
    expect((await host.listCards()).total).toBe(0)

    state.settings.knowledge!.notes = true
    await syncKnowledge(wiring as unknown as KnowledgeWiring, false)
    const finished = await until(async () => {
      const status = await host.queueStatus()
      return status.counts.completed === 1 ? status : null
    }, 'the same task to finish after the channel reopened')
    expect(finished.counts.needs_reread, 'the body was readable all along').toBe(0)
  })

  it('parks the claim before the helper stops in game mode', { timeout: 120_000 }, async () => {
    let blocked = true
    const gate: { release: (() => void) | null } = { release: null }
    const { notes, host, collector, engine, state, wiring } = harness(async call => {
      if (blocked) {
        blocked = false
        await new Promise<void>(resolve => {
          gate.release = resolve
        })
      }
      return cardAnswer(promptOf(call))
    })
    await collector.sync({ game: false })
    settle(collector, await notes.createText({ text: '一条在游戏开始时正在提炼的随记。' }))
    await until(async () => ((await host.queueStatus()).total === 1 ? true : null), 'the note to be queued')

    const running = engine.tick()
    await until(async () => (host.pid ? true : null), 'the helper to be running')
    await new Promise(resolve => setTimeout(resolve, 100))

    // The production order: park through the switch bridge, then stop the helper.
    state.allowed = false
    await syncKnowledge(wiring as unknown as KnowledgeWiring, true)
    gate.release?.()
    await running
    await host.stop()

    // Leaving the game must find the task runnable, not failed by the startup repair.
    await collector.sync({ game: false })
    const parked = await host.queueStatus()
    expect(parked.counts.failed, 'a normal stop is not a crash').toBe(0)
    expect(parked.counts.ready, 'the task waits for the next wake').toBe(1)
    expect(parked.counts.working).toBe(0)

    state.allowed = true
    engine.wake()
    const finished = await until(async () => {
      const status = await host.queueStatus()
      return status.counts.completed === 1 ? status : null
    }, 'the parked task to finish after the game ended')
    expect(finished.counts.working).toBe(0)
  })
})

describe('T5: a group with long metadata still fits the frame', () => {
  it('plans a 450-source group in bounded frames and extracts all of it', { timeout: 180_000 }, async () => {
    const seen = new Set<string>()
    let batches = 0
    const { host, collector, engine, threads } = harness(async call => {
      const text = promptOf(call)
      batches += 1
      for (const match of text.matchAll(/来源 (\S+)（第 \d+ 段/g)) seen.add(match[1]!)
      return cardAnswer(text)
    })
    await collector.sync({ game: false })

    const at = Date.now()
    for (let index = 0; index < 450; index += 1) {
      const threadId = `thread-${index}`
      const userId = `user-${index}`
      // The answer id carries the padding on purpose: the source reference is what
      // the description of every source grows with.
      const answerId = `answer-${index}-${'源'.repeat(130)}`
      const question = `Synthetic distinct turn ${index}`
      const answer = `第 ${index} 条回答`
      threads.set(threadId, { userId, answerId, question, answer })
      await host.publishSource({
        channel: 'chat',
        kind: 'chat',
        originRef: `${threadId}:${userId}:${answerId}`,
        groupKey: 'thread-long',
        threadKey: threadId,
        title: '题'.repeat(200),
        scope: '范'.repeat(1000),
        text: `${question}

${answer}`,
        at: at + index
      })
    }
    const queued = await host.queueStatus()
    expect(queued.total, 'one group holds every turn').toBe(1)

    // Many runnable batches, but one wake: the engine walks until Rust is done.
    await engine.tick()
    const done = await until(async () => {
      const status = await host.queueStatus()
      return status.counts.completed === 1 ? status : null
    }, 'the long-metadata group to finish', 150_000)
    expect(done.counts.working, 'no plan was too large').toBe(0)

    const groupId = (await host.listQueue()).items[0]!.id
    let total = 0
    let offset: number | null = 0
    const ordinals = new Set<number>()
    while (offset !== null) {
      const page = await host.queueItems({ groupId, limit: 40, offset })
      total = page.total
      for (const item of page.items) ordinals.add(item.ordinal)
      offset = page.nextOffset
    }
    expect(total, 'every source stays reachable').toBe(450)
    expect(ordinals.size, 'no source was skipped or duplicated').toBe(450)
    expect(seen.size, 'every distinct body reached the model').toBe(450)
    // The descriptions alone exceed one frame, so the plan really had to be split.
    expect(batches, 'the plan was split instead of oversized').toBeGreaterThan(1)
  })
})
