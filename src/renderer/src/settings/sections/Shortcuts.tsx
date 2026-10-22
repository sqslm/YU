import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Stack, Switch, Tooltip } from '@mui/material'
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
import { shortcutConflict } from '@shared/shortcuts'

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

export function ShortcutsSection({
  settings,
  patch
}: {
  settings: Settings
  patch: (delta: Partial<Settings>) => void
}): JSX.Element {
  const [capturing, setCapturing] = useState<string | null>(null)
  const [held, setHeld] = useState<string[]>([])
  const [conflict, setConflict] = useState('')
  // Refs keep the key listeners stable while still seeing the newest settings.
  const heldRef = useRef<string[]>([])
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const save = (target: string, keys: string[]): void => {
    const hotkeys = settingsRef.current.hotkeys
    const duplicate = shortcutConflict(hotkeys, target, keys)
    if (duplicate) {
      const label = MODE_ROWS.find(row => row.mode === duplicate)?.label ?? (duplicate === 'notes' ? '随记录音' : duplicate === 'selection' ? '选区处理' : '粘贴上一条')
      setConflict(i18n.t('该快捷键已用于「{{name}}」，已保留原快捷键。', { name: i18n.t(label) }))
      return
    }
    setConflict('')
    if (target === 'selection') patch({ hotkeys: { ...hotkeys, selectionKeys: { keys } } })
    else if (target === 'pasteLast') patch({ hotkeys: { ...hotkeys, pasteLastKeys: { keys } } })
    else if (target === 'notes') patch({ hotkeys: { ...hotkeys, notesKeys: { keys } } })
    else patch({ hotkeys: { ...hotkeys, bindings: { ...hotkeys.bindings, [target]: { keys } } } })
  }

  const recording = capturing !== null
  useEffect(() => {
    if (!recording) return
    void window.api.settings.captureShortcut(true)
    return () => { void window.api.settings.captureShortcut(false) }
  }, [recording])

  useEffect(() => {
    if (!capturing) return

    const off = window.api.settings.onShortcutKey(({ token, down }) => {
      if (token === 'Escape' && down) { setCapturing(null); heldRef.current = []; setHeld([]); return }
      if (down) {
        if (!heldRef.current.includes(token)) {
          heldRef.current = [...heldRef.current, token]
          setHeld(heldRef.current)
        }
      } else if (heldRef.current[0] === token) {
        save(capturing, heldRef.current)
        heldRef.current = []
        setHeld([])
        setCapturing(null)
      }
    })

    const onBlur = (): void => {
      heldRef.current = []
      setHeld([])
      setCapturing(null)
    }

    const onOutside = (event: PointerEvent): void => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-shortcut-controls]')) onBlur()
    }

    window.addEventListener('blur', onBlur)
    window.addEventListener('pointerdown', onOutside)
    return () => {
      off()
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('pointerdown', onOutside)
    }
  }, [capturing, patch])

  const renderRow = (id: string, label: string, hint: string, keys: string[]): JSX.Element => (
    <SettingsRow key={id} label={i18n.t(label)} description={i18n.t(hint)}>
      <Stack direction="row" spacing={0.5} alignItems="center" data-shortcut-controls>
      <Tooltip title={i18n.t(capturing === id ? '按下组合键，Esc 取消' : '点击快捷键即可重新录制')}>
      <Button
        size="small"
        variant="outlined"
        data-shortcut-recorder={id}
        aria-label={i18n.t('修改 {{name}} 快捷键', { name: i18n.t(label) })}
        aria-pressed={capturing === id}
        sx={{ minWidth: 150, minHeight: 34, px: 1.25, borderColor: capturing === id ? 'primary.main' : 'divider', color: capturing === id ? 'primary.main' : 'text.primary', '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' } }}
        onClick={() => {
          setConflict('')
          heldRef.current = []
          setHeld([])
          setCapturing(capturing === id ? null : id)
        }}
      >
        {capturing === id && held.length === 0 ? i18n.t('请按下按键组合…')
          : (capturing === id ? held : keys).length ? <Keycaps keys={capturing === id ? held : keys} /> : i18n.t('未设置')}
      </Button>
      </Tooltip>
      <Tooltip title={i18n.t('清空快捷键')}>
        <span><Button size="small" data-shortcut-clear={id} aria-label={i18n.t('清空 {{name}} 快捷键', { name: i18n.t(label) })}
          disabled={keys.length === 0 && capturing !== id} sx={{ minWidth: 32, color: 'text.secondary' }} onClick={() => { setCapturing(null); heldRef.current = []; setHeld([]); save(id, []) }}>×</Button></span>
      </Tooltip>
      </Stack>
    </SettingsRow>
  )

  return (
    <Stack spacing={3}>
      {conflict && <Alert severity="warning" role="alert" data-shortcut-conflict>{conflict}</Alert>}
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
        {renderRow('selection', '选区处理', '选中文字后打开润色或翻译，预览后替换或追加', settings.hotkeys.selectionKeys.keys)}
        {renderRow(
          'notes',
          i18n.t('随记录音'),
          i18n.t('在任意界面开始 / 结束一条随记，打开随记页并录音'),
          settings.hotkeys.notesKeys?.keys ?? []
        )}
      </SettingsGroup>

      <SettingsHint>
        {i18n.t('点击快捷键后按下组合键，松开第一个键即保存；Esc 或点击其他区域取消，× 清空。录制期间按键不会传递给其他应用。')}
      </SettingsHint>
    </Stack>
  )
}
