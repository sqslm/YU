import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import os from 'node:os'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1] }
if (process.platform !== 'win32') throw new Error('Windows is required')
const baseline = option('--baseline', '88377c9')
const directory = mkdtempSync(join(root, 'scripts/.windows-benchmark-'))
const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const executable = join(root, 'native/bin/yu-windows.exe')
const koffi = require('koffi'), kernel = koffi.load('kernel32.dll')
const open = kernel.func('void *OpenProcess(uint32_t access, int inherit, uint32_t pid)')
const times = kernel.func('int GetProcessTimes(void *process, void *created, void *exited, void *kernel, void *user)')
const close = kernel.func('int CloseHandle(void *handle)')
let fixture
try {
  for (const file of ['windows-tools.ps1', 'system-volume.ps1']) {
    writeFileSync(join(directory, file), execFileSync('git', ['show', `${baseline}:resources/${file}`], { cwd: root }))
  }
  fixture = spawn(powershell, ['-NoProfile', '-NonInteractive', '-File', join(root, 'tests/yu-v2/fixtures/windows-bridge.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  fixture.stderr.on('data', data => process.stderr.write(data))
  const lines = createInterface({ input: fixture.stdout })
  const fixtureClosed = new Promise(resolve => fixture.once('close', resolve))
  async function state(command) {
    const response = once(lines, 'line')
    if (command) fixture.stdin.write(command + '\n')
    const timer = setTimeout(() => fixture.kill(), 15000)
    try {
      const reply = await Promise.race([response, fixtureClosed.then(() => { throw new Error('Bridge fixture closed before replying') })])
      return JSON.parse(reply[0])
    } finally { clearTimeout(timer) }
  }
  const initial = await state(), target = { handle: initial.handle, pid: initial.pid, title: initial.title }
  async function request(variant, body) {
    const at = performance.now()
    const child = spawn(variant === 'rust' ? executable : powershell,
      variant === 'rust' ? ['--parent-pid', String(process.pid)] : ['-NoProfile', '-NonInteractive', '-File', join(directory, 'windows-tools.ps1')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', error = '', handle
    const timeout = setTimeout(() => child.kill(), 15000)
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { error += data })
    try {
      // Acquire identity before sending input, while the new worker is blocked.
      await once(child, 'spawn'); handle = open(0x1000, 0, child.pid)
      if (!handle) throw new Error('Cannot open worker for CPU measurement')
      const closed = once(child, 'close'); child.stdin.end(JSON.stringify(body))
      const [code] = await closed
      const elapsedMs = performance.now() - at
      const created = Buffer.alloc(8), exited = Buffer.alloc(8), k = Buffer.alloc(8), u = Buffer.alloc(8)
      if (!times(handle, created, exited, k, u)) throw new Error('CPU measurement unavailable')
      return { code, error, data: code === 0 ? JSON.parse(output.replace(/^\uFEFF/, '')) : null, elapsedMs, workerCpuMs: Number(k.readBigUInt64LE() + u.readBigUInt64LE()) / 10000 }
    } finally { clearTimeout(timeout); if (handle) close(handle); child.kill() }
  }
  const checks = []
  for (const variant of ['powershell', 'rust']) {
    assert.deepEqual((await request(variant, { action: 'window-check', ...target })).data, { valid: true })
    const wrongPid = await request(variant, { action: 'window-check', ...target, pid: target.pid + 1 })
    assert.notEqual(wrongPid.code, 0); assert.match(wrongPid.error, /changed or closed/)
    const changed = await state('title')
    assert.notEqual(changed.title, target.title, 'the fixture title must actually change')
    const stale = await request(variant, { action: 'window-check', ...target })
    assert.notEqual(stale.code, 0); assert.match(stale.error, /changed or closed/)
    await state('minimize')
    const minimized = await request(variant, { action: 'window-check', ...target, title: changed.title })
    assert.notEqual(minimized.code, 0); assert.match(minimized.error, /minimized/)
    await state('restore')
    target.title = changed.title
    // Read only: do not set volume or mute during validation/benchmarking.
    const volume = await request(variant, { action: 'system-volume' })
    assert.equal(volume.code, 0, volume.error); assert.ok(Number.isInteger(volume.data.volume) && volume.data.volume >= 0 && volume.data.volume <= 100)
    assert.equal(typeof volume.data.muted, 'boolean')
    const invalid = await request(variant, { action: 'system-volume', volume: 101 })
    assert.notEqual(invalid.code, 0)
    const unavailable = await request(variant, { action: 'ocr', png: initial.png, language: 'xx-YU-fixture-uninstalled' })
    assert.notEqual(unavailable.code, 0); assert.match(unavailable.error, /language pack is not installed/)
    checks.push({ variant, windowCheck: true, mismatchedPidRejected: true, staleTitleRejected: true, minimizedRejected: true, volumeReadOnly: true, invalidVolumeRejected: true, unavailableOcrLanguageRejected: true })
  }
  const rounds = [], expected = new Map()
  const percentile = (xs, q) => [...xs].sort((a,b) => a-b)[Math.ceil(xs.length*q)-1]
  for (const variant of ['powershell', 'rust', 'rust', 'powershell']) {
    const measurements = []
    for (const action of ['window-check', 'disk-space', 'system-volume', 'ocr']) {
      const body = action === 'window-check' ? { action, ...target } : action === 'ocr' ? { action, png: initial.png } : { action }
      const elapsed = [], cpu = []
      for (let i = 0; i < 6; i++) {
        const result = await request(variant, body)
        assert.equal(result.code, 0, result.error)
        if (action === 'ocr') {
          assert.match(result.data.text, /QINLY\s+OCR\s+123/i)
          assert.equal(result.data.width, 640); assert.equal(result.data.height, 100)
          if (expected.has(action)) assert.deepEqual(result.data, expected.get(action))
          else expected.set(action, result.data)
        }
        if (action === 'disk-space') {
          assert.ok(result.data.drives.length > 0)
          for (const drive of result.data.drives) { assert.ok(drive.totalBytes > 0 && drive.freeBytes >= 0); assert.equal(drive.usedBytes + drive.freeBytes, drive.totalBytes) }
          const stable = result.data.drives.map(d => ({ name: d.name, label: d.label, totalBytes: d.totalBytes }))
          if (expected.has(action)) assert.deepEqual(stable, expected.get(action)); else expected.set(action, stable)
        }
        if (i) { elapsed.push(result.elapsedMs); cpu.push(result.workerCpuMs) }
      }
      measurements.push({ action, p50Ms: percentile(elapsed, .5), p95Ms: percentile(elapsed, .95), workerCpuP50Ms: percentile(cpu,.5), elapsedSamples: elapsed, workerCpuSamples: cpu })
    }
    rounds.push({ variant, measurements }); console.log(JSON.stringify(rounds.at(-1)))
  }
  fixture.stdin.write('quit\n'); await fixtureClosed
  const closedWindow = await request('rust', { action: 'window-check', ...target })
  assert.notEqual(closedWindow.code, 0); assert.match(closedWindow.error, /changed or closed/)
  checks.push({ closedWindowRejected: true, ocrFieldsAndBoundsEqual: true, diskLabelsAndTotalsEqual: true })
  const binary = readFileSync(executable)
  const report = { date: new Date().toISOString(), baseline, platform: `${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model,
    helperBytes: binary.length, helperSha256: createHash('sha256').update(binary).digest('hex'),
    scope: 'Complete one-shot request wall time including process startup, input, output and exit; five measured requests per action per round after one discarded warmup. Worker CPU sums all its threads, may exceed wall time, excludes compiler subprocesses and has OS accounting granularity. No total-app CPU or RAM reduction is inferred. Uses an owned transparent non-activating window and synthetic in-memory image; audio is read only. No user paths, audio values or OCR text are saved in this report.', checks, rounds }
  if (option('--output')) writeFileSync(resolve(option('--output')), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ complete: true, checks }))
} finally {
  if (fixture && fixture.exitCode === null) { const closed = once(fixture, 'close'); fixture.kill(); await closed }
  rmSync(directory, { recursive: true, force: true })
}
