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

## 目录与验证覆盖

下面列出全部内置预设。`本地协议测试` 表示使用受控传输或本地 HTTP / WebSocket 服务验证请求和解析；`本地契约测试` 表示通过模拟响应验证聊天传输。两者均不表示真实账号联通验证。文档链接是对应预设的参考入口，无法访问的条目在上方单独说明。

### ASR（26）

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
