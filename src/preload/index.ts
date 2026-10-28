import { contextBridge, ipcRenderer } from 'electron'
import type {
  BarState,
  HistoryEntry,
  RecordingSessionInfo,
  Settings,
  SyncStatus
} from '@shared/types'
import type { StatsFile } from '@shared/stats'
import type { LocalAsrMirror, LocalDownloadProgress } from '@shared/local-asr'
import type { AnswerCardPayload, TypelessApi } from '@shared/api'

// Cache from preload startup, including before React subscribes. A hidden card
// clears its payload; a late or StrictMode subscription only replays live data.
let lastCard: AnswerCardPayload | null = null
ipcRenderer.on('card:data', (_event, payload: AnswerCardPayload) => { lastCard = payload })
ipcRenderer.on('card:hidden', () => { lastCard = null })

const api: TypelessApi = {
  entities: {
    list: () => ipcRenderer.invoke('entities:list'),
    save: (input, id) => ipcRenderer.invoke('entities:save', input, id),
    remove: id => ipcRenderer.invoke('entities:remove', id),
    import: () => ipcRenderer.invoke('entities:import'),
    importPublic: ids => ipcRenderer.invoke('entities:import-public', ids),
    export: () => ipcRenderer.invoke('entities:export')
  },
  checkAsr: () => ipcRenderer.invoke('asr:check'),
  wakeWord: {
    setup: mode => ipcRenderer.invoke('wake:setup', mode),
    learn: (phrase, samples) => ipcRenderer.invoke('wake:learn', phrase, samples),
    onTestDetected: callback => {
      const listener = (): void => callback()
      ipcRenderer.on('wake:test-detected', listener)
      return () => ipcRenderer.removeListener('wake:test-detected', listener)
    },
    devices: (): Promise<Array<{ id: string; name: string }>> => ipcRenderer.invoke('wake:devices'),
    status: () => ipcRenderer.invoke('wake:status'),
    retry: () => ipcRenderer.invoke('wake:retry'),
    onChanged: callback => {
      const listener = (_event: Electron.IpcRendererEvent, status: import('@shared/wake-word').WakeWordStatus): void => callback(status)
      ipcRenderer.on('wake:changed', listener)
      return () => ipcRenderer.removeListener('wake:changed', listener)
    }
  },
  screenshot: {
    openQrUrl: text => ipcRenderer.invoke('screenshot:open-qr-url', text),
    allScreens:()=>ipcRenderer.invoke('screenshot:all-screens'),
    open: () => ipcRenderer.invoke('screenshot:open'),
    frame: () => ipcRenderer.invoke('screenshot:frame'),
    ready: () => ipcRenderer.invoke('screenshot:ready'),
    close: () => ipcRenderer.invoke('screenshot:close'),
    copyText: text => ipcRenderer.invoke('screenshot:copy-text', text),
    startScroll: (rect, controls) => ipcRenderer.invoke('screenshot:scroll-start', rect, controls),
    finishScroll: () => ipcRenderer.invoke('screenshot:scroll-finish'),
    onScroll: callback => {
      const listener = (_event: Electron.IpcRendererEvent, progress: import('@shared/screenshot').ScrollCaptureProgress): void => callback(progress)
      ipcRenderer.on('screenshot:scroll-progress', listener)
      return () => ipcRenderer.removeListener('screenshot:scroll-progress', listener)
    },
    run: (action, dataUrl, question, target, ocrLanguage) => ipcRenderer.invoke('screenshot:run', action, dataUrl, question, target, ocrLanguage)
  },
  assistant: {
    navigate: page => ipcRenderer.invoke('assistant:navigate', page),
    hubView: () => ipcRenderer.invoke('assistant:hub-view'),
    onNavigate: callback => {
      const listener = (): void => callback()
      ipcRenderer.on('assistant:navigate', listener)
      return () => ipcRenderer.removeListener('assistant:navigate', listener)
    }
  },
  reminders: {
    list: () => ipcRenderer.invoke('reminders:list'),
    acknowledgeMissed: (id, dueAt, completed) => ipcRenderer.invoke('reminders:acknowledge-missed', id, dueAt, completed),
    save: (input, id) => ipcRenderer.invoke('reminders:save', input, id),
    saveMany: inputs => ipcRenderer.invoke('reminders:save-many', inputs),
    action: (id, action, snoozeMinutes) => ipcRenderer.invoke('reminders:action', id, action, snoozeMinutes),
    remove: id => ipcRenderer.invoke('reminders:remove', id),
    extractNote: id => ipcRenderer.invoke('reminders:extract-note', id),
    view: () => ipcRenderer.invoke('reminders:view'),
    strong: () => ipcRenderer.invoke('reminders:strong'),
    closeStrong: () => ipcRenderer.send('reminders:close-strong'),
    onChanged: callback => {
      const listener = (): void => callback()
      ipcRenderer.on('reminders:changed', listener)
      return () => ipcRenderer.removeListener('reminders:changed', listener)
    },
    onOpen: callback => {
      const listener = (_event: unknown, view: import('@shared/reminders').ReminderView): void => callback(view)
      ipcRenderer.on('reminders:open', listener)
      return () => ipcRenderer.removeListener('reminders:open', listener)
    }
  },
  life: {
    events: (range, anchor) => ipcRenderer.invoke('life:events', range, anchor),
    eventsBetween: (from, until) => ipcRenderer.invoke('life:events-between', from, until),
    cancelEvent: (id, action) => ipcRenderer.invoke('life:event-cancel', id, action),
    saveEvent: (input, id) => ipcRenderer.invoke('life:event-save', input, id),
    importIcs: () => ipcRenderer.invoke('life:ics-import'),
    feeds: () => ipcRenderer.invoke('calendar:feeds'),
    addFeed: input => ipcRenderer.invoke('calendar:feed-add', input),
    updateFeed: input => ipcRenderer.invoke('calendar:feed-update', input),
    removeFeed: id => ipcRenderer.invoke('calendar:feed-remove', id),
    refreshFeeds: () => ipcRenderer.invoke('calendar:feed-refresh'),
    exportIcs: () => ipcRenderer.invoke('life:ics-export'),
    onChanged: callback => {
      const listener = (): void => callback()
      ipcRenderer.on('life:event-changed', listener)
      return () => ipcRenderer.removeListener('life:event-changed', listener)
    },
    voices: () => ipcRenderer.invoke('life:voices'),
    speak: text => ipcRenderer.invoke('life:speak', text),
    stopSpeaking: () => ipcRenderer.invoke('life:stop-speaking'),
    briefing: () => ipcRenderer.invoke('briefing:latest'),
    refreshBriefing: () => ipcRenderer.invoke('briefing:refresh'),
    briefingHistory: () => ipcRenderer.invoke('briefing:history'),
    briefingDeliveryHistory:()=>ipcRenderer.invoke('briefing:delivery-history'),
    sendBriefing:()=>ipcRenderer.invoke('briefing:send'),
    onBriefingDelivery:callback=>{const listener=():void=>callback();ipcRenderer.on('briefing:delivery-changed',listener);return ()=>ipcRenderer.removeListener('briefing:delivery-changed',listener)},
    onBriefing: callback => {
      const listener = (_event: unknown, value: import('@shared/briefing').Briefing): void => callback(value)
      ipcRenderer.on('briefing:changed', listener)
      return () => ipcRenderer.removeListener('briefing:changed', listener)
    }
  },
  workflow: {
    list: () => ipcRenderer.invoke('workflow:list'),
    tools: () => ipcRenderer.invoke('workflow:tools'),
    save: (input, id) => ipcRenderer.invoke('workflow:save', input, id),
    manage: (id, action) => ipcRenderer.invoke('workflow:manage', id, action),
    onChanged: callback => {
      const listener = (): void => callback()
      ipcRenderer.on('workflow:changed', listener)
      return () => ipcRenderer.removeListener('workflow:changed', listener)
    }
  },
  settings: {
    onShortcutKey: callback => {
      const handler = (_event: Electron.IpcRendererEvent, key: import('@shared/types').ShortcutKeyEvent): void => callback(key)
      ipcRenderer.on('settings:shortcut-key', handler)
      return () => ipcRenderer.removeListener('settings:shortcut-key', handler)
    },
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    update: (patch: Partial<Settings>): Promise<Settings> =>
      ipcRenderer.invoke('settings:update', patch),
    captureShortcut: (active: boolean): Promise<void> => ipcRenderer.invoke('settings:capture-shortcut', active),
    onChanged: (callback: (settings: Settings) => void): (() => void) => {
      const listener = (_event: unknown, settings: Settings): void => callback(settings)
      ipcRenderer.on('settings:changed', listener)
      return () => ipcRenderer.off('settings:changed', listener)
    }
  },
  history: {
    exportText: (ids, format) => ipcRenderer.invoke('history:export-text', ids, format),
    list: (query = ''): Promise<HistoryEntry[]> => ipcRenderer.invoke('history:list', query),
    latest: (): Promise<HistoryEntry | undefined> => ipcRenderer.invoke('history:latest'),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('history:remove', id),
    archive: (id: string, archived = true): Promise<boolean> =>
      ipcRenderer.invoke('history:archive', id, archived),
    clear: (): Promise<void> => ipcRenderer.invoke('history:clear'),
    clearAbnormal: (): Promise<number> => ipcRenderer.invoke('history:clear-abnormal'),
    downloadAudio: (id: string): Promise<{ ok: boolean; path?: string; message?: string }> =>
      ipcRenderer.invoke('history:downloadAudio', id),
    feedback: (input: { id?: string; text: string }): Promise<{ ok: boolean; path?: string }> =>
      ipcRenderer.invoke('history:feedback', input)
  },
  stats: {
    get: (): Promise<StatsFile> => ipcRenderer.invoke('stats:get')
  },
  account: {
    meta: (serverUrl) => ipcRenderer.invoke('account:meta', serverUrl),
    status: () => ipcRenderer.invoke('account:status'),
    signIn: (input) => ipcRenderer.invoke('account:sign-in', input),
    sendCode: (input) => ipcRenderer.invoke('account:send-code', input),
    resetPassword: (input) => ipcRenderer.invoke('account:reset-password', input),
    openLogin: () => ipcRenderer.invoke('account:open-login'),
    closeLogin: () => ipcRenderer.invoke('account:close-login'),
    signOut: () => ipcRenderer.invoke('account:sign-out'),
    refresh: () => ipcRenderer.invoke('account:refresh')
  },
  sync: {
    status: () => ipcRenderer.invoke('sync:status'),
    now: () => ipcRenderer.invoke('sync:now'),
    wipeRemote: () => ipcRenderer.invoke('sync:wipe-remote'),
    onStatus: (callback: (status: SyncStatus) => void): (() => void) => {
      const listener = (_event: unknown, status: SyncStatus): void => callback(status)
      ipcRenderer.on('sync:status', listener)
      return () => {
        ipcRenderer.removeListener('sync:status', listener)
      }
    }
  },
  localAsr: {
    status: () => ipcRenderer.invoke('localAsr:status'),
    activate: () => ipcRenderer.invoke('localAsr:activate'),
    release: () => ipcRenderer.invoke('localAsr:release'),
    rescan: () => ipcRenderer.invoke('localAsr:rescan'),
    download: (mirror?: LocalAsrMirror) => ipcRenderer.invoke('localAsr:download', mirror),
    remove: () => ipcRenderer.invoke('localAsr:remove'),
    pickDir: () => ipcRenderer.invoke('localAsr:pickDir'),
    clearDir: () => ipcRenderer.invoke('localAsr:clearDir'),
    openDir: () => ipcRenderer.invoke('localAsr:openDir'),
    onProgress: (callback: (progress: LocalDownloadProgress | null) => void): (() => void) => {
      const listener = (_event: unknown, progress: LocalDownloadProgress | null): void => {
        callback(progress)
      }
      ipcRenderer.on('localAsr:progress', listener)
      return () => ipcRenderer.removeListener('localAsr:progress', listener)
    }
  },
  notes: {
    audioControl:(action,id,options)=>ipcRenderer.invoke('note-audio:control',action,id,options),
    list: () => ipcRenderer.invoke('notes:list'),
    importAttachments: id => ipcRenderer.invoke('notes:importAttachments', id),
    addAttachment: (id, input) => ipcRenderer.invoke('notes:addAttachment', id, input),
    revealAttachment: (id, path) => ipcRenderer.invoke('notes:revealAttachment', id, path),
    createText: (input) => ipcRenderer.invoke('notes:createText', input),
    importAudio: (categoryId) => ipcRenderer.invoke('notes:importAudio', categoryId),
    retranscribe: (id) => ipcRenderer.invoke('notes:retranscribe', id),
    cancelAudioJob: () => ipcRenderer.invoke('notes:cancelAudioJob'),
    exportText: (ids, format) => ipcRenderer.invoke('notes:exportText', ids, format),
    exportAudio: (id) => ipcRenderer.invoke('notes:exportAudio', id),
    create: (input: { pcm: Int16Array; durationMs: number; categoryId?: string; tags?: string[] }) =>
      ipcRenderer.invoke('notes:create', input),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('notes:update', id, patch),
    remove: (id: string) => ipcRenderer.invoke('notes:remove', id),
    applyBulk: (ids: string[], bulk: unknown) => ipcRenderer.invoke('notes:applyBulk', ids, bulk),
    repolish: (id: string) => ipcRenderer.invoke('notes:repolish', id),
    setCategories: (categories: unknown) => ipcRenderer.invoke('notes:setCategories', categories),
    audioUrl: (id: string) => ipcRenderer.invoke('notes:audioUrl', id),
    dataDir: () => ipcRenderer.invoke('notes:dataDir'),
    chooseDataDir: () => ipcRenderer.invoke('notes:chooseDataDir'),
    migrate: (target: string) => ipcRenderer.invoke('notes:migrate', target),
    onChanged: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('notes:changed', listener)
      return () => ipcRenderer.removeListener('notes:changed', listener)
    },
    /**
     * The global 随记录音 chord, relayed by main. Fires on every press; the notes
     * page decides whether that means "start" or "stop".
     */
    recording: (active) => ipcRenderer.send('notes:recording', active),
    onRecordControl: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, action: 'stop' | 'cancel'): void => callback(action)
      ipcRenderer.on('notes:record-control', listener)
      return () => ipcRenderer.removeListener('notes:record-control', listener)
    },
    onRecordHotkey: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('notes:record-toggle', listener)
      return () => ipcRenderer.removeListener('notes:record-toggle', listener)
    }
  },
  pipeline: {
    pasteLast: (): Promise<boolean> => ipcRenderer.invoke('pipeline:pasteLast'),
    state: (): Promise<'recording' | 'idle'> => ipcRenderer.invoke('pipeline:state'),
    retry: (id?: string): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('pipeline:retry', id)
  },
  update: {
    state: (): Promise<import('@shared/api').UpdateState | null> => ipcRenderer.invoke('update:state'),
    check: (): Promise<import('@shared/api').UpdateState | null> => ipcRenderer.invoke('update:check'),
    download: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('update:download'),
    pause: (): Promise<void> => ipcRenderer.invoke('update:pause'),
    install: (): Promise<boolean> => ipcRenderer.invoke('update:install'),
    onState: (callback: (state: import('@shared/api').UpdateState) => void) => {
      const listener = (_event: unknown, state: import('@shared/api').UpdateState): void => callback(state)
      ipcRenderer.on('update:state', listener)
      return () => ipcRenderer.removeListener('update:state', listener)
    }
  },
  app: {
    chooseDownloadFolder: () => ipcRenderer.invoke('app:chooseDownloadFolder'),
    openDataFolder: (): Promise<void> => ipcRenderer.invoke('app:openDataFolder'),
    recordingOpen: (): Promise<boolean> => ipcRenderer.invoke('recording:open'),
    recordingList: (): Promise<RecordingSessionInfo[]> => ipcRenderer.invoke('recording:list'),
    onRecordingChanged: callback => {
      const listener = (): void => callback()
      ipcRenderer.on('recording:changed', listener)
      return () => ipcRenderer.removeListener('recording:changed', listener)
    },
    recordingRead: (id: string): Promise<string | null> =>
      ipcRenderer.invoke('recording:read', id),
    recordingClear: (): Promise<number> => ipcRenderer.invoke('recording:clear'),
    openSettings: (): Promise<void> => ipcRenderer.invoke('app:openSettings'),
    copyText: (text: string): Promise<void> => ipcRenderer.invoke('app:copyText', text),
    version: (): Promise<string> => ipcRenderer.invoke('app:version'),
    resources: () => ipcRenderer.invoke('app:resources'),
    releaseResources: () => ipcRenderer.invoke('app:releaseResources'),
    setGameMode: active => ipcRenderer.invoke('app:gameMode', active),
    onPrepareForGameMode: callback => {
      const listener = (_event: Electron.IpcRendererEvent, id: number): void => {
        void Promise.resolve().then(callback).then(ok => ipcRenderer.send('app:gameMode-prepared', id, ok === true),
          () => ipcRenderer.send('app:gameMode-prepared', id, false))
      }
      ipcRenderer.on('app:gameMode-prepare', listener)
      return () => { ipcRenderer.off('app:gameMode-prepare', listener) }
    },
    setChromeDim: (dimmed: boolean): Promise<void> =>
      ipcRenderer.invoke('app:chromeDim', dimmed),
    saveImage: (
      dataUrl: string,
      fileName: string
    ): Promise<{ ok: boolean; path?: string; message?: string }> =>
      ipcRenderer.invoke('app:saveImage', { dataUrl, fileName }),
    diagnostics: (
      devices: Array<{ deviceId: string; label: string }>
    ): Promise<{ ok: boolean; path?: string; message?: string }> =>
      ipcRenderer.invoke('app:diagnostics', devices)
  },
  net: {
    probeSearch: input => ipcRenderer.invoke('net:probe-search', input),
    probe: (input: {
      baseUrl: string
      apiKey: string
      extraHeaders?: string
      asrAdapter?: string
    }): Promise<{ ok: boolean; status?: number; message: string }> =>
      ipcRenderer.invoke('net:probe', input),
    probeMultimodal: (input: {
      baseUrl: string
      apiKey: string
      model: string
      extraHeaders?: string
    }): Promise<{ ok: boolean; status?: number; message: string }> =>
      ipcRenderer.invoke('net:probeMultimodal', input)
  },
  media: {
    devices: (): Promise<Array<{ deviceId: string; label: string }>> =>
      ipcRenderer.invoke('media:devices')
  },
  windows: {
    list: () => ipcRenderer.invoke('windows:list')
  },
  models: {
    list: (input: {
      baseUrl: string
      apiKey: string
      extraHeaders?: string
      refresh?: boolean
      asrAdapter?: string
    }): Promise<import('@shared/types').ModelListResult> =>
      ipcRenderer.invoke('models:list', input)
  },
  bar: {
    ready: () => ipcRenderer.send('bar:ready'),
    startCueFinished: taskId => ipcRenderer.send('bar:start-cue-finished', taskId),
    onSpeechPlayback: callback => {
      const listener = (_event: unknown, request: import('@shared/speech').SpeechPlaybackRequest): void => callback(request)
      ipcRenderer.on('speech:playback', listener)
      return () => ipcRenderer.removeListener('speech:playback', listener)
    },
    replySpeechPlayback: reply => ipcRenderer.invoke('speech:playback-reply', reply),
    onNoteAudio:callback=>{
      const listener=(_event:unknown,request:import('@shared/noteAudio').NoteAudioRequest):void=>callback(request)
      ipcRenderer.on('note-audio:command',listener)
      return ()=>ipcRenderer.removeListener('note-audio:command',listener)
    },
    replyNoteAudio:reply=>ipcRenderer.invoke('note-audio:reply',reply),
    onLayout: (callback) => {
      const listener = (_event: unknown, layout: import('@shared/types').BarWindowLayout): void => callback(layout)
      ipcRenderer.on('bar:layout', listener)
      return () => { ipcRenderer.removeListener('bar:layout', listener) }
    },
    captionVisible: (visible) => ipcRenderer.send('bar:caption-visible', visible),
    onCaption: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, caption: { active: boolean; text: string; unavailable?: boolean }): void => callback(caption)
      ipcRenderer.on('bar:caption', listener)
      return () => { ipcRenderer.removeListener('bar:caption', listener) }
    },
    onState: (callback: (state: BarState) => void): (() => void) => {
      const listener = (_event: unknown, state: BarState): void => callback(state)
      ipcRenderer.on('bar:state', listener)
      return () => ipcRenderer.off('bar:state', listener)
    },
    onStop: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('capture:stop', listener)
      return () => ipcRenderer.off('capture:stop', listener)
    },
    sendAudio: (chunk: Int16Array): void => {
      ipcRenderer.send('audio:chunk', chunk)
    },
    stopped: (): void => {
      ipcRenderer.send('capture:stopped')
    },
    error: (message: string): void => {
      ipcRenderer.send('capture:error', message)
    },
    log: (message: string): void => {
      ipcRenderer.send('bar:log', message)
    },
    devices: (devices: Array<{ deviceId: string; label: string }>): void => {
      ipcRenderer.send('bar:devices', devices)
    },
    encoded: (data: Uint8Array, contentType: string): void => {
      ipcRenderer.send('capture:encoded', data, contentType)
    },
    interactive: (interactive: boolean): void => {
      ipcRenderer.send('bar:interactive', interactive)
    },
    action: (id): void => {
      ipcRenderer.send('bar:action', id)
    }
  },
  // Every renderer shares this one preload, so the card page gets the same
  // bridge — `window.api.card` is what AnswerCard.tsx subscribes to.
  card: {
    beginVoice: () => ipcRenderer.invoke('card:voice-begin'),
    cancelVoice: id => ipcRenderer.send('card:voice-cancel', id),
    transcribeVoice: (id, wav) => ipcRenderer.invoke('card:voice-transcribe', id, wav),
    ready: () => ipcRenderer.send('card:ready'),
    onHidden: callback => {
      const listener = (): void => callback()
      ipcRenderer.on('card:hidden', listener)
      return () => ipcRenderer.removeListener('card:hidden', listener)
    },
    onData: (callback: (payload: AnswerCardPayload) => void): (() => void) => {
      let subscribed = true
      const listener = (_event: unknown, payload: AnswerCardPayload): void => callback(payload)
      ipcRenderer.on('card:data', listener)
      if (lastCard !== null) {
        const pending = lastCard
        // Replay what already arrived before this page subscribed.
        queueMicrotask(() => {
          if (subscribed && lastCard === pending) callback(pending)
        })
      }
      return () => { subscribed = false; ipcRenderer.off('card:data', listener) }
    },
    hide: (): void => {
      ipcRenderer.send('card:hide')
    },
    action: (action): void => {
      ipcRenderer.send('card:action', action)
    },
    reportHeight: (height: number): void => {
      ipcRenderer.send('card:height', height)
    },
    close: (): void => {
      ipcRenderer.send('card:hide')
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
