import { join } from 'node:path'
import type { MemoryEntry, MemoryKind } from '@shared/memory'
import { validateMemoryReply } from '@shared/memory-reply'
import { readCatalog, readGraph } from './catalog'

const port = (process as unknown as { parentPort: { on(name: string, fn: (event: { data: any }) => void): void; postMessage(data: unknown): void } }).parentPort
let home = '', modelDir = '', userId = 'local-user', sequence = 0
const llmPending = new Map<number, { kind: 'facts' | 'memory'; resolve(value: { content: string }): void; reject(error: Error): void }>()
let extractor: any
let sdk: typeof import('mem0ai/oss')
const stores = new Map<MemoryKind, InstanceType<typeof import('mem0ai/oss').Memory>>()

async function embedQuery(text: string): Promise<number[]> {
  if (!extractor) {
    const { env, pipeline } = await import('@huggingface/transformers')
    env.allowRemoteModels = false
    env.allowLocalModels = true
    extractor = await pipeline('feature-extraction', modelDir, { device: 'cpu', dtype: 'q8', session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } })
  }
  return Array.from((await extractor(text, { pooling: 'cls', normalize: true, truncation: true, max_length: 512 })).data)
}
async function store(kind: MemoryKind): Promise<InstanceType<typeof import('mem0ai/oss').Memory>> {
  if (!stores.has(kind)) {
    sdk ??= await import('mem0ai/oss')
    const policy = kind === 'style'
        ? '仅记住用户明确要求的写作偏好：语气、语言、长度、格式。不要记人名、经历、事实、网页内容、任务正文。引用与假设不是用户偏好。不推断用户未表达的要求。新的明确偏好替代冲突旧偏好。'
        : '仅提取用户明确自述的稳定事实、个人偏好和项目背景。不要提取助手回复、提问本身、临时任务、引用、假设、小说、网页、文件或他人信息。不得猜测未知事实。明确否定和更正应更新或删除冲突旧事实。不要保存密码、密钥。'
    const memory = new sdk.Memory({ disableHistory: true, enableGraph: false,
      embedder: { provider: 'langchain', config: { model: { embedQuery, embedDocuments: (texts: string[]) => Promise.all(texts.map(embedQuery)) } } },
      vectorStore: { provider: 'memory', config: { dimension: 512, dbPath: join(home, `${kind}.db`) } },
      llm: { provider: 'langchain', config: { model: { invoke(messages: any[]) {
        const id = ++sequence
        const kind = messages.some(message => message.getType() === 'system') ? 'facts' : 'memory'
        return new Promise<{ content: string }>((resolve, reject) => {
          llmPending.set(id, { kind, resolve, reject })
          port.postMessage({ type: 'llm', id, kind, messages: messages.map(message => ({ role: message.getType() === 'human' ? 'user' : message.getType() === 'ai' ? 'assistant' : 'system', content: message.content })).concat([{ role: 'system', content: policy }]) })
        })
      } } } },

    })
    stores.set(kind, memory)
  }
  return stores.get(kind)!
}
function rows(result: any, kind: MemoryKind): MemoryEntry[] {
  return (result.results ?? []).map((row: any) => ({ id: row.id, text: row.memory, kind, sourceId: row.metadata?.sourceId ?? '', createdAt: row.createdAt, updatedAt: row.updatedAt, score: row.score }))
}
async function command(message: any): Promise<unknown> {
  if (message.method === 'init') {
    home = message.home; modelDir = message.modelDir
    process.env.MEM0_TELEMETRY = 'false'; process.env.MEM0_DIR = join(home, 'sdk')
    return true
  }
  const kind = message.kind as MemoryKind
  if (message.method === 'graph') return readGraph(home, message.kind, message.query)
  if (message.method === 'clear') {
    for (const k of ['assistant', 'style'] as const) {
      const memory = await store(k)
      await memory.deleteAll({ userId })
      await memory.reset()
      if ((await memory.getAll({ userId })).results.length) throw Error('Memory clear did not complete')
    }
    return true
  }
  if (kind !== 'assistant' && kind !== 'style') throw Error('Invalid memory kind')
  if (message.method === 'list') return readCatalog(home, kind).rows
  const memory = await store(kind)
  if (message.method === 'recall') return rows(await memory.search(message.text, { userId, limit: kind === 'assistant' ? 5 : 3 }), kind)
  if (message.method === 'add' || message.method === 'learn') {
    const inferred = message.method === 'learn' || message.sourceId !== 'manual'
    const result = await memory.add([{ role: 'user', content: message.text }], { userId, infer: inferred, metadata: { sourceId: message.sourceId } })
    if (message.method === 'add' && inferred && !result.results.some(row => ['ADD', 'UPDATE', 'DELETE'].includes(row.metadata?.event))) throw Error('未提炼出新的可保存事实，已有记忆未改动。')
    return true
  }
  const existing = await memory.get(message.memoryId)
  if (!existing) throw Error('记忆不存在，请刷新')
  if (message.method === 'update') return memory.update(message.memoryId, message.text)
  if (message.method === 'delete') return memory.delete(message.memoryId)
  throw Error('Unknown memory operation')
}
let serial = Promise.resolve()
port.on('message', ({ data }) => {
  if (data.type === 'llm-result') {
    const pending = llmPending.get(data.id); llmPending.delete(data.id)
    if (data.error) pending?.reject(Error(data.error))
    else {
      try { pending?.resolve({ content: validateMemoryReply(data.text, pending?.kind) }) }
      catch { pending?.reject(Error('记忆模型返回了无效的结构化结果')) }
    }
    return
  }
  serial = serial.then(async () => {
    try { port.postMessage({ type: 'result', id: data.id, value: await command(data) }) }
    catch (error) {
      const message = error instanceof Error ? error.message : ''
      const safe = message.includes('未提炼出') ? message : message.includes('无效的结构化结果') ? '记忆提炼未完成：当前 LLM 未返回有效 JSON，请检查连接或更换模型后重试'
        : /LLM|Memory model request failed/u.test(message) ? '记忆模型请求失败，请检查模型连接'
          : '记忆处理失败，请检查模型连接和本地存储'
      port.postMessage({ type: 'result', id: data.id, error: safe })
    }
  })
})
