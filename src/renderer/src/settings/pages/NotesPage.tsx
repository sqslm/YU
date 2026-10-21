import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  IconButton,
  InputBase,
  Menu,
  MenuItem,
  Slider,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import PauseIcon from '@mui/icons-material/Pause'
import PlayIcon from '@mui/icons-material/PlayArrow'
import { useTranslation } from 'react-i18next'
import type { NoteBulk, NoteCategory, NoteEntry, NotePatch, Settings } from '@shared/types'
import { MicCapture } from '../../bar/capture'
import { IconMic, IconPlus, IconSearch, IconSettings, IconSparkles, IconTrash } from '../icons'
import {
  ALL_CATEGORIES,
  MAX_TAGS,
  PLAYBACK_RATES,
  TAG_FILTER_LIMIT,
  addTag,
  categoryNameOf,
  clampPlaybackRate,
  collectTags,
  emptyStateCopy,
  emptyStateKind,
  filterNotes,
  formatClock,
  formatDuration,
  formatStamp,
  nextSaveState,
  removeTag,
  saveStateKey,
  summarize,
  toggleTag,
  type NoteSort,
  type SaveState
} from './notesView'

/** Typing pause before a text edit is written; blur and navigation flush earlier. */
const SAVE_DEBOUNCE_MS = 600
/** The search box waits this long so a fast typist issues one filter pass, not eight. */
const SEARCH_DEBOUNCE_MS = 150
/** `MicCapture` is created at 16 kHz, so sample count is duration. */
const SAMPLE_RATE = 16_000
/** Shown when the stored chord is empty, so the row is never blank. */
const DEFAULT_NOTES_CHORD_LABEL = 'Ctrl + Alt + N'

const SAVE_TONE: Record<SaveState, string> = {
  idle: 'text.disabled',
  pending: 'text.secondary',
  saving: 'text.secondary',
  saved: 'text.disabled',
  error: 'error.main'
}

const pillSx = (active: boolean) => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  height: 24,
  px: 1.1,
  borderRadius: '99px',
  border: 1,
  borderColor: active ? 'primary.main' : 'divider',
  bgcolor: active ? 'action.selected' : 'transparent',
  color: active ? 'primary.main' : 'text.secondary',
  fontSize: 11.5,
  fontWeight: 500,
  cursor: 'pointer',
  userSelect: 'none',
  whiteSpace: 'nowrap',
  '&:hover': { bgcolor: active ? 'action.selected' : 'action.hover' },
  '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 1 }
})

/** Compact text button for the batch bar; five of them share one row. */
const bulkButtonSx = {
  minWidth: 0,
  fontSize: 11.5,
  px: 0.9,
  py: 0.1,
  color: 'text.secondary',
  '&:hover': { bgcolor: 'action.selected', color: 'text.primary' }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface NotesPageProps {
  settings: Settings
  /** `useSettings` debounces the write; the page only states the preference. */
  patch: (delta: Partial<Settings>) => void | Promise<unknown>
  /**
   * Increments once per press of the global 随记录音 chord. A change means
   * "toggle the recorder"; 0 means no press has happened yet.
   */
  recordTicket?: number
}

/**
 * 随记: a two-pane notebook over `window.api.notes`.
 *
 * All filtering, summarising and time formatting lives in `notesView`; this file
 * owns only the wiring that needs a DOM — drafts, the debounced write, the single
 * `<audio>` element and the microphone. Edits are written per field so a note
 * that was only searched never gets its transcript rewritten.
 */
/**
 * Highest 随记录音 ticket this page has acted on.
 *
 * Module level on purpose: the hub remounts the page on every navigation, and a
 * per-mount marker would either replay an old press (re-opening the recorder long
 * after the fact) or swallow the press that was the reason for the navigation.
 */
let lastRecordTicket = 0

export function NotesPage({ settings, patch, recordTicket = 0 }: NotesPageProps): JSX.Element {
  const { t } = useTranslation()

  const [notes, setNotes] = useState<NoteEntry[]>([])
  const [categories, setCategories] = useState<NoteCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('')

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [categoryId, setCategoryId] = useState(ALL_CATEGORIES)
  const [activeTags, setActiveTags] = useState<string[]>([])
  const [sort, setSort] = useState<NoteSort>('newest')

  const [transcriptDraft, setTranscriptDraft] = useState('')
  const [polishedDraft, setPolishedDraft] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [tagInput, setTagInput] = useState('')

  const [starting, setStarting] = useState(false)
  const [recording, setRecording] = useState(false)
  const [recordedMs, setRecordedMs] = useState(0)
  const [micMessage, setMicMessage] = useState('')

  const [playing, setPlaying] = useState(false)
  const [positionMs, setPositionMs] = useState(0)
  const [durationMs, setDurationMs] = useState(0)
  /** Set while the thumb is dragged so the clock follows the finger, not the file. */
  const [scrubMs, setScrubMs] = useState<number | null>(null)

  const [repolishOpen, setRepolishOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  /** The 分类 manager: the hub had no way to create a bucket, only to filter by one. */
  const [categoriesOpen, setCategoriesOpen] = useState(false)
  const [categoryDraft, setCategoryDraft] = useState('')
  const [busy, setBusy] = useState(false)

  /**
   * 批量操作: the ids ticked in the sidebar, plus the three popovers that carry the
   * actual actions. Selection is UI state, not a view — it never touches the store
   * until one of the batch calls below runs.
   */
  const [selection, setSelection] = useState<string[]>([])
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkCategoryAt, setBulkCategoryAt] = useState<HTMLElement | null>(null)
  const [bulkTagOpen, setBulkTagOpen] = useState(false)
  const [bulkTagDraft, setBulkTagDraft] = useState('')
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  /** Confirmation for the batch calls; `notice` stays reserved for problems. */
  const [flash, setFlash] = useState('')
  /** 随记 settings: currently just whether the chord brings the hub forward. */
  const [prefsOpen, setPrefsOpen] = useState(false)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const micRef = useRef<MicCapture | null>(null)
  /**
   * The server-side text the drafts were last built from. Comparing against it
   * is how the page tells "the model just filled this in" from "the user typed".
   */
  const draftBaseRef = useRef<{ id: string | null; transcript: string; polished: string }>({
    id: null,
    transcript: '',
    polished: ''
  })
  const micErrorRef = useRef('')
  const chunksRef = useRef<Int16Array[]>([])
  const recStartRef = useRef(0)
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<{ id: string; patch: NotePatch } | null>(null)

  /**
   * Mirrors kept during render so the effect that resets drafts on a selection
   * change can read the freshest store without listing `notes` as a dependency
   * (which would re-run it — and wipe the draft — on every unrelated update).
   */
  const notesRef = useRef<NoteEntry[]>(notes)
  notesRef.current = notes

  const reload = useCallback(async (): Promise<void> => {
    try {
      const store = await window.api.notes.list()
      setNotes(store.notes ?? [])
      setCategories(store.categories ?? [])
      setLoadError('')
    } catch (err) {
      setLoadError(messageOf(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
    // Main owns the store, so an external change (bar dictation, second window)
    // is the only thing that can move the list behind our back.
    return window.api.notes.onChanged(() => {
      void reload()
    })
  }, [reload])

  const ordered = useMemo(() => filterNotes(notes, { sort }), [notes, sort])
  const visible = useMemo(
    () => filterNotes(notes, { query, categoryId, tags: activeTags, sort }, categories),
    [notes, query, categoryId, activeTags, sort, categories]
  )
  const tagOptions = useMemo(() => collectTags(notes, TAG_FILTER_LIMIT), [notes])
  const selected = useMemo(() => notes.find((note) => note.id === selectedId) ?? null, [notes, selectedId])
  const selectedRef = useRef<NoteEntry | null>(selected)
  selectedRef.current = selected

  const audioKey = selected?.audioPath ?? ''
  const rate = clampPlaybackRate(settings.notePlaybackRate)

  useEffect(() => {
    const id = setTimeout(() => setQuery(queryInput), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [queryInput])

  // Keep the selection pointing at a note that still exists; the order comes
  // from the unfiltered list so a filter change never steals the selection.
  useEffect(() => {
    if (notes.length === 0) {
      if (selectedId !== null) setSelectedId(null)
      return
    }
    if (selectedId && notes.some((note) => note.id === selectedId)) return
    setSelectedId(ordered[0]?.id ?? null)
  }, [notes, ordered, selectedId])

  // A new selection gets fresh drafts; the previous note was flushed by the
  // click handler before this ran.
  useEffect(() => {
    const note = notesRef.current.find((item) => item.id === selectedId) ?? null
    setTranscriptDraft(note?.transcript ?? '')
    setPolishedDraft(note?.polished ?? '')
    draftBaseRef.current = { id: note?.id ?? null, transcript: note?.transcript ?? '', polished: note?.polished ?? '' }
    setTagInput('')
    setSaveState(nextSaveState('idle', 'reset'))
  }, [selectedId])

  /**
   * A take is stored empty and filled in later: `notes.create` returns the row
   * before ASR and the polish prompt have run, and main pushes `notes:changed`
   * when the text lands. Resetting drafts on `selectedId` alone left the two
   * editors blank until the page was left and re-entered, so a finished recording
   * looked like it had produced nothing.
   *
   * A field is only overwritten when the draft still shows the previous server
   * text — i.e. the user has not typed into it. Anything else (a local edit, or a
   * save still in flight) keeps what is on screen and leaves the text to the
   * debounced write, so a late transcript can never clobber a correction.
   */
  useEffect(() => {
    const note = selected
    const base = draftBaseRef.current
    if (!note || !base || base.id !== note.id) return
    const pending = pendingRef.current
    const ownsText = pending && pending.id === note.id

    if (note.transcript !== base.transcript) {
      const userTyped = Boolean(ownsText && pending?.patch.transcript !== undefined)
      if (!userTyped && transcriptDraft === base.transcript) setTranscriptDraft(note.transcript)
      base.transcript = note.transcript
    }
    if (note.polished !== base.polished) {
      const userTyped = Boolean(ownsText && pending?.patch.polished !== undefined)
      if (!userTyped && polishedDraft === base.polished) setPolishedDraft(note.polished)
      base.polished = note.polished
    }
  }, [selected, transcriptDraft, polishedDraft])

  const patchEntry = useCallback((updated: NoteEntry): void => {
    setNotes((prev) => prev.map((note) => (note.id === updated.id ? updated : note)))
  }, [])

  const flushNow = useCallback(async (): Promise<void> => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = null
    setSaveState((prev) => nextSaveState(prev, 'flushStarted'))
    try {
      const updated = await window.api.notes.update(pending.id, pending.patch)
      if (updated) patchEntry(updated)
      setSaveState((prev) => nextSaveState(prev, 'flushSucceeded'))
    } catch {
      // The patch is the only copy of what the user typed: dropping it left the
      // edit visible until the page closed and then gone for good. Put it back so
      // the next flush can retry, unless newer edits already queued their own.
      pendingRef.current = pendingRef.current ?? pending
      setSaveState((prev) => nextSaveState(prev, 'flushFailed'))
    }
  }, [patchEntry])

  const editField = useCallback(
    (field: 'transcript' | 'polished', value: string): void => {
      if (field === 'transcript') setTranscriptDraft(value)
      else setPolishedDraft(value)
      const note = selectedRef.current
      if (!note) return
      // Only the touched field enters the patch: a note whose transcript was
      // never edited must not have it rewritten from a possibly stale draft.
      const base: NotePatch = pendingRef.current?.id === note.id ? pendingRef.current.patch : {}
      const next: NotePatch = { ...base }
      next[field] = value
      pendingRef.current = { id: note.id, patch: next }
      setSaveState((prev) => nextSaveState(prev, 'edited'))
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null
        void flushNow()
      }, SAVE_DEBOUNCE_MS)
    },
    [flushNow]
  )

  // Unmount and window close must not drop a pending edit. `beforeunload` cannot
  // await an IPC round-trip, so the write is fired and left to settle in main.
  useEffect(() => {
    const fire = (): void => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      const pending = pendingRef.current
      if (!pending) return
      pendingRef.current = null
      void window.api.notes.update(pending.id, pending.patch).catch(() => undefined)
    }
    window.addEventListener('beforeunload', fire)
    return () => {
      window.removeEventListener('beforeunload', fire)
      fire()
    }
  }, [])

  const selectNote = useCallback(
    (id: string | null): void => {
      if (id === selectedId) return
      void flushNow()
      setSelectedId(id)
    },
    [flushNow, selectedId]
  )

  // ---- microphone -------------------------------------------------------

  const startRecording = async (): Promise<void> => {
    if (recording || starting) return
    setStarting(true)
    setMicMessage('')
    micErrorRef.current = ''
    chunksRef.current = []
    const mic = new MicCapture({
      onChunk: (chunk) => {
        chunksRef.current.push(chunk)
      },
      onError: (message) => {
        // `start()` swallows the getUserMedia rejection, so the only record of it
        // is this callback; keep it until the caller reads `isRunning`.
        micErrorRef.current = message
        setMicMessage(message)
      },
      onLevel: () => undefined
    })
    micRef.current = mic
    try {
      await mic.setDevice(settings.inputDeviceId ?? '')
      mic.setActive(true)
      await mic.start()
    } catch (err) {
      micErrorRef.current = messageOf(err)
    }
    if (!mic.isRunning) {
      micRef.current = null
      setMicMessage(micErrorRef.current || t('notes.micUnavailable'))
      setStarting(false)
      return
    }
    recStartRef.current = Date.now()
    setRecordedMs(0)
    setRecording(true)
    setStarting(false)
    recTimerRef.current = setInterval(() => setRecordedMs(Date.now() - recStartRef.current), 200)
  }

  const stopRecording = async (): Promise<void> => {
    if (!recording) return
    const mic = micRef.current
    micRef.current = null
    if (recTimerRef.current) {
      clearInterval(recTimerRef.current)
      recTimerRef.current = null
    }
    setRecording(false)
    setRecordedMs(0)
    if (mic) {
      mic.setActive(false)
      await mic.stop()
    }
    const parts = chunksRef.current
    chunksRef.current = []
    const samples = parts.reduce((total, part) => total + part.length, 0)
    if (samples === 0) {
      setMicMessage(t('notes.micEmpty'))
      return
    }
    const pcm = new Int16Array(samples)
    let offset = 0
    for (const part of parts) {
      pcm.set(part, offset)
      offset += part.length
    }
    const durationMs = Math.round((samples / SAMPLE_RATE) * 1000)
    try {
      // Filing the take under the category currently being filtered keeps a
      // recording session on one topic without a second step.
      const created = await window.api.notes.create({
        pcm,
        durationMs,
        categoryId: categoryId || undefined
      })
      setNotes((prev) => [created, ...prev.filter((note) => note.id !== created.id)])
      setSelectedId(created.id)
      void reload()
    } catch (err) {
      setMicMessage(messageOf(err))
    }
  }

  // Leaving the page must not hold the device open.
  useEffect(() => {
    return () => {
      if (recTimerRef.current) clearInterval(recTimerRef.current)
      recTimerRef.current = null
      const mic = micRef.current
      micRef.current = null
      if (mic) {
        mic.setActive(false)
        void mic.stop()
      }
    }
  }, [])

  /**
   * The global 随记录音 chord, one press at a time.
   *
   * Held in a ref because the effect must not re-subscribe on every render: the
   * toggle closes over `recording`, and a stale closure would start a second take
   * instead of stopping the first.
   */
  const toggleRecorderRef = useRef<() => void>(() => undefined)
  toggleRecorderRef.current = (): void => {
    if (recording) void stopRecording()
    else void startRecording()
  }
  useEffect(() => {
    if (recordTicket <= lastRecordTicket) return
    lastRecordTicket = recordTicket
    toggleRecorderRef.current()
  }, [recordTicket])

  // ---- player -----------------------------------------------------------

  // One element for the whole page: a fresh `<audio>` per note would leak the
  // decoder and race the previous playback's `timeupdate` events.
  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    const onTime = (): void => setPositionMs(el.currentTime * 1000)
    const onMeta = (): void => {
      if (Number.isFinite(el.duration) && el.duration > 0) setDurationMs(el.duration * 1000)
    }
    const onPlay = (): void => setPlaying(true)
    const onPause = (): void => setPlaying(false)
    const onEnded = (): void => {
      setPlaying(false)
      setPositionMs(0)
    }
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('loadedmetadata', onMeta)
    el.addEventListener('durationchange', onMeta)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('ended', onEnded)
    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('loadedmetadata', onMeta)
      el.removeEventListener('durationchange', onMeta)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('ended', onEnded)
      el.pause()
      el.src = ''
      el.load()
    }
  }, [])

  useEffect(() => {
    const el = audioRef.current
    setPlaying(false)
    setPositionMs(0)
    setScrubMs(null)
    setDurationMs(0)
    if (!el) return
    el.pause()
    el.src = ''
    el.load()
    if (!selectedId || !audioKey) return
    let alive = true
    void window.api.notes
      .audioUrl(selectedId)
      .then((url) => {
        if (!alive || !url) return
        el.src = url
        el.load()
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [selectedId, audioKey])

  useEffect(() => {
    const el = audioRef.current
    if (el) el.playbackRate = rate
  }, [rate])

  const totalMs = durationMs > 0 ? durationMs : (selected?.durationMs ?? 0)
  const shownMs = scrubMs ?? positionMs
  const maxMs = Math.max(totalMs, 1)

  const togglePlay = (): void => {
    const el = audioRef.current
    if (!el || !audioKey) return
    if (el.paused) {
      el.playbackRate = rate
      void el.play().catch(() => setNotice(t('notes.playFailed')))
      return
    }
    el.pause()
  }

  const commitSeek = (value: number | number[]): void => {
    const ms = Array.isArray(value) ? value[0] : value
    setScrubMs(null)
    setPositionMs(ms)
    const el = audioRef.current
    if (!el || !Number.isFinite(el.duration)) return
    el.currentTime = Math.min(ms / 1000, el.duration)
  }

  // ---- note mutations ---------------------------------------------------

  const changeCategory = async (next: string): Promise<void> => {
    const note = selectedRef.current
    if (!note) return
    setNotice('')
    try {
      const updated = await window.api.notes.update(note.id, { categoryId: next })
      if (updated) patchEntry(updated)
    } catch (err) {
      setNotice(messageOf(err))
    }
  }

  const commitTags = async (tags: string[]): Promise<void> => {
    const note = selectedRef.current
    if (!note) return
    setNotice('')
    try {
      const updated = await window.api.notes.update(note.id, { tags })
      if (updated) patchEntry(updated)
    } catch (err) {
      setNotice(messageOf(err))
    }
  }

  const submitTag = (): void => {
    const note = selectedRef.current
    if (!note) return
    const next = addTag(note.tags, tagInput)
    setTagInput('')
    if (next.length === note.tags.length) return
    void commitTags(next)
  }

  /**
   * Writes the whole category list back, which is what the store exposes: it
   * keeps `notes` untouched and only clears references to categories that are
   * gone, so deleting a bucket never deletes a note.
   */
  const writeCategories = async (next: NoteCategory[]): Promise<void> => {
    try {
      const saved = await window.api.notes.setCategories(next)
      setCategories(saved)
      // A note that lost its bucket must stop showing the old chip, so re-read.
      void reload()
    } catch (err) {
      setNotice(messageOf(err))
    }
  }

  const createCategory = async (): Promise<void> => {
    const name = categoryDraft.trim()
    if (!name) return
    if (categories.some((category) => category.name === name)) {
      setNotice(t('notes.categoryExists'))
      return
    }
    // A stable, opaque id: the name is editable, the id must never be derived
    // from it or a rename would orphan every note filed under it.
    const id = `cat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    await writeCategories([...categories, { id, name }])
    setCategoryDraft('')
  }

  const removeCategory = async (id: string): Promise<void> => {
    if (categoryId === id) setCategoryId(ALL_CATEGORIES)
    await writeCategories(categories.filter((category) => category.id !== id))
  }

  const runRepolish = async (): Promise<void> => {
    const note = selectedRef.current
    setRepolishOpen(false)
    if (!note) return
    // Flush first: the fresh polish must not race an older transcript write.
    await flushNow()
    setBusy(true)
    setNotice('')
    try {
      const updated = await window.api.notes.repolish(note.id)
      if (!updated) return
      patchEntry(updated)
      const pending = pendingRef.current
      if (!(pending && pending.id === updated.id && pending.patch.polished !== undefined)) {
        setPolishedDraft(updated.polished)
      }
    } catch (err) {
      setNotice(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const deleteNote = async (): Promise<void> => {
    const note = selectedRef.current
    setDeleteOpen(false)
    if (!note) return
    try {
      await window.api.notes.remove(note.id)
      pendingRef.current = null
      setNotes((prev) => prev.filter((item) => item.id !== note.id))
      setSelectedId(null)
    } catch (err) {
      setNotice(messageOf(err))
    }
  }

  // ---- 批量操作 ---------------------------------------------------------

  /**
   * Selection is pruned against the live store: a note deleted elsewhere (bar,
   * second window) must not stay ticked and then get acted on by a stale id.
   */
  useEffect(() => {
    setSelection((prev) => {
      if (prev.length === 0) return prev
      const live = new Set(notes.map((note) => note.id))
      const next = prev.filter((id) => live.has(id))
      return next.length === prev.length ? prev : next
    })
  }, [notes])

  const selectedSet = useMemo(() => new Set(selection), [selection])
  const allVisibleSelected = visible.length > 0 && visible.every((note) => selectedSet.has(note.id))

  const toggleSelected = (id: string): void => {
    // A confirmation from the previous batch must not sit next to a new tick.
    setFlash('')
    setSelection((prev) => (prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]))
  }

  /**
   * One batch call for the whole selection.
   *
   * `visible` is already narrowed by the category/tag/search filters, so 全选 means
   * "everything this list is showing" — pick a category first and the batch lands
   * only inside that category, pick 全部随记 and it lands on everything.
   */
  const applyBulk = async (bulk: NoteBulk): Promise<void> => {
    const ids = selection
    if (ids.length === 0) return
    setBulkBusy(true)
    setNotice('')
    setFlash('')
    try {
      const result = await window.api.notes.applyBulk(ids, bulk)
      setSelection([])
      if (bulk.delete && selectedId && ids.includes(selectedId)) setSelectedId(null)
      await reload()
      if (result.changed > 0) setFlash(t('notes.bulkDone', { count: result.changed }))
    } catch (err) {
      setNotice(messageOf(err))
    } finally {
      setBulkBusy(false)
    }
  }

  const prefsOpenApp = settings.hotkeys.notesOpenApp !== false
  const notesChordLabel =
    settings.hotkeys.notesKeys?.keys?.join(' + ') || DEFAULT_NOTES_CHORD_LABEL

  const emptyKind = emptyStateKind({ total: notes.length, visible: visible.length })
  const emptyCopy = emptyStateCopy(emptyKind)
  const saveKey = saveStateKey(saveState)

  return (
    <Box data-notes-page sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Box
        data-notes-toolbar
        sx={{ px: 3, pt: 2, pb: 1, display: 'flex', flexDirection: 'column', gap: 1, flex: '0 0 auto' }}
      >
        <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <Box
            data-notes-search
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              height: 34,
              px: 1.25,
              width: 230,
              borderRadius: '8px',
              bgcolor: 'action.hover'
            }}
          >
            <Box sx={{ display: 'flex', color: 'text.disabled' }}>
              <IconSearch size={14} />
            </Box>
            <InputBase
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
              placeholder={t('notes.searchPlaceholder')}
              sx={{ flex: 1, fontSize: 12.5 }}
              inputProps={{ 'aria-label': t('notes.searchPlaceholder') }}
            />
          </Box>

          <TextField
            data-notes-category-filter
            select
            size="small"
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
            sx={{ width: 136, '& .MuiInputBase-input': { fontSize: 12.5 } }}
            aria-label={t('notes.categoryFilter')}
          >
            <MenuItem value={ALL_CATEGORIES}>{t('notes.allCategories')}</MenuItem>
            {categories.map((category) => (
              <MenuItem key={category.id} value={category.id}>
                {category.name}
              </MenuItem>
            ))}
          </TextField>

          <Tooltip title={t('notes.categoryManage')}>
            <IconButton
              data-notes-category-manage
              size="small"
              onClick={() => {
                setCategoryDraft('')
                setCategoriesOpen(true)
              }}
              sx={{ border: '1px solid', borderColor: 'divider', borderRadius: '8px', width: 30, height: 30 }}
              aria-label={t('notes.categoryManage')}
            >
              <IconPlus size={14} />
            </IconButton>
          </Tooltip>

          <Box
            role="button"
            tabIndex={0}
            data-notes-sort={sort}
            aria-pressed={sort === 'newest'}
            onClick={() => setSort((prev) => (prev === 'newest' ? 'oldest' : 'newest'))}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                setSort((prev) => (prev === 'newest' ? 'oldest' : 'newest'))
              }
            }}
            sx={pillSx(false)}
          >
            {sort === 'newest' ? t('notes.sortNewest') : t('notes.sortOldest')}
          </Box>

          <Box sx={{ flex: 1 }} />

          {recording && (
            <Stack
              direction="row"
              spacing={0.75}
              alignItems="center"
              data-notes-recording
              data-notes-elapsed={Math.floor(recordedMs / 1000)}
            >
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  bgcolor: 'error.main',
                  animation: 'notesPulse 1.2s ease-in-out infinite',
                  '@keyframes notesPulse': {
                    '0%, 100%': { opacity: 1, transform: 'scale(1)' },
                    '50%': { opacity: 0.3, transform: 'scale(0.78)' }
                  }
                }}
              />
              <Typography
                data-notes-elapsed-label
                sx={{ fontSize: 11.5, color: 'error.main', fontVariantNumeric: 'tabular-nums' }}
              >
                {formatClock(recordedMs)}
              </Typography>
            </Stack>
          )}

          <Tooltip title={t('notes.prefsTitle')}>
            <IconButton
              data-notes-prefs-open
              size="small"
              onClick={() => setPrefsOpen(true)}
              sx={{ border: '1px solid', borderColor: 'divider', borderRadius: '8px', width: 30, height: 30 }}
              aria-label={t('notes.prefsTitle')}
            >
              <IconSettings size={14} />
            </IconButton>
          </Tooltip>

          <Button
            data-notes-record={recording ? 'on' : 'idle'}
            size="small"
            variant={recording ? 'contained' : 'outlined'}
            color={recording ? 'error' : 'primary'}
            disabled={starting}
            onClick={() => void (recording ? stopRecording() : startRecording())}
            startIcon={<IconMic size={14} />}
            sx={{ fontSize: 12, height: 34 }}
          >
            {recording ? t('notes.recordStop') : t('notes.record')}
          </Button>
        </Stack>

        {tagOptions.length > 0 && (
          <Stack
            data-notes-tag-filter-row
            direction="row"
            spacing={0.75}
            sx={{ flexWrap: 'wrap', rowGap: 0.75, alignItems: 'center' }}
          >
            {tagOptions.map(({ tag, count }) => {
              const active = activeTags.some((value) => value === tag)
              return (
                <Box
                  key={tag}
                  role="button"
                  tabIndex={0}
                  data-notes-tag-filter={tag}
                  data-notes-tag-active={active ? 'on' : 'off'}
                  aria-pressed={active}
                  onClick={() => setActiveTags((prev) => toggleTag(prev, tag))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setActiveTags((prev) => toggleTag(prev, tag))
                    }
                  }}
                  sx={pillSx(active)}
                >
                  #{tag}
                  <Box component="span" sx={{ opacity: 0.55 }}>
                    {count}
                  </Box>
                </Box>
              )
            })}
          </Stack>
        )}

        {selection.length > 0 && (
          <Stack
            data-notes-bulk-bar
            data-notes-bulk-count={selection.length}
            data-notes-bulk-scope={visible.length}
            direction="row"
            spacing={0.75}
            sx={{
              alignItems: 'center',
              flexWrap: 'wrap',
              rowGap: 0.75,
              px: 1.25,
              py: 0.75,
              borderRadius: '8px',
              bgcolor: 'action.hover'
            }}
          >
            <Typography data-notes-bulk-label sx={{ fontSize: 11.5, color: 'text.secondary' }}>
              {t('notes.bulkSelected', { count: selection.length })}
            </Typography>
            <Button
              size="small"
              data-notes-bulk-select-all={allVisibleSelected ? 'on' : 'off'}
              disabled={bulkBusy || visible.length === 0}
              onClick={() =>
                setSelection(allVisibleSelected ? [] : visible.map((note) => note.id))
              }
              sx={bulkButtonSx}
            >
              {allVisibleSelected ? t('notes.bulkSelectNone') : t('notes.bulkSelectAll')}
            </Button>
            <Button
              size="small"
              data-notes-bulk-category
              disabled={bulkBusy}
              onClick={(event) => setBulkCategoryAt(event.currentTarget)}
              sx={bulkButtonSx}
            >
              {t('notes.bulkCategory')}
            </Button>
            <Button
              size="small"
              data-notes-bulk-tag
              disabled={bulkBusy}
              onClick={() => {
                setBulkTagDraft('')
                setBulkTagOpen(true)
              }}
              sx={bulkButtonSx}
            >
              {t('notes.bulkTag')}
            </Button>
            <Button
              size="small"
              color="error"
              data-notes-bulk-delete
              disabled={bulkBusy}
              onClick={() => setBulkDeleteOpen(true)}
              sx={bulkButtonSx}
            >
              {t('common.delete')}
            </Button>
            <Button
              size="small"
              data-notes-bulk-cancel
              disabled={bulkBusy}
              onClick={() => setSelection([])}
              sx={bulkButtonSx}
            >
              {t('common.cancel')}
            </Button>
            <Box sx={{ flex: 1 }} />
            <Typography sx={{ fontSize: 10.5, color: 'text.disabled' }}>
              {t('notes.bulkScopeHint', { count: visible.length })}
            </Typography>
          </Stack>
        )}

        {flash && (
          <Typography data-notes-flash sx={{ fontSize: 11.5, color: 'text.secondary' }}>
            {flash}
          </Typography>
        )}
        {micMessage && (
          <Typography data-notes-mic-error sx={{ fontSize: 11.5, color: 'warning.main' }}>
            {micMessage}
          </Typography>
        )}
        {notice && (
          <Typography data-notes-notice sx={{ fontSize: 11.5, color: 'warning.main' }}>
            {notice}
          </Typography>
        )}
        {loadError && (
          <Typography data-notes-load-error sx={{ fontSize: 11.5, color: 'error.main' }}>
            {loadError}
          </Typography>
        )}
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <Box
          data-notes-list
          data-notes-visible={visible.length}
          sx={{
            width: 320,
            flex: '0 0 320px',
            minHeight: 0,
            overflowY: 'auto',
            borderTop: '1px solid',
            borderRight: '1px solid',
            borderColor: 'divider'
          }}
        >
          {loading && (
            <Typography sx={{ px: 2.5, py: 3, fontSize: 12, color: 'text.disabled' }}>
              {t('common.loading')}
            </Typography>
          )}

          {!loading && emptyKind !== 'none' && (
            <Box data-notes-empty={emptyKind} sx={{ px: 3, py: 5, textAlign: 'center' }}>
              <Typography sx={{ fontSize: 13, fontWeight: 600, color: 'text.secondary' }}>
                {t(emptyCopy.titleKey)}
              </Typography>
              <Typography sx={{ fontSize: 11.5, color: 'text.disabled', mt: 0.75, lineHeight: 1.6 }}>
                {t(emptyCopy.hintKey)}
              </Typography>
            </Box>
          )}

          {!loading &&
            visible.map((note) => {
              const active = note.id === selectedId
              const picked = selectedSet.has(note.id)
              const stamp = formatStamp(note.createdAt)
              const category = categoryNameOf(categories, note.categoryId)
              return (
                <Box
                  key={note.id}
                  role="button"
                  tabIndex={0}
                  data-notes-row={note.id}
                  data-notes-row-active={active ? 'on' : 'off'}
                  data-notes-row-picked={picked ? 'on' : 'off'}
                  aria-pressed={active}
                  onClick={() => selectNote(note.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      selectNote(note.id)
                    }
                  }}
                  sx={{
                    px: 2,
                    py: 1.25,
                    cursor: 'pointer',
                    borderBottom: '1px solid',
                    borderColor: 'divider',
                    bgcolor: picked ? 'action.selected' : active ? 'action.selected' : 'transparent',
                    // A 2px rail marks the ticked rows without shifting the text:
                    // the colour changes, the width stays.
                    borderLeft: '2px solid',
                    borderLeftColor: picked ? 'primary.main' : 'transparent',
                    '&:hover': { bgcolor: picked || active ? 'action.selected' : 'action.hover' },
                    '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 }
                  }}
                >
                  <Stack direction="row" spacing={1} alignItems="baseline">
                    <Checkbox
                      data-notes-row-select={note.id}
                      size="small"
                      checked={picked}
                      disableRipple
                      tabIndex={-1}
                      onChange={() => toggleSelected(note.id)}
                      onClick={(event) => event.stopPropagation()}
                      sx={{ p: 0.25, ml: -0.5, mr: -0.25, alignSelf: 'center' }}
                      inputProps={{ 'aria-label': t('notes.bulkPick') }}
                    />
                    <Typography
                      data-notes-row-time
                      sx={{ fontSize: 11.5, color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}
                    >
                      {stamp.time}
                    </Typography>
                    <Typography sx={{ fontSize: 10.5, color: 'text.disabled' }}>{stamp.day}</Typography>
                    <Box sx={{ flex: 1 }} />
                    <Typography
                      data-notes-row-duration
                      sx={{ fontSize: 10.5, color: 'text.disabled', fontVariantNumeric: 'tabular-nums' }}
                    >
                      {formatDuration(note.durationMs)}
                    </Typography>
                  </Stack>
                  <Typography
                    data-notes-row-summary
                    sx={{
                      fontSize: 12.5,
                      lineHeight: 1.45,
                      mt: 0.25,
                      color: 'text.primary',
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                      wordBreak: 'break-word'
                    }}
                  >
                    {summarize(note, 120) || '—'}
                  </Typography>
                  {(category || note.tags.length > 0) && (
                    <Stack direction="row" spacing={0.5} sx={{ mt: 0.75, flexWrap: 'wrap', rowGap: 0.5 }}>
                      {category && (
                        <Chip
                          data-notes-row-category={category}
                          size="small"
                          label={category}
                          sx={{ height: 18, fontSize: 10, borderRadius: '99px' }}
                        />
                      )}
                      {note.tags.slice(0, 3).map((tag) => (
                        <Chip
                          key={tag}
                          data-notes-row-tag={tag}
                          size="small"
                          label={`#${tag}`}
                          sx={{ height: 18, fontSize: 10, borderRadius: '99px' }}
                        />
                      ))}
                    </Stack>
                  )}
                </Box>
              )
            })}
        </Box>

        <Box
          data-notes-detail-pane
          sx={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflowY: 'auto',
            borderTop: '1px solid',
            borderColor: 'divider'
          }}
        >
          {!selected && (
            <Box data-notes-detail-empty sx={{ px: 3, py: 5, textAlign: 'center' }}>
              <Typography sx={{ fontSize: 12.5, color: 'text.disabled' }}>{t('notes.selectPrompt')}</Typography>
            </Box>
          )}

          {selected && (
            <Box data-notes-detail={selected.id} sx={{ px: 3, py: 2.5 }}>
              <Stack direction="row" spacing={1.25} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 0.75 }}>
                <Typography
                  data-notes-detail-time
                  sx={{ fontSize: 12, color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}
                >
                  {formatStamp(selected.createdAt).full || '—'}
                </Typography>
                <Typography
                  data-notes-detail-duration
                  sx={{ fontSize: 11, color: 'text.disabled', fontVariantNumeric: 'tabular-nums' }}
                >
                  {formatDuration(selected.durationMs)}
                </Typography>
                <Box sx={{ flex: 1 }} />
                <Typography data-notes-save-state={saveState} sx={{ fontSize: 11, color: SAVE_TONE[saveState] }}>
                  {saveKey ? t(saveKey) : ''}
                </Typography>
                <Tooltip title={t('notes.delete')}>
                  <IconButton data-notes-delete size="small" onClick={() => setDeleteOpen(true)}>
                    <IconTrash size={15} />
                  </IconButton>
                </Tooltip>
              </Stack>

              <Stack direction="row" spacing={1.5} sx={{ mt: 1.5, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <TextField
                  data-notes-category
                  select
                  size="small"
                  value={selected.categoryId ?? ALL_CATEGORIES}
                  onChange={(event) => void changeCategory(event.target.value)}
                  sx={{ width: 148, '& .MuiInputBase-input': { fontSize: 12.5 } }}
                  aria-label={t('notes.category')}
                >
                  <MenuItem value={ALL_CATEGORIES}>{t('notes.noCategory')}</MenuItem>
                  {categories.map((category) => (
                    <MenuItem key={category.id} value={category.id}>
                      {category.name}
                    </MenuItem>
                  ))}
                </TextField>

                <Box data-notes-tags sx={{ flex: 1, minWidth: 220 }}>
                  <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', rowGap: 0.75, alignItems: 'center' }}>
                    {selected.tags.map((tag) => (
                      <Chip
                        key={tag}
                        data-notes-tag={tag}
                        size="small"
                        label={`#${tag}`}
                        onDelete={() => void commitTags(removeTag(selected.tags, tag))}
                        sx={{ height: 22, fontSize: 11, borderRadius: '99px' }}
                      />
                    ))}
                    <TextField
                      data-notes-tag-input
                      size="small"
                      value={tagInput}
                      disabled={selected.tags.length >= MAX_TAGS}
                      placeholder={
                        selected.tags.length >= MAX_TAGS ? t('notes.tagLimit') : t('notes.tagPlaceholder')
                      }
                      onChange={(event) => setTagInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return
                        event.preventDefault()
                        submitTag()
                      }}
                      sx={{ width: 148, '& .MuiInputBase-input': { fontSize: 11.5, py: 0.6 } }}
                    />
                  </Stack>
                </Box>
              </Stack>

              <Stack spacing={2} sx={{ mt: 2.25 }}>
                <Box>
                  <Typography sx={{ fontSize: 11.5, fontWeight: 600, color: 'text.secondary', mb: 0.75 }}>
                    {t('notes.transcriptLabel')}
                  </Typography>
                  <TextField
                    data-notes-editor="transcript"
                    multiline
                    minRows={4}
                    fullWidth
                    value={transcriptDraft}
                    onChange={(event) => editField('transcript', event.target.value)}
                    onBlur={() => void flushNow()}
                    placeholder={t('notes.transcriptPlaceholder')}
                    InputProps={{ sx: { fontSize: 13, lineHeight: 1.65 } }}
                  />
                </Box>

                <Box>
                  <Typography sx={{ fontSize: 11.5, fontWeight: 600, color: 'text.secondary', mb: 0.75 }}>
                    {t('notes.polishedLabel')}
                  </Typography>
                  <TextField
                    data-notes-editor="polished"
                    multiline
                    minRows={4}
                    fullWidth
                    value={polishedDraft}
                    onChange={(event) => editField('polished', event.target.value)}
                    onBlur={() => void flushNow()}
                    placeholder={t('notes.polishedPlaceholder')}
                    InputProps={{ sx: { fontSize: 13, lineHeight: 1.65 } }}
                  />
                </Box>
              </Stack>

              <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.5, flexWrap: 'wrap' }}>
                <Button
                  data-notes-repolish
                  size="small"
                  variant="outlined"
                  disabled={busy}
                  onClick={() => setRepolishOpen(true)}
                  startIcon={<IconSparkles size={14} />}
                  sx={{ fontSize: 12 }}
                >
                  {t('notes.repolish')}
                </Button>
                {selected.polishStatus === 'failed' && (
                  <Typography data-notes-polish-failed sx={{ fontSize: 11, color: 'warning.main' }}>
                    {t('notes.polishFailed')}
                  </Typography>
                )}
              </Stack>

              <Box
                data-notes-player
                sx={{
                  mt: 2.5,
                  p: 1.25,
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: '10px',
                  bgcolor: 'background.paper'
                }}
              >
                <Stack direction="row" spacing={1.25} alignItems="center">
                  <IconButton
                    data-notes-play
                    data-notes-playing={playing ? 'on' : 'off'}
                    size="small"
                    disabled={!audioKey}
                    onClick={togglePlay}
                    aria-label={playing ? t('notes.pause') : t('notes.play')}
                  >
                    {playing ? <PauseIcon sx={{ fontSize: 18 }} /> : <PlayIcon sx={{ fontSize: 18 }} />}
                  </IconButton>
                  <Typography
                    data-notes-clock="position"
                    sx={{
                      fontSize: 10.5,
                      color: 'text.disabled',
                      fontVariantNumeric: 'tabular-nums',
                      minWidth: 32,
                      textAlign: 'right'
                    }}
                  >
                    {formatClock(shownMs)}
                  </Typography>
                  <Slider
                    data-notes-seek
                    size="small"
                    min={0}
                    max={maxMs}
                    value={Math.min(shownMs, maxMs)}
                    disabled={!audioKey}
                    onChange={(_event, value) => setScrubMs(Array.isArray(value) ? value[0] : value)}
                    onChangeCommitted={(_event, value) => commitSeek(value)}
                    sx={{ flex: 1 }}
                  />
                  <Typography
                    data-notes-clock="total"
                    sx={{ fontSize: 10.5, color: 'text.disabled', fontVariantNumeric: 'tabular-nums', minWidth: 32 }}
                  >
                    {formatClock(totalMs)}
                  </Typography>
                  <TextField
                    data-notes-rate
                    select
                    size="small"
                    value={String(rate)}
                    onChange={(event) => {
                      void patch({ notePlaybackRate: Number(event.target.value) })
                    }}
                    sx={{ width: 78, '& .MuiInputBase-input': { fontSize: 11.5, py: 0.6 } }}
                    aria-label={t('notes.rate')}
                  >
                    {PLAYBACK_RATES.map((option) => (
                      <MenuItem key={option} value={String(option)}>
                        {option}×
                      </MenuItem>
                    ))}
                  </TextField>
                </Stack>
              </Box>
            </Box>
          )}
        </Box>
      </Box>

      <audio ref={audioRef} preload="metadata" style={{ display: 'none' }} />

      <Dialog
        open={repolishOpen}
        onClose={() => setRepolishOpen(false)}
        slotProps={{ paper: { sx: { borderRadius: '12px' } } }}
      >
        <DialogTitle sx={{ fontSize: 15, fontWeight: 600, pb: 1 }}>{t('notes.repolishTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ fontSize: 12.5, lineHeight: 1.7 }}>{t('notes.repolishBody')}</DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 2.5, pb: 2 }}>
          <Button size="small" data-notes-repolish-cancel onClick={() => setRepolishOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            size="small"
            variant="contained"
            data-notes-repolish-confirm
            onClick={() => void runRepolish()}
            sx={{ fontSize: 12 }}
          >
            {t('notes.repolishConfirm')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        slotProps={{ paper: { sx: { borderRadius: '12px' } } }}
      >
        <DialogTitle sx={{ fontSize: 15, fontWeight: 600, pb: 1 }}>{t('notes.deleteTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ fontSize: 12.5, lineHeight: 1.7 }}>{t('notes.deleteBody')}</DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 2.5, pb: 2 }}>
          <Button size="small" data-notes-delete-cancel onClick={() => setDeleteOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            size="small"
            variant="contained"
            color="error"
            data-notes-delete-confirm
            onClick={() => void deleteNote()}
            sx={{ fontSize: 12 }}
          >
            {t('common.delete')}
          </Button>
        </DialogActions>
      </Dialog>

      <Menu
        anchorEl={bulkCategoryAt}
        open={Boolean(bulkCategoryAt)}
        onClose={() => setBulkCategoryAt(null)}
        slotProps={{ paper: { sx: { minWidth: 176 } } }}
      >
        <MenuItem
          data-notes-bulk-category-none
          onClick={() => {
            setBulkCategoryAt(null)
            void applyBulk({ categoryId: null })
          }}
          sx={{ fontSize: 12.5 }}
        >
          {t('notes.bulkCategoryClear')}
        </MenuItem>
        {categories.map((category) => (
          <MenuItem
            key={category.id}
            data-notes-bulk-category-item={category.id}
            onClick={() => {
              setBulkCategoryAt(null)
              void applyBulk({ categoryId: category.id })
            }}
            sx={{ fontSize: 12.5 }}
          >
            {category.name}
          </MenuItem>
        ))}
        {categories.length === 0 && (
          <MenuItem disabled sx={{ fontSize: 11.5 }}>
            {t('notes.bulkCategoryEmpty')}
          </MenuItem>
        )}
      </Menu>

      <Dialog
        open={bulkTagOpen}
        onClose={() => setBulkTagOpen(false)}
        fullWidth
        maxWidth="xs"
        slotProps={{ paper: { sx: { borderRadius: '12px' } } }}
      >
        <DialogTitle sx={{ fontSize: 15, fontWeight: 600, pb: 1 }}>
          {t('notes.bulkTagTitle', { count: selection.length })}
        </DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ fontSize: 12.5, lineHeight: 1.7 }}>
            {t('notes.bulkTagBody')}
          </DialogContentText>
          <TextField
            data-notes-bulk-tag-input
            size="small"
            autoFocus
            fullWidth
            value={bulkTagDraft}
            placeholder={t('notes.tagPlaceholder')}
            onChange={(event) => setBulkTagDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              if (!bulkTagDraft.trim()) return
              setBulkTagOpen(false)
              void applyBulk({ addTags: [bulkTagDraft] })
            }}
            inputProps={{ maxLength: MAX_TAGS }}
            InputProps={{ sx: { fontSize: 12.5 } }}
            sx={{ mt: 1.5 }}
          />
        </DialogContent>
        <DialogActions sx={{ px: 2.5, pb: 2 }}>
          <Button size="small" data-notes-bulk-tag-cancel onClick={() => setBulkTagOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            size="small"
            variant="contained"
            data-notes-bulk-tag-confirm
            disabled={!bulkTagDraft.trim() || bulkBusy}
            onClick={() => {
              setBulkTagOpen(false)
              void applyBulk({ addTags: [bulkTagDraft] })
            }}
            sx={{ fontSize: 12 }}
          >
            {t('notes.bulkTagConfirm')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={bulkDeleteOpen}
        onClose={() => setBulkDeleteOpen(false)}
        fullWidth
        maxWidth="xs"
        slotProps={{ paper: { sx: { borderRadius: '12px' } } }}
      >
        <DialogTitle sx={{ fontSize: 15, fontWeight: 600, pb: 1 }}>
          {t('notes.bulkDeleteTitle', { count: selection.length })}
        </DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ fontSize: 12.5, lineHeight: 1.7 }}>
            {t('notes.bulkDeleteBody', { count: selection.length })}
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 2.5, pb: 2 }}>
          <Button size="small" data-notes-bulk-delete-cancel onClick={() => setBulkDeleteOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            size="small"
            variant="contained"
            color="error"
            data-notes-bulk-delete-confirm
            disabled={bulkBusy}
            onClick={() => {
              setBulkDeleteOpen(false)
              void applyBulk({ delete: true })
            }}
            sx={{ fontSize: 12 }}
          >
            {t('common.delete')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={prefsOpen}
        onClose={() => setPrefsOpen(false)}
        fullWidth
        maxWidth="xs"
        slotProps={{ paper: { sx: { borderRadius: '12px' } } }}
      >
        <DialogTitle sx={{ fontSize: 15, fontWeight: 600, pb: 1 }}>{t('notes.prefsTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ fontSize: 12.5, lineHeight: 1.7 }}>
            {t('notes.prefsBody')}
          </DialogContentText>
          <FormControlLabel
            data-notes-prefs-open-app={prefsOpenApp ? 'on' : 'off'}
            sx={{ mt: 1.5, mx: 0, alignItems: 'flex-start', gap: 1 }}
            control={
              <Switch
                size="small"
                data-notes-prefs-open-switch
                checked={prefsOpenApp}
                onChange={(event) =>
                  patch({
                    hotkeys: { ...settings.hotkeys, notesOpenApp: event.target.checked }
                  })
                }
                inputProps={{ 'aria-label': t('notes.openAppLabel') }}
                sx={{ mt: -0.25 }}
              />
            }
            label={
              <Box>
                <Typography sx={{ fontSize: 12.5 }}>{t('notes.openAppLabel')}</Typography>
                <Typography sx={{ fontSize: 11, color: 'text.disabled', lineHeight: 1.6, mt: 0.25 }}>
                  {t('notes.openAppHint')}
                </Typography>
              </Box>
            }
          />
          <Stack
            direction="row"
            spacing={1}
            alignItems="baseline"
            data-notes-prefs-chord={notesChordLabel}
            sx={{ mt: 2, pt: 1.5, borderTop: '1px solid', borderColor: 'divider' }}
          >
            <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>{t('notes.prefsChord')}</Typography>
            <Chip size="small" label={notesChordLabel} sx={{ height: 20, fontSize: 10.5, borderRadius: '6px' }} />
          </Stack>
          <Typography sx={{ fontSize: 11, color: 'text.disabled', lineHeight: 1.6, mt: 0.75 }}>
            {t('notes.prefsChordHint')}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 2.5, pb: 2 }}>
          <Button size="small" data-notes-prefs-close onClick={() => setPrefsOpen(false)} sx={{ fontSize: 12 }}>
            {t('common.close')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={categoriesOpen}
        onClose={() => setCategoriesOpen(false)}
        fullWidth
        maxWidth="xs"
        slotProps={{ paper: { sx: { borderRadius: '12px' } } }}
      >
        <DialogTitle sx={{ fontSize: 15, fontWeight: 600, pb: 1 }}>{t('notes.categoryManage')}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ fontSize: 12.5, lineHeight: 1.7 }}>
            {t('notes.categoryBody')}
          </DialogContentText>
          <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
            <TextField
              data-notes-category-input
              size="small"
              autoFocus
              fullWidth
              value={categoryDraft}
              placeholder={t('notes.categoryPlaceholder')}
              onChange={(event) => setCategoryDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                void createCategory()
              }}
              inputProps={{ maxLength: 24 }}
              InputProps={{ sx: { fontSize: 12.5 } }}
            />
            <Button
              size="small"
              variant="contained"
              data-notes-category-create
              disabled={!categoryDraft.trim()}
              onClick={() => void createCategory()}
              sx={{ fontSize: 12, flex: '0 0 auto' }}
            >
              {t('notes.categoryCreate')}
            </Button>
          </Stack>

          {categories.length > 0 && (
            <Stack spacing={0.5} sx={{ mt: 1.75 }} data-notes-category-list>
              {categories.map((category) => (
                <Stack key={category.id} direction="row" spacing={1} alignItems="center">
                  <Typography sx={{ fontSize: 12.5, flex: 1 }}>{category.name}</Typography>
                  <Tooltip title={t('notes.categoryDelete')}>
                    <IconButton
                      size="small"
                      data-notes-category-remove={category.id}
                      onClick={() => void removeCategory(category.id)}
                    >
                      <IconTrash size={13} />
                    </IconButton>
                  </Tooltip>
                </Stack>
              ))}
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 2.5, pb: 2 }}>
          <Button size="small" onClick={() => setCategoriesOpen(false)}>
            {t('common.close')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
