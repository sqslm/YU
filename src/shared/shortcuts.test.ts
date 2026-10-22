import { describe, expect, it } from 'vitest'
import { mergeSettings } from './defaults'
import { shortcutConflict } from './shortcuts'

describe('shortcut conflicts', () => {
  it('detects exact duplicates regardless of recorded order', () => {
    const hotkeys = mergeSettings({}).hotkeys
    hotkeys.bindings.ask = { keys: ['LeftCtrl', 'F8'] }
    expect(shortcutConflict(hotkeys, 'dictation', ['F8', 'LeftCtrl'])).toBe('ask')
    expect(shortcutConflict(hotkeys, 'ask', ['LeftCtrl', 'F8'])).toBeUndefined()
  })
  it('includes note and paste bindings while allowing subsets and empty bindings', () => {
    const hotkeys = mergeSettings({}).hotkeys
    expect(shortcutConflict(hotkeys, 'ask', hotkeys.notesKeys.keys)).toBe('notes')
    expect(shortcutConflict(hotkeys, 'ask', hotkeys.pasteLastKeys.keys)).toBe('pasteLast')
    expect(shortcutConflict(hotkeys, 'ask', [])).toBeUndefined()
    expect(shortcutConflict(hotkeys, 'ask', ['RightAlt', 'LeftShift'])).toBeUndefined()
  })
})
