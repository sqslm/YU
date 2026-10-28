import { expect, it } from 'vitest'
import { mergeSettings } from './defaults'
import { nextPromptRoute } from './promptLibrary'

it('cycles every card, including inactive cards, then returns to automatic routing', () => {
  let settings = mergeSettings({})
  settings.promptLibrary.cards.polish.push({ id: 'inactive', name: 'Unselected card', content: 'Custom wording' })
  const expected = ['polish', 'translate', 'document', 'email', 'ai'].flatMap(kind => settings.promptLibrary.cards[kind as keyof typeof settings.promptLibrary.cards].map(card => `${kind}:${card.id}`))
  const seen: string[] = []
  for (let n = 0; n < expected.length; n++) {
    settings = { ...settings, ...nextPromptRoute(settings) }
    expect(settings.autoActivatePrompts).toBe(false)
    seen.push(`${settings.mainPromptKind}:${settings.mainPromptCardId}`)
  }
  expect(seen).toEqual(expected)
  settings = { ...settings, ...nextPromptRoute(settings) }
  expect(settings.autoActivatePrompts).toBe(true)
  expect(settings.promptLibrary.active.polish).not.toBe('inactive')
})

it('does not steal a custom chord and preserves a cleared cycle binding', () => {
  const hotkeys = mergeSettings({}).hotkeys
  hotkeys.screenshotKeys = { keys: ['LeftCtrl', 'RightShift', 'P'] }
  delete (hotkeys as Partial<typeof hotkeys>).promptCycleKeys
  expect(mergeSettings({ hotkeys }).hotkeys.promptCycleKeys.keys).toEqual(['LeftCtrl', 'RightShift', 'F6'])
  expect(mergeSettings({ hotkeys: { ...hotkeys, promptCycleKeys: { keys: [] } } }).hotkeys.promptCycleKeys.keys).toEqual([])
})
