import type { PresetField } from './types'
import { mt } from './mainI18n'

/**
 * Fields a vendor needs beyond base URL, key, model and path.
 *
 * This table lives in `shared` because two very different callers need the same
 * list: the settings UI (which renders an input per field and refuses to leave a
 * required one blank) and the transcription adapters in the main process (which
 * read the values back out). Keeping one copy means the form can never ask for a
 * field the adapter does not read, or skip one it does.
 *
 * Keyed by preset id; a hand-written profile has no preset, so it falls back to
 * the adapter's own `fields` list.
 */
export const PRESET_FIELDS: Record<string, PresetField[]> = {
  'azure-openai': [
    {
      key: 'deployment',
      label: mt('部署名'),
      hint: mt('Azure 门户里那个部署名称，不是模型名'),
      required: true,
      placeholder: 'whisper'
    },
    {
      key: 'apiVersion',
      label: mt('API 版本'),
      hint: mt('留空用 2024-06-01'),
      placeholder: '2024-06-01',
      value: '2024-06-01'
    }
  ],
  tencent: [
    { key: 'secretId', label: 'SecretId', required: true, hint: mt('访问管理 → API 密钥') },
    { key: 'secretKey', label: 'SecretKey', required: true },
    { key: 'region', label: mt('地域'), value: 'ap-shanghai', placeholder: 'ap-shanghai' },
    { key: 'token', label: mt('临时 Token'), hint: mt('只有用临时密钥时才填') }
  ],
  xfyun: [
    { key: 'appId', label: 'AppId', required: true, hint: mt('讯飞控制台里那串 8 位数字') },
    { key: 'apiKey', label: 'APIKey', required: true },
    { key: 'apiSecret', label: 'APISecret', required: true }
  ],
  baidu: [
    { key: 'apiKey', label: 'API Key', required: true, hint: mt('百度智能云应用列表里的 API Key') },
    { key: 'secretKey', label: 'Secret Key', required: true, hint: mt('同一个应用里的 Secret Key，用来换 access_token') }
  ],
  aliyun: [
    {
      key: 'uploadUrl',
      label: mt('上传地址'),
      hint: mt('仅 Paraformer / Filetrans 异步模型需要；Qwen ASR Flash 直接上传录音，无需填写')
    },
    { key: 'workspace', label: 'Workspace', hint: mt('留空用默认业务空间') }
  ],
  'google-cse': [
    { key: 'cx', label: mt('搜索引擎 ID (cx)'), required: true, hint: mt('Programmable Search Engine 的控制台里那串 cx') }
  ]
}

/** Fields for a preset id; empty array for anything hand-written. */
export function presetVendorFields(presetId: string | undefined): PresetField[] {
  if (!presetId) return []
  return PRESET_FIELDS[presetId] ?? []
}

/** Required-but-empty fields, in declaration order. */
export function missingVendorFields(
  presetId: string | undefined,
  vendor: Record<string, string> | undefined
): PresetField[] {
  return presetVendorFields(presetId).filter(
    (item) => item.required === true && (vendor?.[item.key] ?? '').trim() === ''
  )
}

/** Starting values for a new profile: defaults, plus the key field aliases. */
export function defaultVendorValues(presetId: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  presetVendorFields(presetId).forEach((item) => {
    if (item.value) out[item.key] = item.value
  })
  return out
}
