import { describe, expect, it } from 'vitest'
import { resolveReference, type ReferenceContext, type ReferenceItem } from './assistant'

const rows = (): ReferenceItem[] => [
  { id: 'e1', title: '项目讨论', fields: {} },
  { id: 'e2', title: '评审', fields: {} },
  { id: 'e3', title: '面试', fields: {} }
]

const thread = (items: ReferenceItem[] = rows()): ReferenceContext => ({ tool: 'list_events', items })

describe('quoted content never resolves as a pointer (REF-1)', () => {
  it('ignores an ordinal that appears inside quotes mid-sentence', () => {
    // The reported case: the user is recording what someone said, not pointing at
    // the second row of the list the assistant just printed.
    expect(resolveReference('他说「第二个方案不行」，帮我记下来', thread())).toEqual({ kind: 'none' })
    expect(resolveReference('他说“第 2 条要推迟”，记一下', thread())).toEqual({ kind: 'none' })
    expect(resolveReference('客户的原话是"the second one is wrong"，帮我整理', thread())).toEqual({ kind: 'none' })
  })
  it('treats a quoted tail reference the same way', () => {
    expect(resolveReference('他问「最后一条还在吗」，帮我回复', thread())).toEqual({ kind: 'none' })
  })
  it('keeps a plain ordinal working next to quoted material without ordinals', () => {
    expect(resolveReference('把「项目讨论」和第二个都改成十一点', thread())).toMatchObject({ kind: 'ordinal', index: 1 })
    expect(resolveReference('第二个改成十一点', thread())).toMatchObject({ kind: 'ordinal', index: 1 })
    expect(resolveReference('把第 2 条改成十一点', thread())).toMatchObject({ kind: 'ordinal', index: 1 })
    expect(resolveReference('最后一个改成十一点', thread())).toMatchObject({ kind: 'last', index: 2 })
  })
  it('still ignores time ordinals, quoted or not', () => {
    expect(resolveReference('第一次提醒是什么时候', thread())).toEqual({ kind: 'none' })
    expect(resolveReference('他说「第三步先做界面」', thread())).toEqual({ kind: 'none' })
  })
})
