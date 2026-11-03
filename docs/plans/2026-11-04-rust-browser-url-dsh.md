# 阶段 13：浏览器地址读取的 Rust 迁移与验收

**状态：待 DSH 实施。** 基线：`903d88d`，工作目录 `E:/code/deepseek-harness/rea/typeless`。

**目标：** 保留 Electron 外壳，减少 `get_current_page` 读取当前浏览器地址时启动 PowerShell、加载 .NET/UIA 的成本。行为一致、取消与资源回收通过且实测收益达标，才接入生产；没有收益可以保留原实现并如实结项。

**执行会话：** `session-850bebee-f8e0-47b1-a9c3-29767a917077`。本文件就是本轮完整开发要求，不需要复制旧会话历史。完成后由 DSH 更新本计划、总计划及实际改变的 README，记录验证、限制、最终产物哈希和提交编号，再汇报 Codex。

## 1. 接手背景与边界

阶段 1–12 的实现和结果见 `docs/rust-refactor-plan.md`。热键、焦点 UIA、四项 Windows 操作、滚动匹配、唤醒及本地 TTS 已完成相应阶段；截图和记忆图曾因收益不成立保留 TS。本轮不重做这些阶段。

阶段 12 的提交为 `9c07ce7`、`ad08ca8`、`903d88d`；Codex 已核对入库证据的 12 项检查、有效样本计数及 `yu-speech.exe` 哈希一致。这不等于重新执行过其全部验证命令，真实音频设备等未测项继续保留。

本轮只迁移 `windowsNative({ action: 'browser-url', handle, pid, title })`。复用现有一次性 `native/windows` → `native/bin/yu-windows.exe`，不新增常驻服务、端口或另一个可执行文件。TypeScript 的工具编排、URL 过滤、权限与文件访问限制继续承担原职责。

`current-content` 的网页正文、Explorer/Office 读取，`explorer-folder`、应用枚举、激活、搜索、最近文件均不在本轮迁移范围。不要把任意窗口树读取塞入常驻焦点 UIA helper。不要顺带改模型、存储、学习范围、云服务或界面。

## 2. 开始前核对与修改入口

- [ ] 检查 Git 状态及 HEAD，保留现有修改；后续如发现并发改动，提交时只收本轮文件。
- [ ] 阅读 `src/main/windows-native.ts` 与三个 `windows-native*.test.ts`、`src/main/tools/windows.ts`、`src/main/current-content.test.ts`、`src/main/tools/windows.test.ts`，确认冻结目标与 `browserAddress` 的调用边界。
- [ ] 对照 `resources/windows-tools.ps1` 的 `Assert-OriginalWindow` 和 `resources/current-content.ps1` 的地址读取分支，先形成对照用例，再实现 Rust。
- [ ] 阅读 `native/windows/src/{main,operations,input}.rs`、`Cargo.toml`，参考 `native/uia/src/reader.rs` 的官方 COM 绑定及 RAII；不复制整个模块或建立跨 crate 通用框架。

建议在 `native/windows/src/` 增加专用地址读取模块，并在 `operations.rs` 增加一个分支；沿用已锁定的 `windows`、`serde_json` 版本，只补确有需要的 Windows SDK feature。不要新增第三方依赖或升级工具链。

官方依据：[UIA 客户端线程模型](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)要求使用不拥有窗口的 MTA 线程；[UIA 树及 Control View](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-treeoverview)说明视图与 provider 的关系。文件 URL 可评估系统 [PathCreateFromUrlW](https://learn.microsoft.com/en-us/windows/win32/api/shlwapi/nf-shlwapi-pathcreatefromurlw)，但必须通过与旧 .NET URI 的实际兼容对照，不能仅凭 API 名称认定等价。

## 3. 必须保留的行为

### 3.1 目标与协议

- [ ] 输入继续经 stdin JSON，输出一份 JSON 后换行；只处理一次请求，结束即退出，不把 URL、标题或用户路径放到命令行、诊断和性能证据中。
- [ ] 操作前和取得结果后，检查同一个十进制 HWND、PID、大小写敏感的标题；失配、销毁时非零退出，不能先输出可用结果再报错。保留旧脚本 1024 单元标题读取边界。
- [ ] 不重新取前台窗口，不激活窗口、不操作剪贴板、不模拟按键；仅观察冻结窗口对应的 UIA 树。不读取浏览器配置、历史、cookie、登录数据，不发网络请求。
- [ ] 不能直接调用现有 `window-check` 而意外新增“最小化即报错”等旧 `browser-url` 没有的规则；只在确有重复时提取最小的目标校验代码，四个既有 native action 的行为保持兼容。
- [ ] 返回字段保持旧接口：`title`、`truncated: false`，有把握时才有 `url` 或 `path`；没有地址是正常的无对应字段结果。地址原值继续交由 TS 过滤和规范化，不用标题猜测，不新增浏览器进程白名单。
- [ ] 保留实际输入中的 `metadataOnly` 和 `expectedPath` 分支语义；若有协议差异，先用旧脚本证明，再记录决定，不悄悄忽略输入字段。

### 3.2 地址候选规则

- [ ] Document 候选为目标 descendants 中可见的前 20 个；Edit/ComboBox 检查范围为 descendants 的前 100 个，跳过密码和不可见控件。不得读取这些控件的正文或 TextPattern。
- [ ] 地址栏标识与名称匹配沿用现有 ID 和中英文模式，包含 `addressEditBox`、`urlbar-input`、`urlbar`、`omnibox`；大小写、空值与去重语义用 PS 对照确定，不能改成仅支持 Chromium 的特例。
- [ ] 候选沿 ControlView 父链最多 40 层，必须经过 ToolBar 并到达本次根窗口，遇到 Document 或无法到达根即拒绝。页面表单中伪造地址栏的控件不可成为结果。
- [ ] 符合规则的地址栏 Value 去重后只有一个才采纳。Document 自身 Value 仅接受 `http://`、`https://`、`file://`；唯一 Document URL 按旧规则覆盖地址栏值，多个不同值不能任选一个。保留 `metadataOnly` 对 Document Value 的跳过条件。
- [ ] `file://` 仅在转换得到的本地文件真实存在时产生 `path` 并去掉 `url`；不存在时的结果、百分号转义、中文、空格、盘符和 UNC 用受控 fixture 对照旧实现。不要自行解析几种字符串后宣称全面兼容。
- [ ] 控件不支持 ValuePattern 与整个 UIA 调用失败要分清：前者按旧实现忽略该候选，后者保留错误出口。COM/BSTR/数组等通过官方绑定与 RAII 释放，不吞掉失败并报告“读取成功”。

### 3.3 生命周期与接入顺序

- [ ] 先通过直接调用 Rust 候选进行验证；达到第 5 节门槛后，才把 `browser-url` 加入 `src/main/windows-native.ts` 的 `nativeActions`。若不采纳，保留 PS 生产路由，解释原因。
- [ ] 沿用当前 15s 请求预算、输出上限、取消和 `--parent-pid`。stdin EOF 表示请求已写完，不能误当取消。父进程退出、abort 或卡住 provider 到期后，辅助进程必须回收；不增加重试、静默 PS 回落或更大超时。
- [ ] UIA 在一次性 helper 的 MTA 上完成，不向 Electron 主线程搬同步 COM 调用；不留监听器、后台任务或控件引用。

## 4. 正确性与真实原生验收

优先扩展现有测试/fixture，必要时增加一个专用受控 UIA 窗口。窗口必须不抢用户焦点；构造浏览器形状的 toolbar/document 树，不依赖用户已登录浏览器。纯逻辑测试不能替代真实 COM/provider 通路；替身故障要标明模拟。

- [ ] 正向：真实 ToolBar 下地址 Edit、中文名称、ComboBox、未列入白名单的进程；无候选、重复相同值、不同地址歧义、Document 唯一值覆盖地址栏。
- [ ] 反向：Document 内伪地址 Edit、密码、不可见、无 toolbar、父链不能到根、深度上界、多 Document URL；证明 Rust 和旧 PS 的输出字段及值一致。
- [ ] 文件 URL：本轮临时文件的中文/空格/转义路径、文件不存在、UNC 能否实际验证；未搭建真实 UNC 时明确未测，不操作用户共享文件。
- [ ] 原窗口错 PID、错标题、关闭；读取过程中改变/销毁目标的读后校验。需要受控延迟时仅在 fixture/provider 中提供，不在生产 helper 增加测试开关。
- [ ] 用现有生产运行器验证 abort、超时杀进程和父进程退出；卡住 provider 的测试不能只等一个正常快速请求。旧进程迟到的关闭事件不能影响下一次请求。
- [ ] 至少 30 次实际启停，记录各 PID 的关闭并复核无残留；用 `process.kill(pid, 0)` 等已有正确方式区分存活、已退出、查询失败，禁止重复阶段 11 的整数 PID/`$_.Id` 误测。
- [ ] 复跑现有业务回归：冻结目标、URL 凭据/危险 scheme 过滤、路径优先、应用/目录排除、受限文件与联网授权；不得通过删断言、扩大超时或绕开生产运行器取得通过。

如果受控 fixture 暴露不出关键树形状，应修好 fixture，或明确保留 PS 路由，不能用全 mock 的成功替代上线验收。真实 Edge/Chrome/Firefox、提权窗口、锁屏/远程桌面、不同 UIA provider 的覆盖不足必须列为未测项，不把合成窗口结论扩写成所有浏览器均支持。

## 5. 同机对照、采纳门槛与证据

- [ ] 以 `903d88d` 的固定 `windows-tools.ps1` 与 `current-content.ps1` 为 PS 基线；仅提取所需脚本，不复制工作区或依赖目录。Rust 使用本轮交付候选，两侧读同一个受控窗口、同一份地址数据。
- [ ] 可扩展 `scripts/benchmark-windows.mjs`，或增加小型 `scripts/benchmark-browser-url.mjs` 及对应命令；复用现有测量方式，不为了单个 action 新建基准框架或复制整份语音 job 测量实现。
- [ ] PS/Rust/Rust/PS 交错，两侧各至少 20 个有效请求；warmup 与有效样本分开，报告请求/成功/失败数、原始样本、P50/P95。正确性失败不得作为“异常值”剔除后采纳。
- [ ] 主指标为从 spawn 前到 stdio `close` 的整次请求耗时，包含进程启动、UIA、协议及退出；fixture 启动、编译、外部采样开销不能悄悄只算在一侧。不要把额外 sleep 算进工作时长。
- [ ] CPU 若测，使用两侧同法的进程累计 user+kernel 时间并在退出后保留句柄读数，说明范围与粒度。私有内存/工作集若测，标明瞬时或采样最大值、采样间隔；不把采样峰值称为内核精确峰值。无法可靠获得的值记不可用，不能填 0 或出百分比。
- [ ] 采纳条件：行为/退出/现有业务回归通过，且整次请求 P95 至少下降 25% 并减少 100ms；或者同法、同生命周期的有效私有内存指标至少下降 30% 且无明确延迟退化。未测内存时只按延迟门槛判断。指标仅归因本 action 辅助进程，不宣称整应用降幅。
- [ ] 新证据写 `tests/yu-v2/evidence/rust-browser-url-20261104.json`（实际跨日则改日期），包含基线、OS/架构、测量口径、实际 fixture/对照检查、原始样本、失败原因、采纳决定、二进制大小/完整 SHA-256。不要覆盖旧阶段证据，证据只存合成地址与必要统计。

## 6. 验证、文档与交付

- [ ] 在 `native/windows` 执行 `cargo fmt -- --check`、`cargo clippy --locked --offline --all-targets -- -D warnings`、`cargo test --locked --offline`；沿用既有 MSVC 静态 CRT 构建。依赖离线不可用时如实说明，不擅自更换版本。
- [ ] 候选构建后运行真实地址对照与基准，补齐相关 native/TS 测试，再决定生产路由。可使用 `pnpm exec vitest run src/main/windows-native.test.ts src/main/windows-native-transport.test.ts src/main/windows-native-process.test.ts src/main/current-content.test.ts src/main/tools/windows.test.ts`，加上本轮新增的测试文件。
- [ ] 最终实现执行 `pnpm typecheck`、`pnpm test:native`、`pnpm test`、`pnpm build`，按顺序记录退出码、实际测试数和失败详情；通过后不无目标重复全量验证。遇到失败先查根因，不简单归类成“既有偶发”。
- [ ] 所有会触发 `build-native` 的验证结束后，再计算最终 `yu-windows.exe` 大小/SHA-256，并核对证据确实测的是交付版本。若最后重建变动了资产，核实来源并修正或复测，不再重复阶段 12 的旧哈希回填。
- [ ] 在本文件勾选实际已完成项，补“实施结果”：实际代码范围、是否接入/依据、对照与性能原始证据、真实/替身测试、失败/未测项、清理情况与提交编号；未完成项保留未勾选并说明原因。
- [ ] 更新 `docs/rust-refactor-plan.md` 阶段 13 状态与结果。若接入，更新中英文 README 对 Windows helper 操作范围/基准命令的描述；PS 的 `current-content` 仍使用地址代码时不得误删相关脚本。
- [ ] 本轮只清理自己创建且不再使用的临时窗口、基线脚本副本和探针。既有 `native/*/target` 缓存不当作本轮新增垃圾全部删除；保留交付、fixture、必要证据与工程依赖，报告明显新增占用。
- [ ] 检查 diff，仅暂存本轮文件，用 Conventional Commits 自动提交；计划目录被忽略时只对确切新文件使用 `git add -f`。不 push、不打包、不发布、不重启或终止用户正在使用的应用。

完成后直接汇报开发与文档结果，带实现/文档提交编号、最终哈希、实际验证及限制，等待 Codex 复核下一阶段。不要自行扩大到其余 Windows 操作，不要再次完整复跑唤醒长会话或重做 TTS 基准。
