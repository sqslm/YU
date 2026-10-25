import { expect, it } from 'vitest'
import { attachTask, createTask, matchesTaskTarget } from './task-context'
import { renderContext } from '@shared/prompts'

it('freezes the original target and preserves one task across consumers', () => {
  const original = { windowHandle: '123', processId: 9, appName: 'explorer', windowTitle: 'D:\\photo', windowRect: { x: 0, y: 0, width: 900, height: 600 } }
  const task = createTask('voice', original, 'current folder')
  original.windowTitle = 'Assistant'; original.windowRect.x = 300
  const context = attachTask({ appName: 'assistant', windowTitle: 'Assistant' }, task)
  expect(context.windowTitle).toBe('D:\\photo'); expect(context.windowRect?.x).toBe(0)
  expect(context.task).toBe(task)
  expect(matchesTaskTarget(task.target, { handle: '123', pid: 9, title: 'D:\\photo' })).toBe(true)
  expect(matchesTaskTarget(task.target, { handle: '123', pid: 10, title: 'D:\\photo' })).toBe(false)
})

it('isolates requests and does not render internal task inputs as prompt context', () => {
  const one = createTask('text', {}, 'private clipboard text'), two = createTask('text')
  expect(one.id).not.toBe(two.id)
  one.receipts.push({ tool: 'read_clipboard', state: 'completed', durationMs: 1 })
  expect(two.receipts).toEqual([])
  expect(renderContext(attachTask({}, one))).not.toContain('private clipboard text')
})
