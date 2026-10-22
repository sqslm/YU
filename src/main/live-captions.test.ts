import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveCaptions } from './live-captions'

afterEach(() => vi.useRealTimers())
const speech = (seconds = 1): Int16Array => new Int16Array(seconds * 16000).fill(1200)
function harness(transcribe = vi.fn(async (_pcm: Int16Array, _signal: AbortSignal) => '字幕')) {
  const onText = vi.fn(), onError = vi.fn()
  return { captions: new LiveCaptions({ transcribe, onText, onError }), transcribe, onText, onError }
}

describe('live captions', () => {
  it('offers opening text only while the ASR window still contains the beginning', async () => {
    vi.useFakeTimers()
    const onOpeningText = vi.fn(), onText = vi.fn()
    const text = '指令问答，' + '这是正文'.repeat(40)
    const captions = new LiveCaptions({ transcribe: async () => text, onOpeningText, onText, onError: vi.fn() })
    captions.push(speech(2)); await vi.advanceTimersByTimeAsync(1800)
    expect(onOpeningText).toHaveBeenCalledWith(text)
    expect(Array.from(onText.mock.calls[0][0])).toHaveLength(120)
    captions.push(speech(6)); await vi.advanceTimersByTimeAsync(1800)
    expect(onOpeningText).toHaveBeenCalledOnce()
    expect(onText).toHaveBeenCalledTimes(2)
    captions.stop()
  })
  it('bounds keyword-only capture to the first six seconds without polling the rest of the recording', async () => {
    vi.useFakeTimers()
    const transcribe = vi.fn(async (_pcm: Int16Array) => 'command ask, hello'), onOpeningText = vi.fn()
    const captions = new LiveCaptions({ transcribe, onOpeningText, openingOnly: true, onText: vi.fn(), onError: vi.fn() })
    captions.push(speech(20)); await vi.advanceTimersByTimeAsync(1800)
    expect(transcribe.mock.calls[0][0]).toEqual(speech(6))
    captions.push(speech(30)); await vi.advanceTimersByTimeAsync(30000)
    expect(transcribe).toHaveBeenCalledOnce()
    expect(onOpeningText).toHaveBeenCalledOnce()
    captions.stop()
  })
  it('waits for a second of audible input and bounds each preview to six seconds', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.captions.push(new Int16Array(16000))
    await vi.advanceTimersByTimeAsync(1800)
    expect(h.transcribe).not.toHaveBeenCalled()
    h.captions.push(speech(12))
    await vi.advanceTimersByTimeAsync(1800)
    expect(h.transcribe).toHaveBeenCalledOnce()
    expect(h.transcribe.mock.calls[0][0]).toEqual(speech(6))
    expect(h.onText).toHaveBeenCalledWith('字幕')
    h.captions.stop()
  })

  it('never queues concurrent requests; stopping aborts and ignores a late result', async () => {
    vi.useFakeTimers()
    let finish!: (value: string) => void
    const request = vi.fn((_pcm: Int16Array, _signal: AbortSignal) => new Promise<string>(resolve => { finish = resolve }))
    const h = harness(request)
    h.captions.push(speech())
    await vi.advanceTimersByTimeAsync(1800)
    h.captions.push(speech(9))
    await vi.advanceTimersByTimeAsync(10000)
    expect(request).toHaveBeenCalledOnce()
    h.captions.stop()
    expect(request.mock.calls[0][1].aborted).toBe(true)
    finish('迟来的旧字幕')
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.onText).not.toHaveBeenCalled()
    expect(h.onError).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('processes fresh input after a slow request and stops previewing after an error', async () => {
    vi.useFakeTimers()
    let finish!: (value: string) => void
    const request = vi.fn((_pcm: Int16Array, _signal: AbortSignal) => new Promise<string>(resolve => { finish = resolve }))
    const h = harness(request)
    h.captions.push(speech())
    await vi.advanceTimersByTimeAsync(1800)
    h.captions.push(speech())
    finish('第一段')
    await vi.advanceTimersByTimeAsync(0)
    request.mockRejectedValueOnce(new Error('quota'))
    await vi.advanceTimersByTimeAsync(1800)
    expect(h.onError).toHaveBeenCalledOnce()
    h.captions.push(speech())
    await vi.advanceTimersByTimeAsync(30000)
    expect(request).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
