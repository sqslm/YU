import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryEntry, MemoryGraph, MemoryKind } from '@shared/memory'

interface CatalogRow extends MemoryEntry { vector?: number[] }

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
      const view = bytes && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      return { id: row.id as string, text: payload.data, kind, sourceId: payload.sourceId ?? '', createdAt: payload.createdAt, updatedAt: payload.updatedAt,
        ...(view && { vector: Array.from({ length: view.byteLength / 4 }, (_, i) => view.getFloat32(i * 4, true)) }) }
    }) }
  } finally { db.close() }
}

export function graphLinks(rows: CatalogRow[]): MemoryGraph['links'] {
  const links: MemoryGraph['links'] = [], pairs = new Set<string>()
  const sources = rows.map(row => new Set(row.sourceId.split(',').filter(id => id && id !== 'manual')))
  const norms = rows.map(row => Math.sqrt(row.vector?.reduce((sum, v) => sum + v * v, 0) ?? 0))
  for (let i = 0; i < rows.length; i++) {
    const candidates: Array<{ j: number; type: 'similar' | 'source'; score: number }> = []
    for (let j = 0; j < rows.length; j++) {
      if (i === j) continue
      const common = [...sources[i]].some(id => sources[j].has(id))
      const a = rows[i].vector, b = rows[j].vector
      let score = 0
      if (a && b && a.length === b.length && norms[i] && norms[j]) {
        for (let n = 0; n < a.length; n++) score += a[n] * b[n]
        score /= norms[i] * norms[j]
      }
      if (common || score >= 0.78) candidates.push({ j, type: common ? 'source' : 'similar', score })
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
