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

- [x] 先固定失败回归：resume 正在等待 ready → stop 返回 idle → ready 到达，旧 resume 不得投递；其 Promise 明确取消、对应 AbortSignal 已 abort，pending/定时器归零。不要只检查新增字段。
- [x] 同时检查 seek/rate 等待中的同类情况，以及新 play 替换旧播放时的旧代控制。停止/替换必须结束旧请求的就绪等待与响应预算，旧 ready、成功/错误回执不能再改变当前 owner、位置、速率或忙态。
- [x] 投递和接收均核对当前有效代次；停止后的迟到控制回复也不能把 idle 改回 playing/paused。使用现有 gen/pending 结构即可，不做新的控制总线。
- [x] pause 在准备阶段也不得允许等待中的 resume 随后恢复播放；已经开始的可恢复暂停仍保留录音、位置、速率。status 仍只查询，绝不能再次变成取消信号。
- [x] 保留无窗口的 status/pause/stop 不建窗、合法控制正常返回、旧窗口回执不建窗、自然结束/错误释放 busy 的行为。不扩大 8 s/20 s 预算，不增加固定 sleep。
- [x] 补真实窗口中“等待 ready 的 resume 被 stop/pause 撤销”的路径；至少记录投递序列及最终状态。真实窗口检查与替身反例分别标明，不以空 Audio 元素没有声音证明没有投递旧命令。

## 2. R2：播放证据须对应本次被测候选

涉及：`scripts/lib/playback.mjs`、`scripts/lib/playback.test.mjs`、`scripts/compare-app-resources.mjs` 及必要的现有比较测试。

外部将阶段 20 原输入仅在内存里改动一个字段：probe 的 `identity.entrySha256` 改成另一合法 SHA-256（64 个 `f`），实际调用整个比较脚本，仍得到 `decision=adopted`、`playbackMet=true`、无拒绝原因。当前代码只验证哈希格式和身份字段齐全，没有将 probe 身份与 candidate 的 `meta.build.entrySha256` 对照。

这不是说交付 probe 实际用了错误构建：外部核对原始 probe 与当前磁盘哈希一致。缺口是比较器无法拒绝另一构建的旧通过报告。

- [x] 新增反例：其它门槛全满足，仅 probe entry 哈希与被测 candidate 不同，必须 `not-adopted` 且 CLI 非零退出，原因列出对应字段与不一致，不得只写警告。
- [x] 比较入口必须传入并验证被测 candidate 的身份，至少 entrySha256 完整、有效且逐值相同。缺失或格式非法也不能自动采纳。不能用 probe 自己的哈希同时充当“期望值”和“实际值”。
- [x] preload/bar.html 若被测记录有对应哈希，也须逐值核对；没有历史记录的如实说明限制，不从现在磁盘倒填历史样本。真实探针仍保留对当前三个产物哈希的核验，不必为此建立新测量框架。
- [x] 正向控制：当前身份一致、必要真实场景完整且全部通过时可通过；保留空 cases、缺场景、失败/跳过、缺身份的拒绝行为。不要通过忽略新字段或使用默认值把旧证据变成有效证据。

## 3. R3：可比性拒绝必须进入最终采纳判断

涉及：`scripts/compare-app-resources.mjs` 和对应测试。

外部保持原始样本、场景、主机、播放证据不变，只把 candidate 的 `meta.build.scriptSha256` 改成另一合法哈希，得到：

```json
{"decision":"adopted","comparable":true,"reasons":["the two runs were produced by different benchmark scripts, so the measurement rules differ"]}
```

当前 `sameScript` 只追加 reasons，没有进入 `comparable`；最终 `adopted` 只检查门槛列表，因而可在明确发现规则不同的同时仍采纳。

- [x] 先添加该完整判定回归，断言 comparable=false、decision=not-adopted、CLI 非零退出。不要仅断言 reasons 含警告。
- [x] 相同且有效的测量脚本身份必须是可比性的必要条件；缺失脚本身份不能靠当前的宽松默认值蒙混通过。其余已经明确的必要条件也必须传递到最终判定，不靠纯说明性字符串代替判断。
- [x] 确保同一构建、场景不一致和身份缺失等已有拒绝条件不会被局部门槛通过覆盖；正向一致输入保持可采纳。
- [x] 沿用当前比较脚本和小测试入口，不增加可配置规则引擎或新的大套基准框架。

## 4. 验证、证据与资源复查

- [x] 先写 R1–R3 失败回归并确认旧实现确实失败，再做最小修改；逐项记录修复前后的可观察结果。
- [x] 定向命令（项目根目录）：`pnpm exec vitest run src/main/note-audio.test.ts src/main/note-audio-busy.test.ts src/main/bar-ready.test.ts src/main/bar-playback-host.test.ts src/main/bar-retire.test.ts src/main/speech-playback.test.ts scripts/lib/playback.test.mjs`，加上新增比较回归文件。外部基点命令为七文件 67 passed；收尾按实际数量填写。
- [x] `pnpm typecheck`；源码稳定后执行一次 `pnpm test`、`pnpm build`，最后对最终产物跑 `src/main/bar-playback.probe.test.ts`。用本轮独立 `PROBE_OUT`，不要覆盖 `work/t20-probe/result.json` 或阶段 19/20 原始证据。真实探针/比较的正反向都要记录退出码。
- [x] 比较脚本反例使用自有测试输入或内存副本，不改入库的真实数据来“制造通过”。原始 stage20 输入应仍可按其身份重新比较；若有新的必要字段导致拒绝，注明实际缺失，不伪造补齐。
- [x] 生产代码改变后，对最终候选补必要的真实窗口/资源验证，使新证据对应最终构建。基线 `0cb30d9` 的原样本在采集脚本、封装和场景确实同法时可复用，记录出处；若改变了采集口径，再补相应基线，不能放宽 R3 只为旧样本过关。
- [x] 沿用空闲完整树私有驻留至少 −15% 且 −30 MiB、20 次开关无持续增长、首开 P95 回退 ≤100 ms、CPU 无明显升高与功能通过；最终候选不能用旧候选的性能数字冒充本轮实测。未能实测则标待测，不自动 adopted。
- [x] 新证据使用 `tests/yu-v2/evidence/electron-playback-binding-20261105.json`（跨日用实际日期），写入构建/输入身份、三项正反例、原始读数与失败/未测。阶段 18/19/20 的证据原样保留。继续隔离 userData、禁止登录项写入、拒绝麦克风、只用合成媒体，不读取用户资料。

## 5. 自行收尾与汇报

- [x] 回填本文实际已实现项与 §6，写真实命令、退出码、失败与局限，不预填通过。
- [x] 同步总计划阶段 20/21、阶段 20 计划相关复核结论；保留阶段 20 的真实资源结果与出处，不能把本次反例说成原样本造假或把未测补成已测。README 只同步影响到的现行行为和有效结论。
- [x] 检查 diff，仅提交本轮相关且验证可用的变更，Conventional Commits，记录全部实际提交号；不得混入他人 WIP。
- [x] 只清理本轮自有且已退出进程不再使用的探针/临时目录，先核实绝对路径和归属；不清历史证据、恢复备份或用途不明的目录。记录新增/回收占用。
- [x] 内部审查收齐后只汇报一次：R1–R3 修复前后、验证、最终构建与证据身份、资源复查及未测、提交、工作区状态。随后等当前外部 Codex 对话复核，不自行开新阶段。

## 6. 实施结果

### 6.1 环境、身份与出处

- 外部复核基点 `392d8bdce285f67b36e2ca07bd4bab0a8beca13c`；本轮代码提交 `49fb092`（R1，`src/main`）、`0130719`（R2/R3，`scripts/` 与 `.gitignore`），文档与证据随本文件提交。收到派单时工作区干净，无他人 WIP 混入。
- 测量脚本未改：`scripts/benchmark-electron-app.mjs` `5645f616de2525e5a0a45e1bb6ba77df18ae837325d12c02e4dbea9dcf0d08ff`；诊断封装 `dfcbfc3a…`、`meta.measurement.scenarios`、`meta.host` 与阶段 19 逐项相同，故基线样本 `work/t19-run/baseline.json`（entry `5d5fecb1…`）按原口径复用，未放宽任何条件。
- 候选产物：`out/main/index.js` `6b98f39256d8cc36b00a15ec1c4f97ac946d98d138470c7f11997172fef255b4`（本轮 R1 改动，阶段 20 为 `2e6a4ee1…`）、`out/preload/index.js` `1179fc92…`、`out/renderer/bar.html` `d126110c…`。`out/main` 仍附带 `resources/` 与 `native/bin/`（`app.getAppPath()` 为 `out/main`）。
- 探针 identity 三项与磁盘一致（`entrySha256 6b98f392…`、`preloadSha256 1179fc92…`、`barHtmlSha256 d126110c…`），`sourceRef` 为 `HEAD 84fc62f… (dirty)`（构建时 HEAD 仍是计划提交，工作区含未提交改动，与 `dirty:true` 相符）。
- 新证据 `tests/yu-v2/evidence/electron-playback-binding-20261105.json`（99,287 B）：`decision=adopted`、`comparable=true`、`reasons=[]`；阶段 18/19/20 证据文件未改动。

### 6.2 R1：停止与替换撤销等待中的控制（`49fb092`）

- 失败回归在旧实现上真失败（`src/main/note-audio.test.ts` → `Tests 6 failed | 16 passed (22)`）：`expect(signals[0]!.aborted).toBe(true)` 得到 `expected false to be true`（第 278 行）、`vi.fn()` 记录了 `["note-audio:command", {action:"resume"}]`、`onState` 收到 `['idle','playing']`——与外部 `{"waitAborted":false,"commandsAfterReady":["resume"]}` 完全对应，不是断言写法问题。
- 修改（`src/main/note-audio.ts`，221 → 251 行）：`Pending.play: boolean` → `Pending.action: NoteAudioAction`；新增 `cancelPending(action)`（`pause` → `cancelUnsent`；`stop` → `gen += 1` + `cancelBefore(gen)` + `playId = null`；其余动作不动）、`cancelBefore(gen, error)`（取消所有 `pending.gen < gen`，唯独跳过 `status`，查询永不成为取消信号）、`cancelUnsent(error)`（只取消未投递命令，已开始的可恢复暂停不受影响）；play 路径先 `gen += 1; cancelBefore(gen, SUPERSEDED)`；`deliver()` 在 `send()` 前复核 `pending.gen < this.gen` 并以 `Playback superseded` 结束；根因函数 `cancelPlays()` 删除。`receive()`/`acceptEvent()` 未改：取消即删除 pending，stop 置空 `playId`，迟到回执与迟到事件都不再归属。
- 绿灯：`note-audio.test.ts` 22/22（新增 6 例：resume/seek/rate × stop 表驱动，断言 signal 已 abort、零投递、reject 严格等于 `Playback cancelled`、`vi.getTimerCount()===0`；新 play 替换等待中的 seek → `Playback superseded`；pause 撤销等待中的 resume；stop 前的 status 快照不得改写 onState）；五套件合并 49 passed。
- 真实窗口（`src/main/bar-playback.probe.ts` 新例 `r1-stop-cancels-waiting-control`，492 ms）：冷窗未就绪时发起 resume → stop 立即 idle/id null → resume 于 0 ms 以 `Playback cancelled` 失败 → ready 到达后投递序列仅 `[status]`、`status=idle id=null busy=false`；负断言额外要求 `status` 出现在投递序列中，避免空序列假绿。
- 未回退：`status` 仍为纯查询（不取消、无窗口不建窗、立即 idle）；无窗口 `status/pause/stop` 不建窗；自然结束/错误释放 busy 不变；8 s/20 s 预算与轮询节奏未改，无新增固定 sleep。

### 6.3 R2：播放证据绑定被测候选（`0130719`）

- 失败回归在旧实现上真失败：新增 `scripts/compare-app-resources.test.mjs` → `11 tests | 9 failed`，其中 R2 卡在 `expect(evidence.thresholds.playbackFeature.met).toBe(false)`（第 253 行），对应外部「只改 probe `identity.entrySha256` 为 64×`f` 仍 adopted」。
- 修改：`scripts/lib/playback.mjs` 新增 `playbackBindingProblems(identity, build)`，**期望值只取 candidate 的 `meta.build`**，绝不使用 probe 自己给出的哈希；缺 build、非 64 hex、逐值不符分别产出明确原因（如 `playback identity.entrySha256 ffffffffffff does not match the measured build entrySha256 2e6a4ee195f3`）；`playbackGate(baseline, candidate, build)` 增加第三参数并返回 `binding`；必要场景清单增至 6 项（新增 `r1-stop-cancels-waiting-control`），空 cases、缺场景、失败/跳过、缺 `kind`、缺 identity 的既有拒绝全部保留。
- 边界如实声明：candidate `meta.build` 只记录 entry/wrapper/script 身份，"preload/bar.html 未被采样记录，因此不在此逐值核对，仅由探针运行时对磁盘三件产物自检覆盖" —— 未从现在磁盘倒填历史样本。
- 正反向（全部实际执行整个比较脚本）：真实 probe + 真实 candidate → `binding:true`、`checked:["entrySha256"]`；把 entry 改成 64×`f` → 退出码 1、`not-adopted`，原因点名两个哈希；只缺新场景 → 退出码 1（唯一原因是缺场景，身份仍 `binding:true`）；补上该场景后 → `adopted`、退出码 0。反例用 `work/t21-check/` 下的自有副本，未改入库的真实数据。

### 6.4 R3：可比性进入最终采纳判定（`0130719`）

- 失败回归在旧实现上真失败：同上文件卡在 `expect(evidence.comparable).toBe(false)`（第 183 行），对应外部「只改 candidate `meta.build.scriptSha256` 仍 `{"decision":"adopted","comparable":true,…}`」。
- 修改：`scripts/compare-app-resources.mjs` 增加 `DIGEST`/`digestOf`、`buildIdentityKnown`/`sameBuild`/`scriptIdentityKnown`/`sameScript`，`comparable = scenariosMatch && hostMatch && buildIdentityKnown && !sameBuild && scriptIdentityKnown && sameScript`，`adopted = comparable && 九项门槛全部 met`；缺失或非法身份不再靠宽松默认值通过；证据新增 `comparability`（两侧 entry/script 身份与各布尔），`openLatency` 在不可比时附原因，CLI 打印 `[compare] comparable <bool> — …`，未达标仍退出 1。
- 正反向：只改脚本身份的副本 → 退出码 1、`comparable:false`、`not-adopted`；真实输入 → 退出码 0、`comparable:true`、`adopted`。九项门槛阈值一个未动（`memory` −15%/−30 MiB、`noSustainedGrowth` ≤5%、`openLatency` ≤+100 ms、`idleCpu` ≤1.2×、`playbackFeature`、`isolation`、`cpuSelfCheck`、`coldSeparation`、`pillRetired`）。

### 6.5 验证命令与退出码（最终产物上）

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 0 |
| `pnpm exec vitest run src/main/note-audio.test.ts src/main/note-audio-busy.test.ts src/main/bar-ready.test.ts src/main/bar-playback-host.test.ts src/main/bar-retire.test.ts src/main/speech-playback.test.ts scripts/lib/playback.test.mjs scripts/compare-app-resources.test.mjs` | 0；8 文件 91 例（22/5/10/6/7/6/24/11）。外部基点是 7 文件 67 例；本轮增 `bar-retire.test.ts` 与新增比较回归 |
| `pnpm test` | 0；251 文件通过 / 3 skipped，3675 通过 / 8 skipped，101.78 s（日志 `work/t21-run/test.log`） |
| `pnpm build` | 0；14.21 s |
| `PROBE_OUT=work/t21-probe-final pnpm exec vitest run src/main/bar-playback.probe.test.ts` | 0；16/16 全 `real-window`、无跳过，13.9 s |
| `node scripts/compare-app-resources.mjs --baseline=work/t19-run/baseline.json --candidate=work/t21-run/candidate.json --playback=work/t21-probe-final/result.json --output=tests/yu-v2/evidence/electron-playback-binding-20261105.json` | 0；`adopted`、`comparable true` |

如实记录一处副作用：全量 `pnpm test` 会执行探针测试且未带 `PROBE_OUT`，因此覆盖了工作区产物 `work/t19-probe/result.json`（现为 16 例，00:13）。已入库的证据文件与 `work/t20-probe/result.json` 未受影响；本轮正式采样改用独立目录 `work/t21-probe-final`。

### 6.6 资源复查（基线 `0cb30d9` 原样本 + 本轮候选实测）

| 指标 | 基线 `0cb30d9` | 候选（第 1 轮） | 候选（第 2 轮，复测） |
| --- | --- | --- | --- |
| 托盘空闲 60 s 私有驻留 p50 | 94,232,576 B（89.9 MiB） | 56,979,456 B（54.3 MiB），−39.53% / −37,253,120 B | 56,954,880 B（54.3 MiB），−39.56% |
| 稳定 4 s 簇 p50 | 108,011,520 B（103.0 MiB） | 67,162,112 B（64.1 MiB） | 67,153,920 B |
| 20 次开关趋势（16–20 对 1–5） | −10.42% | −11.12% | −11.12% |
| 开关后静止树 | 97.7 MiB（含 1 个 Pill renderer 25.0 MiB） | 66.7 MiB（renderer 0） | 63.5 MiB（renderer 0） |
| 首开 p50 / p95（20 例，0 失败） | 601.208 / 638.689 ms | 582.457 / 733.803 ms（+95.114） | 629.476 / 678.969 ms（+40.280） |
| 重开 p50 / p95（不入门槛） | 267.494 / 316.262 ms | 267.510 / 318.015 ms | 287.197 / 322.830 ms |
| 冷启动树就绪 / Pill 就绪 | 868.524 / 575.562 ms | 759.964 / 不建 Pill | 634.034 / 不建 Pill |
| 空闲 CPU | 30.2 ms/s（1812.5 ms / 60.0 s） | 3.906 ms/s | 0.26 ms/s |
| Pill 场景 | 0 次回收 / 1 take / 1 renderer | 3 / 3 / 3 | 3 / 3 / 3 |
| Run 键与登录项抑制 | — | 8 项前后一致，`diff {added:[],removed:[],changed:[]}`，抑制标记 27 | 同上 |

- 九项必要条件全部 `met`，`decision=adopted`（`memory` −39.53% / −37.3 MB；`noSustainedGrowth` −11.12%，开关后 69,914,624 B、renderer 0；`openLatency` +95.114 ms；`isolation`、`cpuSelfCheck` 1015.625/1001.793 ms、`coldSeparation`、`idleCpu` ratio 0.129、`playbackFeature` bound + 16/16、`pillRetired`）。
- **首开 P95 余量偏薄，如实记录**：第 1 轮 p95 回退 95.114 ms，距 100 ms 门槛仅 4.9 ms；两轮样本分布为 [555…664…936] 与 [570…679…689] ms，第 1 轮有两个 ≥734 ms 的尾部样本（基线最大 663.7 ms），第 2 轮未复现（+40.280 ms）。本阶段改动只在主进程播放控制路径，preload 与 `bar.html` 哈希与阶段 20 相同、渲染器侧未改，故不支持「代码导致变慢」的结论，但也不以复测较好的一轮替代较差的一轮：证据文件保留第 1 轮，第二轮以独立比较输出 `work/t21-run/candidate2-evidence.json` 记录，两轮均达标。
- 另需说明：开关后静止树相对新建空闲为 +22.7%（基线 +8.72%），绝对值 66.7 MiB 仍低于基线 97.7 MiB，且 16–20 周期未见增长；门槛只约束绝对值与停止增长，此相对比例作为观察项列出，不宣称已消除。
- 冷启动 10 s CPU 读数为 0，属调度量子（15.625 ms）以下的量化结果，不等于零 CPU；阶段 19 同口径读到 15.625 ms。

### 6.7 未测与局限

- 未在真实应用里走完随记播放 / 云 TTS 的点击全链路（探针用真实 `bar.html` + preload + 生产接线，但没有真实 TTS 服务与用户笔记）。
- 真实 TTS 音频的停止/暂停语义、语音音量与倍速映射未覆盖；8 s/20 s 预算耗尽路径、不可信 sender 的拒绝仍未构造。
- 页面内 `process.crash()` 不可用（sandbox、无 Node），崩溃仍由 `forcefullyCrashRenderer()` 触发；`cancelUnsent` 未按窗口归属过滤（与阶段 20 同）；`deliver()` 的 `SUPERSEDED` 分支在真实窗口未命中，仅单测覆盖。
- `status` 回执不被取消：stop 前发出的 status 仍会 resolve 自己的（可能过期的）快照，`receive()` 的代次门槛保证它不改 onState/忙态；`NotesPage.tsx` 若恰好用旧快照补发一次 `pause`，对 idle 是空操作，属既有竞态。
- 资源口径仍为隔离 `--user-data-dir` 下、关闭开发实例的全新启动；真实用户开发实例、全部功能开启、小时级碎片、锁屏/RDP、多显示器混合 DPI 未测。平台仅 Windows x64。
- 首开延迟环境波动明显（两轮 p95 差 55 ms），单轮不足以断言无回退；如需强结论应加样本轮次，本轮不加门槛、不改判定规则。

### 6.8 提交与清理

- 提交：`49fb092`（R1）、`0130719`（R2/R3），本文件与证据同批提交；未 push、未打包、未重启用户应用、未改 DSH 插件或旧会话日志。
- 清理：删除本轮探针体 `work/t21-probe/profile-{40060,46032,48668}`、`work/t21-probe-final/profile-54316`（约 7.4 MB → 约 124 KB）；保留 `work/t21-run/`（candidate.json、candidate2.json、candidate2-evidence.json、run/run2 日志与脚本、test.log）、`work/t21-probe*/result.json`、`work/t21-check/`（正反例输入）与阶段 19/20 原始样本；阶段 18/19/20 证据、会话恢复备份与用途不明的目录未动。收尾时无遗留 electron/conhost 进程。

