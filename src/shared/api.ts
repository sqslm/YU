import type {
  AccountView,
  ShortcutKeyEvent,
  BarActionId,
  BarState,
  CardAction,
  HistoryEntry,
  ModelListResult,
  NoteBulk,
  NoteCategory,
  NoteEntry,
  NoteExportFormat,
  NotePatch,
  NoteStore,
  PromptKind,
  RecordingSessionInfo,
  ResourceUsage,
  SearchConnection,
  SearchProbeResult,
  Settings,
  ServerMeta,
  SyncStatus
} from './types'
import type { StatsFile } from './stats'
import type { LocalAsrMirror, LocalAsrStatus, LocalDownloadProgress } from './local-asr'
import type { Reminder, ReminderAction, ReminderInput, ReminderView } from './reminders'

export type { AnswerCardPayload } from './types'

/** The bridge exposed by the preload script as `window.api`. */
/**
 * Mirrors `src/main/updater.ts`'s `UpdateState`. Kept structurally identical so a
 * change there shows up here as a type error instead of a silently empty badge.
 */
export interface UpdateState {
  phase:
    | 'idle'
    | 'checking'
    | 'up-to-date'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'error'
    | 'disabled'
  currentVersion: string
  version?: string
  percent?: number
  message?: string
}

export interface TypelessApi {
  checkAsr(): Promise<void>
  wakeWord: {
    /** Enumerates capture devices; never rejects, an empty list means "use default". */
    devices(): Promise<Array<{ id: string; name: string }>>
    status(): Promise<import('./wake-word').WakeWordStatus>
    retry(): Promise<import('./wake-word').WakeWordStatus>
    onChanged(callback: (status: import('./wake-word').WakeWordStatus) => void): () => void
  }
  screenshot: {
    allScreens(): Promise<void>
    open(): Promise<boolean>
    frame(): Promise<import('./screenshot').ScreenshotFrame>
    ready(): Promise<void>
    close(): Promise<void>
    copyText(text: string): Promise<void>
    startScroll(rect: import('./screenshot').CaptureRect, controls: import('./screenshot').CaptureRect): Promise<void>
    finishScroll(): Promise<import('./screenshot').ScreenshotFrame>
    onScroll(callback: (progress: import('./screenshot').ScrollCaptureProgress) => void): () => void
    run(action: import('./screenshot').ScreenshotAction, dataUrl: string, question?: string, target?: string, ocrLanguage?: string): Promise<import('./screenshot').ScreenshotResult>
  }
  assistant: {
    navigate(page: 'notes' | 'reminders' | 'settings'): Promise<void>
    hubView(): Promise<'overview' | 'history' | 'notes' | 'reminders' | 'corrections' | 'settings' | null>
    onNavigate(callback: () => void): () => void
  }
  reminders: {
    list(): Promise<Reminder[]>
    acknowledgeMissed(id: string, dueAt: number, completed: boolean): Promise<void>
    save(input: ReminderInput, id?: string): Promise<Reminder>
    saveMany(inputs: ReminderInput[]): Promise<Reminder[]>
    action(id: string, action: ReminderAction, snoozeMinutes?: number): Promise<void>
    remove(id: string): Promise<void>
    extractNote(id: string): Promise<string>
    view(): Promise<ReminderView | null>
    strong(): Promise<Reminder[]>
    closeStrong(): void
    onChanged(callback: () => void): () => void
    onOpen(callback: (view: ReminderView) => void): () => void
  }
  /**
   * The local calendar, read-aloud and the daily briefing.
   *
   * The mutating calls return the list they changed: the settings page redraws
   * from one answer instead of guessing whether its cache is still valid.
   */
  life: {
    /**
     * `anchor` only moves the `'month'` range, so paging the month view asks for
     * the month on screen instead of the month of the main process's clock.
     */
    events(range: import('./calendar').CalendarRange, anchor?: { year: number; month: number }): Promise<import('./calendar').CalendarEvent[]>
    /** Events overlapping a window the caller computed with `rangeFor`/`monthRangeFor`. */
    eventsBetween(from: number, until: number): Promise<import('./calendar').CalendarEvent[]>
    cancelEvent(id: string, action: 'cancel' | 'restore'): Promise<import('./calendar').CalendarEvent | null>
    /**
     * Creates or replaces one event. The caller passes every field it wants kept:
     * this is a replacement, not a patch, so a field left out is reset.
     */
    saveEvent(input: import('./calendar').CalendarEventInput, id?: string): Promise<import('./calendar').CalendarEvent | null>
    importIcs(): Promise<{ added: number; updated: number; skipped: number } | null>
    /**
     * Subscribed ICS feeds. Adding and updating validate the URL in the main
     * process — the renderer never decides whether a fetch may happen.
     */
    feeds(): Promise<import('./types').ExternalCalendar[]>
    addFeed(input: { name?: string; url: string }):
      Promise<{ ok: true; calendar: import('./types').ExternalCalendar } | { ok: false; error: string }>
    updateFeed(input: { id: string; patch: { name?: string; url?: string; enabled?: boolean } }):
      Promise<{ ok: true; feeds: import('./types').ExternalCalendar[] } | { ok: false; error: string }>
    removeFeed(id: string): Promise<{ ok: true; feeds: import('./types').ExternalCalendar[] }>
    /** Manual "refresh now": resolves with what each feed contributed this time. */
    refreshFeeds(): Promise<{ ok: true; result: { feeds: number; added: number; updated: number; failed: number } }
      | { ok: false; error: string }>
    exportIcs(): Promise<{ path: string } | null>
    /** Fires after any calendar write, including ones made by the assistant. */
    onChanged(callback: () => void): () => void
    voices(): Promise<{ ok: boolean; error?: string; voices?: string[] }>
    speak(text: string): Promise<{ spoken: number; skipped: boolean }>
    briefing(): Promise<import('./briefing').Briefing>
    refreshBriefing(): Promise<import('./briefing').Briefing>
    /** What was actually delivered, newest last: the page shows real history, not a recomposition. */
    briefingHistory(): Promise<import('./briefing').BriefingRecord[]>
    briefingDeliveryHistory():Promise<import('./briefingDelivery').BriefingDeliveryReceipt[]>
    sendBriefing():Promise<import('./briefingDelivery').BriefingDeliveryReceipt[]>
    onBriefingDelivery(callback:()=>void):()=>void
    onBriefing(callback: (briefing: import('./briefing').Briefing) => void): () => void
  }
  /**
   * Saved workflows: an ordered list of tool calls replayed without a model.
   *
   * There is no `run` here on purpose. Running one goes through the assistant so
   * the same allowlist and the same receipt apply whether a run started from the
   * settings page or from a sentence.
   */
  workflow: {
    list(): Promise<import('./workflow').Workflow[]>
    save(input: import('./workflow').WorkflowInput, id?: string): Promise<import('./workflow').Workflow | null>
    manage(id: string, action: 'archive' | 'restore' | 'remove'): Promise<import('./workflow').Workflow[] | null>
    onChanged(callback: () => void): () => void
  },
  settings: {
    get(): Promise<Settings>
    update(patch: Partial<Settings>): Promise<Settings>
    captureShortcut(active: boolean): Promise<void>
    onShortcutKey(callback: (event: ShortcutKeyEvent) => void): () => void
    onChanged(callback: (settings: Settings) => void): () => void
  }
  history: {
    exportText(ids: string[], format: NoteExportFormat): Promise<{ path: string; count: number } | null>
    list(query?: string): Promise<HistoryEntry[]>
    latest(): Promise<HistoryEntry | undefined>
    remove(id: string): Promise<void>
    /**
     * Hides an entry from the list without deleting its text or audio;
     * `archived: false` puts it back. Returns false when the id is unknown.
     */
    archive(id: string, archived?: boolean): Promise<boolean>
    clear(): Promise<void>
    /** Removes only old abnormal history and its audio; returns the row count. */
    clearAbnormal(): Promise<number>
    /**
     * Copies a kept wav next to the user's downloads folder and returns its
     * path; `ok:false` when the take was not kept or the file is gone (REQ-07).
     */
    downloadAudio(id: string): Promise<{ ok: boolean; path?: string; message?: string }>
    /**
     * Appends one line of user feedback (plus the take's transcript when an id
     * is given) to `<userData>/feedback.log` (REQ-02).
     */
    feedback(input: { id?: string; text: string }): Promise<{ ok: boolean; path?: string }>
  }
  stats: {
    /**
     * Lifetime usage rollup behind the 概览 page. Deliberately independent of the
     * history rows so 清空历史 cannot reset the counters.
     */
    get(): Promise<StatsFile>
  }
  /**
   * The self-hosted account behind history sync.
   *
   * Every call takes the server URL from settings, except `signIn`, which also
   * persists the address the user typed so a failed login does not erase it.
   */
  account: {
    meta(serverUrl: string): Promise<ServerMeta | null>
    status(): Promise<AccountView | null>
    signIn(input: {
      serverUrl?: string
      email: string
      password: string
      mode?: 'login' | 'register'
      /** Sign-up code; the server refuses a registration without it. */
      code?: string
    }): Promise<AccountView | null>
    /**
     * Asks the server to mail a code.
     *
     * `purpose` separates the two audiences the server keeps apart: a sign-up
     * code and a password-reset code are different rows and neither can be
     * replayed into the other flow.
     */
    sendCode(input: {
      serverUrl?: string
      email: string
      purpose?: 'register' | 'reset'
    }): Promise<{ required: boolean }>
    /** Sets a new password with a mailed reset code; every session is revoked. */
    resetPassword(input: { serverUrl?: string; email: string; code: string; password: string }): Promise<void>
    /** Opens the standalone sign-in window (single instance). */
    openLogin(): Promise<boolean>
    /** Called by the sign-in window itself once it is done or dismissed. */
    closeLogin(): Promise<boolean>
    signOut(): Promise<AccountView | null>
    /** Re-reads `/auth/me`, which is where the subscription comes from. */
    refresh(): Promise<AccountView | null>
  }
  sync: {
    status(): Promise<SyncStatus | null>
    /** One push+pull now; the manual button and the timer share this path. */
    now(): Promise<SyncStatus | null>
    /** Tombstones everything on the server, then pulls the deletes back. */
    wipeRemote(): Promise<SyncStatus | null>
    /** Fires whenever the state, the pending count or the error changes. */
    onStatus(callback: (status: SyncStatus) => void): () => void
  }
  localAsr: {
    /** Disk scan + engine phase; cheap enough to call on every render. */
    status(): Promise<LocalAsrStatus>
    /** Maps the weights into memory. ~200 MB and a second or two. */
    activate(): Promise<LocalAsrStatus>
    /** Drops the recogniser; the native side owns the memory. */
    release(): Promise<LocalAsrStatus>
    rescan(): Promise<LocalAsrStatus>
    /** One-click download of every catalogue file for the chosen model. */
    download(mirror?: LocalAsrMirror): Promise<LocalAsrStatus>
    remove(): Promise<LocalAsrStatus>
    /** Directory picker; resolves null when the user cancels. */
    pickDir(): Promise<LocalAsrStatus | null>
    clearDir(): Promise<LocalAsrStatus>
    openDir(): Promise<boolean>
    /** Bytes while a download runs; null clears the bar when it ends. */
    onProgress(callback: (progress: LocalDownloadProgress | null) => void): () => void
  }
  notes: {
    audioControl(action:import('./noteAudio').NoteAudioAction,id?:string,options?:{positionMs?:number;rate?:number}):Promise<import('./noteAudio').NoteAudioState>
    list(): Promise<NoteStore>
    createText(input?: { categoryId?: string; fromClipboard?: boolean; text?: string }): Promise<NoteEntry>
    importAudio(categoryId?: string): Promise<NoteEntry | null>
    retranscribe(id: string): Promise<NoteEntry | null>
    cancelAudioJob(): Promise<void>
    exportText(ids: string[], format: NoteExportFormat): Promise<{ path: string; count: number } | null>
    exportAudio(id: string): Promise<string | null>
    /** Stores a finished recording, then runs ASR and the light polish prompt. */
    create(input: {
      pcm: Int16Array
      durationMs: number
      categoryId?: string
      tags?: string[]
    }): Promise<NoteEntry>
    update(id: string, patch: NotePatch): Promise<NoteEntry | undefined>
    remove(id: string): Promise<void>
    /**
     * One change over a selection of notes: delete, set/clear category, add or
     * remove tags. Main applies it in a single write.
     */
    applyBulk(ids: string[], bulk: NoteBulk): Promise<{ matched: number; changed: number }>
    /** Re-runs only the polish step; the caller confirms before overwriting. */
    repolish(id: string): Promise<NoteEntry | undefined>
    setCategories(categories: NoteCategory[]): Promise<NoteCategory[]>
    /** A 'typeless-audio://note/<id>' URL, or null when no audio was kept. */
    audioUrl(id: string): Promise<string | null>
    dataDir(): Promise<{ dir: string; custom: boolean }>
    chooseDataDir(): Promise<{ ok: boolean; dir?: string; message?: string }>
    migrate(target: string): Promise<{ ok: boolean; moved?: number; message?: string }>
    onChanged(callback: () => void): () => void
    /** The global 随记录音 shortcut, already resolved by main. */
    onRecordHotkey(callback: () => void): () => void
    recording(active: boolean): void
    onRecordControl(callback: (action: 'stop' | 'cancel') => void): () => void
  }
  pipeline: {
    pasteLast(): Promise<boolean>
    state(): Promise<'recording' | 'idle'>
    /**
     * Re-runs the ASR+LLM chain for an existing entry from its kept audio (or
     * from its transcript when no audio was kept). Used by the bar's retry
     * button and by the history row menu (REQ-02).
     */
    retry(id?: string): Promise<{ ok: boolean; message: string }>
  }
  /**
   * Update plumbing. `state` is the whole truth (phase + version + percent), so
   * the hub can show a badge without asking the updater twice, and `onState`
   * pushes every phase change so the badge is never stale.
   */
  update: {
    state(): Promise<UpdateState | null>
    check(): Promise<UpdateState | null>
    download(): Promise<{ ok: boolean; message: string }>
    install(): Promise<boolean>
    onState(callback: (state: UpdateState) => void): () => void
  }
  app: {
    chooseDownloadFolder(): Promise<string | null>
    openDataFolder(): Promise<void>
    openSettings(): Promise<void>
    /**
     * Per-take session logs (the reference client's `recording-event` family).
     * `recordingOpen` reveals `<userData>/recordings` so one file can be attached
     * to a bug report; the list/read pair backs the "最近几次听写" panel.
     */
    recordingOpen(): Promise<boolean>
    recordingList(): Promise<RecordingSessionInfo[]>
    onRecordingChanged(callback: () => void): () => void
    recordingRead(id: string): Promise<string | null>
    /** Deletes every session log and reports how many files went. */
    recordingClear(): Promise<number>
    /** Copy through the main process: a file:// renderer has no clipboard grant. */
    copyText(text: string): Promise<void>
    /** Real app version, so the UI never hardcodes a build number. */
    version(): Promise<string>
    resources(): Promise<ResourceUsage>
    releaseResources(): Promise<ResourceUsage>
    /**
     * Dim the native window buttons with the page while a dialog is open. They
     * are drawn above the web content, so the renderer cannot reach them.
     */
    setChromeDim(dimmed: boolean): Promise<void>
    /**
     * Saves a `data:image/png;base64,…` payload the renderer produced (the share
     * card) through a save dialog. A `file://` renderer cannot write files, and
     * the user must pick where the image lands.
     */
    saveImage(
      dataUrl: string,
      fileName: string
    ): Promise<{ ok: boolean; path?: string; message?: string }>
    /**
     * Writes a redacted diagnostics report and reveals it in the file manager.
     * Devices are passed in because only a renderer can enumerate them.
     */
    diagnostics(
      devices: Array<{ deviceId: string; label: string }>
    ): Promise<{ ok: boolean; path?: string; message?: string }>
  }
  net: {
    probeSearch(input: Pick<SearchConnection, 'provider' | 'apiKey' | 'endpoint'>): Promise<SearchProbeResult>
    probe(input: {
      baseUrl: string
      apiKey: string
      extraHeaders?: string
    }): Promise<{ ok: boolean; status?: number; message: string }>
    /**
     * Multimodal connectivity check: sends the smallest possible generateContent
     * call so a bad key/model shows up before the user records anything.
     */
    probeMultimodal(input: {
      baseUrl: string
      apiKey: string
      model: string
      extraHeaders?: string
    }): Promise<{ ok: boolean; status?: number; message: string }>
  }
  media: {
    /** Microphones reported by the bar renderer, which owns microphone access. */
    devices(): Promise<Array<{ deviceId: string; label: string }>>
  }
  windows: {
    /**
     * Every visible top-level window plus the prompt kind the pipeline would
     * pick for it right now — the evidence the manual routing table needs.
     */
    list(): Promise<
      Array<{
        title: string
        appName: string
        pid: number
        matchedKind: PromptKind
        matchedBy: 'rule' | 'heuristic' | 'fallback'
        matchedRuleId: string | null
        matchedRuleLabel: string | null
        pinned: boolean
      }>
    >
  }
  bar: {
    onNoteAudio(callback:(request:import('./noteAudio').NoteAudioRequest)=>void):()=>void
    replyNoteAudio(reply:import('./noteAudio').NoteAudioReply):Promise<void>
    onLayout(callback: (layout: import('./types').BarWindowLayout) => void): () => void
    captionVisible(visible: boolean): void
    onState(callback: (state: BarState) => void): () => void
    onCaption(callback: (caption: { active: boolean; text: string; unavailable?: boolean }) => void): () => void
    onStop(callback: () => void): () => void
    sendAudio(chunk: Int16Array): void
    stopped(): void
    error(message: string): void
    log(message: string): void
    devices(devices: Array<{ deviceId: string; label: string }>): void
    /**
     * The compressed copy of the take (webm/Opus, recorded by Chromium beside the
     * PCM tap). Main prefers it for the ASR upload when the configured provider
     * accepts it, which removes the dependency on a system ffmpeg (REQ-11).
     */
    encoded(data: Uint8Array, contentType: string): void
    /**
     * Tells main whether the bar must swallow mouse input. Alerts with buttons
     * turn it on; every other phase turns it off so the bar never steals a click
     * from the window underneath (REQ-01).
     */
    interactive(interactive: boolean): void
    /** `bar:action` — a button inside the bar was clicked. */
    action(id: BarActionId): void
  }
  /**
   * `GET {baseUrl}/models` as a one-click action. The cached list is returned
   * when the live request fails, with `cached: true` and `error` set.
   */
  models: {
    list(input: {
      baseUrl: string
      apiKey: string
      extraHeaders?: string
      /** Ignore the cache and hit the network. */
      refresh?: boolean
    }): Promise<ModelListResult>
  }
  /** Answer card window (Ask Anything results). */
  card: {
    /** Renderer subscribed and can receive the first payload. */
    ready(): void
    /** `card:data` — one answer at a time, newest wins. */
    onData(callback: (payload: import('./types').AnswerCardPayload) => void): () => void
    /** Real BrowserWindow hide; visibilitychange alone is unreliable on Windows. */
    onHidden(callback: () => void): () => void
    /** `card:hide` — asks the main process to hide the card window. */
    hide(): void
    /** `card:action` — copy / replace-selection / follow-up question. */
    action(action: CardAction): void
    /** `card:height` — report the rendered content height so the window fits. */
    reportHeight(height: number): void
    /** `card:focus` — resize/raise the card for a follow-up answer. */
    close(): void
  }
}
