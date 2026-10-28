import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { complete } from './providers/llm'
import { EntityMatcher } from './entity-matcher'
import { entityCandidatePrompt, normalizeEntity } from '@shared/entities'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { builtinPromptText } from '@shared/promptLibrary'
import reference from './fixtures/entity-recording-reference.json'

const root = process.env.TYPELESS_ENTITY_EVALUATION_ROOT
it.skipIf(!root)('compares confirmed real recordings with one existing LLM request per mode (explicit opt-in only)', async () => {
  const url = process.env.TYPELESS_ENTITY_LLM_URL, model = process.env.TYPELESS_ENTITY_LLM_MODEL
  if (!url || !model) throw Error('Set TYPELESS_ENTITY_LLM_URL and TYPELESS_ENTITY_LLM_MODEL for the configured provider')
  const matcher = new EntityMatcher()
  matcher.set(reference.terms.map((row, index) => ({ ...normalizeEntity(row), id: String(index), userDefined: true, createdAt: 1, updatedAt: 1 })))
  const audio = JSON.parse(readFileSync(join(root!, 'sensevoice-real-audio.json'), 'utf8')) as { rows: Array<{ file: string; durationMs: number; baseline: { text: string; ms: number } }> }
  const report = { model, reference: reference.source, labelledMentions: 7, limitation: 'Exact matches of the seven user-confirmed proper-name occurrences only; not full-transcript word error rate. Review every full output. No microphone, clipboard or insertion automation.',
    rows: [] as Array<Record<string, unknown>>, calls: 0, error: '' }
  try {
    for (const sample of audio.rows) {
      const expected = reference.expected[sample.file as keyof typeof reference.expected] ?? []
      const raw = sample.baseline.text
      const started = performance.now(), candidates = matcher.candidates(raw, 'polish')
      const candidateMs = performance.now() - started
      const row: Record<string, unknown> = { file: sample.file, raw, expected, asrMs: sample.baseline.ms, candidateMs, candidates, originalMatches: expected.filter(name => raw.includes(name)).length }
      report.rows.push(row)
      for (const enhanced of [false, true]) {
        const at = performance.now()
        let usage: { inputTokens: number; outputTokens: number } | null = null
        report.calls++
        const text = await complete({ ...DEFAULT_SETTINGS.polish, baseUrl: url, model, apiKey: process.env.TYPELESS_ENTITY_LLM_KEY || '' }, {
          messages: [{ role: 'system', content: builtinPromptText('polish') + (enhanced ? entityCandidatePrompt(candidates) : '') }, { role: 'user', content: raw }],
          temperature: 0, effort: 'off', maxTokens: 1024, signal: AbortSignal.timeout(30_000), onUsage: value => { usage = value }
        })
        row[enhanced ? 'enhanced' : 'baseline'] = { text, ms: performance.now() - at, usage, matched: expected.filter(name => text.includes(name)).length,
          lostPreviouslyCorrect: expected.filter(name => raw.includes(name) && !text.includes(name)).length }
      }
    }
    expect(report.calls).toBe(12)
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error }
  finally { writeFileSync(join(root!, 'llm-real-comparison.json'), JSON.stringify(report, null, 2)) }
}, 400_000)
