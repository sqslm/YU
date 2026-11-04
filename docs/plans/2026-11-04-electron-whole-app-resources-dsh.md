# 阶段 18：Electron 整应用资源基线与首项优化

**状态：DSH 已实施，`decision=adopted`。** 基线 `e44c2c7`（计划提交前）、实施基线 `0cb30d9`；工作目录 `E:/code/deepseek-harness/rea/typeless`。

**目标：** 保留 Electron 和现有功能，以完整进程树的前后对照定位常驻内存大头，并只实施一项有证据的优化。原生迁移阶段 1–17 已收束，其 helper 收益不能作为本阶段的整应用收益。

**架构与工具：** 沿用 Electron、TypeScript、现有 Windows 资源采样和测试工具。优先处理不必要的渲染器加载、窗口生命周期或主进程常驻分配；本阶段不新增 Rust action、不改数据库和用户数据格式、不搭建常驻监控服务。

## 1. 执行边界与已知事实

- 外部规划者为 Codex 线程 `01a19b72-79e7-7800-b1b5-55aaf2eeaae6`；执行会话为 `session-850bebee-f8e0-47b1-a9c3-29767a917077`。DSH 内部名为 `codex` 的子智能体只是协作者，团队消息不构成外部批准。
- 原会话第 2 轮出现重复 `step/start step=1`，已从完整备份校正后续步骤编号，并保留原压缩分帧。历史消息、工具参数和结果未删除。不要重做已验收阶段或自行改写会话日志。
- `docs/rust-refactor-plan.md` 已纠正整应用目标尚未验收。此前开发模式快照约为 Electron 262.5 MiB、热键/唤醒 11.6 MiB，仅供定位方向，不作为本轮基线或差分。
- 只实施本文范围。生产修改由测量决定；若没有可验证的改进，交付瓶颈证据和明确结论，不制造代码改动或自行降低门槛。

## 2. 先建立可复现的整应用基线

入口先读 `src/main/index.ts`、`src/main/windows.ts`、`src/main/resources.ts`、对应 renderer 页面入口及现有直接相关测试。核对 `app.getAppMetrics()` 的进程角色、窗口与 webContents 对应关系，以及 Rust/模型子进程的归属；现有资源面板未必包含全部原生子进程。

- [x] 检查 Git 状态和实际 HEAD，保留其他人的修改；记录 Electron/Node 版本、构建方式、屏幕/DPI、窗口状态与功能开关。
- [x] 使用 `pnpm build` 产出的同一构建模式，直接运行现有 Electron 与 `out/main/index.js`；基线和候选均不接 Vite HMR/DevTools。先核对 Electron 参数，再使用独立 `--user-data-dir`，不得接管或重启用户正在运行的实例。
- [x] 在 E 盘创建最小隔离测试资料，记录唤醒、热键、本地模型等开关；同场景两侧设置一致。不要复制真实聊天、音频、凭据或模型目录。若只能使用空配置，明确结论只适用于该配置，不能代表用户日常配置。
- [x] 至少覆盖：冷启动；首次打开主界面并静置；关闭主界面到托盘后空闲 60 秒；同一进程内主界面开关 10 次后再次空闲 60 秒。每个状态保留主进程、各 renderer、GPU/utility 和本项目辅助进程的独立 PID/角色与汇总。
- [x] 记录私有驻留、工作集、私有提交，三者分列；无法读取的值记不可用，不能记 0。CPU 取同一采样窗口内 user+kernel 增量，报告窗口时长与核数口径。不要把工作集之和冒充不重复的物理内存。
- [x] 首次与再次开窗分别记录延迟，给出开始/完成事件定义；至少各 20 次，标注冷启动与重复开窗的差别。内存/CPU 场景至少各 3 次独立应用启动，原始样本及有效/失败数量齐全。

复用现有计量方式；只增加本轮必要的小脚本/诊断入口。采样器本身不得计入应用树。不要长期打开资源面板、DevTools 或 Heap Snapshot 再把其成本计入常态。不得通过 `EmptyWorkingSet`、手动 trim、显式强制 GC 或关闭功能制造数字下降。

## 3. 查明归因后只改一项

- [x] 把常驻占用与实际加载的页面、窗口、模块对应起来；优先核对 `createBarWindow`、`ensureSettingsWindow`、`createCardWindow` 的创建/销毁时机以及隐藏页是否加载完整主应用。`backgroundThrottling: false` 只作为检查线索，不能未经录音/动画验证直接删掉。
- [x] 对最大且可避免的一个分配来源做一次受控对照，记录预测、实际差值和功能影响。候选可以是延迟加载未使用页面、缩小独立窗口入口或回收确已不用的对象；不提前指定某个窗口必须销毁。
- [x] 若归因成立，实施最小修改，并补充真正覆盖失效行为的回归。若没有安全且可验收的改法，保留生产代码，写明瓶颈、失败尝试与下一步所需证据。
- [x] 不更换 Electron、不关 GPU/沙箱/安全隔离、不移除热键/唤醒/托盘功能，不用清空缓存、聊天、笔记或停用本地模型换取收益；不扩展为前端整体重构。

## 4. 本轮采纳与验收

- [x] 用同一小脚本、同一隔离配置及场景重跑基线/候选；允许复用未变化的二进制，不为测量复制整份仓库或 node_modules。
- [x] 首项常驻内存优化的采纳门槛：托盘空闲场景的完整应用树私有驻留中位数同时下降 **至少 15% 且至少 30 MiB**，并且多次开关后无持续增长。另列 Electron 组与全部 helper，不能靠漏计子进程达标。
- [x] CPU 和开窗延迟如实对比；若开窗 P95 回退超过 100 ms、空闲 CPU 明显升高或任何原有功能回归，不自动采纳生产改动，报告取舍由外部规划者决定。
- [x] 验证热键、唤醒、托盘重新打开、主界面状态保持，以及本次触及的录音/卡片流程。真实音频无法安全验证的部分列未测，不冒充已覆盖。
- [x] 只运行直接相关测试和 `pnpm typecheck`；生产改动确定保留后执行一次 `pnpm test`、`pnpm build`。任何失败必须说明实际结果，不以单独复跑成功断言属于既有问题。

证据建议为 `tests/yu-v2/evidence/electron-whole-app-resources-20261104.json`（跨日用实际日期），含场景/环境、每次启动、进程归属、原始样本、可比性、归因、门槛与最终 decision。禁止收录用户正文、完整进程命令行中的凭据或其他应用的隐私信息。不要将所有场景平均成一个无法解释的百分比。

## 5. 自行收尾后一次汇报

- [x] 回填本文实际完成项、指标与测量边界，更新总计划阶段 18；README 只改确实变化的产品行为。
- [x] 内部审查在外部最终报告之前完成并收齐；停止本轮内部审查，不让迟到团队消息启动新轮次。报告后等待外部 Codex，不自行开展阶段 19。
- [x] 核对 Diff，只提交本阶段相关内容，自动 Conventional Commit；报告提交号、未测项、采纳/未采纳结论。不得 push、发布、打包安装器或重启用户应用。
- [x] 仅清理本轮自有测试进程、隔离资料和可重建的临时产物；保留必要原始样本与可复现脚本。记录本轮主要磁盘占用，不动历史缓存和会话恢复备份。

## 6. 实施结果

**状态：DSH 已实施并通过采纳门槛（`decision=adopted`）。** 环境：Electron 42.11.18、Node v24.22.2、Windows 10/11 x64、16 核。测量对象是 `pnpm build` 产物（`electron.exe out/main/index.js`，每次独立 `--user-data-dir`，不接 Vite HMR/DevTools），基线是 `0cb30d9` 的源码（`git checkout` 回工作树后重新构建，证据 `build.source` 注明），候选是本轮工作树（`23efa58` 之上，`build.candidate.entrySha256=b52966db…`，基线 `2561ea29…`）；两侧 `build.rev` 与入口哈希都记入证据，`comparable` 由「同一台机器 + 同一组场景参数 + 两侧构建不同」判定，不再硬编码。数据全部来自空配置隔离资料（未复制真实聊天、音频、凭据、模型目录），结论只代表该配置。

### 6.1 计量方式

- `scripts/benchmark-electron-app.mjs`（采样器独立进程，不在应用树内）：进程树按 `Win32_Process` 的父子链取得，角色按名字与 `--type=` 划分（main / renderer / gpu / utility / crashpad / zygote / helper / conhost）；内存用 `K32GetProcessMemoryInfo` + `PROCESS_MEMORY_COUNTERS_EX2`（私有驻留、工作集、私有提交分列，读不到写 `null` 并计入 `unavailable`，**不当 0**）；CPU 用 `GetProcessTimes` 在同一窗口首尾各取一次求 user+kernel 增量，同时报窗口毫秒与核数。
- 场景：冷启动；首次打开主界面并静置；关闭到托盘后空闲 60 s；同进程开关 20 次后再空闲 60 s；另有 Pill 生命周期场景。开窗延迟 = 启动第二个实例（真实 `second-instance` → `ensureSettingsWindow()`）到 EnumWindows 首次看到可见主窗口；关窗 = 向主窗口投 `WM_CLOSE`（与标题栏 X 等价，进程内处理器隐藏到托盘）。
- 快照按阶段分簇记录：`settled-4s`（启动后 4 s，20 个）与 `idle-60s`（真空闲，3 个）。**门槛只读 `idle-60s`**，`settled-4s` 单列，避免把「启动刚稳定」冒充「托盘空闲」。
- 空闲 CPU 与内存各 3 次独立启动；首开 21 个样本、重开 20 个样本。

### 6.2 基线与归因

基线 `idle-60s` 中位私有驻留 **101 036 032 B（96.4 MiB）**，角色分布 main 45.7 + renderer 25.7（**只有 Pill 一个**）+ utility 14.9（两个）+ gpu 8.7 + other 1.4 MiB；`settled-4s` 簇 105.3 MiB。启动即创建 Pill 渲染器（`ensureBarWindow()` 在 boot 无条件执行，`show:false` + `backgroundThrottling:false`），它同时拖着一个 spare utility 进程并抬高 main/gpu；hub 渲染器早已在隐藏 15 s 后被 `hubRetireTimer` 销毁，所以**能省的只有 Pill**。临时删掉 boot 的无条件创建做消融，上界 66.3 MiB（−37%~−39%），与最终实现吻合。

### 6.3 最小改动

- `src/main/bar-retire.ts`：`wireBarRetirement(win, {delayMs=30_000, isBusy, isCardVisible, log})`——`hide` 起表、`show`/`closed` 取消；到期且 `!isDestroyed() && !isVisible()` 时，若 `isBusy()` 或 `isCardVisible()` 为真则**重新起表**（忙碌可以在没有新 `hide` 的情况下结束），否则 `destroy()` 并记 `[bar] retiring the hidden pill window`；创建即隐藏的窗口也起表。
- `src/main/index.ts`：删除 boot 的无条件 `ensureBarWindow()`；新增 `barSink()`（`quitting` 或游戏模式返回 `null`，否则 `ensureBarWindow()`），`Pipeline` 的 bar 出口、`NoteAudioPlayer`、`createSpeechPlayback`、`controlNoteAudio` 全部改走它——原来后三者直接读裸 `barWindow`，Pill 被回收后随记播放会抛 `录音播放服务尚未就绪`、云端 TTS 报 `Speech playback is not ready`。`isBusy` 纳入 `speech.status().speaking` 与随记播放态（页面自行驱动的播放经 `note-audio:reply` 上报）。
- `src/main/note-audio.ts`：构造签名加 `onState` 回调，把页面驱动的播放状态也上报给主进程。
- `src/main/index.ts` 自检块：支持 `TYPELESS_SELFTEST_STAY` + `TYPELESS_SELFTEST_REPEAT_MS`，让无麦克风的合成 take 周期性重跑并保持进程存活，用于观察 Pill 的创建→回收→再创建。
- 测试：`bar-retire.test.ts` 7 用例（到期销毁 / show 取消 / 可见不销毁 / 忙碌或卡片占用时推迟并复检 / closed 取消 / 创建即隐藏也起表 / 忙碌结束后无需新 `hide` 也能回收）；`note-audio.test.ts` 3 用例（每次命令都向 sink 取窗口 / 回复上报状态 / sink 为 null 时抛错）。

### 6.4 前后结果（同一脚本、同一构建模式、同机）

| 指标 | 基线 `0cb30d9` | 候选（工作树） | 差 |
| --- | --- | --- | --- |
| 托盘空闲 60 s 私有驻留 p50 | 101 036 032 B（96.4 MiB） | 61 313 024 B（58.5 MiB） | **−39.7 MB / −37.9 MiB / −39.32%** |
| 其中 main / renderer / utility / gpu | 45.7 / 25.7 / 14.9 / 8.7 MiB | 42.8 / 0 / 6.8 / 7.6 MiB | renderer 归零、utility 少一个 |
| 启动后 4 s（`settled-4s`，不参与门槛） | 105.3 MiB | 67.9 MiB | −35.5% |
| 20 次开关后静止 | 104 251 392 B（99.4 MiB） | 73 150 464 B（69.8 MiB） | −30.0%，静止时 renderer 0 个 |
| 20 次开关的累积趋势（第 16–20 轮均值 vs 第 1–5 轮） | −8.82% | −10.39% | 未随开关次数增长 |
| 首次开窗 p50 / p95 | 1096.10 / 1110.80 ms | 1097.37 / 1199.75 ms | +1.3 / **+88.95 ms**（门槛 ≤ +100） |
| 重开 p50 | 1071.89 ms | 1073.54 ms | +1.7 ms |
| 空闲 CPU（62 s 窗、16 核） | 0.875 ms | 0.156 ms | 未升高 |
| Pill 生命周期（自检 3 次 take） | 无回收日志，同一 renderer `[37636]` | 回收 3 次，renderer `[41292, 50440, 55164]` | 创建→回收→再创建 |
| 生命周期 renderer（hub 场景） | startup `[48216]` 隐藏后仍在 | startup `[]` | Pill 不再常驻 |

门槛判定（全部来自证据 `thresholds`）：私有驻留 −39.32% 且 −37.9 MiB（要求 ≤ −15% 且 ≤ −30 MiB）；同实例 20 次开关无持续增长（趋势 −10.39%，且开关后静止树 69.8 MiB < 基线 99.4 MiB，静止 renderer 0 个）；开窗 P95 回退 +88.95 ms（≤ +100 ms）；Pill 创建后确实被回收并再次创建（基线侧为 0 次回收、startup renderer 仍在）→ 四项全过，`decision=adopted`。证据 `tests/yu-v2/evidence/electron-whole-app-resources-20261104.json`（version 2，含两侧每次启动、进程归属、原始样本、分簇、周期序列、构建身份、可比性、归因与门槛）。

**读数说明：**单位是二进制 MiB（1 MiB = 1 048 576 B），括号里的十进制 MB 与 MiB 不同，上一版把 73.3/70.9 的十进制 MB 写成 MiB 已在本版修正；本次开窗 p95 的上界 +100 ms 是唯一与延迟有关的门槛，实测 +88.95 ms 虽在界内但已接近，换成忙机可能翻转，见 §6.6。

### 6.5 功能与测试

- 真实链路自检（`TYPELESS_SELFTEST=1` + `scripts/mock-openai.mjs` + 独立资料 + `--background`，须 `env -u ELECTRON_RUN_AS_NODE`，否则 electron 以纯 Node 运行）：`[bar] capture input=48000Hz … capture warm` 说明 Pill 在真实录入流程中按需创建并完成采集，`[selftest] multimodal → {"status":"completed","wordCount":19}` 说明整条 take 走通并写库；`dictation/ask/ask+web → null` 属同文本去重。Pill 场景进一步证明回收后下一次 take 仍能重新创建（`[selftest] repeat →` 后仍出现 `capture warm`）。
- 未打包运行需把 `native/bin`、`resources` 放进 `out/main`（`app.getAppPath()` 指向 `out/main`），否则 helper 全 `ENOENT`、托盘图标加载失败；两侧都在补齐资产后测量，helper 计入证据，未靠漏计子进程达标。
验证（本轮最后一次全量，逐条记退出码）：`pnpm typecheck` → 0；`pnpm exec vitest run src/main/bar-retire.test.ts src/main/note-audio.test.ts src/main/pipeline.test.ts src/main/resources.test.ts` → 0（4 文件 / 165 用例）；`pnpm test` → 0（241 文件通过 / 3 跳过，3562 用例通过 / 8 跳过，97.50 s）；`pnpm build` → 0（12.48 s）。

### 6.6 未测边界

真实麦克风录音与音频设备切换、托盘菜单交互与全局热键（会与用户实例冲突）、唤醒词与本地 ASR 模型、聊天/笔记/网络等待、锁屏与远程桌面、多显示器与不同 DPI、`closeBehavior=quit`、小时级长跑的碎片与句柄增长；`backgroundThrottling:false` 能否去掉未验证；Pill 回收后第一次 reveal 的**视觉空白时长未量化**（只以整次 take 仍能完成 + 重开 p50 未退化为边界）；开窗 p95 余量只有 11 ms，忙机或冷页缓存下可能越过门槛；基线侧的 Pill「未被回收」由 `[bar]` 无回收日志 + startup renderer 存活证明，基线无法运行 `TYPELESS_SELFTEST_STAY`（该钩子是本轮新增），因此它的对比证据是生命周期场景而不是同一 3 次 take 的时间线。

### 6.7 清理与提交

`%TEMP%\yu-app-*` 隔离资料、`out/main` 下复制的资产、`/tmp/t18-*.log`、`.tmp-measure18.sh` 均按本轮自有产物清理；两侧原始样本已并入证据（`/tmp/app-baseline4.json`、`/tmp/app-candidate4.json` 为过程产物，关键数字与分簇都在证据内）。提交见本轮 feat/docs 两个提交（不 push）。`restoreRunKey` 现在会删除本轮新增的登录项，只还原用户原有的值。
