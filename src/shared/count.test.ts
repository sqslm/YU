import { describe, expect, it } from 'vitest'
import {
  countText,
  countUnits,
  formatHitCount,
  speakingWpm,
  timeSavedMs,
  TYPING_WPM
} from './count'

/**
 * Text counters (REQ-07 / REQ-08).
 *
 * The expected numbers are worked out by hand from the strings below, never by
 * re-running the same regex: mixed-sentence behaviour is a product decision
 * ("AI 很好用" counts as 1 + 3), so the test has to pin the decision itself.
 */

describe('countText', () => {
  it('counts Unicode letters and supplementary Han without counting emoji or combining accents twice', () => {
    expect(countText('𠮷 café café Привет مرحبا 👨‍👩‍👧‍👦').units).toBe(5)
  })
  it('counts pure Chinese per character and no words', () => {
    // 我们今天开会 -> 6 ideographs, no latin token.
    expect(countText('我们今天开会')).toEqual({ cjk: 6, words: 0, units: 6, chars: 6 })
  })

  it('counts pure English per whitespace-separated word', () => {
    // 'hello' 'brave' 'new' 'world' -> 4 words; 5+1+5+1+3+1+5 = 21 code points.
    expect(countText('hello brave new world')).toEqual({
      cjk: 0,
      words: 4,
      units: 4,
      chars: 21
    })
  })

  it('adds CJK characters and latin words in a mixed sentence', () => {
    // 我们今天 + deploy + 两次 + hotfix -> 6 cjk + 2 words.
    const counted = countText('我们今天 deploy 两次 hotfix')
    expect(counted.cjk).toBe(6)
    expect(counted.words).toBe(2)
    expect(counted.units).toBe(8)
    // 4 + 1 + 6 + 1 + 2 + 1 + 6 = 21 code points.
    expect(counted.chars).toBe(21)
  })

  it('counts punctuation as characters but never as units', () => {
    // 你好，世界！ -> 4 ideographs, 2 punctuation marks.
    expect(countText('你好，世界！')).toEqual({ cjk: 4, words: 0, units: 4, chars: 6 })
    // Latin punctuation is the same deal: 2 words, 3 characters including '!'.
    expect(countText('hi!')).toEqual({ cjk: 0, words: 1, units: 1, chars: 3 })
  })

  it('treats digit runs as words, alone or inside a mixed sentence', () => {
    // '3' 'apples' 'and' '12' 'pears' -> 5 words; 1+1+6+1+3+1+2+1+5 = 21 chars.
    expect(countText('3 apples and 12 pears')).toEqual({
      cjk: 0,
      words: 5,
      units: 5,
      chars: 21
    })
    // 第 + 3 + 章 -> 2 cjk + 1 word.
    expect(countText('第 3 章')).toEqual({ cjk: 2, words: 1, units: 3, chars: 5 })
  })

  it('returns zeroes for an empty string instead of throwing', () => {
    expect(countText('')).toEqual({ cjk: 0, words: 0, units: 0, chars: 0 })
  })

  it('counts whitespace-only text as characters but zero units', () => {
    // Three spaces: nothing to speak, but they are still characters.
    expect(countText('   ')).toEqual({ cjk: 0, words: 0, units: 0, chars: 3 })
    // Space, newline, space: 3 code points, still no units.
    expect(countText(' \n ')).toEqual({ cjk: 0, words: 0, units: 0, chars: 3 })
  })

  it('exposes the same unit total through countUnits', () => {
    expect(countUnits('我们今天 deploy 两次 hotfix')).toBe(8)
    expect(countUnits('')).toBe(0)
  })
})

describe('speakingWpm', () => {
  it('returns 0 for takes shorter than a second', () => {
    // 10 units in 999 ms would extrapolate to 600 wpm; refuse the noise.
    expect(speakingWpm(10, 999)).toBe(0)
    expect(speakingWpm(10, 0)).toBe(0)
  })

  it('returns 0 when there is nothing to speak', () => {
    expect(speakingWpm(0, 5000)).toBe(0)
    expect(speakingWpm(-3, 5000)).toBe(0)
  })

  it('scales units per minute for a normal take', () => {
    // 10 units in 5 s -> 10 / 5000 * 60000 = 120 wpm.
    expect(speakingWpm(10, 5000)).toBe(120)
    // 50 units in 30 s -> 100 wpm, exactly on the boundary of a second.
    expect(speakingWpm(50, 30_000)).toBe(100)
  })
})

describe('timeSavedMs', () => {
  it('returns 0 when nothing was produced', () => {
    expect(timeSavedMs(0, 5000)).toBe(0)
  })

  it('subtracts the time spent speaking from the typing estimate', () => {
    // 80 units at 40 wpm = 120 s of typing, minus 60 s spoken = 60 s saved.
    expect(timeSavedMs(80, 60_000)).toBe(60_000)
    // 40 units at 40 wpm = 60 s of typing against 60 s spoken -> break even.
    expect(timeSavedMs(40, 60_000)).toBe(0)
  })

  it('clamps at zero when speaking took longer than typing', () => {
    // 1 unit = 1.5 s of typing, but 60 s were spent saying it.
    expect(timeSavedMs(1, 60_000)).toBe(0)
  })

  it('defaults to the shared typing rate and honours an override', () => {
    expect(TYPING_WPM).toBe(40)
    // Halving the typing speed doubles the typing estimate: 40 units at 20 wpm =
    // 120 s, minus 60 s spoken = 60 s saved.
    expect(timeSavedMs(40, 60_000, 20)).toBe(60_000)
  })
})

describe('formatHitCount', () => {
  it('keeps plain digits below a thousand', () => {
    expect(formatHitCount(0)).toBe('0')
    expect(formatHitCount(999)).toBe('999')
  })

  it('uses one decimal only while the mantissa is single-digit', () => {
    expect(formatHitCount(1000)).toBe('1k')
    expect(formatHitCount(1100)).toBe('1.1k')
    expect(formatHitCount(2000)).toBe('2k')
    expect(formatHitCount(9999)).toBe('10k')
  })

  it('rounds to whole thousands above ten', () => {
    expect(formatHitCount(11_000)).toBe('11k')
    expect(formatHitCount(12_400)).toBe('12k')
    expect(formatHitCount(999_000)).toBe('999k')
  })

  it('promotes instead of printing a four-digit mantissa', () => {
    expect(formatHitCount(999_999)).toBe('1M')
    expect(formatHitCount(1_200_000)).toBe('1.2M')
  })

  it('treats negative input as zero', () => {
    expect(formatHitCount(-4)).toBe('0')
  })
})
