import { Box, Divider, ListItemText, Menu, MenuItem, Typography } from '@mui/material'

/** One row of a note context menu; a divider separates groups. */
export type NoteMenuEntry =
  | { id: string; label: string; shortcut?: string; disabled?: boolean; run: () => void }
  | { divider: true }

export interface NoteContextMenuProps {
  /** Viewport coordinates of the click, or null when the menu is closed. */
  anchor: { x: number; y: number } | null
  entries: NoteMenuEntry[]
  onClose: () => void
}

/**
 * The right-click menu of a note body.
 *
 * Deliberately a plain MUI menu anchored at the cursor instead of a native
 * Electron menu: the actions are markdown-aware (toggle a mark, turn a block into
 * a heading, copy the note as markdown) and live in the renderer where the editor
 * already is. Only the note body installs it — the rest of the page keeps the
 * platform default, which is what the user asked for.
 */
export function NoteContextMenu({ anchor, entries, onClose }: NoteContextMenuProps): JSX.Element {
  return (
    <Menu
      open={Boolean(anchor)}
      onClose={onClose}
      anchorReference="anchorPosition"
      anchorPosition={anchor ? { top: anchor.y, left: anchor.x } : undefined}
      data-note-context-menu
      slotProps={{ paper: { sx: { minWidth: 208, py: 0.5 } } }}
    >
      {entries.map((entry, index) => ('divider' in entry)
        ? <Divider key={`divider-${index}`} sx={{ my: 0.5 }} />
        : <MenuItem
            key={entry.id}
            data-note-menu-item={entry.id}
            disabled={entry.disabled}
            onClick={() => { entry.run(); onClose() }}
            sx={{ gap: 2, py: 0.5, minHeight: 30 }}
          >
            <ListItemText primary={entry.label} primaryTypographyProps={{ fontSize: 12.5 }} sx={{ my: 0 }} />
            {entry.shortcut && <Box component="span" sx={{ ml: 'auto', pl: 3, fontSize: 10.5, color: 'text.disabled', fontVariantNumeric: 'tabular-nums' }}>{entry.shortcut}</Box>}
          </MenuItem>)}
      {!entries.length && <Typography sx={{ px: 2, py: 1, fontSize: 12, color: 'text.disabled' }}>—</Typography>}
    </Menu>
  )
}
