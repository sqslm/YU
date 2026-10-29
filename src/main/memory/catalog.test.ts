import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { graphLinks, readCatalog, readGraph } from './catalog'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('yu-catalog-')) throw Error('Unexpected test directory')
  rmSync(root, { recursive: true, force: true })
} })
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'yu-catalog-')); roots.push(root)
  const db = new DatabaseSync(join(root, 'assistant.db'))
  db.exec('CREATE TABLE vectors (id TEXT PRIMARY KEY, vector BLOB, payload TEXT)')
  const insert = db.prepare('INSERT INTO vectors VALUES (?, ?, ?)')
  for (let i = 0; i < 205; i++) insert.run(String(i), Buffer.from(new Float32Array([1, 0]).buffer), JSON.stringify({ userId: i === 204 ? 'other-user' : 'local-user', data: `记忆${i}`, sourceId: 'manual', createdAt: '2026-10-29T00:00:00Z' }))
  db.close(); return root
}
it('reads the SDK format without a model, filters users and searches before the graph limit', () => {
  const home = fixture()
  expect(readCatalog(home, 'assistant').rows).toHaveLength(204)
  expect(readCatalog(home, 'style').rows).toEqual([])
  const result = readGraph(home)
  expect(result.nodes).toHaveLength(200); expect(result.total).toBe(204)
  expect(result.links.length).toBeLessThanOrEqual(600)
  expect(readGraph(home, undefined, '记忆203').nodes[0].text).toBe('记忆203')
  expect(readGraph(home, undefined, '记忆204').nodes).toEqual([])
})
it('distinguishes shared provenance from similarity, excludes manual pseudo-links and deduplicates pairs', () => {
  const row = (id: string, sourceId: string, vector: number[]) => ({ id, sourceId, vector, text: id, kind: 'assistant' as const })
  const links = graphLinks([row('a', 'turn-1,turn-2', [1, 0]), row('b', 'turn-2', [0, 1]), row('c', 'manual', [1, 0]), row('d', 'manual', [-1, 0])])
  expect(links).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'a', target: 'b', type: 'source' }), expect.objectContaining({ source: 'a', target: 'c', type: 'similar' })]))
  expect(links.filter(link => new Set([link.source, link.target]).has('d'))).toHaveLength(0)
  expect(links).toHaveLength(2)
})
