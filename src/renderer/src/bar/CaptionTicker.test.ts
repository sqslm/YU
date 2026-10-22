import { describe, expect, it } from 'vitest'
import { reconcileCaption, type CaptionGlyph } from './CaptionTicker'
const glyphs = (text: string): CaptionGlyph[] => Array.from(text, (text, id) => ({ id, text }))
const update = (old: CaptionGlyph[], text: string): CaptionGlyph[] => {
  let id = Math.max(0, ...old.map(item => item.id))
  return reconcileCaption(old, text, () => ++id)
}

describe('caption reconciliation', () => {
  it('keeps existing identities as words arrive and as the window advances', () => {
    const old = glyphs('今天测试字幕')
    expect(update(old, '今天测试字幕显示').slice(0, old.length)).toEqual(old)
    expect(update(old, '测试字幕显示').slice(0, 4)).toEqual(old.slice(2))
  })
  it('corrects an ASR tail without replaying the matching prefix', () => {
    const old = glyphs('你好你好')
    expect(update(old, '你好你们').map(item => item.id)).toEqual(old.map(item => item.id))
    expect(update(old, '')).toEqual([])
  })
  it('bounds the visible sequence and keeps emoji and combining characters together', () => {
    expect(update([], '很长'.repeat(80))).toHaveLength(120)
    expect(update([], '好👨‍👩‍👧‍👦e\u0301').map(item => item.text)).toEqual(['好', '👨‍👩‍👧‍👦', 'e\u0301'])
  })
  it('does not replay existing words when ASR inserts punctuation before them', () => {
    const old = glyphs('大家好今天在这里测试')
    const next = update(old, '大家好，今天在这里测试新字')
    expect(next.filter(item => old.some(before => before.id === item.id))).toEqual(old)
    expect(next.filter(item => !old.some(before => before.id === item.id)).map(item => item.text)).toEqual(['，', '新', '字'])
  })
  it('diffs queued words against the whole previous target across rapid snapshots', () => {
    const first = update([], '第一句还没播完就有新文字')
    const second = update(first, '第一句还没播完，就有新文字进入')
    const third = update(second, '第一句还没播完，就有新文字进入到字幕中')
    expect(third.slice(0, second.length)).toEqual(second)
    expect(new Set(third.map(item => item.id)).size).toBe(third.length)
  })
  it('queues a rewritten sentence as new glyphs instead of replacing all shown glyphs in one batch', () => {
    const old = glyphs('旧的一整段字幕')
    const next = update(old, ' completely different sentence')
    expect(next.every(glyph => !old.some(previous => previous.id === glyph.id))).toBe(true)
  })
})
