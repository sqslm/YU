import { expect, it, vi } from 'vitest'
import { readTargetSnapshot } from './child'

it('never reads a newly focused window and discards a provider result after a window switch', () => {
  const target = { windowHandle: '11', processId: 22, windowTitle: 'Editor' }
  const original = { handle: '11', pid: 22, title: 'Editor' } as ReturnType<typeof import('../foreground').foregroundWindow>
  const other = { handle: '33', pid: 44, title: 'Assistant' } as typeof original
  const read = vi.fn(() => ({ value: 'original field' } as ReturnType<typeof import('./reader').readFocusedSnapshot>))
  expect(readTargetSnapshot(target, read, () => other)).toBeNull()
  expect(read).not.toHaveBeenCalled()
  expect(readTargetSnapshot(target, read, vi.fn().mockReturnValueOnce(original).mockReturnValueOnce(other))).toBeNull()
  expect(read).toHaveBeenCalledOnce()
  expect(readTargetSnapshot(target, read, () => original)).toEqual({ value: 'original field' })
})
