#!/usr/bin/env node
/**
 * Whole-application resource baseline for the packaged-style build.
 *
 * What this measures, and nothing else:
 *   - every process the app tree owns (main, renderers, GPU, utilities, Rust helpers),
 *   - private resident, working set and private commit per process,
 *   - user+kernel CPU deltas over an explicit window,
 *   - four separate latency figures: cold tree ready, cold pill ready, first hub
 *     open, and reopen.
 *
 * Rules this file follows, because the review found them broken:
 *
 *  1. It never writes the HKCU Run key. The app calls
 *     `app.setLoginItemSettings` on every start, and `--user-data-dir` does not
 *     isolate HKCU, so both sides are launched through a generated diagnostic
 *     wrapper (`out/main/diagnostic-entry.cjs`) that logs the call instead of
 *     performing it. The Run key is read twice (before/after) with a
 *     structured PowerShell read and diffed by a pure function; a difference is
 *     reported and invalidates the run. Nothing is restored, removed or rewritten.
 *
 *  2. CPU is reported in the right unit: FILETIME ticks are converted once
 *     (`cpuMsFromTicks`). A controlled busy-loop self-check is recorded next to it.
 *
 *  3. Nothing inside a timing window calls PowerShell. PID sets, tree walks and
 *     ancestor checks use the native Toolhelp32 table (1–10 ms); WMI is only used
 *     outside windows, to attach command lines for role classification.
 *
 *  4. A launch that never reaches `[app] ready`, or that logs a bootstrap
 *     failure, is an invalid sample: it goes into `failures`, not into a median.
 *
 * Run:
 *   node scripts/benchmark-electron-app.mjs --app-root=<dir> --label=baseline \
 *     --source=<ref> --output=<file> [--playback-evidence=<file>] [--cpu-check]
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, release as osRelease, tmpdir, totalmem } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import { BUSY_LOOP_SOURCE, cpuMsFromTicks, perSecond } from './lib/cpu.mjs'
import { countMarker, ensureWrapper, sha256 as sha256Text, WRAPPER_MARKER, WRAPPER_RELATIVE } from './lib/diagnostic-entry.mjs'
import { loadPlaybackEvidence } from './lib/playback.mjs'
import { descendantsOf, listProcessTable } from './lib/process-table.mjs'
import { isolationReport, powerShellPath, readRunKey } from './lib/run-key.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT_ROOT = resolve(HERE, '..')
const require = createRequire(import.meta.url)

// ── CLI ──────────────────────────────────────────────────────────────────────
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
const appRootOption = option('app-root', SCRIPT_ROOT)
if (appRootOption === true) throw new Error('--app-root needs a directory')
/** The app under test may live outside this repository (the baseline worktree does). */
const APP_ROOT = resolve(String(appRootOption))
const ENTRY = join(APP_ROOT, 'out', 'main', 'index.js')
const WRAPPER = join(APP_ROOT, 'out', 'main', 'diagnostic-entry.cjs')

const openSamples = Number(option('open-samples', 20))
const idleRuns = Number(option('idle-runs', 3))
const idleMs = Number(option('idle-ms', 60_000))
const toggles = Number(option('toggles', 20))
const lifecycleIdleMs = Number(option('lifecycle-idle-ms', 40_000))
const settleMs = Number(option('settle-ms', 4_000))
const coldPillWaitMs = Number(option('cold-pill-wait-ms', 8_000))
const skipCold = args.includes('--skip-cold')
const withPill = args.includes('--pill')
const withLifecycle = !args.includes('--skip-lifecycle')
/** On by default: the comparison refuses to adopt without it. `--skip-cpu-check` is for quick loops. */
const cpuCheck = !args.includes('--skip-cpu-check')
const sourceRef = String(option('source', '') ?? '')
const playbackPath = option('playback-evidence', null)
const output = String(option('output', join(SCRIPT_ROOT, 'tests', 'yu-v2', 'evidence', `.electron-app-${label}.json`)))

const POLL_MS = 20
const CPU_SAMPLE_MS = 250
/** Descendant count must hold still this long before the tree counts as ready. */
const TREE_STABLE_MS = 200
const READY_TIMEOUT_MS = 30_000
const TREE_TIMEOUT_MS = 60_000
const HUB_TIMEOUT_MS = 30_000

if (!Number.isInteger(openSamples) || openSamples < 1) throw new Error('--open-samples must be a positive integer')
if (!Number.isInteger(toggles) || toggles < 1) throw new Error('--toggles must be a positive integer')
if (!Number.isInteger(idleRuns) || idleRuns < 1) throw new Error('--idle-runs must be a positive integer')

// ── App root, electron, preconditions ────────────────────────────────────────
const toPosix = (path) => String(path).split(String.fromCharCode(92)).join('/')

function pickElectron() {
  const candidates = [
    join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    join(SCRIPT_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error(`electron.exe was not found in ${candidates.join(' or ')}`)
  return found
}
const ELECTRON = pickElectron()

/**
 * In development `app.getAppPath()` is the directory of the entry script, i.e.
 * `out/main`, so the app resolves its native helpers and resources from
 * `out/main/native/bin` and `out/main/resources`. Missing assets mean
 * `createTray` throws and the run measures a broken app, so the run stops here
 * instead of producing numbers nobody can attribute.
 */
function preconditions() {
  const required = [
    { what: 'compiled main entry', path: ENTRY },
    { what: 'renderer build', path: join(APP_ROOT, 'out', 'renderer', 'bar.html') },
    { what: 'tray icon beside the entry (app.getAppPath() is out/main)', path: join(APP_ROOT, 'out', 'main', 'resources', 'tray', 'dark.ico') },
    { what: 'native helpers beside the entry', path: join(APP_ROOT, 'out', 'main', 'native', 'bin') }
  ]
  const rows = required.map((item) => ({ ...item, exists: existsSync(item.path), relative: toPosix(relative(APP_ROOT, item.path)) }))
  return { ok: rows.every((row) => row.exists), required: rows, missing: rows.filter((row) => !row.exists).map((row) => row.relative), appRoot: APP_ROOT, electron: ELECTRON }
}

const launchAssets = preconditions()
if (!launchAssets.ok) {
  console.error(`[app] ${label}: the app root is not launchable, so no sample was taken`)
  for (const row of launchAssets.required) console.error(`[app]   ${row.exists ? 'ok     ' : 'MISSING'} ${row.relative} (${row.what})`)
  console.error('[app] fix the build (pnpm build) or place native/ and resources/ beside out/main/index.js')
  process.exit(2)
}

const wrapperInfo = ensureWrapper(APP_ROOT)
if (!wrapperInfo) throw new Error('the diagnostic wrapper could not be written')
const wrapperSha256 = wrapperInfo.sha256

// ── Win32 ────────────────────────────────────────────────────────────────────
const koffi = require('koffi')
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

const WM_CLOSE = 0x0010
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

/** One conversion only: FILETIME ticks → milliseconds (see lib/cpu.mjs). */
function readCpuMs(pid) {
  const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (!handle) return null
  try {
    if (!GetProcessTimes(handle, filetimes[0], filetimes[1], filetimes[2], filetimes[3])) return null
    return { kernelMs: cpuMsFromTicks(filetimes[2].readBigUInt64LE()), userMs: cpuMsFromTicks(filetimes[3].readBigUInt64LE()) }
  } finally {
    CloseHandle(handle)
  }
}

/**
 * Command lines, for role classification only (renderer / gpu / utility).
 * One WMI call costs about a second, so it is never called inside a timing
 * window; `wmiCalls` records how often it happened.
 */
let wmiCalls = 0
const warnings = []

function commandLines() {
  wmiCalls += 1
  const script = [
    'Get-CimInstance Win32_Process |',
    'Select-Object ProcessId,ParentProcessId,Name,CommandLine |',
    'ConvertTo-Json -Compress -Depth 3'
  ].join(' ')
  const out = spawnSync(powerShellPath(), ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (out.status !== 0) throw new Error(`process command lines failed: ${out.stderr?.trim() ?? out.status}`)
  const parsed = JSON.parse(out.stdout || '[]')
  const map = new Map()
  for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
    map.set(Number(row.ProcessId), { pid: Number(row.ProcessId), ppid: Number(row.ParentProcessId), name: String(row.Name ?? ''), cmd: String(row.CommandLine ?? '') })
  }
  return map
}

function safeCommandLines() {
  try {
    return commandLines()
  } catch (error) {
    warnings.push(`command lines unavailable for role classification: ${error?.message ?? error}`)
    return new Map()
  }
}

function roleOf(proc, cmd = '') {
  if (/(^|\\)typeless-(hotkey|uia|wake|speech|local-asr|windows)\.exe$/i.test(proc.name)) return 'helper'
  if (String(proc.name).toLowerCase() === 'electron.exe') {
    if (cmd.includes('--type=gpu-process')) return 'gpu'
    if (cmd.includes('--type=utility')) return 'utility'
    if (cmd.includes('--type=renderer')) return 'renderer'
    if (cmd.includes('--type=crashpad-handler')) return 'crashpad'
    if (cmd.includes('--type=zygote')) return 'zygote'
    return cmd ? 'main' : 'electron-child'
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

// ── helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits

function sha256File(file) {
  return sha256Text(readFileSync(file))
}

/** Build identity. A copied work tree is not a git repo, so this reports that instead of throwing. */
function buildGit() {
  const rev = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: APP_ROOT, encoding: 'utf8' })
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: APP_ROOT, encoding: 'utf8' })
  if (rev.status !== 0) return { rev: null, dirty: null, gitError: String(rev.stderr ?? '').trim().slice(0, 200) || 'not a git work tree' }
  return { rev: String(rev.stdout ?? '').trim(), dirty: String(status.stdout ?? '').trim().length > 0 }
}

function lines(text) {
  return String(text ?? '')
    .split(String.fromCharCode(10))
    .map((line) => line.replaceAll(String.fromCharCode(13), ''))
    .filter((line) => line.trim().length > 0)
}

function summarise(values) {
  if (!values.length) return { count: 0, min: null, p50: null, p95: null, max: null }
  const sorted = [...values].sort((a, b) => a - b)
  return { count: sorted.length, min: sorted[0], p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted.at(-1) }
}

function percentile(values, quantile) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * quantile) - 1]
}

function median(values) {
  const usable = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
  if (!usable.length) return null
  return percentile(usable, 0.5)
}

// ── launcher ─────────────────────────────────────────────────────────────────
/** Every launch is registered so the marker count covers the whole run. */
const launched = []
let markerTotal = 0

function appEnv() {
  const env = { ...process.env }
  // These would change what "the app" means: a dev server URL, plain-Node mode,
  // or the self-test harness left over from another run.
  delete env.ELECTRON_RENDERER_URL
  delete env.ELECTRON_RUN_AS_NODE
  for (const key of Object.keys(env)) if (key.startsWith('TYPELESS_SELFTEST')) delete env[key]
  return env
}

function recordStream(child, stream) {
  return (chunk) => {
    const at = performance.now()
    const text = String(chunk)
    if (stream === 'stdout') child.__stdout = (child.__stdout + text).slice(-200_000)
    else child.__stderr = (child.__stderr + text).slice(-200_000)
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      child.__events.push({ at, stream, line })
    }
    markerTotal += countMarker(text)
  }
}

/**
 * Start the app through the diagnostic wrapper. `--background` keeps it in the
 * tray; the wrapper sits next to index.js so `app.getAppPath()` is unchanged.
 */
function launch(profile, extraEnv = {}) {
  const child = spawn(ELECTRON, [WRAPPER, `--user-data-dir=${profile}`, '--background'], {
    cwd: APP_ROOT,
    env: { ...appEnv(), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.__stdout = ''
  child.__stderr = ''
  child.__events = []
  child.__spawnedAt = performance.now()
  child.stdout?.on('data', recordStream(child, 'stdout'))
  child.stderr?.on('data', recordStream(child, 'stderr'))
  launched.push(child)
  return child
}

/** The second instance: same wrapper, so its start cannot write HKCU either. */
function requestOpen(profile) {
  const child = spawn(ELECTRON, [WRAPPER, `--user-data-dir=${profile}`], {
    cwd: APP_ROOT,
    env: appEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.__stdout = ''
  child.__stderr = ''
  child.__events = []
  child.__spawnedAt = performance.now()
  child.stdout?.on('data', recordStream(child, 'stdout'))
  child.stderr?.on('data', recordStream(child, 'stderr'))
  launched.push(child)
  return child
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

// ── readiness ────────────────────────────────────────────────────────────────
const READY_MARKER = '[app] ready'
const BOOTSTRAP_FAILURES = ['[app] bootstrap failed', 'Failed to load image']

/**
 * Did this process get far enough to be measured? A boot that failed on a
 * missing tray icon, or that never logged ready, produces process counts and
 * memory numbers that belong to a half-started app.
 */
function validityOf(child) {
  const text = `${child.__stdout ?? ''}\n${child.__stderr ?? ''}`
  const failures = BOOTSTRAP_FAILURES.map((marker) => ({ marker, line: lines(text).find((line) => line.includes(marker)) ?? null })).filter((entry) => entry.line)
  const readyLine = lines(text).find((line) => line.includes(READY_MARKER)) ?? null
  return {
    ready: Boolean(readyLine),
    readyLine,
    failures,
    valid: Boolean(readyLine) && failures.length === 0,
    invalidBecause: !readyLine ? `never logged "${READY_MARKER}"` : failures.length ? failures.map((entry) => entry.marker).join(', ') : null
  }
}

class InvalidSample extends Error {
  constructor(reason, details) {
    super(reason)
    this.name = 'InvalidSample'
    this.details = details ?? null
  }
}

async function waitForReady(child, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = performance.now() + timeoutMs
  let validity = validityOf(child)
  while (performance.now() < deadline) {
    if (validity.valid || validity.failures.length) return validity
    await sleep(100)
    validity = validityOf(child)
  }
  return validity
}

/**
 * Native table until the descendant count holds still for TREE_STABLE_MS, so
 * the recorded moment is not the first child but the settled tree. Command
 * lines (WMI) are fetched once, after the loop, outside the measured interval.
 */
async function waitForTree(child, timeoutMs = TREE_TIMEOUT_MS) {
  const deadline = performance.now() + timeoutMs
  let count = 0
  let stableSince = null
  let treeReadyAt = null
  while (performance.now() < deadline) {
    const size = descendantsOf(listProcessTable(), child.pid).length
    const now = performance.now()
    if (size > 0 && size === count) {
      if (stableSince === null) stableSince = now
      if (now - stableSince >= TREE_STABLE_MS) {
        treeReadyAt = now
        count = size
        break
      }
    } else {
      count = size
      stableSince = null
    }
    await sleep(POLL_MS)
  }
  if (treeReadyAt === null) throw new Error(`the app tree did not appear within ${timeoutMs} ms (descendants: ${count})`)

  const commands = safeCommandLines()
  const table = listProcessTable()
  const tree = descendantsOf(table, child.pid).map((proc) => ({ ...proc, role: roleOf(proc, commands.get(proc.pid)?.cmd ?? '') }))
  return {
    treeReadyMs: round(treeReadyAt - child.__spawnedAt),
    processCount: tree.length + 1,
    gpu: tree.some((proc) => proc.role === 'gpu'),
    roles: tree.reduce((acc, proc) => ({ ...acc, [proc.role]: (acc[proc.role] ?? 0) + 1 }), {})
  }
}

/** Tree + ready gate, used by every scenario before it measures anything. */
async function awaitHealthy(child, scenario) {
  const tree = await waitForTree(child)
  const validity = await waitForReady(child)
  if (!validity.valid) throw new InvalidSample(`${scenario}: ${validity.invalidBecause}`, { tree, validity, stderr: collectStderr(child) })
  return { tree, validity }
}

/** `[bar] capture warm` as an arrival time, or null with the reason it is null. */
function pillReadyOf(child, sinceSpawn = true) {
  const event = child.__events.find((entry) => entry.line.includes('[bar] capture warm'))
  if (!event) return { ms: null, reason: 'the run never logged "[bar] capture warm"; this side did not create the pill' }
  return { ms: round(event.at - (sinceSpawn ? child.__spawnedAt : 0)), reason: null }
}

async function waitForPillReady(child, timeoutMs) {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const found = pillReadyOf(child)
    if (found.ms !== null) return found
    if (child.exitCode !== null) return { ms: null, reason: `the app exited (code ${child.exitCode}) before logging "[bar] capture warm"` }
    await sleep(100)
  }
  return pillReadyOf(child)
}

/** EnumWindows poll inside the window; PID sets come from the native table. */
async function waitForHub(child, timeoutMs = HUB_TIMEOUT_MS) {
  const deadline = performance.now() + timeoutMs
  let polls = 0
  while (performance.now() < deadline) {
    polls += 1
    const pids = new Set([child.pid, ...descendantsOf(listProcessTable(), child.pid).map((proc) => proc.pid)])
    const hub = listWindows(pids).find((win) => win.title === '语' && win.className.includes('Chrome_WidgetWin'))
    if (hub) return { hub, polls }
    await sleep(POLL_MS)
  }
  return { hub: null, polls }
}

// ── sampling ─────────────────────────────────────────────────────────────────
/**
 * One memory snapshot of the whole tree. Command lines are refreshed here so
 * roles stay right for renderers that appeared after launch; this never runs
 * inside a latency window.
 */
function snapshot(rootPid) {
  const commands = safeCommandLines()
  const table = listProcessTable()
  const root = table.find((proc) => proc.pid === rootPid) ?? { pid: rootPid, ppid: 0, name: 'electron.exe' }
  const entries = [root, ...descendantsOf(table, rootPid)].map((proc) => {
    const memory = readMemory(proc.pid)
    return {
      pid: proc.pid,
      ppid: proc.ppid,
      name: proc.name,
      role: roleOf(proc, commands.get(proc.pid)?.cmd ?? ''),
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
    processes: entries,
    totals,
    byRole,
    unavailable: entries.filter((entry) => entry.privateResidentBytes === null).map((entry) => entry.pid)
  }
}

/**
 * CPU over an explicit window, sampled every CPU_SAMPLE_MS from the native table.
 *
 * Processes that appear after the window opened are measured from their first
 * sample; processes that exit are counted up to their last reading and flagged.
 * A PID whose times cannot be read is `unavailable`, never zero. This is not
 * full process-tree accounting and the evidence says so.
 */
async function cpuWindow(rootPid, windowMs, { cmdMap = new Map(), sampleMs = CPU_SAMPLE_MS } = {}) {
  const seen = new Map()
  const started = performance.now()

  const sampleOnce = () => {
    const table = listProcessTable()
    const tree = [{ pid: rootPid, ppid: 0, name: 'electron.exe' }, ...descendantsOf(table, rootPid)]
    const live = new Set()
    for (const proc of tree) {
      if (live.has(proc.pid)) continue
      live.add(proc.pid)
      let entry = seen.get(proc.pid)
      if (!entry) {
        entry = { pid: proc.pid, name: proc.name, role: roleOf(proc, cmdMap.get(proc.pid)?.cmd ?? ''), first: null, last: null, exitedMidWindow: false }
        seen.set(proc.pid, entry)
      }
      const times = readCpuMs(proc.pid)
      if (!times) continue
      if (!entry.first) entry.first = times
      entry.last = times
    }
    for (const proc of seen.values()) if (!live.has(proc.pid) && proc.last) proc.exitedMidWindow = true
  }

  while (true) {
    sampleOnce()
    const elapsed = performance.now() - started
    if (elapsed >= windowMs) break
    await sleep(Math.max(0, Math.min(sampleMs, windowMs - elapsed)))
  }
  const elapsed = performance.now() - started

  const perPid = []
  const unavailablePids = []
  let totalMs = 0
  let exitedMidWindow = 0
  for (const entry of seen.values()) {
    if (!entry.first || !entry.last) {
      unavailablePids.push(entry.pid)
      continue
    }
    const userMs = round(entry.last.userMs - entry.first.userMs)
    const kernelMs = round(entry.last.kernelMs - entry.first.kernelMs)
    const sum = round(userMs + kernelMs)
    if (sum < 0) {
      unavailablePids.push(entry.pid)
      continue
    }
    perPid.push({ pid: entry.pid, role: entry.role, userMs, kernelMs, totalMs: sum, exitedMidWindow: entry.exitedMidWindow })
    totalMs += sum
    if (entry.exitedMidWindow) exitedMidWindow += 1
  }
  totalMs = round(totalMs)
  return {
    windowMs: round(elapsed),
    cores: cpus().length,
    perPid,
    totalMs,
    perSecond: perSecond(totalMs, elapsed),
    coverage: {
      windowMs: round(elapsed),
      cores: cpus().length,
      pids: { seen: seen.size, exitedMidWindow, unavailable: unavailablePids.length },
      unavailablePids,
      limitation:
        'CPU burned by a process before its first sample (250 ms grid) is not counted; a process that exits between samples contributes only up to its last reading. This is a sampled tree, not exact process-tree accounting.'
    }
  }
}

/**
 * Controlled CPU self-check: one busy thread against the wall clock.
 * A single spinning thread is one core, so a 1000 ms window should show
 * ~1000 ms of CPU. Coarse on purpose (±35%): it catches unit errors of the
 * 1000× kind without pretending to be a calibration.
 */
async function cpuSelfCheck(windowMs = 1000) {
  const child = spawn(process.execPath, ['-e', BUSY_LOOP_SOURCE], { stdio: 'ignore' })
  try {
    const deadline = performance.now() + 5_000
    let first = null
    while (performance.now() < deadline) {
      first = readCpuMs(child.pid)
      if (first && first.userMs + first.kernelMs > 0) break
      await sleep(POLL_MS)
    }
    await sleep(200)
    first = readCpuMs(child.pid)
    const started = performance.now()
    await sleep(windowMs)
    const second = readCpuMs(child.pid)
    const elapsed = performance.now() - started
    if (!first || !second) return { pass: false, skipped: false, reason: 'the busy child could not be sampled', windowMs: round(elapsed), cores: cpus().length }
    const measuredMs = round(second.userMs + second.kernelMs - (first.userMs + first.kernelMs))
    const expectedMs = round(elapsed)
    const ratio = expectedMs > 0 ? round(measuredMs / expectedMs) : null
    return {
      windowMs: round(elapsed),
      cores: cpus().length,
      expectedMs,
      measuredMs,
      ratio,
      pass: ratio !== null && Math.abs(ratio - 1) <= 0.35,
      skipped: false,
      note: 'coarse self-check: one busy thread versus wall clock, ±35% tolerance'
    }
  } finally {
    child.kill()
  }
}

function cluster(samples, phase) {
  const picked = samples.filter((sample) => sample.phase === phase)
  const values = picked.map((sample) => sample.totals.privateResidentBytes)
  return {
    phase,
    count: picked.length,
    summary: summarise(values),
    unavailable: picked.reduce((sum, sample) => sum + sample.unavailable.length, 0),
    byRole: medianByRole(picked),
    last: picked.at(-1) ?? null
  }
}

function medianByRole(samples) {
  if (samples.length === 0) return {}
  const ordered = [...samples].sort((a, b) => a.totals.privateResidentBytes - b.totals.privateResidentBytes)
  return ordered[Math.floor(ordered.length / 2)].byRole
}

/** Raw per-role samples, grouped by role — the evidence keeps the rows, not just totals. */
function byRoleSamples(samples) {
  const grouped = {}
  for (const sample of samples) {
    for (const proc of sample.processes) {
      const bucket = (grouped[proc.role] ??= [])
      bucket.push({
        phase: sample.phase,
        at: sample.at ?? null,
        pid: proc.pid,
        name: proc.name,
        privateResidentBytes: proc.privateResidentBytes,
        workingSetBytes: proc.workingSetBytes,
        committedBytes: proc.committedBytes
      })
    }
  }
  return grouped
}

// ── scenarios ────────────────────────────────────────────────────────────────
async function withProfile(prefix, body) {
  const profile = mkdtempSync(join(tmpdir(), `typeless-${prefix}-`))
  try {
    return await body(profile)
  } finally {
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
  }
}

/**
 * Cold start. Two figures, both from the same launch: when the tree settled
 * (native table) and when the pill became usable (`[bar] capture warm`), the
 * latter possibly null with a reason. There is no fixed sleep standing in for
 * readiness, and nothing here feeds the first-open distribution.
 */
async function coldRun() {
  return withProfile('cold', async (profile) => {
    const child = launch(profile)
    const started = performance.now()
    try {
      const { tree, validity } = await awaitHealthy(child, 'cold start')
      const pill = await waitForPillReady(child, coldPillWaitMs)
      await sleep(settleMs)
      const memory = snapshot(child.pid)
      const cpu = await cpuWindow(child.pid, 10_000, { cmdMap: safeCommandLines() })
      return {
        valid: true,
        spawnedAt: new Date().toISOString(),
        spawnToTreeReadyMs: tree.treeReadyMs,
        spawnToPillReadyMs: pill.ms,
        pillReason: pill.reason,
        tree: { processCount: tree.processCount, gpu: tree.gpu, roles: tree.roles },
        validity,
        settleMs,
        memory,
        cpu,
        elapsedMs: round(performance.now() - started),
        stderr: collectStderr(child)
      }
    } catch (error) {
      return {
        valid: false,
        reason: error?.message ?? String(error),
        details: error?.details ?? null,
        validity: validityOf(child),
        stderr: collectStderr(child)
      }
    } finally {
      await stopApp(child)
    }
  })
}

/**
 * First hub open: hidden start → tree + ready → settle → second instance →
 * timing until the hub window is visible. Only native calls and EnumWindows
 * happen inside the window. Every sample records `{latencyMs, ok}`; failures go
 * to `failed` and are counted by the comparison.
 */
async function firstOpenLoop(samples, idleSamples) {
  const valid = []
  const failed = []
  for (let index = 0; index < samples; index += 1) {
    await withProfile('open', async (profile) => {
      const child = launch(profile)
      try {
        const { tree } = await awaitHealthy(child, 'first open')
        await sleep(settleMs)
        idleSamples.push({ phase: 'settled-4s', ...snapshot(child.pid) })
        const started = performance.now()
        const opener = requestOpen(profile)
        const { hub, polls } = await waitForHub(child)
        const latencyMs = hub ? round(performance.now() - started) : null
        opener.kill()
        if (hub) {
          valid.push({ index: index + 1, latencyMs, ok: true, polls, treeReadyMs: tree.treeReadyMs })
        } else {
          failed.push({ index: index + 1, latencyMs: null, ok: false, reason: `the hub window never appeared within ${HUB_TIMEOUT_MS} ms`, polls, validity: validityOf(child), stderr: collectStderr(child) })
        }
      } catch (error) {
        failed.push({ index: index + 1, latencyMs: null, ok: false, reason: error?.message ?? String(error), details: error?.details ?? null, validity: validityOf(child) })
      } finally {
        await stopApp(child)
      }
    })
  }
  return { valid, failed }
}

/**
 * Tray idle: one launch, settle, then a CPU window of `idleMs` and a memory
 * snapshot. This is the cluster the comparison gates memory and CPU on.
 */
async function trayIdleRun() {
  return withProfile('idle', async (profile) => {
    const child = launch(profile)
    try {
      const { tree, validity } = await awaitHealthy(child, 'tray idle')
      await sleep(settleMs)
      const cpu = await cpuWindow(child.pid, idleMs, { cmdMap: safeCommandLines() })
      const memory = { phase: 'idle-60s', ...snapshot(child.pid) }
      return { valid: true, treeReadyMs: tree.treeReadyMs, cpu, memory, validity }
    } catch (error) {
      return { valid: false, reason: error?.message ?? String(error), details: error?.details ?? null, validity: validityOf(child), stderr: collectStderr(child) }
    } finally {
      await stopApp(child)
    }
  })
}

/**
 * Toggle cycles: reopen latency per cycle plus a memory sample after each hide.
 * Per-cycle samples answer whether repeated toggling accumulates anything.
 */
async function toggleRun() {
  return withProfile('toggle', async (profile) => {
    const child = launch(profile)
    const samples = []
    const cycles = []
    const failed = []
    try {
      const { tree } = await awaitHealthy(child, 'toggle')
      await sleep(settleMs)
      const before = snapshot(child.pid)
      for (let index = 0; index < toggles; index += 1) {
        const started = performance.now()
        const opener = requestOpen(profile)
        const { hub } = await waitForHub(child)
        const latencyMs = hub ? round(performance.now() - started) : null
        opener.kill()
        if (!hub) {
          failed.push({ cycle: index + 1, latencyMs: null, ok: false, reason: `the hub window never appeared on toggle ${index + 1}` })
          continue
        }
        samples.push({ cycle: index + 1, latencyMs, ok: true })
        await sleep(1_200)
        PostMessageW(hub.handle, WM_CLOSE, 0, 0)
        await sleep(1_200)
        const cycle = snapshot(child.pid)
        cycles.push({
          cycle: index + 1,
          latencyMs,
          privateResidentBytes: cycle.totals.privateResidentBytes,
          renderers: cycle.processes.filter((proc) => proc.role === 'renderer').length,
          utility: cycle.processes.filter((proc) => proc.role === 'utility').length
        })
      }
      await sleep(idleMs)
      const memory = { phase: 'after-toggles', ...snapshot(child.pid) }
      return { valid: true, treeReadyMs: tree.treeReadyMs, samples, failed, cycles, before, memory }
    } catch (error) {
      return { valid: false, reason: error?.message ?? String(error), details: error?.details ?? null, samples, failed, cycles, validity: validityOf(child) }
    } finally {
      await stopApp(child)
    }
  })
}

/**
 * Pill window lifecycle, observed from outside: opening the hub makes the
 * settings renderer ask for the microphone list, answered by the bar renderer.
 * Whether the bar is still there after the hub closes is what the retirement
 * change alters, so this records renderer PIDs rather than an opinion.
 */
async function lifecycleRun() {
  return withProfile('life', async (profile) => {
    const child = launch(profile)
    const seen = []
    const commandsFor = () => safeCommandLines()
    const renderersNow = () => {
      const commands = commandsFor()
      const table = listProcessTable()
      return descendantsOf(table, child.pid)
        .filter((proc) => roleOf(proc, commands.get(proc.pid)?.cmd ?? '') === 'renderer')
        .map((proc) => proc.pid)
    }
    try {
      const { tree } = await awaitHealthy(child, 'lifecycle')
      await sleep(settleMs)
      seen.push({ at: 'startup', renderers: renderersNow() })
      const opener = requestOpen(profile)
      const { hub } = await waitForHub(child)
      opener.kill()
      if (!hub) throw new InvalidSample('the hub window never appeared for the lifecycle run')
      await sleep(3_000)
      seen.push({ at: 'hub-open', renderers: renderersNow() })
      PostMessageW(hub.handle, WM_CLOSE, 0, 0)
      await sleep(lifecycleIdleMs)
      seen.push({ at: 'after-hide-idle', renderers: renderersNow() })
      return { valid: true, treeReadyMs: tree.treeReadyMs, seen }
    } catch (error) {
      return { valid: false, reason: error?.message ?? String(error), details: error?.details ?? null, seen, validity: validityOf(child) }
    } finally {
      await stopApp(child)
    }
  })
}

/**
 * Pill lifecycle under the self-test harness: real takes without a microphone.
 * Kept as-is apart from the wrapper launch and the validity gate.
 */
async function pillScenario(repeatMs = 45_000, observeMs = 130_000) {
  return withProfile('pill', async (profile) => {
    const logs = []
    const mock = spawn(process.execPath, [join(SCRIPT_ROOT, 'scripts', 'mock-openai.mjs')], { cwd: SCRIPT_ROOT, env: appEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    await sleep(1_500)
    const child = launch(profile, { TYPELESS_SELFTEST: '1', TYPELESS_SELFTEST_STAY: '1', TYPELESS_SELFTEST_REPEAT_MS: String(repeatMs) })
    const renderers = []
    const started = performance.now()
    let valid = false
    try {
      const health = await awaitHealthy(child, 'pill')
      valid = health.validity.valid
      while (performance.now() - started < observeMs) {
        const commands = safeCommandLines()
        const pids = descendantsOf(listProcessTable(), child.pid)
          .filter((proc) => roleOf(proc, commands.get(proc.pid)?.cmd ?? '') === 'renderer')
          .map((proc) => proc.pid)
          .sort((a, b) => a - b)
        const sample = { atMs: Math.round(performance.now() - started), rendererPids: pids }
        const previous = renderers.at(-1)
        if (!previous || previous.rendererPids.join(',') !== pids.join(',')) renderers.push(sample)
        await sleep(1_000)
      }
    } catch (error) {
      logs.push(`invalid: ${error?.message ?? error}`)
    } finally {
      logs.push(...lines(child.__stderr))
      logs.push(...lines(child.__stdout))
      await stopApp(child)
      mock.kill()
    }
    const distinct = new Set(renderers.flatMap((sample) => sample.rendererPids))
    return {
      valid,
      observeMs,
      repeatMs,
      retirements: logs.filter((line) => line.includes('[bar] retiring the hidden pill window')).length,
      takes: logs.filter((line) => line.includes('[selftest] repeat →') || line.includes('[selftest] dictation →')).length,
      distinctRenderers: [...distinct].sort((a, b) => a - b),
      timeline: renderers,
      tail: logs.filter((line) => line.includes('[bar]') || line.includes('[selftest]')).slice(-20)
    }
  })
}

// ── run ──────────────────────────────────────────────────────────────────────
const startedAt = new Date().toISOString()
const runKeyBefore = readRunKey({ spawnSync })
const scriptSha256 = sha256File(fileURLToPath(import.meta.url))

const coldRuns = []
const idleSamples = []
const trayRuns = []
let firstOpen = { valid: [], failed: [] }
let toggle = { valid: false, samples: [], failed: [], cycles: [] }
let lifecycle = null
let pill = null
let cpuSelf = { pass: false, skipped: true, reason: 'not run' }
let fatal = null

try {
  if (buildGit().rev === null && !sourceRef) warnings.push('the app root is not a git work tree; pass --source=<ref> so the build identity is recorded')
  if (cpuCheck) cpuSelf = await cpuSelfCheck()
  else cpuSelf = { pass: false, skipped: true, reason: 'skipped with --skip-cpu-check' }

  if (!skipCold) coldRuns.push(await coldRun())
  firstOpen = await firstOpenLoop(openSamples, idleSamples)
  for (let index = 0; index < idleRuns; index += 1) {
    const run = await trayIdleRun()
    trayRuns.push(run)
    if (run.valid) idleSamples.push(run.memory)
  }
  toggle = await toggleRun()
  if (withLifecycle) lifecycle = await lifecycleRun()
  if (withPill) pill = await pillScenario()
} catch (error) {
  fatal = { message: error?.message ?? String(error), stack: String(error?.stack ?? '').slice(-2000) }
  console.error(`[app] ${label}: run stopped: ${fatal.message}`)
}

for (const child of launched) await stopApp(child)

const runKeyAfter = readRunKey({ spawnSync })
const isolation = isolationReport(runKeyBefore, runKeyAfter, { markerCount: markerTotal, marker: WRAPPER_MARKER })
if (!isolation.valid) {
  for (const reason of isolation.reasons) console.warn(`[app] ${label}: isolation warning: ${reason}`)
}

const replay = playbackPath ? loadPlaybackEvidence(playbackPath) : null
const playbackMeta = replay ? { path: replay.path, ok: replay.ok, pass: replay.pass, caseCount: replay.caseCount, error: replay.error } : null

const idleClusterSamples = idleSamples
const cpuRuns = trayRuns.filter((run) => run.valid && run.cpu)
const trayCpu = {
  windowMs: median(cpuRuns.map((run) => run.cpu.windowMs)),
  cores: cpus().length,
  totalMs: median(cpuRuns.map((run) => run.cpu.totalMs)),
  perSecond: median(cpuRuns.map((run) => run.cpu.perSecond)),
  runs: cpuRuns.map((run) => ({ windowMs: run.cpu.windowMs, totalMs: run.cpu.totalMs, perSecond: run.cpu.perSecond, coverage: run.cpu.coverage })),
  unavailable: cpuRuns.reduce((sum, run) => sum + run.cpu.coverage.pids.unavailable, 0)
}

const evidence = {
  kind: 'electron-app-resources',
  version: 2,
  label,
  meta: {
    generatedAt: startedAt,
    host: {
      os: `${process.platform} ${osRelease()}`,
      arch: process.arch,
      cpuModel: cpus()[0]?.model ?? '',
      cores: cpus().length,
      totalMemMb: Math.round(totalmem() / 1048576)
    },
    node: process.version,
    appRoot: APP_ROOT,
    electron: {
      path: ELECTRON,
      relative: toPosix(relative(APP_ROOT, ELECTRON).startsWith('..') ? ELECTRON : relative(APP_ROOT, ELECTRON)),
      // ELECTRON_RUN_AS_NODE turns electron into plain Node, which answers
      // --version with the bundled Node version; appEnv() strips it.
      version: String(spawnSync(ELECTRON, ['--version'], { encoding: 'utf8', env: appEnv() }).stdout ?? '').trim().replace(/^v/, ''),
      sha256: sha256File(ELECTRON)
    },
    build: {
      entry: toPosix(relative(APP_ROOT, ENTRY)),
      entrySha256: sha256File(ENTRY),
      wrapperSha256,
      script: toPosix(relative(SCRIPT_ROOT, fileURLToPath(import.meta.url))),
      scriptSha256,
      ...buildGit(),
      source: sourceRef || 'HEAD',
      assets: launchAssets.required
    },
    launch: {
      entry: toPosix(relative(APP_ROOT, ENTRY)),
      entrySha256: sha256File(ENTRY),
      wrapper: { file: WRAPPER_RELATIVE, sha256: wrapperSha256, generated: wrapperInfo.written },
      args: ['<wrapper>', '--user-data-dir=<temp>', '--background'],
      marker: WRAPPER_MARKER,
      env: 'ELECTRON_RENDERER_URL, ELECTRON_RUN_AS_NODE and TYPELESS_SELFTEST* stripped; --user-data-dir is a fresh temp directory per launch'
    },
    measurement: {
      memory: 'K32GetProcessMemoryInfo PROCESS_MEMORY_COUNTERS_EX2 per PID; unavailable reported, never zero',
      cpu: 'GetProcessTimes user+kernel delta; FILETIME ticks converted once (ticks / 10_000 → ms)',
      cpuSelfCheck: cpuSelf,
      timing: {
        source: 'toolhelp32+enumwindows',
        pollMs: { tree: POLL_MS, hub: POLL_MS, cpuSample: CPU_SAMPLE_MS, treeStable: TREE_STABLE_MS },
        coldClock: 'performance.now()',
        wmiCalls,
        powerShellInsideWindows: false,
        roleClassification: 'CommandLine via WMI, outside timing windows only',
        resolution: 'native snapshot ~9 ms plus a 20 ms sleep, so hub polling resolves to roughly 30 ms'
      },
      scenarios: { openSamples, idleRuns, idleMs, toggles, settleMs, coldPillWaitMs, lifecycleIdleMs }
    },
    playback: playbackMeta,
    isolation
  },
  isolation,
  cold: coldRuns,
  firstOpen: {
    valid: firstOpen.valid.map((sample) => ({ ...sample, ok: true })),
    failed: firstOpen.failed,
    summary: summarise(firstOpen.valid.map((sample) => sample.latencyMs)),
    // Cold samples are deliberately absent: a fixed-sleep figure is not an open latency.
    coldIncluded: false
  },
  reopen: {
    samples: toggle.samples ?? [],
    failed: toggle.failed ?? [],
    summary: summarise((toggle.samples ?? []).map((sample) => sample.latencyMs))
  },
  toggle: { cycles: toggle.cycles ?? [], latencies: (toggle.samples ?? []).map((sample) => sample.latencyMs), memory: toggle.memory ?? null, before: toggle.before ?? null, valid: toggle.valid ?? false, reason: toggle.reason ?? null },
  trayIdle: {
    runs: trayRuns,
    clusters: {
      // 'settled-4s' is the tree a moment after launch; 'idle-60s' is the tray
      // resting state the plan gates on.
      'settled-4s': cluster(idleClusterSamples, 'settled-4s'),
      'idle-60s': cluster(idleClusterSamples, 'idle-60s')
    },
    summary: cluster(idleClusterSamples, 'idle-60s').summary,
    cpu: trayCpu,
    failures: trayRuns.filter((run) => !run.valid).map((run) => ({ reason: run.reason, details: run.details ?? null, validity: run.validity ?? null })),
    last: idleClusterSamples.at(-1) ?? null
  },
  processes: { byRole: byRoleSamples(idleClusterSamples), samples: idleClusterSamples },
  lifecycle,
  pill,
  warnings,
  fatal
}

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`)

const cpuLine = cpuSelf.skipped ? 'skipped' : `${cpuSelf.measuredMs} ms in ${cpuSelf.windowMs} ms → ratio ${cpuSelf.ratio}`
console.log(`[app] ${label}: first-open p50 ${evidence.firstOpen.summary.p50} ms (n=${evidence.firstOpen.summary.count}, failed ${firstOpen.failed.length})`)
console.log(`[app] ${label}: reopen p50 ${evidence.reopen.summary.p50} ms (n=${evidence.reopen.summary.count}, failed ${evidence.reopen.failed.length})`)
console.log(`[app] ${label}: cold tree ready ${coldRuns[0]?.spawnToTreeReadyMs ?? 'n/a'} ms, pill ready ${coldRuns[0]?.spawnToPillReadyMs ?? 'null'}`)
console.log(`[app] ${label}: tray idle private resident p50 ${evidence.trayIdle.summary.p50 === null ? 'n/a' : (evidence.trayIdle.summary.p50 / 1048576).toFixed(1)} MiB, cpu ${trayCpu.perSecond} ms/s over ${trayCpu.windowMs} ms`)
console.log(`[app] ${label}: cpu self-check ${cpuLine}`)
console.log(`[app] ${label}: isolation ${isolation.valid ? 'valid' : 'INVALID'} (markers ${isolation.markerCount}, run key unchanged ${isolation.runKey.unchanged})`)
console.log(`[app] ${label}: evidence ${output}`)

const ranAnything = evidence.firstOpen.valid.length + evidence.reopen.samples.length + (coldRuns[0]?.valid ? 1 : 0) > 0
if (fatal || !isolation.valid || !ranAnything) process.exit(1)
