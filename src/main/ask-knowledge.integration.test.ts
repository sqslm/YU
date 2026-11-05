/**
 * Stage 6 A, end to end over the real production path.
 *
 * Everything in this file is the shipped code: the real `ChatService`, the real
 * `askAgent`, the real tool registry, and the real compiled helper
 * `native/bin/yu-knowledge.exe` on its real pipes with an isolated data root.
 * The one substitution is the model network — a `node:http` server on loopback
 * that speaks the OpenAI-compatible `/v1/chat/completions` shape, which is the
 * same seam the production code already uses outside Electron
 * (`src/main/net/egress.ts` degrades to `globalThis.fetch`).
 *
 * The point is proving that a knowledge card citation is real all the way
 * through: the tool table the model is offered, the search the helper answers,
 * the citation rule in `parseCardCitations`, the id stored on the chat message,
 * the projection the collector publishes, and the `sources.cited_card_ids`
 * column in the helper's own SQLite file.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { Settings } from '@shared/types'

import { AssistantSession } from './assistant'
import { ChatService } from './chat'
import { KnowledgeCollector, type ChatTurnDone } from './knowledge/collector'
import { ExtractEngine } from './knowledge/engine'
import { KnowledgeHost } from './knowledge/host'
import { createSourceRecovery } from './knowledge/recover'
import type { KnowledgeTools } from './tools/knowledge'
import { runTool } from './tools/registry'

/** The compiled helper. Already built in this working tree; never rebuilt here. */
const ENTRY = join(process.cwd(), 'native', 'bin', 'yu-knowledge.exe')

/**
 * The settling window is real in production; a test that has already written the
 * whole answer shortens it instead of sleeping through it.
 */
beforeAll(() => { process.env.YU_KNOWLEDGE_STABLE_MS = '0' })

/** Synthetic card: no user data, and its title is what the citation rule matches. */
const CARD_TITLE = '检索粒度基线'
const CARD_BODY = '知识图谱检索先命中标题，再落到正文；两三个字也能命中。'
const QUESTION = '我之前记过的检索粒度基线是什么'
/** Names the library *and* asks to search it — the explicit case, in Chinese. */
const EXPLICIT = '请搜索我的知识库中关于检索粒度基线的卡片。'
/** The chat allowlist the production code builds: two reads, never the write. */
const CHAT_KNOWLEDGE_TOOLS = ['search_knowledge', 'get_knowledge']

// ---------------------------------------------------------------------------
// Fake model: a loopback OpenAI-compatible endpoint
// ---------------------------------------------------------------------------

interface Exchange {
  path: string
  body: Record<string, any>
}

interface Reply {
  status?: number
  type?: string
  body: string
}

type Handler = (body: Record<string, any>, index: number) => Reply

const servers: Server[] = []

function json(payload: unknown): Reply {
  return { body: JSON.stringify(payload) }
}

/** A plain answer: the shape the production parser reads from `choices[0].message`. */
function answer(content: string): Reply {
  return json({ choices: [{ message: { content }, finish_reason: 'stop' }] })
}

/** One native tool call, exactly as an OpenAI-compatible gateway returns it. */
function callTool(name: string, args: Record<string, unknown>): Reply {
  return json({
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }]
      },
      finish_reason: 'tool_calls'
    }]
  })
}

async function fakeModel(handler: Handler): Promise<{ baseUrl: string; requests: Exchange[] }> {
  const requests: Exchange[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      let body: Record<string, any> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>
      } catch {
        body = {}
      }
      requests.push({ path: String(request.url ?? ''), body })
      const reply = handler(body, requests.length - 1)
      response.writeHead(reply.status ?? 200, { 'content-type': reply.type ?? 'application/json' })
      response.end(reply.body)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests }
}

interface WireMessage {
  role?: string
  content?: string | null
}

function messagesOf(body: Record<string, any>): WireMessage[] {
  return Array.isArray(body.messages) ? (body.messages as WireMessage[]) : []
}

/** The answering round sees the tool output as a `role: 'tool'` message. */
function hasToolResult(body: Record<string, any>): boolean {
  return messagesOf(body).some((message) => message.role === 'tool')
}

/** The tool payload the model was shown, parsed back out of the wire message. */
function toolPayload(body: Record<string, any>): Record<string, any> {
  const message = messagesOf(body).find((item) => item.role === 'tool')
  expect(message).toBeDefined()
  return JSON.parse(String(message?.content)) as Record<string, any>
}

/** The tool table the model was offered, as names. Empty when tools were off. */
function toolNames(body: Record<string, any>): string[] {
  const tools = Array.isArray(body.tools) ? (body.tools as Array<{ function?: { name?: unknown } }>) : []
  return tools.map((tool) => String(tool?.function?.name))
}

// ---------------------------------------------------------------------------
// Real helper, real tools, isolated roots
// ---------------------------------------------------------------------------

const roots: string[] = []
const hosts: KnowledgeHost[] = []
const services: ChatService[] = []

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'yu-ask-knowledge-'))
  roots.push(root)
  return root
}

function trackHost(root: string, entry = ENTRY): KnowledgeHost {
  const host = new KnowledgeHost({ entry, root, requestMs: 20_000, idleMs: 60_000 })
  hosts.push(host)
  return host
}

function trackService(service: ChatService): ChatService {
  services.push(service)
  return service
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const service of services.splice(0)) {
    try {
      service.close()
    } catch {
      // A service already closed by its own test needs no second close.
    }
  }
  // A live helper holds its database open, so it stops before the root goes.
  for (const host of hosts.splice(0)) await host.stop().catch(() => undefined)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

afterAll(() => {
  delete process.env.YU_KNOWLEDGE_STABLE_MS
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * The production `knowledgeTools` object from `src/main/index.ts`, minus the
 * note/reading writes this test never exercises: the search and the read are the
 * same two calls the shipped object makes.
 */
function knowledgeToolsFor(host: KnowledgeHost, enabled: () => boolean) {
  const searched: string[] = []
  const extracts: string[] = []
  const tools: KnowledgeTools = {
    enabled,
    async search(query, limit) {
      searched.push(query)
      const page = await host.searchCards({ query, offset: 0, limit })
      return {
        total: page.total,
        items: page.items.map((card) => ({ id: card.id, title: card.title, summary: card.summary, kind: card.kind, topics: card.topics, updatedAt: card.updatedAt }))
      }
    },
    get: (id) => host.getCard(id),
    async extractFromNote(noteId) {
      // The write path belongs to the notes page; a chat/Ask turn must never land here.
      extracts.push(noteId)
      throw new Error('this turn was never allowed to queue a note for extraction')
    }
  }
  return { tools, searched, extracts }
}

/** A localhost LLM profile so the real request goes to the fake server. */
function settingsFor(baseUrl: string, knowledge: boolean): Settings {
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.profiles = [{
    ...settings.polish,
    id: 'fake-llm',
    name: 'Fake local model',
    kind: 'llm',
    enabled: true,
    preset: '',
    baseUrl,
    apiKey: 'local-test-key',
    model: 'fake-model'
  }]
  settings.chains = { asr: [], llm: ['fake-llm'], multimodal: [] }
  settings.knowledge = { ...settings.knowledge, enabled: knowledge, chat: true, reading: true, notes: true }
  // The router path: one tool round, then the answer round. No extra model call.
  settings.search = { ...settings.search, enabled: true, decideWithModel: true }
  return settings
}

/** Publishing is fire-and-forget, so the row is awaited instead of slept on. */
async function until<T>(read: () => T, done: (value: T) => boolean, label: string, attempts = 240, delay = 25): Promise<T> {
  let last: T | undefined
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      last = read()
      if (done(last)) return last
    } catch {
      // The database file is not there yet, or the helper still holds it.
    }
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`)
}

interface SourceRow {
  kind: string
  origin_ref: string
  version: string
  cited_card_ids: string
}

function readCardCount(root: string): number {
  const file = join(root, 'data', 'knowledge', 'knowledge.db')
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const row = db.prepare('SELECT count(*) AS count FROM cards').get() as unknown as { count: number }
    return row.count
  } finally {
    db.close()
  }
}

function readSources(root: string): SourceRow[] {
  const file = join(root, 'data', 'knowledge', 'knowledge.db')
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare('SELECT kind, origin_ref, version, cited_card_ids FROM sources ORDER BY rowid').all() as unknown as SourceRow[]
  } finally {
    db.close()
  }
}

describe('knowledge citations over the real chat, Ask, tool registry and helper', () => {
  it('offers the two reads, runs the real search and cites the card the helper returned', async () => {
    const root = newRoot()
    const host = trackHost(root)
    const card = await host.saveCard({ kind: 'concept', title: CARD_TITLE, body: CARD_BODY, topics: ['检索'] })
    const fake = await fakeModel((body) =>
      hasToolResult(body)
        ? answer(`根据卡片《${CARD_TITLE}》，检索先命中标题，再落到正文。[[card:${card.id}]]`)
        : callTool('search_knowledge', { query: CARD_TITLE, limit: 3 })
    )
    const settings = settingsFor(fake.baseUrl, true)
    const { tools } = knowledgeToolsFor(host, () => true)
    const completed: ChatTurnDone[] = []
    const service = trackService(new ChatService(
      join(root, 'chats.db'),
      () => settings,
      () => {},
      () => ({ knowledge: tools }),
      (turn) => completed.push(turn)
    ))
    const thread = service.create(null)
    // A thread whose first answer is already done: the title request would
    // otherwise be a third model call that has nothing to do with knowledge.
    const seed = service.store.begin(thread.id, '上一轮的问题')
    service.store.finish(seed.answerId, '上一轮的回答', 'done')

    await service.send(thread.id, QUESTION)

    expect(fake.requests).toHaveLength(2)
    expect(fake.requests[0].path).toBe('/v1/chat/completions')
    expect(fake.requests[0].body.model).toBe('fake-model')
    // The production instruction prompt built the request, not a test double.
    expect(String(messagesOf(fake.requests[0].body)[0]?.content)).toContain('工具纪律')
    const offered = toolNames(fake.requests[0].body)
    expect(offered).toContain('search_knowledge')
    expect(offered).toContain('get_knowledge')
    expect(offered).not.toContain('extract_knowledge')
    // The answering round gets the tool output and no tool table.
    expect(toolNames(fake.requests[1].body)).toEqual([])
    const payload = toolPayload(fake.requests[1].body)
    expect(payload.ok).toBe(true)
    expect(payload.total).toBe(1)
    expect((payload.items as Array<{ id: string }>).map((item) => item.id)).toEqual([card.id])

    expect(completed).toHaveLength(1)
    expect(completed[0].citedCardIds).toEqual([card.id])
    expect(completed[0].materials).toEqual([])

    const stored = service.get(thread.id).messages.at(-1)!
    expect(stored.state).toBe('done')
    expect(stored.text).toContain(CARD_TITLE)
    // The model's marker is program markup: the reader never sees it.
    expect(stored.text).not.toContain('[[card:')
    expect(stored.records).toEqual([expect.objectContaining({ kind: 'knowledge', id: card.id, title: CARD_TITLE })])
  }, 60_000)

  it('opens only ids the turn really received, and never asks the model again', async () => {
    const root = newRoot()
    const host = trackHost(root)
    const card = await host.saveCard({ kind: 'concept', title: CARD_TITLE, body: CARD_BODY, topics: ['检索'] })
    const fake = await fakeModel((body) =>
      hasToolResult(body)
        ? answer(`根据卡片《${CARD_TITLE}》，检索先命中标题，再落到正文。`)
        : callTool('search_knowledge', { query: CARD_TITLE })
    )
    const settings = settingsFor(fake.baseUrl, true)
    const { tools } = knowledgeToolsFor(host, () => true)
    const opened: string[] = []
    const session = new AssistantSession({
      settings: () => settings,
      changed: () => {},
      log: () => {},
      knowledge: tools,
      openCard: (id) => opened.push(id)
    })

    await session.send(QUESTION)

    expect(fake.requests).toHaveLength(2)
    expect(session.snapshot().turns.at(-1)).toMatchObject({ state: 'done' })
    const requestsAfterAnswer = fake.requests.length

    await expect(session.openItem(card.id)).resolves.toBe('knowledge')
    expect(opened).toEqual([card.id])
    // Showing a card is a place, not a question: no model round, no new request.
    expect(fake.requests).toHaveLength(requestsAfterAnswer)

    await expect(session.openItem('card_forged_9')).rejects.toThrow('请先查找并选择真实结果')
    expect(opened).toEqual([card.id])
    expect(fake.requests).toHaveLength(requestsAfterAnswer)

    // The registry is per-turn: clearing the session forgets every trusted id.
    session.clear()
    await expect(session.openItem(card.id)).rejects.toThrow('请先查找并选择真实结果')
    expect(opened).toEqual([card.id])
    expect(fake.requests).toHaveLength(requestsAfterAnswer)
  }, 60_000)

  it('offers and runs no knowledge tool at all while the switch is off', async () => {
    const root = newRoot()
    const host = trackHost(root)
    await host.saveCard({ kind: 'concept', title: CARD_TITLE, body: CARD_BODY, topics: ['检索'] })
    const fake = await fakeModel(() => answer('知识库现在没有打开。'))
    const settings = settingsFor(fake.baseUrl, false)
    const { tools, searched } = knowledgeToolsFor(host, () => false)
    const completed: ChatTurnDone[] = []
    const service = trackService(new ChatService(
      join(root, 'chats.db'),
      () => settings,
      () => {},
      () => ({ knowledge: tools }),
      (turn) => completed.push(turn)
    ))
    const thread = service.create(null)
    const seed = service.store.begin(thread.id, '上一轮的问题')
    service.store.finish(seed.answerId, '上一轮的回答', 'done')

    await service.send(thread.id, QUESTION)

    expect(fake.requests).toHaveLength(1)
    const offered = toolNames(fake.requests[0].body)
    for (const name of CHAT_KNOWLEDGE_TOOLS) expect(offered).not.toContain(name)
    expect(completed).toHaveLength(1)
    expect(completed[0].citedCardIds).toEqual([])
    const stored = service.get(thread.id).messages.at(-1)!
    expect(stored.state).toBe('done')
    expect(stored.records).toEqual([])

    // The registry refuses the read itself, so a model that ignores its tool
    // table still cannot reach the library.
    const outcome = await runTool('search_knowledge', { query: CARD_TITLE }, {
      settings,
      question: QUESTION,
      log: () => {},
      knowledge: tools,
      allowedTools: CHAT_KNOWLEDGE_TOOLS
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.status).toBe('unsupported')
    expect(outcome.summary).toBe('工具当前不可用：search_knowledge')
    expect(searched).toEqual([])
  }, 60_000)

  it('keeps the knowledge write out of the tool table and out of reach', async () => {
    const root = newRoot()
    const host = trackHost(root)
    await host.saveCard({ kind: 'concept', title: CARD_TITLE, body: CARD_BODY, topics: ['检索'] })
    const fake = await fakeModel(() => answer('这是一段普通回答。'))
    const settings = settingsFor(fake.baseUrl, true)
    const { tools, extracts } = knowledgeToolsFor(host, () => true)

    const completed: ChatTurnDone[] = []
    const service = trackService(new ChatService(
      join(root, 'chats.db'),
      () => settings,
      () => {},
      () => ({ knowledge: tools }),
      (turn) => completed.push(turn)
    ))
    const thread = service.create(null)
    const seed = service.store.begin(thread.id, '上一轮的问题')
    service.store.finish(seed.answerId, '上一轮的回答', 'done')
    await service.send(thread.id, QUESTION)

    const session = new AssistantSession({ settings: () => settings, changed: () => {}, log: () => {}, knowledge: tools })
    await session.send(QUESTION)

    expect(fake.requests.length).toBeGreaterThanOrEqual(2)
    for (const request of fake.requests) {
      expect(toolNames(request.body)).not.toContain('extract_knowledge')
    }
    expect(completed).toHaveLength(1)

    // No write grant: the tool is not even available in this context.
    const plain = await runTool('extract_knowledge', { noteId: 'note_1' }, {
      settings,
      question: QUESTION,
      log: () => {},
      knowledge: tools,
      allowedTools: CHAT_KNOWLEDGE_TOOLS
    })
    expect(plain.ok).toBe(false)
    expect(plain.status).toBe('unsupported')
    expect(plain.summary).toBe('工具当前不可用：extract_knowledge')

    // Even with a write grant, a normal answer's allowlist refuses the call.
    const granted = await runTool('extract_knowledge', { noteId: 'note_1' }, {
      settings,
      question: QUESTION,
      log: () => {},
      knowledge: tools,
      knowledgeWrite: true,
      allowedTools: CHAT_KNOWLEDGE_TOOLS
    })
    expect(granted.ok).toBe(false)
    expect(granted.summary).toBe('本次任务未授权此工具：extract_knowledge')
    expect(extracts).toEqual([])
  }, 60_000)

  it('publishes the cited ids into the helper database and stores none without a citation', async () => {
    const root = newRoot()
    const host = trackHost(root)
    const card = await host.saveCard({ kind: 'concept', title: CARD_TITLE, body: CARD_BODY, topics: ['检索'] })
    const settings = settingsFor('http://127.0.0.1:9/v1', true)
    const collector = new KnowledgeCollector({ settings: () => settings, host: () => host, log: () => {} })
    await collector.sync()

    const at = Date.now()
    // The plain-thread branch: one cited turn, one that names nothing.
    collector.threadFinished({ threadId: 'thread-1', threadTitle: '检索', userId: 'user-1', answerId: 'answer-1', question: '检索怎么工作', answer: '先命中标题。', at, citedCardIds: [card.id] })
    collector.threadFinished({ threadId: 'thread-1', userId: 'user-1', answerId: 'answer-2', question: '没有引用的一轮', answer: '普通回答。', at })
    // The reading branch a chat turn with materials would take.
    collector.readingFinished({
      threadId: 'ask:demo',
      scope: '浮动提问',
      request: '读一下这一页',
      materials: [{ origin: 'https://example.com/baseline', title: '检索基线', text: '这一页讲了检索粒度。', url: 'https://example.com/baseline' }],
      answer: '这一页讲了检索粒度。',
      sources: [{ title: '检索基线', url: 'https://example.com/baseline' }],
      citedCardIds: [card.id],
      at
    })

    const rows = await until(() => readSources(root), (all) => all.length >= 3, 'three published sources')
    const citedChat = rows.find((row) => row.origin_ref === 'thread-1:user-1:answer-1')
    expect(citedChat).toBeDefined()
    expect(JSON.parse(citedChat!.cited_card_ids)).toEqual([card.id])
    const plainChat = rows.find((row) => row.origin_ref === 'thread-1:user-1:answer-2')
    expect(plainChat).toBeDefined()
    expect(JSON.parse(plainChat!.cited_card_ids)).toEqual([])
    const reading = rows.find((row) => row.origin_ref === 'https://example.com/baseline')
    expect(reading).toBeDefined()
    expect(reading!.kind).toBe('web')
    expect(JSON.parse(reading!.cited_card_ids)).toEqual([card.id])
  }, 60_000)

  it('reports a failed explicit library search and hands nothing to the collector', async () => {
    const root = newRoot()
    const host = trackHost(root, join(root, 'missing', 'yu-knowledge.exe'))
    const fake = await fakeModel((body) =>
      hasToolResult(body) ? answer('这一次没有读到知识库。') : callTool('search_knowledge', { query: CARD_TITLE })
    )
    const settings = settingsFor(fake.baseUrl, true)
    const { tools } = knowledgeToolsFor(host, () => true)
    const completed: ChatTurnDone[] = []
    const service = trackService(new ChatService(
      join(root, 'chats.db'),
      () => settings,
      () => {},
      () => ({ knowledge: tools }),
      (turn) => completed.push(turn)
    ))
    const thread = service.create(null)
    const seed = service.store.begin(thread.id, '上一轮的问题')
    service.store.finish(seed.answerId, '上一轮的回答', 'done')

    await service.send(thread.id, EXPLICIT)

    expect(fake.requests).toHaveLength(2)
    const followUp = JSON.stringify(fake.requests[1].body.messages)
    expect(followUp).toContain('执行失败')
    expect(completed).toEqual([])
    const stored = service.get(thread.id).messages.at(-1)!
    // Observed production behaviour: the answer text still arrives, but the
    // failed read marks the turn `error`, so nothing is handed to the collector.
    expect(stored.text).toBe('这一次没有读到知识库。')
    expect(stored.state).toBe('error')
    expect(stored.records).toEqual([])
  }, 60_000)

  it('keeps an ordinary answer when the optional library read fails', async () => {
    const root = newRoot()
    // The helper cannot start, so the read the model chose on its own fails.
    const host = trackHost(root, join(root, 'missing', 'yu-knowledge.exe'))
    const fake = await fakeModel((body) =>
      hasToolResult(body)
        ? answer('建议在数据库里加唯一约束。')
        : callTool('search_knowledge', { query: '重复写入' })
    )
    const settings = settingsFor(fake.baseUrl, true)
    const { tools } = knowledgeToolsFor(host, () => true)
    const completed: ChatTurnDone[] = []
    const service = trackService(new ChatService(
      join(root, 'chats.db'),
      () => settings,
      () => {},
      () => ({ knowledge: tools }),
      (turn) => completed.push(turn)
    ))
    const thread = service.create(null)
    const seed = service.store.begin(thread.id, '上一轮的问题')
    service.store.finish(seed.answerId, '上一轮的回答', 'done')

    await service.send(thread.id, '如何避免重复写入？')

    expect(fake.requests).toHaveLength(2)
    const stored = service.get(thread.id).messages.at(-1)!
    // The answer that exists survives the failed optional read...
    expect(stored.text).toBe('建议在数据库里加唯一约束。')
    expect(stored.state).toBe('done')
    // ...and it carries no citation, because the card was never read.
    expect(stored.records).toEqual([])
    expect(completed).toHaveLength(1)
    expect(completed[0].citedCardIds).toEqual([])
  }, 60_000)

  it('judges a failed library read by the question, not by the tool name', async () => {
    // The same failing helper and the same generic answer, four questions: the
    // real chat decides from the question alone whether the read was required.
    async function run(question: string): Promise<{ state: string; text: string; cited: string[] }> {
      const root = newRoot()
      const host = trackHost(root, join(root, 'missing', 'yu-knowledge.exe'))
      const fake = await fakeModel((body) =>
        hasToolResult(body)
          ? answer('建议在数据库里加唯一约束。')
          : callTool('search_knowledge', { query: '去重' })
      )
      const settings = settingsFor(fake.baseUrl, true)
      const { tools } = knowledgeToolsFor(host, () => true)
      const completed: ChatTurnDone[] = []
      const service = trackService(new ChatService(
        join(root, 'chats.db'),
        () => settings,
        () => {},
        () => ({ knowledge: tools }),
        (turn) => completed.push(turn)
      ))
      const thread = service.create(null)
      const seed = service.store.begin(thread.id, '上一轮的问题')
      service.store.finish(seed.answerId, '上一轮的回答', 'done')
      await service.send(thread.id, question)
      const stored = service.get(thread.id).messages.at(-1)!
      return { state: stored.state, text: stored.text, cited: completed[0]?.citedCardIds ?? [] }
    }

    const ordinary = await run('普通数据库写入如何避免重复？')
    expect(ordinary.state).toBe('done')
    expect(ordinary.text).toBe('建议在数据库里加唯一约束。')
    expect(ordinary.cited).toEqual([])

    const topic = await run('知识库的备份策略怎么设计？')
    // Discussing a knowledge base is a topic, not a request to read this one.
    expect(topic.state).toBe('done')
    expect(topic.text).toBe('建议在数据库里加唯一约束。')
    expect(topic.cited).toEqual([])

    // An explicit request keeps the real failure: the turn is reported as failed
    // rather than as a successful "no hit", and nothing is collected.
    const explicit = await run(EXPLICIT)
    expect(explicit.state).toBe('error')
    expect(explicit.cited).toEqual([])

    const english = await run('Search my knowledge base for deduplication.')
    expect(english.state).toBe('error')
    expect(english.cited).toEqual([])
  }, 120_000)

  it('hands a restatement and a new conclusion to the helper as two real sources', async () => {
    const root = newRoot()
    const host = trackHost(root)
    const card = await host.saveCard({ kind: 'concept', title: CARD_TITLE, body: CARD_BODY, topics: ['检索'] })
    const SAME = `检索先命中标题，再落到正文。[[card:${card.id}]]`
    const NEW = `写入前先查重，能少一半重复。[[card:${card.id}]]`
    let round = 0
    const fake = await fakeModel((body) =>
      hasToolResult(body)
        ? answer(round++ < 2 ? SAME : NEW)
        : callTool('search_knowledge', { query: CARD_TITLE })
    )
    const settings = settingsFor(fake.baseUrl, true)
    const { tools } = knowledgeToolsFor(host, () => true)
    const collector = new KnowledgeCollector({ settings: () => settings, host: () => host, log: () => {} })
    await collector.sync()
    // The same wiring index.ts uses: one completed chat turn becomes one collection.
    const service = trackService(new ChatService(
      join(root, 'chats.db'),
      () => settings,
      () => {},
      () => ({ knowledge: tools }),
      (turn) => { void collector.threadFinished(turn) }
    ))
    const thread = service.create(null)
    const seed = service.store.begin(thread.id, '上一轮的问题')
    service.store.finish(seed.answerId, '上一轮的回答', 'done')

    await service.send(thread.id, '检索粒度是什么')
    const first = await until(() => readSources(root), (rows) => rows.length >= 1, 'the first cited source')
    // The answer's marker became the helper's own cited_card_ids column.
    expect(JSON.parse(first[0].cited_card_ids)).toEqual([card.id])
    expect(first[0].version).toMatch(/^[0-9a-f]{64}$/)

    // The same question answered the same way has the same content fingerprint:
    // this is the projection-level identity only. Whether extraction really
    // refuses a duplicate card is asserted by the suite below.
    await service.send(thread.id, '检索粒度是什么')
    // A different conclusion is its own material, and still names the same card.
    await service.send(thread.id, '怎么减少重复写入')
    const rows = await until(() => readSources(root), (all) => all.length >= 3, 'three collected turns')
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((row) => row.version)).size).toBe(2)
    expect(rows[0].version).toBe(rows[1].version)
    expect(rows[2].version).not.toBe(rows[1].version)
    for (const row of rows) {
      expect(row.kind).toBe('chat')
      // Every turn points back at the one real card instead of a copy per answer.
      expect(JSON.parse(row.cited_card_ids)).toEqual([card.id])
    }
    expect(readCardCount(root)).toBe(1)
  }, 90_000)

  it('never completes a turn that was cancelled while deltas were still arriving', async () => {
    const root = newRoot()
    const host = trackHost(root)
    const card = await host.saveCard({ kind: 'concept', title: CARD_TITLE, body: CARD_BODY, topics: ['检索'] })
    const fake = await fakeModel((body) =>
      hasToolResult(body)
        ? { type: 'text/event-stream', body: `data: ${JSON.stringify({ choices: [{ delta: { content: '部分回答' } }] })}\n\n` }
        : callTool('search_knowledge', { query: CARD_TITLE })
    )
    const settings = settingsFor(fake.baseUrl, true)
    const { tools } = knowledgeToolsFor(host, () => true)
    const completed: ChatTurnDone[] = []
    let service!: ChatService
    service = trackService(new ChatService(
      join(root, 'chats.db'),
      () => settings,
      (event) => {
        // The stop lands exactly where the user's stop button lands: on the
        // delta that flowed out of the answering round.
        if (event.type === 'progress' && event.text.length > 0) service.cancel()
      },
      () => ({ knowledge: tools }),
      (turn) => completed.push(turn)
    ))
    const thread = service.create(null)
    const seed = service.store.begin(thread.id, '上一轮的问题')
    service.store.finish(seed.answerId, '上一轮的回答', 'done')

    await service.send(thread.id, QUESTION)

    expect(fake.requests).toHaveLength(2)
    // The stop landed after the real search had already answered with the card.
    expect(toolPayload(fake.requests[1].body).total).toBe(1)
    expect(card.id).toBe(toolPayload(fake.requests[1].body).items[0].id)
    expect(completed).toEqual([])
    const stored = service.get(thread.id).messages.at(-1)!
    expect(stored.state).toBe('cancelled')
    expect(stored.records).toEqual([])
  }, 60_000)

  it('cites nothing when the real search returns no hit', async () => {
    const root = newRoot()
    const host = trackHost(root)
    await host.saveCard({ kind: 'concept', title: CARD_TITLE, body: CARD_BODY, topics: ['检索'] })
    const fake = await fakeModel((body) =>
      hasToolResult(body) ? answer('知识库里没有相关内容。') : callTool('search_knowledge', { query: 'zzzz-没有这张卡片' })
    )
    const settings = settingsFor(fake.baseUrl, true)
    const { tools, searched } = knowledgeToolsFor(host, () => true)
    const completed: ChatTurnDone[] = []
    const service = trackService(new ChatService(
      join(root, 'chats.db'),
      () => settings,
      () => {},
      () => ({ knowledge: tools }),
      (turn) => completed.push(turn)
    ))
    const thread = service.create(null)
    const seed = service.store.begin(thread.id, '上一轮的问题')
    service.store.finish(seed.answerId, '上一轮的回答', 'done')

    await service.send(thread.id, QUESTION)

    expect(fake.requests).toHaveLength(2)
    expect(searched).toEqual(['zzzz-没有这张卡片'])
    // The tool message is the helper's own answer: a real search, zero rows.
    const payload = toolPayload(fake.requests[1].body)
    expect(payload.query).toBe('zzzz-没有这张卡片')
    expect(payload.total).toBe(0)
    expect(payload.items).toEqual([])
    expect(completed).toHaveLength(1)
    expect(completed[0].citedCardIds).toEqual([])
    const stored = service.get(thread.id).messages.at(-1)!
    expect(stored.state).toBe('done')
    expect(stored.records).toEqual([])
  }, 60_000)
})

/** The same conclusion in other words: a restatement must not mint a card. */
const RESTATED = '换一套说法复述：知识图谱检索先命中标题，再落到正文，两三个字也能命中。'
/** A statement the library does not hold yet. */
const FRESH = '写入顺序固定为先认领版本、再删卡片，最后收尾关系，不留悬空链接。'

describe('extraction over the citation a real chat turn produced', () => {
  it('absorbs a restatement into the cited card and keeps a genuinely new conclusion', async () => {
    const root = newRoot()
    let citedCardId = ''
    const prompts: string[] = []
    let drafts = 0
    // The provider seam the host already exposes: the helper builds the prompt,
    // this stand-in only answers it. Which card is "the same" is decided by the
    // real Rust comparison, given the candidates the helper puts in front of it.
    const completer = async (call: { messages: { content: string }[] }): Promise<string> => {
      const text = call.messages.map((message) => message.content).join('\n')
      prompts.push(text)
      if (text.includes('知识库去重器')) {
        // The card this turn cited has to be a candidate, or a restatement has
        // nothing to attach to and would be minted twice.
        expect(text).toContain(citedCardId)
        const fresh = text.includes(FRESH)
        return JSON.stringify({
          decisions: [{
            index: 0,
            action: fresh ? 'new' : 'reference',
            ...(fresh ? {} : { targetCardId: citedCardId }),
            reason: fresh ? '这条结论库里还没有' : '同一结论的另一种说法'
          }]
        })
      }
      drafts += 1
      const named = /来源 (\S+)（第 0 段/.exec(text)
      expect(named, 'the prompt must name the source it read').not.toBeNull()
      return JSON.stringify({
        cards: [{
          kind: 'concept',
          title: CARD_TITLE,
          summary: '检索先命中标题',
          body: drafts === 1 ? RESTATED : FRESH,
          topics: ['检索'],
          aliases: [],
          sources: [{ sourceId: named![1], segment: 0 }],
          reason: '可复用'
        }],
        reason: 'ok'
      })
    }
    const host = new KnowledgeHost({ entry: ENTRY, root, requestMs: 20_000, idleMs: 60_000, completer: completer as never })
    hosts.push(host)
    const card = await host.saveCard({ kind: 'concept', title: CARD_TITLE, body: CARD_BODY, topics: ['检索'] })
    citedCardId = card.id

    let turn = 0
    const fake = await fakeModel((body) => {
      if (!hasToolResult(body)) return callTool('search_knowledge', { query: CARD_TITLE, limit: 3 })
      turn += 1
      return answer(turn === 1
        ? `检索先命中标题，再落到正文。[[card:${card.id}]]`
        : `另外，写入顺序要先认领版本再删卡片。[[card:${card.id}]]`)
    })
    const settings = settingsFor(fake.baseUrl, true)
    const { tools } = knowledgeToolsFor(host, () => true)

    let service!: ChatService
    const recovery = createSourceRecovery({
      notes: () => ({ list: () => ({ notes: [] }) }),
      chats: () => service.store
    })
    const collector = new KnowledgeCollector({
      settings: () => settings,
      host: () => host,
      readBody: (channel, originRef) => recovery(channel, originRef)
    })
    await collector.sync()
    // The production hook, not a hand-made projection: the collector receives
    // exactly the turn the real ChatService completed.
    service = trackService(new ChatService(
      join(root, 'chats.db'),
      () => settings,
      () => {},
      () => ({ knowledge: tools }),
      (done) => { collector.threadFinished(done) }
    ))
    const engine = new ExtractEngine({
      host: () => host,
      readBody: (channel, originRef) => collector.resolveBody(channel, originRef),
      settings: () => settings,
      allowed: () => true
    })

    const thread = service.create(null)
    const seed = service.store.begin(thread.id, '上一轮的问题')
    service.store.finish(seed.answerId, '上一轮的回答', 'done')

    await service.send(thread.id, QUESTION)
    // The projection really carries the cited id before extraction starts.
    const first = await until(() => readSources(root), (rows) => rows.length === 1, 'the first chat source')
    expect(JSON.parse(first[0].cited_card_ids)).toEqual([card.id])

    await engine.tick()

    // A restatement attaches to the card the answer cited: no second card.
    const afterFirst = await host.listCards()
    expect(afterFirst.total, 'a pure restatement mints no duplicate').toBe(1)
    const absorbed = await host.getCard(card.id)
    expect(absorbed.sourceIds).toHaveLength(1)
    expect(prompts.some((text) => text.includes('知识库去重器') && text.includes(card.id))).toBe(true)

    await service.send(thread.id, QUESTION)
    const both = await until(() => readSources(root), (rows) => rows.length === 2, 'the second chat source')
    expect(JSON.parse(both[1].cited_card_ids)).toEqual([card.id])

    await engine.tick()

    // A genuinely new conclusion is a new card, and the cited one stays as it was.
    const afterSecond = await host.listCards()
    expect(afterSecond.total, 'a new conclusion becomes a card').toBe(2)
    const minted = afterSecond.items.find((item) => item.id !== card.id)
    expect(minted, 'the second card is a different card').toBeDefined()
    expect(minted!.title).toBe(CARD_TITLE)
    const fresh = await host.getCard(minted!.id)
    expect(fresh.body).toBe(FRESH)
    // The cited card absorbed the first restatement and did not swallow the new one.
    const citedAfter = await host.getCard(card.id)
    expect(citedAfter.body).not.toBe(FRESH)
    expect(prompts.some((text) => text.includes('知识库去重器') && text.includes(FRESH))).toBe(true)
    const stillOne = service.get(thread.id).messages.at(-1)!
    expect(stillOne.state).toBe('done')
    expect(stillOne.text).not.toContain('[[card:')
  }, 120_000)
})
