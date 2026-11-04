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

**状态：DSH 已实施并通过采纳门槛（`decision=adopted`）。** 环境：Electron 42.11.18、Node v24.22.2、Windows 10/11 x64、16 核、1920×1080 / 32 bpp；`pnpm build` 产物直接以 `node_modules/electron/dist/electron.exe out/main/index.js` 启动，每次运行使用独立 `--user-data-dir`，不接 Vite HMR/DevTools。所有数据来自空配置隔离资料（未复制真实聊天、音频、凭据、模型目录），因此结论只代表该配置。

### 6.1 计量方式

- 新增 `scripts/benchmark-electron-app.mjs`（采样器独立进程，不在应用树内）：进程树由 `Win32_Process` 的父子链取得，角色按名字与 `--type=` 划分（main / renderer / gpu / utility / crashpad / zygote / helper / conhost）；内存用 `K32GetProcessMemoryInfo` + `PROCESS_MEMORY_COUNTERS_EX2`（私有驻留、工作集、私有提交三项分列，读不到记 `null` 并计入 `unavailable`）；CPU 用 `GetProcessTimes` 在同一窗口首尾各取一次求 user+kernel 增量，同时报窗口毫秒与核数。
- 场景：冷启动、首次打开主界面、关闭到托盘后空闲 60 s、同进程开关 20 次后再空闲 60 s，另有 Pill 窗口生命周期（startup / hub-open / 隐藏后空闲三点的 renderer PID）。开窗延迟定义 = 启动第二个实例（走真实 `second-instance` → `ensureSettingsWindow()`）到 EnumWindows 首次看到可见的主窗口；关窗 = 对主窗口投 `WM_CLOSE`（与标题栏 X 等价，进程内 `close` 处理器隐藏到托盘）。
- 记忆/CPU 场景各 3 次独立启动（托盘空闲 24 个快照参与中位数），首开与重开各 21 / 20 个样本。

### 6.2 基线与归因

基线（`0cb30d9`）：托盘空闲整树私有驻留 **105.0 MiB**（110 116 864 B，24 快照中位数），Electron 组 92.1 + helper 0.6 + conhost 0.8 MiB；其中 main 56.5、renderer 23.0（**只有 Pill 一个**）、utility 15.0（两个）、gpu 8.8。启动即创建 Pill 渲染器（`ensureBarWindow()` 在 boot 无条件执行，`show:false` + `backgroundThrottling:false`），它同时拖着一个 spare utility 进程并抬高 main/gpu。hub 渲染器则早已在隐藏 15 s 后被 `hubRetireTimer` 销毁，因此**能省的只有 Pill**——把 boot 的无条件创建临时删掉做消融上界，得到 66.3 MiB（−37%~−39%），与最终实现的 67.7 MiB 吻合。

### 6.3 最小改动

- `src/main/bar-retire.ts`：`wireBarRetirement(win, {delayMs=30_000, isBusy, isCardVisible, log})` —— `hide` 时起表、`show`/`closed` 取消，到期且 `!isDestroyed() && !isVisible() && !isBusy() && !isCardVisible()` 时 `destroy()`；**创建即隐藏的窗口也起表**（Pill 会为麦克风列表请求被创建却从不 show）。
- `src/main/index.ts`：删除 boot 的无条件 `ensureBarWindow()`；`ensureBarWindow()` 末尾接线；`Pipeline` 的 bar 出口从 `() => barWindow` 改为 `() => ensureBarWindow()`——退休后复查必须能重新拿到窗口。其余按需入口（game-mode 退出、`media:devices`、诊断截图）原样保留。
- `src/main/bar-retire.test.ts`：6 个用例覆盖「到期销毁 / 期间 show 取消 / 可见不销毁 / 录音或卡片占用时跳过 / closed 取消 / 创建即隐藏也起表」。

### 6.4 前后结果（同一脚本、同一构建模式、同机）

| 指标 | 基线 | 候选 | 差 |
| --- | --- | --- | --- |
| 托盘空闲私有驻留 p50 | 105.0 MiB | 67.7 MiB | **−37.4 MiB / −35.58%** |
| 其中 Electron 组 | 92.1 MiB | 56.4 MiB | −35.7 MiB |
| 其中 helper / conhost | 0.6 / 0.8 MiB | 0.6 / 0.8 MiB | 不变 |
| 开机 renderer 数 | 1（Pill） | 0 | Pill 不再常驻 |
| 20 次开关后 vs 空闲 | — | +3.31%（73.3 vs 70.9 MiB） | 未持续增长 |
| 首次开窗 p50 / p95 | 1111.92 / 1305.35 ms | 1116.48 / 1335.13 ms | +4.6 / **+29.78 ms**（门槛 ≤ +100） |
| 重开 p50 | 1100.51 ms | 1101.31 ms | +0.8 ms |
| 空闲 CPU（62 s 窗、16 核） | 0.673 ms | 0 ms | 未升高 |
| 生命周期 renderer | startup `[33620]` 隐藏后仍在 | startup `[]`，hub 隐藏后也消失 | Pill 已回收 |

门槛判定：私有驻留 −35.58% 且 −37.4 MiB（要求 ≤ −15% 且 ≤ −30 MiB）、多次开关无持续增长（≤ 5%）、开窗 P95 回退 +29.78 ms（≤ +100 ms）、Pill 已回收，四项全部通过 → `decision=adopted`。证据 `tests/yu-v2/evidence/electron-whole-app-resources-20261104.json`（含两侧每次启动、进程归属、原始样本、可比性说明、归因与门槛）。

### 6.5 功能与测试

- 真实链路自检（`TYPELESS_SELFTEST=1` + `scripts/mock-openai.mjs`、独立资料、`--background`）：`[bar] capture input=48000Hz … capture warm` 说明 Pill 渲染器在真实录入流程中按需创建并完成音频采集；`[selftest] multimodal → {status:"completed", wordCount:19}` 说明整条 take 走通并写入历史。`dictation/ask/ask+web` 返回 `null` 属同文本去重。
- 未打包运行需把 `native/bin`、`resources` 放进 `out/main`（`app.getAppPath()` 在未打包时指向 `out/main`），否则 helper 全部 `ENOENT`、托盘图标加载失败；两侧都在补齐资产后测量，helper 计入证据，未靠漏计子进程达标。
- `pnpm typecheck` 0；`pnpm exec vitest run src/main/bar-retire.test.ts src/main/pipeline.test.ts src/main/resources.test.ts` 3 文件 161 用例通过；`pnpm test`、`pnpm build` 在本轮末尾各跑一次（结果见提交说明）。

### 6.6 未测边界

真实麦克风录音与音频设备切换、托盘菜单交互与全局热键（会与用户正在运行的实例冲突）、唤醒词与本地 ASR 模型、聊天/笔记/网络等待、锁屏与远程桌面、多显示器与不同 DPI、`closeBehavior=quit` 配置、长时间（小时级）运行后的碎片与句柄增长；`backgroundThrottling:false` 是否可去掉未验证（Pill 只在录音期可见，未获得可安全对照的动画证据）；Pill 被回收后第一次 take 需要重建窗口与渲染器，本轮只验证整条 take 仍能完成，**没有单独量化这次重建对「开始录音」延迟的影响**。

### 6.7 清理与提交

临时资料目录（`%TEMP%\yu-app-*`）、`out/main` 下复制的资产、`/tmp/t18-*.log` 均按本轮自有产物处理；两侧原始样本已并入证据。提交见本轮 feat/docs 两个提交（不 push）。
