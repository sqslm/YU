import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SETTINGS_VERSION, applySettingsPatch, mergeSettings, normalizeAppList } from './defaults'
import { defaultSearchProviders } from './searchProviders'
import { DEFAULT_LOCAL_MODEL } from './local-asr'

describe('mergeSettings', () => {
  it('defaults old installations to fidelity capture and preserves the voice-processing choice', () => {
    expect(mergeSettings({}).audioProcessing).toBe('fidelity')
    expect(mergeSettings({ audioProcessing: 'voice' }).audioProcessing).toBe('voice')
    expect(mergeSettings({ audioProcessing: 'unknown' as never }).audioProcessing).toBe('fidelity')
  })
  it('retires failed-only history audio while preserving successful-audio opt-in', () => {
    expect(mergeSettings({}).keepAudio).toBe('never')
    expect(mergeSettings({ keepAudio: 'failed' }).keepAudio).toBe('never')
    expect(mergeSettings({ keepAudio: 'always' }).keepAudio).toBe('always')
  })
  it('enables caption previews for old settings and preserves the off switch', () => {
    expect(mergeSettings({}).liveCaptions).toBe(true)
    expect(mergeSettings({ liveCaptions: false }).liveCaptions).toBe(false)
    expect(mergeSettings({ liveCaptions: 'false' as never }).liveCaptions).toBe(true)
  })
  it('combines partial groups while preserving unrelated provider entries', () => {
    const first = applySettingsPatch({}, { asr: { apiKey: 'test' } as never })
    const pending = applySettingsPatch(first, { asr: { model: 'model' } as never })
    expect(pending.asr).toMatchObject({ apiKey: 'test', model: 'model' })
    const updated = applySettingsPatch(DEFAULT_SETTINGS, {
      search: { providers: { tavily: { apiKey: 'search-test' } } } as never
    })
    expect(updated.search.providers.tavily).toEqual({ apiKey: 'search-test', endpoint: '', maxResults: 5 })
    expect(updated.search.providers.brave).toEqual(DEFAULT_SETTINGS.search.providers.brave)
    expect(DEFAULT_SETTINGS.search.providers.tavily.apiKey).toBe('')
  })
  it('normalizes booleans, playback speed and temperature to their control ranges', () => {
    const merged = mergeSettings({
      polish: { enabled: 'false', temperature: 8 } as never,
      restoreClipboard: 'false' as never,
      launchAtStartup: 1 as never,
      notePlaybackRate: 99,
      language: 42 as never,
      notesDir: null as never,
      barPosition: { x: Number.NaN, y: Infinity }
    })
    expect(merged.polish.enabled).toBe(DEFAULT_SETTINGS.polish.enabled)
    expect(merged.polish.temperature).toBe(1)
    expect(merged.restoreClipboard).toBe(DEFAULT_SETTINGS.restoreClipboard)
    expect(merged.launchAtStartup).toBe(false)
    expect(merged.notePlaybackRate).toBe(2)
    expect(merged.language).toBe(DEFAULT_SETTINGS.language)
    expect(merged.notesDir).toBe('')
    expect(merged.barPosition).toBeNull()
    expect(mergeSettings({ polish: { temperature: 0.25 } as never }).polish.temperature).toBe(0.25)
  })

  it('returns the defaults for an empty object', () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps nested groups intact when only one field is supplied', () => {
    const merged = mergeSettings({ asr: { model: 'whisper-1' } as never })
    expect(merged.asr.model).toBe('whisper-1')
    // Untouched siblings survive, which is what makes upgrades safe.
    expect(merged.asr.baseUrl).toBe(DEFAULT_SETTINGS.asr.baseUrl)
    expect(merged.polish).toEqual(DEFAULT_SETTINGS.polish)
  })

  it('merges individual hotkey bindings without dropping the others', () => {
    const merged = mergeSettings({ hotkeys: { bindings: { dictation: ['F9'] } } as never })
    expect(merged.hotkeys.bindings.dictation).toEqual(['F9'])
    expect(merged.hotkeys.bindings.ask).toEqual(DEFAULT_SETTINGS.hotkeys.bindings.ask)
    expect(merged.hotkeys.bindings.translate).toEqual(
      DEFAULT_SETTINGS.hotkeys.bindings.translate
    )
  })

  it('gives a settings file written before the notes chord a working default', () => {
    // 0.9.17 and older have no `notesKeys`; the merge must invent one instead of
    // leaving `undefined` where the hook expects a list of key tokens.
    const merged = mergeSettings({ hotkeys: { enabled: true, bindings: {} } as never })
    expect(merged.hotkeys.notesKeys).toEqual(DEFAULT_SETTINGS.hotkeys.notesKeys)
    expect(merged.hotkeys.notesKeys.keys.length).toBeGreaterThan(0)
  })

  it('brings the hub forward for a settings file written before the toggle', () => {
    // The only behaviour that existed was "open the app"; a silent background
    // default would have changed how the chord feels on upgrade day.
    const merged = mergeSettings({ hotkeys: { notesKeys: { keys: ['F8'] } } as never })
    expect(merged.hotkeys.notesOpenApp).toBe(true)
  })

  it('keeps a deliberate background-only choice', () => {
    const merged = mergeSettings({ hotkeys: { notesOpenApp: false } as never })
    expect(merged.hotkeys.notesOpenApp).toBe(false)
    const back = mergeSettings({ hotkeys: { notesOpenApp: true } as never })
    expect(back.hotkeys.notesOpenApp).toBe(true)
  })

  it('keeps a user-recorded notes chord and leaves the modes alone', () => {
    const merged = mergeSettings({ hotkeys: { notesKeys: { keys: ['F8'] } } as never })
    expect(merged.hotkeys.notesKeys).toEqual({ keys: ['F8'] })
    expect(merged.hotkeys.bindings).toEqual(DEFAULT_SETTINGS.hotkeys.bindings)
    expect(merged.hotkeys.pasteLastKeys).toEqual(DEFAULT_SETTINGS.hotkeys.pasteLastKeys)
  })

  it('always stamps the current schema version', () => {
    expect(mergeSettings({ version: 0 }).version).toBe(SETTINGS_VERSION)
  })

  it('keeps the three appearances and drops anything else', () => {
    // `'system'` is stored as-is: the resolution to a palette happens at render
    // time (renderer) and at chrome-paint time (main), never in the settings file.
    expect(mergeSettings({ themeMode: 'system' }).themeMode).toBe('system')
    expect(mergeSettings({ themeMode: 'light' }).themeMode).toBe('light')
    expect(mergeSettings({ themeMode: 'neon' } as never).themeMode).toBe(
      DEFAULT_SETTINGS.themeMode
    )
  })

  it('does not mutate the defaults', () => {
    const before = structuredClone(DEFAULT_SETTINGS)
    mergeSettings({ language: 'en' })
    expect(DEFAULT_SETTINGS).toEqual(before)
  })

  it('drops malformed glossary entries and keeps good ones', () => {
    const merged = mergeSettings({
      replacements: [
        { from: 'a', to: 'b' },
        // A term without a translation is a glossary hint, not garbage: it
        // teaches the model a spelling without rewriting anything.
        { from: 'x' } as never,
        { from: '   ', to: 'y' } as never,
        null as never,
        { from: 1, to: 2 } as never
      ]
    })
    expect(merged.replacements).toEqual([
      { from: 'a', to: 'b', mode: 'replace', origin: 'manual' },
      { from: 'x', to: '', mode: 'hint', origin: 'manual' }
    ])
  })

  it('collapses duplicate terms and keeps the learned count', () => {
    const merged = mergeSettings({
      replacements: [
        { from: 'Kubernetes', to: '', origin: 'auto', hits: 3, updatedAt: 10 } as never,
        { from: 'kubernetes', to: 'K8s' } as never
      ]
    })
    expect(merged.replacements).toEqual([
      { from: 'Kubernetes', to: '', mode: 'hint', origin: 'auto', hits: 3, updatedAt: 10 }
    ])
  })

  it('normalises a bad bar position back to auto', () => {
    expect(mergeSettings({ barPosition: { x: 10, y: 20 } }).barPosition).toEqual({ x: 10, y: 20 })
    expect(mergeSettings({ barPosition: { x: 'a', y: 2 } as never }).barPosition).toBeNull()
    expect(mergeSettings({}).barPosition).toBeNull()
  })

  it('rounds a persisted device id and falls back to the system default', () => {
    expect(mergeSettings({ inputDeviceId: 'abc' }).inputDeviceId).toBe('abc')
    expect(mergeSettings({ inputDeviceId: undefined }).inputDeviceId).toBe('')
  })

  it('keeps every search provider key in its own slot', () => {
    const providers = defaultSearchProviders()
    providers.tavily = { apiKey: 'tvly-key', endpoint: '', maxResults: 3 }
    providers.brave = { apiKey: 'brave-key', endpoint: 'https://brave.local', maxResults: 7 }
    const merged = mergeSettings({ search: { providers, provider: 'brave' } as never })
    expect(merged.search.providers.tavily.apiKey).toBe('tvly-key')
    expect(merged.search.providers.brave.apiKey).toBe('brave-key')
    // The flat trio mirrors the active provider, so adapters never read stale keys.
    expect(merged.search.apiKey).toBe('brave-key')
    expect(merged.search.endpoint).toBe('https://brave.local')
    expect(merged.search.maxResults).toBe(7)
  })

  it('switching provider swaps the live key without touching other slots', () => {
    const providers = defaultSearchProviders()
    providers.tavily = { apiKey: 'tvly-key', endpoint: '', maxResults: 4 }
    providers.searxng = { apiKey: '', endpoint: 'http://127.0.0.1:8080', maxResults: 6 }
    const toTavily = mergeSettings({ search: { providers, provider: 'tavily' } as never })
    expect(toTavily.search.apiKey).toBe('tvly-key')
    const toSearxng = mergeSettings({ search: { providers, provider: 'searxng' } as never })
    expect(toSearxng.search.apiKey).toBe('')
    expect(toSearxng.search.endpoint).toBe('http://127.0.0.1:8080')
    expect(toSearxng.search.maxResults).toBe(6)
  })

  it('rejects an unknown search provider and falls back to the default', () => {
    expect(mergeSettings({ search: { provider: 'gigablast' } as never }).search.provider).toBe(
      DEFAULT_SETTINGS.search.provider
    )
  })

  it('collapses a legacy built-in Ask prompt and keeps real extra instructions', () => {
    const legacyEn = mergeSettings({
      polish: { askPrompt: 'You are a helpful assistant answering a spoken question.' } as never
    })
    expect(legacyEn.polish.askPrompt).toBe('')
    const mine = mergeSettings({ polish: { askPrompt: '答案控制在三句话以内。' } as never })
    expect(mine.polish.askPrompt).toBe('答案控制在三句话以内。')
  })

  it('keeps site rules, normalises their domain, and drops unusable ones', () => {
    const merged = mergeSettings({
      appRules: [
        { id: 'site', match: '', domain: 'https://WWW.GitHub.com/x', kind: 'ai' },
        { id: 'text', match: 'Outlook', kind: 'email' },
        { id: 'junk', match: '', domain: 'README.md', kind: 'ai' },
        { id: 'site', match: 'duplicate id', kind: 'polish' }
      ] as never
    })
    expect(merged.appRules).toEqual([
      { id: 'site', match: '', domain: 'github.com', kind: 'ai' },
      { id: 'text', match: 'Outlook', kind: 'email' }
    ])
  })

  it('keeps a rule that only names a domain', () => {
    const merged = mergeSettings({
      appRules: [{ id: 'only-domain', match: '', domain: 'notion.so', kind: 'document' }] as never
    })
    expect(merged.appRules).toHaveLength(1)
    expect(merged.appRules[0]).toMatchObject({ domain: 'notion.so', kind: 'document' })
  })
})

describe('local speech model defaults', () => {
  it('starts switched off with the multilingual model and the CN mirror', () => {
    const settings = mergeSettings({})
    expect(settings.localAsr.enabled).toBe(false)
    expect(settings.localAsr.modelId).toBe(DEFAULT_LOCAL_MODEL)
    expect(settings.localAsr.language).toBe('auto')
    expect(settings.localAsr.mirror).toBe('cn')
    expect(settings.localAsr.modelDir).toBe('')
    expect(settings.localAsr.idleUnloadMinutes).toBe(5)
  })

  it('keeps a stored choice that still exists', () => {
    const settings = mergeSettings({
      localAsr: { enabled: true, modelId: 'paraformer-zh', modelDir: 'D:\\models', language: 'zh', mirror: 'official', idleUnloadMinutes: 15 }
    })
    expect(settings.localAsr).toEqual({
      enabled: true,
      modelId: 'paraformer-zh',
      modelDir: 'D:\\models',
      language: 'zh',
      mirror: 'official',
      idleUnloadMinutes: 15
    })
  })

  it('drops a model id that is no longer in the catalogue', () => {
    const settings = mergeSettings({ localAsr: { modelId: 'gone-forever' } as never })
    expect(settings.localAsr.modelId).toBe(DEFAULT_LOCAL_MODEL)
  })

  it('migrates older settings and bounds the idle timeout without replacing zero', () => {
    for (const [input, expected] of [[undefined, 5], [0, 0], [-1, 0], [90, 60], [NaN, 5]]) {
      expect(mergeSettings({ localAsr: { idleUnloadMinutes: input } as never }).localAsr.idleUnloadMinutes).toBe(expected)
    }
  })

  it('drops a language the chosen model cannot do', () => {
    // Paraformer is Chinese-only, so the 'ja' left over from another model has to
    // collapse instead of being handed to a recogniser that would ignore it.
    const settings = mergeSettings({
      localAsr: { modelId: 'paraformer-zh', language: 'ja' } as never
    })
    expect(settings.localAsr.language).toBe('zh')
  })

  it('treats any mirror that is not "official" as the CN mirror', () => {
    const settings = mergeSettings({ localAsr: { mirror: 'lol' } as never })
    expect(settings.localAsr.mirror).toBe('cn')
  })
})

describe('normalizeAppList', () => {
  it('trims, lowercases and drops the .exe suffix', () => {
    // The foreground app reports `code`; the user types `Code.exe`. Both have to
    // end up as the same key or the blocklist silently never matches.
    expect(normalizeAppList([' Code.exe ', 'chrome', 'Code'])).toEqual(['code', 'chrome'])
  })

  it('drops empty and non-string entries instead of failing the load', () => {
    expect(normalizeAppList(['', '  ', 42, null, 'notes'])).toEqual(['notes'])
  })

  it('returns an empty list for a value that is not an array', () => {
    expect(normalizeAppList('code')).toEqual([])
    expect(normalizeAppList(undefined)).toEqual([])
  })

  it('caps the list so a pasted log cannot become the settings file', () => {
    const many = Array.from({ length: 150 }, (_, index) => `app${index}`)
    expect(normalizeAppList(many)).toHaveLength(100)
  })

  it('is what mergeSettings applies to a stored list', () => {
    expect(mergeSettings({ disabledApps: ['Slack.exe'] }).disabledApps).toEqual(['slack'])
  })

  it('defaults to an empty list when the key was never written', () => {
    expect(mergeSettings({}).disabledApps).toEqual([])
  })
})

it('migrates selection shortcuts and validates the shared list page size', () => {
  expect(mergeSettings({}).hotkeys.selectionKeys.keys).toEqual(['LeftCtrl', 'RightShift', 'S'])
  expect(mergeSettings({ hotkeys: { selectionKeys: { keys: ['LeftCtrl', 'RightShift', 'T'] } } as never })
    .hotkeys.selectionKeys.keys).toEqual(['LeftCtrl', 'RightShift', 'T'])
  expect(mergeSettings({ listPageSize: 10 }).listPageSize).toBe(10)
  expect(mergeSettings({ listPageSize: -2 }).listPageSize).toBe(30)
  expect(mergeSettings({ hotkeys: { selectionKeys: { keys: [] } } as never }).hotkeys.selectionKeys.keys).toEqual([])
})
