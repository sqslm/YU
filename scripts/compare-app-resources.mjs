#!/usr/bin/env node
/**
 * Merges the baseline and candidate whole-app measurements into one evidence
 * file and decides whether the change may be adopted.
 *
 * The gate is deliberately strict about what it does *not* know: an unreadable
 * counter, a missing idle cluster or a missing pill trace all end in
 * `met: null`, which blocks adoption instead of contributing a fake saving.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const MiB = 1048576

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const prefix = `--${name}=`
  const inline = args.find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = args.indexOf(`--${name}`)
  if (index >= 0 && args[index + 1] !== undefined) return args[index + 1]
  return fallback
}

const baselinePath = option('baseline', join(ROOT, 'tests', 'yu-v2', 'evidence', '.electron-app-baseline.json'))
const candidatePath = option('candidate', join(ROOT, 'tests', 'yu-v2', 'evidence', '.electron-app-candidate.json'))
const output = option('output', join(ROOT, 'tests', 'yu-v2', 'evidence', 'electron-whole-app-resources-20261104.json'))

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'))

const IDLE = 'idle-60s'
const SETTLED = 'settled-4s'

function clusterOf(run, phase) {
  return run.trayIdle?.clusters?.[phase] ?? { count: 0, summary: { p50: null, p95: null }, unavailable: 0, byRole: {}, last: null }
}

/**
 * Snapshot totals per phase, so the evidence keeps the raw readings instead of
 * only the percentiles the thresholds read.
 */
function phaseTotals(run, phase) {
  return (run.trayIdle?.samples ?? [])
    .filter((sample) => sample.phase === phase)
    .map((sample) => (sample.processes ?? []).reduce((sum, entry) => sum + (entry.privateResidentBytes ?? 0), 0))
}

function numbers(list) {
  return (list ?? []).filter((value) => typeof value === 'number')
}

function growthPercent(from, to) {
  if (typeof from !== 'number' || typeof to !== 'number' || from === 0) return null
  return Math.round(((to - from) / from) * 10000) / 100
}

function percentDelta(from, to) {
  if (typeof from !== 'number' || typeof to !== 'number' || from === 0) return null
  return Math.round(((to - from) / from) * 10000) / 100
}

/**
 * Roles are recomputed from process names, so a sampler that predates the
 * helper rename cannot hide a helper inside `other`.
 */
function classify(name) {
  const text = String(name ?? '').toLowerCase()
  if (/^(?:typeless|yu)-(?:hotkey|uia|wake|speech|local-asr|windows)\.exe$/.test(text)) return 'helper'
  if (text === 'electron.exe') return 'electron'
  if (text === 'conhost.exe') return 'conhost'
  return 'other'
}

function groupsOf(snapshot) {
  const groups = {}
  for (const proc of snapshot?.processes ?? []) {
    const key = classify(proc.name)
    const bucket = (groups[key] ??= { count: 0, privateResidentBytes: 0, names: new Set() })
    bucket.count += 1
    bucket.names.add(proc.name)
    if (typeof proc.privateResidentBytes === 'number') bucket.privateResidentBytes += proc.privateResidentBytes
  }
  return Object.fromEntries(
    Object.entries(groups).map(([key, value]) => [key, { count: value.count, privateResidentBytes: value.privateResidentBytes, names: [...value.names] }])
  )
}

/** Renderers of the startup tree that are still alive after the hub spent time hidden. */
function survivors(seen) {
  if (!Array.isArray(seen) || seen.length < 3) return null
  const startup = seen.find((step) => step.at === 'startup')?.renderers ?? []
  const after = seen.find((step) => step.at === 'after-hide-idle')?.renderers ?? []
  return startup.filter((pid) => after.includes(pid))
}

const baselineIdle = clusterOf(baseline, IDLE)
const candidateIdle = clusterOf(candidate, IDLE)
const baselineSettled = clusterOf(baseline, SETTLED)
const candidateSettled = clusterOf(candidate, SETTLED)

const scenariosMatch = JSON.stringify(baseline.meta?.scenarios ?? {}) === JSON.stringify(candidate.meta?.scenarios ?? {})
const hostMatch = (baseline.meta?.host?.cores ?? 0) === (candidate.meta?.host?.cores ?? -1)
const sameBuild = Boolean(baseline.meta?.build?.entrySha256) && baseline.meta?.build?.entrySha256 === candidate.meta?.build?.entrySha256
const comparable = Boolean(scenariosMatch && hostMatch && !sameBuild)

const reasons = []
if (!scenariosMatch) reasons.push('scenario parameters differ between the two runs')
if (!hostMatch) reasons.push('the two runs did not use the same machine shape')
if (sameBuild) reasons.push('both runs measured the same build, so there is nothing to compare')

const baselineMedian = baselineIdle.summary.p50
const candidateMedian = candidateIdle.summary.p50
const memoryPercent = percentDelta(baselineMedian, candidateMedian)
const memoryBytes = typeof baselineMedian === 'number' && typeof candidateMedian === 'number' ? candidateMedian - baselineMedian : null
const memoryUnavailable = (baselineIdle.unavailable ?? 0) + (candidateIdle.unavailable ?? 0)
const memoryMet =
  comparable && baselineIdle.count >= 3 && candidateIdle.count >= 3 && memoryUnavailable === 0 && memoryPercent !== null && memoryBytes !== null
    ? memoryPercent <= -15 && memoryBytes <= -30 * MiB
    : null

// Growth is read from one instance's own cycle series, first five cycles
// against the last five: a fresh instance's idle figure would charge the
// one-time cost of loading the settings page once to "accumulation", and the
// settled tree right after launch is inflated by startup caches.
function cycleTrend(run) {
  const series = (run.toggles?.cycles ?? []).map((entry) => entry.privateResidentBytes).filter((value) => typeof value === 'number')
  if (series.length < 10) return null
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length
  const head = mean(series.slice(0, 5))
  const tail = mean(series.slice(-5))
  return growthPercent(Math.round(head), Math.round(tail))
}

const trend = cycleTrend(candidate)
const baselineTrend = cycleTrend(baseline)
const afterIdle = candidate.toggles?.memory?.totals?.privateResidentBytes
const baselineAfterIdle = baseline.toggles?.memory?.totals?.privateResidentBytes
const lastRenderers = candidate.toggles?.memory?.processes?.filter((proc) => proc.role === 'renderer').length
const growthMet =
  trend === null || typeof afterIdle !== 'number' || typeof baselineAfterIdle !== 'number' || typeof lastRenderers !== 'number'
    ? null
    : trend <= 5 && afterIdle <= baselineAfterIdle && lastRenderers <= 1

const openBaseline = baseline.firstOpen?.summary ?? {}
const openCandidate = candidate.firstOpen?.summary ?? {}
const openDelta = typeof openBaseline.p95 === 'number' && typeof openCandidate.p95 === 'number' ? Math.round((openCandidate.p95 - openBaseline.p95) * 1000) / 1000 : null
const openMet = openDelta === null ? null : openDelta <= 100

function pillVerdict() {
  const base = baseline.pill
  const cand = candidate.pill
  if (!base || !cand) return { met: null, reason: 'the pill scenario was not measured on both sides' }
  const reused = (cand.distinctRenderers?.length ?? 0) >= 2
  const retired = (cand.retirements ?? 0) >= 1
  const repeated = (cand.takes ?? 0) >= 2
  // The baseline cannot run the staying self-test, so what it proves is the other
  // half: its startup renderer is still there after an idle period.
  const baselineKept = (base.retirements ?? 0) === 0 && (base.distinctRenderers?.length ?? 0) >= 1 && (survivors(baseline.lifecycle)?.length ?? 0) >= 1
  const met = reused && retired && repeated && baselineKept
  const missing = [
    reused ? null : 'the candidate never showed two different pill renderers',
    retired ? null : 'the candidate never logged a retirement',
    repeated ? null : 'the candidate never ran two takes',
    baselineKept ? null : 'the baseline either retired the pill or never created one'
  ].filter(Boolean)
  return { met, reason: met ? 'created by a take, retired while idle, created again by the next take' : missing.join('; ') }
}

const pill = pillVerdict()

const thresholds = {
  memory: {
    metric: 'tray idle (60 s) whole-tree private resident median',
    percentAtMost: -15,
    bytesAtMost: -30 * MiB,
    baselineMedian,
    candidateMedian,
    percent: memoryPercent,
    bytes: memoryBytes,
    idleSamples: { baseline: baselineIdle.count, candidate: candidateIdle.count },
    unavailable: memoryUnavailable,
    met: memoryMet
  },
  noSustainedGrowth: {
    metric: 'same instance: mean private resident of cycles 16-20 vs cycles 1-5, plus the resting tree after the last cycle vs the baseline resting tree',
    percent: trend,
    baselinePercent: baselineTrend,
    atMost: 5,
    afterIdleBytes: afterIdle ?? null,
    baselineAfterIdleBytes: baselineAfterIdle ?? null,
    afterIdleRenderers: lastRenderers ?? null,
    afterIdleVsFreshIdlePercent: growthPercent(candidateMedian, afterIdle),
    baselineAfterIdleVsFreshIdlePercent: growthPercent(baselineMedian, baselineAfterIdle),
    met: growthMet
  },
  openLatency: {
    metric: 'first open p95',
    baselineP95Ms: openBaseline.p95 ?? null,
    candidateP95Ms: openCandidate.p95 ?? null,
    deltaMs: openDelta,
    atMostMs: 100,
    met: openMet
  },
  pillRetired: pill
}

const adopted = thresholds.memory.met === true && thresholds.noSustainedGrowth.met === true && thresholds.openLatency.met === true && thresholds.pillRetired.met === true
if (!adopted) {
  for (const [name, value] of Object.entries(thresholds)) {
    if (value.met !== true) reasons.push(`${name}: ${value.met === null ? 'not measurable' : 'threshold not met'}`)
  }
}

const evidence = {
  kind: 'electron-whole-app-resources',
  version: 2,
  generatedAt: new Date().toISOString(),
  scope: {
    included: [
      'whole application tree: main, gpu, utility, renderer, crashpad, zygote, conhost and the Rust helpers',
      'memory: private resident, working set and private commit per PID',
      'cpu: user+kernel delta over an explicit window with window length and cores',
      'latency: first open and reopen, measured from the second-instance trigger to the visible hub'
    ],
    excluded: ['no Vite dev server, no DevTools, no HMR', 'no user profile, no user microphone, no packaged installer', 'no EmptyWorkingSet or manual trimming', 'no forced GC']
  },
  environment: {
    host: { baseline: baseline.meta?.host ?? null, candidate: candidate.meta?.host ?? null },
    node: { baseline: baseline.meta?.node ?? null, candidate: candidate.meta?.node ?? null },
    electron: { baseline: baseline.meta?.electron ?? null, candidate: candidate.meta?.electron ?? null }
  },
  build: { baseline: baseline.meta?.build ?? null, candidate: candidate.meta?.build ?? null },
  comparable,
  measurement: baseline.meta?.measurement ?? null,
  attribution: {
    hypothesis: 'a hidden bar renderer was created on every launch and never released while the app rested in the tray',
    change: 'the bar window is created on demand and destroyed after 30 s of being hidden and idle',
    files: ['src/main/bar-retire.ts', 'src/main/index.ts', 'src/main/note-audio.ts']
  },
  baseline: {
    idle: baselineIdle,
    settled: baselineSettled,
    groups: baselineIdle.byRole,
    idleSamples: phaseTotals(baseline, IDLE),
    settledSamples: phaseTotals(baseline, SETTLED),
    openSamples: numbers(baseline.firstOpen?.samples),
    reopenSamples: numbers(baseline.toggles?.reopen),
    toggleCycles: (baseline.toggles?.cycles ?? []).map((cycle) => ({ cycle: cycle.cycle, privateResidentBytes: cycle.privateResidentBytes ?? null, renderers: cycle.renderers ?? null })),
    open: openBaseline,
    reopen: baseline.toggles?.summary ?? null,
    afterToggles: baseline.toggles?.memory?.totals ?? null,
    idleCpu: baseline.trayIdle?.cpu ?? null,
    lifecycle: baseline.lifecycle ?? []
  },
  candidate: {
    idle: candidateIdle,
    settled: candidateSettled,
    groups: candidateIdle.byRole,
    idleSamples: phaseTotals(candidate, IDLE),
    settledSamples: phaseTotals(candidate, SETTLED),
    openSamples: numbers(candidate.firstOpen?.samples),
    reopenSamples: numbers(candidate.toggles?.reopen),
    toggleCycles: (candidate.toggles?.cycles ?? []).map((cycle) => ({ cycle: cycle.cycle, privateResidentBytes: cycle.privateResidentBytes ?? null, renderers: cycle.renderers ?? null })),
    open: openCandidate,
    reopen: candidate.toggles?.summary ?? null,
    afterToggles: candidate.toggles?.memory?.totals ?? null,
    idleCpu: candidate.trayIdle?.cpu ?? null,
    lifecycle: candidate.lifecycle ?? []
  },
  comparison: {
    memory: {
      unit: 'bytes',
      baseline: baselineMedian,
      candidate: candidateMedian,
      percent: memoryPercent,
      mib: {
        baseline: typeof baselineMedian === 'number' ? Math.round((baselineMedian / MiB) * 10) / 10 : null,
        candidate: typeof candidateMedian === 'number' ? Math.round((candidateMedian / MiB) * 10) / 10 : null
      }
    },
    settledMemory: {
      baseline: baselineSettled.summary.p50,
      candidate: candidateSettled.summary.p50,
      percent: percentDelta(baselineSettled.summary.p50, candidateSettled.summary.p50)
    },
    openLatency: {
      p50: [openBaseline.p50 ?? null, openCandidate.p50 ?? null],
      p95: [openBaseline.p95 ?? null, openCandidate.p95 ?? null],
      deltaMs: openDelta
    },
    reopen: { baseline: baseline.toggles?.summary ?? null, candidate: candidate.toggles?.summary ?? null },
    togglesTrendPercent: trend,
    baselineTogglesTrendPercent: baselineTrend,
    idleCpuMs: { baseline: baseline.trayIdle?.cpu?.totalMs ?? null, candidate: candidate.trayIdle?.cpu?.totalMs ?? null },
    pill: {
      baseline: {
        retirements: baseline.pill?.retirements ?? null,
        distinctRenderers: baseline.pill?.distinctRenderers ?? null,
        takes: baseline.pill?.takes ?? null,
        observeMs: baseline.pill?.observeMs ?? null,
        repeatMs: baseline.pill?.repeatMs ?? null,
        aliveAtEnd: baseline.pill?.aliveAtEnd ?? null
      },
      candidate: {
        retirements: candidate.pill?.retirements ?? null,
        distinctRenderers: candidate.pill?.distinctRenderers ?? null,
        takes: candidate.pill?.takes ?? null,
        observeMs: candidate.pill?.observeMs ?? null,
        repeatMs: candidate.pill?.repeatMs ?? null,
        aliveAtEnd: candidate.pill?.aliveAtEnd ?? null
      }
    },
    rendererLifecycle: {
      stages: { baseline: (baseline.lifecycle ?? []).length, candidate: (candidate.lifecycle ?? []).length },
      baselineStartupSurvivors: survivors(baseline.lifecycle),
      candidateStartupSurvivors: survivors(candidate.lifecycle)
    }
  },
  thresholds,
  decision: adopted ? 'adopted' : 'not-adopted',
  reasons
}

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`)

const mib = (bytes) => (typeof bytes === 'number' ? `${(bytes / MiB).toFixed(1)} MiB` : 'n/a')
console.log(`[compare] idle median ${mib(baselineMedian)} → ${mib(candidateMedian)} (${memoryPercent ?? 'n/a'}%)`)
console.log(`[compare] open p95 ${openBaseline.p95 ?? 'n/a'} → ${openCandidate.p95 ?? 'n/a'} ms (${openDelta ?? 'n/a'})`)
console.log(`[compare] decision ${evidence.decision}${reasons.length ? ` — ${reasons.join('; ')}` : ''}`)
console.log(`[compare] evidence ${output}`)
if (!adopted) process.exitCode = 1
