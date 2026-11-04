import { describe, expect, it } from 'vitest'
import { buildRunKeyReadScript, diffRunKeys, isolationReport, parseRunKeyJson, readRunKey, RUN_KEY_PATH } from './run-key.mjs'

/**
 * Every command the benchmark could run is recorded here. The review's core
 * demand is that none of them writes anything, so the assertions below check
 * the recorded command text, not only the returned diff.
 */
const WRITE_COMMAND = /(Remove-ItemProperty|Remove-Item|New-ItemProperty|Set-ItemProperty|Rename-ItemProperty|Set-Item|reg(?:\.exe)?\s+(?:add|delete|import))/i

function recorder(responses) {
  const calls = []
  let index = 0
  const spawnSync = (exe, args, options) => {
    calls.push({ exe, args, options })
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (next instanceof Error) throw next
    return next
  }
  return { calls, spawnSync }
}

const payload = (entries) => ({ status: 0, stdout: JSON.stringify(entries), stderr: '' })
const writes = (calls) => calls.filter((call) => WRITE_COMMAND.test(String(call.args?.join(' ') ?? '')))

const typelessEntry = {
  name: 'typeless-rebuild',
  value: '"C:\\Program Files\\Typeless\\typeless.exe" --background',
  kind: 'String'
}
const steamEntry = { name: 'Steam', value: '"C:\\Steam\\steam.exe" -silent', kind: 'String' }

describe('buildRunKeyReadScript', () => {
  it('reads names, values and kinds instead of splitting text', () => {
    const script = buildRunKeyReadScript()
    expect(script).toContain('GetValueNames()')
    expect(script).toContain('GetValue($n)')
    expect(script).toContain('GetValueKind($n)')
    expect(script).toContain('ConvertTo-Json')
    expect(script).not.toMatch(WRITE_COMMAND)
    expect(script).toContain(RUN_KEY_PATH)
  })

  it('escapes quotes in an injected key path', () => {
    expect(buildRunKeyReadScript("HKCU:\\A'B")).toContain("'HKCU:\\A''B'")
  })
})

describe('parseRunKeyJson', () => {
  it('keeps values containing several equals signs intact', () => {
    const value = '"C:\\Program Files\\Typeless\\typeless.exe" --launch=at=startup --flag=a=b'
    const parsed = parseRunKeyJson(JSON.stringify([{ name: 'typeless-rebuild', value, kind: 'ExpandString' }]))
    expect(parsed).toEqual([{ name: 'typeless-rebuild', value, kind: 'ExpandString' }])
  })

  it('accepts a single object, an empty array and empty output', () => {
    expect(parseRunKeyJson(JSON.stringify(typelessEntry))).toHaveLength(1)
    expect(parseRunKeyJson('[]')).toEqual([])
    expect(parseRunKeyJson('')).toEqual([])
  })

  it('does not filter out other programs', () => {
    const parsed = parseRunKeyJson(JSON.stringify([typelessEntry, steamEntry]))
    expect(parsed.map((entry) => entry.name)).toEqual(['Steam', 'typeless-rebuild'])
  })
})

describe('diffRunKeys', () => {
  it('reports additions, removals and value changes', () => {
    const before = parseRunKeyJson(JSON.stringify([typelessEntry, steamEntry]))
    const after = parseRunKeyJson(JSON.stringify([{ ...typelessEntry, value: '"C:\\other\\typeless.exe"' }]))
    const diff = diffRunKeys(before, after)
    expect(diff.removed.map((entry) => entry.name)).toEqual(['Steam'])
    expect(diff.changed).toEqual([{ name: 'typeless-rebuild', before: typelessEntry.value, after: '"C:\\other\\typeless.exe"', kindBefore: 'String', kindAfter: 'String' }])
    expect(diff.added).toEqual([])
  })

  it('is empty for identical snapshots', () => {
    const snapshot = parseRunKeyJson(JSON.stringify([typelessEntry, steamEntry]))
    expect(diffRunKeys(snapshot, snapshot)).toEqual({ added: [], removed: [], changed: [] })
  })
})

describe('isolation on a stubbed Run key', () => {
  // (a) Another program registers an Electron-looking startup entry while the
  //      benchmark runs. The old code deleted "new names matching
  //      /typeless|electron/" — that entry is not ours, so nothing may touch it.
  it('reports another program\'s matching entry and touches nothing', () => {
    const before = payload([typelessEntry, steamEntry])
    const after = payload([typelessEntry, steamEntry, { name: 'electron-helper', value: '"C:\\Other\\electron.exe" --hidden', kind: 'String' }])
    const { calls, spawnSync } = recorder([before, after])
    const first = readRunKey({ spawnSync })
    const second = readRunKey({ spawnSync })
    const report = isolationReport(first, second, { markerCount: 1, marker: '[diag] suppressed login-item write' })

    expect(report.runKey.diff.added).toEqual([{ name: 'electron-helper', value: '"C:\\Other\\electron.exe" --hidden', kind: 'String' }])
    expect(report.runKey.diff.removed).toEqual([])
    expect(report.runKey.unchanged).toBe(false)
    expect(report.valid).toBe(false)
    expect(calls).toHaveLength(2)
    expect(writes(calls)).toEqual([])
    for (const call of calls) expect(String(call.args?.join(' '))).toContain('GetValueNames()')
  })

  // (b) The original value contains several '='. A text split would have
  //     truncated it and the restore step would have written the truncated
  //     value back; the structured read keeps it and reports no change.
  it('keeps a value with several equals signs unchanged', () => {
    const messy = { name: 'typeless-rebuild', value: '"C:\\t\\typeless.exe" --a=b --c=d=e', kind: 'ExpandString' }
    const { calls, spawnSync } = recorder([payload([messy]), payload([messy])])
    const report = isolationReport(readRunKey({ spawnSync }), readRunKey({ spawnSync }), { markerCount: 2, marker: 'm' })

    expect(report.runKey.before[0].value).toBe('"C:\\t\\typeless.exe" --a=b --c=d=e')
    expect(report.runKey.diff).toEqual({ added: [], removed: [], changed: [] })
    expect(report.runKey.unchanged).toBe(true)
    expect(report.valid).toBe(true)
    expect(writes(calls)).toEqual([])
  })

  // (c) The user edits a value themselves while the benchmark runs. Report the
  //     edit, invalidate the run, write nothing back.
  it('reports a user edit during the run instead of restoring it', () => {
    const edited = { ...typelessEntry, value: '"D:\\moved\\typeless.exe" --background' }
    const { calls, spawnSync } = recorder([payload([typelessEntry, steamEntry]), payload([edited, steamEntry])])
    const report = isolationReport(readRunKey({ spawnSync }), readRunKey({ spawnSync }), { markerCount: 1, marker: 'm' })

    expect(report.runKey.diff.changed).toEqual([{ name: 'typeless-rebuild', before: typelessEntry.value, after: edited.value, kindBefore: 'String', kindAfter: 'String' }])
    expect(report.runKey.unchanged).toBe(false)
    expect(report.reasons.join(' | ')).toContain('changed during the run')
    expect(writes(calls)).toEqual([])
  })

  // (d) The sampling run dies and the cleanup path executes. Cleanup is a read
  //     and a report; there is no restore step left to run.
  it('runs no write command when a read fails during unwinding', () => {
    const { calls, spawnSync } = recorder([payload([typelessEntry]), { status: 1, stdout: '', stderr: 'Access is denied.' }])
    const report = isolationReport(readRunKey({ spawnSync }), readRunKey({ spawnSync }), { markerCount: 1, marker: 'm' })

    expect(report.runKey.unchanged).toBe(false)
    expect(report.valid).toBe(false)
    expect(report.reasons.join(' | ')).toContain('could not be read')
    expect(report.runKey.reads.after.ok).toBe(false)
    expect(writes(calls)).toEqual([])
  })

  it('treats a throwing powershell as a failed read', () => {
    const { calls, spawnSync } = recorder([new Error('spawn ENOENT')])
    const report = readRunKey({ spawnSync })
    expect(report.ok).toBe(false)
    expect(report.error).toContain('spawn ENOENT')
    expect(writes(calls)).toEqual([])
  })

  it('does not claim isolation without the wrapper marker', () => {
    const snapshot = payload([typelessEntry])
    const { spawnSync } = recorder([snapshot, snapshot])
    const report = isolationReport(readRunKey({ spawnSync }), readRunKey({ spawnSync }), { markerCount: 0, marker: '[diag] suppressed login-item write' })
    expect(report.runKey.unchanged).toBe(true)
    expect(report.valid).toBe(false)
    expect(report.reasons.join(' | ')).toContain('login-item write')
  })
})
