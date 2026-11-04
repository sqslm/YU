#!/usr/bin/env node
/**
 * Merges the baseline and candidate runs of `benchmark-electron-app.mjs` into
 * one evidence file and applies the adoption thresholds.
 *
 *   node scripts/compare-app-resources.mjs \
 *     --baseline /tmp/app-baseline.json --candidate /tmp/app-candidate.json \
 *     --output tests/yu-v2/evidence/electron-whole-app-resources-20261104.json
 *
 * Nothing is averaged across scenarios: the tray-idle median decides the memory
 * threshold, the open-latency P95 decides whether the change is allowed to stay,
 * and the toggle runs decide whether the saving holds after repeated use.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const args = process.argv.slice(2)
function option(name, fallback) {
  const prefix = `--${name}=`
  const inline = args.find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = args.indexOf(`--${name}`)
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) return args[index + 1]
  return fallback
}

const baselinePath = option('baseline')
const candidatePath = option('candidate')
const output = option('output', 'tests/yu-v2/evidence/electron-whole-app-resources-20261104.json')
if (!baselinePath || !candidatePath) throw new Error('--baseline and --candidate are required')

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
// The lifecycle block was added to the harness after the baseline run, so the
// baseline's pill observation comes from a separate short run of the same build.
const baselineLifecyclePath = option('baseline-lifecycle')
if (!baseline.lifecycle) {
  if (!baselineLifecyclePath) throw new Error('the baseline run has no lifecycle block; pass --baseline-lifecycle from a --skip-cold run')
  baseline.lifecycle = JSON.parse(readFileSync(baselineLifecyclePath, 'utf8')).lifecycle
}
const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'))

const MiB = 1048576
const median = (values) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * 0.5) - 1]
}
const p95 = (values) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * 0.95) - 1]
}
const pct = (from, to) => (from > 0 ? Math.round(((to - from) / from) * 10_000) / 100 : null)

function idleTotals(run) {
  const samples = [...run.trayIdle.samples, ...run.trayIdle.last ? [run.trayIdle.last] : []]
  return samples.map((sample) => sample.totals.privateResidentBytes)
}

/**
 * The role labels stored by the sampler are recomputed here from the recorded
 * process names, so both sides of the comparison use one classifier (the first
 * baseline run predates the helper name pattern and filed helpers under `other`).
 */
function classify(name) {
  if (/^(?:typeless|yu)-(?:hotkey|uia|wake|speech|local-asr|windows)\.exe$/i.test(name)) return 'helper'
  if (name.toLowerCase() === 'electron.exe') return 'electron'
  if (name.toLowerCase() === 'conhost.exe') return 'conhost'
  return 'other'
}
function groupsOf(sample) {
  const groups = {}
  for (const proc of sample.processes ?? []) {
    const role = proc.category ?? classify(proc.name)
    const bucket = (groups[role] ??= { privateResidentBytes: 0, workingSetBytes: 0, committedBytes: 0, count: 0 })
    bucket.privateResidentBytes += proc.privateResidentBytes ?? 0
    bucket.workingSetBytes += proc.workingSetBytes ?? 0
    bucket.committedBytes += proc.committedBytes ?? 0
    bucket.count += 1
  }
  return groups
}
function groupOf(sample, roles) {
  let sum = 0
  for (const [role, bucket] of Object.entries(groupsOf(sample))) {
    if (roles.includes(role)) sum += bucket.privateResidentBytes
  }
  return sum
}

const baselineIdle = idleTotals(baseline)
const candidateIdle = idleTotals(candidate)
const baselineIdleMedian = median(baselineIdle)
const candidateIdleMedian = median(candidateIdle)
const idleDeltaBytes = candidateIdleMedian - baselineIdleMedian
const idlePct = pct(baselineIdleMedian, candidateIdleMedian)

const baselineToggles = median([baseline.toggles.memory.totals.privateResidentBytes])
const candidateToggles = median([candidate.toggles.memory.totals.privateResidentBytes])
const growth = candidateIdleMedian > 0 ? Math.round(((candidateToggles - candidateIdleMedian) / candidateIdleMedian) * 10_000) / 100 : null

const openP95 = { baseline: p95(baseline.firstOpen.samples), candidate: p95(candidate.firstOpen.samples) }
const openP95DeltaMs = openP95.baseline !== null ? Math.round((openP95.candidate - openP95.baseline) * 1000) / 1000 : null

const cpuIdle = {
  baseline: baseline.trayIdle.cpu.totalMs,
  candidate: candidate.trayIdle.cpu.totalMs,
  windowMs: { baseline: baseline.trayIdle.cpu.windowMs, candidate: candidate.trayIdle.cpu.windowMs },
  cores: baseline.trayIdle.cpu.cores
}

function lifecycleVerdict(run) {
  const at = (point) => new Set((run.find((entry) => entry.at === point)?.renderers) ?? [])
  const startup = at('startup')
  const open = at('hub-open')
  const after = at('after-hide-idle')
  return {
    startup: [...startup].sort((a, b) => a - b),
    hubOpen: [...open].sort((a, b) => a - b),
    afterHideIdle: [...after].sort((a, b) => a - b),
    startupSurvivorsAfterIdle: [...startup].filter((pid) => after.has(pid)).sort((a, b) => a - b),
    hubSurvivorsAfterIdle: [...open].filter((pid) => after.has(pid) && !startup.has(pid)).sort((a, b) => a - b),
  }
}

const baselineLifecycle = lifecycleVerdict(baseline.lifecycle)
const candidateLifecycle = lifecycleVerdict(candidate.lifecycle)

const thresholds = {
  memory: { percentAtMost: -15, bytesAtMost: -30 * MiB, met: false },
  noSustainedGrowth: { met: growth === null ? null : growth <= 5, observedPctVsIdle: growth },
  openLatency: { p95RegressionMsAtMost: 100, met: openP95DeltaMs === null ? null : openP95DeltaMs <= 100, observedMs: openP95DeltaMs },
  pillRetired: {
    met: candidateLifecycle.startupSurvivorsAfterIdle.length === 0,
    detail: 'the renderer started with the app (the pill) must be gone once the hub has been closed and the app idles; the hub renderer is expected to go too, which it already did before this change'
  }
}
thresholds.memory.met = idlePct !== null && idlePct <= thresholds.memory.percentAtMost && idleDeltaBytes <= thresholds.memory.bytesAtMost

const adoption = thresholds.memory.met && thresholds.noSustainedGrowth.met === true && thresholds.openLatency.met === true && thresholds.pillRetired.met

const evidence = {
  kind: 'electron-whole-app-resources',
  version: 1,
  generatedAt: new Date().toISOString(),
  scope: {
    included: ['cold start', 'first hub open', 'hub closed to tray, 60 s idle', 'twenty hub toggles then 60 s idle', 'pill window lifecycle'],
    excluded: [
      'real microphone capture (the sandbox cannot record audio)',
      'tray menu interaction, global hotkey chords (they collide with the running user instance)',
      'wake word, local ASR model, chat, notes content',
      'dev server / DevTools / heap snapshot runs (deliberately not part of the measured path)'
    ]
  },
  environment: {
    host: baseline.meta.host,
    node: baseline.meta.node,
    electron: baseline.meta.electron,
    build: baseline.meta.build,
    profile: baseline.meta.profile,
    scenarios: baseline.meta.scenarios,
    measurement: baseline.meta.measurement,
    settings: 'empty isolated profile; the harness writes no settings and imports no user data'
  },
  attribution: {
    hypothesis: 'The pill (bar) renderer is created at startup and never destroyed, although it is only visible while a take runs; it also pulls in a spare utility process and inflates the main and GPU processes.',
    change: 'Create the pill window on demand and destroy it once it has been hidden for 30 s (src/main/bar-retire.ts + the pipeline bar sink), leaving every reveal path to recreate it through ensureBarWindow().',
    files: ['src/main/index.ts', 'src/main/bar-retire.ts', 'src/main/bar-retire.test.ts']
  },
  baseline: {
    trayIdlePrivateResidentBytes: { samples: baselineIdle, median: baselineIdleMedian },
    groups: groupsOf(baseline.trayIdle.last),
    togglesPrivateResidentBytes: baselineToggles,
    firstOpenMs: baseline.firstOpen,
    reopenMs: baseline.toggles.summary,
    idleCpu: cpuIdle.baseline,
    lifecycle: baseline.lifecycle
  },
  candidate: {
    trayIdlePrivateResidentBytes: { samples: candidateIdle, median: candidateIdleMedian },
    groups: groupsOf(candidate.trayIdle.last),
    togglesPrivateResidentBytes: candidateToggles,
    firstOpenMs: candidate.firstOpen,
    reopenMs: candidate.toggles.summary,
    idleCpu: cpuIdle.candidate,
    lifecycle: candidate.lifecycle
  },
  comparison: {
    trayIdlePrivateResident: {
      baselineMedianBytes: baselineIdleMedian,
      candidateMedianBytes: candidateIdleMedian,
      deltaBytes: idleDeltaBytes,
      deltaMiB: Math.round((idleDeltaBytes / MiB) * 10) / 10,
      deltaPct: idlePct,
      byGroupMiB: Object.fromEntries(
        Object.keys({ ...groupsOf(baseline.trayIdle.last), ...groupsOf(candidate.trayIdle.last) }).map((role) => [
          role,
          {
            baseline: Math.round((groupOf(baseline.trayIdle.last, [role]) / MiB) * 10) / 10,
            candidate: Math.round((groupOf(candidate.trayIdle.last, [role]) / MiB) * 10) / 10,
            helperPids: (baseline.trayIdle.last.processes ?? []).filter((proc) => (proc.category ?? classify(proc.name)) === role).map((proc) => proc.name)
          }
        ])
      )
    },
    toggleGrowth: { baselineBytes: baselineToggles, candidateBytes: candidateToggles, candidatePctVsIdle: growth },
    openLatency: { baselineP95Ms: openP95.baseline, candidateP95Ms: openP95.candidate, p95DeltaMs: openP95DeltaMs, comparable: true, reason: 'same harness, same isolated profile, same build mode on one machine' },
    idleCpu: cpuIdle,
    rendererLifecycle: {
      baseline: baselineLifecycle,
      candidate: candidateLifecycle,
      note: 'compared by PID identity, not by renderer count: the hub renderer was already destroyed fifteen seconds after hiding before this change, so a count alone cannot tell which renderer survived'
    }
  },
  thresholds,
  decision: adoption ? 'adopted' : 'not-adopted',
  reasons: [
    `tray-idle private resident ${idlePct}% / ${Math.round((idleDeltaBytes / MiB) * 10) / 10} MiB (needs <= -15% and <= -30 MiB)`,
    `growth after twenty toggles ${growth}% (needs <= 5%)`,
    `hub open P95 ${openP95DeltaMs} ms (needs <= +100 ms)`,
    `pill renderer retired after idle: ${thresholds.pillRetired.met ? 'yes' : 'no'} (startup renderers still alive: ${candidateLifecycle.startupSurvivorsAfterIdle.join(', ') || 'none'})`,
    'microphone, tray menu and global-chord flows are listed as untested rather than covered'
  ]
}

mkdirSync(dirname(resolve(output)), { recursive: true })
writeFileSync(resolve(output), `${JSON.stringify(evidence, null, 2)}\n`)
console.log(`[compare] decision ${evidence.decision}: ${evidence.reasons[0]}; ${evidence.reasons[1]}; ${evidence.reasons[2]}`)
console.log(`[compare] evidence ${resolve(output)}`)
process.exit(adoption ? 0 : 1)
