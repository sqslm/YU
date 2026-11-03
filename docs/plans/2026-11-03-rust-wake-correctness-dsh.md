# 第九阶段：Rust 唤醒正确性与资源回收修复计划

> **执行者：DSH，继续现有 typeless 对话和工作区。** 直接修复、验证、自行回写文档并提交，完成后停止，等待用户下一轮指令。Codex 不监听开发过程。

**状态：待实施。基线：`d31a0a4`。** 本轮规划只做了代码及微软源码核对，未复跑真实 SAPI；下表区分确定的实现问题和仍需运行时核实的兼容性。不要把待验证因果写成已证实的机器限制。

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

- [ ] 按微软 `sapi.h` 复现并记录：`SPFEI_FLAGCHECK = (1u64 << 30) | (1u64 << 33)`，`SPFEI(id) = (1u64 << id) | SPFEI_FLAGCHECK`。两种 interest mask 都按 SDK 构造，订阅本轮实际使用的四类事件，在 ready 前完成配置。若队列只需要其子集，明确说明；不能漏标志后再认定系统有问题。
- [ ] 改用正确 `SPDFID_WaveFormatEx`，验证 GetFormat 返回的 GUID、PCM 格式与 SAPI 实际使用格式一致；修正 `bytes_per_ms` 在输入配置前取值的假设。输入为 16k/16bit/mono 时验证 32B/ms，其它测试格式明确支持或拒绝，不默默用错误比例。
- [ ] 对既有 `SetInterest`、`SetBaseStream`、`SetDeviceId` 的失败做最小真实对照，记录调用顺序与 HRESULT。纠正原因和调用参数后，再决定自有流是否仍必要；不要求为了减少代码重写全部采集实现，也不增加超时/轮询来掩盖 API 错误。
- [ ] 正确处理事件等待/GetEvents 错误及事件负载所有权；保留 recognition、rejection、end 和实际支持的 level。核对 `SPEVENT.elParamType` 的对象/分配释放，不能只释放识别分支。正常文件结束靠真实 end 事件，删除已无必要的“文件大小推时长+1500ms”/“1200ms 宽限”等绕行。
- [ ] 真实源若确不提供音量事件，可保留经验证的采集 RMS 显示；发声边界必须使用对应的音频位置，不能借“900ms 无结果”推测静音。修正旧文档中与源码/SDK不符的归因，保留原报告。

## 3. 任务 B：修时间轴和流读取契约

涉及 `native/wake/src/{capture,stream,matching,speech}.rs`。

- [ ] 分清累计采集/送入 SAPI/消费位置与队列长度，保证用于静音、result 和 carry 的位置在同一时间轴且不回退。队列溢出要按完整 PCM 帧处理并显式处理丢弃产生的时间断点，不能拼接断裂音频成同一次唤醒；不添加全局缓存或无界积压。
- [ ] IStream Read 支持请求超过队列上限：一边消费一边等待后续数据；`cb=0` 立即按 COM 契约返回并写回 0。正常填满/EOF 短读/关闭/停止的 HRESULT 与字节数一致，Seek 只保留真实支持的初始化探测，不让任意 seek 成功来掩盖不支持的行为。
- [ ] 加可重复的无麦克风回归：零读、大于 160000B 的读、分段推送、短 EOF、Read 阻塞时 close、慢消费者/队列溢出。检查字节序列、期限与线程退出，不改队列上限躲过大请求用例。
- [ ] 用合成音频验证：起始静音 10s/30s 后唤醒、同一会话多轮间隔发声、中文/英文可用语料、完整词接指令、700ms/2s 跨段、超 3s 片段、句中嵌词与噪声。必须经实际 Rust 自有流/文件输入路径；文件开头一次成功不能代表长期监听正确。不得默认打开真实麦克风。

## 4. 任务 C：生命周期、设备和既有设置兼容

- [ ] Capture 的构造逐步记录实际拥有的句柄/已 prepare 的 header；任何失败都可安全销毁。检查所有 waveInPrepareHeader/AddBuffer/Start/Reset/Unprepare/Close 的实际返回，只有驱动已归还且 reader 已退出才能释放裸指针指向的内存；Drop 与显式 close 不双重释放。不另写通用资源管理框架。
- [ ] 在 SetInput、语法/通知配置、激活失败，以及 EOF/初始化中取消/正常停止时验证清理。针对真实错误出口做必要故障注入，检查 reader、waveIn 和缓冲所有权；单次进程退出码不能证明每个错误路径正确。
- [ ] 修已选设备打开/送流失败时的默认回落，保留一次可见 notice，报告实际输入名；默认也失败则按 microphone 错误退出。保留 waveIn ID，不改用户设置、默认系统设备，不添加无限重试或双监听。
- [ ] 核对 TS stop/初始化期间暂停/迟到 spawn/迟到事件/父进程退出。现有 host 改动没有加入 spawn 后的过期进程再清理，需要用生命周期回归证明没有遗留，而非只看 30 次已进入 ready 的正常退出。
- [ ] 对照 `resources/voice-wake.ps1` 的 MatchText/Phones 做实际 NFKC/NFD 归一化，覆盖全角拉丁字母/数字、大小写与组合附加符。复用现有 Win32/依赖实现，不用“兼容折叠”注释替代真正转换。
- [ ] 用 PS `Learn()` 实际生成的合成训练样本比较编码，再验证 Rust 识别结果的音标与旧 variants，要求至少一组只能靠音标而不是变体 text 相同匹配。核实 SAPI phone ID、UPS/IPA 与 System.Speech Pronunciation 的关系，不预设 ID 就是保存的字符串；不得迁移或重写用户训练数据。
- [ ] 保留整句与拼接/部分词的置信度语义和 0.1–0.99 用户门槛、300–9000ms 时长与 5s 冷却。对比原控制方案的句级/词级分数，真实零分不能被抬高成固定猜测；缺失/非法分数不得伪装高置信度成功。

## 5. 可重复验收、文档与停止条件

- [ ] 把上轮位于 `native/wake/target/probe/table2.cjs` 的必要语料/生命周期探针整理为受跟踪的最小 fixture 或真正的 Rust 集成测试，例如 `src/main/wake-word-rust.test.ts`、`tests/yu-v2/fixtures/wake-native.cjs`。只保留必要生成脚本，不提交大批 WAV；新脚本按 allowlist 管理。纯 matcher 六个测试和仍调用 PS 的测试不能冒充真实 Rust 监听覆盖。
- [ ] 相关回归先验证修前失败、修后通过，再运行 Rust fmt/test/Clippy、`pnpm test:native`、`pnpm typecheck`、`pnpm test`、`pnpm build`。保留已有正负语料，不改阈值/预期或 skip 来掩盖回归；语言包确实缺失与功能失败分开记录。
- [ ] 做隔离 Electron 的实际宿主/子进程验证，并在合成受控输入下连续监听至少 10 分钟，在后段送入唤醒/负语料，记录线程/句柄、内存平台值、事件与结束。可生成音频流而不保存长文件；等待期间只在 DSH 本对话报告有意义进度，不要求 Codex 监听。1h/热插拔/真实讲话/UAC/RDP 未测仍保留未测。
- [ ] 正确性通过后用相同输入、识别器和采样条件重测修复后的 PS 与 Rust；启动/内存/CPU/唤醒尾延迟范围分开。现有报告的 `decision` 只按 ready/内存判断，不含功能与 CPU 退化门槛，须与真实功能验收结合，缺测 CPU 不能写成“无退化”。不重复无目标全量重建或扩大到学习/ASR等迁移。
- [ ] 新报告建议 `tests/yu-v2/evidence/rust-wake-correctness-20261103.json`，记录基线、实际文件/hash、命令/退出码、回归与限制。原 `rust-wake-listener-20261103.json` 保留，不能覆盖后声称从未有问题。
- [ ] 开始时将本文标“实施中”；结束自行追加“实际修复与验收结果”，仅勾已完成项目，同步总计划、阶段 8 归因与中英文 README 的现行行为。硬件未测、可复现 API 阻塞保留真实状态，不把所有待办机械勾选。
- [ ] 必要验证后检查 Diff，只暂存本任务文件，自动 Conventional Commit；清理本轮隔离/暂存前确认路径和进程退出，保留用户数据、模型、依赖与必要证据，报告主要新增/回收占用。不 push、不发布、不打安装器、不改个人设置或自动重启开发版。最后在现有 DSH 对话回复结果、文档路径和提交 hash，然后停止，等待用户下一轮。

## 官方依据（规划时已核对）

- [微软 SDK sapi.h](https://raw.githubusercontent.com/microsoft/win32metadata/main/generation/WinSDK/RecompiledIdlHeaders/um/sapi.h)：SPFEI_FLAGCHECK/SPFEI、事件结构及 SAPI 接口。
- [微软 System.Speech SapiInterop.cs](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Speech/src/Internal/SapiInterop/SapiInterop.cs)：SAPIGuids.SPDFID_WaveFormatEx 的准确 GUID。
- [SAPI 音频位置与时长](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ms720448(v=vs.85))：字节位置与 100ns 时长不可混用。
- [WAVEHDR 所有权与队列状态](https://github.com/MicrosoftDocs/sdk-api/blob/docs/sdk-api-src/content/mmeapi/ns-mmeapi-wavehdr.md)：只在驱动归还缓冲后回收资源。
