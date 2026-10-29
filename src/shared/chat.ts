import type { SearchResult } from './types'
export const CHAT_ATTACHMENT_LIMIT = 5
export const CHAT_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const CHAT_ATTACHMENT_TOTAL = 25 * 1024 * 1024
export const CHAT_FILE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.avif,.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.xml,.yaml,.yml,.log,.ini,.toml,.html,.htm,.js,.jsx,.ts,.tsx,.py,.java,.c,.cpp,.h,.cs,.rs,.go,.sql,.css,.srt,.vtt,.pdf,.docx,.xlsx,.pptx,.odt,.ods,.odp'
export interface ChatUpload { name: string; bytes: Uint8Array }
export interface ChatAttachment { id: string; name: string; size: number; kind: 'image' | 'document'; thumbnail?: string; truncated: boolean }
export interface ChatGroup { id: string; name: string }
export interface ChatThread { id: string; title: string; groupId: string | null; updatedAt: number; manualTitle: boolean; memoryTemporary?: boolean }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; state: 'working' | 'done' | 'error' | 'cancelled'; sources: SearchResult[]; createdAt: number; attachments?: ChatAttachment[] }
export interface ChatDetail extends ChatThread { messages: ChatMessage[]; total: number }
export interface ChatIndex { threads: ChatThread[]; groups: ChatGroup[]; busyThreadId: string | null }
export type ChatEdit = { action: 'rename'; id: string; name: string } | { action: 'move'; id: string; groupId: string | null } | { action: 'delete'; id: string } | { action: 'group-create'; name: string } | { action: 'group-rename'; id: string; name: string } | { action: 'group-delete'; id: string }
export type ChatEvent = { type: 'changed' } | { type: 'progress'; threadId: string; messageId: string; text: string; status: string }
