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

/**
 * The cards an answer really used this turn.
 *
 * A search hit is a candidate, not a citation: it counts only when the answer
 * names it, or when the turn opened that very card by id. Both inputs come from
 * the tools' own results, so an id the model invented has no row to match and
 * can never be cited.
 */
export function citedKnowledgeIds(cards: KnowledgeCardRef[], answer: string, opened: Iterable<string> = []): string[] {
  const used = new Set(opened)
  const text = answer ?? ''
  const cited: string[] = []
  for (const card of cards) {
    if (!card.id || cited.includes(card.id)) continue
    const title = card.title.trim()
    if (!used.has(card.id) && (title.length < 2 || !text.includes(title))) continue
    cited.push(card.id)
    if (cited.length >= MAX_CITED_CARDS) break
  }
  return cited
}
