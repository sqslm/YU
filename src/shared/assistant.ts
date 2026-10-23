import type { SearchResult } from './types'

export interface AssistantTurn {
  id: number
  question: string
  answer: string
  sources: SearchResult[]
  state: 'working' | 'done' | 'cancelled' | 'error'
}

export interface AssistantState {
  turns: AssistantTurn[]
  busy: boolean
  status: string
}
