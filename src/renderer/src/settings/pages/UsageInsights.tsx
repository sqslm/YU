import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, ButtonBase, Tooltip, Typography } from '@mui/material'
import type { HistoryEntry, Settings } from '@shared/types'
import type { StatsFile } from '@shared/stats'
import { palettes } from '../theme'
import { IconBook, IconChart, IconClock, IconMic, IconSparkles } from '../icons'
import {
  WEEKDAY,
  bucketFromStats,
  clock,
  heatFromStats,
  heatLevel,
  monthLabels,
  shortClock,
  todayFromStats
} from './overview'
import { durationLabel, group, insightsFromStats, savedLabel, wpmLabel } from './insights'
import { buildShareCard, drawShareCard, shareCardFileName } from './shareCard'
import { AppShareDialog } from './AppShareDialog'
import { appColor, piePercentages } from './pie'
import i18n, { currentUiLanguage } from '../../i18n'

interface UsageInsightsProps {
  settings: Settings
  mode: 'dark' | 'light'
  entries: HistoryEntry[] | undefined
  stats: StatsFile
  now: number
  onOpenHistory: (query?: string) => void
}

type Range = 7 | 30
type Metric = 'count' | 'chars' | 'duration'

/** Space above the cells reserved for the month captions. */
const MONTH_ROW = 14
/** Gap between heat cells; the same value drives the weekday label column. */
const HEAT_GAP = 2

const METRIC_LABEL: Record<Metric, string> = {
  count: '条数',
  chars: '字数',
  duration: '时长'
}

export function UsageInsights({ settings, mode, entries, stats, now, onOpenHistory }: UsageInsightsProps): JSX.Element {
  const t = palettes[mode]
  const [range, setRange] = useState<Range>(7)
  const [metric, setMetric] = useState<Metric>('count')
  const [sharing, setSharing] = useState(false)
  const [shareHint, setShareHint] = useState<string | null>(null)
  const [appShareOpen, setAppShareOpen] = useState(false)
  const [hover, setHover] = useState<number | null>(null)

  const today = useMemo(() => todayFromStats(stats, now), [stats, now])

  // Vendor-style lifetime insights: cumulative volume, weighted speaking rate,
  // time saved versus typing, the streak and the apps the text landed in.
  const insights = useMemo(() => insightsFromStats(stats, { now, topApps: Object.keys(stats.apps).length }), [stats, now])
  const saved = useMemo(() => savedLabel(insights.savedMs), [insights.savedMs])

  /**
   * Calls across every app in the rollup. `insights.apps` contains the full ranked list, so
   * the dialog's centre number comes from the rollup itself: a capped list
   * summed on its own would report "68 次" while the history holds 90.
   */
  const appTotal = useMemo(
    () => Object.values(stats.apps).reduce((sum, count) => sum + count, 0),
    [stats]
  )

  /**
   * Percentages for the 热门场景 chips, from the same helper the dialog's ring
   * uses. `share * 100` rounded per chip reads 6% for a 6.38% slice while the
   * ring, which has to add up to 100, prints 7% — one number, two answers. The
   * largest-remainder split is therefore computed once here and both views print
   * its digits.
   */
  const appPercents = useMemo(
    () => piePercentages(insights.apps.map((app) => app.count)),
    [insights.apps]
  )

  const buckets = useMemo(() => bucketFromStats(stats, range, now), [stats, range, now])

  const chart = useMemo(() => {
    const value = (day: { count: number; chars: number; ms: number }): number =>
      metric === 'count' ? day.count : metric === 'chars' ? day.chars : Math.round(day.ms / 1000)
    const values = buckets.map(value)
    const total = values.reduce((sum, n) => sum + n, 0)
    const max = Math.max(1, ...values)
    return { values, total, max, average: Math.round(total / Math.max(1, buckets.length)) }
  }, [buckets, metric])

  const heat = useMemo(() => heatFromStats(stats, new Date(now)), [stats, now])

  /**
   * Cell size for the year grid. A fixed 11px cell left a wide strip of empty
   * card to the right of December, so the size comes from the width the card
   * actually offers: 53 columns plus their gaps, minus the weekday label column.
   * The value is deliberately fractional — rounding down left a 30px gutter on
   * the right, and a tenth of a pixel per cell is invisible while the grid now
   * ends exactly at the card's padding edge.
   */
  const heatBoxRef = useRef<HTMLDivElement | null>(null)
  const [heatCell, setHeatCell] = useState(11)
  const heatWeekCount = heat.weeks.length
  useEffect(() => {
    const element = heatBoxRef.current
    if (!element) return
    const measure = (): void => {
      const available = element.clientWidth - 26
      if (available <= 0 || heatWeekCount === 0) return
      const raw = (available - HEAT_GAP * (heatWeekCount - 1)) / heatWeekCount
      setHeatCell(Math.max(8, Math.min(20, Math.round(raw * 100) / 100)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [heatWeekCount])

  /**
   * Month captions land on the column where that month's first week starts.
   * 11px columns are narrower than a "10月" caption, so neighbouring labels
   * collide; `monthLabels` drops the ones that would overlap (the current
   * month always survives, because that is the one the reader looks for).
   */
  // `monthLabels` translates month names itself, so the memo has to recompute when
  // the interface language flips; keyed on `heat` alone it kept the labels it
  // captured on the first render (Chinese, on a reload, before settings applied).
  const language = currentUiLanguage()
  const monthCols = useMemo(() => monthLabels(heat.weeks), [heat, language])

  /**
   * Renders the same figures into a 1080×1350 PNG and hands it to the main
   * process for a save dialog. Off-screen canvas so nothing flashes on screen.
   */
  const shareInsights = useCallback(async (): Promise<void> => {
    if (sharing) return
    setSharing(true)
    setShareHint(i18n.t('生成中…'))
    try {
      const levels = heat.weeks.flatMap((week) =>
        week.map((cell) => heatLevel(cell.count, heat.max))
      )
      const model = buildShareCard(insights, { heat: levels })
      const canvas = document.createElement('canvas')
      canvas.width = model.width
      canvas.height = model.height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error(i18n.t('浏览器不支持绘图'))
      drawShareCard(ctx, model, {
        canvas: t.canvas,
        surface: t.surface,
        text: t.text,
        textDim: t.textDim,
        textFaint: t.textFaint,
        accent: t.accent,
        line: t.line
      })
      const result = await window.api.app.saveImage(
        canvas.toDataURL('image/png'),
        shareCardFileName(Date.now())
      )
      setShareHint(result.ok ? i18n.t('已保存') : (result.message ?? i18n.t('保存失败')))
    } catch (err) {
      setShareHint(err instanceof Error ? err.message : i18n.t('生成失败'))
    } finally {
      setSharing(false)
      window.setTimeout(() => setShareHint(null), 2600)
    }
  }, [heat, insights, sharing, t])


  // The renderer runs on file://, which has no clipboard permission — the copy
  // has to go through the main process (same path the history page uses).
  const card = {
    bgcolor: t.surface,
    border: `1px solid ${t.line}`,
    borderRadius: '12px'
  } as const
  return (
    <Box
      sx={{
        minWidth: 0,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 1
      }}
    >
      {/* One strip, four numbers. Four separate tiles made the page read as a
          dashboard of dashboards; the three "today" numbers belong together, and
          the lifetime count answers a different question, so it sits behind a
          divider instead of in a tile of its own. */}
      <Box
        data-today-stats
        sx={{ ...card, display: 'flex', alignItems: 'stretch', px: 2, py: 1.15, gap: 2, flexShrink: 0 }}
      >
        {[
          {
            icon: <IconSparkles size={12} />,
            label: i18n.t('今日字数'),
            value: String(today.chars),
            sub: i18n.t('{{n}} 段', { n: today.segments })
          },
          {
            icon: <IconClock size={12} />,
            label: i18n.t('今日总时长'),
            value: clock(today.spoken),
            sub: today.segments > 0 ? i18n.t('平均 {{n}}', { n: shortClock(today.average) }) : i18n.t('今天还没有说话')
          },
          {
            icon: <IconMic size={12} />,
            // Pace is the one today-number the old tiles never showed: "average
            // paragraph" only repeated the footnote under the duration.
            label: i18n.t('今日语速'),
            value: today.pace > 0 ? String(today.pace) : '—',
            sub: today.pace > 0 ? i18n.t('字/分') : i18n.t('暂无有效语速样本')
          }
        ].map((item) => (
          <Box key={item.label} sx={{ flex: 1, minWidth: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
              <Box sx={{ display: 'grid', placeItems: 'center', color: t.textDim, opacity: 0.9 }}>{item.icon}</Box>
              <Typography sx={{ fontSize: 10.5, color: t.textDim }}>{item.label}</Typography>
            </Box>
            <Typography
              sx={{
                fontSize: 18,
                fontWeight: 700,
                letterSpacing: -0.5,
                lineHeight: 1.35,
                fontVariantNumeric: 'tabular-nums'
              }}
            >
              {item.value}
            </Typography>
            <Typography
              sx={{
                fontSize: 9.5,
                color: t.textFaint,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {item.sub}
            </Typography>
          </Box>
        ))}

        <Box sx={{ width: '1px', bgcolor: t.line, flexShrink: 0 }} />

        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
            <Box sx={{ display: 'grid', placeItems: 'center', color: t.textDim, opacity: 0.9 }}>
              <IconBook size={12} />
            </Box>
            <Typography sx={{ fontSize: 10.5, color: t.textDim }}>{i18n.t('保留的记录')}</Typography>
          </Box>
          <Typography
            sx={{
              fontSize: 18,
              fontWeight: 700,
              letterSpacing: -0.5,
              lineHeight: 1.35,
              fontVariantNumeric: 'tabular-nums'
            }}
          >
            {entries ? String(entries.length) : '—'}
          </Typography>
          <Typography
            sx={{
              fontSize: 9.5,
              color: t.textFaint,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {i18n.t('本机存档（上限 {{n}}）', { n: settings.historyLimit })}
          </Typography>
        </Box>
      </Box>


      {/* Trend and lifetime insights share one band: both answer "how am I
          doing over time", and side by side they cost a row instead of two. */}
      <Box
        data-home-trend
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1.6fr) minmax(0, 1fr)' },
          gap: 1,
          minHeight: 200,
          flexShrink: 0
        }}
      >
        <Box
          sx={{
            ...card,
            p: 1.5,
            flex: 1,
            // Bars are drawn as a percentage of this card, so a card squeezed
            // to 120 px renders bars shorter than their own labels.
            minHeight: 186,
            display: 'flex',
            flexDirection: 'column'
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Pills
              t={t}
              items={[
                { id: '7', label: i18n.t('近 7 天') },
                { id: '30', label: i18n.t('近 30 天') }
              ]}
              value={String(range)}
              onChange={(id) => setRange(id === '30' ? 30 : 7)}
            />
            <Box sx={{ ml: 'auto' }}>
              <Pills
                t={t}
                items={[
                  { id: 'count', label: i18n.t(METRIC_LABEL.count) },
                  { id: 'chars', label: i18n.t(METRIC_LABEL.chars) },
                  { id: 'duration', label: i18n.t(METRIC_LABEL.duration) }
                ]}
                value={metric}
                onChange={(id) => setMetric(id as Metric)}
              />
            </Box>
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mt: 1 }}>
            <Typography sx={{ fontSize: 22, fontWeight: 700, letterSpacing: -0.8 }}>
              {chart.total}
            </Typography>
            <Typography sx={{ fontSize: 11, color: t.textFaint }}>
              {i18n.t('日均 {{n}}', { n: chart.average })}
              {metric === 'duration' ? ' ' + i18n.t('秒') : ''}
            </Typography>
          </Box>

          <Box
            sx={{
              mt: 1,
              // Grows to fill the card so the chart's baseline lines up with the
              // bottom of the neighbouring list instead of leaving a dead band.
              flex: 1,
              minHeight: 96,
              display: 'flex',
              alignItems: 'flex-end',
              gap: range === 7 ? 1.75 : 0.4,
              position: 'relative',
              // The card is full width now; without a cap seven buckets spread
              // across ~800 px read as slabs floating in a gap. 620 px keeps the
              // pitch of a normal week and centres the plot under the numbers.
              width: '100%',
              maxWidth: 620,
              mx: 'auto'
            }}
          >
            {[0, 0.5, 1].map((ratio) => (
              <Box
                key={ratio}
                sx={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: `${ratio * 100}%`,
                  borderTop: `1px dashed ${t.line}`
                }}
              />
            ))}
            {chart.values.map((value, index) => {
              const unit = metric === 'duration' ? i18n.t('秒') : metric === 'chars' ? i18n.t('字') : i18n.t('条')
              const active = hover === index
              const bucket = buckets[index]
              // 30px is reserved for the number above and the weekday below, so
              // the bar can be a percentage of whatever height the card offers.
              const ratio = value > 0 ? Math.max(0.05, value / chart.max) : 0
              /**
               * The whole day, not just the plotted metric: the bar answers "which
               * day was busiest", and the card answers "so what happened on it".
               */
              const detail = bucket ? (
                <Box data-chart-detail={bucket.key} sx={{ py: 0.25 }}>
                  <Typography sx={{ fontSize: 11, fontWeight: 600, color: t.text }}>
                    {i18n.t('{{m}} 月 {{d}} 日 · 周', { m: Number(bucket.key.slice(5, 7)), d: Number(bucket.key.slice(8)) })}
                    {bucket.label}
                  </Typography>
                  <Typography
                    sx={{
                      mt: 0.4,
                      fontSize: 10.5,
                      color: t.textDim,
                      fontVariantNumeric: 'tabular-nums'
                    }}
                  >
                    {i18n.t('{{count}} 条 · {{chars}} 字 · {{time}}', { count: bucket.count, chars: bucket.chars, time: bucket.ms > 0 ? clock(bucket.ms) : '0:00' })}
                  </Typography>
                  {active && (
                    <Typography sx={{ mt: 0.2, fontSize: 10, color: t.textFaint }}>
                      {i18n.t('当前按「{{metric}}」排序，这一天 {{value}} {{unit}}', { metric: i18n.t(METRIC_LABEL[metric] ?? ''), value, unit })}
                    </Typography>
                  )}
                </Box>
              ) : (
                ''
              )
              return (
                <Tooltip key={index} arrow placement="top" title={detail}>
                  <Box
                    data-chart-column={index}
                    data-chart-column-active={active ? 'on' : 'off'}
                    onMouseEnter={() => setHover(index)}
                    onMouseLeave={() => setHover(null)}
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      height: '100%',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'flex-end',
                      alignItems: 'center',
                      position: 'relative',
                      // No column background on hover: the ring around the bar read
                      // as a selected cell rather than as the bar reacting.
                      cursor: 'default'
                    }}
                  >
                    {value > 0 && (
                      <Typography
                        sx={{
                          fontSize: 9.5,
                          color: active ? 'text.primary' : t.textDim,
                          mb: 0.5,
                          fontVariantNumeric: 'tabular-nums',
                          transition: 'color .12s ease'
                        }}
                      >
                        {value}
                      </Typography>
                    )}
                    <Box
                      data-chart-bar={index}
                      data-chart-bar-active={active ? 'on' : 'off'}
                      sx={{
                        width: range === 7 ? '52%' : '68%',
                        height: value > 0 ? `calc((100% - 30px) * ${ratio})` : 2,
                        borderRadius: '3px',
                        bgcolor:
                          value > 0
                            ? active
                              ? t.accent
                              : t.textFaint
                            : t.line,
                        // A 2px lift and a slightly brighter body: enough to feel
                        // alive under the pointer, small enough not to move the axis.
                        transform: active && value > 0 ? 'translateY(-2px)' : 'none',
                        transformOrigin: 'bottom',
                        boxShadow: active && value > 0 ? '0 3px 10px rgba(0,0,0,.35)' : 'none',
                        transition:
                          'transform .16s cubic-bezier(.2,.7,.3,1), background-color .12s ease, box-shadow .16s ease'
                      }}
                    />
                    {range === 7 && (
                      <Typography
                        sx={{ mt: 0.5, fontSize: 9.5, color: active ? t.textDim : t.textFaint }}
                      >
                        {bucket?.label}
                      </Typography>
                    )}
                  </Box>
                </Tooltip>
              )
            })}
          </Box>
        </Box>

        {/* Lifetime numbers, not today's: these are the ones that make the
            habit feel worth keeping. */}
        <Box sx={{ ...card, px: 1.75, py: 1.25, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography sx={{ fontSize: 11.5, color: t.textDim }}>{i18n.t(i18n.t('使用洞察'))}</Typography>
            <Button
              size="small"
              data-share-insights
              variant="text"
              disabled={sharing}
              onClick={() => void shareInsights()}
              sx={{
                ml: 'auto',
                minWidth: 0,
                px: 0.75,
                py: 0,
                fontSize: 10.5,
                lineHeight: '16px',
                color: t.textDim,
                '&:hover': { color: t.text, bgcolor: t.surfaceHi }
              }}
            >
              {shareHint ?? i18n.t('分享成图')}
            </Button>
          </Box>
          <Box
            sx={{
              mt: 0.75,
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              columnGap: 1.5,
              rowGap: 1.1
            }}
          >
            {[
              {
                label: i18n.t('累计口述字数'),
                value: group(insights.units),
                sub: i18n.t('字 · 累计 {{span}}', { span: durationLabel(insights.spokenMs) })
              },
              {
                label: i18n.t('平均语速'),
                value: wpmLabel(insights.wpm),
                sub:
                  insights.measured > 0
                    ? i18n.t('字/分 · {{n}} 条样本', { n: group(insights.measured) })
                    : i18n.t('字/分 · 暂无样本')
              },
              {
                label: i18n.t('节省时间'),
                value: saved.value,
                sub: i18n.t('{{unit}} · 对比 {{wpm}} 字/分', { unit: i18n.t(saved.unit), wpm: insights.typingWpm })
              },
              {
                label: i18n.t('连续天数'),
                value: insights.records === 0 ? '—' : String(insights.streak.current),
                sub: insights.records === 0 ? i18n.t('还没有记录') : `天 · 最长 ${insights.streak.longest} 天`
              }
            ].map((item) => (
              <Box key={item.label} sx={{ minWidth: 0 }}>
                <Typography sx={{ fontSize: 10, color: t.textFaint }}>{item.label}</Typography>
                <Typography sx={{ fontSize: 16, fontWeight: 700, letterSpacing: -0.4, lineHeight: 1.3 }}>
                  {item.value}
                </Typography>
                {/* The footnote gets its own line: four columns are too narrow
                    for a number and a sentence side by side. */}
                <Typography
                  sx={{
                    fontSize: 9.5,
                    color: t.textFaint,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0
                  }}
                >
                  {item.sub}
                </Typography>
              </Box>
            ))}
          </Box>
        </Box>
      </Box>

      {/* The year in one picture, with no caption: the four numbers above already
          say what period this is, and a 少→多 swatch row only repeated the five
          shades the cells themselves make obvious. Cells are sized to the card so
          the grid fills it edge to edge instead of hugging the left. */}
      <Box sx={{ ...card, px: 1.5, py: 1.25, flexShrink: 0 }}>
        <Box ref={heatBoxRef} sx={{ display: 'flex', gap: 1, minWidth: 0, overflowX: 'auto' }}>
          <Box
            sx={{
              pt: `${MONTH_ROW + 2}px`,
              display: 'flex',
              flexDirection: 'column',
              gap: `${HEAT_GAP}px`,
              flexShrink: 0
            }}
          >
            {WEEKDAY.map((day, index) => (
              <Typography
                key={day}
                sx={{
                  fontSize: 9,
                  color: t.textFaint,
                  height: heatCell,
                  lineHeight: `${heatCell}px`
                }}
              >
                {index % 2 === 0 && index < 5 ? i18n.t(day) : ''}
              </Typography>
            ))}
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: `repeat(${heat.weeks.length}, ${heatCell}px)`,
                columnGap: `${HEAT_GAP}px`,
                height: MONTH_ROW
              }}
            >
              {monthCols.map((item) => (
                <Typography
                  key={item.label}
                  sx={{
                    gridColumnStart: item.col + 1,
                    gridRow: 1,
                    fontSize: 9,
                    lineHeight: `${MONTH_ROW}px`,
                    // Month labels stay neutral on hover: only cells react, so the
                    // axis never competes with the activity colour.
                    fontWeight: item.current ? 600 : 400,
                    color: t.textFaint,
                    whiteSpace: 'nowrap'
                  }}
                >
                  {item.label}
                </Typography>
              ))}
            </Box>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: `repeat(${heat.weeks.length}, ${heatCell}px)`,
                gridTemplateRows: `repeat(7, ${heatCell}px)`,
                gridAutoFlow: 'column',
                columnGap: `${HEAT_GAP}px`,
                rowGap: `${HEAT_GAP}px`,
                mt: '2px'
              }}
            >
              {heat.weeks.flatMap((week, weekIndex) =>
                week.map((cell, dayIndex) => {
                  const level = heatLevel(cell.count, heat.max)
                  return (
                    <Box
                      key={`${weekIndex}-${dayIndex}`}
                      title={i18n.t('{{key}} · {{n}} 次', { key: cell.key, n: cell.count })}
                      data-heat-cell
                      data-heat-level={level}
                      sx={{
                        width: heatCell,
                        height: heatCell,
                        borderRadius: '3px',
                        bgcolor:
                          level === 0
                            ? 'rgba(127,127,127,.12)'
                            : `rgba(76,141,255,${0.25 + level * 0.19})`,
                        // Hover deepens what is already there: a used cell keeps its
                        // own blue and gets a few shades darker, an empty one just
                        // gains a bit more grey. Nothing jumps to a shared colour.
                        transition: 'filter .12s ease, background-color .12s ease',
                        '&:hover':
                          level === 0
                            ? { bgcolor: 'rgba(127,127,127,.26)', filter: 'brightness(.9)' }
                            : { filter: 'brightness(.74)' }
                      }}
                    />
                  )
                })
              )}
            </Box>
          </Box>
        </Box>
      </Box>

      <Box data-app-scenes sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0, minHeight: 22, flexShrink: 0 }}>
        <Tooltip title={i18n.t('按产生文字的记录统计 · 点击查看')}>
          <Typography data-app-share-hint tabIndex={0} sx={{ fontSize: 10.5, color: t.textDim, flexShrink: 0 }}>{i18n.t('热门场景')}</Typography>
        </Tooltip>
        <Box
          data-app-scene-list
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            flex: 1,
            minWidth: 0,
            flexWrap: 'wrap'
          }}
        >
          {insights.apps.length === 0 ? (
            <Typography
              sx={{
                fontSize: 10.5,
                color: t.textFaint,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {i18n.t('说几句话之后，这里会按 App 统计文字用在了哪里')}
            </Typography>
          ) : (
            insights.apps.slice(0, 5).map((app, index) => (
              <AppChip
                key={app.name}
                t={t}
                name={app.name}
                count={app.count}
                percent={appPercents[index] ?? 0}
                color={appColor(index)}
                onOpen={() => onOpenHistory(app.name)}
              />
            ))
          )}
        </Box>
        <Button data-app-share-open size="small" variant="text" aria-label={i18n.t('查看各 App 的调用占比')}
          title={i18n.t('各 App 的调用占比')} onClick={() => setAppShareOpen(true)}
          sx={{ flexShrink: 0, minWidth: 0, height: 22, py: 0, px: 0.9, gap: 0.5, fontSize: 10.5,
            lineHeight: '16px', color: t.textDim, border: `1px solid ${t.surfaceHi}`, borderRadius: '6px',
            '&:hover': { color: t.text, borderColor: t.textFaint, bgcolor: t.surfaceHi } }}>
          <IconChart size={11} />{i18n.t('分布')}
        </Button>
      </Box>

      {/* Portalled, so it is declared here and paints over the whole window. */}
      <AppShareDialog
        open={appShareOpen}
        onClose={() => setAppShareOpen(false)}
        t={t}
        apps={insights.apps}
        total={appTotal}
      />
    </Box>
  )
}

interface PillsProps {
  t: { surface: string; surfaceHi: string; text: string; textDim: string; line: string }
  items: Array<{ id: string; label: string }>
  value: string
  onChange: (id: string) => void
}

function Pills({ t, items, value, onChange }: PillsProps): JSX.Element {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      {items.map((item) => {
        const active = item.id === value
        return (
          <Box
            component="button" type="button" aria-pressed={active}
            key={item.id}
            onClick={() => onChange(item.id)}
            sx={{
              border: 0, fontFamily: 'inherit', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' },
              px: 1.1,
              height: 24,
              display: 'grid',
              placeItems: 'center',
              borderRadius: '99px',
              fontSize: 11.5,
              cursor: 'pointer',
              color: active ? t.text : t.textDim,
              bgcolor: active ? t.surfaceHi : 'transparent',
              transition: 'background-color .15s ease'
            }}
          >
            {item.label}
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * One app of the 热门场景 row: colour dot, label, record count, its share, and a
 * link to it. The dot is the app's segment colour in the breakdown dialog, so
 * the row and the ring are readable against each other.
 */
function AppChip({
  t,
  name,
  count,
  percent,
  color,
  onOpen
}: {
  t: { surfaceHi: string; text: string; textDim: string; textFaint: string }
  name: string
  count: number
  /** Already-rounded share, shared with the breakdown dialog's legend. */
  percent: number
  color: string
  onOpen: () => void
}): JSX.Element {
  return (
    <ButtonBase
      data-app-scene={name}
      title={i18n.t('{{name}} · {{n}} 次 · {{pct}}%', { name, n: count, pct: percent })}
      aria-label={i18n.t('查看 {{name}} 的记录', { name })}
      onClick={onOpen}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.6,
        px: 0.9,
        height: 22,
        borderRadius: '6px',
        border: `1px solid ${t.surfaceHi}`,
        maxWidth: 200,
        minWidth: 0,
        flexShrink: 1,
        cursor: 'pointer',
        transition: 'border-color .12s ease, background-color .12s ease',
        '&:hover': { borderColor: t.textFaint, backgroundColor: t.surfaceHi }
      }}
    >
      <Box
        sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: color, flexShrink: 0 }}
      />
      <Typography
        sx={{
          fontSize: 11,
          color: t.text,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {name}
      </Typography>
      <Typography
        sx={{ fontSize: 10.5, color: t.textFaint, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
      >
        {i18n.t('{{n}} 次 · {{pct}}%', { n: group(count), pct: percent })}
      </Typography>
    </ButtonBase>
  )
}
