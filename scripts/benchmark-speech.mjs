/**
 * Compares the PowerShell speech host with the Rust helper on the same machine,
 * text, voice, rate and volume. Voices and speak are measured separately: the
 * enumeration never opens the audio device, and the speak runs use volume 0 so
 * the room stays quiet while the engine still paces real synthesis.
 *
 *   node scripts/benchmark-speech.mjs [--samples 20] [--text '…'] [--voice '…']
 *
 * Timing boundaries are the real ones: everything is measured from the moment
 * the request is written to the moment the child's stdio is closed, so no
 * artificial delay is folded into the total. Resource numbers are a snapshot
 * taken while the helper is alive and are labelled as such — they are not a
 * lifetime CPU figure.
 *
 * The script writes tests/yu-v2/evidence/rust-speech-correctness-20261104.json
 * and exits non-zero when a check fails.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const rounds = Number(option('samples', '10'))
const text = option('text', '你好，这是一次本地朗读测试。')
const voice = option('voice', 'Microsoft Huihui Desktop')
const rate = Number(option('rate', '0'))
const volume = Number(option('volume', '0'))
const exe = resolve(root, option('exe', 'native/bin/yu-speech.exe'))
const output = resolve(root, option('output', 'tests/yu-v2/evidence/rust-speech-correctness-20261104.json'))
const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const hosts = {
  powershell: { command: shell, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'resources', 'speech.ps1')] },
  native: { command: exe, args: [] }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Reads the helper's private bytes, working set, threads, handles and CPU. */
function probe(pid) {
  return new Promise((done) => {
    const script = [
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
      'if (-not $p) { \'{"missing":true}\'; exit 0 }',
      `$g = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
      '[pscustomobject]@{ privateKb = [math]::Round($p.PrivatePageCount / 1kb, 1); workingKb = [math]::Round($p.WorkingSetSize / 1kb, 1); threads = $p.ThreadCount; handles = $p.HandleCount; cpuMs = if ($g) { [math]::Round($g.TotalProcessorTime.TotalMilliseconds, 1) } else { $null } } | ConvertTo-Json -Compress'
    ].join('; ')
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    let out = ''
    let settled = false
    let timer = null
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done({ ...value, atMs: Math.round(performance.now() - t0) })
    }
    const t0 = performance.now()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('close', () => {
      try { finish(JSON.parse(out.trim() || '{}')) } catch { finish({ error: 'unreadable probe output' }) }
    })
    child.on('error', (error) => finish({ error: String(error) }))
    timer = setTimeout(() => { try { child.kill() } catch {} finish({ error: 'probe timeout' }) }, 15_000)
  })
}

/**
 * Runs one request. Resolves on `close`, so the reported total covers the whole
 * child lifetime and drained pipes; no extra wait is added on top.
 */
function run(name, request, { round = 0, sampleAfterMs = 300 } = {}) {
  const host = hosts[name]
  return new Promise((done) => {
    const started = performance.now()
    let child
    try {
      child = spawn(host.command, host.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      done({ host: name, round, spawnError: String(error), events: [], code: -1, valid: false })
      return
    }
    const events = []
    let buffer = ''
    let writeAtMs = null
    let writeError = null
    let sample = null
    let sampleTask = null
    let settled = false
    const timers = []
    const finish = (extra = {}) => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      Promise.resolve(sampleTask).then(() => done({
        host: name,
        round,
        pid: child.pid,
        events,
        sample,
        writeAtMs,
        writeError,
        sampleAtMs: sample?.atMs ?? null,
        ...extra
      }))
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
        if (parsed.event === 'started' && !sampleTask) {
          // Alive-only snapshot: a sample of an already exited helper would be
          // an empty object and is reported as such, not silently used.
          sampleTask = sleep(sampleAfterMs).then(() => probe(child.pid)).then((value) => { sample = { ...value, ofPid: child.pid } })
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', () => {})
    child.stdin.on('error', (error) => { writeError = String(error) })
    child.on('error', (error) => finish({ code: -1, spawnError: String(error), closed: false }))
    child.on('close', (code, signal) => {
      const closedAt = Math.round(performance.now() - started)
      if (buffer.trim()) events.push({ at: closedAt, raw: buffer.trim() })
      finish({ code, signal, closed: true, closedAtMs: closedAt })
    })
    timers.push(setTimeout(() => { try { child.kill() } catch {} }, 60_000))
    try {
      child.stdin.write(JSON.stringify(request) + '\n')
      writeAtMs = Math.round(performance.now() - started)
    } catch (error) {
      writeError = String(error)
    }
    if (request.action !== 'speak') child.stdin.end()
  })
}

/** Percentile over the samples that passed validation; raw stays in the report. */
function stats(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))]
  return { count: sorted.length, min: sorted[0], p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] }
}

const round = (value) => (value == null ? null : Math.round(value * 10) / 10)

function record(result, kind) {
  const started = result.events.find((event) => event.event === 'started') ?? null
  const terminal = result.events.find((event) => event.ok === true && !event.event) ?? null
  const failure = result.events.find((event) => event.ok === false) ?? null
  const voices = result.events.find((event) => Array.isArray(event.voices))?.voices ?? null
  const ok = result.code === 0 && (kind === 'voices' ? Array.isArray(voices) : terminal !== null)
  return {
    kind,
    host: result.host,
    round: result.round,
    pid: result.pid ?? null,
    ok,
    code: result.code ?? null,
    spawnError: result.spawnError ?? null,
    writeError: result.writeError ?? null,
    writeAtMs: result.writeAtMs ?? null,
    startedMs: started ? started.at : null,
    terminalMs: terminal ? terminal.at : null,
    closedAtMs: result.closedAtMs ?? null,
    // Whole child lifetime, measured to pipes-drained close: the request cost
    // without any artificial completion delay.
    totalMs: result.closedAtMs ?? null,
    sampleAtMs: result.sampleAtMs ?? null,
    privateKb: Number.isFinite(result.sample?.privateKb) ? result.sample.privateKb : null,
    workingKb: Number.isFinite(result.sample?.workingKb) ? result.sample.workingKb : null,
    threads: Number.isFinite(result.sample?.threads) ? result.sample.threads : null,
    handles: Number.isFinite(result.sample?.handles) ? result.sample.handles : null,
    // Per-sample CPU is the process total at the moment of the snapshot; it is
    // not the CPU of the whole utterance and is labelled that way.
    cpuSnapshotMs: Number.isFinite(result.sample?.cpuMs) ? result.sample.cpuMs : null,
    voices,
    error: failure?.error ?? null
  }
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

async function collect(kind, order, total) {
  const runs = { powershell: [], native: [] }
  for (let index = 0; index < total; index += 1) {
    for (const name of order) {
      const request = kind === 'voices' ? { action: 'voices' } : { action: 'speak', text, voice, rate, volume }
      runs[name].push(record(await run(name, request, { round: index }), kind))
      await sleep(150)
    }
  }
  return runs
}

function hostSummary(records) {
  const ok = records.filter((record) => record.ok)
  return {
    requests: records.length,
    valid: ok.length,
    failed: records.length - ok.length,
    totalMs: summary(ok, 'totalMs'),
    startedMs: summary(ok, 'startedMs'),
    privateKb: summary(ok, 'privateKb'),
    workingKb: summary(ok, 'workingKb'),
    handles: summary(ok, 'handles'),
    threads: summary(ok, 'threads'),
    cpuSnapshotMs: summary(ok, 'cpuSnapshotMs'),
    failures: records.filter((record) => !record.ok).map((record) => ({ round: record.round, code: record.code, error: record.error, spawnError: record.spawnError }))
  }
}

const binaryHash = (() => {
  try { return createHash('sha256').update(readFileSync(exe)).digest('hex') } catch { return null }
})()

console.log(`speech benchmark: ${rounds} rounds per ordering slot, text ${JSON.stringify(text)}, voice ${JSON.stringify(voice)}`)

// Warm both hosts so their first-run page cache and SAPI initialisation do not
// land on the measured samples.
for (const name of ['powershell', 'native']) {
  await run(name, { action: 'voices' })
  await run(name, { action: 'speak', text, voice, rate, volume })
}

const voices = await collect('voices', ['powershell', 'native', 'native', 'powershell'], rounds)
const speak = await collect('speak', ['powershell', 'native', 'native', 'powershell'], rounds)

const nativeVoices = voices.native.find((record) => record.voices)?.voices ?? null
const powershellVoices = voices.powershell.find((record) => record.voices)?.voices ?? null
const sameVoices = JSON.stringify(nativeVoices) === JSON.stringify(powershellVoices)
const voicesOk = [...voices.powershell, ...voices.native].every((record) => record.ok)
const speakOk = [...speak.powershell, ...speak.native].every((record) => record.ok)

const report = {
  kind: 'speech-host-comparison',
  version: 2,
  date: new Date().toISOString(),
  platform: { os: process.env.OS ?? 'windows', node: process.version },
  binary: { path: 'native/bin/yu-speech.exe', bytes: (() => { try { return readFileSync(exe).length } catch { return null } })(), sha256: binaryHash },
  scope: {
    voices: 'one process per sample; the request is answered and the process exits',
    speak: `one utterance (${text.length} chars), rate ${rate}, volume ${volume}; started is the host's own start event`,
    timing: 'total is request write to stdio close; no artificial completion delay is added',
    memory: 'one snapshot per sample, taken ~300 ms after started while the helper is alive (not a peak)',
    cpu: 'process-total CPU at the snapshot moment, not the CPU of the whole utterance',
    excluded: ['cloud TTS', 'playback of provider audio', 'SSML/markup', 'renderer/UI', 'multi-utterance sessions']
  },
  settings: { text, voice, rate, volume, roundsPerSlot: rounds, order: ['powershell', 'native', 'native', 'powershell'] },
  voices: {
    powershell: hostSummary(voices.powershell),
    native: hostSummary(voices.native),
    identical: sameVoices,
    sample: { powershell: powershellVoices, native: nativeVoices }
  },
  speak: {
    powershell: hostSummary(speak.powershell),
    native: hostSummary(speak.native),
    comparison: {
      total: compare(speak.powershell.filter((r) => r.ok), speak.native.filter((r) => r.ok), 'totalMs'),
      started: compare(speak.powershell.filter((r) => r.ok), speak.native.filter((r) => r.ok), 'startedMs'),
      privateKb: compare(speak.powershell.filter((r) => r.ok), speak.native.filter((r) => r.ok), 'privateKb'),
      workingKb: compare(speak.powershell.filter((r) => r.ok), speak.native.filter((r) => r.ok), 'workingKb')
    }
  },
  checks: { voicesOk, sameVoices, speakOk, nativeValidSamples: speak.native.filter((record) => record.ok).length, powershellValidSamples: speak.powershell.filter((record) => record.ok).length },
  raw: { voices, speak }
}

// Adoption thresholds from the delivery plan, re-evaluated on this run.
const comparison = report.speak.comparison
report.adoption = {
  memoryPct: comparison.privateKb.p50Pct,
  memoryMeets: comparison.privateKb.p50Pct !== null && comparison.privateKb.p50Pct <= -30,
  startedP95Pct: comparison.started.p95Pct,
  startedP95DeltaMs: comparison.started.p95Delta,
  startedMeets: comparison.started.p95Pct !== null && comparison.started.p95Pct <= -25 && comparison.started.p95Delta <= -100,
  decision: comparison.privateKb.p50Pct !== null && comparison.privateKb.p50Pct <= -30 ? 'memory' : (comparison.started.p95Pct !== null && comparison.started.p95Pct <= -25 && comparison.started.p95Delta <= -100 ? 'startup' : 'below-threshold')
}

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, JSON.stringify(report, null, 2) + '\n')

const row = (label, host) => ({
  host: label,
  requests: host.requests,
  valid: host.valid,
  'start p50': host.startedMs?.p50 ?? null,
  'start p95': host.startedMs?.p95 ?? null,
  'total p50': host.totalMs?.p50 ?? null,
  'private p50': host.privateKb?.p50 ?? null,
  'working p50': host.workingKb?.p50 ?? null,
  'cpu snapshot p50': host.cpuSnapshotMs?.p50 ?? null
})
console.table([row('voices PS', report.voices.powershell), row('voices Rust', report.voices.native), row('speak PS', report.speak.powershell), row('speak Rust', report.speak.native)])
console.log('voices identical:', sameVoices, '| voices ok:', voicesOk, '| speak ok:', speakOk)
console.log('speak comparison:', JSON.stringify(comparison))
console.log('adoption:', JSON.stringify(report.adoption))
console.log('evidence:', output)

const failed = !voicesOk || !sameVoices || !speakOk || report.checks.nativeValidSamples < 20 || report.checks.powershellValidSamples < 20
if (failed) {
  console.error('speech benchmark checks failed; see', output)
  process.exitCode = 1
}
