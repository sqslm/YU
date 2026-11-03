# 阶段 13 续做：浏览器地址读取的正确性修复与验收补齐

**状态：待 DSH 实施。** 基线：`f31e17a`（实现 `4c401f3`）。工作目录：`E:/code/deepseek-harness/rea/typeless`。

**目标：** 修复阶段 13 的文件 URL 兼容、UIA 错误处理和验收缺口，让已经接入的 `browser-url` 有可复现的正确性证据。本轮只续做同一功能，不迁移其他 Windows 操作。

**架构与工具链：** 继续使用一次性 `yu-windows.exe`、已锁定的 windows-rs/serde_json、现有 Electron 运行器及 Vitest；测试 provider 独立于生产 helper。不新增服务、端口、第三方依赖、通用 RPC 或基准框架。

**执行会话：** `session-850bebee-f8e0-47b1-a9c3-29767a917077`。这是下一轮完整任务；DSH 负责实现、真实验证、纠正文档、提交并汇报。不能把上一轮报告中的“仓库接受”当作 Codex 已通过复核。

**并行工作提示：** Codex 准备本文件期间，工作区出现了 Explorer 阶段 14 的未提交源码与文档；本文件不覆盖或提交这些改动，也不占用阶段 14 编号。接收任务后先核对实际 HEAD/状态，优先补齐本次复核问题；若另一个执行者仍在修改同一文件，避免覆盖其内容并明确报告冲突。不要删除、回滚或混入不属于自己的修改。

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
