import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { createSpeechRunner } from './speech'

// The helper under test is the real binary in native/bin, built by
// `pnpm test:native`. Every utterance uses volume 0 and a short sentence, so the
// suite exercises the SAPI protocol without filling the room with speech.
const require = createRequire(import.meta.url)
const fixture = require('../../tests/yu-v2/fixtures/speech-native.cjs') as {
  available: () => boolean
  exe: string
  parse: (result: { events: { at: number; line: string }[] }) => any[]
  request: (lines: string[], options?: { keepOpenMs?: number; timeoutMs?: number }) => Promise<{ code: number | null; closed: boolean; ms: number; events: { at: number; line: string }[]; pid: number }>
  live: (request: object, actions: { on?: (event: any) => boolean; write?: object; end?: boolean; waitMs?: number }[], options?: { timeoutMs?: number }) => Promise<{ code: number | null; ms: number; events: any[]; pid: number }>
  speakCycle: (request: object, options?: { pause?: boolean; sampleAfterMs?: number; stopAfterMs?: number; timeoutMs?: number }) => Promise<{ code: number | null; pid: number; stage: string; sample: { handles?: number; threads?: number; privateKb?: number; missing?: boolean; error?: string } | null; events: any[]; ms: number }>
  powershellVoices: () => Promise<string[] | null>
  probe: (pid: number) => Promise<{ handles?: number; threads?: number; privateKb?: number; missing?: boolean; error?: string }>
  existence: (pids: number[]) => { alive: number[]; unknown: number[] }
  leftovers: (pids: number[], timeoutMs?: number) => Promise<{ living: number[]; unknown: number[] }>
  sleep: (ms: number) => Promise<void>
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

  it('rejects text carrying a NUL instead of speaking a truncated sentence', async () => {
    // The helper builds a wide string for SAPI; a NUL would silently cut the
    // rest, so the request must fail loudly rather than succeed with less text.
    const result = await fixture.request([JSON.stringify({ ...speak, text: '前半句\u0000后半句' })])
    const events = fixture.parse(result)
    expect(result.code).toBe(1)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ ok: false })
    expect(events[0].event).toBeUndefined()
    expect(JSON.stringify(events[0])).not.toContain('前半句')
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
    // Control input is read on the event-wait boundary, which is capped at
    // 50 ms, so the acknowledgement has to arrive well inside a couple of waits.
    const startedAt = result.events.find((event) => event.event === 'started')?.at
    const ackedAt = controls[0]?.at
    expect(typeof startedAt).toBe('number')
    expect(typeof ackedAt).toBe('number')
    expect(ackedAt - startedAt).toBeLessThan(300)
    expect(result.code).toBe(0)
  }, 30_000)

  it('stops on EOF while paused without leaving the helper behind', async () => {
    const result = await fixture.live(speak, [
      { on: (event) => event.event === 'started', write: { action: 'pause', id: 1 } },
      { on: (event) => event.event === 'control', end: true }
    ])
    expect(result.code).toBe(0)
    expect(result.ms).toBeLessThan(5000)
    // Only this test's helper matters; other suites run their own.
    expect(await fixture.leftovers([result.pid])).toEqual({ living: [], unknown: [] })
  }, 30_000)

  it('outlives the twenty second startup deadline through the production runner', async () => {
    // This goes through createSpeechRunner, the component that owns the timer.
    // Without clearing it on `started`, the runner would kill a paused
    // utterance at twenty seconds instead of letting it finish.
    const run = createSpeechRunner(fixture.exe)
    const controller = new AbortController()
    let started = false
    const speaking = run({ ...speak, text: '你好，这是一次通过运行器的长时间朗读测试。' }, controller.signal, () => { started = true })
    while (!started) await fixture.sleep(20)
    expect(await run.control?.('pause')).toMatchObject({ ok: true, paused: true })
    await fixture.sleep(21_500)
    expect(await run.control?.('resume')).toMatchObject({ ok: true, paused: false })
    const result = await speaking
    expect(result.ok).toBe(true)
  }, 90_000)

  it('cancels through the production runner before and during speech', async () => {
    const run = createSpeechRunner(fixture.exe)
    const before = new AbortController()
    const early = run({ ...speak, text: '你好，这是一次启动前取消的测试。' }, before.signal)
    before.abort()
    expect(await early).toMatchObject({ ok: false, error: 'cancelled' })

    const during = new AbortController()
    let started = false
    const speaking = run({ ...speak, text: '你好，这是一次朗读中取消的测试。' }, during.signal, () => { started = true })
    while (!started) await fixture.sleep(20)
    during.abort()
    const cancelled = await speaking
    expect(cancelled).toMatchObject({ ok: false, error: 'cancelled' })
    expect(await run.control?.('pause')).toMatchObject({ ok: false, error: 'No active speech' })
  }, 60_000)

  it('keeps a new utterance independent of the previous, cancelled one', async () => {
    const run = createSpeechRunner(fixture.exe)
    const old = new AbortController()
    let oldStarted = false
    const first = run({ ...speak, text: '你好，这是前一段朗读。' }, old.signal, () => { oldStarted = true })
    while (!oldStarted) await fixture.sleep(20)
    expect(await run.control?.('pause')).toMatchObject({ ok: true, paused: true })

    // The second utterance starts while the first helper is still paused.
    const second = await run({ ...speak, text: '你好，这是后一段朗读。' })
    expect(second.ok).toBe(true)

    // The old helper exiting late must not touch the finished request.
    old.abort()
    expect(await first).toMatchObject({ ok: false, error: 'cancelled' })
    expect(await run.control?.('resume')).toMatchObject({ ok: false, error: 'No active speech' })
  }, 90_000)

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

  it('sees a live process and stops seeing it once it exits', async () => {
    // Positive control: without this, a broken survivor check passes silently.
    expect(fixture.existence([process.pid])).toEqual({ alive: [process.pid], unknown: [] })
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
    const pid = child.pid as number
    expect(fixture.existence([pid]).alive).toEqual([pid])
    child.kill()
    await new Promise((done) => child.on('exit', done))
    expect(await fixture.leftovers([pid], 5000)).toEqual({ living: [], unknown: [] })
  }, 30_000)

  it('speaks thirty times and reaps every helper it started', async () => {
    // Real synthesis each round, not enumeration: voices never opens the audio
    // path, so it cannot show whether that path leaks.
    const pids: number[] = []
    const samples: { handles?: number; threads?: number; privateKb?: number; missing?: boolean; error?: string }[] = []
    for (let index = 0; index < 30; index += 1) {
      // Pause before sampling: a paused helper is unambiguously alive, so a
      // sample of an exited process fails loudly instead of reading as clean.
      const cycle = await fixture.speakCycle({ ...speak, text: '你好。' }, { pause: true, sampleAfterMs: 200 })
      pids.push(cycle.pid)
      expect(cycle.code).toBe(0)
      expect(cycle.events.some((event: any) => event.event === 'started')).toBe(true)
      if (index === 0 || index === 14 || index === 29) {
        expect(cycle.sample, `no sample while helper ${cycle.pid} was ${cycle.stage}`).not.toBeNull()
        const sample = cycle.sample as { handles?: number; threads?: number; privateKb?: number; missing?: boolean; error?: string }
        // A sample taken from an already exited process would be an empty
        // object; that must fail rather than skip the assertion.
        expect(sample.missing, `helper ${cycle.pid} had already exited when sampled`).not.toBe(true)
        expect(sample.error).toBeUndefined()
        expect(typeof sample.handles).toBe('number')
        expect(typeof sample.threads).toBe('number')
        expect(typeof sample.privateKb).toBe('number')
        samples.push(sample)
      }
    }
    expect(pids).toHaveLength(30)
    expect(await fixture.leftovers(pids)).toEqual({ living: [], unknown: [] })
    const first = samples[0].handles as number
    const last = samples.at(-1)?.handles as number
    // Per-process samples: a leak would raise the count as work accumulates.
    expect(last).toBeLessThanOrEqual(first + 8)
  }, 240_000)

  it('drives the production runner through the real helper', async () => {
    const run = createSpeechRunner(fixture.exe)
    let startedAt = 0
    const result = await run({ ...speak, text: '这是一次通过 SpeechRunner 的朗读。' }, undefined, () => { startedAt = Date.now() })
    expect(result.ok).toBe(true)
    expect(startedAt).toBeGreaterThan(0)
    expect(await run({ action: 'voices' })).toMatchObject({ ok: true })
  }, 40_000)
})
