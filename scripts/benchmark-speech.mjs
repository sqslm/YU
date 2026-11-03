/**
 * Compares the PowerShell speech host with the Rust helper on the same machine,
 * text, voice, rate and volume. Voices and speak are measured separately: the
 * enumeration never opens the audio device, and the speak runs use volume 0 so
 * the room stays quiet while the engine still paces real synthesis.
 *
 *   node scripts/benchmark-speech.mjs [--samples 20] [--text '…'] [--voice '…']
 *
 * The script writes tests/yu-v2/evidence/rust-speech-20261104.json and prints a
 * table. Memory and CPU are sampled from the helper process itself; the parent
 * Node process is never used as a proxy for helper cost.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const samples = Number(option('samples', '10'))
const text = option('text', '你好，这是一次本地朗读测试。')
const voice = option('voice', 'Microsoft Huihui Desktop')
const rate = Number(option('rate', '0'))
const volume = Number(option('volume', '0'))
const output = resolve(root, option('output', 'tests/yu-v2/evidence/rust-speech-20261104.json'))
const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const hosts = {
  powershell: { command: shell, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'resources', 'speech.ps1')] },
  native: { command: resolve(root, option('exe', 'native/bin/yu-speech.exe')), args: [] }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Reads the helper's RSS/private bytes, threads and CPU in one probe. */
function probe(pid) {
  return new Promise((done) => {
    const script = [
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
      'if (-not $p) { "{}"; exit 0 }',
      '$g = Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue',
      '[pscustomobject]@{ privateKb = [math]::Round($p.PrivatePageCount / 1kb, 1); workingKb = [math]::Round($p.WorkingSetSize / 1kb, 1); threads = $p.ThreadCount; handles = $p.HandleCount; cpuMs = if ($g) { [math]::Round($g.TotalProcessorTime.TotalMilliseconds, 1) } else { $null } } | ConvertTo-Json -Compress'
    ].join('; ')
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('exit', () => {
      try { done(JSON.parse(out.trim() || '{}')) } catch { done({}) }
    })
    child.on('error', () => done({}))
    setTimeout(() => { try { child.kill() } catch {} }, 10_000)
  })
}

/** Runs one request and returns timings plus the helper's own resource sample. */
function run(name, request, { keepOpenMs = 0 } = {}) {
  const host = hosts[name]
  return new Promise((done) => {
    const started = performance.now()
    const child = spawn(host.command, host.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let buffer = ''
    const events = []
    let exitCode = null
    let settled = false
    let sample = null
    const finish = () => {
      if (settled) return
      settled = true
      done({ host: name, pid: child.pid, exitCode, ms: Math.round(performance.now() - started), events, sample })
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        const at = Math.round(performance.now() - started)
        let parsed = null
        try { parsed = JSON.parse(line) } catch { parsed = { raw: line } }
        events.push({ at, ...parsed })
        if (parsed.event === 'started') {
          setTimeout(async () => { sample = await probe(child.pid) }, 300)
        }
        if (keepOpenMs && parsed.ok === true && !parsed.event && parsed.voices) {
          setTimeout(() => child.stdin.end(), keepOpenMs)
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', () => {})
    child.on('error', (error) => { events.push({ at: -1, error: String(error) }); exitCode = -1 })
    child.on('exit', (code) => { exitCode = code; setTimeout(finish, 200) })
    child.stdin.write(JSON.stringify(request) + '\n')
    if (request.action !== 'speak') child.stdin.end()
    setTimeout(() => { try { child.kill() } catch {} }, 60_000)
  })
}

function stats(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))]
  return { count: sorted.length, min: sorted[0], p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] }
}

const round = (value) => (value == null ? null : Math.round(value * 10) / 10)

async function collect(kind, order, total) {
  const runs = { powershell: [], native: [] }
  for (let round = 0; round < total; round += 1) {
    for (const name of order) {
      const request = kind === 'voices' ? { action: 'voices' } : { action: 'speak', text, voice, rate, volume }
      const result = await run(name, request)
      const startedEvent = result.events.find((event) => event.event === 'started')
      const finished = result.events.some((event) => event.ok === true && !event.event)
      runs[name].push({
        kind,
        startedMs: startedEvent?.at ?? null,
        finished,
        totalMs: result.ms,
        exitCode: result.exitCode,
        privateKb: result.sample?.privateKb ?? null,
        workingKb: result.sample?.workingKb ?? null,
        threads: result.sample?.threads ?? null,
        handles: result.sample?.handles ?? null,
        cpuMs: result.sample?.cpuMs ?? null,
        voices: result.events.find((event) => Array.isArray(event.voices))?.voices ?? null,
        error: result.events.find((event) => event.ok === false)?.error ?? null
      })
      await sleep(250)
    }
  }
  return runs
}

const summary = (records, key) => stats(records.map((record) => record[key]))

function compare(base, next, key) {
  const a = summary(base, key)
  const b = summary(next, key)
  if (!a || !b || !a.p95 || !b.p95) return { p50Pct: null, p95Pct: null, p95Delta: null }
  return {
    p50Pct: round(((b.p50 - a.p50) / a.p50) * 100),
    p95Pct: round(((b.p95 - a.p95) / a.p95) * 100),
    p95Delta: round(b.p95 - a.p95)
  }
}

console.log(`speech benchmark: ${samples} sample rounds per host, text ${JSON.stringify(text)}, voice ${JSON.stringify(voice)}`)

// Warm both hosts so their first-run page cache and SAPI initialisation do not
// land on the measured samples.
for (const name of ['powershell', 'native']) {
  await run(name, { action: 'voices' })
  await run(name, { action: 'speak', text, voice, rate, volume })
}

const voices = await collect('voices', ['powershell', 'native', 'native', 'powershell'], samples)
const speak = await collect('speak', ['powershell', 'native', 'native', 'powershell'], samples)

const voicesOk = Object.entries(voices).every(([name, records]) => records.every((record) => record.exitCode === 0 && record.voices))
const nativeVoices = voices.native[0]?.voices
const powershellVoices = voices.powershell[0]?.voices
const sameVoices = JSON.stringify(nativeVoices) === JSON.stringify(powershellVoices)
const speakOk = Object.entries(speak).every(([name, records]) => records.every((record) => record.exitCode === 0 && record.finished))

const report = {
  kind: 'speech-host-comparison',
  date: new Date().toISOString(),
  platform: { os: process.env.OS ?? 'windows', node: process.version },
  scope: {
    voices: 'one process per sample, request answered and exited',
    speak: `one utterance (${text.length} chars), rate ${rate}, volume ${volume}; started is the host's own start event`,
    memory: 'sampled from the helper process 300 ms after started',
    excluded: ['cloud TTS', 'playback of provider audio', 'SSML/markup', 'renderer/UI', 'multi-utterance sessions']
  },
  settings: { text, voice, rate, volume, samplesPerHost: samples },
  voices: {
    powershell: powerSummary(voices.powershell),
    native: powerSummary(voices.native),
    identical: sameVoices,
    sample: { powershell: powershellVoices, native: nativeVoices }
  },
  speak: {
    powershell: powerSummary(speak.powershell),
    native: powerSummary(speak.native),
    comparison: {
      total: compare(speak.powershell, speak.native, 'totalMs'),
      started: compare(speak.powershell, speak.native, 'startedMs'),
      privateKb: compare(speak.powershell, speak.native, 'privateKb'),
      workingKb: compare(speak.powershell, speak.native, 'workingKb')
    }
  },
  checks: { voicesOk, sameVoices, speakOk },
  raw: { voices, speak }
}

function powerSummary(records) {
  const first = records[0] ?? {}
  return {
    count: records.length,
    ok: records.every((record) => record.exitCode === 0),
    totalMs: summary(records, 'totalMs'),
    startedMs: summary(records, 'startedMs'),
    privateKb: summary(records, 'privateKb'),
    workingKb: summary(records, 'workingKb'),
    cpuMs: summary(records, 'cpuMs'),
    handles: summary(records, 'handles'),
    threads: summary(records, 'threads'),
    error: first.error ?? null
  }
}

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, JSON.stringify(report, null, 2) + '\n')

const cells = (label, host) => [label, host.totalMs?.p50, host.totalMs?.p95, host.startedMs?.p50, host.startedMs?.p95, host.privateKb?.p50, host.workingKb?.p50, host.cpuMs?.p50]
console.table([
  cells('voices PS', report.voices.powershell),
  cells('voices Rust', report.voices.native),
  cells('speak PS', report.speak.powershell),
  cells('speak Rust', report.speak.native)
].map((row) => Object.fromEntries(['host', 'total p50', 'total p95', 'start p50', 'start p95', 'private p50', 'working p50', 'cpu p50'].map((key, index) => [key, row[index]]))))

console.log('voices identical:', sameVoices, '| voices ok:', voicesOk, '| speak ok:', speakOk)
console.log('speak comparison:', JSON.stringify(report.speak.comparison))
console.log('evidence:', output)
