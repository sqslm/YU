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

/**
 * Saving through the real tool path.
 *
 * The bug this locks down: a model that sent `steps` as a JSON string, or as a
 * list of bare tool names, got "工具参数无效：steps" and the user saw "工作流没保存
 * 成功". The schema now describes the step shape, and validation only insists
 * that `steps` is a list (or a string holding one) so the normalizer can either
 * accept the shape or say precisely which part is wrong.
 */
describe('save_workflow accepts what a model actually sends', () => {
  // `ctx.workflow` is read from the outer `beforeEach`; the nested one replaces
  // `store`, so the context has to be rebuilt against the new object.
  const saveCtx = (): ToolContext => ({ ...ctx, workflow: store, allowedTools: ['save_workflow'] })

  beforeEach(() => {
    // The store hands back the row it wrote; the tool echoes its name and steps.
    store = { ...store, save: vi.fn(() => workflowOf([step('get_datetime')])) }
  })

  it('saves steps that arrive as a JSON string', async () => {
    const steps = JSON.stringify([{ tool: 'get_datetime', args: {}, label: '看时间' }])
    const result = await runTool('save_workflow', { name: '晨间', steps }, saveCtx())
    expect(result.ok).toBe(true)
    const [saved] = vi.mocked(store.save).mock.calls[0] as unknown as [{ name: string; steps: WorkflowStep[] }]
    // The label the model gave survives; only a missing one falls back to the tool.
    expect(saved).toEqual({ name: '晨间', steps: [{ tool: 'get_datetime', args: {}, label: '看时间' }] })
  })

  it('saves steps that arrive as bare tool names', async () => {
    const result = await runTool('save_workflow', { name: '晨间', steps: ['list_events', 'daily_briefing'] }, saveCtx())
    expect(result.ok).toBe(true)
    const [saved] = vi.mocked(store.save).mock.calls[0] as unknown as [{ name: string; steps: WorkflowStep[] }]
    expect(saved).toEqual({ name: '晨间', steps: [step('list_events'), step('daily_briefing')] })
  })

  it('reports too many steps as too many steps, not as invalid arguments', async () => {
    const tooMany = Array.from({ length: 9 }, () => 'get_datetime')
    const result = await runTool('save_workflow', { name: '晨间', steps: tooMany }, saveCtx())
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('最多 8 步')
  })
})
