#!/usr/bin/env node
/**
 * Merges the baseline and candidate whole-app measurements into one evidence
 * file and decides whether the change may be adopted.
 *
 * The gate is deliberately strict about what it does *not* know: an unreadable
 * counter, a missing idle cluster or a missing pill trace all end in
 * `met: null`, which blocks adoption instead of contributing a fake saving.
 *
 * Necessary conditions added after the stage-18 review — each one blocks
 * `adopted` on its own, because a number can be cheap for the wrong reason:
 *   - both runs prove they did not write the user's Run key (read-only diff plus
 *     the diagnostic wrapper's suppressed-write count),
 *   - both runs passed the controlled CPU self-check, so the unit is right,
 *   - both first-open distributions have at least 20 valid samples and every
 *     failure is counted instead of dropped,
 *   - cold start and first open are separate measurements, never mixed,
 *   - candidate idle CPU is within 1.20× of the baseline over comparable windows,
 *   - the candidate's playback probe passed.
 *
 *   node scripts/compare-app-resources.mjs --baseline=<json> --candidate=<json> \
 *     --output=<json> [--playback=<json>]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadPlaybackEvidence, playbackGate } from './lib/playback.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const MiB = 1048576
const MIN_OPEN_SAMPLES = 20
const MIN_IDLE_SAMPLES = 3
const IDLE_CPU_RATIO_AT_MOST = 1.2
const IDLE_WINDOW_TOLERANCE = 0.1

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const prefix = `--${name}=`
  const inline = args.find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = args.indexOf(`--${name}`)
  if (index >= 0 && args[index + 1] !== undefined && !args[index + 1].startsWith('--')) return args[index + 1]
  return fallback
}

const baselinePath = option('baseline', join(ROOT, 'tests', 'yu-v2', 'evidence', '.electron-app-baseline.json'))
const candidatePath = option('candidate', join(ROOT, 'tests', 'yu-v2', 'evidence', '.electron-app-candidate.json'))
const output = option('output', join(ROOT, 'tests', 'yu-v2', 'evidence', 'electron-whole-app-resources-20261104.json'))
const playbackPath = option('playback', null)

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

function percentDelta(from, to) {
  if (typeof from !== 'number' || typeof to !== 'number' || from === 0) return null
  return Math.round(((to - from) / from) * 10000) / 100
}

function growthPercent(from, to) {
  return percentDelta(from, to)
}

/** The benchmark emits `toggle`; older evidence used `toggles`. */
function toggleOf(run) {
  return run.toggle ?? run.toggles ?? {}
}

/** `firstOpen.valid[]` holds `{latencyMs, ok}`; version-1 evidence held bare numbers. */
function openSamplesOf(run) {
  const valid = run.firstOpen?.valid
  if (Array.isArray(valid)) return valid.map((sample) => (typeof sample === 'number' ? sample : sample?.latencyMs)).filter((value) => typeof value === 'number')
  return numbers(run.firstOpen?.samples)
}

function reopenSamplesOf(run) {
  const samples = run.reopen?.samples
  if (Array.isArray(samples)) return samples.map((sample) => (typeof sample === 'number' ? sample : sample?.latencyMs)).filter((value) => typeof value === 'number')
  return numbers(toggleOf(run).reopen)
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

/** The benchmark emits `lifecycle.seen`; older evidence was the bare array. */
function lifecycleSeen(run) {
  return Array.isArray(run.lifecycle) ? run.lifecycle : run.lifecycle?.seen ?? []
}

/** Renderers of the startup tree that are still alive after the hub spent time hidden. */
function survivors(seen) {
  if (!Array.isArray(seen) || seen.length < 3) return null
  const startup = seen.find((step) => step.at === 'startup')?.renderers ?? []
  const after = seen.find((step) => step.at === 'after-hide-idle')?.renderers ?? []
  return startup.filter((pid) => after.includes(pid))
}

// ── necessary conditions ─────────────────────────────────────────────────────
/**
 * Isolation: the Run key did not move and the wrapper logged at least one
 * suppressed write. Both are needed — no change alone could also mean the app
 * never tried, and a marker alone would not prove other programs' entries were
 * left alone. Nothing was written in either case; this only reads.
 */
function isolationOf(run) {
  const iso = run.meta?.isolation ?? run.isolation ?? null
  const unchanged = iso?.runKey?.unchanged === true
  const markers = Number(iso?.markerCount ?? 0)
  const changedEntries = (iso?.runKey?.diff?.added?.length ?? 0) + (iso?.runKey?.diff?.removed?.length ?? 0) + (iso?.runKey?.diff?.changed?.length ?? 0)
  const reasons = []
  if (!iso) reasons.push('no isolation evidence')
  else {
    if (!unchanged) reasons.push(`the Run key changed during the run (${changedEntries} entries in the diff)`)
    if (!(markers > 0)) reasons.push('the diagnostic wrapper never logged a suppressed login-item write')
    if (iso.valid !== true) reasons.push(...(iso.reasons ?? []).filter(Boolean))
  }
  return {
    met: Boolean(iso) && iso.valid === true && unchanged && markers > 0,
    unchanged,
    changedEntries,
    markerCount: markers,
    valid: iso?.valid === true,
    keyPath: iso?.runKey?.keyPath ?? null,
    diff: iso?.runKey?.diff ?? null,
    reasons
  }
}

function cpuSelfCheckOf(run) {
  const check = run.meta?.measurement?.cpuSelfCheck ?? null
  const reasons = []
  if (!check) reasons.push('no CPU self-check')
  else if (check.pass !== true) reasons.push(check.reason ?? `ratio ${check.ratio ?? 'n/a'} outside ±0.35`)
  return {
    met: check?.pass === true,
    pass: check?.pass ?? null,
    skipped: check?.skipped ?? null,
    windowMs: check?.windowMs ?? null,
    measuredMs: check?.measuredMs ?? null,
    cores: check?.cores ?? null,
    ratio: check?.ratio ?? null,
    reasons
  }
}

/**
 * Cold and first open must be separate: a fixed sleep folded into the open
 * distribution is what produced the n=21 mixed figure before.
 */
const COLD_MARKERS = ['startupMs', 'spawnToTreeReadyMs', 'spawnToPillReadyMs']
function separationOf(run) {
  const reasons = []
  const cold = run.cold
  if (!Array.isArray(cold) || cold.length === 0) reasons.push('no cold sample was recorded')
  const valid = run.firstOpen?.valid
  if (!Array.isArray(valid)) reasons.push('firstOpen.valid is missing')
  if (run.firstOpen?.coldIncluded !== false) reasons.push('firstOpen does not declare coldIncluded=false')
  const polluted = (Array.isArray(valid) ? valid : []).filter((sample) => sample && typeof sample === 'object' && (sample.cold === true || COLD_MARKERS.some((key) => key in sample)))
  if (polluted.length) reasons.push(`${polluted.length} first-open sample(s) carry cold-start fields`)
  if (run.firstOpen?.summary && Array.isArray(valid) && valid.length !== run.firstOpen.summary.count) reasons.push('the first-open summary was computed over a different sample set')
  return {
    met: reasons.length === 0,
    coldSamples: Array.isArray(cold) ? cold.length : null,
    openValid: Array.isArray(valid) ? valid.length : null,
    coldIncluded: run.firstOpen?.coldIncluded ?? null,
    reasons
  }
}

function idleCpuGate() {
  const base = baseline.trayIdle?.cpu ?? null
  const cand = candidate.trayIdle?.cpu ?? null
  const reasons = []
  const basePerSecond = base?.perSecond ?? null
  const candPerSecond = cand?.perSecond ?? null
  const baseWindow = base?.windowMs ?? null
  const candWindow = cand?.windowMs ?? null
  let windowDiffPercent = null
  let ratio = null
  if (typeof basePerSecond !== 'number' || typeof candPerSecond !== 'number') reasons.push('idle CPU per second is missing on one side')
  if (typeof baseWindow !== 'number' || typeof candWindow !== 'number') reasons.push('the idle CPU window length is missing on one side')
  if (!reasons.length) {
    windowDiffPercent = baseWindow > 0 ? Math.abs(candWindow - baseWindow) / baseWindow : null
    if (!(windowDiffPercent <= IDLE_WINDOW_TOLERANCE)) {
      reasons.push(`idle windows differ by ${windowDiffPercent === null ? 'n/a' : `${Math.round(windowDiffPercent * 1000) / 10}%`}, so the per-second figures are not comparable`)
    }
    ratio = basePerSecond > 0 ? Math.round((candPerSecond / basePerSecond) * 1000) / 1000 : null
    if (ratio === null) reasons.push('the baseline idle CPU is zero, so a ratio is undefined')
    else if (ratio > IDLE_CPU_RATIO_AT_MOST) reasons.push(`candidate idle CPU is ${ratio}× the baseline (limit ${IDLE_CPU_RATIO_AT_MOST}×)`)
  }
  return {
    met: reasons.length === 0,
    atMost: IDLE_CPU_RATIO_AT_MOST,
    ratio,
    windowMs: { baseline: baseWindow, candidate: candWindow },
    windowDiffPercent: windowDiffPercent === null ? null : Math.round(windowDiffPercent * 1000) / 1000,
    perSecondMs: { baseline: basePerSecond, candidate: candPerSecond },
    totalMs: { baseline: base?.totalMs ?? null, candidate: cand?.totalMs ?? null },
    unavailable: { baseline: base?.unavailable ?? null, candidate: cand?.unavailable ?? null },
    reasons
  }
}

/**
 * Playback: the candidate probe must say pass=true. `--playback` wins; without
 * it the paths the benchmark recorded in `meta.playback` are read, so a full run
 * does not need a third argument.
 */
function playbackVerdict() {
  const recorded = { baseline: baseline.meta?.playback?.path ?? null, candidate: candidate.meta?.playback?.path ?? null }
  const candidateFile = playbackPath ?? recorded.candidate
  const baselineFile = playbackPath ?? recorded.baseline
  const base = loadPlaybackEvidence(baselineFile)
  const cand = loadPlaybackEvidence(candidateFile)
  const gate = playbackGate(base, cand)
  if (!playbackPath && !recorded.candidate) {
    return { ...gate, met: false, reason: 'no playback evidence: pass --playback=<json> (candidate probe result)', source: 'none' }
  }
  return { ...gate, source: playbackPath ? '--playback' : 'meta.playback', recorded }
}

const baselineIdle = clusterOf(baseline, IDLE)
const candidateIdle = clusterOf(candidate, IDLE)
const baselineSettled = clusterOf(baseline, SETTLED)
const candidateSettled = clusterOf(candidate, SETTLED)

const scenariosMatch =
  JSON.stringify(baseline.meta?.measurement?.scenarios ?? baseline.meta?.scenarios ?? {}) ===
  JSON.stringify(candidate.meta?.measurement?.scenarios ?? candidate.meta?.scenarios ?? {})
const hostMatch = (baseline.meta?.host?.cores ?? 0) === (candidate.meta?.host?.cores ?? -1)
const sameBuild = Boolean(baseline.meta?.build?.entrySha256) && baseline.meta?.build?.entrySha256 === candidate.meta?.build?.entrySha256
const sameScript = !baseline.meta?.build?.scriptSha256 || !candidate.meta?.build?.scriptSha256 || baseline.meta.build.scriptSha256 === candidate.meta.build.scriptSha256
const comparable = Boolean(scenariosMatch && hostMatch && !sameBuild)

const reasons = []
if (!scenariosMatch) reasons.push('scenario parameters differ between the two runs')
if (!hostMatch) reasons.push('the two runs did not use the same machine shape')
if (sameBuild) reasons.push('both runs measured the same build, so there is nothing to compare')
if (!sameScript) reasons.push('the two runs were produced by different benchmark scripts, so the measurement rules differ')

const baselineMedian = baselineIdle.summary.p50
const candidateMedian = candidateIdle.summary.p50
const memoryPercent = percentDelta(baselineMedian, candidateMedian)
const memoryBytes = typeof baselineMedian === 'number' && typeof candidateMedian === 'number' ? candidateMedian - baselineMedian : null
const memoryUnavailable = (baselineIdle.unavailable ?? 0) + (candidateIdle.unavailable ?? 0)
const memoryMet =
  comparable && baselineIdle.count >= MIN_IDLE_SAMPLES && candidateIdle.count >= MIN_IDLE_SAMPLES && memoryUnavailable === 0 && memoryPercent !== null && memoryBytes !== null
    ? memoryPercent <= -15 && memoryBytes <= -30 * MiB
    : null

// Growth is read from one instance's own cycle series, first five cycles
// against the last five: a fresh instance's idle figure would charge the
// one-time cost of loading the settings page once to "accumulation", and the
// settled tree right after launch is inflated by startup caches.
function cycleTrend(run) {
  const series = (toggleOf(run).cycles ?? []).map((entry) => entry.privateResidentBytes).filter((value) => typeof value === 'number')
  if (series.length < 10) return null
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length
  const head = mean(series.slice(0, 5))
  const tail = mean(series.slice(-5))
  return growthPercent(Math.round(head), Math.round(tail))
}

const trend = cycleTrend(candidate)
const baselineTrend = cycleTrend(baseline)
const afterIdle = toggleOf(candidate).memory?.totals?.privateResidentBytes
const baselineAfterIdle = toggleOf(baseline).memory?.totals?.privateResidentBytes
const lastRenderers = toggleOf(candidate).memory?.processes?.filter((proc) => proc.role === 'renderer').length
const growthMet =
  trend === null || typeof afterIdle !== 'number' || typeof baselineAfterIdle !== 'number' || typeof lastRenderers !== 'number'
    ? null
    : trend <= 5 && afterIdle <= baselineAfterIdle && lastRenderers <= 1

/**
 * Open latency: the p95 may not grow by more than 100 ms, both sides need at
 * least MIN_OPEN_SAMPLES valid samples, and any failed sample fails the gate —
 * a timeout that was quietly dropped is exactly the kind of saving this
 * comparison must not reward.
 */
const openBaseline = baseline.firstOpen?.summary ?? {}
const openCandidate = candidate.firstOpen?.summary ?? {}
const openBaselineSamples = openSamplesOf(baseline)
const openCandidateSamples = openSamplesOf(candidate)
const openBaselineFailed = baseline.firstOpen?.failed?.length ?? 0
const openCandidateFailed = candidate.firstOpen?.failed?.length ?? 0
const openDelta = typeof openBaseline.p95 === 'number' && typeof openCandidate.p95 === 'number' ? Math.round((openCandidate.p95 - openBaseline.p95) * 1000) / 1000 : null
const openReasons = []
if (openDelta === null) openReasons.push('the first-open p95 is missing on one side')
else if (openDelta > 100) openReasons.push(`first-open p95 grew by ${openDelta} ms (limit 100 ms)`)
if (openBaselineSamples.length < MIN_OPEN_SAMPLES) openReasons.push(`the baseline has ${openBaselineSamples.length} valid first-open samples (minimum ${MIN_OPEN_SAMPLES})`)
if (openCandidateSamples.length < MIN_OPEN_SAMPLES) openReasons.push(`the candidate has ${openCandidateSamples.length} valid first-open samples (minimum ${MIN_OPEN_SAMPLES})`)
if (openBaselineFailed > 0) openReasons.push(`the baseline recorded ${openBaselineFailed} failed first-open sample(s)`)
if (openCandidateFailed > 0) openReasons.push(`the candidate recorded ${openCandidateFailed} failed first-open sample(s)`)
const openMet = comparable && openReasons.length === 0

function pillVerdict() {
  const base = baseline.pill
  const cand = candidate.pill
  if (!base || !cand) return { met: null, reason: 'the pill scenario was not measured on both sides' }
  const reused = (cand.distinctRenderers?.length ?? 0) >= 2
  const retired = (cand.retirements ?? 0) >= 1
  const repeated = (cand.takes ?? 0) >= 2
  // The baseline cannot run the staying self-test, so what it proves is the other
  // half: its startup renderer is still there after an idle period.
  const baselineKept = (base.retirements ?? 0) === 0 && (base.distinctRenderers?.length ?? 0) >= 1 && (survivors(lifecycleSeen(baseline))?.length ?? 0) >= 1
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
const isolation = { baseline: isolationOf(baseline), candidate: isolationOf(candidate) }
isolation.met = isolation.baseline.met && isolation.candidate.met
isolation.reason = isolation.met ? 'both runs left the Run key untouched and suppressed every login-item write' : [...isolation.baseline.reasons.map((entry) => `baseline: ${entry}`), ...isolation.candidate.reasons.map((entry) => `candidate: ${entry}`)].join('; ')

const cpuSelfCheck = { baseline: cpuSelfCheckOf(baseline), candidate: cpuSelfCheckOf(candidate) }
cpuSelfCheck.met = cpuSelfCheck.baseline.met && cpuSelfCheck.candidate.met
cpuSelfCheck.reason = cpuSelfCheck.met
  ? 'both sides passed the controlled busy-loop check'
  : [...cpuSelfCheck.baseline.reasons.map((entry) => `baseline: ${entry}`), ...cpuSelfCheck.candidate.reasons.map((entry) => `candidate: ${entry}`)].join('; ')

const separation = { baseline: separationOf(baseline), candidate: separationOf(candidate) }
separation.met = separation.baseline.met && separation.candidate.met
separation.reason = separation.met
  ? 'cold start and first open are separate measurements on both sides'
  : [...separation.baseline.reasons.map((entry) => `baseline: ${entry}`), ...separation.candidate.reasons.map((entry) => `candidate: ${entry}`)].join('; ')

const idleCpu = idleCpuGate()
const playback = playbackVerdict()

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
    samples: { baseline: openBaselineSamples.length, candidate: openCandidateSamples.length },
    minSamples: MIN_OPEN_SAMPLES,
    failed: { baseline: openBaselineFailed, candidate: openCandidateFailed },
    reasons: openReasons,
    met: openMet
  },
  reopenLatency: {
    metric: 'reopen p50/p95 (reported, not gated)',
    baseline: baseline.reopen?.summary ?? toggleOf(baseline).summary ?? null,
    candidate: candidate.reopen?.summary ?? toggleOf(candidate).summary ?? null,
    failed: { baseline: baseline.reopen?.failed?.length ?? null, candidate: candidate.reopen?.failed?.length ?? null }
  },
  isolation: {
    metric: 'Run key unchanged and every login-item write suppressed (read-only)',
    baseline: isolation.baseline,
    candidate: isolation.candidate,
    reason: isolation.reason,
    met: isolation.met
  },
  cpuSelfCheck: {
    metric: 'controlled busy-loop CPU check, |ratio-1| ≤ 0.35',
    baseline: cpuSelfCheck.baseline,
    candidate: cpuSelfCheck.candidate,
    reason: cpuSelfCheck.reason,
    met: cpuSelfCheck.met
  },
  coldSeparation: {
    metric: 'cold start reported separately from the first-open distribution',
    baseline: separation.baseline,
    candidate: separation.candidate,
    reason: separation.reason,
    met: separation.met
  },
  idleCpu: { metric: 'tray idle CPU per second over a comparable window', ...idleCpu },
  playbackFeature: {
    metric:
      'candidate playback probe passed every case, covered every required scenario with a real-window case, and recorded the build identity',
    ...playback,
    met: playback.met === true
  },
  pillRetired: pill
}

const decided = ['memory', 'noSustainedGrowth', 'openLatency', 'isolation', 'cpuSelfCheck', 'coldSeparation', 'idleCpu', 'playbackFeature', 'pillRetired']
const adopted = decided.every((name) => thresholds[name].met === true)
if (!adopted) {
  for (const name of decided) {
    const value = thresholds[name]
    if (value.met === true) continue
    const detail = value.reason ?? (Array.isArray(value.reasons) && value.reasons.length ? value.reasons.join('; ') : null)
    reasons.push(`${name}: ${value.met === null ? 'not measurable' : detail ? `threshold not met (${detail})` : 'threshold not met'}`)
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
      'cpu: user+kernel delta over an explicit window with window length and cores, plus a controlled self-check',
      'latency: cold tree ready, cold pill ready, first open and reopen, kept apart',
      'isolation: the Run key read before and after, read-only, with the suppressed login-item writes counted',
      'playback: the candidate renderer probe verdict, case by case, with the required scenarios, real-window classification, and build identity'
    ],
    excluded: ['no Vite dev server, no DevTools, no HMR', 'no user profile, no user microphone, no packaged installer', 'no EmptyWorkingSet or manual trimming', 'no forced GC', 'no repair or rewrite of the user Run key']
  },
  inputs: { baseline: baselinePath, candidate: candidatePath, playback: playback.source === 'none' ? null : playbackPath ?? playback.recorded?.candidate ?? null },
  environment: {
    host: { baseline: baseline.meta?.host ?? null, candidate: candidate.meta?.host ?? null },
    node: { baseline: baseline.meta?.node ?? null, candidate: candidate.meta?.node ?? null },
    electron: { baseline: baseline.meta?.electron ?? null, candidate: candidate.meta?.electron ?? null },
    appRoot: { baseline: baseline.meta?.appRoot ?? null, candidate: candidate.meta?.appRoot ?? null }
  },
  build: { baseline: baseline.meta?.build ?? null, candidate: candidate.meta?.build ?? null },
  comparable,
  measurement: { baseline: baseline.meta?.measurement ?? null, candidate: candidate.meta?.measurement ?? null },
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
    openSamples: numbers(openBaselineSamples),
    openFailed: baseline.firstOpen?.failed ?? [],
    cold: baseline.cold ?? [],
    reopenSamples: numbers(reopenSamplesOf(baseline)),
    toggleCycles: (toggleOf(baseline).cycles ?? []).map((cycle) => ({ cycle: cycle.cycle, privateResidentBytes: cycle.privateResidentBytes ?? null, renderers: cycle.renderers ?? null })),
    open: openBaseline,
    reopen: baseline.reopen?.summary ?? toggleOf(baseline).summary ?? null,
    afterToggles: toggleOf(baseline).memory?.totals ?? null,
    idleCpu: baseline.trayIdle?.cpu ?? null,
    lifecycle: lifecycleSeen(baseline),
    pill: baseline.pill ?? null,
    isolation: isolation.baseline,
    cpuSelfCheck: cpuSelfCheck.baseline
  },
  candidate: {
    idle: candidateIdle,
    settled: candidateSettled,
    groups: candidateIdle.byRole,
    idleSamples: phaseTotals(candidate, IDLE),
    settledSamples: phaseTotals(candidate, SETTLED),
    openSamples: numbers(openCandidateSamples),
    openFailed: candidate.firstOpen?.failed ?? [],
    cold: candidate.cold ?? [],
    reopenSamples: numbers(reopenSamplesOf(candidate)),
    toggleCycles: (toggleOf(candidate).cycles ?? []).map((cycle) => ({ cycle: cycle.cycle, privateResidentBytes: cycle.privateResidentBytes ?? null, renderers: cycle.renderers ?? null })),
    open: openCandidate,
    reopen: candidate.reopen?.summary ?? toggleOf(candidate).summary ?? null,
    afterToggles: toggleOf(candidate).memory?.totals ?? null,
    idleCpu: candidate.trayIdle?.cpu ?? null,
    lifecycle: lifecycleSeen(candidate),
    pill: candidate.pill ?? null,
    isolation: isolation.candidate,
    cpuSelfCheck: cpuSelfCheck.candidate
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
      deltaMs: openDelta,
      samples: { baseline: openBaselineSamples.length, candidate: openCandidateSamples.length },
      failed: { baseline: openBaselineFailed, candidate: openCandidateFailed }
    },
    coldToOpen: {
      baseline: { treeReadyMs: baseline.cold?.[0]?.spawnToTreeReadyMs ?? null, pillReadyMs: baseline.cold?.[0]?.spawnToPillReadyMs ?? null },
      candidate: { treeReadyMs: candidate.cold?.[0]?.spawnToTreeReadyMs ?? null, pillReadyMs: candidate.cold?.[0]?.spawnToPillReadyMs ?? null }
    },
    reopen: { baseline: baseline.reopen?.summary ?? toggleOf(baseline).summary ?? null, candidate: candidate.reopen?.summary ?? toggleOf(candidate).summary ?? null },
    togglesTrendPercent: trend,
    baselineTogglesTrendPercent: baselineTrend,
    idleCpuMs: { baseline: baseline.trayIdle?.cpu?.totalMs ?? null, candidate: candidate.trayIdle?.cpu?.totalMs ?? null },
    idleCpuPerSecond: { baseline: baseline.trayIdle?.cpu?.perSecond ?? null, candidate: candidate.trayIdle?.cpu?.perSecond ?? null },
    pill: {
      baseline: baseline.pill ?? null,
      candidate: candidate.pill ?? null
    },
    rendererLifecycle: {
      stages: { baseline: lifecycleSeen(baseline).length, candidate: lifecycleSeen(candidate).length },
      baselineStartupSurvivors: survivors(lifecycleSeen(baseline)),
      candidateStartupSurvivors: survivors(lifecycleSeen(candidate))
    },
    playback: { candidate: playback.candidate, baseline: playback.baseline, caseVerdicts: playback.candidate.cases }
  },
  thresholds,
  decision: adopted ? 'adopted' : 'not-adopted',
  reasons
}

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`)

const mib = (bytes) => (typeof bytes === 'number' ? `${(bytes / MiB).toFixed(1)} MiB` : 'n/a')
console.log(`[compare] idle median ${mib(baselineMedian)} → ${mib(candidateMedian)} (${memoryPercent ?? 'n/a'}%)`)
console.log(`[compare] open p95 ${openBaseline.p95 ?? 'n/a'} → ${openCandidate.p95 ?? 'n/a'} ms (${openDelta ?? 'n/a'}), samples ${openBaselineSamples.length}/${openCandidateSamples.length}, failed ${openBaselineFailed}/${openCandidateFailed}`)
console.log(`[compare] idle cpu/s ${baseline.trayIdle?.cpu?.perSecond ?? 'n/a'} → ${candidate.trayIdle?.cpu?.perSecond ?? 'n/a'} (ratio ${idleCpu.ratio ?? 'n/a'})`)
console.log(`[compare] isolation ${isolation.met ? 'met' : 'not met'}, cpu self-check ${cpuSelfCheck.met ? 'met' : 'not met'}, playback ${thresholds.playbackFeature.met ? 'met' : 'not met'}`)
console.log(`[compare] decision ${evidence.decision}${reasons.length ? ` — ${reasons.join('; ')}` : ''}`)
console.log(`[compare] evidence ${output}`)
if (!adopted) process.exitCode = 1
