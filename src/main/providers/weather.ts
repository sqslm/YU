/**
 * Live weather lookups for Ask Anything.
 *
 * Search engines answer "安阳天气" with pages full of historical tables, so the
 * model ends up hedging. Open-Meteo answers with numbers and needs no key, which
 * is what makes a sentence like "今天安阳 12 到 19 度，多云" possible at all.
 */
import type { SearchResult } from '@shared/types'
import { mt } from '@shared/mainI18n'

/** Split so the self-test can point both endpoints at the local stub. */
function geocodingBase(): string {
  const override = process.env.TYPELESS_WEATHER_BASE
  return override ? `${override}/geocoding-api/v1` : 'https://geocoding-api.open-meteo.com/v1'
}

function forecastBase(): string {
  const override = process.env.TYPELESS_WEATHER_BASE
  return override ? `${override}/v1` : 'https://api.open-meteo.com/v1'
}

export interface WeatherReport {
  place: string
  region?: string
  current: {
    temperature: number
    apparent: number
    humidity: number
    precipitation: number
    wind: number
    code: number
    description: string
  }
  daily: Array<{
    date: string
    description: string
    high: number
    low: number
    rainChance: number
  }>
  sourceUrl: string
}

/** WMO weather codes, collapsed into something a spoken answer can use. */
const WEATHER_CODE: Record<number, string> = {
  0: mt('晴'),
  1: mt('晴间多云'),
  2: mt('多云'),
  3: mt('阴'),
  45: mt('雾'),
  48: mt('霜雾'),
  51: mt('小毛毛雨'),
  53: mt('毛毛雨'),
  55: mt('大毛毛雨'),
  56: mt('冻毛毛雨'),
  57: mt('强冻毛毛雨'),
  61: mt('小雨'),
  63: mt('中雨'),
  65: mt('大雨'),
  66: mt('冻雨'),
  67: mt('强冻雨'),
  71: mt('小雪'),
  73: mt('中雪'),
  75: mt('大雪'),
  77: mt('雪粒'),
  80: mt('阵雨'),
  81: mt('强阵雨'),
  82: mt('暴雨'),
  85: mt('阵雪'),
  86: mt('强阵雪'),
  95: mt('雷阵雨'),
  96: mt('雷阵雨伴冰雹'),
  99: '强雷阵雨伴冰雹'
}

export function describeWeather(code: number): string {
  return WEATHER_CODE[code] ?? mt('未知天气')
}

const WEATHER_WORDS = /天气|气温|温度|下雨|降雨|下雪|降雪|刮风|风力|雾霾|空气|几度|多少度|冷不冷|热不热/
const WEATHER_WORDS_EN =
  /\b(?:weather|forecast|temperature|humidity|rain|raining|snow|snowing|wind|windy)\b/i
const FORECAST_WORDS = /预报|明天|后天|未来|这周|一周|周末|tomorrow|week|weekend|forecast/i

/** Cheap intent gate: only weather questions take the Open-Meteo shortcut. */
export function isWeatherQuery(text: string): boolean {
  return WEATHER_WORDS.test(text) || WEATHER_WORDS_EN.test(text)
}

/**
 * Strip the parts of a spoken question that never appear in a place name.
 * "今天河南安阳的天气怎么样" → ["河南安阳", "安阳"].
 */
export function placeCandidates(text: string): string[] {
  const cleaned = text
    .replace(/[?？。！!，,、]/g, ' ')
    .replace(
      /(今天|今日|明天|明日|后天|现在|当前|目前|这两天|这周|本周|周末|未来几天|最近的?)/g,
      ' '
    )
    .replace(/(的)?(天气|气温|温度|预报|情况|怎么样|如何|咋样|是什么|多少度|几度|冷不冷|热不热)/g, ' ')
    .replace(/(请问|帮我|我想|问一下|查一下|看一下|告诉我)/g, ' ')
    .replace(
      /\b(?:what'?s|what is|how is|how'?s|the|weather|forecast|temperature|today|tomorrow|tonight|in|at|like|is|it)\b/gi,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim()

  const out: string[] = []
  for (const token of cleaned.split(' ').filter(Boolean)) {
    if (token.length === 0) continue
    out.push(token)
    // "河南安阳" → keep "安阳" too: the province is a hint, not part of the name.
    const region = REGIONS.exec(token)?.[1]
    if (region && token.length > region.length) out.push(token.slice(region.length))
  }
  return [...new Set(out)]
}

interface GeoHit {
  name: string
  admin1?: string
  country?: string
  population?: number
  latitude: number
  longitude: number
}

const REGIONS =
  /(北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门)/

/**
 * Open-Meteo happily returns the first village named 安阳 (there is one in
 * Guangxi) for "河南安阳", so prefer a hit whose province matches the spoken
 * region and otherwise take the most populous one.
 */
async function geocode(
  place: string,
  region: string | null,
  signal?: AbortSignal
): Promise<GeoHit | null> {
  const url = `${geocodingBase()}/search?name=${encodeURIComponent(place)}&count=5&language=zh&format=json`
  const res = await fetch(url, { signal })
  if (!res.ok) return null
  const body = (await res.json()) as {
    results?: Array<{
      name?: unknown
      admin1?: unknown
      country?: unknown
      population?: unknown
      latitude?: unknown
      longitude?: unknown
    }>
  }
  const hits = (body.results ?? []).filter(
    (hit) => typeof hit.latitude === 'number' && typeof hit.longitude === 'number'
  )
  if (hits.length === 0) return null

  const rank = (hit: (typeof hits)[number]): number => {
    const admin = typeof hit.admin1 === 'string' ? hit.admin1 : ''
    const provinceMatch = region && admin.includes(region.replace(/[省市]$/, '')) ? 1 : 0
    return provinceMatch * 1e9 + (typeof hit.population === 'number' ? hit.population : 0)
  }
  const best = [...hits].sort((a, b) => rank(b) - rank(a))[0]
  return {
    name: String(best.name ?? place),
    admin1: typeof best.admin1 === 'string' ? best.admin1 : undefined,
    country: typeof best.country === 'string' ? best.country : undefined,
    population: typeof best.population === 'number' ? best.population : undefined,
    latitude: best.latitude as number,
    longitude: best.longitude as number
  }
}

interface ForecastBody {
  current?: Record<string, number | string>
  daily?: Record<string, Array<number | string>>
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export async function fetchWeather(
  text: string,
  signal?: AbortSignal
): Promise<WeatherReport | null> {
  let hit: GeoHit | null = null
  const region = REGIONS.exec(text)?.[1] ?? null
  for (const candidate of placeCandidates(text)) {
    hit = await geocode(candidate, region, signal)
    if (hit) break
  }
  if (!hit) return null

  const params = new URLSearchParams({
    latitude: String(hit.latitude),
    longitude: String(hit.longitude),
    current:
      'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: FORECAST_WORDS.test(text) ? '4' : '2'
  })
  const res = await fetch(`${forecastBase()}/forecast?${params.toString()}`, { signal })
  if (!res.ok) return null
  const body = (await res.json()) as ForecastBody
  const current = body.current ?? {}
  const daily = body.daily ?? {}
  const dates = (daily.time ?? []) as string[]
  const codes = (daily.weather_code ?? []) as number[]
  const highs = (daily.temperature_2m_max ?? []) as number[]
  const lows = (daily.temperature_2m_min ?? []) as number[]
  const rain = (daily.precipitation_probability_max ?? []) as number[]

  return {
    place: [hit.admin1, hit.name].filter(Boolean).join(' '),
    region: hit.country,
    current: {
      temperature: num(current.temperature_2m),
      apparent: num(current.apparent_temperature),
      humidity: num(current.relative_humidity_2m),
      precipitation: num(current.precipitation),
      wind: num(current.wind_speed_10m),
      code: num(current.weather_code),
      description: describeWeather(num(current.weather_code))
    },
    daily: dates.slice(0, 4).map((date, index) => ({
      date,
      description: describeWeather(num(codes[index])),
      high: num(highs[index]),
      low: num(lows[index]),
      rainChance: num(rain[index])
    })),
    sourceUrl: `https://open-meteo.com/en/docs?latitude=${hit.latitude}&longitude=${hit.longitude}`
  }
}

/** The prompt block: numbers only, so the model has nothing to hedge about. */
export function formatWeather(report: WeatherReport, today = new Date()): string {
  const todayKey = today.toISOString().slice(0, 10)
  const lines = [
    mt('地点：{{place}}', { place: report.place }),
    mt(
      '实况（更新于查询时刻）：{{desc}}，{{temp}}°C，体感 {{feels}}°C，相对湿度 {{humidity}}%，风速 {{wind}} km/h，降水 {{rain}} mm',
      {
        desc: report.current.description,
        temp: report.current.temperature,
        feels: report.current.apparent,
        humidity: report.current.humidity,
        wind: report.current.wind,
        rain: report.current.precipitation
      }
    )
  ]
  for (const day of report.daily) {
    const label = day.date === todayKey ? mt('今天') : day.date
    lines.push(
      mt('{{label}}：{{desc}}，{{low}}~{{high}}°C，降水概率 {{rain}}%', {
        label,
        desc: day.description,
        low: day.low,
        high: day.high,
        rain: day.rainChance
      })
    )
  }
  return lines.join('\n')
}

export function weatherSource(report: WeatherReport): SearchResult {
  return {
    title: mt('{{place}} 实时天气 · Open-Meteo', { place: report.place }),
    url: report.sourceUrl,
    snippet: `${report.current.description} ${report.current.temperature}°C`
  }
}
