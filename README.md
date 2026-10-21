# Typeless Rebuild

Windows 上的语音输入客户端，界面与交互对齐 Typeless（hub 三页 + 设置弹层 + 底部胶囊悬浮条）：按一下热键开始说话，再按一下结束，自动「识别 → 润色 → 整段插入到当前焦点位置」，另提供翻译模式、Ask Anything（可联网检索）与「粘贴上一条」。

后端不绑定厂商：通用 ASR / LLM 支持 OpenAI 兼容协议，也提供厂商专用 ASR 适配器。通过「模型 → 添加配置」选择服务商并填写地址、密钥、模型及需要的专用字段。也可以切到**多模态链路**，把 WAV 直接丢给 Gemini `generateContent` 一条龙出文本。

## 快速开始

```powershell
pnpm install
# 起一个本地假后端，便于没有 API 时自测
pnpm mock                     # http://127.0.0.1:8787/v1
pnpm build
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # 见「已知坑」
node_modules\electron\dist\electron.exe .
```

首次运行的模型配置为空。在「设置 → 模型」添加语音转写和语言模型配置，填写服务地址、密钥与模型，测试连接后保存。使用本地假后端时，手动将配置地址设为 `http://127.0.0.1:8787/v1`；启动 mock 不会自动修改设置。

打包安装器：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
pnpm package          # → release\Typeless Rebuild-0.14.0-setup.exe
```

## 使用

| 操作 | 默认快捷键 |
| --- | --- |
| 听写（识别 + 润色 + 插入） | `右 Alt` 按一下开始，再按一下结束；录音中按 `Esc` 取消 |
| Ask Anything（可联网检索后回答） | `Space + 右 Alt` 起，**单按右 Alt** 结束；答案同时弹出一张回答卡 |
| 翻译模式（识别后译成目标语言） | `右 Alt + 右 Shift` |
| 粘贴上一条结果 | `左 Ctrl + 右 Shift + V` |

触发方式可在「快捷键」页切成**按一下开始 / 结束**（默认，和 Typeless 一致）或**按住说话**；热键用录制方式改，托盘菜单可临时停用全部快捷键。切到「按一下」后，**任何模式都只按一下右 Alt 就结束**——包括用 `Space + 右 Alt` 起头的 Ask，不必再重复起手组合。

说明页仅在设置中提供，主窗口侧栏不重复显示。

随记工具栏的「新建」或随记页内的 `Ctrl+N` 会创建文字随记并聚焦正文；新建菜单可从系统剪贴板的纯文字创建，只有点击该项时才读取剪贴板。当前分类会沿用，搜索和标签筛选会清空以显示新记录；空白随记显示「未命名随记」。正文自动保存，保存失败时保留待重试改动，并阻止继续新建。剪贴板内容最多 200000 个字符，超限会明确报错，不会截断。文字随记不生成录音，不自动调用模型；可手动润色，支持已有的分类、标签、同步和导出。`Ctrl+N` 仅在随记页生效，弹出对话框时不会新建。

随记工具栏的「导出」可将当前筛选结果导出为 Markdown 或 UTF-8 纯文本；勾选记录后只导出选中项，按当前排序排列。详情中的「导出此条」只导出当前记录。文档包含创建时间（本机时区）、分类、标签、正文或原始转写、润色文本；有录音时包含录音时长。导出前会等待文字保存，保存失败时停止导出。播放器右侧「保存录音」按原始 OGG / WAV 格式另存，不转码。这些是可阅读的文档与原始录音导出，不是可还原分类和同步状态的完整数据库备份。

设置按用途分为「通用」（外观、启动与反馈）、「语音与翻译」（识别语言、翻译与录音）、「文本输入」（插入、换行与应用排除）和「数据与存储」（历史保留与目录）。每项修改自动保存，数字输入在失焦或按 Enter 后保存。

设置里还有几项直接影响结果：

- **麦克风**：列出全部输入设备（悬浮条持有麦克风权限，因此能拿到真实设备名），切换后音频流立即重开。
- **语言**：作为 `language` 传给 ASR；留空自动检测。
- **词典**（hub 的「词典」页）：润色后按字面替换，修正常被识别错的专有名词，长词优先。
- **插入方式**：默认「自动」= 剪贴板整段粘贴（一次到位，且不会被聊天框当成回车），失败才回退 SendInput 逐字符。
- **换行处理**：多行结果默认换成空格；可选 Shift+Enter（不触发发送）或保留回车。
- **模型页**：一页里先选「模式」（传统/多模态），再填对应的接口；传统模式下面是 ASR 与文本模型两组，多模态模式下面是 Gemini 一组，切模式不用换页面。
- **网页搜索**：Ask Anything 先判断要不要检索（也能强制检索），需要就按问题类型排一份检索计划——新闻/实时类走 Brave News 或带 `freshness` 的普通检索，技术问题补英文关键词做中英双语检索；拿到结果先过来源排序（一手优先、聚合站只当线索、同稿转载折叠、按日期剔旧文、字段冲突标出来），再挑 2–3 篇精读原文后才作答，答案带 `[1]` 引用与「## 来源」列表，检索失败会直说覆盖受限而不是编。
- **检索预算**：一次问答最多 3 次检索、3 篇精读（常识题 0 次），响应里能看到的 `[search]` 日志会打出实际用了哪几条查询。
- **延迟预算（v0.8）**：问答链路把「串行」改成了「能并行就并行」——两条检索词并发（`SEARCH_CONCURRENCY=2`）、3 篇精读并发（`MAX_DEEP_READS=3`）、工具轮次压到 1 轮（`MAX_TOOL_ROUNDS=1`，1 轮工具 + 1 轮回答，最多两次 LLM 往返）、回答 `max_tokens=1024`、回答走 SSE 流式（卡片边生成边显示，节流 80ms 重绘）。每层都有硬超时：LLM 25s、搜索 8s、精读 6s、天气 8s，超时就带着已有材料作答并在卡片上说明覆盖受限。实测（mock + 延迟注入 profile）：`ask total 2808ms`，同 profile 旧串行路径为 3608ms（还有 1/3 概率多一次 LLM 往返 → ~4560ms）。日志里 `[perf] llm round0 …` / `[perf] enrich …` / `[perf] ask total …` 能逐段核对。
- **本地 ASR 优化**：keep-alive 连接（复用后 0.93ms，新建 1.84ms）、首尾静音裁剪（实测 300366B → 282320B，−6%）、`concatPcm` 一次分配、`temperature=0` + 显式 `language` 的省 token 请求、超时默认 60s（`TYPELESS_ASR_TIMEOUT_MS`）而不是永久挂起；空闲时每 4 分钟发 300ms 探针保活（`TYPELESS_ASR_WARMUP=off|all|local`，连续 3 次空闲就自停，任何 take 都不会等它）。**注意瓶颈其实在服务端**：本机 `llama.exe serve` 没开 `-ngl`（纯 CPU）且带 `--sleep-idle-seconds 900`，实测延迟与音频长度无关、只与输出 token 数相关（≈350–600ms/token），9.4s 语音要 6–20s。客户端已压到 1ms 级，剩下只能改服务端启动参数（见「已知坑」）。`[perf] asr bytes=… ms=… rtf=… trim=… conn=reuse|new` 可核对。
- **天气直连**：问句里出现天气/气温/下雨等意图时，绕过搜索引擎直接查 Open-Meteo（免 Key）的实况与逐日预报，把数字交给模型，因此能答出「实况 10.3°C，白天 10.2～22.5°C，降水概率 4%」这种具体值；地名会按省份消歧（`河南安阳` 不会飘到广西安阳）。
- **悬浮条位置**：拖动后自动记住；托盘菜单可重置，显示器变化时自动回落到可用区域。
- **回答卡**：Ask 的答案同时以独立悬浮卡（560 固定宽，**从悬浮条正上方 10px 处渐出**、不抢焦点）弹出，`Esc` 或 ✕ 关闭，来源可点开浏览器；卡片正文不放「## 来源」，完整内容仍写进历史。悬浮条在卡片显示期间保留为小药丸（卡片就是挂在它上面的），关卡片一起收。
- **模型列表与思考档位**：文本模型一栏点「获取模型列表」会拉 `GET /models`（`Authorization: Bearer`），下拉支持直接输入；「思考档位」按模型的 `reasoning_supported_efforts` 与 `can_disable_thinking` 生成——选「关闭思考」时请求体发 `thinking:{type:'disabled'}` 且**不带** `reasoning_effort`，其它档位反过来发 `reasoning_effort` 且不带 `thinking`；`max_tokens` 恒 ≥1024（思考与输出共享额度）。列表缓存 10 分钟，拉取失败沿用上次结果且不清空已选模型，请求 UA 为 `typeless-rebuild/<version>`。
- **Ask 是工具 Agent**：Ask 不再只是「检索 + 一次回答」，模型可以调 8 个工具——`get_weather`（Open-Meteo 实况+预报）、`web_search`、`read_webpage`（正文抽取、拒内网、内容视为不可信）、`get_datetime`（系统时间，不让模型猜日期）、`calculate`（手写递归下降求值，无 `eval`）、`get_selection` / `replace_selection`（读选中、替换选中；**替换必须点卡片按钮确认**）、`open_search`。优先走原生 Function Calling（最多两轮），模型不支持时降级为严格 JSON 意图；卡片上会显示工具进度与来源。
- **取消**：录音中按 `Esc` 直接丢弃这一条——不插入、不写历史，悬浮条显示「已取消」后收拢。
- **五类提示词**：设置里的「提示词」页把五类提示词（AI / 润色 / 翻译 / 文档 / 邮件）平铺成五个卡片区块——不分 tab，内置提示词也是卡片，一眼看到全部。每张卡有自己的名字、内容、**可选独立温度**；卡上可「激活 / 复制 / 编辑 / 删除」，**内置卡也能直接改**（改过会标「已改写」，编辑器里有「恢复默认文本」），改完立刻生效；内置卡也能删掉，删光后区块显示空态并提供「恢复内置提示词」，不会白屏。虚线卡用于新建。
- **自动激活提示词**：提示词页顶部有「自动激活」开关，默认打开。打开时按前台应用挑卡——微信 / 聊天类走「润色」（也就是日常说话的那张卡），Codex / Claude Code / OpenCode / Cursor / 终端这类 AI 开发工具走「AI」，Word / Notion 这类编辑器走「文档」，邮件客户端走「邮件」，其余回落「润色」；翻译模式固定用「翻译」卡。**关掉后由你自己钉住主模式 + 主卡片**（两个下拉，主卡片留空 = 跟随该类型的当前卡片），所有窗口统一用它。卡片的温度会真正进到请求体，没设卡片温度时才回落到全局温度。
- **窗口归类**：设置里的「窗口归类」页解决「某个应用被认错」的问题。上面写清判定顺序（手动规则 → 内置分类表 → 兜底润色），下面是一张手动规则表——填一段匹配关键词（进程名或窗口标题的子串，大小写不敏感）再选归为哪一类（AI / 润色 / 翻译 / 文档 / 邮件）；「拾取当前窗口」会列出此刻所有可见窗口、各自当前会被归成哪一类、以及是被规则还是内置表命中，没被认出来的窗口标红，点一下就能生成一条规则。下面还有实时预览输入框，改规则前可以先验证。
- **多模态也吃提示词**：多模态（Gemini 那一路）以前只是把音频转成文字，现在系统提示词里带的是同一套卡片内容（加一句「先在心里听写、只输出最终结果」），因此 AI / 文档 / 邮件 / 翻译的规则在一次直出里同样生效。
- **复制**：历史记录每条 hover 出复制按钮（走主进程剪贴板，`file://` 渲染进程没有剪贴板权限）；回答卡只保留底部一个「复制回答」，不再重复三处。
- **设置入口**：侧栏底部固定「设置」齿轮（也可 `Ctrl+,`），同一个地方还有亮/暗切换与版本号。
- **界面**：hub 首页是概览（今日字数/时长/平均段落/累计记录、近 7 天或 30 天的柱状图、最近识别、
  年度活动热力图）；热力图是**最近 52 周**（最后一列永远是本周，当前月份标签用强调色标出来——之前按自然年画，十月会看到九月当最后一格）；侧栏底部的太阳/月亮按钮切换亮/暗主题；窗口无独立标题栏，顶部与应用内容一体。
- **悬浮条与模式标签**：条上可以显示当前模式（听写 / 翻译 / 问答），在「通用」页用「在悬浮条上显示当前模式」开关控制，关掉就只剩波形与计时；标签不受录音状态影响，`idle` 小药丸与错误态不显示。
- **按服务商分开的搜索配置**：Tavily / Brave / SearXNG / DuckDuckGo 各自的 Key、地址、结果条数分开存，切服务商不会串用上一家的凭据；标「可选」的 Key 输入框同样可以输入（SearXNG 开了鉴权的实例就用它）。

## 架构

```
右 Alt（按一下 / 按住）
   ↓  WH_KEYBOARD_LL 全局钩子（utilityProcess + koffi，吞键，不影响原本的 Alt 行为）
hotkey child ──IPC──▶ main/pipeline
   ↓
bar 窗口（AudioWorklet，常开暖流，16 kHz 单声道 PCM16）
   ↓ 分块回传
pipeline：静音判断 → 拼接 WAV
   ├─ classic：ASR(/v1/audio/transcriptions) → LLM(/v1/chat/completions)
   │            └─ ask 模式走工具 Agent：get_weather / web_search / read_webpage /
   │               get_datetime / calculate / get_selection → 带来源回答 → 弹卡
   └─ multimodal：Gemini generateContent(WAV + 提示词) 一条龙
   ↓
插入：剪贴板整段粘贴 → 失败回退 SendInput Unicode → 再失败走 UIA
   ↓
history.sqlite（SQLite 检索，含来源与链路标记）
```

关键模块：

- `src/main/hotkey/child.ts` — 全局键盘钩子。`PeekMessageW` + `setInterval(..., 4)` 泵消息（阻塞式 `GetMessageW` 会让 V8 无法执行 koffi 回调）；chord 状态机识别「同时按下」与「按住」，`activation` 控制 toggle/hold 语义；`CallNextHookEx` 需要 `koffi.address(lParam)`。
- `src/main/hotkey/host.ts` — 用 `utilityProcess` 跑钩子，崩溃自动重启（最多 5 次），避免钩子拖慢主进程。
- `src/main/pipeline.ts` — 一次听写的完整生命周期，`MIN_DURATION_MS=350` 防误触，`STOP_GRACE_MS=500` 等最后一块音频；`complete()` 按 `pipelineMode` 分流，统一走术语替换后插入。
- `src/main/keyevents.ts` — 纯函数生成 `INPUT` 事件序列，决定换行是空格 / Shift+Enter / 回车，并提供 `submitsOnEnter()` 自检。
- `src/main/agent.ts` — Ask 的调度核心：原生 tool_calls 最多两轮，失败降级为严格 JSON 意图，最后包一层「工具结果 → 回答」；`applyReplaceText()` 只在用户点了「替换选中」后调用。
- `src/main/tools/` — 8 个工具的纯实现（`registry.ts` 出 schema 并按名分发，`runTool` 永不抛异常而是回结构化错误）。
- `src/main/answer.ts` — 旧检索外壳的兼容层：`isWeatherQuery` 直连 Open-Meteo，其余检索路径、来源追加都在这里，`agent.ts` 复用它。
- `src/main/providers/models.ts` — `GET /models` 拉取 + snake→camel 归一化 + 10 分钟磁盘缓存 + 失败回退缓存（从不抛异常）。
- `src/shared/effort.ts` — 思考档位的纯规则：`can_disable_thinking` 才给 `off`，其余只开放 `reasoning_supported_efforts`。
- `src/main/cardLayout.ts` — 回答卡定位的纯函数：以悬浮条矩形为锚，正上方 10px 居中，放不下才翻到下方，越界夹到工作区。
- `src/main/answer.ts` 的检索调度：天气意图先走 Open-Meteo，其余用模型判定 → 搜索 → 结果拼进提示词 → 补「## 来源」；搜索失败自动退回纯问答。
- `src/main/providers/weather.ts` — Open-Meteo 地理编码 + 预报（`placeCandidates` 剥口语、按省份消歧、`formatWeather` 生成必须被引用的数字块）。
- `src/main/providers/search.ts` — DuckDuckGo（HTML 抓取）/ Tavily / Brave / SearXNG 四种检索适配器。
- `src/main/providers/gemini.ts` — `generateContent` 多模态调用（`inline_data` 传 WAV，API Key 走请求头）。
- `src/renderer/src/bar/capture.ts` — 麦克风常开（`setActive` 只控制是否上报），避免冷启动 200–800 ms 丢音。
- `src/main/insert.ts` — 剪贴板整段粘贴优先；SendInput 用 40 字节手写 `INPUT` 布局，注入前用 `AttachThreadInput` 强制前台。
- `src/main/providers/*` — OpenAI 兼容适配器，含 `<SAY>`/引号包裹等模型输出清洗。

数据目录：`%APPDATA%\typeless-rebuild\`（`settings.json`、`history.sqlite`、`notes.json` 和 `notes/audio/`；随记可迁移到自定义目录）。

## 设置规范

修改自动保存；数字输入在失焦或按 Enter 后保存，空值恢复原值，超出范围时收敛到边界。保存失败会保留待保存改动并显示重试入口；关闭设置弹窗会提交待保存改动。更改与当前设置分组内的其他字段合并，不会清空同组连接信息。

| 位置 | 设置与生效条件 |
| --- | --- |
| 通用 | 界面语言、主题、启动与提示反馈；提示停留时长 1–60 秒。 |
| 语音与翻译 → 识别与翻译 | 识别语言仅作为 ASR 提示；翻译目标为 1–3 个不同语言。 |
| 语音与翻译 → 音频 | Opus 为显式选择，关闭时上传 WAV，压缩格式被拒时回退 WAV。内置本地识别与厂商专用协议由各自适配器处理。 |
| 数据与存储 → 历史 | 保留期与记录上限集中管理；上限为 1–100000 条，修改后立即执行；「不保存」需确认，且会清空现有历史和对应录音。 |
| 文本输入 | 插入方式、换行、剪贴板恢复、格式保留集中管理；选择 SendInput 时剪贴板恢复和格式保留不可用。 |
| 快捷键 | 管理全局开关、触发方式和各模式按键。 |
| 资源管理 | 查看所有应用进程的驻留与已提交内存、复制占用信息、释放空闲资源；本地模型默认空闲 5 分钟卸载，可选保持加载，下一次本地听写自动恢复。 |
| 模型 | 传统 / 多模态分别使用对应配置链；厂商专用字段随配置传递；多模态音频上限为 5–600 秒。 |
| 提示词 / 窗口归类 | 管理任务卡片及按应用自动路由；润色温度范围为 0–1。 |
| 搜索 | 各服务独立保存地址、密钥与结果数量；每次结果上限为 1–10。 |
| 账户 | 同步历史、随记及随记录音；同步频率提供常用分钟选项及仅手动同步，保留已有自定义秒数。关闭同步开关后手动同步也不可用。服务器地址仅在登录界面设置。 |

历史、随记新增、编辑、删除、删除冲突以及同步期间的本机修改，都有客户端对真实本地服务端的回归测试。服务端恢复备份导致游标回退时，客户端接受新的游标继续分页。随记分类列表的名称保存在本机，服务端同步的是记录上的分类 ID。录音上传失败会计入待上传数量并显示错误；下载游标在录音落盘后才提交，中断或重启后可继续重试。

资源管理统计包含主进程、界面、快捷键及媒体等全部应用进程。Windows x64 支持时显示私有驻留物理内存；不支持时明确标为包含共享页的工作集。已提交内存单独显示，不能用来代替驻留占用。关闭主窗口会销毁其界面进程；开机启动使用 `--background` 参数，只驻留托盘和听写悬浮条。手动启动仍打开主窗口。

React、MUI、Emotion 和界面国际化库由 Vite 编译进前端资源，仅作为开发依赖保存。安装包运行时仅携带主进程所需依赖，避免重复分发界面源码及其大量文件索引。

后台约 200 MB 是未加载本地模型时的优化目标，不能保证录音、识别或打开主窗口时也保持该占用。本地模型权重需额外内存；空闲卸载后，下次本地听写会因重新加载而稍慢。手动释放模型会取消自动恢复；「释放空闲资源」保留自动恢复能力。录音或识别中不可回收，麦克风预热保持开启以避免漏掉开头。Windows 使用软件图形合成减少悬浮条的图形缓存，所有渲染窗口启用沙箱。

## 开源范围与许可

本项目以 MIT 许可证发布，是独立实现，不隶属于 Typeless，也不包含其客户端源码、录音、原始历史、截图或逆向取证产物。应用图标由 `scripts/make-icon.mjs` 生成。第三方依赖保留各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 `licenses/`。

首次安装不会预设任何个人服务器地址。在「设置 → 账户」填写自己的 HTTP / HTTPS 地址后登录；已有安装保留其保存的地址。客户端会读取服务端能力：关闭公开注册时隐藏注册入口，未配置邮件时隐藏密码找回入口。不需要验证码的私有实例可直接注册。

提示词由本项目自行编写，听写、翻译、问答与按应用路由由 `src/shared/prompts.ts` 和 `src/shared/promptLibrary.ts` 管理。随记在服务器上是明文存储，管理员能够读取；当前不提供端到端加密。

源码仓库只跟踪可编辑工程、测试、构建配置和许可。`.env`、密钥、API 凭据、用户数据、日志、安装包和本机取证目录都不进入源码发布。`private: true` 用于防止意外发布到 npm，不影响代码开源。

本地验证后执行 `pnpm package` 生成 Windows x64 NSIS 安装器。开发过程使用本地 Git 管理，源码压缩包按需生成，推送 GitHub 须明确授权。需要完整归档时，在提交后运行 `pnpm release:archives` 生成源码 ZIP、服务端 tar.gz 及 SHA-256 清单；归档来自已提交的 Git 内容。安装器未配置代码签名时为未签名版本。

服务端部署见 [server/README.md](server/README.md)。Docker 只提供账号与同步；ASR、语言模型和可选本地模型由客户端独立配置。语音模型权重不包含在安装器和源码包中，下载后遵循各模型自己的许可。

## 自测

```powershell
pnpm test                     # 单元测试及自动启动本地真实服务端的历史/随记联调测试
pnpm typecheck

# 端到端（跳过静音门槛，全程指向假后端：听写 / Ask+检索 / 多模态 三条链路）
pnpm mock
$env:TYPELESS_SELFTEST='1'; $env:TYPELESS_IGNORE_SILENCE='1'
node_modules\electron\dist\electron.exe .

# 只截 UI，不需要人操作
$env:TYPELESS_CAPTURE='1'     # → screenshots\hub-*.png、prefs-*.png、bar-*.png
```

`scripts/mock-openai.mjs` 还带 A–I 九个检索场景：`curl http://127.0.0.1:8787/__scenario?id=C` 切场景后，下一次 Ask 就会走「官方文档优先 / 旧文剔除 / 转载折叠 / 数值冲突」这些分支，`src/main/ask-acceptance.test.ts` 用同一套场景做离线断言。

辅助脚本：`scripts/mock-openai.mjs` 提供假 ASR / LLM / Gemini / SearXNG；`scripts/make-icon.mjs` 可重新生成图标。

## 变更记录

- **v0.8.3**：翻译回到「只用翻译分类自己的卡片」——主模式 / 主卡片只作用于听写这类场景，不干预翻译（它是独立业务）；年度活动热力图加了悬停反馈（已上色格子在自己那个蓝上再深几度，空格子加灰，月份标题不跟着变色）；首页「最近识别」的「全部记录 →」改为跳到侧栏「历史记录」而不是弹设置，模式标签「问任何问题」简称 Ask；「窗口归类」页顶部的三步路由说明收进标题行右侧的 ⓘ（悬停给一句话、点击展开精简版）。
- **v0.8.2**：提示词页收口——删掉「使用内置提示词」「手写提示词（听写/翻译）」「术语表」三块，只留润色开关、温度和「Ask 附加要求」；术语表统一由侧栏「词典」管理。关掉自动激活后，主模式 + 主卡片现在**对所有模式生效**（此前翻译仍固定用翻译卡，看起来像没生效）。`polish.askPrompt` 从「整体替换」改为「追加在内置问答提示词后面」。
- **v0.8.1**：首页「最近识别」的复制改走主进程剪贴板（`file://` 下 `navigator.clipboard` 无权限，点了没反应），空内容条目不再误显示「已复制」；年度活动热力图去掉误标在未来日期上的蓝色描边，「今天」只说真话；月份轴修掉「两个 10 月 + 11 月被挤掉」——同名月份保留最近一次、间距阈值降到 2 列、末位标签左移避免裁切。
- **v0.8.0**：Ask 提速（并发检索/并发精读/单轮工具/SSE 流式）、本地 ASR 提速与保活、悬浮条模式标签、窗口归类、按应用自动切提示词。

## 已知坑

- **FFmpeg 编码支持**：启用 Opus 需要带 libopus 的 FFmpeg，或使用 Chromium 已捕获的压缩副本；编码器不可用时保留 WAV，不影响转写。
- **`ELECTRON_RUN_AS_NODE=1`**：本机若设了该环境变量，`electron.exe` 会退化成纯 Node，报 `Cannot read properties of undefined (reading 'getPath')`。启动前清掉。
- Electron 主进程走 **CJS**：ESM 下 `import { BrowserWindow } from 'electron'` 运行时报 `does not provide an export named 'BrowserWindow'`，所以 `package.json` 不设 `"type": "module"`。
- pnpm 11 不再读 `package.json` 的 `pnpm.onlyBuiltDependencies`，构建脚本白名单要写在 `pnpm-workspace.yaml` 的 `allowBuilds`。
- koffi 回调里解码指针：参数声明成 `const KBDLLHOOKSTRUCT *` 才会自动解成对象；声明 `intptr_t` 拿到的是 number，`koffi.decode` 会报 `expected external or TypedArray`。
- 粘贴回退会短暂占用剪贴板，设置里可开启「粘贴后恢复剪贴板内容」。
- 工具 Agent 依赖模型的函数调用能力：支持 `tools`/`tool_calls` 的直接走原生调用，不支持的（或网关回 400/404/422 等）自动降级成「只输出一个 JSON 意图」的模式，能力弱一些但不会整条失败。

## 与 Typeless 的差异（有意为之）

- 登录可选；登录成功会开启同步，可在「设置 → 账户」关闭。同步包含听写文字、随记和随记录音，听写录音仅保存在产生它的本机。服务端不提供支付，套餐和配额由管理员设置。
- ASR/LLM/Gemini 需通过保存的模型配置接入；默认没有可用模型连接。
- 检索先用模型判断再决定是否联网（Typeless 由服务端决定）；回答里的来源列表是本项目加的，方便核对。
- 提供首次使用引导；没有团队空间和支付订阅流程。
