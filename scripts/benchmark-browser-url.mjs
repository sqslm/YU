// Compares the shipped PowerShell baseline with the Rust helper for the
// browser-url action, measured on an owned, non-activating UIA provider.
//
// No user browser, profile, window or session is touched: the fixture creates
// its own window, and every sample is checked against the fixture's expected
// body before it is allowed into the timing aggregate.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { cpus, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const koffi = require('koffi')

const options = { samples: 10, output: 'tests/yu-v2/evidence/rust-browser-url-correctness-20261104.json', timeoutMs: 15000 }
for (const [index, value] of process.argv.slice(2).entries()) {
  if (!value.startsWith('--')) continue
  const [name, inline] = value.slice(2).split('=')
  const next = inline ?? process.argv[index + 3]
  if (!(name in options)) throw new Error(`Unknown option --${name}`)
  options[name] = name === 'samples' || name === 'timeoutMs' ? Number(next) : next
}
if (!Number.isInteger(options.samples) || options.samples < 1) throw new Error('--samples must be a positive integer')

const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
const helpers = {
  powershell: { executable: powershell, args: ['-NoProfile', '-NonInteractive', '-File', join(root, 'resources/windows-tools.ps1')] },
  rust: { executable: join(root, 'native/bin/yu-windows.exe'), args: [] },
}
const fixtureScript = join(root, 'tests/yu-v2/fixtures/uia-provider.ps1')

// --- job accounting (same technique as scripts/benchmark-speech.mjs) --------
const kernel32 = koffi.load('kernel32.dll')
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
const CreateJobObjectW = kernel32.func('void *CreateJobObjectW(void *attributes, void *name)')
const AssignProcessToJobObject = kernel32.func('int AssignProcessToJobObject(void *job, void *process)')
const OpenProcess = kernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)')
const CloseHandle = kernel32.func('int CloseHandle(void *handle)')
const QueryAccounting = kernel32.func('int QueryInformationJobObject(void *job, int class, _Out_ JobAccounting *info, uint32 length, void *returned)')
const QueryExtendedLimit = kernel32.func('int QueryInformationJobObject(void *job, int class, _Out_ JobExtendedLimit *info, uint32 length, void *returned)')

const PROCESS_ACCESS = 0x0100 | 0x0001 | 0x0400 | 0x0200

/** Opens a job, assigns the helper to it and reports every step honestly. */
function openJob(pid) {
  const job = CreateJobObjectW(null, null)
  if (!job) return { error: 'CreateJobObjectW returned null' }
  const process = OpenProcess(PROCESS_ACCESS, 0, pid)
  if (!process) return { job, error: `OpenProcess(${pid}) returned null` }
  const assigned = AssignProcessToJobObject(job, process)
  CloseHandle(process)
  return assigned ? { job } : { job, error: 'AssignProcessToJobObject failed' }
}

/** Reads the job's cumulative CPU and peak commit; undefined on query failure. */
function accounting(job) {
  const totals = [{}]
  if (!QueryAccounting(job, 1, totals, koffi.sizeof(JobAccounting), null)) return undefined
  const limits = [{}]
  if (!QueryExtendedLimit(job, 9, limits, koffi.sizeof(JobExtendedLimit), null)) return undefined
  return {
    cpuUserMs: Number(totals[0].TotalUserTime) / 10000,
    cpuKernelMs: Number(totals[0].TotalKernelTime) / 10000,
    cpuMs: (Number(totals[0].TotalUserTime) + Number(totals[0].TotalKernelTime)) / 10000,
    peakPrivateKb: Math.round(Number(limits[0].PeakProcessMemoryUsed) / 1024),
  }
}

// --- fixture ---------------------------------------------------------------
const fixtures = new Set()

/** Starts one fixture window and resolves its ready event. */
function startFixture(mode, args = []) {
  const child = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixtureScript, '-Mode', mode, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  fixtures.add(child)
  let buffered = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  return new Promise((ready, fail) => {
    const timer = setTimeout(() => fail(new Error(`fixture ${mode} did not become ready: ${stderr.trim()}`)), 30_000)
    const events = []
    let settled = false
    child.stdout.on('data', chunk => {
      buffered += chunk
      const lines = buffered.split(/\r?\n/)
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let event
        try { event = JSON.parse(line) } catch { continue }
        events.push(event)
        if (event.type !== 'ready' || settled) continue
        settled = true
        clearTimeout(timer)
        ready({ mode, child, events, send: command => child.stdin.write(`${JSON.stringify(command)}\n`), ready: event })
      }
    })
    child.once('exit', code => { clearTimeout(timer); if (!settled) fail(new Error(`fixture ${mode} exited early (${code}): ${stderr.trim()}`)) })
  })
}

/** Runs one helper to completion, timing from spawn to stdio close. */
function run(side, body) {
  const { executable, args } = helpers[side]
  const started = performance.now()
  const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const jobState = openJob(child.pid)
  return new Promise(resolveRun => {
    let stdout = '', stderr = '', spawnError, writeError, timedOut = false
    const finish = () => {
      const totalMs = performance.now() - started
      const usage = jobState.job ? accounting(jobState.job) : undefined
      if (jobState.job) CloseHandle(jobState.job)
      resolveRun({ side, code: child.exitCode, totalMs, stdout: stdout.trim(), stderr: stderr.trim(), spawnError, writeError, timedOut, ...usage, jobError: jobState.error })
    }
    child.on('error', error => { spawnError = String(error); finish() })
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk.slice(0, 2000) })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, options.timeoutMs)
    child.once('close', code => { clearTimeout(timer); child.exitCode = code; finish() })
    child.stdin.on('error', error => { writeError = String(error) })
    child.stdin.end(Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'))
  })
}

const parse = text => { try { return JSON.parse(text) } catch { return undefined } }

// The consumer's own filter: resources/windows-tools.ps1 hands the url to
// src/main/tools/windows.ts, which only accepts plain http(s) addresses.
function accepted(address) {
  if (typeof address !== 'string' || !/^https?:\/\//i.test(address)) return false
  try {
    const url = new URL(address)
    return /^https?:$/.test(url.protocol) && !url.username && !url.password && url.href.length <= 2000
  } catch { return false }
}

// The two helpers emit the same fields in a different order (a PowerShell
// hashtable sorts by name, serde_json keeps its own order), so bodies are
// compared after canonicalising keys. Downstream parses JSON, not text.
const canonical = value => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value
const compare = (left, right) => left !== undefined && right !== undefined && JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))

// --- correctness pass: every field, both sides, no timing -------------------
// UIA core swallows exceptions raised inside an in-process provider, so a
// provider that "fails" is indistinguishable from a provider with no
// candidates: the client-visible failures are a destroyed window and a read
// that never returns. Both are covered below, next to the equal-body cases.
const specs = [
  { mode: 'address-edit', kind: 'body', expected: ready => ({ title: ready.title, url: 'https://example.com/a', truncated: false }) },
  { mode: 'file-url', kind: 'body', expected: ready => ({ title: ready.title, path: ready.file, truncated: false }) },
  { mode: 'no-candidate', kind: 'body', expected: ready => ({ title: ready.title, truncated: false }) },
  { mode: 'provider-error', kind: 'body', args: ['-FailStage', 'get-property'], expected: ready => ({ title: ready.title, truncated: false }) },
  { mode: 'provider-error', kind: 'body', args: ['-FailStage', 'find-children'], expected: ready => ({ title: ready.title, truncated: false }) },
  { mode: 'address-edit', kind: 'destroyed' },
  { mode: 'address-edit', kind: 'unresponsive', args: ['-FailStage', 'unresponsive'] },
]

async function correctness(spec) {
  const fixture = await startFixture(spec.mode, spec.args ?? [])
  const request = { action: 'browser-url', handle: String(Number(BigInt(fixture.ready.handle))), pid: fixture.ready.pid, title: fixture.ready.title }
  const result = { mode: spec.mode, kind: spec.kind, failStage: spec.args?.[1], request }
  if (spec.kind === 'destroyed') fixture.send({ command: 'destroy' })
  if (spec.kind === 'unresponsive') await new Promise(done => setTimeout(done, 500))
  const [left, right] = [await run('powershell', request), await run('rust', request)]
  const [a, b] = [parse(left.stdout), parse(right.stdout)]
  result.powershell = { code: left.code, stderr: left.stderr, json: a, timedOut: left.timedOut, totalMs: left.totalMs }
  result.rust = { code: right.code, stderr: right.stderr, json: b, timedOut: right.timedOut, totalMs: right.totalMs }
  if (spec.kind === 'body') {
    // `injected` proves the fixture really raised inside the provider.
    result.injected = fixture.events.filter(event => event.type === 'injected').map(event => ({ stage: event.stage, call: event.call }))
    result.expected = spec.expected(fixture.ready)
    result.identical = compare(a, b)
    result.matchesExpected = compare(a, result.expected) && compare(b, result.expected)
  }
  if (spec.kind === 'destroyed') {
    const rejected = side => side.code !== 0 && /Original window has changed or closed/.test(side.stderr)
    result.rejected = rejected(result.powershell) && rejected(result.rust)
    result.identical = rejected(result.powershell) === rejected(result.rust)
    result.matchesExpected = result.rejected
  }
  if (spec.kind === 'unresponsive') {
    // Both helpers hang against a provider that never answers; only the client
    // budget stops them, which is why production runs with a 15s timeout.
    result.timedOut = result.powershell.timedOut === true && result.rust.timedOut === true
    result.identical = result.powershell.timedOut === result.rust.timedOut
    result.matchesExpected = result.timedOut
  }
  if (a?.url || b?.url) result.accepted = accepted(b?.url ?? '')
  fixture.send({ command: 'quit' })
  await new Promise(done => setTimeout(done, 200))
  return result
}

const correctnessReports = []
for (const spec of specs) {
  const name = spec.args?.length ? `${spec.mode} ${spec.args.join(' ')}` : spec.mode
  try { correctnessReports.push(await correctness(spec)) } catch (error) {
    correctnessReports.push({ mode: spec.mode, kind: spec.kind, failStage: spec.args?.[1], label: name, error: String(error), identical: false, matchesExpected: false })
  }
}

const https = correctnessReports.find(entry => entry.mode === 'address-edit' && entry.kind === 'body')
const files = correctnessReports.find(entry => entry.mode === 'file-url')
const empty = correctnessReports.find(entry => entry.mode === 'no-candidate')
const providerErrors = correctnessReports.filter(entry => entry.mode === 'provider-error')
const destroyed = correctnessReports.find(entry => entry.kind === 'destroyed')
const unresponsive = correctnessReports.find(entry => entry.kind === 'unresponsive')

// --- timed pass ------------------------------------------------------------
const fixture = await startFixture('address-edit')
const request = { action: 'browser-url', handle: String(Number(BigInt(fixture.ready.handle))), pid: fixture.ready.pid, title: fixture.ready.title }
const expectedBody = { title: fixture.ready.title, url: 'https://example.com/a', truncated: false }
const order = ['powershell', 'rust', 'rust', 'powershell']
const runs = []
let round = 0
for (let sample = 0; sample < options.samples; sample++) {
  for (const side of order) {
    round++
    const result = await run(side, request)
    const json = parse(result.stdout)
    const ok = result.code === 0 && compare(json, expectedBody)
    const reason = ok ? undefined
      : result.spawnError ? `spawn failed: ${result.spawnError}`
      : result.writeError ? `stdin failed: ${result.writeError}`
      : result.timedOut ? `exceeded ${options.timeoutMs}ms`
      : result.code !== 0 ? `exit ${result.code}: ${result.stderr}`
      : `unexpected body: ${result.stdout}`
    runs.push({ side, round, ok, reason, code: result.code, totalMs: result.totalMs, cpuUserMs: result.cpuUserMs, cpuKernelMs: result.cpuKernelMs, cpuMs: result.cpuMs, peakPrivateKb: result.peakPrivateKb, jobError: result.jobError, body: json })
    process.stdout.write(ok ? '.' : 'X')
  }
}
process.stdout.write('\n')
const timedFixtureQuit = fixture.send({ command: 'quit' })
await new Promise(done => setTimeout(done, 200))
void timedFixtureQuit

// --- aggregation -----------------------------------------------------------
const percentile = (values, q) => {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]
}
const METRICS = ['totalMs', 'cpuMs', 'peakPrivateKb']
function summarise(runs_) {
  const valid = runs_.filter(entry => entry.ok)
  const invalid = runs_.filter(entry => !entry.ok).map(entry => ({ round: entry.round, reason: entry.reason }))
  const metrics = {}
  for (const metric of METRICS) {
    const values = valid.map(entry => entry[metric]).filter(value => typeof value === 'number')
    metrics[metric] = values.length === valid.length && valid.length
      ? { n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) }
      : null
  }
  return { n: valid.length, invalid, metrics }
}
const bySide = { powershell: runs.filter(entry => entry.side === 'powershell'), rust: runs.filter(entry => entry.side === 'rust') }
const aggregate = { powershell: summarise(bySide.powershell), rust: summarise(bySide.rust) }

const comparable = METRICS.every(metric => aggregate.powershell.metrics[metric] && aggregate.rust.metrics[metric])
const comparison = {}
for (const metric of METRICS) {
  const left = aggregate.powershell.metrics[metric], right = aggregate.rust.metrics[metric]
  comparison[metric] = left && right
    ? {
        p50Pct: left.p50 ? Math.round(((right.p50 - left.p50) / left.p50) * 10000) / 100 : null,
        p95Pct: left.p95 ? Math.round(((right.p95 - left.p95) / left.p95) * 10000) / 100 : null,
        p95DeltaMs: metric === 'peakPrivateKb' ? null : Math.round((right.p95 - left.p95) * 100) / 100,
      }
    : { p50Pct: null, p95Pct: null, p95DeltaMs: null }
}

const latencyMeets = comparable && comparison.totalMs.p95Pct !== null && comparison.totalMs.p95Pct <= -25 && comparison.totalMs.p95DeltaMs <= -100
const memoryMeets = comparable && comparison.peakPrivateKb.p50Pct !== null && comparison.peakPrivateKb.p50Pct <= -30 && (comparison.totalMs.p95Pct ?? 1) <= 0
const performanceMeets = latencyMeets || memoryMeets

// --- cleanup ---------------------------------------------------------------
// Every fixture is ours: ask it to quit, then reap only those children.
const cleanupFailures = []
for (const child of fixtures) {
  try { child.stdin.write('{"command":"quit"}\n'); child.stdin.end() } catch (error) { cleanupFailures.push(`quit ${child.pid}: ${error}`) }
}
await new Promise(done => setTimeout(done, 750))
for (const child of fixtures) {
  if (child.exitCode !== null) continue
  try { child.kill() } catch (error) { cleanupFailures.push(`kill ${child.pid}: ${error}`) }
}

// --- checks ----------------------------------------------------------------
const survivors = runs.filter(entry => entry.jobError)
const checks = [
  { name: 'https-address-identical', pass: https?.identical === true, detail: https?.identical ? 'both helpers returned the same body' : JSON.stringify(https) },
  { name: 'https-address-expected', pass: https?.matchesExpected === true, detail: JSON.stringify({ expected: https?.expected, powershell: https?.powershell?.json, rust: https?.rust?.json }) },
  { name: 'https-address-accepted-by-consumer', pass: https?.accepted === true, detail: 'browserAddress accepts the fixed https address within 2000 characters' },
  { name: 'file-address-yields-path', pass: files?.identical === true && files?.matchesExpected === true, detail: JSON.stringify({ expected: files?.expected, powershell: files?.powershell?.json, rust: files?.rust?.json }) },
  { name: 'no-candidate-returns-no-address', pass: empty?.matchesExpected === true, detail: JSON.stringify({ expected: empty?.expected, powershell: empty?.powershell?.json, rust: empty?.rust?.json }) },
  { name: 'provider-errors-equal-and-invisible', pass: providerErrors.length === 2 && providerErrors.every(entry => entry.identical === true && entry.matchesExpected === true && (entry.injected?.length ?? 0) > 0), detail: JSON.stringify(providerErrors.map(entry => ({ failStage: entry.failStage, injected: entry.injected, powershell: entry.powershell?.json, rust: entry.rust?.json }))) },
  { name: 'destroyed-window-rejected', pass: destroyed?.rejected === true, detail: JSON.stringify({ powershell: destroyed?.powershell, rust: destroyed?.rust }) },
  { name: 'unresponsive-read-hits-budget', pass: unresponsive?.timedOut === true, detail: JSON.stringify({ powershell: unresponsive?.powershell, rust: unresponsive?.rust }) },
  { name: 'every-sample-valid', pass: runs.every(entry => entry.ok), detail: `${runs.filter(entry => entry.ok).length}/${runs.length} samples matched the fixture body` },
  { name: 'samples-per-side', pass: aggregate.powershell.n >= 40 && aggregate.rust.n >= 40, detail: `powershell ${aggregate.powershell.n}, rust ${aggregate.rust.n}` },
  { name: 'measurement-comparable', pass: comparable, detail: comparable ? 'every metric has both sides' : 'a metric is missing on one side' },
  { name: 'job-accounting', pass: survivors.length === 0, detail: survivors.length ? `${survivors.length} job assignment/queries failed: ${survivors[0].jobError}` : 'every helper was assigned to its own job and queried' },
  { name: 'cleanup-complete', pass: cleanupFailures.length === 0, detail: cleanupFailures.length ? cleanupFailures.join('; ') : `every fixture process exited; ${fixtures.size} fixtures tracked` },
  { name: 'performance-threshold', pass: performanceMeets, detail: `latency ${latencyMeets ? 'met' : 'not met'}, memory ${memoryMeets ? 'met' : 'not met'}` },
]

const correctnessPassed = checks.filter(check => !['performance-threshold'].includes(check.name)).every(check => check.pass)
const decision = !correctnessPassed ? 'not-adopted' : latencyMeets ? 'latency' : memoryMeets ? 'memory' : 'below-threshold'
const passed = correctnessPassed && performanceMeets

const binary = join(root, 'native/bin/yu-windows.exe')
const report = {
  kind: 'windows-helper-comparison',
  version: 2,
  meta: {
    generatedAt: new Date().toISOString(),
    host: { os: process.platform, arch: process.arch, cpuModel: cpus()[0]?.model, cores: cpus().length, totalMemMb: Math.round(totalmem() / 1048576) },
    node: process.version,
    samples: options.samples,
    operation: 'browser-url',
    timeoutMs: options.timeoutMs,
    note: 'bodies are compared after canonicalising key order',
    fixture: { script: 'tests/yu-v2/fixtures/uia-provider.ps1', modes: correctnessReports.map(entry => entry.mode), timingMode: 'address-edit', expected: expectedBody, ownership: 'fixture-owned window; no user browser or profile is used' },
    measurement: { method: 'job accounting + wall clock', cpuWindow: 'spawn → stdio close', memory: 'PeakProcessMemoryUsed of the job', notes: 'Both helpers are timed over the same production request budget.' },
  },
  binary: { path: 'native/bin/yu-windows.exe', bytes: statSync(binary).size, sha256: createHash('sha256').update(readFileSync(binary)).digest('hex') },
  scope: {
    included: ['browser-url over an owned UIA provider', 'https address', 'file address with an existing file', 'no candidate', 'process lifetime and job accounting'],
    excluded: ['real Edge/Chrome/Firefox trees', 'password managers', 'Document-level forms in real pages', 'UNC shares', 'UIA provider failures', 'locked or remote sessions'],
  },
  correctness: correctnessReports,
  runs,
  aggregate,
  comparison,
  checks,
  passed,
  adoption: { latencyMeets, memoryMeets, performanceMeets, decision },
  cleanup: { fixturePids: [...fixtures].map(child => child.pid), failures: cleanupFailures },
}

const target = resolve(root, options.output)
writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`)
for (const check of checks) console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`)
console.log(`decision=${decision} passed=${passed} samples: powershell ${aggregate.powershell.n} / rust ${aggregate.rust.n}`)
console.log(`totalMs p50/p95: ${aggregate.powershell.metrics.totalMs?.p50}/${aggregate.powershell.metrics.totalMs?.p95} → ${aggregate.rust.metrics.totalMs?.p50}/${aggregate.rust.metrics.totalMs?.p95}`)
console.log(`cpuMs p50/p95: ${aggregate.powershell.metrics.cpuMs?.p50}/${aggregate.powershell.metrics.cpuMs?.p95} → ${aggregate.rust.metrics.cpuMs?.p50}/${aggregate.rust.metrics.cpuMs?.p95}`)
console.log(`peakPrivateKb p50/p95: ${aggregate.powershell.metrics.peakPrivateKb?.p50}/${aggregate.powershell.metrics.peakPrivateKb?.p95} → ${aggregate.rust.metrics.peakPrivateKb?.p50}/${aggregate.rust.metrics.peakPrivateKb?.p95}`)
console.log(`evidence: ${options.output}`)
if (cleanupFailures.length) console.log(`cleanup failures: ${cleanupFailures.join('; ')}`)
process.exit(passed && cleanupFailures.length === 0 ? 0 : 1)
