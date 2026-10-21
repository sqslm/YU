import type { MultilineMode } from '@shared/types'

/**
 * Pure key-event construction for text insertion.
 *
 * Kept free of koffi/Electron imports so the newline policy can be unit tested:
 * the interesting question is whether a generated newline turns into Enter
 * (which submits chat inputs) or a harmless break, and that decision must be
 * provable without a real keyboard hook.
 */
export const KEYEVENTF_KEYUP = 0x0002
export const KEYEVENTF_UNICODE = 0x0004
export const VK_SHIFT = 0x10
export const VK_RETURN = 0x0d
export const VK_CONTROL = 0x11
export const VK_V = 0x56

export interface KeyEvent {
  vk?: number
  scan?: number
  flags?: number
}

function charEvent(code: number, up = false): KeyEvent {
  return { scan: code, flags: up ? KEYEVENTF_UNICODE | KEYEVENTF_KEYUP : KEYEVENTF_UNICODE }
}

function keyEvent(vk: number, scan: number, up = false): KeyEvent {
  return { vk, scan, flags: up ? KEYEVENTF_KEYUP : 0 }
}

/** One UTF-16 unit per event pair, newlines resolved by the multiline policy. */
export function buildKeyEvents(text: string, multiline: MultilineMode = 'space'): KeyEvent[] {
  const events: KeyEvent[] = []
  for (const char of text) {
    if (char === '\n' || char === '\r') {
      if (multiline === 'space') {
        events.push(charEvent(0x20), charEvent(0x20, true))
      } else if (multiline === 'shiftEnter') {
        events.push(
          keyEvent(VK_SHIFT, 0x2a),
          keyEvent(VK_RETURN, 0x1c),
          keyEvent(VK_RETURN, 0x1c, true),
          keyEvent(VK_SHIFT, 0x2a, true)
        )
      } else {
        events.push(keyEvent(VK_RETURN, 0x1c), keyEvent(VK_RETURN, 0x1c, true))
      }
      continue
    }
    for (let i = 0; i < char.length; i++) {
      const code = char.charCodeAt(i)
      events.push(charEvent(code), charEvent(code, true))
    }
  }
  return events
}

/**
 * True when the stream contains a bare Enter press (no Shift held during it).
 * Used by tests and by the settings UI to warn about the `keep` policy.
 */
export function submitsOnEnter(events: KeyEvent[]): boolean {
  let shiftDown = false
  for (const event of events) {
    const up = ((event.flags ?? 0) & KEYEVENTF_KEYUP) !== 0
    if (event.vk === VK_SHIFT) {
      shiftDown = !up
      continue
    }
    if (event.vk === VK_RETURN && !up && !shiftDown) return true
  }
  return false
}

/**
 * Keys this stream pressed but never released, as the keyup events that fix it.
 *
 * Insertion is not atomic: text is sent in chunks, and a chunk can be refused
 * (UIPI, a locked session, focus stolen mid-typing), which aborts the rest of
 * the stream. If the abort lands between a modifier's press and its release —
 * exactly where `shiftEnter` puts the Shift pair — the injected Shift stays down
 * system-wide and every following keystroke is treated as Shift+key. Releasing
 * what we pressed is the only way out that does not need the user to press the
 * key again.
 */
export function danglingKeyUps(events: KeyEvent[]): KeyEvent[] {
  const held: number[] = []
  for (const event of events) {
    if (((event.flags ?? 0) & KEYEVENTF_UNICODE) !== 0) continue
    const vk = event.vk ?? 0
    if (!vk) continue
    if (((event.flags ?? 0) & KEYEVENTF_KEYUP) !== 0) {
      const at = held.lastIndexOf(vk)
      if (at >= 0) held.splice(at, 1)
      continue
    }
    if (!held.includes(vk)) held.push(vk)
  }
  return held.reverse().map((vk) => ({ vk, scan: 0, flags: KEYEVENTF_KEYUP }))
}
