import { briefingDayKey, nextBriefingAt } from '@shared/briefing'
import type { Briefing, BriefingSettings } from '@shared/briefing'

export interface BriefingState { lastDay?: string }

export interface BriefingDeps {
  /** Settings arrive bare or nested under `briefing`, depending on the caller. */
  settings: () => { briefing?: BriefingSettings } | BriefingSettings
  now?: () => number
  compose: (now: number) => Briefing
  deliver: (briefing: Briefing, at: number) => void
  load: () => BriefingState
  save: (state: BriefingState) => void
  log: (line: string) => void
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

/** A single long setTimeout drifts wholesale across a Windows sleep, so the target
 *  is re-derived from the wall clock at least this often. */
const POLL_MS = 30_000
/** A failed delivery retries at poll pace: pushing it to tomorrow would lose the day. */
const RETRY_MS = POLL_MS

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error)

function readSettings(source: { briefing?: BriefingSettings } | BriefingSettings): BriefingSettings {
  const nested = (source as { briefing?: BriefingSettings }).briefing
  return nested ?? source as BriefingSettings
}

/** Follows ReminderScheduler: one timer, recomputed from scratch on every tick. */
export class BriefingScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private nextAt: number | null = null
  private active = false
  private state: BriefingState
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void

  constructor(private readonly deps: BriefingDeps) {
    this.state = deps.load()
    this.now = deps.now ?? (() => Date.now())
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms)
      handle.unref?.()
      return handle
    })
    this.clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle))
  }

  start(): void {
    this.active = true
    this.check()
  }

  stop(): void {
    this.active = false
    this.disarm()
    this.nextAt = null
  }

  status(): { enabled: boolean; nextAt: number | null; lastDay?: string } {
    return { enabled: readSettings(this.deps.settings()).enabled, nextAt: this.nextAt, lastDay: this.state.lastDay }
  }

  check(): void {
    this.disarm()
    const now = this.now()
    const settings = readSettings(this.deps.settings())
    if (!settings.enabled) {
      this.stop()
      return
    }
    const today = briefingDayKey(now)
    let next: number
    if (this.state.lastDay === today) {
      next = this.tomorrowSlot(now, settings.time)
    } else if (briefingDayKey(nextBriefingAt(now, settings.time)) !== today) {
      // Today's slot already slid by (app was closed or the machine slept): send now
      // rather than silently waiting a whole day.
      next = this.attempt(now, settings, today) ? this.tomorrowSlot(now, settings.time) : now + RETRY_MS
    } else {
      next = nextBriefingAt(now, settings.time)
    }
    this.nextAt = next
    const delay = Math.max(1, Math.min(POLL_MS, next - now))
    this.timer = this.setTimer(() => {
      // A callback already queued when stop() ran must not revive the chain.
      if (this.active) this.check()
    }, delay)
  }

  /** True when today's slot is settled: delivered, or deliberately skipped as empty. */
  private attempt(now: number, settings: BriefingSettings, today: string): boolean {
    let briefing: Briefing
    try {
      briefing = this.deps.compose(now)
    } catch (error) {
      this.deps.log(`briefing: compose failed: ${describe(error)}`)
      return false
    }
    if (settings.skipEmpty && briefing.empty) {
      // Still mark the day so an empty briefing does not resurface on every tick.
      this.deps.log('briefing: nothing scheduled')
    } else {
      try {
        this.deps.deliver(briefing, now)
      } catch (error) {
        this.deps.log(`briefing: deliver failed: ${describe(error)}`)
        return false
      }
    }
    this.state = { ...this.state, lastDay: today }
    this.deps.save(this.state)
    return true
  }

  /** Once today is served the target is tomorrow's clock time, even if the time changed. */
  private tomorrowSlot(now: number, time: string): number {
    const upcoming = nextBriefingAt(now, time)
    return briefingDayKey(upcoming) === briefingDayKey(now) ? nextBriefingAt(upcoming, time) : upcoming
  }

  private disarm(): void {
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
  }
}
