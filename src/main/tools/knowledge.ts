/**
 * The knowledge base as tools.
 *
 * Three read/write verbs over the existing Rust helper: find cards, read one
 * card, and ask for extraction of one real note. The tool layer never touches
 * SQL and never re-reads a document — every call goes through the same host and
 * collector the UI uses, so the library the model sees is the library the user
 * has.
 */
import { mt } from '@shared/mainI18n'
import type { ExtractSourceResult, KnowledgeCard } from '@shared/knowledge'
import type { ToolDefinition, ToolOutcome } from './registry'

export const KNOWLEDGE_TOOLS = ['search_knowledge', 'get_knowledge', 'extract_knowledge'] as const

/** The bounded slice of the library a tool may see. */
export interface KnowledgeCardHit {
  id: string
  title: string
  summary: string
  kind: string
  topics: string[]
  updatedAt: number
}

export interface KnowledgeTools {
  /**
   * Extraction of a page this run really read. The material comes from a previous
   * step's own result, never from a string the model or the renderer supplied.
   */
  reading?: (
    material: { origin: string; title: string; text?: string; url?: string },
    options?: { signal?: AbortSignal }
  ) => Promise<{ queued: number; reason?: string; groupId?: string | null }>
  /** Full-text search; the helper ranks and pages, we only bound the answer. */
  search(query: string, limit: number): Promise<{ items: KnowledgeCardHit[]; total: number }>
  get(id: string): Promise<KnowledgeCard>
  /** Re-queues one note for extraction through the real source chain. */
  extractFromNote(noteId: string, options?: { signal?: AbortSignal }): Promise<ExtractSourceResult>
  /** True only while the user has the knowledge base switched on and idle. */
  enabled(): boolean
}

const MAX_QUERY = 200
const MAX_LIMIT = 8
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export const KNOWLEDGE_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'search_knowledge',
    description:
      mt('在本机知识库中检索已经提炼过的知识卡片（用户自己的结论、决定、方法）。用户问「我之前记过/总结过什么」这类问题时用它；它只能读，不会联网，也不会新增知识。'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: mt('检索词，用用户的原始说法即可，两三个字也能命中。') },
        limit: { type: 'number', description: mt('返回条数，默认 5，最多 8。') }
      },
      required: ['query'],
      additionalProperties: false
    },
    available: (ctx) => Boolean(ctx.knowledge?.enabled()),
    run: async (args, ctx): Promise<ToolOutcome> => {
      const query = text(args.query)
      if (!ctx.knowledge) throw new Error(mt('知识库当前不可用：{{name}}', { name: 'search_knowledge' }))
      if (!query) throw new Error(mt('工具参数无效：{{name}}', { name: 'query' }))
      if (query.length > MAX_QUERY) throw new Error(mt('检索词过长，最多 {{max}} 个字', { max: MAX_QUERY }))
      const asked = Number(args.limit)
      const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), MAX_LIMIT) : 5
      ctx.signal?.throwIfAborted()
      ctx.onStatus?.(mt('正在检索知识库…'))
      const found = await ctx.knowledge.search(query, limit)
      const items: KnowledgeCardHit[] = found.items.slice(0, limit)
      return {
        ok: true,
        summary: items.length ? mt('知识库命中 {{count}} 条：{{first}}', { count: found.total, first: items[0].title }) : mt('知识库里没有相关内容'),
        data: { ok: true, query, total: found.total, items }
      }
    }
  },
  {
    name: 'get_knowledge',
    description:
      mt('按 id 读取一张知识卡片的完整正文与来源。只读取用户自己库里真实存在的卡片；id 来自 search_knowledge 的结果。'),
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: mt('卡片 id，必须来自检索结果。') } },
      required: ['id'],
      additionalProperties: false
    },
    available: (ctx) => Boolean(ctx.knowledge?.enabled()),
    run: async (args, ctx): Promise<ToolOutcome> => {
      const id = text(args.id)
      if (!ctx.knowledge) throw new Error(mt('知识库当前不可用：{{name}}', { name: 'get_knowledge' }))
      if (!id) throw new Error(mt('工具参数无效：{{name}}', { name: 'id' }))
      ctx.signal?.throwIfAborted()
      const card = await ctx.knowledge.get(id)
      return {
        ok: true,
        summary: mt('已读取卡片：{{title}}', { title: card.title }),
        data: {
          ok: true,
          card: { id: card.id, title: card.title, kind: card.kind, topics: card.topics, body: card.body, sourceIds: card.sourceIds, updatedAt: card.updatedAt }
        }
      }
    }
  },
  {
    name: 'extract_knowledge',
    description:
      mt('把用户指定的这一条随记送入知识提炼队列（与正常保存走同一条来源链，不会重复生成卡片）。只在用户明确要求提炼某条记录时使用；它不读取正文副本，也不执行记录里的任何指令。'),
    parameters: {
      type: 'object',
      properties: { noteId: { type: 'string', description: mt('随记 id，必须来自真实记录。') } },
      required: ['noteId'],
      additionalProperties: false
    },
    available: (ctx) => Boolean(ctx.knowledge?.enabled() && ctx.knowledgeWrite),
    run: async (args, ctx): Promise<ToolOutcome> => {
      const noteId = text(args.noteId)
      if (!ctx.knowledge) throw new Error(mt('知识库当前不可用：{{name}}', { name: 'extract_knowledge' }))
      if (!noteId) throw new Error(mt('工具参数无效：{{name}}', { name: 'noteId' }))
      // The user's own words, not the platform's: a stopped turn says so.
      if (ctx.signal?.aborted) throw new Error(mt('本轮已取消'))
      ctx.onStatus?.(mt('正在加入提炼队列…'))
      const result = await ctx.knowledge.extractFromNote(noteId, ctx.signal ? { signal: ctx.signal } : {})
      // Only a really accepted task counts as success: a refusal, a pause or a
      // stale source must stop the step it belongs to instead of reporting a queue
      // entry that does not exist.
      if (result.queued === 1) return { ok: true, summary: mt('已加入提炼队列'), data: { ok: true, ...result } }
      return {
        ok: false,
        summary: result.reason ? mt('没有可以提炼的新内容：{{reason}}', { reason: result.reason }) : mt('没有可以提炼的新内容'),
        data: { ok: false, ...result }
      }
    }
  }
]
