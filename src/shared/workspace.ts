/** A link to a real local record; no filesystem path or executable URL. */
export interface LocalRecord {
  kind: 'note' | 'history' | 'reminder' | 'event' | 'chat' | 'knowledge'
  id: string
  title: string
  text: string
  at: number
  threadId?: string
}
export interface WorkspaceSearchPage { items: LocalRecord[]; hasMore: boolean }
export const LOCAL_QUERY_TOOLS = ['search_notes', 'search_history', 'list_reminders', 'list_events'] as const

/** Tool name → the record kind its result rows carry. */
const RECORD_KINDS: Record<string, LocalRecord['kind']> = {
  search_notes: 'note',
  search_history: 'history',
  list_reminders: 'reminder',
  list_events: 'event',
  search_knowledge: 'knowledge',
  get_knowledge: 'knowledge'
}

/** Cards handed to one extraction pass; the helper applies the same cap. */
export const MAX_CITED_CARDS = 12

export function recordsFromTool(name: string, data: Record<string, unknown>): LocalRecord[] {
  const kind = RECORD_KINDS[name]
  if (!kind) return []
  // A search answers with rows, a single-card read answers with the card itself.
  const rows = Array.isArray(data.items) ? data.items : [data.card ?? data.item]
  return rows.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && typeof row.id === 'string'))
    .slice(0, 20).map(row => ({ kind, id: String(row.id), title: String(row.title || row.text || row.summary || '').slice(0, 100),
      text: String(row.text ?? row.description ?? row.notes ?? row.summary ?? row.body ?? '').slice(0, 2000),
      at: Number(row.start ?? row.createdAt ?? row.dueAt ?? row.updatedAt) || 0 }))
}

/** One card the tools of a turn returned; chat and Ask both describe them this way. */
export interface KnowledgeCardRef { id: string; title: string }

/** The two reads that can back a citation; nothing else may produce one. */
export const KNOWLEDGE_READ_TOOLS: readonly string[] = ['search_knowledge', 'get_knowledge']

/**
 * The answer's own citation marker: `[[card:ID]]`, written after the sentence
 * that used the card. A title that happens to appear, a card that was only read,
 * or a search hit is not a citation — only this declaration is, and only for an
 * id the tools of the same turn really returned.
 */
const CARD_CITE = /\[\[card:([^\]\s]{1,128})\]\]/g

/** The cards an answer declared, and the answer without the markers. */
export function parseCardCitations(answer: string, received: Iterable<string>): { answer: string; cited: string[] } {
  const known = new Set(received)
  const cited: string[] = []
  const text = (answer ?? '').replace(CARD_CITE, (_mark: string, id: string) => {
    if (!known.has(id) || cited.includes(id) || cited.length >= MAX_CITED_CARDS) return ''
    cited.push(id)
    return ''
  })
  return { answer: text, cited }
}

/**
 * The user asked their own library by name. A read that fails there is a real
 * failure to report; the same read failing in passing must not sink the answer.
 */
export function asksOwnKnowledge(question: string): boolean {
  return /知识库|知识卡片|我的卡片|卡片里|我记|记过|之前记|笔记里|资料库里/.test(question ?? '')
}
