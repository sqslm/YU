import { randomUUID } from 'node:crypto'
import type { PromptContext } from '@shared/prompts'
import type { TaskContext, TaskSource, TaskTarget } from '@shared/task'

export function createTask(source: TaskSource, context: PromptContext = {}, input?: string, explicitMode?: TaskContext['explicitMode']): TaskContext {
  return {
    id: randomUUID(), source, triggeredAt: Date.now(), originalInput: input, explicitMode,
    target: Object.freeze(Object.fromEntries(Object.entries({ windowHandle: context.windowHandle, processId: context.processId,
      appName: context.appName, appPath: context.appPath, windowTitle: context.windowTitle,
      windowRect: context.windowRect ? Object.freeze({ ...context.windowRect }) : undefined }).filter(([, value]) => value !== undefined))),
    state: 'pending', receipts: []
  }
}

/** The original target wins even when a caller supplies subsequently focused metadata. */
export function attachTask(context: PromptContext, task: TaskContext): PromptContext {
  return Object.fromEntries(Object.entries({ ...context, ...task.target, task }).filter(([, value]) => value !== undefined)) as PromptContext
}

export function matchesTaskTarget(target: TaskTarget, current: { handle?: string; pid: number; title: string }): boolean {
  return Boolean(target.processId && current.pid === target.processId &&
    (!target.windowHandle || current.handle === target.windowHandle) && current.title === target.windowTitle)
}
