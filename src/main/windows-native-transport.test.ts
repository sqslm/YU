import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { windowsNative } from './windows-native'

const mock = vi.hoisted(() => ({ spawn: vi.fn(), packaged: false }))
vi.mock('node:child_process', () => ({ spawn: mock.spawn }))
vi.mock('electron', () => ({ app: { get isPackaged() { return mock.packaged }, getAppPath: () => process.cwd() } }))

function child() {
  return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
}
beforeEach(() => { mock.spawn.mockReset(); mock.packaged = false })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

it.each(['window-check', 'disk-space', 'system-volume', 'ocr', 'browser-url', 'explorer-folder', 'recent-files', 'applications'])('routes %s only to the owned native executable', async action => {
  const proc = child(); mock.spawn.mockReturnValue(proc)
  let input = ''; proc.stdin.on('data', data => { input += data })
  const result = windowsNative({ action, text: '中文 " $() ; data' })
  const [path, args, options] = mock.spawn.mock.calls[0]
  expect(path).toMatch(/native[\\/]bin[\\/]yu-windows\.exe$/)
  expect(args).toEqual(['--parent-pid', String(process.pid)])
  expect(options).toMatchObject({ windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  expect(JSON.parse(input)).toEqual({ action, text: '中文 " $() ; data' })
  proc.stdout.write('\uFEFF{"value":"中'); proc.stdout.write('文"}'); proc.emit('close', 0)
  expect(await result).toEqual({ value: '中文' })
})

it.each(['activate', 'search', 'current-content'])('retains the explicit PowerShell backend for %s', async action => {
  const proc = child(); mock.spawn.mockReturnValue(proc)
  const result = windowsNative({ action })
  expect(mock.spawn.mock.calls[0][0]).toMatch(/powershell\.exe$/)
  expect(mock.spawn.mock.calls[0][1]).toEqual(['-NoProfile', '-NonInteractive', '-File', expect.stringMatching(/resources[\\/]windows-tools\.ps1$/)])
  proc.stdout.write('{}'); proc.emit('close', 0); expect(await result).toEqual({})
})

it('locates packaged native resources outside ASAR and never falls back after failure', async () => {
  mock.packaged = true; vi.stubGlobal('process', { ...process, resourcesPath: 'E:/YU/resources' })
  const proc = child(); mock.spawn.mockReturnValue(proc)
  const result = windowsNative({ action: 'ocr' })
  expect(String(mock.spawn.mock.calls[0][0]).replaceAll('\\', '/')).toBe('E:/YU/resources/native/yu-windows.exe')
  proc.stderr.write('Requested Windows OCR language pack is not installed'); proc.emit('close', 1)
  await expect(result).rejects.toThrow('language pack is not installed')
  expect(mock.spawn).toHaveBeenCalledTimes(1)
})

it('propagates a missing native executable without trying a different backend', async () => {
  const proc = child(); mock.spawn.mockReturnValue(proc)
  const result = windowsNative({ action: 'window-check' })
  proc.emit('error', new Error('ENOENT'))
  await expect(result).rejects.toThrow('ENOENT'); expect(proc.kill).toHaveBeenCalled()
  expect(mock.spawn).toHaveBeenCalledTimes(1)
})

it('cancels and kills only the current request, ignoring its late successful close', async () => {
  const proc = child(); mock.spawn.mockReturnValue(proc)
  const controller = new AbortController(), result = windowsNative({ action: 'ocr' }, controller.signal)
  controller.abort(); proc.stdout.write('{}'); proc.emit('close', 0)
  await expect(result).rejects.toThrow('Cancelled'); expect(proc.kill).toHaveBeenCalledTimes(1)
})

it('does not start a process for an already aborted request', () => {
  const controller = new AbortController(); controller.abort()
  expect(() => windowsNative({ action: 'disk-space' }, controller.signal)).toThrow()
  expect(mock.spawn).not.toHaveBeenCalled()
})

it('terminates a request at the existing 15-second deadline', async () => {
  vi.useFakeTimers(); const proc = child(); mock.spawn.mockReturnValue(proc)
  const result = windowsNative({ action: 'ocr' })
  const rejected = expect(result).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(15000); await rejected
  expect(proc.kill).toHaveBeenCalledTimes(1)
})

it('rejects oversized output, malformed JSON and broken input pipes', async () => {
  for (const failure of ['large', 'json', 'pipe']) {
    const proc = child(); mock.spawn.mockReturnValue(proc)
    const result = windowsNative({ action: 'ocr' })
    if (failure === 'large') proc.stdout.write('x'.repeat(2_000_001))
    if (failure === 'json') { proc.stdout.write('invalid'); proc.emit('close', 0) }
    if (failure === 'pipe') proc.stdin.emit('error', new Error('EPIPE'))
    await expect(result).rejects.toThrow(failure === 'large' ? 'response too large' : failure === 'json' ? 'Invalid Windows bridge response' : 'EPIPE')
  }
})
