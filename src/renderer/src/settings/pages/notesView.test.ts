import { describe, expect, it } from 'vitest'
import type { NoteCategory, NoteEntry } from '@shared/types'
import {
  ALL_CATEGORIES,
  MAX_TAGS,
  addTag,
  categoryNameOf,
  clampPlaybackRate,
  collectTags,
  emptyStateCopy,
  emptyStateKind,
  filterNotes,
  formatClock,
  formatDuration,
  formatStamp,
  matchesQuery,
  nextSaveState,
  normalizeTag,
  removeTag,
  saveStateKey,
  summarize,
  toggleTag
} from './notesView'

function entry(patch: Partial<NoteEntry> = {}): NoteEntry {
  return {
    id: 'n1',
    createdAt: 1_700_000_000_000,
    durationMs: 4_200,
    polished: '',
    polishStatus: 'ok',
    tags: [],
    transcript: '',
    updatedAt: 1_700_000_000_000,
    ...patch
  }
}

const CATEGORIES: NoteCategory[] = [
  { id: 'c1', name: '会议' },
  { id: 'c2', name: '灵感' }
]

it('filters note types before ordering without losing recordings missing their local file', () => {
  const text = entry({ id: 'text', durationMs: 0, updatedAt: 300 })
  const audio = entry({ id: 'audio', audioPath: 'notes/audio/a.ogg', updatedAt: 200 })
  const remoteAudio = entry({ id: 'remote', updatedAt: 400, polishStatus: 'failed' })
  const rows = [text, audio, remoteAudio]
  expect(filterNotes(rows, { kind: 'text' }).map(n => n.id)).toEqual(['text'])
  expect(filterNotes(rows, { kind: 'audio', sort: 'updated' }).map(n => n.id)).toEqual(['remote', 'audio'])
  expect(filterNotes(rows, { kind: 'failed' }).map(n => n.id)).toEqual(['remote'])
  expect(filterNotes(rows, { sort: 'updated' }).map(n => n.id)).toEqual(['remote', 'text', 'audio'])
  expect(rows.map(n => n.id)).toEqual(['text', 'audio', 'remote'])
})

describe('summarize', () => {
  it('prefers the polished text over the raw transcript', () => {
    const note = entry({ polished: '今天下午三点开会。', transcript: '嗯 今天 下午 三点 开会' })
    expect(summarize(note)).toBe('今天下午三点开会。')
  })

  it('falls back to the transcript when the polish is empty', () => {
    const note = entry({ polished: '   ', transcript: '原始转写的内容' })
    expect(summarize(note)).toBe('原始转写的内容')
  })

  it('collapses newlines and repeated spaces into one line', () => {
    const note = entry({ transcript: '第一行\n\n第二行   还是第二行' })
    expect(summarize(note)).toBe('第一行 第二行 还是第二行')
  })

  it('truncates to the budget with an ellipsis and never exceeds it', () => {
    const note = entry({ polished: '0123456789abcdefghij' })
    const out = summarize(note, 10)
    expect(out).toBe('012345678…')
    expect(out).toHaveLength(10)
  })

  it('counts CJK characters the same way it counts latin ones', () => {
    const note = entry({ polished: '一二三四五六七八九十' })
    expect(summarize(note, 6)).toBe('一二三四五…')
  })

  it('returns an empty string for a note with no text at all', () => {
    expect(summarize(entry())).toBe('')
  })

  it('returns the text untouched when it already fits', () => {
    expect(summarize(entry({ polished: '短文' }), 40)).toBe('短文')
  })

  it('returns an empty string for a zero or negative budget', () => {
    const note = entry({ polished: '内容' })
    expect(summarize(note, 0)).toBe('')
    expect(summarize(note, -3)).toBe('')
  })

  it('keeps the ellipsis as the whole result for a one character budget', () => {
    expect(summarize(entry({ polished: '内容' }), 1)).toBe('…')
  })
})

describe('matchesQuery', () => {
  it('matches everything when the query is empty or whitespace', () => {
    const note = entry({ transcript: '内容' })
    expect(matchesQuery(note, '')).toBe(true)
    expect(matchesQuery(note, '   ')).toBe(true)
  })

  it('matches the transcript case-insensitively', () => {
    const note = entry({ transcript: 'Deploy the Build' })
    expect(matchesQuery(note, 'build')).toBe(true)
    expect(matchesQuery(note, 'BUILD')).toBe(true)
  })

  it('matches the polished text even when the transcript does not', () => {
    const note = entry({ polished: '润色后的句子', transcript: 'luan ma' })
    expect(matchesQuery(note, '润色')).toBe(true)
  })

  it('matches tags and the category name', () => {
    const note = entry({ tags: ['工作', 'Weekly'] })
    expect(matchesQuery(note, 'weekly')).toBe(true)
    expect(matchesQuery(note, '会议', '会议')).toBe(true)
    expect(matchesQuery(note, '会议')).toBe(false)
  })

  it('rejects a query that no field contains', () => {
    expect(matchesQuery(entry({ transcript: 'abc', tags: ['x'] }), 'zzz')).toBe(false)
  })
})

describe('filterNotes', () => {
  const notes: NoteEntry[] = [
    entry({ id: 'a', createdAt: 300, categoryId: 'c1', tags: ['工作', '周报'], transcript: '周一站会' }),
    entry({ id: 'b', createdAt: 100, categoryId: 'c2', tags: ['工作'], transcript: '一个灵感' }),
    entry({ id: 'c', createdAt: 200, tags: ['私人'], transcript: '买菜清单' })
  ]

  it('returns every note for the all-categories sentinel', () => {
    expect(filterNotes(notes, { categoryId: ALL_CATEGORIES }).map((n) => n.id)).toEqual(['a', 'c', 'b'])
  })

  it('keeps only the requested category', () => {
    expect(filterNotes(notes, { categoryId: 'c1' }).map((n) => n.id)).toEqual(['a'])
    expect(filterNotes(notes, { categoryId: 'c2' }).map((n) => n.id)).toEqual(['b'])
  })

  it('treats an uncategorised note as having no category', () => {
    const loose = [entry({ id: 'x', createdAt: 9 }), entry({ id: 'y', createdAt: 8, categoryId: 'c1' })]
    expect(filterNotes(loose, { categoryId: 'c1' }).map((n) => n.id)).toEqual(['y'])
    expect(filterNotes(loose, { categoryId: 'c9' })).toEqual([])
  })

  it('requires every selected tag to be present', () => {
    expect(filterNotes(notes, { tags: ['工作'] }).map((n) => n.id)).toEqual(['a', 'b'])
    expect(filterNotes(notes, { tags: ['工作', '周报'] }).map((n) => n.id)).toEqual(['a'])
    expect(filterNotes(notes, { tags: ['工作', '私人'] })).toEqual([])
  })

  it('combines query, category and tags', () => {
    expect(filterNotes(notes, { query: '站会', categoryId: 'c1', tags: ['周报'] }).map((n) => n.id)).toEqual([
      'a'
    ])
    expect(filterNotes(notes, { query: '站会', categoryId: 'c2' })).toEqual([])
  })

  it('searches the category name of the note being filtered', () => {
    expect(filterNotes(notes, { query: '灵感' }, CATEGORIES).map((n) => n.id)).toEqual(['b'])
    expect(filterNotes(notes, { query: '灵感', categoryId: 'c2' }, CATEGORIES).map((n) => n.id)).toEqual([
      'b'
    ])
  })

  it('sorts newest first by default and oldest first on request', () => {
    expect(filterNotes(notes).map((n) => n.id)).toEqual(['a', 'c', 'b'])
    expect(filterNotes(notes, { sort: 'oldest' }).map((n) => n.id)).toEqual(['b', 'c', 'a'])
  })

  it('keeps the incoming order for notes with the same timestamp', () => {
    const tied = [entry({ id: 'first', createdAt: 500 }), entry({ id: 'second', createdAt: 500 })]
    expect(filterNotes(tied).map((n) => n.id)).toEqual(['first', 'second'])
    expect(filterNotes(tied, { sort: 'oldest' }).map((n) => n.id)).toEqual(['first', 'second'])
  })

  it('treats a missing or non-finite timestamp as the oldest', () => {
    const odd = [entry({ id: 'ok', createdAt: 10 }), entry({ id: 'bad', createdAt: Number.NaN })]
    expect(filterNotes(odd).map((n) => n.id)).toEqual(['ok', 'bad'])
  })

  it('does not mutate or reorder the caller array', () => {
    const source = [entry({ id: 'p', createdAt: 1 }), entry({ id: 'q', createdAt: 2 })]
    filterNotes(source, { sort: 'oldest' })
    expect(source.map((n) => n.id)).toEqual(['p', 'q'])
  })

  it('returns an empty list when nothing matches', () => {
    expect(filterNotes(notes, { query: '根本没有' })).toEqual([])
  })
})

describe('collectTags', () => {
  const notes: NoteEntry[] = [
    entry({ id: 'a', tags: ['工作', '周报'] }),
    entry({ id: 'b', tags: ['工作', '灵感'] }),
    entry({ id: 'c', tags: ['灵感', '灵感', '   '] }),
    entry({ id: 'd', tags: ['alpha', 'beta'] }),
    entry({ id: 'e', tags: [] })
  ]

  it('counts usage across notes, most used first', () => {
    const rows = collectTags(notes)
    expect(rows[0]).toEqual({ tag: '工作', count: 2 })
    expect(rows[1]).toEqual({ tag: '灵感', count: 2 })
  })

  it('counts a repeated tag in one note only once', () => {
    const rows = collectTags(notes)
    expect(rows.find((row) => row.tag === '灵感')?.count).toBe(2)
  })

  it('breaks ties by a stable locale compare', () => {
    const rows = collectTags(notes)
    expect(rows.slice(2).map((row) => row.tag)).toEqual(['周报', 'alpha', 'beta'])
  })

  it('drops blank tags and honours the limit', () => {
    expect(collectTags(notes).some((row) => row.tag === '')).toBe(false)
    expect(collectTags(notes, 2)).toHaveLength(2)
  })

  it('returns an empty list for an empty library', () => {
    expect(collectTags([])).toEqual([])
  })

  it('does not slice when the limit is zero', () => {
    expect(collectTags(notes, 0)).toHaveLength(5)
  })
})

describe('formatDuration', () => {
  it('prints whole seconds', () => {
    expect(formatDuration(4_200)).toBe('4s')
    expect(formatDuration(900)).toBe('1s')
    expect(formatDuration(0)).toBe('0s')
  })

  it('falls back to zero for negative or non-finite input', () => {
    expect(formatDuration(-500)).toBe('0s')
    expect(formatDuration(Number.NaN)).toBe('0s')
  })
})

describe('formatClock', () => {
  it('prints m:ss for the player and the recording timer', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(7_000)).toBe('0:07')
    expect(formatClock(65_000)).toBe('1:05')
    expect(formatClock(3_600_000)).toBe('60:00')
  })

  it('clamps negative and non-finite input to zero', () => {
    expect(formatClock(-1)).toBe('0:00')
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('0:00')
  })
})

describe('formatStamp', () => {
  it('splits a local timestamp into HH:mm and MM-DD', () => {
    const ts = new Date(2024, 2, 9, 8, 5).getTime()
    expect(formatStamp(ts)).toEqual({ time: '08:05', day: '03-09', full: '2024-03-09 08:05' })
  })

  it('pads a midnight timestamp', () => {
    const ts = new Date(2024, 11, 31, 0, 0).getTime()
    expect(formatStamp(ts).time).toBe('00:00')
    expect(formatStamp(ts).day).toBe('12-31')
  })

  it('uses placeholders for a missing timestamp', () => {
    expect(formatStamp(0)).toEqual({ time: '--:--', day: '--', full: '' })
    expect(formatStamp(Number.NaN).time).toBe('--:--')
  })
})

describe('nextSaveState', () => {
  it('walks pending → saving → saved', () => {
    let state = nextSaveState('idle', 'edited')
    expect(state).toBe('pending')
    state = nextSaveState(state, 'flushStarted')
    expect(state).toBe('saving')
    state = nextSaveState(state, 'flushSucceeded')
    expect(state).toBe('saved')
  })

  it('ignores a success that lands while newer edits are pending', () => {
    expect(nextSaveState('pending', 'flushSucceeded')).toBe('pending')
    expect(nextSaveState('idle', 'flushSucceeded')).toBe('idle')
  })

  it('shows the failure and recovers on the next edit', () => {
    expect(nextSaveState('saving', 'flushFailed')).toBe('error')
    expect(nextSaveState('error', 'edited')).toBe('pending')
  })

  it('resets when the selection moves', () => {
    expect(nextSaveState('saved', 'reset')).toBe('idle')
    expect(nextSaveState('error', 'reset')).toBe('idle')
  })

  it('maps states to translation keys and hides the idle line', () => {
    expect(saveStateKey('pending')).toBe('notes.saveSaving')
    expect(saveStateKey('saving')).toBe('notes.saveSaving')
    expect(saveStateKey('saved')).toBe('notes.saveSaved')
    expect(saveStateKey('error')).toBe('notes.saveFailed')
    expect(saveStateKey('idle')).toBeNull()
  })
})

describe('emptyStateKind', () => {
  it('hides the pane when something is visible', () => {
    expect(emptyStateKind({ total: 5, visible: 2 })).toBe('none')
  })

  it('blames the library when there are no notes at all', () => {
    expect(emptyStateKind({ total: 0, visible: 0 })).toBe('records')
  })

  it('blames the filters when notes exist but none matched', () => {
    expect(emptyStateKind({ total: 5, visible: 0 })).toBe('filters')
  })

  it('gives each case its own copy', () => {
    expect(emptyStateCopy('records').titleKey).not.toBe(emptyStateCopy('filters').titleKey)
    expect(emptyStateCopy('none').titleKey).toBe('notes.emptyRecords')
  })
})

describe('categoryNameOf', () => {
  it('resolves a known id and ignores an unknown or empty one', () => {
    expect(categoryNameOf(CATEGORIES, 'c1')).toBe('会议')
    expect(categoryNameOf(CATEGORIES, 'nope')).toBe('')
    expect(categoryNameOf(CATEGORIES, undefined)).toBe('')
  })
})

describe('clampPlaybackRate', () => {
  it('keeps an offered rate as is', () => {
    expect(clampPlaybackRate(1.25)).toBe(1.25)
    expect(clampPlaybackRate(0.75)).toBe(0.75)
  })

  it('snaps an unoffered rate to the nearest one', () => {
    expect(clampPlaybackRate(0.9)).toBe(1)
    expect(clampPlaybackRate(1.9)).toBe(2)
    expect(clampPlaybackRate(0.1)).toBe(0.75)
  })

  it('falls back to 1 for a non-finite rate', () => {
    expect(clampPlaybackRate(Number.NaN)).toBe(1)
  })
})

describe('tag editing', () => {
  it('strips a leading hash and collapses inner whitespace', () => {
    expect(normalizeTag('  #周  报 ')).toBe('周 报')
    expect(normalizeTag('#')).toBe('')
  })

  it('appends a normalized tag', () => {
    expect(addTag(['工作'], '  #周报 ')).toEqual(['工作', '周报'])
  })

  it('rejects blanks, duplicates and an over-full list', () => {
    expect(addTag(['工作'], '   ')).toEqual(['工作'])
    expect(addTag(['Work'], 'work')).toEqual(['Work'])
    const full = Array.from({ length: MAX_TAGS }, (_, index) => `t${index}`)
    expect(addTag(full, 'overflow')).toHaveLength(MAX_TAGS)
  })

  it('always hands back a fresh array', () => {
    const tags = ['工作']
    const next = addTag(tags, '工作')
    expect(next).not.toBe(tags)
    expect(next).toEqual(tags)
  })

  it('removes a tag regardless of case', () => {
    expect(removeTag(['Work', '私人'], 'work')).toEqual(['私人'])
    expect(removeTag(['工作'], '不存在')).toEqual(['工作'])
  })

  it('toggles a filter chip on and off', () => {
    expect(toggleTag([], '工作')).toEqual(['工作'])
    expect(toggleTag(['工作'], '工作')).toEqual([])
    expect(toggleTag(['工作'], '灵感')).toEqual(['工作', '灵感'])
    expect(toggleTag(['工作'], '  ')).toEqual(['工作'])
  })
})
