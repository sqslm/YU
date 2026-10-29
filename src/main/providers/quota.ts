import { createHash } from 'node:crypto'
import type { Settings } from '@shared/types'
import type { QuotaResult, QuotaTarget } from '@shared/quota'
import { ttsProfiles } from '@shared/speech'
import { parseHeaderLines } from './headers'

type Vendor = 'deepseek' | 'moonshot' | 'siliconflow' | 'openrouter' | 'elevenlabs'
const endpoints: Record<string, { vendor: Vendor; path: string; consoleUrl: string }> = {
  'api.deepseek.com': { vendor: 'deepseek', path: '/user/balance', consoleUrl: 'https://platform.deepseek.com/usage' },
  'api.moonshot.cn': { vendor: 'moonshot', path: '/v1/users/me/balance', consoleUrl: 'https://platform.kimi.com/console/account' },
  'api.siliconflow.cn': { vendor: 'siliconflow', path: '/v1/user/info', consoleUrl: 'https://cloud.siliconflow.cn/account/ak' },
  'openrouter.ai': { vendor: 'openrouter', path: '/api/v1/key', consoleUrl: 'https://openrouter.ai/settings/credits' },
  'api.elevenlabs.io': { vendor: 'elevenlabs', path: '/v1/user/subscription', consoleUrl: 'https://elevenlabs.io/app/subscription' }
}
const record = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('format')
  return value as Record<string, any>
}
const amount = (value: unknown): number => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value.trim()))) throw Error('format')
  const number = Number(value)
  if (!Number.isFinite(number)) throw Error('format')
  return number
}
export function parseQuota(vendor: Vendor, body: unknown): Pick<QuotaResult, 'scope' | 'metrics' | 'message'> {
  const json = record(body)
  if (vendor === 'deepseek') {
    if (!Array.isArray(json.balance_infos) || !json.balance_infos.length) throw Error('format')
    return { scope: 'account', message: '账户共享余额，不是模型独立额度', metrics: json.balance_infos.map((row: any) => {
      if (!['CNY', 'USD'].includes(row.currency)) throw Error('format')
      return { label: '可用余额', remaining: amount(row.total_balance), unit: row.currency }
    }) }
  }
  if (vendor === 'moonshot' || vendor === 'siliconflow') {
    const data = record(json.data)
    if (vendor === 'moonshot' && json.status === false || vendor === 'siliconflow' && (json.status !== true || data.status !== 'normal')) throw Error('restricted')
    return { scope: 'account', message: '账户共享余额，不是模型独立额度', metrics: [{ label: '可用余额',
      remaining: amount(vendor === 'moonshot' ? data.available_balance : data.totalBalance), unit: 'CNY' }] }
  }
  if (vendor === 'openrouter') {
    const data = record(json.data), used = amount(data.usage)
    if (data.limit == null) return { scope: 'key', message: '此密钥未设置额度上限；账户余额请在控制台查看', metrics: [{ label: '密钥累计用量', used, unit: 'USD' }] }
    const total = amount(data.limit), remaining = amount(data.limit_remaining)
    if (total < 0) throw Error('format')
    return { scope: 'key', message: '密钥共享限额，不代表账户余额或模型独立额度', metrics: [{ label: '密钥剩余额度', total, remaining, used: Math.max(0, total - remaining), unit: 'USD' }] }
  }
  const used = amount(json.character_count), total = amount(json.character_limit)
  if (used < 0 || total < 0) throw Error('format')
  return { scope: 'account', message: '订阅周期共享额度，实际模型消耗以提供商为准', metrics: [{ label: '订阅剩余额度', used, total, remaining: Math.max(0, total - used), unit: 'characters',
    ...(typeof json.next_character_count_reset_unix === 'number' && json.next_character_count_reset_unix > 0 ? { resetsAt: json.next_character_count_reset_unix * 1000 } : {}) }] }
}

/** On-demand read-only queries. Cache and request sharing are scoped to actual endpoint + credentials. */
export class QuotaService {
  private cache = new Map<string, { until: number; result: QuotaResult }>()
  private pending = new Map<string, Promise<QuotaResult>>()
  constructor(private readonly settings: () => Settings, private readonly request: typeof fetch = fetch, private readonly now = Date.now) {}
  clear(): void { this.cache.clear() }
  async query(target: QuotaTarget): Promise<QuotaResult> {
    const settings = this.settings()
    const result = (status: QuotaResult['status'], message: string, consoleUrl?: string): QuotaResult => ({ status, message, scope: 'none', metrics: [], checkedAt: this.now(), ...(consoleUrl ? { consoleUrl } : {}) })
    if (target.kind === 'local-asr') return result('local', '本地模型不使用云端额度')
    const profile = target.kind === 'tts' ? ttsProfiles(settings.tts).find(row => row.id === target.id)
      : settings.profiles.find(row => row.kind === target.kind && row.id === target.id)
    if (!profile) return result('unconfigured', '连接已删除，请重新选择')
    if ('provider' in profile && profile.provider === 'windows') return result('local', '本机声音不使用云端额度')
    let url: URL
    try { url = new URL(profile.baseUrl) } catch { return result('unconfigured', '请先配置模型连接地址') }
    const endpoint = endpoints[url.hostname]
    // A preset name never authorizes sending gateway credentials to the vendor's server.
    if (!endpoint || url.protocol !== 'https:' || url.port || url.username || url.password) return result('unsupported', '此连接暂不支持自动查询额度，请到提供商控制台查看')
    const extra = 'extraHeaders' in profile ? profile.extraHeaders : undefined
    let headers: Headers
    try {
      headers = new Headers(parseHeaderLines(extra))
      if (profile.apiKey) headers.set(endpoint.vendor === 'elevenlabs' ? 'xi-api-key' : 'Authorization', endpoint.vendor === 'elevenlabs' ? profile.apiKey : `Bearer ${profile.apiKey}`)
    } catch { return result('unconfigured', '自定义请求头格式无效，请先检查模型连接', endpoint.consoleUrl) }
    if (!headers.get(endpoint.vendor === 'elevenlabs' ? 'xi-api-key' : 'Authorization')) return result('unconfigured', '请先配置 API Key', endpoint.consoleUrl)
    const address = url.origin + endpoint.path
    const key = createHash('sha256').update(JSON.stringify([address, [...headers.entries()]])).digest('hex')
    const cached = this.cache.get(key)
    if (cached && cached.until > this.now()) return cached.result
    const running = this.pending.get(key)
    if (running) return running
    const work = async (): Promise<QuotaResult> => {
      const signal = AbortSignal.timeout(8000)
      let value: QuotaResult
      try {
        const response = await this.request(address, { method: 'GET', headers, signal, redirect: 'error' })
        if (!response.ok) {
          const status = response.status
          value = result(status === 404 || status === 410 ? 'unsupported' : 'error', status === 401 || status === 403 ? '额度查询鉴权失败，请检查密钥或查询权限' : status === 429 ? '查询过于频繁，请稍后再试' : status === 404 || status === 410 ? '提供商未开放此额度查询接口，请到控制台查看' : '提供商额度服务暂时不可用，请稍后重试', endpoint.consoleUrl)
        } else {
          const text = await response.text()
          if (text.length > 65536) throw Error('format')
          value = { status: 'ok', ...parseQuota(endpoint.vendor, JSON.parse(text)), checkedAt: this.now(), consoleUrl: endpoint.consoleUrl }
        }
      } catch (error) {
        value = result(error instanceof Error && error.message === 'restricted' ? 'unsupported' : 'error', signal.aborted ? '额度查询超时，请检查网络后重试' : error instanceof Error && (error.message === 'format' || error instanceof SyntaxError) ? '提供商未返回有效额度数据，请到控制台查看' : error instanceof Error && error.message === 'restricted' ? '提供商未开放此额度查询接口，请到控制台查看' : '额度查询失败，请检查网络后重试', endpoint.consoleUrl)
      }
      this.cache.set(key, { result: value, until: this.now() + (value.status === 'ok' ? 300000 : 30000) })
      if (this.cache.size > 150) this.cache.delete(this.cache.keys().next().value!)
      return value
    }
    const promise = work(); this.pending.set(key, promise)
    try { return await promise } finally { this.pending.delete(key) }
  }
}
