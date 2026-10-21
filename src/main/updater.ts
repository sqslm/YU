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
}

export type UpdateCheck =
  | { ok: true; status: 'available' | 'none'; version?: string }
  | { ok: false; status: 'not-configured' | 'error'; message: string }

/**
 * Feed URL resolution order: the environment variable wins so a packaged build
 * can be pointed at a mirror without rebuilding, then a plain text file the
 * operator can drop into the data folder.
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
  if (!userDataPath) return null
  const file = join(userDataPath, 'update-feed.txt')
  if (!existsSync(file)) return null
  try {
    const fromFile = readFileSync(file, 'utf8').trim()
    return fromFile || null
  } catch {
    return null
  }
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
  const parse = (raw: string): number[] =>
    raw
      .trim()
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0)
  const next = parse(candidate)
  const now = parse(current)
  for (let i = 0; i < 3; i += 1) {
    const a = next[i] ?? 0
    const b = now[i] ?? 0
    if (a !== b) return a > b
  }
  return false
}

export class Updater {
  private configured = false
  private downloadedVersion: string | null = null
  /** One check at a time: the startup timer and a click must share it. */
  private checking: Promise<UpdateCheck> | null = null

  constructor(private readonly options: UpdaterOptions) {}

  private configure(feedUrl: string): void {
    if (this.configured) return
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = {
      info: (msg?: unknown) => this.options.log(`[update] ${String(msg ?? '')}`),
      warn: (msg?: unknown) => this.options.log(`[update] warn ${String(msg ?? '')}`),
      error: (msg?: unknown) => this.options.log(`[update] error ${String(msg ?? '')}`),
      debug: (msg?: unknown) => this.options.log(`[update] debug ${String(msg ?? '')}`)
    } as unknown as typeof autoUpdater.logger
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })

    autoUpdater.on('update-available', (info) => {
      this.options.log(`[update] available ${info.version}`)
      this.options.onAvailable({ version: info.version, notes: notesOf(info.releaseNotes) })
    })
    autoUpdater.on('update-not-available', () => this.options.log('[update] up to date'))
    autoUpdater.on('download-progress', (progress) => {
      this.options.onProgress?.(Math.round(progress.percent))
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.downloadedVersion = info.version
      this.options.log(`[update] downloaded ${info.version}`)
      this.options.onDownloaded(info.version)
    })
    autoUpdater.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err)
      this.options.log(`[update] failed: ${message}`)
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
      return { ok: false, status: 'not-configured', message: mt('开发模式不检查更新') }
    }
    const feedUrl = resolveFeedUrl(process.env, this.options.userDataPath)
    if (!feedUrl) {
      this.options.log('[update] skipped: no feed configured')
      return { ok: false, status: 'not-configured', message: mt('未配置更新源（TYPELESS_UPDATE_URL）') }
    }
    try {
      this.configure(feedUrl)
      const result = await autoUpdater.checkForUpdates()
      const version = result?.updateInfo?.version
      if (version && isNewerVersion(version, app.getVersion())) {
        return { ok: true, status: 'available', version }
      }
      if (version) this.options.log(`[update] feed has ${version}, installed ${app.getVersion()}`)
      return { ok: true, status: 'none' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.options.log(`[update] check failed: ${message}`)
      return { ok: false, status: 'error', message }
    }
  }

  /** Starts the download for a version the user accepted in the bar. */
  async download(): Promise<{ ok: boolean; message: string }> {
    if (!this.configured) return { ok: false, message: mt('尚未检查更新') }
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true, message: mt('更新已下载，退出时自动安装') }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, message }
    }
  }

  /** Installs what was downloaded and restarts into the new version. */
  install(): boolean {
    if (!this.downloadedVersion) return false
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
