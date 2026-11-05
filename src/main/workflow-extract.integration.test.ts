/**
 * Stage 6 D: a saved workflow hands the page it really read to extraction, through
 * the same source chain a normal summary uses.
 *
 * The real executor (`runTool('run_workflow')`), the real hand-off module, a real
 * `WorkflowStore`, the production collector and extraction engine, and the real
 * release helper all run here. Only the Electron shell and the model transport are
 * stand-ins; the page itself comes from a hand-written fetch double, exactly the
 * way the tool context carries a transport.
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

import { KnowledgeCollector, readingKey, readingMaterial, type NoteProjection } from './knowledge/collector'
import { ExtractEngine } from './knowledge/engine'
import { handoffNote, handoffReading, type HandoffDeps } from './knowledge/handoff'
import { KnowledgeHost } from './knowledge/host'
import { extractSourceNow } from './knowledge/manual'
import { createSourceRecovery } from './knowledge/recover'
import type { KnowledgeTools } from './tools/knowledge'
import { runTool, type ToolContext } from './tools/registry'
import { WorkflowStore } from './workflows'

const ENTRY = join(process.cwd(), 'native', 'bin', 'yu-knowledge.exe')
const PAGE = 'https://example.test/dedupe'
const BODY =
  '写入顺序固定为先认领版本，再删卡片，最后收尾关系；顺序反过来会留下指向已删卡片的悬空链接，检索时就查不到它了。'
const HTML = `<html><head><title>去重笔记</title></head><body><p>${BODY}</p></body></html>`
const roots: string[] = []
const hosts: KnowledgeHost[] = []

beforeAll(() => {
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
  id: string
  kind: string
  origin_ref: string
  version: string
  state: string
}

function readSources(root: string): SourceRow[] {
  const db = new DatabaseSync(join(root, 'data', 'knowledge', 'knowledge.db'), { readOnly: true })
  try {
    return db.prepare('SELECT id, kind, origin_ref, version, state FROM sources ORDER BY rowid').all() as unknown as SourceRow[]
  } finally {
    db.close()
  }
}

/**
 * The normal summary path writes a reading, exactly as a finished answer does:
 * one `readingFinished` call with the material the turn read.
 */
function summarize(current: Rig, text: string): void {
  const material = readingMaterial('read_webpage', { url: PAGE, title: '去重笔记', text })
  expect(material).not.toBeNull()
  current.collector.readingFinished({
    threadId: 'thread-1',
    scope: '主界面问答',
    request: '这页讲了什么',
    materials: [material!],
    answer: '先认领版本再删卡片。',
    sources: [{ title: '去重笔记', url: PAGE }],
    at: Date.now()
  })
}

/** The body this process would hand to extraction for that page right now. */
function bodyOf(current: Rig): string | null {
  const held = current.collector.resolveBody('reading', PAGE)
  return 'text' in held ? held.text : null
}

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, label: string, attempts = 400, delay = 25): Promise<T> {
  let last: T | undefined
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      last = await read()
      if (done(last)) return last
    } catch {
      // the database file is not there yet, or the helper still holds it
    }
    await new Promise(resolve => setTimeout(resolve, delay))
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`)
}

interface Rig {
  root: string
  settings: Settings
  host: KnowledgeHost
  collector: KnowledgeCollector
  engine: ExtractEngine
  workflows: WorkflowStore
  tools: KnowledgeTools
  handoff: HandoffDeps
  /** What the extraction model was asked, in order. */
  prompts: string[]
  /** What the last hand-over published, and whether the engine was woken. */
  evidence: { publishedId: string | null; wakes: number }
  /** The notes the note hand-over may read back, by id. */
  notes: Map<string, NoteProjection>
}

/** The app's own wiring, one layer at a time: collector, engine, hand-off, tools. */
async function rig(
  options: {
    reading?: boolean
    /** Replaces the helper's pause state, so a test can hold the wait open. */
    paused?: () => Promise<{ manual: boolean; game: boolean }>
    /** Wraps the host the collector talks to, to hold a switch hand-over open. */
    collectorHost?: (host: KnowledgeHost) => KnowledgeHost
    /** One note the note hand-over may read back. */
    note?: { id: string; text: string }
    /** Held right after a hand-over published, before the source is queued. */
    beforeExtract?: () => Promise<void>
  } = {}
): Promise<Rig> {
  if (!existsSync(ENTRY)) throw new Error(`the knowledge helper is missing: ${ENTRY}`)
  const root = mkdtempSync(join(tmpdir(), 'yu-workflow-extract-'))
  roots.push(root)
  mock.dir = root
  const reading = options.reading !== false
  const settings = mergeSettings({
    ...DEFAULT_SETTINGS,
    notesDir: join(root, 'notes'),
    knowledge: { enabled: true, notes: true, chat: true, reading }
  })
  const prompts: string[] = []
  // The extraction model: it is told which source it read, and answers one card
  // that cites that very source — the way the helper's own prompt asks.
  const completer = async (call: { messages: { content: string }[] }): Promise<string> => {
    const prompt = call.messages.map(message => message.content).join('\n')
    prompts.push(prompt)
    const named = /来源 (\S+)（第 0 段/.exec(prompt)
    if (!named) return JSON.stringify({ cards: [], reason: '没有可提炼的内容' })
    return JSON.stringify({
      cards: [
        {
          kind: 'method',
          title: '写入顺序',
          summary: '先认领版本再删卡片',
          body: BODY,
          topics: ['写入'],
          aliases: [],
          sources: [{ sourceId: named[1], segment: 0 }],
          reason: '可复用'
        }
      ],
      reason: 'ok'
    })
  }
  const host = new KnowledgeHost({ entry: ENTRY, root, requestMs: 20_000, idleMs: 60_000, completer: completer as never })
  hosts.push(host)
  await host.configureCollect({ enabled: true, notes: true, chat: true, reading })
  const recovery = createSourceRecovery({ notes: () => ({ list: () => ({ notes: [] }) }), chats: () => ({ get: () => undefined }) })
  const collectorHost = options.collectorHost ? options.collectorHost(host) : host
  const collector = new KnowledgeCollector({
    settings: () => settings,
    host: () => collectorHost,
    readBody: (channel, originRef) => recovery(channel, originRef)
  })
  await collector.sync()
  const engine = new ExtractEngine({
    host: () => host,
    readBody: (channel, originRef) => collector.resolveBody(channel, originRef),
    settings: () => settings,
    allowed: () => true
  })
  const evidence: { publishedId: string | null; wakes: number } = { publishedId: null, wakes: 0 }
  const notes = new Map<string, NoteProjection>()
  if (options.note) {
    notes.set(options.note.id, {
      id: options.note.id,
      title: '合成随记',
      transcript: options.note.text,
      polished: '',
      updatedAt: Date.now(),
      polishStatus: 'skipped'
    })
  }
  const handoff: HandoffDeps = {
    enabled: () => collector.enabled,
    channelOn: channel => settings.knowledge[channel] !== false,
    gameActive: () => false,
    disabled: () => settings.assistantAccess.disabledTools,
    paused: options.paused ?? (async () => (await host.queueStatus()).pausedReasons),
    publishReading: async (material, publishOptions) => {
      const published = await collector.publishReading(
        { ...material, locator: material.url ?? '' } as never,
        { threadId: 'workflow', at: Date.now(), scope: '工作流' },
        publishOptions
      )
      evidence.publishedId = published?.sourceId ?? null
      return published?.sourceId ?? null
    },
    publishNote: async (noteId, publishOptions) => {
      const note = notes.get(noteId)
      // The production adapter reads the note back through its own store; the
      // stand-in is the same projection, not a body handed in by the caller.
      if (!note) throw new Error('这条随记已不存在')
      const published = await collector.publishNote(note, [], publishOptions)
      evidence.publishedId = published?.sourceId ?? null
      return published?.sourceId ?? null
    },
    extract: async (sourceId, extractOptions) => {
      if (options.beforeExtract) await options.beforeExtract()
      return extractSourceNow(sourceId, {
        host: () => host,
        signal: extractOptions.signal,
        enabled: () => collector.enabled,
        allowed: () => collector.enabled,
        resolveBody: (channel, originRef) => collector.resolveBody(channel, originRef),
        wake: () => {
          evidence.wakes += 1
          engine.wake()
        },
        log: () => undefined
      })
    }
  }
  const tools: KnowledgeTools = {
    enabled: () => collector.enabled,
    search: async (query, limit) => {
      const page = await host.searchCards({ query, offset: 0, limit })
      return { total: page.total, items: page.items }
    },
    get: id => host.getCard(id),
    reading: (material, options) => handoffReading(handoff, material, options),
    extractFromNote: (noteId, options) => handoffNote(handoff, noteId, options)
  }
  const workflows = new WorkflowStore(join(root, 'workflows.json'), () => Date.now())
  return { root, settings, host, collector, engine, workflows, tools, handoff, prompts, evidence, notes }
}

/** A transport the URL check treats as a test double, so no DNS is involved. */
function fetchOf(body = HTML): typeof fetch {
  return vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })) as unknown as typeof fetch
}

function contextOf(current: Rig, fetchImpl: typeof fetch, allowedTools: string[], signal?: AbortSignal): ToolContext {
  return {
    settings: current.settings,
    question: '跑一下早间提炼',
    log: () => undefined,
    workflow: current.workflows,
    knowledge: current.tools,
    allowedTools,
    cache: new Map(),
    signal: signal ?? new AbortController().signal,
    onLocalResult: () => undefined,
    fetchImpl
  } as unknown as ToolContext
}

describe('a saved workflow hands what it read to extraction', () => {
  it('publishes the page once, queues it, and the card cites that source', async () => {
    const current = await rig()
    const saved = current.workflows.save({
      name: '早间提炼',
      steps: [
        { tool: 'read_webpage', args: { url: PAGE }, label: '读页面' },
        { tool: 'extract_knowledge', args: {}, label: '送入提炼' }
      ]
    })

    const result = await runTool('run_workflow', { id: saved.id }, contextOf(current, fetchOf(), ['run_workflow', 'read_webpage']))
    expect(result.ok, JSON.stringify(result.data)).toBe(true)

    // The queue holds the source the collector minted from the text in hand.
    const queued = await current.host.queueStatus()
    expect(queued.total).toBeGreaterThanOrEqual(1)
    const rows = await until(() => readSources(current.root), list => list.some(row => row.origin_ref === PAGE), 'the reading source')
    const mine = rows.filter(row => row.origin_ref === PAGE)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ kind: 'web', state: 'active' })

    // Extraction runs on that source, and the card it makes points back at it.
    const cards = await until(
      async () => {
        await current.engine.tick()
        return current.host.listCards({ offset: 0, limit: 20 })
      },
      list => list.total > 0,
      'the extracted card',
      100,
      100
    )
    expect(cards.items[0].title).toBe('写入顺序')
    // The card cites the source this hand-over really published, not just any id.
    expect(current.evidence.publishedId).toMatch(/^src_/)
    expect((await current.host.getCard(cards.items[0].id)).sourceIds).toEqual([current.evidence.publishedId])
    expect(current.prompts.join('\n')).toContain(BODY)
  }, 120_000)

  it('shares one source with the normal summary path instead of publishing twice', async () => {
    const current = await rig()
    // The summary path first: the very entry point a finished answer uses.
    summarize(current, BODY)
    const rows = await until(
      () => readSources(current.root).filter(row => row.origin_ref === PAGE),
      list => list.length > 0,
      'the summary source'
    )
    const sourceId = rows[0].id

    // The same page, read by a saved workflow: same origin, same text, so the
    // helper answers with the source the summary already published.
    const saved = current.workflows.save({
      name: '早间提炼',
      steps: [
        { tool: 'read_webpage', args: { url: PAGE }, label: '读页面' },
        { tool: 'extract_knowledge', args: {}, label: '送入提炼' }
      ]
    })
    const result = await runTool('run_workflow', { id: saved.id }, contextOf(current, fetchOf(), ['run_workflow', 'read_webpage']))
    expect(result.ok).toBe(true)

    const after = readSources(current.root).filter(row => row.origin_ref === PAGE)
    expect(after, 'a duplicate reading adds no source').toHaveLength(1)
    expect(after[0].id).toBe(sourceId)
    const queue = await current.host.queueStatus()
    expect(queue.total, 'and no second task').toBe(1)

    // One extraction for both readers: the card is not copied either, and it
    // points at the source both paths share.
    const cards = await until(
      async () => {
        await current.engine.tick()
        return current.host.listCards({ offset: 0, limit: 20 })
      },
      list => list.total > 0,
      'the extracted card',
      100,
      100
    )
    expect(cards.total).toBe(1)
    expect((await current.host.getCard(cards.items[0].id)).sourceIds).toEqual([sourceId])
  }, 120_000)

  it('stops with the real reason when the reading channel is off', async () => {
    const current = await rig({ reading: false })
    const saved = current.workflows.save({
      name: '早间提炼',
      steps: [
        { tool: 'read_webpage', args: { url: PAGE }, label: '读页面' },
        { tool: 'extract_knowledge', args: {}, label: '送入提炼' },
        { tool: 'get_datetime', args: {}, label: '看时间' }
      ]
    })
    const result = await runTool('run_workflow', { id: saved.id }, contextOf(current, fetchOf(), ['run_workflow', 'read_webpage', 'get_datetime']))
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('知识库没有开启阅读采集')
    const steps = result.data.steps as Array<{ tool: string }>
    expect(steps.map(row => row.tool)).toEqual(['read_webpage', 'extract_knowledge'])
    expect(readSources(current.root).filter(row => row.origin_ref === PAGE)).toHaveLength(0)
  }, 120_000)

  it('refuses the note branch with the note channel off, without publishing', async () => {
    const current = await rig()
    const off = mergeSettings({
      ...current.settings,
      knowledge: { ...current.settings.knowledge, notes: false }
    })
    // The same hand-off module the tool calls, with only that channel switched off.
    const blocked = await handoffNote({ ...current.handoff, channelOn: channel => off.knowledge[channel] !== false }, 'note-1')
    expect(blocked).toMatchObject({ queued: 0, reason: '知识库没有开启随记采集' })
  }, 60_000)

  it('stops with the real reason while collection is paused', async () => {
    const current = await rig()
    await current.host.pauseCollect('manual', true)
    const saved = current.workflows.save({
      name: '早间提炼',
      steps: [
        { tool: 'read_webpage', args: { url: PAGE }, label: '读页面' },
        { tool: 'extract_knowledge', args: {}, label: '送入提炼' }
      ]
    })
    const result = await runTool('run_workflow', { id: saved.id }, contextOf(current, fetchOf(), ['run_workflow', 'read_webpage']))
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('采集已暂停')
    expect(readSources(current.root).filter(row => row.origin_ref === PAGE)).toHaveLength(0)
  }, 120_000)
})

/**
 * The four boundaries the review found: a cancel that lands inside one of the
 * hand-over's own awaits, a tool the user switched off, and a refusal the helper
 * itself makes. Each runs on the real executor, collector and helper.
 */
describe('a cancelled turn never writes through the hand-over', () => {
  it('stops before the source when the cancel lands while the pause state is read', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const current = await rig({ paused: () => gate.then(() => ({ manual: false, game: false })) })
    const saved = current.workflows.save({
      name: '早间提炼',
      steps: [
        { tool: 'read_webpage', args: { url: PAGE }, label: '读页面' },
        { tool: 'extract_knowledge', args: {}, label: '送入提炼' },
        { tool: 'get_datetime', args: {}, label: '记时间' }
      ]
    })
    const fetchImpl = fetchOf()
    const controller = new AbortController()
    const running = runTool(
      'run_workflow',
      { id: saved.id },
      contextOf(current, fetchImpl, ['run_workflow', 'read_webpage'], controller.signal)
    )
    // The page was read; the hand-over is now waiting on the pause state.
    await until(
      () => (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
      calls => calls > 0,
      'the page read'
    )
    controller.abort()
    release()
    const result = await running
    expect(result.ok).toBe(false)
    expect(result.status).toBe('cancelled')
    expect(readSources(current.root).filter(row => row.origin_ref === PAGE)).toHaveLength(0)
    expect((await current.host.queueStatus()).total).toBe(0)
    expect(current.evidence.wakes).toBe(0)
  }, 120_000)

  it('publishes nothing when the cancel lands while the switches are handed over', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let calls = 0
    const current = await rig({
      collectorHost: host =>
        new Proxy(host, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver)
            if (property !== 'configureCollect') {
              return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
            }
            const real = value as (channels: unknown) => Promise<unknown>
            // The rig's own first sync goes straight through; the sync this test
            // starts later is the one held open, the way a slow helper would be.
            return async (channels: unknown) => {
              calls += 1
              if (calls > 1) await gate
              return real.call(target, channels)
            }
          }
        })
    })
    const syncing = current.collector.sync()
    await until(() => calls, count => count > 1, 'the switch hand-over')
    const saved = current.workflows.save({
      name: '早间提炼',
      steps: [
        { tool: 'read_webpage', args: { url: PAGE }, label: '读页面' },
        { tool: 'extract_knowledge', args: {}, label: '送入提炼' },
        { tool: 'get_datetime', args: {}, label: '记时间' }
      ]
    })
    const fetchImpl = fetchOf()
    const controller = new AbortController()
    const running = runTool(
      'run_workflow',
      { id: saved.id },
      contextOf(current, fetchImpl, ['run_workflow', 'read_webpage'], controller.signal)
    )
    await until(
      () => (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
      count => count > 0,
      'the page read'
    )
    // Nothing reached the database while the switches were still being sent.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(readSources(current.root).filter(row => row.origin_ref === PAGE)).toHaveLength(0)
    expect((await current.host.queueStatus()).total).toBe(0)
    controller.abort()
    release()
    await syncing
    const result = await running
    expect(result.ok).toBe(false)
    expect(readSources(current.root).filter(row => row.origin_ref === PAGE)).toHaveLength(0)
    expect((await current.host.queueStatus()).total).toBe(0)
    expect(current.evidence.wakes).toBe(0)
    expect(JSON.stringify(result.data)).not.toContain('get_datetime')
  }, 120_000)

  it('stops the note branch at the same boundary', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let calls = 0
    const current = await rig({
      note: { id: 'note-1', text: BODY },
      collectorHost: host =>
        new Proxy(host, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver)
            if (property !== 'configureCollect') {
              return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
            }
            const real = value as (channels: unknown) => Promise<unknown>
            return async (channels: unknown) => {
              calls += 1
              if (calls > 1) await gate
              return real.call(target, channels)
            }
          }
        })
    })
    const syncing = current.collector.sync()
    await until(() => calls, count => count > 1, 'the switch hand-over')
    const saved = current.workflows.save({
      name: '早间提炼',
      steps: [{ tool: 'extract_knowledge', args: { noteId: 'note-1' }, label: '送入提炼' }]
    })
    const controller = new AbortController()
    const running = runTool('run_workflow', { id: saved.id }, contextOf(current, fetchOf(), ['run_workflow'], controller.signal))
    await new Promise(resolve => setTimeout(resolve, 50))
    controller.abort()
    release()
    await syncing
    const result = await running
    expect(result.ok).toBe(false)
    const rows = readSources(current.root)
    expect(rows).toHaveLength(0)
    expect((await current.host.queueStatus()).total).toBe(0)
    expect(current.evidence.wakes).toBe(0)
  }, 120_000)
})

describe('the workflow cannot widen what the user allowed', () => {
  it('keeps a tool the user switched off switched off', async () => {
    const current = await rig()
    current.settings.assistantAccess.disabledTools = ['extract_knowledge']
    const saved = current.workflows.save({
      name: '早间提炼',
      steps: [
        { tool: 'read_webpage', args: { url: PAGE }, label: '读页面' },
        { tool: 'extract_knowledge', args: {}, label: '送入提炼' },
        { tool: 'get_datetime', args: {}, label: '记时间' }
      ]
    })
    const result = await runTool('run_workflow', { id: saved.id }, contextOf(current, fetchOf(), ['run_workflow', 'read_webpage']))
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('此工具已在权限设置中关闭')
    expect(readSources(current.root).filter(row => row.origin_ref === PAGE)).toHaveLength(0)
    expect((await current.host.queueStatus()).total).toBe(0)
    expect(JSON.stringify(result.data)).not.toContain('get_datetime')
  }, 120_000)

  it('reports the refusal the helper itself made', async () => {
    const current = await rig()
    await current.host.exclude('reading', readingKey(PAGE), '测试排除')
    const saved = current.workflows.save({
      name: '早间提炼',
      steps: [
        { tool: 'read_webpage', args: { url: PAGE }, label: '读页面' },
        { tool: 'extract_knowledge', args: {}, label: '送入提炼' }
      ]
    })
    const result = await runTool('run_workflow', { id: saved.id }, contextOf(current, fetchOf(), ['run_workflow', 'read_webpage']))
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('知识库拒绝了这次读取')
    expect(result.summary.toLowerCase()).toContain('excluded')
    expect(readSources(current.root).filter(row => row.origin_ref === PAGE)).toHaveLength(0)
    expect((await current.host.queueStatus()).total).toBe(0)
  }, 120_000)
})

const FIRST_BODY = '第一次读到的正文：先写日志再写数据，回放时按日志顺序重放，半截状态不会被当成完整结果。'
const SECOND_BODY = '第二次读到的正文：改成先写数据再写日志，崩溃后按日志补齐，剩下的交给对账任务清理干净。'
const SECOND_HTML = `<html><head><title>去重笔记</title></head><body><p>${SECOND_BODY}</p></body></html>`

/** Holds the second switch hand-over open, the way a slow helper would. */
function heldSwitches(): {
  collectorHost: (host: KnowledgeHost) => KnowledgeHost
  calls: () => number
  release: () => void
} {
  let release = (): void => undefined
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let calls = 0
  return {
    calls: () => calls,
    release: () => release(),
    collectorHost: host =>
      new Proxy(host, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver)
          if (property !== 'configureCollect') {
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
          }
          const real = value as (channels: unknown) => Promise<unknown>
          // The rig's own first sync goes straight through; the sync a test starts
          // later is the one held open.
          return async (channels: unknown) => {
            calls += 1
            if (calls > 1) await gate
            return real.call(target, channels)
          }
        }
      })
  }
}

function readCalls(fetchImpl: typeof fetch): number {
  return (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length
}

describe('a hand-over that waited for the switches re-reads the rules before it writes', () => {
  it('keeps the body the summary published when the workflow is cancelled mid hand-over', async () => {
    const switches = heldSwitches()
    const current = await rig({ collectorHost: switches.collectorHost })
    summarize(current, FIRST_BODY)
    const rows = await until(
      () => readSources(current.root).filter(row => row.origin_ref === PAGE),
      list => list.length > 0,
      'the summary source'
    )
    expect(bodyOf(current)).toBe(FIRST_BODY)

    const syncing = current.collector.sync()
    await until(switches.calls, count => count > 1, 'the switch hand-over')
    const saved = current.workflows.save({
      name: '早间提炼',
      steps: [
        { tool: 'read_webpage', args: { url: PAGE }, label: '读页面' },
        { tool: 'extract_knowledge', args: {}, label: '送入提炼' },
        { tool: 'get_datetime', args: {}, label: '记时间' }
      ]
    })
    const fetchImpl = fetchOf(SECOND_HTML)
    const controller = new AbortController()
    const running = runTool(
      'run_workflow',
      { id: saved.id },
      contextOf(current, fetchImpl, ['run_workflow', 'read_webpage'], controller.signal)
    )
    await until(() => readCalls(fetchImpl), count => count > 0, 'the page read')
    await new Promise(resolve => setTimeout(resolve, 50))
    controller.abort()
    switches.release()
    await syncing
    const result = await running
    expect(result.ok).toBe(false)
    expect(result.status).toBe('cancelled')

    // The cancelled hand-over never replaced the text another legal task quotes.
    expect(bodyOf(current)).toBe(FIRST_BODY)
    const afterAbort = await current.host.queueStatus()
    expect(afterAbort.counts.needs_reread ?? 0, 'the summary task still has its body').toBe(0)

    // That task still extracts the body it published, and points at that source.
    const cards = await until(
      async () => {
        await current.engine.tick()
        return current.host.listCards({ offset: 0, limit: 20 })
      },
      list => list.total > 0,
      'the extracted card',
      100,
      100
    )
    expect(cards.total).toBe(1)
    expect(current.prompts.join('\n')).toContain(FIRST_BODY)
    expect(current.prompts.join('\n')).not.toContain(SECOND_BODY)
    expect((await current.host.getCard(cards.items[0].id)).sourceIds).toEqual([rows[0].id])
    expect(readSources(current.root).filter(row => row.origin_ref === PAGE)).toHaveLength(1)
  }, 120_000)

  it('stops when the tool is switched off while the switches are handed over', async () => {
    const switches = heldSwitches()
    const current = await rig({ collectorHost: switches.collectorHost })
    const syncing = current.collector.sync()
    await until(switches.calls, count => count > 1, 'the switch hand-over')
    const saved = current.workflows.save({
      name: '早间提炼',
      steps: [
        { tool: 'read_webpage', args: { url: PAGE }, label: '读页面' },
        { tool: 'extract_knowledge', args: {}, label: '送入提炼' },
        { tool: 'get_datetime', args: {}, label: '记时间' }
      ]
    })
    const fetchImpl = fetchOf()
    const running = runTool('run_workflow', { id: saved.id }, contextOf(current, fetchImpl, ['run_workflow', 'read_webpage']))
    await until(() => readCalls(fetchImpl), count => count > 0, 'the page read')
    await new Promise(resolve => setTimeout(resolve, 50))
    // The user switches the tool off while the wait is still open.
    current.settings.assistantAccess.disabledTools = ['extract_knowledge']
    switches.release()
    await syncing
    const result = await running
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('此工具已在权限设置中关闭')
    expect(readSources(current.root).filter(row => row.origin_ref === PAGE)).toHaveLength(0)
    expect((await current.host.queueStatus()).total).toBe(0)
    expect(current.evidence.wakes).toBe(0)
    expect(JSON.stringify(result.data)).not.toContain('get_datetime')
  }, 120_000)

  it('stops when collection is paused while the switches are handed over', async () => {
    const switches = heldSwitches()
    const current = await rig({ collectorHost: switches.collectorHost })
    const syncing = current.collector.sync()
    await until(switches.calls, count => count > 1, 'the switch hand-over')
    const saved = current.workflows.save({
      name: '早间提炼',
      steps: [
        { tool: 'read_webpage', args: { url: PAGE }, label: '读页面' },
        { tool: 'extract_knowledge', args: {}, label: '送入提炼' },
        { tool: 'get_datetime', args: {}, label: '记时间' }
      ]
    })
    const fetchImpl = fetchOf()
    const running = runTool('run_workflow', { id: saved.id }, contextOf(current, fetchImpl, ['run_workflow', 'read_webpage']))
    await until(() => readCalls(fetchImpl), count => count > 0, 'the page read')
    await new Promise(resolve => setTimeout(resolve, 50))
    await current.host.pauseCollect('manual', true)
    switches.release()
    await syncing
    const result = await running
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('采集已暂停')
    expect(readSources(current.root).filter(row => row.origin_ref === PAGE)).toHaveLength(0)
    expect((await current.host.queueStatus()).total).toBe(0)
    expect(current.evidence.wakes).toBe(0)
    expect(JSON.stringify(result.data)).not.toContain('get_datetime')
    await current.host.pauseCollect('manual', false)
  }, 120_000)

  it('applies the same boundary to the note branch', async () => {
    const switches = heldSwitches()
    const current = await rig({ note: { id: 'note-1', text: BODY }, collectorHost: switches.collectorHost })
    const syncing = current.collector.sync()
    await until(switches.calls, count => count > 1, 'the switch hand-over')
    const saved = current.workflows.save({
      name: '早间提炼',
      steps: [{ tool: 'extract_knowledge', args: { noteId: 'note-1' }, label: '送入提炼' }]
    })
    const running = runTool('run_workflow', { id: saved.id }, contextOf(current, fetchOf(), ['run_workflow']))
    await new Promise(resolve => setTimeout(resolve, 50))
    current.settings.assistantAccess.disabledTools = ['extract_knowledge']
    switches.release()
    await syncing
    const result = await running
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('此工具已在权限设置中关闭')
    expect(readSources(current.root)).toHaveLength(0)
    expect((await current.host.queueStatus()).total).toBe(0)
  }, 120_000)

  it('keeps the source it already committed when the cancel lands after the write', async () => {
    let release = (): void => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const current = await rig({ beforeExtract: () => gate })
    const saved = current.workflows.save({
      name: '早间提炼',
      steps: [
        { tool: 'read_webpage', args: { url: PAGE }, label: '读页面' },
        { tool: 'extract_knowledge', args: {}, label: '送入提炼' }
      ]
    })
    const controller = new AbortController()
    const running = runTool(
      'run_workflow',
      { id: saved.id },
      contextOf(current, fetchOf(SECOND_HTML), ['run_workflow', 'read_webpage'], controller.signal)
    )
    const rows = await until(
      () => readSources(current.root).filter(row => row.origin_ref === PAGE),
      list => list.length > 0,
      'the committed source'
    )
    expect(rows[0].state).toBe('active')
    controller.abort()
    release()
    const result = await running
    expect(result.ok).toBe(false)
    expect(result.status).toBe('cancelled')
    // What was written stays written, together with the body it was written from;
    // nothing further is queued for this turn and the engine is not woken.
    expect(bodyOf(current)).toBe(SECOND_BODY)
    expect(readSources(current.root).filter(row => row.origin_ref === PAGE)).toHaveLength(1)
    const queue = await current.host.queueStatus()
    expect(queue.total, 'only the task the publish itself created').toBe(1)
    expect(current.evidence.wakes).toBe(0)
  }, 120_000)
})
