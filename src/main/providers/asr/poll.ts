import { ProviderError } from '../providerError'
import { mt } from '@shared/mainI18n'

/**
 * How a job API is polled.
 *
 * ## Why this is not a constant interval
 *
 * Measurement first: a 5 s clip submitted to AssemblyAI/Gladia/DashScope is
 * usually finished by the time the *first* status GET comes back — the job is
 * queued and decoded in the same second the POST returns. The old code waited a
 * fixed interval before that first GET (`1_500` ms in `west.ts`, `500` ms for
 * DashScope), so it paid that wait on *every* take, even the majority where the
 * answer was already there. That is dead time in the user's dictation, and it is
 * exactly the "cloud feels a second or two slower than local" report.
 *
 * So: check immediately, then back off. The sequence
 *
 *   0 → 200 → 300 → 450 → 675 → 1000 → 1500 → 1500 …
 *
 * spends 0 ms on the common case, and by the sixth attempt is slower than any
 * fixed interval the code used before. The cap keeps the steady state exactly
 * where it was, so a long job is not turned into a busy loop: a 30 s job costs
 * ~22 GETs, a 120 s job ~82 — the same order as the previous 1.5 s cadence.
 *
 * The *budget* is untouched: a job still gets the same wall clock to finish, this
 * only changes how often we look while waiting.
 */
export const POLL_BACKOFF_MS = [200, 300, 450, 675, 1000, 1500] as const

/** Steady-state ceiling: never faster than the old fixed 1.5 s cadence. */
export const POLL_MAX_DELAY_MS = POLL_BACKOFF_MS[POLL_BACKOFF_MS.length - 1]!

/** How long a job may take before the take is declared lost. Unchanged. */
export const POLL_BUDGET_MS = 120_000

/**
 * Delay to wait *before* poll attempt `attempt` (0-based).
 *
 * Attempt 0 is the immediate check right after submitting the job: no timer, no
 * rate-limit burst (one GET), and the answer that is usually already there.
 */
export function pollDelays(attempt: number): number {
  const index = Number.isFinite(attempt) ? Math.max(0, Math.trunc(attempt)) : 0
  if (index === 0) return 0
  const step = index - 1
  return POLL_BACKOFF_MS[Math.min(step, POLL_BACKOFF_MS.length - 1)] ?? POLL_MAX_DELAY_MS
}

export interface PollOptions<T> {
  /** One status check. `null` means "still running". */
  attempt: () => Promise<T | null>
  /** Cancellation-aware sleep; a cancelled take must not sit in this wait. */
  sleep: (ms: number) => Promise<void>
  /** Built lazily, so the vendor keeps its own wording. */
  onTimeout: () => Error
  /** Override for tests and for a vendor with a shorter documented worst case. */
  budgetMs?: number
  /** Written as `[perf] asr-poll …`; no key, no URL, no body. */
  log?: (line: string) => void
  /** Vendor sentence for the line, e.g. "AssemblyAI 转写". */
  label?: string
}

/**
 * Polls until `attempt` returns a value.
 *
 * `null` means "the job is still running", which is why an empty transcript is a
 * legitimate `''` answer: the vendor said it is done, it just heard nothing.
 */
export async function pollForResult<T>(options: PollOptions<T>): Promise<T> {
  const budgetMs = options.budgetMs ?? POLL_BUDGET_MS
  const started = Date.now()
  let attempts = 0
  let waitedMs = 0

  // One line per job, success or timeout: it is the evidence that the backoff
  // (and not the vendor) was the wait. `attempts=1 wait=0ms` is the good case.
  const report = (): void => {
    if (!options.log) return
    options.log(
      `[perf] asr-poll attempts=${attempts} wait=${waitedMs}ms${options.label ? ` what=${options.label}` : ''}`
    )
  }

  for (;;) {
    const wait = pollDelays(attempts)
    if (wait > 0) {
      if (Date.now() - started >= budgetMs) {
        report()
        throw options.onTimeout()
      }
      await options.sleep(wait)
      waitedMs += wait
    }
    attempts += 1
    const value = await options.attempt()
    if (value !== null) {
      report()
      return value
    }
  }
}

/** The shared "the job never finished" sentence; `what` names the vendor step. */
export function pollTimeoutError(what: string, budgetMs = POLL_BUDGET_MS): ProviderError {
  return new ProviderError(
    mt('{{what}}超过 {{seconds}} s 还没有结果', { what, seconds: Math.round(budgetMs / 1000) })
  )
}
