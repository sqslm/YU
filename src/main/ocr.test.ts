import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ nativeImage: {} }))
import { normalizeOcrText } from './ocr'

it('removes artificial Chinese character and punctuation spacing, preserving actual English words and line breaks', () => {
  expect(normalizeOcrText('本 轮 沿 用 code 、 brainstorming 和 调 试 技 能 ， 分 三 步 做 ： ASR 可 用 性 检 查 。\nWindows local speech recognition'))
    .toBe('本轮沿用 code、brainstorming 和调试技能，分三步做：ASR 可用性检查。\nWindows local speech recognition')
})
it('does not merge English phrases, alter source words or pretend to correct recognition errors', () => {
  expect(normalizeOcrText(' Hello world!\n  W 本 地 语 音 ')).toBe('Hello world!\nW 本地语音')
})
