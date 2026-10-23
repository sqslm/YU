import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, writeFile, unlink, rmdir, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
import { windowsNative } from './windows-native'

let root: string
const paths: string[] = []
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'qinly-native-'))) })
afterEach(async () => { for (const path of paths.splice(0)) await unlink(path); await rmdir(root) })
const make = async (name: string, text: string, date: string): Promise<string> => {
  const path = join(root, name); await writeFile(path, text); await utimes(path, new Date(date), new Date(date)); paths.push(path); return path
}

it.skipIf(process.platform !== 'win32')('queries real Windows file metadata, preserving Unicode and filtering dates/extensions/sizes', async () => {
  const first = await make('Qinly 报告.txt', 'first report', '2026-10-22T01:00:00Z')
  await make('small.txt', 'x', '2026-10-21T01:00:00Z')
  await make('image.png', 'image', '2026-10-22T01:00:00Z')
  const result = await windowsNative({ action: 'search', root, extension: 'txt', name: '报告', after: '2026-10-22T00:00:00Z', before: '2026-10-23T00:00:00Z', minBytes: 2, sort: 'size' })
  expect(result.files).toEqual([expect.objectContaining({ name: 'Qinly 报告.txt', path: first, bytes: 12 })])
  expect(['folder', 'windows-search+folder']).toContain(result.backend)
}, 20_000)

it.skipIf(process.platform !== 'win32')('discovers real registered applications without launching them and rejects unknown native actions', async () => {
  const result = await windowsNative({ action: 'applications' })
  expect(Array.isArray(result.applications)).toBe(true)
  for (const item of result.applications as { name: string; path: string }[]) {
    expect(item.name).toBeTruthy(); expect(item.path).toMatch(/\.exe$/i)
    expect(await realpath(item.path)).toBeTruthy()
  }
  await expect(windowsNative({ action: 'run', command: 'echo should-never-run' })).rejects.toThrow('Unknown operation')
}, 25_000)

it.skipIf(process.platform !== 'win32')('cancels and terminates the native helper instead of waiting for its timeout', async () => {
  const controller = new AbortController()
  const result = windowsNative({ action: 'applications' }, controller.signal)
  controller.abort()
  await expect(result).rejects.toThrow('Cancelled')
})
