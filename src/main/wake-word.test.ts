import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('electron', () => ({ app: { getAppPath: () => '/app', isPackaged: false } }))
import { WakeWordHost } from './wake-word'

describe('offline custom wake lifecycle', () => {
  let children: any[], host: WakeWordHost
  const wake = vi.fn(), changed = vi.fn()
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); children = []
    mocks.spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() })
      children.push(child); return child
    })
    host = new WakeWordHost({ wake, changed })
  })
  afterEach(() => { host.stop(); vi.useRealTimers() })
  it('does not open a microphone until explicitly enabled; pauses and resumes without duplicate helpers', () => {
    host.update({ enabled: false, phrase: '你好轻令' }, false); expect(mocks.spawn).not.toHaveBeenCalled()
    const settings = { enabled: true, phrase: '你好轻令' }
    host.update(settings, false); host.update(settings, false)
    expect(children).toHaveLength(1)
    children[0].stdout.write('{"type":"ready"}\n')
    expect(host.snapshot().phase).toBe('listening')
    host.update(settings, true)
    expect(children[0].kill).toHaveBeenCalledOnce(); expect(host.snapshot().phase).toBe('paused')
    children[0].stdout.write('{"type":"wake"}\n'); expect(wake).not.toHaveBeenCalled()
    host.update(settings, false); expect(children).toHaveLength(2)
  })
  it('starts exactly one existing recording when woken and ignores queued events', () => {
    host.update({ enabled: true, phrase: 'Hey Qinly' }, false)
    const event = JSON.stringify({ type: 'wake', phrase: 'Hey Qinly', confidence: .98, wordConfidence: .95, durationMs: 800 }) + '\n'
    children[0].stdout.write('{"type":"ready"}\n' + event + event)
    expect(wake).toHaveBeenCalledOnce(); expect(children[0].kill).toHaveBeenCalledOnce()
    expect(host.snapshot().phase).toBe('paused')
  })
  it('rejects weak, clipped, unrelated and cooldown matches without starting a recording', () => {
    const settings = { enabled: true, phrase: '你好轻令' }
    host.update(settings, false); children[0].stdout.write('{"type":"ready"}\n')
    const event = { type: 'wake', phrase: settings.phrase, confidence: .98, wordConfidence: .95, durationMs: 700 }
    for (const patch of [{ confidence: .6 }, { durationMs: 100 }, { phrase: '你好清理' }]) children[0].stdout.write(JSON.stringify({ ...event, ...patch }) + '\n')
    expect(wake).not.toHaveBeenCalled()
    children[0].stdout.write(JSON.stringify(event) + '\n'); expect(wake).toHaveBeenCalledOnce()
    host.update(settings, false); children[1].stdout.write('{"type":"ready"}\n' + JSON.stringify(event) + '\n')
    expect(wake).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(5000); children[1].stdout.write(JSON.stringify(event) + '\n')
    expect(wake).toHaveBeenCalledTimes(2)
  })
  it('accepts a clearly matched normal long phrase without requiring near-perfect confidence', () => {
    host.update({ enabled: true, phrase: '你好语助手' }, false)
    children[0].stdout.write('{"type":"ready"}\n')
    children[0].stdout.write(JSON.stringify({ type: 'wake', phrase: '你好语助手', confidence: .86, wordConfidence: .65, durationMs: 1000 }) + '\n')
    expect(wake).toHaveBeenCalledOnce()
  })
  it('honors the lowest configured threshold for a custom name without a hidden per-word floor', () => {
    host.update({ enabled: true, phrase: '你好，胡小杨', confidence: 0.5 }, false)
    children[0].stdout.write('{"type":"ready"}\n')
    children[0].stdout.write(JSON.stringify({ type: 'wake', phrase: '你好，胡小杨', confidence: 0.62, wordConfidence: 0.23, durationMs: 1800 }) + '\n')
    expect(wake).toHaveBeenCalledOnce()
  })
  it('also honors an explicitly lower threshold for a short custom name', () => {
    host.update({ enabled: true, phrase: '小杨', confidence: 0.5 }, false)
    children[0].stdout.write('{"type":"ready"}\n')
    children[0].stdout.write(JSON.stringify({ type: 'wake', phrase: '小杨', confidence: 0.61, wordConfidence: 0.25, durationMs: 600 }) + '\n')
    expect(wake).toHaveBeenCalledOnce()
  })
  it('accepts a matching low-confidence custom name at the new lowest sensitivity setting', () => {
    host.update({ enabled: true, phrase: '你好，胡小杨', confidence: 0.1 }, false)
    children[0].stdout.write('{"type":"ready"}\n')
    children[0].stdout.write(JSON.stringify({ type: 'wake', phrase: '你好，胡小杨', confidence: 0.22, durationMs: 1300 }) + '\n')
    expect(wake).toHaveBeenCalledOnce()
  })
  it('keeps a stricter confidence gate for short phrases', () => {
    host.update({ enabled: true, phrase: '小语' }, false)
    children[0].stdout.write('{"type":"ready"}\n')
    children[0].stdout.write(JSON.stringify({ type: 'wake', phrase: '小语', confidence: .86, wordConfidence: .65, durationMs: 450 }) + '\n')
    expect(wake).not.toHaveBeenCalled()
  })
  it.each([0.5, 0.75, 0.99])('uses the configured confidence boundary %s', confidence => {
    const settings = { enabled: true, phrase: '你好语助手', confidence }
    host.update(settings, false)
    children[0].stdout.write('{"type":"ready"}\n')
    const event = { type: 'wake', phrase: settings.phrase, confidence: confidence - 0.01, wordConfidence: 0.95, durationMs: 800 }
    children[0].stdout.write(JSON.stringify(event) + '\n')
    expect(wake).not.toHaveBeenCalled()
    children[0].stdout.write(JSON.stringify({ ...event, confidence }) + '\n')
    expect(wake).toHaveBeenCalledOnce()
  })
  it('applies threshold changes without reopening the microphone', () => {
    const settings = { enabled: true, phrase: '你好语助手', confidence: 0.9 }
    host.update(settings, false)
    children[0].stdout.write('{"type":"ready"}\n')
    const event = JSON.stringify({ type: 'wake', phrase: settings.phrase, confidence: 0.85, wordConfidence: 0.9, durationMs: 800 }) + '\n'
    children[0].stdout.write(event)
    expect(wake).not.toHaveBeenCalled()
    host.update({ ...settings, confidence: 0.8 }, false)
    expect(children).toHaveLength(1)
    children[0].stdout.write(event)
    expect(wake).toHaveBeenCalledOnce()
  })
  it('surfaces a missing language pack and retries only when requested', () => {
    const settings = { enabled: true, phrase: 'Hey Qinly' }
    host.update(settings, false); children[0].stdout.write('{"type":"error","error":"language"}\n')
    expect(host.snapshot()).toEqual({ phase: 'error', error: 'language' })
    host.update(settings, false); expect(children).toHaveLength(1)
    host.update(settings, false, true); expect(children).toHaveLength(2)
  })
  it('times out startup and safely passes custom phrases as JSON, never shell source', async () => {
    host.update({ enabled: true, phrase: '你好; $(测试)' }, false)
    expect(mocks.spawn.mock.calls[0][1]).not.toContain('你好; $(测试)')
    expect(mocks.spawn.mock.calls[0][2].windowsHide).toBe(true)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(host.snapshot()).toEqual({ phase: 'error', error: 'unavailable' })
  })
  it('reports the silent default-microphone fallback instead of just listening', () => {
    // The script falls back on purpose when the saved device index is gone; the UI
    // has to say so, otherwise the user talks into a microphone that never hears it.
    host.update({ enabled: true, phrase: '你好语助手', deviceId: '9' }, false)
    children[0].stdout.write('{"type":"log","reason":"device-missing","device":9}\n')
    expect(changed).toHaveBeenLastCalledWith({ phase: 'starting', deviceNotice: 'device-missing' })
    children[0].stdout.write('{"type":"ready"}\n')
    expect(host.snapshot()).toEqual({ phase: 'listening', deviceNotice: 'device-missing' })
  })
  it('clears the fallback notice on pause and re-reports it only from a real log', () => {
    const settings = { enabled: true, phrase: '你好语助手', deviceId: '9' }
    host.update(settings, false)
    children[0].stdout.write('{"type":"log","reason":"device-missing","device":9}\n{"type":"ready"}\n')
    expect(host.snapshot().deviceNotice).toBe('device-missing')
    host.update(settings, true)
    expect(host.snapshot()).toEqual({ phase: 'paused' })
    host.update(settings, false)
    expect(host.snapshot()).toEqual({ phase: 'starting' })
    children[1].stdout.write('{"type":"ready"}\n')
    expect(host.snapshot()).toEqual({ phase: 'listening' })
  })
  it('ignores other log events so unrelated script chatter cannot fake a notice', () => {
    host.update({ enabled: true, phrase: '你好语助手' }, false)
    children[0].stdout.write('{"type":"log","reason":"device-opened","device":0}\n{"type":"ready"}\n')
    expect(host.snapshot()).toEqual({ phase: 'listening' })
  })
})
