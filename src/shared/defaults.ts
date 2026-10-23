import type {
  AppRule,
  PromptKind,
  ProviderKind,
  ProviderProfile,
  Replacement,
  Settings,
  Suggestion
} from './types'
import { normalizeDomain } from './domain'
import { buildAskPrompt, buildDictationPrompt, buildTranslatePrompt } from './prompts'
import { PROMPT_KINDS, defaultPromptLibrary, normalizePromptLibrary } from './promptLibrary'
import { defaultSearchProviders, isSearchProvider, normalizeSearchProviders, normalizeSearchConnections } from './searchProviders'
import { DEFAULT_LOCAL_MODEL, findModel } from './local-asr'
import { DEFAULT_VOICE_COMMANDS, normalizeVoiceCommands } from './voiceCommands'

export const SETTINGS_VERSION = 1

/** Translation mode emits at most three language blocks per take (REQ-10). */
import { mt } from './mainI18n'

export const MAX_TRANSLATE_TARGETS = 3

/** Legal retention windows: 24h / 1w / 1m / 1y, plus forever (-1) and never (0). */
export const HISTORY_RETENTIONS = [-1, 0, 86_400, 604_800, 2_592_000, 31_536_000] as const

export const DEFAULT_SETTINGS: Settings = {  version: SETTINGS_VERSION,
  hotkeys: {
    enabled: true,
    // Mirrors the vendor defaults discovered on disk so muscle memory carries
    // over: RightAlt = dictation, RightAlt+Space = ask, RightAlt+RightShift =
    // translate, Ctrl+RightShift+V = paste last transcript.
    bindings: {
      dictation: { keys: ['RightAlt'] },
      ask: { keys: ['RightAlt', 'Space'] },
      translate: { keys: ['RightAlt', 'RightShift'] }
    },
    pasteLastKeys: { keys: ['LeftCtrl', 'RightShift', 'V'] },
    selectionKeys: { keys: ['LeftCtrl', 'RightShift', 'S'] },
    selectionTranslateKeys: { keys: ['LeftCtrl', 'RightShift', 'T'] },
    reminderKeys: { keys: ['LeftCtrl', 'RightShift', 'R'] },
    assistantKeys: { keys: ['LeftCtrl', 'RightShift', 'A'] },
    // Ctrl+Alt+N: no modifier of the dictation gesture, so a note take can never
    // be mistaken for one and a note chord cannot start a dictation on its way in.
    notesKeys: { keys: ['LeftCtrl', 'LeftAlt', 'N'] },
    // On by default: a global chord with no visible reaction reads as broken, and
    // the notes page is where the take's progress is shown.
    notesOpenApp: true
  },
  // Empty on purpose: a connection only exists once the user saves a profile.
  // Ship a populated default and every take fails against an endpoint the user
  // never chose, with an error that points at the network instead of the setup.
  selectionInsertMode: 'replace',
  voiceCommands: structuredClone(DEFAULT_VOICE_COMMANDS),
  reminders: { notifications: true, strongSound: true, snoozeMinutes: 5 },
  asr: {
    baseUrl: '',
    apiKey: '',
    model: '',
    // WAV by default: a wrong guess here breaks every take on a gateway that
    // does not decode Ogg/Opus, which is most self-hosted ones.
    upload: 'wav'
  },
  polish: {
    enabled: true,
    baseUrl: '',
    apiKey: '',
    model: '',
    effort: '',
    systemPrompt: buildDictationPrompt(),
    translatePrompt: buildTranslatePrompt('en'),
    // Extra instructions appended to the built-in Ask prompt (empty = none).
    // The switch that used to swap the whole prompt out is gone; askPrompt is an
    // additive field now, so a legacy value equal to the built-in text is
    // treated as "no extra instructions" during merge.
    askPrompt: '',
    useBuiltInPrompts: true,
    temperature: 0.2
  },
  pipelineMode: 'classic',
  multimodal: {
    baseUrl: '',
    apiKey: '',
    model: '',
    maxSeconds: 120
  },
  search: {
    enabled: true,
    strategy: 'single',
    connections: [],
    provider: 'duckduckgo',
    providers: defaultSearchProviders(),
    // Mirror of providers[provider]; mergeSettings keeps it in sync so adapters
    // can keep reading a single flat config.
    apiKey: '',
    endpoint: '',
    maxResults: 5,
    decideWithModel: true
  },
  localAsr: {
    enabled: false,
    modelId: DEFAULT_LOCAL_MODEL,
    modelDir: '',
    language: 'auto',
    mirror: 'cn',
    idleUnloadMinutes: 5
  },
  // Empty by default: an untouched install keeps using the legacy blocks above,
  // so nothing changes until the user saves a profile on purpose.
  profiles: [],
  chains: { asr: [], llm: [], multimodal: [] },
  activationMode: 'toggle',
  language: 'zh',
  translateTarget: 'en',
  translateTargets: ['en'],
  inputDeviceId: '',
  replacements: [],
  // Learned ideas stay here until the user confirms one; see `@shared/suggestions`.
  suggestions: [],
  insertMethod: 'clipboard',
  multiline: 'space',
  restoreClipboard: true,
  launchAtStartup: false,
  closeBehavior: 'background',
  onboarded: false,
  /**
   * Deprecated: the pill is the only place that reports what the app is doing,
   * so nothing ever hid it, and the tray entry that used to explain that is
   * gone. Kept only so existing settings files still load.
   */
  showBarOnDesktop: true,
  barPosition: null,
  disabledApps: [],
  listPageSize: 30,
  historyLimit: 500,
  historyDurationSeconds: -1,
  historyRefreshSeconds: 0,
  notesDir: '',
  notePlaybackRate: 1,
  alertHideSeconds: 4,
  keepAudio: 'never',
  audioProcessing: 'fidelity',
  maxSessionSeconds: 540,
  arrowToCursorInBar: false,
  themeMode: 'dark',
  /** Interface language; see `Settings.uiLanguage`. */
  uiLanguage: 'zh',
  promptLibrary: defaultPromptLibrary(),
  autoActivatePrompts: true,
  mainPromptKind: 'polish',
  mainPromptCardId: '',
  appRules: [],
  showModeInBar: true,
  liveCaptions: true,
  playSounds: true,
  /**
   * Off by default: rich insertion changes what the target receives (HTML as
   * well as plain text), and an app that does not understand the format shows
   * raw tags. The user opts in once they dictate into a document or a mail body.
   */
  richInsert: false,
  /**
   * Off by default: muting someone's music without being asked is worse than a
   * noisy transcript. The reference client ships the same switch defaulted off.
   */
  muteWhileRecording: false,
  /**
   * An open-source install does not choose a hosted service for the user.
   * The operator supplies their server in Account settings before signing in.
   */
  syncServerUrl: '',
  syncEnabled: false,
  /** Fifteen minutes: often enough to feel live, rare enough to stay invisible. */
  syncIntervalSeconds: 900
}

/** Applies a patch without resetting siblings in a settings group. Arrays replace. */
export function applySettingsPatch(current: Settings, patch: Partial<Settings>): Settings
export function applySettingsPatch(current: Partial<Settings>, patch: Partial<Settings>): Partial<Settings>
export function applySettingsPatch(current: Partial<Settings>, patch: Partial<Settings>): Partial<Settings> {
  const next = { ...current, ...patch }
  for (const key of ['hotkeys', 'asr', 'polish', 'multimodal', 'search', 'localAsr', 'chains', 'reminders', 'voiceCommands'] as const) {
    if (patch[key]) next[key] = { ...current[key], ...patch[key] } as never
  }
  if (patch.hotkeys?.bindings) {
    next.hotkeys!.bindings = { ...current.hotkeys?.bindings, ...patch.hotkeys.bindings } as Settings['hotkeys']['bindings']
  }
  if (patch.voiceCommands?.keywords) {
    next.voiceCommands!.keywords = { ...current.voiceCommands?.keywords, ...patch.voiceCommands.keywords } as Settings['voiceCommands']['keywords']
  }
  if (patch.search?.providers) {
    next.search!.providers = { ...current.search?.providers } as Settings['search']['providers']
    for (const key of Object.keys(patch.search.providers) as Array<keyof Settings['search']['providers']>) {
      next.search!.providers[key] = { ...current.search?.providers?.[key], ...patch.search.providers[key] }
    }
  }
  return next
}

/**
 * Merges a persisted (or partially supplied) settings object onto the
 * defaults, keeping nested groups intact so a single missing key never wipes a
 * whole section. Lives here rather than in main so it can be unit tested
 * without Electron.
 */
export function mergeSettings(input: Partial<Settings>): Settings {
  const base = structuredClone(DEFAULT_SETTINGS)
  const merged: Settings = {
    ...base,
    ...input,
    version: SETTINGS_VERSION,
    hotkeys: { ...base.hotkeys, ...(input.hotkeys ?? {}) },
    asr: { ...base.asr, ...(input.asr ?? {}) },
    polish: { ...base.polish, ...(input.polish ?? {}) },
    multimodal: { ...base.multimodal, ...(input.multimodal ?? {}) },
    search: { ...base.search, ...(input.search ?? {}) }
  }
  // A hand-edited config must not smuggle an unknown wire format in.
  merged.asr = { ...merged.asr, upload: pickEnum(merged.asr.upload, ['wav', 'opus'], 'wav') }

  merged.hotkeys.bindings = {
    ...base.hotkeys.bindings,
    ...(input.hotkeys?.bindings ?? {})  }
  merged.hotkeys.pasteLastKeys = {
    ...base.hotkeys.pasteLastKeys,
    ...(input.hotkeys?.pasteLastKeys ?? {})
  }
  merged.listPageSize = [10, 20, 30, 50, 100].includes(merged.listPageSize) ? merged.listPageSize : 30
  merged.hotkeys.selectionKeys = {
    ...base.hotkeys.selectionKeys,
    ...(input.hotkeys?.selectionKeys ?? {})
  }
  // New shortcuts must not take an existing custom chord. A cleared binding
  // remains cleared; only fields absent in an older version get a free default.
  const used = [
    ...Object.values(merged.hotkeys.bindings), merged.hotkeys.pasteLastKeys,
    merged.hotkeys.selectionKeys, input.hotkeys?.notesKeys ?? base.hotkeys.notesKeys,
    input.hotkeys?.selectionTranslateKeys ?? { keys: [] }, input.hotkeys?.reminderKeys ?? { keys: [] },
    input.hotkeys?.assistantKeys ?? { keys: [] }
  ].map(binding => [...(Array.isArray(binding) ? binding : binding.keys ?? [])].sort().join('+'))
  for (const [field, letters] of [['selectionTranslateKeys', ['T', 'Y', 'F9']], ['reminderKeys', ['R', 'F10', 'F11']], ['assistantKeys', ['A', 'F8', 'F12']]] as const) {
    const stored = input.hotkeys?.[field]
    const keys = stored?.keys ?? letters.map(letter => ['LeftCtrl', 'RightShift', letter])
      .find(chord => !used.includes([...chord].sort().join('+'))) ?? []
    merged.hotkeys[field] = { keys }
    used.push([...keys].sort().join('+'))
  }
  merged.selectionInsertMode = input.selectionInsertMode === 'append' ? 'append' : 'replace'
  merged.voiceCommands = normalizeVoiceCommands(input.voiceCommands)
  merged.reminders = {
    notifications: input.reminders?.notifications !== false,
    strongSound: input.reminders?.strongSound !== false,
    snoozeMinutes: [1, 5, 10, 15, 30, 60].includes(input.reminders?.snoozeMinutes ?? 5) ? input.reminders?.snoozeMinutes ?? 5 : 5
  }
  merged.hotkeys.notesKeys = {
    ...base.hotkeys.notesKeys,
    ...(input.hotkeys?.notesKeys ?? {})
  }
  // A settings file written before the toggle existed means "yes, bring the hub
  // forward": that was the only behaviour, so upgrading must not change it.
  merged.hotkeys.notesOpenApp =
    typeof input.hotkeys?.notesOpenApp === 'boolean'
      ? input.hotkeys.notesOpenApp
      : base.hotkeys.notesOpenApp
  merged.replacements = Array.isArray(input.replacements)
    ? normalizeReplacements(input.replacements)
    : base.replacements
  // A settings file written before suggestions existed simply has no key; a
  // hand-edited one may hold anything, so the pool is rebuilt from scratch.
  merged.suggestions = normalizeSuggestions(input.suggestions)
  merged.profiles = normalizeProfiles(input.profiles)
  merged.chains = normalizeChains(input.chains, merged.profiles)
  merged.inputDeviceId = typeof input.inputDeviceId === 'string' ? input.inputDeviceId : ''
  merged.polish.useBuiltInPrompts =
    typeof input.polish?.useBuiltInPrompts === 'boolean'
      ? input.polish.useBuiltInPrompts
      : base.polish.useBuiltInPrompts
  // `askPrompt` is additive now. Older builds stored the whole built-in Ask
  // prompt there — first an English one-liner, later the Chinese multi-rule
  // block — so anything still starting with those texts collapses back to
  // "no extra instructions" instead of being appended twice.
  const rawAsk = typeof input.polish?.askPrompt === 'string' ? input.polish.askPrompt.trim() : ''
  const legacyAsk =
    rawAsk.startsWith('You are a helpful assistant answering a spoken question') ||
    rawAsk === buildAskPrompt().trim()
  merged.polish.askPrompt = legacyAsk ? '' : rawAsk
  merged.polish.effort =
    typeof input.polish?.effort === 'string' ? input.polish.effort : base.polish.effort
  merged.polish.enabled = typeof merged.polish.enabled === 'boolean' ? merged.polish.enabled : base.polish.enabled
  merged.polish.temperature =
    typeof input.polish?.temperature === 'number' && Number.isFinite(input.polish.temperature)
      ? Math.min(1, Math.max(0, input.polish.temperature))
      : base.polish.temperature
  merged.hotkeys.enabled = typeof merged.hotkeys.enabled === 'boolean' ? merged.hotkeys.enabled : base.hotkeys.enabled
  merged.search.enabled = typeof merged.search.enabled === 'boolean' ? merged.search.enabled : base.search.enabled
  merged.search.decideWithModel = typeof merged.search.decideWithModel === 'boolean'
    ? merged.search.decideWithModel : base.search.decideWithModel
  merged.restoreClipboard = typeof input.restoreClipboard === 'boolean' ? input.restoreClipboard : base.restoreClipboard
  merged.launchAtStartup = typeof input.launchAtStartup === 'boolean' ? input.launchAtStartup : base.launchAtStartup
  merged.closeBehavior = input.closeBehavior === 'quit' ? 'quit' : 'background'
  merged.language = typeof input.language === 'string' ? input.language.trim() : base.language
  merged.notesDir = typeof input.notesDir === 'string' ? input.notesDir.trim() : base.notesDir
  merged.notePlaybackRate = typeof input.notePlaybackRate === 'number' && Number.isFinite(input.notePlaybackRate)
    ? Math.min(2, Math.max(0.75, input.notePlaybackRate)) : base.notePlaybackRate
  merged.barPosition =
    input.barPosition &&
    Number.isFinite(input.barPosition.x) &&
    Number.isFinite(input.barPosition.y)
      ? { x: Math.round(input.barPosition.x), y: Math.round(input.barPosition.y) }
      : null
  merged.activationMode = pickEnum(input.activationMode, ['hold', 'toggle'], base.activationMode)
  merged.pipelineMode = pickEnum(
    input.pipelineMode,
    ['classic', 'multimodal'],
    base.pipelineMode
  )
  merged.multiline = pickEnum(
    input.multiline,
    ['keep', 'space', 'shiftEnter'],
    base.multiline
  )
  merged.insertMethod = pickEnum(input.insertMethod, ['auto', 'sendinput', 'clipboard'], base.insertMethod)
  // Three appearances: two fixed palettes plus "follow the OS". The resolved
  // value is never stored, so a machine that flips between light and dark at
  // sunset keeps working without rewriting the settings file.
  merged.themeMode = pickEnum(input.themeMode, ['dark', 'light', 'system'], base.themeMode)
  merged.uiLanguage = pickEnum(input.uiLanguage, ['zh', 'en'], base.uiLanguage)
  // Translation targets: 1–3 distinct language codes. The legacy single
  // `translateTarget` is honoured for settings files written before v0.9, and
  // the flat field is kept as a mirror of the first entry so prompt builders
  // that still read it keep working (REQ-10).
  const rawTargets = Array.isArray(input.translateTargets) ? input.translateTargets : []
  const legacyTarget = typeof input.translateTarget === 'string' ? input.translateTarget.trim() : ''
  const candidates = (rawTargets.length > 0 ? rawTargets : [legacyTarget])
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
  merged.translateTargets = dedupeStrings(candidates).slice(0, MAX_TRANSLATE_TARGETS)
  if (merged.translateTargets.length === 0) merged.translateTargets = [...base.translateTargets]
  merged.translateTarget = merged.translateTargets[0]!
  merged.historyDurationSeconds = pickNumber(
    input.historyDurationSeconds,
    HISTORY_RETENTIONS,
    base.historyDurationSeconds
  )
  // 0 disables auto refresh; anything else is a poll interval the page sets.
  merged.historyRefreshSeconds = clampNumber(
    input.historyRefreshSeconds,
    0,
    600,
    base.historyRefreshSeconds
  )
  // The bar has no buttons, so a notice can only leave on a timer; the user
  // picks how long it stays.
  merged.alertHideSeconds = clampNumber(input.alertHideSeconds, 1, 60, base.alertHideSeconds)
  // The row cap is a destructive setting, so it is clamped like the timers
  // above: `-1` used to reach `prune()` as `entries.slice(0, -1)`, which dropped
  // the newest row (and its wav) on every load — a quiet way to lose the whole
  // history one take at a time.
  merged.disabledApps = normalizeAppList(input.disabledApps)
  merged.historyLimit = clampNumber(input.historyLimit, 1, 100_000, base.historyLimit)
  merged.keepAudio = pickEnum(input.keepAudio, ['never', 'always'], base.keepAudio)
  merged.audioProcessing = pickEnum(input.audioProcessing, ['fidelity', 'voice'], base.audioProcessing)
  merged.maxSessionSeconds = clampNumber(
    input.maxSessionSeconds,
    10,
    3600,
    base.maxSessionSeconds
  )
  merged.promptLibrary = normalizePromptLibrary(input.promptLibrary ?? base.promptLibrary)
  merged.autoActivatePrompts =
    typeof input.autoActivatePrompts === 'boolean'
      ? input.autoActivatePrompts
      : base.autoActivatePrompts
  merged.search.maxResults = clampNumber(input.search?.maxResults, 1, 10, base.search.maxResults)
  merged.search.provider = isSearchProvider(input.search?.provider)
    ? input.search.provider
    : base.search.provider
  // Per-provider config is the source of truth; the flat three fields are a
  // mirror of whichever provider is active, so switching provider can never
  // leave another backend's key behind.
  merged.search.providers = normalizeSearchProviders(input.search?.providers)
  merged.search.strategy = pickEnum(input.search?.strategy, ['single', 'fallback', 'aggregate'], 'single')
  merged.search.connections = normalizeSearchConnections(input.search?.connections)
  const activeEntry = merged.search.providers[merged.search.provider]
  merged.search.apiKey = activeEntry.apiKey
  merged.search.endpoint = activeEntry.endpoint
  merged.search.maxResults = activeEntry.maxResults
  merged.localAsr = {
    enabled: input.localAsr?.enabled === true,
    modelId: findModel(input.localAsr?.modelId) ? input.localAsr!.modelId : base.localAsr.modelId,
    modelDir: typeof input.localAsr?.modelDir === 'string' ? input.localAsr.modelDir : base.localAsr.modelDir,
    language: pickLanguage(input.localAsr?.modelId, input.localAsr?.language),
    mirror: input.localAsr?.mirror === 'official' ? 'official' : 'cn',
    idleUnloadMinutes: clampNumber(input.localAsr?.idleUnloadMinutes, 0, 60, base.localAsr.idleUnloadMinutes)
  }
  merged.multimodal.maxSeconds = clampNumber(
    input.multimodal?.maxSeconds,
    5,
    600,
    base.multimodal.maxSeconds
  )
  merged.mainPromptKind = pickEnum<PromptKind>(input.mainPromptKind, PROMPT_KINDS, 'polish')
  merged.mainPromptCardId =
    typeof input.mainPromptCardId === 'string' ? input.mainPromptCardId : ''
  merged.appRules = normalizeAppRules(input.appRules)
  merged.showModeInBar =
    typeof input.showModeInBar === 'boolean' ? input.showModeInBar : base.showModeInBar
  merged.playSounds = typeof input.playSounds === 'boolean' ? input.playSounds : base.playSounds
  merged.liveCaptions = typeof input.liveCaptions === 'boolean' ? input.liveCaptions : base.liveCaptions
  merged.richInsert = typeof input.richInsert === 'boolean' ? input.richInsert : base.richInsert
  merged.muteWhileRecording =
    typeof input.muteWhileRecording === 'boolean' ? input.muteWhileRecording : base.muteWhileRecording
  merged.syncServerUrl = normalizeServerUrl(input.syncServerUrl, base.syncServerUrl)
  merged.syncEnabled = typeof input.syncEnabled === 'boolean' ? input.syncEnabled : base.syncEnabled
  merged.syncIntervalSeconds = clampNumber(input.syncIntervalSeconds, 0, 86_400, base.syncIntervalSeconds)
  // Strict `=== true`: a missing or malformed value means "not done yet", which
  // is the harmless direction (the tour shows once more, nothing is lost).
  merged.onboarded = input.onboarded === true
  return merged
}

/**
 * Application names dictation is switched off in.
 *
 * Stored trimmed, lowercased, without `.exe` and without duplicates: the
 * foreground app reports `code`, the user is told the app is `Code.exe`, and both
 * paths in `pipeline.disabledAppNow()` have to agree. The cap keeps a pasted log
 * file from becoming the settings file.
 */
/**
 * Turns whatever the user typed into a base URL, or returns `fallback`.
 *
 * `192.168.1.5:8787`, `localhost:8787` and `https://host/` are all what people
 * actually type, so a missing scheme defaults to `http`. Anything that is not
 * http(s) is dropped rather than passed through: this string ends up in `fetch`,
 * and a `file://` or `javascript:` value there is a small disaster.
 */
export function normalizeServerUrl(input: unknown, fallback = ''): string {
  if (typeof input !== 'string') return fallback
  const trimmed = input.trim().replace(/\/+$/, '')
  // Callers may provide a fallback; the open-source default leaves it empty.
  if (!trimmed) return fallback
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback
    const path = url.pathname.replace(/\/+$/, '')
    return `${url.protocol}//${url.host}${path}`
  } catch {
    return fallback
  }
}

export function normalizeAppList(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of input) {
    if (typeof item !== 'string') continue
    const name = item.trim().toLowerCase().replace(/\.exe$/, '')
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
    if (out.length >= MAX_BLOCKED_APPS) break
  }
  return out
}

/**
 * Keeps only usable routing rules: at least one matcher (a `match` substring or a
 * `domain`), a known `kind`, and a unique id. Junk entries are dropped instead
 * of failing the whole settings load.
 */
function normalizeAppRules(input: unknown): AppRule[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: AppRule[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Partial<AppRule>
    const match = typeof raw.match === 'string' ? raw.match.trim() : ''
    const domain = normalizeDomain(raw.domain) ?? ''
    if (!match && !domain) continue
    const kind = pickEnum<PromptKind>(raw.kind, PROMPT_KINDS, 'polish')
    const id = typeof raw.id === 'string' && raw.id ? raw.id : `rule-${out.length}`
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      match,
      ...(domain ? { domain } : {}),
      kind,
      ...(typeof raw.label === 'string' && raw.label ? { label: raw.label } : {})
    })
  }
  return out
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

/** A number that must be one of a fixed set (retention windows, REQ-05). */
function pickNumber(value: unknown, allowed: readonly number[], fallback: number): number {
  return typeof value === 'number' && allowed.includes(value) ? value : fallback
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/**
 * A language the chosen model can actually be asked for.
 *
 * The picker is per model (Paraformer has no Japanese), so a stored 'ja' that
 * belongs to a model the user just switched away from has to collapse to 'auto'
 * rather than be handed to a recogniser that will ignore it.
 */
function pickLanguage(modelId: unknown, language: unknown): string {
  const model = findModel(typeof modelId === 'string' ? modelId : undefined)
  const options = model?.languages ?? ['auto']
  return typeof language === 'string' && options.includes(language) ? language : options[0]
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/** Upper bound on dictionary entries, mirrors the vendor's own cap. */
export const MAX_DICTIONARY_ENTRIES = 500
/** Upper bound on a single dictionary term. */
export const MAX_DICTIONARY_TERM = 64

/**
 * Upper bound on the suggestion pool. Ideas are cheap to collect and expensive
 * to review, so the pool is small and evicts the least recently seen row.
 */
export const MAX_SUGGESTIONS = 200

/** How many sightings of one idea make it worth showing as a suggestion. */
export const SUGGESTION_THRESHOLD = 3

/**
 * Normalizes the dictionary.
 *
 * Legacy entries were `{from, to}` only, so `mode`/`origin` default to
 * `replace`/`manual` and old data keeps behaving exactly as before. Entries
 * whose `from` is blank are dropped (an empty pattern would match everywhere),
 * duplicates collapse on a case-insensitive key, and the list is capped.
 */
export function normalizeReplacements(input: unknown): Replacement[] {
  if (!Array.isArray(input)) return []
  const out: Replacement[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const from = typeof record.from === 'string' ? record.from.trim() : ''
    if (!from) continue
    const key = from.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const term = from.slice(0, MAX_DICTIONARY_TERM)
    const to = typeof record.to === 'string' ? record.to.trim() : ''
    const mode = pickEnum<'replace' | 'hint'>(record.mode, ['replace', 'hint'], to ? 'replace' : 'hint')
    const origin = pickEnum<'auto' | 'manual'>(record.origin, ['auto', 'manual'], 'manual')
    const entry: Replacement = { from: term, to, mode, origin }
    if (typeof record.hits === 'number' && Number.isFinite(record.hits) && record.hits > 0) {
      entry.hits = Math.round(record.hits)
    }
    if (typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)) {
      entry.updatedAt = record.updatedAt
    }
    out.push(entry)
    if (out.length >= MAX_DICTIONARY_ENTRIES) break
  }
  return out
}

const SUGGESTION_STATUSES = ['pending', 'accepted', 'ignored'] as const

/** Narrows a persisted value to a suggestion status. */
function isSuggestionStatus(value: unknown): value is Suggestion['status'] {
  return (
    typeof value === 'string' && (SUGGESTION_STATUSES as readonly string[]).includes(value)
  )
}

/**
 * Normalizes the suggestion pool read back from disk.
 *
 * Unknown shapes are dropped instead of repaired: a row without a `from` can
 * never be turned into a term, and a row with an unknown `status` would either
 * resurrect an ignored idea or hide a pending one. `count` and the two
 * timestamps fall back to a single sighting so an older file still sorts
 * sensibly, and the cap mirrors `MAX_SUGGESTIONS`.
 */
export function normalizeSuggestions(input: unknown): Suggestion[] {
  if (!Array.isArray(input)) return []
  const out: Suggestion[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const from = typeof record.from === 'string' ? record.from.trim() : ''
    if (!from) continue
    // A row written before `status` existed means "not decided yet"; any other
    // unknown value is junk, and keeping it would hide or resurrect the idea.
    const status = record.status === undefined ? 'pending' : record.status
    if (!isSuggestionStatus(status)) continue
    const key = from.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const to = typeof record.to === 'string' ? record.to.trim() : ''
    out.push({
      from: from.slice(0, MAX_DICTIONARY_TERM),
      to: to.slice(0, MAX_DICTIONARY_TERM),
      mode: pickEnum<'replace' | 'hint'>(record.mode, ['replace', 'hint'], to ? 'replace' : 'hint'),
      count: Math.max(1, Math.round(positiveNumber(record.count, 1))),
      firstSeen: positiveNumber(record.firstSeen, 0),
      lastSeen: positiveNumber(record.lastSeen, 0),
      status
    })
    if (out.length >= MAX_SUGGESTIONS) break
  }
  return out
}

/** A finite, non-negative number, or `fallback` for anything else. */
function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** Hard cap on saved provider configurations; the UI cannot create more. */
export const MAX_PROFILES = 40

/** Hard cap on the app blocklist; nobody needs more and a paste cannot explode. */
export const MAX_BLOCKED_APPS = 100

const PROFILE_KINDS: ProviderKind[] = ['asr', 'llm', 'multimodal']

function isProviderKind(value: unknown): value is ProviderKind {
  return value === 'asr' || value === 'llm' || value === 'multimodal'
}

/**
 * Keeps only the string-valued entries of a vendor credential map, or
 * `undefined` when nothing survives. Azure (deployment, api-version), Tencent
 * (secret id, app id), Baidu (secret key) and Xfyun (api secret) all read their
 * extra credentials through this one field.
 */
function stringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') out[key] = raw
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Normalises saved provider configurations.
 *
 * A profile with no base URL is kept on purpose: the settings UI creates an
 * empty row first and fills it while the user types, and dropping it on every
 * keystroke save would make the form unusable. Identity is the only hard
 * requirement — a profile without an `id` cannot be referenced by a chain.
 *
 * Every field of `ProviderProfile` has to survive this rebuild. It runs on each
 * save (`mergeSettings` → here), so a field missing from the object below is not
 * "omitted once" — it is erased about 350 ms after the user types it. `vendor`
 * and `asrAdapter` were exactly that: the adapters read `cfg.vendor`, so those
 * profiles could never be called and the form kept showing "fields missing".
 */
export function normalizeProfiles(input: unknown): ProviderProfile[] {
  if (!Array.isArray(input)) return []
  const out: ProviderProfile[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (!id || seen.has(id)) continue
    if (!isProviderKind(record.kind)) continue
    seen.add(id)
    const preset = typeof record.preset === 'string' ? record.preset.trim() : ''
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    const extraHeaders =
      typeof record.extraHeaders === 'string' ? record.extraHeaders.trim() : ''
    const vendor = stringMap(record.vendor)
    const asrAdapter =
      typeof record.asrAdapter === 'string' ? record.asrAdapter.trim() : ''
    // Carried through so a load→save cycle does not throw the encrypted key away.
    // Dropping it here would mean every save rewrites the file without a key.
    const apiKeyEnc =
      typeof record.apiKeyEnc === 'string' ? record.apiKeyEnc.trim() : ''
    out.push({
      id,
      kind: record.kind,
      // Falls back to the preset name so a renamed-then-cleared row still has a
      // label in the chain editor instead of an empty chip.
      name: name || preset || mt('未命名'),
      preset,
      baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl.trim() : '',
      apiKey: typeof record.apiKey === 'string' ? record.apiKey : '',
      model: typeof record.model === 'string' ? record.model.trim() : '',
      ...(extraHeaders ? { extraHeaders } : {}),
      ...(record.authHeader === 'x-api-key' ? { authHeader: 'x-api-key' as const } : {}),
      ...(typeof record.requestPath === 'string' && record.requestPath.trim()
        ? { requestPath: record.requestPath.trim() }
        : {}),
      ...(vendor ? { vendor } : {}),
      ...(asrAdapter ? { asrAdapter } : {}),
      ...(apiKeyEnc ? { apiKeyEnc } : {}),
      enabled: record.enabled !== false
    })
    if (out.length >= MAX_PROFILES) break
  }
  return out
}

/**
 * Keeps each kind's chain pointing at profiles that still exist, in order.
 * A dangling id would silently shorten the chain, which looks like a provider
 * being skipped for no reason, so unknown ids are dropped here once.
 */
export function normalizeChains(
  input: unknown,
  profiles: ProviderProfile[]
): Record<ProviderKind, string[]> {
  const known = new Set(profiles.map((profile) => profile.id))
  const out: Record<ProviderKind, string[]> = { asr: [], llm: [], multimodal: [] }
  if (!input || typeof input !== 'object') return out
  const record = input as Record<string, unknown>
  for (const kind of PROFILE_KINDS) {
    const raw = record[kind]
    if (!Array.isArray(raw)) continue
    const seen = new Set<string>()
    for (const item of raw) {
      if (typeof item !== 'string') continue
      const id = item.trim()
      if (!id || !known.has(id) || seen.has(id)) continue
      seen.add(id)
      out[kind].push(id)
    }
  }
  return out
}
