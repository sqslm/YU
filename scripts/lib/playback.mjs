/**
 * Playback evidence from the renderer probe (produced by another collaborator).
 *
 * The whole-app comparison decides whether the rebuild is adopted, and playback
 * is a feature of the app rather than a resource number: a cheaper app that
 * cannot play is not an improvement. `compare` therefore refuses `adopted`
 * unless the candidate probe says `pass === true`, and it repeats each case
 * verdict in its own output so the decision can be audited.
 */
import fs from 'node:fs'

function normalizeCase(entry, index) {
  const name = String(entry?.name ?? entry?.case ?? entry?.id ?? `case-${index}`)
  const passed = entry?.pass === true || entry?.ok === true
  return {
    name,
    pass: passed,
    reason: typeof entry?.reason === 'string' ? entry.reason : null
  }
}

/**
 * Read one probe file. Any shape problem is reported instead of guessed, since
 * a playback gate that silently accepts unreadable input would always pass.
 */
export function loadPlaybackEvidence(file, { fileSystem = fs } = {}) {
  const base = { path: file ? String(file) : null, ok: false, pass: null, caseCount: 0, cases: [], error: null }
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
  const rawCases = Array.isArray(parsed.cases) ? parsed.cases : Array.isArray(parsed.results) ? parsed.results : []
  const cases = rawCases.map(normalizeCase)
  const pass = parsed.pass === true ? true : parsed.pass === false ? false : null
  if (pass === null) return { ...base, caseCount: cases.length, cases, error: 'playback evidence has no boolean pass field' }
  return { ...base, ok: true, pass, caseCount: cases.length, cases, error: null }
}

/**
 * The gate for one comparison. `candidate` is required; `baseline` is carried
 * into the evidence for context but does not gate on its own.
 */
export function playbackGate(baseline, candidate) {
  const reasons = []
  const failedCases = (candidate?.cases ?? []).filter((entry) => entry.pass !== true)
  if (!candidate?.ok) {
    reasons.push(candidate?.error ?? 'candidate playback evidence is missing')
  } else if (candidate.pass !== true) {
    reasons.push('candidate playback probe did not report pass=true')
  }
  if (candidate?.ok && failedCases.length) {
    reasons.push(`${failedCases.length} playback case(s) did not pass: ${failedCases.map((entry) => entry.name).join(', ')}`)
  }
  if (baseline?.path && !baseline.ok) {
    reasons.push(`baseline playback evidence was unreadable (${baseline.error}); the comparison still gates on the candidate`)
  }
  return {
    met: reasons.length === 0,
    reason: reasons.length ? reasons.join('; ') : 'candidate playback probe reported pass=true for every case',
    candidate: { path: candidate?.path ?? null, ok: candidate?.ok === true, pass: candidate?.pass ?? null, caseCount: candidate?.caseCount ?? 0, cases: candidate?.cases ?? [], error: candidate?.error ?? null },
    baseline: { path: baseline?.path ?? null, ok: baseline?.ok === true, pass: baseline?.pass ?? null, caseCount: baseline?.caseCount ?? 0, cases: baseline?.cases ?? [], error: baseline?.error ?? null }
  }
}
