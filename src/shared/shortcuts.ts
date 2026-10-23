import type { Settings } from './types'

/** Exact duplicate chords conflict; deliberate subset chords (Alt / Alt+Shift) remain valid. */
export function shortcutConflict(hotkeys: Settings['hotkeys'], target: string, keys: string[]): string | undefined {
  if (!keys.length) return undefined
  const signature = [...keys].sort().join('+')
  const bindings = {
    ...hotkeys.bindings,
    pasteLast: hotkeys.pasteLastKeys,
    notes: hotkeys.notesKeys,
    selection: hotkeys.selectionKeys,
    selectionTranslate: hotkeys.selectionTranslateKeys,
    reminder: hotkeys.reminderKeys,
    assistant: hotkeys.assistantKeys,
    screenshot: hotkeys.screenshotKeys
  }
  return Object.entries(bindings).find(([id, binding]) =>
    id !== target && binding?.keys.length && [...binding.keys].sort().join('+') === signature
  )?.[0]
}
