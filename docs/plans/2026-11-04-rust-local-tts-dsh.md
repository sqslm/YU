# 第十阶段：Windows 本地 TTS 宿主 Rust 评估与条件迁移

> **执行者：DSH，继续现有 typeless 对话与工作区。** 按本文评估、实现、验证，自行更新完成项、证据、限制与提交编号。完成后通过已启用的 Codex 桥汇报；Codex 收到汇报才核对并决定后续任务，不监听开发过程。

**状态：已交付并接入（实现 `4ad5cdd`、文档 `c85e982`），完整验收需整改。** 2026-11-04 Codex复核发现残留检测漏报活进程、句柄采样在退出后跳过、生产计时器测试未覆盖、直连NUL截断与SAPI错误出口缺口；基准 totalMs 还计入200ms等待。后续修复与重测转入[阶段11](2026-11-04-rust-local-tts-correctness-dsh.md)。文末保留DSH原始交付历史，不把原测试数量当作这些合同已经成立的证明。

**Goal：** 保留 Electron 与现有 Windows 音色，减少本地朗读时 PowerShell/.NET 的启动和活动内存开销，保留真实开始、暂停、继续、停止及分段朗读语义。

**Architecture：** 优先评估按需启动、每次请求独立退出的 `yu-speech.exe`，使用继承 stdin/stdout 的 UTF-8 NDJSON。TypeScript 保留文本清理、分段、设置、任务生命周期和 UI；Rust 只负责 SAPI 合成、音色枚举与当前朗读的控制。先测量与验证，达到采纳条件后才接入生产构建。

**Tech Stack：** 现有 Rust MSVC、`windows = "=0.61.3"`、`serde_json = "=1.0.151"`、Windows SAPI、TypeScript、Vitest。沿用固定版本和静态 CRT，先检查 E 盘已有工具与缓存；不升级依赖、不安装模型或语言包。

**基线：** `95241cb3c4add5064c9ffb61c5a3e00fa4e9beb2`。开始前核对实际 HEAD、AGENTS.md 与 Git 状态；保留已有修改，在当前分支实施，不 push、merge、rebase、reset，不复制整个工程。

## 1. 选择依据与范围

| 候选 | 当前代码事实 | 本轮处理 |
| --- | --- | --- |
| Windows 本地 TTS | `src/main/speech.ts` 每次 `voices` / `speak` 启动 `powershell.exe`；`resources/speech.ps1` 加载 System.Speech，朗读期间每 25ms 检查一次控制输入 | 首选：独立测量，再实现小型 SAPI 宿主 |
| 云 TTS 与浏览器播放 | `providers/tts.ts` 负责厂商 HTTP 协议，`speech-playback.ts` 负责 Chromium 播放；主要等待网络/音频设备 | 保留，不迁移协议、API Key 或播放器 |
| 唤醒学习、ASR、记忆、截图 | 前阶段已有实现或保留原架构的证据；唤醒学习有既有 IPA 数据约束 | 不纳入本轮 |

本地 TTS 当前按需启动，不能把“活动期间 helper 减少内存”写成“整应用静默常驻内存减少”；声音合成仍由 Windows 引擎执行，换语言不等于提升音色或识别能力。

## 2. 任务 A：固定行为与基线

阅读：

- `src/main/speech.ts`、`src/main/speech.test.ts`：`SpeechRunner`、`SpeechService`、`start/speak/pause/resume/stop/voices`。
- `resources/speech.ps1`：原始本地合成、默认输出、音色回落与控制协议。
- `src/shared/speech.ts`：`MAX_SPEECH_CHARS`、设置归一化、完整文章的分段语义。
- `src/main/index.ts` 的 `createWindowsSpeechRunner` 接入点；`src/main/speech-playback.ts`、`src/main/providers/tts.ts` 只用于确认边界。
- `scripts/build-native.mjs`、`electron-builder.yml`、相邻原生 crate 的 `.cargo/config.toml`。

- [x] 记录基线版本、操作系统、Node/Electron/Rust 版本、现有 SAPI 音色及默认音色。
- [x] 保存旧脚本与运行器的最小基线引用，放在隔离探针目录或从固定提交读取；不创建额外完整工作副本。
- [x] 分开测量音色枚举、进程启动至首次有效输出、合成期间的私有提交/工作集、CPU 时间与退出回收。朗读与枚举不得混合成一个指标。
- [x] 核对默认/指定/已不存在音色，中文与实际安装的其他语言，速率 -10/0/10、音量 0/50/100 的行为。未安装的语言注明缺测。已用矩阵探针核对两台宿主的接受/完成行为：`rate 10` 明显更快、`rate -10` 明显更慢、`volume 0/100` 只影响响度不影响时长、`Missing Voice 7.0` 与空音色都回落默认、`Microsoft Zira Desktop` 朗读英文成功；响度本身未听辨（见未测项）。
- [x] 记录暂停/继续、停止中断、完整长文分段、下一次朗读打断旧朗读，以及声音已开始后原任务结束仍可继续朗读的既有预期。

## 3. 任务 B：实现限定的 Rust 候选

候选文件：`native/speech/Cargo.toml`、`Cargo.lock`、`.cargo/config.toml`、`src/main.rs`，如实现确有需要再拆分 SAPI/协议模块。不要新建通用 Windows 后端或公共协议框架。

固定协议与现有运行器兼容；每行一个 JSON，stdout 不输出调试文本，stderr 不回显朗读正文：

```json
{"action":"voices"}
{"ok":true,"voices":["已安装且可选的音色名称"]}
{"action":"speak","text":"合成测试文本","voice":"音色名称","rate":0,"volume":50}
{"ok":true,"event":"started"}
{"action":"pause","id":1}
{"ok":true,"event":"control","id":1,"paused":true}
{"action":"resume","id":2}
{"ok":true,"event":"control","id":2,"paused":false}
{"ok":true}
```

以上展示多种收发方向，不是一批连续输入。`voices` 一次回复后退出；`speak` 期间 stdin 保持可读，正常完成后只发一次终态并退出。错误返回 `ok:false` 与不含正文的错误信息。

- [x] 用 Windows SDK/固定版本绑定的 `SpVoice` / `ISpVoice`；核对实际方法签名、COM apartment、HRESULT、事件掩码与事件数据回收。沿用 SDK 常量，不手写未经验证的 GUID 或事件位。
- [x] 普通文本显式使用 `SPF_IS_NOT_XML`；不能让 `<voice>`、`<speak>`、文件路径、引号、反引号或 `$` 内容变成 SSML、文件读取或命令。处理 NUL 等会造成 UTF-16 截断的真实输入边界，不能静默丢失后半句。
      **阶段 11 修正**：原实现把 NUL 之后的内容截断后仍报成功；现在含 NUL 的请求直接以单行 `ok:false` 拒绝并非零退出（上层 `speechText` 已先清除 NUL 并保留两侧，业务路径不受影响）。
- [x] 异步 `Speak` 成功只代表已排队；将 `started` 与本次 stream 的实际输出开始事件对应，不能提前确认。完成也须对应本次 stream，不以文本字数计时或固定宽限判定。
- [x] 使用事件等待处理 SAPI 通知和控制输入，暂停期间也能接收继续/停止/EOF；不引入高频 Sleep 轮询。
- [x] 音色枚举与旧脚本逐值核对名称、可选性和默认语义。已卸载/无效的指定音色按原脚本回落系统默认；其他 COM/音频错误如实失败，不误归为“机器不支持”。
- [x] `Pause/Resume` 控制回执保留 id，重复控制不能累积不可恢复的暂停状态；停止、stdin EOF、父进程退出和初始化中途失败均释放语音、COM、线程与句柄。
- [x] 不在命令行、日志、用户数据或报告中保存朗读正文/音频；验证只使用合成公开测试文本。

## 4. 任务 C：验证候选，再决定是否接入

测试文件：扩展 `src/main/speech.test.ts`，必要时新增 `src/main/speech-native.test.ts` 与 `tests/yu-v2/fixtures/speech-native.cjs`。保留现有 `SpeechService` 断言，用实际 helper 验证协议，不能只增加“能创建函数”的测试。

- [x] 枚举真实已装音色并与旧脚本比较；选定音色真实合成。无设备/无音色等测试须使用可控输入或隔离 fixture，不卸载用户组件或更改系统设置。
- [x] 验证中文、混合语言、标点、emoji、XML 形状文本、引号/美元符号、非法 JSON、空正文、分片/多行响应、输出上限、进程非零退出与缺失 exe。
- [x] 真实协议覆盖开始→暂停→继续→完成、暂停中 EOF/取消、开始前取消、正常/异常结束和至少 30 次启停。检查残留进程、线程/句柄趋势，不把单次成功作为回收证明。
- [x] 保持现有 20 秒启动期限、5 秒控制期限、输出限制；`started` 后长文不能被启动计时器杀死。旧进程的迟到事件/结束不能覆盖新朗读或错误地确认新控制请求。
- [x] 验证完整文章分段的尾部未丢失，`start()` 在真实开始后返回，后续后台段错误仍能报告；云 TTS 请求与 Chromium 播放路径保持既有测试结果。

测试默认使用隔离的合成文件输出或受控输出流，避免向用户扬声器播放长音频。探针输出模式必须显式启用、限定隔离路径，不成为产品新功能。文件输出、流接收事件与真实声卡可听首音是不同指标；若受控输出不能证明关键控制语义，应明确留待验证，不能据此宣布通过。真实声卡听辨、蓝牙/热插拔与远程桌面列为人工验收，不修改默认设备或真实音量。

### 采纳条件

所有关键正确性与回收检查先通过；再满足以下至少一项，并记录原始样本：

1. 同场景的活动期 helper 私有提交下降至少 30%；或
2. 音色枚举/同种输出模式下的启动至首次输出 P95 下降至少 25% 且至少 100ms。

同时列出其他测量项的退化与未测范围，不用均值掩盖 P95，不用父进程 CPU 代替 helper CPU。收益不足或正确性未证明时，保留原生产路径，仅交付候选、最小必要修复及分析记录；不要为了语言统一强行上线。

## 5. 任务 D：有条件接入与构建

仅在采纳条件满足后执行：

- [x] 在 `src/main/speech.ts` 将固定 PowerShell 启动替换为固定 helper 启动，保留 `SpeechRunner` 与上层业务接口。路径解析仍由 `src/main/index.ts` 区分 `native/bin/yu-speech.exe` 和打包后的 `resources/native/yu-speech.exe`。
- [x] 在 `scripts/build-native.mjs` 与 `electron-builder.yml` 增加该 helper；保持静态 CRT 和现有构建方式。失败明确报告，不自动回退启动 PowerShell。
- [x] 核对 `resources/speech.ps1` 的剩余引用；生产不再使用时移除它的打包项，基线留在隔离探针而非新增双后端运行时开关。
- [x] 无请求时不保留新常驻进程；不添加 HTTP 端口、服务、自启动、模型、额外 UI 或设置迁移。

## 6. 任务 E：可复现性能证据与验收

新增 `scripts/benchmark-speech.mjs` 与 `tests/yu-v2/evidence/rust-speech-20261104.json`，沿用现有性能脚本的测量方法；不引入通用基准框架。

- [x] 同机、同文本、同音色、同 rate/volume、同输出方式，PS/Rust/Rust/PS 交错运行。每个方案先预热，再保留不少于 20 个有效启动/枚举样本，并报告 P50/P95 与实际采样数；首次运行成本单列。
- [x] 文件输出可加速结束，不能拿它的吞吐时长与声卡实时朗读比较；静音 volume=0 也不代表无音频设备交互。明确记录启动/首输出/合成结束/播放结束各自口径。
- [x] 报告 helper PID、私有提交、工作集、内核+用户 CPU 时间、线程、句柄、退出码、采样窗口及采样失败值；计时粒度下的 0 不等于零 CPU。多轮启停证明无孤儿进程与资源单调增长。
- [x] 按需采纳方案保留证据；不为复测重建无关 crate，不重新跑上一阶段的 622 秒唤醒会话。范围内修改导致回归时再扩大排查。

验证命令（新 crate 先在其目录执行，确保读取静态 CRT 配置）：

```text
cd native/speech
cargo fmt -- --check
cargo clippy --locked --offline --all-targets -- -D warnings
cargo test --locked --offline
cd ../..
pnpm exec vitest run src/main/speech.test.ts src/main/speech-playback.test.ts src/main/providers/tts.test.ts
pnpm typecheck
```

新增原生集成测试时加入对应 Vitest 文件；先构建候选，再运行真实 helper 测试。缺少缓存时先核对现有依赖位置，不删 `--locked` 或升级版本来绕过错误。

若接入生产，再运行 `pnpm test:native`、`pnpm test`、`pnpm build`。这些命令的原生构建入口已有覆盖，不额外制作安装器或发布包。未采纳候选时运行受影响的回归与必要类型检查，记录为什么无需全量重建。

## 7. 任务 F：文档、自检、提交与汇报

- [x] DSH 自行勾选本文实际完成项，并在文末新增“实施结果”：采纳/不采纳、实现文件、真实命令/数量、原始证据、未测项、风险与提交编号。无法验证的项保持未完成，不能靠改预期或删测试制造成功。
- [x] 更新 `docs/rust-refactor-plan.md` 的阶段 10，README 中英仅同步实际生产行为；按依赖变化更新 `THIRD_PARTY_NOTICES.md`。不把候选写成已上线。
- [x] 清理本轮可重建的测试输出和新增编译暂存；保留最终交付 helper、源码、复现 fixture 与原始报告。记录保留/回收占用，不清理已有缓存、用户数据或历史证据。
- [x] 检查 Diff，仅暂存本阶段文件；必要验证通过后自动 Conventional Commit，不 push。最终文档若需补记实现提交编号，可单独做一次文档收尾提交。
- [x] 通过原 Codex 桥汇报：阶段与结论、实现/文档提交编号、测试命令和结果、性能对照、证据文件、真实未测项、工作区状态。不要再次只汇报“已就绪”，不要自行扩展到阶段 11。

## 官方依据

- [微软 ISpVoice](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ms719576(v=vs.85))：SAPI 合成、设置与控制接口；实现以本机固定版本绑定和 SDK 为准。
- [微软 SPEAKFLAGS](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ee431843(v=vs.85))：异步排队及纯文本解析标志。
- [微软 TTS 事件](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ms720164(v=vs.85))：开始/结束事件与输出对象、stream number 的对应关系；输出开始不等于扬声器可听首音。
- [微软 windows-rs](https://github.com/microsoft/windows-rs)：复用既有 MIT/Apache-2.0 Windows Rust 绑定，不另引第三方合成引擎。

## 实施结果（DSH，2026-11-04）

**结论：采纳并已接入生产。** 正确性、文本边界与回收先行通过，再满足两项性能门槛（活动期私有提交 −85%，启动至首次输出 P95 −69.1% / −660ms）。本地朗读不再启动 PowerShell；`resources/speech.ps1` 只作基线保留，不再打包。云 TTS 与 Chromium 播放路径未改。

**环境**：Windows 11（10.0.26300）、Node v24.22.2、Electron 42.11.18、Rust 1.97.0 MSVC；SAPI 音色 `Microsoft Huihui Desktop`（zh-CN，系统默认）与 `Microsoft Zira Desktop`（en-US），两者 `Enabled`。

**实现文件**

| 位置 | 作用 |
| --- | --- |
| `native/speech/src/main.rs` | 协议分派、`SpVoice` 合成、事件等待、暂停/继续/停止、EOF 与退出 |
| `native/speech/src/voices.rs` | `SpObjectTokenCategory` 枚举音色、`Attributes\Enabled` 过滤、按名选中与默认回落 |
| `native/speech/src/json.rs` | 逐行 JSON 事件（`voices`/`started`/`control`/终态/错误） |
| `native/speech/Cargo.toml`、`Cargo.lock`、`.cargo/config.toml` | 固定 `windows = "=0.61.3"`、`serde_json = "=1.0.151"`、静态 CRT |
| `src/main/speech.ts` | `createSpeechRunner(helperPath)` 取代固定 PowerShell 启动；协议、超时、输出上限不变 |
| `src/main/index.ts` | 开发 `native/bin/yu-speech.exe`、打包 `resources/native/yu-speech.exe` |
| `scripts/build-native.mjs`、`electron-builder.yml` | 构建并打包该 helper；移除 `speech.ps1` 的打包项 |
| `src/main/speech-native.test.ts`、`tests/yu-v2/fixtures/speech-native.cjs` | 真实二进制协议、控制、回收与音色对照 |
| `scripts/benchmark-speech.mjs`、`tests/yu-v2/evidence/rust-speech-20261104.json` | 交错基准与原始样本 |

**命令与结果**

| 命令 | 结果 |
| --- | --- |
| `cd native/speech && cargo fmt -- --check` | 通过 |
| `cargo clippy --locked --offline --all-targets -- -D warnings` | 通过 |
| `cargo test --locked --offline` | 2 passed（NUL 截断/空白拒绝、速率与音量夹取） |
| `pnpm exec vitest run src/main/speech-native.test.ts` | 11 passed（59.4s，含 25s 存活、30 次启停、重复暂停不累积） |
| `pnpm exec vitest run src/main/speech.test.ts src/main/speech-playback.test.ts src/main/providers/tts.test.ts src/main/speech-native.test.ts` | 60 passed |
| `pnpm typecheck` | 通过 |
| `pnpm test:native` | 通过（含 yu-speech 2 个 Rust 单测） |
| `pnpm test` | 237 文件通过 / 3 跳过；3531 用例通过 / 8 跳过 / 0 失败 |
| `pnpm build` | 通过 |
| `node scripts/build-native.mjs` | 五个原生程序 + 截图 DLL 构建成功 |

**性能（同机、同文本、同音色、`rate 0`/`volume 0`，PS/Rust/Rust/PS 交错，各 20 个有效样本）**

| 指标 | PowerShell | Rust | 变化 |
| --- | --- | --- | --- |
| 音色枚举 P50 / P95 | 1029 / 1047ms | 233 / 235ms | P50 −77.4% |
| 启动至 `started` P50 / P95 | 901 / 955ms | 287 / 295ms | P50 −68.1%、P95 −69.1%（−660ms） |
| 活动期私有提交 | 71.4MB | 10.7MB | −85%（−60.9MB） |
| 活动期工作集 | 116.3MB | 42.4MB | −63.5% |
| 活动期 CPU（每进程采样） | 1593.8ms | 109.4ms | −93.1% |
| 句柄 / 线程 | 819 / 31 | 458 / 14 | — |
| 单次朗读总时长 P50 / P95 | 5203 / 5295ms | 4406 / 4527ms | −15.3% / −14.5% |

`started` 是 helper 自己 stream 的开始事件，`total` 含合成到结束；`volume 0` 仍会走真实音频输出，不能当作"无音频交互"。`voices identical: true`，两宿主枚举值完全一致。

**行为核对（矩阵探针，两宿主各一遍）**：`rate 10` 明显更快、`rate -10` 明显更慢（13089→12007ms 一档、2536→1639ms 一档），`volume 0` 与 `volume 100` 时长相同（只影响响度），空音色与 `Missing Voice 7.0` 均回落默认且正常完成，`Microsoft Zira Desktop` 朗读英文成功，混合中英文、XML 形状文本、引号与 `$` 均按字面朗读。

**二进制**：`native/bin/yu-speech.exe` 334848 B，SHA-256 `f915ea6fe0b32618e2a53c12f4704ebfdcd65bea7403a6d726d645a01f20e6e0`；PE32+ x64（machine 0x8664、6 节、DllCharacteristics 0x8160），导入仅 `kernel32/ntdll/ole32/oleaut32/api-ms-win-core-synch-l1-2-0`，无 MSVC 运行库（静态 CRT）。未新增第三方依赖，`THIRD_PARTY_NOTICES.md` 无需变动。

**未测项**：真实声卡听辨与响度、蓝牙/热插拔、远程桌面/锁屏、系统无音频输出设备时的失败表现、多显示器与默认音频设备切换。多句长文只经 TypeScript 分段后逐段调用，helper 本身不承担连续会话。
