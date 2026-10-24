import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('electron', () => ({ app: { getAppPath: () => '/app', isPackaged: false } }))
import { WakeWordHost, parseDeviceList } from './wake-word'

describe('wake-word input device picker', () => {
  let children: any[], host: WakeWordHost
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  const usePlatform = (value: NodeJS.Platform): void => { Object.defineProperty(process, 'platform', { value, configurable: true }) }
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); children = []
    mocks.spawn.mockImplementation(() => {
      const stdin = Object.assign(new PassThrough(), { end: vi.fn() })
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin, kill: vi.fn() })
      children.push(child); return child
    })
    usePlatform('win32')
    host = new WakeWordHost({ wake: vi.fn(), changed: vi.fn() })
  })
  afterEach(() => { host.stop(); vi.useRealTimers(); Object.defineProperty(process, 'platform', original) })
  it('reads the device list out of the script output and ignores log lines', () => {
    const stdout = [
      '[voice-wake] compiling',
      JSON.stringify({ type: 'devices', devices: [{ id: '0', name: '麦克风 (HyperX Cloud III)' }, { id: '1', name: '麦克风 (Steam Streaming Microphone' }] }),
      ''
    ].join('\n')
    expect(parseDeviceList(stdout)).toEqual([
      { id: '0', name: '麦克风 (HyperX Cloud III)' },
      { id: '1', name: '麦克风 (Steam Streaming Microphone' }
    ])
  })
  it('returns nothing for an empty list, a malformed line or a different event', () => {
    expect(parseDeviceList('{"type":"devices","devices":[]}')).toEqual([])
    expect(parseDeviceList('{"type":"ready"}')).toEqual([])
    expect(parseDeviceList('not json at all')).toEqual([])
    expect(parseDeviceList('{"type":"devices","devices":[{"name":"no id"}]}')).toEqual([])
  })
  it('asks the script for the list instead of starting the recogniser', async () => {
    const pending = host.listDevices()
    children[0].stdout.write(JSON.stringify({ type: 'devices', devices: [{ id: '2', name: '耳机麦克风' }] }) + '\n')
    children[0].emit('exit', 0, null)
    await expect(pending).resolves.toEqual([{ id: '2', name: '耳机麦克风' }])
    expect(mocks.spawn.mock.calls[0][1]).toContain('-ListDevices')
    expect(host.deviceIssue).toBe('')
  })
  it('never rejects: a failed or silent helper reports an empty list and the reason', async () => {
    const crashed = host.listDevices()
    children[0].emit('error', new Error('spawn failed'))
    await expect(crashed).resolves.toEqual([])
    expect(host.deviceIssue).toBe('unavailable')
    const empty = host.listDevices()
    children[1].emit('exit', 1, null)
    await expect(empty).resolves.toEqual([])
    expect(host.deviceIssue).toBe('unavailable')
  })
  it('gives up on a helper that never answers and kills it', async () => {
    const pending = host.listDevices()
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(pending).resolves.toEqual([])
    expect(host.deviceIssue).toBe('timeout')
    expect(children[0].kill).toHaveBeenCalled()
  })
  it('reports no devices on a platform without the helper', async () => {
    usePlatform('linux')
    await expect(host.listDevices()).resolves.toEqual([])
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(host.deviceIssue).toBe('unavailable')
  })
  it('passes the chosen device and restarts the recogniser when it changes', () => {
    const settings = { enabled: true, phrase: '你好语助手', deviceId: '1' }
    host.update(settings, false)
    expect(JSON.parse(children[0].stdin.end.mock.calls[0][0])).toEqual({ phrase: '你好语助手', language: 'zh', device: '1' })
    host.update(settings, false)
    expect(children).toHaveLength(1)
    host.update({ ...settings, deviceId: '0' }, false)
    expect(children).toHaveLength(2)
    expect(JSON.parse(children[1].stdin.end.mock.calls[0][0]).device).toBe('0')
  })
  it('falls back to the system default when no device was ever chosen', () => {
    host.update({ enabled: true, phrase: 'Hey YU' }, false)
    expect(JSON.parse(children[0].stdin.end.mock.calls[0][0])).toEqual({ phrase: 'Hey YU', language: 'en', device: '' })
  })
})
