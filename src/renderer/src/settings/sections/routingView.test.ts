import { describe, expect, it } from 'vitest'
import type { AppRule } from '@shared/types'
import {
  RULE_GROUP_ORDER,
  countOf,
  groupDefaultOpen,
  groupRules,
  isPromptKind,
  rulesOfKind,
  withKind
} from './routingView'

function rule(id: string, kind: AppRule['kind'], extra: Partial<AppRule> = {}): AppRule {
  return { id, match: id, kind, ...extra }
}

describe('groupRules', () => {
  it('lists all five blocks in page order even when there are no rules', () => {
    const groups = groupRules([])
    expect(groups.map((group) => group.kind)).toEqual([
      'ai',
      'polish',
      'translate',
      'document',
      'email'
    ])
    expect(groups.map((group) => group.kind)).toEqual([...RULE_GROUP_ORDER])
    // Empty groups stay listed rather than being filtered out.
    expect(groups).toHaveLength(5)
    expect(groups.every((group) => group.rules.length === 0)).toBe(true)
  })

  it('filters every rule into the block of its own kind', () => {
    const rules = [
      rule('a', 'ai'),
      rule('p1', 'polish'),
      rule('d', 'document'),
      rule('p2', 'polish'),
      rule('e', 'email'),
      rule('t', 'translate')
    ]
    const byKind = Object.fromEntries(
      groupRules(rules).map((group) => [group.kind, group.rules.map((item) => item.id)])
    )
    expect(byKind).toEqual({
      ai: ['a'],
      polish: ['p1', 'p2'],
      translate: ['t'],
      document: ['d'],
      email: ['e']
    })
  })

  it('keeps the stored order inside a block, not the grouped order', () => {
    // Deliberately interleaved: a naive sort by kind would print these in a
    // different order than the user saved them in.
    const rules = [
      rule('z', 'polish'),
      rule('a', 'ai'),
      rule('y', 'polish'),
      rule('b', 'ai')
    ]
    const groups = groupRules(rules)
    expect(groups.find((group) => group.kind === 'polish')?.rules.map((item) => item.id)).toEqual([
      'z',
      'y'
    ])
    expect(groups.find((group) => group.kind === 'ai')?.rules.map((item) => item.id)).toEqual([
      'a',
      'b'
    ])
  })

  it('drops a rule whose kind is unknown instead of bucketing it', () => {
    // Simulates hand-edited settings from a version that had another kind.
    const junk = { id: 'old', match: 'x', kind: 'calendar' } as unknown as AppRule
    const rules = [junk, rule('ok', 'email')]
    const groups = groupRules(rules)
    expect(groups.flatMap((group) => group.rules.map((item) => item.id))).toEqual(['ok'])
    expect(groups.find((group) => group.kind === 'email')?.rules).toHaveLength(1)
  })

  it('renders an empty layout for a non-array value', () => {
    // Settings can be malformed; the page must not throw while rendering.
    const groups = groupRules(undefined as unknown as AppRule[])
    expect(groups).toHaveLength(5)
    expect(groups.every((group) => group.rules.length === 0)).toBe(true)
  })

  it('never mutates the caller list or its rule objects', () => {
    const rules = [rule('a', 'ai'), rule('b', 'polish')]
    const snapshot = [...rules]
    groupRules(rules)
    expect(rules).toEqual(snapshot)
    expect(rules[0]).toBe(snapshot[0])
  })
})

describe('rulesOfKind / countOf', () => {
  it('returns only the requested kind, in stored order', () => {
    const rules = [rule('p1', 'polish'), rule('a', 'ai'), rule('p2', 'polish')]
    expect(rulesOfKind(rules, 'polish').map((item) => item.id)).toEqual(['p1', 'p2'])
    expect(rulesOfKind(rules, 'translate')).toEqual([])
  })

  it('returns no rules for an unknown kind', () => {
    const rules = [rule('p1', 'polish')]
    expect(rulesOfKind(rules, 'calendar' as never)).toEqual([])
    expect(countOf(rules, 'calendar' as never)).toBe(0)
  })

  it('counts per kind and sums to the total', () => {
    const rules = [
      rule('a1', 'ai'),
      rule('a2', 'ai'),
      rule('p', 'polish'),
      rule('t', 'translate'),
      rule('d', 'document'),
      rule('e', 'email')
    ]
    expect(countOf(rules, 'ai')).toBe(2)
    expect(countOf(rules, 'translate')).toBe(1)
    expect(countOf(rules, 'email')).toBe(1)
    const total = RULE_GROUP_ORDER.reduce((sum, kind) => sum + countOf(rules, kind), 0)
    expect(total).toBe(rules.length)
  })

  it('counts a hand-added rule that has no label or domain', () => {
    const rules = [rule('bare', 'email', { label: undefined, domain: undefined })]
    expect(countOf(rules, 'email')).toBe(1)
  })
})

describe('withKind', () => {
  it('stamps the kind while keeping the other fields intact', () => {
    const draft = { id: 'rule-1', match: '', domain: 'github.com', label: '备注' }
    const stamped = withKind(draft, 'document')
    expect(stamped).toEqual({
      id: 'rule-1',
      match: '',
      domain: 'github.com',
      label: '备注',
      kind: 'document'
    })
  })

  it('does not mutate the draft it was given', () => {
    const draft = { id: 'rule-2', match: 'dsh' }
    withKind(draft, 'ai')
    expect(draft).toEqual({ id: 'rule-2', match: 'dsh' })
    expect('kind' in draft).toBe(false)
  })

  it('re-stamps an existing rule without touching its id', () => {
    const original = rule('keep-me', 'polish', { label: '微信' })
    const moved = withKind(original, 'ai')
    expect(moved.kind).toBe('ai')
    expect(moved.id).toBe('keep-me')
    expect(moved.label).toBe('微信')
    expect(original.kind).toBe('polish')
  })
})

describe('groupDefaultOpen', () => {
  it('opens a block that has rules and collapses an empty one', () => {
    expect(groupDefaultOpen({ kind: 'ai', rules: [rule('a', 'ai')] })).toBe(true)
    expect(groupDefaultOpen({ kind: 'ai', rules: [] })).toBe(false)
  })
})

describe('isPromptKind', () => {
  it('accepts the five kinds and rejects anything else', () => {
    for (const kind of RULE_GROUP_ORDER) expect(isPromptKind(kind)).toBe(true)
    expect(isPromptKind('calendar')).toBe(false)
    expect(isPromptKind('')).toBe(false)
    expect(isPromptKind(null)).toBe(false)
    expect(isPromptKind(3)).toBe(false)
  })
})
