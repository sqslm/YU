import { describe, expect, it } from 'vitest'
import type { BarAlert, BarState } from '@shared/types'
import { alertOf, alertTone, hasAlertActions } from './AlertRow'

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
    expect(alertTone(undefined)).toEqual(alertTone('info'))
  })
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
