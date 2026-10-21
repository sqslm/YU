import { describe, expect, it } from 'vitest'
import {
  describeWeather,
  formatWeather,
  isWeatherQuery,
  placeCandidates,
  weatherSource,
  type WeatherReport
} from './weather'

describe('isWeatherQuery', () => {
  it('matches spoken weather questions', () => {
    expect(isWeatherQuery('今天河南安阳的天气怎么样')).toBe(true)
    expect(isWeatherQuery('明天会下雨吗')).toBe(true)
    expect(isWeatherQuery('现在几度')).toBe(true)
    expect(isWeatherQuery("what's the weather in Tokyo")).toBe(true)
  })

  it('ignores everything else', () => {
    expect(isWeatherQuery('把这段转成英文')).toBe(false)
    expect(isWeatherQuery('总结一下这个函数做什么')).toBe(false)
  })
})

describe('placeCandidates', () => {
  it('strips the question wrapper but keeps the region', () => {
    const out = placeCandidates('今天河南安阳的天气怎么样')
    expect(out).toContain('河南安阳')
    expect(out).toContain('安阳')
  })

  it('handles a bare city', () => {
    expect(placeCandidates('北京天气')).toContain('北京')
  })

  it('drops filler verbs', () => {
    const out = placeCandidates('帮我查一下明天上海的天气预报')
    expect(out.some((item) => item.includes('上海'))).toBe(true)
    expect(out.join('')).not.toContain('帮我')
  })
})

describe('describeWeather', () => {
  it('maps known WMO codes and survives unknown ones', () => {
    expect(describeWeather(0)).toBe('晴')
    expect(describeWeather(61)).toBe('小雨')
    expect(describeWeather(999)).toBe('未知天气')
  })
})

describe('formatWeather', () => {
  const report: WeatherReport = {
    place: '河南省 安阳',
    current: {
      temperature: 18.4,
      apparent: 17.1,
      humidity: 62,
      precipitation: 0,
      wind: 9.7,
      code: 3,
      description: '阴'
    },
    daily: [
      { date: '2026-10-19', description: '阴', high: 23.1, low: 12.2, rainChance: 10 },
      { date: '2026-10-20', description: '小雨', high: 21.4, low: 13.6, rainChance: 65 }
    ],
    sourceUrl: 'https://open-meteo.com/en/docs'
  }

  it('carries the numbers the answer must quote', () => {
    const text = formatWeather(report, new Date('2026-10-19T08:00:00Z'))
    expect(text).toContain('河南省 安阳')
    expect(text).toContain('18.4°C')
    expect(text).toContain('今天：阴，12.2~23.1°C，降水概率 10%')
    expect(text).toContain('2026-10-20：小雨')
  })

  it('labels the source', () => {
    expect(weatherSource(report).title).toContain('Open-Meteo')
    expect(weatherSource(report).url).toBe(report.sourceUrl)
  })
})
