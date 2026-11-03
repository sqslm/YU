# 第十二阶段：本地 TTS 生命周期观测与验收口径对齐

> **执行者：DSH，继续当前 typeless 会话。** 只推进本阶段：把朗读 CPU 从“存活瞬间快照”改为“请求写入 → stdio close 的进程累计差分”，补朗读期峰值内存，并把总计划、阶段计划、README 的未测项措辞对齐。完成后自行补齐证据与提交，再通过 Codex 桥回报。不做破坏性音频设备测试，不改偶发时序用例。

**目标：** 让 `scripts/benchmark-speech.mjs` 的 CPU 与内存指标变成可复现的生命周期口径，替换阶段 11 遗留的瞬时快照口径；PowerShell 与 Rust 两侧使用同一套测量方法，做不到同法时不出百分比。

## 1. 测量区间与实现路径

### 1.1 区间

- **CPU 区间**：`stdin` 请求写入时刻 → 子进程 stdio `close` 时刻，覆盖 helper 全部存活期（启动、SAPI 初始化、合成、END、进程退出）。
  - 起点与现有 `totalMs` 的起点相同（`writeAtMs`），终点与现有 `totalMs` 的终点相同（`closedAtMs`），因此 CPU 与耗时同区间，可直接对照。
  - 旧脚本用 `Get-Process -Id <pid> | TotalProcessorTime` 在 `started` 后约 300 ms 取一次值，那是“活着那一刻的累计 CPU”，不是整次朗读 CPU；本次删除该口径，报告里不再出现 `cpuSnapshotMs`。
- **内存区间**：同一区间内的采样峰值。
  - 私有提交内存用 job 记账的 `PeakProcessMemoryUsed`（进程级峰值，内核维护，非采样估计）。
  - 工作集用 100 ms 间隔的 `GetProcessMemoryInfo` 采样取最大值，字段名与注释都写“按 100 ms 间隔采样的峰值”，不称真峰值。
  - 句柄与线程为 100 ms / 500 ms 间隔采样的最大值，同样按采样口径标注。

### 1.2 路径选型：P2（job 计账）

两条候选路径：

- **P1 helper 自报**：Rust 侧 `GetProcessTimes(GetCurrentProcess())` 在 END 前输出，PS 侧脚本退出前自报 `TotalProcessorTime`。代价是两条实现路径（Rust 与 PowerShell 各写一次），且 END → close 的尾部（毫秒级）不计入。
- **P2 job 计账**：Node 侧为每个子进程建 job 对象、`AssignProcessToJobObject`，close 后用 `QueryInformationJobObject` 读 `TotalUserTime` / `TotalKernelTime` 与 `PeakProcessMemoryUsed`。

选 **P2**，理由：

1. 两侧共用同一段测量代码，方法天然一致，`comparable` 可以直接为 `true`，不需要为“PS 用 A 法、Rust 用 B 法”出具不可比声明。
2. 区间覆盖到进程退出（job 记账由内核在子进程结束时累加），不丢 END → close 尾部。
3. 不改 helper 生产协议：`yu-speech.exe` 与 `resources/speech.ps1` 一行不动，所以本轮 helper 字节数与 SHA-256 保持不变（336896 B / `2bafa91e…`）。
4. `koffi` 已在 `package.json` 依赖内（Electron 主进程用它加载 `yu-capture.dll`），基准脚本直接复用，不新增依赖。

实现细节与约束：

- `CreateJobObjectW` 建匿名 job；`OpenProcess(PROCESS_SET_QUOTA|PROCESS_TERMINATE|PROCESS_QUERY_INFORMATION|PROCESS_VM_READ)` 拿句柄后 `AssignProcessToJobObject`。Node 自身若已在 job 中，Windows 8+ 支持嵌套 job，不影响。
- close 后 job 记账要等内核把终止计数记满，因此做最多 300 ms 的**记账收敛轮询**（`TotalTerminatedProcesses < TotalProcesses` 时重查）。该轮询发生在 close 之后，不进入 `totalMs`，也不改变任何耗时字段。
- 采样器在 100 ms 定时器上跑，只调两个内核查询（`GetProcessMemoryInfo`、`GetProcessHandleCount`），每 5 个 tick 再用 toolhelp 快照数一次线程；采样任务在收尾前 await，失败/缺失如实记录，不用 `if` 跳过后写成通过。
- 若 job 分配失败（例如极短请求的进程已退出），该样本标记 `invalidReason`，不写入 CPU 字段；checks 会因有效样本不足而非零退出，而不是给一个假数字。

## 2. 任务清单

- [x] A1 删除 `probe()` 的瞬时 CPU 快照口径，改为 P2 job 记账的 `cpuUserMs` / `cpuKernelMs` / `cpuTotalMs`，并记录 `cpuWindowEnd`。
- [x] A2 增加 100 ms 采样峰值 `peakWorkingSetKb`、job 峰值 `peakPrivateKb`、`memorySampleCount`、`handlesMax`、`threadsMax`。
- [x] A3 两侧同口径：`comparison` 每项带 `comparable` 与 `reason`；`comparable: false` 时百分比必须为 `null`。
- [x] B1 `checks[]` 结构化（name / pass / detail），硬检查含每侧 ≥20 有效样本、每样本 `cpuTotalMs > 0`、峰值字段非空、`comparable` 为真时必须给出百分比；任一 fail → 非零退出。
- [x] B2 证据改落 `tests/yu-v2/evidence/rust-speech-lifecycle-20261104.json`，旧 `rust-speech-correctness-20261104.json` / `rust-speech-20261104.json` 原样保留。
- [x] C1 `docs/plans/2026-11-04-rust-local-tts-correctness-dsh.md` 6.4 节补齐“无音频输出设备时的失败表现、默认音频设备切换”，与总计划同措辞。
- [x] C2 `docs/rust-refactor-plan.md:304` 把“CPU 只有采样瞬间快照”改为已测口径并指向新证据。
- [x] C3 `README.md:296` 末句改新口径 + 与总计划一致的未测项措辞；`README.en.md` 同步。
- [x] C4 阶段表第 12 行回填结果与提交编号。

## 3. 验证

```text
cd native/speech && cargo fmt -- --check
cargo clippy --locked --offline --all-targets -- -D warnings
cargo test --locked --offline
cd ../.. && node scripts/benchmark-speech.mjs --samples 20
pnpm exec vitest run src/main/speech.test.ts src/main/speech-native.test.ts \
  src/main/speech-playback.test.ts src/main/providers/tts.test.ts
pnpm typecheck
pnpm test:native
pnpm build
pnpm test
```

helper 未改动，二进制字节数与 SHA-256 应保持 336896 B / `2bafa91e2a2d54b01d9e043d15fce58f6656d2323cd75fc9e83f2f0ece2823d5`；若 `build-native` 结果与之不同，按实际值回填并说明原因。

## 4. 证据字段

路径 `tests/yu-v2/evidence/rust-speech-lifecycle-20261104.json`：

- `meta`：`generatedAt`、`host{os,cpuModel,cores}`、`node`、`samples`、`text`、`voice`、`rate`、`volume`、`interleave`、`measurement{method:"P2", cpuWindow:"stdin write→close", memoryIntervalMs, notes}`。
- `runs[]`：`side`、`round`、`ok`、`invalidReason`、`requestWriteAt`、`startedAt`、`endAt`、`closeAt`、`totalMs`、`cpuUserMs`、`cpuKernelMs`、`cpuTotalMs`、`cpuWindowEnd`、`peakWorkingSetKb`、`peakPrivateKb`、`memorySampleCount`、`handlesMax`、`threadsMax`。
- `aggregate`：每侧有效/无效样本数与 `totalMs`、`startedMs`、`cpuTotalMs`、`peakWorkingSetKb`、`peakPrivateKb` 的 P50/P95。
- `comparison`：每指标 `{p50, p95, p50Pct, p95Pct, comparable, reason}`。
- `checks[]` 与 `decision`（沿用阶段 10 的 memory/startup 判据，不新增凑结论的阈值）。

## 5. 结果

A1–A3、B1–B2、C1–C3 全部落地，C4 见下方提交编号。

**实现（只改 `scripts/benchmark-speech.mjs`，helper、TS 协议与测试文件一行未动）**

- 删除 `probe()` 的 PowerShell 瞬时快照（旧 `cpuSnapshotMs` 不再出现）：每个子进程用 `CreateJobObjectW` + `AssignProcessToJobObject` 建匿名 job，`close` 之后用 `QueryInformationJobObject` 读 `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION`（class 1，`TotalUserTime`/`TotalKernelTime`）与 `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`（class 9，`PeakProcessMemoryUsed`）。窗口起点沿用 `writeAtMs`、终点沿用 `closedAtMs`，CPU 与 `totalMs` 同区间。
- 记账在 close 后按 15×20ms 轮询收敛（判据是 `TotalUserTime+TotalKernelTime > 0`；`TotalTerminatedProcesses` 在本机实测始终为 0，不能当收敛条件），该轮询在窗口外，不进入 `totalMs`。
- 内存/句柄/线程：`setInterval(100ms)` + 启动时立即采样一次（`<100ms` 的 voices 进程也有峰值），每 tick 取 `GetProcessMemoryInfo` 与 `GetProcessHandleCount`，每 5 tick 用 `CreateToolhelp32Snapshot(4,0)` 数线程。`peakPrivateKb` 是内核峰值（非采样估计），`peakWorkingSetKb` 明确写成“100ms 采样的最大值”。
- `record()` 逐样本写出 `cpuWindowStart:'stdin write'`、`cpuWindowEnd:'stdio close'`、`cpuUserMs`/`cpuKernelMs`/`cpuTotalMs`、`peakPrivateKb`/`peakPrivateSampleKb`/`peakWorkingSetKb`/`memorySampleCount`/`handlesMax`/`threadsMax`/`jobAssigned`/`jobSettled`；`comparison` 每项带 `baselineP50/baselineP95/p50/p95/p50Pct/p95Pct/p95Delta/comparable/reason`，`comparable:false` 时百分比一律 `null`。
- `checks[]` 结构化 12 项（两处 fixed 前提 + 80 条样本全覆盖 + 每侧 4 项硬检查 + 百分比只在可比时出现），任一 fail 即 `process.exitCode = 1`。
- 证据结构按 §4：`meta{generatedAt,host,node,samples,text,voice,rate,volume,interleave,measurement{...}}`、`aggregate{powershell,native}`（含 `n`/`valid`/`invalid` 与五项指标 P50/P95）、`runs[]`（80 条逐样本记录，`side` 区分两侧）、`comparison`、`checks`、`decision`；另保留 `platform`/`binary`/`scope`/`settings`/`voices` 便于复核。旧 `rust-speech-correctness-20261104.json`、`rust-speech-20261104.json` 未动。

**测量结果（`node scripts/benchmark-speech.mjs --samples 20`，每侧 40 个有效样本，80/80 全部有效，12 项 checks 全 PASS）**

| 指标 | PS P50 | Rust P50 | P50 差 | P95 差 |
| --- | --- | --- | --- | --- |
| 音色枚举 `totalMs` | 852ms | 26ms | — | — |
| `startedMs` | 891ms | 291ms | −67.3% | −66.0%（−622ms） |
| 整次朗读 `cpuTotalMs` | 1703.1ms | 125.0ms | −92.7% | −85.2% |
| `peakPrivateKb` | 75.4MB | 10.5MB | −86.0% | −86.0% |
| `peakWorkingSetKb` | 113.8MB | 41.5MB | −63.5% | −63.6% |
| `totalMs` | 5010ms | 4209ms | −16.0% | −15.6% |

`decision` 仍为 `memory`（私有内存 P50 −86.0% ≤ −30%，`started` P95 −66.0% 且 −622ms ≤ −25%/−100ms），判据沿用阶段 10/11，未新增凑结论的阈值。

同一脚本连续三次 20 轮实跑，口径稳定：`started` P50 差 −66.8%～−67.3%、P95 差 −64.9%～−66.0%，CPU P50 差 −91.9%～−92.7%，私有内存 −86.0%～−86.1%，工作集 −63.5%；绝对值的抖动集中在 CPU（PS 1703～1750ms、Rust 125～141ms），说明该指标应按百分比读，不按单次毫秒读。`yu-speech.exe` 未重建，仍 336896 B / `2bafa91e2a2d54b01d9e043d15fce58f6656d2323cd75fc9e83f2f0ece2823d5`。

**文档对齐（C1–C3）**

- `docs/plans/2026-11-04-rust-local-tts-correctness-dsh.md` 6.4 节：未测项补“无音频输出设备时的失败表现、默认音频设备切换”，CPU 口径改为阶段 12 生命周期口径并指向新证据。
- `docs/rust-refactor-plan.md` 阶段 11 后的未测项：把“CPU 只有采样瞬间快照”改为已按阶段 12 口径实测，并给出证据路径；阶段 11 的历史数字与结论未改。
- `README.md:296` / `README.en.md:267`：换成 40 样本新口径（枚举 852 → 26ms、`started` P50 891 → 291ms / P95 943 → 321ms、整次朗读 CPU 1703 → 125ms、私有峰值 75.4 → 10.5MB、工作集峰值 113.8 → 41.5MB、`total` P50 5010 → 4209ms），未测项措辞与总计划一致。

**验证命令与退出码（一次连续执行，日志 `/tmp/verify12.log`）**

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `cargo fmt -- --check` | 0 | 无差异 |
| `cargo clippy --locked --offline --all-targets -- -D warnings` | 0 | 无告警 |
| `cargo test --locked --offline` | 0 | `yu_speech` 10 passed |
| `node scripts/benchmark-speech.mjs --samples 20` | 0 | 80/80 有效、12 checks PASS、`decision=memory` |
| `pnpm exec vitest run src/main/speech.test.ts src/main/speech-native.test.ts src/main/speech-playback.test.ts src/main/providers/tts.test.ts` | 0 | 4 文件 64 用例通过 |
| `pnpm typecheck` | 0 | `tsc --noEmit` 两套配置均通过 |
| `pnpm test:native` | 0 | 39 passed（8/4/4/0/13/10） |
| `pnpm build` | 0 | `✓ built in 14.54s` |
| `pnpm test` | 0 | 237 文件通过 / 3 跳过，3535 用例通过 / 8 跳过 |

`pnpm test` 全量本轮一次通过：阶段 11 记录的 `search-pool.test.ts`、`update-download.test.ts` 并行超时未复现，两个文件一行未改、断言未放宽。

**未测项（阶段 12 后）**

真实声卡听辨与响度、蓝牙/热插拔、远程桌面与锁屏、无音频输出设备时的失败表现、默认音频设备切换、音频服务崩溃；事件读取/等待失败与缺失 START 的用例仍是替身模拟，未在真实故障设备上复现；job 记账在极短进程（voices，约 26ms）上可能读到 0 CPU，基准确认只在 speak 样本上强校验 `cpuTotalMs > 0` 并如实记录该限制。云 TTS 与浏览器播放路径未改。

**提交**：实现 `9c07ce7`（`scripts/benchmark-speech.mjs` + 证据 JSON）；文档回写见同一阶段的文档提交（本文件、总计划表行与未测项、阶段 11 计划 6.4 节、README 双语）。均未 push。
