import { registerGameModePreparation } from './gameModePreparation'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Settings } from '@shared/types'
import { applySettingsPatch } from '@shared/defaults'

interface UseSettingsResult {
  settings: Settings | null
  patch: (patch: Partial<Settings>) => void
  saving: boolean
  error: string
  flush: () => Promise<void>
}

/**
 * Loads settings once, then applies patches optimistically and persists them
 * with a short debounce so dragging a slider does not write the file per pixel.
 *
 * The debounce has a cost that used to be paid in data: a patch made in the last
 * 350 ms before the dialog closed (or before the user quit) only ever existed in
 * a `setTimeout` that died with the renderer. The unmount path therefore flushes
 * the pending patch, and a failed write puts the patch back instead of dropping
 * it — "I ticked that box and it never stayed ticked" is the same bug from two
 * directions.
 */
export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<Partial<Settings>>({})
  const writing = useRef<Partial<Settings> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)

  const flush = useCallback(async () => {
    if (writing.current) return
    const patch = pending.current
    pending.current = {}
    if (Object.keys(patch).length === 0) return
    writing.current = patch
    if (alive.current) { setSaving(true); setError('') }
    let savedOk = false
    try {
      const saved = await window.api.settings.update(patch)
      savedOk = true
      if (alive.current) setSettings(applySettingsPatch(saved, pending.current))
    } catch (err) {
      // Keep the change so the next edit (or the unmount flush) retries it.
      pending.current = applySettingsPatch(patch, pending.current)
      if (alive.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      writing.current = null
      if (alive.current) setSaving(false)
      // A second debounce may have fired while the first write was in flight.
      if (savedOk && Object.keys(pending.current).length > 0) void flushRef.current()
    }
  }, [])

  useEffect(() => registerGameModePreparation(async () => {
    await flush()
    return writing.current === null && Object.keys(pending.current).length === 0
  }), [flush])

  // The unmount cleanup runs after the hook body, so it reaches the latest flush
  // through a ref instead of capturing the first render's closure.
  const flushRef = useRef(flush)
  flushRef.current = flush

  useEffect(() => {
    alive.current = true
    let live = true
    let receivedChange = false
    void window.api.settings.get().then((loaded) => {
      if (live && !receivedChange) setSettings(applySettingsPatch(loaded, pending.current))
    })
    const off = window.api.settings.onChanged((next) => {
      receivedChange = true
      if (live) setSettings(applySettingsPatch(applySettingsPatch(next, writing.current ?? {}), pending.current))
    })
    return () => {
      live = false
      alive.current = false
      off()
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      void flushRef.current()
    }
  }, [])

  const patch = useCallback(
    (delta: Partial<Settings>) => {
      setSaving(true)
      setSettings((current) => (current ? applySettingsPatch(current, delta) : current))
      pending.current = applySettingsPatch(pending.current, delta)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        void flush()
      }, 350)
    },
    [flush]
  )

  return { settings, patch, saving, error, flush }
}
