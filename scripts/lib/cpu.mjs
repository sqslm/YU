/**
 * CPU accounting units, kept in one place so the conversion cannot be applied
 * twice. Windows `GetProcessTimes` reports FILETIME ticks of 100 ns, so one
 * millisecond is exactly 10,000 ticks and the divisor appears once:
 *
 *   10,000,000 ticks → 1000 ms      (one second of one core)
 *   1 tick           → 0.0001 ms
 *
 * The earlier version divided by 10,000 (ms) and then by 1000 again, which
 * reported a full second as one millisecond.
 */

/** FILETIME ticks (100 ns each) → milliseconds, fractional part preserved. */
export function cpuMsFromTicks(ticks) {
  const value = typeof ticks === 'bigint' ? ticks : BigInt(Math.trunc(Number(ticks) || 0))
  return Number(value) / 10_000
}

/** Total CPU milliseconds normalised to one second of wall clock. */
export function perSecond(totalMs, windowMs) {
  if (typeof totalMs !== 'number' || typeof windowMs !== 'number' || !(windowMs > 0)) return null
  return Math.round((totalMs / (windowMs / 1000)) * 1000) / 1000
}

/**
 * The controlled load for the CPU self-check: a single thread spinning for
 * three seconds. One busy thread is one core, which is what makes the
 * measured delta comparable to the window length.
 */
export const BUSY_LOOP_SOURCE = 'const end = Date.now() + 3000; while (Date.now() < end) {}'
