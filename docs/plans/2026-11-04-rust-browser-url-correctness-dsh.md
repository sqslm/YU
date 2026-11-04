# 阶段 13 续做：浏览器地址读取的正确性修复与验收补齐

**状态：已实施（DSH）。** 基线：`f31e17a`（实现 `4c401f3`）。工作目录：`E:/code/deepseek-harness/rea/typeless`。

**目标：** 修复阶段 13 的文件 URL 兼容、UIA 错误处理和验收缺口，让已经接入的 `browser-url` 有可复现的正确性证据。本轮只续做同一功能，不迁移其他 Windows 操作。

**架构与工具链：** 继续使用一次性 `yu-windows.exe`、已锁定的 windows-rs/serde_json、现有 Electron 运行器及 Vitest；测试 provider 独立于生产 helper。不新增服务、端口、第三方依赖、通用 RPC 或基准框架。

**执行会话：** `session-850bebee-f8e0-47b1-a9c3-29767a917077`。这是下一轮完整任务；DSH 负责实现、真实验证、纠正文档、提交并汇报。不能把上一轮报告中的“仓库接受”当作 Codex 已通过复核。

**主线程派单与执行边界：** 唯一外部规划者是 Codex Desktop 对话 `01a19b72-79e7-7800-b1b5-55aaf2eeaae6`，不是 DSH 内部名为 `codex` 的子智能体。`Team message from codex`、`agent-message` 和 `subagent-settled` 是协作审查资料，不能批准开启下一阶段。只有用户或绑定的外部规划者明确派发的新任务才可以改变开发范围；完成报告后等待下一份外部派单，不自行拟定并实施阶段 16 等后续迁移。

**已有续做的处理：** 已核实 07:54 的“阶段 13 复核通过，可进入阶段 14”来自内部子会话 `e91d9d43-586e-4f65-be8f-cdbd30e312c8`，不是外部规划者的结论。此后 DSH 已开始 Explorer/最近文件迁移。本文件不撤销、删除或覆盖已保存的这些成果，也不占用其阶段编号；接收任务后核对实际 HEAD/状态，停止向新的迁移阶段扩展，优先补齐下列 R1–R5。现有内部审查者也只处理本轮明确范围，不让其消息再次启动下一阶段。若仍有其他执行者修改同一文件，避免覆盖其内容并明确报告冲突；不要混入不属于自己的修改。

## 1. Codex 已核对的交付与问题

工作区起始干净；交付 `yu-windows.exe` 为 392704 B，SHA-256 `52266cd4d331919dc969004128550e7446ccc2eb08b343647270d18f139d9616`，与阶段 13 证据一致。Codex 本轮直接复跑五个 Windows/当前内容相关 TS 文件，149 用例全部通过。没有重跑全部应用测试，也没有启动阶段 13 的 Edge 基准。

这些既有测试通过，不能替代新迁移的分支验收。以下是具体修复依据，按 R1–R5 完成；不要先扩展新功能。

### R1：文件 URL 转换与输入契约不等价

`native/windows/src/address.rs:69` 的 `local_path()` 是手写前缀与 `%XX` 拆解；`:289` 用 `Path::exists()`，而旧脚本使用 `[uri]::LocalPath` 与 `[IO.File]::Exists()`。

Codex 从源码原样提取该函数、用 rustc 编译后，与本机旧 .NET 转换直接对照，得到：

| 输入 | 当前 Rust 函数 | 旧 .NET LocalPath |
| --- | --- | --- |
| `file:///E:/a%20b.html` | `E:/a b.html` | `E:\a b.html` |
| `file:///E:/a.html?x=1#part` | `E:/a.html?x=1#part` | `E:\a.html?x=1` |
| `FILE:///E:/a.html` | 无结果 | `E:\a.html` |
| `file://server/share/a.html` | 无结果 | `\\server\share\a.html` |

这是转换函数对照，不是已完成真实浏览器/共享文件验收。另有两处静态差异：目录的 `exists()` 为真、旧 `File.Exists()` 为假；PS 在 `current-content.ps1:85` 对非空 `expectedPath` 抛错，Rust 完全未处理该字段，阶段 13 文档所写“PS 同样不使用”不成立。

- [ ] 用现有 Windows 系统 URI 转换能力替代简化字符串解析，先对照旧 .NET 再选具体 API；不要为了这个分支引入新 URI 依赖或越写越大的解析器。系统 API 也不能未经对照就声称与 .NET 完全一致。
- [ ] 使用本轮临时文件/目录核对精确返回字段与路径：中文、空格、百分号转义、大小写 scheme、片段、文件不存在和目录；确认普通有效 file URL 不再被遗漏或当成 URL 原样留给 TS 拒绝。不要把不存在文件的转换单测冒充真实 `path` 分支测试。
- [ ] UNC 转换先做不访问网络的路径字符串对照；没有自有可用共享时明确“共享文件存在性未测”，不查询用户共享。不得因“本地优先”擅自删除旧契约允许的形式。
- [ ] 对 `expectedPath` 的实际输入契约恢复与 PS 相同的提前拒绝，并增加反例测试；不要把它扩展成打开 Office 或文件的能力。
- [ ] 原窗口最后一次校验放在所有候选/文件检查完成之后、结果输出之前，文件路径检查也不能越过读后窗口保护。

### R2：UIA 错误被吞，失败时放行属性判断

当前 `documents()` 将 CreatePropertyCondition/FindAll 失败转空集合，`address_bar()` 多处 `.ok()?` 转无地址；`CurrentIsPassword`/`CurrentIsOffscreen` 失败变 `false`，父链 ControlType 失败变 0，ValuePattern 的真实读取失败也全部变“无 Pattern”。阶段 13 文档声称 FindAll/CreateOrCondition 失败会向上返回，与代码不符。

- [ ] 给这些必要读取保留 `Result`，区分“正常没有候选/不支持 ValuePattern”与“UIA/COM 调用失败”。明确允许的未支持返回，其他失败带操作阶段与 HRESULT 非零退出，不把错误改成成功空结果。
- [ ] 密码、可见性、祖先类型无法确认时，不得继续读取候选 Value；不能用 `unwrap_or(false)` 把未知属性当成安全。正常属性值为 false 仍按原规则处理。
- [ ] 覆盖 FindAll、属性读取、父链、Value 读取的代表性失败；至少证明失败后无候选正文输出、无成功 JSON。用小范围替身验证难以稳定制造的 HRESULT，明确哪些是模拟，不新建完整 COM 抽象框架。
- [ ] 正常无 ValuePattern、真正无候选和重复相同值仍可正常返回；错误修复不得变成对所有非浏览器窗口都报错。

依据：[GetCurrentPattern](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationelement-getcurrentpattern) 的成功/错误契约、[CurrentIsPassword](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationelement-get_currentispassword) 的密码属性含义。官方生成绑定返回 Result 不代表可以把每种失败都归为“没有值”。

### R3：补真正的受控 provider 与生产运行器验收

阶段 13 只有五个地址模块单测；没有文档所称的父链/深度/Document 覆盖或去重测试。Edge 中的页面表单没有出现在 UIA 树，不能证明伪地址栏防护有效。`handle + 4` 不是销毁窗口实验；已有父退出测试在 stdin 未 EOF 时退出，证明的是等输入时回收，不能证明 COM 卡住时回收。abort/15s 测试使用 mock 子进程，不能替代新增原生通路。

- [ ] 增加小型自有 UIA fixture（可复用现有 .NET/Win32 测试手段），带正常消息泵，能明确暴露所需树与 ValuePattern；使用非激活窗口，检查前后前台 HWND 未被夺走。不能通过新增真实浏览器窗口来碰用户会话；不使用用户数据或已登录浏览器。
- [ ] 用同一 fixture 同时驱动旧 PS 和交付 Rust，逐字段 deepEqual。至少覆盖：ToolBar/Edit 与 ComboBox、无候选、相同值去重、不同值歧义、Document 唯一 URL 覆盖地址栏和多 Document 歧义、Document 内含 ToolBar 的伪地址栏拒绝。
- [ ] 真实树覆盖密码/不可见、无 toolbar/不能到根、40 层父链边界、前 20 可见 Document 与前 100 Edit/ComboBox 的选择边界。断言 fixture 确实暴露目标控件，不能把“树里没有恶意控件”算防护通过。
- [ ] 有效 HWND 下分别验证错 PID/标题、真实销毁；provider 受控阻塞期间更改标题或销毁目标后放行，验证读后保护。测试延迟/阻塞只能在 fixture 中，不在生产 helper 增加测试开关。
- [ ] 通过真实 `windowsNative` 生产路径（只 mock Electron 路径，不 mock spawn）测试正在 COM 读取时 abort、原有 15s 超时与下一次请求独立。记录实际退出 PID，不能仅断言 Promise rejected。
- [ ] 父退出测试发送完整请求并关闭 stdin，等待 fixture 确认 provider 已进入阻塞，再终止自有父进程；原生 helper 必须随之退出。超时现场和 fixture 也须在 finally 回收。
- [ ] 至少 30 次实际请求启停，逐 PID 确认退出，再用 `process.kill(pid, 0)` 区分已退出/仍存活/查询失败；对探测器做活进程正对照。不能只用“已有 40 次 close”写成已测残留。

不要为这组固定场景建立通用自动化平台。真实 Edge/Chrome/Firefox、UAC/锁屏/RDP 仍可列人工未测；自有 provider 的关键分支验收不能继续拿浏览器环境限制替代。

### R4：基准与清理必须反映实际通过条件

旧证据的结果是 `url: "E:/.../yu-browser-url.html"`，没有 scheme；它只能证明一个地址栏值一致，没有实际经过 Document/file URL 转换或证明 `get_current_page` 返回了可接受的 HTTP URL。`benchmark-browser-url.mjs` 还存在：计时仅比 url、`failures` 在成功列表里计算恒为 0、QueryExtendedLimit 返回未检查、分配 job 失败泄漏句柄、清理只在尾部、超时 60s 超出生产预算、采纳 decision 未受全部 checks 约束。

- [ ] 以 R3 的自有 fixture 替换本轮基准默认的 Edge 启动/枚举/移动/强杀路径。使用固定合成 HTTPS 地址，明确证明 TS URL 过滤可接受；另设 file URL 用例验证 `path`。不再启动浏览器 profile，不从标题变化推断恢复了用户会话。
- [ ] 每条成功样本校验完整预期对象（title/url/path/truncated），准确记录请求/成功/失败及原因；正确性失败不能剔除后宣布采纳。无采样数据/非有限数时显示不可比，不输出伪百分比。
- [ ] 检查 job 创建、分配与查询返回；所有分支关闭拥有的句柄。沿用两侧同法的实际进程累计 CPU/内核私有内存峰值，无需重新设计计量；无法测得时记录不可用，延迟门槛仍可单独判断。
- [ ] 请求预算与生产的 15s 一致；处理 spawn error、stdin error、超时和 fixture 初始化失败。用 try/finally 回收本轮 PID、fixture、临时文件、job；清理不得按全局进程名或未经归属确认的窗口 PID 强杀。清理失败必须报路径与原因。
- [ ] 采纳决定必须同时满足所有必要正确性/生命周期检查与阶段 13 性能门槛；任一必要检查失败时，证据明确未通过、命令非零退出，不能仍报 decision=latency/memory。
- [ ] 同机 PS/Rust/Rust/PS 交错，每侧至少 20 个有效样本；保留原始样本、失败与范围说明。新证据 `tests/yu-v2/evidence/rust-browser-url-correctness-20261104.json`（跨日用实际日期），旧证据完整保留。

### R5：纠正文档的已完成项与事实

- [ ] 更新阶段 13 计划的错误勾选/解释：expectedPath、UIA 错误传播、所谓已覆盖的 Document/父链/去重、读后变化、真实取消与残留。只有新证据确实覆盖后才能勾选，失败或未测保留未勾选。
- [ ] 阶段 13 的原始性能表作为旧测量保留并标明范围；不得把旧 8 checks 写成全面正确性验收。自有 profile 下观察到改标题不等于已证明“恢复用户会话”，删改未经证实的因果断言。
- [ ] 本计划增加“实施结果”：逐项 R1–R5 实现、真实/替身边界、命令/退出码/实际测试数、完整产物哈希、采纳依据、失败/未测项、清理与提交编号；同步总计划及确有行为变化的 README。

## 2. 验证顺序与交付要求

1. 先检查 Git 状态与相关实现，给上述具体差异补反例，再做必要修复。仅修改地址模块、直接相关运行器/测试/fixture/基准与文档，不改无关阶段。
2. `native/windows` 下执行 `cargo fmt -- --check`、`cargo clippy --locked --offline --all-targets -- -D warnings`、`cargo test --locked --offline`；按现有工具链构建交付候选。
3. 运行新增真实 provider/生产路径验收，以及 `pnpm exec vitest run src/main/windows-native.test.ts src/main/windows-native-transport.test.ts src/main/windows-native-process.test.ts src/main/current-content.test.ts src/main/tools/windows.test.ts`（加上新增相关测试），再复测新基准。
4. 实现稳定后执行 `pnpm typecheck`、`pnpm test:native`、`pnpm test`、`pnpm build`，记录真实结果；不放宽超时或删断言。失败先定位，不能仅因文件未改就归因为既有偶发问题。
5. 全部构建链结束后检查最终 `yu-windows.exe` 大小/完整 SHA-256 与入库证据是否一致；如产物改变，确保测的是最终交付。保留按需退出、原父进程保护及无运行时 PS 回落规则。
6. 若本轮仍不能通过必要正确性/生命周期验收，将 `browser-url` 的生产路由整体保留/恢复为 PS，并明确 Rust 只是待验收候选；这是开发采纳决定，不是在运行时失败后重试另一后端。不以性能高为理由跳过验收。
7. 清理本轮自有临时窗口、探针与副本；不删除用户数据、旧证据或既有 Rust 缓存，不重启用户应用。检查 diff，只暂存本轮文件并自动 Conventional Commit，不 push、不打包、不发布。计划新文件被忽略时只对确切路径 `git add -f`。

完成开发与文档后汇报提交编号、R1–R5 对照、最终二进制哈希、实际验证与限制。等待 Codex 复核后再定下一轮，不自行开始其他功能的 Rust 迁移。

## 3. 实施结果

**状态：已实施。** 只改了地址模块、直接相关的测试/fixture/基准与文档，未迁移其他 Windows 操作，未新增依赖或服务。

### R1 文件 URL 与输入契约

- `local_path()` 改为 `PathCreateFromUrlW`（`Win32::UI::Shell`，已有 feature）：先按 `file:` 前缀（大小写不敏感）早退，丢弃 `#fragment`，转换后把 `?query` 拼回（API 会丢 query，`.NET [uri]::LocalPath` 会保留），存在性由 `Path::exists()` 改为 `Path::is_file()`（目录不再算命中）。
- `expectedPath` 非空时在第一次原窗口校验之后、任何 UIA 读取之前抛 `Original Office document is no longer available`，与 `resources/current-content.ps1:85` 一致。
- 读后的原窗口校验移到候选解析与文件检查之后、输出之前。
- 单测 `local_path_matches_the_dotnet_conversion` 覆盖 Codex 给出的四行（`%20`、`?x=1#part`、大写 scheme、UNC）加中文路径与仅 fragment；`local_path_keeps_only_files_as_local_paths` 用临时文件/目录区分 `is_file`。

### R2 UIA 错误不再被吞

- 属性、枚举、父链、取值全部返回 `Result`；失败统一为 `UIA address read failed at {stage} (HRESULT 0x…)` 并非零退出；只有 `UIA_E_NOTSUPPORTED` 视为「控件没有 ValuePattern」，其余错误一律上抛。密码、可见性、祖先控制类型读不出来时不再继续读 Value。
- **本轮实测的边界（结论与派单假设不同，按证据记录）**：进程内 provider 抛出的异常会被 UIA core 吞掉，客户端只看到「没有候选」。`-Mode provider-error` 的 `injected` 事件证明故障确实在 provider 侧触发（`GetPropertyValue(ControlType)`、`Navigate(FirstChild)`），但 PS 基线与 Rust 都返回 `{title, truncated:false}`、exit 0；`root-fragment` 与 `host-hwnd` 两档探针得到同样结论。因此「provider 抛异常」不能作为「两侧都必须失败」的证据，也不是任一实现吞错。
- 客户端可见的故障只有两类，均已断言：**窗口消失**（`destroy` 后两侧 exit 1，同一句 `Original window has changed or closed`）与**读取永久挂死**（`-FailStage unresponsive`，两侧都必须由客户端的 15s 预算终止，实测 15.03s / 15.01s）。

### R3 受控 provider 与生产路径

- 新建自有 fixture `tests/yu-v2/fixtures/uia-provider.ps1` + `uia-provider.cs`：非激活窗口（`WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW` + `SW_SHOWNOACTIVATE`，自检 `uia-foreground.ps1` 断言前后 `GetForegroundWindow` 不变）、自带 `System.Windows.Automation.Provider`，`-Mode` 19 个（含 `file-url`、`provider-error`、`-FailStage`），stdin 命令 `describe/retitle/block/unblock/destroy/quit`，另有 `uia-tree.ps1` 读树与 `scripts/uia-fixture-check.mjs` 自检。目标窗口线程常驻泵消息、stdin 独立线程解析命令——这是「阻塞期间仍能改标题/销毁」的前提。
- `scripts/compare-browser-url.mjs`：同一 fixture 同时驱动 PS 基线（`resources/windows-tools.ps1`）与 Rust helper，逐 mode 比对 `title`/`url`/`path`/`truncated`，17 个 mode 全部一致（`address-edit`/`address-combo`/`document-overrides`/`duplicate`/`deep-40`/`documents-20`/`documents-21`/`edits-100`/`edits-101` 给出地址，`no-candidate`/`ambiguous`/`document-ambiguous`/`pseudo-address`/`password`/`offscreen`/`no-toolbar`/`deep-41` 不给地址）。
- `src/main/windows-native-browser-url.test.ts`：走真实 `windowsNative` 生产路径（只 mock `electron`），7 个用例全通过——正常读取、标题/PID 失配、读中改标题、读中销毁、阻塞中 abort（`Cancelled`，helper 退出，下一次请求独立）、真实 15s 超时（实测 16.9s 含启动开销，helper 退出）、40 次连续请求中用常驻 PowerShell 每 5ms 流式上报 PID，观测到 ≥30 个不同 helper PID 全部已退出，并以 `process.kill(pid, 0)` 做活进程正对照。
- 键序差异（PS Hashtable 按名排序、serde_json 保持自身顺序）不影响下游 `JSON.parse`；两侧比较一律按规范化键序。

### R4 基准

`scripts/benchmark-browser-url.mjs` 整体重写：不再启动/移动/强杀 Edge，改用自有 fixture；请求预算与生产一致的 15s；job 记账（`CreateJobObjectW`/`OpenProcess`/`AssignProcessToJobObject`/两次 `QueryInformationJobObject` 的返回值都检查，句柄用 `CloseHandle` 关闭）；每条样本校验完整 body（`title`/`url` 或 `path`/`truncated`），失败样本进 `invalid[]` 附原因而不剔除；fixture 初始化失败、spawn/stdin 错误、超时、清理失败都计入；收尾只对自己的 fixture 与 helper 发 `quit`/`kill`，不按进程名强杀。

**证据**：`tests/yu-v2/evidence/rust-browser-url-correctness-20261104.json`（`generatedAt` 2026-11-04T01:13:05.793Z，`binary` 430080 B / `303e2772cba7d29330489f8f3436ad3c5cfcb52f075fedcb26940d4665dc0a0e`），80 runs（PS 40 / Rust 40，invalid 0），14 项 checks 全 PASS，`decision = latency`。

| 指标 | PowerShell | Rust | 变化 |
| --- | --- | --- | --- |
| 整次请求 P50 / P95 | 1121.75 / 1183.06 ms | 43.56 / 59.10 ms | −96.12% / −95.00%（P95 −1123.96 ms） |
| CPU（job user+kernel）P50 / P95 | 1953.13 / 2046.88 ms | 31.25 / 46.88 ms | −98.40% / −97.71% |
| 私有内存峰值 P50 / P95 | 76492 / 76756 KB | 2488 / 2560 KB | −96.75% / −96.66% |

`checks` 覆盖：`https-address-identical`、`https-address-expected`、`https-address-accepted-by-consumer`（`browserAddress` 的 http(s)/无凭据/≤2000 过滤）、`file-address-yields-path`、`no-candidate-returns-no-address`、`provider-errors-equal-and-invisible`（含 `injected` 证明）、`destroyed-window-rejected`、`unresponsive-read-hits-budget`、`every-sample-valid`、`samples-per-side`、`measurement-comparable`、`job-accounting`、`cleanup-complete`、`performance-threshold`。

### R5 文档

- 本文件补实施结果；阶段 13 计划的超额勾选按实际证据更正（见该文件「勾选更正」）；`docs/rust-refactor-plan.md` 的阶段 13 段落补续做结果与新证据；README 的 helper 职责描述不变（本轮未改操作集合）。

### 验证命令与退出码

一次连续执行（日志 `/tmp/verify-correctness2.log`），逐条记录：

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `cd native/windows && cargo fmt -- --check` | 0 | — |
| `cargo clippy --locked --offline --all-targets -- -D warnings` | 0 | — |
| `cargo test --locked --offline` | 0 | 18 单测通过（含 5 个地址模块用例） |
| `pnpm exec vitest run src/main/windows-native.test.ts src/main/windows-native-transport.test.ts src/main/windows-native-process.test.ts src/main/windows-native-browser-url.test.ts src/main/current-content.test.ts src/main/tools/windows.test.ts` | 0 | 6 文件 / 156 用例通过（新增 7 个生产路径用例） |
| `pnpm typecheck` | 0 | — |
| `pnpm test:native` | 0 | 39 项通过 |
| `pnpm build` | 0 | built in 14.5s |
| `pnpm test` | 0 | 238 文件 / 3542 用例通过，3 文件 8 用例跳过 |
| `node scripts/benchmark-browser-url.mjs --samples 20` | 0 | 80/80 有效、14 项 checks 全 PASS、`decision=latency` |

收尾校验：`native/bin/yu-windows.exe` 430080 B / `303e2772cba7d29330489f8f3436ad3c5cfcb52f075fedcb26940d4665dc0a0e`，与证据 `binary{}` 一致。

本轮实测暴露并已修复的两处自身缺陷（如实记录，首次链的值不作结论）：`windows-native-browser-url.test.ts` 把采样进程强转成 `ChildProcessWithoutNullStreams` 触发 `TS2352`（`pnpm typecheck` 退出码 2），改为三路 `pipe` 后由类型自然收敛；`benchmark-browser-url.mjs` 末尾残留旧变量 `failures` 触发 `ReferenceError`（基准退出码 1，但 14 项 checks 已全部 PASS），改为读 `cleanupFailures` 后复跑得 0。

### 未测项

- 中文/空格/百分号转义路径的真实文件存在性校验：`file-url` fixture 用 `%TEMP%` 下的 ASCII 路径；转换规则（含中文、`%20`、UNC 字符串形态）由单测覆盖，**UNC 共享的可达性未测**。
- 真实浏览器（Edge/Chrome/Firefox）与密码管理器：本轮全部改用自有 provider，未读用户会话；阶段 13 的 Edge 对照保留为旧测量。
- 锁屏、远程桌面、UAC 提示态下的读取。
- 跨进程 provider（真实浏览器崩溃）导致的 UIA 失败：fixture 的故障注入只能证明进程内异常被 core 吞掉，未覆盖跨进程。
- `metadataOnly` 分支：本轮未构造对应 fixture（`get_current_page` 只用 `browser-url`，`metadataOnly` 属于 `current-content`）。
