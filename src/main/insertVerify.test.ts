import { describe, expect, it } from 'vitest'
import { insertOk, insertionTail, verifyInsertion } from './insert'

/**
 * ACC-08: insertion must be observable. These tests inject the reader, so each
 * verdict below is produced by the exact branch the pipeline relies on.
 */

const TEXT = '我们明天上午十点开会，记得带上第二季度的预算表'

describe('insertionTail', () => {
  it('keeps short text whole and cuts long text to its last 24 characters', () => {
    expect(insertionTail('好的')).toBe('好的')
    const compacted = TEXT.replace(/\s+/g, '')
    expect(insertionTail(TEXT)).toBe(compacted.slice(-24))
    expect(insertionTail('x'.repeat(40))).toBe('x'.repeat(24))
    expect(insertionTail('x'.repeat(40))).toHaveLength(24)
  })

  it('ignores whitespace, including newlines', () => {
    expect(insertionTail('我们明天\n开会')).toBe('我们明天开会')
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
    const compacted = TEXT.replace(/\s+/g, '')
    const result = await verifyInsertion(async () => compacted.slice(-24), TEXT)
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
