import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeSettings } from '@shared/defaults'
import { setMainLanguage } from '@shared/mainI18n'
import type { Workflow, WorkflowStep } from '@shared/workflow'
import { runTool, type ToolContext } from './registry'
import type { WorkflowTools } from './workflow'

/**
 * Replay authorization.
 *
 * The bug this locks down: `run_workflow` used to union every step's tool into the
 * round's allowlist, so a step could reach a tool the user's own turn had denied —
 * "不要联网" still ran the saved `web_search` step.
 */

/** Friday 2026-10-23 09:00 local. */
const NOW = new Date(2026, 9, 23, 9, 0, 0).getTime()
const NAME = '早上例行检查'

function step(tool: string, args: Record<string, unknown> = {}): WorkflowStep {
  return { tool, args, label: tool }
}

function workflowOf(steps: WorkflowStep[]): Workflow {
  return { id: 'wf-1', name: NAME, steps, runs: 0, createdAt: NOW, updatedAt: NOW }
}

let store: WorkflowTools
let ctx: ToolContext

function context(allowedTools: readonly string[]): ToolContext {
  return { ...ctx, allowedTools }
}

beforeEach(() => {
  store = {
    list: vi.fn(() => [workflowOf([step('get_datetime')])]),
    active: vi.fn(() => [workflowOf([step('get_datetime')])]),
    get: vi.fn(() => workflowOf([step('get_datetime')])),
    save: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
    recordRun: vi.fn()
  } as unknown as WorkflowTools
  ctx = {
    settings: mergeSettings({}),
    question: `跑一下${NAME}`,
    log: vi.fn(),
    workflow: store,
    allowedTools: ['run_workflow'],
    cache: new Map(),
    signal: new AbortController().signal,
    onLocalResult: vi.fn()
  }
})

afterEach(() => setMainLanguage('zh'))

describe('run_workflow authorizes each step against this round', () => {
  it('refuses a step the round never granted instead of widening the allowlist', async () => {
    const result = await runTool('run_workflow', { name: NAME }, context(['run_workflow']))
    expect(result.ok).toBe(false)
    // The receipt names the step and the reason, so the card can explain it.
    expect(result.summary).toContain('第 1 步未获本轮授权')
    expect(result.data).toMatchObject({
      stoppedAt: 'get_datetime',
      steps: [{ tool: 'get_datetime', ok: false, summary: '第 1 步未获本轮授权' }]
    })
    // A denied step still records the attempt: "I tried" is the fact the counter keeps.
    expect(store.recordRun).toHaveBeenCalledWith('wf-1')
  })

  it('runs the same step when the round did grant its tool', async () => {
    const result = await runTool('run_workflow', { name: NAME }, context(['run_workflow', 'get_datetime']))
    expect(result.ok).toBe(true)
    expect(result.data.steps).toMatchObject([{ tool: 'get_datetime', ok: true }])
    expect(store.recordRun).toHaveBeenCalledWith('wf-1')
  })

  it('does not re-add a tool an offline turn stripped from the allowlist', async () => {
    // The round said "不联网", so `web_search` is absent. A saved step must not resurrect it.
    store = { ...store, list: vi.fn(() => [workflowOf([step('get_datetime'), step('web_search', { query: 'x' })])]) }
    const result = await runTool('run_workflow', { name: NAME }, { ...context(['run_workflow', 'get_datetime']), workflow: store })
    expect(result.ok).toBe(false)
    expect(result.data).toMatchObject({
      steps: [{ tool: 'get_datetime', ok: true }, { tool: 'web_search', ok: false, summary: '第 2 步未获本轮授权' }]
    })
  })

  it('still rejects a step outside the workflow whitelist at run time', async () => {
    // A hand-edited store can hand back anything; the load filter is not the only gate.
    store = { ...store, list: vi.fn(() => [workflowOf([step('open_search', { query: 'x' })])]) }
    const result = await runTool('run_workflow', { name: NAME }, { ...context(['run_workflow', 'open_search']), workflow: store })
    expect(result.ok).toBe(false)
    expect(result.data.steps).toMatchObject([{ tool: 'open_search', ok: false, summary: '这一步的工具不在允许范围内：open_search' }])
  })
})
