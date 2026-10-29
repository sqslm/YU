# 语音识别（ASR）API 申请与配置教程

适用版本 **1.1.0-rc.16** 及以后。下面这几条是软件内置、可以直接配的中文语音识别连接：

| 软件里的模板名 | 协议 | 计费口径 | 适合什么 |
| --- | --- | --- | --- |
| 阿里云百炼（实时识别） | WebSocket 流式 | 按音频时长 | 首选，一句话/长段落都行，延迟低，不需要 OSS |
| 阿里云百炼（Paraformer 录音文件） | HTTP 异步任务 | 按音频时长 | 离线补录、批量转写；必须自备公网可访问的 URL |
| 火山引擎（豆包流式识别） | WebSocket 流式 | 按音频时长（小时版/并发版） | 中文效果好，免费额度较宽松 |
| 科大讯飞（实时语音转写） | WebSocket 流式 | 按会话时长 + 并发路数 | 免费包 5 小时、单会话无 60 秒上限 |
| 科大讯飞（语音听写） | WebSocket 帧协议 | 按次 | 短句听写（单次 60 秒上限） |
| 腾讯云（实时语音识别） | WebSocket 流式 | 按并发路数 | 已在用腾讯云、愿意开 CAM 子账号密钥的团队 |
| 腾讯云（一句话识别） | HTTP TC3 签名 | 按次 | 短音频补录 |

先说结论：**只想尽快能用**，就按第 1 节配一条「阿里云百炼（实时识别）」，其余留空；想要第二家兜底，再加一条「火山引擎（豆包流式识别）」。

---

## 0. 通用流程（所有厂商都一样）

1. **在厂商控制台拿到凭据**：多数是「一个 Key」，腾讯是「AppID + SecretId + SecretKey」，讯飞是「AppID + Key」。
2. 打开软件 **设置 → AI 与模型 → 顶部切到「ASR 模型」→ 左侧「+ 添加」**。
3. 选提供商模板，填下面五类框：
   - **连接名称**：自己认得的名字，随便起（例：`阿里云免费ASR`）。
   - **API Key**：多数厂商的 key 填这里（腾讯、讯飞另有专门的字段，见各自小节）。
   - **接口地址**：模板已预填，**一般不要改**；改错是配不通的头号原因。
   - **模型 ID**：模板已预填；腾讯、讯飞留空即可（它们用「引擎」而不是模型）。可点 **获取模型** 看该模板支持哪些 ID。
   - **模板附加字段**：带 `*` 的是必填，缺了保存不了。
4. 点 **测试连接**。它只做 HTTP 可达性判断，语音接口探测失败不一定是错（见 0.3）。
5. 保存后把这一条的 **启用** 开关打开。多条同时启用时，按「我的连接」列表的**从上到下顺序**调用，前一条失败会自动换下一条。
6. 想让某条固定优先，选中它点 **设为首选**。
7. 真实验证：按快捷键录一句话，看是否出字。**这一步才算配好了。**

### 0.1 五种凭据分别填在哪

| 厂商 | 外层「API Key」 | 附加字段里的必填项 |
| --- | --- | --- |
| 阿里云百炼（实时 / 录音文件） | `sk-` 开头的 API Key | 录音文件版还要「音频直传地址」 |
| 火山引擎（豆包流式） | 新版控制台的 API Key | 无（Resource Id 有默认值） |
| 科大讯飞（实时语音转写） | APIKey（填这里或下面的字段都行） | `AppID` |
| 科大讯飞（语音听写） | 留空 | `AppId` + `APIKey` + `APISecret` |
| 腾讯云（实时 / 一句话） | 留空 | 实时：`AppID` + `SecretId` + `SecretKey`；一句话：`SecretId` + `SecretKey` |

### 0.2 关于「接口地址」

- 一律填 `https://`，**不要填 `wss://`**：软件在通话时自己把地址升级成 WebSocket。填 `wss://` 会让「测试连接」的 HTTP 探测发不出去，看起来像配错了。
- 控制台文档里给的 `wss://…` 地址可以直接抄，但要改掉协议头。
- 下面每个厂商的小节都写清楚了该填哪一行。

### 0.3 「测试连接」能证明什么、不能证明什么

- **流式语音接口**（阿里实时、火山、讯飞转写、腾讯实时）：这类地址没有 `/models` 接口，软件会直接提示「这条连接用 WebSocket 流式识别，HTTP 探测不适用；地址与密钥会在录音时真正验证」。这是正常提示，不是错误。
- **非 OpenAI 兼容接口**（录音文件、一句话识别）：探测返回 404/401 也可能只是接口本来没有 `/models`，同样以录音结果为准。
- 判据只有一个：**录一句话有没有出字。**

### 0.4 密钥怎么存

- 界面上显示为掩码；落盘时用系统凭据保护（Windows 上是 DPAPI，走 Electron `safeStorage`）加密成 `apiKeyEnc`，明文不写进 `settings.json`。
- 换成另一台电脑、或换 Windows 账号后，旧密文解不开，需要**重新填一次**。
- 备份 `settings.json` 不等于备份密钥：换机器时密钥要重新输入。

---

## 1. 阿里云百炼 · 实时识别（推荐）

**对应模板**：`阿里云百炼（实时识别）` · 模型 `paraformer-realtime-v2`

### 1.1 申请步骤

1. 注册阿里云账号并完成**实名认证**。
2. 打开百炼控制台 <https://bailian.console.aliyun.com>（地域建议华北2·北京），首次进入按引导**开通百炼**。
3. 打开 <https://bailian.console.aliyun.com/model/settings/api-key>，点「创建 API Key」，复制 `sk-` 开头的字符串（**只显示一次**）。
4. 在模型广场搜 `paraformer-realtime-v2`，确认该模型有可用免费额度或已开通付费。

### 1.2 配置填写

| 界面字段 | 填什么 |
| --- | --- |
| 连接名称 | `阿里云免费ASR`（随意） |
| API Key | `sk-…` |
| 接口地址 | `https://dashscope.aliyuncs.com/api-ws/v1/inference` |
| 模型 ID | `paraformer-realtime-v2`（也可 `paraformer-realtime-v1`、`paraformer-realtime-8k-v2`、`gummy-realtime-v1`） |
| 业务空间 ID | 留空（用默认业务空间） |

### 1.3 容易踩的坑

- **别用专属/部署域名**。形如 `https://llm-xxxxxxxx.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference` 的地址是本账号的专属部署入口，免费额度不走那里；额度在公网地址用完时，专属地址会直接返回 `AllocationQuota.FreeTierOnly`（免费额度已耗尽）。遇到这个报错：换回 `dashscope.aliyuncs.com`，或去百炼开通付费/领新额度。
- 这条是**流式**，音频直接上传，**不需要 OSS**。
- 想转 8 kHz 电话录音，用 `paraformer-realtime-8k-v2`。

---

## 2. 阿里云百炼 · Paraformer 录音文件

**对应模板**：`阿里云百炼（Paraformer 录音文件）` · 模型 `paraformer-v2`

这个接口只收 `file_urls`（一个 URL），不收字节流，所以**必须**准备一个「阿里云能回源读到」的地址；软件会把本地录音 `PUT` 到该地址，再把同一个地址交给百炼。

### 2.1 准备一个 OSS 地址

1. 开通对象存储 OSS，创建 Bucket（建议与百炼同地域，权限保持**私有**）。
2. 上传一段测试录音（wav/mp3）确认能读。
3. 取得**允许 PUT 的 URL**：
   - 简单做法：给「上传地址」一个签名 URL，签名时允许 `PUT` 方法，有效期建议 ≥ 1 小时（软件上传后还要等识别完成）。
   - 也可以在自有服务器上加一个接收 PUT 的接口，把文件落到能被公网读到的位置。
   - 公共读写 Bucket 也能用，但不建议。
4. 注意「上传地址」要**指向具体对象**（例如 `https://bucket.oss-cn-beijing.aliyuncs.com/typless/asr.wav?…签名…`），不是 Bucket 根目录。

### 2.2 配置填写

| 界面字段 | 填什么 |
| --- | --- |
| API Key | `sk-…`（与第 1 节同一个 key 即可） |
| 接口地址 | `https://dashscope.aliyuncs.com` |
| 模型 ID | `paraformer-v2`（或 `paraformer-8k-v2`、`paraformer-v1`） |
| 音频直传地址 `*` | 上面的可 PUT 公网 URL |
| 业务空间 ID | 留空 |

### 2.3 说明

- 这条是**异步**任务：提交后轮询结果，延迟比流式大，适合补录历史录音，不适合当默认听写。
- 不想用 OSS 的话，直接用第 1 节的实时识别即可（它一样能转整段录音）。

---

## 3. 火山引擎 · 豆包流式识别

**对应模板**：`火山引擎（豆包流式识别）` · 模型 `bigmodel`（或留空）

### 3.1 申请步骤

1. 注册火山引擎账号，完成**实名认证**（未实名无法调用）。
2. 打开语音技术控制台 <https://console.volcengine.com/speech/service/16>，首次使用点**开通服务**。
3. 在「应用管理」创建应用（例：`YU`），记下 **APP ID**（数字，如 `9177907997`）。
4. 新版控制台会为应用生成**一个 API Key**（形如 `575d119f-a6d8-4a6a-9a45-2fe8296fe0a8`）；在应用详情或 API Key 管理里创建/复制它。
5. 领取或购买**流式语音识别**资源包，记住对应的 **Resource Id**：
   - 大模型流式语音识别 **2.0 小时版**：`volc.seedasr.sauc.duration`（默认就用这个）
   - 大模型流式语音识别 **2.0 并发版**：`volc.seedasr.sauc.concurrent`
   - 1.0 老账号：`volc.bigasr.sauc.duration` / `volc.bigasr.sauc.concurrent`
6. 确认账户**余额**或资源包有效期；余额为 0 且无资源包时调用会被拒。

### 3.2 配置填写

| 界面字段 | 填什么 |
| --- | --- |
| API Key | 新版控制台的 API Key |
| 接口地址 | `https://openspeech.bytedance.com/api/v3/sauc/bigmodel_async` |
| 模型 ID | `bigmodel`，或留空（等价） |
| App ID（旧版控制台，可选） | **留空** |
| Access Token（旧版控制台，可选） | **留空** |
| Resource Id | `volc.seedasr.sauc.duration`（与所购资源包一致） |

### 3.3 容易踩的坑

- **模型 ID 只有 `bigmodel` 这一个合法值**，写 `2.0`、`1.0`、`bigmodel_async` 都不对——版本由 Resource Id 决定，不是模型名。
- 老教程里的「App ID + Access Token」是**旧版控制台**的鉴权方式；新版只要 API Key。两套同时填不会更保险，反而可能鉴权失败。
- Resource Id 必须与已购资源包匹配，否则报「未开通 / 无权限」。
- 地址里的 `bigmodel_async` 是推荐端点（伪流式，句级返回）；想用原生流式可换成 `bigmodel`。

---

## 4. 科大讯飞 · 实时语音转写（RTASR）

**对应模板**：`科大讯飞（实时语音转写）` · 模型留空

### 4.1 申请步骤

1. 注册讯飞开放平台 <https://www.xfyun.cn/>，完成**实名认证**。
2. 控制台 <https://console.xfyun.cn> → 「创建应用」，应用名随意，记下 **APPID**（8 位，如 `d4cb2b12`）。
3. 打开「实时语音转写」服务页 <https://console.xfyun.cn/services/rta>，**领取免费包**（当前为 5 小时 / 1 路并发，具体以页面为准），并把该服务**添加到你刚创建的应用**。
4. 在同一页的「Websocket服务接口认证信息」里复制 **APIKey**（32 位十六进制）。

### 4.2 配置填写

| 界面字段 | 填什么 |
| --- | --- |
| API Key | 上面那串 APIKey（也可以留空、改填到下面的「APIKey」字段） |
| 接口地址 | `https://rtasr.xfyun.cn/v1/ws` |
| 模型 ID | **留空** |
| AppID `*` | `d4cb2b12` 这类 8 位串 |
| APIKey | 同上（两处填一处即可） |
| 语言 | `cn`（中文/中英混合）；英文填 `en`；方言需先在控制台添加 |
| 拾音方式 | 留空＝远场；嘴贴麦克风说话填 `2`（近场） |

### 4.3 容易踩的坑

- **签名用的是 APIKey，不是 APISecret**。这是它和「语音听写」最大的区别，填错必然 401。
- 发送节奏由软件控制为 **40 ms / 1280 字节**，是协议要求，不能加速：一段 30 秒录音大约 30 秒才发完，收尾还要 2~4 秒等服务端吐最后一句。所以它适合边说边出字，不适合「录完立刻要结果」。
- 单会话**没有 60 秒上限**（这是它相对「语音听写」的优势），但免费包只有 5 小时，用完为止。
- 连续 **15 秒没有音频**会被服务端断开（错误码 `37005`），中途别长时间静音。
- 官方旧文档页 `RTASR.html` 已 404，以 <https://www.xfyun.cn/doc/asr/rtasr/API.html> 为准；`global.xfyun.cn/doc/rtasr/` 是另一个服务（境外站点，HMAC-SHA256 + APISecret），不要混用。

---

## 5. 科大讯飞 · 语音听写（IAT）

**对应模板**：`科大讯飞（语音听写）` · 模型留空

### 5.1 申请步骤

1. 同第 4 节：讯飞开放平台注册 + 实名 + 创建应用拿 **APPID**。
2. 打开「语音听写（流式版）」服务页 <https://console.xfyun.cn/services/iat> 领取免费额度，并把该服务添加到刚创建的应用。
3. 在「Websocket服务接口认证信息」里同时复制 **APIKey** 和 **APISecret**（这一家用三件套）。

### 5.2 配置填写

| 界面字段 | 填什么 |
| --- | --- |
| API Key | **留空**（key 填在下面的字段里） |
| 接口地址 | `https://iat-api.xfyun.cn/v2` |
| 模型 ID | 留空 |
| AppId `*` | 8 位 APPID |
| APIKey `*` | 控制台 APIKey |
| APISecret `*` | 控制台 APISecret |

### 5.3 与实时语音转写的区别

| | 语音听写（IAT） | 实时语音转写（RTASR） |
| --- | --- | --- |
| 凭据 | AppId + APIKey + **APISecret** | AppID + **APIKey** |
| 单次时长 | 60 秒上限 | 无上限（受免费额度限制） |
| 计费 | 按次 | 按时长 + 并发路数 |
| 适合 | 一句话、短指令 | 长段落、边说边出字 |

---

## 6. 腾讯云 · 实时语音识别 / 一句话识别

### 6.1 申请步骤

1. 注册腾讯云，完成**实名认证**。
2. 开通语音识别服务 <https://console.cloud.tencent.com/asr>。
3. 在「概览」页拿到 **AppID**（形如 `1250000000`）。
4. 打开访问管理 <https://console.cloud.tencent.com/cam/capi> 创建 **SecretId / SecretKey**（建议用子账号并只授予语音识别权限）。
5. 领取或购买对应的免费/付费资源包（实时识别按**并发路数**计费）。

### 6.2 实时语音识别填写

| 界面字段 | 填什么 |
| --- | --- |
| API Key | **留空** |
| 接口地址 | `https://asr.cloud.tencent.com/asr/v2` |
| 模型 ID | 留空 |
| AppID `*` | `125xxxxxxx` |
| SecretId `*` / SecretKey `*` | CAM 里创建的那一对 |
| 引擎 | `16k_zh`（英文 `16k_en`、粤语 `16k_yue`、大模型档 `16k_zh_en_2.0`） |

### 6.3 一句话识别填写

| 界面字段 | 填什么 |
| --- | --- |
| API Key | 留空 |
| 接口地址 | `https://asr.tencentcloudapi.com` |
| 模型 ID | 留空 |
| SecretId `*` / SecretKey `*` | CAM 里创建的那一对 |
| 地域 | `ap-shanghai`（就近即可） |

### 6.4 容易踩的坑

- 签名（实时是 HMAC-SHA1 查询串，一句话是 TC3-HMAC-SHA256）都在**本机**算，SecretKey 一定不要外传；一旦泄露请立刻在 CAM 里轮换。
- `AuthFailure.SignatureFailure` 基本都是 SecretKey 填错；`AuthFailure.SecretIdNotFound` 是 SecretId 错或已被删除。
- 一句话识别有单次音频长度上限，长录音请改用实时识别。

---

## 7. 排错速查

| 现象 | 多半是 | 怎么办 |
| --- | --- | --- |
| 保存时提示某字段必填 | 带 `*` 的字段为空 | 按第 0.1 节的表格补 |
| `测试连接` 报 HTTP 404 / 401 | 语音接口没有 `/models` | 正常，改录一句话验证 |
| `测试连接` 报「HTTP 探测不适用」 | 流式接口 | 正常提示 |
| 阿里返回 `AllocationQuota.FreeTierOnly` | 免费额度用完，或用了专属 maas 地址 | 换 `dashscope.aliyuncs.com`，或开通付费 |
| 阿里返回 401 / `InvalidApiKey` | key 错、带了空格、属于别的业务空间 | 重新复制 key；业务空间 ID 填对或留空 |
| 火山报「未授权 / 无权限」 | API Key 与账号不匹配，或 Resource Id 与资源包不符 | 核对 Resource Id，确认真实开通 |
| 讯飞 401 / 签名错误 | 用了 APISecret 当 APIKey，或系统时间偏差大 | 改用 APIKey；校准系统时间 |
| 讯飞 `37005` | 15 秒内没有音频 | 别长时间静音；分段录 |
| 腾讯 `AuthFailure.SignatureFailure` | SecretKey 错 | 重新复制 SecretKey |
| 录音后提示「没有返回文字」 | 录音太短、无人声、麦克风静音 | 换设备试，先说一句完整话 |
| 识别很慢 | 讯飞按实时节奏发送；录音文件识别是异步轮询 | 短句用实时识别；长录音用阿里实时或火山 |
| 某条连接报错后自动换了别的 | 链路回退 | 想固定某条就设为首选，或禁用其他条 |

---

## 8. 成本与隐私

- **成本**：流式识别按音频时长计（腾讯实时按并发路数），一句话/语音听写按次。免费额度用完后按量扣费，建议在厂商控制台设置用量告警。
- **隐私**：除本地识别（内置 SenseVoice 离线引擎，不联网）之外，录音会发送到你配置的厂商。密钥只在本机加密保存，但**音频一定会上行**——处理敏感内容时用本地识别。
- **回收**：不用的连接记得关掉「启用」，避免回退链把音频发到不想用的厂商。

---

## 9. 一页速查

| 厂商模板 | 接口地址 | 模型 ID | 需要准备 |
| --- | --- | --- | --- |
| 阿里云百炼（实时识别） | `https://dashscope.aliyuncs.com/api-ws/v1/inference` | `paraformer-realtime-v2` | API Key（`sk-`） |
| 阿里云百炼（Paraformer 录音文件） | `https://dashscope.aliyuncs.com` | `paraformer-v2` | API Key + 可 PUT 的公网 URL |
| 火山引擎（豆包流式识别） | `https://openspeech.bytedance.com/api/v3/sauc/bigmodel_async` | `bigmodel` | API Key + Resource Id（默认 2.0 小时版） |
| 科大讯飞（实时语音转写） | `https://rtasr.xfyun.cn/v1/ws` | 留空 | AppID + APIKey |
| 科大讯飞（语音听写） | `https://iat-api.xfyun.cn/v2` | 留空 | AppId + APIKey + APISecret |
| 腾讯云（实时语音识别） | `https://asr.cloud.tencent.com/asr/v2` | 留空 | AppID + SecretId + SecretKey + 引擎 |
| 腾讯云（一句话识别） | `https://asr.tencentcloudapi.com` | 留空 | SecretId + SecretKey + 地域 |
