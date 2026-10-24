import { appendBriefingHistory, briefingDayKey, nextAllowedAt, nextBriefingAt } from '@shared/briefing'
import type { Briefing, BriefingRecord, BriefingSettings } from '@shared/briefing'

export interface BriefingState {
  /** Day key of the last settled briefing. Older state files carry only this. */
  lastDay?: string
  /** Delivered briefings, oldest first. Missing in state files written before history. */
  history?: BriefingRecord[]
}

export interface BriefingDeps {
  /** Settings arrive bare or nested under `briefing`, depending on the caller. */
  settings: () => { briefing?: BriefingSettings } | BriefingSettings
  now?: () => number
  /**
   * Produces the briefing. Model-written text arrives as a promise: the timer
   * chain must not wait on an LLM round trip, so a promise is settled off the
   * tick and the day is claimed only when real text comes back.
   */
  compose: (now: number) => Briefing | Promise<Briefing>
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

const iso = (at: number): string => new Date(at).toISOString()

/** A `compose` that narrates returns a thenable; one that does not returns a Briefing. */
const isThenable = (value: Briefing | Promise<Briefing>): value is Promise<Briefing> =>
  typeof (value as Promise<Briefing>)?.then === 'function'

function readSettings(source: { briefing?: BriefingSettings } | BriefingSettings): BriefingSettings {
  const nested = (source as { briefing?: BriefingSettings }).briefing
  return nested ?? source as BriefingSettings
}

/** Follows ReminderScheduler: one timer, recomputed from scratch on every tick. */
export class BriefingScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private nextAt: number | null = null
  private active = false
  /** The quiet-hours end already reported, so the poll loop logs it once. */
  private loggedQuietAt: number | null = null
  /** The narration currently being awaited for today; null once it settles. */
  private settling: Promise<void> | null = null
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

  status(): { enabled: boolean; nextAt: number | null; lastDay?: string; history: BriefingRecord[] } {
    return {
      enabled: readSettings(this.deps.settings()).enabled,
      nextAt: this.nextAt,
      lastDay: this.state.lastDay,
      history: this.state.history ?? []
    }
  }

  check(): void {
    this.disarm()
    const now = this.now()
    const settings = readSettings(this.deps.settings())
    if (!settings.enabled) {
      this.stop()
      return
    }
    const next = this.plan(now, settings, briefingDayKey(now))
    this.nextAt = next
    const delay = Math.max(1, Math.min(POLL_MS, next - now))
    this.timer = this.setTimer(() => {
      // A callback already queued when stop() ran must not revive the chain.
      if (this.active) this.check()
    }, delay)
  }

  /**
   * When the next delivery should be attempted.
   *
   * Quiet hours never become a delivery: they only move the moment, and `lastDay`
   * stays unwritten so the day is still owed rather than silently burned.
   */
  private plan(now: number, settings: BriefingSettings, today: string): number {
    if (this.state.lastDay === today) return this.tomorrowSlot(now, settings.time)
    const slot = nextBriefingAt(now, settings.time)
    if (briefingDayKey(slot) === today) {
      // The slot is still ahead today: a quiet window can only push it back.
      const allowed = nextAllowedAt(settings, slot)
      if (allowed === slot) return slot
      // The window outlasts the day, so this clock time lands inside the window
      // again tomorrow: it can never be delivered, and reporting one quiet
      // "skipped" line per day hides the real cause.
      if (briefingDayKey(allowed) !== today) return this.neverDelivers(allowed, now, settings)
      this.noteQuiet(allowed, `[briefing] quiet hours, delaying to ${iso(allowed)}`)
      return allowed
    }
    // Today's slot already slid by (app closed or the machine slept): send now
    // rather than silently waiting a whole day, unless that would fire inside the
    // user's silence window.
    const allowed = nextAllowedAt(settings, now)
    if (briefingDayKey(allowed) !== today) return this.missedToday(allowed, now, settings)
    if (allowed > now) {
      this.noteQuiet(allowed, `[briefing] quiet hours, delaying to ${iso(allowed)}`)
      return allowed
    }
    return this.attempt(now, settings, today) ? this.tomorrowSlot(now, settings.time) : now + RETRY_MS
  }

  /**
   * The configured clock time sits inside the silence window and the window only
   * lifts after the next slot (23:30 with quiet hours until 07:30), so no day is
   * ever deliverable. `nextAt` still moves to tomorrow so the 30 s poll cannot
   * spin, and the log names the cause — `noteQuiet` keeps it to one line per
   * detected target instead of one per tick.
   */
  private neverDelivers(allowed: number, now: number, settings: BriefingSettings): number {
    this.noteQuiet(allowed, `[briefing] ${settings.time} is inside quiet hours until ${iso(allowed)}; no briefing can be delivered, move the time or disable quiet hours`)
    return this.tomorrowSlot(now, settings.time)
  }

  /**
   * The silence runs past midnight, so today's briefing is already stale by the time
   * it lifts. Sending it then would stack a late copy on top of tomorrow's, so the
   * day is written off instead — with `lastDay` untouched, tomorrow starts clean.
   */
  private missedToday(allowed: number, now: number, settings: BriefingSettings): number {
    this.noteQuiet(allowed, `[briefing] quiet hours until ${iso(allowed)}, ${briefingDayKey(now)} skipped`)
    return this.tomorrowSlot(now, settings.time)
  }

  /** The 30 s poll recomputes the same target until the window lifts; one line is enough. */
  private noteQuiet(allowed: number, line: string): void {
    if (this.loggedQuietAt === allowed) return
    this.loggedQuietAt = allowed
    this.deps.log(line)
  }

  /** True when today's slot is settled: delivered, or deliberately skipped as empty. */
  private attempt(now: number, settings: BriefingSettings, today: string): boolean {
    // A narration already in flight owns today: a second call would deliver the
    // briefing twice and write two history rows a second apart.
    if (this.settling) return true
    let produced: Briefing | Promise<Briefing>
    try {
      produced = this.deps.compose(now)
    } catch (error) {
      this.deps.log(`briefing: compose failed: ${describe(error)}`)
      return false
    }
    if (isThenable(produced)) {
      // The timer chain moves on immediately; the day is claimed when the text lands.
      this.settling = this.settleLater(produced, now, settings, today)
      return true
    }
    return this.settle(produced, now, settings, today)
  }

  /**
   * Delivers (or deliberately skips) one produced briefing.
   *
   * Split out of `attempt` so the awaited path and the immediate path share one
   * definition of "today is done": skipEmpty, delivery, `lastDay`, history, save.
   */
  private settle(briefing: Briefing, now: number, settings: BriefingSettings, today: string): boolean {
    const skipped = settings.skipEmpty && briefing.empty
    if (skipped) {
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
    if (skipped) {
      // An empty briefing has nothing worth keeping, but the day itself is settled.
      this.state = { ...this.state, lastDay: today }
    } else {
      this.state = {
        ...this.state,
        lastDay: today,
        history: appendBriefingHistory(this.state.history ?? [],
          { dayKey: today, title: briefing.title, body: briefing.body, createdAt: now, source: briefing.source })
      }
    }
    this.deps.save(this.state)
    return true
  }

  /**
   * Settles a narrated briefing once its model call returns.
   *
   * A rejected narration writes nothing: the day stays owed, so the 30 s poll
   * retries exactly like a failed delivery instead of losing the briefing. The
   * promise is never awaited by `check()`, so a slow provider cannot stall the
   * timer chain.
   */
  private async settleLater(produced: Promise<Briefing>, now: number, settings: BriefingSettings, today: string): Promise<void> {
    let briefing: Briefing
    try {
      briefing = await produced
    } catch (error) {
      this.deps.log(`briefing: compose failed: ${describe(error)}`)
      return
    } finally {
      this.settling = null
    }
    // A narration that lands after stop() belongs to a briefing the user switched
    // off (or a time they already changed), so it is dropped rather than delivered.
    if (!this.active) return
    try {
      this.settle(briefing, now, settings, today)
    } catch (error) {
      this.deps.log(`briefing: deliver failed: ${describe(error)}`)
    }
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
