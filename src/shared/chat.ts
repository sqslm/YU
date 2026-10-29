import type { SearchResult } from './types'
export interface ChatGroup { id: string; name: string }
export interface ChatThread { id: string; title: string; groupId: string | null; updatedAt: number; manualTitle: boolean; memoryTemporary?: boolean }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; state: 'working' | 'done' | 'error' | 'cancelled'; sources: SearchResult[]; createdAt: number }
export interface ChatDetail extends ChatThread { messages: ChatMessage[]; total: number }
export interface ChatIndex { threads: ChatThread[]; groups: ChatGroup[]; busyThreadId: string | null }
export type ChatEdit = { action: 'rename'; id: string; name: string } | { action: 'move'; id: string; groupId: string | null } | { action: 'delete'; id: string } | { action: 'group-create'; name: string } | { action: 'group-rename'; id: string; name: string } | { action: 'group-delete'; id: string }
export type ChatEvent = { type: 'changed' } | { type: 'progress'; threadId: string; messageId: string; text: string; status: string }
