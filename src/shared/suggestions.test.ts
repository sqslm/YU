import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  MAX_DICTIONARY_TERM,
  MAX_SUGGESTIONS,
  SUGGESTION_THRESHOLD,
  mergeSettings
} from './defaults'
import {
  acceptSuggestion,
  ignoreSuggestion,
  mergeSuggestion,
  pickSuggestions,
  pruneSuggestions,
  type SuggestionCandidate
} from './suggestions'
import type { Suggestion } from './types'

/**
 * The suggestion pool is the only thing standing between "the user fixed a
 * typo" and "the model now believes this typo is a term", so these cases pin
 * the four rejections, the counting rule, the two decisions and the cap.
 */

function candidate(from: string, at: number, over: Partial<SuggestionCandidate> = {}): SuggestionCandidate {
  return { from, to: '', mode: 'hint', at, ...over }
}

function row(from: string, over: Partial<Suggestion> = {}): Suggestion {
  return {
    from,
    to: '',
    mode: 'hint',
    count: 1,
    firstSeen: 0,
    lastSeen: 0,
    status: 'pending',
    ...over
  }
}

describe('mergeSuggestion', () => {
  it('turns one sighting into a pending row', () => {
    expect(mergeSuggestion([], candidate('复刻', 100))).toEqual([
      {
        from: '复刻',
        to: '',
        mode: 'hint',
        count: 1,
        firstSeen: 100,
        lastSeen: 100,
        status: 'pending'
      }
    ])
  })

  it('counts the same idea again instead of adding a second row', () => {
    let pool: Suggestion[] = []
    for (const at of [100, 200, 300]) pool = mergeSuggestion(pool, candidate('Kubernetes', at))
    expect(pool).toHaveLength(1)
    expect(pool[0]?.count).toBe(3)
    // The window is what the page explains to the user: first and last sighting.
    expect(pool[0]?.firstSeen).toBe(100)
    expect(pool[0]?.lastSeen).toBe(300)
  })

  it('matches case-insensitively and keeps the pair it was first asked about', () => {
    let pool = mergeSuggestion([], candidate('kubernetes', 10))
    pool = mergeSuggestion(pool, candidate('Kubernetes', 20, { to: 'K8s', mode: 'replace' }))
    expect(pool).toHaveLength(1)
    expect(pool[0]).toMatchObject({ from: 'kubernetes', to: '', mode: 'hint', count: 2 })
  })

  it('drops candidates that could never become a useful term', () => {
    const rejected: SuggestionCandidate[] = [
      candidate('', 1),
      candidate('   ', 1),
      // A pair that maps a word to itself teaches nothing.
      candidate('复刻', 1, { to: ' 复刻 ' }),
      candidate('Kubernetes', 1, { to: 'KUBERNETES' }),
      // Stopwords: one Chinese, one English, straight from the shared list.
      candidate('因为', 1),
      candidate('the', 1),
      candidate('x'.repeat(MAX_DICTIONARY_TERM + 1), 1)
    ]
    for (const item of rejected) expect(mergeSuggestion([], item)).toEqual([])
  })

  it('never mutates the pool it was given', () => {
    const pool = [row('飞书', { count: 2, lastSeen: 5 })]
    const snapshot = structuredClone(pool)
    const next = mergeSuggestion(pool, candidate('飞书', 9))
    expect(pool).toEqual(snapshot)
    expect(next).not.toBe(pool)
    expect(next[0]).toMatchObject({ count: 3, lastSeen: 9 })
  })

  it('keeps lastSeen monotonic when a sighting carries an older clock', () => {
    const pool = [row('飞书', { lastSeen: 500 })]
    expect(mergeSuggestion(pool, candidate('飞书', 400))[0]?.lastSeen).toBe(500)
  })

  it('stops counting once the user decided', () => {
    const accepted = [row('飞书', { status: 'accepted', count: 4 })]
    const ignored = [row('飞书', { status: 'ignored', count: 4 })]
    // Same array back: the caller can skip the settings write entirely.
    expect(mergeSuggestion(accepted, candidate('飞书', 99))).toBe(accepted)
    expect(mergeSuggestion(ignored, candidate('飞书', 99))).toBe(ignored)
  })

  it('evicts the least recently seen row at the cap', () => {
    let pool: Suggestion[] = []
    for (let i = 0; i < MAX_SUGGESTIONS; i += 1) {
      pool = mergeSuggestion(pool, candidate(`词${i}`, 1000 + i))
    }
    expect(pool).toHaveLength(MAX_SUGGESTIONS)
    const grown = mergeSuggestion(pool, candidate('新词', 5000))
    expect(grown).toHaveLength(MAX_SUGGESTIONS)
    expect(grown.map((entry) => entry.from)).not.toContain('词0')
    expect(grown.map((entry) => entry.from)).toContain('新词')
  })
})

describe('pickSuggestions', () => {
  it('hides ideas below the threshold and ranks the rest by how often they repeated', () => {
    const pool = [
      row('两次', { count: 2, lastSeen: 30 }),
      row('三次', { count: 3, lastSeen: 10 }),
      row('五次', { count: 5, lastSeen: 20 })
    ]
    expect(pickSuggestions(pool).map((entry) => entry.from)).toEqual(['五次', '三次'])
    expect(pickSuggestions(pool).map((entry) => entry.count)).toEqual([5, 3])
    expect(pickSuggestions(pool, 2).map((entry) => entry.from)).toEqual(['五次', '三次', '两次'])
  })

  it('defaults to SUGGESTION_THRESHOLD', () => {
    expect(SUGGESTION_THRESHOLD).toBe(3)
    expect(pickSuggestions([row('刚好', { count: SUGGESTION_THRESHOLD })])).toHaveLength(1)
    expect(pickSuggestions([row('差一次', { count: SUGGESTION_THRESHOLD - 1 })])).toEqual([])
  })

  it('leaves decided rows out', () => {
    const pool = [
      row('已采纳', { count: 9, status: 'accepted' }),
      row('已忽略', { count: 9, status: 'ignored' }),
      row('待定', { count: 3 })
    ]
    expect(pickSuggestions(pool).map((entry) => entry.from)).toEqual(['待定'])
  })
})

describe('acceptSuggestion / ignoreSuggestion', () => {
  it('marks one row accepted and leaves the others alone', () => {
    const pool = [
      row('飞书', { count: 3, firstSeen: 5, lastSeen: 7 }),
      row('Notion', { count: 3, lastSeen: 6 })
    ]
    const next = acceptSuggestion(pool, ' 飞书 ', 40)
    expect(next[0]).toMatchObject({
      from: '飞书',
      status: 'accepted',
      count: 3,
      firstSeen: 5,
      lastSeen: 40
    })
    expect(next[1]).toBe(pool[1])
    expect(pool[0]?.status).toBe('pending')
  })

  it('is a no-op for an unknown spelling', () => {
    const pool = [row('飞书', { count: 3 })]
    expect(acceptSuggestion(pool, '不存在', 1)).toBe(pool)
    expect(ignoreSuggestion(pool, '不存在', 1)).toBe(pool)
  })

  it('remembers an ignore so the idea is neither offered nor counted again', () => {
    let pool: Suggestion[] = [row('飞书', { count: 3 })]
    pool = ignoreSuggestion(pool, '飞书', 50)
    expect(pool[0]).toMatchObject({ status: 'ignored', lastSeen: 50 })
    expect(pickSuggestions(pool)).toEqual([])
    expect(mergeSuggestion(pool, candidate('飞书', 60))).toBe(pool)
  })
})

describe('pruneSuggestions', () => {
  it('evicts the earliest lastSeen and keeps the input untouched', () => {
    const pool = [
      row('a', { lastSeen: 30 }),
      row('b', { lastSeen: 10 }),
      row('c', { lastSeen: 20 })
    ]
    const pruned = pruneSuggestions(pool, 2)
    expect(pruned.map((entry) => entry.from)).toEqual(['a', 'c'])
    expect(pool).toHaveLength(3)
    // Under the limit there is nothing to do, so callers get the same array.
    expect(pruneSuggestions(pool, 5)).toBe(pool)
  })

  it('breaks lastSeen ties deterministically', () => {
    const tied = [row('b', { lastSeen: 1 }), row('a', { lastSeen: 1 })]
    expect(pruneSuggestions(tied, 1).map((entry) => entry.from)).toEqual(['b'])
  })
})

describe('normalizeSuggestions (via mergeSettings)', () => {
  it('ships an empty pool and the documented caps', () => {
    expect(DEFAULT_SETTINGS.suggestions).toEqual([])
    expect(MAX_SUGGESTIONS).toBe(200)
  })

  it('tolerates a settings file written before suggestions existed', () => {
    const merged = mergeSettings({ language: 'en' })
    expect(merged.suggestions).toEqual([])
    expect(merged.language).toBe('en')
  })

  it('keeps a well-formed pool intact, so a save round-trip loses nothing', () => {
    const pool = [
      row('飞书', { count: 4, firstSeen: 10, lastSeen: 20 }),
      row('Notion', { to: 'Notion', mode: 'replace', count: 3, status: 'ignored' })
    ]
    expect(mergeSettings({ suggestions: pool }).suggestions).toEqual(pool)
  })

  it('drops malformed rows and repairs the rest', () => {
    const merged = mergeSettings({
      suggestions: [
        null,
        'nope',
        { from: '', status: 'pending' },
        { from: '坏状态', status: 'maybe' },
        { from: '好词', to: 'Good', mode: 'replace', count: 2, firstSeen: 1, lastSeen: 2 }
      ] as unknown as Suggestion[]
    })
    expect(merged.suggestions.map((entry) => entry.from)).toEqual(['好词'])
    expect(merged.suggestions[0]).toMatchObject({
      to: 'Good',
      mode: 'replace',
      count: 2,
      status: 'pending'
    })
  })

  it('falls back to one sighting when count or timestamps are missing', () => {
    const [only] = mergeSettings({
      suggestions: [{ from: '飞书' }] as unknown as Suggestion[]
    }).suggestions
    expect(only).toMatchObject({ count: 1, firstSeen: 0, lastSeen: 0, mode: 'hint' })
  })

  it('clamps field length and caps the pool', () => {
    const long = 'x'.repeat(MAX_DICTIONARY_TERM + 20)
    const clamped = mergeSettings({
      suggestions: [{ from: long, status: 'pending' }] as unknown as Suggestion[]
    }).suggestions
    expect(clamped[0]?.from).toHaveLength(MAX_DICTIONARY_TERM)

    const many = Array.from({ length: MAX_SUGGESTIONS + 5 }, (_, index) => row(`w${index}`))
    expect(mergeSettings({ suggestions: many }).suggestions).toHaveLength(MAX_SUGGESTIONS)
  })
})
