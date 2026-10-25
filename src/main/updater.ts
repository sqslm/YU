/**
 * Auto-update plumbing (REQ-13).
 *
 * `electron-updater` reads a feed configured at build time; this rebuild has no
 * hosted release channel, so the feed URL is operator-supplied through
 * `TYPELESS_UPDATE_URL` (or a `update-feed.txt` next to the settings file).
 * Without a feed the updater reports "not configured" instead of pretending an
 * update check happened — a silent success would be indistinguishable from a
 * stale install.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { mt } from '@shared/mainI18n'

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
    | 'downloaded'
    | 'error'
    | 'disabled'
  currentVersion: string
  version?: string
  percent?: number
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
      this.setState({ phase: 'downloading', percent })
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
    if (!this.configured) return { ok: false, message: mt('尚未检查更新') }
    if (!this.availableVersion || !isNewerVersion(this.availableVersion, app.getVersion())) return { ok: false, message: mt('没有可下载的新版本') }
    this.setState({ phase: 'downloading', percent: 0, message: undefined })
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true, message: mt('更新已下载，退出时自动安装') }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.setState({ phase: 'error', message })
      return { ok: false, message }
    }
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
