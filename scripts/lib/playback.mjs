/**
 * Playback evidence from the renderer probe (produced by another collaborator).
 *
 * The whole-app comparison decides whether the rebuild is adopted, and playback
 * is a feature of the app rather than a resource number: a cheaper app that
 * cannot play is not an improvement. `compare` therefore refuses `adopted`
 * unless the candidate probe passed every case *and* the evidence actually
 * covers the required phase-20 scenarios with a real window *and* names the
 * build it was produced from *and that name matches the build the comparison
 * measured. An empty `{pass:true, cases:[]}` file must never be able to satisfy
 * this gate, and a probe cannot vouch for itself: `identity.entrySha256` is
 * compared against the candidate run's `meta.build.entrySha256`, never against
 * the probe's own copy.
 *
 * Probe result contract (the candidate file):
 *
 *   {
 *     "pass": true,
 *     "cases": [
 *       { "id": "r1-stop-before-ready", "kind": "real-window", "pass": true, "detail": "..." },
 *       ...
 *     ],
 *     "identity": {
 *       "entrySha256": "...", "preloadSha256": "...", "barHtmlSha256": "...",
 *       "sourceRef": "HEAD c8a6a5a", "command": "pnpm exec vitest run src/main/bar-playback.probe.test.ts"
 *     }
 *   }
 *
 * `kind` is one of `real-window` or `stub`; a stub case is recorded but never
 * stands in for a real window. `skipped`/`skipReason` mark a case as not run.
 * Identity fields may also sit directly at the top level or under `build` for
 * compatibility with the existing evidence files.
 */
import fs from 'node:fs'

/** The phase-20 scenarios a playback pass must actually demonstrate. */
export const REQUIRED_PLAYBACK_SCENARIOS = Object.freeze([
  { id: 'r1-stop-before-ready', stage: 'R1', what: 'stop before a cold window is ready cancels the pending play' },
  {
    id: 'r1-stop-cancels-waiting-control',
    stage: 'R1',
    what: 'stopping while a play waits for the cold window cancels the waiting control instead of leaving it pending'
  },
  { id: 'r1-playback-replacement', stage: 'R1', what: 'a newer play replaces the older one; the old replies change nothing' },
  { id: 'r2-destroy-or-cancel', stage: 'R2', what: 'destroying the waiting window (or cancelling the wait) settles it and allows a rebuild' },
  { id: 'r3-note-cold-path', stage: 'R3', what: 'the note playback cold path plays from a real window' },
  { id: 'r3-speech-cold-path', stage: 'R3', what: 'the speech playback cold path plays from a real renderer' }
])

/** Case classifications. `stub` is recorded, never accepted as window evidence. */
export const PLAYBACK_CASE_KINDS = Object.freeze(['real-window', 'stub'])

/** Build identity the evidence must carry before a pass is believable. */
export const PLAYBACK_IDENTITY_FIELDS = Object.freeze(['entrySha256', 'preloadSha256', 'barHtmlSha256', 'sourceRef', 'command'])

const SHA256 = /^[0-9a-f]{64}$/i

function textOf(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeCase(entry, index) {
  const name = String(entry?.name ?? entry?.case ?? entry?.id ?? `case-${index}`)
  const skipped = entry?.skipped === true
  return {
    id: textOf(entry?.id) ?? name,
    name,
    kind: textOf(entry?.kind),
    pass: entry?.pass === true || entry?.ok === true,
    skipped,
    skipReason: textOf(entry?.skipReason) ?? (skipped ? textOf(entry?.reason) : null),
    reason: textOf(entry?.reason),
    detail: textOf(entry?.detail)
  }
}

/**
 * Pull the identity block out of a probe file. A probe may carry it under
 * `identity`, under `build`, or at the top level; all three are read the same
 * way so the older evidence files stay loadable.
 */
function identityOf(parsed) {
  const source =
    parsed?.identity && typeof parsed.identity === 'object'
      ? parsed.identity
      : parsed?.build && typeof parsed.build === 'object'
        ? parsed.build
        : parsed
  const identity = {}
  for (const field of PLAYBACK_IDENTITY_FIELDS) identity[field] = textOf(source?.[field])
  return identity
}

/** Missing/malformed identity fields, as reasons that can be written into evidence. */
export function playbackIdentityProblems(identity) {
  const missing = PLAYBACK_IDENTITY_FIELDS.filter((field) => !textOf(identity?.[field]))
  const malformed = PLAYBACK_IDENTITY_FIELDS.filter((field) => {
    const value = textOf(identity?.[field])
    return value ? field.endsWith('Sha256') && !SHA256.test(value) : false
  })
  const problems = []
  if (missing.length) problems.push(`build identity is incomplete: missing ${missing.join(', ')}`)
  if (malformed.length) problems.push(`build identity has a malformed sha256 digest: ${malformed.join(', ')}`)
  return problems
}

/** A digest reads as 12 hex characters in evidence; the full value stays in `expected`/`actual`. */
function short(value) {
  const text = textOf(value)
  return text ? text.slice(0, 12) : 'absent'
}

function sameDigest(left, right) {
  return textOf(left).toLowerCase() === textOf(right).toLowerCase()
}

/**
 * Bind the probe's identity to the build it claims to have measured.
 *
 * A probe that reports only its own digest proves nothing: if both the expected
 * and the observed value come out of the same file, any digest passes. The
 * expectation therefore comes from the candidate run's `meta.build`, and the
 * two sides are compared field by field. A field the resource sample never
 * recorded (`preloadSha256`, `barHtmlSha256` in phase 20) becomes a documented
 * limitation instead of being backfilled from whatever is on disk today.
 */
export function playbackBindingProblems(identity, build) {
  const reasons = []
  const limitations = []
  const checked = []
  const record = build && typeof build === 'object' ? build : null
  const actualEntry = textOf(identity?.entrySha256)
  const expectedEntry = textOf(record?.entrySha256)

  if (!record) {
    reasons.push('candidate build identity is missing, so the playback evidence is bound to no measured build')
  } else if (!expectedEntry) {
    reasons.push('candidate meta.build.entrySha256 is missing, so there is no expected digest to bind the playback evidence to')
  } else if (!SHA256.test(expectedEntry)) {
    reasons.push(`candidate meta.build.entrySha256 is not a 64-character hex digest (${short(expectedEntry)})`)
  }

  const entryUsable = Boolean(record && expectedEntry && SHA256.test(expectedEntry) && actualEntry && SHA256.test(actualEntry))
  if (entryUsable) {
    if (sameDigest(actualEntry, expectedEntry)) checked.push('entrySha256')
    else reasons.push(`playback identity.entrySha256 ${short(actualEntry)} does not match the measured build entrySha256 ${short(expectedEntry)}`)
  }

  const unrecorded = []
  for (const field of ['preloadSha256', 'barHtmlSha256']) {
    const expected = textOf(record?.[field])
    if (!expected) {
      unrecorded.push(field)
      continue
    }
    if (!SHA256.test(expected)) {
      reasons.push(`candidate meta.build.${field} is not a 64-character hex digest (${short(expected)})`)
      continue
    }
    const actual = textOf(identity?.[field])
    if (!actual || !SHA256.test(actual)) continue // playbackIdentityProblems already names it
    if (sameDigest(actual, expected)) checked.push(field)
    else reasons.push(`playback identity.${field} ${short(actual)} does not match the measured build ${field} ${short(expected)}`)
  }

  if (unrecorded.length) {
    limitations.push(
      `${unrecorded.join(' and ')} are not recorded in the candidate resource sample (meta.build carries entry, entrySha256, wrapperSha256, script, scriptSha256, rev, dirty, source and assets only), so they are not cross-checked here; only the real probe's runtime self-check of the on-disk artifacts covers them`
    )
  }

  return {
    met: reasons.length === 0,
    reasons,
    limitations,
    checked,
    expected: { entrySha256: expectedEntry ?? null, preloadSha256: textOf(record?.preloadSha256), barHtmlSha256: textOf(record?.barHtmlSha256) },
    actual: {
      entrySha256: actualEntry,
      preloadSha256: textOf(identity?.preloadSha256),
      barHtmlSha256: textOf(identity?.barHtmlSha256)
    }
  }
}

/**
 * Read one probe file. Any shape problem is reported instead of guessed, since
 * a playback gate that silently accepts unreadable input would always pass.
 */
export function loadPlaybackEvidence(file, { fileSystem = fs } = {}) {
  const base = {
    path: file ? String(file) : null,
    ok: false,
    pass: null,
    caseCount: 0,
    cases: [],
    identity: null,
    error: null
  }
  if (!file) return { ...base, error: 'no playback evidence was given' }
  let text
  try {
    text = fileSystem.readFileSync(file, 'utf8')
  } catch (error) {
    return { ...base, error: `playback evidence could not be read: ${error?.message ?? error}` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ...base, error: `playback evidence is not valid JSON: ${error?.message ?? error}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...base, error: 'playback evidence must be a JSON object with pass and cases' }
  }
  const identity = identityOf(parsed)
  const rawCases = Array.isArray(parsed.cases) ? parsed.cases : Array.isArray(parsed.results) ? parsed.results : null
  const pass = parsed.pass === true ? true : parsed.pass === false ? false : null
  if (rawCases === null) {
    return { ...base, identity, pass, error: 'playback evidence has no cases array' }
  }
  const cases = rawCases.map(normalizeCase)
  if (pass === null) {
    return { ...base, identity, caseCount: cases.length, cases, error: 'playback evidence has no boolean pass field' }
  }
  return { ...base, ok: true, pass, caseCount: cases.length, cases, identity, error: null }
}

function idsOf(cases) {
  return cases.map((entry) => entry.id)
}

/**
 * The gate for one comparison. `candidate` is required, `build` is the
 * candidate run's `meta.build` — the build the evidence has to prove it
 * measured. `baseline` is carried into the evidence for context but does not
 * gate on its own.
 *
 * `met` is true only when the candidate file is readable, says pass=true,
 * carries at least one case, every case passed and ran, every case is
 * classified, every required phase-20 scenario has a passing `real-window`
 * case, the build identity is complete, and that identity matches the measured
 * build field by field.
 */
export function playbackGate(baseline, candidate, build = null) {
  const reasons = []
  const cases = Array.isArray(candidate?.cases) ? candidate.cases : []
  const ran = cases.filter((entry) => entry.skipped !== true && entry.pass === true)
  const binding = playbackBindingProblems(candidate?.identity ?? null, build)

  if (!candidate?.ok) {
    reasons.push(candidate?.error ?? 'candidate playback evidence is missing')
  } else {
    if (candidate.pass !== true) reasons.push('candidate playback probe did not report pass=true')
    if (!cases.length) reasons.push('candidate playback evidence contains no cases')

    const failed = cases.filter((entry) => entry.skipped !== true && entry.pass !== true)
    if (failed.length) {
      reasons.push(
        `${failed.length} playback case(s) did not pass: ${failed
          .map((entry) => (entry.reason ? `${entry.id} (${entry.reason})` : entry.id))
          .join(', ')}`
      )
    }
    const skipped = cases.filter((entry) => entry.skipped === true)
    if (skipped.length) {
      reasons.push(
        `${skipped.length} playback case(s) were skipped: ${skipped
          .map((entry) => (entry.skipReason ? `${entry.id} (${entry.skipReason})` : entry.id))
          .join(', ')}`
      )
    }
    const unclassified = cases.filter((entry) => !PLAYBACK_CASE_KINDS.includes(entry.kind))
    if (unclassified.length) {
      reasons.push(
        `${unclassified.length} playback case(s) have no valid kind (${PLAYBACK_CASE_KINDS.join('|')}): ${idsOf(unclassified).join(', ')}`
      )
    }

    const realWindow = ran.filter((entry) => entry.kind === 'real-window')
    const stubs = ran.filter((entry) => entry.kind === 'stub')
    if (!realWindow.length) {
      reasons.push('candidate playback evidence has no passing real-window case (stub cases cannot stand in for a real window)')
    }
    const missingRealWindow = REQUIRED_PLAYBACK_SCENARIOS.filter((scenario) => !realWindow.some((entry) => entry.id === scenario.id))
    if (missingRealWindow.length) {
      reasons.push(
        `required playback scenario(s) have no passing real-window case: ${missingRealWindow
          .map((scenario) => `${scenario.id} (${scenario.what})`)
          .join('; ')}`
      )
    }

    reasons.push(...playbackIdentityProblems(candidate.identity))
    reasons.push(...binding.reasons)
  }

  if (baseline?.path && !baseline.ok) {
    reasons.push(`baseline playback evidence was unreadable (${baseline.error}); the comparison still gates on the candidate`)
  }

  const deliveredScenarios = REQUIRED_PLAYBACK_SCENARIOS.filter((scenario) =>
    ran.some((entry) => entry.kind === 'real-window' && entry.id === scenario.id)
  )
  const deliveredIds = deliveredScenarios.map((scenario) => scenario.id)

  return {
    met: reasons.length === 0,
    reason: reasons.length
      ? reasons.join('; ')
      : 'candidate playback probe passed every case, covered every required scenario with a real window, recorded the build identity, and that identity matches the measured build',
    reasons,
    binding,
    requiredScenarios: REQUIRED_PLAYBACK_SCENARIOS.map((scenario) => scenario.id),
    coverage: {
      realWindow: idsOf(ran.filter((entry) => entry.kind === 'real-window')),
      stub: idsOf(ran.filter((entry) => entry.kind === 'stub')),
      scenarios: deliveredIds,
      missingScenarios: REQUIRED_PLAYBACK_SCENARIOS.filter((scenario) => !deliveredIds.includes(scenario.id)).map(
        (scenario) => scenario.id
      ),
      unclassified: idsOf(cases.filter((entry) => !PLAYBACK_CASE_KINDS.includes(entry.kind)))
    },
    identity: candidate?.identity ?? null,
    candidate: {
      path: candidate?.path ?? null,
      ok: candidate?.ok === true,
      pass: candidate?.pass ?? null,
      caseCount: candidate?.caseCount ?? 0,
      cases: candidate?.cases ?? [],
      identity: candidate?.identity ?? null,
      error: candidate?.error ?? null
    },
    baseline: {
      path: baseline?.path ?? null,
      ok: baseline?.ok === true,
      pass: baseline?.pass ?? null,
      caseCount: baseline?.caseCount ?? 0,
      cases: baseline?.cases ?? [],
      error: baseline?.error ?? null
    }
  }
}
