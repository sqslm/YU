/**
 * Which provider to ask first, learned from what actually came back fast.
 *
 * The chain is a user's preference order, and it should stay that way: it is the
 * only thing that expresses "use this account first". But a preference order is
 * not a latency order — the user's first choice can be a queue-backed job API
 * while the second one answers in a second — and once a take is slow there is
 * nothing left to do but wait for it and *then* fail over.
 *
 * So the samples recorded per saved profile are used to reorder the attempts of
 * one take. Two rules keep that honest:
 *
 * 1. Nothing is reordered on one measurement. A cold socket, a model load or a
 *    once-off rate limit all produce a slow first call, so a profile only counts
 *    once it has {@link MIN_SAMPLES} successful takes behind it.
 * 2. Unmeasured profiles keep their place after the measured ones, in chain
 *    order, rather than being pushed around by a guess.
 *
 * The statistic is an exponential moving average, not the mean: providers get
 * faster after a warm-up and users notice the recent behaviour, not the average
 * of the last week.
 */

/** Successful takes needed before a profile's timing is allowed to reorder anything. */
const MIN_SAMPLES = 3

/** Weight of the newest sample. 0.4 settles in ~4 takes and still reacts. */
const ALPHA = 0.4

/** A take longer than this is a failure in disguise; it must not poison the average. */
const MAX_SAMPLE_MS = 120_000

/** Bound on distinct profiles; well above any real settings file. */
const MAX_ENTRIES = 64

interface Entry {
  /** Exponential moving average, milliseconds. */
  value: number
  samples: number
}

const entries = new Map<string, Entry>()

/**
 * Profiles that answered "no" for a reason retrying will not fix (quota, auth).
 *
 * The chain still runs them last rather than dropping them: a profile the user
 * configured must keep the ability to report *why* it failed. But an exhausted
 * free tier must not cost a round trip at the front of every take for the next
 * ten minutes either.
 */
const unavailable = new Map<string, { until: number; reason: string }>()

/** How long a quota/auth answer keeps a profile at the back of the chain. */
export const ASR_UNAVAILABLE_MS = 10 * 60_000

function trim(): void {
  // Insertion order is the age order: the oldest profile goes first.
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next()
    if (oldest.done) return
    entries.delete(oldest.value)
  }
}

/**
 * Records one successful take.
 *
 * Called only for a provider that really answered a request, so a profile that
 * was skipped (disabled, blank, never reached because the first one worked)
 * never gets a sample it did not earn.
 */
export function recordAsrLatency(profileId: string, ms: number): void {
  const id = String(profileId ?? '').trim()
  if (!id) return
  if (!Number.isFinite(ms) || ms <= 0) return
  const sample = Math.min(ms, MAX_SAMPLE_MS)
  const current = entries.get(id)
  if (!current) {
    entries.set(id, { value: sample, samples: 1 })
    trim()
    return
  }
  current.value = current.value + ALPHA * (sample - current.value)
  current.samples += 1
}

/**
 * The measured latency of a profile in milliseconds, or `null` when the sample
 * is not yet trusted (fewer than {@link MIN_SAMPLES} takes).
 */
export function asrLatencyFor(profileId: string): number | null {
  const entry = entries.get(String(profileId ?? '').trim())
  if (!entry || entry.samples < MIN_SAMPLES) return null
  return entry.value
}

/** Successful takes behind a profile's number; 0 for an unmeasured profile. */
export function asrSampleCount(profileId: string): number {
  return entries.get(String(profileId ?? '').trim())?.samples ?? 0
}

/** Remembers a failure that retrying cannot fix, for {@link ASR_UNAVAILABLE_MS}. */
export function markAsrProfileUnavailable(profileId: string, reason: string, ttlMs = ASR_UNAVAILABLE_MS): void {
  const id = String(profileId ?? '').trim()
  if (!id || !Number.isFinite(ttlMs) || ttlMs <= 0) return
  unavailable.set(id, { until: Date.now() + ttlMs, reason: String(reason || '').slice(0, 200) })
}

/** Why this profile is currently benched, or `null` when it is not. */
export function asrUnavailableReason(profileId: string): string | null {
  const id = String(profileId ?? '').trim()
  const entry = unavailable.get(id)
  if (!entry) return null
  if (entry.until <= Date.now()) { unavailable.delete(id); return null }
  return entry.reason
}

/** Test seam and settings-reload seam: forget everything measured so far. */
export function resetAsrLatency(): void {
  entries.clear()
  unavailable.clear()
}

/**
 * Attempt order for one take: measured-and-fast first, then everything else in
 * the order the user configured.
 *
 * Returns a new array and never mutates the input — the chain in `settings` is
 * the user's stored order and is never rewritten by a measurement.
 */
export function orderAsrProfiles<T extends { id: string }>(profiles: T[]): T[] {
  if (!Array.isArray(profiles) || profiles.length < 2) return Array.isArray(profiles) ? [...profiles] : []
  const ranked = profiles.map((profile, index) => ({
    profile,
    index,
    latency: asrLatencyFor(profile?.id ?? '')
  }))
  // Benched profiles go last, in their configured order: the take should not pay
  // a round trip for a quota that is already known to be exhausted.
  const benched = (item: { profile: { id: string } }): boolean => asrUnavailableReason(item.profile?.id ?? '') !== null
  const live = ranked.filter((item) => !benched(item))
  const measured = live
    .filter((item) => item.latency !== null)
    .sort((a, b) => (a.latency! - b.latency!) || (a.index - b.index))
  const unmeasured = live.filter((item) => item.latency === null)
  const parked = ranked.filter(benched)
  return [...measured, ...unmeasured, ...parked].map((item) => item.profile)
}
