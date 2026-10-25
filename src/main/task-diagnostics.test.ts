import { expect, it, vi } from 'vitest'
import { createTask } from './task-context'
import { finishTaskTrace, recordTaskStage, taskDiagnosticSummary, traceTaskStage, withTaskTrace } from './task-diagnostics'

it('correlates concurrent provider work without mixing tasks or recording private content', async () => {
  const log = vi.fn(), first = createTask('text', { windowTitle: 'private-window' }, 'secret-input'), second = createTask('voice')
  await Promise.all([first, second].map(task => withTaskTrace(task, log, () => traceTaskStage('llm', async () => {
    await new Promise(resolve => setImmediate(resolve)); return 'secret-result'
  }))))
  expect(log.mock.calls.map(([line]) => line)).toEqual(expect.arrayContaining([
    expect.stringContaining(first.id), expect.stringContaining(second.id)
  ]))
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-window|secret-input|secret-result/)
  first.state = 'cancelled'; finishTaskTrace(first, log); finishTaskTrace(first, log)
  expect(log.mock.calls.filter(([line]) => line.includes('stage=total'))).toHaveLength(1)
})

it('bounds samples and reports real percentiles and failures without input or IDs', async () => {
  const task = createTask('text', {}, 'private'), log = vi.fn()
  await expect(withTaskTrace(task, log, () => traceTaskStage('asr', async () => { throw Error('password') }))).rejects.toThrow('password')
  expect(log.mock.calls.at(-1)?.[0]).toContain('state=failed')
  for (let index = 1; index <= 600; index++) recordTaskStage(task, 'tool', index, () => {}, index % 2 ? 'completed' : 'failed')
  const summary = taskDiagnosticSummary() as { samples: number; stages: { tool: { p50: number; p95: number } }; toolCompletionRate: number }
  expect(summary.samples).toBe(512)
  expect(summary.stages.tool).toMatchObject({ p50: 344, p95: 575 })
  expect(summary.toolCompletionRate).toBe(.5)
  expect(JSON.stringify(summary)).not.toMatch(new RegExp(`private|password|${task.id}`))
})
