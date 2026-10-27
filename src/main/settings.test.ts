import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SettingsStore } from './settings'

const cryptoMock = vi.hoisted(() => ({ available: false }))

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  safeStorage: { isEncryptionAvailable: () => cryptoMock.available,
    encryptString: (text: string) => Buffer.from('sealed:' + text),
    decryptString: (bytes: Buffer) => bytes.toString().replace(/^sealed:/, '') }
}))

let dir: string
beforeEach(async () => { cryptoMock.available = false; dir = await mkdtemp(join(tmpdir(), 'typeless-settings-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

it('encrypts active and saved TTS credentials and restores all connection fields after restart', async () => {
  cryptoMock.available = true
  const file = join(dir, 'settings.json'), store = new SettingsStore(file)
  await store.load()
  await store.update({ tts: { provider: 'openai', apiKey: 'active-tts-secret', baseUrl: 'https://example.test/v1/audio/speech', model: 'tts', apiVoice: 'alloy', speed: 1.3,
    connections: { minimax: { apiKey: 'saved-tts-secret', baseUrl: 'https://example.test/minimax', model: 'speech-2.8-hd', apiVoice: 'a' } } } as never })
  const raw = await readFile(file, 'utf8')
  expect(raw).not.toContain('active-tts-secret'); expect(raw).not.toContain('saved-tts-secret')
  const reloaded = await new SettingsStore(file).load()
  expect(reloaded.tts).toMatchObject({ provider: 'openai', apiKey: 'active-tts-secret', model: 'tts', apiVoice: 'alloy', speed: 1.3,
    connections: { minimax: { apiKey: 'saved-tts-secret', model: 'speech-2.8-hd' } } })
})

it('saves wake confidence independently and retains it after restart', async () => {
  const file = join(dir, 'settings.json'), store = new SettingsStore(file)
  await store.load()
  await store.update({ wakeWord: { enabled: true, phrase: '我的唤醒词', deviceId: '2', confidence: 0.91 } })
  await store.update({ wakeWord: { confidence: 0.72 } as never })
  const loaded = await new SettingsStore(file).load()
  expect(loaded.wakeWord).toEqual({ enabled: true, phrase: '我的唤醒词', deviceId: '2', confidence: 0.72 })
})

it('encrypts every search credential on disk and restores pool and legacy provider keys after restart', async () => {
  cryptoMock.available = true
  const file = join(dir, 'settings.json'), store = new SettingsStore(file)
  await store.load()
  const current = store.get().search
  await store.update({ search: { ...current, provider: 'tavily', strategy: 'fallback', providers: { ...current.providers, tavily: { apiKey: 'legacy-search-secret', endpoint: '', maxResults: 5 } },
    connections: [{ id: 'account-two', name: 'Account 2', provider: 'tavily', enabled: true, apiKey: 'pool-search-secret', endpoint: '', maxResults: 8 }] } })
  const raw = await readFile(file, 'utf8')
  expect(raw).not.toContain('legacy-search-secret')
  expect(raw).not.toContain('pool-search-secret')
  const loaded = await new SettingsStore(file).load()
  expect(loaded.search.apiKey).toBe('legacy-search-secret')
  expect(loaded.search.connections[0]).toMatchObject({ apiKey: 'pool-search-secret', maxResults: 8, enabled: true })
})

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

it('persists an update made while an earlier save is still finishing', async () => {
  const file = join(dir, 'settings.json')
  const store = new SettingsStore(file)
  await store.load()
  const first = store.update({ alertHideSeconds: 9 })
  // Yield once so the first job has taken its snapshot and reached file I/O.
  await new Promise((resolve) => setTimeout(resolve, 0))
  const second = store.update({ historyLimit: 800 })
  await Promise.all([first, second])
  const disk = JSON.parse(await readFile(file, 'utf8'))
  expect(disk).toMatchObject({ alertHideSeconds: 9, historyLimit: 800 })
})
