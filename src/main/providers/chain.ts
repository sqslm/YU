/**
 * Provider chains with failover.
 *
 * A chain is an ordered list of saved profiles: the first enabled one that
 * answers wins, and a failure moves to the next. There is deliberately no
 * implicit default connection: an install with nothing enabled has no provider,
 * and the bar says "add one" instead of failing later with a connection error
 * nobody can trace back to a missing setting.
 */
import type { ProviderKind, ProviderProfile, Settings } from '@shared/types'
import { mt } from '@shared/mainI18n'

/**
 * Profiles to try, in order.
 *
 * Disabled profiles are skipped rather than removed from the chain, so toggling
 * one back on restores its position. A profile the user saved but has not yet
 * placed in the chain still counts as configured, so the tail is appended: a new
 * profile must work immediately, before anyone reorders anything.
 */
export function chainFor(settings: Settings, kind: ProviderKind): ProviderProfile[] {
  const byId = new Map<string, ProviderProfile>()
  for (const profile of settings.profiles ?? []) {
    if (profile.kind === kind) byId.set(profile.id, profile)
  }
  const ordered: ProviderProfile[] = []
  const seen = new Set<string>()
  for (const id of settings.chains?.[kind] ?? []) {
    const profile = byId.get(id)
    if (profile && profile.enabled && !seen.has(id)) {
      seen.add(id)
      ordered.push(profile)
    }
  }
  for (const [id, profile] of byId) {
    if (profile.enabled && !seen.has(id)) ordered.push(profile)
  }
  return ordered
}

export interface FailoverResult<T> {
  value: T
  /** The profile that produced `value`. */
  profile: ProviderProfile
  /** Profiles that failed before it, in order, for logging and alerts. */
  failures: Array<{ profile: ProviderProfile; error: unknown }>
}

/**
 * Runs `attempt` against each profile until one succeeds.
 *
 * Every failure is collected instead of aborting: with two saved providers, a
 * rate-limited first one must not hide the working second one. The last error is
 * rethrown when all of them fail, because it is the one the user can act on.
 */
export async function withFailover<T>(
  profiles: ProviderProfile[],
  attempt: (profile: ProviderProfile) => Promise<T>,
  onFail?: (profile: ProviderProfile, error: unknown, index: number) => void
): Promise<FailoverResult<T>> {
  if (profiles.length === 0) throw new Error(mt('没有可用的提供商配置'))
  const failures: Array<{ profile: ProviderProfile; error: unknown }> = []
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index]!
    try {
      const value = await attempt(profile)
      return { value, profile, failures }
    } catch (error) {
      failures.push({ profile, error })
      onFail?.(profile, error, index)
    }
  }
  const last = failures[failures.length - 1]?.error
  throw last instanceof Error ? last : new Error(String(last))
}
