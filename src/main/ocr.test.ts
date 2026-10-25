import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ nativeImage: {} }))
import { normalizeOcrText, ocrRegions } from './ocr'

it('removes artificial Chinese character and punctuation spacing, preserving actual English words and line breaks', () => {
  expect(normalizeOcrText('本 轮 沿 用 code 、 brainstorming 和 调 试 技 能 ， 分 三 步 做 ： ASR 可 用 性 检 查 。\nWindows local speech recognition'))
    .toBe('本轮沿用 code、brainstorming 和调试技能，分三步做：ASR 可用性检查。\nWindows local speech recognition')
})
it('does not merge English phrases, alter source words or pretend to correct recognition errors', () => {
  expect(normalizeOcrText(' Hello world!\n  W 本 地 语 音 ')).toBe('Hello world!\nW 本地语音')
})
it('maps upscaled and downscaled OCR bounds back to original pixels', () => {
  expect(ocrRegions({ width: 900, height: 300, lines: [{ text: '中 文', x: 15, y: 30, width: 300, height: 30 }] }, { width: 600, height: 200 }))
    .toEqual([{ text: '中文', x: 10, y: 20, width: 200, height: 20 }])
  expect(() => ocrRegions({ width: 900, height: 300, lines: [{ text: 'bad', x: -1, y: 0, width: 10, height: 20 }] }, { width: 600, height: 200 })).toThrow('未获取到文字位置')
})
