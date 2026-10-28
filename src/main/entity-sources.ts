import { ENTITY_SOURCES } from '@shared/entity-sources'
import type { EntityInput } from '@shared/entities'

export function parsePublicTerms(text: string, source: typeof ENTITY_SOURCES[number]): EntityInput[] {
  const seen = new Set<string>(), rows: Array<{ canonical: string; frequency: number }> = []
  let body = source.format !== 'rime'
  for (const line of text.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    if (!body) { if (line.trim() === '...') body = true; continue }
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const cells = line.split('\t'), canonical = cells[0].trim()
    // Read dictionary rows as plain text, never parse/execute YAML tags or code.
    if (cells.length < 2 || !/^[\p{L}\p{N}· .+#&-]{2,80}$/u.test(canonical) || seen.has(canonical.toLowerCase())) continue
    seen.add(canonical.toLowerCase())
    rows.push({ canonical, frequency: Number(cells[source.format === 'rime' ? 2 : 1]) || 0 })
  }
  if (!rows.length) throw Error('公共词库格式已变化，请稍后重试')
  const selected = 'limit' in source ? rows.sort((a, b) => b.frequency - a.frequency).slice(0, source.limit) : rows
  return selected.map(({ canonical }) => ({ canonical, type: source.domain === '技术' ? 'technology' : 'custom', aliases: [], related: [], domain: source.domain,
    source: `${source.url} (${source.license})`, verified: false, enabled: true, userDefined: false }))
}

export async function fetchPublicTerms(ids: unknown, request: typeof fetch): Promise<EntityInput[]> {
  if (!Array.isArray(ids) || !ids.length || ids.length > ENTITY_SOURCES.length || ids.some(id => !ENTITY_SOURCES.some(source => source.id === id))) throw Error('请选择有效的公共词库')
  const terms: EntityInput[] = []
  for (const id of new Set(ids)) {
    const source = ENTITY_SOURCES.find(source => source.id === id)!
    const response = await request(source.url, { signal: AbortSignal.timeout(20000), redirect: 'error', credentials: 'omit' })
    if (!response.ok) throw Error(`公共词库下载失败 (${response.status})`)
    const reader = response.body?.getReader()
    if (!reader) throw Error('公共词库下载为空')
    const chunks: Uint8Array[] = []; let bytes = 0
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break
        bytes += value.length
        if (bytes > 1024 * 1024) throw Error('公共词库文件过大')
        chunks.push(value)
      }
    } finally { await reader.cancel() }
    terms.push(...parsePublicTerms(Buffer.concat(chunks).toString('utf8'), source))
  }
  return terms
}
