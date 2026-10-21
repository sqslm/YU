import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AccountView,
  NoteEntry,
  Settings,
  ServerMeta,
  StorageUsage,
  SubscriptionInfo,
  SyncStatus
} from '@shared/types'
import type { AccountStore, Session } from './account'
import { toSyncRow, type HistoryStore } from './history'
import type { RemoteAudio } from './notes'
import { mt } from '@shared/mainI18n'
import { normalizeServerUrl } from '@shared/defaults'

/** A server that does not answer in this window is unreachable, not slow. */
const REQUEST_TIMEOUT_MS = 15_000
/** Rows per push/pull page. Notes pushes allow 200 total changes. */
const PAGE = 200
/** Stops a pathological loop (a server that always reports `hasMore`). */
const MAX_PAGES = 50

export class CloudError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'CloudError'
  }
}

function describeNetworkError(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') return mt('请求超时')
  const message = err instanceof Error ? err.message : String(err)
  return message || mt('网络不可用')
}

function payloadMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const item = payload as { message?: unknown; error?: unknown }
    if (typeof item.message === 'string' && item.message) return item.message
    if (typeof item.error === 'string' && item.error) return item.error
  }
  return fallback
}

function payloadCode(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const code = (payload as { code?: unknown }).code
    if (typeof code === 'string') return code
    const error = (payload as { error?: unknown }).error
    if (typeof error === 'string') return error
  }
  return ''
}

function parseJson(text: string): unknown {
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function describeError(err: unknown): string {
  if (err instanceof CloudError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

interface AuthPayload {
  accessToken: string
  refreshToken: string
  expiresIn: number
  user: { id: string; email: string; subscription?: SubscriptionInfo | null }
}

/**
 * One HTTP client for everything the self-hosted server offers.
 *
 * It owns token rotation: an expired access token is refreshed once and the call
 * is repeated, so no caller has to think about it. A 401 that survives a refresh
 * means the account is gone or the refresh token was revoked, and the store is
 * cleared so the UI can ask for a password instead of failing silently.
 */
export class CloudClient {
  private refreshing: Promise<Session> | null = null

  constructor(private readonly accounts: AccountStore) {}

  async meta(serverUrl: string): Promise<ServerMeta | null> {
    try {
      return await this.anonymous<ServerMeta>(serverUrl, 'GET', '/api/v1/meta')
    } catch (err) {
      if (err instanceof CloudError && err.status === 404) return null
      throw err
    }
  }

  private async send(
    method: string,
    url: string,
    body: unknown,
    token: string | null
  ): Promise<{ status: number; payload: unknown; text: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal
      })
      const text = await response.text()
      return { status: response.status, payload: parseJson(text), text }
    } catch (err) {
      throw new CloudError(0, 'network', describeNetworkError(err))
    } finally {
      clearTimeout(timer)
    }
  }

  /** A call that needs a signed-in account; refreshes and retries once. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const session = this.accounts.get()
    if (!session) throw new CloudError(401, 'signed_out', mt('还没有登录'))
    const first = await this.send(method, `${session.serverUrl}${path}`, body, session.accessToken)
    if (first.status === 401) {
      await this.refresh(session.accessToken)
      const again = this.accounts.get()
      if (!again) throw new CloudError(401, 'signed_out', mt('登录状态已失效，请重新登录'))
      const second = await this.send(method, `${again.serverUrl}${path}`, body, again.accessToken)
      if (second.status >= 400) this.fail(second)
      return second.payload as T
    }
    if (first.status >= 400) this.fail(first)
    return first.payload as T
  }

  /** A call made before there is a session (login, register, health). */
  async anonymous<T>(serverUrl: string, method: string, path: string, body?: unknown): Promise<T> {
    const base = this.serverAddress(serverUrl)
    const result = await this.send(method, `${base}${path}`, body, null)
    if (result.status >= 400) this.fail(result)
    return result.payload as T
  }

  private fail(result: { status: number; payload: unknown; text: string }): never {
    const code = payloadCode(result.payload) || `http_${result.status}`
    const message = payloadMessage(result.payload, mt('服务器返回 {{status}}', { status: result.status }))
    throw new CloudError(result.status, code, message)
  }

  /** Exchanges the refresh token for a new pair. Clears the store when that fails. */
  refresh(rejectedToken?: string): Promise<Session> {
    const current = this.accounts.get()
    // A slower 401 may arrive after another request already rotated the tokens.
    if (current && rejectedToken && current.accessToken !== rejectedToken) return Promise.resolve(current)
    if (this.refreshing) return this.refreshing
    this.refreshing = this.rotateTokens().finally(() => { this.refreshing = null })
    return this.refreshing
  }

  private serverAddress(value: string): string {
    const address = normalizeServerUrl(value)
    if (!address) throw new CloudError(0, 'bad_server_url', mt('先填有效的 HTTP 或 HTTPS 服务器地址'))
    return address
  }

  private async rotateTokens(): Promise<Session> {
    const session = this.accounts.get()
    if (!session) throw new CloudError(401, 'signed_out', mt('还没有登录'))
    const result = await this.send(
      'POST',
      `${session.serverUrl}/api/v1/auth/refresh`,
      { refreshToken: session.refreshToken },
      null
    )
    if (result.status >= 400) {
      if (result.status !== 401 && result.status !== 403) this.fail(result)
      this.accounts.expire()
      throw new CloudError(result.status, payloadCode(result.payload) || 'refresh_failed', mt('登录状态已过期，请重新登录'))
    }
    const payload = result.payload as AuthPayload
    this.accounts.updateTokens(payload.accessToken, payload.refreshToken, payload.expiresIn)
    const next = this.accounts.get()
    if (!next) throw new CloudError(401, 'signed_out', mt('登录状态已过期，请重新登录'))
    return next
  }

  /**
   * Asks the server to mail a sign-up or password-reset code.
   *
   * `required: false` is the answer of a deployment that does not verify
   * addresses (or of an older server that predates the endpoint): the form then
   * skips the code field instead of waiting for a mail that will never arrive.
   */
  async requestCode(
    serverUrl: string,
    email: string,
    purpose: 'register' | 'reset' = 'register'
  ): Promise<{ required: boolean }> {
    const base = this.serverAddress(serverUrl)
    try {
      const payload = await this.anonymous<{ required?: boolean }>(base, 'POST', '/api/v1/auth/code', {
        email: email.trim(),
        purpose
      })
      return { required: payload.required !== false }
    } catch (err) {
      if (err instanceof CloudError && (err.status === 404 || err.code === 'not_found')) {
        return { required: false }
      }
      throw err
    }
  }

  /**
   * Sets a new password with a mailed reset code.
   *
   * The server revokes every existing session afterwards, which is why the form
   * sends the user back to the sign-in view instead of signing them in.
   */
  async resetPassword(serverUrl: string, email: string, code: string, password: string): Promise<void> {
    const base = this.serverAddress(serverUrl)
    await this.anonymous(base, 'POST', '/api/v1/auth/password/reset', {
      email: email.trim(),
      code: code.trim(),
      password
    })
  }

  /** Logs in (or registers) and stores the session. */
  async authenticate(
    serverUrl: string,
    mode: 'login' | 'register',
    email: string,
    password: string,
    code = ''
  ): Promise<Session> {
    const base = this.serverAddress(serverUrl)
    const payload = await this.anonymous<AuthPayload>(base, 'POST', `/api/v1/auth/${mode}`, {
      email: email.trim(),
      password,
      ...(mode === 'register' && code ? { code: code.trim() } : {})
    })
    const session: Session = {
      serverUrl: base,
      email: payload.user?.email ?? email.trim(),
      userId: payload.user?.id ?? '',
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken,
      accessExpiresAt: Date.now() + Math.max(0, payload.expiresIn) * 1000,
      subscription: payload.user?.subscription ?? null
    }
    this.accounts.set(session)
    return session
  }

  /** `GET /auth/me`, which is also how the subscription is refreshed. */
  async me(): Promise<{ userId: string; email: string; subscription: SubscriptionInfo | null }> {
    const payload = await this.request<{ user: { id: string; email: string; subscription?: SubscriptionInfo | null } }>(
      'GET',
      '/api/v1/auth/me'
    )
    const subscription = payload.user?.subscription ?? null
    this.accounts.setSubscription(subscription)
    return {
      userId: payload.user?.id ?? '',
      email: payload.user?.email ?? '',
      subscription
    }
  }

  async logout(): Promise<void> {
    const session = this.accounts.get()
    if (session) {
      // Best effort: the local session is dropped even when the server is gone.
      try {
        await this.send('POST', `${session.serverUrl}/api/v1/auth/logout`, { refreshToken: session.refreshToken }, session.accessToken)
      } catch (err) {
        console.warn('[cloud] logout call failed, dropping the local session anyway:', err)
      }
    }
    this.accounts.clear()
  }

  // ------------------------------------------------------------------- notes

  /**
   * One notes push.
   *
   * A 409 is an answer, not a failure: the server names the notes another device
   * changed and sends its copies so they can be merged. Turning that into an
   * exception would abort a sync that is supposed to finish.
   */
  async pushNotes(changes: unknown[]): Promise<{ status: number; payload: NotesPushResult }> {
    return this.sendAuthed<NotesPushResult>('POST', '/api/v1/notes/changes', { changes })
  }

  pullNotes(since: number, limit: number): Promise<NotesPage> {
    return this.request<NotesPage>('GET', `/api/v1/notes?since=${since}&limit=${limit}`)
  }

  /** Puts this machine's recording for one note on the server. */
  async uploadNoteAudio(
    id: string,
    format: 'ogg' | 'wav',
    data: Uint8Array
  ): Promise<{ status: number; payload: unknown }> {
    const path = `/api/v1/notes/${encodeURIComponent(id)}/audio?format=${format}`
    const contentType = format === 'wav' ? 'audio/wav' : 'audio/ogg'
    let session = this.accounts.get()
    if (!session) throw new CloudError(401, 'signed_out', mt('还没有登录'))
    let result = await this.sendBinary('PUT', `${session.serverUrl}${path}`, data, contentType, session.accessToken)
    if (result.status === 401) {
      session = await this.refresh(session.accessToken)
      result = await this.sendBinary('PUT', `${session.serverUrl}${path}`, data, contentType, session.accessToken)
    }
    // Error bodies are small JSON; an audio body never is.
    const payload = result.bytes.byteLength > 0 && result.bytes.byteLength <= 4096
      ? parseJson(new TextDecoder().decode(result.bytes))
      : null
    if (result.status >= 400) {
      throw new CloudError(
        result.status,
        payloadCode(payload) || `http_${result.status}`,
        payloadMessage(payload, mt('录音上传失败'))
      )
    }
    return { status: result.status, payload }
  }

  /** Fetches one recording; null when the server has none for this note. */
  async downloadNoteAudio(id: string): Promise<Uint8Array | null> {
    const path = `/api/v1/notes/${encodeURIComponent(id)}/audio`
    let session = this.accounts.get()
    if (!session) throw new CloudError(401, 'signed_out', mt('还没有登录'))
    let result = await this.sendBinary('GET', `${session.serverUrl}${path}`, null, null, session.accessToken)
    if (result.status === 401) {
      session = await this.refresh(session.accessToken)
      result = await this.sendBinary('GET', `${session.serverUrl}${path}`, null, null, session.accessToken)
    }
    if (result.status === 404) return null
    if (result.status >= 400) {
      throw new CloudError(result.status, `http_${result.status}`, mt('录音下载失败'))
    }
    return result.bytes
  }

  /** Bytes used, quota and recording count, for the account page. */
  storage(): Promise<StorageUsage> {
    return this.request<StorageUsage>('GET', '/api/v1/user/storage')
  }

  /** Like `request`, but keeps the status so callers can treat 409 as data. */
  private async sendAuthed<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; payload: T }> {
    const session = this.accounts.get()
    if (!session) throw new CloudError(401, 'signed_out', mt('还没有登录'))
    let result = await this.send(method, `${session.serverUrl}${path}`, body, session.accessToken)
    if (result.status === 401) {
      const again = await this.refresh(session.accessToken)
      result = await this.send(method, `${again.serverUrl}${path}`, body, again.accessToken)
      if (result.status === 401) this.fail(result)
    }
    if (result.status >= 400 && result.status !== 409) this.fail(result)
    return { status: result.status, payload: result.payload as T }
  }

  /** A binary body in, raw bytes out. No JSON parsing, no text decoding. */
  private async sendBinary(
    method: string,
    url: string,
    body: Uint8Array | null,
    contentType: string | null,
    token: string | null
  ): Promise<{ status: number; bytes: Uint8Array }> {
    const controller = new AbortController()
    // Recordings are tens of megabytes on a slow uplink; the JSON window is too tight.
    const timer = setTimeout(() => controller.abort(), 5 * 60_000)
    try {
      const init: RequestInit = {
        method,
        headers: {
          ...(contentType ? { 'content-type': contentType } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        signal: controller.signal
      }
      // A Uint8Array is accepted here at runtime; the node typing for `body` does
      // not know the byte-array overload under this tsconfig.
      if (body) init.body = body as unknown as RequestInit['body']
      const response = await fetch(url, init)
      const bytes = new Uint8Array(await response.arrayBuffer())
      return { status: response.status, bytes }
    } catch (err) {
      throw new CloudError(0, 'network', describeNetworkError(err))
    } finally {
      clearTimeout(timer)
    }
  }
}

interface NotesPushResult {
  applied?: string[]
  duplicates?: string[]
  conflicts?: Array<{ id?: string; server?: Record<string, unknown> | null; error?: string }>
  cursor?: number
}

interface NotesPage {
  cursor: number
  notes: unknown[]
  hasMore: boolean
}

/**
 * What the sync engine needs from the note store.
 *
 * Declared here rather than imported as the class so a test can hand the engine a
 * few plain objects instead of a whole NotesStore on disk.
 */
export interface NotesSyncSource {
  pendingChanges(limit?: number): { live: NoteEntry[]; dead: Array<{ id: string; version: number }> }
  pendingCount(): number
  markPushed(accepted: Array<{ id: string; version?: number; updatedAt?: number }>): void
  markDeleted(ids: string[]): void
  applyRemote(rows: unknown[]): { applied: number; conflicts: number; audio: RemoteAudio[] }
  audioPending(limit?: number): Array<{ id: string; format: 'ogg' | 'wav' }>
  hasAudio(id: string): boolean
  audioData(id: string): { data: Uint8Array; format: 'ogg' | 'wav' } | null
  writeRemoteAudio(id: string, data: Uint8Array, format: 'ogg' | 'wav'): void
  markAudioUploaded(id: string): void
  retargetTombstone(id: string, version: number): void
}

/** A note as the server expects it in a change list. */
function toNoteChange(note: NoteEntry): Record<string, unknown> {
  return {
    id: note.id,
    // 0 is what the server expects for a note it has never seen; it is not a guess.
    version: note.version ?? 0,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    durationMs: note.durationMs,
    transcript: note.transcript,
    polished: note.polished,
    polishStatus: note.polishStatus,
    polishError: note.polishError ?? null,
    categoryId: note.categoryId ?? null,
    tags: note.tags,
    editedAt: note.editedAt ?? null
  }
}

interface SyncState {
  /** Server timestamp of the newest row this machine has pulled. */
  pullCursor: number
  /** Local stamp of the newest row already accepted by the server. */
  pushCursor: number
  /** Server seq of the newest note this machine has pulled. */
  notesCursor: number
  lastSyncAt: number
  lastError: string
  remoteCount: number
}

const EMPTY_STATE: SyncState = {
  pullCursor: 0,
  pushCursor: 0,
  notesCursor: 0,
  lastSyncAt: 0,
  lastError: '',
  remoteCount: -1
}

interface PullPage {
  revision: number
  entries: Array<Record<string, unknown> & { id?: string; deleted?: boolean; updatedAt?: number }>
  hasMore: boolean
  nextSince: number
}

/**
 * Pushes local history and pulls the server's, on a timer.
 *
 * Order matters: push first, then pull. Pulling first would merge rows that then
 * have to be pushed back, and the two machines would trade the same rows forever.
 */
export class SyncEngine {
  private state: SyncState
  private timer: NodeJS.Timeout | null = null
  private running: Promise<SyncStatus> | null = null
  private statusListeners = new Set<(status: SyncStatus) => void>()
  /** Recordings the last pull page mentioned but this machine does not have yet. */
  private pendingAudio: RemoteAudio[] = []

  constructor(
    private readonly history: HistoryStore,
    private readonly accounts: AccountStore,
    private readonly client: CloudClient,
    private readonly getSettings: () => Settings,
    private readonly log: (line: string) => void,
    private readonly filePath = join(app.getPath('userData'), 'sync-state.json'),
    private readonly notes: NotesSyncSource | null = null
  ) {
    this.state = this.readState()
  }

  private readState(): SyncState {
    if (!existsSync(this.filePath)) return { ...EMPTY_STATE }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<SyncState>
      return {
        pullCursor: Number(parsed.pullCursor) || 0,
        pushCursor: Number(parsed.pushCursor) || 0,
        notesCursor: Number(parsed.notesCursor) || 0,
        lastSyncAt: Number(parsed.lastSyncAt) || 0,
        lastError: typeof parsed.lastError === 'string' ? parsed.lastError : '',
        remoteCount: Number.isFinite(Number(parsed.remoteCount)) ? Number(parsed.remoteCount) : -1
      }
    } catch (err) {
      console.error('[sync] cannot read sync-state.json, starting from zero:', err)
      return { ...EMPTY_STATE }
    }
  }

  private writeState(): void {
    const temp = `${this.filePath}.${process.pid}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(this.state, null, 2), 'utf8')
      renameSync(temp, this.filePath)
    } catch (err) {
      console.error('[sync] cannot write sync-state.json:', err)
    }
  }

  onStatus(listener: (status: SyncStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private emit(status: SyncStatus): SyncStatus {
    for (const listener of this.statusListeners) listener(status)
    return status
  }

  /**
   * What the status looks like with no run in flight.
   *
   * Separate from `status()` because `run()` has to report its own outcome while
   * `this.running` is still set: asking `status()` from inside a run is what made
   * every failure come back as "syncing".
   */
  private snapshot(): SyncStatus {
    const settings = this.getSettings()
    const session = this.accounts.get()
    const enabled = settings.syncEnabled && session !== null
    const pending = enabled
      ? this.history.pendingSince(this.state.pushCursor) + (this.notes?.pendingCount() ?? 0)
      : 0
    return {
      enabled,
      state: !enabled ? 'off' : this.state.lastError ? 'error' : 'idle',
      pending,
      lastSyncAt: this.state.lastSyncAt,
      lastError: this.state.lastError
    }
  }

  status(): SyncStatus {
    const snapshot = this.snapshot()
    if (snapshot.state === 'off' || !this.running) return this.emit(snapshot)
    return this.emit({ ...snapshot, state: 'syncing' })
  }

  /** Re-arms the timer after a settings change. */
  reconfigure(): void {
    this.stop()
    const settings = this.getSettings()
    const interval = Math.max(0, Math.trunc(settings.syncIntervalSeconds))
    if (!settings.syncEnabled || !this.accounts.get() || interval === 0) return
    this.timer = setInterval(() => {
      void this.now().catch((err: unknown) => console.error('[sync] tick failed:', err))
    }, interval * 1000)
    // Node keeps the process alive for a pending timer; this one is not a reason to.
    this.timer.unref?.()
    void this.now().catch((err: unknown) => console.error('[sync] first run failed:', err))
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One full push+pull. Concurrent calls share the same run. */
  now(): Promise<SyncStatus> {
    if (this.running) return this.running
    this.running = this.run().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async run(): Promise<SyncStatus> {
    const settings = this.getSettings()
    const session = this.accounts.get()
    if (!settings.syncEnabled || !session) {
      this.state.lastError = ''
      this.writeState()
      return this.emit(this.snapshot())
    }
    this.status()
    try {
      // Notes first: their text has to exist on the server before a recording can
      // be attached to it, and their tombstones have to land before deletions.
      await this.pushNotes()
      const notesCursor = await this.pullNotes()
      await this.pushAll()
      await this.pullAll()
      await this.syncNoteAudio()
      // Keep the old durable cursor until recordings are on disk as well. A
      // failed download (or a restart) must replay the page that advertised it.
      this.state.notesCursor = notesCursor
      this.state.lastSyncAt = Date.now()
      this.state.lastError = ''
      this.log(`[sync] done, ${this.state.remoteCount} row(s) on the server`)
    } catch (err) {
      const message = err instanceof CloudError ? err.message : err instanceof Error ? err.message : String(err)
      this.state.lastError = message
      this.log(`[sync] failed: ${message}`)
    }
    this.writeState()
    return this.emit(this.snapshot())
  }

  /**
   * Sends the notes this machine has changed since the server last confirmed them.
   *
   * A conflict is settled by adopting the server's copy and keeping the local text
   * as a separate note, which the next pass then pushes. Nothing the user typed is
   * thrown away, and the local copy is no longer dirty afterwards, so the same
   * conflict cannot come back on the following sync.
   */
  private async pushNotes(): Promise<void> {
    const notes = this.notes
    if (!notes) return
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const pending = notes.pendingChanges(PAGE)
      const live = pending.live.slice(0, PAGE)
      const dead = pending.dead.slice(0, PAGE - live.length)
      if (live.length === 0 && dead.length === 0) return
      const changes = [
        ...live.map(toNoteChange),
        ...dead.map((item) => ({ id: item.id, version: item.version, deleted: true }))
      ]
      const result = await this.client.pushNotes(changes)
      const payload = result.payload ?? {}
      const accepted = [...(payload.applied ?? []), ...(payload.duplicates ?? [])]
      notes.markPushed(accepted.map((id) => {
        const sent = live.find((note) => note.id === id)
        return sent ? { id, version: (sent.version ?? 0) + 1, updatedAt: sent.updatedAt } : { id }
      }))
      notes.markDeleted(dead.filter((item) => accepted.includes(item.id)).map((item) => item.id))
      // Applied and duplicate rows both have sent.version + 1. Keep the pull
      // cursor unchanged so concurrent changes on other devices are still read.
      this.writeState()

      const conflicts = payload.conflicts ?? []
      if (conflicts.length === 0) {
        if (live.length < PAGE && dead.length < PAGE) return
        continue
      }

      const gone = new Set(dead.map((item) => item.id))
      for (const conflict of conflicts) {
        const id = String(conflict.id ?? '')
        if (!id) continue
        const server = conflict.server
        if (!server) {
          // The id exists under another account. There is nothing to merge, and
          // retrying it forever would keep the sync permanently red.
          this.log(`[sync] note ${id} refused by the server (${conflict.error ?? 'conflict'})`)
          notes.markPushed([{ id }])
          continue
        }
        if (gone.has(id)) {
          // The deletion lost a race; retry it against the version that now exists.
          notes.retargetTombstone(id, Number(server.version) || 0)
          continue
        }
        notes.applyRemote([server])
      }
      // The merge above leaves work for the next pass (the forked copies). Stopping
      // here keeps one sync bounded instead of pushing in a loop.
      return
    }
  }

  /** Merges everything the server changed since the last notes cursor. */
  private async pullNotes(): Promise<number> {
    const notes = this.notes
    if (!notes) return this.state.notesCursor
    let cursor = this.state.notesCursor
    this.pendingAudio = []
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.client.pullNotes(cursor, PAGE)
      const rows = Array.isArray(result.notes) ? result.notes : []
      const merged = notes.applyRemote(rows)
      if (merged.conflicts > 0) {
        this.log(`[sync] ${merged.conflicts} 条随记冲突：本机改动已另存`)
      }
      this.pendingAudio.push(...merged.audio)
      const next = Number(result.cursor)
      if (Number.isFinite(next) && next >= 0) cursor = next
      if (!result.hasMore || rows.length === 0) break
    }
    return cursor
  }

  /**
   * Moves recordings in both directions.
   *
   * Download before upload: a note that arrived from another device already has
   * its audio on the server, and re-uploading the local copy would only burn the
   * user's quota. The local recording is the source of truth for notes this
   * machine created, so an upload failure is logged and retried on the next pass.
   */
  private async syncNoteAudio(): Promise<void> {
    const notes = this.notes
    if (!notes) return
    let failure: Error | null = null
    for (const item of this.pendingAudio) {
      if (notes.hasAudio(item.id)) continue
      try {
        const bytes = await this.client.downloadNoteAudio(item.id)
        if (!bytes || bytes.byteLength === 0) throw new Error(`录音 ${item.id} 下载为空`)
        if (item.sha256) {
          const digest = createHash('sha256').update(bytes).digest('hex')
          if (digest !== item.sha256) {
            throw new Error(`录音 ${item.id} 校验不通过`)
          }
        }
        notes.writeRemoteAudio(item.id, bytes, item.format)
        if (!notes.hasAudio(item.id)) throw new Error(`录音 ${item.id} 未能保存到本机`)
      } catch (err) {
        this.log(`[sync] 下载录音失败 ${item.id}：${describeError(err)}`)
        failure ??= new Error(`下载录音失败：${describeError(err)}`)
      }
    }
    this.pendingAudio = []

    for (const item of notes.audioPending(PAGE)) {
      const local = notes.audioData(item.id)
      if (!local) {
        failure ??= new Error(`无法读取待上传的录音 ${item.id}`)
        continue
      }
      try {
        await this.client.uploadNoteAudio(item.id, local.format, local.data)
        notes.markAudioUploaded(item.id)
      } catch (err) {
        // Quota and size limits fail the same way every time; report once per pass
        // and let the rest of the account keep syncing.
        this.log(`[sync] 上传录音失败 ${item.id}：${describeError(err)}`)
        failure ??= new Error(`上传录音失败：${describeError(err)}`)
      }
    }
    if (failure) throw failure
  }

  /** Sends every local change page by page, advancing the cursor as it goes. */
  private async pushAll(): Promise<void> {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const rows = this.history.changesSince(this.state.pushCursor, PAGE)
      const gone = this.history.deletionsSince(this.state.pushCursor, PAGE)
      if (rows.length === 0 && gone.length === 0) return
      let newest = this.state.pushCursor
      for (const row of rows) newest = Math.max(newest, row.updatedAt ?? row.createdAt)
      for (const item of gone) newest = Math.max(newest, item.deletedAt)
      await this.client.request('POST', '/api/v1/transcription_history/push', {
        entries: rows.map(toSyncRow),
        deleted: gone.map((item) => item.id)
      })
      // Persisted after every page: a crash mid-push must not re-send what the
      // server already accepted, and `updatedAt > cursor` can never re-read it.
      this.state.pushCursor = newest
      this.writeState()
      if (rows.length < PAGE && gone.length < PAGE) return
    }
  }

  /** Pulls everything newer than the last pull cursor. */
  private async pullAll(): Promise<void> {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.client.request<PullPage>(
        'GET',
        `/api/v1/transcription_history/pull?since=${this.state.pullCursor}&limit=${PAGE}`
      )
      const entries = Array.isArray(result.entries) ? result.entries : []
      const live = entries.filter((entry) => entry.deleted !== true)
      // A tombstone carries the server timestamp under `updatedAt`; the store keys
      // deletions by `deletedAt`, and reading the wrong field made every remote
      // deletion look like it happened at t=0 — i.e. never applied.
      const dead = entries
        .filter((entry) => entry.deleted === true)
        .map((entry) => ({ id: String(entry.id ?? ''), deletedAt: Number(entry.updatedAt) || 0 }))
        .filter((item) => item.id !== '' && item.deletedAt > 0)
      await this.history.applyRemote(live, dead)
      const newest = Number(result.nextSince)
      if (Number.isFinite(newest) && newest >= 0) this.state.pullCursor = newest
      if (!result.hasMore || entries.length === 0) break
    }
    // Only pushAll advances the acknowledged local stamp. Advancing it to the
    // latest local row here would skip edits made while the HTTP calls ran.
    // Pulled rows can be echoed once next time; the server accepts them idempotently.
    const status = await this.client.request<{ count: number }>('GET', '/api/v1/transcription_history/sync_status')
    if (Number.isFinite(Number(status.count))) this.state.remoteCount = Number(status.count)
  }

  /** Asks the server to tombstone everything. The next pull deletes it locally. */
  async wipeRemote(): Promise<number> {
    // Emptying the server is one-way for the account: the rows stay in this
    // machine's own history — the button says 清空服务器历史, not 清空本机历史 — so
    // both cursors jump past everything instead of back to zero. At zero the next
    // push would upload every row again and undo the wipe a second later, and a
    // pull would apply the tombstones it just caused to the local database.
    const result = await this.client.request<{ revision: number; cursor?: number; wiped?: number }>(
      'DELETE',
      '/api/v1/transcription_history/wipe'
    )
    const local = this.history.newestStamp()
    const remote = Number(result.cursor)
    // A server that predates the seq cursor answers without one; its own pull
    // cursor is a timestamp, which is exactly what `local` holds.
    this.state.pullCursor = Number.isFinite(remote) && remote > 0 ? remote : local
    this.state.pushCursor = local
    this.state.remoteCount = 0
    this.writeState()
    return 0
  }

  /** Local view of the account, safe to send to the renderer. */
  accountView(): AccountView {
    const session = this.accounts.get()
    const known = this.accounts.knownAccount()
    return {
      signedIn: session !== null,
      needsSignIn: this.accounts.needsSignIn(),
      email: session?.email ?? known?.email ?? '',
      serverUrl: session?.serverUrl ?? known?.serverUrl ?? this.getSettings().syncServerUrl,
      subscription: session?.subscription ?? null,
      remoteCount: this.state.remoteCount,
      lastSyncAt: this.state.lastSyncAt,
      lastError: this.state.lastError,
      // Filled in by the caller, which is the only place that may hit the network
      // for a status view.
      storage: null
    }
  }
}
