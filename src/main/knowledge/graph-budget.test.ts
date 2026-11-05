/**
 * The renderer draws exactly what the helper budgeted.
 *
 * This drives the real release helper to the review's scene — a full 200-node
 * topic page, then a focus query that keeps the focus and its one out-of-topic
 * neighbour — and feeds both answers through the production renderer functions.
 * The canvas must stay at the node budget, because the older answer is never
 * merged back in.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { acceptGraph, createGate, graphView } from '../../renderer/src/settings/pages/knowledgeView'
import { KnowledgeHost } from './host'

const entry = join(process.cwd(), 'native', 'bin', 'yu-knowledge.exe')
const LIMIT = 200

describe('the graph budget the helper applies', () => {
  let root = ''
  let host: KnowledgeHost

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'yu-knowledge-budget-'))
    host = new KnowledgeHost({ entry, root, requestMs: 20_000 })
  })

  afterEach(async () => {
    await host.stop()
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps the canvas at the node budget when a focus answer expands to a neighbour', async () => {
    const body = '正文正文正文正文正文'
    const ids: string[] = []
    for (let index = 0; index < LIMIT; index++) {
      const card = await host.saveCard({ kind: 'concept', title: `节点 ${index}`, body, topics: ['Rust'] })
      ids.push(card.id)
    }
    // One card outside the topic, reachable only through the focus.
    const neighbour = await host.saveCard({ kind: 'concept', title: '主题外邻居', body, topics: ['Other'] })
    const focus = ids[0]
    await host.addRelation({ fromId: focus, toId: neighbour.id, kind: 'contains' })

    const topicAnswer = await host.queryGraph({ topic: 'Rust' })
    expect(topicAnswer.nodes).toHaveLength(LIMIT)
    const gate = createGate()
    const drawn = graphView(acceptGraph(gate, gate.next(), topicAnswer, null))
    expect(drawn.nodes).toHaveLength(LIMIT)

    const focusAnswer = await host.queryGraph({ focusId: focus, depth: 1 })
    expect(focusAnswer.nodes.length).toBeLessThanOrEqual(LIMIT)
    expect(focusAnswer.expanded).toBeGreaterThanOrEqual(1)
    expect(focusAnswer.nodes.some(row => row.id === focus)).toBe(true)
    expect(focusAnswer.nodes.some(row => row.id === neighbour.id)).toBe(true)

    const expanded = graphView(acceptGraph(gate, gate.next(), focusAnswer, topicAnswer))
    expect(expanded.nodes.length).toBeLessThanOrEqual(LIMIT)
    expect(expanded.nodes.some(row => row.id === focus)).toBe(true)
    expect(expanded.nodes.some(row => row.id === neighbour.id)).toBe(true)
    const visible = new Set(expanded.nodes.map(row => row.id))
    for (const link of expanded.links) {
      expect(visible.has(link.source)).toBe(true)
      expect(visible.has(link.target)).toBe(true)
    }
    // The canvas stays at the budget while matching and expanded are counted apart.
    expect(expanded.counts).toEqual({
      matched: focusAnswer.shown - focusAnswer.expanded,
      total: focusAnswer.total,
      expanded: focusAnswer.expanded
    })
  }, 180_000)
})
