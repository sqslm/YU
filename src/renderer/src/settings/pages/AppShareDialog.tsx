/**
 * The 热门场景 breakdown, opened from the chip row on the overview page.
 *
 * Two rules drive the design:
 *
 * - The numbers come from `insights.apps`, the very array the chips render.
 *   A chip that says "12 次 · 34%" and a legend that says something else would
 *   be two products disagreeing about one number, so both read the same list.
 * - No chart library. The ring is four attributes of SVG per segment, which
 *   keeps the renderer bundle free of a dependency that would exist for one
 *   dialog and one screen of pixels.
 */
import CloseIcon from '@mui/icons-material/Close'
import { Box, Button, Dialog, IconButton, Tooltip, Typography } from '@mui/material'
import { useState } from 'react'
import type { Tokens } from '../theme'
import { group, type AppUsage } from './insights'
import { donutSlices } from './pie'
import i18n from '../../i18n'

export interface AppShareDialogProps {
  open: boolean
  onClose: () => void
  /** Palette of the resolved light/dark mode, so the panel matches the page. */
  t: Tokens
  /** The same per-app rows the 热门场景 chips are built from. */
  apps: readonly AppUsage[]
  /**
   * Calls across every app in the rollup. It can exceed the listed counts when
   * the breakdown is capped, and the caption says so instead of quietly
   * pretending the visible apps are all of them.
   */
  total: number
}

/** Side of the coordinate box the SVG uses; `pie.ts` draws in a 100×100 one. */
const CHART = 132

/**
 * How far a hovered segment slides out of the ring, in viewBox units.
 *
 * Small on purpose: the slice should look lifted, not detached. Two units of a
 * 100-unit box is about 2.6 px at this size, which reads as a step forward
 * without opening a gap the eye has to explain.
 */
const LIFT = 2

export function AppShareDialog({ open, onClose, t, apps, total }: AppShareDialogProps): JSX.Element {
  // Same input, same order, same colours as the chips: `donutSlices` assigns a
  // colour by index, and `appColor(index)` is what the chip dot uses too.
  const slices = donutSlices(apps.map((app) => ({ name: app.name, count: app.count })))
  const listed = slices.reduce((sum, slice) => sum + slice.count, 0)
  const unlisted = Math.max(0, Math.round(total) - listed)
  // One hovered name drives both the ring and the legend, so pointing at either
  // one says the same thing and the two halves of the dialog never disagree.
  const [hovered, setHovered] = useState<string | null>(null)
  const focus = slices.find((slice) => slice.name === hovered) ?? null
  // MUI's `paper` slot type has no `data-*` surface, and the attribute is what a
  // CDP check asserts on; spreading a plain map keeps everything else typed.
  const paperSlot: Record<string, unknown> = { 'data-app-share-dialog': 'on' }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      aria-labelledby="app-share-title"
      slotProps={{
        paper: {
          // The paper's own border/background come from the theme's MuiPaper
          // override; only the radius and the room for the ring are local.
          sx: { borderRadius: '12px', bgcolor: t.surface },
          ...paperSlot
        }
      }}
    >
      <Box sx={{ p: 2.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              id="app-share-title"
              sx={{ fontSize: 15, fontWeight: 600, letterSpacing: -0.2 }}
            >
              {i18n.t('热门场景分布')}
            </Typography>
            <Typography sx={{ fontSize: 11.5, color: t.textDim, mt: 0.5 }}>
              {i18n.t('按前台 App 统计文字最后落在了哪里')}
            </Typography>
          </Box>
          <IconButton
            size="small"
            aria-label={i18n.t(i18n.t('关闭'))}
            data-app-share-close
            onClick={onClose}
            sx={{ mt: -0.5, mr: -0.5, color: t.textDim }}
          >
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Box>

        {slices.length === 0 ? (
          <Typography sx={{ mt: 2.5, fontSize: 12, color: t.textFaint, lineHeight: 1.7 }}>
            {i18n.t('还没有可以统计的记录，按住快捷键说第一句话之后，这里会按 App 画出分布。')}
          </Typography>
        ) : (
          <>
            <Box
              sx={{ position: 'relative', width: CHART, height: CHART, mx: 'auto', mt: 2 }}
              onMouseLeave={() => setHovered(null)}
            >
              <svg
                width={CHART}
                height={CHART}
                viewBox="0 0 100 100"
                role="img"
                aria-label={i18n.t('{{n}} 个 App 的调用占比', { n: slices.length })}
              >
                {slices.map((slice) => {
                  const mid = ((slice.startAngle + slice.endAngle) / 2 - 90) * (Math.PI / 180)
                  const active = slice.name === hovered
                  const dim = hovered !== null && !active
                  return (
                    // The tooltip is the readable version of the `<title>` that used
                    // to be here: a native SVG title waits a second and cannot carry
                    // a layout, and the same information already lives in the legend,
                    // so nothing is lost by replacing it.
                    <Tooltip
                      key={slice.name}
                      arrow
                      enterDelay={80}
                      leaveDelay={0}
                      disableInteractive
                      placement="top"
                      slotProps={{
                        tooltip: {
                          sx: {
                            bgcolor: t.surfaceHi,
                            color: t.text,
                            border: 1,
                            borderColor: 'divider',
                            boxShadow: '0 6px 18px rgba(0,0,0,.45)',
                            borderRadius: '8px',
                            px: 1,
                            py: 0.75
                          }
                        },
                        arrow: { sx: { color: t.surfaceHi, '&::before': { border: 1, borderColor: 'divider' } } }
                      }}
                      title={
                        <Box data-pie-tip={slice.name}>
                          <Typography sx={{ fontSize: 11.5, fontWeight: 600, lineHeight: 1.35 }}>
                            {slice.name}
                          </Typography>
                          <Typography sx={{ fontSize: 10.5, color: t.textDim, lineHeight: 1.45, mt: 0.25 }}>
                            {i18n.t('{{n}} 次 · {{pct}}%', { n: group(slice.count), pct: slice.percent })}
                          </Typography>
                        </Box>
                      }
                    >
                      <path
                        data-pie-slice={slice.name}
                        data-pie-active={active ? 'on' : 'off'}
                        d={slice.path}
                        fill={slice.color}
                        style={{
                          // The lift is a transform rather than a bigger radius: the
                          // arc path is already computed, and re-deriving it per hover
                          // would make the ring stutter on every pointer move.
                          transform: active
                            ? `translate(${(Math.cos(mid) * LIFT).toFixed(2)}px, ${(Math.sin(mid) * LIFT).toFixed(2)}px)`
                            : 'translate(0px, 0px)',
                          transformOrigin: 'center',
                          opacity: dim ? 0.45 : 1,
                          filter: active ? 'brightness(1.16) drop-shadow(0 3px 6px rgba(0,0,0,.4))' : 'none',
                          transition:
                            'transform 150ms cubic-bezier(.2,.7,.3,1), opacity 150ms ease, filter 150ms ease',
                          cursor: 'pointer'
                        }}
                        onMouseEnter={() => setHovered(slice.name)}
                        onFocus={() => setHovered(slice.name)}
                      />
                    </Tooltip>
                  )
                })}
              </svg>
              {/* Text sits in HTML, not in the SVG: it inherits the app font
                  stack, and it stays crisp at any zoom level. */}
              <Box
                sx={{
                  position: 'absolute',
                  inset: 0,
                  display: 'grid',
                  placeItems: 'center',
                  textAlign: 'center',
                  pointerEvents: 'none'
                }}
              >
                <Box sx={{ maxWidth: CHART - 52, px: 0.5 }}>
                  {focus ? (
                    // While hovering, the hole in the ring answers "which one is
                    // this, and how big" without moving the eye to the legend.
                    <>
                      <Typography
                        data-pie-center={focus.name}
                        sx={{
                          fontSize: 15,
                          fontWeight: 600,
                          letterSpacing: -0.3,
                          lineHeight: 1.15,
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden'
                        }}
                      >
                        {focus.name}
                      </Typography>
                      <Typography
                        sx={{
                          fontSize: 10,
                          color: t.textDim,
                          mt: 0.35,
                          fontVariantNumeric: 'tabular-nums'
                        }}
                      >
                        {i18n.t('{{n}} 次 · {{pct}}%', { n: group(focus.count), pct: focus.percent })}
                      </Typography>
                    </>
                  ) : (
                    <>
                      <Typography
                        sx={{ fontSize: 20, fontWeight: 700, letterSpacing: -0.7, lineHeight: 1.1 }}
                      >
                        {group(total)}
                      </Typography>
                      <Typography sx={{ fontSize: 9.5, color: t.textFaint, mt: 0.25 }}>
                        {i18n.t('次调用')}
                      </Typography>
                    </>
                  )}
                </Box>
              </Box>
            </Box>

            <Box
              data-app-share-legend
              sx={{ mt: 1.75, display: 'flex', flexDirection: 'column', gap: 0.6 }}
            >
              {slices.map((slice) => {
                const active = slice.name === hovered
                const dim = hovered !== null && !active
                return (
                  <Box
                    key={slice.name}
                    data-pie-legend={slice.name}
                    data-pie-legend-active={active ? 'on' : 'off'}
                    onMouseEnter={() => setHovered(slice.name)}
                    onMouseLeave={() => setHovered(null)}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 0.9,
                      minWidth: 0,
                      px: 0.75,
                      py: 0.4,
                      my: -0.2,
                      borderRadius: '6px',
                      // The legend follows the ring: hovering a row lifts its
                      // segment, so the two halves point at the same thing.
                      bgcolor: active ? t.accentSoft : 'transparent',
                      opacity: dim ? 0.6 : 1,
                      transition: 'background-color 130ms ease, opacity 130ms ease',
                      cursor: 'default'
                    }}
                  >
                    <Box
                      sx={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        bgcolor: slice.color,
                        flexShrink: 0
                      }}
                    />
                    <Typography
                      sx={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 11.5,
                        color: t.text,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {slice.name}
                    </Typography>
                    <Typography
                      sx={{
                        flexShrink: 0,
                        fontSize: 11,
                        color: active ? t.text : t.textDim,
                        fontVariantNumeric: 'tabular-nums'
                      }}
                    >
                      {i18n.t('{{n}} 次 · {{pct}}%', { n: group(slice.count), pct: slice.percent })}
                    </Typography>
                  </Box>
                )
              })}
            </Box>

            {unlisted > 0 && (
              <Typography sx={{ mt: 1.25, fontSize: 10.5, color: t.textFaint }}>
                {i18n.t('另有 {{n}} 次来自未列出的 App，饼图按上面列出的这些归一。', { n: group(unlisted) })}
              </Typography>
            )}
          </>
        )}

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2 }}>
          <Button size="small" variant="contained" data-app-share-dialog-close onClick={onClose}>
            {i18n.t('关闭')}
          </Button>
        </Box>
      </Box>
    </Dialog>
  )
}
