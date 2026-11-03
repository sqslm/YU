import { expect, it } from 'vitest'
import type { MemoryGraph } from '@shared/memory'
import { graphLinks } from './catalog'

/** Row shape used by the differential fixtures. */
type Row = { id: string; sourceId: string; vector?: number[]; text: string; kind: 'assistant' | 'style' }

/** Copy of graphLinks at 00d652c, kept as the oracle for this refactor. */
function baseline(rows: Row[]): MemoryGraph['links'] {
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

/** The refactor reads float32 storage in place; mirror that on the same values. */
function production(rows: Row[]): MemoryGraph['links'] {
  return graphLinks(rows.map(row => ({ ...row, vector: row.vector && new Float32Array(row.vector) })) as Parameters<typeof graphLinks>[0])
}

const row = (id: string, vector: number[] | undefined, sourceId = ''): Row => ({ id, sourceId, vector, text: id, kind: 'assistant' })

/** Deterministic pseudo random generator so the large fixture is reproducible. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function compare(rows: Row[]) {
  // Storage is float32, so both sides see the same rounded values.
  const rounded = rows.map(item => ({ ...item, vector: item.vector && Array.from(new Float32Array(item.vector)) }))
  const expected = baseline(rounded)
  const actual = production(rounded)
  expect(actual).toEqual(expected)
  return actual
}

it('keeps the baseline result for degenerate catalogs', () => {
  expect(compare([])).toEqual([])
  expect(compare([row('solo', [1, 0])])).toEqual([])
  expect(compare([row('no-vector', undefined), row('also-none', undefined)])).toEqual([])
})

it('keeps scores, provenance priority, ties and the three-link cap', () => {
  const rows = [
    row('a', [1, 0], 'turn-1'),
    row('b', [1, 0], 'turn-1,turn-2'),
    row('c', [1, 0]),
    row('d', [1, 0]),
    row('e', [1, 0]),
    row('manual', [0, 1], 'manual'),
  ]
  const links = compare(rows)
  // a and b share provenance, so that edge comes first; the rest are equal
  // scores and therefore keep their ascending target order.
  expect(links.slice(0, 3)).toEqual([
    { source: 'a', target: 'b', type: 'source', score: 1 },
    { source: 'a', target: 'c', type: 'similar', score: 1 },
    { source: 'a', target: 'd', type: 'similar', score: 1 },
  ])
  compare(rows)
})

it('keeps short vectors, mismatched lengths, zero norms and missing vectors', () => {
  compare([row('short-a', [1, 0]), row('short-b', [0.6, 0.8]), row('long', [1, 0, 0]), row('zero', [0, 0]), row('none', undefined)])
  compare([row('one', [1]), row('two', [1, 1]), row('three', [1, 1, 1])])
  // a zero-norm pair scores 0 in the baseline instead of producing NaN
  const zeroNorms = compare([row('zero', [0, 0]), row('unit', [1, 0])])
  expect(zeroNorms.filter(link => link.type === 'similar')).toEqual([])
})

it('keeps the similarity threshold on both sides of 0.78', () => {
  const at = Math.SQRT1_2 // cos 45° = 0.7071, so build the exact 0.78 cosine
  const cosine = (value: number) => [value, Math.sqrt(1 - value * value)]
  const below = compare([row('a', cosine(0.7799)), row('b', [1, 0])])
  const above = compare([row('a', cosine(0.7801)), row('b', [1, 0])])
  expect(below.filter(link => link.type === 'similar')).toEqual([])
  expect(above.filter(link => link.type === 'similar').length).toBeGreaterThan(0)
  expect(at).toBeCloseTo(0.7071, 4)
})

it('keeps orthogonal, negatively correlated and differently scaled pairs out', () => {
  const links = compare([row('x', [1, 0]), row('y', [0, 1]), row('z', [-1, 0]), row('scaled', [1000, 0])])
  const scoreOf = (source: string, target: string) => links.find(link => link.source === source && link.target === target)?.score
  expect(scoreOf('x', 'scaled')).toBe(1)
  expect(links.some(link => link.type === 'similar' && scoreOf(link.source, link.target) !== undefined && (link.score as number) < 0.78)).toBe(false)
})

it('keeps non-finite values out of the graph exactly like the baseline', () => {
  compare([row('nan', [Number.NaN, 1]), row('inf', [Number.POSITIVE_INFINITY, 0]), row('finite', [1, 0])])
  compare([row('nan-shared', [Number.NaN, 1], 'turn-9'), row('shared', [1, 0], 'turn-9')])
})

it('keeps the full link list and its order for a 200 node catalog', () => {
  const next = random(20261103)
  const rows: Row[] = []
  for (let index = 0; index < 200; index++) {
    const vector = Array.from({ length: 16 }, () => next() * 2 - 1)
    // near-duplicates exercise the similarity branch, shared turns the provenance branch
    if (index > 0 && index % 7 === 0) vector.splice(0, 16, ...(rows[index - 1].vector as number[]))
    rows.push(row(`n${index}`, vector, index % 5 === 0 ? `turn-${index % 3}` : index % 11 === 0 ? `turn-${index % 3},turn-9` : ''))
  }
  const links = compare(rows)
  expect(new Set(links.map(link => link.type))).toEqual(new Set(['source', 'similar']))
  expect(links.length).toBeGreaterThan(100)
  expect(links.length).toBeLessThanOrEqual(600)
})
