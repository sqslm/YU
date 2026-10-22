import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BarState, HistoryEntry, Settings , ProviderProfile} from '@shared/types'
import { mergeSettings } from '@shared/defaults'

/**
 * Translation branch of the real pipeline (REQ-10).
 *
 * The collaborators that touch Win32 (koffi), Electron windows or the network
 * are mocked; everything else — prompt assembly, the translate loop, the alert
 * plumbing and the history bookkeeping — runs for real through `debugIngest`.
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

const { Pipeline } = await import('./pipeline')

type HistoryStore = ConstructorParameters<typeof Pipeline>[1]

function makeHistory(): {
  store: HistoryStore
  entries: HistoryEntry[]
} {
  const entries: HistoryEntry[] = []
  const store = {
    add: vi.fn(async (input: Partial<HistoryEntry>) => {
      const entry = { id: `h${entries.length + 1}`, attempts: 0, ...input } as HistoryEntry
      entries.push(entry)
      return entry
    }),
    update: vi.fn(async (id: string, patch: Partial<HistoryEntry>) => {
      const entry = entries.find((item) => item.id === id)
      if (!entry) return undefined
      Object.assign(entry, patch)
      return entry
    }),
    saveAudio: vi.fn(async () => '/tmp/typeless/audio/h1.wav'),
    readAudio: vi.fn(async () => null),
    get: vi.fn(() => undefined),
    latest: vi.fn(() => entries[entries.length - 1]),
    latestWithStatus: vi.fn(() => undefined)
  }
  return { store: store as unknown as HistoryStore, entries }
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
  options: ConstructorParameters<typeof Pipeline>[4] = {}
): {
  pipeline: InstanceType<typeof Pipeline>
  sent: BarState[]
  entries: HistoryEntry[]
  log: ReturnType<typeof vi.fn>
  settings: Settings
} {
  const { store, entries } = makeHistory()
  const sent: BarState[] = []
  const barWindow = {
    webContents: {
      send: vi.fn((channel: string, state: BarState) => {
        if (channel === 'bar:state') sent.push(state)
      })
    },
    isDestroyed: () => false,
    isVisible: () => false,
    showInactive: vi.fn(),
    hide: vi.fn()
  }
  const settings = makeSettings(overrides)
  const log = vi.fn()
  const pipeline = new Pipeline(
    () => settings,
    store,
    (() => barWindow) as unknown as () => BrowserWindow,
    log,
    options
  )
  return { pipeline, sent, entries, log, settings }
}

const alerts = (sent: BarState[]): BarState[] => sent.filter((state) => state.phase === 'alert')

function alertOf(sent: BarState[], kind: string): { level?: string; text?: string } | undefined {
  const found = sent.find(
    (state) => state.phase === 'alert' && state.alert.kind === kind
  )
  return found?.phase === 'alert' ? found.alert : undefined
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.transcribe.mockResolvedValue({ text: '你好世界', model: 'whisper-1' })
  mocks.insertText.mockResolvedValue(undefined)
  // Insertion verification is another task's surface; here it always confirms.
  mocks.verifyInsertion.mockResolvedValue({ ok: true })
})

describe('translate branch', () => {
  it('keeps a single target byte-for-byte compatible with the old request', async () => {
    mocks.complete.mockResolvedValue('Hello world')
    const { pipeline, entries, log } = harness({ translateTargets: ['en'], translateTarget: 'en' })

    const entry = await pipeline.debugIngest('translate')

    expect(mocks.complete).toHaveBeenCalledTimes(1)
    const request = mocks.complete.mock.calls[0]![1] as { messages: { role: string; content: string }[] }
    const system = request.messages[0]!.content
    expect(system).toContain('Target language: en')
    // No multi-target formatting instructions leak into the single-target prompt.
    expect(system).not.toContain('[<code>]')
    // No language label in the inserted text either.
    expect(mocks.insertText).toHaveBeenCalledWith('Hello world', expect.anything())
    expect(entry?.status).toBe('completed')
    expect(entries[0]?.final).toBe('Hello world')
    expect(log).toHaveBeenCalledWith('[translate] targets=en multi=false')
  })

  it('asks for every target in one request and labels each block with its language name', async () => {
    mocks.complete.mockResolvedValue('[en] Hello world\n[ja] こんにちは世界')
    const { pipeline, entries, log } = harness({ translateTargets: ['en', 'ja'] })

    const entry = await pipeline.debugIngest('translate')

    // Latency: one round trip for both languages, never two sequential calls.
    expect(mocks.complete).toHaveBeenCalledTimes(1)
    const request = mocks.complete.mock.calls[0]![1] as { messages: { role: string; content: string }[] }
    const system = request.messages[0]!.content
    expect(system).toContain('en, ja')
    expect(system).toContain('[<code>]')
    expect(system).not.toContain('Target language:')
    expect(mocks.insertText).toHaveBeenCalledWith(
      '英语\nHello world\n\n---\n\n日语\nこんにちは世界',
      expect.anything()
    )
    expect(entry?.status).toBe('completed')
    expect(entries[0]?.final).toBe('英语\nHello world\n\n---\n\n日语\nこんにちは世界')
    expect(log).toHaveBeenCalledWith('[translate] targets=en,ja multi=true')
  })

  it('caps the request at MAX_TRANSLATE_TARGETS even if settings carry more', async () => {
    mocks.complete.mockResolvedValue('[en] one\n[ja] 二\n[ko] 셋\n[fr] quatre')
    const { pipeline, settings } = harness({ translateTargets: ['en', 'ja', 'ko'] })
    // A hand-edited settings file: mergeSettings caps at three, so bypass it to
    // prove the pipeline enforces the same limit on its own.
    settings.translateTargets = ['en', 'ja', 'ko', 'fr']

    await pipeline.debugIngest('translate')

    const request = mocks.complete.mock.calls[0]![1] as { messages: { role: string; content: string }[] }
    const system = request.messages[0]!.content
    expect(system).toContain('en, ja, ko')
    expect(system).not.toContain('fr')
    expect(mocks.insertText).toHaveBeenCalledWith(
      '英语\none\n\n---\n\n日语\n二\n\n---\n\n韩语\n셋',
      expect.anything()
    )
  })

  it('inserts the delivered targets and warns about the missing one', async () => {
    mocks.complete.mockResolvedValue('[en] Hello world')
    const { pipeline, sent, entries, log } = harness({ translateTargets: ['en', 'ja'] })

    const entry = await pipeline.debugIngest('translate')

    // The surviving translation is still delivered…
    expect(mocks.insertText).toHaveBeenCalledWith('英语\nHello world', expect.anything())
    expect(entry?.status).toBe('completed')
    expect(entries[0]?.final).toBe('英语\nHello world')
    expect(log).toHaveBeenCalledWith('[translate] missing ja (delivered 1/2)')

    // …and the missing target is named once the success pill has faded.
    await vi.waitFor(
      () => {
        expect(alertOf(sent, 'llm_failed')).toBeDefined()
      },
      { timeout: 4000 }
    )
    const alert = alertOf(sent, 'llm_failed')!
    expect(alert.level).toBe('warn')
    expect(alert.text).toContain('日语')
    const actions = sent.find((state) => state.phase === 'alert')!.alert.actions ?? []
    expect(actions.map((action) => action.id)).toEqual(['open_settings', 'dismiss'])
  })

  it('falls through to the shared error path when no target is delivered', async () => {
    mocks.complete.mockResolvedValue('抱歉，我无法翻译。')
    const { pipeline, sent, entries, log } = harness({ translateTargets: ['en', 'ja'] })

    const entry = await pipeline.debugIngest('translate')

    expect(mocks.insertText).not.toHaveBeenCalled()
    expect(entry).toBeNull()
    expect(entries).toHaveLength(0)
    expect(log).toHaveBeenCalledWith('[translate] no target delivered (en,ja)')
    const alert = alertOf(sent, 'llm_failed')!
    expect(alert.level).toBe('error')
  })
})

describe('auto language detection', () => {
  it('nudges once when the spoken language is not among the targets', async () => {
    mocks.transcribe.mockResolvedValue({ text: 'こんにちは世界、今日はいい天気ですね', model: 'whisper-1' })
    mocks.complete.mockResolvedValue('Hello world')
    const { pipeline, sent } = harness({ translateTargets: ['en'], language: '' })

    await pipeline.debugIngest('translate')

    await vi.waitFor(
      () => {
        expect(alertOf(sent, 'auto_language_detected')).toBeDefined()
      },
      { timeout: 4000 }
    )
    const alert = alertOf(sent, 'auto_language_detected')!
    expect(alert.level).toBe('info')
    expect(alert.text).toContain('日语')
    // No settings writer was wired, so the notice sends the user to Settings
    // instead of claiming the target list changed.
    expect(alert.text).toContain('可在设置里')
  })

  it('appends the detected language when the host wired a settings writer', async () => {
    mocks.transcribe.mockResolvedValue({ text: 'こんにちは世界', model: 'whisper-1' })
    mocks.complete.mockResolvedValue('Hello world')
    const saveTranslateTargets = vi.fn()
    const { pipeline, sent, log } = harness(
      { translateTargets: ['en'], language: '' },
      { saveTranslateTargets }
    )

    await pipeline.debugIngest('translate')

    expect(saveTranslateTargets).toHaveBeenCalledWith(['en', 'ja'])
    expect(log).toHaveBeenCalledWith('[translate] appended ja -> targets=en,ja')
    await vi.waitFor(
      () => {
        expect(alertOf(sent, 'auto_language_detected')).toBeDefined()
      },
      { timeout: 4000 }
    )
    expect(alertOf(sent, 'auto_language_detected')!.text).toBe('检测到日语，已加入目标语言')
  })

  it('does not append past the cap even when a writer is wired', async () => {
    mocks.transcribe.mockResolvedValue({ text: 'こんにちは世界', model: 'whisper-1' })
    mocks.complete.mockResolvedValue('[en] Hello\n[zh] 你好\n[ko] 안녕')
    const saveTranslateTargets = vi.fn()
    const { pipeline, sent } = harness(
      { translateTargets: ['en', 'zh', 'ko'], language: '' },
      { saveTranslateTargets }
    )

    await pipeline.debugIngest('translate')

    expect(saveTranslateTargets).not.toHaveBeenCalled()
    await vi.waitFor(
      () => {
        expect(alertOf(sent, 'auto_language_detected')).toBeDefined()
      },
      { timeout: 4000 }
    )
    expect(alertOf(sent, 'auto_language_detected')!.text).toContain('可在设置里')
  })

  it('does not nudge again on later takes of the same session', async () => {
    mocks.transcribe.mockResolvedValue({ text: 'こんにちは世界', model: 'whisper-1' })
    mocks.complete.mockResolvedValue('Hello world')
    const { pipeline, sent } = harness({ translateTargets: ['en'], language: '' })

    await pipeline.debugIngest('translate')
    await vi.waitFor(
      () => {
        expect(alertOf(sent, 'auto_language_detected')).toBeDefined()
      },
      { timeout: 4000 }
    )

    const before = sent.filter((state) => state.phase === 'alert').length
    await pipeline.debugIngest('translate')
    // Long enough for a second deferred notice to have fired.
    await new Promise((resolve) => setTimeout(resolve, 1900))
    const after = sent.filter(
      (state) => state.phase === 'alert' && state.alert.kind === 'auto_language_detected'
    ).length
    expect(after).toBe(1)
    expect(sent.filter((state) => state.phase === 'alert').length).toBe(before)
  })

  it('stays silent when the detected language is already a target', async () => {
    mocks.transcribe.mockResolvedValue({ text: 'こんにちは世界', model: 'whisper-1' })
    mocks.complete.mockResolvedValue('[en] Hello\n[ja] こんにちは世界')
    const { pipeline, sent } = harness({ translateTargets: ['en', 'ja'], language: '' })

    await pipeline.debugIngest('translate')
    await new Promise((resolve) => setTimeout(resolve, 1900))

    expect(alertOf(sent, 'auto_language_detected')).toBeUndefined()
    expect(alerts(sent)).toHaveLength(0)
  })
})

describe('multimodal translate', () => {
  it('asks the one-shot audio route for every target', async () => {
    mocks.generateFromAudio.mockResolvedValue('[en] Hello\n[ja] こんにちは')
    const { pipeline } = harness({ translateTargets: ['en', 'ja'], pipelineMode: 'multimodal' })

    await pipeline.debugIngest('translate')

    expect(mocks.generateFromAudio).toHaveBeenCalledTimes(1)
    const request = mocks.generateFromAudio.mock.calls[0]![1] as { prompt: string }
    // The label instruction has to reach the audio route too, otherwise the model
    // answers in one language and the formatted output silently drops a target.
    expect(request.prompt).toContain('[<code>]')
    expect(request.prompt).toContain('en')
    expect(request.prompt).toContain('ja')
    // Exactly one audio call: never a second round trip per language.
    expect(mocks.complete).not.toHaveBeenCalled()
  })

  it('reorders and strips chatter from the audio answer before inserting', async () => {
    mocks.generateFromAudio.mockResolvedValue('以下是结果：\n[ja] こんにちは\n[en] Hello')
    const { pipeline, entries } = harness({
      translateTargets: ['en', 'ja'],
      pipelineMode: 'multimodal'
    })

    await pipeline.debugIngest('translate')

    expect(mocks.insertText).toHaveBeenCalledWith(
      '英语\nHello\n\n---\n\n日语\nこんにちは',
      expect.anything()
    )
    expect(entries[0]?.final).toBe('英语\nHello\n\n---\n\n日语\nこんにちは')
  })

  it('leaves an unlabelled answer alone instead of dropping it', async () => {
    mocks.generateFromAudio.mockResolvedValue('Hello there')
    const { pipeline } = harness({ translateTargets: ['en', 'ja'], pipelineMode: 'multimodal' })

    await pipeline.debugIngest('translate')

    expect(mocks.insertText).toHaveBeenCalledWith('Hello there', expect.anything())
  })

  it('keeps the single-target answer unlabelled', async () => {
    mocks.generateFromAudio.mockResolvedValue('Hello there')
    const { pipeline } = harness({ translateTargets: ['en'], pipelineMode: 'multimodal' })

    await pipeline.debugIngest('translate')

    const request = mocks.generateFromAudio.mock.calls[0]![1] as { prompt: string }
    expect(request.prompt).not.toContain('[<code>]')
    expect(mocks.insertText).toHaveBeenCalledWith('Hello there', expect.anything())
  })
})
