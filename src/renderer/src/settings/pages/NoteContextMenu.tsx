import { useEffect, useRef, useState } from 'react'
import { Box, Divider, ListItemText, Menu, MenuItem, Typography } from '@mui/material'
import CheckRounded from '@mui/icons-material/CheckRounded'
import ChevronRightRounded from '@mui/icons-material/ChevronRightRounded'

/**
 * One row of a note context menu; a divider separates groups.
 *
 * `children` turns the row into a submenu (标题, 列表与块, 插入 …) so the top level
 * stays short. `checked` is the toggle state: the same entry both applies and
 * removes a format, so it has to say which one it would do right now.
 */
export type NoteMenuEntry =
  | { id: string; label: string; shortcut?: string; disabled?: boolean; checked?: boolean; run: () => void }
  | { id: string; label: string; children: NoteMenuEntry[]; disabled?: boolean }
  | { divider: true }

export interface NoteContextMenuProps {
  /** Viewport coordinates of the click, or null when the menu is closed. */
  anchor: { x: number; y: number } | null
  entries: NoteMenuEntry[]
  onClose: () => void
}

/** Grace period before a hovered submenu closes, so the diagonal move survives. */
const SUBMENU_CLOSE_MS = 180

/**
 * The right-click menu of a note body.
 *
 * Deliberately a plain MUI menu anchored at the cursor instead of a native
 * Electron menu: the actions are markdown-aware (toggle a mark, turn a block into
 * a heading, copy the note as markdown) and live in the renderer where the editor
 * already is. Only the note body installs it — the rest of the page keeps the
 * platform default, which is what the user asked for.
 *
 * Submenus open on **hover**, the way Typora's menu does: reaching 标题 or 列表
 * should not require a click first. A click still works (keyboard, touch, and
 * anyone who expects it), and the close is delayed so moving diagonally into the
 * submenu does not dismiss it.
 */
export function NoteContextMenu({ anchor, entries, onClose }: NoteContextMenuProps): JSX.Element {
  const [submenu, setSubmenu] = useState<{ id: string; anchor: HTMLElement; entries: NoteMenuEntry[] } | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelClose = (): void => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
  }
  const scheduleClose = (): void => {
    cancelClose()
    closeTimer.current = setTimeout(() => setSubmenu(null), SUBMENU_CLOSE_MS)
  }
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])

  const close = (): void => { cancelClose(); setSubmenu(null); onClose() }

  const row = (entry: NoteMenuEntry, key: string): JSX.Element => {
    if ('divider' in entry) return <Divider key={key} sx={{ my: 0.5 }} />
    if ('children' in entry) {
      const open = submenu?.id === entry.id
      const show = (element: HTMLElement): void => {
        cancelClose()
        setSubmenu({ id: entry.id, anchor: element, entries: entry.children })
      }
      return (
        <MenuItem
          key={entry.id}
          data-note-menu-item={entry.id}
          disabled={entry.disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          selected={open}
          onMouseEnter={(event) => show(event.currentTarget)}
          onMouseLeave={scheduleClose}
          onClick={(event) => show(event.currentTarget)}
          sx={{ gap: 1, py: 0.5, minHeight: 30 }}
        >
          <Box component="span" aria-hidden sx={{ width: 14, flexShrink: 0 }} />
          <ListItemText primary={entry.label} primaryTypographyProps={{ fontSize: 12.5 }} sx={{ my: 0 }} />
          <ChevronRightRounded sx={{ fontSize: 16, ml: 'auto', pl: 3, color: 'text.secondary' }} />
        </MenuItem>
      )
    }
    return (
      <MenuItem
        key={entry.id}
        data-note-menu-item={entry.id}
        data-note-menu-checked={entry.checked ? 'on' : undefined}
        disabled={entry.disabled}
        onClick={() => { entry.run(); close() }}
        sx={{ gap: 2, py: 0.5, minHeight: 30 }}
      >
        <Box component="span" aria-hidden sx={{ width: 14, display: 'grid', placeItems: 'center', color: 'primary.main', flexShrink: 0 }}>
          {entry.checked ? <CheckRounded sx={{ fontSize: 14 }} /> : null}
        </Box>
        <ListItemText primary={entry.label} primaryTypographyProps={{ fontSize: 12.5 }} sx={{ my: 0 }} />
        {entry.shortcut && <Box component="span" sx={{ ml: 'auto', pl: 3, fontSize: 10.5, color: 'text.disabled', fontVariantNumeric: 'tabular-nums' }}>{entry.shortcut}</Box>}
      </MenuItem>
    )
  }

  return (
    <>
      <Menu
        open={Boolean(anchor)}
        onClose={close}
        anchorReference="anchorPosition"
        anchorPosition={anchor ? { top: anchor.y, left: anchor.x } : undefined}
        data-note-context-menu
        slotProps={{ paper: { sx: { minWidth: 232, py: 0.5 }, onMouseLeave: scheduleClose } }}
      >
        {entries.map((entry, index) => row(entry, `root-${index}`))}
        {!entries.length && <Typography sx={{ px: 2, py: 1, fontSize: 12, color: 'text.disabled' }}>—</Typography>}
      </Menu>
      <Menu
        open={Boolean(submenu)}
        onClose={() => setSubmenu(null)}
        anchorEl={submenu?.anchor ?? null}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        data-note-context-submenu
        // `disableRestoreFocus` keeps the editor's DOM focus where the selection
        // lives while the pointer travels between the two papers.
        disableRestoreFocus
        slotProps={{ paper: { sx: { minWidth: 196, py: 0.5, ml: 0.5 }, onMouseEnter: cancelClose, onMouseLeave: scheduleClose } }}
      >
        {submenu?.entries.map((entry, index) => row(entry, `sub-${index}`))}
      </Menu>
    </>
  )
}
