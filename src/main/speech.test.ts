import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_TTS_SETTINGS, MAX_SPEECH_CHARS, normalizeTtsSettings, speechText, type TtsSettings } from '@shared/speech'
import { SpeechService, createWindowsSpeechRunner, type SpeechRequest, type SpeechResult, type SpeechRunner } from './speech'

it('acknowledges real start and preserves the utterance across pause/resume', async () => {
  let started:(()=>void)|undefined, finish:((r:SpeechResult)=>void)|undefined
  const run:SpeechRunner=(_request,_signal,onStarted)=>{started=onStarted;return new Promise(resolve=>{finish=resolve})}
  run.control=vi.fn(async()=>({ok:true}))
  const service=new SpeechService({settings:()=>({tts:{...DEFAULT_TTS_SETTINGS,enabled:true}}),run,log:vi.fn()})
  let acknowledged=false
  const start=service.start('Read this text').then(value=>{acknowledged=true;return value})
  await Promise.resolve();expect(acknowledged).toBe(false)
  started!();expect(await start).toMatchObject({skipped:false})
  expect(await service.pause()).toMatchObject({speaking:true,paused:true})
  expect(await service.resume()).toMatchObject({speaking:true,paused:false})
  expect(run.control).toHaveBeenNthCalledWith(1,'pause')
  expect(run.control).toHaveBeenNthCalledWith(2,'resume')
  finish!({ok:true});await Promise.resolve();await Promise.resolve()
  expect(service.status().speaking).toBe(false)
})

/**
 * Every test drives {@link SpeechService} through a fake runner. Nothing here
 * spawns powershell.exe or opens an audio device: the bridge is the one piece
 * that needs a real Windows host, and it stays out of the unit suite.
 */
function harness(reply: (request: SpeechRequest) => Promise<SpeechResult> = async () => ({ ok: true }), tts: Partial<TtsSettings> = {}) {
  const calls: SpeechRequest[] = []
  const signals: Array<AbortSignal | undefined> = []
  const logs: string[] = []
  const run: SpeechRunner = (request, signal) => {
    calls.push(request)
    signals.push(signal)
    return reply(request)
  }
  const service = new SpeechService({
    settings: () => ({ tts: { ...DEFAULT_TTS_SETTINGS, enabled: true, ...tts } }),
    run,
    log: (line) => logs.push(line),
    // A frozen clock keeps the failure log assertions exact.
    now: () => 0
  })
  return { service, calls, signals, logs }
}

/** A runner whose promises the test resolves by hand, so read-outs overlap. */
function pendingHarness() {
  const settling: Array<(result: SpeechResult) => void> = []
  const base = harness(() => new Promise<SpeechResult>((resolve) => { settling.push(resolve) }))
  return { ...base, settling }
}

describe('SpeechService.speak', () => {
  it('says nothing while read-aloud is switched off in the settings', async () => {
    const h = harness(async () => ({ ok: true }), { enabled: false })
    await expect(h.service.speak('你好')).resolves.toEqual({ spoken: 0, skipped: true })
    expect(h.calls).toEqual([])
    expect(h.service.speaking()).toBe(false)
  })

  it('skips a message that cleans down to nothing instead of reporting a failure', async () => {
    const h = harness()
    for (const text of ['   \n\t ', '🎉🚀', '', null, 42]) {
      await expect(h.service.speak(text)).resolves.toEqual({ spoken: 0, skipped: true })
    }
    expect(h.calls).toEqual([])
    expect(h.logs).toEqual([])
  })

  it('speaks the cleaned text with the rate and volume from the settings', async () => {
    const h = harness(async () => ({ ok: true }), { rate: 3, volume: 60 })
    const result = await h.service.speak('## 标题\n请**朗读**这段 https://example.com 内容。')
    expect(h.calls).toEqual([{ action: 'speak', text: '标题 请朗读这段 内容。', rate: 3, volume: 60 }])
    expect(result).toEqual({ spoken: '标题 请朗读这段 内容。'.length, skipped: false })
    expect(h.service.speaking()).toBe(false)
  })

  it('passes the configured voice through only when one is set', async () => {
    const named = harness(async () => ({ ok: true }), { voice: '  Microsoft Huihui  ' })
    await named.service.speak('好的')
    expect(named.calls[0]).toMatchObject({ voice: 'Microsoft Huihui' })

    const automatic = harness()
    await automatic.service.speak('好的')
    expect(automatic.calls[0]).not.toHaveProperty('voice')
  })

  it('interrupts the previous utterance before starting the next one', async () => {
    const h = pendingHarness()
    const first = h.service.speak('第一段')
    expect(h.calls.map((call) => call.text)).toEqual(['第一段'])
    expect(h.service.speaking()).toBe(true)

    const second = h.service.speak('第二段')
    expect(h.calls.map((call) => call.text)).toEqual(['第一段', '第二段'])
    // The old read-out was stopped: its bridge call was cancelled before the
    // new one started, which is what makes two voices never overlap.
    expect(h.signals[0]?.aborted).toBe(true)
    expect(h.signals[1]?.aborted).toBe(false)

    h.settling[0]({ ok: false, error: 'cancelled' })
    h.settling[1]({ ok: true })
    await expect(first).resolves.toEqual({ spoken: 0, skipped: true })
    await expect(second).resolves.toEqual({ spoken: 3, skipped: false })
    expect(h.service.speaking()).toBe(false)
  })

  it('surfaces a runner failure with its reason and logs it', async () => {
    const h = harness(async () => ({ ok: false, error: 'no audio device' }))
    await expect(h.service.speak('你好')).rejects.toThrow('朗读失败：no audio device')
    expect(h.logs.join('\n')).toContain('no audio device')
    expect(h.service.speaking()).toBe(false)
  })

  it('wraps a thrown runner error in the same message', async () => {
    const h = harness(async () => { throw new Error('powershell.exe is missing') })
    await expect(h.service.speak('你好')).rejects.toThrow('朗读失败：powershell.exe is missing')
    expect(h.logs.join('\n')).toContain('powershell.exe is missing')
  })

  it('reports a failure without a reason instead of throwing a bare error', async () => {
    const h = harness(async () => ({ ok: false }))
    await expect(h.service.speak('你好')).rejects.toThrow('朗读失败：unknown')
  })
})

describe('SpeechService.stop', () => {
  it('is safe when nothing is speaking', () => {
    const h = harness()
    expect(() => h.service.stop()).not.toThrow()
    expect(() => h.service.stop()).not.toThrow()
    expect(h.service.speaking()).toBe(false)
    expect(h.calls).toEqual([])
  })

  it('cancels the live read-out without throwing', async () => {
    const h = pendingHarness()
    const speaking = h.service.speak('一段很长的话')
    expect(h.service.speaking()).toBe(true)
    expect(() => h.service.stop()).not.toThrow()
    expect(h.service.speaking()).toBe(false)
    expect(h.signals[0]?.aborted).toBe(true)
    h.settling[0]({ ok: false, error: 'cancelled' })
    // A stop the user asked for is not a failure to report back.
    await expect(speaking).resolves.toEqual({ spoken: 0, skipped: true })
    expect(h.logs.join('\n')).toContain('interrupted')
  })
})

describe('SpeechService.voices', () => {
  it('lists the installed voices', async () => {
    const h = harness(async () => ({ ok: true, voices: ['Microsoft Huihui', ' Microsoft Kangkang ', ''] }))
    await expect(h.service.voices()).resolves.toEqual(['Microsoft Huihui', 'Microsoft Kangkang'])
    expect(h.calls).toEqual([{ action: 'voices' }])
  })

  it('answers with an empty list when the synthesizer is unavailable', async () => {
    const failed = harness(async () => ({ ok: false, error: 'System.Speech is not installed' }))
    await expect(failed.service.voices()).resolves.toEqual([])
    expect(failed.logs.join('\n')).toContain('System.Speech is not installed')

    const broken = harness(async () => { throw new Error('bridge died') })
    await expect(broken.service.voices()).resolves.toEqual([])
    expect(broken.logs.join('\n')).toContain('bridge died')
  })
})

describe('SpeechService settings', () => {
  it('treats a settings object without a tts block as switched off', async () => {
    const calls: SpeechRequest[] = []
    const service = new SpeechService({
      settings: () => ({}),
      run: async (request) => { calls.push(request); return { ok: true } },
      log: () => undefined
    })
    await expect(service.speak('你好')).resolves.toEqual({ spoken: 0, skipped: true })
    expect(calls).toEqual([])
  })

  it('normalizes an out-of-range settings file before speaking', async () => {
    const h = harness(async () => ({ ok: true }), { rate: 99, volume: -20 })
    await h.service.speak('你好')
    expect(h.calls[0]).toMatchObject({ rate: 10, volume: 0 })
  })
})

describe('createWindowsSpeechRunner', () => {
  it('builds a runner without spawning anything', () => {
    // Only the shape is unit-checkable here; the bridge itself is the part that
    // needs a real powershell.exe and is exercised by hand.
    const run = createWindowsSpeechRunner('resources/speech.ps1')
    expect(typeof run).toBe('function')
  })
})

describe('normalizeTtsSettings', () => {
  it('defaults, clamps and rounds every field', () => {
    expect(normalizeTtsSettings(undefined)).toEqual(DEFAULT_TTS_SETTINGS)
    expect(normalizeTtsSettings({})).toEqual(DEFAULT_TTS_SETTINGS)
    expect(normalizeTtsSettings({ enabled: 'yes', rate: 99, volume: -5, voice: '  Microsoft Huihui  ' }))
      .toEqual({ enabled: false, voice: 'Microsoft Huihui', rate: 10, volume: 0 })
    expect(normalizeTtsSettings({ enabled: true, rate: -12.6, volume: 140, voice: 7 }))
      .toEqual({ enabled: true, voice: '', rate: -10, volume: 100 })
    expect(normalizeTtsSettings({ enabled: true, rate: '4', volume: '48' }))
      .toEqual({ enabled: true, voice: '', rate: 4, volume: 48 })
  })
})

describe('speechText', () => {
  it('strips markdown scaffolding from headings, lists, quotes, emphasis and code', () => {
    expect(speechText('# 标题\n- **粗体**\n> 引用\n`代码`')).toBe('标题 粗体 引用 代码')
    expect(speechText('1. 第一步\n2) 第二步\n- [x] 第三步')).toBe('第一步 第二步 第三步')
  })

  it('drops table walls and separator rows', () => {
    expect(speechText('| 名称 | 值 |\n|---|---|\n| 甲 | 乙 |')).toBe('名称 值 甲 乙')
  })

  it('keeps link text but removes the URLs', () => {
    expect(speechText('请看[文档](https://example.com/doc)或 https://example.com/a，然后继续。'))
      .toBe('请看文档或，然后继续。')
    expect(speechText('访问 www.example.com 即可')).toBe('访问 即可')
  })

  it('removes code fences entirely', () => {
    expect(speechText('运行这段：\n```ts\nconst a = 1\n```\n然后重启。')).toBe('运行这段： 然后重启。')
  })

  it('keeps Chinese sentence punctuation because the synthesizer pauses on it', () => {
    expect(speechText('好的、这样？行。')).toBe('好的、这样？行。')
  })

  it('collapses repeated punctuation and extra whitespace', () => {
    expect(speechText('太棒了！！！   真的吗？？\n\n好的。')).toBe('太棒了！ 真的吗？ 好的。')
  })

  it('cuts a long message at the last sentence boundary', () => {
    expect(speechText('第一句很短。第二句话也不长。第三句话稍微长一点点。', 20))
      .toBe('第一句很短。第二句话也不长。…')
  })

  it('hard-cuts when no sentence ends and never exceeds the limit', () => {
    const dense = '字'.repeat(30)
    const spoken = speechText(dense, 10)
    expect(spoken).toBe(`${'字'.repeat(9)}…`)
    expect(spoken.length).toBe(10)
  })

  it('defaults to the shared character budget', () => {
    const spoken = speechText('a'.repeat(2000))
    expect(spoken.length).toBe(MAX_SPEECH_CHARS)
    expect(spoken.endsWith('…')).toBe(true)
  })

  it('returns nothing for emoji-only input', () => {
    expect(speechText('🎉🎉🚀')).toBe('')
    expect(speechText('👨‍👩‍👧‍👦')).toBe('')
  })

  it('removes emoji and zero-width characters from a sentence', () => {
    const spoken = speechText('你好😀世界\u200B，继续。')
    expect(spoken).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(spoken).toBe('你好 世界，继续。')
  })

  it('returns an empty string for anything that is not text', () => {
    expect(speechText(undefined)).toBe('')
    expect(speechText(null)).toBe('')
    expect(speechText(42)).toBe('')
    expect(speechText({ text: '你好' })).toBe('')
  })
})
