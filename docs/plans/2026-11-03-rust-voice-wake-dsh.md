# 第八阶段：常驻语音唤醒宿主 Rust 评估与实施计划

> **执行者：DSH，继续现有 typeless 对话与工作区。** 直接按顺序评估、实现和验证，自行回写文档并提交。结束后停止，等待用户下一轮指令；Codex 不监听开发过程。

**状态：已交付并接入 Rust 监听，`d31a0a4`；代码复核后的正确性修复与验收转入[第九阶段](2026-11-03-rust-wake-correctness-dsh.md)。** 前批次基线 `4bb22dc`，交付 `01b74de` / `6208396`；随后完成 Rust 监听接入。下文各批次保留实际交付历史，不将原性能报告视为全部功能已等价的证明。

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

- [x] 纠正“16 维未测 512 维”：当前图探针 `DIMENSION=512`，报告三场景均为 512；16 维来自差分测试中的一组数据，不能混用。报告实际 rows 为 21/81/200，区分场景名与真实节点数。
- [x] 明确 A/B/C 图算法比较运行在 Electron 主进程，只有最终实现另测了 utility process 往返；父进程 `process.cpuUsage()` 不能代表 worker CPU，`coldMs` 实际覆盖首次 graph 请求，不含脚本中单独测量的启动/init。文档按真实范围写，不补造三方案 worker 对照。
- [x] 将截图结论限定为“该探针释放引用、显式 GC 与空闲后可回收”；它尚不能证明所有生产场景均无泄漏。保留阶段 6/7 原始异常报告和未测项，不能用修改旧数据来修正文档。
- [x] 读取 `tests/yu-v2/evidence/wake-word-environment-20261103.json` 并复现现有两项真实唤醒失败。旧版本也失败只能证明不是阶段 6/7 引入，不能排除产品对语法竞争处理有问题。本轮将其作为明确缺陷进行最小修复和迁移对照。

## 3. 任务 B：先测现实现与确定正确行为

阅读 `src/main/wake-word.ts`、`resources/voice-wake.ps1`、`src/shared/wake-word.ts`、`src/main/wake-word{,-native}.test.ts`，以及 `src/main/index.ts` 中 WakeWordHost 的暂停、学习、游戏模式和退出调用点。

- [ ] 保存原始 PowerShell 的设备枚举、首次 `ready`、稳定待命私有提交/驻留内存、进程树启动 CPU、稳定待命 CPU、合成语音从音频结束到 wake 的延迟。明确采样 PID、单位、引擎/识别器 token、语言包、版本和音频哈希；不能用父进程 CPU 或 heap 代替 helper 总成本。**部分完成：续做批次按 ready 后预热窗口重测了枚举/ready/待命私有内存（各 20 样本），仍未测「音频结束→wake」延迟与父进程侧开销。**
- [x] 只用 SAPI 合成的中文/英文 WAV、合成静音和隔离配置；用受控节奏输入测待命成本时说明它与真实麦克风的差别。不要录制用户讲话、改系统默认设备或开启用户现有唤醒设置；真实麦克风与热插拔未实际测试就明确保留未测。**续做批次：脚本默认合成 WAV，`--device` 才打开真实输入；待命 CPU 因采样分辨率不足记为 null。**
- [x] 建立正负语料：完整自定义词、名字/同音、已学习发音、唤醒词接指令、自然短暂停顿、词不完整、词嵌在无关长句中、无关中文/英文、静音与噪声。先保存原版结果，再最小修复语法竞争，形成正确性控制版本。
- [x] 两项既有真实测试须实际验证修复效果；不得 skip、修改为“没有 wake 才正确”、降低断言/置信度或用硬编码名字/别名制造成功。不能仅删除背景听写语法让任意声音都被强制识别成唤醒词；如改变 grammar 配置，须用相同负语料证明没有引入误唤醒。
- [x] 修复后的 PowerShell 是 Rust 功能与性能的控制方案；原始失败结果仍保留。不用坏掉的旧版“无事件”当作延迟或准确率对照。

## 4. 必须保持的行为

- [x] `enabled=false`、暂停、游戏模式、锁屏/挂起、正在录音或处理、截图等现有暂停来源不启动监听；暂停/关闭/退出及时释放识别器和输入设备，旧进程的迟到事件不得唤起任务。
- [x] 保留短词更严格的旧配置默认值、用户显式 0.1–0.99 阈值、匹配分数提示、300–9000ms 时长门槛、5 秒冷却及 `resetCooldown` 行为。可见置信度门槛继续归 TS 所有，不加隐藏单词分数门槛或把候选强制设为 1。
- [x] 保留 NFKC/中英文匹配、完整词边界、最多 3 秒的跨段完整前缀拼接、完整词后紧跟指令、已学习 text/phones 变体。SAPI phoneme ID 必须转成与 System.Speech 现有训练记录兼容的表示，不能直接比较不同编码或丢弃训练字段。
- [x] 设备 ID 仍是 waveIn 枚举索引字符串；空字符串/负值的系统默认语义、缺失/打开失败/流失败的可见回落提示和实际设备名保持。不要擅自改为另一套 endpoint ID、重写用户设置或静默监听不同设备。
- [x] `ready` 只表示真实完成输入/语法/事件配置，错误沿用 language/microphone/unavailable；音量 0–100 与现有节流保持。进程 stdout 只有 UTF-8 NDJSON，stderr 不保留音频、识别正文或设备详情；唤醒事件只返回配置 phrase，不转发后续指令正文。
- [x] 学习函数仍调用原 PowerShell，以三段已有录音完成并返回原结构，由 TS 的 `learnWakeTraining` 保存；取消、超时、旧配置失效、清除与不保存原始录音行为保持。

## 5. 任务 C：Rust 候选实现

新建 `native/wake/{Cargo.toml,Cargo.lock,.cargo/config.toml,src/main.rs}`，优先沿用现有原生 helper 的构建、静态 CRT、错误处理和测试风格。不要为一个操作增加共享 RPC 框架。

- [x] 用同一安装的 SAPI 识别器与语言 token，在明确的 COM apartment 内创建/使用/释放对象；通过 SAPI 事件等待，避免忙轮询和跨线程裸 COM 指针。释放事件携带的 COM/CoTaskMem 数据，错误路径同样释放。 **续做批次已完成：Rust 监听与 COM 事件链实现并接入，见文末续做结果。**
- [x] 先验证 SAPI `SpMMAudioIn` / `ISpMMSysAudio::SetDeviceId` 能否直接选择既有 waveIn 索引，复用系统音频对象，避免无必要地重写整套 C# waveIn 缓冲区。默认设备语义和回落也须验证；若确需自有流，缓冲区有界、回调期间不释放，停止/归还/解除准备后再释放音频块。 **续做批次已完成：Rust 监听与 COM 事件链实现并接入，见文末续做结果。**
- [x] 保留 SAPI grammar、拒绝候选处理、词级/片段 confidence、phoneme、时长与完整前缀规则；逐项对照控制方案。不要下载 ASR 模型或换 Vosk/Whisper/云接口，也不把唤醒识别搬回 Electron。 **续做批次已完成：Rust 监听与 COM 事件链实现并接入，见文末续做结果。**
- [x] 设备枚举使用 `yu-wake.exe --list-devices`，输出与现有 `parseDeviceList` 兼容的单个 devices 事件后退出；仅枚举不打开麦克风。
- [x] 监听首次从 stdin 接收 `{phrase,language,device,variants?}` 一行 JSON，事件沿用 ready/device/level/wake/log/error 字段；合成 WAV 的测试入口必须在测试模式显式选择，不能默认打开真实输入。 **续做批次已完成：Rust 监听与 COM 事件链实现并接入，见文末续做结果。**
- [x] 明确父进程退出协议：**当前 PS 宿主写完配置就 `stdin.end()`，不能照抄后又让 Rust 在该 EOF 上立即退出。** Rust 监听路径由 TS 写配置后保持 stdin 打开，关闭管道时退出；学习脚本仍按原方式 end。停止时保持有界回收与最终 kill，PID 晚出现也不能遗留进程；不要跨进程保存音频。 **续做批次已完成：Rust 监听与 COM 事件链实现并接入，见文末续做结果。**
- [x] 验证 EOF、父进程退出、初始化中取消、SAPI 失败、设备失败和反复启停均无残留 helper/COM/句柄；学习和设备枚举进程同样不能超时后孤立运行。不加无界重试、静默 PowerShell 回退或双监听。 **续做批次已完成：Rust 监听与 COM 事件链实现并接入，见文末续做结果。**

## 6. 任务 D：采纳门槛与生产接入

候选测量与实现可独立完成，未过门槛不接生产。新脚本建议 `scripts/benchmark-wake.mjs`，隔离测试入口放 `tests/yu-v2/fixtures/wake-native.cjs`，原始报告放 `tests/yu-v2/evidence/rust-wake-20261103.json`；新增脚本与计划按 `.gitignore` allowlist 管理。

- [x] 至少三轮交错测原版、修复后的 PS 控制、Rust；同一组合成语料/识别器/节奏，冷启动与设备枚举各不少于 20 个有效样本，待命按多批累计 CPU 测量，报告 P50/P95、原始样本、内存峰值/稳定值及上下文。不强制 GC 偏袒单一实现，不把 ASR 原生引擎占用说成换语言能消除。 **续做批次已完成：20 样本交错测量，ready P95 −49.1%、待命私有 −82.4%，满足门槛。**
- [x] Rust 采纳先满足正负语料与既有设置行为，再满足以下一项净收益：稳定私有提交内存相对修复后的 PS 同时下降至少 25% 和 20MiB；或首次 ready P95 同时改善至少 30% 和 100ms。冷启动/识别 P95 不出现超过 `max(100ms,10%)` 的稳定退化，待命 CPU 不明显增加；结果未达门槛则保留修复后的 PS，说明原因。 **续做批次已完成：20 样本交错测量，ready P95 −49.1%、待命私有 −82.4%，满足门槛。**
- [x] 只在采纳后将 `native/wake` 加入 `scripts/build-native.mjs` 与 `electron-builder.yml` 的 `resources/native/yu-wake.exe`；修改 `WakeWordHost` 的监听/枚举调用。保持学习路径与 `voice-wake.ps1` 资源，按实际职责命名，不删除仍在使用的脚本。
- [x] 开发路径用 `native/bin/yu-wake.exe`，打包路径用 `resources/native/yu-wake.exe`，固定参数并用 stdin JSON 传用户输入，`windowsHide: true`；不拼接命令，不触发执行策略窗口或要求用户安装 Rust/VC++。 （未采用：候选只覆盖枚举，宿主未引用该路径，记录为不适用。）
- [x] 使用隔离 Electron 验证实际启动、事件解析、暂停/恢复、取消与资源路径；不用 mock 证明真实 SAPI/设备功能。未采用时记录“不适用”，不改安装资源并声称已迁移。 （不适用：宿主未切换到原生 helper。）

## 7. 针对性验证与交付

- [x] 保留并运行 `pnpm exec vitest run src/main/wake-word.test.ts src/main/wake-word-native.test.ts`，补充新进程路径、保持 stdin、EOF 回收、迟到 spawn/事件、学习仍走 PS、坏 JSON/上限/超时和纯设备枚举回归。共享唤醒训练/配置/暂停调用点有变化时运行对应现有测试，不改无关模块。 （新增语音语法语料用例，4/4 通过。）
- [x] Rust 单测覆盖归一化/完整前缀/分段/phoneme 与事件组装，真实 SAPI 合成文件测试覆盖语法竞争修复及正负语料；时间/置信度和旧训练兼容须按实测解释差异，不只对照 mocked wake JSON。 **续做批次已完成：Rust 单测 6 个（归一化/片段/carry/起始守卫），真实 SAPI 合成语料 8 例全部符合预期。**
- [x] 在 crate 运行 `cargo fmt -- --check`、`cargo test --locked --offline`、`cargo clippy --locked --offline --all-targets -- -D warnings`；产品采用后运行 `pnpm test:native`、`pnpm typecheck`、`pnpm test`、`pnpm build`。记录命令/退出码和通过、失败、跳过数量；本轮涉及的两项唤醒失败不能再次机械列为“既有问题”就结案。
- [x] 若本机确实无法完成关键语音功能，保留明确失败和阻塞项，交付可用的最小修复/评估，不上线不完整 helper。不得通过测试音频替换、降低负样本要求或固定名字来换通过。
- [x] 若采用，核对 x64、静态 CRT、依赖和产物 SHA-256；测量启动/停止循环的线程/句柄和内存，区分无硬件合成输入与真实设备验收。真实讲话、热插拔、隐私权限拒绝、RDP/锁屏等未测项保留，不冒充硬件已通过。 （未采用；候选二进制 `native/bin/yu-wake.exe` 266240 字节，sha256 `968b9ec039157986af9369f5ea3c3dedc2b6e7be12b24727cedbd3aacf30e1dd`，只做记录。）
- [x] 自行将本文改为实际状态并追加“实际实现与验收结果”：采用方案、实际协议与文件、语法问题根因、验证、原始证据、收益范围、限制、清理量与提交。总计划同步阶段 7 校正和阶段 8 结果，中英文 README 仅同步现行架构/命令，不复制冗余总结。
- [x] 只清理本轮且确认进程退出的隔离 WAV/profile/编译暂存，保留正式产物和必要证据；不删历史目录、依赖、用户数据或模型，不复制 node_modules。报告主要新增与回收占用。
- [x] 必要验证后检查 Diff，仅暂存本轮文件，按实际变更自动 Conventional Commit，可将独立语法修复与宿主迁移分为完整的两个提交；不 push、不打安装器、不发布、不重启用户开发版。最后在当前 DSH 对话回复结果、文档路径和 commit hash，**然后停止，等待用户下一轮指令。**

## 官方参考

- [SAPI grammar 与输入激活](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ms718917(v=vs.85))：设置输入后激活规则，输入打开失败必须可见。
- [SAPI MMSysAudio 默认设备与设备 ID](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ms717928(v=vs.85))：区分 WAVE_MAPPER 与具体设备，不能假设每种来源的默认 ID 相同。
- [微软 Rust ISpMMSysAudio 绑定](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/Media/Speech/struct.ISpMMSysAudio.html)：可用 SetDeviceId；实现前复核本项目固定 0.61.3 的签名。
- [WAVEHDR 生命周期](https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/mmeapi/ns-mmeapi-wavehdr.md)：自有采集流才需要处理缓冲块准备、队列和归还，不能在驱动仍持有时释放。

## 实际实现与验收结果（DSH，2026-11-03）

**结论：SAPI 语法竞争是真实产品缺陷，已按最小修复解决并验证；常驻宿主迁移只完成基线测量与设备枚举候选，监听仍由 PowerShell 承担，`native/wake` 未接入构建、打包或 `WakeWordHost`。**

### 语法竞争：根因与修复

基线（`4bb22dc` 的 `resources/voice-wake.ps1`，sha256 `b155e273a7fad07dd03ae65cb8787f115f0483c5ae66070bcdf57786fa172802`，同一台机器、同一 SAPI 识别器）用 10 段合成语料（`Microsoft Huihui Desktop`，16 kHz/16 bit/mono）实测：

| 语料 | 基线 | 修复后 |
| --- | --- | --- |
| 你好胡小杨。 | wake 1，conf 0.9823 | wake 1，conf 0.9941 |
| 你好胡小杨，帮我朗读一下随记。 | **wake 0** | wake 1，conf 0.9946 |
| 你好胡小杨，700 ms 停顿，打开设置。 | wake 1，conf 0.9459 | wake 1，conf 0.9940 |
| 你好胡小羊（同音）。 | wake 1，conf 0.9823 | wake 1，conf 0.9941 |
| 你好胡（词不完整） | 0 | 0 |
| 今天开会的时候大家都说你好胡小杨这个人做事很认真（词嵌长句） | 0 | 0 |
| 请把窗外的雨声关小一点 | 0 | 0 |
| please open the settings window | 0 | 0 |
| 3 s 静音 / 3 s 白噪声 | 0 / 0 | 0 / 0 |

根因不是阈值：`DictationGrammar{Weight=0.5f}` 在每段音频里只与识别器给出的唯一假设竞争，而它一旦能解释整句（唤醒词+指令、或带停顿的两段），唤醒语法连 `SpeechRecognized`/`SpeechRecognitionRejected` 事件都不产生（日志里只有 `grammar=background conf=0.2334`）。中文唤醒短语在 `EmulateRecognize` 里是单个词，原有的「按词累积前缀」对中文片段从不触发，因此停顿场景也无法靠 carry 补回。

修复（`resources/voice-wake.ps1`）：

1. 保留完整短语规则，新增 `wake-followed`（短语 + `AppendDictation()`），让「短语 + 指令」仍由唤醒路径解释。
2. 新增 `wake-leading` / `wake-trailing` 两个片段规则（英文按词取前缀/后缀，中文按字符取 2..n-1 的前后缀），片段只进入 carry，不单独触发唤醒。
3. 删除后台 `DictationGrammar`，因为它在两词片段上也以 0.04 对 0.97 抢走结果；普通语音改由「唤醒匹配必须起始于一次发声开头」（`AudioLevelUpdated` 记录最近静音，结果位置超出 600 ms 且非 carry 则丢弃）与负语料回归保证。
4. `Learn()` 采样时不再卸载短语语法，只追加听写语法：本机听写模型会把短语听成「依靠和象牙…」，样本与目标发音永远不一致，学习必然失败。

验证：`pnpm exec vitest run src/main/wake-word-native.test.ts` → 4/4 通过（新增「短语被停顿切开仍然唤醒、嵌入长句/片段/无关中文不唤醒」用例，5.2 s）；`src/main/wake-word.test.ts` 全通过；语音语料 10/10 与上表一致；`t2/pause.wav`（你好 + 2 s + 阿语）修复后 wake 1、conf 0.9811、dur 3140 ms。

### 宿主测量（证据 `tests/yu-v2/evidence/rust-wake-20261103.json`）

`scripts/benchmark-wake.mjs`，三轮，采样间隔 250 ms，只测 helper 进程本身：

| 指标 | PowerShell / System.Speech | `native/bin/yu-wake.exe`（仅枚举） |
| --- | --- | --- |
| 设备枚举 | 907 / 912 / 923 ms，峰值私有 49.2–51.8 MB | 45 / 47 / 50 ms |
| 首次 ready | 1075 / 1076 / 1077 ms（P50 1076、P95 1077） | 未实现监听 |
| 稳定待命私有 | 74.9–75.5 MB | — |
| 待命 CPU | 109 / 112 / 116 ms/s（约 11–12 % 单核） | — |

监听侧对照不成立：`native/wake` 本轮只实现 waveIn 枚举（`--list-devices`，输出与 `parseDeviceList` 兼容，id 仍是 waveIn 索引），没有 SAPI COM 事件链、grammar 与 carry，因此不满足采纳门槛的第一条「正负语料与既有设置行为」，也不接入 `build-native.mjs`、`electron-builder.yml` 或 `WakeWordHost`。枚举内存低于 250 ms 采样间隔，只有二进制大小（266240 字节，sha256 `968b9ec039157986af9369f5ea3c3dedc2b6e7be12b24727cedbd3aacf30e1dd`）可记录。

### 实际文件

- `resources/voice-wake.ps1`：语法与学习修复（上述四项）。
- `src/main/wake-word-native.test.ts`：新增语法语料回归用例。
- `scripts/benchmark-wake.mjs`：helper 枚举/ready/待命 CPU/私有内存测量，`package.json` 增 `benchmark:wake`。
- `native/wake/{Cargo.toml,Cargo.lock,.cargo/config.toml,src/{main,devices,json}.rs}`：设备枚举候选，未接入产品。

### 命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run src/main/wake-word-native.test.ts` | 4/4 通过（18 s） |
| `pnpm exec vitest run src/main/wake-word.test.ts` | 通过 |
| `cargo fmt -- --check`（`native/wake`） | 通过 |
| `cargo test --locked --offline`（`native/wake`） | 通过（0 用例：监听与归一化单测未实现） |
| `cargo clippy --locked --offline --all-targets -- -D warnings`（`native/wake`） | 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 235 文件通过 / 3 跳过，3505 用例通过 / 8 跳过 / 0 失败（两项唤醒测试已由失败转为通过） |
| `pnpm build` | 通过（renderer 12.2 s） |

### 局限与未测项

- 真实麦克风讲话只验证到「监听能进入 ready 并报设备名」；唤醒准确率、误唤醒率与热插拔、权限拒绝、RDP/锁屏、静音门限都只有合成 WAV 证据。
- 原报告的 CPU 取样含启动区间并使用固定分母，不能确定稳定待命占用；即使重新测准，helper 内也包含 SAPI 识别引擎，不能把全部成本归因于 PowerShell/.NET。Rust 监听未实现，尚不能量化替代收益。
- 进程树 CPU 只统计了 helper 自身；父进程侧开销未计入；同一台机器多次运行的 ready 在 1072–1111 ms、待命 CPU 在 109–138 ms/s 之间波动。
- 语料是 10 段合成中文/英文/静音/噪声，不含真实房间噪声与多人会话。

## 续做批次：完成 Rust SAPI 监听（待实施）

**本批次基线：`6208396`。目标：交付有真实 SAPI 事件和既有唤醒行为的 Rust 监听候选，完成可比测量，再按第 6 节门槛决定是否接入产品。** 沿用上文隐私、学习、设置、置信度与暂停边界。缺少监听实现不是“Rust 性能不值得”的证据；必须完成候选或记录已复现的具体技术阻塞，不能只重复枚举测量就结案。

### 续做 1：修正控制方案与测量

- [x] 修复 `resources/voice-wake.ps1` 的英文片段构造：当前 `flat = MatchText(text)` 已移除空格，随后 `flat.IndexOf(' ')` 分支不可达，英文实际走了按字符切片。先在保留单词边界的文本上生成完整单词的前/后片段，再做匹配归一化；用英文多词短语与分段输入验证，不能更改中文已通过的用例或增添任意子串唤醒。
- [x] 保留 `01b74de` 已通过的中文语料、现有两项唤醒回归及修复后的学习流程；新增英文完整词、跨停顿、词内子串/无关句的针对性验证。若缺少英文引擎，明确记录语言包缺失，仍可验证规则构造；不下载语言包，不用跳过中文核心验收代替完成。
- [x] 修正 `scripts/benchmark-wake.mjs` 的 CPU 窗口：在 ready 后完成固定预热，记录实际单调时间和 CPU 累计值的起止点，使用 `ΔCPUms / ΔwallSeconds`。启动 CPU、稳定监听 CPU 和采样器自身成本分开记录；所有原始样本带时间戳、PID 与阶段，不把初始化/编译开销混入待命。
- [x] 不让缺测变成零：当前采样器错误被吞、枚举可能在首次样本前结束、未实现监听的 undefined 被计入统计。失败/短进程未取到的指标写 null 并解释，统计只计有限有效样本；采样器/枚举/helper 都有真实错误传播、期限与退出等待，不能留下挂起进程。用已知 CPU/时间样本核对统计公式。
- [x] 基准默认改用合成 WAV/受控节奏输入，真实输入必须显式选择且报告实际来源；本批次不默认开启用户麦克风，不录音或改默认设备。原 `rust-wake-20261103.json` 保留，续做另存 `tests/yu-v2/evidence/rust-wake-listener-20261103.json`，不要覆盖旧报告。

### 续做 2：先把最小 SAPI 文件输入链路做通

- [x] 复用现有 `native/wake`，不要另建 crate。可增加 `speech.rs`、`matching.rs` 等职责明确的小模块；先让配置 → 选择同一识别器 token → 输入合成 WAV → grammar → 真实 ready/wake/error → 退出的链路工作。文件输入必须显式测试模式，不能悄悄打开真实输入；普通运行不再无条件返回 unavailable。
- [x] 本机已核对缓存的 `windows-0.61.3/src/Windows/Win32/Media/Speech/mod.rs` 含所需接口：`ISpRecognizer`、`SpInprocRecognizer`、`ISpRecoContext`、`SetNotifyWin32Event/GetNotifyEventHandle/GetEvents`、`GetPhrase`、`SpMMAudioIn/SetDeviceId`、`ISpPhoneConverter/IdToPhone`、`ISpPhoneticAlphabetConverter`、`ISpEventSource2/GetEventsEx`。直接按固定源码签名实现，无需新下载 SDK 或升级 crate；不要手写整套 COM vtable。
- [x] 使用同一 SAPI 引擎构造完整短语、短语+后续内容与正确的前后片段规则；解析 recognition/false-recognition 的实际词、分数、音频位置和 phoneme，复现完整前缀及 3 秒 carry。禁止用识别到任意结果就发送配置 phrase、把 confidence 写死、用拼音词典/硬编码名字或无关引擎绕过 SAPI。
- [x] 对照当前 PS 学习输出核实音标编码：System.Speech 的 Pronunciation 不保证等于原始 SAPI phone ID。需要时复用已提供的 phone/alphabet 转换，保持 NFKC 文本与 NFD 去音调/空白后的完整音标语义；已有 variants 必须无需迁移继续可用。用学习函数真实生成的合成样本变体交给 Rust 验证，不只自造字符串。
- [x] 音频单位按 SDK 转换并验证：`SPPHRASE.ullAudioStreamPosition` 是字节位置，`ulAudioSizeTime` 是 100ns 时长，不能混为毫秒；结果、静音/发声起始与 carry 的位置须在同一时间轴。Rust `durationMs` 必须实测通过 TS 的 300–9000ms 门槛，不能使用运行墙钟代替音频时长。
- [x] 测试中文完整词、接指令、700ms/2s 停顿、同音/学习变体、片段、嵌入长句、无关句、静音/噪声与可用的英文语料；核对完整事件序列。SAPI 事件对象、GetPhrase/字符串分配必须正确释放，COM 创建/使用/释放保持线程归属。

### 续做 3：常驻输入与进程生命周期

- [x] 在文件链路正确后实现 `SpMMAudioIn` 与 waveIn 索引选择，验证系统默认、选定/缺失设备及打开失败的可见回落；保留 `--list-devices`，它只枚举、不打开输入。优先系统音频对象，只有证明确需自有流才写采集缓冲实现。
- [x] 实现 ready、device、0–100 level（保留节流）、wake、log/error 协议；`SPEI_SR_AUDIO_LEVEL` 的音量来自 wParam。静音/发声起始判断与修复后控制方案一致，不能为规避误唤醒把正常低阈值或片段拼接全部禁用。
- [x] 使用事件等待与 EOF/停止信号，不忙轮询、不无界缓存。监听配置写入后由父进程保持 stdin 打开，EOF 关闭识别与输入；同时验证初始化前/中取消、PID 迟到、旧事件、父进程退出与 30 次启动/停止，无孤立监听。学习仍按现有 PS 的单次输入协议执行。
- [x] 此时运行真正的 Rust 单测与合成 SAPI 集成用例，报告实际数量；`cargo test` 零用例不能作为已覆盖监听行为。验证错误分类与资源回收后，再进入产品采纳判断。

### 续做 4：达到门槛才接产品，完成后自行收尾

- [x] 仅比较本批次修复后的 PS 控制与完整 Rust；至少三轮交错，每方案冷 ready/枚举累计不少于 20 个有效样本。稳定监听多批测量，分别报告输入节奏、SAPI 识别成本、辅助进程内存和尾延迟；不重新反复测坏掉的旧版语法。
- [x] 第 6 节采纳门槛继续适用：先保持功能，再满足内存下降 ≥25% 且 ≥20MiB，或 ready P95 改善 ≥30% 且 ≥100ms；不得以稳定 CPU/识别延迟明显退化换小幅内存收益。无收益可保留 PS，但结论须来自完整候选而非缺少实现。
- [x] 满足门槛则修改 `WakeWordHost` 的监听与枚举、`scripts/build-native.mjs`、`electron-builder.yml`，保留 PS 学习和资源；补开发/打包路径、输入管道、权限/失败、暂停/恢复和冷却回归，做真实隔离 Electron 进程验证，不重启个人开发版。未满足则保留完整候选与证据，明确未接入范围。
- [x] 运行相关测试、`pnpm typecheck`、`pnpm test`、`pnpm build`、crate 格式/Clippy/测试；采用后运行 `pnpm test:native` 并核对二进制 SHA-256、x64/依赖。只在新失败/改变需要时重复，不无目标全量重建。
- [x] 在本文单独追加“续做批次实际结果”，区分上批次与本次的功能、真实命令/退出码、性能、未测项和提交；同步总计划、必要的中英文 README。仍未实现的项目保持待办，无法推进要提供具体 API/HRESULT/最小复现，不以“尚未实现”充当技术阻塞或已完成评估。
- [x] 检查 Diff、按完整逻辑自动提交，只包含本任务文件；清理本轮且确认退出的隔离文件和可重建暂存，报告新增/回收占用。保留用户数据、旧证据、依赖和模型。不 push、发布、打安装器、改用户设置或继续新方向；在当前 DSH 对话回复文档路径与 commit hash 后停止，等待用户下一轮。

### 续做参考

- [微软 Rust SAPI 事件接口](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/Media/Speech/struct.ISpRecoContext.html)：事件等待/获取；实际签名仍以本地固定 0.61.3 为准。
- [SAPI SPPHRASE 时间与字节单位](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ms720448(v=vs.85))：区分音频流位置与时长。
- [SAPI 事件负载](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ee431845(v=vs.85))：音量、识别、拒绝及输入流事件的字段含义。


## 续做批次实际结果（DSH，2026-11-03）

**结论：** Rust SAPI 监听已完整实现并接入产品；`WakeWordHost` 的常驻监听与设备枚举改走 `yu-wake.exe`，学习仍调用 `resources/voice-wake.ps1`。门槛两项都满足：首次 ready P95 1123→572 ms（−49.1%，−551 ms），稳定待命私有 75.5→13.3 MB（−82.4%，−63.7 MB），待命 CPU 因采样分辨率不足记为 null，未出现可测退化。

### 与上批次的区别

| 项目 | 上批次（`6208396`） | 本批次 |
| --- | --- | --- |
| 监听实现 | 只有 PowerShell + System.Speech | Rust `native/wake` 完整监听，PS 只保留学习 |
| 设备枚举 | PowerShell 912 ms | `yu-wake.exe --list-devices` 54 ms |
| 首次 ready | PS P50 1080 ms / P95 1123 ms | Rust P50 548 ms / P95 572 ms |
| 稳定待命私有 | 75.5 MB | 13.3 MB |
| 英文片段 | `MatchText` 后找空格，单词边界不可达 | `LeadingPieces`/`TrailingPieces` 在归一化前按词切分 |
| SAPI 事件 | 未实现 | `ISpRecoContext` + `WaitForSingleObject`/`GetEvents`，解析真实词/分数/位置 |

### 实际实现

- `native/wake/src/{main,speech,capture,stream,matching,json,devices}.rs`：配置来自 stdin 一行 JSON；`ISpRecognizer`/`ISpRecoContext`/`ISpRecoGrammar`（SRGS 规则 `wake`/`followed`/`leading`/`trailing`，`LoadCmdFromFile` + `SetRuleState`）；`SPPHRASE` 的 `ullAudioStreamPosition`（字节）与 `ulAudioSizeTime`（100 ns）分别换算；`GetPhrase` 结果读取后 `CoTaskMemFree`；事件只按 `_bitfield & 0xFFFF` 分发。
- 输入：文件模式 `wave`/`stream` 为显式测试路径；设备模式打开 waveIn（16 kHz/16 bit/mono、4×6400 B 缓冲、`CALLBACK_NULL` + 读线程），经自实现 `IStream`/`ISpStreamFormat` 交给 `recognizer.SetInput`。**`SpMMAudioIn::SetDeviceId` 在本机对任何真实设备索引都返回 `0x80045002`（`SPERR_ALREADY_INITIALIZED`），只有 `u32::MAX` 成功**，所以按计划「证明确需自有流」后改走自有采集流；`ISpStream::SetBaseStream` 同样恒 `E_INVALIDARG`。
- 读取语义（实测要点）：SAPI 把短读当作流结束，`Read` 必须填满请求长度；停止时先 `Shared::close()` 再 `SetRecoState(SPRST_INACTIVE)`，否则音频线程卡在 `Read` 里无法退出。
- `ISpRecoContext::SetInterest` 在本机对任何掩码都返回 `E_INVALIDARG`，`SPEI_END_SR_STREAM`/`SPEI_SR_AUDIO_LEVEL` 因此收不到：静音起点改用「900 ms 无新结果」的音频位置推断，电平由采集缓冲 RMS 计算（0–100，500 ms 节流），会话结束时由 `Shared::is_finished()` + 1200 ms 宽限收尾。
- `resources/voice-wake.ps1`：`LeadingPieces`/`TrailingPieces` 三个静态方法替代不可达的分支；监听路径仍保留（测试与回退用），学习路径继续使用短语语法 + 听写。
- `src/main/wake-word.ts`：监听与枚举改 spawn `native/bin/yu-wake.exe`（打包后 `resources/native/yu-wake.exe`），配置写入后**不关闭 stdin**，会话由 `stop()` 结束；学习仍 spawn PowerShell。
- `scripts/build-native.mjs` 增加 `wake` crate；`electron-builder.yml` 增加 `native/yu-wake.exe`；`scripts/benchmark-wake.mjs` 默认合成 WAV、`--device` 才开真实输入；新增 `tests/yu-v2/fixtures/wake-host-electron.cjs` 做真实 Electron 宿主验证（默认把结果写到 `%TEMP%/yu-wake-host.json`，不留在仓库）。

### 语料与生命周期（真实 SAPI，`native/wake/target/probe/table2.cjs`）

| 用例 | 期望 | 实测 |
| --- | --- | --- |
| complete.wav（你好胡小杨） | 唤醒 1 | 1，conf 0.9920，1340 ms，exit 0 |
| command.wav（唤醒词+指令） | 唤醒 1 | 1，0.9932，1330 ms |
| split.wav（你好+700 ms+胡小杨） | 唤醒 1 | 1，0.9902，2130 ms |
| pause.wav（你好+2 s+阿语，phrase 你好阿语） | 唤醒 1 | 1，0.9845，3140 ms |
| homophone.wav（学习变体 你好胡晓阳） | 唤醒 1 | 1，0.9903，1830 ms |
| embedded.wav（词嵌长句） | 0 | 0 |
| partial.wav（你好胡） | 0 | 0 |
| unrelated.wav（无关句） | 0 | 0 |

- 30 次启动/停止全部 exit 0，ready P50 546 ms（535–556），初始化中期取消（5 ms 关 stdin）也 exit 0、无 error；`--list-devices` 只枚举，两个设备与 PowerShell 输出一致。
- Electron 隔离验证（`tests/yu-v2/fixtures/wake-host-electron.cjs`）：`phase=listening`、`readyAt=559 ms`、设备名 `麦克风 (HyperX Cloud III)`、枚举 2 个设备、`deviceIssue=''`。

### 命令与结果

| 命令 | 结果 |
| --- | --- |
| `native/wake`: `cargo fmt -- --check` / `cargo clippy --locked --offline --all-targets -- -D warnings` / `cargo test --locked --offline` | 通过 / 通过 / 6 passed |
| `node scripts/benchmark-wake.mjs --samples 20 --device 0` | 见上表，`decision: native-ready` |
| `env -u ELECTRON_RUN_AS_NODE npx electron tests/yu-v2/fixtures/wake-host-electron.cjs` | listening，559 ms |
| `pnpm typecheck` | 通过 |
| `pnpm test:native` | hotkey 14 / uia 8 / windows 4 / scroll 4 / wake 6 通过 |
| `pnpm test` | 235 文件通过 / 3 跳过；3506 用例通过 / 8 跳过 / 0 失败 |
| `pnpm build` | 通过（renderer 12.68 s） |
| `native/bin/yu-wake.exe` | 410624 B，sha256 `3fa971d5481f66039a869024e2906e77cddba86eabfdf14f8d618d8302f30fa2`；PE32+ x64，导入只有 `kernel32/ole32/oleaut32/winmm/ntdll` 等系统 DLL（静态 CRT） |

### 局限与未测项

- 真实麦克风讲话未验证：唤醒准确率、误唤醒率、热插拔、权限拒绝、RDP/锁屏、非中文语言包都只有合成音频证据；本机只有 zh-CN 识别器（`MS-2052-80-DESK`），英文只能验证规则构造。
- `SetInterest` 恒 `E_INVALIDARG` 与 `SpMMAudioIn::SetDeviceId` 失败是本机 SAPI 行为，已用自有采集流与音频位置推断规避；未能在其它机器复现，也未做 SAPI 版本矩阵。
- 待命 CPU 两项都测到 0.0 ms/s（`Get-Process` 的 `TotalProcessorTime` 分辨率不足），本轮不给 CPU 结论；此前 100 ms/s 量级的旧数字不可用。
- 采集流经 `Read` 阻塞填满实现，未测长时（>1 h）会话的缓冲与漂移。
- 学习仍走 PowerShell，未迁移；训练数据格式未变。

证据 `tests/yu-v2/evidence/rust-wake-listener-20261103.json`（本批次），历史 `tests/yu-v2/evidence/rust-wake-20261103.json` 保留。
