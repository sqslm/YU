/**
 * End-to-end regressions for the adoption decision itself.
 *
 * The unit tests in `lib/playback.test.mjs` cover the playback gate's clauses;
 * these run the real CLI and assert on the *decision*, because the two defects
 * behind them both let a local per-threshold check pass and still adopted:
 *
 *   - the playback probe named a build nobody compared it against, so a probe
 *     whose `identity.entrySha256` was rewritten still counted as evidence;
 *   - a benchmark-script mismatch was only appended to `reasons` as prose, so
 *     `comparable` stayed true and `adopted` followed.
 *
 * A decision is only trustworthy when the comparison is comparable *and* every
 * threshold is met, so both are asserted from the JSON the CLI writes.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

import { REQUIRED_PLAYBACK_SCENARIOS } from './lib/playback.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'compare-app-resources.mjs')
const dir = mkdtempSync(join(tmpdir(), 'typeless-compare-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const MiB = 1048576
const sha = (seed) => seed.repeat(64).slice(0, 64)

const BASELINE_ENTRY = sha('5')
const CANDIDATE_ENTRY = sha('2')
const SCRIPT_SHA = sha('3')
const OTHER_SCRIPT_SHA = sha('9')
const WRAPPER_SHA = sha('d')

function openSamples(count, p95) {
  return Array.from({ length: count }, (_, index) => ({ latencyMs: p95 - 40 + (index % 5) }))
}

function cycles(count, bytes) {
  return Array.from({ length: count }, (_, index) => ({ cycle: index + 1, privateResidentBytes: bytes, renderers: 1 }))
}

/** A run that satisfies every threshold on its own; only identity is varied. */
function run({ entrySha256, scriptSha256, idleMedianBytes, openP95Ms, pill, lifecycle }) {
  return {
    meta: {
      build: {
        entry: 'out/main/index.js',
        entrySha256,
        wrapperSha256: WRAPPER_SHA,
        script: 'scripts/benchmark-electron-app.mjs',
        scriptSha256,
        rev: null,
        dirty: null,
        source: 'HEAD',
        assets: []
      },
      host: { cores: 16, platform: 'win32', totalBytes: 64 * 1024 * MiB },
      measurement: {
        scenarios: { idleMs: 60000, firstOpen: 20, reopen: 10 },
        cpuSelfCheck: { pass: true, ratio: 1.01, windowMs: 2000, measuredMs: 2000, cores: 16 }
      },
      isolation: {
        valid: true,
        runKey: { unchanged: true, keyPath: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', diff: { added: [], removed: [], changed: [] } },
        markerCount: 2
      }
    },
    trayIdle: {
      clusters: {
        'idle-60s': { count: 3, summary: { p50: idleMedianBytes, p95: idleMedianBytes }, unavailable: 0, byRole: {}, last: null },
        'settled-4s': { count: 3, summary: { p50: idleMedianBytes, p95: idleMedianBytes }, unavailable: 0, byRole: {}, last: null }
      },
      samples: [],
      cpu: { perSecond: 0.5, windowMs: 60000, totalMs: 30000, unavailable: 0 }
    },
    cold: [{ spawnToTreeReadyMs: 900, spawnToPillReadyMs: 1200 }],
    firstOpen: {
      valid: openSamples(20, openP95Ms),
      coldIncluded: false,
      summary: { count: 20, p50: openP95Ms, p95: openP95Ms },
      failed: []
    },
    toggle: {
      cycles: cycles(12, 300 * MiB),
      memory: { totals: { privateResidentBytes: 300 * MiB }, processes: [{ role: 'renderer' }] }
    },
    reopen: { samples: [{ latencyMs: 120 }], summary: { p50: 120, p95: 130 } },
    pill,
    lifecycle
  }
}

/** The lifecycle probe reads `startup` and `after-hide-idle`, so both are needed. */
const BASELINE_LIFECYCLE = [
  { at: 'startup', renderers: [10, 11] },
  { at: 'after-toggles', renderers: [10, 11] },
  { at: 'after-hide-idle', renderers: [10] }
]

function baselineFixture() {
  return run({
    entrySha256: BASELINE_ENTRY,
    scriptSha256: SCRIPT_SHA,
    idleMedianBytes: 400 * MiB,
    openP95Ms: 800,
    pill: { retirements: 0, distinctRenderers: ['baseline-renderer'], takes: 1 },
    lifecycle: BASELINE_LIFECYCLE
  })
}

function candidateFixture() {
  return run({
    entrySha256: CANDIDATE_ENTRY,
    scriptSha256: SCRIPT_SHA,
    idleMedianBytes: 300 * MiB,
    openP95Ms: 850,
    pill: { retirements: 1, distinctRenderers: ['first-take', 'second-take'], takes: 2 },
    lifecycle: BASELINE_LIFECYCLE
  })
}

/** A probe pass that covers every required scenario on a real window. */
function probeFor(entrySha256 = CANDIDATE_ENTRY) {
  return {
    pass: true,
    cases: REQUIRED_PLAYBACK_SCENARIOS.map((scenario) => ({
      id: scenario.id,
      kind: 'real-window',
      pass: true,
      detail: `${scenario.id} observed`
    })),
    identity: {
      entrySha256,
      preloadSha256: sha('b'),
      barHtmlSha256: sha('c'),
      sourceRef: 'HEAD 597fb25da9386313deddf49d26f8e574c02dda94 (dirty)',
      command: 'pnpm exec vitest run src/main/bar-playback.probe.test.ts'
    }
  }
}

let counter = 0
function write(name, body) {
  const file = join(dir, `${counter++}-${name}.json`)
  writeFileSync(file, JSON.stringify(body, null, 2), 'utf8')
  return file
}

/** Run the real CLI; the exit code is part of the contract, not just the JSON. */
function compare({ baseline = baselineFixture(), candidate = candidateFixture(), probe = probeFor(), playback = true } = {}) {
  const output = join(dir, `out-${counter++}.json`)
  const args = [SCRIPT, `--baseline=${write('baseline', baseline)}`, `--candidate=${write('candidate', candidate)}`, `--output=${output}`]
  if (playback === true) args.push(`--playback=${write('probe', probe)}`)
  else if (playback) args.push(`--playback=${playback}`)
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' })
  const evidence = result.status === 0 || result.status === 1 ? JSON.parse(readFileSync(output, 'utf8')) : null
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, evidence }
}

describe('the comparison adopts a consistent pair', () => {
  it('adopts when the identities agree, every threshold is met and the playback evidence is bound', () => {
    const { status, evidence, stderr } = compare()
    expect(stderr).toBe('')
    expect(evidence.comparable).toBe(true)
    expect(evidence.decision).toBe('adopted')
    expect(evidence.reasons).toEqual([])
    expect(evidence.thresholds.playbackFeature.met).toBe(true)
    expect(status).toBe(0)
  })
})

describe('R3: the benchmark script identity is a necessary condition', () => {
  it('refuses to adopt when only the script digest differs', () => {
    const candidate = candidateFixture()
    candidate.meta.build.scriptSha256 = OTHER_SCRIPT_SHA
    const { status, evidence } = compare({ candidate })

    expect(evidence.comparable).toBe(false)
    expect(evidence.comparability.sameScript).toBe(false)
    expect(evidence.decision).toBe('not-adopted')
    expect(status).not.toBe(0)
    expect(evidence.reasons.join('; ')).toContain('the two runs were produced by different benchmark scripts, so the measurement rules differ')
  })

  it('refuses to adopt when the script identity is missing on one side', () => {
    const candidate = candidateFixture()
    delete candidate.meta.build.scriptSha256
    const { status, evidence } = compare({ candidate })

    expect(evidence.comparability.scriptIdentityKnown).toBe(false)
    expect(evidence.comparable).toBe(false)
    expect(evidence.decision).toBe('not-adopted')
    expect(status).not.toBe(0)
    expect(evidence.reasons.join('; ')).toContain('candidate scriptSha256 absent')
  })

  it('refuses to adopt when the script identity is malformed', () => {
    const candidate = candidateFixture()
    candidate.meta.build.scriptSha256 = 'not-a-digest'
    const { status, evidence } = compare({ candidate })

    expect(evidence.comparability.scriptIdentityKnown).toBe(false)
    expect(evidence.comparable).toBe(false)
    expect(evidence.decision).toBe('not-adopted')
    expect(status).not.toBe(0)
  })

  it('keeps refusing a pair that measured the same build', () => {
    const candidate = candidateFixture()
    candidate.meta.build.entrySha256 = BASELINE_ENTRY
    const { status, evidence } = compare({ candidate })

    expect(evidence.comparability.sameBuild).toBe(true)
    expect(evidence.comparable).toBe(false)
    expect(evidence.decision).toBe('not-adopted')
    expect(status).not.toBe(0)
  })

  it('keeps refusing a pair measured with different scenario parameters', () => {
    const candidate = candidateFixture()
    candidate.meta.measurement.scenarios = { idleMs: 30000, firstOpen: 20, reopen: 10 }
    const { status, evidence } = compare({ candidate })

    expect(evidence.comparability.scenariosMatch).toBe(false)
    expect(evidence.comparable).toBe(false)
    expect(evidence.decision).toBe('not-adopted')
    expect(status).not.toBe(0)
  })

  it('keeps refusing a pair measured on a different machine shape', () => {
    const candidate = candidateFixture()
    candidate.meta.host.cores = 24
    const { status, evidence } = compare({ candidate })

    expect(evidence.comparability.sameHost).toBe(false)
    expect(evidence.comparable).toBe(false)
    expect(evidence.decision).toBe('not-adopted')
    expect(status).not.toBe(0)
  })
})

describe('R2: the playback evidence is bound to the measured build', () => {
  it('refuses the reproduced probe whose entry digest was rewritten to 64 f', () => {
    // This is the external reproduction: nothing changes but the probe's own
    // `identity.entrySha256`, which the old gate never compared to the run.
    const { status, evidence } = compare({ probe: probeFor('f'.repeat(64)) })

    expect(evidence.thresholds.playbackFeature.met).toBe(false)
    expect(evidence.thresholds.playbackFeature.binding.met).toBe(false)
    expect(evidence.decision).toBe('not-adopted')
    expect(status).not.toBe(0)
    const playbackReasons = evidence.thresholds.playbackFeature.reasons.join('; ')
    expect(playbackReasons).toContain(`playback identity.entrySha256 ${'f'.repeat(12)} does not match the measured build entrySha256 ${CANDIDATE_ENTRY.slice(0, 12)}`)
  })

  it('refuses a probe whose identity block is missing', () => {
    const probe = probeFor()
    delete probe.identity
    const { status, evidence } = compare({ probe })

    expect(evidence.thresholds.playbackFeature.met).toBe(false)
    expect(evidence.decision).toBe('not-adopted')
    expect(status).not.toBe(0)
  })

  it('refuses a probe that dropped a required scenario', () => {
    const probe = probeFor()
    probe.cases = probe.cases.filter((entry) => entry.id !== 'r1-stop-cancels-waiting-control')
    const { status, evidence } = compare({ probe })

    expect(evidence.thresholds.playbackFeature.met).toBe(false)
    expect(evidence.decision).toBe('not-adopted')
    expect(status).not.toBe(0)
    expect(evidence.thresholds.playbackFeature.reasons.join('; ')).toContain('r1-stop-cancels-waiting-control')
  })

  it('records the preload/bar.html limitation instead of inventing a digest', () => {
    const { evidence } = compare()
    const binding = evidence.thresholds.playbackFeature.binding
    expect(binding.checked).toEqual(['entrySha256'])
    expect(binding.limitations.join(' ')).toContain('preloadSha256 and barHtmlSha256 are not recorded in the candidate resource sample')
  })
})
