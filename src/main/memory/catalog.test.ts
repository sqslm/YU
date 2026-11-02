import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { graphLinks, readCatalog, readGraph, searchCatalog } from './catalog'

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

it('recalls float32 cosine scores with stable ties, separate kinds/users and the existing limits', () => {
  const home = mkdtempSync(join(tmpdir(), 'yu-catalog-')); roots.push(home)
  const basis = (a: number, b = 0): number[] => [a, b, ...Array(510).fill(0)]
  for (const kind of ['assistant', 'style'] as const) {
    const db = new DatabaseSync(join(home, `${kind}.db`))
    db.exec('CREATE TABLE vectors (id TEXT PRIMARY KEY, vector BLOB, payload TEXT)')
    const insert = db.prepare('INSERT INTO vectors VALUES (?, ?, ?)')
    for (const [id, vector] of [['first', basis(1)], ['tie', basis(2)], ['diagonal', basis(1, 1)], ['orthogonal', basis(0, 1)], ['negative', basis(-1)], ['zero', basis(0)], ['foreign', basis(1)]] as const) {
      insert.run(id, Buffer.from(new Float32Array(vector).buffer), JSON.stringify({ userId: id === 'foreign' ? 'another-user' : 'local-user', data: kind + ':' + id, sourceId: 'turn', createdAt: '2026-11-03T00:00:00Z' }))
    }
    db.close()
  }
  const before = readFileSync(join(home, 'assistant.db'))
  const result = searchCatalog(home, 'assistant', basis(1))
  expect(result.map(row => row.id)).toEqual(['first', 'tie', 'diagonal', 'orthogonal', 'zero'])
  expect(result[0]).toMatchObject({ text: 'assistant:first', kind: 'assistant', sourceId: 'turn', score: 1, createdAt: '2026-11-03T00:00:00Z' })
  expect(result[2].score).toBe(1 / Math.sqrt(2)); expect(result[4].score).toBeNaN()
  expect(searchCatalog(home, 'style', basis(1)).map(row => row.text)).toEqual(['style:first', 'style:tie', 'style:diagonal'])
  expect(readFileSync(join(home, 'assistant.db'))).toEqual(before)
})

it('does not create a missing catalog and surfaces invalid vector dimensions', () => {
  const home = mkdtempSync(join(tmpdir(), 'yu-catalog-')); roots.push(home)
  expect(searchCatalog(home, 'assistant', Array(512).fill(0))).toEqual([])
  expect(existsSync(join(home, 'assistant.db'))).toBe(false)
  expect(() => searchCatalog(home, 'assistant', [1, 0])).toThrow('query dimension mismatch')
  expect(() => searchCatalog(fixture(), 'assistant', Array(512).fill(1))).toThrow('vector dimension mismatch')
})
