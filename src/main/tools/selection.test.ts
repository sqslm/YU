import { describe, expect, it, vi } from 'vitest'
import { getSelection, type SelectionDeps } from './selection'

/**
 * `getSelection` is a clipboard probe, so its contract is mostly about what it
 * refuses to do: never leak the old clipboard as a selection, never lose the
 * user's clipboard, and never hang the pipeline.
 */
function makeDeps(overrides: Partial<SelectionDeps> = {}): {
  deps: SelectionDeps
  written: string[]
} {
  const written: string[] = []
  const deps: SelectionDeps = {
    readClipboard: () => '',
    writeClipboard: (text: string) => {
      written.push(text)
    },
    sendCopy: async () => {},
    wait: async () => {},
    ...overrides
  }
  return { deps, written }
}

describe('getSelection', () => {
  it('returns the text that appeared after Ctrl+C', async () => {
    let clipboard = '旧内容'
    let copies = 0
    const { deps } = makeDeps({
      readClipboard: () => clipboard,
      writeClipboard: (text) => {
        clipboard = text
      },
      sendCopy: async () => {
        copies += 1
        clipboard = '选中的文字'
      }
    })
    const result = await getSelection({ deps, timeoutMs: 90, pollMs: 10 })
    expect(result).toEqual({ ok: true, text: '选中的文字' })
    expect(copies).toBe(1)
  })

  it('restores the previous clipboard afterwards', async () => {
    let clipboard = '用户的原内容'
    const written: string[] = []
    const { deps } = makeDeps({
      readClipboard: () => clipboard,
      writeClipboard: (text) => {
        written.push(text)
        clipboard = text
      },
      sendCopy: async () => {
        clipboard = '一段选中的话'
      }
    })
    const result = await getSelection({ deps, timeoutMs: 90, pollMs: 10 })
    expect(result.ok).toBe(true)
    expect(written).toEqual(['用户的原内容'])
    expect(clipboard).toBe('用户的原内容')
  })

  it('reports "no selection" when the clipboard never changes', async () => {
    const { deps, written } = makeDeps({ readClipboard: () => '没变' })
    const result = await getSelection({ deps, timeoutMs: 30, pollMs: 10 })
    expect(result).toEqual({ ok: false, error: '没有选中文字' })
    // Same content on both sides: nothing to restore, nothing to overwrite.
    expect(written).toEqual([])
  })

  it('treats whitespace-only selections as empty', async () => {
    let clipboard = 'old'
    const { deps } = makeDeps({
      readClipboard: () => clipboard,
      writeClipboard: (text) => {
        clipboard = text
      },
      sendCopy: async () => {
        clipboard = '   \n\t '
      }
    })
    const result = await getSelection({ deps, timeoutMs: 60, pollMs: 10 })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('没有选中文字')
  })

  it('surfaces a failed key press', async () => {
    const { deps } = makeDeps({
      sendCopy: async () => {
        throw new Error('user32 unavailable')
      }
    })
    const result = await getSelection({ deps, timeoutMs: 30, pollMs: 10 })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('复制快捷键')
  })

  it('surfaces an unreadable clipboard', async () => {
    const { deps } = makeDeps({
      readClipboard: () => {
        throw new Error('denied')
      }
    })
    const result = await getSelection({ deps, timeoutMs: 30, pollMs: 10 })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('剪贴板')
  })

  it('gives up on the timeout instead of waiting forever', async () => {
    const waits = vi.fn(async () => {})
    const { deps } = makeDeps({ readClipboard: () => 'same', wait: waits })
    const result = await getSelection({ deps, timeoutMs: 50, pollMs: 25 })
    expect(result.ok).toBe(false)
    // 25 + 25 = 50 is not < 50, so exactly two polls happened.
    expect(waits).toHaveBeenCalledTimes(2)
  })
})

it('recognizes copying identical text through the clipboard sequence without leaking stale content', async () => {
  let version = 1
  const { deps, written } = makeDeps({
    readClipboard: () => '同样的文字', clipboardVersion: () => version,
    sendCopy: async () => { version++ }
  })
  expect(await getSelection({ deps })).toEqual({ ok: true, text: '同样的文字' })
  expect(written).toEqual(['同样的文字'])
})
