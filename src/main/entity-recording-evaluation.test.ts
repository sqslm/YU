import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { EntityMatcher } from './entity-matcher'
import { normalizeEntity } from '@shared/entities'
import reference from './fixtures/entity-recording-reference.json'

it.skipIf(!process.env.TYPELESS_ENTITY_EVALUATION_ROOT)('measures candidate retrieval on the confirmed local audio transcripts without claiming LLM correction accuracy', () => {
  const root = process.env.TYPELESS_ENTITY_EVALUATION_ROOT!
  const audio = JSON.parse(readFileSync(join(root, 'sensevoice-real-audio.json'), 'utf8')) as { rows: Array<{ file: string; baseline: { text: string } }> }
  const matcher = new EntityMatcher(), at = performance.now()
  matcher.set(reference.terms.map((row, i) => ({ ...normalizeEntity(row), id: String(i), userDefined: true, createdAt: 1, updatedAt: 1 })))
  const indexMs = performance.now() - at, times: number[] = []
  const rows = audio.rows.map(sample => {
    const expected = reference.expected[sample.file as keyof typeof reference.expected] ?? []
    const started = performance.now(), candidates = matcher.candidates(sample.baseline.text, '')
    times.push(performance.now() - started)
    return { file: sample.file, expected, candidates, candidateMatches: expected.filter(name => candidates.some(candidate => candidate.canonical === name)).length,
      originalMatches: expected.filter(name => sample.baseline.text.includes(name)).length }
  })
  times.sort((a, b) => a - b)
  const report = { sampleCount: rows.length, labelledMentions: 7, originalMatches: rows.reduce((sum, row) => sum + row.originalMatches, 0),
    candidateMatches: rows.reduce((sum, row) => sum + row.candidateMatches, 0), indexMs,
    averageCandidateMs: times.reduce((a, b) => a + b, 0) / times.length, p95CandidateMs: times[Math.ceil(times.length * .95) - 1],
    finalCorrectionAccuracy: null, falseCorrectionRate: null,
    limitation: 'Terms and aliases were configured from these confirmed samples. Candidate inclusion is wiring/replay coverage, not final correction accuracy, semantic accuracy or independent holdout/generalization accuracy. No LLM output is substituted for ground truth.', rows }
  writeFileSync(join(root, 'candidate-replay.json'), JSON.stringify(report, null, 2))
  expect(report.originalMatches).toBe(3); expect(report.candidateMatches).toBe(7)
  expect(rows.find(row => row.file === '录音 (4).m4a')?.candidates).toEqual([])
})
