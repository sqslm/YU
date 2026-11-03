// Measures the resident wake helper: device enumeration, time to the first ready
// event, and the CPU / private memory of a settled listening session. No Electron
// API is needed, so the helpers are spawned directly from this script.
//
// Listening is measured on a synthetic wave by default: the helper is configured with
// a wave path, so no capture device is opened and no room audio is involved. A real
// input has to be asked for with --device.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// A single long-lived sampler costs less than spawning a query per sample. It lives in
// the temp directory so the repository stays free of measurement scratch files.
const sampler = join(tmpdir(), `yu-wake-sample-${process.pid}.ps1`)
writeFileSync(sampler, '\uFEFF' + `param([int]$TargetPid, [int]$IntervalMs = 250)
$p = [System.Diagnostics.Process]::GetProcessById($TargetPid)
while ($true) {
  try { $p.Refresh() } catch { break }
  if ($p.HasExited) { break }
  '{0} {1} {2}' -f $p.WorkingSet64, $p.PrivateMemorySize64, [int]$p.TotalProcessorTime.TotalMilliseconds
  Start-Sleep -Milliseconds $IntervalMs
}
`)
process.on('exit', () => { try { unlinkSync(sampler) } catch { /* already gone */ } })
const powershell = process.env.SystemRoot ? resolve(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : 'powershell.exe'

const helpers = {
  powershell: {
    command: powershell,
    args: (extra) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve(root, 'resources/voice-wake.ps1'), ...(extra ?? [])],
    enumerate: ['-ListDevices']
  },
  native: {
    command: resolve(root, 'native/bin/yu-wake.exe'),
    args: (extra) => [...(extra ?? [])],
    enumerate: ['--list-devices']
  }
}

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index < 0 ? fallback : args[index + 1]
}
const output = resolve(root, option('--output', 'tests/yu-v2/evidence/rust-wake-listener-20261103.json'))
const samples = Number(option('--samples', '20'))
const warmupMs = Number(option('--warmup', '2000'))
const windowMs = Number(option('--window', '6000'))
const phrase = option('--phrase', '你好，胡小杨')
let wave = option('--wave', '')
const device = option('--device', '')
const deadlineMs = Number(option('--deadline', '30000'))

const wait = (ms) => new Promise((done) => setTimeout(done, ms))

// Listening is measured on synthesized speech, so no capture device is opened and no
// room audio is involved. The wave is generated once per run into the temp directory.
const synthesize = async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yu-wake-benchmark-'))
  const wavePath = join(directory, 'benchmark.wav')
  const script = join(directory, 'synth.ps1')
  writeFileSync(script, [
    '﻿param([string]$Path, [string]$Phrase)',
    'Add-Type -AssemblyName System.Speech',
    '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    '$synth.SetOutputToWaveFile($Path, $format)',
    '$synth.Speak($Phrase)',
    '$synth.Dispose()',
  ].join(String.fromCharCode(10)))
  const child = spawn(
    powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, wavePath, Array.from({ length: 12 }, () => phrase).join('，')],
    { windowsHide: true },
  )
  const code = await new Promise((done) => child.on('close', done))
  if (code !== 0) throw new Error(`wave synthesis failed with ${code}`)
  process.on('exit', () => rmSync(directory, { recursive: true, force: true }))
  return wavePath
}

const closeWithin = (child, ms) => new Promise((done) => {
  if (child.exitCode !== null || child.signalCode !== null) return done(true)
  const timer = setTimeout(() => { child.kill('SIGKILL'); done(false) }, ms)
  child.on('close', () => { clearTimeout(timer); done(true) })
})

const sample = (pid, onPoint, onError) => {
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', sampler, String(pid)], { windowsHide: true })
  let buffer = ''
  let pending = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const [workingSet, privateBytes, cpuMs] = line.trim().split(' ').map(Number)
      if (!Number.isFinite(privateBytes)) { pending = `unreadable sampler line: ${line.trim().slice(0, 40)}`; continue }
      onPoint({ at: performance.now(), workingSetKb: workingSet / 1024, privateKb: privateBytes / 1024, cpuMs })
    }
  })
  child.stderr.on('data', (chunk) => { pending = String(chunk).trim().slice(0, 200) })
  // A sampler that dies silently would turn every number into a zero, so the failure is
  // kept and surfaced by the caller instead of being swallowed.
  child.on('error', (error) => onError(`sampler failed: ${error.message}`))
  child.on('close', (code) => { if (code !== 0) onError(pending || `sampler exited with ${code}`) })
  return () => child.kill()
}

const finite = (values) => values.filter((value) => value !== null && Number.isFinite(value))

const stats = (values) => {
  const sorted = [...finite(values)].sort((left, right) => left - right)
  if (!sorted.length) return { count: 0, p50: null, p95: null, min: null, max: null }
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))]
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), min: sorted[0], max: sorted[sorted.length - 1] }
}

const enumerate = async (name) => {
  const helper = helpers[name]
  if (!existsSync(helper.command)) return { helper: name, error: 'missing executable' }
  const started = performance.now()
  const child = spawn(helper.command, helper.args(helper.enumerate), { windowsHide: true })
  const errors = []
  const points = []
  const stop = sample(child.pid, (point) => points.push(point), (message) => errors.push(message))
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const outcome = await Promise.race([
    new Promise((done) => child.on('close', (code) => done({ code }))),
    wait(deadlineMs).then(() => ({ timeout: true }))
  ])
  if (outcome.timeout) { child.kill('SIGKILL'); await closeWithin(child, 5000) }
  const wallMs = performance.now() - started
  stop()
  const devices = stdout.split('\n').map((line) => { try { return JSON.parse(line) } catch { return null } }).find((event) => event?.type === 'devices')
  return {
    helper: name,
    wallMs,
    pid: child.pid,
    exitCode: outcome.timeout ? null : outcome.code,
    timeout: Boolean(outcome.timeout),
    peakPrivateKb: points.length ? Math.max(...points.map((point) => point.privateKb)) : null,
    deviceCount: devices?.devices?.length ?? null,
    error: outcome.timeout ? 'enumeration exceeded its deadline' : errors[0] ?? (outcome.code ? stderr.trim().slice(0, 200) || `exit ${outcome.code}` : null),
    points: points.length
  }
}

const listen = async (name) => {
  const helper = helpers[name]
  if (!existsSync(helper.command)) return { helper: name, error: 'missing executable' }
  const started = performance.now()
  const errors = []
  const points = []
  const child = spawn(helper.command, helper.args(), { windowsHide: true })
  const stop = sample(child.pid, (point) => points.push(point), (message) => errors.push(message))
  let buffer = ''
  let stderr = ''
  const events = []
  let ready = null
  let failure = null
  const wakes = []
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      let event = null
      try { event = JSON.parse(line) } catch { continue }
      events.push(event.type)
      if (event.type === 'ready' && ready === null) ready = { at: performance.now(), cpuMs: points.length ? points[points.length - 1].cpuMs : null }
      if (event.type === 'error' && failure === null) failure = event.error
      if (event.type === 'wake' && !wakes.includes(event)) wakes.push({ text: event.phrase, confidence: event.confidence, durationMs: event.durationMs })
    }
  })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.on('error', (error) => errors.push(`spawn failed: ${error.message}`))

  child.stdin.write(JSON.stringify({ phrase, language: 'zh', device, ...(wave ? { wave } : {}) }) + '\n')
  while (ready === null && failure === null && performance.now() - started < deadlineMs && !errors.length) await wait(100)
  const readyMs = ready ? ready.at - started : null
  let settled = null
  if (ready) {
    // The window starts after the warm-up, so engine start-up and grammar compilation do
    // not count as idle cost. Both ends carry a monotonic timestamp and the process CPU
    // counter, and the rate is ΔCPU / Δwall of that window only.
    await wait(warmupMs)
    const from = points.length
    await wait(windowMs)
    const window = points.slice(from)
    const first = window[0]
    const last = window[window.length - 1]
    const cpuAtReady = ready.cpuMs
    if (window.length >= 3 && first && last && last.at - first.at >= 2000) {
      settled = {
        fromMs: first.at - started,
        toMs: last.at - started,
        wallSeconds: (last.at - first.at) / 1000,
        cpuMs: last.cpuMs - first.cpuMs,
        privateKb: last.privateKb,
        workingSetKb: last.workingSetKb,
        samples: window.length,
        startupCpuMs: cpuAtReady === null ? null : Math.max(0, cpuAtReady)
      }
      settled.cpuMsPerSecond = settled.cpuMs / settled.wallSeconds
    }
  }
  child.stdin.end()
  const exited = await closeWithin(child, 8000)
  if (!exited) child.kill('SIGKILL')
  stop()
  return {
    helper: name,
    pid: child.pid,
    state: failure ? 'error' : ready ? 'ready' : errors.length ? 'failed' : 'timeout',
    error: failure ?? errors[0] ?? (ready ? null : stderr.trim().slice(0, 200) || 'no ready event'),
    readyMs,
    settled,
    wakes,
    peakPrivateKb: points.length ? Math.max(...points.map((point) => point.privateKb)) : null,
    survivedStop: !exited,
    events: [...new Set(events)],
    wave: wave || null,
    device: device || null
  }
}

const report = {
  kind: 'wake-listener-host',
  date: new Date().toISOString(),
  node: process.version,
  phrase,
  samples,
  warmupMs,
  windowMs,
  wave: wave || null,
  device: device || null,
  scope: [
    'Enumeration, time to first ready and the settled idle window are measured for the helper process only.',
    'The idle rate is ΔCPU / Δwall inside a window that starts after a warm-up, so start-up and grammar compilation are excluded.',
    'Time to first ready covers process start plus engine and grammar setup, measured from spawn to the ready event.',
    'Listening uses a synthetic wave unless --device is passed; no capture device is opened by default and no audio is stored.',
    'A missing or invalid metric is reported as null with its reason; invalid runs are excluded from the statistics, not counted as zero.'
  ],
  helpers: {}
}

for (const name of ['powershell', 'native']) {
  report.helpers[name] = { enumerate: [], listen: [] }
}

if (!wave && !device) wave = await synthesize()

for (let index = 0; index < samples; index += 1) {
  // Alternating order keeps a slow first run or a machine warm-up from landing on one helper.
  const order = index % 2 === 0 ? ['powershell', 'native'] : ['native', 'powershell']
  for (const name of order) {
    report.helpers[name].enumerate.push(await enumerate(name))
    if (name === 'native' && !existsSync(helpers.native.command)) continue
    report.helpers[name].listen.push(await listen(name))
  }
  const line = order.map((name) => {
    const lastEnumerate = report.helpers[name].enumerate.at(-1)
    const lastListen = report.helpers[name].listen.at(-1)
    return `${name}: enum ${lastEnumerate.wallMs?.toFixed(0) ?? '—'}ms ready ${lastListen.readyMs?.toFixed(0) ?? '—'}ms cpu ${lastListen.settled?.cpuMsPerSecond?.toFixed(1) ?? '—'}/s`
  }).join(' | ')
  console.log(`[${index + 1}/${samples}] ${line}`)
}

const summarise = (name) => {
  const helper = report.helpers[name]
  const enumerations = helper.enumerate
  const sessions = helper.listen.filter((session) => session.state === 'ready')
  return {
    enumerateRuns: enumerations.length,
    enumerateFailures: enumerations.filter((run) => run.error).length,
    enumerateWallMs: stats(enumerations.map((run) => run.wallMs)),
    listenRuns: helper.listen.length,
    listenReady: sessions.length,
    listenFailures: helper.listen.filter((session) => session.state !== 'ready').map((session) => session.error).slice(0, 3),
    readyMs: stats(sessions.map((session) => session.readyMs)),
    settledPrivateKb: stats(sessions.map((session) => session.settled?.privateKb ?? null)),
    settledCpuMsPerSecond: stats(sessions.map((session) => session.settled?.cpuMsPerSecond ?? null)),
    startupCpuMs: stats(sessions.map((session) => session.settled?.startupCpuMs ?? null)),
    survivedStop: sessions.every((session) => !session.survivedStop)
  }
}

report.powershell = summarise('powershell')
report.native = summarise('native')

const pct = (from, to) => from && to ? (to - from) / from * 100 : null
const ps = report.powershell
const native = report.native
report.comparison = {
  readyP95Pct: pct(ps.readyMs.p95, native.readyMs.p95),
  readyP95DeltaMs: ps.readyMs.p95 !== null && native.readyMs.p95 !== null ? native.readyMs.p95 - ps.readyMs.p95 : null,
  settledPrivatePct: pct(ps.settledPrivateKb.p50, native.settledPrivateKb.p50),
  settledPrivateDeltaKb: ps.settledPrivateKb.p50 !== null && native.settledPrivateKb.p50 !== null ? native.settledPrivateKb.p50 - ps.settledPrivateKb.p50 : null,
  idleCpuPct: pct(ps.settledCpuMsPerSecond.p50, native.settledCpuMsPerSecond.p50)
}
const comparison = report.comparison
report.decision = {
  adopted: comparison.readyP95Pct !== null && comparison.readyP95Pct <= -30 && comparison.readyP95DeltaMs <= -100
    ? 'native-ready'
    : comparison.settledPrivatePct !== null && comparison.settledPrivatePct <= -25 && comparison.settledPrivateDeltaKb <= -20 * 1024
      ? 'native-memory'
      : 'powershell',
  criteria: {
    readyP95PctAtMost: -30,
    readyP95DeltaMsAtMost: -100,
    settledPrivatePctAtMost: -25,
    settledPrivateDeltaKbAtMost: -20480
  }
}

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
const row = (name) => `${name}: enum p50 ${report[name].enumerateWallMs.p50?.toFixed(0)}ms, ready p50 ${report[name].readyMs.p50?.toFixed(0)}ms p95 ${report[name].readyMs.p95?.toFixed(0)}ms, settled ${(report[name].settledPrivateKb.p50 / 1024).toFixed(1)}MB, idle ${report[name].settledCpuMsPerSecond.p50?.toFixed(1)}ms/s`
console.log(row('powershell'))
console.log(row('native'))
console.log('comparison', JSON.stringify(report.comparison))
console.log('decision', report.decision.adopted, '→', output)
