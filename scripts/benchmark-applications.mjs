import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const koffi = require('koffi')

const options = { samples: 10, output: 'tests/yu-v2/evidence/rust-applications-20261104.json' }
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

// --- job accounting (same technique as scripts/benchmark-speech.mjs) -------
const koffiKernel32 = koffi.load('kernel32.dll')
const JobAccounting = koffi.struct('JobAccounting', {
  TotalUserTime: 'int64',
  TotalKernelTime: 'int64',
  ThisPeriodTotalUserTime: 'int64',
  ThisPeriodTotalKernelTime: 'int64',
  TotalPageFaultCount: 'uint32',
  TotalProcesses: 'uint32',
  TotalTerminatedProcesses: 'uint32',
})
const JobBasicLimit = koffi.struct('JobBasicLimit', {
  PerProcessUserTimeLimit: 'int64',
  PerJobUserTimeLimit: 'int64',
  LimitFlags: 'uint32',
  MinimumWorkingSetSize: 'uint64',
  MaximumWorkingSetSize: 'uint64',
  ActiveProcessLimit: 'uint32',
  Affinity: 'uint64',
  PriorityClass: 'uint32',
  SchedulingClass: 'uint32',
})
const JobExtendedLimit = koffi.struct('JobExtendedLimit', {
  BasicLimitInformation: JobBasicLimit,
  IoInfo: 'uint8[48]',
  ProcessMemoryLimit: 'uint64',
  JobMemoryLimit: 'uint64',
  PeakProcessMemoryUsed: 'uint64',
  PeakJobMemoryUsed: 'uint64',
})
const CreateJobObjectW = koffiKernel32.func('void *CreateJobObjectW(void *attributes, void *name)')
const AssignProcessToJobObject = koffiKernel32.func('int AssignProcessToJobObject(void *job, void *process)')
const OpenProcess = koffiKernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)')
const CloseHandle = koffiKernel32.func('int CloseHandle(void *handle)')
const QueryAccounting = koffiKernel32.func(
  'int QueryInformationJobObject(void *job, int class, _Out_ JobAccounting *info, uint32 length, void *returned)',
)
const QueryExtendedLimit = koffiKernel32.func(
  'int QueryInformationJobObject(void *job, int class, _Out_ JobExtendedLimit *info, uint32 length, void *returned)',
)

function openJob(pid) {
  const job = CreateJobObjectW(null, null)
  if (!job) return { error: 'CreateJobObjectW failed' }
  const process = OpenProcess(0x0100 | 0x0001 | 0x0400 | 0x0200, 0, pid)
  if (!process) {
    CloseHandle(job)
    return { error: 'OpenProcess failed' }
  }
  const assigned = AssignProcessToJobObject(job, process)
  CloseHandle(process)
  if (!assigned) {
    CloseHandle(job)
    return { error: 'AssignProcessToJobObject failed' }
  }
  return { job }
}

function accounting(job) {
  const totals = [{}]
  if (!QueryAccounting(job, 1, totals, koffi.sizeof(JobAccounting), null)) return undefined
  const limits = [{}]
  if (!QueryExtendedLimit(job, 9, limits, koffi.sizeof(JobExtendedLimit), null)) return undefined
  return {
    cpuUserMs: Number(totals[0].TotalUserTime) / 10000,
    cpuKernelMs: Number(totals[0].TotalKernelTime) / 10000,
    peakPrivateKb: Math.round(Number(limits[0].PeakProcessMemoryUsed) / 1024),
  }
}

const payload = JSON.stringify({ action: 'applications' })

function run(side, { timeoutMs = 60000 } = {}) {
  const { executable, args } = helpers[side]
  return new Promise(resolveRun => {
    const started = performance.now()
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const opened = openJob(child.pid)
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code, extra = {}) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(watchdog)
      const totalMs = performance.now() - started
      const usage = opened.job && !extra.timedOut ? accounting(opened.job) : undefined
      if (opened.job) CloseHandle(opened.job)
      resolveRun({ side, code, totalMs, stdout, stderr, jobError: opened.error, ...usage, ...extra })
    }
    const timer = setTimeout(() => child.kill(), timeoutMs)
    // A helper that exits without closing both pipes would otherwise hang the
    // whole round: settle anyway and record it as a timeout.
    const watchdog = setTimeout(() => finish(undefined, { timedOut: true }), timeoutMs + 5000)
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk.slice(0, 2000)))
    child.on('error', error => finish(undefined, { spawnError: error.message }))
    child.on('close', code => finish(code))
    child.stdin.end(payload)
  })
}

function parse(result) {
  try {
    const body = JSON.parse(result.stdout)
    return Array.isArray(body?.applications) ? body.applications : undefined
  } catch {
    return undefined
  }
}

// Evidence must not carry real application names or paths: only counts, a
// digest over the canonical document, and the diff *kinds* that were seen.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
const digest = entries => createHash('sha256').update(canonical(entries)).digest('hex')
const shape = entries =>
  entries.reduce(
    (counts, entry) => {
      counts.total += 1
      if (entry?.path) counts.withPath += 1
      if (entry?.appId) counts.withAppId += 1
      if (!entry?.path && !entry?.appId) counts.withoutLocation += 1
      return counts
    },
    { total: 0, withPath: 0, withAppId: 0, withoutLocation: 0 },
  )
const diffKinds = (left, right) => {
  const key = entry => `${entry.name}\u0000${entry.path ?? ''}\u0000${entry.appId ?? ''}`
  const leftKeys = left.map(key)
  const rightKeys = right.map(key)
  const onlyLeft = leftKeys.filter(entry => !rightKeys.includes(entry)).length
  const onlyRight = rightKeys.filter(entry => !leftKeys.includes(entry)).length
  const order = leftKeys.length === rightKeys.length && leftKeys.every((entry, index) => entry === rightKeys[index])
  return { onlyBaseline: onlyLeft, onlyNative: onlyRight, sameOrder: order }
}

const first = { powershell: await run('powershell'), rust: await run('rust') }
const parsed = { powershell: parse(first.powershell), rust: parse(first.rust) }
const reference = {
  powershell: parsed.powershell && digest(parsed.powershell),
  rust: parsed.rust && digest(parsed.rust),
}

// Parent death must retire the worker: the helper exits when its parent goes.
const parentFixture = spawn(process.env.ComSpec, ['/c', 'ping -n 6 127.0.0.1 >nul'], { stdio: 'ignore' })
const orphan = spawn(helpers.rust.executable, ['--parent-pid', String(parentFixture.pid)], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
const orphanExit = new Promise(done => orphan.on('close', code => done({ code, at: performance.now() })))
orphan.stdin.write(payload)
await new Promise(done => setTimeout(done, 300))
const killedAt = performance.now()
parentFixture.kill()
const orphanResult = await Promise.race([
  orphanExit,
  new Promise(done => setTimeout(done, 5000)),
])

async function timed(side) {
  const result = await run(side)
  const entries = parse(result)
  return {
    side,
    ok: result.code === 0 && entries !== undefined && reference[side] !== undefined && digest(entries) === reference[side],
    code: result.code,
    entries: entries?.length,
    digest: entries ? digest(entries) : undefined,
    totalMs: result.totalMs,
    cpuMs: result.cpuUserMs === undefined ? undefined : result.cpuUserMs + result.cpuKernelMs,
    peakPrivateKb: result.peakPrivateKb,
    timedOut: result.timedOut,
    jobError: result.jobError,
    error: result.code === 0 ? undefined : result.stderr.trim().split('\n')[0],
  }
}

const runs = []
for (let round = 0; round < options.samples; round++) {
  for (const side of ['powershell', 'rust', 'rust', 'powershell']) runs.push(await timed(side))
}

function percentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]
}
function summary(side) {
  const own = runs.filter(entry => entry.side === side)
  const valid = own.filter(entry => entry.ok)
  const stats = key => {
    const values = valid.map(entry => entry[key]).filter(value => typeof value === 'number')
    if (!values.length) return undefined
    return { p50: Number(percentile(values, 0.5).toFixed(2)), p95: Number(percentile(values, 0.95).toFixed(2)) }
  }
  return {
    side,
    n: valid.length,
    invalid: own.filter(entry => !entry.ok).map(entry => ({ round: runs.indexOf(entry), code: entry.code, entries: entry.entries, timedOut: entry.timedOut, jobError: entry.jobError, error: entry.error })),
    entries: valid.length ? valid[valid.length - 1].entries : undefined,
    totalMs: stats('totalMs'),
    cpuMs: stats('cpuMs'),
    peakPrivateKb: stats('peakPrivateKb'),
  }
}
const aggregate = { powershell: summary('powershell'), rust: summary('rust') }

function compare(key) {
  const baseline = aggregate.powershell[key]
  const next = aggregate.rust[key]
  if (!baseline || !next) return { p50: baseline?.p50, p95: baseline?.p95, comparable: false, reason: 'one side has no valid sample' }
  const change = (from, to) => (from ? Number((((to - from) / from) * 100).toFixed(2)) : null)
  return {
    p50: next.p50,
    p95: next.p95,
    baselineP50: baseline.p50,
    baselineP95: baseline.p95,
    p50Pct: change(baseline.p50, next.p50),
    p95Pct: change(baseline.p95, next.p95),
    p95DeltaMs: Number((next.p95 - baseline.p95).toFixed(2)),
    comparable: true,
  }
}
const comparison = { totalMs: compare('totalMs'), cpuMs: compare('cpuMs'), peakPrivateKb: compare('peakPrivateKb') }

const baselineShape = parsed.powershell ? shape(parsed.powershell) : undefined
const nativeShape = parsed.rust ? shape(parsed.rust) : undefined
const diff = parsed.powershell && parsed.rust ? diffKinds(parsed.powershell, parsed.rust) : undefined
const latency = comparison.totalMs
const memory = comparison.peakPrivateKb
const checks = [
  {
    name: 'result-identical',
    pass: Boolean(parsed.powershell && parsed.rust && digest(parsed.powershell) === digest(parsed.rust)),
    detail: `baseline=${baselineShape?.total} native=${nativeShape?.total} digest=${digest(parsed.rust ?? [])}`,
  },
  {
    name: 'same-order-and-membership',
    pass: diff?.sameOrder === true && diff.onlyBaseline === 0 && diff.onlyNative === 0,
    detail: `onlyBaseline=${diff?.onlyBaseline} onlyNative=${diff?.onlyNative} sameOrder=${diff?.sameOrder}`,
  },
  {
    name: 'entry-shape',
    pass: [baselineShape, nativeShape].every(value => value && value.withoutLocation === 0 && value.total > 0),
    detail: `baseline=${JSON.stringify(baselineShape)} native=${JSON.stringify(nativeShape)}`,
  },
  {
    name: 'every-sample-valid',
    pass: aggregate.powershell.invalid.length === 0 && aggregate.rust.invalid.length === 0,
    detail: `powershell=${aggregate.powershell.invalid.length} rust=${aggregate.rust.invalid.length} invalid of ${runs.length}`,
  },
  {
    name: 'samples-per-side',
    pass: aggregate.powershell.n >= options.samples * 2 && aggregate.rust.n >= options.samples * 2,
    detail: `powershell=${aggregate.powershell.n} rust=${aggregate.rust.n}`,
  },
  {
    name: 'measurement-comparable',
    pass: latency.comparable === true && memory.comparable === true,
    detail: 'both sides measured by wall clock and job accounting',
  },
  {
    name: 'job-accounting',
    pass: runs.every(entry => !entry.jobError),
    detail: runs.filter(entry => entry.jobError).map(entry => entry.jobError).join(', ') || 'every run had a job',
  },
  {
    name: 'parent-death-retires-worker',
    pass: orphanResult.code === 0,
    detail: `code=${orphanResult.code} after ${orphanResult.at ? Math.round(orphanResult.at - killedAt) : '?'}ms`,
  },
  {
    name: 'performance-threshold',
    pass: latency.p95Pct !== null && latency.p95Pct !== undefined && latency.p95Pct <= -25 && latency.p95DeltaMs <= -100,
    detail: `p95 ${latency.baselineP95} → ${latency.p95}ms (${latency.p95Pct}%, ${latency.p95DeltaMs}ms)`,
  },
]

const latencyMeets = latency.p95Pct !== null && latency.p95Pct !== undefined && latency.p95Pct <= -25 && latency.p95DeltaMs <= -100
const memoryMeets = memory.p50Pct !== null && memory.p50Pct !== undefined && memory.p50Pct <= -30 && (latency.p95Pct ?? 0) <= 0
const correctness = checks.filter(check => check.name !== 'performance-threshold')
const decision = !correctness.every(check => check.pass) ? 'not-adopted' : latencyMeets ? 'latency' : memoryMeets ? 'memory' : 'below-threshold'

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const report = {
  kind: 'windows-helper-comparison',
  version: 1,
  meta: {
    generatedAt: new Date().toISOString(),
    host: {
      os: `${process.platform} ${process.getSystemVersion?.() ?? ''}`.trim(),
      cpuModel: process.env.PROCESSOR_IDENTIFIER,
      cores: cpus().length,
    },
    node: process.version,
    samples: options.samples,
    operation: 'applications',
    request: { action: 'applications' },
    fixture: {
      source: 'operator registry and Start menu, read only',
      baseline: baselineShape,
      native: nativeShape,
      digest: { baseline: parsed.powershell ? digest(parsed.powershell) : undefined, native: parsed.rust ? digest(parsed.rust) : undefined },
      diff,
      privacy: 'counts, a digest and diff kinds only; no application names or paths are stored',
    },
    measurement: {
      method: 'job accounting + wall clock',
      cpuWindow: 'spawn → stdio close',
      notes:
        'Both sides spawn one process per request; PowerShell loads resources/windows-tools.ps1, the native side runs native/bin/yu-windows.exe. Enumeration never launches an application.',
    },
  },
  binary: {
    path: 'native/bin/yu-windows.exe',
    bytes: statSync(helpers.rust.executable).size,
    sha256: sha256(helpers.rust.executable),
  },
  scope: {
    included: ['App Paths enumeration', 'Start menu shortcut scan', 'packaged AppsFolder enumeration', 'fixed PATH commands', 'sort, dedupe and 1500 cap'],
    excluded: ['activate', 'search', 'current-content', 'browser-url', 'explorer-folder', 'recent-files', 'any application launch', 'no persistent service'],
  },
  runs,
  aggregate,
  comparison,
  checks,
  passed: checks.every(check => check.pass),
  adoption: { latencyMeets, memoryMeets, decision },
  raw: { first: { powershell: { code: first.powershell.code, entries: parsed.powershell?.length }, rust: { code: first.rust.code, entries: parsed.rust?.length } }, orphan: orphanResult },
}

writeFileSync(resolve(root, options.output), `${JSON.stringify(report, null, 2)}\n`)
console.log(
  JSON.stringify({ aggregate, comparison, decision, passed: report.passed, entries: baselineShape?.total, output: options.output }, null, 2),
)
if (!report.passed) process.exitCode = 1
