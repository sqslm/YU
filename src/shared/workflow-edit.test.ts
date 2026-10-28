import { expect, it } from 'vitest'
import { removeWorkflowStep, type WorkflowStep } from './workflow'

const steps: WorkflowStep[] = [
  { tool: 'get_datetime', label: 'Unused', args: {} },
  { tool: 'search_notes', label: 'Search', args: { query: 'project' } },
  { tool: 'create_note', label: 'Save', args: { text: { $ref: '2.text' } }, when: { ref: '2.ok', op: 'eq', value: true }, otherwise: { tool: 'copy_to_clipboard', args: { text: { $ref: '2.error' } }, label: 'Error' } }
]
it('renumbers arguments, conditions and fallback bindings after removing an unreferenced step', () => {
  const next = removeWorkflowStep(steps, 0)
  expect(next[1]).toMatchObject({ args: { text: { $ref: '1.text' } }, when: { ref: '1.ok' }, otherwise: { args: { text: { $ref: '1.error' } } } })
  expect(steps[2].when?.ref).toBe('2.ok')
})
it('refuses removing a referenced step instead of silently binding to another result', () => {
  expect(() => removeWorkflowStep(steps, 1)).toThrow('后续步骤引用')
})
