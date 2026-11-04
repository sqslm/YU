# 阶段 19：窗口回收正确性与整应用计量修复

**状态：已完成。** 项目绝对路径：`E:/code/deepseek-harness/rea/typeless`。交接代码 HEAD 为 `e37c51f506f9ab747d58ffa2b0106234311ec099`；本规划提交只添加本文并修改总计划，不包含交接前已有的四项 WIP。执行结果见 §4。

**目标：** 保留 Electron 和阶段 18 的按需 Pill/空闲回收方向，修复冷启动播放、播放占用状态与验收计量缺陷，取得能够支撑采纳结论的功能和整应用证据。阶段 1–17 的 Rust 迁移已收束，本轮不新增迁移项目、不寻找第二项性能优化。

**架构与工具：** 沿用 Electron/TypeScript、现有 `bar:ready`、IPC 信任校验、播放器和 Windows 资源计量。以真实渲染器事件确认就绪及播放状态，不用固定睡眠、猜测播放已结束或扩大超时掩盖问题。不新增依赖、端口、常驻监控或数据库迁移。

## 0. 交接、工作区与验收状态

- 外部规划者：Codex 线程 `01a19b72-79e7-7800-b1b5-55aaf2eeaae6`。本轮唯一执行会话：`session-8ddbf6a1-325f-4999-a162-a3aa0e3f7dcd`。旧 DSH 会话已停止，不恢复其团队或继续给旧内部审查者派任务。
- 这次是用户点击“开始执行”后的首份正式指令，不是新会话已经完成开发。先读本文、总计划、阶段 18 结果和实际调用代码，再实施。不要重做已经完成的 Rust 阶段。
- 四项交接 WIP 保留并先审查：`src/main/index.ts`、`docs/plans/2026-11-04-electron-whole-app-resources-dsh.md`、未跟踪的 `src/main/note-audio-busy.ts`、`src/main/note-audio-busy.test.ts`。它们抽出播放忙态跟踪器、保留暂停和未知时长的占用；不是本轮已通过验证的交付。不要 reset、覆盖或混入其他人的改动；需要调整时沿现有工作继续。
- 阶段 18 的空配置托盘内存初测为 96.4→58.5 MiB，但外部复核发现以下缺口，其“已完成/采纳”尚不能视为完整关单。保留原证据 `tests/yu-v2/evidence/electron-whole-app-resources-20261104.json`，不覆盖历史数字。

## 1. 已确认问题与最小复现

### R0：基准的用户环境隔离不完整（先处理，再运行基准）

`scripts/benchmark-electron-app.mjs` 的 `readRunKey()` 会列举名称含 `typeless|electron` 的启动项，以 `split('=').slice(0,2)` 解析；`restoreRunKey()` 将本次前后新增的匹配项都当成自有项删除，并复写原匹配项。因此另一个 Electron 程序在采样期间新增启动项，也会被误删；原值包含等号时还会被截断后写回。

外部复核通过执行这两个生产函数、替换 `spawnSync` 为记录命令的替身确认：`OtherElectronApp=C:/fake.exe --flag=a=b` 被读成 `C:/fake.exe --flag`，且会产生删除 `OtherElectronApp` 的命令。没有写真实注册表。

- [x] 先消除这种按名称/前后差集推定所有权的恢复逻辑。首选让自有测试进程在两侧相同的诊断启动封装下不调用 `app.setLoginItemSettings`；保留正常产品行为，并记录封装及其哈希。仅设置独立 `--user-data-dir` 不足以隔离该系统级设置。
- [x] 不批量备份/恢复用户的 Run 键，不删除其他程序项，不用“名称含 electron”判定本轮所有权。若确实需要解析注册表结果，使用结构化结果或只在第一个等号切分，保留完整类型和值；本轮不要用真实用户项做破坏性故障注入。
- [x] 以替身覆盖：其他匹配名的项、值含多个 `=`、测试期间用户自行改变原值。验收是没有针对这些非自有数据的写入/删除命令，失败收尾同样如此。隔离做不到时先报告，不继续跑会污染环境的全量基准。

### R1：新建或回收后重建 Pill，首条播放命令会丢失

当前 `NoteAudioPlayer.control()` 和 `createSpeechPlayback()` 在取得 `barSink()` 新建的窗口后立刻 `webContents.send()`。真实播放监听器要等 `src/renderer/src/bar/Bar.tsx` 的 React effect 注册；`bar:ready` 目前只重放 pipeline 状态与设备请求，不重放播放命令。

外部隔离复现使用真实构建的 `bar.html`、preload、`NoteAudioPlayer` 和 IPC 信任校验，并拒绝麦克风权限：创建并加载窗口后立即 `control('status')` → **“录音播放没有响应”**；同一窗口发出 `bar:ready` 后再次查询 → `idle`。诊断脚本及结果保留在 `E:/code/deepseek-harness/work/stage18-review-20261104/real-bar-probe.ts`、`real-bar-probe.cjs`、`real-bar-result.json`，仅作已有复现参考；不要未经检查执行会写出文件的旧探针。简单 DOMContentLoaded 替身页面反而通过，所以不能只用该替身宣称真实页面已就绪。

- [x] 在实际使用播放服务前等待同一个窗口的真实 `bar:ready`，再发送当前仍有效的命令。复用一个必要的就绪机制，不为每条命令添加固定 sleep 或单独轮询。`did-finish-load`、DOMContentLoaded、BrowserWindow 对象存在均不等于 React 播放监听器已安装。
- [x] 同步审查随记播放和云 TTS 的实际入口；新的窗口消费者不能继续假定 Pill 永远存活。只读状态、回执校验与“确保创建窗口”应区分，不能为了验证迟到/伪造回执而新建窗口。
- [x] 保持合理的现有启动/响应预算，处理等待期间取消、加载失败、窗口销毁/崩溃、旧窗口迟到 ready、旧请求被新播放替代；失败必须清理监听器、定时器和 pending，请求取消后不得迟到起播。不要扩大 8 s/20 s 预算来过测试。
- [x] 添加有真实失效信号的回归：冷创建、回收后再创建、已就绪三类窗口；至少有真实构建的 bar/preload 冷路径用例。若无窗口时 `status` 合理返回 idle 而不创建，也必须另外验证真正的冷启动 play 路径，不能只靠 status 快捷返回绕开丢命令问题。

### R2：播放占用状态仍以推算时长释放，不能证明不会截断或永久常驻

已有 WIP 对暂停及未知时长选择保留 Pill，方向应保留；但已知时长仍以“剩余时长 / 速率 + 1.5 s”清除忙态。缓冲等待、实际播放进度与结束事件可能与墙钟不同。现有 renderer 播放器主要回复控制命令，不能假设已有连续状态或自然结束上报。

- [x] 检查 `src/renderer/src/bar/noteAudio.ts`、`Bar.tsx`、`src/main/note-audio.ts`、WIP 跟踪器及 `wireBarRetirement()`。用当前播放 owner 的真实结束/错误/停止和必要的媒体状态变化释放占用，不仅靠估算时长就认定结束。
- [x] 播放、缓冲及需要继续播放的暂停态不能在 30 s 回收下被截断；暂停后恢复必须保留同一录音、位置和速率。明确停止/结束、owner 销毁和退出时要释放忙态及 pending，不能由新窗口或其他请求的迟到回复覆盖当前 owner。
- [x] 不把可恢复暂停自动变成停止来节省内存；如果仍需任何到期机制，应有可验证的实际进度依据，不能靠到期猜测已停止。不要为此建立通用播放器框架。
- [x] 覆盖播放超过回收期限、暂停再恢复、seek/rate、时长初始未知、自然 ended、错误和连续两次播放的旧事件。以自有合成资料/受控媒体替身验证；真实设备覆盖不足要列未测，不读取用户真实笔记或音频。

### R3：CPU 量纲与开窗延迟的计量不可用于当前采纳判定

外部执行现有 `readCpuMs()`、将 `GetProcessTimes` 替为确定的 FILETIME 输入后确认：user=10,000,000 个 100 ns tick，即 1000 ms，函数却返回 `userMs=1`。代码先除 10,000 得到毫秒，又除 1000，实际秒数被标成毫秒。

此外，`firstOpenLoop()` 的计时区间内，`waitForHub()` 每次先同步启动 PowerShell/WMI 列进程，再 EnumWindows，约 1 s 的查询开销混入开窗延迟。`coldRun().startupMs` 则包含固定等待 5 s、进程树/内存查询，还被加入 `firstOpen` 的 20 次开窗样本，形成 n=21 的混合口径。

- [x] 修正 FILETIME→ms，仅做一次正确换算并保留适当精度。用已知 tick 值以及实际受控 CPU 任务对照验证单位；报告窗口时长与核数，不能只把旧 JSON 数字乘 1000 就宣称重测完成。
- [x] CPU 必须说明对新生/退出进程的覆盖。优先复用已有 Windows job 记账方法；如果仅统计前后共同存活 PID，应标明局限并将缺失项列出，不得标为完整进程树或按 0 处理。
- [x] 把 PowerShell/WMI 枚举移出延迟轮询的计时区间。可预先取得自有主进程 PID，再用薄的原生窗口查询观察；为计时源、开始/结束事件和采样分辨率留证据。
- [x] 冷进程启动、冷 Pill ready/首次必要状态可呈现、首次打开主界面、再次打开主界面分开记录。不要把固定 sleep、内存采样完成或 `bar:ready` 分别冒充启动完成、开窗完成或视觉空白为零。
- [x] 每类开窗至少 20 个有效样本，失败/超时单列并计入有效性判断，不挑掉最慢值过门槛；冷启动样本不混入开窗分位数。`compare-app-resources.mjs` 根据这些真实口径更新，必要条件缺失时拒绝自动 adopted。

## 2. 重新验证与采纳

- [x] 检查实际 HEAD 和四项 WIP，先完成 R0 隔离及失效回归，再实施 R1/R2，最后修正计量并重测。每项写清复现前后结果。
- [x] 对照仍采用阶段 18 前的 `0cb30d9` 与最终候选，构建方式、功能开关、测试封装、屏幕条件和原生资产相同。基线源码必须在隔离且最小的构建目录取得，不使用 `git checkout <baseline> -- src/...` 覆盖当前工作区；复用依赖，不复制整份 node_modules/模型/用户资料。记录真实 source ref、工作树状态、入口与诊断封装哈希，不把共同的当前 HEAD 当成两侧源码身份。
- [x] 保留托盘空闲 60 s、主界面显示、重复开关后空闲的完整进程树内存分组。两侧至少各 3 次独立启动；实际包括 Electron 与所有自有 helper，读不到不能按 0。停止采样器/诊断开销进入应用树，区分私有驻留、提交和工作集。
- [x] 沿用既定门槛：完整树托盘空闲私有驻留中位数下降至少 15% 且至少 30 MiB；20 次开关无持续增长；修正后的开窗 P95 回退不超过 100 ms，CPU 无明显升高；加上 R1/R2 功能验收。缺任何一项就不自动宣称整体采纳。未达标时保留证据、明确失败指标，等待外部规划者决定，不降低门槛。
- [x] 新证据使用 `tests/yu-v2/evidence/electron-resource-correctness-20261104.json`（跨日用实际日期），至少包含各 R 项结果、构建身份、原始样本、过程覆盖/失败、条件一致性和最终判定。原阶段 18 证据原样保留，不覆盖；不存用户正文、凭据、真实录音或其他程序启动项的值。

## 3. 验证命令与自行收尾

- [x] 先执行直接相关的 `bar-retire`、`note-audio`、`note-audio-busy`、`speech-playback`、`pipeline`、`resources` 及新增回归测试；WIP 测试的计时器、dispose 和真实接线都要验证。纯函数测试不能代替真实渲染器冷路径。
- [x] `pnpm typecheck`；生产改动稳定后最终连续执行一次 `pnpm test`、`pnpm build`，再针对最后产物重跑必要真实验证及修正后的基准。未改 Rust 不为本轮额外全量重建 Rust crate。记录实际命令、退出码、样本和时间；偶发失败保留原结果，不因单独复跑通过就认定既有问题。
- [x] 回填本文所有实际已实现项与 §4 结果，更新总计划阶段 18/19、阶段 18 的相关过期结论；README 只同步现行行为和有效指标。说明已提交与 WIP 的最终归属，不将未测项勾为通过。
- [x] 只提交本阶段相关内容，自动 Conventional Commit，报告所有实际提交号。不要 push、打包安装器、发布、重启用户正在使用的应用、修改 DSH 插件或旧会话日志。
- [x] 清理本轮自有进程/窗口/合成资料/可重建中间产物，先确认归属与进程退出；不动会话恢复备份、历史证据或用途不明的缓存。记录保留内容及磁盘占用。
- [x] 如需内部审查，仅使用当前新执行会话自己的协作者，最终外部汇报前收齐并结束本轮审查。`Team message from codex`、`subagent-settled` 只算内部资料，不能批准阶段 20。完成后只汇报一次，等待当前外部 Codex 核对，不自行开下一阶段。

## 4. 实施结果

### 4.1 环境与判定

- 主机：Windows 10.0.26300 / AMD Ryzen 7 9700X（16 逻辑核）/ 31.8 GB；Electron 42.11.18；Node v24.22.2。
- 基线：`0cb30d9ffbeca305700a697f8da96b866d5de6b9`，`git archive` 取到 `E:/code/deepseek-harness/work/t19-baseline-0cb30d9`（`node_modules` 为 junction，不复制依赖），`electron-vite build` 退出码 0，`out/main/index.js` sha256 `5d5fecb1…`、`out/preload/index.js` `b96ab145…`、`out/renderer/bar.html` `97e28cde…`。
- 候选：HEAD `c8a6a5a` + 本轮改动（工作树 dirty），`out/main/index.js` sha256 `07d2fcdf…`、`out/preload/index.js` `1179fc92…`、`out/renderer/bar.html` `d126110c…`。
- 两侧诊断封装同为 `out/main/diagnostic-entry.cjs`，sha256 `dfcbfc3a…`，基准脚本 sha256 `5645f616…`；原生资产（`native/bin/*`）逐文件哈希一致；`resources/` 有 3 个文件随源码版本不同（`windows-tools.ps1`、`speech.ps1`、`brand/PHILOSOPHY.zh-CN.md`），已在证据 `meta.build.assets` 与本节记录。
- 判定：`decision=adopted`，九道门全部 `met`（详见 §4.5）。

### 4.2 R0：基准环境隔离（先做）

- 改动：新增 `scripts/lib/run-key.mjs`（`GetValueNames()/GetValue()/GetValueKind()` 结构化读取 → `ConvertTo-Json -Compress` 解析，`diffRunKeys` 只比较；模块内不存在任何写/删命令）、`scripts/lib/diagnostic-entry.mjs`（生成 `out/main/diagnostic-entry.cjs`：先 `Object.defineProperty(app,'setLoginItemSettings',{value(){console.log('[diag] suppressed login-item write')}})`，再 `require('./index.js')`，两侧同一哈希，幂等）、`scripts/lib/playback.mjs`；`benchmark-electron-app.mjs` 的 `readRunKey/restoreRunKey` 整体删除，改为“记录前后 Run 键 + 统计抑制标记”，任何差异进入 `isolation.valid=false` 并使比较侧 `isolation` 不通过。
- 失效回归（替身覆盖，不碰真实用户项）：`scripts/lib/run-key.test.mjs` 13 用例，含“其他匹配名在本轮新增”“值含多个 `=`”“采样期间用户改原值”“读取失败”；断言全程不出现 `Remove-Item|New-ItemProperty|Set-ItemProperty|Rename-ItemProperty|reg add|delete`。
- 修复前后：旧实现会把 `OtherElectronApp=C:/fake.exe --flag=a=b` 读成 `C:/fake.exe --flag` 并生成删除命令；现在 Run 键只读。本轮两次全量运行 `HKCU:\...\Run` 8 项前后完全一致（`diff {added:[],removed:[],changed:[]}`），抑制标记各 27 条（每次启动 1 条 + 第二实例/重启启动），`isolation.valid=true`。真实风险顺带消除：产品在 boot 无条件调用 `setLoginItemSettings({openAtLogin:settings.launchAtStartup})`，`launchAtStartup=false` 时会**删除**同名启动项，隔离前跑基准可能改掉用户自己的 `typeless-rebuild` 项。

### 4.3 R1：等真实 `bar:ready` 再发播放命令

- 根因复核：缺陷在 main 侧——窗口对象存在 ≠ 渲染器已订阅。用 HEAD 原 `note-audio.ts` + 同一启动配方重跑，旧构建与重建后的 `out/` 都得到 `cold: 录音播放没有响应 (8006 ms / 8009 ms)`，`warm ok`，与外部 `real-bar-result.json` 一致。
- 改动：新增 `src/main/bar-ready.ts`（按 `webContents.id` 记录就绪，`markReady`/`wait`/`forget`；`closed`、`render-process-gone`、`did-fail-load` 使等待失败；`cancel()` 拒绝 `Playback window closed`）；`src/main/index.ts` 分出 `barPeek()`（不建窗）与 `barEnsure()`（建窗 + 等同一窗口就绪），`bar:ready` 处理器先 `markReady` 再做原有重放；`NoteAudioPlayer(host)` 与 `createSpeechPlayback(host)` 改吃 `{peek, ensure}`，`play/resume/seek/rate` 走 `ensure`，`status/pause/stop` 走 `peek` 且无窗口直接返回 idle；`note-audio:reply`、speech 回执的 owner 校验改用 `peek`，迟到回复不再新建窗口；8 s / 20 s 预算未放大，改为覆盖“建窗 + 就绪 + 回执”全流程。
- 真实冷路径回归：新增 `src/main/bar-playback.probe.ts` + `bar-playback.probe.test.ts`，用真实构建的 `bar.html`/preload/IPC 信任校验启动 Electron，10/10 用例通过（最终产物上复跑仍 10/10）：冷 `play` `state=playing created=1` 266 ms、自然 ended、已就绪窗口 play、暂停→恢复（285→289 ms，rate 1）、seek 1000 ms + rate 1.5、销毁后重建（第 2 窗 playing）、3 s 片段暂停 5 s 仍 busy、`durationMs=0` 3 s 仍 busy、旧 `requestId` 迟到 ended 被丢弃、无窗口 `status` 返回 idle 且不建窗。

### 4.4 R2：忙态跟随真实播放事件

- 改动：渲染器 `createNoteAudioPlayer(audio,{report})` 增加常驻 `playing/pause/ended/error` 监听并携 `requestId` 上报；`play()` 与 `error` 事件和 5 s 载入超时竞速，载入失败立即上报 `error` 而不是永久 busy；`stop` 先上报 idle 再递增序号。主进程新增 `note-audio:event` 订阅，`NoteAudioPlayer.acceptEvent` 只接受当前 owner 的 `requestId`。WIP `src/main/note-audio-busy.ts` 保留并重写（50→34 行）：**删除全部定时到期逻辑**，busy = `playing|paused`，`ended/error/stop/idle` 释放；窗口 `closed`/`render-process-gone` 与退出时 `reset + dispose`。`wireBarRetirement` 的 `isBusy` 直接读该跟踪器。
- 覆盖：`note-audio-busy.test.ts` 5 用例（含 `vi.getTimerCount()===0` 证明无定时器）、`note-audio.test.ts` 9 用例、`noteAudio.test.ts` 7 用例，加上探针里的长暂停、未知时长、迟到事件、连续两次播放。
- 已知行为：窗口存在但尚未 ready 时 `pause`/`stop` 仍会等满 8 s（本轮未改，属既有语义，已记入未测项）。

### 4.5 R3：计量修正与重测

- FILETIME→ms：新增 `scripts/lib/cpu.mjs` 的 `cpuMsFromTicks`，只做一次 `ticks/10_000`；单测 `10_000_000n → 1000 ms`、`123_456n → 12.3456`、`1n → 0.0001`。受控忙等对照：基线 968.75 ms / 1008.831 ms（ratio 0.96）、候选 1000 ms / 1003.543 ms（ratio 0.996），单位正确。
- 计时区净化：`scripts/lib/process-table.mjs` 用 `CreateToolhelp32Snapshot` 原生表取代 PowerShell/WMI，`waitForHub` 20 ms 轮询只做 EnumWindows；本轮 WMI 调用 143/140 次全部发生在计时区外（`powerShellInsideWindows:false`），hub 轮询分辨率约 30 ms（原生快照 ~9 ms + 20 ms 睡眠），证据 `meta.measurement.timing` 记录。副作用可量化：旧口径首开 p50 ≈1096 ms 中有约 500 ms 是每次轮询的 WMI 开销，修正后两侧 p50 都回到 ≈600 ms。
- 指标分离：冷启动 = 进程树就绪（`spawnToTreeReadyMs`）与 Pill ready（`spawnToPillReadyMs`，候选不建 Pill 时给 `pillReason`）分开；首开与重开各自 20 个有效样本，冷样本 `coldIncluded:false`；失败/无效样本进入 `failed[]` 并使 `openLatency` 不通过；启动有效性以 `[app] ready` 与无 `[app] bootstrap failed` 判定，无效样本不进中位数。
- 重测（同一脚本、同一封装、同一原生资产，先基线后候选，串行）：

| 指标 | 基线 `0cb30d9` | 候选 HEAD+WIP |
| --- | --- | --- |
| 托盘空闲 60 s 私有驻留 p50 | 94,232,576 B (89.9 MiB) | 59,600,896 B (56.8 MiB)，−36.75% / −33.0 MiB |
| 同簇角色 (MiB) | main 42.3 / renderer 22.7 / utility 14.8(2) / gpu 8.7 / other 1.4 | main 41.3 / renderer 0 / utility 6.7(1) / gpu 7.5 / other 1.4 |
| 启动后 4 s 簇 p50 | 108,011,520 B (103.0 MiB) | 67,407,872 B (64.3 MiB) |
| 20 次开关：趋势 / 开关后静止 | −10.42% / 102,445,056 B (97.7 MiB)，仍留 1 个 Pill renderer (25.0 MiB) | −14.21% / 69,591,040 B (66.4 MiB)，renderer 0 |
| 首开延迟 p50 / p95（n=20，失败 0） | 601.208 / 638.689 ms | 600.259 / 624.981 ms（p95 −13.708 ms） |
| 重开延迟 p50 / p95（n=20，失败 0，未设门槛） | 267.494 / 316.262 ms | 313.041 / 352.456 ms（+36.2 ms，仍在 +100 ms 同口径内） |
| 冷启动：树就绪 / Pill ready | 868.524 / 575.562 ms（7 进程，含 Pill） | 700.581 / 不创建（5 进程，无 Pill，`pillReason` 记录） |
| 冷启动 4 s 后树 | 108,810,240 B (103.8 MiB) | 67,858,432 B (64.7 MiB) |
| 空闲 CPU（60 s 窗） | 1812.5 ms → 30.2 ms/s | 203.125 ms → 3.385 ms/s（ratio 0.112） |
| Pill 场景（130 s，3 次 take） | 0 次回收，同一 renderer | 3 次回收，3 个不同 renderer，3 次 take 成功 |

- 与阶段 18 数字的关系：阶段 18 的 96.4→58.5 MiB 与本轮 89.9→56.8 MiB **不可直接对比**——本轮换了进程表来源、去掉了计时区里的 WMI、统一了 4 s 沉降与 60 s 空闲口径，两侧都在本轮重测。阶段 18 的 96.4 MiB 基线比本轮高 6.5 MiB 的原因未追查（视为跨轮不可比，不是回归）。

### 4.6 采纳判定

九道门全部通过（证据 `tests/yu-v2/evidence/electron-resource-correctness-20261104.json`，`decision=adopted`，`comparable=true`）：`memory`（−36.75% / −33.0 MiB，3+3 样本，unavailable 0）、`noSustainedGrowth`（趋势 −14.21%，开关后静止 66.4 MiB）、`openLatency`（p95 −13.708 ms，20+20 样本、0 失败）、`isolation`、`cpuSelfCheck`、`coldSeparation`、`idleCpu`（0.112×）、`playbackFeature`（探针 10/10）、`pillRetired`（3 次回收 + 3 次重建）。任一门缺数据或冗余字段不全时 `compare` 拒绝自动 adopted。

### 4.7 原 WIP 归属

- `src/main/note-audio-busy.ts` / `.test.ts`：保留并重写，删除推算到期的定时器，接口改为 `track/isBusy/reset/dispose`，测试改为“无定时器 + 状态映射 + reset”；已随本轮提交。
- `src/main/index.ts`：`trackNoteAudioPlayback` 抽到上述模块后继续演化，`barSink` 拆成 `barPeek/barEnsure`，新增 `note-audio:event` 订阅与 `forgetBarPlayback`；已随本轮提交。
- `docs/plans/2026-11-04-electron-whole-app-resources-dsh.md`：保留原文并在 §6 追加阶段 19 的复核修订说明（审计发现 R0/R1/R2/R3 四项缺口，阶段 18 的“采纳”以本轮为准）。

### 4.8 未测边界

- 播放接线只在隔离的真实窗口里验证，未在真实应用里走完 `index.ts` 全链路（随记播放、云 TTS 的实际点击路径）；真实渲染器崩溃只以 `destroy()` 替身覆盖；`wireBarRetirement` 与忙态的交互只经 Pill 自检场景间接覆盖；录音中暂停随记播放、语音播放渲染器探针、迟到 speech 回执未单独验证。
- 真实设备路径未测：真实麦克风录音与设备切换、托盘菜单与全局热键、唤醒词与本地 ASR、锁屏/RDP、多显示器与混合 DPI、`closeBehavior=quit`、小时级碎片与句柄增长；长录音/音乐（本轮只用 450 ms、3 s 合成音与未知时长替身）。
- 计量口径残留：CPU 是 250 ms 采样的进程树，首个采样点之前的突发与采样之间退出的进程不计入（`coverage.limitation` 已记录）；hub 轮询分辨率约 30 ms，低于该值的差异不可分辨；`spawnToPillReadyMs` 只在打 `[bar] capture warm` 的侧可用。
- 跨轮数字不可比：阶段 18 的内存/延迟/CPU 与本轮不同口径，不得混用。

### 4.9 清理与保留

- 删除：`work/t19-override`（包装实验）、`work/t19-probe/prefix`（修复前对照构建，结论已记入 §4.3）、`work/t19-baseline-0cb30d9`（42 MB，可由 `git archive 0cb30d9` + `electron-vite build` + 资源复制复现）。
- 保留：`work/t19-run/{baseline,candidate}.json` 与 `run.log`（原始样本）、`work/t19-probe/{result,prefix-result}.json`（探针证据）、`work/t19-baseline-0cb30d9.run{1,2}.log`（启动失败/成功对照）。
- 仓库内新增证据 `tests/yu-v2/evidence/electron-resource-correctness-20261104.json`（71,562 B），阶段 18 证据原样保留。
- 实际执行：已删除上述三项，另清理探针留下的三个 `profile-*` 用户目录（各约 1.8 MB）；`work/` 由 147 MB 降至 100 MB，本轮回收约 47 MB。删除前确认无残留 `electron.exe`、无运行中的基准子进程（`tasklist` 计数为 0），临时 `--user-data-dir` 均由脚本在 `finally` 中清除。保留 `work/t19-run/`（344 KB：两份 JSON、`run.log`、`run-benchmark.sh`、基线启动两次的日志）与 `work/t19-probe/`（33 KB：`result.json`、`prefix-result.json`、`probe.cjs`）。`out/` 保留重建产物与复制的 `resources`/`native/bin`（未打包运行的必需资产，不入库）。未动旧会话日志、历史证据与用途不明的缓存。
