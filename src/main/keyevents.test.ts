import { describe, expect, it } from 'vitest'
import {
  KEYEVENTF_KEYUP,
  KEYEVENTF_UNICODE,
  VK_RETURN,
  VK_SHIFT,
  buildKeyEvents,
  danglingKeyUps,
  submitsOnEnter
} from './keyevents'

describe('buildKeyEvents', () => {
  it('types plain ASCII as unicode down/up pairs', () => {
    const events = buildKeyEvents('ab')
    expect(events).toHaveLength(4)
    expect(events[0]).toEqual({ scan: 0x61, flags: KEYEVENTF_UNICODE })
    expect(events[1]).toEqual({ scan: 0x61, flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP })
  })

  it('keeps CJK code units intact', () => {
    const events = buildKeyEvents('复')
    expect(events[0].scan).toBe('复'.charCodeAt(0))
    expect(events[0].flags).toBe(KEYEVENTF_UNICODE)
  })

  it('defaults newlines to a space so chat inputs never submit', () => {
    const events = buildKeyEvents('a\nb')
    const newlineEvents = events.slice(2, 4)
    expect(newlineEvents[0]).toEqual({ scan: 0x20, flags: KEYEVENTF_UNICODE })
    expect(newlineEvents[1].flags).toBe(KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)
    expect(submitsOnEnter(events)).toBe(false)
  })

  it('sends Shift+Enter for the shiftEnter policy', () => {
    const events = buildKeyEvents('a\nb', 'shiftEnter')
    const shiftDown = events.find((event) => event.vk === VK_SHIFT && !event.flags)
    expect(shiftDown).toBeDefined()
    expect(events.some((event) => event.vk === VK_RETURN && !event.flags)).toBe(true)
    expect(submitsOnEnter(events)).toBe(false)
  })

  it('sends a bare Enter for the keep policy', () => {
    const events = buildKeyEvents('a\nb', 'keep')
    expect(submitsOnEnter(events)).toBe(true)
  })

  it('returns nothing for empty text', () => {
    expect(buildKeyEvents('')).toEqual([])
  })
})

describe('submitsOnEnter', () => {
  it('ignores Enter key-ups', () => {
    expect(submitsOnEnter([{ vk: VK_RETURN, flags: KEYEVENTF_KEYUP }])).toBe(false)
  })
})

describe('danglingKeyUps', () => {
  it('finds nothing in a balanced stream', () => {
    const events = buildKeyEvents('a\nb', 'shiftEnter')
    expect(danglingKeyUps(events)).toEqual([])
  })

  it('releases a modifier whose up event was never sent', () => {
    const events = buildKeyEvents('\n', 'shiftEnter')
    // Shift down, Enter down, Enter up, Shift up.
    expect(events.map((e) => e.vk)).toEqual([VK_SHIFT, VK_RETURN, VK_RETURN, VK_SHIFT])
    // Failure right after the Shift press is exactly the stuck-Shift case.
    const stragglers = danglingKeyUps(events.slice(0, 1))
    expect(stragglers).toEqual([{ vk: VK_SHIFT, scan: 0, flags: KEYEVENTF_KEYUP }])
  })

  it('releases nested keys innermost first', () => {
    const stragglers = danglingKeyUps([
      { vk: VK_SHIFT },
      { vk: VK_RETURN },
      { scan: 0x41, flags: KEYEVENTF_UNICODE }
    ])
    expect(stragglers.map((e) => e.vk)).toEqual([VK_RETURN, VK_SHIFT])
  })

  it('ignores unicode events, which never hold a key down', () => {
    expect(danglingKeyUps(buildKeyEvents('abc'))).toEqual([])
  })
})
