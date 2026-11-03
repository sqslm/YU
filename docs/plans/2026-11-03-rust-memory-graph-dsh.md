# 第七阶段：记忆关系图计算评估与 DSH 实施计划

> **执行者：DSH，继续现有 typeless 对话和工作区。** 按顺序实施、验证并自行回写文档和提交；完成后停止，不自动开始下一阶段，不要求 Codex 监听开发过程。

**状态：待实施。** 本文记录开发要求，未勾选项均未经本轮实现和验收。

**目标：** 先核清阶段 6 的测试与性能证据，再评估关系图余弦计算的 Rust 净收益；保留 Electron 和本地记忆行为。

**架构：** SQL、元数据、业务规则和 worker 生命周期保留 TypeScript。对照原版 TS、最小 TS 算法改善、Rust 批量纯计算，计入打包缓冲区和 FFI 成本，只采纳一个有实际收益的最小方案。Rust 候选沿用现有 Koffi/CDLL 方式，在记忆 worker 内加载，不加进截图 DLL，不增加进程、监听端口、线程池或通用后端框架。

**工具链：** 当前固定依赖、Rust MSVC、Koffi、Electron、Vitest。复用 E 盘模型和缓存，不升级依赖，不下载模型，不复制 node_modules 或整个项目。

**评估基线：** `00d652c`（阶段 6 交付），前置对照 `872e5b5`（阶段 6 之前）。开始时核对 HEAD、AGENTS.md 和 Git 状态，保留现有未提交内容。只在当前分支工作，不 push、merge、rebase 或重写历史。

## 1. 已确认事实与候选选择

- `src/main/memory/catalog.ts` 的 `graphLinks` 对最多 200 条向量双重遍历；正常向量为 SQLite float32 存储的 512 维数据，JS 以 double 累加。来源交集、余弦、排序和去重均在该函数内。
- 调用链为 `MemoryGraph.tsx` 的打开/分类/筛选/刷新（250ms 防抖）→ host `graph` → worker → `readGraph` → `readCatalog` / `graphLinks`，计算已经在独立记忆 worker，不应称作主进程阻塞优化。
- 本轮规划时仅用合成数据做了快速探针：Windows Node 24.14.0，当前源码经 TypeScript 转译，5 次预热、30 次采样，20/80/200 节点、512 维的 `graphLinks` P50 约 0.157/1.251/7.859ms，P95 约 2.724/1.560/9.054ms。输入为固定种子的 float32 值，未读用户库。小样本抖动明显；这不是正式 Electron 或端到端结果，不用于宣称收益。
- 阶段 5 的 1000 条召回已约 11ms（含嵌入），本轮不把召回一并重写。ASR、SDK 写入、模型、前台窗口、文本注入和存储格式均暂缓。

## 2. 前置任务 A：核清上一阶段遗留证据

涉及 `scripts/benchmark-capture.mjs`、`tests/yu-v2/fixtures/capture-electron.cjs`、`src/main/wake-word-native.test.ts`、阶段 6 计划和证据报告。

- [ ] 在相同 Node/Electron、依赖、模型/测试资源和环境下，单独复现两项真实唤醒测试失败，再用 `872e5b5` 的相关源码复现。优先用 `git show` 获取必要源码和隔离测试目录；若必须增加临时工作副本，只携带必要受跟踪文件并复用依赖，不切换/覆盖当前工作区。
- [ ] 记录命令、退出码、实际失败信息、测试资源哈希和比较范围。只有旧代码在同环境确实失败，才能记录为既有/环境问题；仅凭文件未修改不能下结论。禁止跳过测试、降低阈值、改期望或把失败改成成功。有本轮回归则先解决，无法定位则保留阻塞项，不能写“全量通过”。
- [ ] 追查阶段 6 的约 69MB→6.5GB 私有内存增长。按 A/B/C 分开统计预热、分批采集、释放引用、让出事件循环、空闲后的 `heapUsed/external/arrayBuffers`、Electron 私有/驻留内存及 GDI/USER 句柄；原生 NativeImage 占用不能只靠 V8 heap 判断。
- [ ] 同样的批量与回收条件用于所有变体，计时区外处理事件循环/可选诊断 GC；区分自然空闲和强制 GC 结果。禁止给生产代码加 GC、无限等待或掩盖增长的缓存。限制批量像素总量，出现持续增长及时终止，不再故意堆到数 GB。
- [ ] 用证据区分基准同步循环造成的延迟回收与生产路径实际泄漏；若是生产回归，补直接回归后做最小修复，若是旧实现问题只在必要范围定位和说明，不顺带重构截图模块。
- [ ] 在内存稳定、测量条件一致后复跑相关 A/B/C 延迟；若结论改变，修订阶段 6 结果。原始异常报告保留，另存有时间与基线标识的新证据，不能覆盖旧报告后声称从未失败。
- [ ] 修正文档/注释中的事实错误：当前缓存的是 9 个 API，不是 10 个；尚无证据证明“解析导出的成本超过 GDI 本身”。句柄零增长只证明被统计句柄稳定，不能证明所有内存无泄漏。

验收：能明确说明失败来源和内存增长原因、测量有效性及剩余限制。若这些问题使后续结果无法可信评估，先交付核验/修复并在文档保留关系图任务待办，不勉强继续迁移。

## 3. 任务 B：建立真实关系图基线

涉及 `src/main/memory/{catalog,worker,host}.ts`、对应测试、`src/shared/memory.ts`、`scripts/benchmark-model-workers.mjs`（参考）、`tests/yu-v2/fixtures/model-worker.cjs`（参考）。新探针建议 `scripts/benchmark-memory-graph.mjs`、`tests/yu-v2/fixtures/memory-graph-electron.cjs`，报告 `tests/yu-v2/evidence/rust-memory-graph-20261103.json`；新增脚本须按仓库 allowlist 更新 `.gitignore`。

- [ ] 用固定种子构造隔离 SQLite 合成库，覆盖 20/80/200 节点、512 维、两种类别、其他用户、多个来源、相似/不相似数据。额外用超过 200 条的库验证筛选在截断前执行；不读取用户库或学习真实内容。
- [ ] 在实际 Electron 记忆 utility process 中分层记录 SQL/JSON/向量解码、余弦、来源/选边、完整 `readGraph` 和一次 host→worker→host；保持原 worker 启停/超时方式。renderer 布局、力导向渲染和 250ms 防抖单独说明，不冒充算法耗时。
- [ ] 报告首次加载、热调用 P50/P95、批量 CPU、峰值与空闲后私有/驻留和 JS/外部分配；分开记录生产与探针内存。基线、TS 控制、Rust 至少三轮交错顺序，每轮预热后不少于 30 个有效样本，保持每种数据一致。
- [ ] 使用 CPU 采样确认图计算是否主导。先测原版，再做最小 TS 控制方案，例如每对向量只计算一次且复用结果；保留逐行选边顺序与语义，不因“去重”改变每节点的前三名规则。不引入常驻全库缓存、ANN、索引服务或图数据库。

## 4. 任务 C：Rust 候选与采纳门槛

只有任务 B 确认仍有值得优化的计算成本才创建 `native/memory-graph/` 和候选包装模块 `src/main/memory/graph-scores.ts`。若 TS 已足够，直接进入验证与交付，记录未创建 Rust 的原因。

- [ ] Rust 仅批量计算余弦/范数，SQL 与 `MemoryGraph` 组装仍由 TS 执行。一次请求批量传递连续数值缓冲区，禁止每条边单独跨 FFI。可用 Float64 输入保持现有 JS 数值；报告打包耗时、字节数和结果矩阵成本，不把磁盘 float32 擅自替换为低精度累加。
- [ ] 在实现前固定并记录 C ABI：明确输入指针/长度/维数、输出容量和状态码；双侧检查乘法溢出与缓冲区长度。输入只借用、不修改或保留，输出调用方持有，返回后无 Rust 堆指针。维数/缺向量/异常数值须保持已有函数行为，不为了正常 512 维路径破坏现有短向量测试。
- [ ] 保持 f64 乘法、按维度顺序累加和现有零范数判断；不启用 fast-math、重排求和、显式融合乘加或低精度 SIMD 来换取改变阈值的结果。允许计算对称项一次，但需证明完整输出一致。
- [ ] 生产候选测量必须包含 JS 取数、打包/分配/拷贝、Koffi 调用和业务选边。不得仅给 Rust 内部循环耗时，不能沿用阶段 4 截图收益。
- [ ] 默认采纳条件：200 节点真实 Electron `readGraph` 的热 P50 相比最佳 TS 控制同时改善至少 20% 和 2ms；三轮方向一致，P95 不出现超过 `max(1ms, 5%)` 的稳定退化；20/80 节点不出现超过 0.5ms 的稳定退化。报告冷加载成本与分配峰值，不能用明显内存增长换小幅提速。
- [ ] 未达门槛就不把候选接入生产构建/安装资源；若最小 TS 改善有可靠净收益，只交付它。若两者都无实际收益，保留当前生产实现并交付真实评估证据，不为满足“Rust 阶段”强行上线。
- [ ] 仅在采纳 Rust 后修改 `scripts/build-native.mjs`、`electron-builder.yml` 与需要的 worker 入口；DLL 开发/打包路径和首次使用加载须在实际 utility process 验证。沿用现有静态 CRT 和本地资源管理；不增加 npm/crate 依赖，无 DLL 静默回退或错误吞掉。

## 5. 行为不变与针对性验证

- [ ] 从 `00d652c` 提取独立基线 oracle，做固定种子差分，比较完整 links 的 source/target/type/score 和顺序；覆盖空/单节点、短向量、长度不同、缺向量、零向量、正交/负相关/重复、不同范数、同分、0.78 阈值两侧及 NaN/非有限数的原行为。确定性数据先记录原结果，不用重写的新算法当 oracle。
- [ ] 保留来源 ID 的逗号分隔、空值/`manual` 排除、共同来源优先于相似、每节点先截前三名再无向去重、最多 200 节点；分数不因重排改变入选边或排序。有限分数目标为逐值一致，特殊数值分类一致；差异必须定位，不能仅放宽分数容差。
- [ ] 保留类别/用户过滤、文本筛选先于 LIMIT、节点排序/总数与读取只读性；合成库读前/后哈希一致。保留现有 `catalog.test.ts` 及学习隐私测试，禁止修改用户库、重嵌入、迁移格式或在日志打印真实记忆。
- [ ] 学习仍仅限 Ask 原话和明确偏好反馈，附件、文件、网页、剪贴板与听写不得进入自动学习；记忆的编辑/删除/临时会话边界不变。不改模型或 SDK 写入流程。
- [ ] 相关检查：`pnpm exec vitest run src/main/memory/catalog.test.ts src/main/memory/host.test.ts`，再运行实际改动涉及的 worker/学习/截图回归；`pnpm typecheck`、`pnpm test`、`pnpm build`。把实际通过/失败/跳过数量分开记录，不照抄上一阶段数量。
- [ ] 若创建 Rust 候选，在对应 crate 运行 `cargo fmt -- --check`、`cargo test --locked --offline`、`cargo clippy --locked --offline --all-targets -- -D warnings`；采纳后运行 `pnpm test:native` 并核对 DLL 的 x64、固定导出、依赖与 SHA-256。未采用的打包验收标记为“不适用”，不能勾成成功。
- [ ] Rust 方案的差分须真实调用 DLL；JS mock 单测与实际 Electron utility process 验证分开记录。不开正在使用的个人关系图，不触发学习，不重启用户开发版。

## 6. 文档、提交与停止条件

- [ ] 开始时将本文件改为“实施中”；结束时按实际结果填写“已完成评估/采用 TS/采用 Rust/阻塞”，不能把全部待办机械勾选。
- [ ] 追加“实际实现与验收结果”：前置问题根因、基线/最终提交、采用方案与文件/ABI、命令和退出码、各轮原始数据、延迟/CPU/内存测量范围、局限与未测项；修订阶段 6 的不准确结论并保留旧证据。
- [ ] 更新 `docs/rust-refactor-plan.md` 的阶段 6/7；README 与 README.en.md 只在现行架构或命令变化时同步，不写未上线的 Rust 能力，不创建重复总结文档。
- [ ] 清理本轮可重建的隔离库、测试 profile 和暂存；先确认进程退出、路径属于本轮，保留必要证据与有效交付。不要删除历史未知目录、现有模型、用户数据、依赖或其他任务产物；报告主要新增/回收占用。
- [ ] 检查 Diff，只暂存本任务文件，必要验证通过后自动 Conventional Commit；只核验/修复、TS 优化、Rust 实现须按真实内容命名。失败测试若证实基线也失败，明确记录该例外；未证实的回归不作为完成交付。
- [ ] 在当前 DSH 对话回复完成项、测量范围、验证/失败与未测项、文档路径和 commit hash，然后停止。**不要监听 Codex，不自动开始下一阶段，不 push、发布、打安装器、修改用户设置或自动重启开发版。**

## 官方依据

- [Koffi 指针与数组](https://koffi.dev/pointers)：批量借用数值缓冲区，明确长度与生命周期。
- [Rust f64 与融合乘加](https://doc.rust-lang.org/std/primitive.f64.html#method.mul_add)：保持现有浮点计算顺序，不把不同舍入语义视为等价。
- [Node 24 process.memoryUsage](https://nodejs.org/docs/latest-v24.x/api/process.html#processmemoryusage)：区分 heap、external、arrayBuffers 与 RSS，并结合 Electron 私有内存取样。
