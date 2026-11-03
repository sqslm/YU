import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryEntry, MemoryGraph, MemoryKind } from '@shared/memory'

interface CatalogRow extends MemoryEntry { vector?: number[] | Float32Array }

/** Read-only equivalent of pinned Mem0 2.4.6 MemoryVectorStore.search.
 * Keep float32 storage, cosine scores, stable ties and category/user isolation.
 * Writes and extraction still belong to the SDK; recall need not import it.
 */
export function searchCatalog(home: string, kind: MemoryKind, query: number[]): MemoryEntry[] {
  if (query.length !== 512) throw Error('Memory query dimension mismatch')
  const path = join(home, `${kind}.db`)
  if (!existsSync(path)) return []
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 1000')
    const results: MemoryEntry[] = []
    const queryNorm = Math.sqrt(query.reduce((sum, value) => sum + value * value, 0))
    for (const row of db.prepare("SELECT id, payload, vector FROM vectors WHERE json_extract(payload, '$.userId') = ?").iterate('local-user')) {
      const bytes = row.vector as Uint8Array
      if (bytes.byteLength !== query.length * 4) throw Error('Memory vector dimension mismatch')
      const vector = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      let dot = 0, norm = 0
      for (let i = 0; i < query.length; i++) {
        const value = vector.getFloat32(i * 4, true)
        dot += query[i] * value; norm += value * value
      }
      const payload = JSON.parse(row.payload as string)
      results.push({ id: row.id as string, text: payload.data, kind, sourceId: payload.sourceId ?? '', createdAt: payload.createdAt, updatedAt: payload.updatedAt,
        score: dot / (queryNorm * Math.sqrt(norm)) })
    }
    results.sort((a, b) => (b.score || 0) - (a.score || 0))
    return results.slice(0, kind === 'assistant' ? 5 : 3)
  } finally { db.close() }
}

// Read-only view of the pinned Mem0 2.4.6 SQLite format. All writes remain in Mem0.
export function readCatalog(home: string, kind: MemoryKind, limit = 10000, query = '', vectors = false): { rows: CatalogRow[]; total: number } {
  const path = join(home, `${kind}.db`)
  if (!existsSync(path)) return { rows: [], total: 0 }
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 1000')
    const where = "json_extract(payload, '$.userId') = ? AND instr(lower(json_extract(payload, '$.data')), lower(?)) > 0"
    const total = Number((db.prepare(`SELECT count(*) AS n FROM vectors WHERE ${where}`).get('local-user', query) as { n: number }).n)
    const rows = db.prepare(`SELECT id, payload${vectors ? ', vector' : ''} FROM vectors WHERE ${where} ORDER BY coalesce(json_extract(payload, '$.updatedAt'), json_extract(payload, '$.createdAt')) DESC, id LIMIT ?`).all('local-user', query, limit)
    return { total, rows: rows.map(row => {
      const payload = JSON.parse(row.payload as string)
      const bytes = row.vector as Uint8Array | undefined
      // The driver hands each row its own buffer, so the float32 payload is read
      // in place instead of being copied into a boxed array.
      const view = bytes && new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
      return { id: row.id as string, text: payload.data, kind, sourceId: payload.sourceId ?? '', createdAt: payload.createdAt, updatedAt: payload.updatedAt,
        ...(view && { vector: view }) }
    }) }
  } finally { db.close() }
}

export function graphLinks(rows: CatalogRow[]): MemoryGraph['links'] {
  const links: MemoryGraph['links'] = [], pairs = new Set<string>()
  const sources = rows.map(row => new Set(row.sourceId.split(',').filter(id => id && id !== 'manual')))
  // float32 widens to these exactly, and a flat float64 copy keeps the dot
  // product loop out of the slower float32 element path.
  const vectors = rows.map(row => row.vector && Float64Array.from(row.vector))
  const norms = vectors.map(vector => Math.sqrt(vector ? vector.reduce((sum, value) => sum + value * value, 0) : 0))
  // One score per unordered pair: the cosine and the shared-source test are
  // both symmetric, so each pair is evaluated once and read back in the
  // original ascending order.
  const size = rows.length, scores = new Float64Array(size * size), kinds = new Uint8Array(size * size)
  for (let i = 0; i < size; i++) {
    for (let j = i + 1; j < size; j++) {
      let common = false
      for (const id of sources[i]) if (sources[j].has(id)) { common = true; break }
      const a = vectors[i], b = vectors[j]
      let score = 0
      if (a && b && a.length === b.length && norms[i] && norms[j]) {
        for (let n = 0; n < a.length; n++) score += a[n] * b[n]
        score /= norms[i] * norms[j]
      }
      // Written as "not (score >= threshold)" so a non-finite score keeps the
      // baseline rule: such a pair only survives through a shared source.
      if (!common && !(score >= 0.78)) continue
      const kind = common ? 2 : 1
      kinds[i * size + j] = kinds[j * size + i] = kind
      scores[i * size + j] = scores[j * size + i] = score
    }
  }
  for (let i = 0; i < size; i++) {
    const candidates: Array<{ j: number; type: 'similar' | 'source'; score: number }> = []
    for (let j = 0; j < size; j++) {
      const kind = kinds[i * size + j]
      if (!kind) continue
      candidates.push({ j, type: kind === 2 ? 'source' : 'similar', score: scores[i * size + j] })
    }
    candidates.sort((a, b) => Number(b.type === 'source') - Number(a.type === 'source') || b.score - a.score)
    for (const edge of candidates.slice(0, 3)) {
      const key = [i, edge.j].sort((a, b) => a - b).join(':')
      if (!pairs.has(key)) {
        pairs.add(key)
        links.push({ source: rows[i].id, target: rows[edge.j].id, type: edge.type, score: edge.score })
      }
    }
  }
  return links
}

export function readGraph(home: string, kind?: MemoryKind, query = ''): MemoryGraph {
  const groups = (kind ? [kind] : ['assistant', 'style'] as const).map(k => readCatalog(home, k, 200, query, true))
  const rows = groups.flatMap(group => group.rows).sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? '')).slice(0, 200)
  return { nodes: rows.map(({ vector: _, ...row }) => row), links: graphLinks(rows), total: groups.reduce((sum, group) => sum + group.total, 0), limit: 200 }
}
