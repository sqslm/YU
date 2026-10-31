import { describe, expect, it } from 'vitest'
import { SETTINGS_GROUPS, SETTINGS_PAGES, searchSettings, settingsPageFor } from './settingsNavigation'

describe('settings navigation', () => {
  it('keeps every previously supported deep link reachable', () => {
    for (const id of ['general', 'speech', 'wake', 'commands', 'input', 'shortcuts', 'models', 'prompts', 'routing', 'search', 'assistant', 'life', 'reminders', 'automation', 'storage', 'resources', 'account', 'about']) {
      expect(settingsPageFor(id).id).toBe(id)
    }
    expect(settingsPageFor('unknown').id).toBe('general')
  })

  it('has one destination per page in a real navigation group', () => {
    expect(new Set(SETTINGS_PAGES.map(page => page.id)).size).toBe(SETTINGS_PAGES.length)
    expect(SETTINGS_PAGES.every(page => SETTINGS_GROUPS.some(group => group.id === page.group))).toBe(true)
    expect(SETTINGS_PAGES.map(page => page.id)).toEqual(expect.arrayContaining(['memory', 'entities', 'asr', 'tts', 'briefing', 'delivery']))
  })

  it('finds pages by Chinese controls, English keywords and translated labels', () => {
    expect(searchSettings('麦克风', key => key).map(page => page.id)).toEqual(['speech'])
    expect(searchSettings('  API KEY  ', key => key).map(page => page.id)).toContain('models')
    expect(searchSettings('日历 订阅', key => key).map(page => page.id)).toEqual(['life'])
    expect(searchSettings('Appearance', key => key === 'settings.nav.general' ? 'Appearance' : key).map(page => page.id)).toContain('general')
    expect(searchSettings('no-such-setting', key => key)).toEqual([])
    expect(searchSettings(' ', key => key)).toHaveLength(SETTINGS_PAGES.length)
  })
})
