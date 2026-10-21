import { describe, expect, it } from 'vitest'
import { mergeSuggestion } from '@shared/suggestions'
import type { Suggestion } from '@shared/types'
import { captureEdit, editedSegment, similarity } from './editCapture'

/**
 * ACC-06: these cases are the contract. Each one is a real situation the
 * pipeline can observe 1.5 s after insertion, and each decision below is a rule
 * the history row and the auto-learned dictionary depend on.
 */

const INSERTED = '我们明天上午十点开会'

describe('similarity', () => {
  it('scores identical text as 1, including two empty strings', () => {
    expect(similarity(INSERTED, INSERTED)).toBe(1)
    expect(similarity('', '')).toBe(1)
  })

  it('scores one empty side as 0', () => {
    expect(similarity('', INSERTED)).toBe(0)
    expect(similarity(INSERTED, '   ')).toBe(0)
  })

  it('is symmetric', () => {
    const a = '我们后天开会'
    const b = INSERTED
    expect(similarity(a, b)).toBeCloseTo(similarity(b, a), 10)
  })

  it('keeps unrelated sentences low and a one-word edit high', () => {
    const unrelated = similarity(INSERTED, '今天的天气真不错，下午去公园散步')
    const edited = similarity(INSERTED, '我们后天上午十点开会')
    expect(unrelated).toBeLessThan(0.2)
    expect(edited).toBeGreaterThan(0.6)
    expect(edited).toBeGreaterThan(unrelated)
  })
})

describe('editedSegment', () => {
  it('returns the appended tail', () => {
    expect(editedSegment(INSERTED, `${INSERTED}记得带电脑`)).toBe('记得带电脑')
  })

  it('returns the minimal changed stretch of a replacement', () => {
    expect(editedSegment('我们明天开会', '我们后天开会')).toBe('后')
  })

  it('returns the surviving text when the change was a deletion', () => {
    // The user dropped everything from 十点开会 onward.
    expect(editedSegment(INSERTED, '我们明天上午')).toBe('我们明天上午')
  })
})

describe('captureEdit', () => {
  it('reports NOT_EXTRACTED when the control could not be read', () => {
    const capture = captureEdit({ inserted: INSERTED, observed: null, transcript: INSERTED })
    expect(capture).toEqual({ editedStatus: 'NOT_EXTRACTED', revertDetected: false })
    expect(capture.editedText).toBeUndefined()
    expect(capture.candidates).toBeUndefined()
  })

  it('reports NOT_EXTRACTED for a blank read', () => {
    expect(captureEdit({ inserted: INSERTED, observed: '   \n ' })).toEqual({
      editedStatus: 'NOT_EXTRACTED',
      revertDetected: false
    })
  })

  it('reports UNCHANGED when only whitespace differs', () => {
    const capture = captureEdit({ inserted: INSERTED, observed: `  ${INSERTED.slice(0, 6)}\n${INSERTED.slice(6)}  ` })
    expect(capture.editedStatus).toBe('UNCHANGED')
    expect(capture.revertDetected).toBe(false)
    expect(capture.editedText).toBeUndefined()
    expect(capture.candidates).toBeUndefined()
  })

  it('reports UNCHANGED when a latin line was re-wrapped', () => {
    const capture = captureEdit({ inserted: 'ship the release notes', observed: 'ship the\nrelease   notes' })
    expect(capture.editedStatus).toBe('UNCHANGED')
    expect(capture.editedText).toBeUndefined()
  })

  it('reports EXTRACTED with the changed stretch when a word was replaced', () => {
    const capture = captureEdit({
      inserted: '我们明天开会',
      observed: '我们后天开会',
      transcript: '我们明天开会'
    })
    expect(capture.editedStatus).toBe('EXTRACTED')
    expect(capture.editedText).toBe('后')
    expect(capture.hasRevertedAI).toBeUndefined()
    expect(capture.revertDetected).toBe(false)
  })

  it('reports EXTRACTED when the user deleted the tail of the AI text', () => {
    const capture = captureEdit({ inserted: INSERTED, observed: '我们明天上午', transcript: INSERTED })
    expect(capture.editedStatus).toBe('EXTRACTED')
    expect(capture.editedText).toBe('我们明天上午')
    expect(capture.revertDetected).toBe(false)
  })

  it('reports EXTRACTED with the appended tail when the user kept typing', () => {
    const capture = captureEdit({
      inserted: INSERTED,
      observed: `${INSERTED}记得带电脑`,
      transcript: INSERTED,
      now: 1_700_000_000_000
    })
    expect(capture.editedStatus).toBe('EXTRACTED')
    expect(capture.editedText).toBe('记得带电脑')
    expect(capture.revertDetected).toBe(false)
    // The edit is what feeds the suggestion pool: a brand-new term, as a hint.
    expect(capture.candidates?.map((entry) => entry.from)).toContain('记得带电脑')
    expect(capture.candidates?.every((entry) => entry.to === '' && entry.mode === 'hint')).toBe(
      true
    )
    expect(capture.candidates?.[0]?.at).toBe(1_700_000_000_000)
  })

  it('produces candidates the suggestion pool accepts verbatim', () => {
    const capture = captureEdit({
      inserted: INSERTED,
      observed: `${INSERTED}记得带电脑`,
      now: 1_700_000_000_000
    })
    const pool = (capture.candidates ?? []).reduce(
      (acc, candidate) => mergeSuggestion(acc, candidate),
      [] as Suggestion[]
    )
    expect(pool.map((row) => row.from)).toEqual(capture.candidates?.map((row) => row.from))
    expect(pool.every((row) => row.count === 1 && row.status === 'pending')).toBe(true)
    expect(pool[0]?.firstSeen).toBe(1_700_000_000_000)
  })

  it('flags a revert when the text left in the field is what the user said', () => {
    const transcript = '我们明天上午九点开会讨论第二季度的预算'
    const capture = captureEdit({
      inserted: '明日九点召开第二季度预算讨论会。',
      observed: transcript,
      transcript
    })
    expect(capture.editedStatus).toBe('EXTRACTED')
    expect(capture.revertDetected).toBe(true)
    expect(capture.hasRevertedAI).toBe(true)
    expect(capture.editedText).toBe(transcript)
  })

  it('does not call a normal edit a revert', () => {
    const capture = captureEdit({
      inserted: INSERTED,
      observed: `${INSERTED}吧`,
      transcript: INSERTED
    })
    expect(capture.revertDetected).toBe(false)
    expect(capture.hasRevertedAI).toBeUndefined()
    expect(capture.editedStatus).toBe('EXTRACTED')
  })

  it('never mistakes an unrelated field for an edit', () => {
    const capture = captureEdit({
      inserted: INSERTED,
      observed: '今天的天气真不错，下午去公园散步',
      transcript: INSERTED
    })
    expect(capture).toEqual({ editedStatus: 'NOT_EXTRACTED', revertDetected: false })
  })
})
