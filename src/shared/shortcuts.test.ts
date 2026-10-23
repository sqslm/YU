import { describe, expect, it } from 'vitest'
import { mergeSettings } from './defaults'
import { shortcutConflict } from './shortcuts'

describe('shortcut conflicts', () => {
  it('detects screenshot conflicts and does not steal a stored custom binding on upgrade', () => {
    const hotkeys = mergeSettings({}).hotkeys
    delete (hotkeys as Partial<typeof hotkeys>).screenshotKeys
    const settings = mergeSettings({ hotkeys: { ...hotkeys, assistantKeys: { keys: ['LeftCtrl', 'RightShift', 'X'] } } })
    expect(settings.hotkeys.screenshotKeys.keys).not.toEqual(settings.hotkeys.assistantKeys.keys)
    expect(shortcutConflict(settings.hotkeys, 'ask', settings.hotkeys.screenshotKeys.keys)).toBe('screenshot')
    expect(mergeSettings({ hotkeys: { ...settings.hotkeys, screenshotKeys: { keys: [] } } }).hotkeys.screenshotKeys.keys).toEqual([])
  })
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
