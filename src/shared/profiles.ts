/**
 * Pure edits over the saved provider profiles and their chains.
 *
 * Kept out of React on purpose: "move this profile up" is a data operation with
 * an obvious right answer, and the settings dialog saves on every keystroke, so
 * these run dozens of times per edit.
 */
import { mt } from './mainI18n'

import type { ProviderKind, ProviderProfile, Settings } from './types'

/** Every profile of a kind, chain order first, then the ones not chained yet. */
export function profilesOf(settings: Settings, kind: ProviderKind): ProviderProfile[] {
  const mine = (settings.profiles ?? []).filter((profile) => profile.kind === kind)
  const byId = new Map(mine.map((profile) => [profile.id, profile]))
  const ordered: ProviderProfile[] = []
  const seen = new Set<string>()
  for (const id of settings.chains?.[kind] ?? []) {
    const profile = byId.get(id)
    if (profile && !seen.has(id)) {
      seen.add(id)
      ordered.push(profile)
    }
  }
  for (const profile of mine) {
    if (!seen.has(profile.id)) ordered.push(profile)
  }
  return ordered
}

/** Inserts or replaces a profile and appends it to its chain when new. */
export function upsertProfile(settings: Settings, profile: ProviderProfile): Settings {
  const others = (settings.profiles ?? []).filter((item) => item.id !== profile.id)
  const chain = settings.chains?.[profile.kind] ?? []
  const nextChain = chain.includes(profile.id) ? chain : [...chain, profile.id]
  return {
    ...settings,
    profiles: [...others, profile],
    chains: { ...settings.chains, [profile.kind]: nextChain }
  }
}

/** Removes a profile and every chain reference to it. */
export function removeProfile(settings: Settings, id: string): Settings {
  const chains = { ...settings.chains }
  for (const kind of Object.keys(chains) as ProviderKind[]) {
    chains[kind] = chains[kind].filter((item) => item !== id)
  }
  return { ...settings, profiles: (settings.profiles ?? []).filter((item) => item.id !== id), chains }
}

/**
 * Moves a profile by one slot inside its chain.
 *
 * `-1` moves up (earlier = tried first), `1` moves down. The chain is the source
 * of truth for order, so a profile missing from it is appended first rather than
 * silently ignored.
 */
export function moveProfile(settings: Settings, id: string, delta: -1 | 1): Settings {
  const kind = (settings.profiles ?? []).find((profile) => profile.id === id)?.kind
  if (!kind) return settings
  const chain = [...(settings.chains?.[kind] ?? [])]
  if (!chain.includes(id)) chain.push(id)
  const from = chain.indexOf(id)
  const to = from + delta
  if (to < 0 || to >= chain.length) return settings
  chain.splice(from, 1)
  chain.splice(to, 0, id)
  return { ...settings, chains: { ...settings.chains, [kind]: chain } }
}

/** Toggles the enabled flag without touching chain position. */
export function setProfileEnabled(settings: Settings, id: string, enabled: boolean): Settings {
  return {
    ...settings,
    profiles: (settings.profiles ?? []).map((profile) =>
      profile.id === id ? { ...profile, enabled } : profile
    )
  }
}

/** Id for a new profile, stable across a session and readable in logs. */
export function newProfileId(kind: ProviderKind, existing: ProviderProfile[]): string {
  const taken = new Set(existing.map((profile) => profile.id))
  for (let index = 1; index < 1000; index += 1) {
    const id = `${kind}-${index}`
    if (!taken.has(id)) return id
  }
  return `${kind}-${Date.now()}`
}

/**
 * A name no other profile already uses.
 *
 * Two rows both labelled "Groq" (a paid key and a free one, say) are
 * indistinguishable in the list and in history, so the second becomes "Groq 2".
 */
export function uniqueProfileName(name: string, existing: ProviderProfile[]): string {
  const base = name.trim() || mt('未命名')
  const taken = new Set(existing.map((profile) => profile.name.trim()))
  if (!taken.has(base)) return base
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base} ${index}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base} ${Date.now()}`
}