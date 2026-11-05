import { describe, expect, it } from 'vitest'
import type { KnowledgeCard, KnowledgeCardPage, KnowledgeGraph, ProfileItem, RelationList } from '@shared/knowledge'
import {
  CARD_PAGE_SIZE,
  EMPTY_FILTERS,
  EMPTY_LIST,
  cardRequest,
  createGate,
  emptyState,
  filtersActive,
  graphNotice,
  groupProfile,
  groupRelations,
  kindKey,
  mergeGraph,
  mergePage,
  mergePreview,
  mergeQuery,
  paneMode,
  relationKey,
  selectedSummary,
  toForceData
} from './knowledgeView'

function summary(id: string, patch: Partial<KnowledgeCardPage['items'][number]> = {}): KnowledgeCardPage['items'][number] {
  return { id, kind: 'concept', title: id, summary: '', topics: [], aliases: [], sourceIds: [], favorite: false, edited: false, revision: 1, createdAt: 1, updatedAt: 1, bodyChars: 0, ...patch }
}

function page(items: KnowledgeCardPage['items'], nextOffset: number | null, total = items.length): KnowledgeCardPage {
  return { items, total, offset: 0, limit: CARD_PAGE_SIZE, hasMore: nextOffset !== null, nextOffset }
}

function card(id: string, patch: Partial<KnowledgeCard> = {}): KnowledgeCard {
  return { id, kind: 'concept', title: id, summary: '', body: '', topics: [], aliases: [], sourceIds: [], favorite: false, edited: false, revision: 1, createdAt: 1, updatedAt: 1, ...patch }
}

describe('request building', () => {
  it('keeps a plain list when no text is typed', () => {
    const request = cardRequest(EMPTY_FILTERS, 40)
    expect(request.search).toBe(false)
    expect(request.query).toEqual({ offset: 40, limit: CARD_PAGE_SIZE })
  })

  it('routes a trimmed query to the search endpoint and carries every filter', () => {
    const request = cardRequest({ topic: 'Rust', kind: 'method', favorite: true, query: '  借用  ' }, 0)
    expect(request.search).toBe(true)
    expect(request.query).toEqual({ offset: 0, limit: CARD_PAGE_SIZE, topic: 'Rust', kind: 'method', favorite: true, query: '借用' })
  })

  it('never asks for a negative offset', () => {
    expect(cardRequest(EMPTY_FILTERS, -10).query.offset).toBe(0)
  })

  it('knows when the filter row is doing something', () => {
    expect(filtersActive(EMPTY_FILTERS)).toBe(false)
    expect(filtersActive({ ...EMPTY_FILTERS, query: '  ' })).toBe(false)
    expect(filtersActive({ ...EMPTY_FILTERS, favorite: true })).toBe(true)
    expect(filtersActive({ ...EMPTY_FILTERS, kind: 'review' })).toBe(true)
  })
})

describe('paging', () => {
  it('replaces the list on the first page and appends afterwards', () => {
    const first = mergePage(null, page([summary('a'), summary('b')], 2, 3))
    expect(first.items.map((row) => row.id)).toEqual(['a', 'b'])
    expect(first.nextOffset).toBe(2)
    const second = mergePage(first, page([summary('c')], null, 3))
    expect(second.items.map((row) => row.id)).toEqual(['a', 'b', 'c'])
    expect(second.nextOffset).toBeNull()
    expect(second.total).toBe(3)
  })

  it('follows nextOffset instead of arithmetic and de-duplicates an overlapping page', () => {
    const first = mergePage(null, page([summary('a'), summary('b')], 7, 2))
    const second = mergePage(first, page([summary('b'), summary('d')], null, 2))
    expect(second.items.map((row) => row.id)).toEqual(['a', 'b', 'd'])
    expect(second.nextOffset).toBeNull()
  })

  it('drops everything when a refreshed page replaces the list', () => {
    const list = mergePage(null, page([summary('a')], null, 1))
    const refreshed = mergePage(null, page([summary('z')], null, 1))
    expect(list.items).toHaveLength(1)
    expect(refreshed.items.map((row) => row.id)).toEqual(['z'])
  })
})

describe('stale response guard', () => {
  it('lets only the newest ticket write', () => {
    const gate = createGate()
    const slow = gate.next()
    const fast = gate.next()
    expect(gate.isCurrent(slow)).toBe(false)
    expect(gate.isCurrent(fast)).toBe(true)
  })

  it('keeps the latest ticket current until a newer request starts', () => {
    const gate = createGate()
    const only = gate.next()
    expect(gate.isCurrent(only)).toBe(true)
    expect(gate.isCurrent(only + 1)).toBe(false)
  })
})

describe('selection and panes', () => {
  it('keeps a selection that survives the new page', () => {
    const list = mergePage(null, page([summary('a'), summary('b')], null, 2))
    expect(selectedSummary(list, 'b')?.id).toBe('b')
    expect(selectedSummary(list, null)).toBeNull()
  })

  it('drops a selection filtered out of the list', () => {
    const list = mergePage(null, page([summary('a')], null, 1))
    expect(selectedSummary(list, 'gone')).toBeNull()
  })

  it('splits on a wide window and swaps on a narrow one', () => {
    expect(paneMode(true, false)).toBe('split')
    expect(paneMode(true, true)).toBe('split')
    expect(paneMode(false, false)).toBe('list')
    expect(paneMode(false, true)).toBe('detail')
  })
})

describe('empty state', () => {
  it('explains an empty library only when nothing is filtered', () => {
    expect(emptyState({ shown: 3, filters: EMPTY_FILTERS })).toBe('none')
    expect(emptyState({ shown: 0, filters: EMPTY_FILTERS })).toBe('library')
    expect(emptyState({ shown: 0, filters: { ...EMPTY_FILTERS, topic: 'Rust' } })).toBe('filters')
    expect(emptyState({ shown: 0, filters: { ...EMPTY_FILTERS, query: '借用' } })).toBe('filters')
  })
})

describe('labels', () => {
  it('maps every kind and relation to its translation key', () => {
    expect(kindKey('review')).toBe('knowledge.kinds.review')
    expect(relationKey('contains')).toBe('knowledge.relations.contains')
    expect(relationKey('prerequisite')).toBe('knowledge.relations.prerequisite')
    expect(relationKey('applies')).toBe('knowledge.relations.applies')
    expect(relationKey('contrast')).toBe('knowledge.relations.contrast')
    expect(relationKey('derives')).toBe('knowledge.relations.derives')
  })

  it('splits relations by the direction the card sees them from', () => {
    const list: RelationList = {
      total: 3,
      items: [
        { id: 'r1', fromId: 'x', toId: 'y', kind: 'contains', origin: 'manual', evidence: '', createdAt: 1, card: { id: 'y', title: 'Y', kind: 'concept' }, direction: 'out' },
        { id: 'r2', fromId: 'z', toId: 'x', kind: 'derives', origin: 'model', evidence: 'q', createdAt: 2, card: { id: 'z', title: 'Z', kind: 'method' }, direction: 'in' },
        { id: 'r3', fromId: 'x', toId: 'w', kind: 'contrast', origin: 'manual', evidence: '', createdAt: 3, card: { id: 'w', title: 'W', kind: 'decision' }, direction: 'out' }
      ]
    }
    const groups = groupRelations(list)
    expect(groups.out.map((row) => row.id)).toEqual(['r1', 'r3'])
    expect(groups.in.map((row) => row.id)).toEqual(['r2'])
    expect(groups.total).toBe(3)
  })
})

describe('merge preview', () => {
  it('joins both bodies, de-duplicates sources and unions topics', () => {
    const preview = mergePreview(
      card('keep', { title: '借用检查', body: 'A', topics: ['Rust', '内存'], sourceIds: ['s1', 's2'] }),
      card('merged', { body: 'B', topics: ['内存', '所有权'], sourceIds: ['s2', 's3'] })
    )
    expect(preview.title).toBe('借用检查')
    expect(preview.body).toBe('A\n\nB')
    expect(preview.sourceIds).toEqual(['s1', 's2', 's3'])
    expect(preview.topics).toEqual(['Rust', '内存', '所有权'])
  })

  it('does not leave a blank line when one body is empty', () => {
    expect(mergePreview(card('keep', { body: 'A' }), card('merged', { body: '   ' })).body).toBe('A')
    expect(mergePreview(card('keep', { body: '' }), card('merged', { body: '' })).body).toBe('')
  })

  it('pins both revisions on the confirm payload', () => {
    expect(mergeQuery(card('keep', { revision: 4 }), card('merged', { revision: 9 }))).toEqual({ keepId: 'keep', mergeId: 'merged', keepRevision: 4, mergeRevision: 9 })
  })
})

describe('graph adaptation', () => {
  const graph: KnowledgeGraph = {
    nodes: [
      { id: 'a', title: 'A', kind: 'concept', topics: [], favorite: false },
      { id: 'b', title: 'B', kind: 'method', topics: [], favorite: true }
    ],
    edges: [
      { id: 'e1', fromId: 'a', toId: 'b', kind: 'contains', origin: 'manual' },
      { id: 'e2', fromId: 'a', toId: 'missing', kind: 'derives', origin: 'model' }
    ],
    total: 8,
    shown: 2,
    truncated: true,
    limitedBy: 'nodes'
  }

  it('maps nodes and drops an edge whose endpoint was trimmed away', () => {
    const data = toForceData(graph)
    expect(data.nodes.map((node) => node.id)).toEqual(['a', 'b'])
    expect(data.links).toEqual([{ id: 'e1', source: 'a', target: 'b', kind: 'contains', origin: 'manual' }])
  })

  it('says which budget limited the graph', () => {
    expect(graphNotice(graph)).toEqual({ limitedBy: 'nodes', total: 8, shown: 2 })
    expect(graphNotice({ ...graph, limitedBy: 'bytes' })?.limitedBy).toBe('bytes')
    expect(graphNotice({ ...graph, truncated: false, limitedBy: null })).toBeNull()
  })

  it('unions an expanded hop without duplicating what is already drawn', () => {
    const first = mergeGraph(null, graph)
    const next: KnowledgeGraph = {
      nodes: [...graph.nodes, { id: 'c', title: 'C', kind: 'review', topics: [], favorite: false }],
      edges: [...graph.edges, { id: 'e3', fromId: 'b', toId: 'c', kind: 'applies', origin: 'manual' }, { id: 'e4', fromId: 'c', toId: 'a', kind: 'derives', origin: 'model' }],
      total: 9,
      shown: 3,
      truncated: false,
      limitedBy: null
    }
    const merged = mergeGraph(first, next)
    expect(merged.nodes.map((node) => node.id)).toEqual(['a', 'b', 'c'])
    // e2 still points at a node neither answer contains, so it stays dropped.
    expect(merged.edges.map((edge) => edge.id)).toEqual(['e1', 'e3', 'e4'])
    expect(merged.shown).toBe(3)
    expect(graphNotice(merged)).toBeNull()
  })
})

describe('profile grouping', () => {
  const item = (id: string, category: ProfileItem['category']): ProfileItem => ({ id, dimension: '偏好', value: id, category, origin: 'auto', pinned: false, corrected: false, evidence: [], createdAt: 1, updatedAt: 1 })

  it('uses the fixed category order and drops empty groups', () => {
    const groups = groupProfile([item('i1', 'inferred'), item('e1', 'explicit'), item('o1', 'observed'), item('e2', 'explicit')])
    expect(groups.map((group) => group.category)).toEqual(['explicit', 'observed', 'inferred'])
    expect(groups[0].items.map((row) => row.id)).toEqual(['e1', 'e2'])
  })

  it('returns nothing for an empty profile', () => {
    expect(groupProfile([])).toEqual([])
    expect(groupProfile([item('e1', 'explicit')]).map((group) => group.category)).toEqual(['explicit'])
  })
})

describe('an untouched list', () => {
  it('starts empty and unpaged', () => {
    expect(EMPTY_LIST.items).toHaveLength(0)
    expect(EMPTY_LIST.nextOffset).toBeNull()
  })
})
