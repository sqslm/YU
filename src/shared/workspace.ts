/** A link to a real local record; no filesystem path or executable URL. */
export interface LocalRecord {
  kind: 'note' | 'history' | 'reminder' | 'event' | 'chat'
  id: string
  title: string
  text: string
  at: number
  threadId?: string
}
export interface WorkspaceSearchPage { items: LocalRecord[]; hasMore: boolean }
export const LOCAL_QUERY_TOOLS = ['search_notes', 'search_history', 'list_reminders', 'list_events'] as const

export function recordsFromTool(name: string, data: Record<string, unknown>): LocalRecord[] {
  const kind = ({ search_notes: 'note', search_history: 'history', list_reminders: 'reminder', list_events: 'event' } as const)[name as typeof LOCAL_QUERY_TOOLS[number]]
  if (!kind || !Array.isArray(data.items)) return []
  return data.items.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && typeof row.id === 'string'))
    .slice(0, 20).map(row => ({ kind, id: String(row.id), title: String(row.title || row.text || '').slice(0, 100),
      text: String(row.text ?? row.description ?? row.notes ?? '').slice(0, 2000), at: Number(row.start ?? row.createdAt ?? row.dueAt) || 0 }))
}
