/**
 * The HKCU Run key, read-only, for the benchmark's isolation evidence.
 *
 * This module cannot write: it builds one PowerShell read, parses the JSON it
 * returns and diffs two snapshots. There is no restore step, no backup, no
 * "remove what is not mine" — a benchmark that deletes startup entries it
 * guessed were its own destroyed another program's registration once, and the
 * only way to not repeat that is to never write.
 *
 * The read is structured on purpose: `GetValueNames()` + `GetValue()` +
 * `GetValueKind()` → JSON. Splitting `name=value` text truncated values that
 * contain `=` (a path plus `--flag=a=b`), which is exactly what a Run value
 * looks like.
 */
export const RUN_KEY_PATH = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

/** Absolute path to the Windows PowerShell that ships with Windows. */
export function powerShellPath(env = process.env) {
  return `${env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

function psQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`
}

/**
 * The read script. `-InputObject @($rows)` keeps the array shape even for one
 * or zero values, so the parser never has to guess.
 */
export function buildRunKeyReadScript(keyPath = RUN_KEY_PATH) {
  return [
    `$k = Get-Item -LiteralPath ${psQuote(keyPath)}`,
    '$rows = foreach ($n in $k.GetValueNames()) { [pscustomobject]@{ name = $n; value = [string]$k.GetValue($n); kind = $k.GetValueKind($n).ToString() } }',
    'ConvertTo-Json -Compress -InputObject @($rows)'
  ].join('; ')
}

/**
 * Parse the JSON snapshot. Values are kept byte for byte — no trimming, no
 * splitting, no filtering by name: ownership is not this module's business.
 */
export function parseRunKeyJson(stdout) {
  const text = String(stdout ?? '').trim()
  if (!text) return []
  const parsed = JSON.parse(text)
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows
    .filter((row) => row && typeof row.name === 'string')
    .map((row) => ({ name: row.name, value: row.value === undefined || row.value === null ? '' : String(row.value), kind: String(row.kind ?? '') }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * One read. `spawnSync` is injected so tests can prove which commands were run
 * without ever touching the registry.
 */
export function readRunKey({ spawnSync, keyPath = RUN_KEY_PATH, exe = powerShellPath(), timeoutMs = 30_000 } = {}) {
  const at = new Date().toISOString()
  const started = Date.now()
  const fail = (error) => ({ ok: false, at, keyPath, entries: [], elapsedMs: Date.now() - started, error })
  if (typeof spawnSync !== 'function') return fail('no spawnSync was injected, so the Run key was not read')
  let result
  try {
    result = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', buildRunKeyReadScript(keyPath)], { encoding: 'utf8', timeout: timeoutMs })
  } catch (error) {
    return fail(`powershell could not run: ${error?.message ?? error}`)
  }
  if (!result || result.status !== 0) {
    const stderr = String(result?.stderr ?? '').trim()
    return fail(`Run key read failed: ${stderr || `exit ${result?.status ?? 'unknown'}`}`)
  }
  try {
    return { ok: true, at, keyPath, entries: parseRunKeyJson(result.stdout), elapsedMs: Date.now() - started, error: null }
  } catch (error) {
    return fail(`Run key JSON could not be parsed: ${error?.message ?? error}`)
  }
}

/** Pure diff of two snapshots. Values are compared exactly, kind included. */
export function diffRunKeys(before, after) {
  const beforeByName = new Map((before ?? []).map((entry) => [entry.name, entry]))
  const afterByName = new Map((after ?? []).map((entry) => [entry.name, entry]))
  const added = []
  const removed = []
  const changed = []
  for (const [name, entry] of afterByName) {
    if (!beforeByName.has(name)) added.push({ name, value: entry.value, kind: entry.kind })
  }
  for (const [name, entry] of beforeByName) {
    if (!afterByName.has(name)) removed.push({ name, value: entry.value, kind: entry.kind })
  }
  for (const [name, entry] of beforeByName) {
    const next = afterByName.get(name)
    if (!next) continue
    if (next.value !== entry.value || next.kind !== entry.kind) {
      changed.push({ name, before: entry.value, after: next.value, kindBefore: entry.kind, kindAfter: next.kind })
    }
  }
  added.sort((left, right) => left.name.localeCompare(right.name))
  removed.sort((left, right) => left.name.localeCompare(right.name))
  changed.sort((left, right) => left.name.localeCompare(right.name))
  return { added, removed, changed }
}

/**
 * Evidence for one benchmark run: `{valid, markerCount, runKey:{unchanged,diff,…}, reasons}`.
 *
 * `unchanged === false` means the user's startup list moved under the run, so
 * the numbers cannot be attributed to the app alone; the run is reported as
 * invalid and nothing is repaired.
 */
export function isolationReport(before, after, { markerCount = 0, marker = '' } = {}) {
  const readable = before?.ok === true && after?.ok === true
  const diff = readable ? diffRunKeys(before.entries, after.entries) : { added: [], removed: [], changed: [] }
  const unchanged = readable && diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0
  const reasons = []
  if (!readable) {
    reasons.push(`the Run key could not be read on ${before?.ok === true ? 'the second' : 'the first'} side (${before?.error ?? after?.error ?? 'unknown error'})`)
  } else if (!unchanged) {
    reasons.push('the Run key changed during the run (added/removed/changed reported, nothing was repaired)')
  }
  if (!(Number(markerCount) > 0)) {
    reasons.push(`the diagnostic wrapper never logged "${marker}", so a suppressed login-item write is not proven`)
  }
  return {
    valid: readable && unchanged && Number(markerCount) > 0,
    markerCount: Number(markerCount) || 0,
    marker,
    reasons,
    runKey: {
      unchanged,
      diff,
      keyPath: before?.keyPath ?? after?.keyPath ?? RUN_KEY_PATH,
      reads: {
        before: { at: before?.at ?? null, ok: before?.ok === true, count: before?.entries?.length ?? 0, error: before?.error ?? null },
        after: { at: after?.at ?? null, ok: after?.ok === true, count: after?.entries?.length ?? 0, error: after?.error ?? null }
      },
      before: before?.entries ?? [],
      after: after?.entries ?? []
    }
  }
}
