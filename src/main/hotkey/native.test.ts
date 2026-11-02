import { beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// Keep the existing gesture assertions and run every trace through the actual
// Rust executable. Replay never installs a hook or changes the user's keyboard.
const executable = resolve('native/bin/yu-hotkey.exe')
type Result = { events: { type: string; [key: string]: unknown }[]; swallowed: boolean | null; releases: number[]; waitMs: number }
let trace: Record<string, unknown>[], held: Set<number>, now: number, clearAt: number
let cached: Result[], cachedLength: number
const native = { receive: (event: { data: Record<string, unknown> }) => trace.push({ ...event.data, at: now }) }
function replay(): Result[] {
  if (cachedLength === trace.length) return cached
  const result = spawnSync(executable, ['--replay'], { input: JSON.stringify(trace), encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr)
  cached = JSON.parse(result.stdout); cachedLength = trace.length
  return cached
}
function clearEvents(): void { clearAt = trace.length }
function tick(ms: number): void {
  now += ms
  trace.push({ type: 'tick', at: now, held: [...held] })
}
function configure(): void {
  native.receive({ data: { type: 'config', bindings: {
    dictation: ['RightAlt'], ask: ['RightAlt', 'Space'], translate: ['RightAlt', 'RightShift']
  }, pasteLast: ['LeftCtrl', 'RightShift', 'V'], selection: ['LeftCtrl', 'RightShift', 'S'],
    selectionTranslate: ['LeftCtrl', 'RightShift', 'T'], reminder: ['LeftCtrl', 'RightShift', 'R'], assistant: ['LeftCtrl', 'RightShift', 'A'], screenshot: ['LeftCtrl', 'RightShift', 'X'], promptCycle: ['LeftCtrl', 'RightShift', 'P'], notes: [] } })
  clearEvents()
}
function key(vk: number, down: boolean): number {
  if (down) held.add(vk); else held.delete(vk)
  const index = trace.length
  trace.push({ type: 'key', vk, down, at: now })
  tick(8)
  return Number(replay()[index].swallowed)
}
function events(type: string): unknown[] { return replay().slice(clearAt).flatMap(x => x.events).filter(event => event.type === type) }
beforeEach(() => {
  trace = []; held = new Set(); now = 1000; clearAt = 0; cached = []; cachedLength = -1
  configure()
})

it('ignores injected traffic unless explicitly allowed by the replay probe', () => {
  trace.push({ type: 'key', vk: 0xa5, down: true, at: now, flags: 0x10 })
  trace.push({ type: 'key', vk: 0xa5, down: false, at: now + 1, flags: 0x10 })
  expect(events('start')).toHaveLength(0)
  expect(replay().at(-1)?.swallowed).toBe(false)
  trace.push({ type: 'key', vk: 0xa5, down: true, at: now + 2, flags: 0x10, allowInjected: true })
  trace.push({ type: 'key', vk: 0xa5, down: false, at: now + 3, flags: 0x10, allowInjected: true })
  expect(events('start')).toHaveLength(1)
})

it('recognizes generic VK_SHIFT as the right physical qualifier by scan code', () => {
  key(0xa5, true)
  trace.push({ type: 'key', vk: 0x10, scan: 0x36, down: true, at: now })
  trace.push({ type: 'key', vk: 0x10, scan: 0x36, down: false, at: now + 1 })
  key(0xa5, false)
  expect(events('start')).toEqual([expect.objectContaining({ mode: 'translate' })])
})

it('captures a physical shortcut once and retains release ownership after capture ends', () => {
  native.receive({ data: { type: 'capture', active: true } })
  expect(key(0xa1, true)).toBe(1); expect(key(0xa1, true)).toBe(1)
  expect(events('capture-key')).toEqual([{ type: 'capture-key', token: 'RightShift', down: true }])
  native.receive({ data: { type: 'capture', active: false } })
  expect(key(0xa1, false)).toBe(1)
  expect(key(0xa1, false)).toBe(0)
  expect(events('start')).toHaveLength(0)
})

it('opens notes without a voice take and permits repeated complete chords', () => {
  native.receive({ data: { type: 'config', bindings: {}, notes: ['LeftCtrl', 'LeftAlt', 'N'] } })
  for (let i = 0; i < 2; i++) {
    key(0xa2, true); key(0xa4, true); expect(key(0x4e, true)).toBe(1)
    key(0x4e, false); key(0xa4, false); key(0xa2, false)
  }
  expect(events('notes-toggle')).toHaveLength(2)
  expect(events('start')).toHaveLength(0)
})

it('retains the original primary when a custom longer chord lists its qualifier first', () => {
  native.receive({ data: { type: 'config', bindings: { dictation: ['F8'], ask: ['LeftShift', 'F8'] } } })
  key(0x77, true); key(0xa0, true); key(0x77, false)
  expect(events('start')).toEqual([expect.objectContaining({ mode: 'ask' })])
  key(0xa0, false)
  expect(events('stop')).toHaveLength(0)
  key(0x77, true)
  expect(events('stop')).toEqual([expect.objectContaining({ mode: 'ask' })])
})

it('cycles prompts on each fresh main-key press while modifiers remain held', () => {
  native.receive!({ data: { type: 'config', bindings: {}, pasteLast: [], promptCycle: ['LeftCtrl', 'LeftAlt', 'S'] } })
  clearEvents()
  key(0xa2, true); key(0xa4, true); key(0x53, true)
  expect(events('prompt-cycle')).toHaveLength(1)
  key(0x53, true)
  expect(events('prompt-cycle')).toHaveLength(1)
  key(0x53, false); key(0x53, true)
  expect(events('prompt-cycle')).toHaveLength(2)
  key(0x53, false); key(0xa4, false); key(0xa2, false)
  expect(events('prompt-cycle')).toHaveLength(2)
  expect(events('start')).toHaveLength(0)
})

it('cycles prompts once on press, without starting a recording', () => {
  key(0xa2, true); key(0xa1, true); key(0x50, true); key(0x50, true)
  expect(events('prompt-cycle')).toHaveLength(1)
  key(0x50, false); key(0xa2, false); key(0xa1, false)
  expect(events('prompt-cycle')).toHaveLength(1)
  expect(events('start')).toHaveLength(0)
})

it('opens screenshot capture once after all modifiers release and never starts audio', () => {
  key(0xa2, true); key(0xa1, true)
  expect(key(0x58, true)).toBe(1)
  expect(events('screenshot')).toHaveLength(0)
  key(0x58, false); key(0xa1, false); key(0xa2, false)
  expect(events('screenshot')).toHaveLength(1)
  expect(events('start')).toHaveLength(0)
})

it('opens the assistant only after the full chord releases, without a voice start', () => {
  key(0xa2, true); key(0xa1, true)
  expect(key(0x41, true)).toBe(1)
  expect(events('assistant-toggle')).toHaveLength(0)
  expect(key(0x41, false)).toBe(1)
  key(0xa2, false); key(0xa1, false)
  expect(events('assistant-toggle')).toHaveLength(1)
  expect(events('start')).toHaveLength(0)
})

describe('action shortcut release ordering', () => {
  it.each(['stop', 'cancel'])('owns controls for a notes recording reported by the actual recorder: %s', action => {
    native.receive!({ data: { type: 'config', bindings: {}, pasteLast: [] } })
    native.receive!({ data: { type: 'activity', value: 'recording' } })
    const vk = action === 'stop' ? 0xa5 : 0x1b
    expect(key(vk, true)).toBe(1)
    expect(key(vk, true)).toBe(1)
    expect(key(vk, false)).toBe(1)
    expect(events(action)).toHaveLength(1)
    expect(events('start')).toHaveLength(0)
    native.receive!({ data: { type: 'activity', value: 'idle' } })
    expect(key(vk, true)).toBe(0); expect(key(vk, false)).toBe(0)
  })

  it('swallows Escape while processing, then restores it after the task finishes', () => {
    native.receive!({ data: { type: 'activity', value: 'working' } })
    expect(key(0x1b, true)).toBe(1); expect(key(0x1b, false)).toBe(1)
    expect(events('cancel')).toHaveLength(1)
    native.receive!({ data: { type: 'activity', value: 'idle' } })
    expect(key(0x1b, true)).toBe(0); expect(key(0x1b, false)).toBe(0)
  })

  it('Right Alt submits a held custom gesture once, even before the start key is released', () => {
    native.receive!({ data: { type: 'config', activation: 'hold', bindings: { translate: ['F8'] }, pasteLast: [] } })
    key(0x77, true)
    expect(key(0xa5, true)).toBe(1); expect(key(0xa5, false)).toBe(1)
    key(0x77, false)
    expect(events('stop')).toHaveLength(1)
    expect(events('start')).toHaveLength(1)
  })
  it('owns Escape through repeats and release while cancelling a recording, but passes it when idle', () => {
    expect(key(0x1b, true)).toBe(0); expect(key(0x1b, false)).toBe(0)
    clearEvents()
    key(0xa5, true); key(0xa5, false)
    expect(key(0x1b, true)).toBe(1)
    expect(key(0x1b, true)).toBe(1)
    expect(key(0x1b, false)).toBe(1)
    expect(events('cancel')).toHaveLength(1)
    expect(events('stop')).toHaveLength(0)
    expect(key(0x1b, true)).toBe(0); expect(key(0x1b, false)).toBe(0)
  })

  it('Right Alt submits a reminder without restarting dictation on release', () => {
    key(0xa2, true); key(0xa1, true); key(0x52, true); key(0x52, false); key(0xa1, false); key(0xa2, false)
    expect(key(0xa5, true)).toBe(1)
    expect(events('stop')).toHaveLength(1)
    expect(key(0xa5, true)).toBe(1)
    expect(key(0xa5, false)).toBe(1)
    expect(events('start')).toHaveLength(1)
    expect(events('stop')).toHaveLength(1)
  })

  it.each(['dictation', 'translate', 'ask'])('Right Alt submits %s with a custom start key', mode => {
    native.receive!({ data: { type: 'config', bindings: { [mode]: ['F8'] }, pasteLast: [], reminder: [] } })
    key(0x77, true); key(0x77, false)
    expect(key(0x41, true)).toBe(0); key(0x41, false)
    expect(key(0xa5, true)).toBe(1); expect(key(0xa5, false)).toBe(1)
    expect(events('stop')).toEqual([expect.objectContaining({ mode })])
    expect(events('start')).toHaveLength(1)
  })
  it.each([[0x56, 'paste-last'], [0x53, 'selection'], [0x54, 'selection-translate']] as const)('%s waits for every modifier before %s', (letter, action) => {
    key(0xa2, true); key(0xa1, true)
    expect(events('start')).toHaveLength(0)
    expect(key(letter, true)).toBe(1)
    key(letter, false)
    expect(events(action)).toHaveLength(0)
    key(0xa1, false)
    expect(events(action)).toHaveLength(0)
    key(0xa2, false)
    expect(events(action)).toHaveLength(1)
    tick(1000)
    expect(events(action)).toHaveLength(1)
    expect(events('start')).toHaveLength(0)
  })

  it('Ctrl + Right Shift alone never starts a voice task', () => {
    key(0xa2, true); key(0xa1, true)
    tick(3000)
    key(0xa1, false); key(0xa2, false)
    expect(events('start')).toHaveLength(0)
    expect(events('selection')).toHaveLength(0)
    expect(events('paste-last')).toHaveLength(0)
  })

  it.each(['esc', 'reset', 'disabled', 'capture', 'config'])('%s clears a deferred paste', (reason) => {
    key(0xa2, true); key(0xa1, true); key(0x56, true); key(0x56, false)
    if (reason === 'esc') { key(0x1b, true); key(0x1b, false) }
    else if (reason === 'config') configure()
    else native.receive!({ data: reason === 'disabled' ? { type: 'enabled', value: false }
      : reason === 'capture' ? { type: 'capture', active: true } : { type: 'reset' } })
    key(0xa1, false); key(0xa2, false)
    expect(events('paste-last')).toHaveLength(0)
  })

  it('preserves the physical side of Shift and permits repeated complete chords', () => {
    key(0xa2, true); key(0xa0, true); key(0x56, true); key(0x56, false)
    key(0xa0, false); key(0xa2, false)
    expect(events('paste-last')).toHaveLength(0)
    for (let i = 0; i < 2; i++) {
      key(0xa1, true); key(0xa2, true); key(0x56, true); key(0x56, false)
      key(0xa2, false); key(0xa1, false)
    }
    expect(events('paste-last')).toHaveLength(2)
  })

  it('retains the existing dictation and qualified translation gestures', () => {
    key(0xa5, true); key(0xa5, false)
    expect(events('start')).toEqual([expect.objectContaining({ mode: 'dictation' })])
    key(0xa5, true); key(0xa5, false)
    expect(events('stop')).toHaveLength(1)
    key(0xa5, true); key(0xa1, true); key(0xa1, false); key(0xa5, false)
    expect(events('start')).toEqual([
      expect.objectContaining({ mode: 'dictation' }), expect.objectContaining({ mode: 'translate' })
    ])
  })
  it('reserves R only for the full reminder chord and never stops reminders on ordinary R input', () => {
    expect(key(0x52, true)).toBe(0); key(0x52, false)
    expect(events('start')).toHaveLength(0)
    key(0xa2, true); key(0xa1, true); expect(key(0x52, true)).toBe(1); key(0x52, false)
    key(0xa1, false); key(0xa2, false)
    expect(events('start')).toEqual([expect.objectContaining({ mode: 'dictation', purpose: 'reminder' })])
    expect(key(0x52, true)).toBe(0); key(0x52, false)
    expect(events('stop')).toHaveLength(0)
    key(0xa2, true); key(0xa1, true); key(0x52, true); key(0x52, false); key(0xa1, false); key(0xa2, false)
    expect(events('stop')).toHaveLength(1)
  })
})
