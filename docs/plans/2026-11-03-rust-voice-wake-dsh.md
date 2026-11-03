# 第八阶段：常驻语音唤醒宿主 Rust 评估与实施计划

> **执行者：DSH，继续现有 typeless 对话与工作区。** 直接按顺序评估、实现和验证，自行回写文档并提交。结束后停止，等待用户下一轮指令；Codex 不监听开发过程。

**状态：待实施。** 本文中的收益、方案与用例都是待验证要求，不是已经完成的结果。

**目标：** 降低常驻语音唤醒的宿主占用与启动延迟，并解决已经复现的语法竞争漏唤醒问题，保留 Electron、现有 SAPI 引擎和用户设置。

**架构：** 常驻监听及 waveIn 设备枚举优先评估独立 `yu-wake.exe`，使用继承的本地管道；TypeScript 继续管理状态、置信度、冷却、暂停与任务唤起。三次录音学习仍调用现有 `voice-wake.ps1`，不在本轮重写学习算法或改训练数据格式。系统语音引擎仍独立于 Electron，不引入新模型、云识别、监听端口或通用语音框架。

**工具链：** 当前 Rust MSVC、`windows = "=0.61.3"`、`serde_json = "=1.0.151"`、现有 Windows SAPI/语言包、Electron、Vitest。复用已安装依赖和 E 盘缓存；核对本地固定版本的接口与 feature，不照抄最新版绑定签名或为此升级依赖。

**基线：** `4bb22dc`。开始时读取 AGENTS.md、核对实际 HEAD 和 Git 状态，保留既有未提交内容；在当前分支实施，不 push、merge、rebase、reset 或复制整个工作区。

## 1. 评估结论与本轮范围

| 候选 | 现有事实 | 决定 |
| --- | --- | --- |
| 常驻语音唤醒 | `WakeWordHost.update` 启动 PowerShell，每次进程启动加载 System.Speech 并 Add-Type 编译约 500 行 C#；启用时持续运行 | 本轮首选，测量宿主和引擎各自成本后再决定迁移 |
| 输入设备枚举 | 同一脚本 `-ListDevices` 也会加载程序集、编译整个 C# 块，再调用 waveIn 枚举 | 可纳入同一小型 helper，保留现有 waveIn ID 语义 |
| 三次录音学习 | 低频，依赖 System.Speech 发音与训练结果，现有 TS 保存学习变体 | 保留原流程，不为统一语言扩大范围 |
| ASR/记忆/截图/前台窗口 | 前几轮已有优化；换语言不能消除原生推理或 OS 等待 | 本轮不继续迁移 |

以上是代码分析，不是常驻内存实测；不得预先宣称 Rust 能降低整应用多少内存或提高识别准确率。

## 2. 任务 A：校正上一阶段记录，固定失败基线

涉及 `docs/plans/2026-11-03-rust-memory-graph-dsh.md`、`docs/rust-refactor-plan.md`、阶段 7 的三个原始报告；只修正与证据不一致的表述，不重跑整个已完成阶段。

- [ ] 纠正“16 维未测 512 维”：当前图探针 `DIMENSION=512`，报告三场景均为 512；16 维来自差分测试中的一组数据，不能混用。报告实际 rows 为 21/81/200，区分场景名与真实节点数。
- [ ] 明确 A/B/C 图算法比较运行在 Electron 主进程，只有最终实现另测了 utility process 往返；父进程 `process.cpuUsage()` 不能代表 worker CPU，`coldMs` 实际覆盖首次 graph 请求，不含脚本中单独测量的启动/init。文档按真实范围写，不补造三方案 worker 对照。
- [ ] 将截图结论限定为“该探针释放引用、显式 GC 与空闲后可回收”；它尚不能证明所有生产场景均无泄漏。保留阶段 6/7 原始异常报告和未测项，不能用修改旧数据来修正文档。
- [ ] 读取 `tests/yu-v2/evidence/wake-word-environment-20261103.json` 并复现现有两项真实唤醒失败。旧版本也失败只能证明不是阶段 6/7 引入，不能排除产品对语法竞争处理有问题。本轮将其作为明确缺陷进行最小修复和迁移对照。

## 3. 任务 B：先测现实现与确定正确行为

阅读 `src/main/wake-word.ts`、`resources/voice-wake.ps1`、`src/shared/wake-word.ts`、`src/main/wake-word{,-native}.test.ts`，以及 `src/main/index.ts` 中 WakeWordHost 的暂停、学习、游戏模式和退出调用点。

- [ ] 保存原始 PowerShell 的设备枚举、首次 `ready`、稳定待命私有提交/驻留内存、进程树启动 CPU、稳定待命 CPU、合成语音从音频结束到 wake 的延迟。明确采样 PID、单位、引擎/识别器 token、语言包、版本和音频哈希；不能用父进程 CPU 或 heap 代替 helper 总成本。
- [ ] 只用 SAPI 合成的中文/英文 WAV、合成静音和隔离配置；用受控节奏输入测待命成本时说明它与真实麦克风的差别。不要录制用户讲话、改系统默认设备或开启用户现有唤醒设置；真实麦克风与热插拔未实际测试就明确保留未测。
- [ ] 建立正负语料：完整自定义词、名字/同音、已学习发音、唤醒词接指令、自然短暂停顿、词不完整、词嵌在无关长句中、无关中文/英文、静音与噪声。先保存原版结果，再最小修复语法竞争，形成正确性控制版本。
- [ ] 两项既有真实测试须实际验证修复效果；不得 skip、修改为“没有 wake 才正确”、降低断言/置信度或用硬编码名字/别名制造成功。不能仅删除背景听写语法让任意声音都被强制识别成唤醒词；如改变 grammar 配置，须用相同负语料证明没有引入误唤醒。
- [ ] 修复后的 PowerShell 是 Rust 功能与性能的控制方案；原始失败结果仍保留。不用坏掉的旧版“无事件”当作延迟或准确率对照。

## 4. 必须保持的行为

- [ ] `enabled=false`、暂停、游戏模式、锁屏/挂起、正在录音或处理、截图等现有暂停来源不启动监听；暂停/关闭/退出及时释放识别器和输入设备，旧进程的迟到事件不得唤起任务。
- [ ] 保留短词更严格的旧配置默认值、用户显式 0.1–0.99 阈值、匹配分数提示、300–9000ms 时长门槛、5 秒冷却及 `resetCooldown` 行为。可见置信度门槛继续归 TS 所有，不加隐藏单词分数门槛或把候选强制设为 1。
- [ ] 保留 NFKC/中英文匹配、完整词边界、最多 3 秒的跨段完整前缀拼接、完整词后紧跟指令、已学习 text/phones 变体。SAPI phoneme ID 必须转成与 System.Speech 现有训练记录兼容的表示，不能直接比较不同编码或丢弃训练字段。
- [ ] 设备 ID 仍是 waveIn 枚举索引字符串；空字符串/负值的系统默认语义、缺失/打开失败/流失败的可见回落提示和实际设备名保持。不要擅自改为另一套 endpoint ID、重写用户设置或静默监听不同设备。
- [ ] `ready` 只表示真实完成输入/语法/事件配置，错误沿用 language/microphone/unavailable；音量 0–100 与现有节流保持。进程 stdout 只有 UTF-8 NDJSON，stderr 不保留音频、识别正文或设备详情；唤醒事件只返回配置 phrase，不转发后续指令正文。
- [ ] 学习函数仍调用原 PowerShell，以三段已有录音完成并返回原结构，由 TS 的 `learnWakeTraining` 保存；取消、超时、旧配置失效、清除与不保存原始录音行为保持。

## 5. 任务 C：Rust 候选实现

新建 `native/wake/{Cargo.toml,Cargo.lock,.cargo/config.toml,src/main.rs}`，优先沿用现有原生 helper 的构建、静态 CRT、错误处理和测试风格。不要为一个操作增加共享 RPC 框架。

- [ ] 用同一安装的 SAPI 识别器与语言 token，在明确的 COM apartment 内创建/使用/释放对象；通过 SAPI 事件等待，避免忙轮询和跨线程裸 COM 指针。释放事件携带的 COM/CoTaskMem 数据，错误路径同样释放。
- [ ] 先验证 SAPI `SpMMAudioIn` / `ISpMMSysAudio::SetDeviceId` 能否直接选择既有 waveIn 索引，复用系统音频对象，避免无必要地重写整套 C# waveIn 缓冲区。默认设备语义和回落也须验证；若确需自有流，缓冲区有界、回调期间不释放，停止/归还/解除准备后再释放音频块。
- [ ] 保留 SAPI grammar、拒绝候选处理、词级/片段 confidence、phoneme、时长与完整前缀规则；逐项对照控制方案。不要下载 ASR 模型或换 Vosk/Whisper/云接口，也不把唤醒识别搬回 Electron。
- [ ] 设备枚举使用 `yu-wake.exe --list-devices`，输出与现有 `parseDeviceList` 兼容的单个 devices 事件后退出；仅枚举不打开麦克风。
- [ ] 监听首次从 stdin 接收 `{phrase,language,device,variants?}` 一行 JSON，事件沿用 ready/device/level/wake/log/error 字段；合成 WAV 的测试入口必须在测试模式显式选择，不能默认打开真实输入。
- [ ] 明确父进程退出协议：**当前 PS 宿主写完配置就 `stdin.end()`，不能照抄后又让 Rust 在该 EOF 上立即退出。** Rust 监听路径由 TS 写配置后保持 stdin 打开，关闭管道时退出；学习脚本仍按原方式 end。停止时保持有界回收与最终 kill，PID 晚出现也不能遗留进程；不要跨进程保存音频。
- [ ] 验证 EOF、父进程退出、初始化中取消、SAPI 失败、设备失败和反复启停均无残留 helper/COM/句柄；学习和设备枚举进程同样不能超时后孤立运行。不加无界重试、静默 PowerShell 回退或双监听。

## 6. 任务 D：采纳门槛与生产接入

候选测量与实现可独立完成，未过门槛不接生产。新脚本建议 `scripts/benchmark-wake.mjs`，隔离测试入口放 `tests/yu-v2/fixtures/wake-native.cjs`，原始报告放 `tests/yu-v2/evidence/rust-wake-20261103.json`；新增脚本与计划按 `.gitignore` allowlist 管理。

- [ ] 至少三轮交错测原版、修复后的 PS 控制、Rust；同一组合成语料/识别器/节奏，冷启动与设备枚举各不少于 20 个有效样本，待命按多批累计 CPU 测量，报告 P50/P95、原始样本、内存峰值/稳定值及上下文。不强制 GC 偏袒单一实现，不把 ASR 原生引擎占用说成换语言能消除。
- [ ] Rust 采纳先满足正负语料与既有设置行为，再满足以下一项净收益：稳定私有提交内存相对修复后的 PS 同时下降至少 25% 和 20MiB；或首次 ready P95 同时改善至少 30% 和 100ms。冷启动/识别 P95 不出现超过 `max(100ms,10%)` 的稳定退化，待命 CPU 不明显增加；结果未达门槛则保留修复后的 PS，说明原因。
- [ ] 只在采纳后将 `native/wake` 加入 `scripts/build-native.mjs` 与 `electron-builder.yml` 的 `resources/native/yu-wake.exe`；修改 `WakeWordHost` 的监听/枚举调用。保持学习路径与 `voice-wake.ps1` 资源，按实际职责命名，不删除仍在使用的脚本。
- [ ] 开发路径用 `native/bin/yu-wake.exe`，打包路径用 `resources/native/yu-wake.exe`，固定参数并用 stdin JSON 传用户输入，`windowsHide: true`；不拼接命令，不触发执行策略窗口或要求用户安装 Rust/VC++。
- [ ] 使用隔离 Electron 验证实际启动、事件解析、暂停/恢复、取消与资源路径；不用 mock 证明真实 SAPI/设备功能。未采用时记录“不适用”，不改安装资源并声称已迁移。

## 7. 针对性验证与交付

- [ ] 保留并运行 `pnpm exec vitest run src/main/wake-word.test.ts src/main/wake-word-native.test.ts`，补充新进程路径、保持 stdin、EOF 回收、迟到 spawn/事件、学习仍走 PS、坏 JSON/上限/超时和纯设备枚举回归。共享唤醒训练/配置/暂停调用点有变化时运行对应现有测试，不改无关模块。
- [ ] Rust 单测覆盖归一化/完整前缀/分段/phoneme 与事件组装，真实 SAPI 合成文件测试覆盖语法竞争修复及正负语料；时间/置信度和旧训练兼容须按实测解释差异，不只对照 mocked wake JSON。
- [ ] 在 crate 运行 `cargo fmt -- --check`、`cargo test --locked --offline`、`cargo clippy --locked --offline --all-targets -- -D warnings`；产品采用后运行 `pnpm test:native`、`pnpm typecheck`、`pnpm test`、`pnpm build`。记录命令/退出码和通过、失败、跳过数量；本轮涉及的两项唤醒失败不能再次机械列为“既有问题”就结案。
- [ ] 若本机确实无法完成关键语音功能，保留明确失败和阻塞项，交付可用的最小修复/评估，不上线不完整 helper。不得通过测试音频替换、降低负样本要求或固定名字来换通过。
- [ ] 若采用，核对 x64、静态 CRT、依赖和产物 SHA-256；测量启动/停止循环的线程/句柄和内存，区分无硬件合成输入与真实设备验收。真实讲话、热插拔、隐私权限拒绝、RDP/锁屏等未测项保留，不冒充硬件已通过。
- [ ] 自行将本文改为实际状态并追加“实际实现与验收结果”：采用方案、实际协议与文件、语法问题根因、验证、原始证据、收益范围、限制、清理量与提交。总计划同步阶段 7 校正和阶段 8 结果，中英文 README 仅同步现行架构/命令，不复制冗余总结。
- [ ] 只清理本轮且确认进程退出的隔离 WAV/profile/编译暂存，保留正式产物和必要证据；不删历史目录、依赖、用户数据或模型，不复制 node_modules。报告主要新增与回收占用。
- [ ] 必要验证后检查 Diff，仅暂存本轮文件，按实际变更自动 Conventional Commit，可将独立语法修复与宿主迁移分为完整的两个提交；不 push、不打安装器、不发布、不重启用户开发版。最后在当前 DSH 对话回复结果、文档路径和 commit hash，**然后停止，等待用户下一轮指令。**

## 官方参考

- [SAPI grammar 与输入激活](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ms718917(v=vs.85))：设置输入后激活规则，输入打开失败必须可见。
- [SAPI MMSysAudio 默认设备与设备 ID](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ms717928(v=vs.85))：区分 WAVE_MAPPER 与具体设备，不能假设每种来源的默认 ID 相同。
- [微软 Rust ISpMMSysAudio 绑定](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/Media/Speech/struct.ISpMMSysAudio.html)：可用 SetDeviceId；实现前复核本项目固定 0.61.3 的签名。
- [WAVEHDR 生命周期](https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/mmeapi/ns-mmeapi-wavehdr.md)：自有采集流才需要处理缓冲块准备、队列和归还，不能在驱动仍持有时释放。
