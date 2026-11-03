import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const koffi = require('koffi')

const options = { samples: 10, output: 'tests/yu-v2/evidence/rust-browser-url-20261104.json', edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' }
for (const [index, value] of process.argv.slice(2).entries()) {
  if (!value.startsWith('--')) continue
  const [name, inline] = value.slice(2).split('=')
  const next = inline ?? process.argv[index + 3]
  if (!(name in options)) throw new Error(`Unknown option --${name}`)
  options[name] = name === 'samples' ? Number(next) : next
}
if (!Number.isInteger(options.samples) || options.samples < 1) throw new Error('--samples must be a positive integer')

const helpers = {
  powershell: {
    executable: join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-File', join(root, 'resources/windows-tools.ps1')],
  },
  rust: { executable: join(root, 'native/bin/yu-windows.exe'), args: [] },
}

// --- window bookkeeping (koffi user32) -------------------------------------
const koffiUser32 = koffi.load('user32.dll')
const EnumProc = koffi.proto('int __stdcall EnumWindowsProc(void *hwnd, intptr_t param)')
const EnumWindows = koffiUser32.func('int EnumWindows(EnumWindowsProc *callback, intptr_t param)')
const GetWindowTextW = koffiUser32.func('int GetWindowTextW(void *hwnd, void *buffer, int max)')
const GetWindowThreadProcessId = koffiUser32.func('uint32 GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)')
const IsWindowVisible = koffiUser32.func('int IsWindowVisible(void *hwnd)')
const SetWindowPos = koffiUser32.func('int SetWindowPos(void *hwnd, void *after, int x, int y, int w, int h, uint32 flags)')
const PostMessageW = koffiUser32.func('int PostMessageW(void *hwnd, uint32 msg, void *wparam, void *lparam)')

function windows() {
  const found = []
  const buffer = Buffer.alloc(4096)
  const callback = koffi.register(hwnd => {
    if (!IsWindowVisible(hwnd)) return 1
    const length = GetWindowTextW(hwnd, koffi.as(buffer, 'void *'), 2048)
    const pid = [0]
    GetWindowThreadProcessId(hwnd, pid)
    found.push({ handle: Number(koffi.address(hwnd)), pid: pid[0], title: buffer.toString('utf16le', 0, Math.max(0, length) * 2) })
    return 1
  }, koffi.pointer(EnumProc))
  EnumWindows(callback, 0)
  koffi.unregister(callback)
  return found
}

// Only accept a window owned by the browser instance we launched. An existing
// Edge session (same or another profile) may already show a page with the same
// title; adopting it would let the operator's browsing decide the benchmark.
function browserProcesses(marker) {
  const script = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { $_.ProcessId }`
  const query = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
  return new Set((query.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).map(Number))
}

function browserWindow(owned) {
  return windows().find(window => window.title.includes('yu-browser-url') && owned.has(window.pid))
}

// --- job accounting (same technique as scripts/benchmark-speech.mjs) -------
const koffiKernel32 = koffi.load('kernel32.dll')
const JobAccounting = koffi.struct('JobAccounting', {
  TotalUserTime: 'int64', TotalKernelTime: 'int64', ThisPeriodTotalUserTime: 'int64', ThisPeriodTotalKernelTime: 'int64',
  TotalPageFaultCount: 'uint32', TotalProcesses: 'uint32', TotalTerminatedProcesses: 'uint32',
})
const JobBasicLimit = koffi.struct('JobBasicLimit', {
  PerProcessUserTimeLimit: 'int64', PerJobUserTimeLimit: 'int64', LimitFlags: 'uint32', MinimumWorkingSetSize: 'uint64',
  MaximumWorkingSetSize: 'uint64', ActiveProcessLimit: 'uint32', Affinity: 'uint64', PriorityClass: 'uint32', SchedulingClass: 'uint32',
})
const JobExtendedLimit = koffi.struct('JobExtendedLimit', {
  BasicLimitInformation: JobBasicLimit, IoInfo: 'uint8[48]',
  ProcessMemoryLimit: 'uint64', JobMemoryLimit: 'uint64', PeakProcessMemoryUsed: 'uint64', PeakJobMemoryUsed: 'uint64',
})
const CreateJobObjectW = koffiKernel32.func('void *CreateJobObjectW(void *attributes, void *name)')
const AssignProcessToJobObject = koffiKernel32.func('int AssignProcessToJobObject(void *job, void *process)')
const OpenProcess = koffiKernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)')
const CloseHandle = koffiKernel32.func('int CloseHandle(void *handle)')
const QueryAccounting = koffiKernel32.func('int QueryInformationJobObject(void *job, int class, _Out_ JobAccounting *info, uint32 length, void *returned)')
const QueryExtendedLimit = koffiKernel32.func('int QueryInformationJobObject(void *job, int class, _Out_ JobExtendedLimit *info, uint32 length, void *returned)')

const PROCESS_SET_QUOTA = 0x0100
const PROCESS_TERMINATE = 0x0001
const PROCESS_QUERY_INFORMATION = 0x0400
const PROCESS_SET_INFORMATION = 0x0200

function openJob(pid) {
  const job = CreateJobObjectW(null, null)
  const process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION | PROCESS_SET_INFORMATION, 0, pid)
  const assigned = process ? AssignProcessToJobObject(job, process) : 0
  if (process) CloseHandle(process)
  return assigned ? job : undefined
}

function accounting(job) {
  const totals = [{}]
  if (!QueryAccounting(job, 1, totals, koffi.sizeof(JobAccounting), null)) return undefined
  const limits = [{}]
  QueryExtendedLimit(job, 9, limits, koffi.sizeof(JobExtendedLimit), null)
  return {
    cpuUserMs: Number(totals[0].TotalUserTime) / 10000,
    cpuKernelMs: Number(totals[0].TotalKernelTime) / 10000,
    peakPrivateKb: Math.round(Number(limits[0].PeakProcessMemoryUsed) / 1024),
  }
}

// --- fixture ---------------------------------------------------------------
const directory = mkdtempSync(join(tmpdir(), 'yu-browser-url-'))
// The temp directory name is unique, so it identifies our browser processes.
const marker = directory.split(String.fromCharCode(92)).pop()
const page = join(directory, 'yu-browser-url.html')
writeFileSync(page, '<!doctype html><meta charset=utf-8><title>yu-browser-url</title><h1>Address fixture</h1><label for=address>Address</label><input id=address value="https://inside.example.com/not-the-address">')
const profile = join(directory, 'profile')
const browser = spawn(options.edge, ['--new-window', '--inprivate', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-features=msEdgeTabSearch', `file:///${page.replace(/\\/g, '/')}`], { stdio: 'ignore', detached: true })
browser.unref()

let owned = new Set()
let window
for (let attempt = 0; attempt < 80 && !window; attempt++) {
  await new Promise(done => setTimeout(done, 250))
  if (attempt % 4 === 0) owned = browserProcesses(marker)
  window = browserWindow(owned)
}
if (!window) throw new Error(`Fixture browser window did not appear (owned processes: ${owned.size})`)
// Off-screen, non-activating placement keeps the operator's desktop untouched.
SetWindowPos(window.handle, null, -32000, -32000, 1000, 800, 0x0010 | 0x0004)
await new Promise(done => setTimeout(done, 1000))
window = browserWindow(owned) ?? window

const request = { action: 'browser-url', handle: String(window.handle), pid: window.pid, title: window.title }
const payload = JSON.stringify(request)

function run(side, body, { timeoutMs = 60000 } = {}) {
  const { executable, args } = helpers[side]
  return new Promise(resolveRun => {
    const started = performance.now()
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const job = openJob(child.pid)
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk.slice(0, 2000)))
    child.on('close', code => {
      clearTimeout(timer)
      const totalMs = performance.now() - started
      const usage = job ? accounting(job) : undefined
      if (job) CloseHandle(job)
      resolveRun({ side, code, totalMs, stdout, stderr, ...usage })
    })
    child.stdin.end(body)
  })
}

function parse(result) {
  try {
    return JSON.parse(result.stdout)
  } catch {
    return undefined
  }
}

// --- correctness ------------------------------------------------------------
const first = { powershell: await run('powershell', payload), rust: await run('rust', payload) }
const parsed = { powershell: parse(first.powershell), rust: parse(first.rust) }
const staleRequest = { ...request, title: `${request.title} (stale)` }
const stale = { powershell: await run('powershell', JSON.stringify(staleRequest)), rust: await run('rust', JSON.stringify(staleRequest)) }
const withoutWindow = { ...request, handle: String(window.handle + 4) }
const missing = { powershell: await run('powershell', JSON.stringify(withoutWindow)), rust: await run('rust', JSON.stringify(withoutWindow)) }

// Parent death must retire the worker: the helper exits when its parent goes.
const parentFixture = spawn(process.env.ComSpec, ['/c', 'ping -n 6 127.0.0.1 >nul'], { stdio: 'ignore' })
const orphan = spawn(helpers.rust.executable, ['--parent-pid', String(parentFixture.pid)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
const orphanExit = new Promise(done => orphan.on('close', code => done({ code, at: performance.now() })))
orphan.stdin.write(payload)
await new Promise(done => setTimeout(done, 300))
const killedAt = performance.now()
parentFixture.kill()
const orphanResult = await Promise.race([orphanExit, new Promise(done => setTimeout(() => done({ code: 'timeout' }), 5000))])

// --- timed comparison -------------------------------------------------------
async function timed(side) {
  const result = await run(side, payload)
  const body = parse(result)
  return {
    side,
    ok: result.code === 0 && body !== undefined && body.url === parsed.powershell?.url,
    code: result.code,
    totalMs: result.totalMs,
    cpuMs: result.cpuUserMs === undefined ? undefined : result.cpuUserMs + result.cpuKernelMs,
    peakPrivateKb: result.peakPrivateKb,
    error: result.code === 0 ? undefined : result.stderr.trim().split('\n')[0],
  }
}

const runs = []
for (let round = 0; round < options.samples; round++) {
  for (const side of ['powershell', 'rust', 'rust', 'powershell']) runs.push(await timed(side))
}

// The fixture must still be the window we froze: same handle, same title, and
// still owned by our own browser processes.
const finalWindow = browserWindow(owned)
const fixtureStable = Boolean(finalWindow) && finalWindow.handle === window.handle && finalWindow.title === window.title

// --- statistics -------------------------------------------------------------
function percentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]
}
function summary(side) {
  const valid = runs.filter(run => run.side === side && run.ok)
  const metric = key => valid.map(run => run[key]).filter(value => typeof value === 'number')
  const stats = key => {
    const values = metric(key)
    return values.length ? { p50: Number(percentile(values, 0.5).toFixed(2)), p95: Number(percentile(values, 0.95).toFixed(2)) } : undefined
  }
  return {
    side,
    n: valid.length,
    invalid: runs.filter(run => run.side === side && !run.ok).map(run => ({ round: runs.indexOf(run), code: run.code, error: run.error })),
    totalMs: stats('totalMs'),
    cpuMs: stats('cpuMs'),
    peakPrivateKb: stats('peakPrivateKb'),
    failures: valid.filter(run => !run.ok).length,
  }
}
const aggregate = { powershell: summary('powershell'), rust: summary('rust') }

function compare(key) {
  const baseline = aggregate.powershell[key]
  const next = aggregate.rust[key]
  if (!baseline || !next) return { p50: baseline?.p50, p95: baseline?.p95, comparable: false }
  const change = (from, to) => (from ? Number((((to - from) / from) * 100).toFixed(2)) : null)
  return {
    p50: next.p50, p95: next.p95, baselineP50: baseline.p50, baselineP95: baseline.p95,
    p50Pct: change(baseline.p50, next.p50), p95Pct: change(baseline.p95, next.p95),
    p95DeltaMs: Number((next.p95 - baseline.p95).toFixed(2)), comparable: true,
  }
}
const comparison = { totalMs: compare('totalMs'), cpuMs: compare('cpuMs'), peakPrivateKb: compare('peakPrivateKb') }

// --- checks -----------------------------------------------------------------
const sameBody = (a, b) => a && b && a.title === b.title && a.url === b.url && a.path === b.path && a.truncated === b.truncated
const rejected = (result, message) => result.code !== 0 && result.stderr.includes(message)
const latency = comparison.totalMs
const memory = comparison.peakPrivateKb
const checks = [
  { name: 'result-identical', pass: sameBody(parsed.powershell, parsed.rust), detail: `powershell=${first.powershell.stdout.trim()} rust=${first.rust.stdout.trim()}` },
  { name: 'url-present', pass: typeof parsed.powershell?.url === 'string' && parsed.powershell.url.includes('yu-browser-url.html'), detail: `url=${parsed.powershell?.url}` },
  { name: 'stale-title-rejected', pass: rejected(stale.powershell, 'Original window has changed or closed') && rejected(stale.rust, 'Original window has changed or closed'), detail: `powershell=${stale.powershell.stderr.trim().split('\n')[0]} rust=${stale.rust.stderr.trim().split('\n')[0]}` },
  { name: 'missing-window-rejected', pass: rejected(missing.powershell, 'Original window has changed or closed') && rejected(missing.rust, 'Original window has changed or closed'), detail: `powershell=${missing.powershell.stderr.trim().split(String.fromCharCode(10))[0]} rust=${missing.rust.stderr.trim().split(String.fromCharCode(10))[0]}` },
  { name: 'parent-death-retires-worker', pass: orphanResult.code === 0, detail: `code=${orphanResult.code} after ${orphanResult.at ? Math.round(orphanResult.at - killedAt) : '?'}ms` },
  { name: 'samples-per-side', pass: aggregate.powershell.n >= options.samples * 2 && aggregate.rust.n >= options.samples * 2, detail: `powershell=${aggregate.powershell.n} rust=${aggregate.rust.n}` },
  { name: 'measurement-comparable', pass: latency.comparable === true && memory.comparable === true, detail: 'both sides measured by wall clock and job accounting' },
  { name: 'fixture-isolated-and-stable', pass: fixtureStable, detail: `handle=${window.handle} pid=${window.pid} ownedProcesses=${owned.size} finalTitle=${JSON.stringify(finalWindow?.title ?? null)}` },
]

// Adopt the native path only when the same-machine comparison clears a gate.
const latencyMeets = latency.p95Pct !== null && latency.p95Pct <= -25 && latency.p95DeltaMs <= -100
const memoryMeets = memory.p50Pct !== null && memory.p50Pct <= -30 && (latency.p95Pct ?? 0) <= 0
const decision = latencyMeets ? 'latency' : memoryMeets ? 'memory' : 'below-threshold'

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const report = {
  kind: 'windows-helper-comparison',
  version: 1,
  meta: {
    generatedAt: new Date().toISOString(),
    host: { os: `${process.platform} ${process.getSystemVersion?.() ?? ''}`.trim(), cpuModel: process.env.PROCESSOR_IDENTIFIER, cores: (await import('node:os')).cpus().length },
    node: process.version,
    samples: options.samples,
    operation: 'browser-url',
    request: { action: 'browser-url', handleFormat: 'decimal HWND', pid: window.pid, title: window.title },
    fixture: { browser: 'Microsoft Edge', profile: 'isolated --user-data-dir', mode: '--inprivate (an ordinary profile window restores the operator session after ~45s and rewrites its title)', ownership: 'window pid verified against processes launched with our profile', placement: 'off-screen, non-activating', page: 'yu-browser-url.html' },
    measurement: { method: 'job accounting + wall clock', cpuWindow: 'spawn → stdio close', notes: 'Both sides spawn one process per request; PowerShell loads resources/windows-tools.ps1 and resources/current-content.ps1, the native side runs native/bin/yu-windows.exe.' },
  },
  binary: { path: 'native/bin/yu-windows.exe', bytes: statSync(helpers.rust.executable).size, sha256: sha256(helpers.rust.executable) },
  scope: {
    included: ['browser-url address bar and document value', 'original window guard', 'parent death retirement'],
    excluded: ['current-content', 'explorer-folder', 'window enumeration', 'activation', 'search', 'no persistent service'],
  },
  runs,
  aggregate,
  comparison,
  checks,
  passed: checks.every(check => check.pass),
  adoption: { latencyMeets, memoryMeets, decision },
  raw: { first: { powershell: first.powershell.stdout.trim(), rust: first.rust.stdout.trim() }, stale: { powershell: stale.powershell.stderr.trim().split('\n')[0], rust: stale.rust.stderr.trim().split('\n')[0] }, orphan: orphanResult },
}

writeFileSync(join(root, options.output), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ aggregate, comparison, decision, passed: report.passed, output: options.output }, null, 2))
if (window?.pid) spawnSync('taskkill', ['/PID', String(window.pid), '/T', '/F'], { stdio: 'ignore' })
await new Promise(done => setTimeout(done, 500))
try {
  rmSync(directory, { recursive: true, force: true })
} catch (error) {
  console.error(`fixture directory left behind: ${directory} (${error.message})`)
}
if (!report.passed) process.exitCode = 1
