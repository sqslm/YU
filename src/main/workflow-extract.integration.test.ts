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

import { KnowledgeCollector, readingMaterial } from './knowledge/collector'
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
  kind: string
  origin_ref: string
  version: string
  state: string
}

function readSources(root: string): SourceRow[] {
  const db = new DatabaseSync(join(root, 'data', 'knowledge', 'knowledge.db'), { readOnly: true })
  try {
    return db.prepare('SELECT kind, origin_ref, version, state FROM sources ORDER BY rowid').all() as unknown as SourceRow[]
  } finally {
    db.close()
  }
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
}

/** The app's own wiring, one layer at a time: collector, engine, hand-off, tools. */
async function rig(options: { reading?: boolean } = {}): Promise<Rig> {
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
  const collector = new KnowledgeCollector({
    settings: () => settings,
    host: () => host,
    readBody: (channel, originRef) => recovery(channel, originRef)
  })
  await collector.sync()
  const engine = new ExtractEngine({
    host: () => host,
    readBody: (channel, originRef) => collector.resolveBody(channel, originRef),
    settings: () => settings,
    allowed: () => true
  })
  const handoff: HandoffDeps = {
    enabled: () => collector.enabled,
    channelOn: channel => settings.knowledge[channel] !== false,
    gameActive: () => false,
    paused: async () => (await host.queueStatus()).pausedReasons,
    publishReading: async material => {
      const published = await collector.publishReading(
        { ...material, locator: material.url ?? '' } as never,
        { threadId: 'workflow', at: Date.now(), scope: '工作流' }
      )
      return published?.sourceId ?? null
    },
    publishNote: async () => null,
    extract: sourceId =>
      extractSourceNow(sourceId, {
        host: () => host,
        enabled: () => collector.enabled,
        allowed: () => collector.enabled,
        resolveBody: (channel, originRef) => collector.resolveBody(channel, originRef),
        wake: () => engine.wake(),
        log: () => undefined
      })
  }
  const tools: KnowledgeTools = {
    enabled: () => collector.enabled,
    search: async (query, limit) => {
      const page = await host.searchCards({ query, offset: 0, limit })
      return { total: page.total, items: page.items }
    },
    get: id => host.getCard(id),
    reading: (material, options) => handoffReading(handoff, material, options),
    extractFromNote: noteId => handoffNote(handoff, noteId)
  }
  const workflows = new WorkflowStore(join(root, 'workflows.json'), () => Date.now())
  return { root, settings, host, collector, engine, workflows, tools, handoff, prompts }
}

/** A transport the URL check treats as a test double, so no DNS is involved. */
function fetchOf(body = HTML): typeof fetch {
  return vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })) as unknown as typeof fetch
}

function contextOf(current: Rig, fetchImpl: typeof fetch, allowedTools: string[]): ToolContext {
  return {
    settings: current.settings,
    question: '跑一下早间提炼',
    log: () => undefined,
    workflow: current.workflows,
    knowledge: current.tools,
    allowedTools,
    cache: new Map(),
    signal: new AbortController().signal,
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
    expect((await current.host.getCard(cards.items[0].id)).sourceIds).toEqual([mine[0].kind === 'web' ? expect.stringMatching(/^src_/) : ''])
    expect(current.prompts.join('\n')).toContain(BODY)
  }, 120_000)

  it('shares one source with the normal summary path instead of publishing twice', async () => {
    const current = await rig()
    const saved = current.workflows.save({
      name: '早间提炼',
      steps: [
        { tool: 'read_webpage', args: { url: PAGE }, label: '读页面' },
        { tool: 'extract_knowledge', args: {}, label: '送入提炼' }
      ]
    })
    const result = await runTool('run_workflow', { id: saved.id }, contextOf(current, fetchOf(), ['run_workflow', 'read_webpage']))
    expect(result.ok).toBe(true)
    await until(() => readSources(current.root), list => list.some(row => row.origin_ref === PAGE), 'the reading source')

    // The same page, read again by a plain question: same origin, same text, so the
    // collector and the helper answer with the source already there.
    const material = readingMaterial('read_webpage', { url: PAGE, title: '去重笔记', text: BODY })
    expect(material).not.toBeNull()
    const again = await current.collector.publishReading(
      { ...material!, locator: PAGE } as never,
      { threadId: 'thread-1', at: Date.now(), scope: '主界面问答' }
    )
    expect(again?.duplicate).toBe(true)

    const rows = readSources(current.root).filter(row => row.origin_ref === PAGE)
    expect(rows).toHaveLength(1)
    const after = await current.host.queueStatus()
    expect(after.total, 'a duplicate reading adds no task').toBe(1)

    // One extraction for both readers: the card is not copied either.
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
