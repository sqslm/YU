import { afterEach, expect, it, vi } from 'vitest'
import { GameMode, isGame, type GameObservation } from './game-mode'
import { normalizeGameProcesses } from '@shared/game-mode'
import { applySettingsPatch, mergeSettings } from '@shared/defaults'

const observation = (process = 'cs2', pid = 42): GameObservation => ({ process, pid, className: '', fullScreen3d: false })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

it('does not treat browser full-screen or presentation windows as games', () => {
  expect(isGame(observation('chrome'), [])).toBe(false)
  expect(isGame({ ...observation('msedge'), fullScreen3d: true }, [])).toBe(false)
  expect(isGame(observation('powerpnt'), [])).toBe(false)
  expect(isGame({ ...observation('other'), className: 'UnityWndClass' }, [])).toBe(true)
  expect(isGame(observation('custom-game'), ['custom-game'])).toBe(true)
})

it('normalizes custom executable paths without shell execution or duplicates', () => {
  expect(normalizeGameProcesses([' C:\\Games\\MyGame.EXE ', 'mygame', '', 42, '"C:\\Games\\My Game.EXE"'])).toEqual(['mygame', 'my game'])
})

it('adds automatic detection to old settings and preserves custom games when toggling it', () => {
  const defaults = mergeSettings({})
  expect(defaults.gameMode).toEqual({ enabled: true, processes: [] })
  const configured = mergeSettings({ gameMode: { enabled: true, processes: ['Game.EXE'] } })
  const updated = applySettingsPatch(configured, { gameMode: { enabled: false } as never })
  expect(mergeSettings(updated).gameMode).toEqual({ enabled: false, processes: ['game'] })
})

it('stays active across Alt+Tab and restores only after all games exit', () => {
  let current = observation(), alive = new Set([42, 43])
  const changed = vi.fn(), mode = new GameMode({ observe: () => current, alive: pid => alive.has(pid), changed, log: vi.fn() })
  mode.configure({ enabled: true, processes: [] })
  expect(mode.snapshot()).toMatchObject({ active: true, source: 'automatic' })
  current = observation('chrome', 50); mode.poll()
  expect(mode.snapshot().active).toBe(true)
  current = observation('dota2', 43); mode.poll()
  alive.delete(42); mode.poll(); expect(mode.snapshot().active).toBe(true)
  current = observation('chrome', 50); alive.clear(); mode.poll()
  expect(mode.snapshot().active).toBe(false)
  mode.stop()
})

it('keeps manual mode independent of automatic detection and cancels polling on stop', async () => {
  vi.useFakeTimers()
  const observe = vi.fn(() => observation('chrome'))
  const mode = new GameMode({ observe, alive: () => false, changed: vi.fn(), log: vi.fn() })
  mode.configure({ enabled: true, processes: [] }); mode.setManual(true)
  mode.configure({ enabled: false, processes: [] })
  expect(mode.snapshot()).toMatchObject({ active: true, source: 'manual' })
  mode.setManual(false); expect(mode.snapshot().active).toBe(false)
  mode.stop(); observe.mockClear(); await vi.advanceTimersByTimeAsync(5000)
  expect(observe).not.toHaveBeenCalled()
})
