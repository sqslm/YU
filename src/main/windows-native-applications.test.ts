import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
import { windowsNative } from './windows-native'

interface Entry {
  name: string
  path?: string
  appId?: string
}

const applications = async (signal?: AbortSignal): Promise<Entry[]> => {
  const result = (await windowsNative({ action: 'applications' }, signal)) as { applications: Entry[] }
  return result.applications
}

const digest = (entries: Entry[]): string =>
  entries
    .map(entry => `${entry.name}\u0000${entry.path ?? ''}\u0000${entry.appId ?? ''}`)
    .sort()
    .join('\u0001')

afterEach(() => {
  vi.restoreAllMocks()
})

it('returns the registered application list in the documented shape', async () => {
  const entries = await applications()
  expect(Array.isArray(entries)).toBe(true)
  expect(entries.length).toBeGreaterThan(0)
  expect(entries.length).toBeLessThanOrEqual(1500)
  for (const entry of entries) {
    expect(typeof entry.name).toBe('string')
    expect(entry.name.length).toBeGreaterThan(0)
    if (entry.appId) expect(entry.path).toBe('')
    else expect(entry.path).toMatch(/\.exe$/i)
  }
  expect(entries.some(entry => entry.appId === 'system:settings')).toBe(true)
  expect(entries.some(entry => Boolean(entry.appId && entry.appId !== 'system:settings'))).toBe(true)
  expect(entries.some(entry => Boolean(entry.path))).toBe(true)
})

it('enumerates repeatedly without drifting', async () => {
  const first = digest(await applications())
  for (let index = 0; index < 29; index += 1) expect(digest(await applications())).toBe(first)
}, 120_000)

it('honours cancellation before the request starts', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(applications(controller.signal)).rejects.toThrow(/abort/i)
})

it('cancels an enumeration in flight and stays usable afterwards', async () => {
  const controller = new AbortController()
  const started = applications(controller.signal)
  setTimeout(() => controller.abort(), 150)
  await expect(started).rejects.toThrow('Cancelled')
  expect((await applications()).length).toBeGreaterThan(0)
}, 120_000)
