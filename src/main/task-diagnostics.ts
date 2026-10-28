import { AsyncLocalStorage } from 'node:async_hooks'
import type { TaskContext, TaskState, ToolState } from '@shared/task'
import { classifyError, type ClassifiedError } from './errors'

type Stage = 'capture' | 'asr' | 'routing' | 'llm' | 'tool' | 'total' | 'hotwords' | 'entity-candidates'
type Sample = { stage: Stage; ms: number; state?: TaskState | ToolState; reason?: ClassifiedError['kind'] }
const scope = new AsyncLocalStorage<{ task: TaskContext; log: (line: string) => void }>()
const samples: Sample[] = []
const finished = new WeakSet<TaskContext>()
const LIMIT = 512

/** Diagnostic scope only. Never use ambient state for permissions or resource access. */
export function withTaskTrace<T>(task: TaskContext | undefined, log: (line: string) => void, run: () => T): T {
  return task ? scope.run({ task, log }, run) : run()
}

export function recordTaskStage(task: TaskContext | undefined, stage: Stage, ms: number,
  log: (line: string) => void, state?: Sample['state'], reason?: Sample['reason']): void {
  if (!task || !Number.isFinite(ms)) return
  ms = Math.max(0, ms)
  samples.push({ stage, ms, ...(state ? { state } : {}), ...(reason ? { reason } : {}) })
  if (samples.length > LIMIT) samples.splice(0, samples.length - LIMIT)
  log(`[task ${task.id}] stage=${stage} ms=${Math.round(ms)}${state ? ` state=${state}` : ''}${reason ? ` reason=${reason}` : ''}`)
}

export async function traceTaskStage<T>(stage: Stage, run: () => Promise<T>): Promise<T> {
  const current = scope.getStore(), started = performance.now()
  let failure: ClassifiedError['kind'] | undefined
  try { return await run() } catch (error) { failure = classifyError(error).kind; throw error }
  finally { if (current) recordTaskStage(current.task, stage, performance.now() - started, current.log, failure ? current.task.state === 'cancelled' ? 'cancelled' : 'failed' : undefined, failure) }
}

export function finishTaskTrace(task: TaskContext, log: (line: string) => void): void {
  if (finished.has(task)) return
  finished.add(task)
  recordTaskStage(task, 'total', Date.now() - task.triggeredAt, log, task.state)
}

/** Finite in-memory samples; no task input, IDs, URLs, resource bytes or secrets. */
export function taskDiagnosticSummary(): object {
  const stages = Object.fromEntries((['capture', 'hotwords', 'asr', 'routing', 'entity-candidates', 'llm', 'tool', 'total'] as Stage[]).map(stage => {
    const values = samples.filter(row => row.stage === stage).map(row => row.ms).sort((a, b) => a - b)
    const percentile = (p: number): number | null => values.length ? Math.round(values[Math.ceil(values.length * p) - 1] * 100) / 100 : null
    return [stage, { count: values.length, averageMs: values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 100) / 100 : null, p50: percentile(.5), p95: percentile(.95) }]
  }))
  const counts = (stage: Stage): Record<string, number> => {
    const result: Record<string, number> = {}
    for (const row of samples) if (row.stage === stage && row.state) result[row.state] = (result[row.state] ?? 0) + 1
    return result
  }
  const tools = counts('tool'), attempts = Object.values(tools).reduce((a, b) => a + b, 0)
  const failures: Record<string, number> = {}
  for (const row of samples) if (row.state && ['failed', 'cancelled', 'timeout', 'unsupported'].includes(row.state)) {
    const key = `${row.stage}:${row.state}${row.reason ? `:${row.reason}` : ''}`
    failures[key] = (failures[key] ?? 0) + 1
  }
  return { sampleLimit: LIMIT, samples: samples.length, stages, tools,
    toolCompletionRate: attempts ? (tools.completed ?? 0) / attempts : null,
    tasks: counts('total'), failures, routingAccuracy: 'Requires labelled regression cases; not inferred from production conversations.' }
}
