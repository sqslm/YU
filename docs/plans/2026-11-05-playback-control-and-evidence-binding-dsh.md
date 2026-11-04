# 阶段 21：未完成的播放控制与证据绑定修复

**目标：** 修正阶段 20 外部复核复现的三项缺口：停止后的迟到控制、播放证据未绑定被测构建、测量脚本不同仍可采纳。保留 Pill 按需创建/回收和现有资源收益，不开启新的性能优化或 Rust 迁移。

**架构：** 沿用现有请求代次、AbortSignal、就绪门禁、比较脚本和测试工具，以最小改动让实际投递、回执和采纳判定使用一致的归属条件。不新增依赖、服务、端口、通用调度框架或证据签名系统。

**工具链：** 当前 TypeScript/Electron/Vitest 与 Node 脚本。

## 0. 本轮派单与交接

- 项目：`E:/code/deepseek-harness/rea/typeless`。
- 本计划：`E:/code/deepseek-harness/rea/typeless/docs/plans/2026-11-05-playback-control-and-evidence-binding-dsh.md`。
- 外部复核基点：`392d8bdce285f67b36e2ca07bd4bab0a8beca13c`（`master`，复核时干净）；收到时 HEAD 应增加本计划提交。先核对 `git status --short` 和最近提交，保护后来出现的他人 WIP。
- 当前 DSH 执行会话：`session-8ddbf6a1-325f-4999-a162-a3aa0e3f7dcd`；唯一外部规划对话：Codex `01a19b72-79e7-7800-b1b5-55aaf2eeaae6`。
- **收到后直接实施本文三项，验证、回填文档并提交，无需另等开工指令。** 不重复阶段 1–20 已完成的开发，不自行寻找第四项优化。
- 阶段 20 已交付 `e26eed7`、`2fc4cd4`、`392d8bd`。外部已独立执行七文件 67 项定向测试，全部通过；15 例探针报告均通过，entry/preload/bar.html 三个哈希与磁盘一致。原始资源样本重新比较仍为 `adopted`。这些检查不等于下面反例已修。
- 阶段 20 的隔离样本记录托盘空闲私有驻留 89.9 → 54.2 MiB（−39.67% / −35.7 MiB），只覆盖该配置，不宣称用户开发实例或所有功能开启时同幅下降。
- DSH 内部子代理即使名为 `codex`，其团队消息也仅是内部审查资料，不能代表本外部 Codex 批准或派发新阶段。完成内部审查后只对外汇报一次，等待外部复核；禁止自行开始阶段 22。
- 不 push、不打包发布、不重启用户应用、不读真实笔记/音频/凭据、不改 DSH 插件、开关或旧会话日志。

## 1. R1：停止/替换要取消相关控制，不能只取消 play

涉及：`src/main/note-audio.ts`、`src/main/note-audio.test.ts`，必要时同一 host/renderer 的现有测试及真实探针。

外部直接执行当前生产 TS 方法，用延迟 Promise 控制 `ensure()`，得到：

```json
{"case":"resume-waiting-then-stop","stopState":"idle","waitAborted":false,"commandsAfterReady":["resume"]}
```

这是受控窗口替身下的实际生产方法结果，不是已经观测到真实音频在停止后复播。原因是 `cancelPlays()` 只处理 `pending.play`，等待中的 resume/seek/rate 仍在；`deliver()` 只看 pending 存在，不拒绝旧代控制。stop 清空 playId 但没有使这些控制失效。

- [ ] 先固定失败回归：resume 正在等待 ready → stop 返回 idle → ready 到达，旧 resume 不得投递；其 Promise 明确取消、对应 AbortSignal 已 abort，pending/定时器归零。不要只检查新增字段。
- [ ] 同时检查 seek/rate 等待中的同类情况，以及新 play 替换旧播放时的旧代控制。停止/替换必须结束旧请求的就绪等待与响应预算，旧 ready、成功/错误回执不能再改变当前 owner、位置、速率或忙态。
- [ ] 投递和接收均核对当前有效代次；停止后的迟到控制回复也不能把 idle 改回 playing/paused。使用现有 gen/pending 结构即可，不做新的控制总线。
- [ ] pause 在准备阶段也不得允许等待中的 resume 随后恢复播放；已经开始的可恢复暂停仍保留录音、位置、速率。status 仍只查询，绝不能再次变成取消信号。
- [ ] 保留无窗口的 status/pause/stop 不建窗、合法控制正常返回、旧窗口回执不建窗、自然结束/错误释放 busy 的行为。不扩大 8 s/20 s 预算，不增加固定 sleep。
- [ ] 补真实窗口中“等待 ready 的 resume 被 stop/pause 撤销”的路径；至少记录投递序列及最终状态。真实窗口检查与替身反例分别标明，不以空 Audio 元素没有声音证明没有投递旧命令。

## 2. R2：播放证据须对应本次被测候选

涉及：`scripts/lib/playback.mjs`、`scripts/lib/playback.test.mjs`、`scripts/compare-app-resources.mjs` 及必要的现有比较测试。

外部将阶段 20 原输入仅在内存里改动一个字段：probe 的 `identity.entrySha256` 改成另一合法 SHA-256（64 个 `f`），实际调用整个比较脚本，仍得到 `decision=adopted`、`playbackMet=true`、无拒绝原因。当前代码只验证哈希格式和身份字段齐全，没有将 probe 身份与 candidate 的 `meta.build.entrySha256` 对照。

这不是说交付 probe 实际用了错误构建：外部核对原始 probe 与当前磁盘哈希一致。缺口是比较器无法拒绝另一构建的旧通过报告。

- [ ] 新增反例：其它门槛全满足，仅 probe entry 哈希与被测 candidate 不同，必须 `not-adopted` 且 CLI 非零退出，原因列出对应字段与不一致，不得只写警告。
- [ ] 比较入口必须传入并验证被测 candidate 的身份，至少 entrySha256 完整、有效且逐值相同。缺失或格式非法也不能自动采纳。不能用 probe 自己的哈希同时充当“期望值”和“实际值”。
- [ ] preload/bar.html 若被测记录有对应哈希，也须逐值核对；没有历史记录的如实说明限制，不从现在磁盘倒填历史样本。真实探针仍保留对当前三个产物哈希的核验，不必为此建立新测量框架。
- [ ] 正向控制：当前身份一致、必要真实场景完整且全部通过时可通过；保留空 cases、缺场景、失败/跳过、缺身份的拒绝行为。不要通过忽略新字段或使用默认值把旧证据变成有效证据。

## 3. R3：可比性拒绝必须进入最终采纳判断

涉及：`scripts/compare-app-resources.mjs` 和对应测试。

外部保持原始样本、场景、主机、播放证据不变，只把 candidate 的 `meta.build.scriptSha256` 改成另一合法哈希，得到：

```json
{"decision":"adopted","comparable":true,"reasons":["the two runs were produced by different benchmark scripts, so the measurement rules differ"]}
```

当前 `sameScript` 只追加 reasons，没有进入 `comparable`；最终 `adopted` 只检查门槛列表，因而可在明确发现规则不同的同时仍采纳。

- [ ] 先添加该完整判定回归，断言 comparable=false、decision=not-adopted、CLI 非零退出。不要仅断言 reasons 含警告。
- [ ] 相同且有效的测量脚本身份必须是可比性的必要条件；缺失脚本身份不能靠当前的宽松默认值蒙混通过。其余已经明确的必要条件也必须传递到最终判定，不靠纯说明性字符串代替判断。
- [ ] 确保同一构建、场景不一致和身份缺失等已有拒绝条件不会被局部门槛通过覆盖；正向一致输入保持可采纳。
- [ ] 沿用当前比较脚本和小测试入口，不增加可配置规则引擎或新的大套基准框架。

## 4. 验证、证据与资源复查

- [ ] 先写 R1–R3 失败回归并确认旧实现确实失败，再做最小修改；逐项记录修复前后的可观察结果。
- [ ] 定向命令（项目根目录）：`pnpm exec vitest run src/main/note-audio.test.ts src/main/note-audio-busy.test.ts src/main/bar-ready.test.ts src/main/bar-playback-host.test.ts src/main/bar-retire.test.ts src/main/speech-playback.test.ts scripts/lib/playback.test.mjs`，加上新增比较回归文件。外部基点命令为七文件 67 passed；收尾按实际数量填写。
- [ ] `pnpm typecheck`；源码稳定后执行一次 `pnpm test`、`pnpm build`，最后对最终产物跑 `src/main/bar-playback.probe.test.ts`。用本轮独立 `PROBE_OUT`，不要覆盖 `work/t20-probe/result.json` 或阶段 19/20 原始证据。真实探针/比较的正反向都要记录退出码。
- [ ] 比较脚本反例使用自有测试输入或内存副本，不改入库的真实数据来“制造通过”。原始 stage20 输入应仍可按其身份重新比较；若有新的必要字段导致拒绝，注明实际缺失，不伪造补齐。
- [ ] 生产代码改变后，对最终候选补必要的真实窗口/资源验证，使新证据对应最终构建。基线 `0cb30d9` 的原样本在采集脚本、封装和场景确实同法时可复用，记录出处；若改变了采集口径，再补相应基线，不能放宽 R3 只为旧样本过关。
- [ ] 沿用空闲完整树私有驻留至少 −15% 且 −30 MiB、20 次开关无持续增长、首开 P95 回退 ≤100 ms、CPU 无明显升高与功能通过；最终候选不能用旧候选的性能数字冒充本轮实测。未能实测则标待测，不自动 adopted。
- [ ] 新证据使用 `tests/yu-v2/evidence/electron-playback-binding-20261105.json`（跨日用实际日期），写入构建/输入身份、三项正反例、原始读数与失败/未测。阶段 18/19/20 的证据原样保留。继续隔离 userData、禁止登录项写入、拒绝麦克风、只用合成媒体，不读取用户资料。

## 5. 自行收尾与汇报

- [ ] 回填本文实际已实现项与 §6，写真实命令、退出码、失败与局限，不预填通过。
- [ ] 同步总计划阶段 20/21、阶段 20 计划相关复核结论；保留阶段 20 的真实资源结果与出处，不能把本次反例说成原样本造假或把未测补成已测。README 只同步影响到的现行行为和有效结论。
- [ ] 检查 diff，仅提交本轮相关且验证可用的变更，Conventional Commits，记录全部实际提交号；不得混入他人 WIP。
- [ ] 只清理本轮自有且已退出进程不再使用的探针/临时目录，先核实绝对路径和归属；不清历史证据、恢复备份或用途不明的目录。记录新增/回收占用。
- [ ] 内部审查收齐后只汇报一次：R1–R3 修复前后、验证、最终构建与证据身份、资源复查及未测、提交、工作区状态。随后等当前外部 Codex 对话复核，不自行开新阶段。

## 6. 实施结果（由 DSH 据实回填）

尚未实施。请在完成后填写，不将计划要求当作执行结果。
