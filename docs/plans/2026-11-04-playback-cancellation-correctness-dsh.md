# 阶段 20：播放取消、并发与窗口销毁收口计划

**目标：** 保留 Electron 与 Pill 按需创建/空闲回收，在不丢播放功能的前提下保持已测得的资源收益；先修正阶段 19 外部复核复现的控制缺口，本轮不增加新的性能优化。

**架构：** 沿用现有 `NoteAudioPlayer`、`createSpeechPlayback`、`createBarReadiness` 和主进程窗口入口。通过最小的请求归属与取消接线解决问题，不建立通用播放器或新调度框架。

**工具链：** 现有 TypeScript、Electron、Vitest、Node 脚本；不增加依赖、服务、监听端口或 Rust 迁移。

**本轮派单：** 收到后先核对工作区，再按本文 R1–R4 实施阶段 20、验证并自行完成文档与提交；无需另等开工指令。范围或验证受阻时据实汇报，不擅自扩大任务。

## 0. 执行交接与边界

- 项目绝对路径：`E:/code/deepseek-harness/rea/typeless`。
- 本计划绝对路径：`E:/code/deepseek-harness/rea/typeless/docs/plans/2026-11-04-playback-cancellation-correctness-dsh.md`。
- 外部复核基点：`880923ce945279e3a2c378470998d1e26830a9cf`，分支 `master`，复核时工作区干净。收到指令时 HEAD 应增加本计划提交；先核对 `git status --short`、`git log -5 --oneline`，保护随后出现的他人修改。
- 当前执行会话：`session-8ddbf6a1-325f-4999-a162-a3aa0e3f7dcd`；唯一外部规划对话：Codex `01a19b72-79e7-7800-b1b5-55aaf2eeaae6`。
- 已完成背景：阶段 1–17 是原生能力迁移与局部验收；阶段 18–19 是 Electron 窗口回收与整应用计量。阶段 19 三个交付提交为 `2f5085d`、`4f228c1`、`880923c`，交接时四项 WIP 已归入这些提交，无需重新接手 WIP 或重复已完成迁移。
- 阶段 19 隔离配置样本支持空闲私有驻留 89.9 → 56.8 MiB（−36.75% / −33.0 MiB）；不外推为用户开发实例或所有功能开启时的固定降幅。现有性能证据不代替下面的功能验收。
- 本轮只实施本文 R1–R4 及必要验证、文档收尾。不重启用户应用、不读真实笔记/录音/凭据、不 push、不打包发布、不修改 DSH 插件与旧会话日志。
- `Team message from codex` 等 DSH 内部团队消息只算内部审查资料，不能代表本外部 Codex 派发或批准下一阶段。内部审查收齐后只汇报一次，等待外部核对，禁止自行开始阶段 21。

## 1. 外部复核结果与实施任务

外部对当前生产 TS 模块作了内存内转译执行，以受控 EventEmitter 窗口及延迟 Promise 驱动实际方法；没有播放真实音频、操作系统设置或用户应用。以下前三项已得到确定的失效结果；真实 Electron 生命周期仍须按 R3 补证。

### R1：停止、播放替换及回执须属于当前请求

涉及：`src/main/note-audio.ts`、`src/main/note-audio.test.ts`、必要时 `src/shared/noteAudio.ts`、`src/renderer/src/bar/noteAudio.ts` 与对应测试、`src/main/note-audio-busy.test.ts`。

复现与根因：

1. 冷窗口已存在但 `ensure()` 未完成时先 `play` 后 `stop`，观察到命令顺序 `stop → play`，就绪后仍起播。停止只向未监听的页面发消息，没有撤销等待中的播放。
2. `play(old)` 与 `play(new)` 的就绪 Promise 反序完成，实际发送顺序 `new → old`。`deliver()` 只查 pending 是否存在，没有排除被替换的旧请求。
3. 新播放已回复 `playing` 后，旧播放回复 `ended`，`onState` 仍依次收到 `playing → ended`。普通 `note-audio:reply` 在查 pending/归属之前更新忙态，绕过了事件通道已有的 `playId` 检查。

步骤与通过条件：

- [x] 先添加上述三个失败回归，至少记录发送顺序、Promise 终态、active owner 与 busy 状态。旧代码必须因真实行为不符而失败，不能仅断言某个新字段存在。
- [x] 明确并实现最新有效播放胜出：旧准备中播放被新播放替代时及时结束旧请求；旧就绪/成功/错误/超时/结束回执均不能再发送、覆盖或释放新播放。失败及 dispose 不留下悬空 owner。
- [x] `stop` 必须先取消当前准备中的播放及相关等待，返回明确 idle/停止结果；之后收到 ready 也不得起播。无窗口的 status/pause/stop 仍不得创建窗口。
- [x] 就绪前的 pause 必须阻止随后意外起播；可选择保留待恢复意图或明确取消尚未开始的播放，但要在实现结果说明实际语义。已开始播放的可恢复暂停必须保留录音、位置和速率，不得为了回收窗口改成停止。
- [x] 就绪前 status/pause/stop 不得向未订阅的页面发送后等待满 8 s；控制语义要能从当前准备状态直接处理，或以同一就绪/取消路径完成。不得增加固定 sleep、轮询或扩大 8 s/20 s 预算。
- [x] 回执须先验证窗口与请求/播放归属，再改变忙态。旧的、未知的、超时后的同窗口 reply 均不能改变当前 owner；合法 pause/resume/seek/rate/status 的回执保持可用。现有“未知 requestId 也更新状态”的测试应纠正为拒绝该错误行为，页面驱动状态沿用受归属校验的事件通道。
- [x] 覆盖 old/new 同序及反序就绪、stop-before-ready、pause-before-ready、超时后 ready、旧 reply/error/ended、重复 stop/dispose；所有 Promise 最终成功或明确取消/失败，无未处理拒绝与残留定时器。

### R2：就绪等待清理与崩溃后重建

涉及：`src/main/bar-ready.ts`、`src/main/bar-ready.test.ts`、`src/main/index.ts` 的 `barEnsure` / `forgetBarPlayback` / `ensureBarWindow`、`src/main/speech-playback.ts` 及对应测试。

确定失效：窗口销毁后 `webContents` getter 抛错，`forget()` 虽已缓存 id，`waiter.detach()` 仍再次读取 `gate.webContents`。按生产顺序先注册 closed→forget、后注册 waiter 再销毁，得到清理异常，等待 Promise 仍 pending。主进程 `barEnsure()` 另丢弃了 `wait().cancel`；命令超时/取消只移除 player pending，并未撤销底层等待。现有 render-process-gone 清理也没有使仍存在的崩溃窗口退出复用路径。

- [x] 先以销毁后 getter 抛错的窗口替身固定失效，覆盖多个 waiter、生产 closed→forget 顺序、重复 forget/cancel。清理不得再访问已销毁窗口 getter，每个 waiter 必须确定结算且监听器归零。
- [x] 把命令取消、替换、超时、dispose 接到真实就绪等待；可调整既有窄接口接收取消信号/返回取消句柄。一个调用取消不能撤销其他有效调用，取消后不遗留监听器或不可达 Promise。不要只在发送前再加一个 pending 判断。
- [x] `did-fail-load` 只处理主框架，但子框架失败不能消耗唯一监听，导致随后主框架失败无人处理；增加先子框架再主框架的回归。
- [x] 渲染器崩溃后，不复用永远无法 ready 的旧窗口。下一次有效播放可在现有预算内取得新的可用窗口；旧窗口迟到 ready/closed/gone 不能清理新窗口的新 owner。退出时不再创建窗口。
- [x] 复用现有窗口生命周期组织方式，以窗口身份限定清理，不扩展为全局窗口管理框架。验证取消前后 pending、waiter/listener、busy 均回到合理基线。

### R3：真实窗口负向路径与云语音播放补证

涉及：`src/main/bar-playback.probe.test.ts`、现有探针源码、`src/main/speech-playback.test.ts`、必要的现有主进程接线。先确认探针实际导入的生产模块，不复制一份播放器逻辑来证明自身。

- [x] 继续用真实构建的 bar 页面、preload 和 IPC 信任校验，隔离 userData、拒绝麦克风权限，以本轮合成的短媒体验证，不使用用户资料或远程付费服务。
- [x] 在真实窗口中覆盖冷创建、回收后重建、ready 窗口；新增 stop-before-ready 和连续播放替换/旧回执反例，证明最终实际播放 owner 正确，而不只检查 send 调用次数。
- [x] 加入 `createSpeechPlayback` 的真实 renderer 路径：冷创建播放、就绪前 abort、开始后 abort、旧 speech 回执到达后新播放仍有效。合成媒体经现有生产入口投递，模型和网络合成可受控替换。
- [x] 至少真实销毁等待中的窗口一次；在隔离探针里对自有 renderer 用 Electron 正规崩溃入口验证 render-process-gone、pending 失败及随后重建，禁止终止用户进程。若环境阻止真实崩溃，保留失败证据并明确未测，不能用 destroy 冒充崩溃。
- [x] 测试必须复用生产主进程的就绪/窗口归属/取消接线，或另加直接针对该接线的测试；孤立自定义 host 全通过不能自动证明 `index.ts` 接线也正确。避免仅为探针大范围拆分主进程。
- [x] 保持暂停超过回收期限、未知时长、seek/rate、自然结束与旧窗口迟到事件的覆盖；语音和随记均不因新窗口冷启动而丢首条有效命令。

### R4：播放验收门槛拒绝空证据

涉及：`scripts/lib/playback.mjs`、`scripts/lib/playback.test.mjs`、必要时 `scripts/compare-app-resources.mjs` 与现有探针结果输出。

已执行生产函数复现：`loadPlaybackEvidence(...{pass:true,cases:[]})` 得 `caseCount=0`，随后 `playbackGate(null, evidence).met === true`。这不否定阶段 19 实际存在的十条记录，但表明缺失功能证据也能被自动采纳。

- [x] 对空 cases、缺 cases、必要场景缺失、任一失败/跳过、仅顶层 pass=true 的输入拒绝通过。使用一份小而明确的必要场景清单，不能仅靠任意非空数组过关，不建立通用验证协议。
- [x] 当前阶段的必要场景至少包含 R1 停止与替换、R2 销毁/取消、R3 随记和 speech 冷路径；区分自动测试替身与真实窗口结果。缺少真实崩溃时记录待验收，不能宣称已测。
- [x] 记录产生探针结果的源码身份、最终构建入口/页面/preload 哈希及具体命令，避免只凭历史 pass=true 文件证明新产物。固定输出文件与比较入口做最小校验即可，不增加签名/服务。
- [x] 保留阶段 18/19 的证据原样。本轮新证据用 `tests/yu-v2/evidence/electron-playback-correctness-20261104.json`，跨日按实际日期；逐项记录结果、失败原因、产物身份和未测项。

## 2. 验证与资源收益复查

- [x] 顺序推进 R1 → R2 → R3 → R4，先记录失败回归再修代码；一组通过后继续下一组，不反复跑全部基准替代排障。
- [x] 在项目根目录运行 `pnpm exec vitest run src/main/note-audio.test.ts src/main/note-audio-busy.test.ts src/main/bar-ready.test.ts src/main/bar-retire.test.ts src/main/speech-playback.test.ts src/main/bar-playback.probe.test.ts scripts/lib/playback.test.mjs`；按实际配置确保 Node 脚本测试和真实窗口探针确实执行，不把未发现/跳过当通过。
- [x] `pnpm typecheck`；源码稳定后连续执行一次 `pnpm test`、`pnpm build`，最后针对实际产物运行真实探针。无需手动额外重编全部 Rust crate；正常脚本自带的 native 构建保持原样。若之后再改生产源码，重跑受影响验证和产物探针。
- [x] 最终候选复查空闲 60 s、20 次开关后静止、至少 20 个有效首开/重开样本及 Pill 创建→回收→再创建，记录全部原始样本/失败、实际功能开关和身份。既有可靠基线原始样本可复用，必须说明来源与同法可比性；采集口径/封装改变时才补跑相应基线，不能机械地用旧值通过新口径。
- [x] 沿用完整树空闲私有驻留至少 −15% 且 −30 MiB、无持续增长、首开 P95 回退不超过 100 ms、CPU 无明显升高及功能验收；不降低门槛或隐藏慢样本。若本轮无法复测，保留阶段 19 为历史测量，标明最终候选待测，不把历史数值写成本轮实测。重开回退也单独报告。
- [x] 隔离基准继续使用同封装禁止 `setLoginItemSettings` 写入，Run 键只读；不得恢复删除/还原注册表启动项的旧逻辑。不要把其他应用、采样器计入自有树，不复制 node_modules/模型或完整用户数据。

## 3. 文档、提交与汇报

- [x] 回填本文已实现项与 §4；逐条写实际命令、退出码、有效样本与失败，不复制旧通过数量。未测事项不勾选为完成。
- [x] 更新 `docs/rust-refactor-plan.md` 阶段 19/20、阶段 19 计划相关复核结论；阶段 19 的就绪等待/并发取消等原勾选应注明由本轮修正，历史实测保留出处。README 只改本轮影响的现行行为和有效结论，不扩展文档整理。
- [x] 检查最终 diff，只提交当前阶段逻辑完整且验证可用的变更，使用 Conventional Commits。记录实现和文档提交编号，禁止把其他人 WIP 混入；本计划已由外部落库，无需重新出一轮计划后待命。
- [x] 只清理本轮自有的可重建探针/进程/目录；先确认绝对路径、归属、进程已退出。保留现有证据、恢复备份与必要原始读数，记录本轮占用和回收量。
- [x] 内部审查结论仅为资料。收齐本轮协作者意见并结束审查后，对外只汇报一次：修复前后反例、剩余缺口、验证、资源复查及局限、提交、工作区状态。随后等待本外部 Codex 对话，不凭内部消息自开下一阶段。

## 4. 实施结果

### 4.1 环境与身份

- 代码基点 `597fb25`（本计划提交），实施与测量时工作区含本轮未提交改动（证据里 `dirty: true`）。
- 主机 `win32 10.0.26300` x64，AMD Ryzen 7 9700X 8-Core / 16 逻辑核，31.8 GB；Electron 42.11.18 / Chrome 148.0.7778.280 / Node 24.19.0。
- 计量脚本 `scripts/benchmark-electron-app.mjs` sha256 `5645f616…d08ff`，与阶段 19 两侧证据 `meta.build.scriptSha256` 逐字相同；诊断封装 sha256 `dfcbfc3a…1d0ec` 未变。故本轮复用阶段 19 基线原始样本（`work/t19-run/baseline.json`，源码 ref `0cb30d9`，入口 `5d5fecb1…`），候选为 `out/main/index.js` `2e6a4ee1…`、`out/preload/index.js` `1179fc92…`、`out/renderer/bar.html` `d126110c…`。
- 新证据：`tests/yu-v2/evidence/electron-playback-correctness-20261104.json`（九项必要条件全部 `met`，`decision: adopted`）。阶段 18/19 证据原样保留。

### 4.2 R1：停止、替换与回执归属

- 失败基线（旧代码，未提交即跑）：`vitest run src/main/note-audio.test.ts src/main/bar-ready.test.ts src/main/speech-playback.test.ts` → EXIT=1，3 文件 9 例失败 / 21 通过，实际断言为：`Playback window closed` 由 `detach` 抛出 `Object has been destroyed`；`expected +0 to be 1`（子框架 `did-fail-load` 吃掉唯一监听）；stop-before-ready 超时 5 s；发送顺序 `['note-2','note-1']`（应为 `['note-2']`）；忙态序列 `['playing','ended']`（应为 `['playing']`）；`expected vi.fn() to not be called at all, but actually been called 1 times`（就绪前 pause 仍发送指令）；取消等待超时；`expected 2 to be +0`（stop 后残留定时器）；`expected undefined to be an instance of AbortSignal`。
- 修复：`src/main/note-audio.ts` 重写为 221 行。每个 `Pending` 带 `gen`（每次 `play` 自增）与 `sent`；`play` 先 `cancelPlays('Playback superseded')` 再自增 `playId/gen`；`stop` 取消全部未结算 play 并清 `playId`；`pause` 只取消尚未发送的 play；每条命令独占一个 `AbortController` 和唯一一个 8 s 定时器，`finish` 里清定时器、删 pending、abort 就绪等待；`deliver` 发送前复查 pending；`window()` 要求 `peek()` 且 `!isDestroyed()` 且（若提供）`host.ready(win)`；`replyWindow()` 用 `peek()`、否则用最后真正发送过的窗口；`receive()` 依次校验窗口归属 → pending → `pending.gen >= this.gen` 才更新忙态。
- 语义决策：就绪前 `pause`/`stop` **明确取消**尚未发送的播放并返回 idle（而不是保留待恢复意图）；无就绪窗口的 `status`/`pause`/`stop` 立即返回、不发送、不创建窗口、零定时器；`status` 是只读的（见 4.8 的复审修正）。
- 复审补强：Lead 复核发现「无就绪窗口」分支把 `status` 也当成取消信号，冷启动中的播放会被一次状态查询静默取消。已收敛为仅 `pause`/`stop` 取消，并新增回归 `does not cancel a play that is still starting when status is queried`：把条件改回旧写法时该例失败（`Playback cancelled`），恢复后通过。

### 4.3 R2：就绪等待清理与崩溃后重建

- `src/main/bar-ready.ts`：`wait()` 在注册时缓存 `const contents = gate.webContents`，`detach` 不再重读 getter（窗口销毁后 getter 抛错曾让清理中断、等待永远 pending）；`did-fail-load` 改用 `on` 监听并忽略 `args[4] === false` 的子框架失败；新增 `isReady(win)`。
- 新增 `src/main/bar-playback-host.ts`（单一窗口入口 `peek/ready/ensure(signal)`）：`ensure` 尊重 `blocked()`（退出/游戏模式），每次调用一个 `AbortSignal`，取消只撤该调用的等待，`finally` 移除监听，只对非主动取消记日志。`index.ts` 用它构造 `barHost`，保留 `barPeek()/barReady()/barEnsure(signal)` 薄包装，随记与 speech 共用同一接线（不再各自复制一份）。
- `index.ts` 窗口身份收口：`closed` 只处理仍是 `barWindow` 的窗口；`render-process-gone` 校验身份后清 `moveTimer`、置 `barWindow=null`、`forgetBarPlayback(win)` 并 `win.destroy()`，使下一次播放拿到新窗口，而不是复用永远无法 ready 的坏窗口。
- `src/main/speech-playback.ts`：每次播放一个 `AbortController`，`finish` 时 abort，接进 `host.ensure(gate.signal)`；20 s 预算不变。

### 4.4 R3：真实窗口负向路径与云语音补证

`src/main/bar-playback.probe.ts` 重写为 747 行、15 例，全部在真实 Electron 窗口 + 真实 `out/renderer/bar.html` + `out/preload/index.js` 上运行，0 拷贝生产接线（直接 import `createBarPlaybackHost`、`createBarReadiness`、`NoteAudioPlayer`、`createSpeechPlayback`、`createNoteAudioBusy`、`trustWindow/subscribe`），独立 userData，权限处理器全部拒绝（含麦克风），媒体为本轮合成的 WAV（0.45 s / 1.6 s / 3 s / 60 s 且长度不可知）。最后一次运行 15/15 通过、无一跳过，`totalMs 13068`：

| 用例 | 实测 |
| --- | --- |
| `r3-note-cold-path` | 冷创建 window #1，真实 `playing` 0 ms/450 ms，status `playing` position 9 ms，busy true |
| `natural-end` | 真实 `ended` 450/450 ms，busy 释放 |
| `ready-window-play` | 已就绪窗口复用（windows=1） |
| `pause-resume` | paused 283 ms → resumed 284 ms，rate 1 |
| `seek-and-rate` | seek 1000 ms、rate 1.5，seek 后 rate 仍 1.5 |
| `r1-playback-replacement` | owner `586eb862`(long) → `4a4cf0be`(hold)；对旧 id 伪造 `ended`+`error` 被丢弃，busy 保持、activePlayId 仍是新 |
| `r1-stop-before-ready` | 冷窗 play 后立即 stop：play 以 `Playback cancelled` 于 1 ms 内结束，页面只收到 `[status]`、从未收到 `play`，放行就绪后 idle/id null/busy false |
| `r2-destroy-or-cancel` | 真实 `win.destroy()` 销毁等待中的窗口：在途 play 以 `Playback closed` 于 1 ms 内失败（不是 8 s 的 `录音播放没有响应`），busy/playId 清空，随后重建 window #4 真播放 |
| `r3-speech-cold-path` | ① 冷创建 window #5，started 1 次、ok=true ② 就绪前 abort → `cancelled` 且页面未收到 play ③ 开始后 abort → `cancelled`，页面收到对应 `stop` ④ 对旧 id 注入 `ended`+`error` 后新 speech 仍 ok |
| `r3-renderer-crash` | `webContents.forcefullyCrashRenderer()` 真实崩溃，`render-process-gone` reason `crashed` exitCode 2；窗口被回收、busy/playId 清空，重建 window #7 真播放 |
| `recreate-after-destroy` | 销毁后重建 window #8 state=playing |
| `status-without-window` | idle、未创建任何窗口 |
| `long-pause-holds-busy` / `unknown-duration-busy` / `stale-event-ignored` | 暂停 5 s 仍 busy（280/3000 ms）；`durationMs=0` 3 s 仍 busy；旧 requestId 的 `ended` 被丢弃、当前 owner 的 `ended` 释放 |

探针事件等待器带同步 backlog（先扫已达事件再挂等待），修掉了「`playing` 在命令 resolve 前到达」造成的假超时；冷路径位置推进改为轮询 status 直到 `positionMs` 增长（上限 3 s），不再固定睡眠；预算未放宽。`r3-renderer-crash` 首轮真实抓到「崩溃后 `activePlayId` 残留」，说明该例能失败（不是恒真断言）。

### 4.5 R4：播放验收门槛拒绝空证据

- 复现：对 `{pass:true, cases:[]}` 调用 `loadPlaybackEvidence` + `playbackGate` → `caseCount 0`、`met true`。修复后同输入 `met:false`，`reasons` 指明缺 cases。
- 新契约（`scripts/lib/playback.mjs`）：`REQUIRED_PLAYBACK_SCENARIOS` = `r1-stop-before-ready`、`r1-playback-replacement`、`r2-destroy-or-cancel`、`r3-note-cold-path`、`r3-speech-cold-path`；每个用例须有 `id/pass/kind`，`kind` 只能是 `real-window` 或 `stub`；每个必要场景必须有**真实窗口**通过例；`identity` 必须给全 `entrySha256/preloadSha256/barHtmlSha256/sourceRef/command` 且哈希为 64 位十六进制；输出 `reasons[]/coverage{realWindow,stub,scenarios,missingScenarios,unclassified}`。
- 反向验证：阶段 19 的旧格式 10 例结果（无 `kind`）→ `playback not met`，`compare` 退出码 1（`not-adopted`），其余指标仍显示达标 —— 说明门槛真的会挡住只有 `pass:true` 的文件。`compare-app-resources.mjs` 仅措辞变化，阈值未动。

### 4.6 验证命令与结果（最终产物）

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | EXIT 0 |
| `pnpm exec vitest run`（本轮相关 8 个文件，含真实窗口探针与 `scripts/lib/playback.test.mjs`） | EXIT 0，8 文件 / 68 例通过 |
| `pnpm test` | EXIT 0，250 文件通过 / 3 跳过，3651 例通过 / 8 跳过 |
| `pnpm build` | EXIT 0 |
| `PROBE_OUT=…/t20-probe pnpm exec vitest run src/main/bar-playback.probe.test.ts` | EXIT 0，15/15 例通过，`totalMs 13068` |
| `node scripts/compare-app-resources.mjs …` | EXIT 0，九项 `met`，`decision adopted` |

`pnpm test`/`pnpm build` 之后未再改生产源码；探针与基准都在最后一次构建产物上运行。

### 4.7 整应用资源复查（同法可比，基线原始样本复用）

| 指标 | 基线 `0cb30d9` | 候选 `2e6a4ee1…` | 结论 |
| --- | --- | --- | --- |
| 托盘空闲 60 s 私有驻留 p50 | 94,232,576 B (89.9 MiB) | 56,848,384 B (54.2 MiB) | −39.67% / −35.7 MiB，门槛 −15%/−30 MiB 达标 |
| 同上角色分布 | main 42.3 / renderer 22.7 / utility 14.8(2) / gpu 8.7 / other 1.4 MiB | main 38.5 / renderer 0 / utility 6.8(1) / gpu 7.6 / other 1.4 MiB | renderer 常驻消失 |
| 稳定 4 s（settled-4s）p50 | 108,011,520 B (103.0 MiB) | 67,092,480 B (64.0 MiB) | −37.88% |
| 20 次开关同实例趋势 | −10.42% | −12.06% | 无持续增长 |
| 开关后静止 | 102,445,056 B (97.7 MiB)，renderer 1 | 66,351,104 B (63.3 MiB)，renderer 0 | 更低 |
| 首次开窗 p50 / p95（n=20+20，失败 0） | 601.208 / 638.689 ms | 566.095 / 591.762 ms | p95 −46.927 ms，回退门槛 ≤+100 ms 达标 |
| 再次开窗 p50 / p95 | 267.494 / 316.262 ms | 275.014 / 304.021 ms | p50 +7.5 ms、p95 −12.2 ms；单次最大 1200.825 ms 出现在首轮（新进程首开），p95 不受影响 |
| 冷启动树就绪 | 868.524 ms | 689.423 ms | 更快；冷启动此时不创建 Pill（`spawnToPillReadyMs: null`，原因已记录） |
| 空闲 CPU | 1812.5 ms / 60016 ms = 30.2 ms/s | 78.125 ms / 60019.5 ms = 1.302 ms/s（三次窗口 1.302 / 0.521 / 2.343） | 比值 0.043，无明显升高 |
| Pill 创建→回收→再创建 | 0 次回收 / 1 次 take / 同一 renderer | 3 次回收 / 3 次 take / 3 个 renderer | 按需创建与回收均在真实窗口上发生 |
| CPU 自检（已知 CPU 任务） | 968.75 ms / 1008.831 ms | 1015.625 ms / 1001.793 ms | 比值 1.014，量纲可信 |

口径说明：基线复用阶段 19 原始样本的前提是脚本、诊断封装、场景参数与主机一致（sha 与 `meta` 已逐项比对）；CPU 为 250 ms 采样树，粒度 15.625 ms（冷启动 10 s 窗口读到 0，等价于不足一个 tick，不能读成「零 CPU」）；采样不覆盖首个采样点之前启动的进程与两次采样之间退出进程的全部用量，证据里原样标注 `coverage.limitation`。

### 4.8 本轮新增/纠正的回归

- `bar-ready.test.ts`：销毁后 getter 抛错时多 waiter 仍确定结算、子框架失败不吃掉监听、`isReady` 语义。
- `bar-playback-host.test.ts`（新）：`peek` 不创建、`ensure` 尊重 `blocked`、单调用 abort 不影响其他等待、取消不记日志。
- `note-audio.test.ts`：stop-before-ready 取消未发送 play、乱序就绪只发最新 play、旧 generation 回执不改忙态、未知回执不更新状态、回执校验在忙态之前、stop 后零定时器、dispose 结算、**status 不取消准备中的播放**（Lead 复审新增）。
- `speech-playback.test.ts`：就绪前 abort、开始后 abort、旧 speech 回执不影响新播放。
- `scripts/lib/playback.test.mjs`：空/缺 cases、必要场景缺失、失败与跳过、缺 identity、真窗口分类、旧格式拒绝。

### 4.9 仍未测边界

1. 页面内 `process.crash()` 未使用：Pill 渲染器是 sandbox + contextIsolation 且无 Node，页面拿不到该方法；改用 Electron 正规崩溃入口 `webContents.forcefullyCrashRenderer()`（真实进程被杀，`reason=crashed`），未用 destroy 冒充崩溃。
2. 真实 TTS / 云端语音服务未连：`speech:playback` 只投递合成 WAV。
3. 8 s 命令预算耗尽路径（`录音播放没有响应`）未构造：没有让活着的渲染器保持沉默的用例。
4. 不可信 sender 拒绝（`Blocked IPC from an untrusted renderer`）未探：无法伪造 sender。
5. 平台仅 Windows x64；macOS/Linux 未测。
6. speech 音量/倍速映射边界（volume=100、speed=1 固定）未覆盖。
7. `index.ts` 的崩溃退役只在探针里以同样接线验证，没有另建主进程集成测试。

### 4.10 清理与提交

- 探针 userData（`work/t19-probe/profile-*`）、临时 profile 与 `work/t20-run/profile-*` 由脚本自清；`work/t20-run/` 保留 `candidate.json`、`run.log`、`verify.log` 与两个运行脚本（约 200 KB），`work/t20-probe/result.json` 作为新证据输入保留。
- 提交：播放接线 `e26eed7`、验收门槛 `2fc4cd4`、文档与证据（本条所在提交）。未 push、未打包、未重启用户应用、未修改 DSH 插件或旧会话日志。
