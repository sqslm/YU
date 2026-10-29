import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '@shared/types'
import { speakingWpm, timeSavedMs } from '@shared/count'
import { statsFromEntries } from '@shared/stats'
import {
  durationLabel,
  insightsFromStats,
  group,
  savedLabel,
  streakHint,
  usageInsights,
  wpmLabel
} from './insights'

let seq = 0
function item(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  seq += 1
  return {
    id: `insight-${seq}`,
    createdAt: new Date(2026, 9, 19, 9, 0).getTime(),
    mode: 'dictation',
    // These dictation fixtures represent unchanged ASR output unless explicitly overridden.
    transcript: overrides.final ?? '',
    final: '',
    durationMs: 0,
    app: 'Notepad',
    ...overrides
  }
}

/** 2026-10-19 12:00 local — the same "today" the overview tests use. */
const NOON = new Date(2026, 9, 19, 12, 0, 0).getTime()

describe('usageInsights: cumulative totals', () => {
  it('adds CJK characters and latin words into one "字" figure', () => {
    const out = usageInsights(
      [
        item({ final: '你好世界', durationMs: 3000 }),
        item({ final: 'hello world', durationMs: 4000 })
      ],
      { now: NOON }
    )
    // 4 CJK characters + 2 words.
    expect(out.units).toBe(6)
    // Code points of the raw text, for the "字符" reading.
    expect(out.chars).toBe('你好世界hello world'.length)
    expect(out.spokenMs).toBe(7000)
    expect(out.records).toBe(2)
  })

  it('skips failed and empty takes but keeps pre-status entries', () => {
    const out = usageInsights(
      [
        item({ final: '错误', durationMs: 2000, status: 'error' }),
        item({ final: '空', durationMs: 5000, status: 'empty' }),
        item({ final: '一', durationMs: 2000, status: 'completed' }),
        item({ final: '二', durationMs: 2000 }) // written before `status` existed
      ],
      { now: NOON }
    )
    expect(out.total).toBe(4)
    expect(out.records).toBe(2)
    expect(out.units).toBe(2)
    expect(out.spokenMs).toBe(4000)
    expect(out.measured).toBe(2)
  })

  it('falls back to the transcript when the cleanup step produced no final text', () => {
    const out = usageInsights([item({ final: '', transcript: '你好', durationMs: 2000 })], {
      now: NOON
    })
    expect(out.units).toBe(2)
    expect(out.measured).toBe(1)
  })

  it('does not let an abandoned take inflate the cumulative duration', () => {
    // ESC stores the take as `dismissed` with empty text; its 30 s of recording
    // would otherwise read as 30 s of dictation that produced nothing.
    const out = usageInsights(
      [
        item({ final: '', durationMs: 30_000, status: 'dismissed' }),
        item({ final: '你好', durationMs: 2000 })
      ],
      { now: NOON }
    )
    expect(out.spokenMs).toBe(2000)
    expect(out.units).toBe(2)
    expect(out.records).toBe(1)
  })
})

describe('usageInsights: speaking rate', () => {
  it('does not infer ASR speed from generated output or an old aggregate', () => {
    const row = item({ mode: 'ask', transcript: '总结新闻', final: '新闻'.repeat(500), durationMs: 4000 })
    expect(usageInsights([row]).wpm).toBe(60)
    expect(usageInsights([item({ final: '很长的模型回答', transcript: '', durationMs: 1000 })]).wpm).toBe(0)
    const legacy = statsFromEntries([row])
    delete Object.values(legacy.days)[0].inputUnits
    delete Object.values(legacy.days)[0].inputMs
    expect(insightsFromStats(legacy).wpm).toBe(0)
  })
  it('weights by total units over total duration, not by averaging per-entry rates', () => {
    const out = usageInsights(
      [
        // 4 units in 2s → 120 wpm.
        item({ final: '你好世界', durationMs: 2000 }),
        // 200 units in 60s → 200 wpm.
        item({ final: '一'.repeat(200), durationMs: 60_000 })
      ],
      { now: NOON }
    )
    // The per-entry mean would be (120 + 200) / 2 = 160; the weighted rate is
    // 204 units / 62 s ≈ 197, because the long take carries the volume.
    expect(out.wpm).toBe(speakingWpm(204, 62_000))
    expect(out.wpm).toBe(197)
    expect(out.wpm).not.toBe(160)
  })

  it('leaves takes shorter than a second out of the rate and the sample count', () => {
    const out = usageInsights(
      [
        item({ final: '一二三四五六七八九十', durationMs: 500 }),
        item({ final: '', transcript: '', durationMs: 4000 })
      ],
      { now: NOON }
    )
    expect(out.measured).toBe(0)
    expect(out.wpm).toBe(0)
    // The words were still dictated even though the take is too short to rate.
    expect(out.units).toBe(10)
    // A take that returned no text adds no duration either: the cumulative
    // 字数/时长 pair has to describe the same population.
    expect(out.spokenMs).toBe(500)
    expect(out.records).toBe(1)
  })

  it('never produces NaN when fields are missing or non-finite', () => {
    const out = usageInsights(
      [
        item({ final: '', transcript: '', durationMs: Number.NaN }),
        item({ final: '一', durationMs: Number.POSITIVE_INFINITY })
      ],
      { now: NOON }
    )
    expect(out.units).toBe(1)
    expect(out.spokenMs).toBe(0)
    expect(out.wpm).toBe(speakingWpm(1, 0))
    expect(Number.isNaN(out.wpm)).toBe(false)
    expect(Number.isNaN(out.savedMs)).toBe(false)
    expect(Number.isNaN(out.streak.current)).toBe(false)
  })

  it('reports zeros for an empty history', () => {
    const out = usageInsights([], { now: NOON })
    expect(out).toMatchObject({
      total: 0,
      records: 0,
      measured: 0,
      units: 0,
      chars: 0,
      spokenMs: 0,
      wpm: 0,
      savedMs: 0,
      typingWpm: 40
    })
    expect(out.apps).toEqual([])
    expect(out.streak).toEqual({
      current: 0,
      longest: 0,
      todayActive: false,
      activeDays: 0,
      lastActiveAt: null
    })
  })
})

describe('usageInsights: time saved', () => {
  it('sums the per-take saving over the measured sample', () => {
    const items = [
      item({ final: '一'.repeat(100), durationMs: 30_000 }),
      item({ final: '二'.repeat(50), durationMs: 20_000 })
    ]
    const out = usageInsights(items, { now: NOON })
    expect(out.savedMs).toBe(timeSavedMs(100, 30_000) + timeSavedMs(50, 20_000))
    // 150 s of typing − 50 s of speaking.
    expect(out.savedMs).toBe(175_000)
  })

  it('saves more when the same text takes less time to say', () => {
    const text = '一'.repeat(80)
    const quick = usageInsights([item({ final: text, durationMs: 20_000 })], { now: NOON })
    const slow = usageInsights([item({ final: text, durationMs: 40_000 })], { now: NOON })
    expect(quick.savedMs).toBeGreaterThan(slow.savedMs)
  })

  it('saves more as the dictation gets longer at the same speaking rate', () => {
    // 150 units per minute — faster than typing, so length pays off.
    const short = usageInsights([item({ final: '一'.repeat(150), durationMs: 60_000 })], {
      now: NOON
    })
    const long = usageInsights([item({ final: '一'.repeat(300), durationMs: 120_000 })], {
      now: NOON
    })
    expect(short.savedMs).toBeGreaterThan(0)
    expect(long.savedMs).toBeGreaterThan(short.savedMs)
  })

  it('clamps to zero instead of reporting a negative saving', () => {
    // Two characters spoken over two minutes: typing would have been faster.
    const out = usageInsights([item({ final: '一二', durationMs: 120_000 })], { now: NOON })
    expect(out.savedMs).toBe(0)
  })

  it('honours a custom typing speed', () => {
    const slowTypist = usageInsights([item({ final: '一'.repeat(40), durationMs: 60_000 })], {
      now: NOON,
      typingWpm: 20
    })
    expect(slowTypist.savedMs).toBe(60_000) // 2 min of typing − 1 min of speech
    expect(slowTypist.typingWpm).toBe(20)
  })
})

describe('usageInsights: app breakdown', () => {
  it('ranks apps by record count, strips .exe and caps the list', () => {
    const out = usageInsights(
      [
        item({ app: 'Code.exe', final: '一' }),
        item({ app: 'Code', final: '一' }),
        item({ app: '钉钉', final: '一' }),
        item({ app: '   ', final: '一' }),
        item({ app: 'Chrome', final: '一' })
      ],
      { now: NOON, topApps: 2 }
    )
    expect(out.apps).toHaveLength(2)
    expect(out.apps[0]).toMatchObject({ name: 'Code', count: 2 })
    expect(out.apps[0].share).toBeCloseTo(0.5)
    expect(out.apps.map((app) => app.name)).not.toContain('')
  })

  it('takes the app name out of a window title and drops language labels', () => {
    const out = usageInsights(
      [
        item({ app: '与 Typeless 的差距 — DeepSeek Harness', final: '一' }),
        item({ app: '中文', final: '一' }),
        item({ app: 'English', final: '一' })
      ],
      { now: NOON }
    )
    expect(out.apps.map((app) => app.name)).toEqual(['DeepSeek Harness'])
  })

  it('does not count a take that produced no text as a scene', () => {
    const out = usageInsights([item({ app: 'Chrome', status: 'empty' })], { now: NOON })
    expect(out.apps).toEqual([])
  })

  it('breaks ties alphabetically so the row does not jump between renders', () => {
    const out = usageInsights(
      [item({ app: 'Zeta', final: '一' }), item({ app: 'Alpha', final: '一' })],
      { now: NOON }
    )
    expect(out.apps.map((app) => app.name)).toEqual(['Alpha', 'Zeta'])
  })
})

describe('usageInsights: streak wiring', () => {
  it('shows the current and the longest run from the same history', () => {
    const at = (day: number): number => new Date(2026, 9, day, 9, 0).getTime()
    const out = usageInsights(
      [
        item({ createdAt: at(19), final: '一', durationMs: 2000 }),
        item({ createdAt: at(18), final: '二', durationMs: 2000 }),
        item({ createdAt: at(15), final: '三', durationMs: 2000 }),
        item({ createdAt: at(14), final: '四', durationMs: 2000 }),
        item({ createdAt: at(13), final: '五', durationMs: 2000 })
      ],
      { now: NOON }
    )
    expect(out.streak.current).toBe(2)
    expect(out.streak.longest).toBe(3)
    expect(out.streak.todayActive).toBe(true)
  })
})

describe('insight formatting', () => {
  it('groups thousands', () => {
    expect(group(0)).toBe('0')
    expect(group(999)).toBe('999')
    expect(group(1234)).toBe('1,234')
    expect(group(1_234_567)).toBe('1,234,567')
    expect(group(Number.NaN)).toBe('0')
  })

  it('labels cumulative durations and never says NaN', () => {
    expect(durationLabel(0)).toBe('—')
    expect(durationLabel(Number.NaN)).toBe('—')
    expect(durationLabel(45_000)).toBe('45 秒')
    expect(durationLabel(60_000)).toBe('1 分钟')
    expect(durationLabel(3_900_000)).toBe('1 小时 5 分')
    expect(durationLabel(3_600_000)).toBe('1 小时')
  })

  it('splits the saved time into value + unit for the stat card', () => {
    expect(savedLabel(0)).toEqual({ value: '—', unit: '分钟' })
    expect(savedLabel(30_000)).toEqual({ value: '30', unit: '秒' })
    expect(savedLabel(18 * 60_000)).toEqual({ value: '18', unit: '分钟' })
    expect(savedLabel(10 * 3_600_000)).toEqual({ value: '10.0', unit: '小时' })
  })

  it('renders the rate as a grouped number or an em dash', () => {
    expect(wpmLabel(0)).toBe('—')
    expect(wpmLabel(Number.NaN)).toBe('—')
    expect(wpmLabel(197)).toBe('197')
    expect(wpmLabel(1234)).toBe('1,234')
  })

  it('explains the streak for each state', () => {
    const base = { current: 0, longest: 0, todayActive: false, activeDays: 0, lastActiveAt: null }
    expect(streakHint(base)).toContain('还没有记录')
    expect(streakHint({ ...base, current: 3, todayActive: true })).toContain('今天已经口述过')
    expect(streakHint({ ...base, current: 3 })).toContain('说一句就能续上')
    expect(streakHint({ ...base, lastActiveAt: new Date(2026, 9, 15, 9, 0).getTime() })).toContain(
      '上次口述是 10 月 15 日'
    )
  })
})

describe('insights read from the lifetime rollup', () => {
  const rows = [
    item({ final: '你好世界', durationMs: 3000, app: '与 Typeless 的差距 — DeepSeek Harness' }),
    item({ final: 'hello world', durationMs: 5000, app: 'Slack' }),
    item({ final: '', durationMs: 4000, status: 'error', app: 'Slack' })
  ]

  it('matches the figures computed from the rows', () => {
    const fromRows = usageInsights(rows, { now: NOON })
    const fromStats = insightsFromStats(statsFromEntries(rows), { now: NOON })

    expect({ ...fromStats, total: rows.length }).toEqual(fromRows)
  })

  it('survives the rows being deleted', () => {
    const stats = statsFromEntries(rows)
    const out = insightsFromStats(stats, { now: NOON })

    expect(out.records).toBe(2)
    expect(out.units).toBe(6)
    expect(out.spokenMs).toBe(8000)
    expect(out.apps.map((app) => app.name)).toEqual(['DeepSeek Harness', 'Slack'])
    expect(out.streak.current).toBe(1)
  })
})
