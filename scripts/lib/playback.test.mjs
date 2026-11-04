import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadPlaybackEvidence, playbackGate } from './playback.mjs'

const dir = mkdtempSync(join(tmpdir(), 'typeless-playback-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function fileOf(name, body) {
  const file = join(dir, name)
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  return file
}

const passing = { pass: true, cases: [{ name: 'play-pause', pass: true }, { name: 'seek', pass: true }] }

describe('loadPlaybackEvidence', () => {
  it('reads a passing probe', () => {
    const loaded = loadPlaybackEvidence(fileOf('pass.json', passing))
    expect(loaded.ok).toBe(true)
    expect(loaded.pass).toBe(true)
    expect(loaded.caseCount).toBe(2)
    expect(loaded.cases.map((entry) => entry.name)).toEqual(['play-pause', 'seek'])
  })

  it('reports a missing file, bad JSON and a missing pass field instead of assuming success', () => {
    expect(loadPlaybackEvidence(join(dir, 'nope.json')).ok).toBe(false)
    expect(loadPlaybackEvidence(join(dir, 'nope.json')).error).toContain('could not be read')
    expect(loadPlaybackEvidence(fileOf('bad.json', '{oops')).error).toContain('not valid JSON')
    expect(loadPlaybackEvidence(fileOf('nopass.json', { cases: [] })).error).toContain('no boolean pass field')
    expect(loadPlaybackEvidence(null).error).toContain('no playback evidence')
  })
})

describe('playbackGate', () => {
  it('passes only when the candidate probe passed every case', () => {
    const gate = playbackGate(loadPlaybackEvidence(fileOf('b-pass.json', passing)), loadPlaybackEvidence(fileOf('c-pass.json', passing)))
    expect(gate.met).toBe(true)
    expect(gate.candidate.caseCount).toBe(2)
  })

  it('fails when the candidate probe failed, even if the baseline passed', () => {
    const file = fileOf('c-fail.json', { pass: false, cases: [{ name: 'play', pass: false, reason: 'no audio frames' }] })
    const gate = playbackGate(loadPlaybackEvidence(fileOf('b2.json', passing)), loadPlaybackEvidence(file))
    expect(gate.met).toBe(false)
    expect(gate.reason).toContain('pass=true')
    expect(gate.reason).toContain('play')
    expect(gate.candidate.cases[0].reason).toBe('no audio frames')
  })

  it('fails when the top-level pass disagrees with a failed case', () => {
    const file = fileOf('c-mixed.json', { pass: true, cases: [{ name: 'seek', pass: false }] })
    const gate = playbackGate(loadPlaybackEvidence(fileOf('b3.json', passing)), loadPlaybackEvidence(file))
    expect(gate.met).toBe(false)
    expect(gate.reason).toContain('seek')
  })

  it('fails when the candidate evidence is absent', () => {
    const gate = playbackGate(loadPlaybackEvidence(fileOf('b4.json', passing)), loadPlaybackEvidence(null))
    expect(gate.met).toBe(false)
    expect(gate.candidate.ok).toBe(false)
  })
})
