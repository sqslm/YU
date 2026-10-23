/**
 * 「随记」store behaviour: storage layout, the background ASR→polish pipeline and
 * data-directory migration.
 *
 * Everything runs against a real temporary directory. The properties worth
 * protecting here are disk properties — the audio exists before the row does, a
 * failed provider leaves both the recording and the transcript alone, and a
 * migrated root still resolves its recordings. A stubbed filesystem would prove
 * none of them.
 *
 * Only the three things that leave the process are mocked: the ASR provider, the
 * LLM provider and the ffmpeg transcode; the failover chain itself runs for real.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/defaults'
import type { NoteStore, ProviderProfile, Settings } from '@shared/types'
import { NotesStore } from './notes'

const mocks = vi.hoisted(() => ({
  userData: '',
  transcribe: vi.fn(),
  complete: vi.fn(),
  toOggOpus: vi.fn()
}))

// `userData` is read on every path calculation, so the mock stays a plain mutable
// slot that each test points at its own temp directory.
vi.mock('electron', () => ({
  app: { getPath: () => mocks.userData }
}))

vi.mock('./providers/asr', () => ({ transcribe: mocks.transcribe }))

// `unwrapModelText` is real: the polish path must still strip the model's quotes.
vi.mock('./providers/llm', async () => {
  const actual = await vi.importActual<typeof import('./providers/llm')>('./providers/llm')
  return { ...actual, complete: mocks.complete }
})

vi.mock('./audio/transcode', () => ({ toOggOpus: mocks.toOggOpus, resolveFfmpeg: () => process.env.TYPELESS_FFMPEG || 'ffmpeg' }))

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

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return mergeSettings({
    language: 'zh',
    profiles: TEST_PROFILES,
    chains: { asr: ['asr-test'], llm: ['llm-test'], multimodal: [] },
    ...overrides
  })
}

let dir = ''
let other = ''
let settings: Settings
let notify: ReturnType<typeof vi.fn>
let lines: string[]

/** 16 kHz mono, so `pcmDurationMs` is exactly `samples / 16` ms. */
function pcm(samples = 16_000, value = 1000): Int16Array {
  return new Int16Array(samples).fill(value)
}

function oggOutcome(bytes = Uint8Array.from([79, 103, 103, 83, 0, 2, 0, 0])) {
  return { ok: true, audio: { data: bytes, contentType: 'audio/ogg', filename: 'note.ogg' }, bytesBefore: 0 }
}

function makeStore(): NotesStore {
  return new NotesStore({
    log: (line) => lines.push(line),
    getSettings: () => settings,
    notify: () => notify()
  })
}

async function loadedStore(): Promise<NotesStore> {
  const store = makeStore()
  await store.load()
  return store
}

function readDb(root: string): NoteStore {
  return JSON.parse(readFileSync(join(root, 'notes.json'), 'utf8')) as NoteStore
}

function audioBytesOf(root: string): number {
  const audio = join(root, 'notes', 'audio')
  if (!existsSync(audio)) return 0
  return readdirSync(audio).reduce((sum, name) => sum + statSync(join(audio, name)).size, 0)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'typeless-notes-'))
  other = mkdtempSync(join(tmpdir(), 'typeless-notes-target-'))
  mocks.userData = dir
  mocks.transcribe.mockReset().mockResolvedValue({ text: '  你好世界  ', model: 'whisper-1' })
  mocks.complete.mockReset().mockResolvedValue('你好，世界。')
  mocks.toOggOpus.mockReset().mockResolvedValue(oggOutcome())
  settings = makeSettings()
  notify = vi.fn()
  lines = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(other, { recursive: true, force: true })
})

describe('creation', () => {
  it('stores keyword-routed audio and the supplied transcript without another ASR request', async () => {
    const store = await loadedStore()
    const entry = await store.create({ pcm: pcm(), durationMs: 1000 }, undefined, '这是已经识别的随记正文')
    expect(entry.transcript).toBe('这是已经识别的随记正文')
    expect(existsSync(join(dir, entry.audioPath!))).toBe(true)
    await vi.waitFor(() => expect(store.list().notes[0]?.polishStatus).toBe('ok'))
    expect(mocks.transcribe).not.toHaveBeenCalled()
    expect(mocks.complete).toHaveBeenCalledOnce()
    expect(mocks.complete.mock.calls[0][1].messages.at(-1).content).toContain('这是已经识别的随记正文')
    expect(readDb(dir).notes[0]?.transcript).toBe('这是已经识别的随记正文')
  })
  it('does not save a keyword-routed note if cancellation lands during audio preparation', async () => {
    const store = await loadedStore(), controller = new AbortController()
    controller.abort()
    await expect(store.create({ pcm: pcm(), durationMs: 1000 }, controller.signal, '正文')).rejects.toThrow()
    expect(store.list().notes).toHaveLength(0)
    expect(mocks.transcribe).not.toHaveBeenCalled()
  })
  it('rolls back the recording and row when the database cannot be written', async () => {
    const store = await loadedStore()
    const temp = join(dir, `notes.json.${process.pid}.tmp`)
    mkdirSync(temp)
    await expect(store.create({ pcm: pcm(), durationMs: 1000 })).rejects.toThrow()
    expect(store.list().notes).toHaveLength(0)
    expect(audioBytesOf(dir)).toBe(0)
    expect(mocks.transcribe).not.toHaveBeenCalled()
  })
  it('persists a blank text note without audio or provider calls and restores it after restart', async () => {
    const store = await loadedStore()
    const entry = await store.createText({ text: '' })
    expect(entry).toMatchObject({ transcript: '', polished: '', polishStatus: 'skipped', durationMs: 0, tags: [], pending: true })
    expect(entry.editedAt).toBeGreaterThan(0)
    expect(store.audioPathOf(entry.id)).toBeNull()
    expect(audioBytesOf(dir)).toBe(0)
    expect((await loadedStore()).list().notes[0]).toEqual(entry)
    expect(mocks.transcribe).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled()
    expect(mocks.toOggOpus).not.toHaveBeenCalled()
  })

  it('keeps clipboard text verbatim, uses the known category and supports explicit polishing', async () => {
    const store = await loadedStore()
    await store.setCategories([{ id: 'work', name: '工作' }])
    const text = '  临时想法 😀\n保留换行\n'
    const entry = await store.createText({ text, categoryId: 'work' })
    expect(entry).toMatchObject({ transcript: text, categoryId: 'work' })
    const unknown = await store.createText({ text: '未知分类', categoryId: 'gone' })
    expect(unknown.categoryId).toBeUndefined()
    const polished = await store.repolish(entry.id)
    expect(polished?.transcript).toBe(text)
    expect(polished?.polishStatus).toBe('ok')
    expect(mocks.complete).toHaveBeenCalledOnce()
    expect(mocks.transcribe).not.toHaveBeenCalled()
    expect(store.hasAudio(entry.id)).toBe(false)
  })

  it('rejects invalid and oversized text without inserting a note or silently truncating', async () => {
    const store = await loadedStore()
    await expect(store.createText({ text: 123 as never })).rejects.toThrow('必须是文字')
    await expect(store.createText({ text: 'x'.repeat(200_001) })).rejects.toThrow('200000')
    expect(store.list().notes).toHaveLength(0)
    const entry = await store.createText({ text: 'x'.repeat(200_000) })
    expect(readDb(dir).notes[0].transcript).toBe(entry.transcript)
  })

  it('rolls back a text-note insertion when persistence fails, allowing a clean retry', async () => {
    const store = await loadedStore()
    const original = await store.createText({ text: '已有内容' })
    const temp = join(dir, `notes.json.${process.pid}.tmp`)
    mkdirSync(temp)
    await expect(store.createText({ text: '新内容' })).rejects.toThrow()
    expect(store.list().notes).toEqual([original])
    expect(readDb(dir).notes).toEqual([original])
    rmSync(temp, { recursive: true })
    await store.createText({ text: '新内容' })
    expect(readDb(dir).notes.map(note => note.transcript)).toEqual(['新内容', '已有内容'])
  })

  it('hands the complete vendor ASR configuration to the provider', async () => {
    settings.profiles[0] = { ...settings.profiles[0], asrAdapter: 'azure', requestPath: '/custom/transcribe', vendor: { deployment: 'speech' } }
    const store = await loadedStore()
    await store.create({ pcm: pcm(), durationMs: 1000 })
    await vi.waitFor(() => expect(mocks.transcribe).toHaveBeenCalled())
    expect(mocks.transcribe.mock.calls[0][0]).toMatchObject({
      asrAdapter: 'azure', requestPath: '/custom/transcribe', vendor: { deployment: 'speech' }
    })
    await vi.waitFor(() => expect(store.list().notes[0].polishStatus).toBe('ok'))
  })
  it('stores the recording first, then fills in transcript and polish', async () => {
    const store = await loadedStore()

    const entry = await store.create({ pcm: pcm(), durationMs: 1000 })

    // The row is visible immediately, before any provider has answered.
    expect(entry.polishStatus).toBe('pending')
    expect(entry.transcript).toBe('')
    expect(entry.audioFormat).toBe('ogg')
    expect(entry.durationMs).toBe(1000)
    const audio = store.audioPathOf(entry.id)
    expect(audio).not.toBeNull()
    expect(existsSync(audio!)).toBe(true)
    expect(audio!.endsWith('.ogg')).toBe(true)
    // …and it is already on disk, not only in memory.
    const saved = readDb(dir)
    expect(saved.notes).toHaveLength(1)
    expect(saved.notes[0]!.audioPath).toBe(`notes/audio/${entry.id}.ogg`)
    expect(saved.notes[0]!.audioBytes).toBe(8)

    await vi.waitFor(() => expect(store.list().notes[0]!.polishStatus).toBe('ok'))
    const note = store.list().notes[0]!
    expect(note.transcript).toBe('你好世界')
    expect(note.polished).toBe('你好，世界。')
    expect(mocks.complete.mock.calls[0][1].messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'system', content: expect.stringContaining('personal voice note') })]))
    expect(note.polishError).toBeUndefined()
    // Written to disk as well, so a restart does not lose the text.
    expect(readDb(dir).notes[0]!.polished).toBe('你好，世界。')
    // One notify for the insert, one per pipeline step.
    expect(notify.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('clamps the declared duration to the audio that was actually recorded', async () => {
    const store = await loadedStore()
    const entry = await store.create({ pcm: pcm(8000), durationMs: 999_000 })
    expect(entry.durationMs).toBe(500)
  })

  it('keeps a WAV when compression is unavailable and stores a playable file', async () => {
    mocks.toOggOpus.mockResolvedValue({ ok: false, reason: 'no-ffmpeg' })
    const store = await loadedStore()
    const samples = pcm(4000)

    const entry = await store.create({ pcm: samples, durationMs: 250 })

    expect(entry.audioFormat).toBe('wav')
    const audio = store.audioPathOf(entry.id)!
    expect(audio.endsWith('.wav')).toBe(true)
    const bytes = readFileSync(audio)
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF')
    expect(bytes.length).toBe(44 + samples.length * 2)
    expect(entry.audioBytes).toBe(44 + samples.length * 2)
    // The fallback is reported, not silent.
    expect(lines.some((line) => line.includes('保存为 WAV'))).toBe(true)
  })

  it('reads a saved note back after a restart', async () => {
    const store = await loadedStore()
    const entry = await store.create({ pcm: pcm(), durationMs: 1000 })
    await vi.waitFor(() => expect(store.list().notes[0]!.polishStatus).toBe('ok'))

    const reopened = await loadedStore()
    const notes = reopened.list().notes
    expect(notes).toHaveLength(1)
    expect(notes[0]!.id).toBe(entry.id)
    expect(notes[0]!.polished).toBe('你好，世界。')
    expect(existsSync(reopened.audioPathOf(entry.id)!)).toBe(true)
  })
})

describe('re-transcription', () => {
  async function recorded(): Promise<{ store: NotesStore; id: string; file: string }> {
    mocks.toOggOpus.mockResolvedValue({ ok: false, reason: 'disabled' })
    const store = await loadedStore()
    const note = await store.create({ pcm: pcm(), durationMs: 1000 })
    await vi.waitFor(() => expect(store.list().notes[0].polishStatus).toBe('ok'))
    await store.update(note.id, { transcript: '手动原文', polished: '手动润色' })
    mocks.transcribe.mockResolvedValue({ text: '重新转写' })
    mocks.complete.mockResolvedValue('重新润色')
    return { store, id: note.id, file: store.audioPathOf(note.id)! }
  }

  it('atomically replaces both texts, preserves audio and persists the result for sync', async () => {
    const { store, id, file } = await recorded()
    const before = readFileSync(file)
    const result = await store.retranscribe(id)
    expect(result).toMatchObject({ transcript: '重新转写', polished: '重新润色', polishStatus: 'ok', pending: true })
    expect(readFileSync(file)).toEqual(before)
    expect(readDb(dir).notes[0]).toEqual(result)
    expect(store.pendingChanges().live[0]).toEqual(result)
  })
  it.each(['asr', 'polish', 'empty'])('preserves both edited texts and recording on %s failure', async kind => {
    const { store, id, file } = await recorded()
    const before = readFileSync(file)
    if (kind === 'asr') mocks.transcribe.mockRejectedValue(new Error('offline'))
    if (kind === 'polish') mocks.complete.mockRejectedValue(new Error('offline'))
    if (kind === 'empty') mocks.transcribe.mockResolvedValue({ text: '  ' })
    await expect(store.retranscribe(id)).rejects.toThrow()
    expect(store.list().notes[0]).toMatchObject({ transcript: '手动原文', polished: '手动润色', polishStatus: 'failed' })
    expect(readFileSync(file)).toEqual(before)
    expect(readDb(dir).notes[0].transcript).toBe('手动原文')
  })
  it('does not replace a newer user edit, or recreate a deleted note', async () => {
    const { store, id } = await recorded()
    let finish!: (value: { text: string }) => void
    mocks.transcribe.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const first = store.retranscribe(id)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await store.update(id, { transcript: '稍后修改' })
    finish({ text: '过期结果' })
    expect(await first).toBeUndefined()
    expect(store.list().notes[0].transcript).toBe('稍后修改')
    finish = undefined as never
    const second = store.retranscribe(id)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await store.remove(id)
    finish({ text: '已删除记录的结果' })
    expect(await second).toBeUndefined()
    expect(store.list().notes).toHaveLength(0)
  })
  it('reports a persistence failure without replacing the original text', async () => {
    const { store, id } = await recorded()
    mkdirSync(join(dir, `notes.json.${process.pid}.tmp`))
    await expect(store.retranscribe(id)).rejects.toThrow()
    expect(store.list().notes[0]).toMatchObject({ transcript: '手动原文', polished: '手动润色' })
    expect(readDb(dir).notes[0]).toMatchObject({ transcript: '手动原文', polished: '手动润色' })
  })
  it('keeps the original state when cancelled and supports disabling polish', async () => {
    const { store, id } = await recorded()
    const before = store.list().notes[0]
    const controller = new AbortController()
    mocks.transcribe.mockImplementationOnce(async () => { controller.abort(); return { text: '取消后' } })
    await expect(store.retranscribe(id, controller.signal)).rejects.toThrow()
    expect(store.list().notes[0]).toEqual(before)
    settings.polish.enabled = false
    const result = await store.retranscribe(id)
    expect(result).toMatchObject({ transcript: '重新转写', polished: '', polishStatus: 'skipped' })
    const text = await store.createText({ text: '纯文本' })
    await expect(store.retranscribe(text.id)).rejects.toThrow('没有本地录音')
  })
})

describe('pipeline failures', () => {
  it('keeps the transcript and the recording when polish fails', async () => {
    mocks.transcribe.mockResolvedValue({ text: '今天开会讨论预算', model: 'whisper-1' })
    mocks.complete.mockRejectedValue(Object.assign(new Error('model overloaded'), { status: 503 }))
    const store = await loadedStore()

    const entry = await store.create({ pcm: pcm(), durationMs: 1000 })

    await vi.waitFor(() => expect(store.list().notes[0]!.polishStatus).toBe('failed'))
    const note = store.list().notes[0]!
    expect(note.transcript).toBe('今天开会讨论预算')
    expect(note.polished).toBe('')
    expect(note.polishError).toContain('润色失败')
    expect(note.polishError).toContain('503')
    // Audio and row survive: a provider outage is not the user's problem.
    expect(existsSync(store.audioPathOf(entry.id)!)).toBe(true)
    expect(store.list().notes).toHaveLength(1)
  })

  it('records a failed transcription instead of dropping the note', async () => {
    mocks.transcribe.mockRejectedValue(new Error('connection refused'))
    const store = await loadedStore()

    const entry = await store.create({ pcm: pcm(), durationMs: 1000 })

    await vi.waitFor(() => expect(store.list().notes[0]!.polishStatus).toBe('failed'))
    const note = store.list().notes[0]!
    expect(note.transcript).toBe('')
    expect(note.polishError).toContain('转写失败')
    expect(existsSync(store.audioPathOf(entry.id)!)).toBe(true)
    expect(mocks.complete).not.toHaveBeenCalled()
  })

  it('skips polish when the user turned polishing off', async () => {
    settings = makeSettings({ polish: { ...DEFAULT_SETTINGS.polish, enabled: false } })
    const store = await loadedStore()

    await store.create({ pcm: pcm(), durationMs: 1000 })

    await vi.waitFor(() => expect(store.list().notes[0]!.polishStatus).toBe('skipped'))
    expect(store.list().notes[0]!.transcript).toBe('你好世界')
    expect(mocks.complete).not.toHaveBeenCalled()
  })
})

describe('editing', () => {
  it('reports a disk write failure to the editor and persists the edit on retry', async () => {
    const store = await loadedStore()
    const entry = await store.create({ pcm: pcm(), durationMs: 1000 })
    await vi.waitFor(() => expect(store.list().notes[0]!.polishStatus).toBe('ok'))
    const temp = join(dir, `notes.json.${process.pid}.tmp`)
    mkdirSync(temp)
    await expect(store.update(entry.id, { transcript: '人工修订' })).rejects.toThrow()
    expect(readDb(dir).notes[0].transcript).toBe('你好世界')
    expect(store.list().notes).toEqual(readDb(dir).notes)
    rmSync(temp, { recursive: true })
    await store.update(entry.id, { transcript: '人工修订' })
    expect(readDb(dir).notes[0].transcript).toBe('人工修订')
  })

  it('marks editedAt and never lets a late polish overwrite edited text', async () => {
    // Hang the polish request so the edit lands while the model is still working.
    let release!: (text: string) => void
    mocks.complete.mockReturnValue(
      new Promise<string>((resolveText) => {
        release = resolveText
      })
    )
    const store = await loadedStore()

    const entry = await store.create({ pcm: pcm(), durationMs: 1000 })
    await vi.waitFor(() => expect(store.list().notes[0]!.transcript).toBe('你好世界'))

    const edited = await store.update(entry.id, { transcript: '我自己写的转写', polished: '我自己的版本' })

    expect(edited?.editedAt).toBeTypeOf('number')
    expect(edited!.editedAt!).toBeGreaterThanOrEqual(entry.createdAt)
    expect(edited?.updatedAt).toBe(edited!.editedAt)

    release('模型版本')
    await vi.waitFor(() => expect(store.list().notes[0]!.polishStatus).toBe('ok'))

    const note = store.list().notes[0]!
    expect(note.transcript).toBe('我自己写的转写')
    expect(note.polished).toBe('我自己的版本')
    // The run still reports success: it happened, it just did not win.
    expect(note.polishError).toBeUndefined()
  })

  it('repolish overwrites edited text and clears the edit stamp', async () => {
    const store = await loadedStore()
    const entry = await store.create({ pcm: pcm(), durationMs: 1000 })
    await vi.waitFor(() => expect(store.list().notes[0]!.polishStatus).toBe('ok'))

    await store.update(entry.id, { polished: '我自己的版本' })
    expect(store.list().notes[0]!.editedAt).toBeTypeOf('number')

    mocks.complete.mockResolvedValue('新的润色结果')
    const repolished = await store.repolish(entry.id)

    expect(repolished?.polished).toBe('新的润色结果')
    expect(repolished?.polishStatus).toBe('ok')
    expect(repolished?.editedAt).toBeUndefined()
    // Only the polish step ran again: the transcript was not re-transcribed.
    expect(mocks.transcribe).toHaveBeenCalledTimes(1)
    expect(mocks.complete).toHaveBeenCalledTimes(2)
  })

  it('normalises, dedupes and caps tags', async () => {
    const store = await loadedStore()
    const long = 'x'.repeat(40)
    const entry = await store.create({
      pcm: pcm(),
      durationMs: 1000,
      tags: ['  工作  ', '工作', '  ', long, ...Array.from({ length: 20 }, (_, i) => `tag${i}`)]
    })

    expect(entry.tags[0]).toBe('工作')
    expect(entry.tags[1]).toBe('x'.repeat(24))
    expect(entry.tags).toHaveLength(12)
    expect(new Set(entry.tags).size).toBe(12)
    expect(entry.tags).not.toContain('')

    const updated = await store.update(entry.id, { tags: ['a', ' a ', 'b', ''] })
    expect(updated?.tags).toEqual(['a', 'b'])
  })
})

describe('removal', () => {
  it('deletes the recording together with the note', async () => {
    const store = await loadedStore()
    const entry = await store.create({ pcm: pcm(), durationMs: 1000 })
    await vi.waitFor(() => expect(store.list().notes[0]!.polishStatus).toBe('ok'))
    const audio = store.audioPathOf(entry.id)!

    await store.remove(entry.id)

    expect(existsSync(audio)).toBe(false)
    expect(store.list().notes).toHaveLength(0)
    expect(store.audioPathOf(entry.id)).toBeNull()
    expect(readDb(dir).notes).toHaveLength(0)
  })
})

describe('categories', () => {
  it('drops blank and duplicate categories and never deletes notes with them', async () => {
    const store = await loadedStore()
    const saved = await store.setCategories([
      { id: 'c1', name: '  工作  ' },
      { id: 'c1', name: '重复' },
      { id: 'c2', name: '   ' },
      { id: '', name: '无 id' }
    ])
    expect(saved).toEqual([{ id: 'c1', name: '工作' }])

    const first = await store.create({ pcm: pcm(), durationMs: 1000, categoryId: 'c1' })
    const second = await store.create({ pcm: pcm(), durationMs: 1000 })
    // A category the user never created is not stored on the note.
    const third = await store.create({ pcm: pcm(), durationMs: 1000, categoryId: 'nope' })

    const byNote = (id: string) => store.list().notes.find((note) => note.id === id)!
    expect(byNote(first.id).categoryId).toBe('c1')
    expect(byNote(second.id).categoryId).toBeUndefined()
    expect(byNote(third.id).categoryId).toBeUndefined()

    await store.setCategories([])

    const notes = store.list().notes
    expect(notes.map((note) => note.id).sort()).toEqual([first.id, second.id, third.id].sort())
    expect(notes.every((note) => note.categoryId === undefined)).toBe(true)
    expect(existsSync(store.audioPathOf(first.id)!)).toBe(true)
    expect(readDb(dir).categories).toEqual([])
  })
})

describe('data directory', () => {
  it('defaults to userData and reports a custom directory', async () => {
    const store = await loadedStore()
    expect(store.dataDir()).toEqual({ dir: dir, custom: false })

    const custom = join(dir, 'custom-root')
    settings = makeSettings({ notesDir: custom })
    const customStore = await loadedStore()
    expect(customStore.dataDir()).toEqual({ dir: custom, custom: true })
    await customStore.create({ pcm: pcm(), durationMs: 1000 })
    expect(existsSync(join(custom, 'notes.json'))).toBe(true)
  })

  it('migrates a copy it verifies, then archives the old files', async () => {
    const store = await loadedStore()
    const a = await store.create({ pcm: pcm(), durationMs: 1000 })
    const b = await store.create({ pcm: pcm(8000), durationMs: 500 })
    await vi.waitFor(() => expect(store.list().notes.every((note) => note.polishStatus === 'ok')).toBe(true)
    )
    const expectedBytes = audioBytesOf(dir)
    expect(expectedBytes).toBeGreaterThan(0)
    const target = join(other, 'typeless-data')

    const result = await store.migrate(target)

    expect(result.ok).toBe(true)
    expect(result.moved).toBe(2)
    expect(result.message).toContain('已迁移')
    // Copy verified: same note count, same audio bytes.
    expect(readDb(target).notes.map((note) => note.id)).toEqual([b.id, a.id])
    expect(audioBytesOf(target)).toBe(expectedBytes)
    expect(existsSync(join(target, 'notes', 'audio', `${a.id}.ogg`))).toBe(true)
    // Old files archived, not deleted.
    expect(existsSync(join(dir, 'notes.json'))).toBe(false)
    const backup = readdirSync(dir).find((name) => name.startsWith('notes-migrated-backup-'))
    expect(backup).toBeDefined()
    expect(existsSync(join(dir, backup!, 'notes.json'))).toBe(true)

    // The store now lives in the new root, so later writes land there.
    expect(store.dataDir()).toEqual({ dir: resolve(target), custom: true })
    const c = await store.create({ pcm: pcm(), durationMs: 1000 })
    expect(readDb(target).notes).toHaveLength(3)
    expect(existsSync(join(target, 'notes', 'audio', `${c.id}.ogg`))).toBe(true)
    expect(existsSync(join(dir, 'notes.json'))).toBe(false)
  })

  it('leaves the old data alone when the target cannot be written', async () => {
    const store = await loadedStore()
    const entry = await store.create({ pcm: pcm(), durationMs: 1000 })
    await vi.waitFor(() => expect(store.list().notes[0]!.polishStatus).toBe('ok'))
    const bytesBefore = readFileSync(join(dir, 'notes.json'), 'utf8')
    // A file where a directory must be: creating the target dir fails.
    const blocker = join(other, 'blocked')
    writeFileSync(blocker, 'not a directory')

    const result = await store.migrate(join(blocker, 'data'))

    expect(result.ok).toBe(false)
    expect(result.message).toContain('无法写入')
    expect(readFileSync(join(dir, 'notes.json'), 'utf8')).toBe(bytesBefore)
    expect(existsSync(store.audioPathOf(entry.id)!)).toBe(true)
    expect(store.list().notes).toHaveLength(1)
  })

  it('refuses a target inside the current root', async () => {
    const store = await loadedStore()
    mkdirSync(join(dir, 'inner'), { recursive: true })

    const result = await store.migrate(join(dir, 'inner'))

    expect(result.ok).toBe(false)
    expect(result.message).toContain('不能放在当前数据目录里面')
  })
})

describe('batch operations', () => {
  it.each(['single', 'batch'] as const)('keeps rows, tombstones and audio when %s deletion cannot be saved', async (kind) => {
    settings.polish.enabled = false
    const store = await loadedStore()
    const first = await store.create({ pcm: pcm(), durationMs: 1000 })
    await vi.waitFor(() => expect(store.list().notes[0].polishStatus).toBe('skipped'))
    const before = store.list()
    const diskBefore = readDb(dir)
    const pendingBefore = store.pendingCount()
    const file = store.audioPathOf(first.id)!
    const temp = join(dir, `notes.json.${process.pid}.tmp`)
    mkdirSync(temp)
    const remove = () => kind === 'single' ? store.remove(first.id) : store.applyBulk([first.id], { delete: true })
    await expect(remove()).rejects.toThrow()
    expect(store.list()).toEqual(before)
    expect(store.pendingCount()).toBe(pendingBefore)
    expect(readDb(dir)).toEqual(diskBefore)
    expect(existsSync(file)).toBe(true)
    rmSync(temp, { recursive: true })
    await remove()
    expect(store.list().notes).toHaveLength(0)
    expect(readDb(dir).deleted?.map(row => row.id)).toContain(first.id)
    expect(existsSync(file)).toBe(false)
  })

  it('does not acknowledge or retain batch tag edits when saving fails', async () => {
    const store = await loadedStore()
    const note = await store.createText({ text: 'keep me' })
    const before = store.list()
    const diskBefore = readDb(dir)
    mkdirSync(join(dir, `notes.json.${process.pid}.tmp`))
    await expect(store.applyBulk([note.id], { addTags: ['work'] })).rejects.toThrow()
    expect(store.list()).toEqual(before)
    expect(readDb(dir)).toEqual(diskBefore)
  })

  it('deletes every selected note together with its recording', async () => {
    const store = await loadedStore()
    const first = await store.create({ pcm: pcm(), durationMs: 1000 })
    const second = await store.create({ pcm: pcm(), durationMs: 1000 })
    const keep = await store.create({ pcm: pcm(), durationMs: 1000 })
    const audioFirst = store.audioPathOf(first.id)!
    const audioSecond = store.audioPathOf(second.id)!
    const audioKeep = store.audioPathOf(keep.id)!
    expect(existsSync(audioFirst)).toBe(true)

    // A stale id in the selection must not change the outcome.
    const result = await store.applyBulk([first.id, second.id, 'gone'], { delete: true })

    expect(result).toEqual({ matched: 2, changed: 2 })
    expect(store.list().notes.map((note) => note.id)).toEqual([keep.id])
    expect(existsSync(audioFirst)).toBe(false)
    expect(existsSync(audioSecond)).toBe(false)
    expect(existsSync(audioKeep)).toBe(true)
    // One write for the whole batch, so the file matches memory exactly.
    expect(readDb(dir).notes.map((note) => note.id)).toEqual([keep.id])
  })

  it('files a selection under a category and clears it again', async () => {
    const store = await loadedStore()
    await store.setCategories([{ id: 'cat-work', name: '工作' }])
    const first = await store.create({ pcm: pcm(), durationMs: 500 })
    const second = await store.create({ pcm: pcm(), durationMs: 500 })

    await store.applyBulk([first.id, second.id], { categoryId: 'cat-work' })
    expect(store.list().notes.map((note) => note.categoryId)).toEqual(['cat-work', 'cat-work'])

    await store.applyBulk([first.id], { categoryId: null })
    const byId = new Map(store.list().notes.map((note) => [note.id, note]))
    expect(byId.get(first.id)!.categoryId).toBeUndefined()
    expect(byId.get(second.id)!.categoryId).toBe('cat-work')

    // An id that no longer exists clears the field instead of storing a dangling
    // reference, which would show as an empty chip after the next reload.
    await store.applyBulk([second.id], { categoryId: 'cat-deleted' })
    expect(new Map(store.list().notes.map((note) => [note.id, note])).get(second.id)!.categoryId).toBeUndefined()
  })

  it('adds a tag once across the selection and removes it again', async () => {
    const store = await loadedStore()
    const first = await store.create({ pcm: pcm(), durationMs: 500 })
    const second = await store.create({ pcm: pcm(), durationMs: 500 })
    await store.applyBulk([first.id], { addTags: ['会议'] })

    const result = await store.applyBulk([first.id, second.id], { addTags: ['会议', '  灵感  '] })

    expect(result).toEqual({ matched: 2, changed: 2 })
    const byId = new Map(store.list().notes.map((note) => [note.id, note]))
    expect(byId.get(first.id)!.tags).toEqual(['会议', '灵感'])
    expect(byId.get(second.id)!.tags).toEqual(['会议', '灵感'])
    expect(readDb(dir).notes.find((note) => note.id === second.id)!.tags).toEqual(['会议', '灵感'])

    await store.applyBulk([first.id, second.id], { removeTags: ['会议'] })
    expect(store.list().notes.map((note) => note.tags)).toEqual([['灵感'], ['灵感']])
  })

  it('reports nothing to do when the selection matches no note', async () => {
    const store = await loadedStore()
    await store.create({ pcm: pcm(), durationMs: 500 })

    expect(await store.applyBulk([], { delete: true })).toEqual({ matched: 0, changed: 0 })
    expect(await store.applyBulk(['missing'], { addTags: ['x'] })).toEqual({ matched: 0, changed: 0 })
    expect(store.list().notes).toHaveLength(1)
  })
})
