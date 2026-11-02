import type { QuotaMetric } from '@shared/quota'

export interface AmountLabel {
  /** Currency mark, or a unit word for non-money credits. */
  symbol: string
  /** Compact figure that fits inside a ring: `7.62`, `1.2k`, `8.4万`. */
  figure: string
  /** Full amount for tooltips and screen readers: `¥7.62`. */
  spoken: string
}

const money = (unit: string): string | undefined => unit === 'CNY' ? '¥' : unit === 'USD' ? '$' : undefined

/**
 * Turns a balance-only metric into something a 28–36 px ring can carry.
 *
 * These providers have no ceiling, so the ring cannot fill by a ratio; it shows the
 * balance instead. Four digits would overflow the ring, so anything past a thousand
 * is compacted with the locale's own notation (1.2k / 1.2万).
 */
export function amountLabel(metric: QuotaMetric, language: string): AmountLabel {
  const value = metric.remaining ?? metric.used ?? 0
  const compact = Math.abs(value) >= 1000
  const figure = new Intl.NumberFormat(language, compact
    ? { notation: 'compact', maximumFractionDigits: 1 }
    : { maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(value)
  const mark = money(metric.unit)
  return {
    symbol: mark ?? (metric.unit === 'characters' ? '字' : ''),
    figure,
    spoken: mark ? `${mark}${figure}` : `${figure}${metric.unit === 'characters' ? ' 字' : ` ${metric.unit}`}`
  }
}
