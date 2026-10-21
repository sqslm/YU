import { useEffect, useRef, useState } from 'react'
import { Button, Stack, Switch, Typography } from '@mui/material'
import type { Mode, Settings } from '@shared/types'
import { Keycaps } from '../keycaps'
import {
  IconKeyboard,
  IconSparkle,
  Segmented,
  SettingsGroup,
  SettingsRow,
  SettingsHint
} from './General'
import i18n from '../../i18n'

const MODE_ROWS: Array<{ mode: Mode; label: string; hint: string; toggleHint: string }> = [
  {
    mode: 'dictation',
    label: '听写',
    hint: '按住主键说话，松开后自动转写并插入',
    toggleHint: '按一下主键开始，再按一下结束'
  },
  {
    mode: 'ask',
    label: '问答',
    hint: '识别语音后回答问题',
    toggleHint: '识别语音后回答问题'
  },
  {
    mode: 'translate',
    label: '翻译',
    hint: '将语音翻译后插入当前应用',
    toggleHint: '将语音翻译后插入当前应用'
  }
]

const ACTIVATION_OPTIONS = [
  { value: 'toggle', label: '按一下开始' },
  { value: 'hold', label: '按住说话' }
] as const

/** Maps a browser KeyboardEvent.code onto the hook's key tokens. */
function codeToToken(code: string, key: string): string | null {
  const map: Record<string, string> = {
    AltRight: 'RightAlt',
    AltLeft: 'LeftAlt',
    ControlRight: 'RightCtrl',
    ControlLeft: 'LeftCtrl',
    ShiftRight: 'RightShift',
    ShiftLeft: 'LeftShift',
    MetaLeft: 'LeftWin',
    MetaRight: 'RightWin',
    Space: 'Space',
    Tab: 'Tab',
    Enter: 'Enter',
    Escape: 'Escape',
    Backspace: 'Backspace',
    CapsLock: 'CapsLock'
  }
  if (map[code]) return map[code]
  const keyMatch = /^Key([A-Z])$/.exec(code)
  if (keyMatch) return keyMatch[1]
  const digitMatch = /^Digit([0-9])$/.exec(code)
  if (digitMatch) return digitMatch[1]
  if (/^F([1-9]|1[0-2])$/.test(code)) return code
  if (/^[A-Z]$/.test(key)) return key
  return null
}

export function ShortcutsSection({
  settings,
  patch
}: {
  settings: Settings
  patch: (delta: Partial<Settings>) => void
}): JSX.Element {
  const [capturing, setCapturing] = useState<string | null>(null)
  const [held, setHeld] = useState<string[]>([])
  // Refs keep the key listeners stable while still seeing the newest settings.
  const heldRef = useRef<string[]>([])
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  useEffect(() => {
    if (!capturing) return

    const commit = (target: string, keys: string[]): void => {
      const current = settingsRef.current
      if (target === 'pasteLast') {
        patch({ hotkeys: { ...current.hotkeys, pasteLastKeys: { keys } } })
        return
      }
      if (target === 'notes') {
        patch({ hotkeys: { ...current.hotkeys, notesKeys: { keys } } })
        return
      }
      patch({
        hotkeys: {
          ...current.hotkeys,
          bindings: {
            ...current.hotkeys.bindings,
            [target]: { keys }
          }
        }
      })
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      const token = codeToToken(event.code, event.key)
      if (!token) return
      if (heldRef.current.includes(token)) return
      heldRef.current = [...heldRef.current, token]
      setHeld(heldRef.current)
    }

    const onKeyUp = (event: KeyboardEvent): void => {
      event.preventDefault()
      const token = codeToToken(event.code, event.key)
      if (!token) return
      const current = heldRef.current
      if (!current.includes(token)) return
      // Releasing the first key completes the chord; modifiers are released after.
      const isPrimary = current[0] === token
      heldRef.current = current.filter((item) => item !== token)
      setHeld(heldRef.current)
      if (isPrimary) {
        commit(capturing, current)
        heldRef.current = []
        setHeld([])
        setCapturing(null)
      }
    }

    const onBlur = (): void => {
      heldRef.current = []
      setHeld([])
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [capturing, patch])

  const renderRow = (id: string, label: string, hint: string, keys: string[]): JSX.Element => (
    <SettingsRow key={id} label={i18n.t(label)} description={i18n.t(hint)}>
      {capturing === id && held.length === 0 ? (
        <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>{i18n.t(i18n.t('请按下按键组合…'))}</Typography>
      ) : (
        <Keycaps keys={capturing === id ? held : keys} />
      )}
      <Button
        size="small"
        variant={capturing === id ? 'contained' : 'text'}
        sx={{ minWidth: 52, ml: 0.5 }}
        onClick={() => {
          heldRef.current = []
          setHeld([])
          setCapturing(capturing === id ? null : id)
        }}
      >
        {capturing === id ? i18n.t('取消') : i18n.t('录制')}
      </Button>
    </SettingsRow>
  )

  return (
    <Stack spacing={3}>
      <SettingsGroup icon={<IconKeyboard />} title={i18n.t('快捷键')}>
        <SettingsRow label={i18n.t('启用全局快捷键')} description={i18n.t('在其他应用中使用听写、翻译和问答快捷键。')}>
          <Switch
            size="small"
            checked={settings.hotkeys.enabled}
            onChange={(e) => patch({ hotkeys: { ...settings.hotkeys, enabled: e.target.checked } })}
          />
        </SettingsRow>
        <SettingsRow
          label={i18n.t('触发方式')}
          description={
            settings.activationMode === 'toggle'
              ? i18n.t('按一下主键开始录音，再按一下结束')
              : i18n.t('按住主键说话，松开即结束录音')
          }
        >
          <Segmented
            value={settings.activationMode}
            options={ACTIVATION_OPTIONS}
            onChange={(value) => patch({ activationMode: value })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup icon={<IconSparkle />} title={i18n.t('模式按键')}>
        {MODE_ROWS.map((row) =>
          renderRow(
            row.mode,
            row.label,
            settings.activationMode === 'toggle' ? row.toggleHint : row.hint,
            settings.hotkeys.bindings[row.mode].keys
          )
        )}
        {renderRow(
          'pasteLast',
          i18n.t('粘贴上一条'),
          i18n.t('再次插入最近一次转写结果'),
          settings.hotkeys.pasteLastKeys.keys
        )}
        {renderRow(
          'notes',
          i18n.t('随记录音'),
          i18n.t('在任意界面开始 / 结束一条随记，打开随记页并录音'),
          settings.hotkeys.notesKeys?.keys ?? []
        )}
      </SettingsGroup>

      <SettingsHint>
        {i18n.t('点「录制」后按下组合键，松开第一个键即保存，立即生效。')}
      </SettingsHint>
    </Stack>
  )
}
