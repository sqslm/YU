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

// The card window is created on demand and shown after `ready-to-show`, while
// the main process pushes `card:data` on `did-finish-load`. React effects can
// still be a tick behind the load event, so the last payload is cached here and
// replayed to any late subscriber instead of being lost.
let lastCard: AnswerCardPayload | null = null

const api: TypelessApi = {
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    update: (patch: Partial<Settings>): Promise<Settings> =>
      ipcRenderer.invoke('settings:update', patch),
    onChanged: (callback: (settings: Settings) => void): (() => void) => {
      const listener = (_event: unknown, settings: Settings): void => callback(settings)
      ipcRenderer.on('settings:changed', listener)
      return () => ipcRenderer.off('settings:changed', listener)
    }
  },
  history: {
    list: (query = ''): Promise<HistoryEntry[]> => ipcRenderer.invoke('history:list', query),
    latest: (): Promise<HistoryEntry | undefined> => ipcRenderer.invoke('history:latest'),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('history:remove', id),
    archive: (id: string, archived = true): Promise<boolean> =>
      ipcRenderer.invoke('history:archive', id, archived),
    clear: (): Promise<void> => ipcRenderer.invoke('history:clear'),
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
    list: () => ipcRenderer.invoke('notes:list'),
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
  app: {
    openDataFolder: (): Promise<void> => ipcRenderer.invoke('app:openDataFolder'),
    recordingOpen: (): Promise<boolean> => ipcRenderer.invoke('recording:open'),
    recordingList: (): Promise<RecordingSessionInfo[]> => ipcRenderer.invoke('recording:list'),
    recordingRead: (id: string): Promise<string | null> =>
      ipcRenderer.invoke('recording:read', id),
    recordingClear: (): Promise<number> => ipcRenderer.invoke('recording:clear'),
    openSettings: (): Promise<void> => ipcRenderer.invoke('app:openSettings'),
    copyText: (text: string): Promise<void> => ipcRenderer.invoke('app:copyText', text),
    version: (): Promise<string> => ipcRenderer.invoke('app:version'),
    resources: () => ipcRenderer.invoke('app:resources'),
    releaseResources: () => ipcRenderer.invoke('app:releaseResources'),
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
    probe: (input: {
      baseUrl: string
      apiKey: string
      extraHeaders?: string
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
    }): Promise<import('@shared/types').ModelListResult> =>
      ipcRenderer.invoke('models:list', input)
  },
  bar: {
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
    onData: (callback: (payload: AnswerCardPayload) => void): (() => void) => {
      const listener = (_event: unknown, payload: AnswerCardPayload): void => {
        lastCard = payload
        callback(payload)
      }
      ipcRenderer.on('card:data', listener)
      if (lastCard !== null) {
        const pending = lastCard
        // Replay what already arrived before this page subscribed.
        queueMicrotask(() => {
          if (lastCard === pending) callback(pending)
        })
      }
      return () => ipcRenderer.off('card:data', listener)
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
