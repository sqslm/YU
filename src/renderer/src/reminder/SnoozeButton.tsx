import { useState } from 'react'
import { Button, ButtonGroup, Menu, MenuItem } from '@mui/material'
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown'
import { useTranslation } from 'react-i18next'

/** The main button keeps the configured default; the menu changes only this occurrence. */
export function SnoozeButton({ label, disabled, onSnooze, variant = 'text', size = 'small' }: {
  label: string; disabled: boolean; onSnooze: (minutes?: number) => void
  variant?: 'text' | 'outlined'; size?: 'small' | 'medium'
}): JSX.Element {
  const { t } = useTranslation()
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  return <>
    <ButtonGroup variant={variant} size={size} disabled={disabled}>
      <Button onClick={() => onSnooze()}>{label}</Button>
      <Button aria-label={t('选择稍后提醒时长')} aria-haspopup="menu" aria-expanded={Boolean(anchor)}
        sx={{ px: 0.5, minWidth: '28px !important' }} onClick={event => setAnchor(event.currentTarget)}><ArrowDropDownIcon fontSize="small" /></Button>
    </ButtonGroup>
    <Menu anchorEl={anchor} open={Boolean(anchor) && !disabled} onClose={() => setAnchor(null)}>
      {[1, 5, 10, 15, 30, 60].map(minutes => <MenuItem key={minutes} onClick={() => { setAnchor(null); onSnooze(minutes) }}>
        {t('{{n}} 分钟后提醒', { n: minutes })}
      </MenuItem>)}
    </Menu>
  </>
}
