/**
 * Owns the UI Automation child process.
 *
 * Contract: `read()` never throws, never hangs longer than `timeoutMs`, and
 * never respawns in a loop. A missing snapshot is a normal outcome — the
 * pipeline simply polishes without surrounding text. That is why a dead or
 * slow child is treated as "no context" instead of an error the user must see.
 *
 * The child is *not* kept alive for the app's lifetime. A Node utility process
 * costs ~75 MB of resident memory, and the snapshot it produces is only needed
 * while a take is being captured, so the process is started by `warm()` on the
 * take path and reclaimed after `IDLE_STOP_MS` without a read. A read that
 * arrives before the child is ready waits for it instead of reporting "no
 * context": the read already overlaps the whole recording, so the wait is free.
 */
import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import type { UiaSnapshot } from './reader'

interface PendingRead {
  resolve: (snapshot: UiaSnapshot | null) => void
  timer: NodeJS.Timeout
}

interface ChildMessage {
  type: 'ready' | 'result'
  id?: number
  snapshot?: UiaSnapshot | null
}

const MAX_RESTARTS = 3
/**
 * Budget for one read. The read starts when the mic opens, so it has the whole
 * take to finish; this bound only decides how long `takeContext()` waits at the
 * end of a very short take before giving up on the context line.
 */
const DEFAULT_TIMEOUT_MS = 150
/**
 * How long a read may wait for a freshly spawned child. Spawning takes a few
 * hundred milliseconds and the read is issued at the start of the recording, so
 * this budget only matters for takes shorter than the spawn.
 */
const READY_WAIT_MS = 1500
/** Idle time after which the child is killed again (memory, not correctness). */
const IDLE_STOP_MS = Number(process.env.TYPELESS_UIA_IDLE_MS ?? 5 * 60_000)

export class UiaHost {
  private proc: UtilityProcess | null = null
  private pending = new Map<number, PendingRead>()
  private readyWaiters: Array<() => void> = []
  private idleTimer: NodeJS.Timeout | null = null
  private seq = 0
  private restarts = 0
  private stopped = false
  private wanted = false
  private retiring = false
  private ready = false

  constructor(private readonly log: (line: string) => void = () => {}) {}

  /**
   * Arms the host without spending a process. Used at startup: from here on a
   * take may call `warm()`, and `stop()` has something to undo.
   */
  start(): void {
    this.stopped = false
    this.wanted = true
  }

  /**
   * Starts the reader ahead of a take and pushes the idle deadline back. Safe to
   * call repeatedly: the child is only forked when there is none.
   */
  warm(): void {
    if (this.stopped || !this.wanted) return
    this.clearIdle()
    if (this.proc) {
      this.scheduleIdle()
      return
    }
    this.spawn()
    this.scheduleIdle()
  }

  private spawn(): void {
    const entry = join(__dirname, 'uia.js')
    try {
      const child = utilityProcess.fork(entry, [], {
        serviceName: 'typeless-uia',
        stdio: 'inherit'
      })
      this.proc = child
      this.restarts = 0
      child.on('message', (message: unknown) => this.onMessage(message as ChildMessage))
      child.on('exit', (code) => {
        this.log(`[uia] exited with ${code}`)
        this.proc = null
        this.ready = false
        this.flushPending()
        // A deliberate retirement is not a crash: do not spawn it straight back.
        if (this.retiring) {
          this.retiring = false
          return
        }
        if (!this.stopped && this.restarts < MAX_RESTARTS) {
          this.restarts += 1
          setTimeout(() => this.spawn(), 1200)
        }
      })
    } catch (err) {
      this.log(`[uia] spawn failed: ${err instanceof Error ? err.message : String(err)}`)
      this.proc = null
    }
  }

  private onMessage(message: ChildMessage): void {
    if (message.type === 'ready') {
      this.ready = true
      this.log('[uia] ready')
      // Arm the reclaimer here as well as after a read: a child that comes back
      // after a crash is only reclaimed if something schedules it, and a spawned
      // child that never gets a read would otherwise stay for the whole session.
      this.scheduleIdle()
      const waiters = this.readyWaiters
      this.readyWaiters = []
      for (const wake of waiters) wake()
      return
    }
    if (message.type !== 'result' || typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    pending.resolve(message.snapshot ?? null)
    if (this.pending.size === 0) this.scheduleIdle()
  }

  /** Resolves every in-flight read with null, so callers never hang. */
  private flushPending(): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.resolve(null)
    }
  }

  private waitForReady(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      this.readyWaiters.push(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  private clearIdle(): void {
    if (!this.idleTimer) return
    clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  /**
   * Kills the child once it has been quiet for `IDLE_STOP_MS`. That is ~75 MB
   * back on an app that spends most of its life waiting for a hotkey; the cost
   * is one spawn the next time a take asks for context.
   */
  private scheduleIdle(): void {
    this.clearIdle()
    if (this.stopped || !this.proc) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (!this.proc || this.pending.size > 0) {
        this.scheduleIdle()
        return
      }
      this.log('[uia] idle: reclaiming the context reader')
      this.retiring = true
      const proc = this.proc
      this.proc = null
      this.ready = false
      proc.kill()
    }, IDLE_STOP_MS)
    // Never hold the event loop open just to reclaim memory later.
    this.idleTimer.unref?.()
  }

  /** True once the child reported ready; callers can skip the wait entirely. */
  get available(): boolean {
    return Boolean(this.proc) && this.ready
  }

  /**
   * Reads the focused control, or resolves null when the child dies, the read
   * times out, or UI Automation reports nothing usable.
   */
  read(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<UiaSnapshot | null> {
    return this.readWithBudget(timeoutMs)
  }

  private async readWithBudget(timeoutMs: number): Promise<UiaSnapshot | null> {
    if (this.stopped || !this.wanted) return null
    this.warm()
    if (!this.ready) {
      const ready = await this.waitForReady(Math.max(timeoutMs, READY_WAIT_MS))
      if (!ready || this.stopped) return null
    }
    const proc = this.proc
    if (!proc) return Promise.resolve(null)
    const id = (this.seq += 1)
    const result = await new Promise<UiaSnapshot | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.log('[uia] read timed out')
        resolve(null)
      }, timeoutMs)
      this.pending.set(id, { resolve, timer })
      try {
        proc.postMessage({ type: 'read', id })
      } catch {
        this.pending.delete(id)
        clearTimeout(timer)
        resolve(null)
      }
    })
    if (this.pending.size === 0) this.scheduleIdle()
    return result
  }

  stop(): void {
    this.stopped = true
    this.wanted = false
    this.clearIdle()
    this.flushPending()
    this.retiring = Boolean(this.proc)
    this.proc?.kill()
    this.proc = null
    this.ready = false
  }
}
