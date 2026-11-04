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

- [ ] 先添加上述三个失败回归，至少记录发送顺序、Promise 终态、active owner 与 busy 状态。旧代码必须因真实行为不符而失败，不能仅断言某个新字段存在。
- [ ] 明确并实现最新有效播放胜出：旧准备中播放被新播放替代时及时结束旧请求；旧就绪/成功/错误/超时/结束回执均不能再发送、覆盖或释放新播放。失败及 dispose 不留下悬空 owner。
- [ ] `stop` 必须先取消当前准备中的播放及相关等待，返回明确 idle/停止结果；之后收到 ready 也不得起播。无窗口的 status/pause/stop 仍不得创建窗口。
- [ ] 就绪前的 pause 必须阻止随后意外起播；可选择保留待恢复意图或明确取消尚未开始的播放，但要在实现结果说明实际语义。已开始播放的可恢复暂停必须保留录音、位置和速率，不得为了回收窗口改成停止。
- [ ] 就绪前 status/pause/stop 不得向未订阅的页面发送后等待满 8 s；控制语义要能从当前准备状态直接处理，或以同一就绪/取消路径完成。不得增加固定 sleep、轮询或扩大 8 s/20 s 预算。
- [ ] 回执须先验证窗口与请求/播放归属，再改变忙态。旧的、未知的、超时后的同窗口 reply 均不能改变当前 owner；合法 pause/resume/seek/rate/status 的回执保持可用。现有“未知 requestId 也更新状态”的测试应纠正为拒绝该错误行为，页面驱动状态沿用受归属校验的事件通道。
- [ ] 覆盖 old/new 同序及反序就绪、stop-before-ready、pause-before-ready、超时后 ready、旧 reply/error/ended、重复 stop/dispose；所有 Promise 最终成功或明确取消/失败，无未处理拒绝与残留定时器。

### R2：就绪等待清理与崩溃后重建

涉及：`src/main/bar-ready.ts`、`src/main/bar-ready.test.ts`、`src/main/index.ts` 的 `barEnsure` / `forgetBarPlayback` / `ensureBarWindow`、`src/main/speech-playback.ts` 及对应测试。

确定失效：窗口销毁后 `webContents` getter 抛错，`forget()` 虽已缓存 id，`waiter.detach()` 仍再次读取 `gate.webContents`。按生产顺序先注册 closed→forget、后注册 waiter 再销毁，得到清理异常，等待 Promise 仍 pending。主进程 `barEnsure()` 另丢弃了 `wait().cancel`；命令超时/取消只移除 player pending，并未撤销底层等待。现有 render-process-gone 清理也没有使仍存在的崩溃窗口退出复用路径。

- [ ] 先以销毁后 getter 抛错的窗口替身固定失效，覆盖多个 waiter、生产 closed→forget 顺序、重复 forget/cancel。清理不得再访问已销毁窗口 getter，每个 waiter 必须确定结算且监听器归零。
- [ ] 把命令取消、替换、超时、dispose 接到真实就绪等待；可调整既有窄接口接收取消信号/返回取消句柄。一个调用取消不能撤销其他有效调用，取消后不遗留监听器或不可达 Promise。不要只在发送前再加一个 pending 判断。
- [ ] `did-fail-load` 只处理主框架，但子框架失败不能消耗唯一监听，导致随后主框架失败无人处理；增加先子框架再主框架的回归。
- [ ] 渲染器崩溃后，不复用永远无法 ready 的旧窗口。下一次有效播放可在现有预算内取得新的可用窗口；旧窗口迟到 ready/closed/gone 不能清理新窗口的新 owner。退出时不再创建窗口。
- [ ] 复用现有窗口生命周期组织方式，以窗口身份限定清理，不扩展为全局窗口管理框架。验证取消前后 pending、waiter/listener、busy 均回到合理基线。

### R3：真实窗口负向路径与云语音播放补证

涉及：`src/main/bar-playback.probe.test.ts`、现有探针源码、`src/main/speech-playback.test.ts`、必要的现有主进程接线。先确认探针实际导入的生产模块，不复制一份播放器逻辑来证明自身。

- [ ] 继续用真实构建的 bar 页面、preload 和 IPC 信任校验，隔离 userData、拒绝麦克风权限，以本轮合成的短媒体验证，不使用用户资料或远程付费服务。
- [ ] 在真实窗口中覆盖冷创建、回收后重建、ready 窗口；新增 stop-before-ready 和连续播放替换/旧回执反例，证明最终实际播放 owner 正确，而不只检查 send 调用次数。
- [ ] 加入 `createSpeechPlayback` 的真实 renderer 路径：冷创建播放、就绪前 abort、开始后 abort、旧 speech 回执到达后新播放仍有效。合成媒体经现有生产入口投递，模型和网络合成可受控替换。
- [ ] 至少真实销毁等待中的窗口一次；在隔离探针里对自有 renderer 用 Electron 正规崩溃入口验证 render-process-gone、pending 失败及随后重建，禁止终止用户进程。若环境阻止真实崩溃，保留失败证据并明确未测，不能用 destroy 冒充崩溃。
- [ ] 测试必须复用生产主进程的就绪/窗口归属/取消接线，或另加直接针对该接线的测试；孤立自定义 host 全通过不能自动证明 `index.ts` 接线也正确。避免仅为探针大范围拆分主进程。
- [ ] 保持暂停超过回收期限、未知时长、seek/rate、自然结束与旧窗口迟到事件的覆盖；语音和随记均不因新窗口冷启动而丢首条有效命令。

### R4：播放验收门槛拒绝空证据

涉及：`scripts/lib/playback.mjs`、`scripts/lib/playback.test.mjs`、必要时 `scripts/compare-app-resources.mjs` 与现有探针结果输出。

已执行生产函数复现：`loadPlaybackEvidence(...{pass:true,cases:[]})` 得 `caseCount=0`，随后 `playbackGate(null, evidence).met === true`。这不否定阶段 19 实际存在的十条记录，但表明缺失功能证据也能被自动采纳。

- [ ] 对空 cases、缺 cases、必要场景缺失、任一失败/跳过、仅顶层 pass=true 的输入拒绝通过。使用一份小而明确的必要场景清单，不能仅靠任意非空数组过关，不建立通用验证协议。
- [ ] 当前阶段的必要场景至少包含 R1 停止与替换、R2 销毁/取消、R3 随记和 speech 冷路径；区分自动测试替身与真实窗口结果。缺少真实崩溃时记录待验收，不能宣称已测。
- [ ] 记录产生探针结果的源码身份、最终构建入口/页面/preload 哈希及具体命令，避免只凭历史 pass=true 文件证明新产物。固定输出文件与比较入口做最小校验即可，不增加签名/服务。
- [ ] 保留阶段 18/19 的证据原样。本轮新证据用 `tests/yu-v2/evidence/electron-playback-correctness-20261104.json`，跨日按实际日期；逐项记录结果、失败原因、产物身份和未测项。

## 2. 验证与资源收益复查

- [ ] 顺序推进 R1 → R2 → R3 → R4，先记录失败回归再修代码；一组通过后继续下一组，不反复跑全部基准替代排障。
- [ ] 在项目根目录运行 `pnpm exec vitest run src/main/note-audio.test.ts src/main/note-audio-busy.test.ts src/main/bar-ready.test.ts src/main/bar-retire.test.ts src/main/speech-playback.test.ts src/main/bar-playback.probe.test.ts scripts/lib/playback.test.mjs`；按实际配置确保 Node 脚本测试和真实窗口探针确实执行，不把未发现/跳过当通过。
- [ ] `pnpm typecheck`；源码稳定后连续执行一次 `pnpm test`、`pnpm build`，最后针对实际产物运行真实探针。无需手动额外重编全部 Rust crate；正常脚本自带的 native 构建保持原样。若之后再改生产源码，重跑受影响验证和产物探针。
- [ ] 最终候选复查空闲 60 s、20 次开关后静止、至少 20 个有效首开/重开样本及 Pill 创建→回收→再创建，记录全部原始样本/失败、实际功能开关和身份。既有可靠基线原始样本可复用，必须说明来源与同法可比性；采集口径/封装改变时才补跑相应基线，不能机械地用旧值通过新口径。
- [ ] 沿用完整树空闲私有驻留至少 −15% 且 −30 MiB、无持续增长、首开 P95 回退不超过 100 ms、CPU 无明显升高及功能验收；不降低门槛或隐藏慢样本。若本轮无法复测，保留阶段 19 为历史测量，标明最终候选待测，不把历史数值写成本轮实测。重开回退也单独报告。
- [ ] 隔离基准继续使用同封装禁止 `setLoginItemSettings` 写入，Run 键只读；不得恢复删除/还原注册表启动项的旧逻辑。不要把其他应用、采样器计入自有树，不复制 node_modules/模型或完整用户数据。

## 3. 文档、提交与汇报

- [ ] 回填本文已实现项与 §4；逐条写实际命令、退出码、有效样本与失败，不复制旧通过数量。未测事项不勾选为完成。
- [ ] 更新 `docs/rust-refactor-plan.md` 阶段 19/20、阶段 19 计划相关复核结论；阶段 19 的就绪等待/并发取消等原勾选应注明由本轮修正，历史实测保留出处。README 只改本轮影响的现行行为和有效结论，不扩展文档整理。
- [ ] 检查最终 diff，只提交当前阶段逻辑完整且验证可用的变更，使用 Conventional Commits。记录实现和文档提交编号，禁止把其他人 WIP 混入；本计划已由外部落库，无需重新出一轮计划后待命。
- [ ] 只清理本轮自有的可重建探针/进程/目录；先确认绝对路径、归属、进程已退出。保留现有证据、恢复备份与必要原始读数，记录本轮占用和回收量。
- [ ] 内部审查结论仅为资料。收齐本轮协作者意见并结束审查后，对外只汇报一次：修复前后反例、剩余缺口、验证、资源复查及局限、提交、工作区状态。随后等待本外部 Codex 对话，不凭内部消息自开下一阶段。

## 4. 实施结果（由 DSH 据实填写）

尚未实施。请记录 R1–R4 的实际结果、关键失败与修复、最终探针/资源证据路径与构建身份、全部验证结果、提交编号、仍未测边界和清理情况。本节不得提前填“通过”。
