import type { SearchResult } from './types'

export interface AssistantItem { id: string; name: string; path: string; kind: 'file' | 'application'; appId?: string; bytes?: number; modified?: string }
export interface AssistantLocalResult { tool: string; ok: boolean; summary: string; items?: AssistantItem[]; detail?: string; fallback?: boolean }

export function unresolvedToolFailure(results: readonly AssistantLocalResult[] = []): AssistantLocalResult | undefined {
  return results.find((item, index) => !item.ok &&
    !(item.fallback && results.slice(index + 1).some(next => next.ok && ['search_files', 'search_file_contents'].includes(next.tool))))
}

export interface AssistantTurn {
  id: number
  question: string
  answer: string
  sources: SearchResult[]
  localResults?: AssistantLocalResult[]
  state: 'working' | 'done' | 'cancelled' | 'error'
}

export interface AssistantState {
  turns: AssistantTurn[]
  busy: boolean
  status: string
}
