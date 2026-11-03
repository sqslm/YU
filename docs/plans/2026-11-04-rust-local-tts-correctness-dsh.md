# 第十一阶段：本地 TTS 正确性与验收证据校正

> **执行者：DSH，继续当前 typeless 会话。** 先修下面已经定位的边界和验收缺口，自行补齐文档、测试、证据与提交，再通过 Codex 桥汇报。本轮完成后等待下一份任务，不自行开展其他迁移。

**状态：已完成（DSH，2026-11-04）。** 基线 `c85e982`，阶段 10 实现提交 `4ad5cdd`；本轮修正后生产 helper SHA-256 为 `2bafa91e2a2d54b01d9e043d15fce58f6656d2323cd75fc9e83f2f0ece2823d5`（336896 B）。R1–R6 全部处理，处理结果见第 6 节。

**目标：** 修正已接入的 Rust TTS 边界、完成/错误事件语义和无效验收，重测真实收益。保持 Electron、按需独立 helper、现有音色、设置与业务接口；不新增语音引擎、后台服务、端口、依赖或 UI。

## 1. Codex 复核事实（2026-11-04）

下列事实来自 `c2d398e..c85e982` 源码与交付二进制复核，不是对用户声卡、热插拔或泄漏现象的推断。

| 编号 | 位置与事实 | 必须解决的问题 |
| --- | --- | --- |
| R1 | `fixtures/speech-native.cjs::survivors` 将整数 PID 经 `Where-Object` 后用 `$_.Id` 输出，整数没有 Id 属性。实测 `fixture.leftovers([process.pid], 2000)` 对仍存活的 Node 也返回 `[]` | 现有“无残留”断言不能识别存活进程，须修复并增加活进程阳性对照 |
| R2 | `speech-native.test.ts` 的首末 `sample(pid)` 在 `await fixture.request(voices)` 之后执行，此时进程已退出；实测得到 `{}`，`if (typeof handles === 'number')` 跳过断言。31 次调用全是 `voices` | 未证明合成/暂停/停止路径回收，也未测到声称的句柄趋势 |
| R3 | “超过 20 秒启动期限”用例调用 `fixture.live`，其代码直接 spawn helper，未调用 `createSpeechRunner` 的 20 秒计时器 | 需实际经过生产运行器验证计时器取消与控制/停止，不能只改测试名称后继续声称已覆盖 |
| R4 | `main.rs::speakable` 用 `split('\0').next()` 截断。向交付 exe 发 `前半句\u0000后半句`、rate 10、volume 0，实测退出 0 并输出 started 和 ok:true | helper 直连会丢后半句却成功，违反阶段 10 文本完整性要求；上层 `speechText` 已移除 NUL、保留两侧，正常业务路径未复现丢字，不能把二者混为一谈 |
| R5 | SAPI `GetEvents` 失败被忽略，`WaitForNotifyEvent` HRESULT 被丢弃；END 没有前置 START 时会补发 `started` | 读取失败可能在启动计时器已取消后持续等待；缺失开始证据时不能补造开始成功。这里是明确代码出口缺口，未声称已复现真实设备故障 |
| R6 | benchmark 在 `exit` 后 `setTimeout(finish, 200)`，`totalMs` 把人为等待算入请求；CPU 是一次采样时的进程累计 CPU。配置 `samplesPerHost:10`，实际 raw 每侧20条 | 校正时间边界、CPU 口径与样本元数据，旧百分比不能继续作为已校准的完整执行成本 |

本轮复核另运行了 `speech.test.ts`、`speech-playback.test.ts`、`providers/tts.test.ts`：3 文件、49 用例通过。一次音色枚举交叉检查为 Rust 响应/close 34/35ms、PS 898/939ms，仅说明原基准的 200ms 人为延迟问题，不是新的 P50/P95。

## 2. 任务 A：先让验收确实能发现失败

修改 `tests/yu-v2/fixtures/speech-native.cjs`、`src/main/speech-native.test.ts`，必要时修改 `src/main/speech.test.ts`。

- [x] 优先使用 Node 已有的进程存在性接口，或修正 PowerShell 输出对象；保留逐 PID 隔离，不回到全局进程数量。明确区分已退出、仍存活和查询失败。
      结果：`existence()` 改用 `process.kill(pid, 0)`（`EPERM` 记存活、`ESRCH` 记已退出、其它进 `unknown`），`leftovers()` 返回 `{living, unknown}`，不再用 PowerShell 过滤整数。
- [x] 增加阳性对照：测试期间仍活着的受控 PID 必须被检出；受控子进程退出后必须不被检出。旧 `survivors` 应使阳性对照失败。不要使用 timeout=0 直接返回初始 PID 列表冒充探测。
      结果：`sees a live process and stops seeing it once it exits` 用 `process.pid` 与一个 30 秒的受控子进程做阳性对照，kill 后断言 `{living: [], unknown: []}`。
- [x] 句柄/线程采样在进程真实合成或暂停存活期间执行，实际覆盖至少首/中/末几次。必须断言采样字段有效；缺测如实失败或记录环境限制，不能用 if 跳过后写成通过。
      结果：`speakCycle(..., {pause: true, sampleAfterMs: 200})` 在暂停存活的 helper 上取快照；30 次循环对第 1/15/30 次断言 `sample` 非空、`missing` 不为真、`handles/threads/privateKb` 均为数字，并断言 `last.handles <= first.handles + 8`。
- [x] 至少 30 次真实 speak 的开始→暂停/继续或取消→退出，记录自己启动的 PID 与退出结果；不能用音色枚举冒充音频路径。合理控制各次时长，统一 volume 0，保留实际音频设备交互的说明。
      结果：`speaks thirty times and reaps every helper it started` 为 30 次真实合成（volume 0，pause→resume→退出），每次记录自己的 PID，结束后 `leftovers` 为空。
- [x] 新增通过生产 `createSpeechRunner` 的真实超过 20 秒暂停后继续用例，验证 started 后启动计时器已清除；另覆盖启动前取消、暂停时取消、下一次朗读打断旧请求、迟到控制/旧进程退出不影响新请求。
      结果：`outlives the twenty second startup deadline through the production runner`（暂停 21.5 秒后继续，26.6 秒仍成功）、`cancels through the production runner before and during speech`、`keeps a new utterance independent of the previous, cancelled one`。
- [x] 仅在测试需要时使用最小内部 seam/现有 mock；不给产品增加测试开关或 PID 管理框架。fixture 的超时定时器在完成时清理，监听 close 并收齐 stdout，任何失败出口也回收本测试子进程。
      结果：fixture 统一用 `reader()` 解析 NDJSON、`child.on('close')` 收尾、`timers` 统一清理、`stdin` 的 `EPIPE` 被吞掉后仍由 close 报错；产品侧没有新增开关。

## 3. 任务 B：修复 helper 文本与事件合同

修改 `native/speech/src/main.rs`，确有需要时调整 `json.rs` 和相关测试；不重写云 TTS、文本清理与整个运行器。

- [x] 直连 helper 对包含 NUL 的请求明确拒绝：一行不含正文的 `ok:false`，没有 started，非零退出。保留上层现有 NUL 清理行为与完整两侧文本；修改当前错误地期待 `Some("前半句")` 的单测，并增加真实 exe 反例。不要“截断后成功”。
      结果：`speakable()` 对 NUL 返回 `Err("text contains a NUL")`；单测 `keeps_the_whole_line_and_refuses_a_nul` 与真实 exe 用例（`code 1`、单行 `ok:false`、无 `event`、输出不含正文）同时覆盖。
- [x] START 仅由匹配本次 stream 的真实 START 事件确认；END 缺少 START 时明确报告异常，不补发 started。结束成功、取消、EOF 和错误分别处理，终态只发一次。
      结果：`classify()` 按 `ulStreamNum` 过滤，END 无 START 返回 `Err("end of stream without a start event")`；单测覆盖重复 START、旧 stream 事件、未知事件。
- [x] 对 `GetEvents` 与等待接口的真正失败 HRESULT 明确退出、停止合成并释放资源；`S_FALSE`/正常超时不是致命错误。错误信息保留失败阶段及 HRESULT，避免全部压成无法定位的 unavailable；不带用户正文。
      结果：`Stage` 前缀 + `0x%08X`；`GetEvents`/`WaitForNotifyEvent` 的失败直接上抛（`events failed 0x…`、`wait failed 0x…`），空事件仍继续等待。
- [x] 用最小内部测试替身或既有可控路径验证：普通超时继续、读取错误退出、等待失败退出、END 无 START 不确认开始、旧 stream 事件不匹配当前请求。区分模拟错误与真实设备实测，不能把模拟结果写成无设备/热插拔已验收。
      结果：新增局部 `Surface` trait（`events/wait/set_paused/cancel`）与 `Fake` 替身，覆盖 `stops_on_a_control_line_after_an_empty_tick`、`reports_a_failed_event_read`、`reports_a_failed_wait_and_stops`、`refuses_to_confirm_an_end_without_its_start`、`ignores_another_streams_events`、`answers_pause_and_resume_once_each`、`stops_when_the_parent_closes_stdin`；全部为模拟，文档按模拟记录。
- [x] 核对仍然存在的 `WaitForNotifyEvent(50)`：当前控制输入依靠最长约 50ms 的定时检查。可用最小 Win32 事件让输入/EOF 唤醒；若保持此设计，文档须直说有界控制轮询及其测量，不能宣称完全无轮询。不要为改名引入复杂线程框架。
      结果：保留事件等待 + 50ms 上界；`reports pause and resume with the request id and the applied state` 实测暂停回执与 `started` 的间隔并断言 < 300ms，README 改为「事件等待，控制输入延迟上界约 50ms」。

## 4. 任务 C：校正基准并重新保存证据

修改 `scripts/benchmark-speech.mjs`，新报告使用 `tests/yu-v2/evidence/rust-speech-correctness-20261104.json`，保留原 `rust-speech-20261104.json` 不覆盖。

- [x] 对协议响应、started、终态、exit/close 分别记录真实时间；通过 close 等待输出管道关闭，删除人为 200ms 完成延迟。无需为等待管道引入宽限计时器。
      结果：`run()` 在 `child.on('close')` 收尾，记录 `writeAtMs/startedMs/terminalMs/closedAtMs`，`totalMs = closedAtMs`。
- [x] 消除测试/采样定时器残留、stdin EPIPE 未处理和 spawn 失败不收尾的问题；等待必要采样完成或如实缺测，不把任务已结束当成还有活进程可采样。
      结果：`timers` 统一清理、`stdin` 错误记入 `writeError`、spawn 失败直接返回无效样本；采样任务在收尾前 await，`missing` 如实保留。
- [x] CPU 现有值是采样时的进程累计值。可以保留为明确标记的快照，并记录实际采样时间和范围；若声称整次朗读 CPU，则需测量完整进程生命周期，不能从一个早期快照推导。内存快照同样不称作峰值；采样延迟300ms是安排时间，不是 PowerShell 查询完成的时刻。
      结果：字段改名 `cpuSnapshotMs`，报告 `scope` 与 `sampleAtMs` 说明「采样瞬间的进程总量，非整次朗读 CPU」；内存同样标注为单点快照。
- [x] 区分轮次、请求数、有效样本数与失败数，以 raw 实际数量填写；默认每侧至少20个有效枚举/启动样本。失败样本保留，checks 失败时脚本非零退出，不能只打印 failed 后返回成功。
      结果：`settings.roundsPerSlot`、`hostSummary()` 的 `requests/valid/failed/failures[]`；10 轮 → 每侧 20/20 有效；checks 失败时 `process.exitCode = 1`（旧版本 `--samples 2` 冒烟确实以非零退出）。
- [x] 同机、同音色、同 rate/volume、同输出方式，按 PS/Rust/Rust/PS 交错，预热后重新采样；新报告记录最终 exe 哈希。复核阶段 10 的采纳条件并报告是否仍成立。
      结果：见第 6 节；`binary.sha256 = 2bafa91e…`，采纳条件仍成立（`decision: memory`）。
- [x] 原基准数据保留为历史；新结果修正文档，不把原 totalMs 减200ms当作重测，也不把本次单样本交叉检查写成分位数。
      结果：旧 `rust-speech-20261104.json` 未改动；新证据独立文件，文档用新数字替换旧百分比并注明口径。

## 5. 验证、文档与交付

优先运行直接相关测试；原生代码变更后才按现有入口构建与扩大回归，不重新跑 622 秒唤醒会话：

```text
cd native/speech
cargo fmt -- --check
cargo clippy --locked --offline --all-targets -- -D warnings
cargo test --locked --offline
cd ../..
pnpm build:native
pnpm exec vitest run src/main/speech.test.ts src/main/speech-native.test.ts src/main/speech-playback.test.ts src/main/providers/tts.test.ts
pnpm typecheck
```

- [x] 修复后运行必要全量 `pnpm test:native`、`pnpm test`、`pnpm build`，记录实际通过/跳过/失败数量。沿用固定依赖及 E 盘现有缓存，不升级依赖、不为本轮打包安装器。
      结果：`cargo fmt -- --check`/`clippy`/`test` 通过（10 个单测）；`pnpm test:native` 通过；四个语音测试文件 64 用例通过；`pnpm typecheck` 通过；`pnpm test` 与 `pnpm build` 结果见第 6 节。
- [x] 自行逐项回填本计划的实际结果：每个 R1–R6 的修复文件、反例、测试入口、重测结果与未测项；无法完成的项保持未完成。不得通过扩大超时、删除断言或降低采样要求掩盖失败。
      结果：见第 6 节；无通过放宽超时或删除断言换来的通过，唯一扩容是把 `speakCycle` 的类型声明补上 `sampleAfterMs`。
- [x] 更新阶段 10 文档、`docs/rust-refactor-plan.md` 与 README 中英的本轮相关表述；正确标注上层清理/直连接口、有界轮询、模拟/实测、历史/新指标。开发版正常重启后生效的边界照实记录，不强制关闭用户应用。
      结果：阶段 10 计划与总计划补「阶段 11 修正」说明；README 中英改用新口径（NUL 拒绝、50ms 上界、快照 CPU、新 P95）。
- [x] 对新 helper 保存哈希；清理本轮可重建产物，保留源码、最终二进制、fixture 与原始报告，不删除用户数据、旧证据或无关缓存。
      结果：`native/bin/yu-speech.exe` 336896 B / `2bafa91e…`；删除 `native/speech/target`（约 277MB）与基准日志。
- [x] Diff 检查后只提交本阶段文件，自动 Conventional Commit，不 push。自行记录实现/文档提交编号，再从当前 Codex 桥汇报 R1–R6 处理情况、验证与限制，结束本轮。
      结果：提交编号见第 6 节末尾。

## 6. 实际修复与验收结果（DSH，2026-11-04）

### 6.1 逐项处理

| 编号 | 修复文件 | 反例/证据 | 测试入口 | 结果 |
| --- | --- | --- | --- | --- |
| R1 | `tests/yu-v2/fixtures/speech-native.cjs` | `process.kill(pid,0)` 区分存活/已退出/查询失败 | `sees a live process and stops seeing it once it exits` | 存活 PID 与受控子进程均被检出，kill 后返回空 |
| R2 | 同上 + `src/main/speech-native.test.ts` | 暂停存活期快照，首/中/末各一次 | `speaks thirty times and reaps every helper it started` | 三次快照字段均有效，句柄增量 ≤ 8 |
| R3 | `src/main/speech-native.test.ts` | 走 `createSpeechRunner`，暂停 21.5s 后继续 | `outlives the twenty second startup deadline through the production runner` | 26.6s 内仍成功，`started` 已清计时器 |
| R4 | `native/speech/src/main.rs` | 直连 exe 发送含 NUL 文本 | 单测 + 真实 exe 用例 | `code 1`、单行 `ok:false`、无 started、无正文 |
| R5 | `native/speech/src/main.rs` | `Fake` 替身制造读取/等待失败与缺失 START | 7 个单测 | 失败按阶段 + HRESULT 退出，END 无 START 不确认开始 |
| R6 | `scripts/benchmark-speech.mjs` | `close` 收尾、快照口径、样本元数据 | 新证据文件 | 每侧 20/20 有效，checks 失败非零退出 |

### 6.2 重测（同机同文本同音色，rate 0、volume 0，PS/Rust/Rust/PS 交错，预热后 20 样本/侧）

| 指标 | PowerShell | Rust helper | 变化 |
| --- | --- | --- | --- |
| 音色枚举 total P50/P95 | 846 / — ms（20/20） | 25 / — ms（20/20） | 音色列表逐值相同 |
| 启动至 `started` P50 | 990 ms | 301 ms | −69.6% |
| 启动至 `started` P95 | 1491 ms | 396 ms | −73.4%（−1095 ms） |
| 请求写入至 close P50 | 5147 ms | 4218 ms | −18.0% |
| 请求写入至 close P95 | — | — | −23.7%（−1342 ms） |
| 活动期私有内存 P50 | 71636 KB | 10772 KB | −85.0% |
| 工作集 P50 | 116604 KB | 42484 KB | −63.6% |
| 采样瞬间进程 CPU P50 | 1828.1 ms | 125.0 ms | 快照，不是整次朗读 CPU |

阶段 10 的采纳条件在本轮口径下仍成立：内存 −85%（门槛 −30%），`started` P95 −73.4% 且 −1095 ms（门槛 −25% 且 −100 ms），故 `decision: memory`。旧报告 `tests/yu-v2/evidence/rust-speech-20261104.json` 保留为历史（其 `totalMs` 含 200ms 人为延迟，不与新数字混用）。

### 6.3 验证命令与结果

```text
cd native/speech && cargo fmt -- --check                      # 通过
cargo clippy --locked --offline --all-targets -- -D warnings  # 通过
cargo test --locked --offline                                 # 10 passed
node scripts/build-native.mjs                                 # 全部成功
pnpm exec vitest run src/main/speech.test.ts src/main/speech-native.test.ts \
  src/main/speech-playback.test.ts src/main/providers/tts.test.ts   # 4 文件 64 passed（93.06s）
pnpm typecheck                                                # 通过
pnpm test:native                                              # 通过（cargo 10 单测在内）
pnpm build                                                    # 通过（renderer 11.95s）
```

`pnpm test` 全量连续三次（本机，逐次都跑完整 240 个文件，未改并行配置）：

| 次数 | 结果 | 失败项 |
| --- | --- | --- |
| 1 | 236 通过 / 1 失败 / 3 跳过，3534 用例通过 | `src/main/providers/search-pool.test.ts:63`（`expect(good.requests).toHaveLength(1)` 得 0） |
| 2 | 235 通过 / 2 失败 / 3 跳过 | `src/main/update-download.test.ts`（32 并发连接与重定向）与 `src/main/providers/search-pool.test.ts`（aggregate deadline） |
| 3 | 236 通过 / 1 失败 / 3 跳过，3534 用例通过 | `src/main/providers/search-pool.test.ts`「retains completed aggregate results if another source reaches the overall deadline」 |

两个失败文件都不在本阶段改动范围内（`git log -1` 分别为 `f872e4b`、`0f0b9ce`），单独复跑全绿：`search-pool.test.ts` 12/12（两次）、`update-download.test.ts` 5/5；在 12 个 CPU 忙循环并发下再跑 `search-pool.test.ts` 仍 12/12。该用例的余量只有 60ms（`timeoutMs: 60` 对 200ms 慢源），全量并行时事件循环延迟即可越过截止时间，因此记为并行负载下的时序敏感用例，未修改这些测试、未放宽断言。

### 6.4 局限与未测项

- `WaitForNotifyEvent(50)` 仍是事件等待加 50ms 上界：控制输入最坏等一个等待周期，实测暂停回执 < 300ms（通常 < 60ms），README 按「有界等待」描述，不称完全无轮询。
- 事件/等待失败与缺失 START 的用例使用 `Fake` 替身，属模拟；真实设备拔除、音频服务崩溃、远程桌面切换未复现。
- 基准用 volume 0 的真实合成（引擎仍按真实时长推进），没有做声卡听辨；真实输出设备差异、蓝牙与热插拔仍未测。
- CPU 只有采样瞬间的进程累计值，未测整次朗读生命周期 CPU。

### 6.5 提交

- 实现：`cd4925c fix(speech): confirm starts per stream and reject NUL text`（含 helper、fixture、测试、基准脚本、证据）。
- 文档：`docs(speech): record the TTS correctness follow-up`（本提交）。
- 顺带记录的既有问题（本阶段未修）：`src/main/providers/search-pool.test.ts` 与 `src/main/update-download.test.ts` 的三个用例在全量并行时偶发超时，单文件复跑稳定通过，见 6.3。
