# 第九阶段：Rust 唤醒正确性与资源回收修复计划

> **执行者：DSH，继续现有 typeless 对话和工作区。** 直接修复、验证、自行回写文档并提交，完成后停止，等待用户下一轮指令。Codex 不监听开发过程。

**状态：主要修复已交付，旧音标兼容与完整 600s 验收待续做。** 上批功能提交 `44335c6`，记录提交 `9ffbaa8`，基线 `d31a0a4`；SDK 参数、读取与回收已有实现和测试，学习音标仍不等价。执行本文末“续做批次：旧学习音标兼容收尾”，按实际验证收尾，不把剩余兼容问题当作迁移完成。

**目标：** 先让已接入的 Rust 唤醒可靠保持既有功能与资源生命周期，再讨论新迁移模块。启动延迟/内存收益不能代替正确性验收。

**架构：** 保留 Rust 独立进程、TS 状态/阈值/冷却与 PS 学习，沿用固定 Windows SAPI 和现有依赖。不换识别引擎、存储格式、设备 ID 或音频技术栈，不建通用 FFI/音频框架。开始前读 AGENTS.md、检查 Git 状态，保留已有变更，不切换工作区。

## 1. 已发现的问题与验收重点

| 优先级 | 位置与源代码证据 | 本轮处理 |
| --- | --- | --- |
| P1 | `speech.rs` 只用 `1 << SPEI_RECOGNITION`，缺 SDK `SPFEI_FLAGCHECK`，SetInterest 错误被吞；随后把缺少事件归因为机器行为 | 按 SDK 正确订阅 recognition/false-recognition/end/level，记录修前/修后 HRESULT；不能继续吞错或默认订阅 |
| P1 | `stream.rs` 的 `SPDFID_WAVE_FORMAT` 是 `c6e13340-30ac-11d0-a18c-00a0c9118956`；微软 System.Speech 实际定义为 `c31adbae-527f-4ff5-a230-f62bb61ff70c` | 修正常量并重新验证 GetFormat/SetBaseStream；旧 E_INVALIDARG 不能先当兼容性限制 |
| P1 | `Shared::position_ms()` 返回 `queue.len()/32`，是当前积压长度，非累计音频位置，会回退 | 建立与 SAPI 结果一致的单调时间轴，验证先静音再说话及连续多次发声 |
| P1 | `capture::read` 等待队列一次积满 destination；队列上限 160000，读取更大请求时无法达成；空队列上的零字节读取也会等待 | 改为逐步消费/填充，零读立即返回，EOF/取消唤醒阻塞读；保留有界队列 |
| P1 | Capture 无 Drop，prepare/add/start 返回值被忽略；打开后 SetInput 等步骤 `?` 退出时直接释放持有裸指针的 headers/buffers，reader/驱动仍可能使用 | RAII 覆盖部分初始化和所有错误出口，停止/归还/解除准备/关闭后再释放，防止残留线程与悬空指针 |
| P2 | 打开已选设备失败只发回落 log 后报错，并未真正尝试默认输入；默认设备名可能为空 | 保持原控制方案的可见回落语义与实际设备身份，不用提示伪装成功回落 |
| 待验证 | `matching.rs` 没有实际 NFKC/NFD 转换；raw phone ID 被直接当字符；`word_from_element` 还用固定 0.3/0.6/0.9 猜分数 | 用 PS 学习真实输出及逐值/事件对照核验文本、音标、整句/词级置信度，不能只比较人为构造的变体 |

## 2. 任务 A：先修 SDK 参数，消除无证据绕行

涉及 `native/wake/src/{speech,stream}.rs`、已有原生/宿主测试；保持 `windows = "=0.61.3"`。

- [x] 按微软 `sapi.h` 复现并记录：`SPFEI_FLAGCHECK = (1u64 << 30) | (1u64 << 33)`，`SPFEI(id) = (1u64 << id) | SPFEI_FLAGCHECK`。两种 interest mask 都按 SDK 构造，订阅本轮实际使用的四类事件，在 ready 前完成配置。若队列只需要其子集，明确说明；不能漏标志后再认定系统有问题。
- [x] 改用正确 `SPDFID_WaveFormatEx`，验证 GetFormat 返回的 GUID、PCM 格式与 SAPI 实际使用格式一致；修正 `bytes_per_ms` 在输入配置前取值的假设。输入为 16k/16bit/mono 时验证 32B/ms，其它测试格式明确支持或拒绝，不默默用错误比例。
- [x] 对既有 `SetInterest`、`SetBaseStream`、`SetDeviceId` 的失败做最小真实对照，记录调用顺序与 HRESULT。纠正原因和调用参数后，再决定自有流是否仍必要；不要求为了减少代码重写全部采集实现，也不增加超时/轮询来掩盖 API 错误。
- [x] 正确处理事件等待/GetEvents 错误及事件负载所有权；保留 recognition、rejection、end 和实际支持的 level。核对 `SPEVENT.elParamType` 的对象/分配释放，不能只释放识别分支。正常文件结束靠真实 end 事件，删除已无必要的“文件大小推时长+1500ms”/“1200ms 宽限”等绕行。
- [x] 真实源若确不提供音量事件，可保留经验证的采集 RMS 显示；发声边界必须使用对应的音频位置，不能借“900ms 无结果”推测静音。修正旧文档中与源码/SDK不符的归因，保留原报告。

## 3. 任务 B：修时间轴和流读取契约

涉及 `native/wake/src/{capture,stream,matching,speech}.rs`。

- [x] 分清累计采集/送入 SAPI/消费位置与队列长度，保证用于静音、result 和 carry 的位置在同一时间轴且不回退。队列溢出要按完整 PCM 帧处理并显式处理丢弃产生的时间断点，不能拼接断裂音频成同一次唤醒；不添加全局缓存或无界积压。
- [x] IStream Read 支持请求超过队列上限：一边消费一边等待后续数据；`cb=0` 立即按 COM 契约返回并写回 0。正常填满/EOF 短读/关闭/停止的 HRESULT 与字节数一致，Seek 只保留真实支持的初始化探测，不让任意 seek 成功来掩盖不支持的行为。
- [x] 加可重复的无麦克风回归：零读、大于 160000B 的读、分段推送、短 EOF、Read 阻塞时 close、慢消费者/队列溢出。检查字节序列、期限与线程退出，不改队列上限躲过大请求用例。
- [x] 用合成音频验证：起始静音 10s/30s 后唤醒、同一会话多轮间隔发声、中文/英文可用语料、完整词接指令、700ms/2s 跨段、超 3s 片段、句中嵌词与噪声。必须经实际 Rust 自有流/文件输入路径；文件开头一次成功不能代表长期监听正确。不得默认打开真实麦克风。

## 4. 任务 C：生命周期、设备和既有设置兼容

- [x] Capture 的构造逐步记录实际拥有的句柄/已 prepare 的 header；任何失败都可安全销毁。检查所有 waveInPrepareHeader/AddBuffer/Start/Reset/Unprepare/Close 的实际返回，只有驱动已归还且 reader 已退出才能释放裸指针指向的内存；Drop 与显式 close 不双重释放。不另写通用资源管理框架。
- [x] 在 SetInput、语法/通知配置、激活失败，以及 EOF/初始化中取消/正常停止时验证清理。针对真实错误出口做必要故障注入，检查 reader、waveIn 和缓冲所有权；单次进程退出码不能证明每个错误路径正确。
- [x] 修已选设备打开/送流失败时的默认回落，保留一次可见 notice，报告实际输入名；默认也失败则按 microphone 错误退出。保留 waveIn ID，不改用户设置、默认系统设备，不添加无限重试或双监听。
- [x] 核对 TS stop/初始化期间暂停/迟到 spawn/迟到事件/父进程退出。现有 host 改动没有加入 spawn 后的过期进程再清理，需要用生命周期回归证明没有遗留，而非只看 30 次已进入 ready 的正常退出。
- [x] 对照 `resources/voice-wake.ps1` 的 MatchText/Phones 做实际 NFKC/NFD 归一化，覆盖全角拉丁字母/数字、大小写与组合附加符。复用现有 Win32/依赖实现，不用“兼容折叠”注释替代真正转换。
- [ ] 用 PS `Learn()` 实际生成的合成训练样本比较编码，再验证 Rust 识别结果的音标与旧 variants，要求至少一组只能靠音标而不是变体 text 相同匹配。核实 SAPI phone ID、UPS/IPA 与 System.Speech Pronunciation 的关系，不预设 ID 就是保存的字符串；不得迁移或重写用户训练数据。
- [x] 保留整句与拼接/部分词的置信度语义和 0.1–0.99 用户门槛、300–9000ms 时长与 5s 冷却。对比原控制方案的句级/词级分数，真实零分不能被抬高成固定猜测；缺失/非法分数不得伪装高置信度成功。

## 5. 可重复验收、文档与停止条件

- [x] 把上轮位于 `native/wake/target/probe/table2.cjs` 的必要语料/生命周期探针整理为受跟踪的最小 fixture 或真正的 Rust 集成测试，例如 `src/main/wake-word-rust.test.ts`、`tests/yu-v2/fixtures/wake-native.cjs`。只保留必要生成脚本，不提交大批 WAV；新脚本按 allowlist 管理。纯 matcher 六个测试和仍调用 PS 的测试不能冒充真实 Rust 监听覆盖。
- [x] 相关回归先验证修前失败、修后通过，再运行 Rust fmt/test/Clippy、`pnpm test:native`、`pnpm typecheck`、`pnpm test`、`pnpm build`。保留已有正负语料，不改阈值/预期或 skip 来掩盖回归；语言包确实缺失与功能失败分开记录。
- [ ] 做隔离 Electron 的实际宿主/子进程验证，并在合成受控输入下连续监听至少 10 分钟，在后段送入唤醒/负语料，记录线程/句柄、内存平台值、事件与结束。可生成音频流而不保存长文件；等待期间只在 DSH 本对话报告有意义进度，不要求 Codex 监听。1h/热插拔/真实讲话/UAC/RDP 未测仍保留未测。**部分完成：上批记录为 568s（9.45 分钟），未达到 600s；续做只对最终版本补一次完整会话，不重复所有旧基准。**
- [x] 正确性通过后用相同输入、识别器和采样条件重测修复后的 PS 与 Rust；启动/内存/CPU/唤醒尾延迟范围分开。现有报告的 `decision` 只按 ready/内存判断，不含功能与 CPU 退化门槛，须与真实功能验收结合，缺测 CPU 不能写成“无退化”。不重复无目标全量重建或扩大到学习/ASR等迁移。
- [x] 新报告建议 `tests/yu-v2/evidence/rust-wake-correctness-20261103.json`，记录基线、实际文件/hash、命令/退出码、回归与限制。原 `rust-wake-listener-20261103.json` 保留，不能覆盖后声称从未有问题。
- [x] 开始时将本文标“实施中”；结束自行追加“实际修复与验收结果”，仅勾已完成项目，同步总计划、阶段 8 归因与中英文 README 的现行行为。硬件未测、可复现 API 阻塞保留真实状态，不把所有待办机械勾选。
- [x] 必要验证后检查 Diff，只暂存本任务文件，自动 Conventional Commit；清理本轮隔离/暂存前确认路径和进程退出，保留用户数据、模型、依赖与必要证据，报告主要新增/回收占用。不 push、不发布、不打安装器、不改个人设置或自动重启开发版。最后在现有 DSH 对话回复结果、文档路径和提交 hash，然后停止，等待用户下一轮。

## 官方依据（规划时已核对）

- [微软 SDK sapi.h](https://raw.githubusercontent.com/microsoft/win32metadata/main/generation/WinSDK/RecompiledIdlHeaders/um/sapi.h)：SPFEI_FLAGCHECK/SPFEI、事件结构及 SAPI 接口。
- [微软 System.Speech SapiInterop.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Speech/src/Internal/SapiInterop/SapiInterop.cs)：SAPIGuids.SPDFID_WaveFormatEx 的准确 GUID。
- [SAPI 音频位置与时长](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ms720448(v=vs.85))：字节位置与 100ns 时长不可混用。
- [WAVEHDR 所有权与队列状态](https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/mmeapi/ns-mmeapi-wavehdr.md)：只在驱动归还缓冲后回收资源。

## 实际修复与验收结果（DSH，2026-11-03）

**结论：** `SetInterest` 与 `SetBaseStream` 两处「机器限制」归因被调用参数对照推翻，并修掉文件时长/宽限收尾绕行；`SetDeviceId` 的失败仍存在，不能写成所有 API 限制已被推翻。时间轴、读取和 RAII 等已有实现，12 项二进制测试及实际 568s 合成会话通过；旧 PS 学习音标与 Rust 仍不等价，完整 600s 会话也尚待补足。以下是该批次实际记录，剩余项见文末续做任务。

### 修前/修后对照（同一台机器，`native/wake/target/release/yu-wake.exe`）

| 项目 | 修前 | 修后 |
| --- | --- | --- |
| `SetInterest` 单事件掩码 `1<<38` | `0x80070057`（E_INVALIDARG），且错误被吞 | `SPFEI(38)`=`0x4240000000` → `S_OK` |
| `SetInterest` 四事件掩码 | `0x4084400000000` → `0x80070057` | `0x4084640000000` → `S_OK` |
| `SetInterest` 全掩码 `u64::MAX` | `0x80070057` | 仍拒绝（`SPFEI_FLAGCHECK` 之外还缺 ID 位），不再订阅该形态 |
| `ISpStream::SetBaseStream` | GUID `c6e13340-30ac-11d0…` → `0x80070057` | GUID `c31adbae-527f-4ff5-a230-f62bb61ff70c` → `S_OK` |
| `SpMMAudioIn::SetDeviceId(0/1)` | `0x80045002`（SPERR_ALREADY_INITIALIZED） | 仍 `0x80045002`；只有 `u32::MAX` 可用，故保留自有 waveIn 采集 |
| 会话收尾 | 文件输入等「字节数/32+1500ms」或 1200ms 宽限 | 引擎 `SPEI_END_SR_STREAM`；`complete.wav` 63–90ms 内退出 |
| 静音起点 | 「900ms 无结果」推断 | 采集累计位置 `delivered/32`；结果、静音、carry 共用一条时间轴 |
| `Shared::position_ms()` | `queue.len()/32`（积压量，会回退） | 已消费字节（单调），溢出按整帧丢弃并计入 `dropped_bytes()` |
| `read()` | 一次积满 destination、160000 上限无法完成 | 边消费边等待；`cb=0` 立即返回 0；关闭后短读；超上限请求可完成 |

### 代码改动

- `native/wake/src/speech.rs`：`SPFEI_FLAGCHECK`/`spfei()` 与四事件订阅（`step("interest", …)?` 不再吞错）；`open_device()` 先试记忆索引、失败回落 `WAVE_MAPPER` 并 `json::log_event("device-missing"|"device-open-failed"|"device-stream-failed", requested)`；设备事件名取 `capture::preferred_device()` + `device_name()` 报告**实际**设备；`handle_result` 的 `SPPHRASE*` 统一 `CoTaskMemFree`；`word_from_element` 用 `SREngineConfidence`（有效区间 (0,1]）否则 0，删除 0.3/0.6/0.9 猜测；`duration_ms = ulAudioSizeTime/10_000`、`start_ms = ullAudioStreamPosition/bytes_per_ms` 不混用单位。
- `native/wake/src/capture.rs`：`Shared` 增 `delivered`/`dropped`，`push()` 按 `FRAME=2` 整帧丢弃，`read()` 改为「边消费边等待」；`Capture` 记录 `handle/headers/buffers/reader/prepared/started/released`，`impl Drop` 统一 Stop/Reset/Unprepare/Close + join，`open()` 检查每一步返回值；新增 `preferred_device()`（`waveInMessage(DRVM_MAPPER_PREFERRED_GET=0x2015)`）。
- `native/wake/src/stream.rs`：`SPDFID_WAVE_FORMAT` 更正为 `c31adbae-527f-4ff5-a230-f62bb61ff70c`。
- `native/wake/src/matching.rs`：文本经 NFKC 折叠、音标经 NFKD 去组合符；同分/前缀/carry 语义不变。
- `native/wake/src/main.rs`：`wave`/`stream` 空字符串视为未提供（宿主会带空 `wave`）；deadline 只作卡死兜底（文件 300s，流/设备无限）。
- 测试：`src/main/wake-word-rust.test.ts`（12 项，真实二进制）+ `tests/yu-v2/fixtures/wake-native.cjs`（SAPI 合成语料、NDJSON 收集、设备枚举），覆盖完整短语、短语后接指令、700ms 跨段、2s 停顿、同音、片段、句中嵌词、无关中文、白噪声、10s 前置静音、10s 段内间隔、设备消失回落、坏配置、自有流输入、枚举。

### 语料与长会话（合成音频，无录音）

| 用例 | 结果 |
| --- | --- |
| complete / command / split(700ms) / pause2s / homophone | 各 1 次唤醒，63–90ms 内以 `SPEI_END_SR_STREAM` 结束 |
| partial / embedded / unrelated / 白噪声 | 0 次唤醒，0 个 error |
| 前置静音 10s（实时流） | 1 次唤醒 |
| 前置静音 31s（实时流，一次性探针） | 1 次唤醒，61 个 level 事件，33s 退出 |
| 段内间隔 10s（实时流） | 0 次唤醒（carry 上限 3s） |
| 连续会话 9.45 分钟（8 轮 60s 静音 + 短语 + 5s + 无关句） | 8/8 唤醒，0 error，时长 1300–1330ms，568s 后正常退出 |

### 性能复测（`pnpm benchmark:wake --device 0`，各 20 样本，交替顺序）

| 指标 | PowerShell | Rust |
| --- | --- | --- |
| 枚举 P50 | 981 ms | 52 ms |
| 首次 ready P50 / P95 | 1151 / 1277 ms | 546 / 597 ms |
| 稳定待命私有内存 | 75.4 MB | 13.3 MB |
| 待命 CPU | 0.0 ms/s（偶发 5.4–18.9） | 0.0 ms/s（偶发 2.6–5.4） |

`comparison`：`readyP95Pct −53.2`、`readyP95DeltaMs −680`、`settledPrivatePct −82.4`、`settledPrivateDeltaKb −63608`、`idleCpuPct null`，`decision: native-ready`。**待命 CPU 在 250ms 采样下多数样本为 0，两侧都有偶发非零读数，因此不能据此写「CPU 无退化」，只能说没有观察到稳定差异。** 证据：`tests/yu-v2/evidence/rust-wake-correctness-20261103.json`（`rust-wake-listener-20261103.json` 原样保留）。

### 命令与结果

| 命令 | 结果 |
| --- | --- |
| `cargo fmt -- --check` / `cargo clippy --locked --offline --all-targets -- -D warnings` | 通过 |
| `cargo test --locked --offline` | 10 passed（matching 6 + capture 4） |
| `pnpm test:native` | 通过（hotkey 14 / uia 8 / windows 4 / scroll 4 / wake 10） |
| `pnpm exec vitest run src/main/wake-word-rust.test.ts` | 12 passed（约 30s） |
| `pnpm test` | 236 文件通过 / 3 跳过，3518 用例通过 / 8 跳过 / 0 失败 |
| `pnpm typecheck` / `pnpm build` | 通过（renderer 12.62s） |
| `native/bin/yu-wake.exe` | 415232 B，sha256 `4484b04552bca2b8251dc39c298bb9417ac683a3217c140d1a012d67c811ee2b`（PE32+ x64，静态 CRT，无 VC++ 运行库） |

### 局限与未测项

- **音标编码（未完成）**：`ISpPhoneConverter` 对中文输出拼音串（`ni2hao3…`），而 `System.Speech` 的 `Pronunciation` 是 IPA（`nihaʊhuɕjaʊjɑŋ`）。两者都来自同一 phone id 序列，但文字不同，因此 PS 学习出的 variants 与 Rust 识别结果**不能只靠音标比对**；当前变体匹配实际由 text 承担，单元测试只验证了同一表示法内部的音标匹配。修复需要 pinyin→IPA 或 id 级别的共享表示，本轮未做，也没有迁移或改写用户训练数据。
- 英文识别未验证：本机只装了 zh-CN 识别器（`MS-2052-80-DESK`），英文语料未能识别，片段规则只在 PowerShell 侧验证。
- 真实麦克风讲话、热插拔、UAC/RDP/锁屏切换、1 小时连续运行仍未测；设备回滚只验证了「索引消失回落到系统默认」。
- 待命 CPU 受 250ms 采样分辨率限制，缺测值写 `null`，没有推断为「无退化」。

## 续做批次：旧学习音标兼容收尾（待实施）

**本批次基线：`9ffbaa8`（功能 `44335c6`）。** 只补本阶段剩余项，沿用现有数据、学习和语音引擎；不重开 ASR/截图/数据库迁移，不要求用户重录，不让每个识别结果启动 PowerShell，也不新增常驻 .NET 进程。

### 续做 1：建立同版真实音标对照

- [ ] 阅读 `resources/voice-wake.ps1` 的 Learn/Phones、`src/shared/wake-word.ts`、`native/wake/src/{speech,matching}.rs` 和现有 fixture。用本机实际 System.Speech/识别器生成多组中文合成样本及三次学习结果，保存语言/token、原始 phone ID 序列、PS Pronunciation、规范化 phones 和 Rust 当前输出的对照；不读取个人训练数据或录音。
- [ ] 对照微软 `Result/RecognitionResult.cs::ConvertPronunciation`、`Internal/AlphabetConverter.cs::SapiToIpa` 和 `Result/RecognizedPhrase.cs` 的音标处理。当前 `ISpPhoneConverter::IdToPhone` 返回拼音，不是已等价 IPA；更正 matching.rs 顶部及 phone_string 的错误注释。源码研究是路径依据，实际兼容以本机旧 Framework 学习输出为准。
- [ ] 精确保持 PS 的 `FormD` 后去组合符/空白/小写规则；当前 Rust 用 `NormalizationKD`，不能直接当作相同。比较声调、组合标记、IPA 修饰符和完整前缀；不改变 PS 输出/旧训练来配合 Rust，不放宽成子串或编辑距离匹配。

### 续做 2：先验证系统原生转换，再选最小实现

- [ ] 本地固定 0.61.3 已有 `SpPhoneticAlphabetConverter`、`ISpPhoneticAlphabetConverter::{SetLangId,GetMaxConvertLength,SAPI2UPS,UPS2SAPI}`，以及 `ISpPhoneticAlphabetSelection::{IsAlphabetUPS,SetAlphabetToUPS}`。用同一实际语言/token 的原始 ID 做小探针，记录 HRESULT、输入/输出代码点与 PS oracle 比较；不能只用接口名字断定 UPS、ASCII 名称与 IPA 字符串一定相同。
- [ ] 优先验证 `SpPhoneticAlphabetConverter` 的原生转换及实际支持接口的 alphabet 选择。语言来自实际选中识别器，输出容量按 API 契约计算，处理终止符与失败；不要硬编码 1024 字符输出就假设任何输入都安全，不手写 COM vtable 或升级依赖来绕过问题。
- [ ] 若系统路径能给出等价结果，就在现有 Rust 会话内初始化并复用，只在需要的匹配路径转换，释放资源；不每词重新创建整个 COM 环境。没有训练的正常文字唤醒不能因为训练转换路径失败而失效，实际不支持的训练匹配也不能伪装成已支持。
- [ ] 只有原生路径经过可复现失败/不等价对照后，才考虑复用微软官方且许可证允许的最小转换实现/表，记录来源版本、哈希、许可证与体积；仅覆盖当前支持范围，不搬完整语音框架，不自创汉语拼音→IPA 规则，不下载模型或修改识别器。如果确有外部阻塞，留下具体 API/HRESULT/最小复现及可用行为范围，不能只写“拼音不是IPA所以不做”。
- [ ] `WakeTraining`、variants.text/phones、保存路径、学习/删除/重录行为保持；修补转换适配，禁止迁移、覆盖或重新生成用户训练数据。旧设置读取与导出保持一致，合成 fixture 的读前/读后哈希不变。

### 续做 3：证明旧学习确实可用

- [ ] 新回归必须来自真实 PS Learn 的输出和真实 Rust/SAPI 识别数据；至少一组明确排除相同 text 能成功的路径，证明完整 phones 匹配。可以在测试中单独屏蔽文字分支验证已有识别数据，但不能改生产识别结果、自造两个相同音标字符串或偷偷改变配置后宣称端到端通过；同时保留真实 helper 的学习变体使用用例。
- [ ] 覆盖完整音标、分段/carry、前缀/后缀不能单独唤醒、近音却不同完整音标、无关文本、组合标记、旧无训练设置；置信度/时长/冷却及负语料保持。纯文字成功不能代替 phoneme 验收，不降低阈值或跳过失败。
- [ ] 本机仅 zh-CN：中文执行真实识别/学习测试；英文可做有明确来源的转换和规则测试，实际未安装英语引擎则保留未测，不声称英文整链路已验收，不下载语言包。探针与回归保存到现有受跟踪 fixture/测试，避免再次只留下 target/probe 中的临时脚本。

### 续做 4：验证并结束本阶段

- [ ] 在最终代码上只补一次同一 PID 实际运行 ≥600s 的合成受控会话，600s 后仍送入正/负语料，记录单调起止时间、事件、内存/线程/句柄与退出；不能只用 WAV 标称时长或多次短会话加总。默认不打开真实输入，不保存用户语音；临时长合成文件用完清理，测试缓冲占用与生产占用分开。
- [ ] 先跑直接相关的新回归、现有 wake host/Rust/native 及共享学习测试，再做 Rust fmt/test/Clippy、`pnpm typecheck`、`pnpm test`、`pnpm build`。完整 10 分钟会话只跑最终版本一次；只有新失败/改变才扩大或重复验证，不重测所有已完成迁移。
- [ ] 检查转换后的冷启动、常驻私有与唤醒尾延迟是否出现明显回退；若新增对象/表带来实质成本，用同输入的修复后 PS/Rust 对照记录。CPU 缺测仍如实写缺测，不用零值证明无开销；不以性能收益替代本轮兼容验收。
- [ ] 新证据建议 `tests/yu-v2/evidence/rust-wake-phoneme-compat.json`，包含代码/音频来源哈希、原始对照、真实命令/退出码与限制；旧报告保留。实际音频或音标诊断只来自合成 fixture，产品常规日志不记录识别正文/用户音标。
- [ ] 自行在本文件追加“音标兼容续做结果”，按真实结果更新遗留勾选、状态、总计划和必要的 README；尚未完成的内容不能标完成，568s 原报告保留为历史。检查 Diff，仅暂存本任务文件，必要验证后自动 Conventional Commit，不为填当前提交 hash 再建单独文档提交。
- [ ] 清理本轮且确认退出的隔离/编译暂存，保留有效交付、模型、依赖、用户数据和必要证据，报告主要占用。不 push、不发布、不打安装器、不改个人设置或重启用户开发版。最终在当前 DSH 对话回复结果、文档路径和 commit hash，然后停止，等待用户下一轮。

### 本批次官方参考

- [微软 SAPI 字母表转换接口](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/cc736216(v=vs.85))：语言设置、SAPI2UPS/UPS2SAPI；实际输出仍须与旧宿主逐值对照。
- [微软 AlphabetConverter](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Speech/src/Internal/AlphabetConverter.cs)：SAPI→IPA、转换表与最长可转换单元逻辑。
- [微软 RecognitionResult](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Speech/src/Result/RecognitionResult.cs)：ConvertPronunciation 对语言和 AlphabetConverter 的使用。
- [微软 RecognizedPhrase](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Speech/src/Result/RecognizedPhrase.cs)：原始音标与 IPA 标记的处理。
