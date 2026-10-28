/**
 * Built-in provider presets.
 *
 * Protocol checks and known limitations are recorded in PROVIDER_API_AUDIT.md.
 * Presets are starting values; model availability and account access vary by vendor.
 *
 * `dropIn: false` is honest about what this client cannot do yet — a provider
 * that wants a signature, a different path, or a two-step upload is listed so it
 * can be found, but the UI says why instead of pretending the key is enough.
 */
import type { ProviderKind } from './types'
import { mt } from './mainI18n'

export type PresetProtocol = 'openai' | 'gemini' | 'custom'

export interface ProviderPreset {
  id: string
  name: string
  kind: ProviderKind
  protocol: PresetProtocol
  baseUrl: string
  /** Default model id, exactly as the vendor writes it; empty means "list it". */
  model: string
  /** Other model ids worth offering. */
  models?: string[]
  /** Header lines to send instead of `Authorization: Bearer <key>`. */
  headers?: string
  /** Where the key goes when the vendor refuses `Authorization: Bearer`. */
  authHeader?: 'x-api-key'
  /** Vendor-specific chat path; defaults to `chat/completions`. */
  requestPath?: string
  keyUrl?: string
  docsUrl?: string
  /** One line the UI shows under the preset: quirks, limits, caveats. */
  notes?: string
  /**
   * Adapter id for a vendor that does not speak OpenAI multipart.
   *
   * Copying this into the profile is what makes the routing survive a hand-edited
   * base URL: `main/providers/asr/index.ts` resolves the adapter from the profile
   * first, then from this preset id, then from the host.
   */
  asrAdapter?: string
  /** True when pasting a key into this client is enough. */
  dropIn: boolean
}

/**
 * Every `notes` below is a getter, never a `mt()` call evaluated at module load.
 *
 * This module is imported long before the renderer has read `settings.uiLanguage`
 * and called `setMainLanguage()`, so a string captured here would keep whatever
 * language was active at import time — the English UI showed Chinese caveats for
 * the whole session. A getter re-translates on every read and still types as
 * `string`, so no caller has to know.
 */
const ASR_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'asr',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-transcribe',
    models: ['gpt-transcribe', 'whisper-1', 'gpt-4o-transcribe'],
    keyUrl: 'https://platform.openai.com/settings/organization/api-keys',
    docsUrl: 'https://platform.openai.com/docs/guides/speech-to-text',
    get notes() { return mt('multipart 上传 /audio/transcriptions；单文件 25 MB 上限。') },
    dropIn: true
  },
  {
    id: 'groq',
    name: 'Groq',
    kind: 'asr',
    protocol: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3',
    models: ['whisper-large-v3', 'whisper-large-v3-turbo'],
    keyUrl: 'https://console.groq.com/keys',
    docsUrl: 'https://console.groq.com/docs/speech-to-text',
    get notes() { return mt('极快、有免费额度；turbo 更便宜，中文准确率低于 large-v3。') },
    dropIn: true
  },
  {
    id: 'siliconflow',
    get name() { return mt('硅基流动') },
    kind: 'asr',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/SenseVoiceSmall',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    docsUrl: 'https://docs.siliconflow.cn/docs/api/audio-transcriptions-post',
    get notes() { return mt('国内直连；SenseVoice 中文强、带情感/事件标签时会被一并转写。') },
    dropIn: true
  },
  {
    id: 'together',
    name: 'Together AI',
    kind: 'asr',
    protocol: 'openai',
    baseUrl: 'https://api.together.ai/v1',
    model: 'openai/whisper-large-v3',
    keyUrl: 'https://api.together.ai/settings/projects/~current/api-keys',
    docsUrl: 'https://docs.together.ai/reference/audio-transcriptions',
    get notes() { return mt('支持长音频（单文件 4 小时 / 80 MB），适合整段会议。') },
    dropIn: true
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    kind: 'asr',
    protocol: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'voxtral-mini-latest',
    models: ['voxtral-mini-latest', 'voxtral-small-latest'],
    keyUrl: 'https://console.mistral.ai/api-keys',
    docsUrl: 'https://docs.mistral.ai/capabilities/audio/',
    get notes() { return mt('使用 Bearer 鉴权，multipart 文件字段 file、模型字段 model；与 OpenAI 转写兼容。') },
    dropIn: true
  },
  {
    id: 'stepfun',
    get name() { return mt('阶跃星辰 StepFun') },
    kind: 'asr',
    protocol: 'openai',
    baseUrl: 'https://api.stepfun.com/v1',
    model: 'stepaudio-2.5-asr',
    keyUrl: 'https://platform.stepfun.com/interface-key',
    docsUrl: 'https://platform.stepfun.com/docs/zh/api-reference/audio/create-audio-transcriptions',
    get notes() { return mt('国内直连、中文口音稳；response_format 是必填项（模板已固定发 json）。') },
    dropIn: true
  },
  {
    id: 'zhipu',
    get name() { return mt('智谱 GLM') },
    kind: 'asr',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-asr-2512',
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-asr',
    get notes() { return mt('与 OpenAI 同形状；单条上限 25 MB 且时长不超过 30 秒，长录音要分次说。') },
    dropIn: true
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    asrAdapter: 'openrouter',
    kind: 'asr',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'elevenlabs/scribe-v2',
    keyUrl: 'https://openrouter.ai/settings/keys',
    docsUrl: 'https://openrouter.ai/docs/cookbook/audio/push-to-talk-button',
    get notes() { return mt('转写使用 JSON input_audio（Base64 WAV），模型须来自 OpenRouter 语音转文字目录。') },
    dropIn: true
  },
  {
    id: 'local',
    get name() { return mt('本地服务（自建 /v1/audio/transcriptions）') },
    kind: 'asr',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'Systran/faster-whisper-small',
    get notes() {
      return mt('本机跑的 OpenAI 兼容转写服务：Speaches（faster-whisper-server 的继任者，默认 8000）、faster-whisper-server、带 /v1/audio/transcriptions 的 GGUF 转写网关（如 llama-server 的 ASR 分支）。注意 llama.cpp 官方 server 本身没有音频路由。端口与模型名按服务实际改；不需要 API Key 时留空。')
    },
    dropIn: true
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    kind: 'asr',
    protocol: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    model: 'accounts/fireworks/models/whisper-v3',
    models: ['accounts/fireworks/models/whisper-v3', 'whisper-v3'],
    keyUrl: 'https://app.fireworks.ai/settings/users/api-keys',
    docsUrl: 'https://docs.fireworks.ai/api-reference/audio-transcriptions',
    get notes() { return mt('当前官方音频接口文档不可用；请先向供应商确认可用的语音端点与模型，聊天地址不代表支持转写。') },
    dropIn: true
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    asrAdapter: 'deepinfra',
    kind: 'asr',
    protocol: 'openai',
    baseUrl: 'https://api.deepinfra.com/v1/inference',
    model: 'openai/whisper-large-v3',
    models: ['openai/whisper-large-v3'],
    keyUrl: 'https://deepinfra.com/dash/api_keys',
    docsUrl: 'https://docs.deepinfra.com/apis/speech',
    get notes() { return mt('使用原生 /v1/inference/{模型} 接口和 audio 文件字段；与聊天的 OpenAI 兼容接口不同。') },
    dropIn: true
  },

  // ---- 以下不是 OpenAI multipart：每家一个适配器（main/providers/asr），
  // 字段数量与请求形态都不相同，所以预设只声明身份与默认值，请求由适配器负责。
  {
    id: 'cohere-transcribe',
    get name() { return mt('Cohere（转写）') },
    asrAdapter: 'cohere',
    kind: 'asr',
    protocol: 'openai',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    model: 'cohere-transcribe-03-2026',
    models: ['cohere-transcribe-03-2026'],
    keyUrl: 'https://dashboard.cohere.com/api-keys',
    docsUrl: 'https://docs.cohere.com/docs/compatibility-api',
    get notes() { return mt('使用 Cohere 转写接口；需要在语音设置中指定识别语言，不支持自动检测。') },
    dropIn: true
  },
  {
    id: 'minimax-asr',
    get name() { return mt('MiniMax（语音转文字）') },
    asrAdapter: 'minimax',
    kind: 'asr',
    protocol: 'openai',
    baseUrl: 'https://api.minimax.io/v1',
    model: 'asr-1.0',
    requestPath: 'speech_to_text',
    docsUrl: 'https://platform.minimax.io/docs/api-reference/speech-to-text',
    get notes() { return mt('使用 /v1/speech_to_text，语言放在 language 请求头，默认模型 asr-1.0。') },
    dropIn: true
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs Scribe',
    asrAdapter: 'elevenlabs',
    kind: 'asr',
    protocol: 'openai',
    baseUrl: 'https://api.elevenlabs.io/v1',
    model: 'scribe_v1',
    keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
    docsUrl: 'https://elevenlabs.io/docs/api-reference/speech-to-text/convert',
    get notes() { return mt('适配器用 xi-api-key 鉴权、model_id / language_code 字段，路径 /v1/speech-to-text。') },
    dropIn: true
  },
  {
    id: 'deepgram',
    name: 'Deepgram',
    asrAdapter: 'deepgram',
    kind: 'asr',
    protocol: 'openai',
    baseUrl: 'https://api.deepgram.com',
    model: 'nova-3',
    keyUrl: 'https://console.deepgram.com',
    docsUrl: 'https://developers.deepgram.com/docs/pre-recorded-audio',
    get notes() { return mt('适配器发裸音频字节（audio/wav），模型与参数走 query，鉴权是 Token 而不是 Bearer。') },
    dropIn: true
  },
  {
    id: 'assemblyai',
    name: 'AssemblyAI',
    asrAdapter: 'assemblyai',
    kind: 'asr',
    protocol: 'openai',
    baseUrl: 'https://api.assemblyai.com/v2',
    model: 'universal-2',
    models: ['universal-2', 'universal-3-5-pro'],
    keyUrl: 'https://www.assemblyai.com/app/api-keys',
    docsUrl: 'https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/submit',
    get notes() { return mt('适配器先 /v2/upload 再提交 transcript，然后轮询到 completed。') },
    dropIn: true
  },
  {
    id: 'gladia',
    name: 'Gladia',
    asrAdapter: 'gladia',
    kind: 'asr',
    protocol: 'openai',
    // Gladia has no model id: the uploaded file carries its own metadata.
    model: '',
    baseUrl: 'https://api.gladia.io/v2',
    keyUrl: 'https://app.gladia.io/account',
    docsUrl: 'https://docs.gladia.io/api-reference',
    get notes() { return mt('模型留空即可（引擎由这家接口自己决定）；适配器先 /v2/upload 拿 audio_url，再提交 pre-recorded 并轮询结果。') },
    dropIn: true
  },
  {
    id: 'speechmatics',
    name: 'Speechmatics',
    asrAdapter: 'speechmatics',
    kind: 'asr',
    protocol: 'openai',
    baseUrl: 'https://asr.api.speechmatics.com/v2',
    model: 'enhanced',
    docsUrl: 'https://docs.speechmatics.com/batch/requests',
    get notes() { return mt('适配器发 data_file + JSON config 的 multipart，并按 Job-ID 轮询转写文本。') },
    dropIn: true
  },
  {
    id: 'revai',
    name: 'Rev.ai',
    asrAdapter: 'revai',
    kind: 'asr',
    protocol: 'openai',
    // Rev.ai names models in the job options, not as a top-level field.
    model: '',
    baseUrl: 'https://api.rev.ai/speechtotext/v1',
    docsUrl: 'https://docs.rev.ai/api/speech-to-text',
    get notes() { return mt('模型留空即可（引擎由这家接口自己决定）；适配器提交 job 后轮询状态，再取 transcript 拼装文本。') },
    dropIn: true
  },
  {
    id: 'azure-openai',
    get name() { return mt('Azure OpenAI（转写）') },
    asrAdapter: 'azure-openai',
    kind: 'asr',
    protocol: 'openai',
    // Only the resource: the deployment name and api-version are adapter fields,
    // because Azure puts them in the path and the query rather than in a model id.
    baseUrl: 'https://RESOURCE.openai.azure.com',
    model: 'whisper',
    keyUrl: 'https://portal.azure.com',
    docsUrl: 'https://learn.microsoft.com/azure/ai-foundry/openai/reference',
    get notes() { return mt('适配器把部署名拼进路径、补 api-version，并用 api-key 头鉴权；下面填「Azure 部署名」。') },
    dropIn: true
  },
  {
    id: 'aliyun-asr',
    get name() { return mt('阿里云百炼（转写）') },
    asrAdapter: 'aliyun',
    kind: 'asr',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com',
    model: 'qwen3-asr-flash',
    keyUrl: 'https://bailian.console.aliyun.com/model/settings/api-key',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/qwen-asr',
    get notes() { return mt('Qwen ASR Flash 直接提交音频；Paraformer / Filetrans 使用上传地址和异步任务。地域和业务空间须与密钥匹配。') },
    dropIn: true
  },
  {
    id: 'aliyun-paraformer',
    get name() { return mt('阿里云百炼（Paraformer 录音文件）') },
    asrAdapter: 'aliyun',
    kind: 'asr',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com',
    model: 'paraformer-v2',
    models: ['paraformer-v2', 'paraformer-8k-v2', 'paraformer-v1'],
    keyUrl: 'https://bailian.console.aliyun.com/model/settings/api-key',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/paraformer-recorded-speech-recognition-restful',
    get notes() { return mt('异步任务接口只收 file_urls，必须在「上传地址」填一个阿里能回源读取的公网地址（OSS 等），否则这条配置无法使用。') },
    dropIn: false
  },
  {
    id: 'aliyun-realtime-asr',
    get name() { return mt('阿里云百炼（实时识别）') },
    asrAdapter: 'dashscope-realtime',
    kind: 'asr',
    protocol: 'openai',
    // https on purpose: the adapter upgrades the scheme itself, and a `wss://`
    // base URL would make the connection tester send an HTTP probe that cannot
    // be answered.
    baseUrl: 'https://dashscope.aliyuncs.com/api-ws/v1/inference',
    model: 'paraformer-realtime-v2',
    models: ['paraformer-realtime-v2', 'paraformer-realtime-v1', 'paraformer-realtime-8k-v2', 'gummy-realtime-v1'],
    keyUrl: 'https://bailian.console.aliyun.com/model/settings/api-key',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/paraformer-real-time-speech-recognition-api',
    get notes() { return mt('WebSocket 流式：run-task → PCM 帧 → finish-task，音频直接上传，不需要 OSS。') },
    dropIn: true
  },
  {
    id: 'tencent-asr',
    get name() { return mt('腾讯云（一句话识别）') },
    asrAdapter: 'tencent',
    kind: 'asr',
    protocol: 'openai',
    // Tencent picks the engine through X-TC-Action, so there is no model field.
    model: '',
    baseUrl: 'https://asr.tencentcloudapi.com',
    docsUrl: 'https://cloud.tencent.com/document/product/1093/35646',
    get notes() { return mt('模型留空即可（引擎由这家接口自己决定，16k_zh 已在适配器里定好）；适配器自己算 TC3-HMAC-SHA256 签名。') },
    dropIn: true
  },
  {
    id: 'tencent-realtime-asr',
    get name() { return mt('腾讯云（实时语音识别）') },
    asrAdapter: 'tencent-realtime',
    kind: 'asr',
    protocol: 'openai',
    // The engine (16k_zh …) is a vendor field here, not the model id.
    model: '',
    baseUrl: 'https://asr.cloud.tencent.com/asr/v2',
    keyUrl: 'https://console.cloud.tencent.com/cam/capi',
    docsUrl: 'https://cloud.tencent.com/document/product/1093/48982',
    get notes() { return mt('WebSocket 流式：边录边出字，整段录音回放也能用（比一句话识别快、按并发计费）。模型留空即可，引擎在下面的「引擎」字段里填；签名在本地算，需要 SecretId + SecretKey + AppID。') },
    dropIn: true
  },
  {
    id: 'volcengine-streaming-asr',
    get name() { return mt('火山引擎（豆包流式识别）') },
    asrAdapter: 'volcengine-streaming',
    kind: 'asr',
    protocol: 'openai',
    model: '',
    baseUrl: 'https://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
    keyUrl: 'https://console.volcengine.com/speech/service/16',
    docsUrl: 'https://www.volcengine.com/docs/6561/1354869',
    get notes() { return mt('新版控制台只填上面的 API Key，App ID 与 Access Token 留空即可。模型栏填 bigmodel 或留空。流式识别 2.0 与 1.0 地址与报文相同，只差 Resource Id：2.0 填 volc.seedasr.sauc.duration，1.0 填 volc.bigasr.sauc.duration。') },
    dropIn: true
  },
  {
    id: 'iflytek',
    get name() { return mt('科大讯飞（语音听写）') },
    asrAdapter: 'xfyun',
    kind: 'asr',
    protocol: 'openai',
    // 讯飞按 domain/business 选引擎，没有 model 字段。
    model: '',
    baseUrl: 'https://iat-api.xfyun.cn/v2',
    docsUrl: 'https://www.xfyun.cn/doc/spark/asr_llm/API.html',
    get notes() { return mt('模型留空即可（引擎由这家接口自己决定）；适配器走 wss://iat-api.xfyun.cn/v2/iat 的帧协议，签名与分帧都在本机完成。') },
    dropIn: true
  },
  {
    id: 'baidu-asr',
    get name() { return mt('百度短语音识别') },
    asrAdapter: 'baidu',
    kind: 'asr',
    protocol: 'openai',
    // 百度的识别类型由 dev_pid 决定，没有 model 字段。
    model: '',
    baseUrl: 'https://vop.baidu.com/server_api',
    docsUrl: 'https://ai.baidu.com/ai-doc/SPEECH/Jk5dll5g2',
    get notes() { return mt('模型留空即可（引擎由这家接口自己决定，dev_pid 由适配器选）；适配器先用两个 Key 换 access_token。') },
    dropIn: true
  },
  {
    id: 'replicate',
    name: 'Replicate',
    asrAdapter: 'replicate',
    kind: 'asr',
    protocol: 'openai',
    // Replicate is addressed by model version hash, not by a model id.
    model: '',
    baseUrl: 'https://api.replicate.com/v1',
    docsUrl: 'https://replicate.com/docs/reference/http',
    get notes() { return mt('模型填 owner/name（默认 openai/whisper），留空即用默认；适配器用 data URI 提交预测，必要时轮询状态。') },
    dropIn: true
  },
  {
    id: 'fal',
    name: 'fal.ai',
    asrAdapter: 'fal',
    kind: 'asr',
    protocol: 'openai',
    baseUrl: 'https://fal.run',
    model: 'fal-ai/whisper',
    docsUrl: 'https://fal.ai/models/fal-ai/whisper/api',
    get notes() { return mt('适配器用 data URI 走 fal.run 的 whisper 端点。') },
    dropIn: true
  }
]

const LLM_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    get name() { return mt('DeepSeek 深度求索') },
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    docsUrl: 'https://api-docs.deepseek.com/',
    get notes() { return mt('官方根地址不带 /v1，直接 POST /chat/completions。国内直连。') },
    dropIn: true
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.5',
    models: ['gpt-5.5', 'gpt-4o-mini'],
    keyUrl: 'https://platform.openai.com/settings/organization/api-keys',
    docsUrl: 'https://platform.openai.com/docs/api-reference/introduction',
    get notes() { return mt('国内需代理。') },
    dropIn: true
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.anthropic.com/v1/',
    model: 'claude-sonnet-5-5',
    models: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'],
    keyUrl: 'https://platform.claude.com/settings/keys',
    docsUrl: 'https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk',
    get notes() { return mt('走官方 OpenAI 兼容层（base 带尾斜杠）；忽略 response_format，n 必须为 1。') },
    dropIn: true
  },
  {
    id: 'google-gemini',
    name: 'Google Gemini',
    kind: 'llm',
    protocol: 'openai',
    // Gemini has an OpenAI-compatible surface; the native generateContent one
    // only answers on /models/{model}:generateContent and would 404 here.
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.8-flash',
    models: ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-pro'],
    keyUrl: 'https://aistudio.google.com/app/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    get notes() { return mt('走 Gemini 的 OpenAI 兼容层（/v1beta/openai），Bearer 鉴权。') },
    dropIn: true
  },
  {
    id: 'groq',
    name: 'Groq',
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile'],
    keyUrl: 'https://console.groq.com/keys',
    docsUrl: 'https://console.groq.com/docs/openai',
    get notes() { return mt('忽略 logprobs/logit_bias，n 必须为 1。') },
    dropIn: true
  },
  {
    id: 'siliconflow',
    get name() { return mt('硅基流动 SiliconFlow') },
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V4-Flash',
    models: ['deepseek-ai/DeepSeek-V4-Flash', 'zai-org/GLM-5.2'],
    docsUrl: 'https://docs.siliconflow.cn/docs/api/chat-completions-post',
    get notes() { return mt('国内直连，模型 id 带命名空间前缀。') },
    dropIn: true
  },
  {
    id: 'moonshot',
    get name() { return mt('月之暗面 Kimi') },
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k3',
    models: ['kimi-k3', 'kimi-k2.6'],
    docsUrl: 'https://platform.kimi.com/docs/api/chat',
    get notes() { return mt('国内直连；content 支持 image_url/video_url。') },
    dropIn: true
  },
  {
    id: 'zhipu',
    get name() { return mt('智谱 BigModel') },
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
    model: 'glm-5.3',
    models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx'],
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
    get notes() { return mt('国内直连；官方 base 带尾斜杠。') },
    dropIn: true
  },
  {
    id: 'aliyun-dashscope',
    get name() { return mt('阿里云百炼') },
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-max',
    models: ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.5-flash'],
    keyUrl: 'https://bailian.console.aliyun.com/model/settings/api-key',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
    get notes() { return mt('国内直连；Key 与地域绑定，跨地域会 401。') },
    dropIn: true
  },
  {
    id: 'volcengine-ark',
    get name() { return mt('火山方舟') },
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-2-1-pro-260915',
    models: ['doubao-seed-2-1-pro-260915'],
    docsUrl: 'https://docs.volcengine.com/docs/ark/compatible-with-openai-sdk?lang=zh',
    get notes() { return mt('国内直连；model 必须是已开通的模型或推理接入点 id。') },
    dropIn: true
  },
  {
    id: 'tencent-hunyuan',
    get name() { return mt('腾讯混元') },
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    model: 'hunyuan-turbos-latest',
    models: ['hunyuan-turbos-latest'],
    docsUrl: 'https://cloud.tencent.com/document/product/1729/111007',
    get notes() { return mt('国内直连；stop 语义与 OpenAI 相反（停在匹配内容之后）。') },
    dropIn: true
  },
  {
    id: 'baidu-qianfan',
    get name() { return mt('百度千帆') },
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    model: 'deepseek-v3.1-250821',
    models: ['deepseek-v3.1-250821'],
    docsUrl: 'https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb',
    get notes() { return mt('Key 形如 bce-v3/ALTAK-...，支持 thinking 与 web_search。') },
    dropIn: true
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: '',
    keyUrl: 'https://openrouter.ai/settings/keys',
    docsUrl: 'https://openrouter.ai/docs/api-reference/overview',
    get notes() { return mt('模型 id 形如 vendor/model；点「获取模型列表」再选。可选 HTTP-Referer 头。') },
    dropIn: true
  },
  {
    id: 'together',
    name: 'Together AI',
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.together.ai/v1',
    model: 'openai/gpt-oss-120b',
    models: ['openai/gpt-oss-120b', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    keyUrl: 'https://api.together.ai/settings/projects/~current/api-keys',
    docsUrl: 'https://docs.together.ai/docs/inference/openai-compatibility',
    get notes() { return mt('不支持 assistants/moderations；logit_bias 多数模型不支持。') },
    dropIn: true
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
    models: ['accounts/fireworks/models/llama-v3p1-8b-instruct'],
    keyUrl: 'https://app.fireworks.ai/settings/users/api-keys',
    docsUrl: 'https://docs.fireworks.ai/tools-sdks/openai-compatibility',
    get notes() { return mt('模型 id 形如 accounts/fireworks/models/<name>。') },
    dropIn: true
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    models: ['deepseek-ai/DeepSeek-V4-Flash-0731'],
    keyUrl: 'https://deepinfra.com/dash/api_keys',
    docsUrl: 'https://docs.deepinfra.com/chat/overview',
    get notes() { return mt('兼容根是 /v1/openai，不是 /v1。') },
    dropIn: true
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    model: 'gpt-oss-120b',
    models: ['gpt-oss-120b', 'qwen-3.8-27b'],
    keyUrl: 'https://cloud.cerebras.ai',
    docsUrl: 'https://inference-docs.cerebras.ai/api-reference/chat-completions',
    get notes() { return mt('速度极快；n 只支持 1。') },
    dropIn: true
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-medium-3-5',
    models: ['mistral-medium-3-5', 'mistral-large-4', 'mistral-small-2603'],
    keyUrl: 'https://console.mistral.ai/api-keys',
    docsUrl: 'https://docs.mistral.ai/api/',
    get notes() { return mt('国际站，国内需代理。') },
    dropIn: true
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-4.7',
    models: ['grok-4.7', 'grok-4.6'],
    keyUrl: 'https://console.x.ai',
    docsUrl: 'https://docs.x.ai/developers/models.md',
    get notes() { return mt('国际站；-latest 是滚动别名。') },
    dropIn: true
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.perplexity.ai',
    model: 'sonar',
    models: ['sonar'],
    keyUrl: 'https://www.perplexity.ai/settings/api',
    docsUrl: 'https://docs.perplexity.ai/getting-started/quickstart',
    get notes() { return mt('OpenAI 兼容 chat（/chat/completions）。新的 Agent API 在 /router/v1，形状不同，本客户端不用它。') },
    dropIn: true
  },
  {
    id: 'sambanova',
    name: 'SambaNova',
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.sambanova.ai/v1',
    model: 'Meta-Llama-3.3-70B-Instruct',
    models: ['Meta-Llama-3.3-70B-Instruct'],
    keyUrl: 'https://cloud.sambanova.ai/apis',
    docsUrl: 'https://docs.sambanova.ai/docs/en/get-started/api-keys-urls',
    get notes() { return mt('官方明示可配 OpenAI 客户端。') },
    dropIn: true
  },
  {
    id: 'novita',
    name: 'Novita AI',
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.novita.ai/openai',
    model: '',
    docsUrl: 'https://novita.ai/docs/api-reference/model-apis-llm-create-chat-completion.md',
    get notes() { return mt('兼容根是 /openai；模型 id 请点「获取模型列表」。') },
    dropIn: true
  },
  {
    id: 'upstage',
    name: 'Upstage',
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.upstage.ai/v1',
    model: 'solar-pro4',
    models: ['solar-pro4', 'solar-mini-4'],
    docsUrl: 'https://developers.upstage.ai/docs/getting-started/quick-start',
    get notes() { return mt('Solar Pro 2/3 已下线，用 solar-pro4。') },
    dropIn: true
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.minimax.cn/v1',
    model: 'MiniMax-M3.1-Flash',
    models: ['MiniMax-M3.1-Flash', 'MiniMax-M3'],
    keyUrl: 'https://platform.minimax.cn/user-center/basic-information/interface-key',
    docsUrl: 'https://platform.minimax.io/docs/api-reference/text-chat-openai',
    get notes() { return mt('使用 /v1/chat/completions；M3 推理默认开启，最低深度为 low。') },
    dropIn: true
  },
  {
    id: 'nebius',
    name: 'Nebius Token Factory',
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.tokenfactory.nebius.com/v1/',
    model: '',
    docsUrl: 'https://docs.nebius.com/studio/inference/api',
    get notes() { return mt('官方 base 带尾斜杠；模型 id 请点「获取模型列表」。') },
    dropIn: true
  },
  {
    id: 'local',
    get name() { return mt('本地部署（LM Studio / Ollama / llama.cpp）') },
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'qwen2.5-7b-instruct',
    keyUrl: '',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    get notes() { return mt('本机不需要 API Key，留空即可；地址和模型名按你实际起的服务改（LM Studio 默认 1234 端口，Ollama 是 11434）。') },
    dropIn: true
  },
  {
    id: 'ollama',
    name: 'Ollama',
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3:8b',
    models: ['qwen3:8b', 'llama3.2:3b', 'gemma3:4b'],
    docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
    get notes() { return mt('Ollama 自带的 /v1 兼容层，不需要 Key；模型名就是 `ollama list` 里那一列（要带 :tag）。') },
    dropIn: true
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: '',
    docsUrl: 'https://lmstudio.ai/docs/app/api/endpoints/openai',
    get notes() { return mt('要先在 LM Studio 里 Start Server；模型 id 随加载的那个变，点「获取模型列表」取。') },
    dropIn: true
  },
  {
    id: 'vllm',
    get name() { return mt('vLLM（本机服务）') },
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: '',
    docsUrl: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html',
    get notes() { return mt('vLLM 默认 8000 端口；模型名 = 启动时 --served-model-name 的值，不确定就点「获取模型列表」。') },
    dropIn: true
  },
  {
    id: 'cohere',
    name: 'Cohere',
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    model: 'command-a-plus-05-2026',
    models: ['command-a-plus-05-2026', 'command-r-plus-08-2024'],
    keyUrl: 'https://dashboard.cohere.com/api-keys',
    docsUrl: 'https://docs.cohere.com/docs/compatibility-api',
    get notes() { return mt('兼容层只认 reasoning_effort=none/high（medium、low 会 400），系统提示走 developer 角色而不是 system。') },
    dropIn: true
  },
  {
    id: 'stepfun',
    get name() { return mt('阶跃星辰 StepFun') },
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.stepfun.com/v1',
    model: 'step-3.7-flash',
    models: ['step-3.7-flash', 'step-3.5-flash', 'step-5-preview', 'step-1o-turbo-vision'],
    keyUrl: 'https://platform.stepfun.com/interface-key',
    docsUrl: 'https://platform.stepfun.com/docs/zh/guides/models/list',
    get notes() { return mt('和上面的转写预设共用一个 Key；step-5-preview 上下文 1M，step-3.7-flash 支持图片输入。') },
    dropIn: true
  },
  {
    id: 'xfyun-spark',
    get name() { return mt('讯飞星火（HTTP）') },
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://spark-api-open.xf-yun.com/v1',
    model: '',
    keyUrl: 'https://console.xfyun.cn/services/cbm',
    docsUrl: 'https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html',
    get notes() { return mt('这是星火的 HTTP 版（不是 wss 实时接口，那个连不上）；模型 id 按控制台手填，如 generalv3.5、4.0Ultra。') },
    dropIn: true
  },
  {
    id: 'yi',
    get name() { return mt('零一万物 Yi') },
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.lingyiwanwu.com/v1',
    model: '',
    keyUrl: 'https://platform.lingyiwanwu.com/apikeys',
    docsUrl: 'https://platform.lingyiwanwu.com/docs',
    get notes() { return mt('模型 id 形如 yi-lightning / yi-large，按控制台手填（各账号可见的型号不同）。') },
    dropIn: true
  },
  {
    id: 'baichuan',
    get name() { return mt('百川智能 Baichuan') },
    kind: 'llm',
    protocol: 'openai',
    baseUrl: 'https://api.baichuan-ai.com/v1',
    model: '',
    keyUrl: 'https://platform.baichuan-ai.com/console/apikey',
    docsUrl: 'https://platform.baichuan-ai.com/docs/api',
    get notes() { return mt('模型 id 按控制台手填（Baichuan4 系列），接口本身是 OpenAI 兼容的 /chat/completions。') },
    dropIn: true
  }
]

const MULTIMODAL_PRESETS: ProviderPreset[] = [
  {
    id: 'google-gemini',
    get name() { return mt('Google Gemini（多模态）') },
    kind: 'multimodal',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.8-flash',
    models: ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-pro'],
    keyUrl: 'https://aistudio.google.com/app/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/audio',
    get notes() { return mt('原生 generateContent，音频直接进模型（无需 ASR）。') },
    dropIn: true
  }
]

/** Every built-in preset, in declaration order — the catalogue the tests audit. */
export function allPresets(): ProviderPreset[] {
  return [...ASR_PRESETS, ...LLM_PRESETS, ...MULTIMODAL_PRESETS]
}

/** The id the "build it yourself" entry answers to. */
export const CUSTOM_PRESET_ID = 'custom'

/** Links come from vendor metadata, never the editable API endpoint. */
export function providerLinks(preset: ProviderPreset): { website: string; docs?: string; key?: string; local: boolean } | null {
  if (preset.id === CUSTOM_PRESET_ID || preset.id === 'local') return null
  const key = preset.keyUrl || allPresets().find(item => item.id === preset.id && item.keyUrl)?.keyUrl
  const url = key || preset.docsUrl
  if (!url) return null
  return { website: new URL(url).origin, docs: preset.docsUrl, key, local: ['ollama', 'lmstudio', 'vllm'].includes(preset.id) }
}

/**
 * A blank connection whose every field belongs to the user.
 *
 * This is what makes local servers and self-hosted gateways first class: with
 * vendor presets alone, "llama.cpp on my own box" is not a provider at all.
 */
export function customPreset(kind: ProviderKind): ProviderPreset {
  return {
    id: CUSTOM_PRESET_ID,
    name: mt('自定义（自己填地址）'),
    kind,
    protocol: kind === 'multimodal' ? 'gemini' : 'openai',
    baseUrl: '',
    model: '',
    notes: mt('自己填 Base URL 与模型；本机服务不需要 Key，留空即可。'),
    dropIn: true
  }
}

/** Presets for one kind: the blank entry first, then drop-in vendors. */
export function presetsFor(kind: ProviderKind): ProviderPreset[] {
  const mine = allPresets().filter((preset) => preset.kind === kind)
  return [customPreset(kind), ...mine.filter((preset) => preset.dropIn), ...mine.filter((preset) => !preset.dropIn)]
}

export function findPreset(id: string, kind?: ProviderKind): ProviderPreset | undefined {
  if (id === CUSTOM_PRESET_ID) return undefined
  return allPresets().find((preset) => preset.id === id && (!kind || preset.kind === kind))
}

/** Applies a preset to a profile draft: fills the connection, leaves the key. */
export function presetDraft(preset: ProviderPreset): {
  baseUrl: string
  model: string
  extraHeaders?: string
  authHeader?: 'x-api-key'
  requestPath?: string
} {
  return {
    baseUrl: preset.baseUrl,
    model: preset.model,
    ...(preset.headers ? { extraHeaders: preset.headers } : {}),
    ...(preset.authHeader ? { authHeader: preset.authHeader } : {}),
    ...(preset.requestPath ? { requestPath: preset.requestPath } : {})
  }
}
