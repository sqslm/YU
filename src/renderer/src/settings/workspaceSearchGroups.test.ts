import { describe, expect, it } from 'vitest'
import type { LocalRecord } from '@shared/workspace'
import { groupRecords } from './workspaceSearchGroups'

const record = (kind: LocalRecord['kind'], id: string): LocalRecord => ({ kind, id, title: id, text: '', at: 0 })

describe('groupRecords', () => {
  it('groups by kind in the fixed order, not in hit order', () => {
    const groups = groupRecords([record('history', 'h1'), record('note', 'n1'), record('chat', 'c1'), record('event', 'e1')])
    expect(groups.map(group => group.kind)).toEqual(['chat', 'note', 'event', 'history'])
    expect(groups.map(group => group.rows.map(row => row.id))).toEqual([['c1'], ['n1'], ['e1'], ['h1']])
  })

  it('keeps the relevance order inside a group', () => {
    const groups = groupRecords([record('chat', 'c1'), record('note', 'n1'), record('chat', 'c2'), record('chat', 'c3')])
    expect(groups.find(group => group.kind === 'chat')?.rows.map(row => row.id)).toEqual(['c1', 'c2', 'c3'])
  })

  it('drops kinds without hits and copes with no hits at all', () => {
    expect(groupRecords([record('reminder', 'r1')]).map(group => group.kind)).toEqual(['reminder'])
    expect(groupRecords([])).toEqual([])
  })

  it('does not lose a record when two kinds share an id', () => {
    expect(groupRecords([record('note', 'x'), record('history', 'x')])).toHaveLength(2)
  })
})
