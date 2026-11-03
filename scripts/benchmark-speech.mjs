/**
 * Compares the PowerShell speech host with the Rust helper on the same machine,
 * text, voice, rate and volume. Voices and speak are measured separately: the
 * enumeration never opens the audio device, and the speak runs use volume 0 so
 * the room stays quiet while the engine still paces real synthesis.
 *
 *   node scripts/benchmark-speech.mjs [--samples 20] [--text '…'] [--voice '…']
 *
 * Timing boundaries are the real ones: everything is measured from the moment
 * the request is written to the moment the child's stdio is closed, so no
 * artificial delay is folded into the total.
 *
 * CPU is the process lifetime total over that same window — the Win32 job object
 * accounting (user + kernel) of the process we spawned, which the kernel keeps
 * accumulating until the process has exited. It is not a snapshot taken while
 * the process happens to be alive: start-up, synthesis, the END event and
 * teardown are all inside the window, and both hosts are measured the same way.
 *
 * Memory is a peak over the same window: private commit from the job's kernel
 * peak (exact) and working set from samples taken every 100 ms, so the working
 * set figure is "peak at 100 ms resolution", not a true peak.
 *
 * The script writes tests/yu-v2/evidence/rust-speech-lifecycle-20261104.json and
 * exits non-zero when a check fails.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { availableParallelism, cpus, release } from 'node:os'
import { performance } from 'node:perf_hooks'
import koffi from 'koffi'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const rounds = Number(option('samples', '10'))
const text = option('text', '你好，这是一次本地朗读测试。')
const voice = option('voice', 'Microsoft Huihui Desktop')
const rate = Number(option('rate', '0'))
const volume = Number(option('volume', '0'))
const exe = resolve(root, option('exe', 'native/bin/yu-speech.exe'))
const output = resolve(root, option('output', 'tests/yu-v2/evidence/rust-speech-lifecycle-20261104.json'))
const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const memoryIntervalMs = 100

const hosts = {
  powershell: { command: shell, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'resources', 'speech.ps1')] },
  native: { command: exe, args: [] }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * Win32 job accounting. A job object keeps the CPU totals and the peak commit
 * charge of the processes assigned to it after they exit, which is the only way
 * to read a child's lifetime CPU without changing the helper protocol.
 */
const kernel32 = koffi.load('kernel32.dll')
const psapi = koffi.load('psapi.dll')

const CreateJobObjectW = kernel32.func('CreateJobObjectW', 'void *', ['void *', 'str16'])
const AssignProcessToJobObject = kernel32.func('AssignProcessToJobObject', 'int', ['void *', 'void *'])
const OpenProcess = kernel32.func('OpenProcess', 'void *', ['uint32', 'int', 'uint32'])
const CloseHandle = kernel32.func('CloseHandle', 'int', ['void *'])
const GetProcessHandleCount = kernel32.func('GetProcessHandleCount', 'int', ['void *', koffi.out(koffi.pointer('uint32'))])
const CreateToolhelp32Snapshot = kernel32.func('CreateToolhelp32Snapshot', 'void *', ['uint32', 'uint32'])
const Thread32First = kernel32.func('Thread32First', 'int', ['void *', 'void *'])
const Thread32Next = kernel32.func('Thread32Next', 'int', ['void *', 'void *'])

const JobAccounting = koffi.struct('JOBOBJECT_BASIC_ACCOUNTING_INFORMATION', {
  TotalUserTime: 'int64',
  TotalKernelTime: 'int64',
  ThisPeriodTotalUserTime: 'int64',
  ThisPeriodTotalKernelTime: 'int64',
  TotalPageFaultCount: 'uint32',
  TotalProcesses: 'uint32',
  TotalTerminatedProcesses: 'uint32'
})

const JobExtendedLimit = koffi.struct('JOBOBJECT_EXTENDED_LIMIT_INFORMATION', {
  PerProcessUserTimeLimit: 'int64',
  PerJobUserTimeLimit: 'int64',
  LimitFlags: 'uint32',
  MinimumWorkingSetSize: 'uintptr_t',
  MaximumWorkingSetSize: 'uintptr_t',
  ActiveProcessLimit: 'uint32',
  Affinity: 'uintptr_t',
  PriorityClass: 'uint32',
  SchedulingClass: 'uint32',
  ReadOperationCount: 'uint64',
  WriteOperationCount: 'uint64',
  OtherOperationCount: 'uint64',
  ReadTransferCount: 'uint64',
  WriteTransferCount: 'uint64',
  OtherTransferCount: 'uint64',
  ProcessMemoryLimit: 'uintptr_t',
  JobMemoryLimit: 'uintptr_t',
  PeakProcessMemoryUsed: 'uintptr_t',
  PeakJobMemoryUsed: 'uintptr_t'
})

const ProcessMemoryCounters = koffi.struct('PROCESS_MEMORY_COUNTERS', {
  cb: 'uint32',
  PageFaultCount: 'uint32',
  PeakWorkingSetSize: 'uintptr_t',
  WorkingSetSize: 'uintptr_t',
  QuotaPeakPagedPoolUsage: 'uintptr_t',
  QuotaPagedPoolUsage: 'uintptr_t',
  QuotaPeakNonPagedPoolUsage: 'uintptr_t',
  QuotaNonPagedPoolUsage: 'uintptr_t',
  PagefileUsage: 'uintptr_t',
  PeakPagefileUsage: 'uintptr_t'
})

const ThreadEntry = koffi.struct('THREADENTRY32', {
  dwSize: 'uint32',
  cntUsage: 'uint32',
  th32ThreadID: 'uint32',
  th32OwnerProcessID: 'uint32',
  tpBasePri: 'int32',
  tpDeltaPri: 'int32',
  dwFlags: 'uint32'
})

const PROCESS_INFO_SIZE = koffi.sizeof(ProcessMemoryCounters)
const THREAD_ENTRY_SIZE = koffi.sizeof(ThreadEntry)
const ACCOUNTING_SIZE = koffi.sizeof(JobAccounting)
const EXTENDED_SIZE = koffi.sizeof(JobExtendedLimit)

// Struct-typed out-parameters: koffi needs the concrete type, a plain `void *`
// would reject the JS object that receives the fields.
const QueryAccounting = kernel32.func('QueryInformationJobObject', 'int', ['void *', 'int', koffi.out(koffi.pointer(JobAccounting)), 'uint32', 'void *'])
const QueryExtendedLimit = kernel32.func('QueryInformationJobObject', 'int', ['void *', 'int', koffi.out(koffi.pointer(JobExtendedLimit)), 'uint32', 'void *'])
const GetProcessMemoryInfo = psapi.func('GetProcessMemoryInfo', 'int', ['void *', koffi.out(koffi.pointer(ProcessMemoryCounters)), 'uint32'])

/** PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION | PROCESS_VM_READ */
function openProcess(pid) {
  return OpenProcess(0x0100 | 0x0001 | 0x0400 | 0x0010, 0, pid)
}

/** Thread count of one process; null when the snapshot could not be taken. */
function countThreads(pid) {
  const snapshot = CreateToolhelp32Snapshot(4, 0)
  if (!snapshot || snapshot === -1n || snapshot === 0xffffffffffffffffn) return null
  try {
    // THREADENTRY32.dwSize has to be filled in before the first call, so the
    // entry is passed as a raw buffer and the owner pid read at its offset.
    const entry = Buffer.alloc(THREAD_ENTRY_SIZE)
    entry.writeUInt32LE(THREAD_ENTRY_SIZE, 0)
    let found = false
    let total = 0
    for (let more = Thread32First(snapshot, entry); more; more = Thread32Next(snapshot, entry)) {
      found = true
      if (entry.readUInt32LE(12) === pid) total += 1
    }
    return found ? total : null
  } finally {
    CloseHandle(snapshot)
  }
}

/**
 * Reads the job's totals once the child is gone. The kernel charges a
 * terminating process into the job slightly after the stdio close event (and a
 * very short process can still read as 0 for a few milliseconds), so the
 * counters are polled for up to 300 ms until CPU time shows up; this happens
 * after close and never inside the measured window.
 */
async function readAccounting(job) {
  const info = {
    TotalUserTime: 0n,
    TotalKernelTime: 0n,
    ThisPeriodTotalUserTime: 0n,
    ThisPeriodTotalKernelTime: 0n,
    TotalPageFaultCount: 0,
    TotalProcesses: 0,
    TotalTerminatedProcesses: 0
  }
  let settled = false
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (!QueryAccounting(job, 1, info, ACCOUNTING_SIZE, null)) {
      return { ok: false, error: 'QueryInformationJobObject(accounting) failed' }
    }
    if (info.TotalUserTime + info.TotalKernelTime > 0n) {
      settled = true
      break
    }
    await sleep(20)
  }
  const extended = {
    PerProcessUserTimeLimit: 0n,
    PerJobUserTimeLimit: 0n,
    LimitFlags: 0,
    MinimumWorkingSetSize: 0n,
    MaximumWorkingSetSize: 0n,
    ActiveProcessLimit: 0,
    Affinity: 0n,
    PriorityClass: 0,
    SchedulingClass: 0,
    ReadOperationCount: 0n,
    WriteOperationCount: 0n,
    OtherOperationCount: 0n,
    ReadTransferCount: 0n,
    WriteTransferCount: 0n,
    OtherTransferCount: 0n,
    ProcessMemoryLimit: 0n,
    JobMemoryLimit: 0n,
    PeakProcessMemoryUsed: 0n,
    PeakJobMemoryUsed: 0n
  }
  const extendedOk = QueryExtendedLimit(job, 9, extended, EXTENDED_SIZE, null)
  return {
    ok: true,
    settled,
    processes: info.TotalProcesses,
    terminated: info.TotalTerminatedProcesses,
    userMs: Number(info.TotalUserTime) / 10000,
    kernelMs: Number(info.TotalKernelTime) / 10000,
    peakPrivateKb: extendedOk ? Number(extended.PeakProcessMemoryUsed) / 1024 : null
  }
}

/**
 * Runs one request. Resolves on `close`, so the reported total covers the whole
 * child lifetime and drained pipes; the CPU window is the same span, and the
 * sampler stops at close. No extra wait is added on top of the totals.
 */
function run(name, request, { round = 0 } = {}) {
  const host = hosts[name]
  return new Promise((done) => {
    const started = performance.now()
    let child
    try {
      child = spawn(host.command, host.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      done({ host: name, round, spawnError: String(error), events: [], code: -1, closed: false, accounting: null })
      return
    }

    const events = []
    const job = CreateJobObjectW(null, null)
    const processHandle = child.pid ? openProcess(child.pid) : null
    const assigned = processHandle ? AssignProcessToJobObject(job, processHandle) !== 0 : false
    const assignmentError = processHandle
      ? (assigned ? null : 'AssignProcessToJobObject failed')
      : 'OpenProcess failed'

    let buffer = ''
    let writeAtMs = null
    let writeError = null
    let settled = false
    let sampling = true
    let peakWorkingSetKb = null
    let peakPrivateSampleKb = null
    let memorySampleCount = 0
    let handlesMax = null
    let threadsMax = null
    let ticks = 0
    let inflight = Promise.resolve()
    const counters = {
      cb: PROCESS_INFO_SIZE,
      PageFaultCount: 0,
      PeakWorkingSetSize: 0n,
      WorkingSetSize: 0n,
      QuotaPeakPagedPoolUsage: 0n,
      QuotaPagedPoolUsage: 0n,
      QuotaPeakNonPagedPoolUsage: 0n,
      QuotaNonPagedPoolUsage: 0n,
      PagefileUsage: 0n,
      PeakPagefileUsage: 0n
    }

    const sample = () => {
      if (!sampling || !processHandle) return
      ticks += 1
      counters.cb = PROCESS_INFO_SIZE
      if (GetProcessMemoryInfo(processHandle, counters, PROCESS_INFO_SIZE)) {
        const workingKb = Number(counters.WorkingSetSize) / 1024
        const privateKb = Number(counters.PagefileUsage) / 1024
        memorySampleCount += 1
        peakWorkingSetKb = peakWorkingSetKb === null ? workingKb : Math.max(peakWorkingSetKb, workingKb)
        peakPrivateSampleKb = peakPrivateSampleKb === null ? privateKb : Math.max(peakPrivateSampleKb, privateKb)
      }
      const handleCount = [0]
      if (GetProcessHandleCount(processHandle, handleCount) && handleCount[0] > 0) {
        handlesMax = handlesMax === null ? handleCount[0] : Math.max(handlesMax, handleCount[0])
      }
      // Thread snapshots are the expensive call, so they run five times rarer.
      if (ticks % 5 === 0) {
        const threads = countThreads(child.pid)
        if (threads !== null) threadsMax = threadsMax === null ? threads : Math.max(threadsMax, threads)
      }
    }

    const timer = setInterval(() => {
      inflight = inflight.then(sample)
    }, memoryIntervalMs)
    // One sample straight away, so an utterance shorter than the interval still
    // reports a sampled peak instead of an empty field.
    inflight = inflight.then(sample)
    const killTimer = setTimeout(() => {
      try { child.kill() } catch {}
    }, 60_000)

    const finish = async (extra = {}) => {
      if (settled) return
      settled = true
      sampling = false
      clearInterval(timer)
      clearTimeout(killTimer)
      await inflight
      const accounting = await readAccounting(job)
      if (processHandle) CloseHandle(processHandle)
      CloseHandle(job)
      done({
        host: name,
        round,
        pid: child.pid ?? null,
        events,
        writeAtMs,
        writeError,
        assigned,
        assignmentError,
        accounting,
        peakWorkingSetKb,
        peakPrivateSampleKb,
        memorySampleCount,
        handlesMax,
        threadsMax,
        ...extra
      })
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        const at = Math.round(performance.now() - started)
        let parsed = null
        try { parsed = JSON.parse(line) } catch { parsed = { raw: line } }
        events.push({ at, ...parsed })
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', () => {})
    child.stdin.on('error', (error) => { writeError = String(error) })
    child.on('error', (error) => finish({ code: -1, spawnError: String(error), closed: false }))
    child.on('close', (code, signal) => {
      const closedAt = Math.round(performance.now() - started)
      if (buffer.trim()) events.push({ at: closedAt, raw: buffer.trim() })
      finish({ code, signal, closed: true, closedAtMs: closedAt })
    })

    try {
      child.stdin.write(JSON.stringify(request) + '\n')
      writeAtMs = Math.round(performance.now() - started)
    } catch (error) {
      writeError = String(error)
    }
    if (request.action !== 'speak') child.stdin.end()
  })
}

/** Percentile over the samples that passed validation; raw stays in the report. */
function stats(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))]
  return { count: sorted.length, min: round1(sorted[0]), p50: round1(at(0.5)), p95: round1(at(0.95)), max: round1(sorted[sorted.length - 1]) }
}

const round1 = (value) => (value == null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10)
const round2 = (value) => (value == null || !Number.isFinite(value) ? null : Math.round(value * 100) / 100)

function record(result, kind) {
  const started = result.events.find((event) => event.event === 'started') ?? null
  const terminal = result.events.find((event) => event.ok === true && !event.event) ?? null
  const failure = result.events.find((event) => event.ok === false) ?? null
  const voices = result.events.find((event) => Array.isArray(event.voices))?.voices ?? null
  const accounting = result.accounting?.ok ? result.accounting : null
  const cpuTotalMs = accounting ? accounting.userMs + accounting.kernelMs : null
  const invalidReason =
    result.spawnError ??
    failure?.error ??
    (accounting ? null : result.accounting?.error ?? 'job accounting unavailable') ??
    (accounting && accounting.processes === 0 ? 'job accounted no processes' : null) ??
    // A voices run is a handshake, and a 25 ms process can sit below the OS CPU
    // accounting granularity; the zero check is what protects the speak samples.
    (kind === 'speak' && cpuTotalMs !== null && !(cpuTotalMs > 0) ? 'job reported zero CPU' : null) ??
    (result.writeError ? result.writeError : null) ??
    (kind === 'speak' && terminal === null ? 'no terminal event' : null)
  const ok = result.code === 0 && !invalidReason && (kind === 'voices' ? Array.isArray(voices) : terminal !== null)
  return {
    kind,
    side: result.host,
    round: result.round,
    pid: result.pid ?? null,
    ok,
    invalidReason,
    code: result.code ?? null,
    spawnError: result.spawnError ?? null,
    writeError: result.writeError ?? null,
    requestWriteAt: result.writeAtMs ?? null,
    startedAt: started ? started.at : null,
    endAt: terminal ? terminal.at : null,
    closeAt: result.closedAtMs ?? null,
    // Whole child lifetime, measured to pipes-drained close: the request cost
    // without any artificial completion delay.
    totalMs: result.closedAtMs ?? null,
    cpuWindowStart: 'stdin write',
    cpuWindowEnd: 'stdio close',
    cpuUserMs: round2(accounting?.userMs),
    cpuKernelMs: round2(accounting?.kernelMs),
    cpuTotalMs: round2(cpuTotalMs),
    peakPrivateKb: round1(accounting?.peakPrivateKb),
    peakPrivateSampleKb: round1(result.peakPrivateSampleKb),
    peakWorkingSetKb: round1(result.peakWorkingSetKb),
    memorySampleCount: result.memorySampleCount ?? 0,
    memoryIntervalMs,
    handlesMax: result.handlesMax ?? null,
    threadsMax: result.threadsMax ?? null,
    jobAssigned: result.assigned ?? false,
    jobAssignmentError: result.assignmentError ?? null,
    jobSettled: accounting ? accounting.settled : null,
    jobProcesses: accounting ? accounting.processes : null,
    voices,
    error: failure?.error ?? null
  }
}

const METRIC_KEYS = ['totalMs', 'startedAt', 'cpuTotalMs', 'cpuUserMs', 'cpuKernelMs', 'peakPrivateKb', 'peakWorkingSetKb']

/**
 * Both hosts are measured by the same job accounting over the same window, so a
 * percentage is meaningful. If a metric ever loses that symmetry the entry has
 * to say so and drop its percentages instead of printing a comparison.
 */
const MEASUREMENT_REASON =
  'both hosts: job object accounting from stdin write to stdio close; peak private is the kernel peak, peak working set is the max of 100 ms samples'

function compare(baseline, next) {
  const entries = {}
  for (const key of METRIC_KEYS) {
    const a = baseline.metrics[key]
    const b = next.metrics[key]
    const comparable = Boolean(a && b)
    const pct = (from, to) => (comparable && Number.isFinite(from) && Number.isFinite(to) && from !== 0 ? round2(((to - from) / from) * 100) : null)
    entries[key] = {
      baselineP50: a?.p50 ?? null,
      baselineP95: a?.p95 ?? null,
      p50: b?.p50 ?? null,
      p95: b?.p95 ?? null,
      p50Pct: pct(a?.p50, b?.p50),
      p95Pct: pct(a?.p95, b?.p95),
      p95Delta: comparable && Number.isFinite(a?.p95) && Number.isFinite(b?.p95) ? round2(b.p95 - a.p95) : null,
      comparable,
      reason: comparable ? MEASUREMENT_REASON : 'missing samples on one side'
    }
  }
  return entries
}

async function collect(kind, order, total) {
  const runs = { powershell: [], native: [] }
  for (let index = 0; index < total; index += 1) {
    for (const name of order) {
      const request = kind === 'voices' ? { action: 'voices' } : { action: 'speak', text, voice, rate, volume }
      runs[name].push(record(await run(name, request, { round: index }), kind))
      await sleep(150)
    }
  }
  return runs
}

function hostSummary(records) {
  const ok = records.filter((record) => record.ok)
  const metrics = {}
  for (const key of METRIC_KEYS) metrics[key] = stats(ok.map((record) => record[key]))
  return {
    requests: records.length,
    valid: ok.length,
    failed: records.length - ok.length,
    totalMs: metrics.totalMs,
    startedMs: metrics.startedAt,
    cpuTotalMs: metrics.cpuTotalMs,
    cpuUserMs: metrics.cpuUserMs,
    cpuKernelMs: metrics.cpuKernelMs,
    peakPrivateKb: metrics.peakPrivateKb,
    peakWorkingSetKb: metrics.peakWorkingSetKb,
    cpuWindow: 'stdin write→close',
    memoryIntervalMs,
    failures: records
      .filter((record) => !record.ok)
      .map((record) => ({ round: record.round, code: record.code, reason: record.invalidReason, error: record.error, spawnError: record.spawnError })),
    metrics
  }
}

const binary = readFileSync(exe)
const binaryHash = createHash('sha256').update(binary).digest('hex')

console.log(`speech benchmark: ${rounds} rounds per ordering slot, text ${JSON.stringify(text)}, voice ${JSON.stringify(voice)}`)

// Warm both hosts so their first-run page cache and SAPI initialisation do not
// land on the measured samples.
for (const name of ['powershell', 'native']) {
  await run(name, { action: 'voices' })
  await run(name, { action: 'speak', text, voice, rate, volume })
}

const order = ['powershell', 'native', 'native', 'powershell']
const voices = await collect('voices', order, rounds)
const speak = await collect('speak', order, rounds)

const nativeVoices = voices.native.find((record) => record.voices)?.voices ?? null
const powershellVoices = voices.powershell.find((record) => record.voices)?.voices ?? null
const sameVoices = JSON.stringify(nativeVoices) === JSON.stringify(powershellVoices)

const voicesSummary = { powershell: hostSummary(voices.powershell), native: hostSummary(voices.native), identical: sameVoices, sample: { powershell: powershellVoices, native: nativeVoices } }
const speakSummary = { powershell: hostSummary(speak.powershell), native: hostSummary(speak.native) }
const comparison = compare(speakSummary.powershell, speakSummary.native)

// Adoption thresholds from the delivery plan, re-evaluated on this run: memory
// is a p50 private-bytes reduction of at least 30%, start-up is a p95 of at
// least 25% and at least 100 ms better.
const adoption = {
  memoryPct: comparison.peakPrivateKb.p50Pct,
  memoryMeets: comparison.peakPrivateKb.p50Pct !== null && comparison.peakPrivateKb.p50Pct <= -30,
  startedP95Pct: comparison.startedAt.p95Pct,
  startedP95DeltaMs: comparison.startedAt.p95Delta,
  startedMeets: comparison.startedAt.p95Pct !== null && comparison.startedAt.p95Pct <= -25 && comparison.startedAt.p95Delta <= -100,
  decision:
    comparison.peakPrivateKb.p50Pct !== null && comparison.peakPrivateKb.p50Pct <= -30
      ? 'memory'
      : comparison.startedAt.p95Pct !== null && comparison.startedAt.p95Pct <= -25 && comparison.startedAt.p95Delta <= -100
        ? 'startup'
        : 'below-threshold'
}

const speakRuns = [...speak.powershell, ...speak.native]
const checks = []
const push = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail })
push('both hosts answered the voice list', [voices.powershell, voices.native].every((runs) => runs.some((record) => record.ok && Array.isArray(record.voices))), `powershell=${powershellVoices?.length ?? 'null'} native=${nativeVoices?.length ?? 'null'}`)
push('both hosts list the same voices', sameVoices, 'voice arrays compared element-wise')
push('every speak run reported a terminal event and exit code 0', speakRuns.every((record) => record.ok), `${speakRuns.filter((record) => record.ok).length}/${speakRuns.length} valid`)
for (const side of ['powershell', 'native']) {
  const runs = speak[side]
  const valid = runs.filter((record) => record.ok)
  push(`${side}: at least 20 valid speak samples`, valid.length >= 20, `${valid.length} valid / ${runs.length} total`)
  push(`${side}: every valid sample reports cpuTotalMs > 0`, valid.length > 0 && valid.every((record) => Number.isFinite(record.cpuTotalMs) && record.cpuTotalMs > 0), `min=${stats(valid.map((record) => record.cpuTotalMs))?.min ?? 'null'}ms`)
  push(`${side}: cpu window is stdin write → stdio close on every sample`, runs.every((record) => record.cpuWindowStart === 'stdin write' && record.cpuWindowEnd === 'stdio close'), 'cpuWindowStart/cpuWindowEnd recorded per sample')
  push(`${side}: peak memory present with its sampling interval`, valid.length > 0 && valid.every((record) => Number.isFinite(record.peakPrivateKb) && record.peakPrivateKb > 0 && Number.isFinite(record.peakWorkingSetKb) && record.peakWorkingSetKb > 0 && record.memoryIntervalMs === memoryIntervalMs && record.memorySampleCount > 0), `peakPrivate/min=${stats(valid.map((record) => record.peakPrivateKb))?.min ?? 'null'}kB peakWorkingSet/min=${stats(valid.map((record) => record.peakWorkingSetKb))?.min ?? 'null'}kB interval=${memoryIntervalMs}ms`)
}
push('percentages appear only where comparable', Object.values(comparison).every((entry) => (entry.comparable ? entry.p50Pct !== null : entry.p50Pct === null && entry.p95Pct === null)), 'p50Pct/p95Pct present iff comparable')

const perSide = (summary) => ({ ...summary, n: summary.requests, invalid: summary.failed })

const report = {
  kind: 'speech-host-comparison',
  version: 3,
  meta: {
    generatedAt: new Date().toISOString(),
    host: { os: `${process.env.OS ?? 'windows'} ${release()}`, cpuModel: cpus()[0]?.model ?? 'unknown', cores: availableParallelism() },
    node: process.version,
    samples: rounds,
    text,
    voice,
    rate,
    volume,
    interleave: order,
    measurement: {
      method: 'P2',
      methodDetail: 'Win32 job object accounting (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION / JOBOBJECT_EXTENDED_LIMIT_INFORMATION)',
      cpuWindow: 'stdin write→close',
      memoryIntervalMs,
      memoryDetail: 'peakPrivateKb is the kernel peak commit of the process; peakWorkingSetKb is the maximum of samples taken every 100 ms',
      notes: 'helper protocol and binaries unchanged; job accounting is read after close with a ≤300 ms settle poll outside the measured window'
    }
  },
  platform: { os: process.env.OS ?? 'windows', arch: process.arch, release: release(), node: process.version },
  binary: { path: 'native/bin/yu-speech.exe', bytes: binary.length, sha256: binaryHash },
  scope: {
    voices: 'one process per sample; the request is answered and the process exits',
    speak: `one utterance (${text.length} chars), rate ${rate}, volume ${volume}; started is the host's own start event`,
    timing: 'total is request write to stdio close; no artificial completion delay is added',
    cpu: 'process lifetime CPU (user + kernel) from request write to stdio close, read from job accounting after exit',
    memory: `peak over the same window: private commit from the kernel peak, working set as the max of ${memoryIntervalMs} ms samples`,
    excluded: ['cloud TTS', 'playback of provider audio', 'SSML/markup', 'renderer/UI', 'multi-utterance sessions', 'no-output-device and default-device switching behaviour', 'audio service crash', 'Bluetooth/hot-plug', 'remote desktop and lock screen']
  },
  settings: { text, voice, rate, volume, roundsPerSlot: rounds, order, memoryIntervalMs },
  voices: voicesSummary,
  aggregate: { powershell: perSide(speakSummary.powershell), native: perSide(speakSummary.native) },
  runs: speakRuns,
  comparison,
  checks,
  passed: checks.every((check) => check.pass),
  adoption,
  decision: adoption.decision
}

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, JSON.stringify(report, null, 2) + '\n')

const row = (label, host) => ({
  host: label,
  requests: host.requests,
  valid: host.valid,
  'start p50': host.startedMs?.p50 ?? null,
  'start p95': host.startedMs?.p95 ?? null,
  'total p50': host.totalMs?.p50 ?? null,
  'cpu p50': host.cpuTotalMs?.p50 ?? null,
  'peak private p50': host.peakPrivateKb?.p50 ?? null,
  'peak workset p50': host.peakWorkingSetKb?.p50 ?? null
})
console.table([row('voices PS', voicesSummary.powershell), row('voices Rust', voicesSummary.native), row('speak PS', speakSummary.powershell), row('speak Rust', speakSummary.native)])
console.log('voices identical:', sameVoices, '| speak valid:', speakRuns.filter((record) => record.ok).length, '/', speakRuns.length)
console.log('comparison:', JSON.stringify(Object.fromEntries(Object.entries(comparison).map(([key, entry]) => [key, { p50Pct: entry.p50Pct, p95Pct: entry.p95Pct, comparable: entry.comparable }]))))
console.log('adoption:', JSON.stringify(adoption))
for (const check of checks) console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.name} — ${check.detail}`)
console.log('evidence:', output)

if (!report.passed) {
  console.error('speech benchmark checks failed; see', output)
  process.exitCode = 1
}
