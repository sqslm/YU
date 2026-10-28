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
      get label() { return mt('部署名') },
      get hint() { return mt('Azure 门户里那个部署名称，不是模型名') },
      required: true,
      placeholder: 'whisper'
    },
    {
      key: 'apiVersion',
      get label() { return mt('API 版本') },
      get hint() { return mt('留空用 2024-06-01') },
      placeholder: '2024-06-01',
      value: '2024-06-01'
    }
  ],
  tencent: [
    { key: 'secretId', label: 'SecretId', required: true, get hint() { return mt('访问管理 → API 密钥') } },
    { key: 'secretKey', label: 'SecretKey', required: true },
    { key: 'region', get label() { return mt('地域') }, value: 'ap-shanghai', placeholder: 'ap-shanghai' },
    { key: 'token', get label() { return mt('临时 Token') }, get hint() { return mt('只有用临时密钥时才填') } }
  ],
  'tencent-realtime-asr': [
    {
      key: 'appId',
      get label() { return mt('AppID') },
      required: true,
      get hint() { return mt('控制台「语音识别 → 概览」里的 125xxxxxx') },
      placeholder: '1250000000'
    },
    { key: 'secretId', label: 'SecretId', required: true, get hint() { return mt('访问管理 → API 密钥') } },
    { key: 'secretKey', label: 'SecretKey', required: true },
    {
      key: 'engine',
      get label() { return mt('引擎') },
      get hint() { return mt('默认 16k_zh；英文 16k_en，粤语 16k_yue，大模型档 16k_zh_en_2.0') },
      value: '16k_zh',
      placeholder: '16k_zh'
    }
  ],
  'volcengine-streaming-asr': [
    // The new console hands out a single API Key, so neither of the old pair is
    // required any more: demanding them is what made this connection look broken.
    {
      key: 'appId',
      get label() { return mt('App ID（旧版控制台，可选）') },
      get hint() { return mt('新版控制台只用上面的 API Key，这里留空即可') }
    },
    {
      key: 'accessKey',
      get label() { return mt('Access Token（旧版控制台，可选）') },
      get hint() { return mt('与 App ID 成对的那串 Access Token，只有旧版控制台才需要') }
    },
    {
      key: 'resourceId',
      get label() { return mt('Resource Id') },
      get hint() { return mt('留空即 2.0 小时版；并发版 volc.seedasr.sauc.concurrent，1.0 老账号 volc.bigasr.sauc.duration') },
      value: 'volc.seedasr.sauc.duration',
      placeholder: 'volc.seedasr.sauc.duration'
    }
  ],
  'xfyun-rta-asr': [
    { key: 'appId', get label() { return mt('AppID') }, required: true, get hint() { return mt('控制台「Websocket服务接口认证信息」里的 8 位 AppID') } },
    {
      key: 'apiKey',
      get label() { return mt('APIKey') },
      get hint() { return mt('同一栏里的 APIKey；留空则用上面的 API Key。签名用的是它，不是 APISecret') }
    },
    {
      key: 'lang',
      get label() { return mt('语言') },
      get hint() { return mt('留空为中文/中英混合；英文填 en，方言要先在控制台添加') },
      value: 'cn',
      placeholder: 'cn'
    },
    {
      key: 'vadMdn',
      get label() { return mt('拾音方式') },
      get hint() { return mt('留空为远场；贴近麦克风说话填 2（近场）') }
    }
  ],
  'aliyun-paraformer': [
    {
      key: 'uploadUrl',
      get label() { return mt('音频直传地址') },
      required: true,
      get hint() { return mt('这个接口只收 URL：填一个阿里能回源读取的公网地址（OSS 等），本地录音会被传到这里') },
      placeholder: 'https://…/audio.wav'
    },
    {
      key: 'workspace',
      get label() { return mt('业务空间 ID') },
      get hint() { return mt('可选；填了会作为 X-DashScope-WorkSpace 发出，留空用默认空间') }
    }
  ],
  'aliyun-realtime-asr': [
    {
      key: 'workspace',
      get label() { return mt('业务空间 ID') },
      get hint() { return mt('可选；留空用默认业务空间') }
    }
  ],
  xfyun: [
    { key: 'appId', label: 'AppId', required: true, get hint() { return mt('讯飞控制台里那串 8 位数字') } },
    { key: 'apiKey', label: 'APIKey', required: true },
    { key: 'apiSecret', label: 'APISecret', required: true }
  ],
  baidu: [
    { key: 'apiKey', label: 'API Key', required: true, get hint() { return mt('百度智能云应用列表里的 API Key') } },
    { key: 'secretKey', label: 'Secret Key', required: true, get hint() { return mt('同一个应用里的 Secret Key，用来换 access_token') } }
  ],
  aliyun: [
    {
      key: 'uploadUrl',
      get label() { return mt('上传地址') },
      get hint() { return mt('仅 Paraformer / Filetrans 异步模型需要；Qwen ASR Flash 直接上传录音，无需填写') }
    },
    { key: 'workspace', label: 'Workspace', get hint() { return mt('留空用默认业务空间') } }
  ],
  'google-cse': [
    { key: 'cx', get label() { return mt('搜索引擎 ID (cx)') }, required: true, get hint() { return mt('Programmable Search Engine 的控制台里那串 cx') } }
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
