import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SettingsStore } from './settings'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false }
}))

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'typeless-settings-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

it('preserves connection settings when only a nested option changes', async () => {
  const store = new SettingsStore(join(dir, 'settings.json'))
  await store.load()
  await store.update({ asr: { baseUrl: 'http://local.test/v1', model: 'whisper', apiKey: 'test', upload: 'wav' } })
  await store.update({ asr: { upload: 'opus' } as never })
  const saved = await store.update({ polish: { temperature: 0.25 } as never })
  expect(saved.asr).toMatchObject({ baseUrl: 'http://local.test/v1', model: 'whisper', apiKey: 'test', upload: 'opus' })
  expect(saved.polish.temperature).toBe(0.25)
  const reloaded = new SettingsStore(join(dir, 'settings.json'))
  expect((await reloaded.load()).asr).toEqual(saved.asr)
})

it('retains both rapid updates in the final file', async () => {
  const store = new SettingsStore(join(dir, 'settings.json'))
  await store.load()
  await Promise.all([store.update({ alertHideSeconds: 9 }), store.update({ historyLimit: 800 })])
  const disk = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
  expect(disk.alertHideSeconds).toBe(9)
  expect(disk.historyLimit).toBe(800)
})
