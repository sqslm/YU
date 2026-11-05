import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode, KnowledgeCard, KnowledgeCardPage, KnowledgeGraph, KnowledgeModelInfo, ProfileItem, RelationList } from '@shared/knowledge'
import {
  CARD_PAGE_SIZE,
  EMPTY_FILTERS,
  EMPTY_LIST,
  SPLIT_MIN_WIDTH,
  acceptGraph,
  cardRequest,
  createGate,
  emptyState,
  extractStatus,
  filtersActive,
  graphCounts,
  graphNotice,
  graphView,
  groupProfile,
  groupRelations,
  kindKey,
  mergePage,
  mergePreview,
  mergeQuery,
  modelView,
  paneMode,
  paneModeFor,
  relationKey,
  selectedSummary,
  splitFit,
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
        { id: 'r1', fromId: 'x', toId: 'y', kind: 'contains', origin: 'manual', evidence: '', sourceId: null, segment: null, createdAt: 1, card: { id: 'y', title: 'Y', kind: 'concept' }, direction: 'out' },
        { id: 'r2', fromId: 'z', toId: 'x', kind: 'derives', origin: 'model', evidence: 'q', sourceId: 's1', segment: 0, createdAt: 2, card: { id: 'z', title: 'Z', kind: 'method' }, direction: 'in' },
        { id: 'r3', fromId: 'x', toId: 'w', kind: 'contrast', origin: 'manual', evidence: '', sourceId: null, segment: null, createdAt: 3, card: { id: 'w', title: 'W', kind: 'decision' }, direction: 'out' }
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
    limitedBy: 'nodes',
    focused: false,
    expanded: 0
  }

  it('maps nodes and drops an edge whose endpoint was trimmed away', () => {
    const data = toForceData(graph)
    expect(data.nodes.map((node) => node.id)).toEqual(['a', 'b'])
    expect(data.links).toEqual([{ id: 'e1', source: 'a', target: 'b', kind: 'contains', origin: 'manual' }])
  })

  it('says which budget limited the graph', () => {
    expect(graphNotice(graph)).toEqual({ limitedBy: 'nodes', matched: 2, total: 8 })
    expect(graphNotice({ ...graph, limitedBy: 'bytes' })?.limitedBy).toBe('bytes')
    expect(graphNotice({ ...graph, truncated: false, limitedBy: null })).toBeNull()
  })
})

describe('graph budget', () => {
  /** The helper's node budget, and the size of the answer it returns. */
  const LIMIT = 200
  const node = (id: string): GraphNode => ({ id, title: id, kind: 'concept', topics: ['Rust'], favorite: false })

  /** One chain so every node after the first has an edge into the answer. */
  function chain(rows: readonly GraphNode[]): GraphEdge[] {
    return rows.slice(1).map((row, index) => ({ id: `edge-${index}`, fromId: rows[index].id, toId: row.id, kind: 'contains' as const, origin: 'manual' as const }))
  }

  function answer(nodes: GraphNode[], patch: Partial<KnowledgeGraph> = {}): KnowledgeGraph {
    return { nodes, edges: chain(nodes), total: nodes.length, shown: nodes.length, truncated: false, limitedBy: null, focused: false, expanded: 0, ...patch }
  }

  const topicNodes = (count: number): GraphNode[] => Array.from({ length: count }, (_, index) => node(`topic-${index}`))

  /**
   * The repro: a topic query fills the budget with 200 matching nodes, then a
   * focus query keeps the focus plus its one out-of-topic neighbour. Rust evicts
   * one matching node to stay inside the budget, so the answer is still 200.
   */
  function expanded(rows: GraphNode[]): KnowledgeGraph {
    const kept = [...rows.slice(0, LIMIT - 2), node('focus'), node('neighbour')]
    return answer(kept, { total: LIMIT, shown: LIMIT, focused: true, expanded: 1 })
  }

  it('draws the expanded answer at its own size, not on top of the previous one', () => {
    // The page's own path: `setData(current => acceptGraph(...))`. The second
    // answer is drawn alone, so what the helper evicted stays evicted.
    const gate = createGate()
    const topic = answer(topicNodes(LIMIT))
    const first = graphView(acceptGraph(gate, gate.next(), topic, null))
    expect(first.nodes).toHaveLength(LIMIT)
    const next = graphView(acceptGraph(gate, gate.next(), expanded(topicNodes(LIMIT)), topic))
    expect(next.nodes).toHaveLength(LIMIT)
    expect(next.counts).toEqual({ matched: LIMIT - 1, total: LIMIT, expanded: 1 })
    expect(next.nodes.some((row) => row.id === 'focus')).toBe(true)
    expect(next.nodes.some((row) => row.id === 'neighbour')).toBe(true)
    // The helper evicted this one; the page must not put it back.
    expect(next.nodes.some((row) => row.id === `topic-${LIMIT - 1}`)).toBe(false)
  })

  it('keeps no duplicate node and no edge with a hidden endpoint', () => {
    const view = graphView(expanded(topicNodes(LIMIT)))
    const ids = view.nodes.map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
    const visible = new Set(ids)
    expect(view.links).toHaveLength(LIMIT - 1)
    for (const link of view.links) {
      expect(visible.has(link.source)).toBe(true)
      expect(visible.has(link.target)).toBe(true)
    }
  })

  it('reports matched, filter total and expanded from the one answer', () => {
    const view = graphView(expanded(topicNodes(LIMIT)))
    // Everything but the neighbour matched, and the info line compares that
    // against the filter total, never against the canvas size.
    expect(view.counts).toEqual({ matched: LIMIT - 1, total: LIMIT, expanded: 1 })
    expect(view.counts.matched + view.counts.expanded).toBe(view.nodes.length)
    expect(graphCounts(answer(topicNodes(2), { total: 8, shown: 2 }))).toEqual({ matched: 2, total: 8, expanded: 0 })
    expect(graphCounts(null)).toEqual({ matched: 0, total: 0, expanded: 0 })
    expect(graphView(null).nodes).toHaveLength(0)
  })

  // The external probe's real answer: one node matched the filter, the focus
  // pulled in one neighbour from outside it, so the canvas drew two nodes.
  it('never reports the expanded neighbour as a second match', () => {
    const probe = answer([node('match'), node('neighbour')], { total: 1, shown: 2, focused: true, expanded: 1 })
    const view = graphView(probe)
    expect(view.counts).toEqual({ matched: 1, total: 1, expanded: 1 })
    expect(view.counts.matched).toBeLessThanOrEqual(view.counts.total)
    expect(view.nodes).toHaveLength(2)
    expect(view.nodes).toHaveLength(probe.nodes.length)
  })

  it('puts the budget notice on the filtered total, not the canvas size', () => {
    const probe = answer([node('match'), node('neighbour')], { total: 1, shown: 2, focused: true, expanded: 1, truncated: true, limitedBy: 'nodes' })
    expect(graphNotice(probe)).toEqual({ limitedBy: 'nodes', matched: 1, total: 1 })
  })

  it('keeps reporting a full budget of matches when nothing was expanded', () => {
    const view = graphView(answer(topicNodes(LIMIT)))
    expect(view.counts).toEqual({ matched: LIMIT, total: LIMIT, expanded: 0 })
    expect(view.nodes).toHaveLength(LIMIT)
  })

  it('ignores a late answer for a query the user already left', () => {
    const gate = createGate()
    const older = gate.next()
    const newer = gate.next()
    const current = answer(topicNodes(LIMIT))
    const accepted = acceptGraph(gate, newer, current, null)
    expect(accepted).toBe(current)
    expect(acceptGraph(gate, older, expanded(topicNodes(LIMIT)), accepted)).toBe(current)
  })

  it('does not grow the set when the same expansion arrives twice', () => {
    const gate = createGate()
    const once = acceptGraph(gate, gate.next(), expanded(topicNodes(LIMIT)), null)
    const twice = acceptGraph(gate, gate.next(), expanded(topicNodes(LIMIT)), once)
    const view = graphView(twice)
    expect(view.nodes).toHaveLength(LIMIT)
    expect(view.links).toHaveLength(LIMIT - 1)
    expect(view.counts).toEqual({ matched: LIMIT - 1, total: LIMIT, expanded: 1 })
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

describe('split from the measured width', () => {
  it('needs the list pane plus a readable card pane', () => {
    expect(splitFit(SPLIT_MIN_WIDTH - 1)).toBe(false)
    expect(splitFit(SPLIT_MIN_WIDTH)).toBe(true)
    // A 1080px window minus the rail and margins still leaves room for both panes.
    expect(splitFit(1080 - 260)).toBe(true)
    // A 900px window does not, which is why the window breakpoint was the wrong input.
    expect(splitFit(900 - 260)).toBe(false)
  })

  it('swaps master and detail instead of squeezing both', () => {
    expect(paneModeFor(560, false)).toBe('list')
    expect(paneModeFor(560, true)).toBe('detail')
    expect(paneModeFor(900, true)).toBe('split')
    expect(paneModeFor(0, false)).toBe('list')
  })
})

describe('manual extraction status', () => {
  it('reports a real queue', () => {
    expect(extractStatus({ queued: 2, reason: 'queued' })).toEqual({ queued: true, count: 2, reason: 'queued' })
  })

  it('keeps the helper reason when nothing was queued', () => {
    expect(extractStatus({ queued: 0, reason: ' capacity full ' })).toEqual({ queued: false, count: 0, reason: 'capacity full' })
    expect(extractStatus({ queued: 0, reason: 'needs_reread' }).queued).toBe(false)
  })

  it('never reports a negative count', () => {
    expect(extractStatus({ queued: -3, reason: '' }).count).toBe(0)
  })
})

describe('model selection view', () => {
  const info = (patch: Partial<KnowledgeModelInfo> = {}): KnowledgeModelInfo => ({
    profiles: [
      { id: 'p1', label: 'A', enabled: true },
      { id: 'p2', label: 'B', enabled: false },
      { id: 'p3', label: 'C', enabled: true }
    ],
    selectedId: '',
    effectiveId: 'p1',
    effectiveLabel: 'A',
    fallback: false,
    ...patch
  })

  it('offers only enabled profiles', () => {
    expect(modelView(info()).options).toEqual([{ id: 'p1', label: 'A' }, { id: 'p3', label: 'C' }])
    expect(modelView(info()).fallback).toBe(false)
  })

  it('names a stored choice that is no longer enabled', () => {
    const view = modelView(info({ selectedId: 'p2', effectiveId: 'p1', effectiveLabel: 'A', fallback: true }))
    expect(view.staleId).toBe('p2')
    expect(view.fallback).toBe(true)
    expect(view.effectiveLabel).toBe('A')
    expect(view.options.some((option) => option.id === 'p2')).toBe(false)
  })

  it('treats a stored profile that vanished as stale even when the helper says otherwise', () => {
    const view = modelView(info({ selectedId: 'gone', fallback: false }))
    expect(view.staleId).toBe('gone')
    expect(view.fallback).toBe(true)
  })

  it('ignores an empty selection', () => {
    const view = modelView(info({ profiles: [] }))
    expect(view.options).toEqual([])
    expect(view.staleId).toBeNull()
  })
})
