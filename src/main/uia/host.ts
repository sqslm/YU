/**
 * Owns the UI Automation child process.
 *
 * Contract: `read()` never throws, has a bounded startup wait plus `timeoutMs`, and
 * never respawns in a loop. A missing snapshot is a normal outcome — the
 * pipeline simply polishes without surrounding text. That is why a dead or
 * slow child is treated as "no context" instead of an error the user must see.
 *
 * The native Rust child is not kept alive for the app's lifetime. Its snapshot is only needed
 * while a take is being captured, so the process is started by `warm()` on the
 * take path and reclaimed after `IDLE_STOP_MS` without a read. A read that
 * arrives before the child is ready waits for it instead of reporting "no
 * context": the read already overlaps the whole recording, so the wait is free.
 */
import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { UiaSnapshot } from './types'
import type { TaskTarget } from '@shared/task'

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
  private proc: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, PendingRead>()
  private readyWaiters = new Set<(ready: boolean) => void>()
  private idleTimer: NodeJS.Timeout | null = null
  private seq = 0
  private restarts = 0
  private stopped = false
  private wanted = false
  private ready = false
  private restartTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly log: (line: string) => void = () => {}) {}

  get pid(): number | undefined { return this.proc?.pid }

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
   * call repeatedly: the child is only spawned when there is none.
   */
  warm(): void {
    if (this.stopped || !this.wanted) return
    this.clearIdle()
    if (this.proc) {
      this.scheduleIdle()
      return
    }
    this.restarts = 0
    this.spawn()
    this.scheduleIdle()
  }

  private spawn(): void {
    if (this.stopped || !this.wanted || this.proc) return
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const entry = app.isPackaged
      ? join(process.resourcesPath, 'native', 'yu-uia.exe')
      : join(app.getAppPath(), 'native', 'bin', 'yu-uia.exe')
    try {
      const child = spawn(entry, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      this.proc = child
      child.once('spawn', () => { if (this.proc !== child || this.stopped) child.kill() })
      child.on('error', error => this.log(`[uia] spawn failed: ${error.message}`))
      child.stdin.on('error', () => { if (this.proc === child) this.terminate() })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (text: string) => this.log(`[uia] ${text.trim()}`))
      const lines = createInterface({ input: child.stdout })
      lines.on('line', line => {
        if (this.proc !== child) return
        try { this.onMessage(JSON.parse(line) as ChildMessage) } catch {
          this.log('[uia] invalid helper response')
          this.terminate()
        }
      })
      child.on('close', (code) => {
        lines.close()
        if (this.proc !== child) return
        this.log(`[uia] exited with ${code}`)
        this.terminate()
        if (!this.stopped && this.restarts < MAX_RESTARTS) {
          this.restarts += 1
          this.restartTimer = setTimeout(() => { this.restartTimer = null; this.spawn() }, 1200)
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
      this.wakeReady(true)
      return
    }
    if (message.type !== 'result' || typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.restarts = 0
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
      const finish = (ready: boolean): void => {
        clearTimeout(timer)
        this.readyWaiters.delete(finish)
        resolve(ready)
      }
      const timer = setTimeout(() => finish(false), ms)
      this.readyWaiters.add(finish)
    })
  }

  private wakeReady(ready: boolean): void {
    for (const wake of this.readyWaiters) wake(ready)
  }

  /** Retire first, then kill: late pipe/close events cannot affect a new reader. */
  private terminate(): void {
    this.clearIdle()
    const proc = this.proc
    this.proc = null
    this.ready = false
    this.flushPending()
    this.wakeReady(false)
    proc?.kill()
  }

  private clearIdle(): void {
    if (!this.idleTimer) return
    clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  /**
   * Kills the child once it has been quiet for `IDLE_STOP_MS`; the cost
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
      this.terminate()
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
  read(timeoutMs = DEFAULT_TIMEOUT_MS, target?: TaskTarget): Promise<UiaSnapshot | null> {
    return this.readWithBudget(timeoutMs, target)
  }

  private async readWithBudget(timeoutMs: number, target?: TaskTarget): Promise<UiaSnapshot | null> {
    if (this.stopped || !this.wanted) return null
    this.warm()
    const proc = this.proc
    if (!proc) return null
    if (!this.ready) {
      const ready = await this.waitForReady(Math.max(timeoutMs, READY_WAIT_MS))
      if (!ready || this.stopped || this.proc !== proc) {
        if (!ready && this.proc === proc) this.terminate()
        return null
      }
    }
    const id = (this.seq += 1)
    const result = await new Promise<UiaSnapshot | null>((resolve) => {
      const timer = setTimeout(() => {
        this.log('[uia] read timed out')
        // A hung COM provider would otherwise block every subsequent request.
        if (this.proc === proc) this.terminate()
      }, timeoutMs)
      this.pending.set(id, { resolve, timer })
      try {
        proc.stdin.write(JSON.stringify({ type: 'read', id, ...(target ? { target } : {}) }) + '\n')
      } catch {
        this.terminate()
      }
    })
    if (this.pending.size === 0) this.scheduleIdle()
    return result
  }

  stop(): void {
    this.stopped = true
    this.wanted = false
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.terminate()
  }

  /** Drop only an idle reader, leaving on-demand reads enabled. */
  reclaim(): boolean {
    if (!this.proc || this.pending.size > 0 || !this.ready) return false
    this.terminate()
    return true
  }
}
