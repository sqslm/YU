import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  handler: null as null | ((code: number, message: number, key: unknown) => number),
  receive: null as null | ((event: { data: unknown }) => void),
  held: new Set<number>(),
  post: vi.fn()
}))

vi.mock('koffi', () => ({ default: {
  load: () => ({ func: (signature: string) => {
    if (signature.includes('GetAsyncKeyState')) return (vk: number) => native.held.has(vk) ? 0x8000 : 0
    if (signature.includes('CallNextHookEx')) return () => 0
    if (signature.includes('PeekMessageW')) return () => 0
    return () => 1
  } }),
  struct: () => ({}), proto: () => ({}), pointer: (value: unknown) => value,
  register: (handler: typeof native.handler) => { native.handler = handler; return handler },
  decode: (value: unknown) => value, address: () => 0, unregister: vi.fn()
} }))

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  native.held.clear()
  native.post.mockClear()
  vi.stubGlobal('process', { ...process, on: vi.fn(), parentPort: {
    postMessage: native.post,
    on: (_event: string, receive: typeof native.receive) => { native.receive = receive }
  } })
  await import('./child')
  configure()
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

function configure(): void {
  native.receive!({ data: { type: 'config', bindings: {
    dictation: ['RightAlt'], ask: ['RightAlt', 'Space'], translate: ['RightAlt', 'RightShift']
  }, pasteLast: ['LeftCtrl', 'RightShift', 'V'], selection: ['LeftCtrl', 'RightShift', 'S'], notes: [] } })
  native.post.mockClear()
}
function key(vk: number, down: boolean): number {
  if (down) native.held.add(vk)
  else native.held.delete(vk)
  const swallowed = native.handler!(0, down ? 0x100 : 0x101, { vkCode: vk, scanCode: 0, flags: 0 })
  vi.advanceTimersByTime(8)
  return swallowed
}
function events(type: string): unknown[] {
  return native.post.mock.calls.map(([event]) => event).filter(event => event.type === type)
}

describe('action shortcut release ordering', () => {
  it.each([[0x56, 'paste-last'], [0x53, 'selection']] as const)('%s waits for every modifier before %s', (letter, action) => {
    key(0xa2, true); key(0xa1, true)
    expect(events('start')).toHaveLength(0)
    expect(key(letter, true)).toBe(1)
    key(letter, false)
    expect(events(action)).toHaveLength(0)
    key(0xa1, false)
    expect(events(action)).toHaveLength(0)
    key(0xa2, false)
    expect(events(action)).toHaveLength(1)
    vi.advanceTimersByTime(1000)
    expect(events(action)).toHaveLength(1)
    expect(events('start')).toHaveLength(0)
  })

  it('Ctrl + Right Shift alone never starts a voice task', () => {
    key(0xa2, true); key(0xa1, true)
    vi.advanceTimersByTime(3000)
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
})
