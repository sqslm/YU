import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The helper under test is the real binary in native/bin, built by `pnpm test:native`.
// Speech is synthesised locally, so the corpus holds no recorded audio.
const require = createRequire(import.meta.url)
const fixture = require('../../tests/yu-v2/fixtures/wake-native.cjs') as {
  EXE: string
  devices: () => { devices?: { id: string; name: string }[] }
  learn: (options: { phrase: string; samples: Buffer[] }) => Promise<{ samples: { text: string; phones: string }[] }>
  listen: (options: {
    config: object | string
    keepOpenMs?: number
    timeoutMs?: number
  }) => Promise<{ code: number | null; ms: number; events: any[]; stderr: string }>
  synthesize: (directory: string) => Record<string, string>
  workspace: () => string
}

const available = process.platform === 'win32' && existsSync(fixture.EXE)
const phrase = '你好，胡小杨'
let directory = ''
let corpus: Record<string, string> = {}

function wakes(events: any[]): any[] {
  return events.filter((event) => event.type === 'wake')
}

beforeAll(() => {
  if (!available) return
  directory = fixture.workspace()
  corpus = fixture.synthesize(directory)
})

afterAll(async () => {
  if (!directory) return
  const { rm } = await import('node:fs/promises')
  await rm(directory, { recursive: true, force: true })
})

describe.skipIf(!available)('rust wake helper', () => {
  it('wakes once on the complete phrase and ends the session on the stream-end event', async () => {
    const result = await fixture.listen({ config: { phrase, language: 'zh', wave: corpus.complete, device: '' } })
    const found = wakes(result.events)
    expect(result.code).toBe(0)
    expect(found).toHaveLength(1)
    // The helper echoes the configured phrase, punctuation included.
    expect(found[0].phrase).toBe(phrase)
    expect(found[0].confidence).toBeGreaterThanOrEqual(0.8)
    expect(found[0].durationMs).toBeGreaterThanOrEqual(300)
    expect(found[0].durationMs).toBeLessThanOrEqual(9000)
    // The engine's SPPEI_END_SR_STREAM arrives when the file is consumed, so the helper
    // exits with the audio instead of waiting out a deadline.
    expect(result.ms).toBeLessThan(3000)
  }, 60_000)

  it('wakes on a phrase followed by a command', async () => {
    const result = await fixture.listen({ config: { phrase, language: 'zh', wave: corpus.command, device: '' } })
    expect(result.code).toBe(0)
    expect(wakes(result.events)).toHaveLength(1)
  }, 60_000)

  it('joins the two halves of a phrase separated by a short silence', async () => {
    const result = await fixture.listen({ config: { phrase, language: 'zh', wave: corpus.split, device: '' } })
    expect(result.code).toBe(0)
    const found = wakes(result.events)
    expect(found).toHaveLength(1)
    expect(found[0].durationMs).toBeGreaterThan(1000)
  }, 60_000)

  it('accepts a homophone the engine spells differently', async () => {
    const result = await fixture.listen({ config: { phrase, language: 'zh', wave: corpus.homophone, device: '' } })
    expect(result.code).toBe(0)
    expect(wakes(result.events)).toHaveLength(1)
  }, 60_000)

  it('stays silent on partial phrases, phrases inside a sentence, and unrelated speech', async () => {
    for (const name of ['partial', 'embedded', 'unrelated']) {
      const result = await fixture.listen({ config: { phrase, language: 'zh', wave: corpus[name], device: '' } })
      expect(result.code, name).toBe(0)
      expect(wakes(result.events), name).toHaveLength(0)
      expect(result.events.some((event) => event.type === 'error'), name).toBe(false)
    }
  }, 120_000)

  it('wakes after ten seconds of leading silence and refuses a ten second internal gap', async () => {
    // Live input paces the audio and reports levels, which is what the utterance-start
    // rule needs; played back in real time so the silence is real silence.
    const leading = await fixture.listen({ config: { phrase, language: 'zh', wave: '', device: '', stream: corpus['lead-silence'] } })
    expect(leading.code).toBe(0)
    expect(wakes(leading.events)).toHaveLength(1)
    const gap = await fixture.listen({ config: { phrase, language: 'zh', wave: '', device: '', stream: corpus['long-gap'] } })
    expect(gap.code).toBe(0)
    // Carry only bridges gaps up to three seconds, so the halves stay unrelated.
    expect(wakes(gap.events)).toHaveLength(0)
  }, 120_000)

  it('joins a phrase split by a two second pause', async () => {
    const result = await fixture.listen({ config: { phrase: '你好，阿语', language: 'zh', wave: corpus.pause2s, device: '' } })
    expect(result.code).toBe(0)
    expect(wakes(result.events)).toHaveLength(1)
  }, 60_000)

  it('stays silent on white noise', async () => {
    const result = await fixture.listen({ config: { phrase, language: 'zh', wave: corpus.noise, device: '' } })
    expect(result.code).toBe(0)
    expect(wakes(result.events)).toHaveLength(0)
  }, 60_000)

  it('reports the device it actually listens to when the remembered one is gone', async () => {
    const result = await fixture.listen({
      config: { phrase, language: 'zh', wave: '', device: '9' },
      keepOpenMs: 1200,
    })
    expect(result.code).toBe(0)
    expect(result.events.some((event) => event.type === 'log' && event.reason === 'device-missing')).toBe(true)
    const device = result.events.find((event) => event.type === 'device')
    expect(device?.name).toBeTruthy()
    expect(result.events.some((event) => event.type === 'ready')).toBe(true)
    // Closing the pipe is the stop signal; the helper must not linger.
    expect(result.ms).toBeLessThan(8000)
  }, 60_000)

  it('fails a malformed configuration without hanging', async () => {
    const result = await fixture.listen({ config: '{"phrase":""}' })
    expect(result.code).toBe(1)
    expect(result.events.at(-1)).toMatchObject({ type: 'error', error: 'unavailable' })
  }, 30_000)

  it('recognises audio pushed through the capture stream contract', async () => {
    const result = await fixture.listen({ config: { phrase, language: 'zh', wave: '', device: '', stream: corpus.complete } })
    expect(result.code).toBe(0)
    expect(wakes(result.events)).toHaveLength(1)
  }, 60_000)

  it('accepts the variants the PowerShell host learned, pronunciation included', async () => {
    // The old host still trains: three samples through `mode: "learn"`. Its stored phones are
    // the IPA the Rust listener now derives from the engine's UPS, so this pins the two ends
    // of the conversion against real output from both.
    const { readFileSync } = await import('node:fs')
    const sample = readFileSync(corpus.homophone)
    const learned = await fixture.learn({ phrase: '你好胡晓阳', samples: [sample, sample, sample] })
    expect(learned.samples).toHaveLength(3)
    for (const row of learned.samples as { text: string; phones: string }[]) {
      expect(row.phones).toBe('nihaʊhuɕjaʊjɑŋ')
    }
    const variants = (learned.samples as { text: string; phones: string }[]).map((row) => ({ text: row.text, phones: row.phones }))
    const result = await fixture.listen({ config: { phrase, language: 'zh', wave: corpus.homophone, device: '', variants } })
    expect(result.code).toBe(0)
    expect(wakes(result.events)).toHaveLength(1)
  }, 120_000)

  it('enumerates the waveIn devices with string ids', () => {
    const payload = fixture.devices()
    expect(Array.isArray(payload.devices)).toBe(true)
    for (const device of payload.devices!) {
      expect(typeof device.id).toBe('string')
      expect(device.name.length).toBeGreaterThan(0)
    }
  }, 30_000)
})
