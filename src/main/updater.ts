/** GitHub release checks; concurrent resumable artifacts, upstream verified install. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, net } from 'electron'
import { autoUpdater, CancellationToken } from 'electron-updater'
import type { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor'
import { mt } from '@shared/mainI18n'
import { downloadRanges } from './update-download'

export interface UpdateInfo {
  version: string
  notes?: string
}

export interface UpdaterOptions {
  log: (line: string) => void
  /** Path of the settings file; `update-feed.txt` is looked up next to it. */
  userDataPath: string
  onAvailable: (info: UpdateInfo) => void
  onProgress?: (percent: number) => void
  onDownloaded: (version: string) => void
  onError: (message: string) => void
  /** Pushes every phase change to the hub badge; the renderer never polls. */
  onState?: (state: UpdateState) => void
}

export type UpdateCheck =
  | { ok: true; status: 'available' | 'none'; version?: string }
  | { ok: false; status: 'not-configured' | 'error'; message: string }

/**
 * What the hub badge renders. Only the main process knows whether a check is
 * still running, whether bytes are moving, or whether a downloaded installer is
 * waiting for a restart, so the state lives here instead of being pieced together
 * from one-shot IPC answers in the renderer.
 */
export interface UpdateState {
  phase:
    | 'idle'
    | 'checking'
    | 'up-to-date'
    | 'available'
    | 'downloading'
    | 'paused'
    | 'verifying'
    | 'downloaded'
    | 'error'
    | 'disabled'
  currentVersion: string
  version?: string
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
  etaSeconds?: number
  message?: string
}

/**
 * The project's own release feed. GitHub serves the newest release's assets at
 * `/releases/latest/download/`, so a generic feed URL keeps working without
 * running an update server of our own. `TYPELESS_UPDATE_URL` and
 * `update-feed.txt` still win, which is how a mirrored install points elsewhere.
 */
export const DEFAULT_FEED_URL = 'https://github.com/sqslm/YU/releases/latest/download'

/**
 * Feed URL resolution order: the environment variable wins so a packaged build
 * can be pointed at a mirror without rebuilding, then a plain text file the
 * operator can drop into the data folder, then the built-in GitHub feed.
 */
export function resolveFeedUrl(
  env: Record<string, string | undefined> = process.env,
  userDataPath?: string
): string | null {
  // Hard opt-out for air-gapped installs and for the test harness: with this set
  // the app must not even attempt a feed lookup.
  if ((env.TYPELESS_NO_UPDATE ?? '').trim() === '1') return null
  const fromEnv = (env.TYPELESS_UPDATE_URL ?? '').trim()
  if (fromEnv) return fromEnv
  if (userDataPath) {
    const file = join(userDataPath, 'update-feed.txt')
    if (existsSync(file)) {
      try {
        const fromFile = readFileSync(file, 'utf8').trim()
        if (fromFile) return fromFile
      } catch {
        // A half-written file is not a reason to lose the default feed.
      }
    }
  }
  return DEFAULT_FEED_URL
}

/** True when running from a packaged build: the only case updates make sense. */
export function canSelfUpdate(isPackaged: boolean = app.isPackaged): boolean {
  return isPackaged
}

/**
 * Numeric dotted-version comparison: `0.9.10` is newer than `0.9.9`.
 *
 * The feed used to be compared by string inequality, so a release older than the
 * installed build still read as "an update is available" and could be downloaded
 * and installed — a downgrade dressed as an upgrade.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (raw: string) => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim().replace(/^v/i, ''))
  const next = parse(candidate)
  const now = parse(current)
  if (!next || !now) return false
  for (let i = 1; i <= 3; i += 1) {
    const a = Number(next[i]), b = Number(now[i])
    if (a !== b) return a > b
  }
  if (!next[4] || !now[4]) return Boolean(now[4] && !next[4])
  const a = next[4].split('.'), b = now[4].split('.')
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === b[i]) continue
    if (a[i] === undefined || b[i] === undefined) return b[i] === undefined
    const numericA = /^\d+$/.test(a[i]), numericB = /^\d+$/.test(b[i])
    if (numericA && numericB) return Number(a[i]) > Number(b[i])
    if (numericA !== numericB) return numericB
    return a[i] > b[i]
  }
  return false
}

export class Updater {
  private configured = false
  private downloadedVersion: string | null = null
  private availableVersion: string | null = null
  /** One check at a time: the startup timer and a click must share it. */
  private checking: Promise<UpdateCheck> | null = null
  private downloading: Promise<{ ok: boolean; message: string }> | null = null
  private cancellation: CancellationToken | null = null
  private state: UpdateState = { phase: 'idle', currentVersion: app.getVersion() }

  constructor(private readonly options: UpdaterOptions) {}

  /** Last known phase; the hub asks once on mount and then follows `onState`. */
  getState(): UpdateState {
    return this.state
  }

  private setState(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch, currentVersion: app.getVersion() }
    try {
      this.options.onState?.(this.state)
    } catch (err) {
      // A renderer that went away must not break the update flow.
      this.options.log(`[update] state listener failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private configure(feedUrl: string): void {
    if (this.configured) return
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    // Differential requests bypass the artifact executor and cannot persist our
    // partial ranges. Use one consistent resumable path for every installer.
    autoUpdater.disableDifferentialDownload = true
    // A prerelease build publishes `rc.yml` — electron-builder names the channel
    // after the prerelease tag — so asking for `latest.yml` would 404 against our
    // own feed and every rc install would silently stop seeing new builds.
    const tag = /^\d+\.\d+\.\d+-([0-9A-Za-z]+)/.exec(app.getVersion())?.[1]
    autoUpdater.allowPrerelease = Boolean(tag)
    if (tag) autoUpdater.channel = tag
    // Setting channel implicitly enables downgrades in electron-updater.
    autoUpdater.allowDowngrade = false
    autoUpdater.logger = {
      info: (msg?: unknown) => this.options.log(`[update] ${String(msg ?? '')}`),
      warn: (msg?: unknown) => this.options.log(`[update] warn ${String(msg ?? '')}`),
      error: (msg?: unknown) => this.options.log(`[update] error ${String(msg ?? '')}`),
      debug: (msg?: unknown) => this.options.log(`[update] debug ${String(msg ?? '')}`)
    } as unknown as typeof autoUpdater.logger
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })
    // electron-updater 6 exposes this at runtime but omits it from its declarations.
    const executor = (autoUpdater as typeof autoUpdater & { httpExecutor?: ElectronHttpExecutor | null }).httpExecutor
    if (executor) {
      const standardDownload = executor.download.bind(executor)
      executor.download = async (url, destination, options) => {
        if (!options.sha512) return standardDownload(url, destination, options)
        const controller = new AbortController()
        const abort = (): void => controller.abort()
        options.cancellationToken.once('cancel', abort)
        if (options.cancellationToken.cancelled) controller.abort()
        let handled: boolean
        try { handled = await downloadRanges({
          url: url.toString(), destination, sha512: options.sha512,
          cacheDir: join(this.options.userDataPath, 'update-parts'), signal: controller.signal,
          headers: options.headers as Record<string, string> | undefined,
          fetchImpl: net.fetch.bind(net) as typeof fetch,
          onProgress: progress => {
            this.setState({ phase: 'downloading', ...progress, percent: Math.floor(progress.percent) })
            this.options.onProgress?.(Math.floor(progress.percent))
          },
          onVerifying: () => this.setState({ phase: 'verifying', bytesPerSecond: 0, etaSeconds: 0 })
        }) } finally { options.cancellationToken.removeListener('cancel', abort) }
        if (!handled) return standardDownload(url, destination, options)
        return destination
      }
    }

    autoUpdater.on('update-available', (info) => {
      if (!isNewerVersion(info.version, app.getVersion())) {
        this.options.log(`[update] ignored older/equal available event ${info.version}`)
        return
      }
      this.availableVersion = info.version
      this.options.log(`[update] available ${info.version}`)
      this.setState({ phase: 'available', version: info.version, percent: undefined, message: undefined })
      this.options.onAvailable({ version: info.version, notes: notesOf(info.releaseNotes) })
    })
    autoUpdater.on('update-not-available', () => {
      this.availableVersion = null
      this.options.log('[update] up to date')
      this.setState({ phase: 'up-to-date', version: undefined, percent: undefined, message: undefined })
    })
    autoUpdater.on('download-progress', (progress) => {
      const percent = Math.round(progress.percent)
      this.setState({ phase: 'downloading', percent, transferred: progress.transferred, total: progress.total, bytesPerSecond: progress.bytesPerSecond })
      this.options.onProgress?.(percent)
    })
    autoUpdater.on('update-downloaded', (info) => {
      if (!isNewerVersion(info.version, app.getVersion()) || info.version !== this.availableVersion) {
        autoUpdater.autoInstallOnAppQuit = false
        this.options.log(`[update] ignored unaccepted downloaded version ${info.version}`)
        return
      }
      this.downloadedVersion = info.version
      autoUpdater.autoInstallOnAppQuit = true
      this.options.log(`[update] downloaded ${info.version}`)
      this.setState({ phase: 'downloaded', version: info.version, percent: 100, message: undefined })
      this.options.onDownloaded(info.version)
    })
    autoUpdater.on('error', (err) => {
      if (this.cancellation?.cancelled) return
      const message = err instanceof Error ? err.message : String(err)
      this.options.log(`[update] failed: ${message}`)
      this.setState({ phase: 'error', message })
      this.options.onError(message)
    })
    this.configured = true
  }

  /**
   * Runs one check. Manual checks surface "not configured" to the caller so the
   * hub can tell the user why nothing happened; the background check on startup
   * just logs.
   */
  async check(): Promise<UpdateCheck> {
    if (this.downloading || this.state.phase === 'paused' || this.state.phase === 'downloaded') {
      return { ok: true, status: 'available', version: this.availableVersion ?? undefined }
    }
    if (this.checking) return this.checking
    this.checking = this.runCheck().finally(() => {
      this.checking = null
    })
    return this.checking
  }

  private async runCheck(): Promise<UpdateCheck> {
    if (!canSelfUpdate()) {
      this.options.log('[update] skipped: development build')
      this.setState({ phase: 'disabled', message: mt('开发模式不检查更新') })
      return { ok: false, status: 'not-configured', message: mt('开发模式不检查更新') }
    }
    const feedUrl = resolveFeedUrl(process.env, this.options.userDataPath)
    if (!feedUrl) {
      // Only reachable with TYPELESS_NO_UPDATE=1: say so instead of checking.
      this.options.log('[update] skipped: checks disabled')
      this.setState({ phase: 'disabled', message: mt('更新检查已关闭') })
      return { ok: false, status: 'not-configured', message: mt('更新检查已关闭') }
    }
    this.setState({ phase: 'checking', message: undefined, percent: undefined })
    try {
      this.configure(feedUrl)
      const result = await autoUpdater.checkForUpdates()
      const version = result?.updateInfo?.version
      if (version && isNewerVersion(version, app.getVersion())) {
        this.availableVersion = version
        this.setState({ phase: 'available', version, percent: undefined, message: undefined })
        return { ok: true, status: 'available', version }
      }
      if (version) this.options.log(`[update] feed has ${version}, installed ${app.getVersion()}`)
      this.availableVersion = null
      this.setState({ phase: 'up-to-date', version: undefined, percent: undefined, message: undefined })
      return { ok: true, status: 'none' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.options.log(`[update] check failed: ${message}`)
      this.setState({ phase: 'error', message })
      return { ok: false, status: 'error', message }
    }
  }

  /** Starts the download for a version the user accepted in the bar. */
  async download(): Promise<{ ok: boolean; message: string }> {
    if (this.downloading) return this.downloading
    if (!this.configured) return { ok: false, message: mt('尚未检查更新') }
    if (!this.availableVersion || !isNewerVersion(this.availableVersion, app.getVersion())) return { ok: false, message: mt('没有可下载的新版本') }
    this.cancellation = new CancellationToken()
    this.downloading = this.runDownload(this.cancellation).finally(() => { this.downloading = null; this.cancellation = null })
    return this.downloading
  }

  private async runDownload(token: CancellationToken): Promise<{ ok: boolean; message: string }> {
    this.setState({ phase: 'downloading', percent: this.state.percent ?? 0, message: undefined, bytesPerSecond: 0, etaSeconds: undefined })
    try {
      await autoUpdater.downloadUpdate(token)
      return { ok: true, message: mt('更新已下载，退出时自动安装') }
    } catch (err) {
      if (token.cancelled) {
        this.setState({ phase: 'paused', bytesPerSecond: 0, etaSeconds: undefined })
        return { ok: true, message: mt('更新下载已暂停') }
      }
      const message = err instanceof Error ? err.message : String(err)
      this.setState({ phase: 'error', message })
      return { ok: false, message }
    }
  }

  async pause(): Promise<void> {
    if (!this.downloading || this.state.phase !== 'downloading') return
    this.cancellation?.cancel()
    await this.downloading
  }

  /** Installs what was downloaded and restarts into the new version. */
  install(): boolean {
    if (!this.downloadedVersion || !isNewerVersion(this.downloadedVersion, app.getVersion())) return false
    this.options.log(`[update] installing ${this.downloadedVersion}`)
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
    return true
  }
}

function notesOf(notes: unknown): string | undefined {
  if (typeof notes === 'string') return notes
  if (Array.isArray(notes)) {
    const joined = notes
      .map((item) => (typeof item === 'string' ? item : (item as { note?: string })?.note ?? ''))
      .filter(Boolean)
      .join('\n')
    return joined || undefined
  }
  return undefined
}
