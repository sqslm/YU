import { spawn } from 'node:child_process'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ screen: {} }))
import { gameProcessAlive } from './game-mode-native'

it.skipIf(process.platform !== 'win32')('uses Windows process handles to distinguish a live process from an exited game', async () => {
  expect(gameProcessAlive(process.pid)).toBe(true)
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 500)'], { windowsHide: true, stdio: 'ignore' })
  expect(child.pid).toBeGreaterThan(0)
  const exited = new Promise<void>((resolve, reject) => { child.on('exit', () => resolve()); child.on('error', reject) })
  expect(gameProcessAlive(child.pid!)).toBe(true)
  await exited
  expect(gameProcessAlive(child.pid!)).toBe(false)
})
