import { describe, expect, it } from 'vitest'
import type { BarAlert, BarState } from '@shared/types'
import { alertOf, alertTone, alertTonesFor, hasAlertActions } from './AlertRow'

const busy: BarAlert = {
  kind: 'busy',
  level: 'info',
  text: '上一条还在处理，按 Esc 取消',
  actions: [{ id: 'cancel', label: '取消' }]
}

const sessionWarning: BarAlert = {
  kind: 'session_warning',
  level: 'warn',
  text: '60 秒后自动结束'
}

const network: BarAlert = {
  kind: 'no_network',
  level: 'error',
  text: '网络连接失败，检查后端地址',
  actions: [
    { id: 'retry', label: '重试' },
    { id: 'open_settings', label: '打开设置' }
  ]
}

describe('alertTone', () => {
  it('gives each level its own accent, copy and border', () => {
    const info = alertTone('info')
    const warn = alertTone('warn')
    const error = alertTone('error')
    expect(info.accent).not.toBe(warn.accent)
    expect(warn.accent).not.toBe(error.accent)
    expect(info.accent).not.toBe(error.accent)
    for (const tone of [info, warn, error]) {
      expect(tone.text).toMatch(/^#/)
      expect(tone.tint).toMatch(/^rgba\(/)
      expect(tone.border).toMatch(/^rgba\(/)
    }
  })

  it('falls back to the info tone for a level it does not know', () => {
    expect(alertTone('fatal' as never)).toEqual(alertTone('info'))
    expect(alertTone(undefined)).toEqual(alertTone('info'))  })
})

describe('alertOf', () => {
  it('reads the alert off the alert phase', () => {
    expect(alertOf({ phase: 'alert', alert: busy })).toBe(busy)
  })

  it('reads the alert off an error state that carries one', () => {
    const state: BarState = { phase: 'error', message: 'boom', alert: network }
    expect(alertOf(state)).toBe(network)
  })

  it('returns null for a bare error so the legacy red line renders', () => {
    expect(alertOf({ phase: 'error', message: 'boom' })).toBeNull()
  })

  it('returns null for the phases that have no alert', () => {
    expect(alertOf({ phase: 'idle' })).toBeNull()
    expect(alertOf({ phase: 'recording', mode: 'dictation', since: 0 })).toBeNull()
    expect(alertOf({ phase: 'working', mode: 'ask' })).toBeNull()
    expect(alertOf({ phase: 'done', mode: 'ask', text: 'x' })).toBeNull()
  })
})

describe('hasAlertActions', () => {
  it('makes reminder receipts interactive for undo or dismissal', () => {
    expect(hasAlertActions({ phase: 'alert', alert: { kind: 'reminder', level: 'info', text: 'Saved', actions: [{ id: 'undo-reminder', label: 'Undo' }] } })).toBe(true)
    expect(hasAlertActions({ phase: 'alert', alert: { kind: 'reminder', level: 'info', text: 'Review time' } })).toBe(true)
    expect(hasAlertActions({ phase: 'done', mode: 'ask', text: 'Opened', feedback: {} })).toBe(true)
  })
  it('is always false: the bar renders no buttons at all', () => {
    // Even an alert that *carries* actions must not put them on screen — the
    // strip stays a passive notice, so it can stay click-through.
    expect(hasAlertActions({ phase: 'alert', alert: busy })).toBe(false)
    expect(hasAlertActions({ phase: 'alert', alert: sessionWarning })).toBe(false)
    expect(hasAlertActions({ phase: 'error', message: 'boom', alert: network })).toBe(false)
    expect(hasAlertActions({ phase: 'error', message: 'boom' })).toBe(false)
    expect(hasAlertActions({ phase: 'idle' })).toBe(false)
  })

  it('is false while a take is running, so the bar stays click-through', () => {
    expect(hasAlertActions({ phase: 'recording', mode: 'dictation', since: 0 })).toBe(false)
    expect(hasAlertActions({ phase: 'working', mode: 'dictation' })).toBe(false)
    expect(hasAlertActions({ phase: 'done', mode: 'dictation', text: 'x' })).toBe(false)
  })
})

describe('alertTonesFor', () => {
  /**
   * The bar's capsule fill decides which way the copy has to run. Getting this
   * wrong is not a subtle contrast miss: the prompt-card switcher printed
   * classic's pale tint on the brutalist bone capsule and the notice was
   * unreadable, which is the report this guards.
   */
  it('puts dark copy on the light brutalist capsule and light copy on the dark one', () => {
    const bone = alertTonesFor('brutal', 'light')
    const coal = alertTonesFor('brutal', 'dark')
    expect(bone.info.text).toBe('#002ba8')
    expect(coal.info.text).toBe('#cddaff')
    // Not the shipped set, whose tints assume a near-black pill in every mode.
    expect(bone.info.text).not.toBe(alertTone('info').text)
    expect(coal.info.text).not.toBe(alertTone('info').text)
  })

  it('keeps three distinct levels in every pack and appearance', () => {
    for (const pack of ['classic', 'apple', 'brutal'] as const) {
      for (const mode of ['dark', 'light'] as const) {
        const tones = alertTonesFor(pack, mode)
        expect(new Set([tones.info.accent, tones.warn.accent, tones.error.accent]).size).toBe(3)
        for (const tone of [tones.info, tones.warn, tones.error]) {
          expect(tone.text).toMatch(/^#/)
          expect(tone.tint).toMatch(/^rgba\(/)
          expect(tone.border).toMatch(/^rgba\(/)
        }
      }
    }
  })

  it('keeps the shipped set for an unknown pack', () => {
    expect(alertTonesFor(undefined, 'light')).toEqual(alertTonesFor('classic', 'light'))
    expect(alertTonesFor('nord' as never, 'dark')).toEqual(alertTonesFor('classic', 'dark'))
  })
})
