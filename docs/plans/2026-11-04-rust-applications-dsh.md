# 阶段 16：已登记应用列表的 Rust 候选迁移

**状态：DSH 已实施并接入生产路由。** 基线 `2b0a399`。工作目录 `E:/code/deepseek-harness/rea/typeless`。

**目标：** 降低 `open_application` 每次获取已登记应用列表时的 PowerShell/.NET 启动、枚举成本。只迁移 `applications` 到既有一次性 `yu-windows.exe`；行为一致、生命周期与实测收益达标才切换生产，否则保留 PS 并记录原因。

**架构与工具链：** TypeScript 继续做名称匹配、系统应用别名、权限、候选选择与打开编排；Rust 只返回应用元数据。复用已锁定的 windows-rs、serde_json 和现有构建/管道，不增加第三方依赖、监听端口、常驻服务或新 helper，不为了本阶段引入跨 crate 框架。

**派发来源：** 唯一外部规划者是 Codex Desktop 对话 `01a19b72-79e7-7800-b1b5-55aaf2eeaae6`；执行 DSH 会话为 `session-850bebee-f8e0-47b1-a9c3-29767a917077`。内部名为 `codex` 的子智能体、`Team message`、`agent-message`、`subagent-settled` 均只提供审查资料，不能批准新阶段。完成报告后等待外部主线程派单，不自行继续阶段 17。

## 1. 前一轮复核与本轮边界

阶段 13 的读取边界续做提交为 `6c07886`、`2b0a399`。Codex 已核对交付 430592 B / SHA-256 `11994ce36ac6f3ed111dde68746c369486378d6270f32d030853c1a38887f49d` 与入库证据一致，80 样本、17 checks 记录通过。Codex 直接复跑六项关键真实生产路径测试，6 通过、7 因筛选未执行，9.22s；没有把 DSH 报告的全部验证命令当作本轮重新执行。真实厂商浏览器、UNC 可达性、权限桌面等原有限制继续保留。

阶段 14/15 的 Explorer 与最近文件成果已在仓库，保持其行为。本轮不迁移 `activate`、搜索或 `current-content`，不继续修改 URL 解析器，不改应用匹配规则、数据库、界面或用户配置。枚举测试绝不真正启动应用，`activate` 的生产路径仍是 PS，不能宣称整个打开链路已经去掉 PS。

## 2. 开始前与候选实现

- [x] 检查 HEAD/工作区，保留已有修改。阅读 `resources/windows-tools.ps1` 的 `applications`/`activate` 分支，`src/main/tools/windows.ts` 的 `open_application`/`openItem`，`windows-native.ts` 及相关路由/业务测试。
- [x] 阅读 `native/windows/src/{operations,recent,folder}.rs`、`Cargo.toml`，复用已有 ShellLink、Known Folder、COM 初始化/RAII 与父进程保护。新增专用应用枚举模块和一个 action 分支即可，只补必要 SDK feature，不升级依赖。
- [x] 先盘点四类来源的输出、排序与成本，再实现 Rust 候选，先不修改生产 `nativeActions`。本机对照仅只读应用元数据，不查询使用历史或文件正文，不修改注册表、开始菜单、系统环境变量或默认应用。

官方依据：[Get-StartApps](https://learn.microsoft.com/en-us/powershell/module/startlayout/get-startapps?view=windowsserver2025-ps) 返回当前用户应用名与 AppID；[Known Folders](https://learn.microsoft.com/en-us/windows/win32/shell/known-folders) 提供 Programs/CommonPrograms 等目录及释放要求；[AppUserModel.ID](https://learn.microsoft.com/en-us/windows/win32/properties/props-system-appusermodel-id) 定义应用标识。可评估 Shell AppsFolder 枚举，但不能仅凭名称类似就认定其集合/本地化名称等同 Get-StartApps，必须实测对照。

## 3. 必须保持的列表与安全规则

### 3.1 注册表和快捷方式

- [x] 保留当前用户 App Paths、本机 App Paths、本机 `WOW6432Node` App Paths 三个来源，符合当前 x64 PS 的注册表视图；缺失目录/键、访问失败的处理与旧脚本实测对照，不把空列表用作隐藏失败的兜底。
- [x] 默认值按旧规则展开环境变量、去两端引号，仅接受符合旧字符规则的 `.exe`，且目标是真实文件。保留中文/空格、环境变量和大小写语义，不拿目录、脚本或失效登记当应用。
- [x] Programs 与 CommonPrograms 使用系统 Known Folder，而非硬编码用户目录；分别递归读取最多 1000 个 `.lnk`，保持与旧脚本的枚举/截断次序，不扫描桌面、用户磁盘或其他未授权范围。
- [x] 快捷方式目标与参数分别读取；**任何非空 Arguments 都不能入列表**。测试普通参数、仅空白、长参数，不能因缓冲截断、读取失败或解析路径时丢掉参数而误认为空。可参考 [GetArguments 的截断说明](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ishelllinkw-getarguments)，按实际需要使用完整属性值；失败不能默默放行。
- [x] 仅加载/读取 `.lnk`，不调用 Resolve 的交互/搜索/更新能力，不 Save，不执行链接目标、不提取图标或启动安装器。COM 对象、PIDL、系统字符串和注册表句柄正确释放。

### 3.2 UWP、系统项与最终集合

- [x] 保留 `Get-StartApps` 中 AppID 含 `!` 的打包应用，名称、AUMID 和空 `path` 与基线一致；Windows Settings 仍为固定 `appId: system:settings`，不得拿猜测的 exe 替代。
- [x] Explorer/Notepad/Calculator 的发现、PATH 查找顺序及“已存在打包 Notepad/Calculator 时不再添加桌面兜底”按原逻辑对照。不要硬编码本机安装路径或把 WindowsApps 执行别名当成普通快捷方式猜测。
- [x] 最终协议保持 `{applications: [...]}`，桌面项为 `name/path`，打包项为 `name/path:''/appId`。按旧 `Sort-Object` 的 name/path 排序、去重与最终 1500 条截断语义验证；注意当前文化、大小写、同名不同路径、同名不同 AUMID 与稳定排序，不能改为简单 HashMap/字节排序就声称等价。
- [x] TS 的别名、唯一结果直接打开、多候选选择、installer/updater 排除、realpath、取消和授权继续按现有实现运行。本轮仅替换列表来源，不扩大可执行对象范围、不加额外确认框，不建立应用库存持久化缓存。
- [x] 所有来源先做完整集合对照。若 Shell/SDK 候选漏 UWP、漏名称或最终集合不一致，先定位并记录；无法收敛就保留整个 PS action，不能上线“只有部分来源”的列表，也不能在 native 失败时再静默调用 PS。

## 4. 验收：真实接口与隔离数据

- [x] 本机旧 PS 与 Rust 候选均只读枚举，逐字段比较完整列表与顺序，报告条目数、各来源计数和差异类别。不要只比较某三个熟悉应用，也不要只比数量或丢弃排序后宣称全部一致。
- [x] 在本轮自有临时目录生成必要 exe 名称占位文件和 `.lnk` fixture，测试目标存在/缺失、目录冒充 exe、中文/空格、环境变量、非 exe、带参数、超长参数、同名不同路径、坏链接、大小写、1000/1500 边界。这些临时占位文件只供元数据判断，绝不执行。
- [x] fixture 的采集/聚合函数可接收内部路径参数供测试；生产入口只能使用固定系统来源，不在 JSON/CLI 中增加任意注册表或根目录覆盖开关。不要向真实 App Paths 或开始菜单注册测试项，也不要改用户 PATH 来测试查找。
- [x] 用真实 API 读取本轮创建的快捷方式，不能全用 mock 代替 ShellLink；聚合与注册表值解析的固定反例可做 Rust 单测。涉及多语言/文化差异但本机无法验证时，如实列出限制，不伪造另一台机器结果。
- [x] 新增一次真实 `windowsNative` 路由请求（只 mock Electron 路径、不 mock spawn）验证交付 action 的完整结构；复跑 `tools/windows.test.ts` 的包应用、别名、重复、多候选、缺失、取消、实际 exe 路径处理。测试枚举阶段不调用 open/activate。
- [x] 确认 stdin 单请求 EOF 完成、显式父退出、abort 与现有 15s 超时/输出上限保持；长枚举在取消后 helper 实际退出，下一次请求独立。用自有进程/固定数据验证，不终止用户的应用，不扩大时间预算。
- [x] 至少 30 次真实枚举调用检查退出和句柄回收，按请求所属 PID 确认，不把全局进程名列表当成本轮所有权，也不把未知采样结果记为零。复用既有可信测量，不搭通用进程管理系统。

## 5. 性能、采纳与证据

- [x] 基线固定为 `2b0a399` 的 PS action；只提取必要脚本，或核对当前脚本相对该提交确实未改。两侧同机、同一应用登记快照，PS/Rust/Rust/PS 交错，每侧至少 20 个有效请求，warmup 单列。
- [x] 主指标为 spawn 前到 stdio close 的整次枚举 P50/P95，包含进程启动、四类来源与最终协议；不能只测注册表或去掉 Get-StartApps 后比较。记录原始请求、成功/失败和原因，正确性失败不得当离群值剔除。
- [x] CPU 使用两侧同法的进程 user+kernel 累计，内存明确是瞬时、采样最大值或内核峰值；检查 API 返回、资源关闭与有限数，做不到同法就写不可比，不填 0、不输出伪百分比。仅归因本 action，不承诺全应用降幅。
- [x] 采纳门槛：完整行为/退出/业务回归通过，且整次枚举 P95 至少下降 25% 并减少 100ms；或者同法私有内存至少下降 30% 且无明确延迟退化。未达标、集合差异或必要验收失败时不切生产。
- [x] 复用当前 Windows 基准的可靠计量，必要时增加小型 `scripts/benchmark-applications.mjs` 与命令；不复制 UIA fixture 平台、不新增常驻采样器。证据写 `tests/yu-v2/evidence/rust-applications-20261104.json`（跨日用实际日期），包含基线、完整检查、统计、原始样本、限制与采纳决定。
- [x] 真实应用名称、用户路径、快捷方式内容不入 Git 证据；完整对照在本机内存进行，证据仅保存计数、摘要哈希、差异类型及合成 fixture 数据。出现差异也先在本地调查，勿把用户应用清单直接提交。

## 6. 接入、验证与 DSH 收尾

- [x] 只在第 4/5 节通过后，把 `applications` 加入 `src/main/windows-native.ts` 的 `nativeActions`，同步传输测试；若不采纳则保留 PS 路由并解释。`activate` 等剩余 action 的路由不变，既有 PS 资源仍保留。
- [x] 在 `native/windows` 执行 `cargo fmt -- --check`、`cargo clippy --locked --offline --all-targets -- -D warnings`、`cargo test --locked --offline`；复用静态 CRT 构建，无新依赖/版本变动。
- [x] 运行新增应用真实用例、`pnpm exec vitest run src/main/windows-native.test.ts src/main/windows-native-transport.test.ts src/main/windows-native-process.test.ts src/main/tools/windows.test.ts`（加上新增相关文件），并对同一 helper 中的浏览器/Explorer/最近文件做有针对性的回归。
- [x] 实现稳定后一次执行 `pnpm typecheck`、`pnpm test:native`、`pnpm test`、`pnpm build`，如实记录退出码/测试数/失败；不放宽断言和超时，不无目标重复。最后构建后再测最终二进制并回填大小/完整 SHA-256，使入库证据匹配实际交付。
- [x] 本文件补“实施结果”：各来源实现/差异、是否接入及依据、真实/替身验证、测量范围、失败/未测、资源清理与提交编号；更新总计划及确实变化的中英文 README。原生 helper 的最新哈希与各历史阶段交付值要区分。
- [x] 先检查 diff，只提交本轮文件；新计划被忽略时仅对确切路径 `git add -f`，自动 Conventional Commit。不 push、不打包、不发布、不重启/终止用户应用。不清理既有缓存或用户数据，回收自己创建且不再使用的临时副本与 fixture。

完成开发与文档后汇报提交、实际验证、证据、最终产物与限制，等待外部 Codex 主线程复核。不要让内部审查者再为下一阶段拟定并实施新任务。

## 7. 实施结果（DSH 回填）

### 7.1 代码范围

- `native/windows/src/applications.rs`（新增）：`app_paths()` 三处 App Paths 注册表来源（`RegEnumKeyExW` + `RegGetValueW`，同时接受 `REG_SZ`/`REG_EXPAND_SZ`）、`start_menu_shortcuts()`（Programs/CommonPrograms Known Folder，BFS 递归、每个根最多 1000 个 `.lnk`、`IPersistFile::Load` + `GetPath` + `GetArguments` 判空）、`packaged_apps()`（`SHParseDisplayName("shell:AppsFolder")` + `SHBindToObject` + `EnumObjects` + `SHCreateItemWithParent`，只保留 AUMID 含 `!` 的项）、固定 `Windows Settings`、`fixed_commands()`（`PATH` 查找 explorer/notepad/calc 并遵守「已有打包项则跳过」）、`finish()`（`CompareStringEx`+`NORM_IGNORECASE` 名称与 path 比较、文化平局时序数比较挑代表项、去重、1500 截断；见 [正确性续做](2026-11-04-rust-applications-correctness-dsh.md)）。
- `native/windows/src/operations.rs`：新增 `applications` 分支（`Runtime::initialize()` 后调用，与其它 Shell action 一致）。
- `native/windows/Cargo.toml`：只补 `Win32_System_Registry`、`Win32_Storage_EnhancedStorage`、`Win32_Globalization`、`Win32_UI_Shell_Common` 四个 feature，无新 crate、无版本变动。
- `src/main/windows-native.ts`：`nativeActions` 加入 `applications`；`src/main/windows-native-transport.test.ts` 两个 `it.each` 对称调整（native 8 项，PS 仅剩 `activate`/`search`/`current-content`）。
- `src/main/windows-native-applications.test.ts`（新增）：真实 `windowsNative` 路由，只 mock Electron。

### 7.2 与基线的差异与取舍

- 打包项来源：`Get-StartApps`（PS/.NET）与 `shell:AppsFolder` 枚举在本机均为 244 项、AUMID 含 `!` 的 40 项，最终列表 41 个打包项（含固定 `system:settings`）逐字段一致。
- 名称排序：`Sort-Object name,path` 在当前文化下大小写不敏感；`CompareStringEx(..., NORM_IGNORECASE, ...)` 需把 `CSTR_EQUAL` 映射为 `Ordering::Equal`，否则同名不相邻导致去重失效（单测固定该行为）。
- 同名不同大小写路径（`Steam.lnk` 在用户/公共 Programs 分别指向 `steam.exe`/`Steam.exe`）：PS `Sort-Object` 的平局顺序不稳定，实测输出保留 `Steam.exe`；Rust 用 path 序数比较（大写在前），与实测基线一致。
- 参数判定：仅用 `GetArguments` 判长度 > 0（缓冲写满即视为非空并丢弃），不读 `PKEY_Link_Arguments` 属性存储——后者每条链接多一次跨进程调用，且与「非空即排除」的语义等价。
- 性能优化仅在实现层：先读 AUMID 再决定是否读显示名，使 AppsFolder 阶段从约 1440 ms 降到约 586 ms；不改变输出。

### 7.3 真实对照

本机只读枚举：PS 204 项 / Rust 204 项，`missing 0`、`extra 0`、`sameOrder true`，桌面项 163、打包项 41、无位置项 0，完整 JSON 规范化后摘要哈希相同（`908e077a…`）。对照脚本为临时文件，已删除；证据只保存计数与摘要。同序与摘要的可复现入口是基准脚本的 `canonical()`（递归键排序后 `JSON.stringify` 再取 sha256），`sha256sum` 之外的比较口径以它为准。

### 7.4 基准与采纳

证据：`tests/yu-v2/evidence/rust-applications-20261104.json`（`generatedAt` 2026-11-04T02:46:31.772Z，`--samples 20`，PS/Rust 各 40 个有效样本，交错 PS/Rust/Rust/PS，CPU 为 job user+kernel、内存为 job 内核峰值私有提交，区间 spawn → stdio close）。这一轮在 D1–D3 修正、`cargo fmt` 重链接之后重跑，`binary{}` 与实际交付产物同一份构建。

| 指标 | PowerShell | Rust | 变化 |
| --- | --- | --- | --- |
| 整次枚举 P50 | 1611.30 ms | 567.03 ms | −64.81% |
| 整次枚举 P95 | 1707.90 ms | 593.80 ms | −65.23%（−1114.10 ms） |
| CPU P50/P95 | 2281.25 / 2484.38 ms | 359.38 / 421.88 ms | −84.25% / −83.02% |
| 私有内存 P50/P95 | 105448 / 105804 KB | 6624 / 6716 KB | −93.72% / −93.65% |

9 项 checks 全通过（`result-identical`、`same-order-and-membership`、`entry-shape`、`every-sample-valid`、`samples-per-side`、`measurement-comparable`、`job-accounting`、`parent-death-retires-worker`、`performance-threshold`），`passed=true`、`adoption.decision=latency`，双门槛同时满足，因此按第 6 节把 `applications` 接入生产路由。

### 7.5 验证命令与退出码

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `cargo fmt -- --check`（`native/windows`） | 0 | 无差异 |
| `cargo clippy --locked --offline --all-targets -- -D warnings` | 0 | 无警告 |
| `cargo test --locked --offline` | 0 | 28 passed（含 7 条 `applications` 单测） |
| `pnpm exec vitest run <7 个 Windows 相关文件>` | 0 | 7 files / 166 tests passed |
| `pnpm typecheck` | 0 | 通过 |
| `pnpm test:native` | 0 | 各 Rust 二进制测试通过（末个 10 passed，合计 39） |
| `pnpm build` | 0 | built in 11.40s |
| `pnpm test` | 0 | 239 files passed / 3 skipped；3552 passed / 8 skipped |
| `node scripts/benchmark-applications.mjs --samples 20` | 0 | 9 checks PASS，`decision=latency`；本轮 stdout 只存在本地临时文件 `/tmp/apps-bench-final.log`，仓库内以证据文件的数值为准 |

交付产物：`native/bin/yu-windows.exe` 473600 B / `5ad72247c1558fe9489fbad664974a8b46f56b83e52e9daee6e198981bba15e6`，与证据 `binary{}` 一致（`pnpm build` 会重建 helper，最后一次真实构建之后取的哈希）。

### 7.6 失败与修正

- `RegGetValueW` 只接受 `RRF_RT_REG_SZ` 时漏掉 `REG_EXPAND_SZ` 登记（`PowerShell.exe`、`licensemanagershellext.exe`），表现为列表少 2 项；改为同时接受两种类型。
- 用 `size/2-1` 截断默认值名称会多带一个尾字符（实测 `…exee`），改为按首个 NUL 截断。
- `SHCreateItemFromParsingName::<IShellItem2>("shell:AppsFolder").cast::<IShellFolder>()` 返回 `0x80004002`，必须改走 `SHParseDisplayName` + `SHBindToObject`。
- 漏写 `Runtime::initialize()` 时 COM 初始化失败，表现为 shortcuts/packaged 全为 0；已按其它 action 的模式补齐。
- `CompareStringEx` 未把 `CSTR_EQUAL` 映射为 `Ordering::Equal` 时同名项不相邻、去重失效（单测 `left: 4 right: 3`）。
- `is_exe` / `strip_exe_suffix` 原先用 `text[len - 4..]` 按字节切尾，非 ASCII 结尾（`C:\工具\程序`、`C:pps\记事`）会 panic；该函数在 `is_file()` 之前对所有 App Paths 值与所有 `.lnk` 目标调用，一条这样的登记就能让整次枚举崩溃且无 JSON 输出，而 PS 只是跳过该项。改为 `exe_tail()`（`checked_sub` + `get(..)` + `eq_ignore_ascii_case(".exe")`）并补了多字节尾部的单测。
- 删死代码（原 `applications.rs:448` 空 `else if`）时多删一个 `}`，`cargo test` 直接报 `unclosed delimiter`；已修回并复跑。
- 快捷方式遍历原为 BFS，注释却写「Depth-first」；已改为真正的深度优先（先本目录 `.lnk`，再按 `read_dir` 顺序递归子目录），限额前的有序前缀由 [正确性续做](2026-11-04-rust-applications-correctness-dsh.md) 的 `keeps_the_folder_order_before_crossing_into_siblings` 固定；与 PS `Get-ChildItem -Recurse` 在超限场景的精确交错仍属未测。
- 应用测试与浏览器读取测试并行时，`yu-windows.exe` 进程名枚举会串到其他 worker 的 helper，导致「恰好一个新 helper」断言抖动；改为按父进程 PID 归属（`childrenOf`），并让阻塞用例轮询等 helper 出现而不是固定 sleep。

### 7.7 未测项

- 每根目录 1000 条上限命中时的子集选择顺序：Rust 用深度优先、PS 用 `Get-ChildItem -Recurse`，两者在超限场景的精确交错未构造对照。
- 名称排序只在当前机器当前文化下对照；其他语言/区域设置、`Sort-Object` 平局顺序的跨机差异未测。
- 1000 个 `.lnk` 上限、1500 条截断、同名不同 AUMID 的边界只用合成 fixture 与单测覆盖，未在真实登记上构造。
- 打包项名称（`GetDisplayName`）与 `Get-StartApps` 的本地化差异只在本次系统语言下对照。
- 损坏/不可解析的注册表值、权限受限的 App Paths 键、漫游/组策略重定向的开始菜单、多用户并发登录未测。
- 未验证 `activate`（仍是 PS）；本阶段只替换列表来源，打开链路仍包含 PowerShell。

