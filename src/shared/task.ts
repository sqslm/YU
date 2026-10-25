import type { Mode, PromptKind } from './types'
import type { PromptContext } from './prompts'

export type TaskState = 'pending' | 'running' | 'awaiting_confirmation' | 'completed' | 'failed' | 'cancelled'
export type ToolState = 'completed' | 'failed' | 'cancelled' | 'awaiting_confirmation' | 'unsupported' | 'timeout'
export type TaskSource = 'voice' | 'wake' | 'text' | 'selection' | 'retry'
export type TaskTarget = Readonly<Pick<PromptContext, 'windowHandle' | 'processId' | 'appName' | 'appPath' | 'windowTitle' | 'windowRect'>>

/** In-memory, per-request data. Never persist the input or authorized resources in diagnostics. */
export interface TaskContext {
  id: string
  source: TaskSource
  triggeredAt: number
  submittedAt?: number
  explicitMode?: Mode
  originalInput?: string
  transcript?: string
  target: TaskTarget
  prompt?: { id: string; name: string; kind: PromptKind; applied: boolean }
  route?: { kind: string; via: 'explicit' | 'rule' | 'model' }
  state: TaskState
  /** Only populated after an explicit selection request. */
  selection?: string
  receipts: Array<{ tool: string; state: ToolState; durationMs: number }>
}
