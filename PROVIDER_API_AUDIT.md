# 供应商 API 核对

核对版本：0.22.0；日期：2026-10-22。

范围是客户端目录中的 26 个 ASR、34 个 LLM 和 1 个多模态预设。测试检查客户端实际发送的地址、鉴权、表单 / JSON 字段和响应解析；专用适配器测试也覆盖上传、轮询和签名。**协议测试通过不代表已用各家真实账号调用成功**，本次未使用全部供应商的付费密钥。模型开放范围、地域、账号权限、计费和服务端限额仍由供应商决定。自建服务需以部署的实际协议为准。

## 已修正的协议差异

| 服务 | 当前实现 | 官方依据 |
| --- | --- | --- |
| Mistral ASR | Bearer 鉴权；旧配置中的 x-api-key 在官方主机上纠正；自定义网关仍尊重显式鉴权设置 | [转写 API](https://docs.mistral.ai/api/endpoint/audio/transcriptions) |
| MiniMax ASR | `/v1/speech_to_text`，multipart `file` / `model`，可选 `language` 请求头，默认 `asr-1.0` | [Speech to Text](https://platform.minimax.io/docs/api-reference/speech-to-text) |
| DeepInfra ASR | `/v1/inference/{模型}`，multipart 文件字段为 `audio`；兼容旧预设保存的 `/v1/openai` 根地址 | [Speech Recognition](https://docs.deepinfra.com/apis/speech) |
| OpenRouter ASR | `/api/v1/audio/transcriptions`，JSON `input_audio`，Base64 WAV；新配置使用文档中的 `elevenlabs/scribe-v2`。已有用户选择的模型不擅自替换，需要是该平台实际支持的语音模型 | [官方录音示例](https://openrouter.ai/docs/cookbook/audio/push-to-talk-button) |
| 阿里云 ASR | Qwen3 ASR Flash 使用同步 multimodal-generation 和内联 WAV；Paraformer / Filetrans 沿用上传 URL、异步任务和轮询。Flash 不再强制要求上传地址，校验 5 分钟 / 编码后 10 MB 限额 | [Qwen ASR API](https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference) |
| Cohere ASR | 保持 compatibility/v1 的正确路径，原生根使用 v2；必填语言来自语音设置，不用 `auto` 冒充；文件位于 multipart 最后 | [Compatibility API](https://docs.cohere.com/docs/compatibility-api) |
| AssemblyAI ASR | 使用 `speech_models` 数组；旧 `best` 配置映射到文档支持的模型列表，新预设使用 `universal-2` | [Transcribe Audio](https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/submit) |
| OpenAI LLM | 推理模型使用 `max_completion_tokens`，按模型处理推理档位与温度；普通聊天模型不接收通用 `thinking` 字段 | [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) |
| Cohere / Gemini / Mistral LLM | 分别处理 developer 角色、支持的推理档位和关闭方式，避免混用 `thinking` 参数 | [Cohere](https://docs.cohere.com/docs/compatibility-api)、[Gemini](https://ai.google.dev/gemini-api/docs/openai)、[Mistral](https://docs.mistral.ai/api/endpoint/chat) |
| Claude LLM | 新模型省略不支持的温度；官方兼容端点忽略 reasoning_effort，因此不把该参数当作已生效的控制 | [OpenAI SDK compatibility](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk) |
| MiniMax LLM | 新预设使用 chat/completions；官方主机的旧内置路径也改走该接口，自定义网关自选路径保持；M3 推理最低 low | [Chat API](https://platform.minimax.io/docs/api-reference/text-chat-openai) |
| DeepSeek 工具调用 | 将供应商返回的 reasoning_content 随下一轮工具历史传回，不显示到最终答案 | [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) |
| Gemini 多模态 | 原生 generateContent、x-goog-api-key、Base64 WAV、单次请求总量上限 20 MB；支持取消和超时，排除 thought 文本 | [Audio input](https://ai.google.dev/gemini-api/docs/generate-content/audio) |
| Tavily / Brave 搜索 | Tavily 使用 Bearer；Brave freshness 使用 pd/pw/pm/py；多连接复用原有各服务适配器 | [Tavily](https://docs.tavily.com/documentation/api-reference/endpoint/search)、[Brave](https://api-dashboard.search.brave.com/app/documentation/web-search/codes) |

## 未能确认的项目与使用条件

- **Fireworks ASR**：旧 `/audio/transcriptions` 文档返回 404，当前官方索引的音频说明是专属部署的多模态聊天输入，不能据此证明旧 Whisper 转写端点仍可用。预设已去掉“音频与聊天同地址可直接使用”的承诺，旧配置不删除。使用前需要供应商确认实际语音端点与模型；本次不宣称此项可用。[当前官方说明](https://docs.fireworks.ai/guides/video-audio-inputs)
- StepFun 的 ASR 文档本次无法读取，现有 OpenAI multipart 协议已做本地请求测试，真实服务端约束仍待账号验证。
- 腾讯、百度和讯飞是各自专用语音产品；一分钟短音频等供应商限额不因客户端会话上限而扩大。腾讯当前固定中文引擎；讯飞为 IAT 帧协议，不是大模型听写接口。
- Azure 必须填写真实资源地址、部署名与 API 版本；阿里云地址、业务空间、模型和密钥必须属于同一可用地域。Replicate / fal 使用可用的实际模型或部署。
- 全部 LLM 预设通过本地传输契约测试；这不证明目录中的每个模型对每个账号均开放，也不证明每家模型都支持工具、流式、思考或温度的全部组合。不支持工具时沿用现有 JSON 意图回退。本轮未把 Chat Completions 重构为 Responses。
- 密钥只在本机配置；本次未批量开通账号、核验免费额度或消耗所有供应商的真实调用配额。
- 四家流式适配器里已有三家用真实账号验证过（百炼、豆包、讯飞实时转写）：2026-10-29 用 16 kHz 单声道 PCM16 的 9.86 秒合成录音回放，返回文本与待识别句子逐字一致，用时 2.99 秒。同一账号的百炼专属地址（`*.maas.aliyuncs.com`）返回 `AllocationQuota.FreeTierOnly`（免费额度已耗尽），而公网 `dashscope.aliyuncs.com` 地址可用，因此预设指向公网地址；这属于账号配额状态，不是协议问题。腾讯云实时识别只有本地协议测试，未申请账号验证真实返回。火山引擎豆包流式识别在 2026-10-29 用真实账号验证：新版控制台只给一个 API Key（`X-Api-Key` + `X-Api-Resource-Id: volc.seedasr.sauc.duration`），不再需要 App ID 与 Access Token；5.40 秒合成录音回放得到 `definite` 结果「这是一段用于测试火山引擎流式语音识别的录音。」，报文为 gzip JSON + 二进制音频包，2.0 与 1.0 只差 Resource Id。

## 目录与验证覆盖

下面列出全部内置预设。`本地协议测试` 表示使用受控传输或本地 HTTP / WebSocket 服务验证请求和解析；`本地契约测试` 表示通过模拟响应验证聊天传输。两者均不表示真实账号联通验证。文档链接是对应预设的参考入口，无法访问的条目在上方单独说明。

### ASR（30）

| 预设 | 协议 | 覆盖 | 文档 |
| --- | --- | --- | --- |
| OpenAI | Bearer / multipart file/model | 本地协议测试 | [官方参考](https://platform.openai.com/docs/guides/speech-to-text) |
| Groq | Bearer / multipart file/model | 本地协议测试 | [官方参考](https://console.groq.com/docs/speech-to-text) |
| 硅基流动 | Bearer / multipart file/model | 本地协议测试 | [官方参考](https://docs.siliconflow.cn/docs/api/audio-transcriptions-post) |
| Together AI | Bearer / multipart file/model | 本地协议测试 | [官方参考](https://docs.together.ai/reference/audio-transcriptions) |
| Mistral AI | Bearer / multipart file/model | 本地协议测试 | [官方参考](https://docs.mistral.ai/capabilities/audio/) |
| 阶跃星辰 StepFun | Bearer / multipart file/model | 本地协议测试 | [官方参考](https://platform.stepfun.com/docs/zh/api-reference/audio/create-audio-transcriptions) |
| 智谱 GLM | Bearer / multipart file/model | 本地协议测试 | [官方参考](https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-asr) |
| OpenRouter | JSON input_audio | 本地协议测试 | [官方参考](https://openrouter.ai/docs/cookbook/audio/push-to-talk-button) |
| 本地服务（自建 /v1/audio/transcriptions） | Bearer / multipart file/model | 本地协议测试 | 按本地部署配置 |
| Fireworks AI | Bearer / multipart file/model | 本地协议测试；现网接口未确认 | [官方参考](https://docs.fireworks.ai/api-reference/audio-transcriptions) |
| DeepInfra | 原生 inference / audio | 本地协议测试 | [官方参考](https://docs.deepinfra.com/apis/speech) |
| Cohere（转写） | multipart / 必填语言 | 本地协议测试 | [官方参考](https://docs.cohere.com/docs/compatibility-api) |
| MiniMax（语音转文字） | speech_to_text / language 头 | 本地协议测试 | [官方参考](https://platform.minimax.io/docs/api-reference/speech-to-text) |
| ElevenLabs Scribe | xi-api-key / model_id | 本地协议测试 | [官方参考](https://elevenlabs.io/docs/api-reference/speech-to-text/convert) |
| Deepgram | Token / 原始 WAV | 本地协议测试 | [官方参考](https://developers.deepgram.com/docs/pre-recorded-audio) |
| AssemblyAI | 上传 / speech_models / 轮询 | 本地协议测试 | [官方参考](https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/submit) |
| Gladia | 上传 / 轮询 | 本地协议测试 | [官方参考](https://docs.gladia.io/api-reference) |
| Speechmatics | data_file / config / job | 本地协议测试 | [官方参考](https://docs.speechmatics.com/batch/requests) |
| Rev.ai | job / 轮询 / transcript | 本地协议测试 | [官方参考](https://docs.rev.ai/api/speech-to-text) |
| Azure OpenAI（转写） | api-key / deployment / api-version | 本地协议测试 | [官方参考](https://learn.microsoft.com/azure/ai-foundry/openai/reference) |
| 阿里云百炼（转写） | 同步音频或异步 URL | 本地协议测试 | [官方参考](https://help.aliyun.com/zh/model-studio/qwen-asr) |
| 腾讯云语音识别 | TC3 签名 / SentenceRecognition | 本地协议测试 | [官方参考](https://cloud.tencent.com/document/product/1093/35646) |
| 科大讯飞（语音听写） | HMAC / WebSocket 帧 | 本地协议测试 | [官方参考](https://www.xfyun.cn/doc/spark/asr_llm/API.html) |
| 百度短语音识别 | OAuth / Base64 JSON | 本地协议测试 | [官方参考](https://ai.baidu.com/ai-doc/SPEECH/Jk5dll5g2) |
| Replicate | Bearer / data URI / prediction | 本地协议测试 | [官方参考](https://replicate.com/docs/reference/http) |
| fal.ai | Key / data URI | 本地协议测试 | [官方参考](https://fal.ai/models/fal-ai/whisper/api) |
| 阿里云百炼（paraformer-v2 录音文件） | 异步 file_urls / 先上传 | 本地协议测试 | [官方参考](https://help.aliyun.com/zh/model-studio/paraformer-recorded-speech-recognition-api) |
| 阿里云百炼（实时识别） | WebSocket 二进制帧 / run-task→finish-task | 真实账号联调（2026-10-29，9.86 秒音频回放，输出与预期一致） | [官方参考](https://help.aliyun.com/zh/model-studio/paraformer-real-time-speech-recognition-api) |
| 腾讯云实时识别 | WebSocket / HMAC-SHA1 查询串签名 | 本地协议测试 | [官方参考](https://cloud.tencent.com/document/product/1093/48982) |
| 火山引擎豆包流式识别 | WebSocket 二进制帧 / gzip JSON | 真实账号联调（新版控制台 API Key） | [官方参考](https://www.volcengine.com/docs/6561/1354869) |
| 科大讯飞实时语音转写 | WebSocket / 文本 JSON + 裸 PCM / APIKey 签名 | 真实账号联调（2026-10-29，RTA 新用户免费包，逐句返回与预期一致） | [官方参考](https://www.xfyun.cn/doc/asr/rtasr/API.html) |

### LLM（34）

| 预设 | 协议 | 覆盖 | 文档 |
| --- | --- | --- | --- |
| DeepSeek 深度求索 | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://api-docs.deepseek.com/) |
| OpenAI | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://platform.openai.com/docs/api-reference/introduction) |
| Anthropic Claude | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk) |
| Google Gemini | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://ai.google.dev/gemini-api/docs/openai) |
| Groq | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://console.groq.com/docs/openai) |
| 硅基流动 SiliconFlow | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://docs.siliconflow.cn/docs/api/chat-completions-post) |
| 月之暗面 Kimi | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://platform.kimi.com/docs/api/chat) |
| 智谱 BigModel | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction) |
| 阿里云百炼 | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope) |
| 火山方舟 | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://docs.volcengine.com/docs/ark/compatible-with-openai-sdk?lang=zh) |
| 腾讯混元 | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://cloud.tencent.com/document/product/1729/111007) |
| 百度千帆 | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb) |
| OpenRouter | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://openrouter.ai/docs/api-reference/overview) |
| Together AI | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://docs.together.ai/docs/inference/openai-compatibility) |
| Fireworks AI | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://docs.fireworks.ai/tools-sdks/openai-compatibility) |
| DeepInfra | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://docs.deepinfra.com/chat/overview) |
| Cerebras | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://inference-docs.cerebras.ai/api-reference/chat-completions) |
| Mistral AI | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://docs.mistral.ai/api/) |
| xAI Grok | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://docs.x.ai/developers/models.md) |
| Perplexity | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://docs.perplexity.ai/getting-started/quickstart) |
| SambaNova | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://docs.sambanova.ai/docs/en/get-started/api-keys-urls) |
| Novita AI | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://novita.ai/docs/api-reference/model-apis-llm-create-chat-completion.md) |
| Upstage | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://developers.upstage.ai/docs/getting-started/quick-start) |
| MiniMax | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://platform.minimax.io/docs/api-reference/text-chat-openai) |
| Nebius Token Factory | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://docs.nebius.com/studio/inference/api) |
| 本地部署（LM Studio / Ollama / llama.cpp） | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://platform.openai.com/docs/api-reference/chat) |
| Ollama | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://github.com/ollama/ollama/blob/main/docs/openai.md) |
| LM Studio | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://lmstudio.ai/docs/app/api/endpoints/openai) |
| vLLM（本机服务） | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html) |
| Cohere | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://docs.cohere.com/docs/compatibility-api) |
| 阶跃星辰 StepFun | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://platform.stepfun.com/docs/zh/guides/models/list) |
| 讯飞星火（HTTP） | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html) |
| 零一万物 Yi | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://platform.lingyiwanwu.com/docs) |
| 百川智能 Baichuan | Bearer / chat/completions / choices | 本地契约测试 | [官方参考](https://platform.baichuan-ai.com/docs/api) |

### MULTIMODAL（1）

| 预设 | 协议 | 覆盖 | 文档 |
| --- | --- | --- | --- |
| Google Gemini（多模态） | x-goog-api-key / generateContent | 本地协议测试 | [官方参考](https://ai.google.dev/gemini-api/docs/audio) |

### TTS（2026-10-28 补充）

下列接口均通过本地 HTTP 服务验证请求与响应解析，音频播放另经 Chromium 实测开始、暂停、继续、停止和结束。未使用这些供应商的真实付费账号；实际模型、音色授权及区域仍需账号验证。Windows 系统朗读继续保留，连接配置由用户自行填写。

| 提供商 | 协议及解析 | 官方依据 |
| --- | --- | --- |
| OpenAI / 自定义兼容 | Bearer；audio/speech；二进制 MP3 | [Speech API](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create) |
| 硅基流动 | Bearer；audio/speech；二进制音频，默认 CosyVoice2 单人朗读 | [语音合成](https://docs.siliconflow.cn/docs/userguide/capabilities/text-to-speech) |
| MiniMax | Bearer；t2a_v2；业务状态码和十六进制音频 | [同步语音合成](https://platform.minimax.cn/docs/api-reference/speech-t2a-http) |
| 百炼 Qwen | Bearer；multimodal-generation/generation；下载 output.audio.url，不携带 API Key | [Qwen-TTS](https://www.alibabacloud.com/help/en/model-studio/qwen-tts-api) |
| 豆包 | 新版 X-Api-Key + X-Api-Resource-Id；V3 SSE；拼接 Base64 音频 | [字节跳动官方示例](https://github.com/bytedance/agentkit-samples/blob/main/skills/byted-text-to-speech/scripts/text_to_speech.py) |
| ElevenLabs | xi-api-key；text-to-speech/voice_id；二进制 MP3 | [Create speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert) |
| Azure Speech | Ocp-Apim-Subscription-Key；SSML；二进制 MP3 | [REST TTS](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech) |


## 专有名词增强检查（2026-10-29）

### 新增实时适配器复核

- 百炼 Paraformer 实时接口支持服务端热词 `vocabulary_id`，并非直接提交任意词数组。[官方客户端事件](https://help.aliyun.com/en/model-studio/paraformer-client-events)。本地词库当前不自动上传或创建云词表。
- 腾讯实时接口支持 `hotword_id` / `hotword_list`；请求级临时词表可能覆盖云词表，不能未经选择静默合并。[官方接口](https://cloud.tencent.com.cn/document/api/1093/131127)。当前适配器未传本地热词，保留现状。
- 豆包 bigmodel 支持 corpus/context 热词与云端词表；直传和云词表存在优先级，应避免全库直传及强权重。[官方热词与上下文](https://docs.volcengine.com/docs/doubao-voice/hot-words-and-context?lang=zh)。当前适配器未自动发送本地热词。
- 讯飞当前适配器连接标准版 rtasr `/v1/ws`，支持控制台个性化热词，不应挪用文件转写 lfasr 的 `hotWord` 参数。[标准版接口](https://www.xfyun.cn/doc/asr/rtasr/API.html)。本地词库未自动上传。
- 本机保存的 llama.cpp / Qwen3-ASR GGUF 配置是否支持提示词取决于该服务版本和请求协议，未据模型名称推断支持。没有读取密钥或发起付费语音请求；以上是官方协议及本地真实 WebSocket 契约测试验证，不代表账号已开通热词或实际识别准确率验证。
- 当前上述新实时适配器只使用本地词库提供 LLM 候选，不额外传原生热词，因而不会重复叠加或覆盖用户云词库。LLM 候选仍可能误判，沿用语境限制、少量候选与精确标识符保护；原有人工 replacements 规则仍会按字面替换，不属于热词。
- 修复已保存实时适配器使用 `paraformer-v2` 文件模型名的情况：仅在实时请求中映射为 `paraformer-realtime-v2`，v1 同理，未知自定义模型保留。腾讯实际发送已经单独限速为 2 倍，无需调整。握手检查确认本机 Node WebSocket 会发送指定鉴权头。
- 本轮同时仅恢复截图窗口预览/单击吸附，保留拖动阈值、工具点击不绘制和双击完成；连接名称改为本地编辑、失焦提交，避免删空过程中设置标准化补回默认名称。类型检查及 29 项相关测试通过；没有声称真人鼠标/键盘或付费 ASR 已验证。

- 最终转写：`pipeline.asrTranscript` 在录音结束后调用本地 sherpa 或 `providers/asr.ts`。通用分支上传 multipart 到 audio/transcriptions；阿里云 Qwen3-ASR-Flash 使用 DashScope multimodal-generation JSON；其他适配器各自构造协议。不能仅凭 model 字符串把所有服务视为支持热词。
- 字幕：`LiveCaptions` 保留至多六秒音频，通过既有转写回调获取预览；不在每个 PCM 分片读取词库或调用 LLM。最终转写独立保存原始文本。
- 场景：开始录音时冻结前台窗口与任务，`promptLibrary` 选择 ai/polish/translate/document/email；五类共享同一个 pipeline，而非五套词库。
- 现有词典：Settings.replacements 与 suggestions 是直接替换/人工接受的提示，不能把实体别名自动变成替换规则。保留其既有行为，不自动读取私人历史建立实体。
- 存储：复用现有 node:sqlite DatabaseSync，实体使用独立 entities.sqlite。检查发现“不保留历史”会删除 history.sqlite，所以不把词库表放进历史文件，避免清理历史误删词库；不新增数据库服务，不改历史行或 API Key。
- 上下文支持：OpenAI 官方转写协议支持 prompt；Qwen3-ASR-Flash 的 system message 可提供上下文/实体词表。未知兼容地址、其他模型和本地引擎默认不声称支持增强。适配参数必须按该协议核实，并在未支持或增强参数失败时保留普通转写路径。
- 来源：[OpenAI 转写](https://developers.openai.com/api/docs/guides/speech-to-text)、[Qwen-ASR](https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference)。没有更换现有提供商或模型。
- GitHub 取舍：pinyin-pro（MIT，GitHub API 查询 pushed_at 2026-10-10）、phrase-pinyin-data（MIT，2026-10-28）、THUOCL（MIT，2023-04-03）。前两项解决读音而非完整实体核实；THUOCL 是领域词表，缺少本任务所需别名/来源关系且更新较久，暂不整库内置。只引入小型本地拼音转换依赖；允许用户导入 JSON 词条，不下载大型人物百科。
- 测试边界：接口契约、文本候选与端到端模拟可自动验证；未提供可复用真实录音和真实服务结果时，不报告真实准确率、误纠率或供应商延迟改善数字。


### 实现与验证（rc.12）

- `shared/builtin-prompts.json` 完整保存用户提供的五份卡片正文；`promptLibrary` 只升级未编辑的旧默认正文，保留用户改写、空白和删除操作。分类名为 agent协作，出厂卡片为内置润色、内置翻译、内置文档、内置邮件、内置协作。
- `entity-store.ts` 管理 entities.sqlite 的 entity_terms 表：id、canonical、domain、结构化 data、created_at、updated_at；data 包含 type、aliases、related、source、verified、enabled、userDefined。名称+领域唯一，最多 10000 项；导入先校验再用事务写入，重复条目保留已有个人编辑，回滚不会修改历史文件。
- `entity-matcher.ts` 缓存读音和名称匹配器。热词在录音开始时冻结到 Task ID，不按分片查询数据库；领域、应用及卡片场景匹配后取最多 20 项，协议上下文限制为 200 UTF-8 字节、完整词条。候选按精确名称、显式别名、带语境的同音/有限近音匹配排序，最多 8 项、附加 JSON 最多 3000 字符。未确定的两字人名不在无语境时只凭拼音匹配；手动常用姓名支持已明确配置的别名。关联只是候选排序依据，不作为强制替换。
- 代码块、路径、URL、邮箱、精确型号版本、API 标识符、JSON 字段、布尔值和命令参数不参加候选纠错。明确要求逐字保留时不提供改名候选。模型若改变受保护的版本、路径或标识符，停止插入，按用户的历史保留设置保存原始转写并报错，不增加纠错重试调用；选择“不保留历史”时不保存。
- `pipeline` 把候选作为不可信数据附加到已有五类卡片的润色/翻译请求；ASR 原文不被覆盖，不另外调用纠错 LLM。翻译多目标分别检查精确内容。关闭润色时不额外启动 LLM。音频直达模式不人为增加独立 ASR 或文本纠错调用。
- `asr-enhancement` 只允许官方 OpenAI 已核实转写接口的 prompt，或当前已接入 DashScope 协议的精确 qwen3-asr-flash 模型。Qwen JSON 的 leading system/content/text 结构核对了[官方工具包源码](https://github.com/QwenLM/Qwen3-ASR-Toolkit/blob/main/qwen3_asr_toolkit/qwen3asr.py)。未核实的兼容地址、模型变体、其他适配器、本地 SenseVoice 不发送新增参数。HTTP 400/422 拒绝增强请求时，仅回退一次普通转写；其他错误正常报告，不更换提供商。
- 设置入口：语音与输入 → 录音与语言 → 语音识别增强。默认关闭，开启前说明相关词条可能发送给当前配置的 ASR/LLM；支持搜索、类别、标准名称、别名、领域、关联、核实依据、启停、删除及 JSON 导入/导出。不会自动从用户历史采集或同步词条。
- 诊断沿用 Task ID，记录 hotwords、entity-candidates、ASR、LLM、total 耗时，汇总平均/分位数所需样本；LLM 返回 usage 时仅记录数值 Token 数。供应商未返回 usage 则为未提供，不按零用量报告。日志不新增词条正文、私密文本或密钥。
- 已用用户提供的 6 份 m4a 及本机已有 SenseVoice Small 真实转写两遍。6/6 的 ASR 输出一致；当前接口没有原生热词，所以不宣称 ASR 准确率提升。基线平均 125.05ms、P95 190.93ms，对照平均 120.19ms、P95 187.98ms，仅是同模型配对耗时波动，不是优化收益。
- 用户人工确认的 7 处专名中，原始 ASR 精确命中 3 处。同批人工配置词条后的候选回放覆盖 7 处；这是接线与召回验证，不是独立测试集或最终 LLM 纠错率。完整对照保存在本地 release/verification-entities，不将用户录音或全文转写提交到 Git。
- 真实 LLM 对照的独立请求因缺少鉴权返回 HTTP 401，已停止继续请求；最终专名正确率、修复率、误纠率及真实 LLM/端到端 P95 尚未验证，不能用候选召回率代替。独立测试脚本支持通过环境变量提供测试服务，不把密钥写到报告或词库。
- 验证结果：类型检查通过；完整回归 2965 项通过、7 项跳过。真实录音候选回放另行通过。rc.12 安装包经 NSIS 完整性、更新摘要、打包主程序与构建产物一致性、原生模块加载及独立配置启动检查；未模拟真实用户按键或证明真实 LLM 最终准确率。
- 回滚：先关闭语音识别增强即恢复原有处理路径；词库可先导出 JSON，再按提交回滚代码。新表不改写历史/设置和原音频；旧版忽略 entities.sqlite。用户改写卡片仍保留；恢复出厂卡片是独立手动操作。

### 公共词库一键导入（rc.13）

- 用户无需逐条录入：词库管理中选择分类，点击「一键导入 / 更新」。当前允许列表为[白霜拼音](https://github.com/gaboolic/rime-frost)的 name、exthot、computer 三份分类文本（GPL-3.0），以及 [THUOCL](https://github.com/thunlp/THUOCL) IT 原词频最高的 5000 项（MIT）。白霜仓库 GitHub API pushed_at 为 2026-10-28；不据此宣称每个文件当天更新。清华词表较旧，界面已标注。
- 2026-10-29 真实下载分别解析 1354、2080、35、5000 项，合计 8469 项。约 3.91 秒下载、38.77ms 内存 SQLite 导入、68.56ms 建索引、8.86ms 样例检索。仅为此电脑单次结果，不是最终语音/LLM 准确率或延迟改善。
- 不随安装包分发这些词表；按用户点击下载到既有本地词库。界面与 THIRD_PARTY_NOTICES 提供源仓库和许可证，词条 source 保留原文件 URL 和许可证。下载不携带用户录音、历史或密钥，不接收用户自定义下载地址；固定 HTTPS 文件、20 秒单源超时、1MiB 单源上限，拒绝跳转。纯文本解析，不执行 YAML 标签或脚本。
- 全部选中来源先下载解析，成功后一次事务导入；失败不导入半份。重复导入只添加缺失词条，保留已有个人改写和启停状态。沿用总数 10000 项限制，超出时整批回滚并提示。
- 公共条目明确标为 userDefined=false、verified=false，不伪造别名或演员—作品关系，不视为已人工核实知识。公共人物同音候选需要演员、角色、姓名等相关语境；普通旅行中的“延安”不会仅凭公共人名改为“闫桉”。未知场景不将公共整库送入 ASR；已有候选数量和输出保护限制继续生效。
- 实际下载、导入及检索通过可选网络测试验证；默认测试覆盖恶意/变化文本、来源允许列表、重复与个人状态保留、超限响应、部分下载失败、词频选择及公共人物语境。未使用付费模型重做最终语音纠错率，rc.12 的真实 LLM 鉴权限制仍然适用。
- 类型检查通过；完整回归 2969 项通过、8 项跳过，可选真实下载测试另行通过。rc.13 安装包的 NSIS 完整性、更新摘要、打包内容一致性、原生模块加载和独立配置启动检查通过。未用真人语音或付费 LLM 证明最终纠错准确率。

### 流式识别适配器（rc.14）

- 新增 `src/main/providers/asr/realtime.ts`，把「只会说 WebSocket」的三家放进同一套工具：握手头、文本/二进制帧、按 100 ms 切分 16 kHz PCM16、倍速发送、超时与错误映射。适配器仍各自拥有报文形状，超时、中止和日志沿用既有适配器接口，没有改动转写主流程。
- 阿里云百炼实时识别（`dashscope-realtime`）：`wss://dashscope.aliyuncs.com/api-ws/v1/inference`，`Authorization: bearer <key>`；`run-task`（task_group=audio、task=asr、function=recognition、format=pcm、sample_rate=16000）→ `task-started` → 二进制 PCM → `finish-task` → `result-generated`（sentence_end 为终局）→ `task-finished`。结果帧是累积句，只在 sentence_end 时提交，避免把半句当整段。
- 腾讯云实时识别（`tencent-realtime`）：`wss://asr.cloud.tencent.com/asr/v2/<appid>?secretid&timestamp&expired&nonce&engine_model_type&voice_format=1&signature`，签名 = Base64(HMAC-SHA1(secretKey, "asr.cloud.tencent.com/asr/v2/<appid>?<排序查询串>"))；音频是裸二进制帧，`{"type":"end"}` 收尾，结果在 `{"code":0,"result":{"voice_text_str"}}` 里逐句到达。
- 火山引擎豆包流式识别（`volcengine-streaming`）：`wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`，握手头 `X-Api-Key`（新版控制台）或 `X-Api-App-Key` + `X-Api-Access-Key`（旧版控制台）/ `X-Api-Resource-Id` / `X-Api-Request-Id` / `X-Api-Connect-Id` / `X-Api-Sequence: -1`；4 字节头（version|header size、message type|flags、serialization|compression）+ 可选序号与事件字段，JSON 用 gzip 压缩，音频按 200 ms 一包，最后一包 flags=0b0010。
- 两处需要说明的选择：百炼把录音文件识别（https）和实时识别（wss）放在同一域名，仅凭主机名无法区分，所以给适配器加了可选的 `schemes` 声明，`aliyun` 只认 http/https，`dashscope-realtime` 只认 ws/wss；预设的 `baseUrl` 一律写 `https://`，由适配器自己升级为 wss，因为连接测试走的是 HTTP 探测。
- 验证边界：`src/main/providers/asr/realtime.test.ts` 用本地 WebSocket 服务覆盖三家的握手头、帧切分、签名、累积文本与错误映射；类型检查通过；完整回归 2975 项通过，仅 `wake-word-native.test.ts` 两项在干净树上同样失败（离线唤醒引擎环境问题，与本次改动无关）。

### 讯飞实时语音转写适配器（rc.16）

- 新增适配器 `xfyun-rta`（仍在 `src/main/providers/asr/realtime.ts`）：`wss://rtasr.xfyun.cn/v1/ws?appid&ts&signa`，可选 `lang`、`vadMdn`。签名 = Base64(HMAC-SHA1(key=APIKey, msg=md5hex(appid + ts)))，`md5` 取小写十六进制、`ts` 为秒、结果 URL 编码；官方文档的示例（appid `595f23df`、ts `1512041814`、key `d9f4aa7e…`）算得 `IrrzsJeOFk1NGfJHW6SkHUoN9CU=`，已固化为测试用例。
- 音频是裸二进制帧，每 40 ms 发 1280 字节（16 kHz、16 bit、单声道），不能加速；收尾必须发二进制帧 `{"end": true}`（空格也算在字节里），服务端随后把最后一句的终稿推上来并关闭连接，因此客户端在写入 end 之后再等 5 秒收尾，比只等关闭更稳。
- 结果帧是 `{"action":"result","code":"0","data":"<JSON 字符串>"}`，`data` 需要二次解析；`cn.st.type` 为 `"0"` 是终稿、`"1"` 是中间稿，终稿带整句，所以按 `seg_id` 追加、并丢弃已被终稿覆盖的中间稿，否则整段话会重复一遍。15 秒没有音频会收到 `37005` 并断开。
- 与语音听写（IAT）的区别：实时转写按时长与并发路数计费、单会话没有 60 秒上限；旧文档页 `RTASR.html` 已 404，有效页面是 `API.html`。注意不要与 `global.xfyun.cn/doc/rtasr/` 混用，那是另一个服务（`ist-api-sg`，HMAC-SHA256，用 APISecret，5 小时上限）。
- 真实账号联调：2026-10-29 用 9.86 秒合成录音，一次 1 倍速发送与一次 4 倍速发送都与预期文本一致，1 倍速约 3.3 秒返回终稿。
- 同时修正：火山引擎预设的 `App ID` 与 `Access Token` 由必填改为可选（新控制台只需 API Key），避免表单红框挡住本可用的连接。
