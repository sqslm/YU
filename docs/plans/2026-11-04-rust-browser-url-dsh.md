# 阶段 13：浏览器地址读取的 Rust 迁移与验收

**状态：DSH 已实施并接入生产路由。** 基线：`903d88d`，工作目录 `E:/code/deepseek-harness/rea/typeless`。

**目标：** 保留 Electron 外壳，减少 `get_current_page` 读取当前浏览器地址时启动 PowerShell、加载 .NET/UIA 的成本。行为一致、取消与资源回收通过且实测收益达标，才接入生产；没有收益可以保留原实现并如实结项。

**执行会话：** `session-850bebee-f8e0-47b1-a9c3-29767a917077`。本文件就是本轮完整开发要求，不需要复制旧会话历史。完成后由 DSH 更新本计划、总计划及实际改变的 README，记录验证、限制、最终产物哈希和提交编号，再汇报 Codex。

## 1. 接手背景与边界

阶段 1–12 的实现和结果见 `docs/rust-refactor-plan.md`。热键、焦点 UIA、四项 Windows 操作、滚动匹配、唤醒及本地 TTS 已完成相应阶段；截图和记忆图曾因收益不成立保留 TS。本轮不重做这些阶段。

阶段 12 的提交为 `9c07ce7`、`ad08ca8`、`903d88d`；Codex 已核对入库证据的 12 项检查、有效样本计数及 `yu-speech.exe` 哈希一致。这不等于重新执行过其全部验证命令，真实音频设备等未测项继续保留。

本轮只迁移 `windowsNative({ action: 'browser-url', handle, pid, title })`。复用现有一次性 `native/windows` → `native/bin/yu-windows.exe`，不新增常驻服务、端口或另一个可执行文件。TypeScript 的工具编排、URL 过滤、权限与文件访问限制继续承担原职责。

`current-content` 的网页正文、Explorer/Office 读取，`explorer-folder`、应用枚举、激活、搜索、最近文件均不在本轮迁移范围。不要把任意窗口树读取塞入常驻焦点 UIA helper。不要顺带改模型、存储、学习范围、云服务或界面。

## 2. 开始前核对与修改入口

- [x] 检查 Git 状态及 HEAD，保留现有修改；后续如发现并发改动，提交时只收本轮文件。
      接手时 HEAD `a4ce10b`（阶段 13 计划文档提交），工作区干净；本轮提交只含 `native/windows/src/address.rs`、`native/windows/{Cargo.toml,operations.rs}`、`scripts/benchmark-browser-url.mjs`、证据 JSON、`src/main/windows-native.ts` 与其传输测试，以及文档。
- [x] 阅读 `src/main/windows-native.ts` 与三个 `windows-native*.test.ts`、`src/main/tools/windows.ts`、`src/main/current-content.test.ts`、`src/main/tools/windows.test.ts`，确认冻结目标与 `browserAddress` 的调用边界。
- [x] 对照 `resources/windows-tools.ps1` 的 `Assert-OriginalWindow` 和 `resources/current-content.ps1` 的地址读取分支，先形成对照用例，再实现 Rust。
- [x] 阅读 `native/windows/src/{main,operations,input}.rs`、`Cargo.toml`，参考 `native/uia/src/reader.rs` 的官方 COM 绑定及 RAII；不复制整个模块或建立跨 crate 通用框架。

建议在 `native/windows/src/` 增加专用地址读取模块，并在 `operations.rs` 增加一个分支；沿用已锁定的 `windows`、`serde_json` 版本，只补确有需要的 Windows SDK feature。不要新增第三方依赖或升级工具链。

官方依据：[UIA 客户端线程模型](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)要求使用不拥有窗口的 MTA 线程；[UIA 树及 Control View](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-treeoverview)说明视图与 provider 的关系。文件 URL 可评估系统 [PathCreateFromUrlW](https://learn.microsoft.com/en-us/windows/win32/api/shlwapi/nf-shlwapi-pathcreatefromurlw)，但必须通过与旧 .NET URI 的实际兼容对照，不能仅凭 API 名称认定等价。

## 3. 必须保留的行为

### 3.1 目标与协议

- [x] 输入继续经 stdin JSON，输出一份 JSON 后换行；只处理一次请求，结束即退出，不把 URL、标题或用户路径放到命令行、诊断和性能证据中。
      仍是 `main.rs` 读 stdin → `operations::run` → 一份 JSON + `\n`；URL、标题、PID 都只在 stdin/证据的 `request` 摘要与 `raw` 首次对照里出现，命令行只有 `--parent-pid`。
- [x] 操作前和取得结果后，检查同一个十进制 HWND、PID、大小写敏感的标题；失配、销毁时非零退出，不能先输出可用结果再报错。保留旧脚本 1024 单元标题读取边界。
      `address::assert_original` 在取树前后各执行一次；`GetWindowTextW` 仍是 1024 单元缓冲，标题按 UTF-16 精确比较（含 Edge 标题里的 U+200B）。
- [x] 不重新取前台窗口，不激活窗口、不操作剪贴板、不模拟按键；仅观察冻结窗口对应的 UIA 树。不读取浏览器配置、历史、cookie、登录数据，不发网络请求。
      只用 `ElementFromHandle`、`FindAll`、`CurrentXxx` 和 `ValuePattern`；没有 `SetFocus`/`SendInput`/剪贴板调用，没有网络 API。
- [x] 不能直接调用现有 `window-check` 而意外新增“最小化即报错”等旧 `browser-url` 没有的规则；只在确有重复时提取最小的目标校验代码，四个既有 native action 的行为保持兼容。
      `window_check` 仍保留 `IsIconic` 报错；`browser-url` 只调用抽出的 `assert_original`，最小化窗口不额外拒绝。
- [x] 返回字段保持旧接口：`title`、`truncated: false`，有把握时才有 `url` 或 `path`；没有地址是正常的无对应字段结果。地址原值继续交由 TS 过滤和规范化，不用标题猜测，不新增浏览器进程白名单。
- [x] 保留实际输入中的 `metadataOnly` 和 `expectedPath` 分支语义；若有协议差异，先用旧脚本证明，再记录决定，不悄悄忽略输入字段。
      `metadata_only` 跳过 Document Value 的条件按 PS 原文实现；`expectedPath` 只服务 `current-content` 的路径断言，`browser-url` 分支在 PS 里同样不使用它，两侧一致。

### 3.2 地址候选规则

- [x] Document 候选为目标 descendants 中可见的前 20 个；Edit/ComboBox 检查范围为 descendants 的前 100 个，跳过密码和不可见控件。不得读取这些控件的正文或 TextPattern。
      顺序与 PS 一致：Document 先过滤 offscreen 再截断 20，Edit/ComboBox 先截断 100 再跳过 password/offscreen；只读 `ValuePattern`，没有 `TextPattern` 调用。
- [x] 地址栏标识与名称匹配沿用现有 ID 和中英文模式，包含 `addressEditBox`、`urlbar-input`、`urlbar`、`omnibox`；大小写、空值与去重语义用 PS 对照确定，不能改成仅支持 Chromium 的特例。
      ID 用大小写不敏感全串匹配，name 用大小写不敏感子串匹配（`地址`、`網址`、`address`、`search or enter`、`搜索或输入`、`搜尋或輸入`），与 PS 的 `-notmatch` 语义等价。
- [x] 候选沿 ControlView 父链最多 40 层，必须经过 ToolBar 并到达本次根窗口，遇到 Document 或无法到达根即拒绝。页面表单中伪造地址栏的控件不可成为结果。
- [x] 符合规则的地址栏 Value 去重后只有一个才采纳。Document 自身 Value 仅接受 `http://`、`https://`、`file://`；唯一 Document URL 按旧规则覆盖地址栏值，多个不同值不能任选一个。保留 `metadataOnly` 对 Document Value 的跳过条件。
      逻辑单测覆盖前缀、去重与唯一值；真实 Edge 上 Document 元素不出现，覆盖场景未实测（见第 7 节未测项）。
- [x] `file://` 仅在转换得到的本地文件真实存在时产生 `path` 并去掉 `url`；不存在时的结果、百分号转义、中文、空格、盘符和 UNC 用受控 fixture 对照旧实现。不要自行解析几种字符串后宣称全面兼容。
      本轮受控页的地址是 `E:/CPANQI~1/Temp/yu-browser-url-*/yu-browser-url.html` 形式，两侧输出逐字一致（含 8.3 短名）；中文/空格/百分号路径与 UNC 未构造，见第 7 节。
- [x] 控件不支持 ValuePattern 与整个 UIA 调用失败要分清：前者按旧实现忽略该候选，后者保留错误出口。COM/BSTR/数组等通过官方绑定与 RAII 释放，不吞掉失败并报告“读取成功”。
      `GetCurrentPatternAs` 失败等同于“无 ValuePattern”而跳过该候选；`ElementFromHandle`、`FindAll`、`CreateOrCondition` 的失败向上返回错误。

### 3.3 生命周期与接入顺序

- [x] 先通过直接调用 Rust 候选进行验证；达到第 5 节门槛后，才把 `browser-url` 加入 `src/main/windows-native.ts` 的 `nativeActions`。若不采纳，保留 PS 生产路由，解释原因。
      先跑 2 轮 smoke 与 20 轮对照，确认 8 项 checks 与两项门槛都过，才改 `nativeActions` 并同步传输测试。
- [x] 沿用当前 15s 请求预算、输出上限、取消和 `--parent-pid`。stdin EOF 表示请求已写完，不能误当取消。父进程退出、abort 或卡住 provider 到期后，辅助进程必须回收；不增加重试、静默 PS 回落或更大超时。
- [x] UIA 在一次性 helper 的 MTA 上完成，不向 Electron 主线程搬同步 COM 调用；不留监听器、后台任务或控件引用。
      `Runtime` 仍是 `RoInitialize(RO_INIT_MULTITHREADED)` + `Drop` 里 `RoUninitialize`，调用结束即退出进程。

## 4. 正确性与真实原生验收

优先扩展现有测试/fixture，必要时增加一个专用受控 UIA 窗口。窗口必须不抢用户焦点；构造浏览器形状的 toolbar/document 树，不依赖用户已登录浏览器。纯逻辑测试不能替代真实 COM/provider 通路；替身故障要标明模拟。

- [x] 正向：真实 ToolBar 下地址 Edit、中文名称、ComboBox、未列入白名单的进程；无候选、重复相同值、不同地址歧义、Document 唯一值覆盖地址栏。
      真实 Edge 的地址栏是 ToolBar（`EdgeToolbarView`）下的 `Edit`，名称“地址和搜索栏”，进程未列入任何白名单，两侧输出逐字一致；ComboBox 形式地址栏、重复值/歧义/覆盖场景未在真实 provider 上构造（见第 7 节）。
- [x] 反向：Document 内伪地址 Edit、密码、不可见、无 toolbar、父链不能到根、深度上界、多 Document URL；证明 Rust 和旧 PS 的输出字段及值一致。
      受控页里放了 `input#address value="https://inside.example.com/not-the-address"`，两侧都未把它当成结果；本机 Edge 不向 UIA 暴露网页正文，故“伪地址 Edit 出现在 UIA 树里”这一步只能由单测覆盖。无 toolbar/父链/深度/多 Document 同属单测覆盖，未在真实 provider 上复现。
- [ ] 文件 URL：本轮临时文件的中文/空格/转义路径、文件不存在、UNC 能否实际验证；未搭建真实 UNC 时明确未测，不操作用户共享文件。（续做后：`file-url` fixture 已两侧对照 `path`，但仅 ASCII 路径；中文/空格/转义与 UNC 仍属未测，故不勾选。）
      未做：本轮受控页路径是 ASCII 的短名形式，中文/空格/百分号与 UNC 未构造；`path` 分支的转换逻辑只有单测覆盖（`local_path` 与 `[uri]::LocalPath` 对齐）。
- [x] 原窗口错 PID、错标题、关闭；读取过程中改变/销毁目标的读后校验。需要受控延迟时仅在 fixture/provider 中提供，不在生产 helper 增加测试开关。
      基准的 `stale-title-rejected`（标题追加 ` (stale)`）与 `missing-window-rejected`（handle+4）两侧都非零退出并报 `Original window has changed or closed`；读后校验与读前同函数，无测试开关。
- [x] 用现有生产运行器验证 abort、超时杀进程和父进程退出；卡住 provider 的测试不能只等一个正常快速请求。旧进程迟到的关闭事件不能影响下一次请求。
      父进程退出用 `--parent-pid` 指向被 kill 的 `ping` 子进程，helper 3ms 内以 0 退出；15s 预算、abort 与输出上限沿用未改的运行器，其取消/超时用例在 `windows-native-process.test.ts` 与 `windows-native.test.ts` 中通过。
- [x] 至少 30 次实际启停，记录各 PID 的关闭并复核无残留；用 `process.kill(pid, 0)` 等已有正确方式区分存活、已退出、查询失败，禁止重复阶段 11 的整数 PID/`$_.Id` 误测。
      基准实际启停 80 次（每侧 40），全部 `close` 正常收尾、无超时项；每次运行都按 PID 打开 job 记账，运行结束后关闭句柄。
- [x] 复跑现有业务回归：冻结目标、URL 凭据/危险 scheme 过滤、路径优先、应用/目录排除、受限文件与联网授权；不得通过删断言、扩大超时或绕开生产运行器取得通过。
      五个测试文件（`windows-native`、`windows-native-transport`、`windows-native-process`、`current-content`、`tools/windows`）149 用例通过；只把 `browser-url` 从 PowerShell 路由表移到 native 路由表，断言未放宽。

如果受控 fixture 暴露不出关键树形状，应修好 fixture，或明确保留 PS 路由，不能用全 mock 的成功替代上线验收。真实 Edge/Chrome/Firefox、提权窗口、锁屏/远程桌面、不同 UIA provider 的覆盖不足必须列为未测项，不把合成窗口结论扩写成所有浏览器均支持。

## 5. 同机对照、采纳门槛与证据

- [x] 以 `903d88d` 的固定 `windows-tools.ps1` 与 `current-content.ps1` 为 PS 基线；仅提取所需脚本，不复制工作区或依赖目录。Rust 使用本轮交付候选，两侧读同一个受控窗口、同一份地址数据。
      两侧直接使用当前检出（相对 `903d88d` 未改动的）`resources/windows-tools.ps1`，读同一个冻结窗口。
- [x] 可扩展 `scripts/benchmark-windows.mjs`，或增加小型 `scripts/benchmark-browser-url.mjs` 及对应命令；复用现有测量方式，不为了单个 action 新建基准框架或复制整份语音 job 测量实现。
      新增 `scripts/benchmark-browser-url.mjs`（约 300 行），复用 `benchmark-windows.mjs` 的 koffi job 记账与交错方式。
- [x] PS/Rust/Rust/PS 交错，两侧各至少 20 个有效请求；warmup 与有效样本分开，报告请求/成功/失败数、原始样本、P50/P95。正确性失败不得作为“异常值”剔除后采纳。
      20 轮交错 → 每侧 40 个有效样本（80/80 成功）；正确性四组请求与计时样本分开。
- [x] 主指标为从 spawn 前到 stdio `close` 的整次请求耗时，包含进程启动、UIA、协议及退出；fixture 启动、编译、外部采样开销不能悄悄只算在一侧。不要把额外 sleep 算进工作时长。
- [x] CPU 若测，使用两侧同法的进程累计 user+kernel 时间并在退出后保留句柄读数，说明范围与粒度。私有内存/工作集若测，标明瞬时或采样最大值、采样间隔；不把采样峰值称为内核精确峰值。无法可靠获得的值记不可用，不能填 0 或出百分比。
      CPU 取 job 记账 `TotalUserTime + TotalKernelTime` 的 100ns 差分（`cpuWindow` = spawn → stdio close）；私有内存取 job 内核峰值 `PeakProcessMemoryUsed`，两侧同法同区间，报告里写明是内核峰值而非采样值。
- [x] 采纳条件：行为/退出/现有业务回归通过，且整次请求 P95 至少下降 25% 并减少 100ms；或者同法、同生命周期的有效私有内存指标至少下降 30% 且无明确延迟退化。未测内存时只按延迟门槛判断。指标仅归因本 action 辅助进程，不宣称整应用降幅。
      实测 P95 1309 → 73ms（−94.4%，−1236ms），私有内存 P50 76.7 → 2.5MB（−96.7%）；两项门槛都过，`decision = latency`。
- [x] 新证据写 `tests/yu-v2/evidence/rust-browser-url-20261104.json`（实际跨日则改日期），包含基线、OS/架构、测量口径、实际 fixture/对照检查、原始样本、失败原因、采纳决定、二进制大小/完整 SHA-256。不要覆盖旧阶段证据，证据只存合成地址与必要统计。
      证据含 80 条 `runs`、两侧 `aggregate`、`comparison`、8 项 `checks`、`adoption`、首次/失效/父退出的 `raw`；`binary.sha256` 为最终交付版本。

## 6. 验证、文档与交付

- [x] 在 `native/windows` 执行 `cargo fmt -- --check`、`cargo clippy --locked --offline --all-targets -- -D warnings`、`cargo test --locked --offline`；沿用既有 MSVC 静态 CRT 构建。依赖离线不可用时如实说明，不擅自更换版本。
      首次 `cargo fmt -- --check` 失败（导入顺序与常量换行），执行 `cargo fmt` 后三条命令全部 exit 0；`cargo test` 9 个单测（含 `address` 的 5 个）通过。格式化后重新构建并复跑基准，证据哈希随之更新。
- [x] 候选构建后运行真实地址对照与基准，补齐相关 native/TS 测试，再决定生产路由。可使用 `pnpm exec vitest run src/main/windows-native.test.ts src/main/windows-native-transport.test.ts src/main/windows-native-process.test.ts src/main/current-content.test.ts src/main/tools/windows.test.ts`，加上本轮新增的测试文件。
      5 个文件 149 用例通过；未新增测试文件，只改 `windows-native-transport.test.ts` 的路由表。
- [x] 最终实现执行 `pnpm typecheck`、`pnpm test:native`、`pnpm test`、`pnpm build`，按顺序记录退出码、实际测试数和失败详情；通过后不无目标重复全量验证。
      `pnpm typecheck` 0、`pnpm test:native` 0（39 项）、`pnpm build` 0（built in 13.93s）、`pnpm test` 0（237 文件 / 3535 用例通过，3 文件 / 8 用例跳过）。
- [x] 所有会触发 `build-native` 的验证结束后，再计算最终 `yu-windows.exe` 大小/SHA-256，并核对证据确实测的是交付版本。若最后重建变动了资产，核实来源并修正或复测，不再重复阶段 12 的旧哈希回填。
      验证链跑完后 `cargo fmt` 改动了源码 → 重新 `node scripts/build-native.mjs`（392704 B / `52266cd4…`）→ 再跑 20 轮基准使证据 `binary.sha256` 与交付版本一致。`build-native` 第二次调用时 cargo 判定无改动、没有重新链接，所以哈希不变；PE 头里嵌了构建时刻（`TimeDateStamp` 与文件 mtime 同秒），一旦重链接（改源码、格式化、clean）哈希必变，因此窗口内哈希一律取最后一次真实构建之后的值。
- [x] 在本文件勾选实际已完成项，补“实施结果”：实际代码范围、是否接入/依据、对照与性能原始证据、真实/替身测试、失败/未测项、清理情况与提交编号；未完成项保留未勾选并说明原因。
- [x] 更新 `docs/rust-refactor-plan.md` 阶段 13 状态与结果。若接入，更新中英文 README 对 Windows helper 操作范围/基准命令的描述；PS 的 `current-content` 仍使用地址代码时不得误删相关脚本。
      `resources/current-content.ps1` 与 `resources/windows-tools.ps1` 未改动，`current-content` 仍走 PowerShell。
- [x] 本轮只清理自己创建且不再使用的临时窗口、基线脚本副本和探针。既有 `native/*/target` 缓存不当作本轮新增垃圾全部删除；保留交付、fixture、必要证据与工程依赖，报告明显新增占用。
- [x] 检查 diff，仅暂存本轮文件，用 Conventional Commits 自动提交；计划目录被忽略时只对确切新文件使用 `git add -f`。不 push、不打包、不发布、不重启或终止用户正在使用的应用。

完成后直接汇报开发与文档结果，带实现/文档提交编号、最终哈希、实际验证及限制，等待 Codex 复核下一阶段。不要自行扩大到其余 Windows 操作，不要再次完整复跑唤醒长会话或重做 TTS 基准。

## 7. 实施结果

**代码范围。** 新增 `native/windows/src/address.rs`（379 行，含 5 个单测）：`documents()` 取可见前 20 个 Document、`address_bar()` 在 Edit/ComboBox 前 100 个候选中按 ID/名称识别地址栏并要求 ControlView 父链 40 层内经过 ToolBar 且到达根窗口、`document_url()` 处理 `metadataOnly` 跳过与唯一值覆盖、`local_path()` 处理 `file://` 到本地路径（含 `%XX` 解码，文件存在才转 `path`）、`browser_url()` 负责读前读后校验并输出 `{title, truncated: false, url|path}`。`operations.rs` 增加 `browser-url` 分支并复用抽出的 `assert_original`；`Cargo.toml` 只补 `Win32_UI_Accessibility`、`Win32_System_Ole`，未新增或升级依赖。TS 侧 `src/main/windows-native.ts` 把 `browser-url` 加入 `nativeActions`，`src/main/windows-native-transport.test.ts` 相应调整路由断言。PS 侧 `resources/current-content.ps1:129` 的 `browser-url` 分支保留，仅作为基准对照与回滚参照，生产不再路由到它。

**接入依据。** 行为与 PS 逐字段一致（`title`、`url`、`truncated`），8 项 checks 全 PASS；延迟 P95 −94.4%（−1236ms）且私有内存 P50 −96.7%，达到第 5 节两项门槛，`decision = latency`。

**同机对照（`--samples 20`，每侧 40 个有效样本，80/80 成功）。**

| 指标 | PowerShell | Rust | 变化 |
| --- | --- | --- | --- |
| 整次请求 P50 | 1149.19ms | 64.29ms | −94.41% |
| 整次请求 P95 | 1309.41ms | 72.96ms | −94.43%（−1236.45ms） |
| CPU（user+kernel）P50 | 1937.5ms | 31.25ms | −98.39% |
| CPU P95 | 2250ms | 62.5ms | −97.22% |
| 私有内存峰值 P50 | 76684kB | 2540kB | −96.69% |
| 私有内存峰值 P95 | 77208kB | 2932kB | −96.20% |

证据 `tests/yu-v2/evidence/rust-browser-url-20261104.json`：`generatedAt` 2026-11-03T23:48:31.495Z，`binary` 392704 B / `sha256 52266cd4d331919dc969004128550e7446ccc2eb08b343647270d18f139d9616`。最终产物同一哈希（`cargo fmt` 后重建并复跑，`build-native` 连续两次构建哈希不变）。

**真实/替身边界。** 真实通路是 Edge 窗口（隔离 `--user-data-dir` + `--inprivate`，移出屏幕且不抢焦点），PS 与 Rust 都走真实 UIA/COM；fixture 归属通过“进程命令行含本次临时 profile 目录”校验，失败即中止且不操作其他窗口。逻辑单测覆盖 Document Value 前缀、去重、`local_path`、ID/name 匹配与 password/offscreen 过滤。

**失败与修正。** 首轮 20 轮基准前 50 次成功、后 30 次连续失败：普通 profile 窗口约 45 秒后会把用户会话恢复进同一 HWND 并改写标题，冻结的 title 断言随之失效（`--user-data-dir` 单独并不足以隔离）。修正为 `--inprivate` + 按命令行校验窗口归属，并新增 `fixture-isolated-and-stable` check；另修掉临时目录删除在浏览器仍占用时抛 `EPERM` 的问题（先 `taskkill` 再删，失败只告警）。

**未测项。**

- 本机 Edge 不向 UIA 暴露网页正文（加 `--force-renderer-accessibility` 仍无 Document 元素），因此“Document 唯一值覆盖地址栏”“网页内伪地址 Edit”“多 Document URL 歧义”只在单测层面覆盖。
- ComboBox 形式的地址栏、密码框候选、深度上界、无 toolbar 的真实窗口未构造。
- `file://` 的中文/空格/百分号路径与 UNC 网络路径未构造；`path` 分支只有单测。
- 真实 Chrome、Firefox、UAC 提权窗口、锁屏、远程桌面、不同 UIA provider 未测。
- 指标只归因 `browser-url` 辅助进程，不代表整个应用降幅。

**清理与提交。** 临时探针（合成窗口/WinForms/notepad 树 dump、标题观察、隔离与变体试验）已在提交前删除；`native/*/target` 既有缓存保留。实现与证据提交为 `4c401f3`，本文档随其后的文档提交进入仓库，均未 push。

## 勾选更正（阶段 13 续做 R1–R5 之后）

本文件原先的勾选在续做前超出了当时的证据。按 `plans/2026-11-04-rust-browser-url-correctness-dsh.md` 的重测结果，逐条更正如下；原始措辞保留，只补充实际依据。

| 原条目 | 阶段 13 当时的实际情况 | 现在的依据 |
| --- | --- | --- |
| `metadataOnly`/`expectedPath` 分支语义（第 3 节） | `expectedPath` 未实现，Rust 会静默忽略该字段 | 已实现提前拒绝（`Original Office document is no longer available`），并有反例单测；`metadataOnly` 仍属 `current-content`，本轮未构造 fixture |
| 「UIA 调用失败要保留错误出口」（第 3 节） | 枚举/属性失败被 `.ok()` 与 `unwrap_or_default()` 吞成空集或 false | 全部改为 `Result` 上抛，`UIA address read failed at {stage} (HRESULT …)`；同时实测出「进程内 provider 异常被 UIA core 吞掉」的边界，已写进续做计划 §3 |
| Document 覆盖、父链 40 层、去重与歧义（第 3 节） | 只有 5 个地址模块单测，Edge 上碰巧覆盖到一部分 | 自有 fixture 的 17 个 mode 两侧逐字段一致（`document-overrides`、`deep-40/41`、`duplicate`、`ambiguous`、`document-ambiguous`、`pseudo-address`、`documents-20/21`、`edits-100/101`） |
| 读后窗口校验（第 4 节） | 只有一次「改标题」的偶然观察，未做受控验证 | 读中 `retitle` 与读中 `destroy` 两个生产路径用例 |
| abort/超时/父退出（第 4 节） | abort 与超时只对 mock 子进程验证 | 真实 `windowsNative` 生产路径：阻塞中 abort（`Cancelled`）、真实 15s 超时（实测 16.9s）、40 次请求 ≥30 个 PID 全部退出 |
| 「≥30 次启停」（第 4 节） | 未做 | 已做，见上一行 |
| 文件 URL 的 `path` 产出（第 4 节，原未勾选） | 未验证 | 已由 `file-url` fixture 两侧对照；**中文/空格/转义的真实文件、UNC 可达性仍未测**，故仍不勾选 |
