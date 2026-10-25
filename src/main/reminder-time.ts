import { en, zh } from 'chrono-node'
import type { ReminderRecurrence } from '@shared/reminders'
import { mt } from '@shared/mainI18n'

export function nextOccurrence(rule: ReminderRecurrence, after: number, completed = 0): number | null {
  if (rule.count !== undefined && completed >= rule.count || rule.until !== undefined && after >= rule.until) return null
  const base = new Date(after)
  const anchor = new Date(rule.anchor ?? after), interval = rule.interval ?? 1
  const localDay = (d: Date): number => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000
  if(localDay(anchor)>localDay(base))base.setFullYear(anchor.getFullYear(),anchor.getMonth(),anchor.getDate())
  const accept = (d: Date): number | null => d.getTime() > after && (rule.until === undefined || +d <= rule.until) && d.getHours() === rule.hour && d.getMinutes() === rule.minute ? +d : null
  if (rule.frequency === 'monthly' || rule.frequency === 'yearly') {
    for (let offset = 0; offset <= interval * 8; offset++) {
      const year = rule.frequency === 'yearly' ? base.getFullYear() + offset : base.getFullYear()
      const month = rule.frequency === 'yearly' ? (rule.month ?? anchor.getMonth() + 1) - 1 : base.getMonth() + offset
      const first = new Date(year, month, 1)
      const periods = rule.frequency === 'yearly' ? first.getFullYear() - anchor.getFullYear() : (first.getFullYear() - anchor.getFullYear()) * 12 + first.getMonth() - anchor.getMonth()
      if (periods < 0 || periods % interval) continue
      const day = Math.min(rule.day ?? anchor.getDate(), new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate())
      const at = accept(new Date(first.getFullYear(), first.getMonth(), day, rule.hour, rule.minute))
      if (at !== null) return at
    }
    return null
  }
  for (let offset = 0; offset <= interval * 14; offset++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, rule.hour, rule.minute, 0, 0)
    // Skip a nonexistent local wall time during a daylight-saving transition.
    if (d.getHours() !== rule.hour || d.getMinutes() !== rule.minute) continue
    const days = localDay(d) - localDay(anchor)
    const periods = rule.frequency === 'daily' ? days : Math.floor((days + (anchor.getDay() + 6) % 7) / 7)
    if (periods >= 0 && periods % interval === 0 && (rule.frequency === 'daily' || rule.weekdays?.includes(d.getDay()))) {
      const at = accept(d)
      if (at !== null) return at
    }
  }
  return null
}

export function validRecurrence(value: unknown): value is ReminderRecurrence {
  if (!value || typeof value !== 'object') return false
  const r = value as ReminderRecurrence
  const integer = (v: unknown, min: number, max: number): boolean => Number.isInteger(v) && Number(v) >= min && Number(v) <= max
  return ['daily', 'weekly', 'monthly', 'yearly'].includes(r.frequency) && integer(r.hour, 0, 23) && integer(r.minute, 0, 59) &&
    (r.interval === undefined || integer(r.interval, 1, 100)) && (r.count === undefined || integer(r.count, 1, 10000)) &&
    (r.until === undefined || integer(r.until, 0, 8640000000000000)) && (r.anchor === undefined || integer(r.anchor, 0, 8640000000000000)) &&
    (r.frequency !== 'monthly' && r.frequency !== 'yearly' || integer(r.day, 1, 31)) && (r.frequency !== 'yearly' || integer(r.month, 1, 12) && r.day! <= new Date(2000,r.month!,0).getDate()) &&
    (r.frequency !== 'weekly' || Array.isArray(r.weekdays) && r.weekdays.length > 0 && r.weekdays.length <= 7 && r.weekdays.every(d => integer(d, 0, 6)))
}

/** Normalize spoken quantities before Chrono resolves the local date/time. */
function normalizeTimeExpression(text: string): string {
  text = text.replace(/\b(\d{1,2})([ap]m)\b/gi, '$1 $2')
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

/** Read only the weekday clause; the clock is still resolved by Chrono. */
function weeklyDays(text: string): { text: string; days?: number[] } {
  const chinese = /每(?:周|週|星期)\s*([一二三四五六日天1-7][一二三四五六日天1-7、,，和及到至\-–~～\s周星期]*)/.exec(text)
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const english = new RegExp(`\\b(?:every|each|weekly(?:\\s+on)?)\\s+((?:${names.join('|')})(?:\\s*(?:,\\s*(?:and\\s+)?|and|to|through|[-–])\\s*(?:${names.join('|')}))*)`, 'i').exec(text)
  const match = chinese || english
  if (!match) return { text }
  const tokens = [...match[1].matchAll(chinese ? /[一二三四五六日天1-7]/g : new RegExp(names.join('|'), 'gi'))]
  const days: number[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const day = chinese ? ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 } as Record<string, number>)[token[0]] ?? Number(token[0]) % 7
      : names.findIndex(name => name.toLowerCase() === token[0].toLowerCase())
    const previous = tokens[i - 1]
    const between = previous ? match[1].slice(previous.index! + previous[0].length, token.index) : ''
    if (previous && days.at(-1) !== day && /到|至|[-–~～]|\b(?:to|through)\b/i.test(between)) {
      for (let next = (days.at(-1)! + 1) % 7; next !== day; next = (next + 1) % 7) days.push(next)
    }
    days.push(day)
  }
  const unique = [...new Set(days)].sort((a, b) => a - b)
  return { text: text.replace(match[0], chinese ? `每${match[0].includes('週') ? '週' : '周'}${'日一二三四五六'[unique[0]]}` : `every ${names[unique[0]]}`), days: unique }
}

/**
 * Lenient parsing for a deadline, which is a target day rather than an alert
 * moment: "by Friday" is usable even though it names no clock.
 *
 * The strict resolver runs first because it also owns recurrence and the
 * daylight-saving checks. Only when it refuses do we fall back to the day Chrono
 * recognised and put the deadline at the local end of that day, so a spoken date
 * can never cost the user the whole reminder.
 */
export function resolveDeadline(expression: string | null, now: number): number | null {
  if (!expression?.trim()) return null
  const strict = resolveReminderTime(expression, now)
  if (!strict.issue && strict.dueAt !== null) return strict.dueAt
  const text = normalizeTimeExpression(expression.trim())
  const parser = /[\u4e00-\u9fff]/.test(text) ? /[後週時鐘號兩]/.test(text) ? zh.hant : zh.hans : en
  const results = parser.parse(text, new Date(now), { forwardDate: true })
  if (results.length !== 1 || results[0]!.end) return null
  const start = results[0]!.start
  // No day means no date to extend: "尽快" or "晚点" must stay refused instead of
  // silently becoming tonight's deadline.
  if (!start.isCertain('day') && !start.isCertain('weekday')) return null
  const day = start.date()
  // End of the local day, not UTC midnight, for the same DST reason as nextOccurrence.
  const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59, 999).getTime()
  return at > now ? at : null
}

export function resolveReminderTime(expression: string | null, now: number): {
  dueAt: number | null; recurrence: ReminderRecurrence | null; issue?: string
} {
  const uncertain = (issue: string): ReturnType<typeof resolveReminderTime> => ({ dueAt: null, recurrence: null, issue: mt(issue) })
  if (!expression?.trim()) return uncertain('请补充具体提醒时间')
  let source = normalizeTimeExpression(expression.trim())
  source=source.replace(/每(?:个|個)?月(?:的)?(?:最后一天|最後一天|月底)/gu,'每月31日').replace(/\b(?:every month|monthly) (?:on )?(?:the )?last day\b/giu,'every month on the 31st')
  const monthNames=['January','February','March','April','May','June','July','August','September','October','November','December']
  source=source.replace(new RegExp(`\\b(every year|yearly|annually)\\s+(?:on\\s+)?(${monthNames.map(name=>name+'|'+name.slice(0,3)).join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`,'giu'),(_all,_unit:string,month:string,day:string)=>`every year on ${monthNames.findIndex(name=>name.toLowerCase().startsWith(month.toLowerCase()))+1}-${day}`)
  let count: number | undefined, until: number | undefined, interval = 1
  const quantity = (text:string):number => {
    if(/^\d+$/.test(text))return Number(text)
    const map:Record<string,number>={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10}
    if(map[text.toLowerCase()]!==undefined)return map[text.toLowerCase()]
    if(/^[一二三四五六七八九]?十[一二三四五六七八九]?$/.test(text)){const [head,tail]=text.split('十');return (head?map[head]:1)*10+(tail?map[tail]:0)}
    return NaN
  }
  source = source.replace(/(?:总共|總共|共|重复|重複)\s*(\d+|[零〇一二两三四五六七八九十百千]+)\s*次|\b(?:for|repeat)\s+(\w+)\s+times?\b/iu, (_all,a:string,b:string)=>{count=quantity(a||b);return ''})
  source = source.replace(/(?:持续|持續)\s*(\d+|[一二两三四五六七八九十百千]+)\s*天|\bfor\s+(\w+)\s+days?\b/iu, (_all,a:string,b:string)=>{const days=quantity(a||b),d=new Date(now);d.setDate(d.getDate()+days-1);d.setHours(23,59,59,999);until=+d;return ''})
  const end = /(?:直到|截止|截至)|\buntil\b/iu.exec(source)
  if(end){const date=source.slice(end.index+end[0].length).replace(/[。.!，,\s]+$/u,'').trim();const parser=/[\u4e00-\u9fff]/.test(date)?zh.hans:en;const rows=parser.parse(date,new Date(now),{forwardDate:true});if(rows.length!==1||!rows[0].start.isCertain('day'))return uncertain('请补充明确的重复结束日期');const d=rows[0].start.date();d.setHours(23,59,59,999);until=+d;source=source.slice(0,end.index)}
  if(/总共|總共|持续|持續|直到|截止|截至|限定|\b(?:until|for|times)\b/iu.test(source))return uncertain('暂不支持此重复规则，请手动确认')
  source=source.replace(/每\s*(\d+|[一二两三四五六七八九十百千]+)\s*(?:个|個)?(天|日|周|星期|月|年)|\bevery\s+(\w+)\s+(days?|weeks?|months?|years?)\b/iu,(_all,a:string,unit:string,b:string,enUnit:string)=>{interval=quantity(a||b);return a?`每${unit}`:`every ${enUnit.replace(/s$/,'')}`})
  source=source.replace(/每周(?:周|星期)([一二三四五六日天])/u,'每周$1')
  const monthly = /每(?:个|個)?月\s*(\d{1,2})\s*[日号號]|\b(?:every\s+month\s+(?:on\s+)?(?:the\s+)?|monthly\s+(?:on\s+)?)(\d{1,2})(?:st|nd|rd|th)?/iu.exec(source)
  const yearly = /每年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号號]|\b(?:every\s+year|yearly)\s+(?:on\s+)?(\d{1,2})-(\d{1,2})\b/iu.exec(source)
  const periodic = monthly || yearly
  const clockSource = periodic ? source.replace(periodic[0], /[\u4e00-\u9fff]/.test(source)?'明天':'tomorrow') : source
  const weeklyClause = weeklyDays(clockSource)
  const text = weeklyClause.text
  if (!Number.isInteger(interval)||interval<1||interval>100||count!==undefined&&(!Number.isInteger(count)||count<1||count>10000)||until!==undefined&&(!Number.isSafeInteger(until)||until<=now)) return uncertain('重复次数、间隔或结束日期无效')
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
  if (!daily && !weekly && !periodic && /每|\b(?:every|each|monthly|yearly)\b/i.test(text)) return uncertain('请确认重复规则与具体日期')
  if (daily || weekly || periodic) {
    const weekday = start.get('weekday')
    if (weekly && weekday === null) return uncertain('请选择每周的星期')
    const recurrence: ReminderRecurrence = { frequency: yearly?'yearly':monthly?'monthly':weekly ? 'weekly' : 'daily', hour, minute,
      ...(weekly ? { weekdays: weeklyClause.days ?? [weekday!] } : {}),
      ...(monthly?{day:Number(monthly[1]||monthly[2])}:{}), ...(yearly?{month:Number(yearly[1]||yearly[3]),day:Number(yearly[2]||yearly[4])}:{}),
      ...(interval!==1?{interval,anchor:now}:{}),...(count!==undefined?{count}:{}),...(until!==undefined?{until}:{}) }
    if(!validRecurrence(recurrence))return uncertain('重复规则无效')
    if(interval!==1){const first=nextOccurrence({...recurrence,interval:1,anchor:undefined},now);if(first===null)return uncertain('结束日期之前没有可执行的提醒');recurrence.anchor=first}
    const dueAt=nextOccurrence(recurrence, now)
    return dueAt===null?uncertain('结束日期之前没有可执行的提醒'): { dueAt, recurrence }
  }
  if (!relative && !start.isCertain('day') && !start.isCertain('weekday')) return uncertain('请补充具体日期')
  const dueAt = start.date().getTime()
  if (!relative && !start.isCertain('timezoneOffset') && (new Date(dueAt).getHours() !== hour || new Date(dueAt).getMinutes() !== minute)) {
    return uncertain('本地时刻因夏令时不存在，请选择其他时间')
  }
  if (!Number.isFinite(dueAt) || dueAt <= now) return uncertain('这个时间已经过去，请确认新的时间')
  return { dueAt, recurrence: null }
}
