/**
 * Share-artefact for the usage insights (REQ-07 / ACC-08 step 5).
 *
 * The layout is a pure data model so the numbers, the copy and the heat grid can
 * be asserted without a canvas: jsdom has no 2D context, and a renderer test that
 * mocked `drawImage` would prove nothing about what the user actually shares.
 * `drawShareCard` is the only part that touches pixels.
 *
 * Card is 1080×1350 (4:5), the size X and LinkedIn both accept without cropping.
 */
import type { UsageInsights } from './insights'
import i18n from '../../i18n'

export const SHARE_WIDTH = 1080
export const SHARE_HEIGHT = 1350

/** Days drawn in the heat grid: 52 weeks, Monday first, same as the hub. */
export const SHARE_HEAT_DAYS = 364

export interface ShareCardStat {
  label: string
  value: string
  hint: string
}

export interface ShareCardModel {
  width: number
  height: number
  title: string
  subtitle: string
  stats: ShareCardStat[]
  apps: string[]
  /** One `heatLevel` per day, oldest first. */
  heat: number[]
  legend: string
  footer: string
  /** True when there is nothing to report; the card says so instead of "0". */
  empty: boolean
}

export interface ShareCardOptions {
  /** `heatLevel` per day from the hub's `heatWeeks`, oldest first. */
  heat?: readonly number[]
  /** Clock injection so the subtitle is testable. */
  now?: number
}

function group(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

function durationLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return i18n.t('{{n}} 秒', { n: total })
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return i18n.t('{{m}} 分 {{s}} 秒', { m: minutes, s: total % 60 })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return i18n.t('{{h}} 小时 {{m}} 分', { h: hours, m: minutes % 60 })
  return i18n.t('{{d}} 天 {{h}} 小时', { d: Math.floor(hours / 24), h: hours % 24 })
}

function savedLabel(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return i18n.t('{{n}} 分钟', { n: minutes })
  const hours = minutes / 60
  if (hours < 24) return i18n.t('{{n}} 小时', { n: hours.toFixed(1) })
  return i18n.t('{{n}} 天', { n: (hours / 24).toFixed(1) })
}

function dateLabel(now: number): string {
  const date = new Date(now)
  return i18n.t('{{y}} 年 {{m}} 月 {{d}} 日', {
    y: date.getFullYear(),
    m: date.getMonth() + 1,
    d: date.getDate()
  })
}

/**
 * Turns the insights into the exact strings that end up on the image.
 *
 * Every figure is either a real number or an em dash: a shared card claiming
 * "0 字" reads like a bug, so an empty account gets its own sentence instead.
 */
export function buildShareCard(
  insights: UsageInsights,
  options: ShareCardOptions = {}
): ShareCardModel {
  const now = options.now ?? Date.now()
  // Right-aligned: the newest day must sit in the last column, so a short history
  // pads the left edge with empty cells instead of shifting the whole grid.
  const source = options.heat ?? []
  const window = source.length > SHARE_HEAT_DAYS ? source.slice(-SHARE_HEAT_DAYS) : source
  const offset = SHARE_HEAT_DAYS - window.length
  const heat = Array.from({ length: SHARE_HEAT_DAYS }, (_unused, index) => {
    const value = window[index - offset]
    return typeof value === 'number' ? value : 0
  })
  const empty = insights.records === 0
  const dash = '—'

  return {
    width: SHARE_WIDTH,
    height: SHARE_HEIGHT,
    title: i18n.t('我的口述统计'),
    subtitle: empty
      ? dateLabel(now)
      : i18n.t('{{date}} · 已连续 {{n}} 天', { date: dateLabel(now), n: insights.streak.current }),
    stats: [
      {
        label: i18n.t('累计口述字数'),
        value: empty ? dash : group(insights.units),
        hint: empty
          ? i18n.t('还没有记录')
          : i18n.t('累计口述 {{span}}', { span: durationLabel(insights.spokenMs) })
      },
      {
        label: i18n.t('平均语速'),
        value: empty ? dash : `${Math.round(insights.wpm)}`,
        hint: i18n.t('字 / 分钟')
      },
      {
        label: i18n.t('节省时间'),
        value: empty ? dash : savedLabel(insights.savedMs),
        hint: i18n.t('相比键盘打字 {{n}} 字/分', { n: insights.typingWpm })
      },
      {
        label: i18n.t('连续天数'),
        value: empty ? dash : String(insights.streak.current),
        hint: empty
          ? i18n.t('还没有记录')
          : i18n.t('天 · 最长 {{n}} 天', { n: insights.streak.longest })
      }
    ],
    apps: insights.apps
      .slice(0, 3)
      .map((app) => i18n.t('{{name}} {{n}} 次', { name: app.name, n: app.count })),
    heat,
    legend: i18n.t('少 ▢▢▢▢▢ 多'),
    footer: i18n.t('轻令（Qinly） · 全部统计只在本机'),
    empty
  }
}

/** Stable, colon-free file name so Windows never rejects the save. */
export function shareCardFileName(now: number): string {
  const date = new Date(now)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `typeless-insights-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.png`
}

export interface SharePalette {
  canvas: string
  surface: string
  text: string
  textDim: string
  textFaint: string
  accent: string
  line: string
}

const HEAT_COLORS = (accent: string, level: number): string =>
  level <= 0 ? 'rgba(127,127,127,.16)' : `rgba(${hexToRgb(accent)},${0.25 + level * 0.19})`

function hexToRgb(hex: string): string {
  const clean = hex.replace('#', '')
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((part) => part + part)
          .join('')
      : clean
  const value = Number.parseInt(full.slice(0, 6), 16)
  return `${(value >> 16) & 255},${(value >> 8) & 255},${value & 255}`
}

/**
 * Paints the model. Kept deliberately dumb: no layout math that a test would have
 * to re-derive, so the model above stays the single source of truth.
 */
export function drawShareCard(
  ctx: CanvasRenderingContext2D,
  model: ShareCardModel,
  palette: SharePalette
): void {
  const { width, height } = model
  ctx.save()
  ctx.fillStyle = palette.surface
  ctx.fillRect(0, 0, width, height)

  const pad = 72
  ctx.textBaseline = 'top'

  ctx.fillStyle = palette.text
  ctx.font = '600 56px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
  ctx.fillText(model.title, pad, 88)

  ctx.fillStyle = palette.textDim
  ctx.font = '400 26px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
  ctx.fillText(model.subtitle, pad, 164)

  // 2×2 stat grid.
  const cellWidth = (width - pad * 2) / 2
  model.stats.forEach((stat, index) => {
    const x = pad + (index % 2) * cellWidth
    const y = 248 + Math.floor(index / 2) * 190
    ctx.fillStyle = palette.textFaint
    ctx.font = '400 24px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
    ctx.fillText(stat.label, x, y)
    ctx.fillStyle = palette.text
    ctx.font = '600 72px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
    ctx.fillText(stat.value, x, y + 36)
    ctx.fillStyle = palette.textDim
    ctx.font = '400 22px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
    ctx.fillText(stat.hint, x, y + 122)
  })

  // Heat grid: 52 columns × 7 rows, 12px cells with 4px gaps.
  const gridTop = 700
  const cell = 12
  const gap = 4
  ctx.fillStyle = palette.textFaint
  ctx.font = '400 22px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
  ctx.fillText(i18n.t('年度活动'), pad, gridTop - 46)
  model.heat.forEach((level, index) => {
    const column = Math.floor(index / 7)
    const row = index % 7
    ctx.fillStyle = HEAT_COLORS(palette.accent, level)
    ctx.fillRect(pad + column * (cell + gap), gridTop + row * (cell + gap), cell, cell)
  })

  let footerY = gridTop + 7 * (cell + gap) + 56
  if (model.apps.length > 0) {
    ctx.fillStyle = palette.textDim
    ctx.font = '400 24px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
    ctx.fillText(i18n.t('常用场景：{{list}}', { list: model.apps.join(' · ') }), pad, footerY)
    footerY += 46
  }

  ctx.strokeStyle = palette.line
  ctx.beginPath()
  ctx.moveTo(pad, height - 118)
  ctx.lineTo(width - pad, height - 118)
  ctx.stroke()

  ctx.fillStyle = palette.textFaint
  ctx.font = '400 22px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
  ctx.fillText(model.footer, pad, height - 92)
  ctx.restore()
}
