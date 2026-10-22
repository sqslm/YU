import type { SearchConnection, SearchProbeResult } from '@shared/types'
import { mergeSettings } from '@shared/defaults'
import { isSearchProvider } from '@shared/searchProviders'
import { searchWeb } from './search'
import { mt } from '@shared/mainI18n'

/** A user-requested search, with the exact connection credentials and no pool fallback. */
export async function probeSearch(input: Pick<SearchConnection, 'provider' | 'apiKey' | 'endpoint'>): Promise<SearchProbeResult> {
  const started = Date.now()
  try {
    if (!isSearchProvider(input.provider)) throw new Error(mt('不支持的搜索服务'))
    const cfg = { ...mergeSettings({}).search, ...input, strategy: 'single' as const, maxResults: 1 }
    const results = await searchWeb(cfg, 'Typeless Rebuild')
    return { ok: true, count: results.length, durationMs: Date.now() - started }
  } catch (error) {
    return { ok: false, count: 0, durationMs: Date.now() - started, message: error instanceof Error ? error.message : String(error) }
  }
}
