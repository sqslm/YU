/**
 * Utility-process entry for UI Automation reads.
 *
 * It runs out of process on purpose: `IUIAutomation` calls cross into other
 * apps' providers, and a provider that faults would otherwise take the whole
 * UI down. Here a fault only kills this child, and the host degrades to "no
 * context" until the next read.
 */
import { readFocusedSnapshot } from './reader'
import { foregroundWindow } from '../foreground'
import { matchesTaskTarget } from '../task-context'
import type { TaskTarget } from '@shared/task'

/** Validate before touching UIA and again after a slow provider returns. */
export function readTargetSnapshot(target?: TaskTarget, read = readFocusedSnapshot, foreground = foregroundWindow): ReturnType<typeof readFocusedSnapshot> {
  if (target && !matchesTaskTarget(target, foreground())) return null
  const snapshot = read()
  return target && !matchesTaskTarget(target, foreground()) ? null : snapshot
}

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

const parent = (process as unknown as { parentPort?: ParentPort }).parentPort

if (parent) {
  parent.on('message', (event) => {
    const message = event?.data as { type?: string; id?: number; target?: TaskTarget } | undefined
    if (!message || message.type !== 'read') return
    let snapshot = null
    try {
      snapshot = readTargetSnapshot(message.target)
    } catch {
      snapshot = null
    }
    parent.postMessage({ type: 'result', id: message.id, snapshot })
  })
  parent.postMessage({ type: 'ready' })
}
