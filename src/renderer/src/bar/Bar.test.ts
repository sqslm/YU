import { describe, expect, it } from 'vitest'
import type { BarState, Mode } from '@shared/types'
import { modeLabelFor } from './Bar'

const recording: BarState = { phase: 'recording', mode: 'translate', since: 0 }
const working: BarState = { phase: 'working', mode: 'ask' }
const done: BarState = { phase: 'done', mode: 'dictation', text: '你好' }
const idle: BarState = { phase: 'idle' }
const error: BarState = { phase: 'error', message: 'boom' }

function withPhase(phase: 'recording' | 'working' | 'done', mode: Mode): BarState {
  if (phase === 'recording') return { phase, mode, since: 0 }
  if (phase === 'working') return { phase, mode }
  return { phase, mode, text: 'x' }
}

describe('modeLabelFor', () => {
  it('labels the mode in the three phases that carry one', () => {
    expect(modeLabelFor(recording, true)).toBe('翻译')
    expect(modeLabelFor(working, true)).toBe('问答')
    expect(modeLabelFor(done, true)).toBe('听写')
  })

  it('labels every mode the same way in every phase that shows it', () => {
    const expected: Record<Mode, string> = { dictation: '听写', translate: '翻译', ask: '问答' }
    for (const phase of ['recording', 'working', 'done'] as const) {
      for (const mode of ['dictation', 'translate', 'ask'] as const) {
        expect(modeLabelFor(withPhase(phase, mode), true)).toBe(expected[mode])
      }
    }
  })

  it('shows nothing on the idle pill', () => {
    expect(modeLabelFor(idle, true)).toBeNull()
  })

  it('shows nothing in the error phase', () => {
    expect(modeLabelFor(error, true)).toBeNull()
  })

  it('shows nothing anywhere when the toggle is off', () => {
    for (const state of [recording, working, done, idle, error]) {
      expect(modeLabelFor(state, false)).toBeNull()
    }
  })

  it('falls back to 听写 when the state carries no mode', () => {
    // A main process that predates the mode field still drives the bar.
    const recordingWithoutMode = { phase: 'recording', since: 0 } as unknown as BarState
    const workingWithoutMode = { phase: 'working' } as unknown as BarState
    const doneWithoutMode = { phase: 'done', text: 'x' } as unknown as BarState
    expect(modeLabelFor(recordingWithoutMode, true)).toBe('听写')
    expect(modeLabelFor(workingWithoutMode, true)).toBe('听写')
    expect(modeLabelFor(doneWithoutMode, true)).toBe('听写')
  })

  it('falls back to 听写 for a mode it does not know', () => {
    const unknown = { phase: 'working', mode: 'summarise' } as unknown as BarState
    expect(modeLabelFor(unknown, true)).toBe('听写')
  })

  it('takes the flag from its argument, not from a showMode field on the state', () => {
    const hidden: BarState = { phase: 'recording', mode: 'ask', since: 0, showMode: false }
    expect(modeLabelFor(hidden, true)).toBe('问答')
    expect(modeLabelFor(hidden, false)).toBeNull()
  })
})
