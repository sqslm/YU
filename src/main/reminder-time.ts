import { en, zh } from 'chrono-node'
import type { ReminderRecurrence } from '@shared/reminders'
import { mt } from '@shared/mainI18n'

export function nextOccurrence(rule: ReminderRecurrence, after: number): number {
  const base = new Date(after)
  for (let offset = 0; offset <= 14; offset++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, rule.hour, rule.minute, 0, 0)
    // Skip a nonexistent local wall time during a daylight-saving transition.
    if (d.getHours() !== rule.hour || d.getMinutes() !== rule.minute) continue
    if (d.getTime() > after && (rule.frequency === 'daily' || rule.weekdays?.includes(d.getDay()))) return d.getTime()
  }
  throw new Error(mt('无法计算下一次提醒时间'))
}

export function validRecurrence(value: unknown): value is ReminderRecurrence {
  if (!value || typeof value !== 'object') return false
  const r = value as ReminderRecurrence
  return ['daily', 'weekly'].includes(r.frequency) && Number.isInteger(r.hour) && r.hour >= 0 && r.hour < 24 &&
    Number.isInteger(r.minute) && r.minute >= 0 && r.minute < 60 && (r.frequency === 'daily' ||
      Array.isArray(r.weekdays) && r.weekdays.length > 0 && r.weekdays.length <= 7 && r.weekdays.every(d => Number.isInteger(d) && d >= 0 && d <= 6))
}

/** Normalize spoken quantities before Chrono resolves the local date/time. */
function normalizeTimeExpression(text: string): string {
  // Chrono can match only the trailing "half hour" and silently lose the
  // preceding whole hour. Normalize these spoken quantities before parsing.
  text = text.replace(/(?:一|1)[个個]?半(?:小时|小時|钟头|鐘頭)/g, match => /[個時鐘]/.test(match) ? '90分鐘' : '90分钟')
    .replace(/(?:一|1)刻(?:钟|鐘)?/g, match => match.includes('鐘') ? '15分鐘' : '15分钟')
    .replace(/^(?:再)?[过過](.+(?:分钟|分鐘|小时|小時|钟头|鐘頭))$/, (match, value: string) => value + (match.includes('過') ? '後' : '后'))
    .replace(/\b(?:one|an?|1) (?:and a half hours?|hours? and a half)\b/gi, '90 minutes')
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
    'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
  const values: Record<string, number> = Object.fromEntries(words.map((word, n) => [word, n]))
  Object.assign(values, { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 })
  const number = `(?:${Object.keys(values).join('|')}|hundred|and)`
  const relative = text.replace(new RegExp(`\\b(${number}(?:[ -]+${number})*)\\s+(?=minutes?\\b|hours?\\b|days?\\b|weeks?\\b)`, 'gi'), (_match, phrase: string) => {
    let value = 0
    for (const word of phrase.toLowerCase().split(/[ -]+/)) {
      if (word === 'hundred') value = (value || 1) * 100
      else value += values[word] ?? 0
    }
    return `${value} `
  })
  const hours = words.slice(1, 13).join('|')
  return relative.replace(new RegExp(`\\b(${hours})(?:[ -]+(fifteen|thirty|forty[ -]five))?\\s*(a\\.?m\\.?|p\\.?m\\.?)\\b`, 'gi'), (_match, hour: string, minute: string | undefined, period: string) =>
    `${values[hour.toLowerCase()]}:${minute ? /fifteen/i.test(minute) ? '15' : /thirty/i.test(minute) ? '30' : '45' : '00'} ${period.replace(/\./g, '')}`)
}

export function resolveReminderTime(expression: string | null, now: number): {
  dueAt: number | null; recurrence: ReminderRecurrence | null; issue?: string
} {
  const uncertain = (issue: string): ReturnType<typeof resolveReminderTime> => ({ dueAt: null, recurrence: null, issue: mt(issue) })
  if (!expression?.trim()) return uncertain('请补充具体提醒时间')
  const text = normalizeTimeExpression(expression.trim())
  if ((/每|\b(?:every|daily|weekly)\b/i.test(text) && /持续|持續|直到|截止|截至|总共|總共|\b(?:until|through|for)\b/i.test(text)) ||
    /每(?:周|週|星期)(?:[一二三四五六日天1-7][、,，和及\s]*){2,}/.test(text) ||
    (/\b(?:every|weekly)\b/i.test(text) && (text.match(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi)?.length ?? 0) > 1)) return uncertain('暂不支持此重复规则，请手动确认')
  if (/之前|左右|大概|有空|某天|尽快|晚点|过几|下次|\b(?:before|by|around|about|sometime|soon|later on|approximately|CST|IST)\b/i.test(text)) return uncertain('时间不够精确，请选择日期和时间')
  if (/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(text)) {
    const numeric = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/)!
    if (Number(numeric[1]) <= 12 && Number(numeric[2]) <= 12) return uncertain('数字日期有歧义，请明确月份与日期')
  }
  const parser = /[\u4e00-\u9fff]/.test(text) ? /[後週時鐘號兩]/.test(text) ? zh.hant : zh.hans : en
  const results = parser.parse(text, new Date(now), { forwardDate: true })
  if (results.length !== 1 || results[0]!.end) return uncertain('没有识别到唯一、明确的提醒时间')
  const start = results[0]!.start
  if (!start.isCertain('hour')) return uncertain('请补充具体时刻，例如上午 10 点')
  const relative = /(?:后|後)\s*$|\bin\s+.+(?:minutes?|hours?|days?|weeks?)\b|\b(?:from now|later)\s*$/i.test(text)
  const hour = start.get('hour')!, minute = start.get('minute') ?? 0
  const clock24 = /\b\d{1,2}[:：]\d{2}\b/.test(text)
  const daypart = /凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|今晚|\b(?:a\.?m\.?|p\.?m\.?|noon|midnight|morning|afternoon|evening|night)\b/i.test(text)
  if (!relative && hour > 0 && hour <= 12 && !daypart && !clock24) return uncertain('请明确上午或下午')
  const daily = /每(?:天|日)|\bevery\s+day\b|\bdaily\b/i.test(text)
  const weekly = /每(?:周|週|星期)|\bevery\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\bweekly\b/i.test(text)
  if (!daily && !weekly && /每|\b(?:every|each|monthly|yearly)\b/i.test(text)) return uncertain('目前支持每天或每周指定星期，请确认重复规则')
  if (daily || weekly) {
    const weekday = start.get('weekday')
    if (weekly && weekday === null) return uncertain('请选择每周的星期')
    const recurrence: ReminderRecurrence = { frequency: weekly ? 'weekly' : 'daily', hour, minute,
      ...(weekly ? { weekdays: [weekday!] } : {}) }
    return { dueAt: nextOccurrence(recurrence, now), recurrence }
  }
  if (!relative && !start.isCertain('day') && !start.isCertain('weekday')) return uncertain('请补充具体日期')
  const dueAt = start.date().getTime()
  if (!relative && !start.isCertain('timezoneOffset') && (new Date(dueAt).getHours() !== hour || new Date(dueAt).getMinutes() !== minute)) {
    return uncertain('本地时刻因夏令时不存在，请选择其他时间')
  }
  if (!Number.isFinite(dueAt) || dueAt <= now) return uncertain('这个时间已经过去，请确认新的时间')
  return { dueAt, recurrence: null }
}
