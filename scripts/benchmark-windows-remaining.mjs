// Measures the PowerShell windows bridge for the three actions that have no
// native route yet: `activate`, `search` and `current-content`.
//
// Only safe, self-owned inputs are used: a synthetic AppID that cannot be
// registered, a temporary folder tree created by this script, and the
// repository's own non-activating UIA fixture. No user window, browser profile,
// Office document or real application is opened.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const koffi = require('koffi')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const options = {
  samples: 10,
  output: join(root, 'tests/yu-v2/evidence/rust-windows-remaining-20261104.json'),
  timeoutMs: 15000,
}

for (const argument of process.argv.slice(2)) {
  const [flag, inline] = argument.split('=')
  const next = () => {
    if (inline !== undefined) return inline
    return process.argv[process.argv.indexOf(argument) + 1]
  }
  if (flag === '--samples') options.samples = Number(next())
  else if (flag === '--output') options.output = resolve(root, next())
  else if (flag === '--timeoutMs') options.timeoutMs = Number(next())
}

if (!Number.isInteger(options.samples) || options.samples < 2) {
  console.error('--samples must be an integer >= 2')
  process.exit(2)
}

const powershell = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)
const bridge = join(root, 'resources/windows-tools.ps1')
const fixtureScript = join(root, 'tests/yu-v2/fixtures/uia-provider.ps1')

const kernel32 = koffi.load('kernel32.dll')
const CreateJobObjectW = kernel32.func('void *CreateJobObjectW(void *attributes, const char16_t *name)')
const AssignProcessToJobObject = kernel32.func('int AssignProcessToJobObject(void *job, void *process)')
const OpenProcess = kernel32.func('void *OpenProcess(uint32_t access, int inherit, uint32_t pid)')
const CloseHandle = kernel32.func('int CloseHandle(void *handle)')

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
  MinimumWorkingSetSize: 'uintptr_t',
  MaximumWorkingSetSize: 'uintptr_t',
  ActiveProcessLimit: 'uint32',
  Affinity: 'uintptr_t',
  PriorityClass: 'uint32',
  SchedulingClass: 'uint32',
})

const JobExtendedLimit = koffi.struct('JobExtendedLimit', {
  BasicLimitInformation: JobBasicLimit,
  IoInfo: koffi.array('uint8', 48),
  ProcessMemoryLimit: 'uint64',
  JobMemoryLimit: 'uint64',
  PeakProcessMemoryUsed: 'uint64',
  PeakJobMemoryUsed: 'uint64',
})

const QueryAccounting = kernel32.func(
  'int QueryInformationJobObject(void *job, int class, _Out_ JobAccounting *info, uint32_t length, void *returned)',
)
const QueryExtendedLimit = kernel32.func(
  'int QueryInformationJobObject(void *job, int class, _Out_ JobExtendedLimit *info, uint32_t length, void *returned)',
)

function openJob(pid) {
  const job = CreateJobObjectW(null, null)
  if (!job) return { error: 'CreateJobObjectW failed' }
  const handle = OpenProcess(0x0100 | 0x0001 | 0x0400 | 0x0200, 0, pid)
  if (!handle) {
    CloseHandle(job)
    return { error: 'OpenProcess failed' }
  }
  const assigned = AssignProcessToJobObject(job, handle)
  CloseHandle(handle)
  if (!assigned) {
    CloseHandle(job)
    return { error: 'AssignProcessToJobObject failed' }
  }
  return { job }
}

function readAccounting(job) {
  const totals = [{}]
  if (!QueryAccounting(job, 1, totals, koffi.sizeof(JobAccounting), null)) return undefined
  const limits = [{}]
  if (!QueryExtendedLimit(job, 9, limits, koffi.sizeof(JobExtendedLimit), null)) return undefined
  const userMs = Number(totals[0].TotalUserTime) / 10000
  const kernelMs = Number(totals[0].TotalKernelTime) / 10000
  return {
    cpuUserMs: userMs,
    cpuKernelMs: kernelMs,
    cpuMs: userMs + kernelMs,
    peakPrivateKb: Math.round(Number(limits[0].PeakProcessMemoryUsed) / 1024),
  }
}

function run(body) {
  return new Promise((settle) => {
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-File', bridge], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const job = openJob(child.pid)
    const started = performance.now()
    const out = []
    const err = []
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('close', onClose)
      const usage = job.job ? readAccounting(job.job) : undefined
      if (job.job) CloseHandle(job.job)
      settle({
        ...result,
        totalMs: Number((performance.now() - started).toFixed(2)),
        jobError: job.error,
        ...(usage ?? {}),
      })
    }
    const onClose = (code) => finish({ code, stdout: out.join(''), stderr: err.join('') })
    child.on('close', onClose)
    child.stdout.on('data', (chunk) => out.push(chunk.toString('utf8')))
    child.stderr.on('data', (chunk) => err.push(chunk.toString('utf8')))
    child.on('error', (error) => finish({ code: null, spawnError: error.message, stdout: out.join(''), stderr: err.join('') }))
    child.stdin.on('error', () => {})
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ code: null, timedOut: true, stdout: out.join(''), stderr: err.join('') })
    }, options.timeoutMs)
    child.stdin.end(JSON.stringify(body) + '\n')
  })
}

function percentile(values, q) {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * q) - 1]
}

function summary(samples, key) {
  const values = samples.map((sample) => sample[key]).filter((value) => typeof value === 'number')
  if (!values.length) return null
  return {
    n: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    min: Math.min(...values),
    max: Math.max(...values),
  }
}

/** The repository's own non-activating UIA fixture. */
function startFixture(mode) {
  const child = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixtureScript, '-Mode', mode], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return new Promise((ready, fail) => {
    const timer = setTimeout(() => fail(new Error(`${mode} fixture did not become ready`)), 30000)
    let buffered = ''
    child.stdout.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const event = JSON.parse(line)
        if (event.type !== 'ready') continue
        clearTimeout(timer)
        ready({
          mode,
          child,
          handle: String(Number(BigInt(event.handle))),
          pid: event.pid,
          title: event.title,
          send: (command) => child.stdin.write(JSON.stringify(command) + '\n'),
        })
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      fail(error)
    })
    child.stdin.on('error', () => {})
  })
}

async function stopFixture(fixture) {
  try {
    fixture.send({ command: 'quit' })
    fixture.child.stdin.end()
  } catch {}
  await new Promise((done) => setTimeout(done, 500))
  if (fixture.child.exitCode === null) fixture.child.kill('SIGKILL')
}

/** A temporary tree with a fixed, synthetic shape. */
function makeTree() {
  const directory = mkdtempSync(join(process.env.TEMP ?? '.', 'yu-search-'))
  mkdirSync(join(directory, 'nested', 'deep'), { recursive: true })
  writeFileSync(join(directory, 'sample-one.txt'), 'one')
  writeFileSync(join(directory, 'sample-two.txt'), 'two')
  writeFileSync(join(directory, 'other.md'), '# other')
  writeFileSync(join(directory, 'nested', 'sample-three.txt'), 'three')
  writeFileSync(join(directory, 'nested', 'deep', 'sample-four.txt'), 'four')
  return directory
}

const scenarios = []
const cleanup = { directories: [], fixtures: [], failures: [] }

// 1. `activate` with an AppID that cannot be registered: measured up to the
// rejection only. A successful ShellExecute and the window becoming visible are
// deliberately out of scope, so this is not a full activation latency.
for (let warmup = 0; warmup < 1; warmup += 1) {
  await run({ action: 'activate', appId: 'yu-remaining-missing-appid' })
}
{
  const samples = []
  for (let index = 0; index < options.samples; index += 1) {
    samples.push(await run({ action: 'activate', appId: 'yu-remaining-missing-appid' }))
  }
  scenarios.push({
    id: 'activate-unregistered-appid',
    action: 'activate',
    input: 'synthetic AppID that is not registered',
    expectation: 'exit 1 with "Registered app is no longer available"',
    covers: 'AppID lookup and rejection only; excludes ShellExecute and window visibility',
    validate: (sample) =>
      sample.code === 1 && sample.stderr.includes('Registered app is no longer available'),
    samples,
  })
}

// 2. `search` over this script's own temporary tree.
{
  const directory = makeTree()
  cleanup.directories.push(directory)
  // `mkdtemp` hands back the 8.3 spelling; the shell reports long paths.
  const longDirectory = realpathSync.native(directory)
  const body = { action: 'search', root: directory, name: 'sample', extensions: ['txt'], recursive: true }
  await run(body)
  const samples = []
  for (let index = 0; index < options.samples; index += 1) {
    samples.push(await run(body))
  }
  const first = JSON.parse(samples[0].stdout)
  scenarios.push({
    id: 'search-own-tree',
    action: 'search',
    input: 'temporary tree with 5 files (4 .txt, 1 .md), recursive, name filter "sample"',
    expectation: 'exit 0, 4 paths, all inside the temporary root',
    backend: first.backend,
    indexUnavailable: first.indexUnavailable,
    covers: `windows-search availability on this machine and the folder fallback; indexed positive hits: ${
      first.backend === 'windows-search+folder' && first.files.length > 0 ? 'observed' : 'not observed'
    }`,
    validate: (sample) => {
      if (sample.code !== 0) return false
      const body = JSON.parse(sample.stdout)
      return (
        body.files.length === 4 &&
        body.files.every((file) => file.path.startsWith(longDirectory)) &&
        body.files.every((file) => file.name.toLowerCase().includes('sample'))
      )
    },
    samples,
  })
}

// 3. `current-content` against the repository's own UIA fixture.
{
  const fixture = await startFixture('address-edit')
  cleanup.fixtures.push(fixture)
  const body = { action: 'current-content', handle: fixture.handle, pid: fixture.pid, title: fixture.title }
  await run(body)
  const samples = []
  for (let index = 0; index < options.samples; index += 1) {
    samples.push(await run(body))
  }
  await stopFixture(fixture)
  const first = JSON.parse(samples[0].stdout)
  scenarios.push({
    id: 'current-content-own-fixture',
    action: 'current-content',
    input: 'repository UIA fixture (address-edit mode): one ToolBar, one Edit with a value, no Document',
    expectation: 'exit 0 and the frozen window title echoed back',
    body: { keys: Object.keys(first) },
    covers:
      'the reachable branch for a window without a Document element; Office, Explorer and real TextPattern paths are untested',
    validate: (sample) => sample.code === 0 && JSON.parse(sample.stdout).title === fixture.title,
    samples,
  })
}

for (const scenario of scenarios) {
  scenario.stats = {
    totalMs: summary(scenario.samples, 'totalMs'),
    cpuMs: summary(scenario.samples, 'cpuMs'),
    peakPrivateKb: summary(scenario.samples, 'peakPrivateKb'),
  }
  scenario.failures = scenario.samples
    .map((sample, index) => ({
      index,
      code: sample.code,
      timedOut: sample.timedOut ?? false,
      stderr: sample.stderr?.trim().slice(0, 200) ?? '',
      parsed: scenario.validate?.(sample) ?? true,
    }))
    .filter((entry) => !entry.parsed)
  scenario.valid = scenario.samples.filter((sample) => scenario.validate?.(sample) ?? true).length
}

const binaryBytes = statSync(join(root, 'native/bin/yu-windows.exe')).size
const binarySha = createHash('sha256')
  .update(readFileSync(join(root, 'native/bin/yu-windows.exe')))
  .digest('hex')

const report = {
  kind: 'windows-helper-comparison',
  version: 1,
  meta: {
    generatedAt: new Date().toISOString(),
    host: {
      os: `${process.platform} ${process.arch}`,
      cpuModel: cpus()[0]?.model ?? 'unknown',
      cores: cpus().length,
      totalMemMb: Math.round(totalmem() / 1024 / 1024),
    },
    node: process.version,
    samples: options.samples,
    action: 'activate | search | current-content',
    measurement: {
      method: 'wall clock from spawn to stdio close, plus job accounting where the job was assigned',
      cpuWindow: 'spawn → stdio close',
      memory: 'job peak process memory (kernel) sampled at close',
      timeoutMs: options.timeoutMs,
      notes:
        'No native route exists for these actions, so every number is the PowerShell bridge only. No Rust comparison is implied.',
    },
    fixture: {
      search: 'temporary tree created by this script, removed afterwards',
      currentContent: 'tests/yu-v2/fixtures/uia-provider.ps1 (address-edit)',
      ownership: 'no user window, browser profile, Office document or real application is used',
    },
    helper: { path: 'native/bin/yu-windows.exe', bytes: binaryBytes, sha256: binarySha },
    closure: 'stage 17 C1/C2 closure build; native route for these actions is out of scope',
  },
  scenarios,
  cleanup,
}

writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n')

for (const directory of cleanup.directories) {
  try {
    rmSync(directory, { recursive: true, force: true })
  } catch (error) {
    cleanup.failures.push(`${directory}: ${error.message}`)
  }
}

for (const scenario of scenarios) {
  console.log(
    `${scenario.id}: n=${scenario.valid}/${scenario.valid + scenario.failures.length} total P50/P95 ${scenario.stats.totalMs?.p50}/${scenario.stats.totalMs?.p95} ms, cpu ${scenario.stats.cpuMs?.p50}/${scenario.stats.cpuMs?.p95} ms, private ${scenario.stats.peakPrivateKb?.p50}/${scenario.stats.peakPrivateKb?.p95} KB, failures ${scenario.failures.length}`,
  )
}
console.log(`output: ${options.output}`)
