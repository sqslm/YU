import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { createSpeechRunner } from './speech'

// The helper under test is the real binary in native/bin, built by
// `pnpm test:native`. Every utterance uses volume 0 and a short sentence, so the
// suite exercises the SAPI protocol without filling the room with speech.
const require = createRequire(import.meta.url)
const fixture = require('../../tests/yu-v2/fixtures/speech-native.cjs') as {
  available: () => boolean
  parse: (result: { events: { at: number; line: string }[] }) => any[]
  request: (lines: string[], options?: { keepOpenMs?: number; timeoutMs?: number }) => Promise<{ code: number | null; ms: number; events: { at: number; line: string }[]; pid: number }>
  live: (request: object, actions: { on?: (event: any) => boolean; write?: object; end?: boolean; waitMs?: number }[], options?: { timeoutMs?: number }) => Promise<{ code: number | null; ms: number; events: any[]; pid: number }>
  powershellVoices: () => Promise<string[] | null>
  sample: (pid: number) => Promise<{ handles?: number; threads?: number; privateKb?: number }>
  leftovers: (pids: number[], timeoutMs?: number) => Promise<number[]>
}

const available = fixture.available()
const speak = { action: 'speak' as const, text: '你好，这是一次本地朗读测试。', voice: 'Microsoft Huihui Desktop', rate: 0, volume: 0 }
const paused = (event: any) => event.event === 'control'

describe.skipIf(!available)('yu-speech helper', () => {
  it('lists exactly the voices the PowerShell host lists', async () => {
    const host = await fixture.powershellVoices()
    const helper = fixture.parse(await fixture.request([JSON.stringify({ action: 'voices' })]))
    expect(host).not.toBeNull()
    expect(helper[0]).toMatchObject({ ok: true })
    expect(helper[0].voices).toEqual(host)
    expect(helper[0].voices.length).toBeGreaterThan(0)
  }, 30_000)

  it('acknowledges the real start of its own stream, then reports completion once', async () => {
    const result = await fixture.request([JSON.stringify(speak)])
    const events = fixture.parse(result)
    const started = events.findIndex((event) => event.event === 'started')
    const done = events.findIndex((event) => event.ok === true && !event.event)
    expect(result.code).toBe(0)
    expect(started).toBeGreaterThanOrEqual(0)
    expect(done).toBeGreaterThan(started)
    expect(events.filter((event) => event.ok === true && !event.event)).toHaveLength(1)
  }, 30_000)

  it('speaks markup-shaped text literally instead of parsing it as SSML', async () => {
    // An unclosed <voice> tag fails SSML parsing; SPF_IS_NOT_XML must ignore it.
    const text = '<voice required="Name=Missing Voice">你好'
    const events = fixture.parse(await fixture.request([JSON.stringify({ ...speak, text })]))
    expect(events[0]).toMatchObject({ event: 'started' })
    expect(events.some((event) => event.ok === false)).toBe(false)
  }, 30_000)

  it('does not stack pauses: one resume clears a repeated pause', async () => {
    const result = await fixture.live(speak, [
      { on: (event) => event.event === 'started', write: { action: 'pause', id: 1 } },
      { on: (event) => event.event === 'control' && event.id === 1, write: { action: 'pause', id: 2 } },
      { on: (event) => event.event === 'control' && event.id === 2, write: { action: 'resume', id: 3 } },
      { on: (event) => event.event === 'control' && event.id === 3 }
    ], { timeoutMs: 60_000 })
    const controls = result.events.filter(paused)
    expect(controls.map((event) => [event.id, event.paused])).toEqual([[1, true], [2, true], [3, false]])
    expect(result.code).toBe(0)
    expect(result.events.at(-1)).toMatchObject({ ok: true })
  }, 90_000)

  it('reports pause and resume with the request id and the applied state', async () => {
    const result = await fixture.live(speak, [
      { on: (event) => event.event === 'started', write: { action: 'pause', id: 1 } },
      { on: (event) => event.event === 'control', write: { action: 'resume', id: 2 } },
      { on: paused, end: true }
    ])
    const controls = result.events.filter(paused)
    expect(controls.map((event) => [event.id, event.paused])).toEqual([[1, true], [2, false]])
    expect(result.code).toBe(0)
  }, 30_000)

  it('outlives the twenty second startup deadline once it has started', async () => {
    // The runner kills a bridge that never reports `started`; this one reports
    // at once and then stays paused past that deadline. A timer that was not
    // cleared would kill it here instead of letting it finish.
    const result = await fixture.live(speak, [
      { on: (event) => event.event === 'started', write: { action: 'pause', id: 1 } },
      { on: (event) => event.event === 'control', waitMs: 21_500 },
      { write: { action: 'resume', id: 2 } },
      { on: (event) => event.event === 'control' }
    ], { timeoutMs: 60_000 })
    expect(result.ms).toBeGreaterThan(21_000)
    expect(result.code).toBe(0)
    expect(result.events.at(-1)).toMatchObject({ ok: true })
  }, 90_000)

  it('stops on EOF while paused without leaving the helper behind', async () => {
    const result = await fixture.live(speak, [
      { on: (event) => event.event === 'started', write: { action: 'pause', id: 1 } },
      { on: (event) => event.event === 'control', end: true }
    ])
    expect(result.code).toBe(0)
    expect(result.ms).toBeLessThan(5000)
    // The helper under test is the one that must be gone; other suites run in
    // parallel and their own helpers are not this test's business.
    expect(await fixture.leftovers([result.pid])).toEqual([])
  }, 30_000)

  it('refuses malformed requests with one error line and a non-zero exit', async () => {
    for (const line of ['not json', JSON.stringify({ action: 'speak', text: '   ' }), JSON.stringify({ action: 'dance' })]) {
      const result = await fixture.request([line])
      const events = fixture.parse(result)
      expect(result.code).toBe(1)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ ok: false })
    }
  }, 40_000)

  it('exits cleanly when the request is cancelled before speech starts', async () => {
    const result = await fixture.request([JSON.stringify(speak)], { keepOpenMs: 1 })
    expect(result.code).toBe(0)
    expect(result.ms).toBeLessThan(5000)
    expect(fixture.parse(result).some((event) => event.ok === false)).toBe(false)
  }, 30_000)

  it('keeps thirty start/stop cycles free of leftover helpers and handle growth', async () => {
    const pids = []
    const first = await fixture.request([JSON.stringify({ action: 'voices' })])
    pids.push(first.pid)
    const firstSample = await fixture.sample(first.pid)
    for (let index = 0; index < 29; index += 1) {
      const result = await fixture.request([JSON.stringify({ action: 'voices' })])
      expect(result.code).toBe(0)
      pids.push(result.pid)
    }
    const last = await fixture.request([JSON.stringify({ action: 'voices' })])
    pids.push(last.pid)
    const lastSample = await fixture.sample(last.pid)
    // Every helper this test started must exit; a global process count would
    // also see the helpers other suites start in parallel.
    expect(pids).toHaveLength(31)
    expect(await fixture.leftovers(pids)).toEqual([])
    if (typeof firstSample.handles === 'number' && typeof lastSample.handles === 'number') {
      // Per-process samples: a leak would raise the count as work accumulates.
      expect(lastSample.handles).toBeLessThanOrEqual(firstSample.handles + 8)
    }
  }, 120_000)

  it('drives the production runner through the real helper', async () => {
    const run = createSpeechRunner(fixture.available() ? require.resolve('../../native/bin/yu-speech.exe') : '')
    let startedAt = 0
    const result = await run({ ...speak, text: '这是一次通过 SpeechRunner 的朗读。' }, undefined, () => { startedAt = Date.now() })
    expect(result.ok).toBe(true)
    expect(startedAt).toBeGreaterThan(0)
    expect(await run({ action: 'voices' })).toMatchObject({ ok: true })
  }, 40_000)
})
