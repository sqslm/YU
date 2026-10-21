import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeServerUrl } from '@shared/defaults'
import type { SubscriptionInfo } from '@shared/types'

/**
 * On-disk shape. Tokens are encrypted with the OS keyring when it is available;
 * when it is not (a Linux box with no keyring) they land in clear text next to the
 * settings file, which already stores provider keys the same way.
 */
interface DiskSession {
  serverUrl: string
  email: string
  userId: string
  accessExpiresAt: number
  subscription: SubscriptionInfo | null
  tokenEnc?: string
  refreshEnc?: string
  token?: string
  refresh?: string
}

/** The signed-in account as the rest of the app uses it: tokens included. */
export interface Session {
  serverUrl: string
  email: string
  userId: string
  accessToken: string
  refreshToken: string
  accessExpiresAt: number
  subscription: SubscriptionInfo | null
}

/**
 * The signed-in account, persisted in `<userData>/account.json`.
 *
 * Kept out of `settings.json` on purpose: settings is edited by the 350 ms debounce
 * of the settings UI and re-serialised on every patch, which is the wrong lifecycle
 * for a token that has to survive a refresh mid-session.
 */
export class AccountStore {
  private readonly path: string
  private session: Session | null = null
  private cached: DiskSession | null = null
  /** Set when decryption failed, so the UI can ask for a fresh sign-in. */
  private unreadable = false

  constructor(filePath = join(app.getPath('userData'), 'account.json')) {
    this.path = filePath
  }

  get filePath(): string {
    return this.path
  }

  load(): Session | null {
    if (this.session) return this.session
    if (!existsSync(this.path)) return null
    let disk: DiskSession
    try {
      disk = JSON.parse(readFileSync(this.path, 'utf8')) as DiskSession
    } catch (err) {
      console.error('[account] cannot read account.json, asking for a new sign-in:', err)
      this.unreadable = true
      return null
    }
    if (!disk || typeof disk.serverUrl !== 'string' || typeof disk.email !== 'string') {
      this.unreadable = true
      return null
    }
    this.cached = disk
    const accessToken = this.open(disk.tokenEnc, disk.token)
    const refreshToken = this.open(disk.refreshEnc, disk.refresh)
    if (!accessToken || !refreshToken) {
      // The keyring changed (another machine, another user). The account is still
      // known — the email and the server URL are readable — so the UI can say
      // "sign in again" instead of showing an empty form.
      this.unreadable = true
      return null
    }
    this.session = {
      serverUrl: normalizeServerUrl(disk.serverUrl),
      email: disk.email,
      userId: typeof disk.userId === 'string' ? disk.userId : '',
      accessToken,
      refreshToken,
      accessExpiresAt: Number(disk.accessExpiresAt) || 0,
      subscription: disk.subscription ?? null
    }
    return this.session
  }

  /** What the UI may show even when the tokens are unusable. */
  knownAccount(): { email: string; serverUrl: string } | null {
    if (!this.cached) return null
    return { email: this.cached.email, serverUrl: normalizeServerUrl(this.cached.serverUrl) }
  }

  needsSignIn(): boolean {
    return this.unreadable && this.session === null
  }

  /**
   * Drops the tokens after the server refused to refresh them.
   *
   * The email and the server URL stay readable so the form can be pre-filled: an
   * expired session is "type your password again", not "set up an account".
   */
  expire(): void {
    this.session = null
    this.unreadable = true
    try {
      if (existsSync(this.path)) renameSync(this.path, `${this.path}.expired`)
    } catch (err) {
      console.error('[account] cannot archive a rejected account.json:', err)
    }
  }

  get(): Session | null {
    return this.session
  }

  set(session: Session): void {
    this.session = { ...session, serverUrl: normalizeServerUrl(session.serverUrl) }
    this.unreadable = false
    this.persist()
  }

  /** Replaces the tokens after a refresh, keeping the rest of the session. */
  updateTokens(accessToken: string, refreshToken: string, expiresInSeconds: number): void {
    if (!this.session) return
    this.session.accessToken = accessToken
    this.session.refreshToken = refreshToken
    this.session.accessExpiresAt = Date.now() + Math.max(0, expiresInSeconds) * 1000
    this.persist()
  }

  setSubscription(subscription: SubscriptionInfo | null): void {
    if (!this.session) return
    this.session.subscription = subscription
    this.persist()
  }

  clear(): void {
    this.session = null
    this.cached = null
    this.unreadable = false
    try {
      if (existsSync(this.path)) renameSync(this.path, `${this.path}.signed-out`)
    } catch (err) {
      console.error('[account] cannot archive account.json:', err)
    }
  }

  private canEncrypt(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  private seal(value: string): { enc?: string; plain?: string } {
    if (!this.canEncrypt()) return { plain: value }
    try {
      return { enc: safeStorage.encryptString(value).toString('base64') }
    } catch (err) {
      console.error('[account] cannot encrypt a token, storing it in clear text:', err)
      return { plain: value }
    }
  }

  private open(enc: string | undefined, plain: string | undefined): string | null {
    if (typeof enc === 'string' && enc.length > 0) {
      try {
        return safeStorage.decryptString(Buffer.from(enc, 'base64'))
      } catch (err) {
        console.error('[account] cannot decrypt a stored token:', err)
        return null
      }
    }
    return typeof plain === 'string' && plain.length > 0 ? plain : null
  }

  private persist(): void {
    if (!this.session) return
    const access = this.seal(this.session.accessToken)
    const refresh = this.seal(this.session.refreshToken)
    const disk: DiskSession = {
      serverUrl: this.session.serverUrl,
      email: this.session.email,
      userId: this.session.userId,
      accessExpiresAt: this.session.accessExpiresAt,
      subscription: this.session.subscription,
      ...(access.enc ? { tokenEnc: access.enc } : {}),
      ...(refresh.enc ? { refreshEnc: refresh.enc } : {}),
      ...(access.plain ? { token: access.plain } : {}),
      ...(refresh.plain ? { refresh: refresh.plain } : {})
    }
    this.cached = disk
    const temp = `${this.path}.${process.pid}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(disk, null, 2), 'utf8')
      renameSync(temp, this.path)
    } catch (err) {
      console.error('[account] cannot write account.json:', err)
    }
  }
}

/** `192.168.1.5:8787` and `https://host/` both become a usable base URL. */
/** Directory of the file, used by tests that need to clean up. */
export function accountDirectory(path: string): string {
  return dirname(path)
}
