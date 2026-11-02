import { expect, it } from 'vitest'
import { searchErrorText } from './searchError'

/** The dictionary in the test is the identity: what matters is which branch ran. */
const t = (key: string): string => key

it('strips Electron\'s invoke wrapper and keeps the real reason', () => {
  expect(searchErrorText(new Error("Error invoking remote method 'workspace:search': Error: 无效的搜索词"), t)).toBe('无效的搜索词')
  expect(searchErrorText("Error invoking remote method 'workspace:search': Error: boom", t)).toBe('boom')
})

it('turns a missing handler into something the user can act on', () => {
  // Exactly what a hot-reloaded renderer over a stale main process reports.
  const stale = new Error("Error invoking remote method 'workspace:search': Error: No handler registered for 'workspace:search'")
  expect(searchErrorText(stale, t)).toBe('搜索需要重启 YU 后才能使用')
  expect(searchErrorText(Error("No handler registered for 'workspace:get'"), t)).toBe('搜索需要重启 YU 后才能使用')
})

it('falls back on an empty reason and never returns an empty bubble', () => {
  expect(searchErrorText(undefined, t)).toBe('搜索失败，请重试')
  expect(searchErrorText(Error("Error invoking remote method 'workspace:search': Error: "), t)).toBe('搜索失败，请重试')
  expect(searchErrorText('   ', t)).toBe('搜索失败，请重试')
})
