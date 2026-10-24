import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setMainLanguage } from '@shared/mainI18n'
import {
  MAX_WORKFLOWS,
  MAX_WORKFLOW_LABEL,
  MAX_WORKFLOW_NAME,
  MAX_WORKFLOW_STEPS,
  WORKFLOW_STEP_TOOLS,
  activeWorkflows,
  describeWorkflow,
  normalizeWorkflowName,
  normalizeWorkflowSteps,
  type Workflow,
  type WorkflowStep
} from '@shared/workflow'
import { WorkflowStore } from './workflows'

/**
 * Saved workflows on disk: the one document, its damage handling, and the pure
 * helpers that decide what a stored step may even be.
 */

/** Friday 2026-10-23 09:00 local. */
const NOW = new Date(2026, 9, 23, 9, 0, 0).getTime()

function step(tool: string, args: Record<string, unknown> = {}, label?: string): WorkflowStep {
  return { tool, args, label: label ?? tool }
}

function steps(tools: string[]): WorkflowStep[] {
  return tools.map(tool => step(tool))
}

describe('workflow store', () => {
  let dir: string
  let file: string
  let clock: number

  const store = (): WorkflowStore => new WorkflowStore(file, () => clock)

  beforeEach(() => {
    setMainLanguage('zh')
    dir = mkdtempSync(join(tmpdir(), 'yu-workflows-'))
    file = join(dir, 'workflows.json')
    clock = NOW
  })
  afterEach(() => {
    setMainLanguage('zh')
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts empty without a file and still writes nothing', () => {
    const workflows = store()
    expect(workflows.list()).toEqual([])
    expect(workflows.active()).toEqual([])
    expect(workflows.damagedPath()).toBeNull()
    expect(existsSync(file)).toBe(false)
  })

  it('saves a new workflow that list and get can both see', () => {
    const workflows = store()
    const saved = workflows.save({ name: '  早间简报  ', steps: steps(['daily_briefing', 'speak_text']) })
    expect(saved.name).toBe('早间简报')
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(saved.runs).toBe(0)
    expect(saved.createdAt).toBe(NOW)
    expect(saved.updatedAt).toBe(NOW)
    expect(saved.archivedAt).toBeUndefined()

    expect(workflows.list()).toHaveLength(1)
    expect(workflows.get(saved.id)).toEqual(saved)
    expect(workflows.get('missing')).toBeUndefined()

    // A reload reads the same workflow back, so the document is the state.
    const reloaded = store()
    expect(reloaded.list()).toEqual([saved])
  })

  it('updates in place and keeps createdAt, runs and lastRunAt', () => {
    const workflows = store()
    const created = workflows.save({ name: '周报', steps: steps(['web_search']) })
    clock = NOW + 60_000
    workflows.recordRun(created.id)
    clock = NOW + 120_000
    const updated = workflows.save({ name: '周报整理', steps: steps(['web_search', 'create_note']) }, created.id)

    expect(updated.id).toBe(created.id)
    expect(updated.name).toBe('周报整理')
    expect(updated.steps).toHaveLength(2)
    expect(updated.createdAt).toBe(NOW)
    expect(updated.updatedAt).toBe(NOW + 120_000)
    expect(updated.runs).toBe(1)
    expect(updated.lastRunAt).toBe(NOW + 60_000)
    expect(workflows.list()).toHaveLength(1)
  })

  it('refuses a duplicate name regardless of case or spacing', () => {
    const workflows = store()
    workflows.save({ name: 'weekly review', steps: steps(['web_search']) })
    expect(() => workflows.save({ name: 'Weekly  Review', steps: steps(['web_search']) }))
      .toThrow('已经有一个同名工作流：Weekly Review')
    expect(workflows.list()).toHaveLength(1)
    // Its own row is not a clash with itself.
    const saved = workflows.list()[0]
    expect(() => workflows.save({ name: 'WEEKLY REVIEW', steps: steps(['calculate']) }, saved.id)).not.toThrow()
  })

  it('rejects an empty step list and too many steps', () => {
    const workflows = store()
    expect(() => workflows.save({ name: '空', steps: [] })).toThrow('工作流至少要有一个步骤')
    expect(() => workflows.save({ name: '空', steps: null as unknown as WorkflowStep[] }))
      .toThrow('工作流至少要有一个步骤')
    const tooMany = steps(Array.from({ length: MAX_WORKFLOW_STEPS + 1 }, () => 'get_datetime'))
    expect(() => workflows.save({ name: '太长', steps: tooMany }))
      .toThrow(`一个工作流最多 ${MAX_WORKFLOW_STEPS} 步`)
    expect(workflows.list()).toEqual([])
  })

  it('rejects tools outside the allowlist, including recursion and selection rewrite', () => {
    const workflows = store()
    expect(WORKFLOW_STEP_TOOLS).not.toContain('run_workflow')
    expect(WORKFLOW_STEP_TOOLS).not.toContain('replace_selection')
    expect(() => workflows.save({ name: '递归', steps: [step('run_workflow', { id: 'abc' })] }))
      .toThrow('这一步的工具不在允许范围内：run_workflow')
    expect(() => workflows.save({ name: '改写', steps: [step('replace_selection', { text: 'x' })] }))
      .toThrow('这一步的工具不在允许范围内：replace_selection')
    expect(() => workflows.save({ name: '未知', steps: [step('brew_coffee')] }))
      .toThrow('这一步的工具不在允许范围内：brew_coffee')
    expect(workflows.list()).toEqual([])
  })

  it('archives and restores by touching only archivedAt', () => {
    const workflows = store()
    const saved = workflows.save({ name: '晨间', steps: steps(['list_events', 'create_note']) })
    clock = NOW + 5_000
    workflows.archive(saved.id)
    const archived = workflows.get(saved.id)
    expect(archived).toBeDefined()
    expect(archived?.archivedAt).toBe(NOW + 5_000)
    // An archive is not an edit: the row keeps its data and its timestamp.
    expect(archived?.name).toBe(saved.name)
    expect(archived?.steps).toEqual(saved.steps)
    expect(archived?.updatedAt).toBe(NOW)
    expect(workflows.list()).toHaveLength(1)

    clock = NOW + 6_000
    workflows.restore(saved.id)
    const restored = workflows.get(saved.id)
    expect(restored?.archivedAt).toBeUndefined()
    expect(restored?.createdAt).toBe(NOW)
    expect(restored?.steps).toEqual(saved.steps)
    expect(store().get(saved.id)?.steps).toEqual(saved.steps)
  })

  it('excludes archived rows from active and orders the rest by last edit', () => {
    const workflows = store()
    const first = workflows.save({ name: '一', steps: steps(['get_datetime']) })
    clock = NOW + 1_000
    const second = workflows.save({ name: '二', steps: steps(['get_weather']) })
    clock = NOW + 2_000
    workflows.archive(first.id)
    expect(workflows.active().map(row => row.id)).toEqual([second.id])
    // The archived row is still in the full list, which is what the UI manages.
    expect(workflows.list()).toHaveLength(2)

    clock = NOW + 3_000
    workflows.save({ name: '一', steps: steps(['calculate']) }, first.id)
    // Editing does not resurrect an archived workflow.
    expect(workflows.active().map(row => row.id)).toEqual([second.id])

    clock = NOW + 4_000
    workflows.restore(first.id)
    clock = NOW + 5_000
    workflows.save({ name: '二', steps: steps(['get_weather', 'speak_text']) }, second.id)
    expect(workflows.active().map(row => row.id)).toEqual([second.id, first.id])
  })

  it('counts a run without reordering the list', () => {
    const workflows = store()
    const saved = workflows.save({ name: '晨间', steps: steps(['daily_briefing']) })
    clock = NOW + 30_000
    workflows.recordRun(saved.id)
    const after = workflows.get(saved.id)
    expect(after?.runs).toBe(1)
    expect(after?.lastRunAt).toBe(NOW + 30_000)
    expect(after?.updatedAt).toBe(NOW)

    clock = NOW + 60_000
    workflows.recordRun(saved.id)
    expect(workflows.get(saved.id)?.runs).toBe(2)
    expect(workflows.get(saved.id)?.lastRunAt).toBe(NOW + 60_000)
    expect(workflows.get(saved.id)?.updatedAt).toBe(NOW)
    // A run for a row that was removed mid-execution is ignored, not thrown.
    expect(() => workflows.recordRun('gone')).not.toThrow()
  })

  it('quarantines a damaged file and keeps working afterwards', () => {
    writeFileSync(file, '{ not json at all', 'utf8')
    const workflows = store()
    expect(workflows.list()).toEqual([])
    const damaged = workflows.damagedPath()
    expect(damaged).not.toBeNull()
    expect(damaged).toMatch(/workflows\.broken-\d{14}\.json$/)
    expect(existsSync(damaged!)).toBe(true)
    expect(readFileSync(damaged!, 'utf8')).toBe('{ not json at all')
    expect(existsSync(file)).toBe(false)

    const saved = workflows.save({ name: '恢复后', steps: steps(['get_datetime']) })
    expect(store().get(saved.id)?.name).toBe('恢复后')
  })

  it('treats a well-formed JSON document with the wrong shape as damaged', () => {
    writeFileSync(file, JSON.stringify({ version: 1, workflows: 'not an array' }), 'utf8')
    const workflows = store()
    expect(workflows.list()).toEqual([])
    expect(workflows.damagedPath()).toMatch(/\.broken-\d{14}\.json$/)
  })

  it('drops hand-edited steps and rows outside the allowlist instead of replaying them', () => {
    // `workflows.json` is a plain file: a row-level filter beats rejecting the whole
    // document, and a step naming a real app tool (`open_search`, `replace_selection`)
    // must never reach the registry.
    const row = (id: string, name: string, steps: unknown[]): unknown => ({ id, name, runs: 0, createdAt: NOW, updatedAt: NOW, steps })
    writeFileSync(file, JSON.stringify({
      version: 1,
      workflows: [
        row('mixed', '混入危险步骤', [
          { tool: 'open_search', args: { query: 'x' }, label: '搜' },
          { tool: 'get_datetime', label: '时间' },
          { tool: 'replace_selection', args: { text: 'x' } }
        ]),
        row('hostile', '全是危险步骤', [{ tool: 'replace_selection' }, { tool: 'press_keys' }]),
        row('shape', '参数坏了', [{ tool: 'calculate', args: 'not an object' }])
      ]
    }), 'utf8')
    const workflows = store()
    expect(workflows.list().map(row => row.id)).toEqual(['mixed', 'shape'])
    expect(workflows.get('mixed')?.steps.map(step => step.tool)).toEqual(['get_datetime'])
    // Unusable args read as the empty call the tool then validates itself.
    expect(workflows.get('shape')?.steps[0]).toEqual({ tool: 'calculate', args: {}, label: 'calculate' })
    // Filtering is not damage: the user's other rows survive unquarantined.
    expect(workflows.damagedPath()).toBeNull()
  })

  it('writes atomically and leaves no temp file behind', () => {
    const workflows = store()
    workflows.save({ name: '原子', steps: steps(['calculate']) })
    const document = JSON.parse(readFileSync(file, 'utf8')) as { version: number; workflows: Workflow[] }
    expect(document.version).toBe(1)
    expect(document.workflows).toHaveLength(1)
    expect(document.workflows[0].name).toBe('原子')
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect(readdirSync(dir)).toEqual(['workflows.json'])
  })

  it(`refuses more than ${MAX_WORKFLOWS} live workflows`, () => {
    const workflows = store()
    for (let index = 0; index < MAX_WORKFLOWS; index++) {
      workflows.save({ name: `流程 ${index}`, steps: steps(['get_datetime']) })
    }
    expect(workflows.list()).toHaveLength(MAX_WORKFLOWS)
    expect(() => workflows.save({ name: '多余', steps: steps(['get_datetime']) }))
      .toThrow(`工作流数量已达上限（${MAX_WORKFLOWS} 个），请先归档不再需要的`)
    // Archiving really does free a slot, which is what the message promises.
    workflows.archive(workflows.list()[0].id)
    expect(() => workflows.save({ name: '腾出位置', steps: steps(['get_datetime']) })).not.toThrow()
    expect(workflows.list()).toHaveLength(MAX_WORKFLOWS + 1)
  })

  it('removes a row only for self-tests', () => {
    const workflows = store()
    const saved = workflows.save({ name: '用完即删', steps: steps(['get_datetime']) })
    workflows.remove(saved.id)
    expect(workflows.list()).toEqual([])
    expect(store().list()).toEqual([])
  })
})

describe('workflow helpers', () => {
  beforeEach(() => setMainLanguage('zh'))
  afterEach(() => setMainLanguage('zh'))

  it('describes a workflow by its steps', () => {
    const workflow: Workflow = {
      id: 'wf-1',
      name: '会议记录',
      steps: steps(['list_events', 'create_note', 'open_page']),
      runs: 0,
      createdAt: NOW,
      updatedAt: NOW
    }
    expect(describeWorkflow(workflow)).toBe('3 步：list_events → create_note → open_page')
    expect(describeWorkflow({ ...workflow, steps: steps(['get_datetime']) })).toBe('1 步：get_datetime')
  })

  it('normalizes a name by trimming, collapsing and clipping it', () => {
    expect(normalizeWorkflowName('  周报   整理  ')).toBe('周报 整理')
    expect(normalizeWorkflowName('周报\t\r\n整理')).toBe('周报 整理')
    const long = '很长的名字'.repeat(20)
    const clipped = normalizeWorkflowName(long)
    expect(clipped).toHaveLength(MAX_WORKFLOW_NAME)
    expect(long.startsWith(clipped)).toBe(true)
    expect(() => normalizeWorkflowName('')).toThrow('请给这个工作流起一个名字')
    expect(() => normalizeWorkflowName('   ')).toThrow('请给这个工作流起一个名字')
    expect(() => normalizeWorkflowName(undefined)).toThrow('请给这个工作流起一个名字')
  })

  it('repairs steps: plain-object args, clipped labels, label falls back to tool', () => {
    const normalized = normalizeWorkflowSteps([
      { tool: ' get_datetime ', args: { timezone: 'Asia/Shanghai' }, label: '  当前时间  ' },
      { tool: 'calculate', args: ['1 + 1'], label: '   ' },
      { tool: 'get_weather', args: null, label: '天'.repeat(MAX_WORKFLOW_LABEL + 20) }
    ])
    expect(normalized[0]).toEqual({ tool: 'get_datetime', args: { timezone: 'Asia/Shanghai' }, label: '当前时间' })
    // An array is not a plain object, so the step keeps empty args.
    expect(normalized[1]).toEqual({ tool: 'calculate', args: {}, label: 'calculate' })
    expect(normalized[2].label).toHaveLength(MAX_WORKFLOW_LABEL)
    expect(normalized[2].args).toEqual({})
  })

  it('filters and orders active workflows', () => {
    const base: Workflow = { id: 'a', name: 'a', steps: steps(['get_datetime']), runs: 0, createdAt: 1, updatedAt: 1 }
    const rows: Workflow[] = [
      { ...base, id: 'a', updatedAt: 1 },
      { ...base, id: 'b', updatedAt: 3 },
      { ...base, id: 'c', updatedAt: 2, archivedAt: 4 }
    ]
    expect(activeWorkflows(rows).map(row => row.id)).toEqual(['b', 'a'])
    // The input is left alone; the UI keeps its own order.
    expect(rows.map(row => row.id)).toEqual(['a', 'b', 'c'])
  })
})
