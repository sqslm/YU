import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BarAlert, BarState, HistoryEntry, Settings , ProviderProfile} from '@shared/types'
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
  setBarInteractive: vi.fn()
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
  foregroundWindow: () => ({ title: 'Editor', className: 'code', appName: '', pid: 0 })
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

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

describe('cancel()', () => {
  it('lands a dismissed row and keeps the captured audio under keepAudio=failed', async () => {
    const { pipeline, store, entries, log, sent } = harness({ keepAudio: 'failed' })
    pipeline.start('dictation')
    pipeline.pushAudio(tone(800))
    await sleep(10)

    expect(pipeline.cancel()).toBe(true)

    await vi.waitFor(() => expect(entries).toHaveLength(1))
    const entry = entries[0]!
    expect(entry.status).toBe('dismissed')
    expect(entry.alertKind).toBe('cancelled')
    expect(entry.durationMs).toBeGreaterThan(0)
    // `dismissed` is not `completed`, so a `failed`-audio setting keeps it.
    // `record()` runs detached after `cancel()`, so wait for the save itself
    // rather than for the row (which is written first).
    await vi.waitFor(() => expect(store.saveAudio).toHaveBeenCalledTimes(1))
    const [savedId, wav] = store.saveAudio.mock.calls[0] as [string, Buffer]
    expect(savedId).toBe(entry.id)
    // 800 ms of PCM16 => 44-byte RIFF header plus samples.
    expect(wav.byteLength).toBe(44 + 800 * 16 * 2)
    expect(wav.subarray(0, 4).toString('latin1')).toBe('RIFF')
    await vi.waitFor(() =>
      expect(entry.audioPath).toBe('/tmp/typeless/audio/h1.wav')
    )
    // The reason rides along in the log line: "user" for an Esc press or the
    // 取消 action, "suspend"/"lock" when Windows ended the session.
    expect(log).toHaveBeenCalledWith(
      '[pipeline] cancelled dictation take (800ms captured, user)'
    )
    // The bar is told to flush and stop the microphone, and shows the hint.
    expect(sent).toContainEqual(
      expect.objectContaining({ phase: 'done', mode: 'dictation', text: '已取消（可在历史中查看）' })
    )
    pipeline.dismissAlert()
  })

  it('keeps no audio when keepAudio=never even though the same PCM was captured', async () => {
    const { pipeline, store, entries } = harness({ keepAudio: 'never' })
    pipeline.start('dictation')
    pipeline.pushAudio(tone(800))
    await sleep(10)

    pipeline.cancel()

    await vi.waitFor(() => expect(entries).toHaveLength(1))
    expect(entries[0]!.status).toBe('dismissed')
    // Identical capture to the test above: only the setting differs.
    expect(store.saveAudio).not.toHaveBeenCalled()
    expect(entries[0]!.audioPath).toBeUndefined()
    pipeline.dismissAlert()
  })
})

describe('reportCaptureError()', () => {
  it('only logs a missing or denied microphone and writes no history row', async () => {
    const { pipeline, store, log } = harness({})

    await pipeline.reportCaptureError('Requested device not found', 'mic_missing')
    await pipeline.reportCaptureError('Permission denied', 'mic_denied')

    expect(store.add).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('[capture] Requested device not found')
    expect(log).toHaveBeenCalledWith('[capture] Permission denied')
  })

  it('records any other capture failure as an error row', async () => {
    const { pipeline, entries, store } = harness({ keepAudio: 'failed' })

    await pipeline.reportCaptureError('decode failed', 'asr_failed')

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      mode: 'dictation',
      status: 'error',
      alertKind: 'asr_failed',
      error: 'decode failed',
      durationMs: 0,
      app: 'Editor',
      transcript: '',
      final: ''
    })
    // Nothing was captured, so there is no PCM to keep.
    expect(store.saveAudio).not.toHaveBeenCalled()
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
