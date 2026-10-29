import type { ProviderKind, Settings } from './types'
import { ttsProfiles } from './speech'

export interface QuotaTarget { kind: ProviderKind | 'tts' | 'local-asr'; id: string }
export interface QuotaConnection extends QuotaTarget { name: string; model: string; enabled: boolean }
export interface QuotaMetric {
  label: string
  remaining?: number
  used?: number
  total?: number
  unit: string
  resetsAt?: number
}
export interface QuotaResult {
  status: 'ok' | 'unsupported' | 'unconfigured' | 'error' | 'local'
  scope: 'account' | 'key' | 'none'
  message: string
  metrics: QuotaMetric[]
  checkedAt: number
  consoleUrl?: string
}
export const quotaKey = (target: QuotaTarget): string => `${target.kind}:${target.id}`
export function quotaConnections(settings: Settings): QuotaConnection[] {
  const activeTts = settings.tts.activeProfileId ?? (settings.tts.provider === 'windows' ? 'windows' : `migrated-${settings.tts.provider}`)
  return [...settings.profiles.map(({ id, kind, name, model, enabled }) => ({ id, kind, name, model, enabled })),
    ...(settings.localAsr.enabled ? [{ id: 'local', kind: 'local-asr' as const, name: '本地 ASR', model: settings.localAsr.modelId, enabled: true }] : []),
    ...ttsProfiles(settings.tts).map(profile => ({ id: profile.id, kind: 'tts' as const, name: profile.name, model: profile.model,
      enabled: settings.tts.enabled && profile.id === activeTts }))]
}
export function defaultQuotaTarget(settings: Settings): QuotaTarget | undefined {
  const connections = quotaConnections(settings)
  return connections.find(row => row.kind === 'llm' && row.id === settings.chains.llm[0] && row.enabled)
    ?? connections.find(row => row.kind === 'llm' && row.enabled) ?? connections.find(row => row.enabled) ?? connections[0]
}
/** A balance alone is not a percentage. Zero/unknown limits must never look full or empty. */
export function quotaRemainingRatio(result?: QuotaResult): number | undefined {
  if (result?.status !== 'ok') return undefined
  const metric = result.metrics.find(row => row.remaining !== undefined && row.total !== undefined && row.total > 0)
  return metric ? Math.max(0, Math.min(1, metric.remaining! / metric.total!)) : undefined
}
