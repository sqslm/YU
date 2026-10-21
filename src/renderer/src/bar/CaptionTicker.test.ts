import { describe, expect, it } from 'vitest'
import { captionUpdate, type CaptionGlyph } from './CaptionTicker'
const glyphs = (text: string): CaptionGlyph[] => Array.from(text, (text, id) => ({ id, text }))

describe('caption reconciliation', () => {
  it('keeps existing identities as words arrive and as the window advances', () => {
    const old = glyphs('今天测试字幕')
    expect(captionUpdate(old, '今天测试字幕显示')).toEqual({ keep: old, pending: ['显', '示'] })
    expect(captionUpdate(old, '测试字幕显示')).toEqual({ keep: old.slice(2), pending: ['显', '示'] })
  })
  it('corrects an ASR tail without replaying the matching prefix', () => {
    const old = glyphs('你好你好')
    expect(captionUpdate(old, '你好你们')).toEqual({ keep: old.slice(0, 3), pending: ['们'] })
    expect(captionUpdate(old, '')).toEqual({ keep: [], pending: [] })
  })
  it('bounds the visible sequence and keeps emoji and combining characters together', () => {
    expect(captionUpdate([], '很长'.repeat(80)).pending).toHaveLength(24)
    expect(captionUpdate([], '好👨‍👩‍👧‍👦e\u0301').pending).toEqual(['好', '👨‍👩‍👧‍👦', 'e\u0301'])
  })
})
