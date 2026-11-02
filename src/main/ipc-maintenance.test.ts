import { afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => unknown>() }))
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (...args: any[]) => unknown) => mocks.handlers.set(channel, handler), on: (channel: string, handler: (...args: any[]) => unknown) => mocks.handlers.set(channel, handler) } }))
import { handle, setDataMaintenance, subscribe } from './ipc-trust'
afterEach(() => { setDataMaintenance(false); mocks.handlers.clear() })
it('blocks writes while a backup is running and resumes the same handler afterwards', () => {
  const update = vi.fn(() => 'saved')
  handle('notes:update', update)
  setDataMaintenance(true)
  expect(() => mocks.handlers.get('notes:update')!(null)).toThrow('备份')
  expect(update).not.toHaveBeenCalled()
  setDataMaintenance(false)
  expect(mocks.handlers.get('notes:update')!(null)).toBe('saved')
})
it('also holds back card actions sent without an invoke response', () => {
  const action = vi.fn()
  subscribe('card:action', action)
  setDataMaintenance(true)
  mocks.handlers.get('card:action')!(null)
  expect(action).not.toHaveBeenCalled()
  setDataMaintenance(false)
  mocks.handlers.get('card:action')!(null)
  expect(action).toHaveBeenCalledOnce()
})
