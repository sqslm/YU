import { expect, it } from 'vitest'
import { stripSourceTail } from './sourceText'

it('removes the model-written source list and keeps the prose', () => {
  const text = '苹果发布了新芯片。\n\n## 来源\n- [官方公告](https://apple.com/news)\n- [报道](https://example.com/a)'
  expect(stripSourceTail(text)).toBe('苹果发布了新芯片。')
})

it('removes a level-3 heading and a colon form, the shapes the model actually uses', () => {
  expect(stripSourceTail('结论。\n\n### 来源：\n- [A](https://a.test)\n- [B](https://b.test)')).toBe('结论。')
  expect(stripSourceTail('结论。\n\n**参考资料：**\n1. https://a.test\n2. https://b.test')).toBe('结论。')
  expect(stripSourceTail('结论。\n\n来源：\n- https://a.test\n- https://b.test')).toBe('结论。')
})

it('strips the English heading too', () => {
  expect(stripSourceTail('Done.\n\n## Sources\n- [A](https://a.test)\n- [B](https://b.test)')).toBe('Done.')
})

it('keeps a real section that merely shares the heading name', () => {
  const text = '正文。\n\n## 来源\n这一节说明数据来自公司年报，没有链接。'
  expect(stripSourceTail(text)).toBe(text)
})

it('removes a trailing citation list with no heading at all', () => {
  expect(stripSourceTail('正文一句。\n\n- [A](https://a.test)\n- [B](https://b.test)')).toBe('正文一句。')
})

it('leaves answers that are only prose untouched', () => {
  const text = '没有检索，也没有链接。\n\n第二段继续说明。'
  expect(stripSourceTail(text)).toBe(text)
  expect(stripSourceTail('')).toBe('')
})

it('does not eat a single trailing link mentioned in prose', () => {
  const text = '详见 https://example.com/doc 。'
  expect(stripSourceTail(text)).toBe(text)
})

it('is idempotent', () => {
  const once = stripSourceTail('结论。\n\n## 来源\n- [A](https://a.test)')
  expect(stripSourceTail(once)).toBe(once)
})
