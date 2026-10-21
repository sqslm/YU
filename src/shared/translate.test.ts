import { describe, expect, it } from 'vitest'
import { MAX_TRANSLATE_TARGETS } from './defaults'
import {
  detectTranscriptLanguage,
  formatTranslateOutput,
  hasLanguage,
  languageLabel,
  missingTargets,
  multiTargetInstruction,
  parseTargetBlocks,
  resolveTranslateTargets
} from './translate'

describe('resolveTranslateTargets', () => {
  it('prefers the array field', () => {
    expect(resolveTranslateTargets({ translateTargets: ['en', 'ja'], translateTarget: 'zh' })).toEqual([
      'en',
      'ja'
    ])
  })

  it('falls back to the legacy single value when the array is empty', () => {
    expect(resolveTranslateTargets({ translateTargets: [], translateTarget: 'ja' })).toEqual(['ja'])
  })

  it('caps the list at MAX_TRANSLATE_TARGETS', () => {
    const targets = resolveTranslateTargets({ translateTargets: ['en', 'ja', 'ko', 'fr', 'de'] })
    expect(targets).toHaveLength(MAX_TRANSLATE_TARGETS)
    expect(targets).toEqual(['en', 'ja', 'ko'])
  })

  it('trims, drops blanks and de-duplicates case-insensitively', () => {
    expect(
      resolveTranslateTargets({ translateTargets: [' en ', '', 'EN', 'ja'] })
    ).toEqual(['en', 'ja'])
  })

  it('falls back to en when nothing usable is configured', () => {
    expect(resolveTranslateTargets({ translateTargets: [], translateTarget: '  ' })).toEqual(['en'])
    expect(resolveTranslateTargets({})).toEqual(['en'])
  })
})

describe('multiTargetInstruction', () => {
  const instruction = multiTargetInstruction(['en', 'ja'])

  it('names the order and the per-line label format', () => {
    expect(instruction).toContain('en, ja')
    expect(instruction).toContain('[<code>]')
    expect(instruction).toContain('[en] …')
    expect(instruction).toContain('[ja] …')
  })

  it('states how many languages are expected', () => {
    expect(instruction).toContain('2 个目标语言')
  })
})

describe('parseTargetBlocks', () => {
  it('splits labelled lines in target order', () => {
    const blocks = parseTargetBlocks('[en] Hello world\n[ja] こんにちは世界', ['en', 'ja'])
    expect(blocks).toEqual([
      { target: 'en', text: 'Hello world' },
      { target: 'ja', text: 'こんにちは世界' }
    ])
  })

  it('accepts uppercase and full-width labels plus list bullets', () => {
    const blocks = parseTargetBlocks('- [EN] Hello\n* 【JA】こんにちは', ['en', 'ja'])
    expect(blocks.map((block) => block.target)).toEqual(['en', 'ja'])
    expect(blocks[0]!.text).toBe('Hello')
  })

  it('keeps continuation lines inside their block', () => {
    const blocks = parseTargetBlocks('[en] first line\nsecond line\n[ja] 二行目', ['en', 'ja'])
    expect(blocks[0]!.text).toBe('first line\nsecond line')
    expect(blocks[1]!.text).toBe('二行目')
  })

  it('returns the configured order even when the model answers out of order', () => {
    const blocks = parseTargetBlocks('[ja] こんにちは\n[en] Hello', ['en', 'ja'])
    expect(blocks.map((block) => block.target)).toEqual(['en', 'ja'])
  })

  it('only reports the targets that produced text', () => {
    const blocks = parseTargetBlocks('[en] Hello', ['en', 'ja'])
    expect(blocks).toEqual([{ target: 'en', text: 'Hello' }])
    expect(missingTargets(blocks, ['en', 'ja'])).toEqual(['ja'])
  })

  it('ignores labels that are not requested targets', () => {
    const blocks = parseTargetBlocks('[xx] nope\n[en] Hello', ['en', 'ja'])
    expect(blocks).toEqual([{ target: 'en', text: 'Hello' }])
  })

  it('never folds a stray unrequested label into the previous block', () => {
    const blocks = parseTargetBlocks('[en] one\n[ja] 二\n[ko] 셋\n[fr] quatre', ['en', 'ja', 'ko'])
    expect(blocks).toEqual([
      { target: 'en', text: 'one' },
      { target: 'ja', text: '二' },
      { target: 'ko', text: '셋' }
    ])
  })

  it('maps a region-tagged reply onto the bare code', () => {
    const blocks = parseTargetBlocks('[zh-CN] 你好', ['zh'])
    expect(blocks).toEqual([{ target: 'zh', text: '你好' }])
  })

  it('falls back to one paragraph per target when no label is present', () => {
    const blocks = parseTargetBlocks('Hello world\n\nこんにちは世界', ['en', 'ja'])
    expect(blocks).toEqual([
      { target: 'en', text: 'Hello world' },
      { target: 'ja', text: 'こんにちは世界' }
    ])
  })

  it('reports nothing for a reply without labels or matching paragraphs', () => {
    const blocks = parseTargetBlocks('抱歉，我无法翻译。', ['en', 'ja'])
    expect(blocks).toEqual([])
    expect(missingTargets(blocks, ['en', 'ja'])).toEqual(['en', 'ja'])
  })
})

describe('formatTranslateOutput', () => {
  it('keeps single-target output bare for backwards compatibility', () => {
    const text = formatTranslateOutput([{ target: 'en', text: 'Hello world' }], ['en'])
    expect(text).toBe('Hello world')
  })

  it('labels every block with its language name and keeps the configured order', () => {
    const blocks = [
      { target: 'ja', text: 'こんにちは世界' },
      { target: 'en', text: 'Hello world' }
    ]
    expect(formatTranslateOutput(blocks, ['en', 'ja'])).toBe(
      '英语\nHello world\n\n---\n\n日语\nこんにちは世界'
    )
  })

  it('labels the surviving block when only some targets are delivered', () => {
    const text = formatTranslateOutput([{ target: 'en', text: 'Hello world' }], ['en', 'ja'])
    expect(text).toBe('英语\nHello world')
  })

  it('drops targets that came back empty', () => {
    const blocks = [
      { target: 'en', text: 'Hello' },
      { target: 'ko', text: '   ' }
    ]
    expect(formatTranslateOutput(blocks, ['en', 'ko'])).toBe('英语\nHello')
  })
})

describe('hasLanguage', () => {
  it('matches exact codes and same-language subtags', () => {
    expect(hasLanguage(['en', 'ja'], 'ja')).toBe(true)
    expect(hasLanguage(['zh'], 'zh-CN')).toBe(true)
    expect(hasLanguage(['en'], 'zh')).toBe(false)
  })
})

describe('languageLabel', () => {
  it('maps known codes to Chinese labels and echoes unknown ones', () => {
    expect(languageLabel('ja')).toBe('日语')
    expect(languageLabel('EN')).toBe('英语')
    expect(languageLabel('xx')).toBe('xx')
  })
})

describe('detectTranscriptLanguage', () => {
  it('detects kana as Japanese even when Han characters are present', () => {
    expect(detectTranscriptLanguage('今日はいい天気ですね、こんにちは')).toBe('ja')
  })

  it('detects Hangul, Cyrillic and Han', () => {
    expect(detectTranscriptLanguage('안녕하세요')).toBe('ko')
    expect(detectTranscriptLanguage('привет')).toBe('ru')
    expect(detectTranscriptLanguage('今天天气很好')).toBe('zh')
  })

  it('stays unknown for Latin text and empty input', () => {
    expect(detectTranscriptLanguage('Hello world')).toBeNull()
    expect(detectTranscriptLanguage('   ')).toBeNull()
  })
})
