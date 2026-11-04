import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const koffi = require('koffi')

const options = { samples: 10, output: 'tests/yu-v2/evidence/rust-recent-files-20261104.json' }
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

// The Recent folder is read, never written: a created .lnk would leave a trace on
// the operator's machine. Content correctness for real links is covered by the
// helper's unit tests; this benchmark reports the entry count it measured.
const recentDirectory = join(process.env.APPDATA, 'Microsoft', 'Windows', 'Recent')
function snapshot() {
  try {
    const entries = readdirSync(recentDirectory)
      .filter(name => name.toLowerCase().endsWith('.lnk'))
      .map(name => ({ name, mtimeMs: statSync(join(recentDirectory, name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
    return { count: entries.length, head: entries.slice(0, 5).map(entry => entry.name), tail: entries.slice(-3).map(entry => entry.name), key: entries.map(entry => `${entry.name}:${entry.mtimeMs}`).join('|') }
  } catch (error) {
    return { count: 0, error: error.message, key: '' }
  }
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

function openJob(pid) {
  const job = CreateJobObjectW(null, null)
  const process = OpenProcess(0x0100 | 0x0001 | 0x0400 | 0x0200, 0, pid)
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
    peakPrivateKb: Math.round(Number(limits[0].ProcessMemoryUsed ?? limits[0].PeakProcessMemoryUsed) / 1024),
  }
}

const before = snapshot()
const payload = JSON.stringify({ action: 'recent-files' })

function run(side, { timeoutMs = 60000 } = {}) {
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
    child.stdin.end(payload)
  })
}

function parse(result) {
  try {
    return JSON.parse(result.stdout)
  } catch {
    return undefined
  }
}

// Object key order is not part of the wire contract: PowerShell serialises a
// hashtable (source → files, path → source → recordedAt) and serde_json sorts
// keys, so the same document is compared structurally.
function sameBody(left, right) {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || !left || !right) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameBody(left[key], right[key]))
}

const first = { powershell: await run('powershell'), rust: await run('rust') }
const parsed = { powershell: parse(first.powershell), rust: parse(first.rust) }

// Parent death must retire the worker: the helper exits when its parent goes.
const parentFixture = spawn(process.env.ComSpec, ['/c', 'ping -n 6 127.0.0.1 >nul'], { stdio: 'ignore' })
const orphan = spawn(helpers.rust.executable, ['--parent-pid', String(parentFixture.pid)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
const orphanExit = new Promise(done => orphan.on('close', code => done({ code, at: performance.now() })))
orphan.stdin.write(payload)
await new Promise(done => setTimeout(done, 300))
const killedAt = performance.now()
parentFixture.kill()
const orphanResult = await Promise.race([orphanExit, new Promise(done => setTimeout(done, 5000))])

async function timed(side) {
  const result = await run(side)
  const body = parse(result)
  return {
    side,
    ok: result.code === 0 && sameBody(body, parsed.powershell),
    code: result.code,
    files: body?.files?.length,
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

const after = snapshot()

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
const recordedAt = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/
const filesOf = report => (Array.isArray(report?.files) ? report.files : [])
const shapeOk = report => filesOf(report).every(file =>
  typeof file?.path === 'string' && file.path.length > 0
  && recordedAt.test(file?.recordedAt ?? '')
  && file?.source === 'Windows Recent'
  && typeof report.source === 'string')

const latency = comparison.totalMs
const memory = comparison.peakPrivateKb
const checks = [
  { name: 'result-identical', pass: sameBody(parsed.powershell, parsed.rust), detail: `powershell=${first.powershell.stdout.trim().slice(0, 200)} rust=${first.rust.stdout.trim().slice(0, 200)}` },
  { name: 'corpus-shape', pass: shapeOk(parsed.powershell) && shapeOk(parsed.rust) && parsed.powershell?.source === 'Windows Recent', detail: `powershell=${filesOf(parsed.powershell).length} rust=${filesOf(parsed.rust).length}` },
  { name: 'recorded-at-format', pass: filesOf(parsed.powershell).every(file => recordedAt.test(file.recordedAt)) && filesOf(parsed.rust).every(file => recordedAt.test(file.recordedAt)), detail: 'seven fractional digits with a trailing Z' },
  { name: 'recent-stable-during-run', pass: before.key === after.key, detail: `before=${before.count} after=${after.count}` },
  { name: 'parent-death-retires-worker', pass: orphanResult.code === 0, detail: `code=${orphanResult.code} after ${orphanResult.at ? Math.round(orphanResult.at - killedAt) : '?'}ms` },
  { name: 'samples-per-side', pass: aggregate.powershell.n >= options.samples * 2 && aggregate.rust.n >= options.samples * 2, detail: `powershell=${aggregate.powershell.n} rust=${aggregate.rust.n}` },
  { name: 'measurement-comparable', pass: latency.comparable === true && memory.comparable === true, detail: 'both sides measured by wall clock and job accounting' },
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
    host: { os: `${process.platform} ${process.getSystemVersion?.() ?? ''}`.trim(), cpuModel: process.env.PROCESSOR_IDENTIFIER, cores: cpus().length },
    node: process.version,
    samples: options.samples,
    operation: 'recent-files',
    request: { action: 'recent-files' },
    fixture: { source: 'read-only operator Recent folder', directory: recentDirectory, entriesAtStart: before.count, entriesAtEnd: after.count, head: before.head, tail: before.tail },
    measurement: { method: 'job accounting + wall clock', cpuWindow: 'spawn → stdio close', notes: 'Both sides spawn one process per request; PowerShell loads resources/windows-tools.ps1, the native side runs native/bin/yu-windows.exe. The Recent folder is never written; link parsing cost is covered by the helper unit tests when the folder is empty.' },
  },
  binary: { path: 'native/bin/yu-windows.exe', bytes: statSync(helpers.rust.executable).size, sha256: sha256(helpers.rust.executable) },
  scope: {
    included: ['recent-files shortcut enumeration', 'LastWriteTimeUtc sort and 300 entry cap', 'recordedAt formatting', 'parent death retirement'],
    excluded: ['current-content', 'browser-url', 'explorer-folder', 'window enumeration', 'activation', 'search', 'no persistent service', 'writing to the Recent folder'],
  },
  runs,
  aggregate,
  comparison,
  checks,
  passed: checks.every(check => check.pass),
  adoption: { latencyMeets, memoryMeets, decision },
  raw: { first: { powershell: first.powershell.stdout.trim(), rust: first.rust.stdout.trim() }, snapshot: { before, after }, orphan: orphanResult },
}

writeFileSync(join(root, options.output), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ aggregate, comparison, decision, passed: report.passed, entries: before.count, output: options.output }, null, 2))
if (!report.passed) process.exitCode = 1
