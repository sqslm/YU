import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, writeFile, unlink, rmdir, utimes, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
import { windowsNative } from './windows-native'

let root: string
const paths: string[] = []
const folders: string[] = []
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'qinly-native-'))) })
afterEach(async () => { for (const path of paths.splice(0)) await unlink(path); for (const folder of folders.splice(0).reverse()) await rmdir(folder); await rmdir(root) })
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
  for (const item of result.applications as { name: string; path: string; appId?: string }[]) {
    expect(item.name).toBeTruthy()
    if (item.appId) expect(item.appId === 'system:settings' || item.appId.includes('!')).toBe(true)
    else { expect(item.path).toMatch(/\.exe$/i); expect(await realpath(item.path)).toBeTruthy() }
  }
  await expect(windowsNative({ action: 'run', command: 'echo should-never-run' })).rejects.toThrow('Unknown operation')
}, 25_000)

it.skipIf(process.platform !== 'win32')('cancels and terminates the native helper instead of waiting for its timeout', async () => {
  const controller = new AbortController()
  const result = windowsNative({ action: 'applications' }, controller.signal)
  controller.abort()
  await expect(result).rejects.toThrow('Cancelled')
})

it.skipIf(process.platform !== 'win32')('finds actual unindexed subfolder archives without scanning beyond the configured depth', async () => {
  let current = root
  for (let level = 1; level <= 4; level++) { current = join(current, `depth-${level}`); await mkdir(current); folders.push(current) }
  const zip = await make('depth-1/report.zip', 'archive metadata fixture', '2026-10-22T01:00:00Z')
  await make('depth-1/not-an-archive.txt', 'excluded', '2026-10-22T01:00:00Z')
  const result = await windowsNative({ action: 'search', root, extensions: ['zip', 'rar', '7z'], recursive: true, sort: 'modified' })
  expect(result.files).toEqual([expect.objectContaining({ path: zip })])
  expect(result.partial).toBe(true)
}, 20000)

it.skipIf(process.platform !== 'win32')('checks the original native window before reading browser or Explorer context', async () => {
  for (const action of ['browser-url', 'explorer-folder', 'current-content']) await expect(windowsNative({ action, handle: '0', pid: process.pid, title: '' })).rejects.toThrow('Original window is unavailable')
}, 20000)

it.skipIf(process.platform !== 'win32')('returns real local drive capacities and refuses activation of invented applications', async () => {
  const result = await windowsNative({ action: 'disk-space' })
  expect((result.drives as unknown[]).length).toBeGreaterThan(0)
  for (const drive of result.drives as { totalBytes: number; freeBytes: number; usedBytes: number }[]) {
    expect(drive.totalBytes).toBeGreaterThan(0)
    expect(drive.freeBytes).toBeGreaterThanOrEqual(0)
    expect(drive.usedBytes + drive.freeBytes).toBe(drive.totalBytes)
  }
  await expect(windowsNative({ action: 'activate', appId: 'nonexistent-qinly-test-app!App' })).rejects.toThrow('no longer available')
}, 25000)

it.skipIf(process.platform !== 'win32')('recognizes actual generated text using installed Windows OCR without uploading or saving the image', async context => {
  const script = `Add-Type -AssemblyName System.Drawing
$bitmap = New-Object Drawing.Bitmap 640,100
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$font = New-Object Drawing.Font 'Arial',32
$stream = New-Object IO.MemoryStream
try { $graphics.Clear([Drawing.Color]::White); $graphics.DrawString('QINLY OCR 123',$font,[Drawing.Brushes]::Black,10,10); $bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png); [Console]::Write([Convert]::ToBase64String($stream.ToArray())) }
finally { $stream.Dispose(); $font.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }`
  const image = await promisify(execFile)(join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
  let result: Record<string, unknown>
  try { result = await windowsNative({ action: 'ocr', png: image.stdout.trim() }) }
  catch (error) {
    if (error instanceof Error && error.message.includes('Windows OCR language support is unavailable')) { context.skip(); return }
    throw error
  }
  expect(String(result.text)).toMatch(/QINLY\s+OCR\s+123/i)
  expect(result).toMatchObject({ width: 640, height: 100, lines: expect.arrayContaining([expect.objectContaining({
    text: expect.stringMatching(/QINLY/i), x: expect.any(Number), y: expect.any(Number), width: expect.any(Number), height: expect.any(Number)
  })]) })
}, 25000)
