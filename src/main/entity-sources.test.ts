import { expect, it, vi } from 'vitest'
import { ENTITY_SOURCES } from '@shared/entity-sources'
import { fetchPublicTerms, parsePublicTerms } from './entity-sources'
import { EntityStore } from './entity-store'
import { EntityMatcher } from './entity-matcher'
import { writeFileSync } from 'node:fs'

it('reads Rime rows without YAML execution, duplicates or comments; preserves public provenance', () => {
  const rows = parsePublicTerms('name: x\n---\n...\n# 注释\n高叶\tgao ye\t1\n高叶\tgao ye\t2\n张颂文\tzhang song wen\t9\n!!js/function evil\tx\t0', ENTITY_SOURCES[0])
  expect(rows.map(row => row.canonical)).toEqual(['高叶', '张颂文'])
  expect(rows[0]).toMatchObject({ userDefined: false, verified: false, aliases: [], domain: '人物', source: expect.stringContaining('GPL-3.0') })
  const store = new EntityStore(':memory:')
  try {
    expect(store.import(rows)).toBe(2)
    const original = store.list()[0]; store.save({ ...original, aliases: ['个人别名'], enabled: false }, original.id)
    expect(store.import(rows)).toBe(0)
    expect(store.list().find(row => row.id === original.id)).toMatchObject({ enabled: false, aliases: ['个人别名'] })
    const matcher = new EntityMatcher(); matcher.set(store.list())
    expect(matcher.hotwords('普通聊天')).toEqual([])
  } finally { store.close() }
})

it('uses public name homophones only in a named scene, keeping unrelated places intact', () => {
  const matcher = new EntityMatcher(), rows = parsePublicTerms('...\n高叶\tgao ye\t0\n闫桉\tyan an\t0', ENTITY_SOURCES[0])
  matcher.set(rows.map((row, i) => ({ ...row, userDefined: false, id: String(i), createdAt: 1, updatedAt: 1 })))
  expect(matcher.candidates('高烨的演技很好', '')[0]).toMatchObject({ canonical: '高叶', reason: 'phonetic' })
  expect(matcher.candidates('去延安旅游', '')).toEqual([])
})

it('selects the explicitly labelled 5000 IT entries by source frequency, not inferred correctness', () => {
  const rows = parsePublicTerms(Array.from({ length: 5002 }, (_, i) => `技术${i}\t${i}`).join('\n'), ENTITY_SOURCES[3])
  expect(rows).toHaveLength(5000); expect(rows[0].canonical).toBe('技术5001'); expect(rows.at(-1)?.canonical).toBe('技术2')
  expect(rows.every(row => !row.verified && !row.userDefined)).toBe(true)
})

it('rejects arbitrary URLs, changed data, oversized files and partial downloads before any database import', async () => {
  const request = vi.fn<typeof fetch>()
  await expect(fetchPublicTerms(['https://127.0.0.1/'], request)).rejects.toThrow('有效'); expect(request).not.toHaveBeenCalled()
  request.mockResolvedValueOnce(new Response('...\n高叶\tgao ye\t1'))
  request.mockResolvedValueOnce(new Response('not found', { status: 503 }))
  await expect(fetchPublicTerms(['frost-names', 'frost-hot'], request)).rejects.toThrow('503')
  expect(request.mock.calls[0]).toEqual([ENTITY_SOURCES[0].url, expect.objectContaining({ credentials: 'omit', redirect: 'error' })])
  request.mockResolvedValueOnce(new Response('a'.repeat(1024 * 1024 + 1)))
  await expect(fetchPublicTerms(['frost-names'], request)).rejects.toThrow('过大')
  request.mockResolvedValueOnce(new Response('<html>login</html>'))
  await expect(fetchPublicTerms(['frost-names'], request)).rejects.toThrow('格式')
})

it.skipIf(!process.env.TYPELESS_PUBLIC_TERMS_LIVE)('downloads the actual reviewed sources and measures a full import and local index', async () => {
  const started = performance.now(), terms = await fetchPublicTerms(ENTITY_SOURCES.map(source => source.id), fetch)
  const downloadedMs = performance.now() - started, store = new EntityStore(':memory:')
  try {
    const at = performance.now(), added = store.import(terms), importMs = performance.now() - at
    const matcher = new EntityMatcher(), indexAt = performance.now(); matcher.set(store.list())
    const indexMs = performance.now() - indexAt, lookupAt = performance.now()
    const candidates = matcher.candidates('科大讯飞和深度求索的技术方案', '技术')
    const lookupMs = performance.now() - lookupAt
    expect(added).toBeGreaterThan(7000); expect(added).toBeLessThanOrEqual(10000)
    expect(candidates.some(row => row.canonical === '深度求索')).toBe(true)
    expect(store.import(terms)).toBe(0)
    const report = { added, downloadedMs, importMs, indexMs, lookupMs, sources: ENTITY_SOURCES.map(source => ({ id: source.id, url: source.url, license: source.license, parsed: terms.filter(row => row.source.startsWith(source.url)).length })), note: 'Actual public downloads and candidate retrieval; not speech recognition or final LLM accuracy.' }
    writeFileSync(process.env.TYPELESS_PUBLIC_TERMS_LIVE!, JSON.stringify(report, null, 2))
  } finally { store.close() }
}, 100000)
