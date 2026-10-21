import { describe, expect, it } from 'vitest'
import type { UsageInsights } from './insights'
import {
  SHARE_HEAT_DAYS,
  SHARE_HEIGHT,
  SHARE_WIDTH,
  buildShareCard,
  shareCardFileName
} from './shareCard'

const NOW = new Date('2026-03-08T10:30:00Z').getTime()

function insights(patch: Partial<UsageInsights> = {}): UsageInsights {
  return {
    total: 42,
    records: 40,
    measured: 38,
    units: 4321,
    chars: 5123,
    spokenMs: 3_720_000,
    wpm: 96.4,
    savedMs: 2_040_000,
    typingWpm: 40,
    apps: [
      { name: 'Code.exe', count: 12, share: 0.3 },
      { name: 'WeChat', count: 8, share: 0.2 },
      { name: 'Chrome', count: 5, share: 0.125 },
      { name: 'Slack', count: 2, share: 0.05 }
    ],
    streak: { current: 6, longest: 11, todayActive: true, activeDays: 30, lastActiveAt: NOW },
    ...patch
  }
}

describe('buildShareCard', () => {
  it('is the 4:5 size X and LinkedIn accept without cropping', () => {
    const card = buildShareCard(insights(), { now: NOW })
    expect(card.width).toBe(SHARE_WIDTH)
    expect(card.height).toBe(SHARE_HEIGHT)
    expect(SHARE_WIDTH / SHARE_HEIGHT).toBeCloseTo(0.8, 5)
  })

  it('formats the four figures with grouped digits and human durations', () => {
    const card = buildShareCard(insights(), { now: NOW })
    expect(card.stats[0]?.value).toBe('4,321')
    expect(card.stats[0]?.hint).toContain('1 小时 2 分')
    expect(card.stats[1]?.value).toBe('96')
    expect(card.stats[2]?.value).toBe('34 分钟')
    expect(card.stats[2]?.hint).toContain('40 字/分')
    expect(card.stats[3]?.value).toBe('6')
    expect(card.stats[3]?.hint).toContain('最长 11 天')
  })

  it('keeps at most three apps and renders them as one line', () => {
    const card = buildShareCard(insights(), { now: NOW })
    expect(card.apps).toEqual(['Code.exe 12 次', 'WeChat 8 次', 'Chrome 5 次'])
  })

  it('says it has nothing to show instead of printing zeros', () => {
    const card = buildShareCard(
      insights({ records: 0, units: 0, wpm: 0, savedMs: 0, apps: [], streak: { ...insights().streak, current: 0 } }),
      { now: NOW }
    )
    expect(card.empty).toBe(true)
    expect(card.stats.map((stat) => stat.value)).toEqual(['—', '—', '—', '—'])
    expect(card.subtitle).not.toContain('已连续')
    expect(card.apps).toEqual([])
  })

  it('right-aligns a short heat series so the newest day keeps the last column', () => {
    const card = buildShareCard(insights(), { now: NOW, heat: [1, 2, 3] })
    expect(card.heat).toHaveLength(SHARE_HEAT_DAYS)
    expect(card.heat.slice(-3)).toEqual([1, 2, 3])
    expect(card.heat[0]).toBe(0)
  })

  it('drops heat days older than a year, keeping the newest window', () => {
    const long = Array.from({ length: SHARE_HEAT_DAYS + 10 }, (_unused, index) => index % 5)
    const card = buildShareCard(insights(), { now: NOW, heat: long })
    expect(card.heat).toHaveLength(SHARE_HEAT_DAYS)
    expect(card.heat[card.heat.length - 1]).toBe(long[long.length - 1])
  })

  it('keeps a five-step legend so a shared cell can be read', () => {
    const card = buildShareCard(insights(), { now: NOW })
    expect(card.legend.match(/▢/g)).toHaveLength(5)
  })
})

describe('shareCardFileName', () => {
  it('never contains a colon and ends in .png', () => {
    const name = shareCardFileName(NOW)
    expect(name).toMatch(/^typeless-insights-\d{4}-\d{2}-\d{2}\.png$/)
    expect(name).not.toContain(':')
  })

  it('uses the local calendar day, zero padded', () => {
    expect(shareCardFileName(new Date(2026, 0, 5, 9, 0, 0).getTime())).toBe(
      'typeless-insights-2026-01-05.png'
    )
  })
})
