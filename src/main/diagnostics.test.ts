import { describe, expect, it } from 'vitest'
import { RingLog, describeSecret, diagnosticsFileName, redactSecrets, renderDiagnostics } from './diagnostics'

describe('redactSecrets', () => {
  it('masks bearer tokens and provider-style keys', () => {
    const text = 'Authorization: Bearer abcdef1234567890 key sk-live-ABCdef123456'
    const out = redactSecrets(text)
    expect(out).not.toContain('abcdef1234567890')
    expect(out).not.toContain('sk-live')
    expect(out).toContain('Bearer ***')
  })

  it('masks query-string credentials and api-key pairs', () => {
    const out = redactSecrets('https://x.test/?api_key=supersecret&page=2 apiKey: "hunter2secret"')
    expect(out).not.toContain('supersecret')
    expect(out).not.toContain('hunter2secret')
    expect(out).toContain('page=2')
  })

  it('leaves ordinary text untouched', () => {
    const text = '[asr] 1360ms audio=1200ms codec=audio/ogg'
    expect(redactSecrets(text)).toBe(text)
  })

  it('does not throw on empty input', () => {
    expect(redactSecrets('')).toBe('')
  })
})

describe('describeSecret', () => {
  it('reports presence without the value', () => {
    expect(describeSecret('')).toBe('未设置')
    expect(describeSecret('abcdef')).toBe('已设置（6 字符）')
  })
})

describe('RingLog', () => {
  it('keeps only the newest lines', () => {
    const log = new RingLog(3)
    for (const line of ['a', 'b', 'c', 'd', 'e']) log.push(line)
    expect(log.tail()).toEqual(['c', 'd', 'e'])
    expect(log.size).toBe(3)
  })

  it('tails fewer lines than it holds', () => {
    const log = new RingLog(10)
    log.push('only')
    expect(log.tail(50)).toEqual(['only'])
  })
})

describe('renderDiagnostics', () => {
  const report = renderDiagnostics({
    version: '0.9.0',
    electron: '38.1.0',
    chrome: '140',
    node: '20',
    platform: 'win32',
    arch: 'x64',
    release: '10.0.19045',
    dataDir: 'C:\\Users\\x\\AppData\\Roaming\\Typeless Rebuild',
    settings: { asr: { baseUrl: 'https://api.test/v1', apiKey: 'sk-secret-value-123' } },
    devices: [{ deviceId: 'abcdef1234567890', label: '麦克风 (Realtek)' }],
    connectivity: ['asr: GET api.test -> 200 (42ms)'],
    logTail: ['[perf] asr bytes=100 Bearer tok_abcdefgh'],
    now: new Date('2026-10-19T09:00:00Z')
  })

  it('contains the sections a support engineer needs', () => {
    expect(report).toContain('轻令（Qinly） 诊断报告')
    expect(report).toContain('Electron: 38.1.0')
    expect(report).toContain('麦克风 (Realtek)')
    expect(report).toContain('asr: GET api.test -> 200')
    expect(report).toContain('2026-10-19T09:00:00.000Z')
  })

  it('never leaks a key, even from the settings snapshot or the log', () => {
    expect(report).not.toContain('sk-secret-value-123')
    expect(report).not.toContain('tok_abcdefgh')
  })

  it('says so when nothing was enumerated', () => {
    const empty = renderDiagnostics({
      version: '0.9.0',
      electron: '',
      chrome: '',
      node: '',
      platform: 'win32',
      arch: 'x64',
      release: '',
      dataDir: '/tmp',
      settings: {},
      devices: [],
      connectivity: [],
      logTail: []
    })
    expect(empty).toContain('未授权或未枚举到设备')
    expect(empty).toContain('未探测')
    expect(empty).toContain('最近日志（0 行）')
  })
})

describe('diagnosticsFileName', () => {
  it('is filesystem-safe and sortable', () => {
    const name = diagnosticsFileName(new Date('2026-10-19T09:08:07.123Z'))
    expect(name).toMatch(/^diagnostics-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.txt$/)
    expect(name).not.toContain(':')
  })
})
