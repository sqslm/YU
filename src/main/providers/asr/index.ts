import type { PresetField, ProviderSettings } from '@shared/types'
import { presetVendorFields } from '@shared/providerFields'
import { findPreset } from '@shared/providerPresets'
import { CN_SPECS } from './cn'
import { REALTIME_SPECS } from './realtime'
import { WEST_SPECS } from './west'
import type { AsrAdapterInput, AsrAdapterSpec } from './types'
import { field } from './types'

/**
 * Every vendor that does not speak OpenAI multipart, in one place.
 *
 * Two registries rather than one list because they were written against two very
 * different sets of docs — and because a single file of 1300 lines is a file
 * nobody audits. Order matters only for the host fallback: a more specific
 * suffix must come before a broader one (`openai.azure.com` before nothing else
 * claims it, and no vendor shares a suffix today).
 */
export const ASR_ADAPTERS: AsrAdapterSpec[] = [...WEST_SPECS, ...CN_SPECS, ...REALTIME_SPECS]

/**
 * What a profile looks like to this module.
 *
 * The settings the pipeline hands over are a `ProviderSettings` copy, while the
 * stored profile is a `ProviderProfile`; only `preset` differs, and it is optional
 * here because a hand-written profile genuinely has none.
 */
interface ProfileLike extends ProviderSettings {
  preset?: string
}

/** Exact id lookup, for tests and for the preset → adapter mapping. */
export function findAsrAdapter(id: string | undefined): AsrAdapterSpec | null {
  if (!id) return null
  return ASR_ADAPTERS.find((spec) => spec.id === id) ?? null
}

/**
 * Which adapter a profile needs, if any.
 *
 * Three signals, most authoritative first:
 *
 * 1. `asrAdapter` on the profile — written when the profile is created, and the
 *    only signal that survives moving a vendor behind a proxy or renaming it.
 * 2. The preset id — covers profiles created before `asrAdapter` existed, as
 *    long as they were created from a preset.
 * 3. The host — covers hand-written profiles and restored backups, where the
 *    user typed `api.deepgram.com` and expects it to just work.
 *
 * Nothing matching means the OpenAI path, which is what most vendors are.
 */
export function resolveAsrAdapter(cfg: ProfileLike): AsrAdapterSpec | null {
  const explicit = findAsrAdapter(cfg.asrAdapter)
  if (explicit) return explicit

  // The preset id is not always the adapter id (`iflytek` → `xfyun`), so the
  // preset table has the last word on which adapter a profile was created for.
  const byPreset = findAsrAdapter(findPreset(cfg.preset ?? '')?.asrAdapter) ?? findAsrAdapter(cfg.preset)
  if (byPreset) return byPreset

  const host = hostOf(cfg.baseUrl)
  if (!host) return null
  const scheme = schemeOf(cfg.baseUrl)
  return (
    ASR_ADAPTERS.find(
      (spec) =>
        spec.hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)) &&
        // A spec that names its schemes only claims those; one that does not
        // (the HTTP vendors) claims the host whatever the scheme.
        (spec.schemes === undefined || spec.schemes.length === 0 || spec.schemes.includes(scheme))
    ) ?? null
  )
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function schemeOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).protocol.replace(/:$/, '').toLowerCase()
  } catch {
    return ''
  }
}

/**
 * The vendor fields a preset needs, registry first.
 *
 * `shared/providerFields.ts` is what the settings form reads; the registry is
 * what the adapter reads. A preset that only the registry knows about (an
 * adapter added without touching the shared table) still gets its inputs, which
 * is the failure mode that would otherwise make a provider silently unusable.
 */
export function adapterFieldsFor(presetId: string | undefined): PresetField[] {
  const fromShared = presetVendorFields(presetId)
  const fromRegistry = findAsrAdapter(presetId)?.fields ?? []
  if (fromShared.length === 0) return fromRegistry
  const seen = new Set(fromShared.map((item) => item.key))
  return [...fromShared, ...fromRegistry.filter((item) => !seen.has(item.key))]
}

/**
 * Run one take through its vendor adapter.
 *
 * Duration is derived from the WAV length instead of asked for: the caller
 * already encoded the clip, `16 kHz mono PCM16` is a fixed 32 bytes per
 * millisecond, and a vendor that wants seconds gets them from one subtraction
 * rather than from a second source of truth that can disagree.
 */
export async function runAsrAdapter(
  spec: AsrAdapterSpec,
  cfg: ProfileLike,
  wav: Uint8Array,
  options: {
    entityContext?: string
    model: string
    language?: string
    signal?: AbortSignal
    log: (line: string) => void
  }
): Promise<string> {
  const pcmBytes = Math.max(0, wav.length - 44)
  const input: AsrAdapterInput = {
    entityContext: options.entityContext,
    wav,
    ms: Math.round(pcmBytes / 32),
    model: options.model || cfg.model,
    language: options.language ?? '',
    mime: 'audio/wav'
  }
  const ctx = {
    baseUrl: cfg.baseUrl.replace(/\/+$/, ''),
    apiKey: cfg.apiKey ?? '',
    extraHeaders: cfg.extraHeaders,
    fields: cfg.vendor ?? {},
    signal: options.signal ?? new AbortController().signal,
    log: options.log
  }
  options.log(`[asr] ${spec.label} adapter (${spec.id})`)
  return spec.run(ctx, input)
}

/** Read one vendor value without importing the helper everywhere. */
export { field as readVendorField }
