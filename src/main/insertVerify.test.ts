import { describe, expect, it } from 'vitest'
import {
  insertOk,
  insertionShingles,
  insertionTail,
  normalizeForVerify,
  verifyInsertion,
  verifyTimeoutMs
} from './insert'

/**
 * ACC-08: insertion must be observable. These tests inject the reader, so each
 * verdict below is produced by the exact branch the pipeline relies on.
 */

const TEXT = '我们明天上午十点开会，记得带上第二季度的预算表'

/** A take long enough to need more than one window of evidence. */
const LONG = '第一季度我们完成了三件大事，第一是统一了模型接入层，第二是把历史的失败任务全部补齐，第三是把插入校验从末尾比对改成了分片比对，最后更新时间是十月三十日晚上。'

/** The text the same long take gets after a length-scaled budget, ≥ 170 chars. */
const LONG_178 =
  '今天下午的会议纪要如下：第一，前端把历史上的失败任务补齐，包括听写失败、模型返回空文本、插入校验失败这三类；' +
  '第二，后端把插入校验的比对方式从末尾二十四个字改成分片命中，长文本要按长度放宽等待时间，避免把已经插入成功的长听写判成没有插入；' +
  '第三，产品要求所有没有被用户取消的失败任务都写进历史记录，用户可以在历史里复制或者重试，而不是只在提示条上闪一下。'

describe('insertionTail', () => {
  it('keeps short text whole and cuts long text to its last 24 characters', () => {
    expect(insertionTail('好的')).toBe('好的')
    const compacted = normalizeForVerify(TEXT)
    expect(insertionTail(TEXT)).toBe(compacted.slice(-24))
    expect(insertionTail('x'.repeat(40))).toBe('x'.repeat(24))
    expect(insertionTail('x'.repeat(40))).toHaveLength(24)
  })

  it('ignores whitespace, including newlines', () => {
    expect(insertionTail('我们明天\n开会')).toBe('我们明天开会')
  })
})

describe('normalizeForVerify', () => {
  it('ignores layout: whitespace, newlines and the markdown that only formats', () => {
    expect(normalizeForVerify('# 会议纪要\n\n**时间**：明天')).toBe('会议纪要时间:明天')
    expect(normalizeForVerify('`code` 和 ~~删除~~ 和 _强调_')).toBe('code和删除和强调')
  })

  it('unifies the punctuation a target control rewrites on paste', () => {
    // Curly quotes, em/en dashes and CJK full stops are not content: an editor
    // that smart-quoted our text has received it.
    expect(normalizeForVerify('“你好”—他说')).toBe('"你好"-他说')
    expect(normalizeForVerify('“你好”—他说')).toBe(normalizeForVerify('"你好" - 他说'))
    expect(normalizeForVerify('第一点。第二点')).toBe(normalizeForVerify('第一点.第二点'))
    expect(normalizeForVerify('一，二')).toBe(normalizeForVerify('一, 二'))
  })

  it('keeps words apart that only look alike', () => {
    expect(normalizeForVerify('预算表')).not.toBe(normalizeForVerify('预 算 书'))
  })
})

describe('insertionShingles', () => {
  it('keeps the tail and samples the text every eight characters', () => {
    const shingles = insertionShingles(LONG)
    expect(shingles.length).toBeGreaterThan(2)
    expect(shingles.every((shingle) => shingle.length === 24)).toBe(true)
    expect(shingles.at(-1)).toBe(normalizeForVerify(LONG).slice(-24))
    expect(new Set(shingles).size).toBe(shingles.length)
  })

  it('treats a short insert as a single window', () => {
    expect(insertionShingles(TEXT)).toEqual([normalizeForVerify(TEXT)])
    expect(insertionShingles('')).toEqual([])
  })
})

describe('verifyTimeoutMs', () => {
  it('scales with the length of the insert and stays capped', () => {
    expect(verifyTimeoutMs(0)).toBe(1200)
    expect(verifyTimeoutMs(10)).toBe(1240)
    expect(verifyTimeoutMs(178)).toBe(1912)
    expect(verifyTimeoutMs(10_000)).toBe(3000)
  })
})

describe('verifyInsertion', () => {
  it('reports ok as soon as the control holds the inserted tail', async () => {
    let reads = 0
    const result = await verifyInsertion(
      async () => {
        reads += 1
        return `前缀 ${TEXT} 后缀`
      },
      TEXT
    )
    expect(result).toEqual({ ok: true, observed: `前缀 ${TEXT} 后缀` })
    expect(reads).toBe(1)
  })

  it('matches text whose quotes, spacing and markdown the control rewrote', async () => {
    const expected = '# 会议纪要\n\n**时间**：明天上午十点，地点在 3 号会议室'
    const observed = '会议纪要 时间: 明天上午十点, 地点在 3 号会议室'
    const result = await verifyInsertion(async () => observed, expected, { attempts: 1 })
    expect(result.ok).toBe(true)
  })

  it('matches text that only survives in the middle of the control', async () => {
    const compacted = normalizeForVerify(LONG)
    // The target kept a slice of the paragraph and re-wrapped everything else:
    // the tail is gone, two windows of the same words are still there.
    const observed = `别的前缀 ${compacted.slice(24, 60)} 别的后缀`
    const result = await verifyInsertion(async () => observed, LONG, { attempts: 1 })
    expect(result.ok).toBe(true)
  })

  it('retries with backoff and succeeds on the third read', async () => {
    let reads = 0
    const result = await verifyInsertion(
      async () => {
        reads += 1
        return reads < 3 ? null : TEXT
      },
      TEXT,
      { attempts: 3 }
    )
    expect(reads).toBe(3)
    expect(result.ok).toBe(true)
    expect(result.observed).toBe(TEXT)
  })

  it('reports mismatch when a readable control holds different text', async () => {
    const result = await verifyInsertion(async () => '完全不同的内容', TEXT, { attempts: 1 })
    expect(result).toEqual({ ok: false, reason: 'mismatch', observed: '完全不同的内容' })
  })

  it('still reports mismatch when only one window of a long take survived', async () => {
    const compacted = normalizeForVerify(LONG)
    // One 24-character phrase is not enough evidence for a whole paragraph: a
    // control that holds a single familiar line has not received the take.
    const observed = compacted.slice(0, 24)
    const result = await verifyInsertion(async () => observed, LONG, { attempts: 1 })
    expect(result).toEqual({ ok: false, reason: 'mismatch', observed })
  })

  it('reports no-target when nothing readable is focused', async () => {
    let reads = 0
    const result = await verifyInsertion(
      async () => {
        reads += 1
        return null
      },
      TEXT,
      { attempts: 2 }
    )
    expect(reads).toBe(2)
    expect(result).toEqual({ ok: false, reason: 'no-target' })
  })

  it('reports no-target when the reader throws', async () => {
    const result = await verifyInsertion(
      async () => {
        throw new Error('uia host is down')
      },
      TEXT,
      { attempts: 1 }
    )
    expect(result).toEqual({ ok: false, reason: 'no-target' })
  })

  it('reports timeout when the budget runs out before the control becomes readable', async () => {
    const result = await verifyInsertion(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 60))
        return null
      },
      TEXT,
      { attempts: 2, timeoutMs: 30 }
    )
    expect(result).toEqual({ ok: false, reason: 'timeout' })
  })

  it('treats a truncated control that ends with the tail as inserted', async () => {
    const compacted = normalizeForVerify(TEXT)
    const result = await verifyInsertion(async () => compacted.slice(-24), TEXT)
    expect(result.ok).toBe(true)
  })

  it('spends more time on a long take than the old fixed 1.2 s budget allowed', async () => {
    // The control needs ~1.4 s to expose the text: past the fixed budget, inside
    // the one scaled to this 170+ character insert.
    let reads = 0
    const result = await verifyInsertion(async () => {
      reads += 1
      await new Promise((resolve) => setTimeout(resolve, 700))
      return reads < 3 ? null : LONG_178
    }, LONG_178)
    expect(reads).toBe(3)
    expect(result.ok).toBe(true)
  })

  it('does nothing when there was no text to insert', async () => {
    let reads = 0
    const result = await verifyInsertion(async () => {
      reads += 1
      return 'irrelevant'
    }, '')
    expect(result).toEqual({ ok: true })
    expect(reads).toBe(0)
  })
})

describe('insertOk', () => {
  it('formats both verdicts', () => {
    expect(insertOk(true)).toBe('insert verified')
    expect(insertOk(false, 'mismatch')).toBe('insert unverified: mismatch')
    expect(insertOk(false)).toBe('insert unverified')
  })
})
