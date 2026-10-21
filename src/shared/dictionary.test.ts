import { describe, expect, it } from 'vitest'
import type { Replacement } from './types'
import { MAX_DICTIONARY_ENTRIES, MAX_DICTIONARY_TERM } from './defaults'
import {
  addTerm,
  countByTab,
  filterDictionary,
  learnFromEdit,
  mergeTerms,
  parseCsv,
  removeTerms
} from './dictionary'

describe('parseCsv', () => {
  it('returns an empty result for empty input', () => {
    expect(parseCsv('')).toEqual({
      rows: [],
      invalid: 0,
      overlong: 0,
      duplicates: 0,
      truncated: 0
    })
  })

  it('ignores blank lines and whitespace-only lines', () => {
    expect(parseCsv('\n  \n钉钉\n\n\t\n飞书\n').rows).toEqual([
      { from: '钉钉', to: '' },
      { from: '飞书', to: '' }
    ])
  })

  it('strips a UTF-8 BOM and CRLF line endings', () => {
    const parsed = parseCsv('\ufeff钉钉,DingTalk\r\n飞书,Feishu\r\n')
    expect(parsed.rows).toEqual([
      { from: '钉钉', to: 'DingTalk' },
      { from: '飞书', to: 'Feishu' }
    ])
    expect(parsed.invalid).toBe(0)
  })

  it('keeps a quoted cell containing the separator as one term', () => {
    expect(parseCsv('"钉钉, 企业版"\n飞书').rows).toEqual([
      { from: '钉钉, 企业版', to: '' },
      { from: '飞书', to: '' }
    ])
    expect(parseCsv('"他说 ""你好"""').rows).toEqual([{ from: '他说 "你好"', to: '' }])
    // A quoted comma must not be mistaken for a second column either.
    expect(parseCsv('"钉钉, 企业版",DingTalk').rows).toEqual([
      { from: '钉钉, 企业版', to: 'DingTalk' }
    ])
  })

  it('reads a second column as the replacement instead of dropping it', () => {
    expect(parseCsv('钉钉,DingTalk\n飞书,Feishu').rows).toEqual([
      { from: '钉钉', to: 'DingTalk' },
      { from: '飞书', to: 'Feishu' }
    ])
  })

  it('leaves the target empty for a single-column file so it becomes a hint', () => {
    expect(parseCsv('钉钉\n飞书').rows).toEqual([
      { from: '钉钉', to: '' },
      { from: '飞书', to: '' }
    ])
    // A trailing separator is the same thing as "no target".
    expect(parseCsv('钉钉,').rows).toEqual([{ from: '钉钉', to: '' }])
  })

  it('detects a tab-separated file from its first line', () => {
    expect(parseCsv('钉钉\tDingTalk\n飞书\tFeishu').rows).toEqual([
      { from: '钉钉', to: 'DingTalk' },
      { from: '飞书', to: 'Feishu' }
    ])
  })

  it('detects a semicolon-separated file from its first line', () => {
    expect(parseCsv('钉钉;DingTalk\n飞书;Feishu').rows).toEqual([
      { from: '钉钉', to: 'DingTalk' },
      { from: '飞书', to: 'Feishu' }
    ])
  })

  it('keeps the separator chosen from the first line for every later row', () => {
    // Three tab-separated cells beat the single comma on the first line, so the
    // comma inside the second row's target is never treated as a separator.
    expect(parseCsv('钉钉\tDingTalk\t备注\n飞书\tFeishu, 企业版').rows).toEqual([
      { from: '钉钉', to: 'DingTalk' },
      { from: '飞书', to: 'Feishu, 企业版' }
    ])
  })

  it('skips a leading header row', () => {
    expect(parseCsv('from,to\n钉钉,DingTalk').rows).toEqual([{ from: '钉钉', to: 'DingTalk' }])
    expect(parseCsv('词条\n钉钉').rows).toEqual([{ from: '钉钉', to: '' }])
    expect(parseCsv('from\tto\n钉钉\tDingTalk').rows).toEqual([{ from: '钉钉', to: 'DingTalk' }])
    // "from" is only a header in the first row; later it is a real word.
    expect(parseCsv('钉钉\nfrom').rows).toEqual([
      { from: '钉钉', to: '' },
      { from: 'from', to: '' }
    ])
  })

  it('collapses case-insensitive duplicates and keeps the first mapping', () => {
    // The first occurrence owns the spelling, so a later stray line cannot
    // rewrite a mapping the user already declared — and a target-less first
    // line stays a hint rather than being "upgraded" behind the user's back.
    const parsed = parseCsv('钉钉,DingTalk\n钉钉,钉钉\nDingTalk\nDingTalk,DT')
    expect(parsed.rows).toEqual([
      { from: '钉钉', to: 'DingTalk' },
      { from: 'DingTalk', to: '' }
    ])
    expect(parsed.duplicates).toBe(2)
  })

  it('accepts a term of exactly MAX_DICTIONARY_TERM and rejects one character more', () => {
    const atCap = 'a'.repeat(MAX_DICTIONARY_TERM)
    const parsed = parseCsv(`${atCap}\n${'b'.repeat(MAX_DICTIONARY_TERM + 1)}\n${'c'.repeat(63)}`)
    expect(parsed.rows.map((row) => row.from)).toEqual([atCap, 'c'.repeat(63)])
    expect(parsed.invalid).toBe(1)
    // Overlong rows are counted separately so the preview can name the reason.
    expect(parsed.overlong).toBe(1)
  })

  it('counts a blank first cell as invalid without counting it as overlong', () => {
    const parsed = parseCsv(',to\n钉钉')
    expect(parsed.rows).toEqual([{ from: '钉钉', to: '' }])
    expect(parsed.invalid).toBe(1)
    expect(parsed.overlong).toBe(0)
  })

  it('caps the result at the dictionary size and reports the truncation', () => {
    const lines = Array.from(
      { length: MAX_DICTIONARY_ENTRIES + 5 },
      (_v, i) => `term${i},target${i}`
    )
    const parsed = parseCsv(lines.join('\n'))
    expect(parsed.rows).toHaveLength(MAX_DICTIONARY_ENTRIES)
    expect(parsed.rows[0]).toEqual({ from: 'term0', to: 'target0' })
    expect(parsed.truncated).toBe(5)
  })
})

describe('learnFromEdit', () => {
  it('learns nothing when the text did not change', () => {
    expect(learnFromEdit('今天天气不错', '今天天气不错')).toEqual([])
  })

  it('learns nothing without a before-text to diff against', () => {
    expect(learnFromEdit('', 'Typeless 很好用')).toEqual([])
  })

  it('picks up a latin proper noun the user introduced', () => {
    expect(learnFromEdit('我们用复刻来做', '我们用 Rebuild 来做')).toEqual(['Rebuild'])
  })

  it('picks up a new Chinese term', () => {
    expect(learnFromEdit('把消息发到旧群', '把消息发到钉钉')).toEqual(['钉钉'])
  })

  it('drops stopwords and text already present in the before-text', () => {
    // "这个" is a stopword, so a lone stopword addition teaches nothing.
    expect(learnFromEdit('Hello', 'Hello 这个')).toEqual([])
    // "typeless" is already in the before-text, so the case variant is not new.
    expect(learnFromEdit('typeless', 'Typeless')).toEqual([])
  })

  it('trims a trailing particle off a short learned term', () => {
    expect(learnFromEdit('祝你', '祝祷你')).toEqual(['祝祷'])
  })

  it('returns at most ten candidates', () => {
    const before = '原文'.repeat(60)
    const after = `${before} ${Array.from({ length: 14 }, (_v, i) => `Token${i}X`).join(' ')}`
    expect(learnFromEdit(before, after)).toHaveLength(10)
  })

  it('learns nothing from a wholesale rewrite', () => {
    const before = '完全不一样的一段原始文字内容'
    const after = '这是一个彻底重写的句子，与原句毫无关系，也学不到任何专有名词'
    expect(learnFromEdit(before, after)).toEqual([])
  })
})

describe('addTerm / mergeTerms', () => {
  it('is idempotent: the same spelling never creates a second row', () => {
    const once = addTerm([], '钉钉', { now: 1 })
    const twice = addTerm(once, '钉钉', { now: 2 })
    expect(twice).toHaveLength(1)
    expect(twice[0]?.from).toBe('钉钉')
    expect(twice[0]?.updatedAt).toBe(2)
  })

  it('treats an empty target as a glossary hint and a filled one as replace', () => {
    expect(addTerm([], 'Typeless').at(0)).toMatchObject({ mode: 'hint', to: '' })
    expect(addTerm([], '复刻', { to: 'Rebuild' }).at(0)).toMatchObject({
      mode: 'replace',
      to: 'Rebuild'
    })
  })

  it('increments hits on an auto entry and keeps its origin', () => {
    const learned = addTerm([], 'Kubernetes', { origin: 'auto', now: 1 })
    expect(learned[0]?.hits).toBe(1)
    const again = mergeTerms(learned, ['Kubernetes'], { origin: 'auto', now: 5 })
    expect(again[0]).toMatchObject({ origin: 'auto', hits: 2, updatedAt: 5 })
  })

  it('never turns a learned entry back into a manual one', () => {
    const learned = addTerm([], '飞书', { origin: 'auto', now: 1 })
    const merged = mergeTerms(learned, ['飞书'], { origin: 'manual', now: 2 })
    expect(merged[0]?.origin).toBe('auto')
    expect(merged[0]?.hits).toBe(2)
  })

  it('merges a batch without duplicating existing spellings', () => {
    const base: Replacement[] = [{ from: '钉钉', to: 'DingTalk', mode: 'replace', origin: 'manual' }]
    const merged = mergeTerms(base, ['飞书', '钉钉', 'dingtalk'], { now: 9 })
    expect(merged.map((entry) => entry.from)).toEqual(['钉钉', '飞书', 'dingtalk'])
    expect(merged[0]?.to).toBe('DingTalk')
  })

  it('imports a two-column row as a replacement and a single column as a hint', () => {
    const merged = mergeTerms([], [{ from: '钉钉', to: 'DingTalk' }, { from: '飞书', to: '' }], {
      origin: 'manual',
      now: 1
    })
    expect(merged).toMatchObject([
      { from: '钉钉', to: 'DingTalk', mode: 'replace' },
      { from: '飞书', to: '', mode: 'hint' }
    ])
  })

  it('turns an existing hint into a replacement when a mapping arrives', () => {
    const hinted = addTerm([], '钉钉', { now: 1 })
    expect(hinted[0]?.mode).toBe('hint')
    const merged = mergeTerms(hinted, [{ from: '钉钉', to: 'DingTalk' }], { now: 2 })
    expect(merged[0]).toMatchObject({ to: 'DingTalk', mode: 'replace' })
  })

  it('never downgrades a mapping when a single-column file is re-imported', () => {
    const base: Replacement[] = [
      { from: '钉钉', to: 'DingTalk', mode: 'replace', origin: 'manual' }
    ]
    const merged = mergeTerms(base, [{ from: '钉钉', to: '' }], { now: 3 })
    expect(merged[0]).toMatchObject({ to: 'DingTalk', mode: 'replace' })
  })

  it('refuses to grow past the dictionary cap', () => {
    const full: Replacement[] = Array.from({ length: MAX_DICTIONARY_ENTRIES }, (_v, i) => ({
      from: `t${i}`,
      to: ''
    }))
    expect(addTerm(full, 'new')).toBe(full)
  })
})

describe('removeTerms', () => {
  it('removes case-insensitive matches and leaves the rest untouched', () => {
    const entries: Replacement[] = [
      { from: '钉钉', to: 'DingTalk' },
      { from: '飞书', to: 'Feishu' },
      { from: 'Typeless', to: '' }
    ]
    expect(removeTerms(entries, ['飞书']).map((e) => e.from)).toEqual(['钉钉', 'Typeless'])
    expect(removeTerms(entries, ['typeless', '钉钉']).map((e) => e.from)).toEqual(['飞书'])
    expect(removeTerms(entries, [])).toBe(entries)
  })
})

describe('countByTab / filterDictionary', () => {
  const entries: Replacement[] = [
    { from: '旧词', to: 'old', origin: 'manual' },
    { from: '复刻', to: 'Rebuild', origin: 'manual' },
    { from: 'Kubernetes', to: '', origin: 'auto', hits: 3 }
  ]

  it('counts every tab, treating a missing origin as manual', () => {
    expect(countByTab(entries)).toEqual({ all: 3, auto: 1, manual: 2 })
    expect(countByTab([{ from: 'x', to: '' }])).toEqual({ all: 1, auto: 0, manual: 1 })
  })

  it('filters by tab and shows the newest entry first', () => {
    expect(filterDictionary(entries, 'auto', '').map((row) => row.entry.from)).toEqual([
      'Kubernetes'
    ])
    expect(filterDictionary(entries, 'manual', '').map((row) => row.entry.from)).toEqual([
      '复刻',
      '旧词'
    ])
    expect(filterDictionary(entries, 'all', '')).toHaveLength(3)
  })

  it('searches both columns case-insensitively and keeps stored indices', () => {
    const hits = filterDictionary(entries, 'all', 'REBU')
    expect(hits.map((row) => row.entry.from)).toEqual(['复刻'])
    expect(hits[0]?.index).toBe(1)
    expect(filterDictionary(entries, 'all', '飞书')).toEqual([])
  })
})
