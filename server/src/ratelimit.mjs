/**
 * A fixed-window limiter, in memory.
 *
 * Enough for a single-container deployment: it exists to stop a password-guessing
 * loop and a runaway client, not to be a distributed quota. `limit <= 0` turns it
 * off, which is what the test suite does.
 */
export class RateLimiter {
  constructor(limitPerMinute, windowMs = 60_000) {
    this.limit = limitPerMinute
    this.windowMs = windowMs
    this.buckets = new Map()
  }

  /** Returns `{ ok, retryAfter }`. */
  take(key, weight = 1) {
    if (this.limit <= 0) return { ok: true, retryAfter: 0 }
    const now = Date.now()
    const bucket = this.buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: weight, resetAt: now + this.windowMs })
      return { ok: true, retryAfter: 0 }
    }
    if (bucket.count + weight > this.limit) {
      return { ok: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) }
    }
    bucket.count += weight
    return { ok: true, retryAfter: 0 }
  }

  /** Drops expired buckets so a long-running process does not grow forever. */
  sweep(now = Date.now()) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key)
    }
  }
}
