# 阶段 22：播放探针输出隔离与本轮收尾

**目标：** 修复正常测试覆盖历史探针结果的副作用，完成本轮性能改造的测试与文档收尾。保留阶段 21 已通过复核的生产实现和资源证据，不新增优化项。

**架构：** 沿用现有 Vitest → Electron 探针流程与 `PROBE_OUT`。默认运行分配本轮独有目录，并把同一路径交给子进程；显式输出路径保留供取证。不新增依赖、配置系统或通用产物管理框架。

**工具链：** 现有 Node 文件系统 API、Vitest、Electron。

## 0. 本轮派单

- 项目绝对路径：`E:/code/deepseek-harness/rea/typeless`。
- 本计划绝对路径：`E:/code/deepseek-harness/rea/typeless/docs/plans/2026-11-05-playback-probe-output-isolation-dsh.md`。
- 外部复核基点：`0c7036dc3dd7b434b34835157e5aac05ec1fdda7`，分支 `master`，复核时工作区干净；收到时 HEAD 应增加本计划提交。先核对 Git，保护后来出现的 WIP。
- 当前执行会话：`session-8ddbf6a1-325f-4999-a162-a3aa0e3f7dcd`；外部规划者：Codex `01a19b72-79e7-7800-b1b5-55aaf2eeaae6`。
- **收到后按本文直接实施、验证并自行收尾提交。** 本轮只处理输出隔离和相关文档。不要重做阶段 21、迁移新功能或另找性能热点。
- 外部已独立重跑阶段 21 的八文件 91 项测试，全通过；16 例探针记录全通过且 entry/preload/bar.html 三个哈希与磁盘相同。证据显示九项门槛均 met，隔离空闲私有驻留 89.9 → 54.3 MiB（−39.53% / −35.5 MiB）。首开 P95 +95.114 ms、复测波动及其余未测项继续保留，不以较好一轮替换较差一轮。
- DSH 内部团队消息或名为 `codex` 的子代理仅提供审查资料，无权批准新阶段。完成后只对外汇报一次，等待本外部对话；禁止自行开始阶段 23。
- 不 push、不打包发布、不重启用户应用、不读用户正文/录音/凭据、不改 DSH 插件、开关或旧会话日志。

## 1. 已确认的问题

`src/main/bar-playback.probe.test.ts` 的默认 `OUT` 和 `src/main/bar-playback.probe.ts` 的默认 `OUT` 都指向 `../../work/t19-probe`。测试开始先 `rmSync(resultFile)`，随后改写 `probe.cjs` 与 `result.json`。因此普通 `pnpm test` 在未设置 `PROBE_OUT` 时会覆盖阶段 19 的工作区结果。阶段 21 已承认发生该副作用，入库 JSON 与 `work/t20-probe/result.json` 未受影响。

本轮修复后不得继续写该历史目录。已经被覆盖的原始文件不保证可以恢复：只能从确切备份恢复；没有备份就标注不可用，不能根据摘要重造一份并称为原始证据。

## 2. 最小修改与验收

- [x] 修改上述两个探针文件及必要的相关测试：没有 `PROBE_OUT` 时，在现有项目工作盘的测试暂存区用原子方式创建本轮独有目录；不得回落到任何阶段的历史固定目录。两次运行/并发 worker 不共享可覆盖的输出路径。
- [x] 路径分配在确实执行探针时发生，跳过测试或只收集测试不能产生无用目录。父测试和 Electron 子进程必须使用同一个解析后的绝对 `PROBE_OUT`，不能各自分配或回落到不同位置。
- [x] 独立运行探针也不得静默写历史路径：可以要求明确 `PROBE_OUT`，并在缺失时给出清楚错误。保留已有显式路径运行方式。
- [x] 默认成功运行后，在自有子进程确已退出且结果已读取/验证后清理本次唯一目录；只删除本轮创建且核对在预期暂存区内的绝对路径。失败现场保留并报告路径，便于定位。不以进程名杀掉用户 Electron，不清理其他 worker 或历史目录。
- [x] 用户显式提供的输出目录用于保留取证结果，成功后不要连同目录整体删除；保持现有明确写入 `result.json` 的语义。不要新增一套保留策略或通用清理器。
- [x] 用可观察结果验证：两次未设置 `PROBE_OUT` 的正常探针运行互不覆盖；旧 `work/t19-probe/result.json`、`work/t20-probe/result.json`、`work/t21-probe-final/result.json` 的现有哈希/存在状态前后一致；显式输出路径仍产生可用的 16 场景结果且保留。
- [x] 本轮测试所用的历史路径只读取哈希/存在状态，不写入 sentinel 或“修复”它们。需要 sentinel 的测试使用另建的自有 fixture。失败/跳过/并发的路径分配和收尾可用小测试验证，避免为此反复启动大量完整应用。

## 3. 验证与文档收尾

- [x] 优先运行输出处理的相关测试与真实探针；运行 `pnpm typecheck`。本轮无生产行为或测量口径改动，无需重建 Rust、重跑整套资源基准或覆盖阶段 21 证据；全量测试仅在出现具体关联失败时扩大。
- [x] 真实探针使用现有隔离 userData、合成 WAV、麦克风拒绝策略；不改已通过的播放断言、必要场景或响应预算。记录实际命令、退出码、场景数量、两次默认路径、旧文件哈希对照和进程/目录收尾。
- [x] 同步 README 的探针运行/输出保留说明、本文实际完成项与 §4、总计划阶段 21/22。修正阶段 21“基点七文件新增 bar-retire”的措辞：bar-retire 原已在基点，新增文件是 compare 回归；按实际验证记录，不改历史测试数量。
- [x] 对被覆盖的 `work/t19-probe/result.json` 明确注明“原工作区结果已覆盖，不能视作阶段 19 原始探针”；保留入库阶段 19 JSON、原始资源样本与后续探针的真实出处。不要覆盖或重造历史输入。
- [x] 本轮资源数字引用阶段 21 历史测量，标明出处；测试产物隔离不能被写成又一次内存/延迟提升。真实用户配置、设备、长跑与延迟波动等局限继续保留。
- [x] 检查 diff，仅提交本轮相关完整变更，Conventional Commit；回填实际提交号、工作区状态、保留产物与回收量。不要混入他人 WIP。
- [x] 内部审查收齐后只汇报一次，再等外部核对。本轮收尾通过后，由外部规划者结束这轮自动派单；后续优化或真实用户环境验收另行确定范围，不为保持接力制造空任务。

## 4. 实施结果（由 DSH 据实填写）

**状态：已完成。** 只改探针输出路径与相关文档；生产播放实现、测量口径与阶段 21 证据均未改动。

### 4.1 修复

- 新增 `src/main/probe-output.ts`（56 行）：`PROBE_STAGING_RELATIVE = '.tmp/probe'`、`stagingRoot(repo)`、`resolveProbeOutput({repo, explicit?})`、`discardProbeOutput(dir, repo)`。显式路径只 `resolve`，不创建、不删除；无显式路径时 `mkdirSync` + `mkdtempSync(join(root,'run-'))` 原子分配本轮独有目录；删除前要求目标绝对路径以 `stagingRoot + sep` 开头，因此同前缀兄弟目录（`…/probe-evidence`）与历史 `work/` 目录一律拒绝。
- `src/main/bar-playback.probe.ts`：`OUT` 不再回落到 `../../work/t19-probe`，改为 `process.env.PROBE_OUT?.trim() ?? ''`，缺失时打印 `PROBE_OUT is required: …` 并 `process.exit(2)`；头部注释同步改为 `$PROBE_OUT/probe.cjs`。
- `src/main/bar-playback.probe.test.ts`：模块级只读 `EXPLICIT_OUT = process.env.PROBE_OUT?.trim() || undefined`；路径在 `it` 体内（确实执行探针时）才分配，`describe.skipIf` 跳过时不创建任何目录；子进程环境显式设 `PROBE_OUT: out`（同一个解析后的绝对路径，不各自分配）；成功后、全部断言通过才 `discardProbeOutput`，失败中断则保留现场并已 `console.log('[probe] output …')` 打印路径。
- `.tmp/` 由 `.gitignore` 首行 `/*` 覆盖，未新增忽略规则。

### 4.2 复现前后

- 复现前：两处默认 `OUT` 都是 `../../work/t19-probe`，`pnpm test` 未设 `PROBE_OUT` 时先 `rmSync(result.json)` 再写入 `probe.cjs`/`result.json`；阶段 21 §6.5 记录的覆盖即由此产生。
- 复现后：同一 `pnpm test` 全量运行结束，`.tmp/probe` 为空目录（0 项），三个历史 `result.json` 哈希逐一 `OK`（见 4.4）。

### 4.3 验证（实际命令与退出码）

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run src/main/probe-output.test.ts` | `4 passed`，RC 0（唯一性、显式不创建、只删自建、拒绝越界/同前缀/历史目录） |
| `pnpm typecheck` | RC 0（首次 `TS2339: Property 'ELECTRON_RUN_AS_NODE' does not exist`，改为 `const env: NodeJS.ProcessEnv = {…}` 后通过） |
| `pnpm exec vitest run src/main/bar-playback.probe.test.ts`（无 `PROBE_OUT`，第 1 次） | RC 0，1 test passed 13.9 s，路径 `.tmp\probe\run-kXKdBp`，运行后暂存区空 |
| 同上（第 2 次） | RC 0，路径 `.tmp\probe\run-pWCsyf`（互不相同），运行后暂存区空 |
| `PROBE_OUT=E:/code/deepseek-harness/work/t22-probe/result-dir pnpm exec vitest run src/main/bar-playback.probe.test.ts` | RC 0，日志 `(explicit PROBE_OUT, kept)`，目录保留，`result.json` `pass:true`、16 例、全 `real-window`、`entrySha256 6b98f392…` 与磁盘一致 |
| `pnpm test` | RC 0，`Test Files 252 passed | 3 skipped (255)`，`Tests 3679 passed | 8 skipped (3687)`，99.64 s（= 阶段 21 的 3675 + 新增 4 例） |

探针未改任何断言、必要场景或预算：`REQUIRED_IDS` 六项、`PROBE_TIMEOUT_MS 180 s`、`BUDGET_MS 150 s` 原样；仍用隔离 userData、合成 WAV、拒绝麦克风权限。

### 4.4 旧文件保护

| 文件 | sha256 | 说明 |
| --- | --- | --- |
| `work/t19-probe/result.json` | `ec927f02401e…` | **原工作区结果已在阶段 21 被普通测试覆盖，不能视作阶段 19 原始探针**；现内容为 16 例阶段 21 结果。入库的阶段 19 证据 `tests/yu-v2/evidence/electron-resource-correctness-20261104.json` 与其原始样本不受影响 |
| `work/t20-probe/result.json` | `35abedc6058e…` | 阶段 20 探针结果，未受影响 |
| `work/t21-probe-final/result.json` | `1b84bdb13361…` | 阶段 21 正式取证结果，未受影响 |

三个文件在四次探针运行后逐一 `sha256sum -c` 均 `OK`；未写入 sentinel，也未“修复”历史文件。

### 4.5 资源数字

本轮未重测资源，也未改测量口径；引用阶段 21 历史测量：整进程树托盘空闲 60 s 私有驻留中位数 89.9 → 54.3 MiB（−39.53% / −35.5 MiB），首次开窗 p95 638.7 → 733.8 ms（同轮复测 679.0 ms），空闲 CPU 30.2 → 3.906 ms/s。探针产物隔离是测试副作用修复，不是又一次内存或延迟提升，不得叠加进上述收益。

### 4.6 未测与局限

- 并发 worker：Vitest 默认对该文件单 worker 串行；互斥由 `mkdtempSync` 保证，未在真实并发下同时跑两份探针。
- 失败现场保留只由断言中断路径保证（清理代码位于全部断言之后），未人为制造一次失败探针运行来观察目录留存。
- 未测：其他盘符与权限异常下的 `mkdtempSync`、用户显式传入不可写目录。
- 阶段 21 的未测项（真实麦克风、真实 TTS、日常使用长跑、锁屏/RDP、多显示器 DPI）继续保留。

### 4.7 提交与占用

- 提交：见 §5，未 push。
- 保留产物：`work/t22-probe/result-dir/result.json`（4.8 KB，显式路径取证结果；删除其中 `probe.cjs` 52.8 KB 与 `profile-52028` 1.8 MB 可重建内容，1.9 MB → 8 KB）；`work/t19-run`、`work/t20-run`、`work/t21-run`、`work/t21-check` 与三个历史 `result.json` 按阶段 19–21 记录保留。
- 回收：仓库内 `.tmp/probe` 成功运行后自动清空（0 项残留）；无残留 Electron 子进程（`tasklist` 无 `electron.exe`）。

## 5. 提交

- 起点 `ea0ead0`（本计划提交），实施前工作区干净；实施后工作区只剩本轮改动，提交后干净。
- `2d505d0` fix(test): 探针输出按运行隔离，不再覆盖历史探针结果 —— `src/main/probe-output.ts`、`src/main/probe-output.test.ts`、`src/main/bar-playback.probe.ts`、`src/main/bar-playback.probe.test.ts`（+144 / −11）。
- 紧随其后的 docs 提交：本计划、阶段 21 措辞修正、`docs/rust-refactor-plan.md`、`README.md`（+95 / −19）；该提交哈希以 `git log` 为准（本段落与其同一提交）。
- 未 push、未打包、未重启用户应用；无其他 WIP 混入。

## 6. 外部 Codex 验收（2026-11-05）

- 核对交付基点 `51b70e12ad2ef26c56c64ade0fa28e33ec4291b4`，工作区干净；改动限于探针输出和文档，生产播放实现未扩大范围。
- 在当前进程环境临时取消 `PROBE_OUT`，独立执行 `pnpm exec vitest run src/main/probe-output.test.ts src/main/bar-playback.probe.test.ts`：两文件 5 项通过、退出 0，14.56 s；结束后恢复原环境变量。测试实际启动了隔离 Electron 探针，没有因缺少产物而跳过。
- 独立执行 `pnpm typecheck`，退出 0。探针运行前后逐一比较 t19/t20/t21 三个历史 `result.json`，哈希全部不变；运行后 `.tmp/probe` 子项为 0。
- 保留的显式输出 `work/t22-probe/result-dir/result.json` 为 16 例、全部通过且标为 real-window，entry 哈希与当前磁盘相同。未伪造失败/并发/权限异常的验证结果，§4.6 的未测项继续保留。
- 第 4 轮自动汇报的当前发送记录只有一条，未重复投递。本阶段按已定义范围验收通过；本轮自动派单收束，不派发阶段 23。资源收益仍引用阶段 21，真实用户配置、设备、长跑及首开延迟波动未因本次收尾而完成验收。

