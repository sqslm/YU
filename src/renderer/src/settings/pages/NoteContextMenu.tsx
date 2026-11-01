import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Box, Divider, ListItemText, Menu, MenuItem, Paper, Typography, useTheme } from '@mui/material'
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

/** Width the submenu needs before it opens to the left of its row instead. */
const SUBMENU_WIDTH = 220

/** A row is 30 px and the panel pads 4 px top and bottom; used to keep it on screen. */
const ROW_HEIGHT = 30
const PANEL_PADDING = 8

interface SubmenuState {
  id: string
  entries: NoteMenuEntry[]
  /** Viewport position of the panel, already flipped and clamped. */
  left: number
  top: number
  /** Whether the panel sits left of its row (no room on the right). */
  flip: boolean
}

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
 * 与块 should not require a click first. A click still works (keyboard, touch,
 * and anyone who expects it).
 *
 * The submenu is *not* a second `Menu`. A second MUI menu is a second modal layer
 * with its own full-screen backdrop, sitting on top of the first: the row under
 * the pointer reported `mouseleave` the moment the panel appeared, the close timer
 * dropped the panel, the row reported `mouseenter` again, and the pair oscillated
 * several times a second ("二级菜单一直闪"). A plain positioned `Paper` rendered
 * into a portal has no modal layer of its own, so the pointer simply travels from
 * the row into the panel and the hover stays alive. The pointer-position guard
 * below is the belt to that braces: nothing closes while the pointer is still over
 * the row or the panel.
 */
export function NoteContextMenu({ anchor, entries, onClose }: NoteContextMenuProps): JSX.Element {
  const theme = useTheme()
  const [submenu, setSubmenu] = useState<SubmenuState | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The row whose submenu is open, in viewport coordinates. */
  const anchorRow = useRef<HTMLElement | null>(null)
  /** Live pointer position: the modal layer makes the enter/leave stream lie. */
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const panel = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const track = (event: MouseEvent): void => { pointer.current = { x: event.clientX, y: event.clientY } }
    document.addEventListener('mousemove', track, true)
    return () => document.removeEventListener('mousemove', track, true)
  }, [])

  const cancelClose = (): void => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
  }
  /** True while the pointer still sits in `element`; 2 px of slack for the edge. */
  const pointerInside = (element: HTMLElement | null | undefined): boolean => {
    const point = pointer.current
    if (!element || !point) return false
    const rect = element.getBoundingClientRect()
    return point.x >= rect.left - 2 && point.x <= rect.right + 2 && point.y >= rect.top - 2 && point.y <= rect.bottom + 2
  }
  const scheduleClose = (): void => {
    cancelClose()
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null
      if (pointerInside(anchorRow.current) || pointerInside(panel.current)) return
      setSubmenu(null)
    }, SUBMENU_CLOSE_MS)
  }
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])

  const close = (): void => { cancelClose(); setSubmenu(null); onClose() }

  const row = (entry: NoteMenuEntry, key: string): JSX.Element => {
    if ('divider' in entry) return <Divider key={key} sx={{ my: 0.5 }} />
    if ('children' in entry) {
      const open = submenu?.id === entry.id
      const show = (element: HTMLElement): void => {
        cancelClose()
        anchorRow.current = element
        const rowRect = element.getBoundingClientRect()
        // Open towards the editor when the panel would not fit on the right — the
        // note pane puts the menu close to the window edge, and a panel clamped
        // back over its own row is what the flicker used to look like.
        const flip = rowRect.right + SUBMENU_WIDTH + 8 > window.innerWidth
        const height = entry.children.length * ROW_HEIGHT + PANEL_PADDING
        setSubmenu({
          id: entry.id,
          entries: entry.children,
          flip,
          left: Math.round(flip ? rowRect.left - SUBMENU_WIDTH - 4 : rowRect.right + 4),
          top: Math.round(Math.max(8, Math.min(rowRect.top, window.innerHeight - height - 8)))
        })
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
        // Hovering a plain entry means the open panel no longer belongs to the row
        // the pointer just left; the guard above still protects 标题/列表与块.
        onMouseEnter={scheduleClose}
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
      {submenu && createPortal(
        <Paper
          ref={panel}
          elevation={8}
          data-note-context-submenu
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          sx={{
            position: 'fixed',
            left: submenu.left,
            top: submenu.top,
            zIndex: theme.zIndex.modal + 1,
            width: SUBMENU_WIDTH,
            py: 0.5,
            border: 1,
            borderColor: 'divider',
            borderRadius: 1
          }}
        >
          <Box component="ul" role="menu" sx={{ listStyle: 'none', m: 0, p: 0 }}>
            {submenu.entries.map((entry, index) => row(entry, `sub-${index}`))}
          </Box>
        </Paper>,
        document.body
      )}
    </>
  )
}
