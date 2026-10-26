import { PagedList } from '../Pagination'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Button,
  ButtonGroup,
  Checkbox,
  Chip,
  CircularProgress,
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
  Tabs,
  Tab,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import PauseIcon from '@mui/icons-material/Pause'
import PlayIcon from '@mui/icons-material/PlayArrow'
import DownloadIcon from '@mui/icons-material/Download'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import Replay10Icon from '@mui/icons-material/Replay10'
import Forward10Icon from '@mui/icons-material/Forward10'
import { useTranslation } from 'react-i18next'
import type { NoteBulk, NoteCategory, NoteEntry, NoteExportFormat, NotePatch, Settings } from '@shared/types'
import { MicCapture } from '../../bar/capture'
import { IconMic, IconPlus, IconSearch, IconSparkles, IconTrash } from '../icons'
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
  type NoteKind,
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
  openNote?: { id: string }
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

export function NotesPage({ settings, patch, recordTicket = 0, openNote }: NotesPageProps): JSX.Element {
  const { t } = useTranslation()

  const [notes, setNotes] = useState<NoteEntry[]>([])
  const [categories, setCategories] = useState<NoteCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('')
  const [extractingReminders, setExtractingReminders] = useState(false)

  const [selectedId, setSelectedId] = useState<string | null>(openNote?.id ?? null)
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [categoryId, setCategoryId] = useState(ALL_CATEGORIES)
  const [activeTags, setActiveTags] = useState<string[]>([])
  const [sort, setSort] = useState<NoteSort>('newest')
  const [kind, setKind] = useState<NoteKind>('all')

  const [titleDraft, setTitleDraft] = useState('')
  const [metadataOpen, setMetadataOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [tagFiltersOpen, setTagFiltersOpen] = useState(false)
  const [moreAt, setMoreAt] = useState<HTMLElement | null>(null)
  const [transcriptDraft, setTranscriptDraft] = useState('')
  const [polishedDraft, setPolishedDraft] = useState('')
  const [originalOpen, setOriginalOpen] = useState(false)
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
  const [exportMenu, setExportMenu] = useState<{ anchor: HTMLElement; ids: string[]; label: string } | null>(null)
  const [exportBusy, setExportBusy] = useState(false)
  const [creatingText, setCreatingText] = useState(false)
  const [importing, setImporting] = useState(false)
  const [retryConfirmId, setRetryConfirmId] = useState<string | null>(null)
  const [retranscribingId, setRetranscribingId] = useState<string | null>(null)
  const audioJobRef = useRef(false)
  const [createMenuAt, setCreateMenuAt] = useState<HTMLElement | null>(null)
  const bodyInputRef = useRef<HTMLTextAreaElement | null>(null)
  const focusNewNoteRef = useRef<string | null>(null)

  const micRef = useRef<MicCapture | null>(null)
  /**
   * The server-side text the drafts were last built from. Comparing against it
   * is how the page tells "the model just filled this in" from "the user typed".
   */
  const draftBaseRef = useRef<{ id: string | null; title: string; transcript: string; polished: string }>({
    id: null,
    title: '',
    transcript: '',
    polished: ''
  })
  const micErrorRef = useRef('')
  const chunksRef = useRef<Int16Array[]>([])
  const recStartRef = useRef(0)
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<{ id: string; patch: NotePatch } | null>(null)
  const saveInFlightRef = useRef<Promise<void> | null>(null)

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
    () => filterNotes(notes, { query, categoryId, tags: activeTags, sort, kind }, categories),
    [notes, query, categoryId, activeTags, sort, kind, categories]
  )
  const tagOptions = useMemo(() => collectTags(notes, TAG_FILTER_LIMIT), [notes])
  const selected = useMemo(() => notes.find((note) => note.id === selectedId) ?? null, [notes, selectedId])
  const selectedRef = useRef<NoteEntry | null>(selected)
  selectedRef.current = selected

  const audioKey = selected?.audioPath ?? ''
  const primaryField = selected && (selected.polished.trim() || ['pending', 'ok'].includes(selected.polishStatus)) ? 'polished' : 'transcript'
  const primaryDraft = primaryField === 'polished' ? polishedDraft : transcriptDraft
  const hasOriginal = Boolean(selected && (selected.durationMs > 0 || audioKey || selected.polished.trim()))
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
    setTitleDraft(note?.title ?? '')
    setMetadataOpen(false)
    setToolsOpen(false)
    setTranscriptDraft(note?.transcript ?? '')
    setOriginalOpen(false)
    setPolishedDraft(note?.polished ?? '')
    draftBaseRef.current = { id: note?.id ?? null, title: note?.title ?? '', transcript: note?.transcript ?? '', polished: note?.polished ?? '' }
    setTagInput('')
    setSaveState(nextSaveState('idle', 'reset'))
    if (focusNewNoteRef.current === selectedId) {
      bodyInputRef.current?.focus()
      focusNewNoteRef.current = null
    }
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

    if ((note.title ?? '') !== base.title) {
      if (!(ownsText && pending?.patch.title !== undefined) && titleDraft === base.title) setTitleDraft(note.title ?? '')
      base.title = note.title ?? ''
    }
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
  }, [selected, titleDraft, transcriptDraft, polishedDraft])

  const patchEntry = useCallback((updated: NoteEntry): void => {
    setNotes((prev) => prev.map((note) => (note.id === updated.id ? updated : note)))
  }, [])

  const flushNow = useCallback(async (): Promise<void> => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    // A blur may have started a write before the export button was clicked.
    while (saveInFlightRef.current) await saveInFlightRef.current
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = null
    setSaveState((prev) => nextSaveState(prev, 'flushStarted'))
    const saving = (async (): Promise<void> => {
      try {
        const updated = await window.api.notes.update(pending.id, pending.patch)
        if (!updated) throw new Error('Note no longer exists')
        patchEntry(updated)
        setSaveState((prev) => nextSaveState(prev, 'flushSucceeded'))
      } catch {
        // Keep the only copy of an unsaved edit available for the next retry.
        pendingRef.current = pendingRef.current ?? pending
        setSaveState((prev) => nextSaveState(prev, 'flushFailed'))
      }
    })()
    saveInFlightRef.current = saving
    await saving
    if (saveInFlightRef.current === saving) saveInFlightRef.current = null
  }, [patchEntry])

  const createTextNote = useCallback(async (fromClipboard = false): Promise<void> => {
    if (creatingText || importing || retranscribingId || loading || recording || starting || busy || bulkBusy || exportBusy) return
    setCreatingText(true)
    setCreateMenuAt(null)
    setNotice('')
    setFlash('')
    try {
      await flushNow()
      if (pendingRef.current) throw new Error(t('notes.createSaveFailed'))
      const note = await window.api.notes.createText({ categoryId: categoryId || undefined, fromClipboard })
      focusNewNoteRef.current = note.id
      setNotes(prev => [note, ...prev.filter(item => item.id !== note.id)])
      setSelectedId(note.id)
      setQueryInput('')
      setQuery('')
      setActiveTags([])
      setKind('all')
      setSelection([])
      setFlash(t(fromClipboard ? 'notes.createdFromClipboard' : 'notes.textCreated'))
    } catch (err) { setNotice(messageOf(err)) }
    finally { setCreatingText(false) }
  }, [creatingText, importing, retranscribingId, loading, recording, starting, busy, bulkBusy, exportBusy, flushNow, categoryId, t])

  useEffect(() => () => {
    if (audioJobRef.current) void window.api.notes.cancelAudioJob().catch(() => undefined)
    audioJobRef.current = false
  }, [])

  const importAudio = async (): Promise<void> => {
    if (audioJobRef.current) return
    setCreateMenuAt(null)
    setNotice('')
    setFlash('')
    setImporting(true)
    audioJobRef.current = true
    try {
      await flushNow()
      if (pendingRef.current) throw new Error(t('notes.createSaveFailed'))
      if (!audioJobRef.current) return
      const note = await window.api.notes.importAudio(categoryId || undefined)
      if (!note) return
      setNotes(prev => [note, ...prev.filter(item => item.id !== note.id)])
      setSelectedId(note.id)
      setQueryInput('')
      setQuery('')
      setActiveTags([])
      setKind('all')
      setSelection([])
      setFlash(t('notes.audioImported'))
    } catch (err) { setNotice(messageOf(err)) }
    finally { audioJobRef.current = false; setImporting(false) }
  }

  const retranscribe = async (): Promise<void> => {
    const id = retryConfirmId
    setRetryConfirmId(null)
    if (!id || audioJobRef.current) return
    setNotice('')
    setFlash('')
    setRetranscribingId(id)
    audioJobRef.current = true
    try {
      await flushNow()
      if (pendingRef.current) throw new Error(t('notes.createSaveFailed'))
      if (!audioJobRef.current) return
      const updated = await window.api.notes.retranscribe(id)
      if (updated) { patchEntry(updated); setFlash(t('notes.retranscribed')) }
    } catch (err) { setNotice(messageOf(err)) }
    finally { audioJobRef.current = false; setRetranscribingId(null) }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || event.isComposing || !event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.key.toLowerCase() !== 'n') return
      if (document.querySelector('[role="dialog"]')) return
      event.preventDefault()
      void createTextNote()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [createTextNote])

  const editField = useCallback(
    (field: 'title' | 'transcript' | 'polished', value: string): void => {
      if (field === 'title') setTitleDraft(value)
      else if (field === 'transcript') setTranscriptDraft(value)
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
      void flushNow().then(() => {
        if (pendingRef.current) { setNotice(t('notes.createSaveFailed')); return }
        setSelectedId(id)
      })
    },
    [flushNow, selectedId, t]
  )
  const consumedOpenNote = useRef<typeof openNote>(undefined)
  useEffect(() => {
    if (loading || !openNote || consumedOpenNote.current === openNote || !notesRef.current.some(note => note.id === openNote.id)) return
    consumedOpenNote.current = openNote
    // Use the same save-before-switch behavior as a click. A new request object
    // also allows reopening the same ID after a manual selection change.
    selectNote(openNote.id)
  }, [loading, openNote, selectNote])

  // ---- microphone -------------------------------------------------------

  const startRecording = async (): Promise<void> => {
    if (recording || starting || audioJobRef.current) return
    setStarting(true)
    window.api.notes.recording(true)
    setMicMessage('')
    micErrorRef.current = ''
    const chunks: Int16Array[] = []
    chunksRef.current = chunks
    const mic = new MicCapture({
      onChunk: (chunk) => {
        chunks.push(chunk)
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
      await window.api.checkAsr()
      if (micRef.current !== mic) return
      await mic.setDevice(settings.inputDeviceId ?? '', settings.audioProcessing)
      if (micRef.current !== mic) return
      await mic.start()
      if (micRef.current !== mic) { await mic.stop(); return }
      if (mic.isRunning) await mic.setActive(true)
    } catch (err) {
      micErrorRef.current = messageOf(err)
    }
    if (micRef.current !== mic) return
    if (!mic.isRunning) {
      micRef.current = null
      setMicMessage(micErrorRef.current || t('notes.micUnavailable'))
      setStarting(false)
      window.api.notes.recording(false)
      return
    }
    recStartRef.current = Date.now()
    setRecordedMs(0)
    setRecording(true)
    setStarting(false)
    recTimerRef.current = setInterval(() => setRecordedMs(Date.now() - recStartRef.current), 200)
  }

  const stopRecording = async (cancel = false): Promise<void> => {
    if (!micRef.current) return
    const mic = micRef.current
    micRef.current = null
    const parts = chunksRef.current
    chunksRef.current = []
    if (recTimerRef.current) {
      clearInterval(recTimerRef.current)
      recTimerRef.current = null
    }
    setRecording(false)
    setStarting(false)
    window.api.notes.recording(false)
    setRecordedMs(0)
    if (mic) {
      await mic.setActive(false, !cancel)
      await mic.stop()
    }
    if (cancel) return
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
      setQueryInput('')
      setQuery('')
      setActiveTags([])
      setKind('all')
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
      window.api.notes.recording(false)
      if (mic) {
        void mic.setActive(false, false).then(() => mic.stop())
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
  const controlRecorderRef = useRef<(action: 'stop' | 'cancel') => void>(() => undefined)
  controlRecorderRef.current = action => { void stopRecording(action === 'cancel') }
  useEffect(() => window.api.notes.onRecordControl(action => controlRecorderRef.current(action)), [])
  useEffect(() => {
    if (recordTicket <= lastRecordTicket) return
    lastRecordTicket = recordTicket
    toggleRecorderRef.current()
  }, [recordTicket])

  // ---- player -----------------------------------------------------------

  // One element for the whole page: a fresh `<audio>` per note would leak the
  // decoder and race the previous playback's `timeupdate` events.
  useEffect(() => {
    let alive=true
    const refresh=async():Promise<void>=>{
      try {
        const current=await window.api.notes.audioControl('status')
        if(!alive)return
        const selected=current.id===selectedId
        setPlaying(selected && current.state==='playing')
        setPositionMs(selected?current.positionMs:0)
        setDurationMs(selected?current.durationMs:0)
      }catch { if(alive)setPlaying(false) }
    }
    setScrubMs(null);void refresh()
    const timer=setInterval(()=>void refresh(),500)
    return ()=>{alive=false;clearInterval(timer)}
  },[selectedId,audioKey])

  useEffect(()=>{
    if(selectedId && durationMs>0)void window.api.notes.audioControl('rate',selectedId,{rate}).catch(()=>{})
  },[rate,selectedId,durationMs])

  const totalMs=durationMs>0?durationMs:(selected?.durationMs??0)
  const shownMs=scrubMs??positionMs
  const maxMs=Math.max(totalMs,1)
  const togglePlay=():void=>{
    if(!selectedId||!audioKey)return
    const id=selectedId
    void window.api.notes.audioControl('status').then(state=>window.api.notes.audioControl(
      state.id===id&&state.state==='playing'?'pause':state.id===id&&state.state==='paused'?'resume':'play',id,{rate}
    )).then(current=>{
      if(selectedRef.current?.id!==id)return
      setPlaying(current.state==='playing');setPositionMs(current.positionMs);setDurationMs(current.durationMs)
    }).catch(()=>setNotice(t('notes.playFailed')))
  }
  const commitSeek=(value:number|number[]):void=>{
    if(!selectedId||durationMs<=0)return
    const ms=Math.max(0,Math.min(Array.isArray(value)?value[0]:value,durationMs))
    setScrubMs(null)
    void window.api.notes.audioControl('seek',selectedId,{positionMs:ms}).then(current=>setPositionMs(current.positionMs)).catch(()=>setNotice(t('notes.playFailed')))
  }
  const skipAudio=(seconds:number):void=>commitSeek(positionMs+seconds*1000)

  const copyDraft = async (text: string): Promise<void> => {
    setNotice(''); setFlash('')
    try { await window.api.app.copyText(text); setFlash(t('notes.textCopied')) }
    catch (error) { setNotice(messageOf(error)) }
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
    setBusy(true)
    setNotice('')
    try {
      await flushNow()
      if (Boolean(pendingRef.current)) throw new Error(t('notes.createSaveFailed'))
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
  const exportIds = (selection.length ? ordered.filter(note => selectedSet.has(note.id)) : visible).map(note => note.id)

  const exportText = async (format: NoteExportFormat): Promise<void> => {
    const ids = exportMenu?.ids
    setExportMenu(null)
    if (!ids?.length) return
    setExportBusy(true)
    setNotice('')
    setFlash('')
    try {
      await flushNow()
      if (pendingRef.current) throw new Error(t('notes.exportSaveFailed'))
      const result = await window.api.notes.exportText(ids, format)
      if (result) setFlash(t('notes.exportDone', { count: result.count }))
    } catch (err) { setNotice(messageOf(err)) }
    finally { setExportBusy(false) }
  }

  const saveAudio = async (): Promise<void> => {
    const id = selectedRef.current?.id
    if (!id) return
    setExportBusy(true)
    setNotice('')
    setFlash('')
    try {
      if (await window.api.notes.exportAudio(id)) setFlash(t('notes.audioSaved'))
    } catch (err) { setNotice(messageOf(err)) }
    finally { setExportBusy(false) }
  }

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
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography sx={{ fontSize: 18, fontWeight: 600 }}>{t('随记')}</Typography>
          <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{notes.length}</Typography>
          <Box sx={{ flex: 1 }} />
          <Stack direction="row" spacing={1} alignItems="center" sx={{ flexShrink: 0, ml: 'auto' }}>
            <ButtonGroup size="small" variant="outlined" disabled={creatingText || importing || !!retranscribingId || loading || recording || starting || busy || bulkBusy || exportBusy} sx={{ height: 34 }}>
              <Button data-notes-new-text title={t('notes.newTextShortcut')} aria-keyshortcuts="Control+N" onClick={() => void createTextNote()} startIcon={<IconPlus size={14} />} sx={{ fontSize: 12 }}>
                {creatingText ? t('notes.creatingText') : t('notes.newText')}
              </Button>
              <Button data-notes-create-menu onClick={event => setCreateMenuAt(event.currentTarget)} aria-label={t('notes.moreCreateOptions')} sx={{ minWidth: '24px !important', px: 0.25 }}>
                <ArrowDropDownIcon sx={{ fontSize: 17 }} />
              </Button>
            </ButtonGroup>


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
                <Button data-notes-more size="small" onClick={event => setMoreAt(event.currentTarget)}>{t('更多')}</Button>
          </Stack>
            )}



            <Button
              data-notes-record={recording ? 'on' : 'idle'}
              size="small"
              variant={recording ? 'contained' : 'outlined'}
              color={recording ? 'error' : 'primary'}
              disabled={starting || importing || !!retranscribingId}
              onClick={() => void (recording ? stopRecording() : startRecording())}
              startIcon={<IconMic size={14} />}
              sx={{ fontSize: 12, height: 34 }}
            >
              {recording ? t('notes.recordStop') : t('notes.record')}
            </Button>
            <Button data-notes-more size="small" onClick={event => setMoreAt(event.currentTarget)}>{t('更多')}</Button>
          </Stack>
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <Box
            data-notes-search
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              height: 34,
              px: 1.25,
              flex: 1,
              minWidth: 180,
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
            SelectProps={{ displayEmpty: true }}
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

          <TextField select size="small" value={sort}
            data-notes-sort={sort}
            onChange={event => setSort(event.target.value as NoteSort)}
            aria-label={t('notes.sortLabel')}
            sx={{ width: 142, '& .MuiInputBase-input': { fontSize: 12.5 } }}>
            <MenuItem value="newest">{t('notes.sortNewest')}</MenuItem>
            <MenuItem value="oldest">{t('notes.sortOldest')}</MenuItem>
            <MenuItem value="updated">{t('notes.sortUpdated')}</MenuItem>
          </TextField>

          <Box sx={{ flex: 1 }} />


        </Stack>

        <Tabs data-notes-kind-filter value={kind} onChange={(_event, value) => setKind(value)} sx={{ minHeight: 34, '& .MuiTab-root': { minHeight: 34, py: .5, fontSize: 12 } }}>
          {(['all', 'text', 'audio', 'failed'] as const).map(value => <Tab key={value} value={value} label={t(`notes.kind_${value}`)} />)}
        </Tabs>
        {(importing || retranscribingId) && <Stack data-notes-audio-job role="status" direction="row" spacing={1} alignItems="center">
          <CircularProgress size={13} />
          <Typography sx={{ fontSize: 11.5 }}>{t(importing ? 'notes.importingAudio' : 'notes.retranscribing')}</Typography>
          <Button data-notes-cancel-audio-job size="small" onClick={() => { audioJobRef.current = false; void window.api.notes.cancelAudioJob().catch(err => setNotice(messageOf(err))) }}>{t('common.cancel')}</Button>
        </Stack>}

        {tagOptions.length > 0 && (tagFiltersOpen || activeTags.length > 0) && (
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

          <PagedList name="NotesPage-visible" resetKey={`${query}|${categoryId}|${activeTags.join(",")}|${kind}|${sort}`} revealKey={selectedId}>{!loading &&
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
                      {note.durationMs === 0 && !note.audioPath ? t('notes.textNote') : formatDuration(note.durationMs)}
                    </Typography>
                  </Stack>
                  <Typography
                    data-notes-row-summary
                    sx={{
                      fontSize: 12.5,
                      fontWeight: note.title ? 600 : 400,
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
                    {summarize(note, 120) || t('notes.untitled')}
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
            })}</PagedList>
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
              <TextField data-notes-title fullWidth variant="standard" value={titleDraft}
                placeholder={t('notes.titlePlaceholder')} onChange={event => editField('title', event.target.value)}
                onBlur={() => void flushNow()} inputProps={{ maxLength: 200, 'aria-label': t('notes.titleLabel') }}
                InputProps={{ disableUnderline: true, sx: { fontSize: 19, fontWeight: 600, mb: .75 } }} />
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
                  {selected.durationMs === 0 && !audioKey ? t('notes.textNote') : formatDuration(selected.durationMs)}
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

              <Button data-notes-metadata-toggle size="small" aria-expanded={metadataOpen} onClick={() => setMetadataOpen(open => !open)} sx={{ mt: .5, fontSize: 12 }}>{t('分类与标签')}</Button>
              {metadataOpen && <Box data-notes-metadata>
              <Stack direction="row" spacing={1.5} sx={{ mt: 1.5, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <TextField
                  data-notes-category
                  select
                  SelectProps={{ displayEmpty: true }}
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

              </Box>}
              <Box data-notes-primary sx={{ mt: 2.25 }}>
                <Typography sx={{ fontSize: 12, fontWeight: 600, color: 'text.secondary', mb: 1 }}>
                  {t(primaryField === 'polished' ? 'notes.polishedLabel' : 'notes.bodyLabel')}
                </Typography>
                <TextField data-notes-editor={primaryField} inputRef={bodyInputRef} disabled={retranscribingId === selected.id}
                  multiline minRows={16} fullWidth value={primaryDraft}
                  onChange={event => editField(primaryField, event.target.value)} onBlur={() => void flushNow()}
                  placeholder={t(primaryField === 'polished' ? 'notes.polishedPlaceholder' : 'notes.bodyPlaceholder')}
                  InputProps={{ sx: { fontSize: 14, lineHeight: 1.8, alignItems: 'flex-start', minHeight: '42vh' } }} />
                <Stack direction="row" spacing={1} sx={{ mt: .5 }}>
                  <Button data-notes-copy={primaryField} size="small" disabled={!primaryDraft.trim()} onClick={() => void copyDraft(primaryDraft)} sx={{ fontSize: 11.5 }}>
                    {t(primaryField === 'polished' ? 'notes.copyPolished' : '复制内容')}
                  </Button>
                  {hasOriginal && <Button data-notes-toggle-original size="small" aria-expanded={originalOpen} aria-controls="notes-original"
                    onClick={() => setOriginalOpen(open => !open)} sx={{ fontSize: 11.5 }}>{t(originalOpen ? '隐藏原始转写' : '查看原始转写')}</Button>}
                </Stack>
              </Box>
              {hasOriginal && originalOpen && <Box id="notes-original" data-notes-original sx={{ mt: 1.5, p: 1.5, bgcolor: 'action.hover', borderRadius: 2 }}>
                <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mb: 1 }}>{t('notes.transcriptLabel')}</Typography>
                <TextField data-notes-editor="original" disabled={retranscribingId === selected.id} multiline minRows={3} fullWidth value={transcriptDraft}
                  onChange={event => editField('transcript', event.target.value)} onBlur={() => void flushNow()}
                  InputProps={{ sx: { fontSize: 13, lineHeight: 1.65 } }} />
                <Button data-notes-copy="original" size="small" disabled={!transcriptDraft.trim()} onClick={() => void copyDraft(transcriptDraft)} sx={{ mt: .5, fontSize: 11.5 }}>{t('notes.copyOriginal')}</Button>
              </Box>}

              <Button data-notes-tools-toggle size="small" aria-expanded={toolsOpen} onClick={() => setToolsOpen(open => !open)} sx={{ mt: 1, fontSize: 12 }}>{t('更多操作')}</Button>
              {toolsOpen && <Box data-notes-tools>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.5, flexWrap: 'wrap' }}>
                <Button
                  data-notes-export-current
                  size="small"
                  disabled={exportBusy || bulkBusy}
                  onClick={(event) => setExportMenu({ anchor: event.currentTarget, ids: [selected.id], label: t('notes.exportCurrent') })}
                  sx={{ fontSize: 12 }}
                >
                  {t('notes.exportCurrent')}
                </Button>
                <Button
                  data-notes-repolish
                  size="small"
                  variant="outlined"
                  disabled={busy || importing || !!retranscribingId}
                  onClick={() => setRepolishOpen(true)}
                  startIcon={<IconSparkles size={14} />}
                  sx={{ fontSize: 12 }}
                >
                  {t('notes.repolish')}
                </Button>
                <Button data-notes-extract-reminders size="small" disabled={extractingReminders || busy || recording || starting || !!retranscribingId}
                  onClick={() => {
                    const id = selected.id
                    setExtractingReminders(true); setNotice('')
                    void flushNow().then(() => {
                      if (pendingRef.current) throw new Error(t('notes.createSaveFailed'))
                      return window.api.reminders.extractNote(id)
                    }).then(message => setFlash(message)).catch(e => setNotice(messageOf(e))).finally(() => setExtractingReminders(false))
                  }}>{t(extractingReminders ? '正在提取待办…' : '提取待办与提醒')}</Button>
                {audioKey && <Button data-notes-retranscribe size="small" disabled={busy || importing || !!retranscribingId || recording || starting}
                  onClick={() => setRetryConfirmId(selected.id)} sx={{ fontSize: 12 }}>{t('notes.retranscribe')}</Button>}
                {selected.polishStatus === 'failed' && (
                  <Typography data-notes-polish-failed title={selected.polishError} sx={{ fontSize: 11, color: 'warning.main' }}>
                    {t('notes.processingFailed')}
                  </Typography>
                )}
              </Stack>

              </Box>}
              {audioKey ? <Box
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
                  <Tooltip title={t('notes.skipBack')}>
                    <IconButton data-notes-skip="back" size="small" aria-label={t('notes.skipBack')}
                      disabled={durationMs <= 0} onClick={() => skipAudio(-10)}><Replay10Icon sx={{ fontSize: 20 }} /></IconButton>
                  </Tooltip>
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
                  <Tooltip title={t('notes.skipForward')}>
                    <IconButton data-notes-skip="forward" size="small" aria-label={t('notes.skipForward')}
                      disabled={durationMs <= 0} onClick={() => skipAudio(10)}><Forward10Icon sx={{ fontSize: 20 }} /></IconButton>
                  </Tooltip>
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
                  <Tooltip title={t('notes.saveAudio')}>
                    <span>
                      <IconButton data-notes-save-audio size="small" disabled={!audioKey || exportBusy} onClick={() => void saveAudio()} aria-label={t('notes.saveAudio')}>
                        <DownloadIcon sx={{ fontSize: 17 }} />
                      </IconButton>
                    </span>
                  </Tooltip>
                </Stack>
              </Box> : <Typography data-notes-no-audio sx={{ mt: 2, fontSize: 11.5, color: 'text.disabled' }}>{t('notes.noLocalAudio')}</Typography>}
            </Box>
          )}
        </Box>
      </Box>



      <Menu anchorEl={createMenuAt} open={Boolean(createMenuAt)} onClose={() => setCreateMenuAt(null)}>
        <MenuItem data-notes-create-blank onClick={() => void createTextNote()} sx={{ fontSize: 12.5 }}>{t('notes.newBlankText')}</MenuItem>
        <MenuItem data-notes-create-clipboard onClick={() => void createTextNote(true)} sx={{ fontSize: 12.5 }}>{t('notes.newFromClipboard')}</MenuItem>
        <MenuItem data-notes-import-audio onClick={() => void importAudio()} sx={{ fontSize: 12.5 }}>{t('notes.importAudio')}</MenuItem>
      </Menu>

      <Dialog open={!!retryConfirmId} onClose={() => setRetryConfirmId(null)} slotProps={{ paper: { sx: { borderRadius: '12px' } } }}>
        <DialogTitle sx={{ fontSize: 15, fontWeight: 600, pb: 1 }}>{t('notes.retranscribe')}</DialogTitle>
        <DialogContent><DialogContentText sx={{ fontSize: 12.5, lineHeight: 1.7 }}>{t('notes.retranscribeBody')}</DialogContentText></DialogContent>
        <DialogActions sx={{ px: 2.5, pb: 2 }}>
          <Button size="small" onClick={() => setRetryConfirmId(null)}>{t('common.cancel')}</Button>
          <Button data-notes-retranscribe-confirm size="small" variant="contained" onClick={() => void retranscribe()}>{t('notes.retranscribe')}</Button>
        </DialogActions>
      </Dialog>

      <Menu anchorEl={exportMenu?.anchor} open={Boolean(exportMenu)} onClose={() => setExportMenu(null)}>
        <MenuItem disabled sx={{ fontSize: 11.5 }}>{exportMenu?.label}</MenuItem>
        <MenuItem data-notes-export-markdown onClick={() => void exportText('markdown')} sx={{ fontSize: 12.5 }}>Markdown (.md)</MenuItem>
        <MenuItem data-notes-export-text onClick={() => void exportText('text')} sx={{ fontSize: 12.5 }}>{t('notes.exportPlainText')}</MenuItem>
      </Menu>

      <Menu anchorEl={moreAt} open={Boolean(moreAt)} onClose={() => setMoreAt(null)}>
        <MenuItem data-notes-category-manage onClick={() => { setMoreAt(null); setCategoryDraft(''); setCategoriesOpen(true) }}>{t('notes.categoryManage')}</MenuItem>
        <MenuItem data-notes-export disabled={exportBusy || bulkBusy || loading || !exportIds.length} onClick={() => { const anchor = moreAt!; setMoreAt(null); setExportMenu({ anchor, ids: exportIds, label: t(selection.length ? 'notes.exportSelected' : 'notes.exportFiltered', { count: exportIds.length }) }) }}>{t('notes.export')}</MenuItem>
        <MenuItem data-notes-filter-tags onClick={() => { setMoreAt(null); setTagFiltersOpen(open => !open) }}>{t('notes.tagFilter')}</MenuItem>
        <MenuItem data-notes-prefs-open onClick={() => { setMoreAt(null); setPrefsOpen(true) }}>{t('notes.prefsTitle')}</MenuItem>
      </Menu>
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
              <PagedList name="note-categories">{categories.map((category) => (
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
              ))}</PagedList>
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
