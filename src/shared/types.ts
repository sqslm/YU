export type Mode = 'dictation' | 'translate' | 'ask'
export type VoiceCommandMode = Mode | 'reminder' | 'notes'
export interface VoiceCommandsSettings {
  enabled: boolean
  smartRouting: boolean
  keywords: Record<VoiceCommandMode, string[]>
}

/** Public capabilities returned by the self-hosted account server. */
export interface ServerMeta {
  version: string
  protocolVersion: number
  registrationEnabled: boolean
  emailVerificationRequired: boolean
  smtpConfigured: boolean
  features: { passwordReset: boolean; notes: boolean; notesAudio: boolean; history: boolean }
}

/** How a shortcut starts and stops capture. */
export type ActivationMode = 'hold' | 'toggle'
export type AudioProcessingMode = 'fidelity' | 'voice'

/** How newlines inside generated text are delivered. */
export type MultilineMode = 'keep' | 'space' | 'shiftEnter'

/** Which pipeline turns audio into text. */
export type PipelineMode = 'classic' | 'multimodal'

/** A literal find/replace pair applied to the final text. */
export interface Replacement {
  from: string
  to: string
  /**
   * `replace` (default) rewrites every literal hit; `hint` only feeds the model
   * glossary and never touches the text, which is what a spelling-only dictionary
   * entry needs (an empty `to` on a replace pair would delete the word).
   */
  mode?: 'replace' | 'hint'
  /** Where the entry came from: `auto` was learned from edits, `manual` was typed. */
  origin?: 'auto' | 'manual'
  /** How many times an auto-learned entry has been seen. */
  hits?: number
  /** Epoch ms of the last confirmation, for sorting the dictionary list. */
  updatedAt?: number
}

/**
 * One learned-but-unconfirmed dictionary idea.
 *
 * Post-insertion edits are noisy: a typo fix, a one-off rewording or a slip of
 * the hand all look the same as a real term. So an idea is only ever collected
 * here, it never reaches a prompt, and the dictionary page offers it as a
 * suggestion once the same `from` has been seen `SUGGESTION_THRESHOLD` times.
 */
export interface Suggestion {
  /** The spelling the edits introduced, i.e. what belongs in the dictionary. */
  from: string
  /** Target spelling; `''` means "glossary hint only", as on `Replacement`. */
  to: string
  mode: 'replace' | 'hint'
  /** How many times this exact idea has been observed. */
  count: number
  firstSeen: number
  lastSeen: number
  /**
   * `ignored` and `accepted` rows are kept on purpose: they remember the
   * decision, so the same idea is neither suggested nor counted again.
   */
  status: 'pending' | 'accepted' | 'ignored'
}

/**
 * One manual routing entry: when the foreground window's process name or title
 * contains `match`, dictation uses the prompt `kind` instead of the classifier's
 * guess. The classifier only knows a fixed list of apps, so anything unusual
 * (an Electron app with a generic title, a terminal running a CLK, …) needs a
 * rule the user can add from the settings page.
 */
export interface AppRule {
  id: string
  /** Case-insensitive substring of the process name (`appName`) or window title. */
  match: string
  /**
   * Optional site rule: a bare domain, a subdomain, or `*.domain`. When the
   * focused window exposes a domain in its title this wins over `match`, so one
   * app can route several sites to different prompts.
   */
  domain?: string
  /** Human label captured with the rule, e.g. "dsh — 对话框". */
  label?: string
  kind: PromptKind
}

export interface ProviderSettings {
  /** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 */
  baseUrl: string
  apiKey: string
  /** ASR model name, e.g. whisper-1 / gpt-4o-mini-transcribe / whisper-large-v3 */
  model: string
  /** Extra request headers, one "Name: value" per line. */
  extraHeaders?: string
  /**
   * How the key travels. Official OpenAI/Mistral use Bearer; a custom gateway
   * may require x-api-key.
   */
  authHeader?: 'bearer' | 'x-api-key'
  /**
   * Chat path relative to `baseUrl`, for custom gateways that override the
   * standard /chat/completions path.
   */
  requestPath?: string
  /**
   * Fields a vendor needs that the generic four (base URL, key, model, path) do
   * not cover: Azure wants a deployment and an api-version, Tencent wants a
   * secret id and an app id, Baidu wants an API key *and* a secret key.
   *
   * They live in one map instead of a dozen optional members so a new vendor adds
   * data (`PresetField[]`) rather than a schema change, and so old settings files
   * need no migration.
   */
  vendor?: Record<string, string>
  /**
   * Which transcription wire protocol this profile speaks. Absent means the
   * OpenAI multipart form; anything else knows its own request shape and its own
   * way of coming back with the text.
   *
   * Resolved from the preset id, then from the host, so a profile created before
   * this field existed still routes correctly.
   */
  asrAdapter?: string
  /**
   * The on-disk form of `apiKey`: base64 of an OS-encrypted blob written by
   * `SettingsStore`. Main decrypts it back into `apiKey` at load time and clears
   * this field in memory, so nothing outside the settings store ever sees it.
   *
   * It exists because `settings.json` is a plain file in the user's profile:
   * before this, opening it (or any backup, sync folder, or support bundle that
   * included it) printed every provider credential in clear text.
   */
  apiKeyEnc?: string
}

/**
 * One extra field a preset needs before it can be called.
 *
 * `required: false` fields are optional tuning (region, api-version with a
 * default); the UI shows them but does not block saving on them.
 */
export interface PresetField {
  key: string
  label: string
  hint?: string
  required?: boolean
  placeholder?: string
  /** Default written into a new profile, so the common case needs no typing. */
  value?: string
}

/** The three kinds of provider the app can talk to. */
export type ProviderKind = 'asr' | 'llm' | 'multimodal'

/**
 * One saved provider configuration.
 *
 * Settings used to hold exactly one endpoint per kind, which made "try my
 * provider, then the cloud one" impossible and forced users to overwrite their
 * only working config to try something new. A profile is that same endpoint with
 * an identity, so profiles can be kept, disabled, and ordered into a chain.
 */
export interface ProviderProfile extends ProviderSettings {
  id: string
  /** Display name, defaults to the preset name at creation time. */
  name: string
  kind: ProviderKind
  /** Built-in preset id this was created from, `''` when hand-written. */
  preset: string
  /** Disabled profiles keep their settings but are skipped by the chain. */
  enabled: boolean
}

/**
 * ASR provider plus wire-format choice.
 *
 * `wav` is the default because it is the only format every OpenAI-compatible
 * gateway decodes; `opus` shrinks a minute of speech from ~2.8 MB to ~180 KB but
 * needs ffmpeg on the client *and* an Ogg/Opus-capable server.
 */
export interface AsrSettings extends ProviderSettings {
  upload: 'wav' | 'opus'
}

export interface PolishSettings {
  enabled: boolean
  /** LLM base URL (may differ from the ASR provider). */
  baseUrl: string
  apiKey: string
  /** Encrypted on-disk form of `apiKey`; see `ProviderSettings.apiKeyEnc`. */
  apiKeyEnc?: string
  model: string
  extraHeaders?: string
  /** Path override for vendors that do not serve `/chat/completions`. */
  requestPath?: string
  /** Where the key goes when the vendor refuses `Authorization: Bearer`. */
  authHeader?: 'bearer' | 'x-api-key'
  /**
   * UI-facing reasoning effort, e.g. 'off' | 'low' | 'high' | 'max' | '' for
   * "whatever the model defaults to". `off` is a local concept only: it is sent
   * as `thinking: { type: 'disabled' }`, never as `reasoning_effort`.
   */
  effort: string
  /** System prompt used for dictation polishing. */
  systemPrompt: string
  /** System prompt used for translation mode. */
  translatePrompt: string
  /** System prompt used for Ask Anything mode. */
  askPrompt: string
  /**
   * When true, the prompts above are ignored and the built-in, context-aware
   * prompts from `@shared/prompts` are used. Turns off as soon as the user edits
   * a prompt by hand.
   */
  useBuiltInPrompts: boolean
  temperature: number
}

export interface ShortcutBinding {
  /** Ordered key tokens; the first token is the hold key. */
  keys: string[]
}

/**
 * Search backends the settings can name.
 *
 * Every member here has a real adapter in `main/providers/search.ts`: a saved
 * setting that cannot actually search is worse than no setting at all.
 * `searchProviders.ts` carries the per-provider flags (does it need a key, does
 * it need an endpoint of its own).
 */
export type SearchProvider =
  | 'tavily'
  | 'brave'
  | 'searxng'
  | 'duckduckgo'
  | 'exa'
  | 'serper'
  | 'bing'
  | 'google-cse'
  | 'jina'
  | 'perplexity'
  | 'zhipu-web'
  | 'baidu'
  | 'deepseek'

/**
 * One provider's own credentials. Kept per provider so switching the active
 * backend can never leave another provider's key or endpoint behind — the old
 * single-slot shape is what made the key look "stuck".
 */
export interface SearchProviderEntry {
  apiKey: string
  apiKeyEnc?: string
  endpoint: string
  maxResults: number
}

export interface SearchConnection extends SearchProviderEntry {
  id: string
  name: string
  provider: SearchProvider
  enabled: boolean
}

export interface SearchProbeResult {
  ok: boolean
  count: number
  durationMs: number
  message?: string
}

export interface SearchSettings {
  enabled: boolean
  strategy: 'single' | 'fallback' | 'aggregate'
  connections: SearchConnection[]
  /** Which backend answers the query. */
  provider: SearchProvider
  /** Per-provider settings; always contains an entry for every provider. */
  providers: Record<SearchProvider, SearchProviderEntry>
  /** Ask the model first whether the question actually needs the web. */
  decideWithModel: boolean
  /**
   * Derived mirror of `providers[provider]`, recomputed on every settings merge.
   * Search code reads these three so it stays provider-agnostic.
   */
  apiKey: string
  endpoint: string
  maxResults: number
}

export interface MultimodalSettings {
  baseUrl: string
  apiKey: string
  /** Encrypted on-disk form of `apiKey`; see `ProviderSettings.apiKeyEnc`. */
  apiKeyEnc?: string
  model: string
  extraHeaders?: string
  /** Hard cap on how much audio one request may carry. */
  maxSeconds: number
}

/** A user-defined bucket for notes. Deleting one never deletes its notes. */
export interface NoteCategory {
  id: string
  name: string
}

export type NoteExportFormat = 'markdown' | 'text'

/** A long-lived voice note: recording + transcript + light polish + tags. */
export interface NoteEntry {
  id: string
  createdAt: number
  updatedAt: number
  durationMs: number
  transcript: string
  polished: string
  polishStatus: 'pending' | 'ok' | 'failed' | 'skipped'
  polishError?: string
  audioPath?: string
  audioFormat?: 'ogg' | 'wav'
  audioBytes?: number
  categoryId?: string
  tags: string[]
  /** Set the first time the user edits either text by hand. */
  editedAt?: number
  /**
   * The server's version of this note. Absent means "never pushed": the row only
   * exists on this machine. Every accepted change to the server bumps it, and it
   * is what the server checks before it applies an edit, so it must survive a
   * restart exactly as the server last reported it.
   */
  version?: number
  /** A local change the server has not accepted yet. */
  pending?: boolean
  /** The server already holds this note's recording (a local bookkeeping fact). */
  audioUploaded?: boolean
}

/**
 * A note the user deleted while the server still knows about it.
 *
 * Keeping the id (and the version it had) is what lets the deletion travel to
 * the server on the next sync instead of the note reappearing on the other
 * machine. Dropped once the server confirms it.
 */
export interface NoteTombstone {
  id: string
  version: number
  deletedAt: number
}

export interface NoteStore {
  notes: NoteEntry[]
  categories: NoteCategory[]
  deleted?: NoteTombstone[]
}

export type NotePatch = Partial<
  Pick<NoteEntry, 'transcript' | 'polished' | 'categoryId' | 'tags'>
>

/**
 * One change applied to a whole selection from the notes sidebar.
 *
 * `categoryId: null` clears the category (the sidebar's "移出分类"), `delete`
 * wins over everything else, and `addTags`/`removeTags` go through the same
 * normaliser as a single-note edit so a batch cannot smuggle in junk tags.
 */
export interface NoteBulk {
  categoryId?: string | null
  addTags?: string[]
  removeTags?: string[]
  delete?: boolean
}

/**
 * The built-in local recogniser (sherpa-onnx).
 *
 * Deliberately independent of the provider profiles: a profile points at an HTTP
 * service, while these four fields describe files on this disk. `modelDir` empty
 * means "search the usual places", which is what makes the page able to say
 * "已经在这台电脑上了" without the user configuring anything.
 */
export interface LocalAsrSettings {
  /** Send dictation through the local model instead of the ASR provider. */
  enabled: boolean
  /** Id from `@shared/local-asr`; the renderer and the main process share it. */
  modelId: string
  /** Folder that holds the model files; empty means auto-detect. */
  modelDir: string
  /** Language hint handed to the recogniser; 'auto' lets the model decide. */
  language: string
  /** Which host to download from; the CN mirror is the same bytes. */
  mirror: 'official' | 'cn'
  /** Unload idle native weights after these minutes; 0 keeps them loaded. */
  idleUnloadMinutes: number
}

export interface ResourceUsage {
  measuredAt: number
  /** Private physical RAM, excluding shared pages; null when unavailable. */
  privateResidentBytes: number | null
  workingSetBytes: number
  committedBytes: number | null
  processes: Array<{
    pid: number
    role: string
    privateResidentBytes: number | null
    workingSetBytes: number
    committedBytes: number | null
  }>
  localModel: { loaded: boolean; autoResume: boolean }
}

/** Logical strip offset inside the transparent window shared with captions. */
export interface BarWindowLayout {
  barTop: number
  captionSide: 'above' | 'below'
}

export interface Settings {
  version: number
  hotkeys: {
    enabled: boolean
    bindings: Record<Mode, ShortcutBinding>
    pasteLastKeys: ShortcutBinding
    selectionKeys: ShortcutBinding
    selectionTranslateKeys: ShortcutBinding
    reminderKeys: ShortcutBinding
    assistantKeys: ShortcutBinding
    screenshotKeys: ShortcutBinding
    /**
     * Starts and stops a 随记 (voice note) take from anywhere: the hub opens on
     * the notes page and the recorder toggles. Kept out of `bindings` because a
     * note is not a `Mode` — it never inserts text and never writes history.
     */
    notesKeys: ShortcutBinding
    /**
     * Whether pressing the 随记 chord brings the hub forward on the notes page, or
     * records behind whatever the user is doing. Off is the "just capture it"
     * mode: the take still runs and still saves, the window never jumps in front.
     */
    notesOpenApp: boolean
  }
  asr: AsrSettings
  selectionInsertMode: 'replace' | 'append'
  /** Empty uses the Windows known Downloads folder. */
  assistantDownloadFolder: string
  voiceCommands: VoiceCommandsSettings
  wakeWord: { enabled: boolean; phrase: string }
  reminders: { notifications: boolean; strongSound: boolean; snoozeMinutes: number }
  polish: PolishSettings
  /** 'classic' = ASR + text LLM, 'multimodal' = one audio-in model does both. */
  pipelineMode: PipelineMode
  multimodal: MultimodalSettings
  search: SearchSettings
  /** Built-in local recogniser; see `LocalAsrSettings`. */
  localAsr: LocalAsrSettings
  /** Hold-to-talk or press-to-toggle. */
  activationMode: ActivationMode
  /** BCP-47 language hint for ASR, e.g. "zh" or "" for auto. */
  language: string
  /**
   * Legacy single translation target, still read for old settings files.
   * `mergeSettings` copies it into `translateTargets` on first load (REQ-10).
   */
  translateTarget: string
  /** 1–3 translation targets; translation mode emits one block per target. */
  translateTargets: string[]
  /** MediaDeviceInfo.deviceId of the preferred microphone, "" for system default. */
  inputDeviceId: string
  /** Literal post-processing pairs applied after the LLM step (glossary fixes). */
  replacements: Replacement[]
  /**
   * Ideas learned from the user's edits, still waiting for confirmation. Kept
   * out of every glossary until the user accepts one on the dictionary page.
   */
  suggestions: Suggestion[]
  /**
   * `auto` types when it can and pastes otherwise; the other two force one route.
   * A fourth value, `uia`, used to be listed here: no code path implemented it, the
   * UI never offered it, and `insertText` fell through to the clipboard — so a
   * stored `uia` silently meant `clipboard`. Removed rather than left as a promise.
   */
  insertMethod: 'auto' | 'sendinput' | 'clipboard'
  /** What to do with newlines when typing text directly. */
  multiline: MultilineMode
  restoreClipboard: boolean
  launchAtStartup: boolean
  closeBehavior: 'background' | 'quit'
  /**
   * Set once the first-run tour is finished or skipped. Kept in settings rather
   * than `localStorage` so it survives a cache clear and can be reset from the
   * settings file, which is what "reset onboarding" means to a tester.
   */
  onboarded: boolean
  showBarOnDesktop: boolean
  /** Last dragged position of the recording bar, null means "auto (bottom centre)". */
  barPosition: { x: number; y: number } | null
  /**
   * Applications where the recording hotkey does nothing. Lowercase process or
   * window-class names without `.exe`; `pipeline.start()` compares both, so a
   * packaged app (`ApplicationFrameWindow`) can be blocked either way.
   */
  disabledApps: string[]
  listPageSize: number
  historyLimit: number
  /**
   * Retention window in seconds: `-1` forever, `0` never persist, otherwise
   * 86400 / 604800 / 2592000 / 31536000 (REQ-05).
   */
  historyDurationSeconds: number
  /** Auto-refresh interval of the history page, in seconds (0 = off). */
  historyRefreshSeconds: number
  /** Where notes (database + audio) live; empty means the app's userData folder. */
  notesDir: string
  /** Remembered playback speed for the notes player. */
  notePlaybackRate: number
  /**
   * How long an error/notice pill stays on screen before it hides itself, in
   * seconds. The bar has no buttons by design, so this is the only way a notice
   * goes away.
   */
  alertHideSeconds: number
  /** Successful take audio only. Legacy `failed` is normalised to `never`. */
  keepAudio: 'never' | 'failed' | 'always'
  /** Fidelity preserves the input; voice enables Chromium noise/gain processing. */
  audioProcessing: AudioProcessingMode
  /** Hard cap for one take; the bar warns one minute before it (REQ-17). */
  maxSessionSeconds: number
  arrowToCursorInBar: boolean
  /** UI palette; toggled from the sidebar sun/moon button. */
  themeMode: ThemeMode
  /**
   * Language of the interface itself.
   *
   * Deliberately separate from `language`, which is the recogniser hint: someone
   * dictating in Japanese still wants to read the settings in Chinese, and while
   * both lived on one field the 「语音识别语言」 dropdown silently flipped the whole
   * app into English — which is why no language switch was findable afterwards.
   */
  uiLanguage: 'zh' | 'en'
  /** Named prompt cards per task type; see `@shared/promptLibrary`. */
  promptLibrary: PromptLibrary
  /**
   * Saved provider configurations. The legacy `asr` / `polish` / `multimodal`
   * blocks stay as the fallback for configs written before profiles existed.
   */
  profiles: ProviderProfile[]
  /**
   * Ordered failover chain per kind: ids into `profiles`. The first enabled
   * entry that answers wins; an empty chain means "use the legacy block".
   */
  chains: Record<ProviderKind, string[]>
  /**
   * Pick the prompt card from the app in the foreground. Turning this off pins
   * dictation to `mainPromptKind` + `mainPromptCardId` — one card everywhere.
   */
  autoActivatePrompts: boolean
  /** Task type used when auto-activation is off. */
  mainPromptKind: PromptKind
  /** Card id used when auto-activation is off; '' means the kind's active card. */
  mainPromptCardId: string
  /**
   * Manual routing table for windows the automatic classifier gets wrong.
   * `match` is a case-insensitive substring of the process name or window
   * title (e.g. "dsh", "DeepSeek Harness"); the first hit wins.
   */
  appRules: AppRule[]
  /** Show the current mode label next to the recording bar's indicator. */
  showModeInBar: boolean
  /** Additional bounded ASR requests while recording, for a provisional caption. */
  liveCaptions: boolean
  /**
   * Short synthesised cues on start / finish / failure. Generated with WebAudio
   * so the app ships no audio assets and the cues follow the system volume.
   */
  playSounds: boolean
  /**
   * Paste formatting along with the text when the result contains Markdown.
   *
   * The clipboard carries both the plain text and an HTML rendering, and the
   * target keeps whichever it understands — Word and Outlook style the list,
   * Notepad takes the text. Off by default because an app that does not decode
   * the HTML would show the tags.
   */
  richInsert: boolean
  /**
   * Mute the default playback device while a take is recording (OPT-09).
   *
   * The microphone is an input device, so muting playback does not silence the
   * dictation; the previous mute state is restored when the take ends, so a
   * user who keeps the machine muted does not get sound switched on. Off by
   * default: silently muting someone's music is worse than a noisy transcript.
   */
  muteWhileRecording: boolean
  /**
   * Where the self-hosted server lives, e.g. `http://192.168.1.5:8787`.
   *
   * Blank means no server configured. Synchronization requires a signed-in
   * account and `syncEnabled`; provider traffic uses its own configured URLs.
   */
  syncServerUrl: string
  /** Sync history, notes and note audio to the signed-in session's server. */
  syncEnabled: boolean
  /**
   * How often the app pulls changes, in seconds. `0` disables the timer and leaves
   * syncing to the manual button, which is what a metered connection wants.
   */
  syncIntervalSeconds: number
}

/**
 * Prompt task types. `polish` is the default dictation prompt, `document` and
 * `email` are picked automatically from the app the user is dictating into, and
 * `translate` backs translation mode.
 */
export type PromptKind = 'ai' | 'polish' | 'translate' | 'document' | 'email'

/** One editable prompt. `builtin` cards fall back to the context-aware prompt. */
export interface NamedPrompt {
  id: string
  name: string
  content: string
  builtin?: boolean
  /** Per-card sampling temperature; undefined falls back to the polish setting. */
  temperature?: number
}

export interface PromptLibrary {
  cards: Record<PromptKind, NamedPrompt[]>
  /** Which card is used for each kind. */
  active: Record<PromptKind, string>
}

/**
 * The three appearances the settings offer.
 *
 * `'system'` is a real option again, but it is resolved rather than rendered: the
 * renderer looks at `prefers-color-scheme`, main looks at
 * `nativeTheme.shouldUseDarkColors`, and both repaint when the OS flips. The
 * difference from the old footer toggle is that this is a named choice in the
 * settings list — nothing silently cycles through it.
 */
export type ThemeMode = 'dark' | 'light' | 'system'

/**
 * New takes are stored only as completed; archived is a successful result put
 * away by the user. Other statuses remain readable for old history and cleanup.
 */
export type HistoryStatus = 'completed' | 'dismissed' | 'empty' | 'error' | 'archived'

/** How far the post-insert diff capture got (REQ-06). */
export type EditedStatus = 'NOT_EXTRACTED' | 'UNCHANGED' | 'EXTRACTED'

/**
 * One per-take session log, as listed by 设置 → 关于 → 最近几次听写.
 *
 * Mirrors the reference client's `recording-event:read-index`: every take gets
 * its own file so a failure report names one take instead of a time window in a
 * rolling log. `open` means the take never wrote its closing line — the app was
 * killed mid-take.
 */
export interface RecordingSessionInfo {
  id: string
  startedAt: number
  endedAt: number | null
  mode: string
  appName: string
  windowTitle: string
  status: 'done' | 'cancelled' | 'error' | 'empty' | 'open'
  lines: number
  bytes: number
}

/** UIA control class of the field the text was typed into (REQ-03). */
export type InputAreaType = 'edit' | 'document' | 'chat' | 'terminal' | 'unknown'

export interface HistoryEntry {
  id: string
  createdAt: number
  /**
   * Last time this row changed, used as the sync tie-breaker: a merge keeps
   * whichever copy of the same id has the larger stamp. Absent on rows written
   * before sync existed; readers fall back to `createdAt`.
   */
  updatedAt?: number
  mode: Mode
  transcript: string
  final: string
  durationMs: number
  /** Foreground window title that received the text. */
  app: string
  error?: string
  /** Web pages the answer was grounded on (Ask + search). */
  sources?: SearchResult[]
  /** Which route produced the text: classic ASR+LLM or a multimodal model. */
  route?: PipelineMode
  /** Missing on entries written before v0.9; readers must default to `completed`. */
  status?: HistoryStatus
  /** Set when an error classification produced a bar alert (REQ-12). */
  alertKind?: string
  /** How many times a retry was attempted for this entry (REQ-02). */
  attempts?: number
  /** Relative path under `<userData>/audio/` when the wav was kept (REQ-07). */
  audioPath?: string
  /** Characters (CJK) or words (latin) of `final`, see `@shared/count` (REQ-07). */
  wordCount?: number
  /** Full path of the foreground process, for per-app stats (REQ-07). */
  appPath?: string
  /** Untruncated foreground window title, `app` stays as the display label. */
  focusedWindowTitle?: string
  /** What the user changed after insertion; absent when untouched (REQ-06). */
  editedText?: string
  editedStatus?: EditedStatus
  /** True when the user undid the AI text outright (REQ-06). */
  hasRevertedAI?: boolean
  inputAreaType?: InputAreaType
  /** Language the ASR reported, if the provider returns one (REQ-10). */
  lang?: string
  /**
   * Which prompt card actually produced `final`. Recorded per take because the
   * same app can route to different cards over time; without it the history
   * cannot answer "why did this one come out as an email".
   */
  promptKind?: PromptKind
  promptId?: string
  promptName?: string
  /** Saved provider profile that answered this take; absent when the legacy block did. */
  providerId?: string
  providerName?: string
}

/**
 * What the server says about this account's plan.
 *
 * `active` is the only field a client should gate on: a trial that ended and a
 * subscription that lapsed both arrive as `active: false` with a different `plan`.
 */
export interface SubscriptionInfo {
  plan: string
  active: boolean
  trialEndsAt: number | null
  currentPeriodEnd: number | null
  cancelAtPeriodEnd: boolean
}

/** The account as the settings UI shows it. Never carries a token. */
export interface AccountView {
  signedIn: boolean
  /** `account.json` exists but its tokens cannot be decrypted: sign in again. */
  needsSignIn: boolean
  email: string
  serverUrl: string
  subscription: SubscriptionInfo | null
  /** Rows the server holds, as of the last pull; -1 when never synced. */
  remoteCount: number
  /** Server-side storage accounting, or null when it has not been read yet. */
  storage: StorageUsage | null
  lastSyncAt: number
  lastError: string
}

/** What `GET /user/storage` reports: the quota the account is held to. */
export interface StorageUsage {
  usedBytes: number
  quotaBytes: number
  noteCount: number
  audioCount: number
  maxAudioUploadBytes: number
}

export type SyncState = 'off' | 'idle' | 'syncing' | 'error'

export interface SyncStatus {
  enabled: boolean
  state: SyncState
  /** Local rows changed since the last successful push. */
  pending: number
  lastSyncAt: number
  lastError: string
}

export type BarAlertKind =
  | 'busy'
  | 'no_provider'
  | 'no_network'
  | 'weak_network'
  | 'auth'
  | 'rate_limit'
  | 'server_error'
  | 'mic_missing'
  | 'mic_denied'
  | 'asr_failed'
  | 'llm_failed'
  | 'empty_audio'
  | 'too_short'
  | 'session_warning'
  | 'cancelled'
  | 'update_available'
  | 'auto_language_detected'
  | 'better_microphone'
  | 'hands_free'
  | 'app_disabled'
  | 'reminder'
  | 'selection'

export type BarAlertLevel = 'info' | 'warn' | 'error'

/** Buttons a bar alert may carry; each one has a real handler in main (REQ-01). */
export type BarActionId =
  | 'retry'
  | 'cancel'
  | 'copy'
  | 'open_settings'
  | 'choose_mic'
  | 'download'
  | 'dismiss'
  | 'undo-reminder'

export interface BarAction {
  id: BarActionId
  label: string
}

/**
 * One floating-bar alert. `actions` makes the alert sticky: the bar stays
 * interactive until the user clicks something or a new take starts.
 */
export interface BarAlert {
  kind: BarAlertKind
  level: BarAlertLevel
  text: string
  actions?: BarAction[]
}

export interface TranscriptionResult {
  text: string
  durationMs: number
}

export type HotkeyEvent =
  | { type: 'start'; mode: Mode; at: number; handsFree?: boolean; purpose?: 'reminder' }
  | { type: 'mode'; mode: Mode; at: number }
  | { type: 'stop'; mode: Mode; at: number }
  | { type: 'paste-last'; at: number }
  | { type: 'error'; message: string }

export type BarState =
  | { phase: 'idle' }
  | {
      phase: 'recording'
      mode: Mode
      since: number
      activation?: ActivationMode
      /** True while a double-press take runs without the key held (REQ-16). */
      handsFree?: boolean
      /** Mirror of `Settings.showModeInBar`; false hides the mode label. */
      showMode?: boolean
      /** Name of the task's selected library card; omitted for card-free modes. */
      promptName?: string
      taskLabel?: string
    }
  | { phase: 'working'; mode: Mode; hint?: string; showMode?: boolean; promptName?: string; taskLabel?: string }
  | { phase: 'done'; mode: Mode; text: string; showMode?: boolean; taskLabel?: string;
      /** Task receipt shown above the strip, separate from live ASR captions. */
      feedback?: { failed?: boolean } }
  /** A non-fatal notice (busy, language detected, mic advice) — REQ-01. */
  | { phase: 'alert'; alert: BarAlert }
  | { phase: 'error'; message: string; alert?: BarAlert }

/** One web search hit, normalised across providers. */
export interface SearchResult {
  title: string
  url: string
  snippet: string
  /** ISO date when the provider reports one (Tavily does). */
  publishedAt?: string
}

/**
 * One entry of `GET {baseUrl}/models`. Only the fields this app acts on are
 * typed; the gateway has many more (`credits`, `vendor`, `supports_images`…).
 */
export interface ModelInfo {
  id: string
  name?: string
  description?: string
  contextLength?: number
  maxOutputTokens?: number
  supportsReasoning?: boolean
  onlyReasoning?: boolean
  reasoningSupportedEfforts?: string[]
  reasoningDefaultEffort?: string
  /** True only when the gateway really honours `thinking: {type:'disabled'}`. */
  canDisableThinking?: boolean
}

export interface ModelListResult {
  models: ModelInfo[]
  /** Epoch ms of the fetch that produced this list. */
  fetchedAt: number
  /** True when the live request failed and the cached list was kept. */
  cached: boolean
  error?: string
}

export type CardActionId = 'copy' | 'replace' | 'ask' | 'stop' | 'open-item' | 'screenshot-accept' | 'screenshot-cancel' | 'selection-polish' | 'selection-translate' | 'selection-replace' | 'selection-append'

export interface CardAction {
  id: CardActionId
  label: string
  /** Extra text the action needs, e.g. the original selection to replace. */
  payload?: string
}

/** What the answer card renders. Kept in shared because the preload bridges it. */
export interface AnswerCardPayload {
  assistant?: boolean
  localResults?: import('./assistant').AssistantLocalResult[]
  screenshot?: import('./assistant').ScreenshotPreview
  question: string
  answer: string
  sources?: SearchResult[]
  /** Transient line such as "正在查询天气…" while tools run. */
  status?: string
  /** Tool names that ran, for the small footer chip. */
  tools?: string[]
  actions?: CardAction[]
  /** True when the answer is still arriving and the card should not be hidden. */
  streaming?: boolean
  /** A user-stopped partial answer is readable but is not a completed history entry. */
  stopped?: boolean
  selection?: boolean
  /** Actual retrieval outcome; never inferred from whether search is enabled. */
  retrieval?: AskRetrieval
}

export interface AskRetrieval {
  searched: boolean
  failed: boolean
  queries: string[]
  pagesRead: number
  digest: boolean
  partial: boolean
}

export interface ShortcutKeyEvent { token: string; down: boolean }
