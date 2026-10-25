/**
 * Calendar sync: external `.ics` subscriptions in, and the self-hosted server in
 * both directions.
 *
 * Two separate problems share this file because they share one subject — the
 * calendar store — and because both are "a remote party has an opinion about the
 * user's schedule":
 *
 * 1. **Subscriptions are read-only mirrors.** A feed is parsed and merged by
 *    `uid`; the merge itself lives in `CalendarStore.importIcs`, which already
 *    preserves the local cancellation state of an event the user refused. Nothing
 *    here can delete an event: a feed that disappears must not empty the calendar.
 * 2. **The server sync is a two-way cursor.** It uses the same `seq` + tombstone
 *    protocol as the notes sync, so the reasoning there applies here: push first
 *    (a row the server has not seen must exist before its deletion can land), then
 *    pull, and never move the cursor backwards.
 *
 * Failures are logged, never thrown: a subscription that 404s or a server that is
 * asleep must not stop the dictation history from syncing. The caller decides what
 * to do with the returned counts.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mt } from '@shared/mainI18n'
import type { CalendarEvent } from '@shared/calendar'
import { inspectUrl, safeFetch } from './safe-fetch'

/** Generous for a text file, and short enough that a stuck feed cannot block a sync. */
export const DEFAULT_ICS_TIMEOUT_MS = 15_000
/** A normal `.ics` feed is tens of kilobytes; this is the ceiling we bother parsing. */
const MAX_ICS_BYTES = 5 * 1024 * 1024
/** Matches the server's MAX_PUSH so one pass never builds a batch the server refuses. */
const PAGE = 200
const MAX_PAGES = 50

/** One `settings.calendar.externalCalendars` entry. The Lead owns the real type. */
export interface ExternalCalendar {
  id: string
  name: string
  url: string
  enabled: boolean
  lastFetchedAt?: number
}

export interface IcsResponse {
  ok: boolean
  status: number
  text(): Promise<string>
  /**
   * Both optional so a fake that only answers `text()` stays valid: the cap can
   * then only be checked on the finished string, which is the old behaviour.
   */
  headers?: { get(name: string): string | null }
  body?: ReadableStream<Uint8Array> | null
}

/**
 * The feed announced or streamed more than the ceiling allows.
 *
 * A distinct type because `refreshOne` owes the user a different sentence for
 * this case: "file too large" is something they can act on, while a generic
 * transport error is not. `name` is set as well so the check still works when
 * only an error's shape survives a transport or a bundle boundary.
 */
export class FeedTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`feed exceeds ${limit} bytes`)
    this.name = 'FeedTooLargeError'
  }
}

function isFeedTooLarge(err: unknown): boolean {
  return err instanceof FeedTooLargeError || (err instanceof Error && err.name === 'FeedTooLargeError')
}

/**
 * Reads a feed body without ever holding more than `limit` bytes of it.
 *
 * `response.text()` is not a guard: it resolves only once the whole body is in
 * memory, so a feed that streams a gigabyte is already a gigabyte of string by
 * the time its length can be checked. The ceiling is therefore applied at every
 * stage available — the announced length, then the running byte count while
 * reading, then (only when there is no stream to cap) the finished string.
 *
 * One chunk may push the total past `limit` before it is noticed; that is what
 * "limit plus one chunk" means, and the chunk is dropped, not accumulated.
 */
export async function readCappedText(response: IcsResponse, limit: number): Promise<string> {
  const announced = response.headers?.get('content-length')
  if (announced) {
    const bytes = Number(announced)
    // An unparseable header says nothing about the size; the stream check below
    // still holds the line.
    if (Number.isFinite(bytes) && bytes > limit) throw new FeedTooLargeError(limit)
  }
  const body = response.body
  if (!body) {
    // Test stubs, or a transport that already decoded: there is no stream left to
    // stop, so the decoded size is all we can inspect.
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > limit) throw new FeedTooLargeError(limit)
    return text
  }
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let received = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      received += value.byteLength
      if (received > limit) {
        // Cancel before rejecting: the socket is the only thing still growing,
        // and nobody is going to drain it.
        await reader.cancel().catch(() => {})
        throw new FeedTooLargeError(limit)
      }
      // `stream: true` keeps a character split across two chunks intact instead
      // of decoding each chunk as if it ended on a boundary.
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally {
    // The lock is what keeps the transport from closing the body; a cancelled
    // read in particular leaves it held unless it is released.
    try {
      reader.releaseLock()
    } catch {
      /* some implementations release it in cancel(); nothing left to do */
    }
  }
}

/** Only the slice of `fetch` this module needs, so a test can hand in a fake. */
export type IcsFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> }
) => Promise<IcsResponse>

export interface IcsMerge {
  added: number
  updated: number
  skipped: number
}

export interface ExternalCalendarOptions {
  getCalendars: () => ReadonlyArray<ExternalCalendar>
  /**
   * Injected so a test can fake the transport.
   *
   * When it is absent the module fetches through `safeFetch`, which follows
   * redirects by hand and re-validates every hop. A bare `fetch` here used to
   * inherit undici's `redirect: 'follow'`, so a subscription could bounce into the
   * user's LAN and nothing would look at the address it landed on.
   */
  fetchImpl?: IcsFetch
  /** `CalendarStore`, structurally: importing the class would drag the stored file in. */
  store: { importIcs(text: string): IcsMerge }
  log: (line: string) => void
  now?: () => number
  timeoutMs?: number
  /** Called once per successfully fetched feed so the settings can record the stamp. */
  onFetched?: (id: string, at: number) => void
}

export interface ExternalCalendarResult {
  feeds: number
  added: number
  updated: number
  failed: number
}

/**
 * `webcal://` is a scheme an OS registers for "open my calendar app", not a
 * protocol; every public feed behind it is plain HTTPS. Rewriting here means the
 * rest of the function only ever sees http(s) and the SSRF check has one input.
 */
export function resolveFeedUrl(raw: string): string {
  const value = String(raw ?? '').trim()
  if (/^webcals?:\/\//i.test(value)) return value.replace(/^webcals?:\/\//i, 'https://')
  return value
}

/**
 * The URL a subscription may point at, or the reason it may not.
 *
 * This is the cheap half of the guard (protocol and host string); `safeFetch`
 * adds the address check and repeats both on every redirect hop. It stays here
 * because settings validation has to answer synchronously, before any DNS lookup.
 */
export function checkFeedUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  const resolved = resolveFeedUrl(raw)
  const check = inspectUrl(resolved)
  if (!check.ok || !check.url) return { ok: false, reason: check.error ?? mt('订阅地址不可用') }
  if (check.url.protocol !== 'https:') {
    // `webcal` became https above, so anything still on http was typed as http.
    // A feed carries events the user will be reminded about; plaintext over the
    // internet is not worth the compatibility.
    return { ok: false, reason: mt('订阅地址必须是 https 或 webcal 链接') }
  }
  return { ok: true, url: check.url.toString() }
}

/**
 * The transport used when the caller injected none.
 *
 * Only `ok`, `status`, `headers.get`, `body` and `text()` are consumed here, all
 * of which `safeFetch`'s real `Response` provides — no wrapper and no cast. A URL
 * the guard refuses throws, and `refreshOne` turns that into one log line like
 * any other failure.
 */
const defaultFeedFetch: IcsFetch = async (url, init) => safeFetch(url, init)

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Abort first: the rejection below settles this promise, and a fetch that
      // ignores the signal would otherwise keep the socket open.
      try {
        onTimeout()
      } catch {
        /* abort() on an already-finished request throws; nothing to do */
      }
      reject(new Error(mt('拉取超时（{{seconds}} 秒）', { seconds: Math.max(1, Math.round(ms / 1000)) })))
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    )
  })
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Fetches one feed and merges it.
 *
 * Returns the merge counts, or null when this feed failed — a failure is one log
 * line, never an exception: one broken subscription must not stop the others.
 */
async function refreshOne(
  calendar: ExternalCalendar,
  options: ExternalCalendarOptions
): Promise<IcsMerge | null> {
  const label = calendar.name || calendar.id
  const checked = checkFeedUrl(calendar.url)
  if (!checked.ok) {
    options.log(mt('订阅日历 {{name}} 已跳过：{{reason}}', { name: label, reason: checked.reason }))
    return null
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_ICS_TIMEOUT_MS
  const doFetch = options.fetchImpl ?? defaultFeedFetch
  const controller = new AbortController()
  try {
    const response = await withTimeout(
      doFetch(checked.url, {
        signal: controller.signal,
        headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5' }
      }),
      timeoutMs,
      () => controller.abort()
    )
    if (!response.ok) {
      options.log(mt('订阅日历 {{name}} 拉取失败：HTTP {{status}}', { name: label, status: response.status }))
      return null
    }
    // The cap is enforced inside the read, not after it: `response.text()` would
    // have already buffered the whole body by the time its length could be seen.
    const text = await withTimeout(
      readCappedText(response, MAX_ICS_BYTES),
      timeoutMs,
      () => controller.abort()
    )
    const merged = options.store.importIcs(text)
    options.onFetched?.(calendar.id, (options.now ?? Date.now)())
    options.log(mt('订阅日历 {{name}} 已更新：新增 {{added}} 条，更新 {{updated}} 条', {
      name: label,
      added: merged.added,
      updated: merged.updated
    }))
    return merged
  } catch (err) {
    if (isFeedTooLarge(err)) {
      options.log(mt('订阅日历 {{name}} 拉取失败：文件过大', { name: label }))
      return null
    }
    options.log(mt('订阅日历 {{name}} 拉取失败：{{reason}}', { name: label, reason: describe(err) }))
    return null
  }
}

/**
 * Refreshes every enabled subscription.
 *
 * Sequential on purpose: a user with a dozen feeds would otherwise open a dozen
 * sockets at once on a laptop that is perhaps on a phone hotspot, and the merge
 * writes one file per event — the store is not built for concurrent writers.
 */
export async function refreshExternalCalendars(
  options: ExternalCalendarOptions
): Promise<ExternalCalendarResult> {
  const calendars = options.getCalendars().filter((entry) => entry.enabled)
  const result: ExternalCalendarResult = { feeds: 0, added: 0, updated: 0, failed: 0 }
  for (const calendar of calendars) {
    result.feeds += 1
    const merged = await refreshOne(calendar, options)
    if (!merged) {
      result.failed += 1
      continue
    }
    result.added += merged.added
    result.updated += merged.updated
  }
  return result
}

// ------------------------------------------------------------------ server sync

/** What a change carries on the wire; the server validates the same fields. */
interface CalendarChange {
  id: string
  title: string
  start: number
  end: number
  allDay: boolean
  location: string | null
  notes: string | null
  leadMinutes: number | null
  source: string
  uid: string | null
  status: string
  updatedAt: number
  deletedAt?: number
}

export interface CalendarPushResult {
  applied?: string[]
  duplicates?: string[]
  /**
   * Ids the server already holds a *newer* version of.
   *
   * Distinct from `conflicts`: a conflict is "this id belongs to another account",
   * stale is "your copy is older than mine". Treating the two the same on purpose —
   * see `push` — because the local row must not be dropped either way.
   */
  stale?: string[]
  conflicts?: Array<{ id?: string; error?: string; server?: Record<string, unknown> | null }>
  cursor?: number
}

export interface CalendarPage {
  cursor: number
  events: unknown[]
  hasMore: boolean
}

/** The transport this module needs from `CloudClient`; declared here to avoid a cycle. */
export interface CalendarRemote {
  pushCalendar(changes: unknown[]): Promise<{ status: number; payload: CalendarPushResult }>
  pullCalendar(since: number, limit: number): Promise<CalendarPage>
}

export interface CalendarSyncStore {
  list(): CalendarEvent[]
  remove(id: string): void
  /**
   * Upserts one row verbatim, keeping its id, its stamps and its status.
   *
   * `save()` cannot do this: it mints a fresh id for a row it has not seen and
   * keeps an existing row's cancellation state whatever the input says, which is
   * exactly what a remote copy has to be able to overwrite. `CalendarStore` has to
   * grow this one method (see the report to the Lead).
   */
  put(row: CalendarEvent): void
}

interface CalendarSyncState {
  /** Server `seq` of the newest calendar row this machine has pulled. */
  cursor: number
  /** id → content signature the server has confirmed. */
  pushed: Record<string, string>
  /** ids seen locally on the last scan, so a disappearance can become a tombstone. */
  shown: string[]
  /** ids deleted locally that the server has not acknowledged yet → deletedAt. */
  tombstones: Record<string, number>
}

function emptyState(): CalendarSyncState {
  return { cursor: 0, pushed: {}, shown: [], tombstones: {} }
}

/**
 * The content of an event, as one comparable string.
 *
 * Deliberately excludes `updatedAt` and `notifiedAt`: they change on every write
 * and on every fired reminder, so a timestamp-based "is this dirty" test would
 * push the whole calendar on each pass. Includes `status`, because cancelling an
 * event is a change the other machine has to hear about.
 */
function signature(event: CalendarEvent): string {
  return JSON.stringify([
    event.title,
    event.start,
    event.end,
    event.allDay,
    event.location ?? null,
    event.notes ?? null,
    event.leadMinutes ?? null,
    event.status,
    event.uid ?? null
  ])
}

function toChange(event: CalendarEvent): CalendarChange {
  return {
    id: event.id,
    title: event.title,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    location: event.location ?? null,
    notes: event.notes ?? null,
    leadMinutes: event.leadMinutes ?? null,
    source: event.source,
    uid: event.uid ?? null,
    status: event.status,
    updatedAt: event.updatedAt
  }
}

/** A 404 means this server predates the calendar routes; retrying cannot help. */
function isUnsupported(err: unknown): boolean {
  return typeof err === 'object' && err !== null && Number((err as { status?: unknown }).status) === 404
}

/** One change plus the signature it was built from, so acceptance can be recorded. */
interface ScanEntry {
  id: string
  signature: string
  change: CalendarChange
  /** Set for a tombstone: the stamp the server should keep. */
  tombstone?: number
}

export interface CalendarSyncOptions {
  store: CalendarSyncStore
  /** Where the cursor and the confirmed signatures live. One file per resource. */
  file: string
  log: (line: string) => void
  now?: () => number
}

/**
 * Two-way calendar sync against the self-hosted server.
 *
 * Conflict rule: **the server wins, the local content is kept as a copy.** A
 * calendar row the user edited on a plane is still the row they typed; dropping it
 * because another device moved the same id would silently lose their work. The
 * copy is a normal new event, so the next pass pushes it and the user can delete it
 * if they disagree. That is the same bargain the notes sync makes.
 */
export class CalendarSync {
  private state: CalendarSyncState
  /** Server URL that answered 404 for the calendar routes, so we stop asking it. */
  private unsupportedServer = ''

  constructor(private readonly options: CalendarSyncOptions) {
    this.state = this.readState()
  }

  /** How many rows the next pass would push, for the status view. */
  pendingCount(): number {
    const events = this.options.store.list()
    const live = new Set(events.map((event) => event.id))
    const pending = new Set<string>()
    for (const event of events) {
      if (this.state.pushed[event.id] !== signature(event)) pending.add(event.id)
    }
    for (const id of Object.keys(this.state.tombstones)) if (!live.has(id)) pending.add(id)
    // A deletion is not a tombstone until `scan()` has seen it, but the counter is
    // read by the UI between passes, so it has to predict that transition itself.
    for (const id of this.state.shown) {
      if (!live.has(id) && this.state.pushed[id] !== undefined) pending.add(id)
    }
    return pending.size
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private readState(): CalendarSyncState {
    if (!existsSync(this.options.file)) return emptyState()
    try {
      const parsed = JSON.parse(readFileSync(this.options.file, 'utf8')) as Partial<CalendarSyncState>
      return {
        cursor: Number(parsed.cursor) > 0 ? Math.trunc(Number(parsed.cursor)) : 0,
        pushed: parsed.pushed && typeof parsed.pushed === 'object' ? parsed.pushed : {},
        shown: Array.isArray(parsed.shown) ? parsed.shown.filter((id): id is string => typeof id === 'string') : [],
        tombstones: parsed.tombstones && typeof parsed.tombstones === 'object' ? parsed.tombstones : {}
      }
    } catch (err) {
      // A damaged file costs one re-push, which the server treats as a batch of
      // duplicates. Refusing to start would cost the user their sync entirely.
      this.options.log(mt('日历同步状态无法读取，已从零开始：{{reason}}', { reason: describe(err) }))
      return emptyState()
    }
  }

  private writeState(): void {
    const temp = `${this.options.file}.${process.pid}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(this.state, null, 2), 'utf8')
      renameSync(temp, this.options.file)
    } catch (err) {
      this.options.log(mt('日历同步状态无法写入：{{reason}}', { reason: describe(err) }))
    }
  }

  /**
   * One push+pull pass.
   *
   * Returns counts so the engine can log a line. A 404 is remembered and skipped
   * (an older self-hosted server); any other error is rethrown for `lastError`.
   */
  async run(remote: CalendarRemote, serverUrl: string): Promise<{ pushed: number; pulled: number }> {
    if (serverUrl && this.unsupportedServer === serverUrl) return { pushed: 0, pulled: 0 }
    try {
      const pushed = await this.push(remote)
      const pulled = await this.pull(remote)
      return { pushed, pulled }
    } catch (err) {
      if (isUnsupported(err)) {
        this.unsupportedServer = serverUrl
        this.options.log(mt('当前服务器不支持日历同步，已跳过'))
        return { pushed: 0, pulled: 0 }
      }
      throw err
    }
  }

  /** Sends what changed locally; returns how many rows the server accepted. */
  private async push(remote: CalendarRemote): Promise<number> {
    const entries = this.scan()
    if (entries.length === 0) return 0
    let accepted = 0
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const slice = entries.slice(page * PAGE, (page + 1) * PAGE)
      if (slice.length === 0) break
      const result = await remote.pushCalendar(slice.map((entry) => entry.change))
      const payload: CalendarPushResult = result.payload ?? {}
      const done = new Set([...(payload.applied ?? []), ...(payload.duplicates ?? [])])
      for (const entry of slice) {
        if (!done.has(entry.id)) continue
        if (entry.tombstone !== undefined) delete this.state.tombstones[entry.id]
        else this.state.pushed[entry.id] = entry.signature
        accepted += 1
      }
      // A 409 here means the id belongs to another account. Nothing to merge and
      // nothing to retry, so it is recorded as delivered to avoid a permanently red
      // sync — the same call the notes push makes.
      for (const conflict of payload.conflicts ?? []) {
        const id = String(conflict.id ?? '')
        if (!id) continue
        this.options.log(mt('日程 {{id}} 被服务器拒绝：{{reason}}', { id, reason: conflict.error ?? 'conflict' }))
        const entry = slice.find((item) => item.id === id)
        if (entry?.tombstone !== undefined) delete this.state.tombstones[id]
        else if (entry) this.state.pushed[id] = entry.signature
        accepted += 1
      }
      /**
       * A `stale` answer means the server holds a newer version of this id, so our
       * copy is the one that loses. Losing quietly is not an option — the user's
       * edit would vanish with no trace — so the local row is kept as a conflict
       * copy first, exactly like a pull-side clash. The id is then marked as
       * delivered: re-pushing the same older content would earn the same answer
       * forever and mint one copy per pass.
       */
      const stale = payload.stale ?? []
      if (stale.length > 0) {
        const local = new Map(this.options.store.list().map((event) => [event.id, event]))
        for (const rawId of stale) {
          const id = String(rawId ?? '')
          if (!id) continue
          const entry = slice.find((item) => item.id === id)
          if (!entry) continue
          if (entry.tombstone !== undefined) {
            // The row exists on the server in a newer form, so the deletion is not
            // ours to apply. Dropping the tombstone is what stops it being retried.
            delete this.state.tombstones[id]
            this.options.log(mt('日程 {{id}} 的删除未生效：服务端有更新的版本', { id }))
          } else {
            const row = local.get(id)
            if (row) {
              this.options.log(mt('日程《{{title}}》的服务端版本更新，本机改动不覆盖它', { title: row.title }))
              this.keepCopy(row, local)
            }
            this.state.pushed[id] = entry.signature
          }
          accepted += 1
        }
      }
      this.writeState()
      if (slice.length < PAGE) break
    }
    return accepted
  }

  /** Merges everything the server changed since the cursor. */
  private async pull(remote: CalendarRemote): Promise<number> {
    let cursor = this.state.cursor
    let applied = 0
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await remote.pullCalendar(cursor, PAGE)
      const rows = Array.isArray(result.events) ? result.events : []
      // One read of the store per page, not per row: a page is 200 rows and each
      // `list()` sorts and copies the whole calendar.
      const local = new Map(this.options.store.list().map((event) => [event.id, event]))
      for (const row of rows) if (this.applyRemoteRow(row, local)) applied += 1
      const next = Number(result.cursor)
      // Never backwards: a server answering with an older cursor (a restored backup,
      // a replica that has not caught up) must not make us re-read rows we already
      // merged, or replay a tombstone over a newer local edit.
      if (Number.isFinite(next) && next > cursor) cursor = next
      this.state.cursor = cursor
      this.writeState()
      if (!result.hasMore || rows.length === 0) break
    }
    return applied
  }

  /**
   * One remote row in.
   *
   * Returns whether the local store actually changed, so the log line counts
   * edits rather than echoes of our own push.
   */
  private applyRemoteRow(row: unknown, local: Map<string, CalendarEvent>): boolean {
    if (!row || typeof row !== 'object') return false
    const raw = row as Record<string, unknown>
    const id = typeof raw.id === 'string' ? raw.id : ''
    if (!id) return false
    const existing = local.get(id)
    const deleted = raw.deleted === true || Number(raw.deletedAt) > 0

    if (deleted) {
      if (!existing) {
        this.forget(id)
        return false
      }
      if (this.isDirty(existing)) this.keepCopy(existing, local)
      this.options.store.remove(id)
      local.delete(id)
      this.forget(id)
      return true
    }

    const title = typeof raw.title === 'string' ? raw.title : ''
    const start = Number(raw.start)
    const end = Number(raw.end)
    if (!title || !Number.isFinite(start) || !Number.isFinite(end)) {
      this.options.log(mt('收到一条无法解析的日程，已跳过'))
      return false
    }
    const remote: CalendarEvent = {
      id,
      title,
      start,
      end,
      allDay: raw.allDay === true,
      ...(typeof raw.location === 'string' && raw.location ? { location: raw.location } : {}),
      ...(typeof raw.notes === 'string' && raw.notes ? { notes: raw.notes } : {}),
      ...(raw.leadMinutes === null || raw.leadMinutes === undefined
        ? {}
        : { leadMinutes: Number(raw.leadMinutes) }),
      source: raw.source === 'voice' || raw.source === 'import' ? raw.source : 'manual',
      createdAt: existing?.createdAt ?? this.now(),
      updatedAt: Number(raw.updatedAt) || this.now(),
      status: raw.status === 'cancelled' ? 'cancelled' : 'confirmed',
      ...(typeof raw.uid === 'string' && raw.uid ? { uid: raw.uid } : {})
    }

    const remoteSignature = signature(remote)
    if (existing && signature(existing) === remoteSignature) {
      // Our own push echoed back: record the agreement, skip the write.
      this.state.pushed[id] = remoteSignature
      return false
    }
    // Only content the server has never confirmed is worth a copy. The push runs
    // before the pull, so an edit it delivered is already on the server and an
    // incoming row for the same id is simply newer — adopting it loses nothing.
    // What is left is content this machine could not deliver (a state file it could
    // read back blank, a batch the server did not take), which the server copy would
    // otherwise overwrite without a trace.
    if (existing && this.isDirty(existing)) this.keepCopy(existing, local)
    this.options.store.put(remote)
    local.set(id, remote)
    this.state.pushed[id] = remoteSignature
    return true
  }

  private isDirty(event: CalendarEvent): boolean {
    return this.state.pushed[event.id] !== signature(event)
  }

  /**
   * Keeps the local version of a clashing row by saving it as a new event.
   *
   * The uid is dropped so a subscription refresh cannot match the copy (and
   * overwrite it with the feed's version, which would look like the conflict never
   * happened), and the title is shortened so the suffix cannot push it past the
   * store's length limit.
   */
  private keepCopy(event: CalendarEvent, local: Map<string, CalendarEvent>): void {
    const at = this.now()
    const copy: CalendarEvent = {
      ...event,
      id: randomUUID(),
      title: mt('{{title}}（冲突副本）', { title: event.title.slice(0, 180) }),
      createdAt: at,
      updatedAt: at
    }
    delete copy.uid
    try {
      this.options.store.put(copy)
      local.set(copy.id, copy)
      this.options.log(mt('日程《{{title}}》被其他设备修改，本机改动已另存', { title: event.title }))
    } catch (err) {
      // The store refuses a copy when the calendar is full. The server copy still
      // wins, so the sync stays consistent; the user is told instead.
      this.options.log(mt('日程《{{title}}》的本机改动无法另存：{{reason}}', {
        title: event.title,
        reason: describe(err)
      }))
    }
  }

  /** Drops the bookkeeping for an id that no longer exists on either side. */
  private forget(id: string): void {
    delete this.state.pushed[id]
    delete this.state.tombstones[id]
    this.state.shown = this.state.shown.filter((item) => item !== id)
  }

  /**
   * Everything to push: changed rows, plus tombstones for rows that vanished.
   *
   * A disappearance is only a deletion if the server had seen the row; otherwise
   * the user created and removed an event between two passes and there is nothing
   * to tell anyone.
   */
  private scan(): ScanEntry[] {
    const events = this.options.store.list()
    const live = new Map(events.map((event) => [event.id, event]))
    const now = this.now()
    for (const id of this.state.shown) {
      if (live.has(id)) continue
      if (this.state.pushed[id] === undefined) continue
      this.state.tombstones[id] = now
      delete this.state.pushed[id]
    }
    this.state.shown = events.map((event) => event.id)

    const entries: ScanEntry[] = []
    for (const event of events) {
      const sig = signature(event)
      if (this.state.pushed[event.id] === sig) continue
      entries.push({ id: event.id, signature: sig, change: toChange(event) })
    }
    for (const [id, deletedAt] of Object.entries(this.state.tombstones)) {
      entries.push({
        id,
        signature: '',
        tombstone: deletedAt,
        change: {
          id,
          title: '',
          start: 0,
          end: 0,
          allDay: false,
          location: null,
          notes: null,
          leadMinutes: null,
          source: 'manual',
          uid: null,
          status: 'confirmed',
          updatedAt: deletedAt,
          deletedAt
        }
      })
    }
    return entries
  }
}
