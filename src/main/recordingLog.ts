/**
 * Per-take session logs.
 *
 * The reference product writes a `recording-event` stream for every take
 * (`recording-event:{log,clear,open,read-index,read-session}`) so a user who
 * reports "it did not insert anything this time" can hand over one file that
 * contains the whole story: which app was focused, what the ASR returned, which
 * prompt card ran, what the inserter verified.
 *
 * `app.err` is a single ever-growing stream: everything is interleaved, takes
 * cannot be told apart, and by the time a user reports a failure the relevant
 * lines are thousands of entries back. One file per take fixes that.
 *
 * Nothing here touches Electron, so it is safe to import from unit tests; the
 * directory is injected by `index.ts` once `app.getPath('userData')` exists.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import type { RecordingSessionInfo } from '@shared/types'

/** How many takes to keep. Diagnostics, not a record: older files are noise. */
const KEEP_SESSIONS = 40
/** A single log line is capped so a pasted provider response cannot balloon. */
const MAX_LINE_CHARS = 2000
/** Reading a session back for the UI: enough to diagnose, not the whole file. */
const MAX_READ_CHARS = 200_000

export interface RecordingSessionMeta {
  mode: string
  appName: string
  windowTitle: string
  /** Free-form extras (device, insertion method, card name …). */
  extra?: Record<string, string | number | boolean | null>
}

export interface RecordingSessionResult {
  status: 'done' | 'cancelled' | 'error' | 'empty'
  chars?: number
  audioMs?: number
  error?: string
}

class RecordingLog {
  private listeners = new Set<() => void>()
  private dir: string | null = null
  private fd: number | null = null
  private session: { id: string; startedAt: number; meta: RecordingSessionMeta } | null = null

  /** Called once from `index.ts` with `<userData>/recordings`. */
  configure(dir: string | null): void {
    this.close()
    this.dir = null
    if (!dir) return
    try {
      mkdirSync(dir, { recursive: true })
      this.dir = dir
    } catch {
      // A read-only profile still lets dictation work; only logging is lost.
    }
  }

  directory(): string | null {
    return this.dir
  }

  /** True while a take is being logged. */
  get active(): boolean {
    return this.session !== null
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private changed(): void { for (const listener of this.listeners) listener() }

  begin(meta: RecordingSessionMeta): void {
    this.close()
    if (!this.dir) return
    const startedAt = Date.now()
    const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-')
    const mode = meta.mode.replace(/[^\w-]/g, '') || 'take'
    const id = `${stamp}-${mode}`
    try {
      this.fd = openSync(join(this.dir, `${id}.jsonl`), 'a')
      this.session = { id, startedAt, meta }
      this.write(`begin ${meta.mode} app="${meta.appName}" title="${meta.windowTitle.slice(0, 160)}"`)
      if (meta.extra) {
        for (const [key, value] of Object.entries(meta.extra)) this.write(`${key}=${String(value)}`)
      }
      this.prune()
      this.changed()
    } catch {
      this.fd = null
      this.session = null
    }
  }

  /** Appends one line. Silent no-op when no take is open. */
  write(line: string): void {
    const session = this.session
    const fd = this.fd
    if (!session || fd === null) return
    const text = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line
    try {
      writeSync(fd, `${JSON.stringify({ t: Date.now() - session.startedAt, line: text })}\n`)
    } catch {
      // Never let diagnostics break the take.
    }
  }

  end(result: RecordingSessionResult): void {
    if (!this.session) return
    this.write(
      `end status=${result.status}` +
        (result.chars === undefined ? '' : ` chars=${result.chars}`) +
        (result.audioMs === undefined ? '' : ` audio=${result.audioMs}ms`) +
        (result.error ? ` error="${result.error.slice(0, 300)}"` : '')
    )
    this.close()
    this.changed()
  }

  /** Newest first. Skips files that vanished between listing and stat. */
  list(limit = KEEP_SESSIONS): RecordingSessionInfo[] {
    if (!this.dir) return []
    let names: string[] = []
    try {
      names = readdirSync(this.dir).filter((name) => name.endsWith('.jsonl'))
    } catch {
      return []
    }
    const out: RecordingSessionInfo[] = []
    for (const name of names.sort().reverse().slice(0, limit)) {
      const info = this.describe(name.slice(0, -'.jsonl'.length))
      if (info) out.push(info)
    }
    return out
  }

  read(id: string): string | null {
    if (!this.dir) return null
    const safe = id.replace(/[^\w.-]/g, '')
    if (!safe || safe.includes('..')) return null
    try {
      const text = readFileSync(join(this.dir, `${safe}.jsonl`), 'utf8')
      return text.length > MAX_READ_CHARS ? `${text.slice(0, MAX_READ_CHARS)}\n…(truncated)` : text
    } catch {
      return null
    }
  }

  clear(): number {
    if (!this.dir) return 0
    let removed = 0
    try {
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith('.jsonl')) continue
        try {
          rmSync(join(this.dir, name))
          removed += 1
        } catch {
          // Leave it; the next clear will try again.
        }
      }
    } catch {
      return removed
    }
    this.changed()
    return removed
  }

  private close(): void {
    const fd = this.fd
    this.fd = null
    this.session = null
    if (fd === null) return
    try {
      closeSync(fd)
    } catch {
      // Already closed by the OS.
    }
  }

  private describe(id: string): RecordingSessionInfo | null {
    if (!this.dir) return null
    const path = join(this.dir, `${id}.jsonl`)
    let bytes = 0, modified = 0
    try {
      const file = statSync(path)
      bytes = file.size; modified = file.mtimeMs
    } catch {
      return null
    }
    // Parse just enough of the file: the first line names the take, the last
    // tells how it ended.
    const head = this.readRange(path, 0, Math.min(bytes, 4096))
    const tail =
      bytes > 4096 ? this.readRange(path, bytes - 4096, 4096) : ''
    const first = this.lastLineBody(head.split('\n')[0] ?? '')
    const lastLine =
      tail
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .pop() ?? head.split('\n').filter((line) => line.trim().length > 0).pop() ?? ''
    const meta = /app="([^"]*)" title="([^"]*)"/.exec(first)
    const begun = /^begin (\S+)/.exec(first)
    const ended = /status=(\w+)/.exec(this.lastLineBody(lastLine))
    const stamp = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/.exec(id)
    const startedAt = stamp ? Date.parse(`${stamp[1]}:${stamp[2]}:${stamp[3]}.${stamp[4]}Z`) : modified
    let elapsed = 0
    try { elapsed = Number(JSON.parse(lastLine).t) || 0 } catch { /* incomplete trailing line */ }
    return {
      id,
      startedAt,
      endedAt: ended ? startedAt + elapsed : null,
      mode: begun?.[1] ?? 'take',
      appName: meta?.[1] ?? '',
      windowTitle: meta?.[2] ?? '',
      status: (ended?.[1] as RecordingSessionInfo['status']) ?? 'open',
      lines: 0,
      bytes
    }
  }

  private lastLineBody(line: string): string {
    try {
      const parsed = JSON.parse(line) as { line?: string }
      return typeof parsed.line === 'string' ? parsed.line : ''
    } catch {
      return ''
    }
  }

  private readRange(path: string, start: number, length: number): string {
    if (length <= 0) return ''
    let fd: number | null = null
    try {
      fd = openSync(path, 'r')
      const buffer = Buffer.alloc(length)
      const read = readSync(fd, buffer, 0, length, start)
      return buffer.subarray(0, read).toString('utf8')
    } catch {
      return ''
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          // Ignore.
        }
      }
    }
  }

  private prune(): void {
    if (!this.dir) return
    try {
      const names = readdirSync(this.dir)
        .filter((name) => name.endsWith('.jsonl'))
        .sort()
        .reverse()
      for (const name of names.slice(KEEP_SESSIONS)) {
        try {
          rmSync(join(this.dir, name))
        } catch {
          // Ignore: a locked file simply survives one more round.
        }
      }
    } catch {
      // Ignore.
    }
  }
}

export const recordingLog = new RecordingLog()
