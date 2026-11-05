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
  search_knowledge: 'knowledge'
}

export function recordsFromTool(name: string, data: Record<string, unknown>): LocalRecord[] {
  const kind = RECORD_KINDS[name]
  if (!kind || !Array.isArray(data.items)) return []
  return data.items.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && typeof row.id === 'string'))
    .slice(0, 20).map(row => ({ kind, id: String(row.id), title: String(row.title || row.text || row.summary || '').slice(0, 100),
      text: String(row.text ?? row.description ?? row.notes ?? row.summary ?? '').slice(0, 2000),
      at: Number(row.start ?? row.createdAt ?? row.dueAt ?? row.updatedAt) || 0 }))
}
