import type { SearchResult } from './types'

export interface AssistantItem { id: string; name: string; path: string; kind: 'file' | 'application'; appId?: string; bytes?: number; modified?: string }
export interface AssistantLocalResult { tool: string; ok: boolean; summary: string; items?: AssistantItem[]; detail?: string }

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
