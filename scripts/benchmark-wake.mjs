// Measures the resident wake helper: device enumeration, time to the first ready
// event, and idle CPU / private memory while listening. No Electron API is needed,
// so the helpers are spawned directly from this script.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// A single long-lived sampler costs less than spawning a query per sample. It lives in
// the temp directory so the repository stays free of measurement scratch files.
const sampler = join(tmpdir(), `yu-wake-sample-${process.pid}.ps1`)
writeFileSync(sampler, '﻿' + `param([int]$TargetPid, [int]$IntervalMs = 250)
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
    enumerate: ['-ListDevices'],
    listen: true
  },
  native: {
    command: resolve(root, 'native/bin/yu-wake.exe'),
    args: (extra) => [...(extra ?? [])],
    enumerate: ['--list-devices'],
    // The native candidate only covers device enumeration; listening is still served by
    // the PowerShell host, so there is no listening session to measure here.
    listen: false
  }
}

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index < 0 ? fallback : args[index + 1]
}
const output = resolve(root, option('--output', 'tests/yu-v2/evidence/rust-wake-20261103.json'))
const rounds = Number(option('--rounds', '3'))
const idleMs = Number(option('--idle', '5000'))
const phrase = option('--phrase', '你好，胡小杨')

const sample = (pid, onSample) => {
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', sampler, String(pid)], { windowsHide: true })
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const [workingSet, privateBytes, cpuMs] = line.trim().split(' ').map(Number)
      if (Number.isFinite(privateBytes)) onSample({ workingSetKb: workingSet / 1024, privateKb: privateBytes / 1024, cpuMs })
    }
  })
  child.on('error', () => {})
  return () => child.kill()
}

const stats = (values) => {
  const sorted = [...values].sort((left, right) => left - right)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))]
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), min: sorted[0], max: sorted[sorted.length - 1] }
}

const enumerate = (name) => new Promise((done) => {
  const helper = helpers[name]
  if (!existsSync(helper.command)) return done({ helper: name, skipped: 'missing executable' })
  const started = performance.now()
  const child = spawn(helper.command, helper.args(helper.enumerate), { windowsHide: true })
  let stdout = ''
  let peak = 0
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', () => {})
  const stop = sample(child.pid, (point) => { peak = Math.max(peak, point.privateKb) })
  child.on('close', (code) => {
    stop()
    const devices = stdout.split('\n').map((line) => { try { return JSON.parse(line) } catch { return null } }).find((event) => event?.type === 'devices')
    done({ helper: name, wallMs: performance.now() - started, code, peakPrivateKb: peak, devices: devices?.devices?.length ?? 0, stdout: stdout.length })
  })
})

const listen = async (name) => {
  const helper = helpers[name]
  if (!existsSync(helper.command)) return { helper: name, skipped: 'missing executable' }
  if (!helper.listen) return { helper: name, skipped: 'listening not implemented in this helper' }
  const child = spawn(helper.command, helper.args(), { windowsHide: true })
  const started = performance.now()
  const points = []
  const stop = sample(child.pid, (point) => points.push(point))
  let stdout = ''
  const events = []
  let readyMs = null
  let failure = null
  const ready = new Promise((done) => {
    const timer = setTimeout(() => done(null), 20000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const lines = stdout.split('\n')
      stdout = lines.pop() ?? ''
      for (const line of lines) {
        let event = null
        try { event = JSON.parse(line) } catch { continue }
        events.push(event.type)
        if (event.type === 'ready' && readyMs === null) { readyMs = performance.now() - started; done('ready') }
        if (event.type === 'error' && failure === null) { failure = event.error; done('error') }
      }
    })
    child.on('error', (error) => { failure = error.message; clearTimeout(timer); done(null) })
    child.on('close', () => { clearTimeout(timer); done(null) })
    child.stdin.write(JSON.stringify({ phrase, language: 'zh', device: option('--device', '') }) + '\n')
  })
  const state = await ready
  await new Promise((settle) => setTimeout(settle, idleMs))
  stop()
  const idle = points.filter((point) => point.cpuMs !== undefined)
  const cpuDelta = idle.length > 1 ? idle[idle.length - 1].cpuMs - idle[0].cpuMs : 0
  const idleSeconds = idle.length > 1 ? (idleMs / 1000) : 0
  const result = {
    helper: name,
    state,
    failure,
    readyMs,
    privateKbPeak: Math.max(0, ...points.map((point) => point.privateKb)),
    privateKbSettled: idle.length ? idle[idle.length - 1].privateKb : null,
    workingSetKbPeak: Math.max(0, ...points.map((point) => point.workingSetKb)),
    idleCpuMsPerSecond: idleSeconds > 0 ? cpuDelta / idleSeconds : null,
    idleSeconds,
    events: [...new Set(events)]
  }
  child.kill()
  await new Promise((settle) => setTimeout(settle, 500))
  return result
}

const report = { kind: 'wake-helper-host', date: new Date().toISOString(), node: process.version, phrase, rounds, idleMs, helpers: {}, scope: [
  'Enumeration and listening are measured for the helper process only; the parent application is not instrumented here.',
  'Idle CPU comes from the helper process total processor time sampled over the idle window, not from the parent.',
  'Time to first ready covers process start plus grammar setup and covers the SAPI engine load.',
  'Live listening uses the default capture device; no audio is stored or uploaded.',
  'The native helper is reported only when native/bin/yu-wake.exe exists; it covers device enumeration only, so no listening numbers exist for it.'
] }

report.decision = {
  adopted: 'powershell',
  reason: 'The PowerShell/System.Speech host keeps listening; the native candidate covers enumeration only, and an unverified listening path is not shipped.'
}

for (const name of ['powershell', 'native']) {
  const enumerations = []
  const sessions = []
  for (let round = 0; round < rounds; round += 1) {
    enumerations.push(await enumerate(name))
    sessions.push(await listen(name))
  }
  report.helpers[name] = {
    enumerate: enumerations,
    listen: sessions,
    readyMs: stats(sessions.map((session) => session.readyMs).filter((value) => value !== null)),
    privateKbSettled: stats(sessions.map((session) => session.privateKbSettled).filter((value) => value !== null)),
    idleCpuMsPerSecond: stats(sessions.map((session) => session.idleCpuMsPerSecond).filter((value) => value !== null))
  }
  console.log(name, JSON.stringify(report.helpers[name].readyMs), JSON.stringify(report.helpers[name].privateKbSettled))
}

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
console.log('written', output)
