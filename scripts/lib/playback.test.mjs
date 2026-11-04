import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  PLAYBACK_CASE_KINDS,
  REQUIRED_PLAYBACK_SCENARIOS,
  loadPlaybackEvidence,
  playbackBindingProblems,
  playbackGate,
  playbackIdentityProblems
} from './playback.mjs'

const dir = mkdtempSync(join(tmpdir(), 'typeless-playback-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function fileOf(name, body) {
  const file = join(dir, name)
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  return file
}

const sha = (seed) => seed.repeat(64).slice(0, 64)

const identity = {
  entrySha256: sha('a'),
  preloadSha256: sha('b'),
  barHtmlSha256: sha('c'),
  sourceRef: 'HEAD c8a6a5a79ca699128701d8524490583ebffc9e7c',
  command: 'pnpm exec vitest run src/main/bar-playback.probe.test.ts'
}

/**
 * The measured build, shaped like phase 20's `meta.build`: an entry digest plus
 * the wrapper and script digests, and *no* preload/bar.html digest — the
 * sample never recorded those two, so they may only ever be a limitation.
 */
const build = {
  entry: 'out/main/index.js',
  entrySha256: identity.entrySha256,
  wrapperSha256: sha('d'),
  scriptSha256: sha('e')
}

const requiredIds = REQUIRED_PLAYBACK_SCENARIOS.map((scenario) => scenario.id)

function realWindowCases(overrides = {}) {
  return requiredIds.map((id) => ({ id, kind: 'real-window', pass: true, detail: `${id} observed`, ...(overrides[id] ?? {}) }))
}

function probe(caseList, extra = {}) {
  return { pass: true, cases: caseList, identity, ...extra }
}

/** A file that satisfies every clause of the gate. */
function passingProbe(extra = {}) {
  return probe([...realWindowCases(), { id: 'r1-stub-reply-order', kind: 'stub', pass: true }], extra)
}

function loadAndGate(body, name = `probe-${Math.random().toString(36).slice(2)}.json`, buildRecord = build) {
  const candidate = loadPlaybackEvidence(fileOf(name, body))
  const baseline = loadPlaybackEvidence(fileOf(`${name}.baseline`, passingProbe()))
  return { candidate, gate: playbackGate(baseline, candidate, buildRecord) }
}

describe('loadPlaybackEvidence', () => {
  it('reads a passing probe and keeps the legacy fields', () => {
    const loaded = loadPlaybackEvidence(fileOf('pass.json', passingProbe()))
    expect(loaded.ok).toBe(true)
    expect(loaded.pass).toBe(true)
    expect(loaded.caseCount).toBe(requiredIds.length + 1)
    expect(loaded.cases.map((entry) => entry.id)).toEqual([...requiredIds, 'r1-stub-reply-order'])
    expect(loaded.cases[0]).toMatchObject({ kind: 'real-window', pass: true, skipped: false })
    expect(loaded.identity).toEqual(identity)
  })

  it('reads the legacy `results` array and the legacy name/ok case shape', () => {
    const loaded = loadPlaybackEvidence(
      fileOf('legacy-results.json', { pass: true, results: [{ name: 'cold-play', ok: true }, { name: 'natural-end', ok: true }] })
    )
    expect(loaded.ok).toBe(true)
    expect(loaded.caseCount).toBe(2)
    expect(loaded.cases[0]).toMatchObject({ id: 'cold-play', name: 'cold-play', kind: null, pass: true })
  })

  it('reports a missing file, bad JSON, a missing cases array and a missing pass field', () => {
    expect(loadPlaybackEvidence(join(dir, 'nope.json')).ok).toBe(false)
    expect(loadPlaybackEvidence(join(dir, 'nope.json')).error).toContain('could not be read')
    expect(loadPlaybackEvidence(fileOf('bad.json', '{oops')).error).toContain('not valid JSON')
    expect(loadPlaybackEvidence(fileOf('nocases.json', { pass: true })).error).toContain('no cases array')
    expect(loadPlaybackEvidence(fileOf('nopass.json', { cases: [] })).error).toContain('no boolean pass field')
    expect(loadPlaybackEvidence(null).error).toContain('no playback evidence')
  })

  it('reads identity from `build` or the top level as well as `identity`', () => {
    const underBuild = loadPlaybackEvidence(fileOf('build.json', { pass: true, cases: realWindowCases(), build: identity }))
    expect(underBuild.identity).toEqual(identity)
    const flat = loadPlaybackEvidence(fileOf('flat.json', { pass: true, cases: realWindowCases(), ...identity }))
    expect(flat.identity).toEqual(identity)
  })
})

describe('playbackGate acceptance', () => {
  it('passes only with every required scenario on a real window, no failures, and a full identity', () => {
    const { gate } = loadAndGate(passingProbe(), 'accept.json')
    expect(gate.reasons).toEqual([])
    expect(gate.met).toBe(true)
    expect(gate.candidate.caseCount).toBe(requiredIds.length + 1)
    expect(gate.coverage.missingScenarios).toEqual([])
    expect(gate.coverage.stub).toEqual(['r1-stub-reply-order'])
    expect(gate.identity).toEqual(identity)
    expect(PLAYBACK_CASE_KINDS).toEqual(['real-window', 'stub'])
  })
})

describe('playbackGate rejections', () => {
  it('rejects the reproduced empty evidence: {pass:true, cases:[]}', () => {
    const { candidate, gate } = loadAndGate({ pass: true, cases: [] }, 'empty.json')
    expect(candidate.caseCount).toBe(0)
    expect(gate.met).toBe(false)
    expect(gate.reasons.join('; ')).toContain('contains no cases')
    expect(gate.reasons.join('; ')).toContain('no passing real-window case')
  })

  it('rejects evidence with no cases array at all', () => {
    const { gate } = loadAndGate({ pass: true }, 'nocases.json')
    expect(gate.met).toBe(false)
    expect(gate.reasons.join('; ')).toContain('no cases array')
  })

  it('rejects the legacy ten-case format that has no kind and no phase-20 scenario', () => {
    const legacyNames = [
      'cold-play',
      'natural-end',
      'ready-window-play',
      'pause-resume',
      'seek-and-rate',
      'recreate-after-destroy',
      'long-pause-holds-busy',
      'unknown-duration-busy',
      'stale-event-ignored',
      'status-without-window'
    ]
    const { gate } = loadAndGate(
      { pass: true, cases: legacyNames.map((name) => ({ name, ok: true })) },
      'legacy-ten.json'
    )
    expect(gate.met).toBe(false)
    const reason = gate.reasons.join('; ')
    expect(reason).toContain('have no valid kind')
    expect(reason).toContain('no passing real-window case')
    expect(reason).toContain('required playback scenario(s) have no passing real-window case')
    expect(reason).toContain('build identity is incomplete')
    expect(gate.coverage.unclassified).toHaveLength(10)
    expect(gate.coverage.missingScenarios).toEqual(requiredIds)
  })

  it('rejects a case that failed and names it with its reason', () => {
    const { gate } = loadAndGate(
      probe(realWindowCases({ 'r1-playback-replacement': { pass: false, reason: 'sent new then old' } })),
      'failed-case.json'
    )
    expect(gate.met).toBe(false)
    expect(gate.reasons.join('; ')).toContain('1 playback case(s) did not pass: r1-playback-replacement (sent new then old)')
  })

  it('rejects a skipped case and surfaces its skipReason', () => {
    const { gate } = loadAndGate(
      probe(realWindowCases({ 'r2-destroy-or-cancel': { skipped: true, skipReason: 'renderer crash not reproducible' } })),
      'skipped.json'
    )
    expect(gate.met).toBe(false)
    expect(gate.reasons.join('; ')).toContain('were skipped: r2-destroy-or-cancel (renderer crash not reproducible)')
  })

  it('rejects a scenario covered only by a stub', () => {
    const cases = realWindowCases().filter((entry) => entry.id !== 'r3-speech-cold-path')
    cases.push({ id: 'r3-speech-cold-path', kind: 'stub', pass: true })
    const { gate } = loadAndGate(probe(cases), 'stub-only.json')
    expect(gate.met).toBe(false)
    expect(gate.reasons.join('; ')).toContain('r3-speech-cold-path')
    expect(gate.coverage.missingScenarios).toEqual(['r3-speech-cold-path'])
    expect(gate.coverage.stub).toEqual(['r3-speech-cold-path'])
  })

  it('rejects evidence with no real-window case at all', () => {
    const { gate } = loadAndGate(
      probe(requiredIds.map((id) => ({ id, kind: 'stub', pass: true }))),
      'all-stubs.json'
    )
    expect(gate.met).toBe(false)
    expect(gate.reasons.join('; ')).toContain('no passing real-window case (stub cases cannot stand in for a real window)')
  })

  it('rejects a top-level pass=true whose cases failed', () => {
    const { gate } = loadAndGate(
      { pass: true, cases: realWindowCases({ 'r3-note-cold-path': { pass: false } }), identity },
      'top-pass-lie.json'
    )
    expect(gate.met).toBe(false)
    expect(gate.reasons.join('; ')).toContain('r3-note-cold-path')
  })

  it('rejects a probe whose pass field is false', () => {
    const { gate } = loadAndGate(passingProbe({ pass: false }), 'pass-false.json')
    expect(gate.met).toBe(false)
    expect(gate.reasons.join('; ')).toContain('did not report pass=true')
  })

  it('rejects incomplete and malformed build identity', () => {
    const incomplete = probe(realWindowCases(), { identity: { entrySha256: sha('a') } })
    const { gate } = loadAndGate(incomplete, 'identity-missing.json')
    expect(gate.met).toBe(false)
    expect(gate.reasons.join('; ')).toContain('missing preloadSha256, barHtmlSha256, sourceRef, command')

    const malformed = probe(realWindowCases(), { identity: { ...identity, barHtmlSha256: 'not-a-digest' } })
    const malformedGate = loadAndGate(malformed, 'identity-malformed.json').gate
    expect(malformedGate.met).toBe(false)
    expect(malformedGate.reasons.join('; ')).toContain('malformed sha256 digest: barHtmlSha256')
    expect(playbackIdentityProblems(identity)).toEqual([])
  })

  it('rejects absent candidate evidence and still warns about an unreadable baseline', () => {
    const candidate = loadPlaybackEvidence(null)
    const gate = playbackGate(loadPlaybackEvidence(fileOf('b.json', passingProbe())), candidate)
    expect(gate.met).toBe(false)
    expect(gate.candidate.ok).toBe(false)
    expect(gate.reasons.join('; ')).toContain('no playback evidence was given')

    const readable = loadAndGate(passingProbe(), 'warn-baseline.json')
    const unreadableBaseline = playbackGate(loadPlaybackEvidence(join(dir, 'missing-baseline.json')), readable.candidate)
    expect(unreadableBaseline.met).toBe(false)
    expect(unreadableBaseline.reasons.join('; ')).toContain('baseline playback evidence was unreadable')
  })

  it('keeps the return shape compare relies on', () => {
    const { gate } = loadAndGate({ pass: true, cases: [] }, 'shape.json')
    expect(gate).toHaveProperty('met')
    expect(gate).toHaveProperty('reason')
    expect(Array.isArray(gate.reasons)).toBe(true)
    expect(gate.candidate).toMatchObject({ path: expect.any(String), ok: true, pass: true, caseCount: 0 })
    expect(Array.isArray(gate.candidate.cases)).toBe(true)
    expect(gate.baseline).toHaveProperty('caseCount')
    expect(gate.requiredScenarios).toEqual(requiredIds)
    expect(gate.binding).toHaveProperty('met')
  })
})

/**
 * The probe publishing a digest proves nothing when the same file supplies the
 * expectation. These cases hold every other clause of the gate at `passing` and
 * vary only the binding between the evidence and the run it claims to measure.
 */
describe('playbackGate binds the evidence to the measured build', () => {
  it('accepts the reproduced phase-20 shape: entry digest equal, preload/bar.html only a limitation', () => {
    const { gate } = loadAndGate(passingProbe(), 'bind-ok.json')
    expect(gate.met).toBe(true)
    expect(gate.binding).toMatchObject({ met: true, checked: ['entrySha256'], reasons: [] })
    expect(gate.binding.limitations.join(' ')).toContain('preloadSha256 and barHtmlSha256 are not recorded in the candidate resource sample')
  })

  it('rejects the reproduced tampering: a probe entry digest rewritten to 64 f', () => {
    const { gate } = loadAndGate(
      probe(realWindowCases(), { identity: { ...identity, entrySha256: sha('f') } }),
      'bind-tampered.json'
    )
    expect(gate.met).toBe(false)
    expect(gate.binding.met).toBe(false)
    const reason = gate.reasons.join('; ')
    expect(reason).toContain('playback identity.entrySha256 ffffffffffff does not match the measured build entrySha256 aaaaaaaaaaaa')
  })

  it('rejects evidence with no build to bind to', () => {
    const { gate } = loadAndGate(passingProbe(), 'bind-nobuild.json', null)
    expect(gate.met).toBe(false)
    expect(gate.reasons.join('; ')).toContain('candidate build identity is missing')
  })

  it('rejects a build whose entry digest is missing or malformed', () => {
    const missing = loadAndGate(passingProbe(), 'bind-noentry.json', { ...build, entrySha256: undefined }).gate
    expect(missing.met).toBe(false)
    expect(missing.reasons.join('; ')).toContain('candidate meta.build.entrySha256 is missing')

    const malformed = loadAndGate(passingProbe(), 'bind-badentry.json', { ...build, entrySha256: 'not-a-digest' }).gate
    expect(malformed.met).toBe(false)
    expect(malformed.reasons.join('; ')).toContain('candidate meta.build.entrySha256 is not a 64-character hex digest (not-a-digest)')
  })

  it('rejects a probe entry digest that is missing or malformed', () => {
    const missingIdentity = { ...identity }
    delete missingIdentity.entrySha256
    const missing = loadAndGate(probe(realWindowCases(), { identity: missingIdentity }), 'bind-noprobeentry.json').gate
    expect(missing.met).toBe(false)
    expect(missing.binding.checked).toEqual([])
    expect(missing.reasons.join('; ')).toContain('build identity is incomplete: missing entrySha256')

    const malformed = loadAndGate(probe(realWindowCases(), { identity: { ...identity, entrySha256: 'zz' } }), 'bind-badprobeentry.json').gate
    expect(malformed.met).toBe(false)
    expect(malformed.reasons.join('; ')).toContain('build identity has a malformed sha256 digest: entrySha256')
  })

  it('cross-checks preload/bar.html only when the build records them', () => {
    const recorded = { ...build, preloadSha256: identity.preloadSha256, barHtmlSha256: identity.barHtmlSha256 }
    const ok = loadAndGate(passingProbe(), 'bind-recorded.json', recorded).gate
    expect(ok.met).toBe(true)
    expect(ok.binding.checked).toEqual(['entrySha256', 'preloadSha256', 'barHtmlSha256'])
    expect(ok.binding.limitations).toEqual([])

    const tampered = loadAndGate(
      probe(realWindowCases(), { identity: { ...identity, barHtmlSha256: sha('f') } }),
      'bind-tampered-bar.json',
      recorded
    ).gate
    expect(tampered.met).toBe(false)
    expect(tampered.reasons.join('; ')).toContain(
      `playback identity.barHtmlSha256 ${'f'.repeat(12)} does not match the measured build barHtmlSha256 ${sha('c').slice(0, 12)}`
    )
  })

  it('classifies a recorded but malformed build preload digest as a mismatch, not a pass', () => {
    const gate = loadAndGate(passingProbe(), 'bind-badbuildpreload.json', { ...build, preloadSha256: 'nope' }).gate
    expect(gate.met).toBe(false)
    expect(gate.reasons.join('; ')).toContain('candidate meta.build.preloadSha256 is not a 64-character hex digest (nope)')
    expect(playbackBindingProblems(identity, build)).toMatchObject({ met: true, checked: ['entrySha256'] })
  })
})
