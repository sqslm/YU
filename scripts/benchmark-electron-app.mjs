#!/usr/bin/env node
/**
 * Whole-application resource baseline for the packaged-style build.
 *
 * What this measures, and nothing else:
 *   - every process the app tree owns (main, renderers, GPU, utilities, Rust helpers),
 *   - private resident, working set and private commit per process,
 *   - user+kernel CPU deltas over an explicit window,
 *   - hub open latency: `spawn(second instance)` → settings window visible.
 *
 * The app is launched from `out/` with an isolated `--user-data-dir`, so the
 * user's own instance, settings and history are never touched. The sampler is a
 * separate OS process and is excluded from every sum. There is no DevTools, no
 * inspector port and no Vite dev server in this path: the window is opened the
 * way a second launch opens it (`second-instance` → `ensureSettingsWindow()`),
 * and closed the way the title-bar X closes it (WM_CLOSE → hide to tray).
 *
 *   node scripts/benchmark-electron-app.mjs --label baseline --open-samples 20
 *
 * Memory and CPU are reported separately; a value that cannot be read is
 * reported as unavailable rather than as zero.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, release as osRelease, tmpdir, totalmem } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const ENTRY = join(ROOT, 'out', 'main', 'index.js')
const require = createRequire(import.meta.url)
const koffi = require('koffi')

// ── Win32 ────────────────────────────────────────────────────────────────────
const kernel32 = koffi.load('kernel32.dll')
const user32 = koffi.load('user32.dll')

const OpenProcess = kernel32.func('void *OpenProcess(uint32_t, int, uint32_t)')
const CloseHandle = kernel32.func('int CloseHandle(void *)')
const GetProcessTimes = kernel32.func('int GetProcessTimes(void *, void *, void *, void *, void *)')
const K32GetProcessMemoryInfo = kernel32.func('int K32GetProcessMemoryInfo(void *, void *, uint32_t)')
const EnumWindowsProc = koffi.proto('int __stdcall EnumWindowsProc(void *hwnd, intptr_t param)')
const EnumWindows = user32.func('int EnumWindows(EnumWindowsProc *callback, intptr_t param)')
const IsWindowVisible = user32.func('int IsWindowVisible(void *hwnd)')
const GetWindowThreadProcessId = user32.func('uint32_t GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)')
const GetWindowTextW = user32.func('int GetWindowTextW(void *hwnd, void *buffer, int count)')
const GetClassNameW = user32.func('int GetClassNameW(void *hwnd, void *buffer, int count)')
const PostMessageW = user32.func('int PostMessageW(void *hwnd, uint32_t msg, uintptr_t wparam, intptr_t lparam)')

// PROCESS_MEMORY_COUNTERS_EX2 on x64: privateResident at 80, workingSet at 16, commit at 72.
const COUNTERS_SIZE = 96
const counters = Buffer.alloc(COUNTERS_SIZE)
counters.writeUInt32LE(COUNTERS_SIZE, 0)

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const PROCESS_VM_READ = 0x0010

function readMemory(pid) {
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid)
  if (!handle) return null
  try {
    if (!K32GetProcessMemoryInfo(handle, koffi.as(counters, 'void *'), COUNTERS_SIZE)) return null
    return {
      privateResidentBytes: Number(counters.readBigUInt64LE(80)),
      workingSetBytes: Number(counters.readBigUInt64LE(16)),
      committedBytes: Number(counters.readBigUInt64LE(72))
    }
  } finally {
    CloseHandle(handle)
  }
}

const filetimes = new Array(4).fill(null).map(() => Buffer.alloc(8))

function readCpuMs(pid) {
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (!handle) return null
  try {
    if (!GetProcessTimes(handle, filetimes[0], filetimes[1], filetimes[2], filetimes[3])) return null
    const kernel = filetimes[2].readBigUInt64LE() / 10_000n
    const user = filetimes[3].readBigUInt64LE() / 10_000n
    return { userMs: Number(user) / 1000, kernelMs: Number(kernel) / 1000 }
  } finally {
    CloseHandle(handle)
  }
}

function listProcesses() {
  const script = [
    'Get-CimInstance Win32_Process |',
    'Select-Object ProcessId,ParentProcessId,Name,CommandLine |',
    'ConvertTo-Json -Compress -Depth 3'
  ].join(' ')
  const out = spawnSync(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  )
  if (out.status !== 0) throw new Error(`process listing failed: ${out.stderr?.trim() ?? out.status}`)
  const parsed = JSON.parse(out.stdout || '[]')
  return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
    pid: Number(row.ProcessId),
    ppid: Number(row.ParentProcessId),
    name: String(row.Name ?? ''),
    cmd: String(row.CommandLine ?? '')
  }))
}

function descendants(all, rootPid) {
  const childrenOf = new Map()
  for (const proc of all) {
    if (!childrenOf.has(proc.ppid)) childrenOf.set(proc.ppid, [])
    childrenOf.get(proc.ppid).push(proc)
  }
  const found = []
  const queue = [rootPid]
  const seen = new Set([rootPid])
  while (queue.length) {
    const pid = queue.shift()
    for (const child of childrenOf.get(pid) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      found.push(child)
      queue.push(child.pid)
    }
  }
  return found
}

function roleOf(proc) {
  if (/(^|\\)typeless-(hotkey|uia|wake|speech|local-asr|windows)\.exe$/i.test(proc.name)) return 'helper'
  if (proc.name.toLowerCase() === 'electron.exe') {
    if (proc.cmd.includes('--type=gpu-process')) return 'gpu'
    if (proc.cmd.includes('--type=utility')) return 'utility'
    if (proc.cmd.includes('--type=renderer')) return 'renderer'
    if (proc.cmd.includes('--type=crashpad-handler')) return 'crashpad'
    if (proc.cmd.includes('--type=zygote')) return 'zygote'
    return 'main'
  }
  return 'other'
}

function listWindows(pids) {
  const found = []
  const titleBuffer = Buffer.alloc(1024)
  const classBuffer = Buffer.alloc(512)
  const callback = koffi.register((hwnd) => {
    const pidOut = [0]
    GetWindowThreadProcessId(hwnd, pidOut)
    const pid = pidOut[0]
    if (!pids.has(pid)) return 1
    if (!IsWindowVisible(hwnd)) return 1
    GetWindowTextW(hwnd, koffi.as(titleBuffer, 'void *'), 512)
    GetClassNameW(hwnd, koffi.as(classBuffer, 'void *'), 256)
    const title = titleBuffer.toString('utf16le').replace(/\0.*$/s, '')
    const className = classBuffer.toString('utf16le').replace(/\0.*$/s, '')
    if (!title) return 1
    found.push({ handle: Number(koffi.address(hwnd)), pid, title, className })
    return 1
  }, koffi.pointer(EnumWindowsProc))
  try {
    EnumWindows(callback, 0)
  } finally {
    koffi.unregister(callback)
  }
  return found
}

// ── App control ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function appEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RENDERER_URL
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function launch(profile, extraEnv = {}) {
  const child = spawn(ELECTRON, [ENTRY, `--user-data-dir=${profile}`, '--background'], {
    cwd: ROOT,
    env: { ...appEnv(), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.__stdout = ''
  child.__stderr = ''
  child.stdout?.on('data', (chunk) => {
    child.__stdout = (child.__stdout + String(chunk)).slice(-200_000)
  })
  child.stderr?.on('data', (chunk) => {
    child.__stderr = (child.__stderr + String(chunk)).slice(-200_000)
  })
  return child
}

function requestOpen(profile) {
  return spawn(ELECTRON, [ENTRY, `--user-data-dir=${profile}`], {
    cwd: ROOT,
    env: appEnv(),
    stdio: ['ignore', 'ignore', 'ignore']
  })
}

async function waitForTree(rootPid, timeoutMs) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    try {
      const tree = descendants(listProcesses(), rootPid)
      if (tree.some((proc) => roleOf(proc) === 'gpu')) return
    } catch {
      /* listing can race with a short-lived process */
    }
    await sleep(200)
  }
  throw new Error('app tree did not appear in time')
}

async function waitForHub(pidSetProvider, timeoutMs) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const pids = pidSetProvider()
    const windows = listWindows(pids)
    const hub = windows.find((win) => win.title === '语' && win.className.includes('Chrome_WidgetWin'))
    if (hub) return hub
    await sleep(20)
  }
  return null
}

function restoreRunKey(saved) {
  const key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
  const known = new Set(saved.map(([name]) => name))
  // Anything this run added is not the user's: drop it so the machine is left
  // exactly as it was found.
  const added = readRunKey()
    .map(([name]) => name)
    .filter((name) => !known.has(name))
  const commands = [
    ...saved.map(([name, value]) => `New-ItemProperty -Path '${key}' -Name '${name}' -Value '${String(value).replace(/'/g, "''")}' -PropertyType String -Force | Out-Null`),
    ...added.map((name) => `Remove-ItemProperty -Path '${key}' -Name '${name}' -ErrorAction SilentlyContinue`)
  ]
  if (!commands.length) return
  spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', commands.join('; ')], { encoding: 'utf8' })
}

function readRunKey() {
  const out = spawnSync(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', "(Get-Item 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run').Property | ForEach-Object { $_ + '=' + (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run').$_ }"],
    { encoding: 'utf8' }
  )
  return (out.stdout || '')
    .split(/\r?\n/)
    .filter((line) => line.includes('='))
    .map((line) => line.split('=').slice(0, 2))
    .filter(([name]) => /typeless|electron/i.test(name))
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function lines(text) {
  const parts = String(text ?? '').split(String.fromCharCode(10))
  return parts.map((line) => line.replaceAll(String.fromCharCode(13), '')).filter((line) => line.trim().length > 0)
}

function cluster(samples, phase) {
  const picked = samples.filter((sample) => sample.phase === phase)
  const values = picked.map((sample) => sample.totals.privateResidentBytes)
  return {
    phase,
    count: picked.length,
    summary: summarise(values),
    unavailable: picked.reduce((sum, sample) => sum + sample.unavailable.length, 0),
    // A median snapshot, not the last one: the group split must describe the
    // typical tree, and `last` is reported separately.
    byRole: medianByRole(picked),
    last: picked.at(-1) ?? null
  }
}

function medianByRole(samples) {
  if (samples.length === 0) return {}
  const ordered = [...samples].sort((a, b) => a.totals.privateResidentBytes - b.totals.privateResidentBytes)
  const middle = ordered[Math.floor(ordered.length / 2)]
  return middle.byRole
}

// ── Sampling ─────────────────────────────────────────────────────────────────
function snapshot(rootPid, startedAt) {
  const all = listProcesses()
  const tree = descendants(all, rootPid)
  const root = all.find((proc) => proc.pid === rootPid)
  const entries = [root, ...tree].filter(Boolean).map((proc) => {
    const memory = readMemory(proc.pid)
    return {
      pid: proc.pid,
      ppid: proc.ppid,
      name: proc.name,
      role: roleOf(proc),
      privateResidentBytes: memory?.privateResidentBytes ?? null,
      workingSetBytes: memory?.workingSetBytes ?? null,
      committedBytes: memory?.committedBytes ?? null
    }
  })
  const totals = { privateResidentBytes: 0, workingSetBytes: 0, committedBytes: 0 }
  const byRole = {}
  for (const entry of entries) {
    const bucket = (byRole[entry.role] ??= { count: 0, privateResidentBytes: 0, workingSetBytes: 0, committedBytes: 0 })
    bucket.count += 1
    for (const key of Object.keys(totals)) {
      if (entry[key] === null) continue
      totals[key] += entry[key]
      bucket[key] += entry[key]
    }
  }
  return {
    at: new Date().toISOString(),
    elapsedMs: startedAt === undefined ? null : Math.round(performance.now() - startedAt),
    processes: entries,
    totals,
    byRole,
    unavailable: entries.filter((entry) => entry.privateResidentBytes === null).map((entry) => entry.pid)
  }
}

async function cpuWindow(rootPid, windowMs) {
  const started = performance.now()
  const treeOf = () => {
    const all = listProcesses()
    const root = all.find((proc) => proc.pid === rootPid) ?? { pid: rootPid, ppid: 0, name: '', cmd: '' }
    return [root, ...descendants(all, rootPid)]
  }
  const before = new Map(treeOf().map((proc) => [proc.pid, readCpuMs(proc.pid)]))
  await sleep(windowMs)
  const after = treeOf()
  const perPid = []
  let totalMs = 0
  for (const proc of after) {
    const then = before.get(proc.pid)
    const now = readCpuMs(proc.pid)
    if (!then || !now) continue
    const userMs = Math.round((now.userMs - then.userMs) * 1000) / 1000
    const kernelMs = Math.round((now.kernelMs - then.kernelMs) * 1000) / 1000
    const sum = userMs + kernelMs
    if (sum < 0) continue
    perPid.push({ pid: proc.pid, role: roleOf(proc), userMs, kernelMs, totalMs: sum })
    totalMs += sum
  }
  return { windowMs: Math.round(performance.now() - started), cores: cpus().length, perPid, totalMs: Math.round(totalMs * 1000) / 1000 }
}

// ── Scenarios ────────────────────────────────────────────────────────────────
async function coldRun() {
  const profile = mkdtempSync(join(tmpdir(), 'yu-app-cold-'))
  const started = performance.now()
  const child = launch(profile)
  try {
    await waitForTree(child.pid, 60_000)
    await sleep(5_000)
    const memory = snapshot(child.pid, started)
    const cpu = await cpuWindow(child.pid, 10_000)
    return { profile, startupMs: memory.elapsedMs, memory, cpu, stderr: collectStderr(child) }
  } finally {
    await stopApp(child)
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
  }
}

function collectStderr(child) {
  return String(child.__stderr ?? '').slice(-2000)
}

async function stopApp(child) {
  if (!child || child.exitCode !== null) return
  try {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* already gone */
  }
  await sleep(500)
}

async function firstOpenLoop(samples) {
  const latencies = []
  const idleSamples = []
  for (let index = 0; index < samples; index += 1) {
    const profile = mkdtempSync(join(tmpdir(), 'yu-app-open-'))
    const child = launch(profile)
    try {
      await waitForTree(child.pid, 60_000)
      await sleep(4_000)
      idleSamples.push({ phase: 'settled-4s', ...snapshot(child.pid, undefined) })
      const started = performance.now()
      const opener = requestOpen(profile)
      const hub = await waitForHub(() => new Set(descendants(listProcesses(), child.pid).map((proc) => proc.pid).concat([child.pid])), 30_000)
      const elapsed = performance.now() - started
      if (!hub) throw new Error('hub window never appeared')
      latencies.push(Math.round(elapsed * 1000) / 1000)
      await stopApp(child)
      opener.kill()
    } finally {
      await stopApp(child)
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
    }
  }
  return { latencies, idleSamples }
}

async function trayIdleRun(idleMs) {
  const profile = mkdtempSync(join(tmpdir(), 'yu-app-idle-'))
  const child = launch(profile)
  try {
    await waitForTree(child.pid, 60_000)
    await sleep(5_000)
    const cpu = await cpuWindow(child.pid, idleMs)
    const memory = snapshot(child.pid, undefined)
    return { memory, cpu }
  } finally {
    await stopApp(child)
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
  }
}

async function toggleRun(toggles, idleMs) {
  const profile = mkdtempSync(join(tmpdir(), 'yu-app-toggle-'))
  const child = launch(profile)
  const latencies = []
  try {
    await waitForTree(child.pid, 60_000)
    await sleep(4_000)
    const before = snapshot(child.pid, undefined)
    // Per-cycle samples answer the question the plan asks — does repeated
    // toggling accumulate anything — without comparing two different instances.
    const cycles = []
    for (let index = 0; index < toggles; index += 1) {
      const started = performance.now()
      const opener = requestOpen(profile)
      const hub = await waitForHub(() => new Set(descendants(listProcesses(), child.pid).map((proc) => proc.pid).concat([child.pid])), 30_000)
      if (!hub) throw new Error(`hub window never appeared on toggle ${index + 1}`)
      latencies.push(Math.round((performance.now() - started) * 1000) / 1000)
      opener.kill()
      await sleep(1_200)
      PostMessageW(hub.handle, 0x0010, 0, 0)
      await sleep(1_200)
      const cycle = snapshot(child.pid, undefined)
      cycles.push({
        cycle: index + 1,
        privateResidentBytes: cycle.totals.privateResidentBytes,
        renderers: cycle.processes.filter((proc) => proc.role === 'renderer').length,
        utility: cycle.processes.filter((proc) => proc.role === 'utility').length
      })
    }
    await sleep(idleMs)
    const memory = { phase: 'after-toggles', ...snapshot(child.pid, undefined) }
    return { latencies, cycles, before, memory }
  } finally {
    await stopApp(child)
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
  }
}

/**
 * The pill's window lifecycle, observed from outside: opening the hub makes the
 * settings renderer ask for the microphone list, which is answered by the bar
 * renderer — so the bar exists while the hub is up. Whether it is still there
 * after the hub closes (and after a longer idle) is exactly what the retirement
 * change alters, and this records it as renderer PIDs rather than as an opinion.
 */
async function lifecycleRun(idleMs) {
  const profile = mkdtempSync(join(tmpdir(), 'yu-app-life-'))
  const child = launch(profile)
  const seen = []
  const count = () => {
    const all = listProcesses()
    const tree = descendants(all, child.pid)
    const renderers = tree.filter((proc) => roleOf(proc) === 'renderer').map((proc) => proc.pid)
    return renderers
  }
  try {
    await waitForTree(child.pid, 60_000)
    await sleep(4_000)
    seen.push({ at: 'startup', renderers: count() })
    const opener = requestOpen(profile)
    const hub = await waitForHub(() => new Set(descendants(listProcesses(), child.pid).map((proc) => proc.pid).concat([child.pid])), 30_000)
    opener.kill()
    if (!hub) throw new Error('hub window never appeared for the lifecycle run')
    await sleep(3_000)
    seen.push({ at: 'hub-open', renderers: count() })
    PostMessageW(hub.handle, 0x0010, 0, 0)
    await sleep(idleMs)
    seen.push({ at: 'after-hide-idle', renderers: count() })
    return seen
  } finally {
    await stopApp(child)
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
  }
}

function percentile(values, quantile) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * quantile) - 1]
}

function summarise(values) {
  if (!values.length) return { count: 0, min: null, p50: null, p95: null, max: null }
  return {
    count: values.length,
    min: Math.min(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values)
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
function option(name, fallback) {
  const prefix = `--${name}=`
  const inline = args.find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = args.indexOf(`--${name}`)
  if (index >= 0) {
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) return true
    return value
  }
  return fallback
}

const label = String(option('label', 'baseline'))
const openSamples = Number(option('open-samples', 20))
/**
 * Pill lifecycle: a take creates the bar renderer, hiding it arms the retire
 * timer, and the next take must bring it back. Drives real takes through the
 * self-test harness (no microphone) and only observes process identity and the
 * retirement log line.
 */
async function pillScenario(repeatMs = 45_000, observeMs = 130_000) {
  const profile = mkdtempSync(join(tmpdir(), 'yu-app-pill-'))
  const logs = []
  const mock = spawn(process.execPath, [join(ROOT, 'scripts', 'mock-openai.mjs')], {
    cwd: ROOT,
    env: appEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  await sleep(1_500)
  const child = launch(profile, {
    TYPELESS_SELFTEST: '1',
    TYPELESS_SELFTEST_STAY: '1',
    TYPELESS_SELFTEST_REPEAT_MS: String(repeatMs)
  })
  const renderers = []
  const started = performance.now()
  try {
    await waitForTree(child.pid, 60_000)
    while (performance.now() - started < observeMs) {
      const tree = descendants(listProcesses(), child.pid)
      const pids = tree.filter((proc) => roleOf(proc) === 'renderer').map((proc) => proc.pid).sort((a, b) => a - b)
      const sample = { atMs: Math.round(performance.now() - started), rendererPids: pids }
      const previous = renderers.at(-1)
      if (!previous || previous.rendererPids.join(',') !== pids.join(',')) renderers.push(sample)
      await sleep(1_000)
    }
  } finally {
    logs.push(...lines(child.__stderr))
    logs.push(...lines(child.__stdout))
    await stopApp(child)
    mock.kill()
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
  }
  const distinct = new Set(renderers.flatMap((sample) => sample.rendererPids))
  return {
    observeMs,
    repeatMs,
    retirements: logs.filter((line) => line.includes('[bar] retiring the hidden pill window')).length,
    takes: logs.filter((line) => line.includes('[selftest] repeat →') || line.includes('[selftest] dictation →')).length,
    distinctRenderers: [...distinct].sort((a, b) => a - b),
    timeline: renderers,
    tail: logs.filter((line) => line.includes('[bar]') || line.includes('[selftest]')).slice(-20),
    aliveAtEnd: descendants(listProcesses(), child.pid).length > 0
  }
}

const idleRuns = Number(option('idle-runs', 3))
const idleMs = Number(option('idle-ms', 60_000))
const toggles = Number(option('toggles', 20))
const lifeIdle = Number(option('lifecycle-idle-ms', 40_000))
const skipCold = args.includes('--skip-cold')
const withPill = args.includes('--pill')
// Set when the measured tree is not exactly HEAD (e.g. a reverted baseline).
const sourceRef = String(option('source', ''))
const output = String(option('output', join(ROOT, 'tests', 'yu-v2', 'evidence', `.electron-app-${label}.json`)))

if (!Number.isInteger(openSamples) || openSamples < 1) throw new Error('--open-samples must be a positive integer')
if (!Number.isInteger(toggles) || toggles < 1) throw new Error('--toggles must be a positive integer')

const runKey = readRunKey()
const startedAt = new Date().toISOString()
const coldRuns = []
const idleSamples = []
const firstOpen = []
try {
  if (!skipCold) {
    const cold = await coldRun()
    coldRuns.push(cold)
    firstOpen.push(cold.startupMs)
  }
  const opened = await firstOpenLoop(openSamples)
  firstOpen.push(...opened.latencies)
  idleSamples.push(...opened.idleSamples)
  for (let index = 0; index < idleRuns; index += 1) idleSamples.push({ phase: 'idle-60s', ...(await trayIdleRun(idleMs)).memory })
  const idleCpu = await trayIdleRun(idleMs)
  const toggle = await toggleRun(toggles, idleMs)
  const lifecycle = await lifecycleRun(lifeIdle)
  const pill = withPill ? await pillScenario() : null
  const evidence = {
    kind: 'electron-app-resources',
    version: 1,
    label,
    meta: {
      generatedAt: startedAt,
      host: { os: `${process.platform} ${osRelease()}`,  arch: process.arch, cpuModel: cpus()[0]?.model ?? '', cores: cpus().length, totalMemMb: Math.round(totalmem() / 1048576) },
      node: process.version,
      // The probe must not inherit ELECTRON_RUN_AS_NODE: that turns electron into
      // plain Node and makes --version print the bundled Node version instead.
      electron: spawnSync(ELECTRON, ['--version'], { encoding: 'utf8', env: appEnv() }).stdout.trim().replace(/^v/, ''),
      build: {
        entry: relative(ROOT, ENTRY).split(String.fromCharCode(92)).join('/'),
        entrySha256: sha256(ENTRY),
        rev: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(),
        source: sourceRef || 'HEAD',
        dirty: spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim().length > 0
      },
      profile: { isolated: true, variable: '--user-data-dir=<temp>' },
      scenarios: { openSamples, idleRuns, idleMs, toggles },
      measurement: {
        memory: 'K32GetProcessMemoryInfo PROCESS_MEMORY_COUNTERS_EX2 per PID; unavailable reported, never zero',
        cpu: 'GetProcessTimes user+kernel delta over an explicit window; cores reported with the window',
        openLatency: 'performance.now() at spawn(second instance) → settings window ("语") first visible in EnumWindows',
        tree: 'Win32_Process parent chain from the launched main PID'
      }
    },
    cold: coldRuns,
    firstOpen: { samples: firstOpen, summary: summarise(firstOpen) },
    trayIdle: {
      samples: idleSamples,
      // The two clusters answer different questions: 'settled-4s' is the tree a
      // moment after launch, 'idle-60s' is the tray resting state the plan gates on.
      clusters: {
        'settled-4s': cluster(idleSamples, 'settled-4s'),
        'idle-60s': cluster(idleSamples, 'idle-60s')
      },
      summary: cluster(idleSamples, 'idle-60s').summary,
      last: idleSamples.at(-1) ?? null,
      cpu: idleCpu.cpu
    },
    toggles: { reopen: toggle.latencies, summary: summarise(toggle.latencies), before: toggle.before, cycles: toggle.cycles, memory: toggle.memory },
    lifecycle,
    pill,
    cleanup: { runKeyBefore: runKey }
  }
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(`[app] ${label}: first-open p50 ${evidence.firstOpen.summary.p50} ms (n=${evidence.firstOpen.summary.count})`)
  console.log(`[app] ${label}: reopen p50 ${evidence.toggles.summary.p50} ms`)
  console.log(`[app] ${label}: tray idle private resident p50 ${(evidence.trayIdle.summary.p50 / 1048576).toFixed(1)} MiB`)
  console.log(`[app] ${label}: evidence ${output}`)
} finally {
  restoreRunKey(runKey)
}
