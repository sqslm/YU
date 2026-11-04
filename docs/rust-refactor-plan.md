# Rust 渐进重构计划

**目标：** 保留 Electron 外壳，以实测为依据降低本机内存、CPU 开销和交互延迟。

**架构：** React、preload、窗口、托盘、更新、凭据管理和业务编排继续使用 TypeScript；Windows 原生能力逐步迁入独立 Rust 辅助进程。辅助进程使用继承的本地管道通信，不增加监听端口。系统接口和模型保留故障隔离、按需启动和退出回收；纯像素匹配通过既有 Koffi 加载 Rust DLL，避免跨进程传图，不持有像素指针。

**工具链：** 现有 Rust stable MSVC / Windows SDK、微软 windows-rs、serde_json、Electron、TypeScript、Vitest。原生程序静态链接 CRT，最终用户无需安装 Rust 或单独的 VC++ 运行库。

本文件是后续重构的统一待办与验收记录。每次先更新当前任务，再实施和验证；完成阶段后登记证据、限制与提交，避免仅把“已写代码”当作完成。

## 阶段与优先级

| 顺序 | 范围 | 状态 | 完成条件 |
| --- | --- | --- | --- |
| 1 | 全局热键 | 已完成，`fc05bab` | Rust 事件循环替代 JS 轮询；手势回归、真实钩子退出、构建及性能对比通过 |
| 2 | UIA 焦点控件读取 | 已完成，`88377c9` | 原窗口校验、快照字段、超时和故障隔离已保留；真实控件读取及性能对比通过 |
| 3 | Windows 操作桥接 | 已完成，`d3d4008` | 四项高开销操作已迁移，权限/取消/错误与真实结果验收通过；其余按下表保留 |
| 4 | 滚动截图等计算热点 | 已完成，`c4d4ca5` | 已迁移纯像素匹配，借用 Buffer 避免传图；CPU 采样、三方案与结果一致性验证通过 |
| 5 | 本地 ASR / 记忆模型包装层 | 已完成分析与优化，`872e5b5`；保留 TS | 只读召回避免 SDK 开销；修复延迟启动进程回收并去掉 PCM 中间数组，ASR 解码未测 |
| 6 | GDI 截图采集 | 已完成，`00d652c`；阶段 7 已复核内存 | [开发计划与结果](plans/2026-11-03-rust-gdi-capture-dsh.md)：采纳缓存绑定的 TS，未上线 Rust；1080p P50 14.1→12.3ms、P95 20.8→18.7ms；6.5 GB 私有内存在“释放引用 + 显式 GC + 空闲”探针条件下可回收，不覆盖全部生产场景 |
| 7 | 记忆关系图纯计算评估与上一阶段核验 | 已交付 `4bb22dc`，采用 TS；Rust 未上线 | [开发计划与结果](plans/2026-11-03-rust-memory-graph-dsh.md)：报告为 512 维、21/81/200 节点，算法对比在 Electron 主进程，最终版另测 worker 往返；文档维数与测量范围由阶段 8 校正为 512 维、21/81/200 节点与主进程/worker 的真实边界 |
| 8 | 常驻语音唤醒宿主与设备枚举 | 已交付并接入，`d31a0a4`；归因由阶段 9 修正 | [开发计划与续做结果](plans/2026-11-03-rust-voice-wake-dsh.md)：Rust 监听/枚举、PS 学习；原报告 ready P95 1123→572ms、私有 75.5→13.3MB。阶段 9 复核发现事件掩码缺 SDK 校验位、格式 GUID 写错、音频时间轴与资源清理问题，原「机器限制」归因已被推翻，性能数字不代替功能验收 |
| 9 | Rust 唤醒正确性与资源回收 | 已完成，`44335c6` + 续做 | [修复计划与结果](plans/2026-11-03-rust-wake-correctness-dsh.md)：SDK 掩码/GUID、读取/回收已修；旧 PS 学习 IPA 经系统 `SAPI2UPS` + `FormD` 与 Rust 逐值一致；同一 PID 622s 会话两次唤醒在 600s 之后、私有内存 32.9–33.2MB 平稳；ready P95 1277→597ms（各 20 样本） |
| 10 | Windows 本地 TTS 宿主 | 已接入 `4ad5cdd`；验收缺口由阶段 11 补齐 | [交付记录](plans/2026-11-04-rust-local-tts-dsh.md)：按需 Rust SAPI helper 已接入；原始报告的残留检测、计时与文本边界缺口已在阶段 11 修复并复测；真实声卡听辨未测 |
| 11 | 本地 TTS 正确性与验收证据校正 | 已完成 `cd4925c`；helper 336896 B / `2bafa91e…` | [交付记录](plans/2026-11-04-rust-local-tts-correctness-dsh.md)：残留探测、采样时机、生产运行器覆盖、NUL 拒绝与 SAPI 失败出口已修，基准改按 close 收尾；校准后 `started` P95 1491→396ms、私有内存 −85%，真实声卡/热插拔未测 |
| 12 | 本地 TTS 生命周期观测与验收口径对齐 | 已完成 `9c07ce7`；helper 源码未改，重建后 336896 B / `e5664328…` | [开发计划与结果](plans/2026-11-04-rust-speech-lifecycle-dsh.md)：生命周期 CPU 差分与朗读期峰值内存可复现采集；总计划/阶段计划/README 未测项措辞一致；证据落 `rust-speech-lifecycle-<日期>.json` |
| 13 | 浏览器地址读取 | 已完成；392704 B / `52266cd4…` | [开发计划与结果](plans/2026-11-04-rust-browser-url-dsh.md)：`browser-url` 迁入一次性 Windows helper；原窗口、地址候选与权限边界一致，真实 Edge 对照 + 每侧 40 样本达标后接入 |
| 14 | 资源管理器文件夹读取 | 已完成；396800 B / `aa9232e5…` | [开发计划与结果](plans/2026-11-04-rust-explorer-folder-dsh.md)：`explorer-folder` 迁入一次性 Windows helper；Shell 窗口绑定与原窗口校验一致，真实资源管理器对照 + 每侧 40 样本达标后接入 |

聊天、笔记、日历、存储和网络编排目前保留 TypeScript。查询算法、同步阻塞、模型加载、隐藏窗口和缓存生命周期优先通过原架构优化。保持既有数据格式、持久化位置与记忆学习范围；本计划不进行数据库迁移。

## 阶段 1：已完成基线

- 实现：`native/hotkey/`、`src/main/hotkey/host.ts`。
- 证据：[`rust-hotkey-20261103.json`](../tests/yu-v2/evidence/rust-hotkey-20261103.json)。热键辅助进程私有提交内存约 33–34 → 1 MiB，工作集约 61–64 → 5.3 MiB，注入按键到主进程事件 P95 约 16–17 → 0.3–0.5 ms。
- 验证：3454 项客户端测试通过、8 项跳过，14 项 Rust 测试通过；类型检查、生产构建和独立审查通过。
- 限制：上述为辅助进程测量，非整机/整应用收益；CPU 降幅尚不能可靠量化，实体键盘、UAC 与锁屏仍需人工验收。

## 阶段 2：UIA 实施清单

### 2.1 理解与技术决策

- [x] 阅读 `src/main/uia/{host,child,reader}.ts`、调用链、资源统计和现有测试。
- [x] 使用微软生成的 COM 接口绑定，替代手写 vtable 与 BSTR 指针管理。
- [x] 使用不拥有窗口的 MTA 线程读取 UIA，保留与热键、Electron 的进程隔离。
- [x] 发现旧控件 ID 表与 Windows 官方枚举不一致；迁移时改用官方标识，补充 Edit=50004 / Document=50030 回归。

决策依据：独立原生程序可以移除 UIA 包装层的 Node 开销；COM 对象使用 RAII 释放。代价是增加一个原生构建产物和 Windows 真实控件验收。这里复用热键阶段的简单管道方式，不搭建通用 RPC 框架。

### 2.2 原生实现

- [x] 新建 `native/uia/`，编译输出 `native/bin/yu-uia.exe`。
- [x] 接口：启动报告 `ready`；接收 `{type:"read", id, target?}`；返回 `{type:"result", id, snapshot}`，无可用数据为 `null`。
- [x] 保留 `UiaSnapshot` 的字段和末尾 4000 个 UTF-16 单元的限长语义；正确释放 COM/BSTR，避免截断产生损坏字符。
- [x] 只读 ValuePattern；不引入过去导致 provider 崩溃的 TextRange 调用。
- [x] 密码控件不返回快照；诊断不记录管道输入正文或控件内容。
- [x] 读前与读后检查同一个原窗口的句柄、PID 和标题；切换窗口即丢弃结果，不打印控件正文。
- [x] 父管道 EOF 时退出，包含 provider 卡住时的清理路径；可疑 provider 故障只影响 UIA 子进程。

### 2.3 Electron 接入

- [x] `src/main/uia/host.ts` 改为原生管道，保持按需 warm、启动等待、读取预算、崩溃重试上限、闲置回收和显式释放。
- [x] 卡住的读取到期后终止失去响应的进程，避免后续请求一直排在它后面；迟到消息不影响新进程。
- [x] 更新 `scripts/build-native.mjs`、`electron-builder.yml` 与 `electron.vite.config.ts`，移除旧 UIA 构建入口。
- [x] 资源统计包含 UIA 原生 PID；无法读取的值保持不可用，不算作零。
- [x] 移除旧 COM 实现，保留独立类型契约；同步中英文 README 和依赖许可。

### 2.4 验收与提交

- [x] 主机测试覆盖启动/读取、分块管道、窗口目标、超时终止、有限重启、停止、闲置回收与迟到消息。
- [x] Rust 测试覆盖控件标识、UTF-16/中文/emoji 限长、目标匹配，以及读后窗口切换丢弃。
- [x] 使用本轮创建的固定测试窗口，真实验证可编辑控件、只读值、长中文文本、非 ValuePattern、失配目标与 EOF；不读取用户正在操作的窗口。
- [x] 基线对比：旧提交 `fc05bab` 的 UIA 辅助进程与新程序，同机、同一个固定测试控件、交错两轮，分别记录启动、读取延迟、私有内存与工作集；比较结果但不预设速度一定提高。
- [x] 执行 `pnpm test:native`、UIA/资源/管线相关测试、`pnpm typecheck`、`pnpm test`、`pnpm build`，以及 Cargo 格式/Clippy 检查。
- [x] 独立代码审查通过；清理本轮临时窗口、探针和编译暂存，保留有效程序与原始测量。
- [x] 更新本文的结果记录，本阶段代码与本文一起提交，不推送或发布安装器。

### 阶段 2 结果

实现：`native/uia/`、`src/main/uia/{host,types}.ts`；旧 UIA TypeScript/COM 实现和构建入口已移除。原生 PID 接入资源统计，构建复用内容相同且仍在运行的热键程序。本阶段提交标题为 `refactor(uia): migrate context reader to Rust`，实现与本文一起归档。

验证：3464 项客户端测试通过、8 项跳过；Rust 22 项通过（热键 14、UIA 8）。类型检查、生产构建、Cargo 格式/Clippy、独立审查通过。真实合成控件验收覆盖可编辑、只读、长中文/emoji、非 ValuePattern 按钮、密码框、失配目标，以及 provider 阻塞时父管道 EOF 退出（约 2.7ms）。已确认二进制 SHA-256 与报告一致，导入表无需单独 VC++ 运行库；生产构建中不再包含 `uia.js`。

性能证据：[`rust-uia-20261103.json`](../tests/yu-v2/evidence/rust-uia-20261103.json)，基线 `fc05bab`，同机同控件交错两轮：

| 辅助进程指标 | 旧版 | Rust |
| --- | --- | --- |
| 私有驻留内存（不含共享页） | 18.7–18.8 MiB | 1.8–1.9 MiB |
| 私有提交 | 31.7–31.9 MiB | 2.4–2.5 MiB |
| 工作集（含共享页） | 110.7–110.9 MiB | 15.9–16.0 MiB |
| 读取 P95（含 UIA / IPC） | 3.9–4.3ms | 3.1–3.2ms |
| 就绪加首读 | 92–102ms | 39–45ms |

边界：只衡量 UIA 辅助进程，不把工作集差额当作整应用节省的物理内存；CPU 采样不足以推断降幅。测试使用固定的合成窗口，焦点不稳定的尝试直接失败、未计入报告。真实厂商应用、UAC/锁屏/权限桌面与安装升级仍待人工验收。现有运行中的开发版需正常重启才加载新主进程代码，本轮未终止用户的热键进程。

产物：保留 `native/bin/yu-uia.exe`（325 KiB）、正式前端/主进程构建与原始报告；清理本轮 UIA 编译暂存约 422 MiB，以及测试窗口和隔离探针。未清理已有热键缓存或用户数据。

## 阶段 3：Windows 操作桥接实施清单

### 3.1 调用盘点与边界

以下为代码调用结构，不是采集用户日志得出的使用频率：

| 操作 | 已确认调用路径 | 本轮处理 |
| --- | --- | --- |
| `window-check` | 原窗口截图前后各调用一次，每次启动 PowerShell 并编译 C# | Rust 直接校验句柄、PID、标题与最小化状态 |
| `ocr` | 截图 OCR/翻译、助手图片正文，每张图调用一次 | Rust WinRT OCR，保留语言选择、6 MiB 限制、行框和中文间距规则 |
| `system-volume` | 每次查询或修改系统音量 | Rust Core Audio；测试只读或拒绝无效参数，不改变用户音量 |
| `disk-space` | 每次查询磁盘容量 | Rust Win32，只返回就绪的固定/可移动盘，保留容量字段 |
| `applications` / `activate` / `recent-files` | 用户明确查询、启动或检索时调用 | 保留现有 PowerShell/Shell 行为，避免同时重写 AUMID、注册表和快捷方式语义 |
| `search` | 用户文件元数据检索 | 保留 Windows Search/OLE DB 与有界遍历，独立评估索引和权限语义 |
| `browser-url` / `explorer-folder` / `current-content` | 原窗口网页、目录、Office 文档读取 | 保留现有 UIA/Shell/Office 读取规则，本轮不改 |
| 语音唤醒 / TTS | 独立长生命周期脚本 | 不属于此桥接调用，不迁移 |

决策：新建按请求启动、完成即退出的 `yu-windows.exe`，不增加常驻进程。TypeScript 按明确的操作列表路由；已迁移操作失败直接报错，不退回 PowerShell 重试。保留工具层原有权限、目录与排除校验，不给原生程序开放通用命令执行。

### 3.2 实施与验收

- [x] 核对旧脚本、工具层和截图调用，查阅 Win32/Core Audio/WinRT OCR 官方 API。
- [x] 新建 `native/windows/`，实现以上四项操作及固定 JSON stdin/stdout 协议；输入错误明确失败。
- [x] 保留原窗口校验错误、默认多媒体输出设备、音量范围、磁盘可用空间和 OCR 返回字段；图片仅在内存处理，不上传、不写临时图。
- [x] 更新 `windows-native.ts` 的显式路由，保持取消、15 秒超时、输出限制和 UTF-8；移除已迁移脚本分支和旧音量脚本。
- [x] 接入原生构建、ASAR 外资源、许可证和 README；不终止用户正在使用的热键/UIA 进程。
- [x] Rust 测试覆盖参数验证、窗口/音量边界、中文 OCR 间距；主机测试覆盖路由、取消、超时、错误和输出限制。
- [x] 真实验证磁盘读取、音量只读、生成图片 OCR 及独立合成窗口的校验/改标题/最小化；不读取用户窗口或改变真实音量。
- [x] 同机比较旧提交 `88377c9` 的 PowerShell 与新程序的完整单次请求耗时（含进程启动）；不把瞬态辅助进程耗时当成整应用收益。
- [x] 全量客户端与原生测试、类型检查、生产构建、格式/Clippy、独立审查通过；保存原始报告。
- [x] 更新本文状态和结果，清理本轮编译暂存/测试窗口与隔离数据，随代码一起提交。

### 阶段 3 结果

实现：`native/windows/` + `src/main/windows-native.ts`。四项原生操作按请求启动、完成退出，父进程身份使用进程句柄监视；即使请求管道由其它进程保持打开，声明的父进程死亡仍会退出。磁盘查询保留本进程继承的错误模式，并抑制无介质时的系统弹窗。已迁移脚本分支与旧音量脚本已移除；应用发现、文件检索、最近文件、Office 等未迁移操作按上表明确保留，不自动回退。本阶段提交标题为 `refactor(windows): move frequent native operations to Rust`，代码与本文一起归档。

验证：3483 项客户端测试通过、8 项跳过；原生 26 项通过（热键 14、UIA 8、Windows 桥接 4）。类型检查、生产构建、格式/Clippy、独立审查通过。真实对照验证窗口/PID/改标题/最小化/关闭、只读音量、无效音量、OCR 语言包缺失、OCR 文本/行框全字段相等，以及磁盘标签/总容量相等和已用+可用=总容量。探针退出路径的审查问题已修复，取消/15 秒期限/输出限制/缺失程序不回退均有回归。

性能证据：[`rust-windows-20261103.json`](../tests/yu-v2/evidence/rust-windows-20261103.json)，基线 `88377c9`，同机按 PowerShell/Rust/Rust/PowerShell 顺序比较，每项每轮 1 次预热后取 5 个样本：

| 完整请求中位耗时（含进程启动与退出） | PowerShell | Rust |
| --- | --- | --- |
| 窗口校验 | 883–936ms | 20–21ms |
| 磁盘容量 | 792–794ms | 22–23ms |
| 音量只读 | 902–910ms | 27ms |
| 内存图像 OCR | 891–898ms | 51–54ms |

边界：以上仅为桥接请求，不能代替整应用/厂商页面的端到端体验。报告中的 CPU 时间累计全部辅助进程线程，可能大于墙时间，受系统计时粒度限制且不包含 PowerShell 的编译器子进程；0 计时不等于零 CPU，占用百分比与峰值 RAM 未单独测定。测试使用透明不激活的自有窗口，不切换用户前台焦点、保存用户路径或改变音量。写音量路径仅做参数拒绝和实现审查，未为验收改变真实设置。

产物：保留 `native/bin/yu-windows.exe`（355 KiB）、正式应用构建与原始报告。累计清理本轮 Windows 桥接的编译暂存约 974 MiB、隔离旧脚本副本和测试窗口；不清理已有热键/UIA 缓存或用户数据。当前运行中的开发版需正常重启以加载新的主进程路由，本轮不终止其进程。UAC/权限桌面、热插拔设备与厂商兼容仍需人工验收；下一阶段先分析截图计算热点。

## 阶段 4：滚动截图计算热点

### 4.1 分析与选择

- [x] 核对 `scroll-capture.ts`、`screenshot-tool.ts` 与现有拼接回归；只分析合成图像，不采集用户桌面。
- [x] 使用 V8 CPU 采样确认重叠评分和变化掩码为热点；初测 4K 匹配 56–62ms，超过 50ms 采样间隔。
- [x] 比较原 TypeScript、只计算采样列的 TypeScript，以及 Rust；同时记录拷贝/管道成本。
- [x] 依据总成本选择实现，保留固定头尾、光标干扰、重复行拒绝、图像尺寸与拼接上限。

决策：沿用既有 Koffi 调用纯计算 Rust DLL，直接借用 Buffer、不持有像素指针，无跨进程传图。只生成评分实际采样列的变化掩码，沿用评分与拒绝阈值。4K 稀疏掩码 TypeScript 仍需约 47–48ms；独立的单帧二进制管道发送/确认探针约 13.4ms（不含算法/启动，使用 Node 接收，不是 Rust 后端总耗时）。因此本轮采用 DLL，减少复制与生命周期代码。它不能提供进程故障隔离；只将经过边界验证、不调用 OS 的纯内存算法放在这里，UIA/COM/模型仍保留独立进程。

### 4.2 实施与验收

- [x] 保存可复现的 CPU 采样、延迟、CPU 时间、临时掩码大小和传输开销报告，注明测量范围。
- [x] 使用既有工具链，不新增 npm 依赖；将有效原生产物接入构建和包资源。
- [x] 对照旧提交做确定性边界/随机图像/连续拼接/缩略图一致性验证，不以速度代替正确性。
- [x] 运行相关回归、全量测试、类型检查、生产构建与 Rust 格式/Clippy。
- [x] 更新 README 和本计划，清理本轮临时产物并提交；保留用户运行中的程序和数据。

### 阶段 4 结果

实现：`native/scroll/`、`src/main/scroll-match.ts`；`ScrollCapture` 的同步接口、图块/固定尾部管理、缩略图和停止逻辑保留 TypeScript。首次匹配才加载 `native/bin/yu-scroll.dll`，打包在 `resources/native/`。FFI 两侧校验尺寸、像素上限和两帧字节数；输入只读、输出为独立三整数，Rust 调用结束释放掩码与评分数组。无新 npm/第三方 crate 依赖、无端口或图像临时文件。提交标题为 `refactor(screenshot): move scroll matching to Rust`。

验证：3487 项客户端测试通过、8 项跳过；原生 30 项通过（热键 14、UIA 8、Windows 桥接 4、截图匹配 4）。类型检查、生产构建、Rust 格式/Clippy 和差异审阅通过。400 组尺寸/彩色像素/静止/向上/失配/固定边缘差分对照，加上两条各 21 帧的连续拼接与逐像素缩略图对照，共 442 组通过。现有光标光晕、重复文字、固定尾部边界和内存上限回归全部通过。实际 Electron 42.11.18 / Node 24.19.0 的 NativeImage → Koffi → DLL 验证通过；无用户桌面抓取。打包路径、缺失 DLL、输入错误与 Buffer 身份有回归；原生产物哈希与报告一致，x64 PE 仅导出固定 C 接口且无需单独 VC++ 运行库。

证据：[`rust-scroll-20261103.json`](../tests/yu-v2/evidence/rust-scroll-20261103.json)，基线 `d3d4008`。按原版/稀疏 TS/Rust/Rust/稀疏 TS/原版交错运行，每项 3 次预热后采 7 个样本；V8 CPU 采样在计时后单独进行，记录转译源码行号。

| 合成帧尺寸 | 匹配中位耗时：原版 → Rust | 首帧登记+匹配+图块追加+原始缩略图：原版 → Rust |
| --- | --- | --- |
| 1280×720 | 17.6–17.9 → 4.9–5.0ms | 18.0–18.4 → 5.2–5.3ms |
| 1920×1080 | 27.1–27.3 → 7.3–7.4ms | 28.4–28.9 → 7.8–8.0ms |
| 3840×2160 | 64.1 → 14.7–15.4ms | 65.7–65.8 → 16.3–18.0ms |

4K 无匹配帧约 66.7–72.4 → 18.6–18.8ms，静止帧约 0.017 → 0.004ms。4K 变化掩码由 8,294,400 字节缩为 131,760 字节（约 7.9 MiB → 129 KiB）；这是明确的临时分配，不是整应用峰值 RAM。两帧额外复制探针约 5.6ms，DLL 路径通过 Koffi 的原始缓冲区指针直接借用，无这一份整帧复制。首次 DLL 调用约 0.63ms，未清空 OS 文件缓存；加载的代码映射留到主进程退出。

边界：以上不含 GDI 读取、PNG 编码、renderer/IPC 和屏幕合成，不承诺端到端帧率或整应用 CPU/内存降幅。CPU 时间有系统计时粒度，单样本 0 不代表无 CPU 开销。DLL 仍同步执行且与 Electron 共享故障域，无 OS 调用或 provider 阻塞路径；系统接口的超时/隔离不受影响。未以实际网页或用户桌面验证所有动画/滚动样式。

产物：保留约 199 KiB DLL、正式应用构建和约 71 KiB 原始报告；清理本轮截图及验证时重新生成的 Windows 桥接编译暂存约 410 MiB，以及隔离 Electron 配置和日志。已有热键/UIA 缓存、运行中的开发版及用户数据保持原状。正常重启开发版后加载本阶段代码；下一阶段先分析 ASR/记忆包装层与原生推理的各自占用。

## 阶段 5：本地模型包装层分析与回收

### 5.1 分析与边界

- [x] 核对 ASR/记忆 worker、主机、超时、暂停、加载和闲置回收调用关系；复用既有本地模型，不下载或移动用户模型。
- [x] 在隔离 Electron 中测量空 utility process、原生运行时导入、记忆 SDK、嵌入模型及推理，分别记录 JS heap、私有驻留/提交内存和延迟。
- [x] 比较音频预处理和跨进程调用开销，明确哪些开销仍来自 ONNX 推理及 SDK。
- [x] 依据实测决定保留 TypeScript 或迁移；不得将模型权重占用当作换语言即可消除的内存。

决策：保留 TypeScript 包装层及原生推理。Mem0 导入约增加 130 MiB 私有驻留、耗时约 0.9 秒，嵌入模型随后约增加 45 MiB。只读召回复用现有 SQLite 目录模块，按固定 Mem0 2.4.6 的 float32/余弦/稳定排序/分类条数语义搜索，避免加载整个 SDK；所有学习与写操作继续由 SDK 执行。不新增存储格式、原生运行时或通用后端接口。把外围 RPC 改成 Rust 无法直接去掉 SDK 与推理引擎；本轮先消除已测得的导入和中间数组开销。

当前 ASR 使用 sherpa-onnx-node 1.13.8 + 原生 C API/ONNX Runtime，记忆使用 Mem0 2.4.6 + Transformers.js 的原生 ONNX Runtime。Rust 迁移需维持同版 C ABI、tokenizer、512 维归一化语义、既有 SQLite 格式和本地学习边界；不同时升级推理库或引入第二套模型。模型评估仅用合成数据和隔离库，不读取个人记忆或录音。

### 5.2 验收

- [x] 确认取消/退出在 PID 延迟出现时仍能清理进程；修复经验证的回收问题并补回归。
- [x] 保存分层基线、可复现探针、CPU/内存测量和限制；不宣称未测的 ASR 识别速度。
- [x] 运行相关与全量测试、类型检查、生产构建；同步 README 和本计划。
- [x] 清理本轮隔离数据与暂存，保留模型和用户进程，提交完整阶段。

### 阶段 5 结果

实现：`memory/catalog.ts` 增加固定格式只读搜索，以 SQLite 流式读取本用户向量，避免 SDK 将全部向量反复转换成 JS 数组；`memory/worker.ts` 的召回在加载 SDK 前完成，写操作继续使用原实现。`memory/host.ts` 在取消后收到迟到的 spawn 时再次终止旧进程，沿用 ASR 的既有处理。`local-asr/worker.ts` 直接将 WAV 数据转换为 Float32，去掉中间 Int16Array，保留字节偏移、RIFF 填充与截断行为。无新依赖、Rust 程序或数据迁移。提交标题为 `refactor(models): reduce local worker overhead`。

验证：3493 项客户端测试通过、8 项跳过，类型检查、生产构建和差异审阅通过。覆盖全部 65,536 个 PCM16 值、非零/未对齐缓冲区偏移、奇数 RIFF 块、空/截断音频、缺少 data 错误；新旧生成 Float32 的哈希一致。主机回归先复现旧的延迟启动漏清理，再确认旧进程退出且替代进程不受影响；实际 Electron API 探针确认 PID 未出现时 kill 返回 false，spawn 后返回 true 并退出。

只读检索对照：每轮 1000 条合成向量，包含不同范数、重复/零向量及其他用户；每轮 16 个查询、共 32 组，与固定 Mem0 2.4.6 的结果 ID、元数据、分数一致。另以原版 worker 写入两类合成记忆，再在同一个库上交错比较新旧 worker，原版 SDK 与新召回的完整结果一致。新 reader 通过模块钩子禁止导入 Mem0，两类数据库的读前/读后 SHA-256 一致；单位回归覆盖分类 5/3 条上限、稳定同分排序、只读与尺寸错误。现有学习/隐私回归全部通过。升级 SDK/存储格式时必须重跑对照。

证据：[`model-workers-20261103.json`](../tests/yu-v2/evidence/model-workers-20261103.json)，基线 `c4d4ca5`，实际 Electron 42.11.18 / Node 24.19.0，复用现有约 23 MiB BGE q8 模型，哈希符合当前固定版本。每项一轮预热后测七次，完成两轮；实际 reader 按旧/新、新/旧顺序比较。ASR 和记忆使用不同 utility process，避免各自 ONNX DLL 冲突。

| 记忆辅助进程指标 | 原版 | 本阶段 |
| --- | --- | --- |
| 私有驻留内存 | 199.6–215.2 MiB | 76.4–76.5 MiB |
| 私有提交内存 | 250.1–265.3 MiB | 123.4–125.6 MiB |
| 首次召回（含导入和模型加载，不含进程启动/init） | 1106–1126ms | 188–203ms |
| 单条合成记忆热召回中位耗时 | 1.16–1.17ms | 1.32–1.39ms |
| 1000 条合成向量查询，含同一个嵌入模型 | 15.8–17.8ms | 11.3–11.6ms |

取舍：每次只读查询重新打开 SQLite 连接，不常驻 SDK/向量缓存；单条记忆的热查询增加约 0.2ms，换取首次召回及约 123–139 MiB 私有驻留的改善。模型和学习时的原生占用仍存在。60 秒音频直接转换约 1.27–1.35 → 0.68–0.69ms，180 秒约 3.8–5.8 → 1.9–2.0ms，后者去掉 5,760,000 字节（约 5.5 MiB）中间 PCM；带校验哈希的跨进程探针约 14.2–16.5 → 11.5ms，不是 ASR 解码耗时。

边界：本机 ASR 关闭，项目与配置目录中未发现已安装识别模型；未下载模型、未读取录音、未测真实 ASR 解码，暂不迁移其原生包装。内存是辅助进程采样而非整应用峰值，分层导入采用累积测量，不能把差值完全归因于模型权重。未清空 OS 文件缓存；CPU 时间受系统计时粒度影响，不推断整个应用的占用百分比。模型、个人记忆、学习范围、自动回收与数据位置保持原状。

产物：保留正式应用构建、探针和约 47 KiB 原始报告；隔离数据库/模型会话配置在退出后清理，未复制模型。回收本轮验证重新生成的 Windows/截图编译暂存约 177 MiB 及测试日志；未清理原有缓存或用户进程。正常重启开发版后生效。原五阶段的实现/分析已完成，上文未测的真实环境验收继续保留；今后只在新证据表明收益时追加迁移，ASR 原生重写仍需同版引擎的真实解码对照。

## 第六阶段结果

GDI 采集在同一个 Electron 进程内对本项目自有窗口做了三方案交错对照（A 基线原版、B 缓存 Koffi 绑定 + 直接返回原始 Buffer 的 TypeScript、C Rust DLL + 原始 Buffer），每变体 30 个样本：

- 1080p 采集到 Buffer：P50 约 14.1 → 12.3 → 12.2ms，P95 约 20.8 → 18.7 → 13.0ms；720p：P50 约 8.7 → 7.9 → 8.1ms。
- 三方案像素逐字节一致，200 次循环后 GDI/USER 句柄零增长，生产模块与三个被测实现哈希相同。
- **采纳 B，不采纳 C。** 生产实现缓存 9 个 API 绑定，并让滚动计时器直接使用 BGRA Buffer；原报告的 Rust DLL 相对 B 的 P50 仅 −2.5%～7.9%，未达到 10% 的采纳参考，因此不进生产代码、`scripts/build-native.mjs` 与安装包，`native/capture/` 只作为候选留档，DLL 由 `pnpm benchmark:capture` 自行构建到 gitignore 目录。

未测项：4K（无 4K 显示器，未做内存 DC 合成）、第二显示器与混合 DPI、UAC/RDP/锁屏、HDR、独占全屏、PNG 编码、renderer 往返与桌面合成等待；1080p 场景实际客户区被工作区裁到 1920×1032。详细证据见[本轮计划文末](plans/2026-11-03-rust-gdi-capture-dsh.md#实际实现与验收结果dsh2026-11-03)与 `tests/yu-v2/evidence/rust-capture-20261103.json`。

复核结果（阶段 7）：约 6.5 GB 私有内存是基准同步批次“分配快于回收”时保留的已提交内存——external 始终 19–65 MB，停止采样并 `gc` + 两次 400 ms 空闲后回到约 104 MB，再跑 100 次采集与 100 次 NativeImage 创建都不残留，生产路径无泄漏（证据 `tests/yu-v2/evidence/rust-capture-memory-20261103.json`）。两项唤醒失败用 `872e5b5` 的脚本在同环境复跑同样失败，根因是本机 zh-CN SAPI 在整句音频上返回听写假设，与本仓库改动无关（证据 `tests/yu-v2/evidence/wake-word-environment-20261103.json`）。

## 第七阶段结果

前置核验：唤醒失败在本机 SAPI 环境可复现（旧脚本同环境同样失败，未改阈值/期望），当时记为环境限制，阶段 8 已按产品缺陷修复；截图 6.5 GB 私有内存在“释放引用 + 显式 GC + 事件循环空闲”的探针条件下可回收，该结论不覆盖全部生产场景。

关系图计算用固定种子合成的 20/80/200 节点、512 维向量（真实行数 21/81/200）对照 A（`00d652c` 的 `graphLinks`）、B（零拷贝 float32 读取 + 每对只算一次的 TS）、C（B + Rust 余弦批量计算），A/B/C 在 Electron 主进程内交错三轮、每变体 30 样本；worker 往返只对最终实现另测（主进程 `process.cpuUsage()` 不能代表 worker CPU，`coldMs` 只是首次 graph 请求、不含启动与 `init`）：

- 200 节点 `readGraph`：P50 约 16.3 → 10.2 → 9.6ms，P95 约 17.7 → 11.7 → 11.0ms；`readCatalog` 3.6–4.4 → 1.8–2.3ms，`graphLinks` 9.5 → 5.9–6.7ms。
- 80 节点 −36%，20 节点 −20%（噪声内）；三场景 links 序列、得分与只读性均与基线一致。
- **采纳 B，不采纳 C。** Rust 相对 B 只快 6%～6.6%（0.55–0.62ms），未达“≥20% 且 ≥2ms”，因此不进生产代码、`scripts/build-native.mjs` 与安装包；`native/memory-graph/` 作为候选留档，DLL 仅由 `pnpm benchmark:memory-graph` 构建到 gitignore 目录。

未测项：真实 512 维规模与真实用户库、renderer 布局/力导向/250ms 防抖、PNG 导出；worker 往返只在最终实现上测过。详细证据见[本轮计划文末](plans/2026-11-03-rust-memory-graph-dsh.md#实际实现与验收结果dsh2026-11-03)与 `tests/yu-v2/evidence/rust-memory-graph-20261103.json`。

## 第八阶段结果

SAPI 语法竞争按产品缺陷修复，不是环境问题：`DictationGrammar{Weight=0.5f}` 在每段音频里只争一个假设，能解释整句时唤醒语法连事件都不产生（漏唤醒），而中文短语被当成单个词，原有的词级前缀 carry 对中文片段从不触发。修复保留完整短语规则、新增「短语 + 指令」与前后片段规则、删除后台听写、要求唤醒匹配起始于一次发声开始，并让学习采样保留短语语法。

- 语料（10 段合成，`Microsoft Huihui Desktop`）：修复前「你好胡小杨，帮我朗读一下随记。」漏唤醒，其余正负样本正确；修复后 4 个正样本全部唤醒（0.9940–0.9946），6 个负样本（词不完整、嵌长句、无关中文/英文、静音、噪声）全部不唤醒，`你好 + 2 s + 阿语` 停顿场景恢复（conf 0.9811、3140 ms）。
- 验收：`src/main/wake-word-native.test.ts` 4/4 通过（含新增语法语料用例），`wake-word.test.ts` 通过；两项此前记为「既有环境失败」的真实测试现在通过。
- 原宿主报告（`scripts/benchmark-wake.mjs`，三次样本，只测 helper）：枚举 907–923 ms / 峰值私有 49.2–51.8 MB；首次 ready P50 1076 ms、P95 1077 ms；监听后私有 74.9–75.5 MB。原 CPU 109–116 ms/s 的采样包含 ready 前的启动区间，却除以固定待命时长，不能作为稳定待命指标；原报告保留，续做批次须重新测量。这里的 helper CPU 包含 SAPI 识别，不能完全归因为 PowerShell/.NET 包装。
- **不采纳 Rust 进程本轮上线**：`native/wake` 只完成 waveIn 枚举（45–50 ms），没有 SAPI COM 事件链、语法与 carry，达不到「正负语料与既有设置行为」的前提，因此不接 `build-native.mjs`、安装资源和 `WakeWordHost`；监听继续由修复后的 PowerShell 承担。枚举候选留档，未接入。
- 未测项：真实讲话的准确率/误唤醒、热插拔、权限拒绝、RDP/锁屏；待命 CPU 未优化，父进程侧开销未计入。

**续做批次（同日）交付 `d31a0a4` 并接入 Rust 监听**：`native/wake` 实现 SAPI 事件读取、SRGS 规则与自有 waveIn/IStream；`WakeWordHost`、构建和资源使用 `yu-wake.exe`，学习仍用 PS。原报告记录 8 例合成语料和 30 次正常启停，枚举 912→54ms、ready P95 1123→572ms、私有 75.5→13.3MB；这些数据不证明所有行为已等价。源码复核发现 `SetInterest` 掩码缺 SDK 校验位、音频格式 GUID 写错，不能把原 API 错误直接归为机器限制；队列长度被当作时间轴，错误出口缺统一资源清理。文档原“900ms 无结果推断”也不能代替与源码一致的音频边界证据。上述问题由阶段 9 修复与复测；真实讲话/热插拔/RDP等仍未测。

## 阶段 9：Rust 唤醒正确性与资源回收（已完成）

阶段 8 记为「机器限制」的三处失败全部是本项目代码问题：`SetInterest` 漏了 SDK 要求的 `SPFEI_FLAGCHECK=(1<<30)|(1<<33)`（补上后四事件掩码返回 `S_OK`），`SPDFID_WaveFormatEx` GUID 写成 `c6e13340…`（应为 `c31adbae…`，改正后 `SetBaseStream` 成功），会话结束靠「文件字节数/32+1500ms」与 1200ms 宽限（改由 `SPEI_END_SR_STREAM` 收尾）。只有 `SpMMAudioIn::SetDeviceId(真实索引)` 仍返回 `0x80045002`，所以保留自有 waveIn + `IStream` 的采集路径。

- 时间轴与读取：`Shared::position_ms()` 由积压队列长度改为已消费字节（单调），结果、静音、carry 共用一条时间轴；`read()` 边消费边等待、`cb=0` 立即返回、超大请求可完成，溢出按整帧丢弃并计入 `dropped_bytes()`。
- 生命周期与回落：`Capture` 的 prepare/add/start 逐步检查并实现 `Drop`，部分初始化与所有错误出口统一 Stop/Reset/Unprepare/Close；设备索引消失时记录 `device-missing` 后回落系统默认，事件报**实际**设备名。
- 行为：完整短语、短语后接指令、700ms 跨段、2s 停顿、同音、片段、句中嵌词、无关中文、白噪声、10s 前置静音、10s 段内间隔、622s 连续会话（含 600s 后的正负语料）均按预期；`src/main/wake-word-rust.test.ts` 13/13。
- 性能复测（各 20 样本）：枚举 981→52ms，首次 ready P50/P95 1151/1277→546/597ms，待命私有 75.4→13.3MB；待命 CPU 在 250ms 采样下两侧多为 0，只能说未观察到稳定差异，不能写「无退化」。
- 音标兼容（续做批次）：旧 `ISpPhoneConverter` 输出拼音的问题已确认并修正，改用系统 `ISpPhoneticAlphabetConverter::SAPI2UPS` 加 `FormD` 去组合符，与 PowerShell 学习保存的 IPA 逐值一致（真实 ids `00e7 000b …` → `nihaʊhuɕjaʊjɑŋ`）；转换器创建失败只降级音标匹配，不影响文字唤醒，也不迁移用户训练数据。
- 十分钟会话（续做批次）：单进程 `pid 23520` 运行 622s，600s 后送入正/负语料，两次唤醒 602.809s/618.433s（conf 0.9921/0.9917），中间无关语音未唤醒；私有内存 32.9–33.2MB、句柄 296–299，无单调增长。会话脚本 `tests/yu-v2/fixtures/wake-long-session.cjs` 受跟踪。
- 未测：英文识别（本机只装 zh-CN 识别器，未下载语言包）；真实麦克风讲话、热插拔、RDP/锁屏、1 小时以上连续运行；`ready` 的 wave 模式（69ms）与设备模式（546ms）口径不同，不能互相替代。

证据：`tests/yu-v2/evidence/rust-wake-correctness-20261103.json`（本轮）；`rust-wake-20261103.json` 与 `rust-wake-listener-20261103.json` 原样保留。详细结果见[阶段 9 计划文末](plans/2026-11-03-rust-wake-correctness-dsh.md#实际修复与验收结果dsh2026-11-03)。

## 阶段 10：Windows 本地 TTS 宿主（已接入，复核整改见阶段 11）

基线 `95241cb`。原路径在每次音色枚举与朗读时启动 `powershell.exe`，由 `resources/speech.ps1` 加载 System.Speech 并在朗读期间每 25ms 检查控制输入。

- [x] 按[阶段 10 计划](plans/2026-11-04-rust-local-tts-dsh.md)固定行为与性能基线：音色、速率、音量、默认与缺失音色的矩阵在 PowerShell 与 Rust 两侧各核对一遍；朗读与枚举分开计时。
- [x] 完整正确性与生命周期验收见阶段 11：直连 helper 的 NUL、END 补造 started、GetEvents/等待失败出口、残留探测与句柄采样均已修复并复测；控制保持事件等待 + 50ms 上界，暂停回执实测 < 300ms。
- [x] 交付原始性能证据与回归结果：`tests/yu-v2/evidence/rust-speech-20261104.json`（旧口径，保留为历史），`scripts/benchmark-speech.mjs` 可复现。

**交付记录**：`yu-speech.exe` 每次请求启动、一次朗读结束即退出，开发路径 `native/bin/`、打包在 `resources/native/`，静态链接 CRT；`resources/speech.ps1` 只作基线保留、不再打包。原报告记录音色枚举 P50 1029→233ms、启动至 `started` P95 955→295ms、活动期私有提交71.4→10.7MB。2026-11-04复核发现 totalMs 额外计入200ms等待，CPU为采样时刻的累计快照；原表保留为历史，校准后的分位数与采纳结论由阶段11重测。

**未测项**：真实声卡听辨与响度、蓝牙/热插拔、远程桌面与锁屏、无音频输出设备时的失败表现、默认音频设备切换。云 TTS 与浏览器播放路径未改，测试结果与之前一致。

## 阶段 11：本地 TTS 正确性与验收证据校正（已完成）

基线 `c85e982`。Codex 已核对交付哈希、复跑49项语音回归，并复现活进程被残留检测漏报、退出后采样为空、helper 接受NUL后截断。生产文本清理已移除NUL并保留两侧，不能把直连接口问题写成正常业务已复现丢字。详细反例和本轮任务见[阶段11计划](plans/2026-11-04-rust-local-tts-correctness-dsh.md)。

- [x] 修复检测工具、采样时机与真实生产运行器覆盖，重新验证至少30次合成启停。
      残留探测改用 `process.kill(pid, 0)` 并区分存活/已退出/查询失败，附活进程与受控子进程的一正一反对照；句柄/线程快照改在暂停存活的 helper 上取，30 次真实合成对首/中/末三次断言字段有效且句柄增量 ≤ 8。
- [x] 修复直连文本边界、开始事件与SAPI错误出口，记录有界等待的实际实现。
      含 NUL 的请求改为单行 `ok:false` 非零退出；`started` 只认本次 stream 的 START，END 缺 START 报错不补造；`GetEvents`/`WaitForNotifyEvent` 的失败按阶段加 HRESULT 退出。控制仍走事件等待 + 50ms 上界，实测暂停回执 < 300ms，README 按有界等待描述。
- [x] 校正基准时间/CPU/样本口径并保留旧报告，DSH自行更新验证、完成状态和提交编号。
      基准改在 `close` 收尾（`totalMs` 无 200ms 人为延迟），CPU 明确为采样瞬间快照，报告区分轮次/请求数/有效样本/失败数，checks 失败时非零退出；新证据 `tests/yu-v2/evidence/rust-speech-correctness-20261104.json`，旧 `rust-speech-20261104.json` 保留为历史。

**阶段 11 结果**：R1–R6 全部处理（逐项文件、反例与测试入口见阶段 11 计划第 6 节）。校准后每侧 20 个有效样本（PS/Rust/Rust/PS 交错）：音色枚举 P50 846 → 25ms；启动至 `started` P50 990 → 301ms、P95 1491 → 396ms（−73.4%，−1095ms）；活动期私有内存 71.6 → 10.8MB（−85%）；工作集 −63.6%；`total` P50 5147 → 4218ms、P95 −23.7%。阶段 10 的采纳条件在新口径下仍成立（内存 −85% ≥ 30%，`started` P95 −73.4% 且 −1095ms）。修正后 helper `native/bin/yu-speech.exe` 336896 B，SHA-256 `2bafa91e2a2d54b01d9e043d15fce58f6656d2323cd75fc9e83f2f0ece2823d5`。实现提交 `cd4925c`，文档回写见同一阶段的文档提交。验证：`cargo fmt/clippy/test`（10 单测）通过，四个语音测试文件 64 用例通过，`pnpm typecheck`、`pnpm test:native`、`pnpm build` 通过；`pnpm test` 全量连续三次各有一个既有网络/时序用例在并行下超时（`search-pool.test.ts` 两次、`update-download.test.ts` 一次），两个文件单独复跑 12/12 与 5/5 通过，本阶段未改动它们，也未放宽断言。

**未测项（阶段 11 后）**：真实声卡听辨与响度、蓝牙/热插拔、远程桌面与锁屏、无音频输出设备时的失败表现、默认音频设备切换；事件读取/等待失败与缺失 START 的用例是替身模拟，未在真实故障设备上复现；CPU 与内存已按阶段 12 的生命周期口径实测（`tests/yu-v2/evidence/rust-speech-lifecycle-20261104.json`），不再是采样瞬间快照。云 TTS 与浏览器播放路径未改。

**阶段 12 结果**：A1–A3、B1–B2、C1–C3 全部落地（逐项见阶段 12 计划第 5 节）。`scripts/benchmark-speech.mjs` 的 CPU 由“存活瞬间快照”改为 job 记账的进程累计差分，窗口是 `stdin` 请求写入 → stdio `close`，与 `totalMs` 同区间；私有内存取 job 内核峰值、工作集取 100ms 采样的最大值；两侧共用同一段测量代码，`comparison` 每项带 `comparable`/`reason`，做不到同法就不出百分比。每侧 40 个有效样本（80/80 有效，12 项结构化 checks 全 PASS，退出码 0）：音色枚举 P50 852 → 26ms；启动至 `started` P50 891 → 291ms、P95 943 → 321ms（−66.0%，−622ms）；整次朗读 CPU P50 1703 → 125ms（−92.7%）；私有内存峰值 75.4 → 10.5MB（−86.0%）；工作集峰值 113.8 → 41.5MB（−63.5%）；`total` P50 5010 → 4209ms、P95 −15.6%。判据沿用阶段 10/11，`decision` 仍为 `memory`。连续三次实跑口径稳定（`started` 差 −66.8%～−67.3%、CPU −91.9%～−92.7%、私有内存 −86.0%～−86.1%），CPU 绝对值抖动较大，按百分比读。证据 `tests/yu-v2/evidence/rust-speech-lifecycle-20261104.json`（`generatedAt` 06:52:21，`binary.sha256` `e5664328…`），旧两份证据未动；helper 源码零改动，但 `pnpm test` 链内的 `build-native` 会重建二进制，最终 336896 B / `e5664328…`。实现提交 `9c07ce7`；验证一次连续执行全部退出码 0（`cargo fmt/clippy/test`、基准 20 轮、四个语音测试文件 64 用例、`pnpm typecheck`、`pnpm test:native` 39 项、`pnpm build`、`pnpm test` 237 文件 3535 用例全通过）。

## 阶段 13：浏览器地址读取

`get_current_page` 的 `browser-url` 原先每次启动 PowerShell 并加载 .NET UIA，本轮迁到现有一次性 `yu-windows.exe`（新增 `native/windows/src/address.rs`）。`current-content`、Office、Explorer、搜索与其余 Windows 操作未动，没有新增常驻进程、端口或可执行文件。详细规则、fixture 与交付要求见[阶段 13 计划](plans/2026-11-04-rust-browser-url-dsh.md)。

- [x] 保留冻结 HWND/PID/标题的读前读后校验、工具栏与 Document 候选规则、文件 URL 兼容和 TS 权限边界。
      目标校验只在 `address.rs` 内复用最小代码，`window-check` 的“最小化即报错”规则没有被带进 `browser-url`；地址候选、`metadataOnly` 跳过条件、唯一值覆盖与 `file://` 本地路径转换按 `resources/current-content.ps1:87-129` 逐条对照实现，取到结果后再校验一次（Finish-Content 语义）。
- [x] 真实受控 UIA 对照、取消/卡住 provider/父退出与至少 30 次启停通过。
      受控窗口是真实 Edge（隔离 `--user-data-dir` + `--inprivate`），80 次请求全部成功；父进程退出后 helper 3ms 内退出，stale 标题与失效句柄两侧同报 `Original window has changed or closed`，两侧输出字段与值逐字一致。
- [x] 同机交错每侧至少 20 个有效样本；行为一致且延迟或可比内存收益达到计划门槛，才切换生产路由。
      每侧 40 个有效样本（PS/Rust/Rust/PS 交错），8 项结构化 checks 全 PASS、退出码 0：整次请求 P50 1149 → 64ms、P95 1309 → 73ms（−94.4%，−1236ms）；CPU P50 1938 → 31ms（−98.4%）；私有内存 P50 76.7 → 2.5MB（−96.7%）。延迟与内存两项门槛都过，`decision = latency`，已把 `browser-url` 加入 `nativeActions`。
- [x] DSH 自行更新已实现项、实际验证、证据、未测项与提交编号，完成文档和代码收尾。

**阶段 13 结果**：实现新增 `native/windows/src/address.rs`（文档/编辑框候选、ControlView 父链 40 层、ValuePattern、唯一值规则、`file://` 本地路径），`operations.rs` 增加 `browser-url` 分支，`Cargo.toml` 只补 `Win32_UI_Accessibility`、`Win32_System_Ole` 两个 feature，未新增依赖。TypeScript 侧只把 `browser-url` 加进 `src/main/windows-native.ts` 的 `nativeActions`，15s 预算、`--parent-pid`、取消与输出上限沿用原运行器。证据 `tests/yu-v2/evidence/rust-browser-url-20261104.json`（`generatedAt` 2026-11-03T23:48:31Z，`binary.sha256` `52266cd4…`），最终 `native/bin/yu-windows.exe` 392704 B / `52266cd4d331919dc969004128550e7446ccc2eb08b343647270d18f139d9616`（`cargo fmt` 后重新构建并复跑，哈希取最后一次构建之后）。验证：`cargo fmt -- --check`、`cargo clippy --locked --offline --all-targets -- -D warnings`、`cargo test --locked --offline`（9 单测）全部通过；五个 TypeScript 文件 149 用例通过；`pnpm typecheck`、`pnpm test:native` 39 项、`pnpm build`、`pnpm test` 237 文件 3535 用例全通过。

**未测项（阶段 13 后）**：Chromium 网页正文的 UIA Document 元素在本机 Edge 上不出现（加 `--force-renderer-accessibility` 也不出现），因此“Document 唯一值覆盖地址栏”“网页内伪地址 Edit”“多 Document URL 歧义”三条只用逻辑单测覆盖，未在真实 provider 上复现；ComboBox 形式的地址栏、密码框与深度上界未在真实浏览器上构造。真实 Chrome/Firefox、UNC 网络路径、中文与空格路径的 `file://` 转换、UAC 提权窗口、锁屏与远程桌面均未测。fixture 依赖本机 Edge：普通 profile 窗口约 45 秒后会恢复用户会话并改写标题，故固定用 `--inprivate`，并在启动后按命令行校验窗口归属，失败即放弃而不操作其他窗口。

## 阶段 14：资源管理器文件夹读取

`read_current_content` 在资源管理器窗口上的 `explorer-folder` 原先每次启动 PowerShell 并加载 Shell COM，本轮迁到现有一次性 `yu-windows.exe`（新增 `native/windows/src/folder.rs`）。`current-content`、`recent-files`、应用枚举、激活与搜索未动，没有新增常驻进程、端口或可执行文件。详细规则、fixture 与交付要求见[阶段 14 计划](plans/2026-11-04-rust-explorer-folder-dsh.md)。

- [x] 保留冻结 HWND/PID/标题的读前读后校验与“唯一且存在”的目录规则，TS 权限边界不变。
      按 `resources/windows-tools.ps1:40-49` 逐条对照：Shell 窗口按 HWND 过滤后才取 `Document`，`Document.Folder`（扩展 Folder 对象）→ `Self` → `Path`，大小写不敏感去重，只有唯一且 `Directory::Exists` 才给值，否则 `null`；读前、读后各校验一次窗口。
- [x] 真实资源管理器对照、非资源管理器窗口、失效窗口与父退出通过。
      真实 `explorer.exe` 窗口（独立临时目录）两侧输出逐字一致；非 Shell 窗口两侧都返回 `{"folder":null}`；stale 标题与失效句柄两侧同报 `Original window has changed or closed`；父进程退出后 helper 3ms 内以 0 退出。
- [x] 同机交错每侧至少 20 个有效样本；行为一致且延迟或可比内存收益达到计划门槛，才切换生产路由。
      每侧 40 个有效样本（PS/Rust/Rust/PS 交错），9 项结构化 checks 全 PASS、退出码 0：整次请求 P50 985 → 39ms、P95 1015 → 44ms（−95.7%，−971ms）；CPU P50 1766 → 31ms（−98.2%）；私有内存 P50 67.6 → 1.7MB（−97.5%）。延迟与内存两项门槛都过，`decision = latency`，已把 `explorer-folder` 加入 `nativeActions`。
- [x] DSH 自行更新已实现项、实际验证、证据、未测项与提交编号，完成文档和代码收尾。

**阶段 14 结果**：实现新增 `native/windows/src/folder.rs`（Shell 窗口枚举、`IWebBrowser2` HWND 过滤、`Folder2.Self.Path`、去重与存在性判定，含 3 个单测）；`assert_original` 上移到 `operations.rs` 供 `address.rs` 与 `folder.rs` 共用，`window_check` 的“最小化即报错”规则未变；`Cargo.toml` 只补 `Win32_UI_Shell`，未新增依赖。TypeScript 侧只把 `explorer-folder` 加进 `src/main/windows-native.ts` 的 `nativeActions`，PowerShell 分支保留为基准对照与回滚参照。证据 `tests/yu-v2/evidence/rust-explorer-folder-20261104.json`（`generatedAt` 2026-11-04T00:04:26Z，`binary.sha256` `aa9232e5…`），最终 `native/bin/yu-windows.exe` 396800 B / `aa9232e554340e42d13e01f7e99e718f31415ec2a008e7222a2ce9c31f222010`。验证：`cargo fmt -- --check`、`cargo clippy --locked --offline --all-targets -- -D warnings`、`cargo test --locked --offline`（12 单测）、`node scripts/benchmark-explorer-folder.mjs --samples 20` 全部通过；五个 TypeScript 文件 149 用例通过；`pnpm typecheck`、`pnpm test:native`、`pnpm build`、`pnpm test` 237 文件 3535 用例全通过。阶段 13 的三处 P3（构建哈希因果、`address.rs` 行数、PS `browser-url` 分支保留说明）随本轮文档提交修正。

**未测项（阶段 14 后）**：同一 HWND 绑定多个 Shell 文件夹（资源管理器多标签切换后再冻结）未构造；“唯一值”歧义只由单测覆盖。网络共享（UNC）路径、超过 260 字符的长路径、符号链接与 OneDrive 占位目录未测。窗口在请求中途被关闭（而非标题变化）只由失效句柄用例近似覆盖；UAC 提权窗口、锁屏与远程桌面未测。fixture 依赖本机 `explorer.exe`：基准自行打开唯一临时目录窗口并在结束后关闭，不触碰操作者已开的资源管理器窗口，但需要可用桌面会话。

## 后续阶段的推进规则

1. 每次只推进一个可独立验收的阶段；性能分析阶段可以得出“保留现实现”的结论。
2. 后续迁移先盘点实际调用与频率，再迁移当前有收益的操作；系统接口、纯计算和模型分别核对边界，避免统一塞进一个大后端。
3. 不承诺整个应用的固定降幅；区分常驻包装层、Chromium、模型及网络等待。
4. 失败或未测项明确保留为待办，不把自动测试代替真实厂商应用、UAC、权限桌面或安装升级验收。

## 官方参考

- [UIA 线程模型](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)
- [UIA 控件类型标识](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-controltype-ids)
- [微软 Rust Windows 绑定](https://github.com/microsoft/windows-rs)
- [磁盘可用容量与配额](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getdiskfreespaceexw)
- [Core Audio 音量接口](https://learn.microsoft.com/en-us/windows/win32/api/endpointvolume/nn-endpointvolume-iaudioendpointvolume)
- [Windows 本地 OCR](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine)
- [Koffi 指针与缓冲区](https://koffi.dev/pointers)
- [Rust cdylib 链接](https://doc.rust-lang.org/reference/linkage.html)
- [Rust 切片的 FFI 安全边界](https://doc.rust-lang.org/std/slice/fn.from_raw_parts.html)
- [Node V8 CPU 采样接口](https://nodejs.org/api/inspector.html)
- [Sherpa 原生 API 与各语言绑定](https://k2-fsa.github.io/sherpa/intro.html)
- [Transformers.js ONNX 后端](https://huggingface.co/docs/transformers.js/en/api/backends/onnx)
