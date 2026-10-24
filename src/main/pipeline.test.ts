import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BarAlert, BarState, HistoryEntry, Settings , ProviderProfile} from '@shared/types'
import { DEFAULT_VOICE_COMMANDS } from '@shared/voiceCommands'
import { mergeSettings } from '@shared/defaults'
import type { PipelineOptions } from './pipeline'
import type { UiaSnapshot } from './uia/reader'

/**
 * The take lifecycle of the real pipeline (REQ-01 / REQ-02 / REQ-03 / REQ-17).
 *
 * The acceptance report's core charge was that `pipeline.ts` — recording start,
 * cancel, failure rows, context injection and the session cap — had no test at
 * all: only the translate branch did. These tests drive the real class through
 * `start()` / `stop()` / `cancel()` and assert on what actually reaches the
 * history store, the bar and the model request.
 *
 * Only the collaborators that touch Win32, Electron windows or the network are
 * mocked (the same harness as `pipeline.translate.test.ts`); every branch inside
 * `Pipeline` — the run-token guard, the `keepAudio` decision, the short/silent
 * gate, the cap arithmetic — runs for real.
 */

const mocks = vi.hoisted(() => ({
  complete: vi.fn(),
  transcribe: vi.fn(),
  insertText: vi.fn(),
  verifyInsertion: vi.fn(),
  generateFromAudio: vi.fn(),
  askAgent: vi.fn(),
  askFollowUp: vi.fn(),
  setBarInteractive: vi.fn(),
  foregroundWindow: vi.fn()
}))

vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn(), readText: vi.fn(() => '') },
  app: { getPath: vi.fn(() => '/tmp/typeless') }
}))
vi.mock('./windows', () => ({ setBarInteractive: mocks.setBarInteractive }))
vi.mock('./insert', () => ({
  insertText: mocks.insertText,
  verifyInsertion: mocks.verifyInsertion,
  insertOk: (ok: boolean, reason?: string) =>
    ok ? 'insert verified' : `insert unverified${reason ? `: ${reason}` : ''}`
}))
vi.mock('./foreground', () => ({
  appLabel: (_appName: string, title: string) => title,
  foregroundWindow: mocks.foregroundWindow
}))
vi.mock('./providers/asr', () => ({ transcribe: mocks.transcribe }))
vi.mock('./providers/llm', async () => {
  const actual = await vi.importActual<typeof import('./providers/llm')>('./providers/llm')
  return { ...actual, complete: mocks.complete }
})
vi.mock('./providers/gemini', () => ({ generateFromAudio: mocks.generateFromAudio }))
vi.mock('./agent', () => ({ askAgent: mocks.askAgent, askFollowUp: mocks.askFollowUp }))
// A pass-through spy: `inferInputAreaType` still runs for real, but the test can
// prove the pipeline handed it the UIA snapshot instead of guessing.
vi.mock('@shared/inputArea', async () => {
  const actual = await vi.importActual<typeof import('@shared/inputArea')>('@shared/inputArea')
  return { ...actual, inferInputAreaType: vi.fn(actual.inferInputAreaType) }
})

const { Pipeline } = await import('./pipeline')
// `Pipeline` imports this mocked binding, so the spy below is the one it calls.
// The module's declared type is the real function, hence `vi.mocked` for the
// `.mock` handle.
const { inferInputAreaType } = await import('@shared/inputArea')
const inferSpy = vi.mocked(inferInputAreaType)

type HistoryContract = ConstructorParameters<typeof Pipeline>[1]

/**
 * The store is the boundary: the pipeline's contract is "what do you write",
 * not "how do you persist it", so a spy is the honest fake here. `entries` is
 * also kept as a plain array so assertions read like the history hub would.
 */
function makeHistory(): {
  store: {
    add: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    saveAudio: ReturnType<typeof vi.fn>
    readAudio: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    latest: ReturnType<typeof vi.fn>
    latestWithStatus: ReturnType<typeof vi.fn>
  }
  entries: HistoryEntry[]
} {
  const entries: HistoryEntry[] = []
  const store = {
    add: vi.fn(async (input: Partial<HistoryEntry>) => {
      const entry = {
        id: `h${entries.length + 1}`,
        createdAt: Date.now(),
        attempts: 0,
        ...input
      } as HistoryEntry
      entries.push(entry)
      return entry
    }),
    update: vi.fn(async (id: string, patch: Partial<HistoryEntry>) => {
      const entry = entries.find((item) => item.id === id)
      if (!entry) return undefined
      Object.assign(entry, patch)
      return entry
    }),
    saveAudio: vi.fn(async (_id: string, _wav: Buffer) => '/tmp/typeless/audio/h1.wav'),
    readAudio: vi.fn(async () => null),
    get: vi.fn(() => undefined),
    latest: vi.fn(() => entries[entries.length - 1]),
    latestWithStatus: vi.fn(() => undefined)
  }
  return { store, entries }
}

const TEST_PROFILES: ProviderProfile[] = [
  {
    id: 'asr-test',
    kind: 'asr',
    name: 'test-asr',
    preset: '',
    baseUrl: 'http://asr.test/v1',
    apiKey: 'test',
    model: 'whisper-1',
    enabled: true
  },
  {
    id: 'llm-test',
    kind: 'llm',
    name: 'test-llm',
    preset: '',
    baseUrl: 'http://llm.test/v1',
    apiKey: 'test',
    model: 'test-model',
    enabled: true
  }
]

function makeSettings(overrides: Partial<Settings>): Settings {
  // Connections live only in saved profiles now, and an empty chain is a hard
  // "not configured" state, so every fixture supplies one per kind it uses.
  return mergeSettings({
    language: 'zh',
    liveCaptions: false,
    voiceCommands: { ...DEFAULT_VOICE_COMMANDS, smartRouting: false },
    profiles: TEST_PROFILES,
    chains: { asr: ['asr-test'], llm: ['llm-test'], multimodal: [] },
    ...overrides
  })
}

function harness(
  overrides: Partial<Settings>,
  options: PipelineOptions = {},
  Ctor: typeof Pipeline = Pipeline
): {
  pipeline: InstanceType<typeof Pipeline>
  store: ReturnType<typeof makeHistory>['store']
  entries: HistoryEntry[]
  sent: BarState[]
  send: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
  settings: Settings
} {
  const { store, entries } = makeHistory()
  const sent: BarState[] = []
  const send = vi.fn((channel: string, state: BarState) => {
    if (channel === 'bar:state') sent.push(state)
  })
  const barWindow = {
    webContents: { send },
    isDestroyed: () => false,
    isVisible: () => false,
    showInactive: vi.fn(),
    hide: vi.fn()
  }
  const settings = makeSettings(overrides)
  const log = vi.fn()
  const pipeline = new Ctor(
    () => settings,
    // The store is a spy by design (see `makeHistory`); the class only ever
    // talks to the `HistoryStore` contract.
    store as unknown as HistoryContract,
    // A structural Electron window would need a real BrowserWindow; the
    // pipeline only calls the five members above.
    (() => barWindow) as unknown as () => BrowserWindow,
    log,
    options
  )
  return { pipeline, store, entries, sent, send, log, settings }
}

function alerts(sent: BarState[]): Array<Extract<BarState, { phase: 'alert' }>> {
  return sent.filter((state): state is Extract<BarState, { phase: 'alert' }> => state.phase === 'alert')
}

function alertOf(sent: BarState[], kind: string): BarAlert | undefined {
  return alerts(sent).find((state) => state.alert.kind === kind)?.alert
}

/** PCM16 tone at the pipeline's 16 kHz: `ms` of audible speech. */
function tone(ms: number): Int16Array {
  const samples = Math.round((ms / 1000) * 16000)
  const pcm = new Int16Array(samples)
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(6000 * Math.sin((2 * Math.PI * 440 * i) / 16000))
  }
  return pcm
}

/** PCM16 zeros: below `isSilent`'s loud-sample ratio. */
function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((ms / 1000) * 16000))
}

function snapshot(overrides: Partial<UiaSnapshot> = {}): UiaSnapshot {
  return {
    controlType: 'edit',
    controlTypeId: 50030,
    className: 'Edit',
    automationId: '',
    name: '',
    value: '前面的话',
    valueTruncated: false,
    readOnly: false,
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.foregroundWindow.mockReturnValue({ title: 'Editor', className: 'code', appName: '', pid: 0 })
  mocks.transcribe.mockResolvedValue({ text: '你好世界', model: 'whisper-1' })
  mocks.complete.mockResolvedValue('你好世界')
  mocks.insertText.mockResolvedValue(undefined)
  // Insertion read-back is another task's surface; here it always confirms.
  mocks.verifyInsertion.mockResolvedValue({ ok: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('Ask card completion', () => {
  it('stops early with a useful error when the ASR service is unavailable', async () => {
    const { pipeline, sent } = harness({}, { checkAsr: async () => { throw Error('请先启动本地 ASR 服务') } })
    pipeline.start('dictation')
    await vi.waitFor(() => expect(pipeline.isBusy).toBe(false))
    expect(alerts(sent).at(-1)?.alert.text).toContain('请先启动')
    expect(mocks.transcribe).not.toHaveBeenCalled()
  })
  it('ignores an old preflight failure after cancel and re-record', async () => {
    let reject!: (error: Error) => void
    const checkAsr = vi.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail })).mockResolvedValue(undefined)
    const { pipeline } = harness({}, { checkAsr })
    pipeline.start('dictation'); pipeline.cancel(); pipeline.start('dictation')
    reject(Error('old failure'))
    await Promise.resolve(); await Promise.resolve()
    expect(pipeline.isRecording).toBe(true); pipeline.cancel()
  })
  it('preserves audio after ASR fails, without adding an abnormal history entry', async () => {
    const preserveAudio = vi.fn(async () => {})
    mocks.transcribe.mockRejectedValue(Error('connect ECONNREFUSED'))
    const { pipeline, sent, entries } = harness({}, { preserveAudio })
    pipeline.start('dictation'); pipeline.pushAudio(tone(900))
    await pipeline.stop()
    expect(preserveAudio).toHaveBeenCalledOnce()
    expect(alerts(sent).at(-1)?.alert.text).toContain('录音已保留到随记')
    expect(entries).toHaveLength(0)
  })
  it('submits wake recordings after speech and silence, but never changes normal shortcut recording', async () => {
    const { pipeline } = harness({})
    const stop = vi.spyOn(pipeline, 'stop').mockResolvedValue(null)
    pipeline.start('dictation', { viaWake: true, handsFree: true })
    pipeline.pushAudio(tone(500)); pipeline.pushAudio(silence(1400))
    expect(stop).toHaveBeenCalledOnce(); pipeline.cancel()
    pipeline.start('dictation'); pipeline.pushAudio(tone(500)); pipeline.pushAudio(silence(2000))
    expect(stop).toHaveBeenCalledOnce(); pipeline.cancel()
  })
  it('stops an Ask request and ignores queued deltas and a late response without writing history', async () => {
    vi.useFakeTimers()
    const onAnswer = vi.fn()
    let resolve!: (value: unknown) => void
    let requestSignal!: AbortSignal
    mocks.askFollowUp.mockImplementation((...args: unknown[]) => {
      requestSignal = args[3] as AbortSignal
      const options = args[5] as { onDelta: (chunk: string) => void }
      options.onDelta('已显示的内容')
      options.onDelta('尚未显示的内容')
      return new Promise(done => { resolve = done })
    })
    const { pipeline, store } = harness({}, { onAnswer })
    const pending = pipeline.followUp('慢回答')
    expect(pipeline.stopAnswer()).toBe(true)
    expect(requestSignal.aborted).toBe(true)
    const frames = onAnswer.mock.calls.length
    resolve({ text: '迟到的回答', sources: [], searched: false })
    await pending
    await vi.advanceTimersByTimeAsync(100)
    expect(onAnswer).toHaveBeenCalledTimes(frames)
    expect(store.add).not.toHaveBeenCalled()
    expect(pipeline.stopAnswer()).toBe(false)
  })

  it('does not cancel dictation or an idle task through the Ask stop action', () => {
    const { pipeline } = harness({})
    expect(pipeline.stopAnswer()).toBe(false)
    pipeline.start('dictation')
    expect(pipeline.stopAnswer()).toBe(false)
    pipeline.cancel()
  })
  it('keeps final retrieval metadata and prevents a queued stream repaint from replacing the final answer', async () => {
    vi.useFakeTimers()
    const onAnswer = vi.fn()
    const retrieval = { searched: true, failed: false, queries: ['AI news', 'AI 模型'], pagesRead: 2, digest: true, partial: false }
    mocks.askFollowUp.mockImplementation(async (...args: unknown[]) => {
      const options = args[5] as { onDelta: (chunk: string) => void }
      options.onDelta('首段')
      options.onDelta('排队中的旧内容')
      return { text: '最终回答', sources: [], searched: true, retrieval }
    })
    const { pipeline } = harness({}, { onAnswer })
    await pipeline.followUp('继续查 AI 新闻')
    await vi.advanceTimersByTimeAsync(100)
    expect(onAnswer).toHaveBeenLastCalledWith(expect.objectContaining({ answer: '最终回答', retrieval }))
    expect(onAnswer.mock.calls.at(-1)?.[0].streaming).not.toBe(true)
  })

  it('ends the card waiting state when a follow-up fails', async () => {
    const onAnswer = vi.fn()
    mocks.askFollowUp.mockRejectedValue(new Error('provider unavailable'))
    const { pipeline } = harness({}, { onAnswer })
    await pipeline.followUp('再详细一点')
    expect(onAnswer).toHaveBeenLastCalledWith(expect.objectContaining({ question: '再详细一点', answer: 'provider unavailable', streaming: false }))
  })
})

describe('caption previews', () => {
  it('uses the available local recognizer without uploading preview audio', async () => {
    vi.useFakeTimers()
    const local = { ready: () => true, transcribeWav: vi.fn(async () => '本地字幕') }
    const { pipeline, send } = harness({ liveCaptions: true,
      localAsr: { ...mergeSettings({}).localAsr, enabled: true } }, { localAsr: local })
    pipeline.start('dictation'); pipeline.pushAudio(tone(2000))
    await vi.advanceTimersByTimeAsync(1800)
    expect(send).toHaveBeenCalledWith('bar:caption', { active: true, text: '本地字幕' })
    expect(local.transcribeWav).toHaveBeenCalledOnce()
    expect(mocks.transcribe).not.toHaveBeenCalled()
    pipeline.discard()
  })
  it('publishes preview text, aborts it on release, and still processes the full recording', async () => {
    vi.useFakeTimers()
    const { pipeline, send, entries } = harness({ liveCaptions: true })
    pipeline.start('dictation')
    pipeline.pushAudio(tone(2000))
    await vi.advanceTimersByTimeAsync(1800)
    expect(send).toHaveBeenCalledWith('bar:caption', { active: true, text: '你好世界' })
    expect(mocks.transcribe.mock.calls[0][1]).toMatchObject({ timeoutMs: 5000, warm: false })
    const previewSignal = mocks.transcribe.mock.calls[0][1].signal as AbortSignal
    const stopping = pipeline.stop()
    pipeline.audioStopped()
    await vi.advanceTimersByTimeAsync(600)
    await stopping
    expect(previewSignal.aborted).toBe(true)
    expect(send).toHaveBeenLastCalledWith('bar:state', expect.anything())
    expect(send).toHaveBeenCalledWith('bar:caption', { active: false, text: '' })
    expect(mocks.transcribe).toHaveBeenCalledTimes(2)
    expect(entries[0]?.status).toBe('completed')
  })
  it('contains a preview failure without failing the final dictation', async () => {
    vi.useFakeTimers()
    const { pipeline, send, entries } = harness({ liveCaptions: true })
    mocks.transcribe.mockRejectedValueOnce(new Error('preview timeout'))
    pipeline.start('dictation')
    pipeline.pushAudio(tone(2000))
    await vi.advanceTimersByTimeAsync(1800)
    expect(send).toHaveBeenCalledWith('bar:caption', { active: true, text: '', unavailable: true })
    const stopping = pipeline.stop(); pipeline.audioStopped()
    await vi.advanceTimersByTimeAsync(600); await stopping
    expect(entries[0]?.status).toBe('completed')
  })
  it('ignores a late old preview after cancellation and honors the off switch', async () => {
    vi.useFakeTimers()
    const { pipeline, send } = harness({ liveCaptions: true })
    let finish!: (value: { text: string }) => void
    mocks.transcribe.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    pipeline.start('dictation'); pipeline.pushAudio(tone(2000))
    await vi.advanceTimersByTimeAsync(1800)
    pipeline.discard(); pipeline.start('dictation')
    finish({ text: '旧会话' })
    await vi.advanceTimersByTimeAsync(0)
    expect(send).not.toHaveBeenCalledWith('bar:caption', { active: true, text: '旧会话' })
    pipeline.discard()
    const off = harness({ liveCaptions: false })
    off.pipeline.start('dictation'); off.pipeline.pushAudio(tone(2000))
    await vi.advanceTimersByTimeAsync(2000)
    expect(mocks.transcribe).toHaveBeenCalledOnce()
    off.pipeline.discard()
  })
})

describe('cancel()', () => {
  it('reports capture, processing and cancellation to the shared recording controls', async () => {
    vi.useFakeTimers()
    const onActivity = vi.fn()
    const { pipeline } = harness({}, { onActivity })
    pipeline.start('dictation')
    expect(onActivity).toHaveBeenLastCalledWith(true, true)
    pipeline.pushAudio(tone(1000))
    const stopped = pipeline.stop()
    expect(onActivity).toHaveBeenLastCalledWith(false, true)
    pipeline.cancel()
    expect(onActivity).toHaveBeenLastCalledWith(false, false)
    await vi.advanceTimersByTimeAsync(1000)
    await stopped
    expect(onActivity).toHaveBeenLastCalledWith(false, false)
  })
  it.each(['never', 'failed', 'always'] as const)('does not write cancelled takes or audio under %s', (keepAudio) => {
    const onRecorded = vi.fn()
    const { pipeline, store, sent } = harness({ keepAudio }, { onRecorded })
    pipeline.start('dictation')
    pipeline.pushAudio(tone(800))
    pipeline.cancel()
    expect(store.add).not.toHaveBeenCalled()
    expect(store.saveAudio).not.toHaveBeenCalled()
    expect(onRecorded).not.toHaveBeenCalled()
    expect(sent.at(-1)).toMatchObject({ phase: 'done', text: '已取消' })
    pipeline.dismissAlert()
  })
})

describe('successful history only', () => {
  it('does not keep a processing take or its late ASR response after cancellation', async () => {
    let release!: (value: { text: string }) => void
    mocks.transcribe.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const { pipeline, store } = harness({ keepAudio: 'always' })
    pipeline.start('dictation'); pipeline.pushAudio(tone(900))
    const done = pipeline.stop(); pipeline.audioStopped()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    pipeline.cancel()
    release({ text: '迟到的结果' })
    expect(await done).toBeNull()
    expect(store.add).not.toHaveBeenCalled()
    expect(store.saveAudio).not.toHaveBeenCalled()
    pipeline.dismissAlert()
  })
  it.each(['asr', 'llm', 'empty', 'insert'] as const)('keeps %s failures out of history and audio but still reports them', async (failure) => {
    const onRecorded = vi.fn()
    const { pipeline, store, sent } = harness({ keepAudio: 'always' }, { onRecorded })
    if (failure === 'asr') mocks.transcribe.mockRejectedValueOnce(new Error('ASR offline'))
    if (failure === 'llm') mocks.complete.mockRejectedValueOnce(new Error('LLM offline'))
    if (failure === 'empty') mocks.complete.mockResolvedValueOnce('   ')
    if (failure === 'insert') mocks.verifyInsertion.mockResolvedValueOnce({ ok: false, reason: 'mismatch' })
    pipeline.start('dictation'); pipeline.pushAudio(tone(900))
    const done = pipeline.stop(); pipeline.audioStopped()
    expect(await done).toBeNull()
    expect(store.add).not.toHaveBeenCalled()
    expect(store.saveAudio).not.toHaveBeenCalled()
    expect(onRecorded).not.toHaveBeenCalled()
    expect(sent.some(state => state.phase === 'alert')).toBe(true)
    expect(alerts(sent).flatMap(state => state.alert.actions ?? []).some(action => action.id === 'retry')).toBe(false)
  })
  it('still saves successful text, provenance, audio and usage when requested', async () => {
    const onRecorded = vi.fn()
    const { pipeline, store, entries } = harness({ keepAudio: 'always' }, { onRecorded })
    pipeline.start('dictation'); pipeline.pushAudio(tone(900))
    const done = pipeline.stop(); pipeline.audioStopped(); await done
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ status: 'completed', final: '你好世界', promptName: expect.any(String) })
    expect(store.saveAudio).toHaveBeenCalledOnce()
    expect(onRecorded).toHaveBeenCalledOnce()
  })
})

describe('reportCaptureError()', () => {
  it('never creates history or audio for a capture failure', async () => {
    const { pipeline, store } = harness({ keepAudio: 'always' })
    pipeline.start('dictation')
    pipeline.pushAudio(tone(800))
    await pipeline.reportCaptureError('decode failed', 'asr_failed')
    expect(pipeline.isRecording).toBe(false)
    expect(pipeline.isBusy).toBe(false)
    expect(store.add).not.toHaveBeenCalled()
    expect(store.saveAudio).not.toHaveBeenCalled()
    expect(mocks.transcribe).not.toHaveBeenCalled()
  })
  it('only logs a missing or denied microphone and writes no history row', async () => {
    const { pipeline, store, log } = harness({})

    await pipeline.reportCaptureError('Requested device not found', 'mic_missing')
    await pipeline.reportCaptureError('Permission denied', 'mic_denied')

    expect(store.add).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('[capture] Requested device not found')
    expect(log).toHaveBeenCalledWith('[capture] Permission denied')
  })

})

describe('busy guard', () => {
  it('surfaces a busy alert instead of silently dropping a press while working', async () => {
    const { pipeline, sent, send, log } = harness({})
    pipeline.start('dictation')
    // `stop()` keeps the stage on `recording` until the renderer confirms the
    // flush — the tail is still accepted as audio — and only then moves to
    // `working`. Resolving the wait here avoids a 500 ms sleep, and the press
    // below lands in the flushing window, which must read as busy rather than as
    // a second take.
    const stopping = pipeline.stop()
    pipeline.audioStopped()
    expect(pipeline.isBusy).toBe(true)

    const before = sent.length
    pipeline.start('dictation')

    // Exactly one state was pushed: the busy alert, not a recording state.
    expect(sent).toHaveLength(before + 1)
    const state = sent[before]!
    expect(state.phase).toBe('alert')
    if (state.phase !== 'alert') throw new Error('expected an alert bar state')
    expect(state.alert.kind).toBe('busy')
    expect(state.alert.level).toBe('info')
    expect(state.alert.text).toBe('上一条还在处理，按 Esc 取消')
    expect(state.alert.actions?.map((action) => action.id)).toEqual(['cancel'])
    // The bar actually received it over `bar:state` (the requirement is about
    // the IPC payload, not just an internal call).
    expect(send).toHaveBeenLastCalledWith('bar:state', state)
    // The press did not start a second take.
    expect(pipeline.isRecording).toBe(false)
    expect(pipeline.isBusy).toBe(true)
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('start dictation (hands-free)'))

    await stopping
  })
})

describe('surrounding-text injection', () => {
  it('reports the real assistant result on the bar without inserting it or opening an Ask card', async () => {
    const onAssistant = vi.fn().mockResolvedValue({ text: '已打开官方网站', failed: false })
    const onAnswer = vi.fn()
    const h = harness({}, { onAssistant, onAnswer })
    h.pipeline.start('ask', { purpose: 'assistant' }); h.pipeline.pushAudio(tone(800))
    const stopping = h.pipeline.stop(); h.pipeline.audioStopped(); await stopping
    expect(h.sent.at(-1)).toMatchObject({ phase: 'done', text: '已打开官方网站', feedback: { failed: false }, taskLabel: 'AI 助手' })
    expect(onAnswer).not.toHaveBeenCalled(); expect(mocks.insertText).not.toHaveBeenCalled()
    expect(h.entries).toEqual([])
  })

  it('delivers assistant voice through the existing ASR without UIA, polish, insertion, cards or voice history', async () => {
    const readContext = vi.fn(), onAssistant = vi.fn(async () => {}), onAnswer = vi.fn()
    const { pipeline, entries, sent } = harness({}, { readContext, onAssistant, onAnswer })
    pipeline.start('ask', { handsFree: true, purpose: 'assistant' })
    pipeline.pushAudio(tone(800))
    expect(sent.some(state => state.phase === 'recording' && state.taskLabel === 'AI 助手')).toBe(true)
    const stopping = pipeline.stop(); pipeline.audioStopped(); await stopping
    expect(onAssistant).toHaveBeenCalledWith('你好世界', expect.any(AbortSignal), expect.any(Number), expect.objectContaining({ appName: 'code', windowTitle: 'Editor' }), undefined)
    expect(mocks.transcribe).toHaveBeenCalledOnce()
    expect(readContext).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.askAgent).not.toHaveBeenCalled()
    expect(mocks.insertText).not.toHaveBeenCalled()
    expect(onAnswer).not.toHaveBeenCalled()
    expect(entries).toEqual([])
  })

  it('does not deliver a cancelled assistant recording or a failed ASR result', async () => {
    const onAssistant = vi.fn(async () => {})
    const { pipeline, entries, sent } = harness({}, { onAssistant })
    pipeline.start('ask', { purpose: 'assistant' }); pipeline.pushAudio(tone(800)); pipeline.cancel()
    expect(onAssistant).not.toHaveBeenCalled()
    pipeline.start('ask', { purpose: 'assistant' }); pipeline.pushAudio(tone(800))
    mocks.transcribe.mockRejectedValueOnce(Error('ASR offline'))
    const stopping = pipeline.stop(); pipeline.audioStopped(); await stopping
    expect(onAssistant).not.toHaveBeenCalled()
    expect(entries).toEqual([])
    expect(alerts(sent).flatMap(state => state.alert.actions ?? []).some(action => action.id === 'retry')).toBe(false)
  })

  it('hands the complete vendor ASR configuration to the provider', async () => {
    const profile = { ...TEST_PROFILES[0], asrAdapter: 'azure', requestPath: '/custom/transcribe', vendor: { deployment: 'speech' } }
    const { pipeline } = harness({ profiles: [profile, TEST_PROFILES[1]] })
    pipeline.start('dictation')
    pipeline.pushAudio(tone(800))
    const stopping = pipeline.stop()
    pipeline.audioStopped()
    await stopping
    expect(mocks.transcribe.mock.calls[0][0]).toMatchObject({
      asrAdapter: 'azure', requestPath: '/custom/transcribe', vendor: { deployment: 'speech' }
    })
  })

  it('passes the UIA snapshot into the polish prompt', async () => {
    const readContext = vi.fn(async (): Promise<UiaSnapshot | null> => snapshot())
    const { pipeline, entries } = harness({}, { readContext })

    pipeline.start('dictation')
    pipeline.pushAudio(tone(800))
    const stopping = pipeline.stop()
    pipeline.audioStopped()
    await stopping

    expect(entries[0]?.status).toBe('completed')
    expect(readContext).toHaveBeenCalledTimes(1)
    expect(mocks.complete).toHaveBeenCalledTimes(1)
    const request = mocks.complete.mock.calls[0]![1] as {
      messages: { role: string; content: string }[]
    }
    const system = request.messages[0]!.content
    // The pipeline fed the snapshot itself to the classifier (not its own guess)…
    expect(inferSpy).toHaveBeenCalledTimes(1)
    expect(inferSpy).toHaveBeenCalledWith({
      controlType: 'edit',
      className: 'Edit',
      appName: 'code Editor',
      readOnly: false
    })
    // …which classifies `Edit` as the edit register…
    expect(inferSpy.mock.results[0]!.value).toBe('edit')
    // …and the value / register reach the prompt verbatim:
    // `inputAreaType: 'edit'` renders as 编辑器, `textBefore` as the quoted line.
    // The label says the caret position is unknown, because the Windows reader
    // returns the whole field value — claiming "光标前的文字" would be a lie the
    // model cannot check.
    expect(system).toContain('- 输入区域：编辑器')
    expect(system).toContain('该输入框的已有文字（光标位置未知')
    expect(system).toContain('<<<前面的话>>>')
  })

  it('never calls readContext when TYPELESS_CONTEXT=off', async () => {
    // `CONTEXT_ENABLED` is a module-level constant, so the kill switch can only
    // be observed on a freshly imported module: hence stubEnv + resetModules +
    // a dynamic import instead of reusing the class imported at the top.
    vi.stubEnv('TYPELESS_CONTEXT', 'off')
    vi.resetModules()
    try {
      const { Pipeline: FreshPipeline } = await import('./pipeline')
      const readContext = vi.fn(async (): Promise<UiaSnapshot | null> => snapshot())
      const { pipeline, entries } = harness({}, { readContext }, FreshPipeline)

      pipeline.start('dictation')
      pipeline.pushAudio(tone(800))
      const stopping = pipeline.stop()
      pipeline.audioStopped()
      await stopping

      expect(entries[0]?.status).toBe('completed')
      expect(readContext).not.toHaveBeenCalled()
      const request = mocks.complete.mock.calls[0]![1] as {
        messages: { role: string; content: string }[]
      }
      const system = request.messages[0]!.content
      expect(system).not.toContain('- 光标前的已有文字：')
      expect(system).not.toContain('- 输入区域：')
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})

describe('session cap', () => {
  /** The two timers are private state by design; runtime access is enough. */
  function capTimers(pipeline: InstanceType<typeof Pipeline>): {
    capTimer: NodeJS.Timeout | null
    capWarnTimer: NodeJS.Timeout | null
  } {
    return pipeline as unknown as {
      capTimer: NodeJS.Timeout | null
      capWarnTimer: NodeJS.Timeout | null
    }
  }

  it('warns at 8 s for a 10 s cap, i.e. before the cap rather than after it', async () => {
    vi.useFakeTimers()
    const { pipeline, sent, log } = harness({ maxSessionSeconds: 10 })

    pipeline.start('dictation')
    const timers = capTimers(pipeline)
    expect(timers.capWarnTimer).not.toBeNull()
    expect(timers.capTimer).not.toBeNull()

    vi.advanceTimersByTime(7_999)
    expect(alertOf(sent, 'session_warning')).toBeUndefined()
    expect(pipeline.isRecording).toBe(true)

    vi.advanceTimersByTime(1)
    const warning = alertOf(sent, 'session_warning')
    expect(warning).toBeDefined()
    expect(warning!.level).toBe('warn')
    // 20% of the cap is 2 s here, so the warning says 2 s, not a full minute.
    expect(warning!.text).toBe('2 秒后自动结束')
    // The cap itself has not fired yet: the warning precedes it.
    expect(pipeline.isRecording).toBe(true)

    // Two seconds later the cap stops the take on its own.
    vi.advanceTimersByTime(2_000)
    expect(log).toHaveBeenCalledWith('[pipeline] session cap reached')
    expect(pipeline.isRecording).toBe(false)

    // Let the internal `void this.stop()` finish instead of leaving it pending.
    pipeline.audioStopped()
    await vi.advanceTimersByTimeAsync(600)
  })

  it('warns a full minute before a 600 s cap', () => {
    vi.useFakeTimers()
    const { pipeline, sent } = harness({ maxSessionSeconds: 600 })

    pipeline.start('dictation')
    const timers = capTimers(pipeline)
    expect(timers.capWarnTimer).not.toBeNull()
    expect(timers.capTimer).not.toBeNull()

    vi.advanceTimersByTime(539_999)
    expect(alertOf(sent, 'session_warning')).toBeUndefined()
    expect(pipeline.isRecording).toBe(true)

    vi.advanceTimersByTime(1)
    const warning = alertOf(sent, 'session_warning')
    expect(warning).toBeDefined()
    // The lead is capped at 60 s for a long session: 600 s - 540 s = 60 s.
    expect(warning!.text).toBe('60 秒后自动结束')
    expect(pipeline.isRecording).toBe(true)

    pipeline.cancel()
  })
})

describe('empty takes', () => {
  it('reports a too-short take with the too_short alert and writes no history row', async () => {
    // Fake timers keep the 500 ms stop grace and the detached edit-capture timer
    // from outliving the test.
    vi.useFakeTimers()
    const { pipeline, entries, sent } = harness({ keepAudio: 'failed' })

    pipeline.start('dictation')
    pipeline.pushAudio(tone(120))
    const stopping = pipeline.stop()
    pipeline.audioStopped()
    await stopping

    // Observed branch: `spokenMs < MIN_DURATION_MS` => alert kind `too_short`, the
    // take never reaches ASR, and nothing is filed under 历史记录: a row of
    // silence is not a take the user can look at or retry later.
    expect(entries).toHaveLength(0)
    expect(mocks.transcribe).not.toHaveBeenCalled()

    const alert = alertOf(sent, 'too_short')
    expect(alert).toBeDefined()
    expect(alert!.level).toBe('warn')
    expect(alert!.text).toBe('录音太短了（120 毫秒）')
    expect(alert!.actions?.map((action) => action.id)).toEqual(['dismiss'])
  })

  it('reports an inaudible take as empty_audio without inserting or recording anything', async () => {
    vi.useFakeTimers()
    const { pipeline, entries, sent } = harness({ keepAudio: 'failed' })

    pipeline.start('dictation')
    pipeline.pushAudio(silence(800))
    const stopping = pipeline.stop()
    pipeline.audioStopped()
    await stopping

    // Observed branch: duration passes MIN_DURATION_MS but `isSilent` is true =>
    // alert kind `empty_audio`, no history row, no insertion.
    expect(entries).toHaveLength(0)
    expect(mocks.transcribe).not.toHaveBeenCalled()
    expect(mocks.insertText).not.toHaveBeenCalled()

    const alert = alertOf(sent, 'empty_audio')
    expect(alert).toBeDefined()
    expect(alert!.text).toBe('没有听清任何声音')
  })
})

describe('prompt label uses the request card', () => {
  it('keeps tap-to-talk recording live without replacing the waveform with a hands-free notice', async () => {
    const { pipeline, sent, entries } = harness({})
    pipeline.start('dictation', { handsFree: true })
    pipeline.lockTake()
    expect(pipeline.isRecording).toBe(true)
    expect(sent.every(state => state.phase === 'recording')).toBe(true)
    await finish(pipeline)
    expect(entries[0].status).toBe('completed')
  })
  function library(): Settings['promptLibrary'] {
    const value = structuredClone(mergeSettings({}).promptLibrary)
    value.cards.ai = [{ id: 'dev', name: '代码开发', content: 'CARD_CODE', temperature: 0.2 }]
    value.cards.polish = [
      { id: 'chat', name: '日常聊天', content: 'CARD_CHAT' },
      { id: 'manual', name: '手动卡片', content: 'CARD_MANUAL' }
    ]
    value.cards.translate = [{ id: 'tr', name: '翻译卡片', content: 'CARD_TRANSLATE' }]
    value.active.ai = 'dev'; value.active.polish = 'chat'; value.active.translate = 'tr'
    return value
  }
  async function finish(pipeline: InstanceType<typeof Pipeline>): Promise<void> {
    pipeline.pushAudio(tone(900))
    const stopping = pipeline.stop(); pipeline.audioStopped(); await stopping
  }
  it.each([
    { auto: true, match: 'code', name: '代码开发', content: 'CARD_CODE' },
    { auto: true, match: 'unmatched', name: '日常聊天', content: 'CARD_CHAT' },
    { auto: false, match: 'code', name: '手动卡片', content: 'CARD_MANUAL' }
  ])('honors routing/manual priority: $auto / $match', async ({ auto, match, name, content }) => {
    const { pipeline, sent, entries } = harness({ promptLibrary: library(), autoActivatePrompts: auto,
      mainPromptKind: 'polish', mainPromptCardId: 'manual', appRules: [{ id: 'rule', match, kind: 'ai' }] })
    pipeline.start('dictation')
    expect(sent.at(-1)).toMatchObject({ phase: 'recording', promptName: name })
    expect(mocks.complete).not.toHaveBeenCalled()
    await finish(pipeline)
    expect(mocks.complete).toHaveBeenCalledOnce()
    expect(mocks.complete.mock.calls[0][1].messages[0].content).toContain(content)
    expect(sent.filter(state => state.phase === 'working').every(state => state.promptName === name)).toBe(true)
    expect(entries[0].promptName).toBe(name)
    expect(sent.at(-1)).toMatchObject({ phase: 'done' })
    expect(sent.at(-1)).not.toHaveProperty('promptName')
  })
  it('keeps the opening window for routing when focus changes during recording', async () => {
    const { pipeline, sent } = harness({ promptLibrary: library(), appRules: [{ id: 'rule', match: 'code', kind: 'ai' }] })
    pipeline.start('dictation')
    const reads = mocks.foregroundWindow.mock.calls.length
    mocks.foregroundWindow.mockReturnValue({ title: '微信', className: 'WeChat', appName: '', pid: 2 })
    pipeline.pushAudio(tone(500))
    expect(mocks.foregroundWindow).toHaveBeenCalledTimes(reads)
    expect(sent.at(-1)).toMatchObject({ promptName: '代码开发' })
    await finish(pipeline)
    expect(mocks.complete.mock.calls[0][1].messages[0].content).toContain('CARD_CODE')
  })
  it('applies manual changes at processing time, then shares the exact card snapshot with the request', async () => {
    const { pipeline, settings, sent, entries } = harness({ promptLibrary: library(), autoActivatePrompts: false,
      mainPromptKind: 'polish', mainPromptCardId: 'chat' })
    pipeline.start('dictation')
    expect(sent.at(-1)).toMatchObject({ promptName: '日常聊天' })
    settings.mainPromptCardId = 'manual'
    mocks.transcribe.mockImplementationOnce(async () => {
      Object.assign(settings.promptLibrary.cards.polish[1], { name: '随后修改的名字', content: 'LATER_EDIT' })
      return { text: '你好' }
    })
    await finish(pipeline)
    expect(sent.filter(state => state.phase === 'working').every(state => state.promptName === '手动卡片')).toBe(true)
    expect(mocks.complete.mock.calls[0][1].messages[0].content).toContain('CARD_MANUAL')
    expect(mocks.complete.mock.calls[0][1].messages[0].content).not.toContain('LATER_EDIT')
    expect(entries[0].promptName).toBe('手动卡片')
  })
  it('updates only on an actual task mode change and uses the translate card', async () => {
    const { pipeline, sent } = harness({ promptLibrary: library(), appRules: [{ id: 'r', match: 'code', kind: 'ai' }] })
    pipeline.start('dictation')
    pipeline.upgrade('translate')
    expect(sent.at(-1)).toMatchObject({ mode: 'translate', promptName: '翻译卡片' })
    await finish(pipeline)
    expect(mocks.complete.mock.calls[0][1].messages[0].content).toContain('CARD_TRANSLATE')
  })
  it('omits library cards for pure transcription and for the separate Ask agent', async () => {
    const pure = harness({ promptLibrary: library(), polish: { ...mergeSettings({}).polish, enabled: false } })
    pure.pipeline.start('dictation'); await finish(pure.pipeline)
    expect(pure.sent.filter(s => s.phase === 'recording' || s.phase === 'working').every(s => !s.promptName)).toBe(true)
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(pure.entries[0].promptName).toBeUndefined()
    mocks.askAgent.mockResolvedValueOnce({ text: '回答', sources: [] })
    const ask = harness({ promptLibrary: library() })
    ask.pipeline.start('ask'); await finish(ask.pipeline)
    expect(ask.sent.filter(s => s.phase === 'recording' || s.phase === 'working').every(s => !s.promptName)).toBe(true)
    expect(ask.entries[0].promptName).toBeUndefined()
  })
  it('labels the multimodal card because that request really uses it even with polish off', async () => {
    mocks.generateFromAudio.mockResolvedValueOnce('多模态结果')
    const { pipeline, sent, entries } = harness({ promptLibrary: library(), pipelineMode: 'multimodal',
      polish: { ...mergeSettings({}).polish, enabled: false }, appRules: [{ id: 'r', match: 'code', kind: 'ai' }] })
    pipeline.start('dictation'); await finish(pipeline)
    expect(sent.find(s => s.phase === 'recording')).toMatchObject({ promptName: '代码开发' })
    expect(mocks.generateFromAudio.mock.calls[0][1]).toMatchObject({ prompt: expect.stringContaining('CARD_CODE'), temperature: 0.2 })
    expect(entries[0].promptName).toBe('代码开发')
  })
  it('does not stamp an unused prompt after ASR failure, or carry it into the next take', async () => {
    mocks.transcribe.mockRejectedValueOnce(new Error('ASR offline'))
    const { pipeline, settings, sent, entries } = harness({ promptLibrary: library() })
    pipeline.start('dictation'); await finish(pipeline)
    expect(entries).toHaveLength(0)
    settings.polish.enabled = false
    pipeline.start('dictation')
    expect(sent.at(-1)).toMatchObject({ phase: 'recording', promptName: undefined })
    pipeline.discard()
    settings.polish.enabled = true
    settings.autoActivatePrompts = false; settings.mainPromptKind = 'polish'; settings.mainPromptCardId = 'manual'
    pipeline.start('dictation')
    expect(sent.at(-1)).toMatchObject({ promptName: '手动卡片' })
    pipeline.discard()
  })
  it('cannot overwrite the next task while an old context read finishes after cancellation', async () => {
    let release!: (value: UiaSnapshot | null) => void
    const readContext = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve })).mockResolvedValue(null)
    const { pipeline, settings, sent } = harness({ promptLibrary: library(), autoActivatePrompts: false,
      mainPromptKind: 'polish', mainPromptCardId: 'chat' }, { readContext })
    pipeline.start('dictation'); pipeline.pushAudio(tone(900))
    const old = pipeline.stop(); pipeline.audioStopped()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    pipeline.cancel()
    settings.mainPromptCardId = 'manual'
    pipeline.start('dictation')
    release(null)
    expect(await old).toBeNull()
    expect(sent.at(-1)).toMatchObject({ phase: 'recording', promptName: '手动卡片' })
    expect(mocks.transcribe).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled()
    pipeline.discard()
  })
})

describe('history provenance (REQ-21)', () => {
  it('stamps the entry with the card that produced the text', async () => {
    const { pipeline, entries } = harness({
      appRules: [{ id: 'r1', match: 'code', kind: 'ai' }]
    })
    pipeline.start('dictation')
    pipeline.pushAudio(tone(900))
    const stopping = pipeline.stop()
    pipeline.audioStopped()
    await stopping

    expect(entries).toHaveLength(1)
    const entry = entries[0]
    // The row is only answerable ("why does this read like a coding agent")
    // if the card that ran is stored next to the text.
    expect(entry.promptKind).toBe('ai')
    expect(entry.promptId).toBeTruthy()
    expect(entry.promptName).toBeTruthy()
  })

  it('keeps the card when the next take starts before the row is written', async () => {
    const { pipeline, entries } = harness({
      appRules: [{ id: 'r1', match: 'code', kind: 'ai' }]
    })
    let release: (() => void) | null = null
    mocks.verifyInsertion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true })
        })
    )

    pipeline.start('dictation')
    pipeline.pushAudio(tone(900))
    const stopping = pipeline.stop()
    pipeline.audioStopped()
    // The take is now parked on the insertion read-back, which is where a fast
    // user starts the next sentence.
    await vi.waitFor(() => expect(release).not.toBeNull())
    pipeline.start('dictation')
    release!()
    await stopping

    expect(entries[0].promptKind).toBe('ai')
    expect(entries[0].promptName).toBeTruthy()
  })
})

describe('correction rule hits', () => {
  it('reports each rule that matched the take', async () => {
    const saveRuleHits = vi.fn()
    const { pipeline } = harness(
      { replacements: [{ from: '你好', to: '您好' }] },
      { saveRuleHits }
    )

    pipeline.start('dictation')
    pipeline.pushAudio(tone(800))
    const stopping = pipeline.stop()
    pipeline.audioStopped()
    await stopping

    // "你好世界" went in, "您好世界" came out: the rule fired once, and the
    // counter is reported with the pre-replacement text as the source of truth.
    expect(saveRuleHits).toHaveBeenCalledTimes(1)
    expect(saveRuleHits).toHaveBeenCalledWith({ 你好: 1 })
  })

  it('counts a rule the model already applied to its own output', async () => {
    // Measured bug: the glossary is handed to the model, so it writes the
    // corrected spelling itself and the rule's original never shows up in the
    // result. Counting the result reported zero for a rule that plainly appeared.
    mocks.transcribe.mockResolvedValue({ text: '今天晚上打CSR吗？', model: 'whisper-1' })
    mocks.complete.mockResolvedValue('今天晚上打 CS2 吗？')
    const saveRuleHits = vi.fn()
    const { pipeline } = harness(
      { replacements: [{ from: 'CSR', to: 'CS2' }] },
      { saveRuleHits }
    )

    pipeline.start('dictation')
    pipeline.pushAudio(tone(800))
    const stopping = pipeline.stop()
    pipeline.audioStopped()
    await stopping

    expect(saveRuleHits).toHaveBeenCalledWith({ CSR: 1 })
  })

  it('reports nothing when no rule matched', async () => {
    const saveRuleHits = vi.fn()
    const { pipeline } = harness(
      { replacements: [{ from: '完全没出现的词', to: 'x' }] },
      { saveRuleHits }
    )

    pipeline.start('dictation')
    pipeline.pushAudio(tone(800))
    const stopping = pipeline.stop()
    pipeline.audioStopped()
    await stopping

    expect(saveRuleHits).not.toHaveBeenCalled()
  })

  it('survives a failing counter write', async () => {
    const saveRuleHits = vi.fn(() => {
      throw new Error('disk full')
    })
    const { pipeline, entries } = harness(
      { replacements: [{ from: '你好', to: '您好' }] },
      { saveRuleHits }
    )

    pipeline.start('dictation')
    pipeline.pushAudio(tone(800))
    const stopping = pipeline.stop()
    pipeline.audioStopped()
    await stopping

    // A counter is a nicety: the take still lands as a completed row.
    expect(saveRuleHits).toHaveBeenCalledTimes(1)
    expect(entries[0]?.status).toBe('completed')
  })
})

describe('local speech model routing', () => {
  const localOn = {
    localAsr: { enabled: true, modelId: 'sense-voice-small', modelDir: '', language: 'auto', mirror: 'cn', idleUnloadMinutes: 5 }
  } as const

  const run = async (
    overrides: Partial<Settings>,
    options: PipelineOptions
  ): Promise<ReturnType<typeof harness>> => {
    const built = harness(overrides, options)
    built.pipeline.start('dictation')
    built.pipeline.pushAudio(tone(800))
    const stopping = built.pipeline.stop()
    built.pipeline.audioStopped()
    await stopping
    return built
  }

  it('uses the local transcript and never calls the provider', async () => {
    const transcribeWav = vi.fn(async () => '本地模型听出来的话')
    const { entries } = await run(localOn, {
      localAsr: { ready: () => true, transcribeWav }
    })

    expect(transcribeWav).toHaveBeenCalledTimes(1)
    expect(mocks.transcribe).not.toHaveBeenCalled()
    expect(entries[0].transcript).toBe('本地模型听出来的话')
  })

  it('falls back to the provider when the local model hears nothing', async () => {
    mocks.transcribe.mockResolvedValueOnce({ text: '服务商听出来的话', model: 'whisper-1' })
    const { entries } = await run(localOn, {
      localAsr: { ready: () => true, transcribeWav: vi.fn(async () => '   ') }
    })

    expect(mocks.transcribe).toHaveBeenCalledTimes(1)
    expect(entries[0].transcript).toContain('服务商听出来的话')
  })

  it('falls back when the local model throws, and says why in the log', async () => {
    mocks.transcribe.mockResolvedValueOnce({ text: '服务商听出来的话', model: 'whisper-1' })
    const { entries, log } = await run(localOn, {
      localAsr: {
        ready: () => true,
        transcribeWav: vi.fn(async () => {
          throw new Error('onnx exploded')
        })
      }
    })

    expect(mocks.transcribe).toHaveBeenCalledTimes(1)
    expect(entries[0].transcript).toContain('服务商听出来的话')
    expect(log.mock.calls.some(([line]) => String(line).includes('local model failed'))).toBe(true)
  })

  it('ignores a loaded model while the switch is off', async () => {
    mocks.transcribe.mockResolvedValueOnce({ text: '服务商听出来的话', model: 'whisper-1' })
    const transcribeWav = vi.fn(async () => '不该被用到')
    const { entries } = await run({}, { localAsr: { ready: () => true, transcribeWav } })

    expect(transcribeWav).not.toHaveBeenCalled()
    expect(entries[0].transcript).toContain('服务商听出来的话')
  })
})

describe('selected text editing', () => {
  it('uses the routed prompt and LLM even if dictation polishing is disabled, without audio or history', async () => {
    const { pipeline, entries } = harness({ polish: { enabled: false } as Settings['polish'] })
    mocks.complete.mockResolvedValue('润色结果')
    const result = await pipeline.transformSelection('原文字', 'polish', { appName: 'WeChat', windowTitle: '聊天' })
    expect(result?.text).toBe('润色结果')
    expect(result?.promptName).toBeTruthy()
    expect(mocks.complete.mock.calls[0][1].messages.at(-1).content).toBe('原文字')
    expect(mocks.transcribe).not.toHaveBeenCalled()
    expect(mocks.insertText).not.toHaveBeenCalled()
    expect(entries).toHaveLength(0)
    expect(pipeline.isBusy).toBe(false)
  })
  it('uses translation targets and drops late text after cancellation', async () => {
    const { pipeline } = harness({ translateTarget: 'en' })
    let finish!: (text: string) => void
    mocks.complete.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const task = pipeline.transformSelection('原文', 'translate', { appName: 'Editor' })
    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalled())
    expect(mocks.complete.mock.calls[0][1].messages[0].content).toContain('Target language: en')
    pipeline.cancel('test-selection')
    finish('late translation')
    expect(await task).toBeNull()
    expect(pipeline.isBusy).toBe(false)
  })
})

describe('dedicated voice reminder capture', () => {
  it('anchors relative reminders to recording submission, before ASR or refinement latency', async () => {
    vi.useFakeTimers(); const submittedAt = new Date(2026, 9, 23, 8).getTime(); vi.setSystemTime(submittedAt)
    mocks.transcribe.mockImplementation(async () => { vi.setSystemTime(submittedAt + 30_000); return { text: '20分钟后提醒我打扫卫生' } })
    const onReminder = vi.fn(async () => ({ message: 'saved' })), { pipeline } = harness({}, { onReminder })
    pipeline.start('dictation', { purpose: 'reminder' }); pipeline.pushAudio(tone(1200))
    const done = pipeline.stop(); pipeline.audioStopped(); await done
    expect(onReminder).toHaveBeenCalledWith('20分钟后提醒我打扫卫生', expect.any(AbortSignal), expect.any(Function), submittedAt)
  })
  it('uses ASR then its independent parser, without polish, insertion, Ask or voice history', async () => {
    const onReminder = vi.fn(async () => ({ message: 'Clean up · tomorrow at 10 AM · Normal', undo: true }))
    const { pipeline, store, sent } = harness({}, { onReminder })
    pipeline.start('dictation', { purpose: 'reminder' }); pipeline.pushAudio(tone(1200))
    const done = pipeline.stop(); pipeline.audioStopped(); await done
    expect(mocks.transcribe).toHaveBeenCalledOnce()
    expect(onReminder).toHaveBeenCalledWith('你好世界', expect.any(AbortSignal), expect.any(Function), expect.any(Number))
    expect(mocks.complete).not.toHaveBeenCalled(); expect(mocks.insertText).not.toHaveBeenCalled(); expect(mocks.askAgent).not.toHaveBeenCalled()
    expect(store.add).not.toHaveBeenCalled()
    expect(sent.some(state => state.phase === 'recording' && state.taskLabel === '快速提醒' && !state.promptName)).toBe(true)
    expect(sent.at(-1)).toMatchObject({ phase: 'alert', alert: { kind: 'reminder', actions: [{ id: 'undo-reminder', label: '撤销' }] } })
  })
  it('does not invoke reminder parsing after ASR failure or cancelled recording', async () => {
    const onReminder = vi.fn(async () => ({ message: 'ok' }))
    const { pipeline, store } = harness({}, { onReminder })
    pipeline.start('dictation', { purpose: 'reminder' }); pipeline.pushAudio(tone(1200)); pipeline.cancel()
    await pipeline.stop(); expect(onReminder).not.toHaveBeenCalled()
    mocks.transcribe.mockRejectedValueOnce(new Error('ASR unavailable'))
    pipeline.start('dictation', { purpose: 'reminder' }); pipeline.pushAudio(tone(1200))
    const done = pipeline.stop(); pipeline.audioStopped(); await done
    expect(onReminder).not.toHaveBeenCalled(); expect(store.add).not.toHaveBeenCalled(); expect(mocks.insertText).not.toHaveBeenCalled()
  })
  it('does not insert a reminder when its parser fails and returns to normal dictation on the next take', async () => {
    const onReminder = vi.fn(async () => { throw new Error('bad reminder JSON') })
    const { pipeline, store, sent } = harness({ polish: { enabled: false } as Settings['polish'] }, { onReminder })
    pipeline.start('dictation', { purpose: 'reminder' }); pipeline.pushAudio(tone(1200))
    const first = pipeline.stop(); pipeline.audioStopped(); await first
    expect(store.add).not.toHaveBeenCalled(); expect(mocks.insertText).not.toHaveBeenCalled()
    pipeline.start('dictation'); pipeline.pushAudio(tone(1200))
    expect(sent.at(-1)).toMatchObject({ phase: 'recording', taskLabel: undefined })
    const second = pipeline.stop(); pipeline.audioStopped(); await second
    expect(mocks.insertText).toHaveBeenCalledOnce(); expect(onReminder).toHaveBeenCalledOnce()
  })
})

describe('opening phrase mode activation', () => {
  const commands = (): Settings['voiceCommands'] => ({ ...mergeSettings({}).voiceCommands, enabled: true, smartRouting: false })
  async function finish(pipeline: InstanceType<typeof Pipeline>): Promise<HistoryEntry | null> {
    const task = pipeline.stop(); pipeline.audioStopped(); return task
  }
  it('routes translation from one ASR result and strips only the leading phrase before the actual LLM call', async () => {
    mocks.transcribe.mockResolvedValue({ text: '指令翻译，今天一起吃饭。' })
    const { pipeline, entries, settings } = harness({ voiceCommands: commands(), translateTargets: ['en'] })
    pipeline.start('dictation'); pipeline.pushAudio(tone(1200)); await finish(pipeline)
    expect(mocks.transcribe).toHaveBeenCalledOnce()
    expect(mocks.complete.mock.calls[0][1].messages.at(-1).content).toBe('今天一起吃饭。')
    expect(entries[0]).toMatchObject({ mode: 'translate', transcript: '今天一起吃饭。' })
    const card = settings.promptLibrary.cards.translate.find(card => card.id === settings.promptLibrary.active.translate)
    expect(entries[0]?.promptName).toBe(card?.name)
  })
  it('routes Ask to the existing agent and stores its real mode instead of inserting dictation', async () => {
    mocks.transcribe.mockResolvedValue({ text: 'command ask: What is new?' })
    mocks.askAgent.mockResolvedValue({ text: 'The answer', sources: [], searched: false })
    const { pipeline, entries } = harness({ voiceCommands: commands() })
    pipeline.start('dictation'); pipeline.pushAudio(tone(1200)); await finish(pipeline)
    expect(mocks.transcribe).toHaveBeenCalledOnce()
    expect(mocks.askAgent.mock.calls[0][1]).toBe('What is new?')
    expect(mocks.insertText).not.toHaveBeenCalled()
    expect(entries[0]).toMatchObject({ mode: 'ask', transcript: 'What is new?' })
  })
  it('uses the existing reminder parser without another ASR request, insertion or history', async () => {
    mocks.transcribe.mockResolvedValue({ text: '指令提醒，20分钟后提醒我打扫卫生' })
    const onReminder = vi.fn(async (_text: string) => ({ message: 'saved' }))
    const { pipeline, entries } = harness({ voiceCommands: commands() }, { onReminder })
    pipeline.start('dictation'); pipeline.pushAudio(tone(1200)); await finish(pipeline)
    expect(onReminder).toHaveBeenCalledWith('20分钟后提醒我打扫卫生', expect.any(AbortSignal), expect.any(Function), expect.any(Number))
    expect(mocks.transcribe).toHaveBeenCalledOnce()
    expect(mocks.insertText).not.toHaveBeenCalled()
    expect(entries).toHaveLength(0)
  })
  it('hands notes the same full audio and cleaned transcript without insertion or voice history', async () => {
    mocks.transcribe.mockResolvedValue({ text: '指令笔记：这是灵感' })
    const onVoiceNote = vi.fn(async () => undefined), pcm = tone(1400)
    const { pipeline, entries } = harness({ voiceCommands: commands() }, { onVoiceNote })
    pipeline.start('dictation'); pipeline.pushAudio(pcm); await finish(pipeline)
    expect(onVoiceNote).toHaveBeenCalledWith(pcm, '这是灵感', expect.any(AbortSignal))
    expect(mocks.transcribe).toHaveBeenCalledOnce()
    expect(mocks.insertText).not.toHaveBeenCalled()
    expect(entries).toHaveLength(0)
  })
  it.each(['普通正文里提到指令问答', '“指令翻译”是什么意思？', '指令输入，保留正文里的指令翻译'])('does not reroute words inside the content: %s', async text => {
    mocks.transcribe.mockResolvedValue({ text })
    const { pipeline, entries } = harness({ voiceCommands: commands(), polish: { enabled: false } as Settings['polish'] })
    pipeline.start('dictation'); pipeline.pushAudio(tone(1200)); await finish(pipeline)
    expect(entries[0]?.mode).toBe('dictation')
    expect(entries[0]?.transcript).toBe(text.replace(/^指令输入，/, ''))
    expect(mocks.askAgent).not.toHaveBeenCalled()
  })
  it('keeps phrases literal when disabled and never changes a dedicated translate shortcut', async () => {
    mocks.transcribe.mockResolvedValue({ text: '指令问答，普通正文' })
    const off = harness({ polish: { enabled: false } as Settings['polish'] })
    off.pipeline.start('dictation'); off.pipeline.pushAudio(tone(1200)); await finish(off.pipeline)
    expect(off.entries[0]).toMatchObject({ mode: 'dictation', transcript: '指令问答，普通正文' })
    const direct = harness({ voiceCommands: commands() })
    direct.pipeline.start('translate'); direct.pipeline.pushAudio(tone(1200)); await finish(direct.pipeline)
    expect(direct.entries[0]).toMatchObject({ mode: 'translate', transcript: '指令问答，普通正文' })
    expect(mocks.askAgent).not.toHaveBeenCalled()
  })
  it('leaves the dedicated reminder shortcut in control even when the content starts with another phrase', async () => {
    mocks.transcribe.mockResolvedValue({ text: '指令翻译，20分钟后提醒我' })
    const onReminder = vi.fn(async (_text: string) => ({ message: 'saved' }))
    const { pipeline } = harness({ voiceCommands: commands() }, { onReminder })
    pipeline.start('dictation', { purpose: 'reminder' }); pipeline.pushAudio(tone(1200)); await finish(pipeline)
    expect(onReminder.mock.calls[0][0]).toBe('指令翻译，20分钟后提醒我')
  })
  it.each(['指令提醒。', ''])('never performs an empty or phrase-only task: %s', async text => {
    mocks.transcribe.mockResolvedValue({ text })
    const onReminder = vi.fn(), onVoiceNote = vi.fn()
    const { pipeline, entries, sent } = harness({ voiceCommands: commands() }, { onReminder, onVoiceNote })
    pipeline.start('dictation'); pipeline.pushAudio(tone(1200)); await finish(pipeline)
    expect(mocks.transcribe).toHaveBeenCalledOnce()
    expect(mocks.complete).not.toHaveBeenCalled(); expect(mocks.askAgent).not.toHaveBeenCalled()
    expect(onReminder).not.toHaveBeenCalled(); expect(onVoiceNote).not.toHaveBeenCalled()
    expect(entries).toHaveLength(0)
    expect(pipeline.isBusy).toBe(false)
    if (text) expect(sent.at(-1)).toMatchObject({ phase: 'alert', alert: { level: 'info', text: '请在关键词后继续说出内容' } })
  })
  it('updates the voice bar during recording with captions disabled and confirms using the final transcript', async () => {
    vi.useFakeTimers()
    mocks.transcribe.mockResolvedValue({ text: '指令翻译，今天去吃饭' })
    const { pipeline, sent, send } = harness({ voiceCommands: commands(), liveCaptions: false })
    pipeline.start('dictation'); pipeline.pushAudio(tone(2000))
    await vi.advanceTimersByTimeAsync(1800)
    expect(pipeline.isRecording).toBe(true)
    expect(sent.at(-1)).toMatchObject({ phase: 'recording', mode: 'translate', promptName: expect.any(String) })
    expect(send.mock.calls.some(([channel, value]) => channel === 'bar:caption' && value.active)).toBe(false)
    const done = finish(pipeline); await vi.advanceTimersByTimeAsync(600); await done
    expect(mocks.transcribe).toHaveBeenCalledTimes(2)
    expect(mocks.complete.mock.calls[0][1].messages.at(-1).content).toBe('今天去吃饭')
  })
  it('ignores silent DC input, trims the lead-in and preserves a recognized mode through incomplete previews', async () => {
    vi.useFakeTimers()
    mocks.transcribe.mockResolvedValueOnce({ text: '指令提醒，二十分钟后打扫卫生' })
      .mockResolvedValueOnce({ text: '二十分钟后打扫卫生' })
      .mockResolvedValue({ text: '指令提醒，二十分钟后打扫卫生' })
    const onReminder = vi.fn(async () => ({ message: 'saved' }))
    const { pipeline, sent, entries } = harness({ voiceCommands: commands(), liveCaptions: true }, { onReminder })
    pipeline.start('dictation'); pipeline.pushAudio(new Int16Array(16000 * 12).fill(350))
    await vi.advanceTimersByTimeAsync(12000)
    expect(mocks.transcribe).not.toHaveBeenCalled()
    pipeline.pushAudio(tone(2000)); await vi.advanceTimersByTimeAsync(1000)
    expect(sent.at(-1)).toMatchObject({ phase: 'recording', taskLabel: '快速提醒' })
    pipeline.pushAudio(tone(1000)); await vi.advanceTimersByTimeAsync(1000)
    expect(sent.at(-1)).toMatchObject({ phase: 'recording', taskLabel: '快速提醒' })
    const done = finish(pipeline); await vi.advanceTimersByTimeAsync(600); await done
    expect(onReminder).toHaveBeenCalledWith('二十分钟后打扫卫生', expect.any(AbortSignal), expect.any(Function), expect.any(Number))
    const wav = mocks.transcribe.mock.calls.at(-1)![1].wav
    expect(wav.length).toBeLessThan(44 + 16000 * 4 * 2)
    expect(entries).toHaveLength(0)
  })
  it.each([['指令提醒', '快速提醒'], ['指令笔记', '随记']])('shows %s as the live task label without a fake polishing card', async (phrase, label) => {
    vi.useFakeTimers()
    mocks.transcribe.mockResolvedValue({ text: `${phrase}，正文` })
    const { pipeline, sent } = harness({ voiceCommands: commands(), liveCaptions: true })
    pipeline.start('dictation'); pipeline.pushAudio(tone(2000)); await vi.advanceTimersByTimeAsync(1800)
    expect(sent.at(-1)).toMatchObject({ phase: 'recording', taskLabel: label, promptName: undefined })
    pipeline.cancel()
  })
  it('corrects a mistaken live preview and resets mode for the next recording', async () => {
    vi.useFakeTimers()
    mocks.transcribe.mockResolvedValueOnce({ text: '指令问答，新闻' }).mockResolvedValue({ text: '今天一起吃饭' })
    const { pipeline, sent, entries } = harness({ voiceCommands: commands() })
    pipeline.start('dictation'); pipeline.pushAudio(tone(2000)); await vi.advanceTimersByTimeAsync(1800)
    expect(sent.at(-1)).toMatchObject({ phase: 'recording', mode: 'ask' })
    const done = finish(pipeline); await vi.advanceTimersByTimeAsync(600); await done
    expect(entries[0]).toMatchObject({ mode: 'dictation', transcript: '今天一起吃饭' })
    expect(mocks.askAgent).not.toHaveBeenCalled()
    pipeline.start('dictation')
    expect(sent.at(-1)).toMatchObject({ phase: 'recording', mode: 'dictation', taskLabel: undefined })
    pipeline.cancel()
  })
  it('does not treat the beginning of a later sliding caption window as the beginning of the task', async () => {
    vi.useFakeTimers()
    mocks.transcribe.mockResolvedValueOnce({ text: '普通正文' }).mockResolvedValue({ text: '指令问答，出现在正文中' })
    const { pipeline, sent } = harness({ voiceCommands: commands(), liveCaptions: true })
    pipeline.start('dictation'); pipeline.pushAudio(tone(2000)); await vi.advanceTimersByTimeAsync(1800)
    pipeline.pushAudio(tone(6000)); await vi.advanceTimersByTimeAsync(1800)
    expect(sent.filter(state => state.phase === 'recording').at(-1)).toMatchObject({ mode: 'dictation' })
    pipeline.cancel()
  })
  it('uses explicit shortcut mode changes over keyword routing and snapshots keywords for one take', async () => {
    mocks.transcribe.mockResolvedValue({ text: '指令问答，新闻' })
    const first = harness({ voiceCommands: commands() })
    first.pipeline.start('dictation'); first.pipeline.upgrade('translate'); first.pipeline.pushAudio(tone(1200)); await finish(first.pipeline)
    expect(first.entries[0]?.mode).toBe('translate')
    expect(first.entries[0]?.transcript).toBe('指令问答，新闻')
    mocks.askAgent.mockResolvedValue({ text: 'answer', sources: [], searched: false })
    const second = harness({ voiceCommands: commands() })
    second.pipeline.start('dictation'); second.settings.voiceCommands.enabled = false
    second.pipeline.pushAudio(tone(1200)); await finish(second.pipeline)
    expect(second.entries[0]?.mode).toBe('ask')
  })
  it('uses the multimodal provider for transcription once, then sends the cleaned text to the existing text chain', async () => {
    mocks.generateFromAudio.mockResolvedValue('command translate: Hello world')
    const { pipeline, entries } = harness({ voiceCommands: commands(), pipelineMode: 'multimodal',
      profiles: [...TEST_PROFILES, { ...TEST_PROFILES[0]!, id: 'mm', kind: 'multimodal' }],
      chains: { asr: [], llm: ['llm-test'], multimodal: ['mm'] } })
    pipeline.start('dictation'); pipeline.pushAudio(tone(1200)); await finish(pipeline)
    expect(mocks.generateFromAudio).toHaveBeenCalledOnce()
    expect(mocks.transcribe).not.toHaveBeenCalled()
    expect(mocks.complete.mock.calls[0][1].messages.at(-1).content).toBe('Hello world')
    expect(entries[0]).toMatchObject({ mode: 'translate', transcript: 'Hello world', route: 'multimodal' })
  })
  it('updates the live mode through the existing multimodal provider when no ASR profile is configured', async () => {
    vi.useFakeTimers()
    mocks.generateFromAudio.mockResolvedValue('command note: An idea')
    const { pipeline, sent } = harness({ voiceCommands: commands(), pipelineMode: 'multimodal', liveCaptions: false,
      profiles: [...TEST_PROFILES.filter(profile => profile.kind !== 'asr'), { ...TEST_PROFILES[0]!, id: 'mm', kind: 'multimodal' }],
      chains: { asr: [], llm: ['llm-test'], multimodal: ['mm'] } })
    pipeline.start('dictation'); pipeline.pushAudio(tone(2000)); await vi.advanceTimersByTimeAsync(1800)
    expect(mocks.generateFromAudio).toHaveBeenCalledOnce()
    expect(mocks.transcribe).not.toHaveBeenCalled()
    expect(sent.at(-1)).toMatchObject({ phase: 'recording', taskLabel: '随记', promptName: undefined })
    pipeline.cancel()
  })
})


describe('unified voice entry', () => {
  const smart = { ...DEFAULT_VOICE_COMMANDS, smartRouting: true }
  const finish = async (pipeline: InstanceType<typeof Pipeline>): Promise<HistoryEntry | null> => {
    pipeline.pushAudio(tone(1200)); const pending = pipeline.stop(); pipeline.audioStopped(); return pending
  }
  it.each([true, false])('reuses the intent classification context decision without another model request: %s', async useContext => {
    mocks.transcribe.mockResolvedValue({ text: '再详细一点' })
    mocks.complete.mockResolvedValueOnce(JSON.stringify({ kind: 'assistant', useContext }))
    const onAssistant = vi.fn().mockResolvedValue({ text: 'Actual answer' })
    const h = harness({ voiceCommands: smart }, { onAssistant })
    h.pipeline.start('dictation'); await finish(h.pipeline)
    expect(onAssistant.mock.calls[0][4]).toBe(useContext)
    expect(mocks.complete).toHaveBeenCalledOnce(); expect(mocks.transcribe).toHaveBeenCalledOnce()
    expect(mocks.insertText).not.toHaveBeenCalled(); expect(h.entries).toEqual([])
  })
  it.each(['明天提醒我上午十点去银行办一张银行卡。', 'Remind me in twenty minutes to clean up.'])('reuses reminder parsing, audio and cancellation without inserting a command: %s', async text => {
    mocks.transcribe.mockResolvedValue({ text })
    const onReminder = vi.fn().mockResolvedValue({ message: 'saved', undo: true })
    const h = harness({ voiceCommands: smart }, { onReminder })
    h.pipeline.start('dictation'); await finish(h.pipeline)
    expect(onReminder).toHaveBeenCalledWith(text, expect.any(AbortSignal), expect.any(Function), expect.any(Number))
    expect(mocks.transcribe).toHaveBeenCalledOnce(); expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.insertText).not.toHaveBeenCalled(); expect(h.entries).toHaveLength(0)
    expect(h.sent.at(-1)).toMatchObject({ phase: 'alert', alert: { actions: [{ id: 'undo-reminder', label: '撤销' }] } })
    expect(h.sent).toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'working', taskLabel: '快速提醒' })]))
  })
  it('answers ordinary questions through the real Ask branch and keeps its history/card', async () => {
    mocks.transcribe.mockResolvedValue({ text: '为什么天空是蓝色的？' })
    mocks.complete.mockResolvedValueOnce('{"kind":"ask"}')
    mocks.askAgent.mockResolvedValue({ text: '散射的原因。', sources: [], searched: false })
    const onAnswer = vi.fn(), h = harness({ voiceCommands: smart }, { onAnswer })
    h.pipeline.start('dictation'); await finish(h.pipeline)
    expect(mocks.askAgent.mock.calls[0][1]).toBe('为什么天空是蓝色的？')
    expect(onAnswer).toHaveBeenCalled(); expect(mocks.insertText).not.toHaveBeenCalled()
    expect(h.entries[0]).toMatchObject({ mode: 'ask', final: '散射的原因。' })
  })
  it('opens the assistant with the original system request and no duplicate ASR', async () => {
    mocks.transcribe.mockResolvedValue({ text: '帮我打开卡巴斯基的官方网站' })
    mocks.complete.mockResolvedValueOnce('{"kind":"assistant"}')
    const onAssistant = vi.fn().mockResolvedValue(undefined), h = harness({ voiceCommands: smart }, { onAssistant })
    h.pipeline.start('dictation'); await finish(h.pipeline)
    expect(onAssistant).toHaveBeenCalledWith('帮我打开卡巴斯基的官方网站', expect.any(AbortSignal), expect.any(Number), expect.objectContaining({ appName: 'code', windowTitle: 'Editor' }), undefined)
    expect(mocks.transcribe).toHaveBeenCalledOnce(); expect(mocks.insertText).not.toHaveBeenCalled()
    expect(h.entries).toHaveLength(0); expect(h.pipeline.isBusy).toBe(false)
  })
  it('translates only the content and never persists a spoken target language', async () => {
    mocks.transcribe.mockResolvedValue({ text: '帮我翻译成英语，今天晚上我们一起去吃烧烤吧。' })
    mocks.complete.mockResolvedValueOnce('{"kind":"translate","text":"今天晚上我们一起去吃烧烤吧。","target":"en"}').mockResolvedValueOnce('Let us have barbecue tonight.')
    const h = harness({ voiceCommands: smart, translateTarget: 'ja', translateTargets: ['ja'] })
    h.pipeline.start('dictation'); await finish(h.pipeline)
    const request = mocks.complete.mock.calls[1][1]
    expect(request.messages.at(-1).content).toBe('今天晚上我们一起去吃烧烤吧。')
    expect(request.messages[0].content).toContain('Target language: en')
    expect(h.settings.translateTargets).toEqual(['ja'])
    expect(h.entries[0]).toMatchObject({ mode: 'translate', transcript: '今天晚上我们一起去吃烧烤吧。' })
  })
  it('keeps the source recording when creating a voice note', async () => {
    mocks.transcribe.mockResolvedValue({ text: '帮我保存到随记：明天研究这个问题。' })
    const onVoiceNote = vi.fn().mockResolvedValue(undefined), h = harness({ voiceCommands: smart }, { onVoiceNote })
    h.pipeline.start('dictation'); await finish(h.pipeline)
    expect(onVoiceNote).toHaveBeenCalledWith(expect.any(Int16Array), '明天研究这个问题。', expect.any(AbortSignal))
    expect(mocks.transcribe).toHaveBeenCalledOnce(); expect(mocks.complete).not.toHaveBeenCalled(); expect(h.entries).toHaveLength(0)
  })
  it('keeps development requirements on the opening-window prompt route even after switching apps', async () => {
    const text = '给 Agent 写提示词：帮我打开下载目录，然后创建一个提醒。'
    mocks.transcribe.mockResolvedValue({ text }); mocks.complete.mockResolvedValue('润色后的需求')
    const onAssistant = vi.fn(), onReminder = vi.fn(), h = harness({ voiceCommands: smart }, { onAssistant, onReminder })
    h.pipeline.start('dictation')
    mocks.foregroundWindow.mockReturnValue({ title: 'WeChat', className: 'WeChat', appName: 'wechat', pid: 100 })
    await finish(h.pipeline)
    expect(mocks.complete).toHaveBeenCalledOnce()
    expect(mocks.complete.mock.calls[0][1].messages.at(-1).content).toBe(text)
    expect(h.entries[0]).toMatchObject({ mode: 'dictation', focusedWindowTitle: 'Editor', final: '润色后的需求' })
    expect(onAssistant).not.toHaveBeenCalled(); expect(onReminder).not.toHaveBeenCalled()
  })
  it('respects explicit keyword dictation and explicit shortcut upgrades over natural intent', async () => {
    mocks.transcribe.mockResolvedValue({ text: '指令输入，明天提醒我开会' })
    const h = harness({ voiceCommands: { ...smart, enabled: true } })
    h.pipeline.start('dictation'); await finish(h.pipeline)
    expect(mocks.complete).toHaveBeenCalledOnce()
    expect(h.entries[0]).toMatchObject({ mode: 'dictation', transcript: '明天提醒我开会' })
    mocks.complete.mockClear()
    h.pipeline.start('dictation'); h.pipeline.upgrade('translate'); await finish(h.pipeline)
    expect(mocks.complete).toHaveBeenCalledOnce()
    expect(h.entries[1]?.mode).toBe('translate')
  })
  it('does not execute on cancellation, empty ASR or invalid model output', async () => {
    const onAssistant = vi.fn(), onReminder = vi.fn(), h = harness({ voiceCommands: smart }, { onAssistant, onReminder })
    h.pipeline.start('dictation'); h.pipeline.pushAudio(tone(1200)); h.pipeline.cancel('test')
    expect(mocks.transcribe).not.toHaveBeenCalled()
    mocks.transcribe.mockResolvedValue({ text: '' })
    h.pipeline.start('dictation'); await finish(h.pipeline)
    mocks.transcribe.mockResolvedValue({ text: '今天有什么AI新闻？' }); mocks.complete.mockResolvedValue('invalid')
    h.pipeline.start('dictation'); await finish(h.pipeline)
    expect(onAssistant).not.toHaveBeenCalled(); expect(onReminder).not.toHaveBeenCalled()
    expect(mocks.insertText).not.toHaveBeenCalled(); expect(h.entries).toHaveLength(0); expect(h.pipeline.isBusy).toBe(false)
  })
  it('does not keep the previous intent or reclassify a take after a settings change', async () => {
    const onReminder = vi.fn().mockResolvedValue({ message: 'saved' }), h = harness({ voiceCommands: smart }, { onReminder })
    mocks.transcribe.mockResolvedValue({ text: '明天提醒我开会' })
    h.pipeline.start('dictation'); await finish(h.pipeline)
    mocks.transcribe.mockResolvedValue({ text: '你好世界' }); mocks.complete.mockResolvedValueOnce('{"kind":"dictation"}').mockResolvedValueOnce('你好世界')
    h.pipeline.start('dictation'); h.settings.voiceCommands.smartRouting = false; await finish(h.pipeline)
    expect(onReminder).toHaveBeenCalledOnce(); expect(h.entries[0]?.mode).toBe('dictation')
    mocks.complete.mockClear()
    h.pipeline.start('dictation'); await finish(h.pipeline)
    expect(mocks.complete).toHaveBeenCalledOnce()
  })
  it('shares selection prompts and append setting, refusing a changed foreground target', async () => {
    mocks.transcribe.mockResolvedValue({ text: '帮我润色选中的内容' })
    mocks.complete.mockResolvedValueOnce('{"kind":"selection","operation":"polish"}').mockResolvedValueOnce('Better text')
    const apply = vi.fn(), captureSelection = vi.fn().mockResolvedValue({ text: 'Original', context: {}, apply })
    const h = harness({ voiceCommands: smart, selectionInsertMode: 'append' }, { captureSelection })
    h.pipeline.start('dictation'); await finish(h.pipeline)
    expect(mocks.complete.mock.calls[1][1].messages.at(-1).content).toBe('Original')
    expect(apply).toHaveBeenCalledWith('Better text', true, expect.any(AbortSignal))
    mocks.complete.mockResolvedValueOnce('{"kind":"selection","operation":"polish"}'); captureSelection.mockClear()
    h.pipeline.start('dictation'); mocks.foregroundWindow.mockReturnValue({ title: 'Another app', pid: 2 }); await finish(h.pipeline)
    expect(captureSelection).not.toHaveBeenCalled()
  })
  it('asks for source text when an explicit polish request has no selection, without a fabricated edit or generic failure', async () => {
    mocks.transcribe.mockResolvedValue({ text: '帮我把这句话写得自然一点，别太正式。' })
    mocks.complete.mockResolvedValueOnce('{"kind":"selection","operation":"polish"}')
    const captureSelection = vi.fn().mockRejectedValue(new Error('没有选中文字')), onAnswer = vi.fn()
    const h = harness({ voiceCommands: smart }, { captureSelection, onAnswer })
    h.pipeline.start('dictation'); await finish(h.pipeline)
    expect(onAnswer).toHaveBeenCalledWith(expect.objectContaining({ answer: '请先选中文字，或提供要处理的文本', streaming: false }))
    expect(mocks.complete).toHaveBeenCalledOnce(); expect(mocks.insertText).not.toHaveBeenCalled()
    expect(h.entries).toHaveLength(0); expect(h.pipeline.isBusy).toBe(false)
  })
  it('sends the opening app snapshot to the assistant even after switching the foreground app', async () => {
    mocks.transcribe.mockResolvedValue({ text: '我当前用的是什么应用？' })
    mocks.complete.mockResolvedValueOnce('{"kind":"assistant"}')
    const onAssistant = vi.fn().mockResolvedValue(undefined)
    const original = { appName: 'code', title: 'Original code', className: 'Code', pid: 42, handle: '1234', appPath: 'C:\\Code.exe', rect: null }
    mocks.foregroundWindow.mockReturnValue(original)
    const h = harness({ voiceCommands: smart }, { onAssistant })
    h.pipeline.start('dictation'); mocks.foregroundWindow.mockReturnValue({ ...original, appName: 'chrome', title: 'Other app', pid: 99 })
    await finish(h.pipeline)
    expect(onAssistant.mock.calls[0][3]).toMatchObject({ appName: 'code', windowTitle: 'Original code', processId: 42, windowHandle: '1234' })
    expect(onAssistant.mock.calls[0][3]).not.toHaveProperty('fieldContent')
  })
  it('uses the existing assistant answer for a voice follow-up instead of starting an empty Ask thread', async () => {
    mocks.transcribe.mockResolvedValue({ text: '那我要怎么解决？' })
    const onAssistant = vi.fn().mockResolvedValue(undefined)
    const h = harness({ voiceCommands: smart }, { onAssistant,
      voiceContext: () => ({ recent: { question: 'Analyze the current error', answer: 'Connection refused on port 8080' } }) })
    h.pipeline.start('dictation'); await finish(h.pipeline)
    expect(onAssistant).toHaveBeenCalledWith('那我要怎么解决？', expect.any(AbortSignal), expect.any(Number), expect.any(Object), undefined)
    expect(mocks.askAgent).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled()
  })
  it.each(['Explain the selected code', '这段英文是什么意思？顺便翻译成中文。'])('supplies real selected text to normal Ask with web search disabled: %s', async text => {
    mocks.transcribe.mockResolvedValue({ text })
    mocks.complete.mockResolvedValueOnce('{"kind":"ask"}')
    mocks.askAgent.mockResolvedValue({ text: 'Explanation', sources: [], searched: false })
    const captureSelection = vi.fn().mockResolvedValue({ text: 'const x = 1;', context: {}, apply: vi.fn() })
    const h = harness({ voiceCommands: smart, search: { enabled: false } as Settings['search'] }, { captureSelection })
    h.pipeline.start('dictation'); await finish(h.pipeline)
    expect(captureSelection).toHaveBeenCalledOnce()
    expect(mocks.askAgent.mock.calls[0][2]).toMatchObject({ selectedText: 'const x = 1;' })
  })
  it('recognizes explicit read-only selection requests before the intent model can route them to an edit', async () => {
    mocks.transcribe.mockResolvedValue({ text: '帮我解释一下选中的这段代码。' })
    mocks.complete.mockResolvedValueOnce('{"kind":"selection","operation":"polish"}')
    mocks.askAgent.mockResolvedValue({ text: 'This returns the sum.', sources: [], searched: false })
    const apply = vi.fn(), captureSelection = vi.fn().mockResolvedValue({ text: 'return a + b;', context: {}, apply })
    const h = harness({ voiceCommands: smart }, { captureSelection })
    h.pipeline.start('dictation'); await finish(h.pipeline)
    expect(mocks.askAgent.mock.calls[0][2]).toMatchObject({ selectedText: 'return a + b;' })
    expect(apply).not.toHaveBeenCalled(); expect(mocks.insertText).not.toHaveBeenCalled()
  })
  it('does not require a text model to polish multimodal dictation after a protected requirement', async () => {
    mocks.generateFromAudio.mockResolvedValueOnce('请帮我实现这个功能，打开网站。').mockResolvedValueOnce('整理后的开发需求')
    const h = harness({ voiceCommands: smart, pipelineMode: 'multimodal', profiles: [{ ...TEST_PROFILES[0], id: 'mm', kind: 'multimodal' }], chains: { llm: [], asr: [], multimodal: ['mm'] } })
    h.pipeline.start('dictation'); await finish(h.pipeline)
    expect(mocks.generateFromAudio).toHaveBeenCalledTimes(2); expect(mocks.complete).not.toHaveBeenCalled()
    expect(h.entries[0]).toMatchObject({ mode: 'dictation', final: '整理后的开发需求' })
  })
})
