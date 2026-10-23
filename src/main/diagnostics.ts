/**
 * Diagnostics bundle (REQ-18).
 *
 * The reference product ships a "run diagnostics" action that packs versions,
 * connectivity, devices and recent logs into one file a support engineer can
 * read. We need the same thing for a different reason: the backend is
 * user-supplied, so most "it does not work" reports are a wrong base URL, a
 * missing key, or a dead mic — all of which fit in one page.
 *
 * Everything written here is redacted first: keys never leave the machine, and
 * the file is only created when the user asks for it.
 */
import { mt } from '@shared/mainI18n'


/** Keeps the last N log lines without growing unboundedly. */
export class RingLog {
  private lines: string[] = []

  constructor(private readonly limit = 200) {}

  push(line: string): void {
    this.lines.push(line)
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit)
  }

  /** Newest last, which is how a human reads a log tail. */
  tail(count = 50): string[] {
    return this.lines.slice(-count)
  }

  get size(): number {
    return this.lines.length
  }
}

/**
 * Removes credentials from free text. Deliberately aggressive: diagnostics are
 * shared with other people, and a false positive only costs a redacted field.
 */
export function redactSecrets(text: string): string {
  if (!text) return text
  return text
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{8,}/gi, '$1 ***')
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{6,}/g, '$1-***')
    // Two forms, one rule: `apiKey=abc` and `"apiKey": "abc"`. The quote that
    // JSON puts between the name and the colon is why the previous pattern let
    // every JSON-shaped secret through — `"apiKey": "sk-…"` was copied verbatim
    // into a report meant to be shared with other people.
    .replace(
      /(\b(?:api[_-]?key|apikey|secret[_-]?(?:key|id)|secretkey|access[_-]?token|auth[_-]?token|refresh[_-]?token|password|passwd)\b"?\s*[:=]\s*"?)[^"\s,}&]{4,}/gi,
      '$1***'
    )
    .replace(/\b(api[_-]?key)\b(\s*[:=]\s*)"?[^"\s,}&]{6,}"?/gi, '$1$2***')
    .replace(/([?&](?:key|token|api_key|apikey|access_token)=)[^&\s]+/gi, '$1***')
    .replace(/\b(AKIA|ASIA)[0-9A-Z]{12,}/g, '***')
}

/** Shows that a secret exists without revealing it: `已设置（39 字符）`. */
export function describeSecret(value: string): string {
  if (!value) return mt('未设置')
  return mt('已设置（{{n}} 字符）', { n: value.length })
}

export interface DiagnosticsInput {
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  release: string
  dataDir: string
  settings: unknown
  devices: Array<{ deviceId: string; label: string }>
  connectivity: string[]
  logTail: string[]
  now?: Date
}

/** Renders the report. Pure so the shape can be asserted in tests. */
export function renderDiagnostics(input: DiagnosticsInput): string {
  const at = (input.now ?? new Date()).toISOString()
  const settings = redactSecrets(JSON.stringify(input.settings ?? {}, null, 2))
  const lines: string[] = [
    mt('轻令（Qinly） 诊断报告'),
    mt('生成时间: {{at}}', { at }),
    '',
    mt('== 版本 =='),
    mt('应用: {{version}}', { version: input.version }),
    `Electron: ${input.electron}`,
    `Chromium: ${input.chrome}`,
    `Node: ${input.node}`,
    '',
    mt('== 系统 =='),
    mt('平台: {{platform}} {{release}} ({{arch}})', {
      platform: input.platform,
      release: input.release,
      arch: input.arch
    }),
    mt('数据目录: {{dir}}', { dir: input.dataDir }),
    '',
    mt('== 麦克风 =='),
    ...(input.devices.length > 0
      ? input.devices.map((device, index) => `- [${index}] ${device.label || mt('（无标签）')} id=${shortId(device.deviceId)}`)
      : ['- ' + mt('未授权或未枚举到设备')]),
    '',
    mt('== 后端连通性 =='),
    ...(input.connectivity.length > 0 ? input.connectivity.map((line) => `- ${line}`) : ['- ' + mt('未探测')]),
    '',
    mt('== 设置快照（已脱敏）=='),
    settings,
    '',
    mt('== 最近日志（{{n}} 行）==', { n: input.logTail.length }),
    ...input.logTail.map((line) => redactSecrets(line))
  ]
  return `${lines.join('\n')}\n`
}

function shortId(id: string): string {
  if (!id) return mt('默认')
  return id.length <= 8 ? id : `${id.slice(0, 6)}…`
}

/** File name with a sortable timestamp; no colons, so Windows accepts it. */
export function diagnosticsFileName(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  return `diagnostics-${stamp}.txt`
}
