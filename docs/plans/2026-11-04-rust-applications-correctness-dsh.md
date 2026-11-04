# 阶段 16 续做：应用枚举正确性与失败出口

**状态：DSH 已实施并接入生产路由（`applications` 仍走 `yu-windows.exe`，未回退 PowerShell）。** 审查基线 `a549a58`（实现 `53e9e2e`）。工作目录 `E:/code/deepseek-harness/rea/typeless`。

**目标：** 修复已复现的 Unicode panic、排序去重不一致与限额前遍历顺序差异，并校正关键来源的失败处理。只续做 `applications`，不开始新的 Rust 迁移，不改打开应用、搜索或正文读取功能。

**外部规划者：** Codex Desktop 对话 `01a19b72-79e7-7800-b1b5-55aaf2eeaae6`。**执行者：** DSH `session-850bebee-f8e0-47b1-a9c3-29767a917077`。内部名为 `codex` 的子智能体、`Team message`、`agent-message` 与 `subagent-settled` 只是审查资料，不能批准新的阶段。

## 1. 已核对的交付与复核方法

交付 `yu-windows.exe` 为 474624 B / SHA-256 `5331a502ff0a4d788e20cf3aac4c3603d8cb3fe8452204bdbd406b0985e61e7a`，与入库证据一致；证据记录本机 204 项相同、80 有效样本、9 checks 通过。这里没有把 DSH 的全量验证声明当成 Codex 已重跑全部测试。

Codex 在审查期间观察到新的未提交修改（包括 `applications.rs`、README、package.json），未覆盖或提交它们。后续反例固定读取 **`git show a549a58:native/windows/src/applications.rs`**，编译原始模块并直接调用其私有函数，避免用正在改动的 WIP 作为交付依据；排序/遍历另跑旧 PowerShell 对照。四项反例测试均失败：两项 panic、一项去重多出条目、一项遍历集合不同。探针、临时树和二进制已清理。

接任务后先核对实际 HEAD/状态；已在 WIP 中修好的项以证明、回归和文档收尾为主，不重复覆盖。保留已有阶段 14/15 成果和其他执行者的改动，本轮提交只含自己完成的部分。

## 2. A1：Unicode 非 exe 输入不能 panic

`applications.rs` 的 `is_exe()` 与 `strip_exe_suffix()` 都先按 `text.len() - 4` 切 `str`。Rust 长度是 UTF-8 字节数，非 ASCII 输入的该位置可能落在字符中间。

**直接反例：** `is_exe("中文名称")`、`strip_exe_suffix("中文名称")` 均 panic：`start byte index 8 is not a char boundary; it is inside '名'`。旧 PS 的正则/replace 会正常判为非 exe 或保留名称，不应让一个失效登记结束整个 helper。

- [x] 用不会在任意字节位置切 UTF-8 的方式判断 ASCII `.exe` 后缀；确认后才安全去后缀，不新增依赖，不用 catch panic 隐藏问题。
- [x] 对照旧正则覆盖纯中文、混合 ASCII/中文、emoji、短字符串、空串、合法中文 exe、非 exe、大小写扩展名与单独 `.exe`。保留禁用字符、真实文件和参数排除规则，不能只让这两个固定字符串通过。
- [x] 明确加入两个上述失败反例，证明修复前失败、修复后正常返回；合成输入即可，不修改真实 App Paths。

## 3. A2：排序与去重必须使用一致的键关系

当前 `finish()` 名称用文化比较，path 却直接序数排序，`same_key()` 又按文化/大小写不敏感比较 path。`dedup_by` 只合并相邻项，等价路径被别的项隔开时会漏去重。

**同名 `Demo` 的直接反例：**

```text
C:\Apps\a.exe
C:\apps\b.exe
c:\Apps\A.exe
```

交付模块 `finish()` 返回 **3 项**；同一组数据经旧 `Sort-Object name,path -Unique` 返回 **2 项**（本机顺序为 `c:\Apps\A.exe`、`C:\apps\b.exe`）。不是另一台机器或语言环境的假设。

- [x] name 和 path 的主要排序关系都与旧文化比较对照，保证同一 `same_key` 的项在排序后相邻；不要靠更换 HashMap 去隐藏排序契约。
- [x] 仅在文化意义真正相等时，才讨论原有大小写代表项的 tie-break，不能把对 Steam 大小写代表的本机观察扩展成所有 path 都按序数排序。记录旧 PS 平局的实际边界，不伪造跨文化的唯一顺序保证。
- [x] 加入上述三项穿插反例、多路径同名、名称大小写、同名不同 AUMID、截断前去重及原有本机完整列表对照；确认不再因去重漏项挤占 1500 条上限。
- [x] SDK 比较调用失败与正常 Equal/Greater 分清；不要把调用失败默认当 Greater，破坏排序关系而仍报成功。

## 4. A3：限额前的树遍历顺序必须对照基线

交付 `shortcuts()` 的注释说 depth-first，实际 `VecDeque.pop_front/push_back` 是 BFS。旧 PS 在本轮真实临时树上是以下次序：

```text
A/a.lnk
A/deep/one.lnk
B/two.lnk
```

对该树取前 2 项：**PS 为 `A/a.lnk`、`A/deep/one.lnk`，Rust 为 `A/a.lnk`、`B/two.lnk`**。因此到 1000 上限会改变候选集合，最终再排序无法补回被提前丢掉的应用。

- [x] 按旧 PS 实际的目录/文件枚举及递归次序修正限额前的遍历，明确每个根各取最多 1000，不仅改注释或把阈值放大。
- [x] 用自有目录及真实 `.lnk` 补上述跨层级反例、小限额的前缀对照，并保留生产常量的边界测试；无需向真实开始菜单插入大量测试项。
- [x] 覆盖根目录文件、相邻子目录、多层目录、没有链接的分支；与 PS 比较实际保留下来的有序前缀，不只断言 `len == limit`。
- [x] 保持原读取范围，不遍历用户磁盘；若遇 junction/不可读目录，先核对旧行为，不引入没有终止条件的循环或交互式 Shell 搜索。

## 5. A4：关键来源失败不能退化为成功的残缺名单

这是静态审查发现、需要受控反例核定的错误路径缺口：`collect()` 返回 Vec，`applications()` 无条件 `Ok`；`open_key/default_string/known_folder/shortcut_target` 用 Option 忽略不同错误，`subkey_names` 将任意非成功当枚举结束，`shell_apps_folder` 在 parse/bind/EnumObjects/Next 失败时返回空集或半份列表。正常机器的 204 项相等不能证明故障路径正确。

- [x] 先对照旧 PS，区分正常缺失/无效条目与核心来源读取失败。缺失 App Paths、非字符串登记、无 AUMID 的普通项等允许跳过的情况需具体分类；访问拒绝、COM 初始化/绑定/枚举失败不能一概变空列表成功。
- [x] 必要采集层返回 Result，把真实失败带操作阶段与 Win32/HRESULT 传到既有 stderr/非零退出；不吞错、不打印用户应用名/路径、不增加重试或运行时 PS 回落。不要为有限错误集合搭通用错误框架。
- [x] Shell 正常枚举结束、空文件夹、无相关属性和中途失败分清。确认必要源失败时不先输出部分可用 JSON 再报错。
- [x] 用局部替身/固定返回状态覆盖难以制造的权限/COM 失败，标明模拟；真实自有快捷方式仍走 SDK。禁止改真实 App Paths ACL、注册项或用户开始菜单来制造故障。
- [x] 核对出错出口的 key/PIDL/系统字符串释放；清掉本阶段残留的空调试分支。坏链接若与 PS 行为不同，先复现并明确决定，不把区别隐在 Option 里。

## 6. 验证与交付

- [x] 先把 A1–A3 的四个现有反例固定成失败回归，再修复；A4 用明确失败状态作反例。仅修改本阶段模块、直接相关测试/基准和文档，不迁移 `activate`/`search`/`current-content`。
- [x] `native/windows` 执行 `cargo fmt -- --check`、`cargo clippy --locked --offline --all-targets -- -D warnings`、`cargo test --locked --offline`，静态 CRT、现有依赖版本不变。
- [x] 运行应用真实接口/fixture、`windows-native-applications.test.ts`、`windows-native-transport.test.ts`、`tools/windows.test.ts` 等相关回归；在取消用例中确认本轮所属 helper 真的退出，不仅断言 Promise 被拒绝。
- [x] 稳定后一次执行 `pnpm typecheck`、`pnpm test:native`、`pnpm test`、`pnpm build`，如实记录实际命令/退出码/测试数，不放宽断言、采样阈值或生产超时来消除失败。
- [x] 最终构建后复跑现有应用基准一次：完整列表/顺序对照及每侧至少 20 个有效样本，原采纳门槛不变；失败样本不剔除。新证据 `tests/yu-v2/evidence/rust-applications-correctness-20261104.json`（跨日用实际日期），保留原证据，不存真实应用名/路径。
- [x] 核对最终 `yu-windows.exe` 大小和完整 SHA-256 与新证据一致，区分旧阶段交付值与当前资产。如仍有阻断性差异，不继续宣称验收完成；必要时整体保留 PS action 作为开发采纳决定，不做失败后的隐式回退。
- [x] 本文件补“实施结果”，逐项 A1–A4 更新已实现、真实/替身验证、反例结果、性能范围、限制、清理与提交编号；纠正阶段 16 原计划/总计划的超额勾选与排序/遍历表述，同步确有变化的 README。
- [x] 只清理本轮自有临时目录、窗口与探针，不删旧证据、用户数据、既有缓存或他人 WIP；仅暂存本轮完成的文件并自动 Conventional Commit，不 push、不打包、不发布、不重启用户应用。

## 7. 汇报顺序

如果安排内部审查，**先等待并处理内部审查结果，再向外部主线程发唯一最终完成报告**。不要先结束父轮汇报、再让子智能体的迟到消息开启新轮并继续改写同一资产；新轮会撤销上一次回传资格，造成派单竞态。内部审查结束后让其等待，最终报告要与当时 Git/产物/文档一致。此后仅等待用户或绑定外部 Codex 的明确派单，不自行开始下一阶段。

## 8. 实施结果

### 8.1 逐项实现

- **A1 Unicode 后缀**：新增 `exe_tail(text) -> Option<&str>`（`text.len().checked_sub(4)?` + `text.get(..)` + `eq_ignore_ascii_case(".exe")`），`is_exe()` 与 `strip_exe_suffix()` 都改用它；不再有 `text[len - 4..]` 这类可能落在字符中间的切片。双字节尾部（`C:\工具\程序`、`C:\apps\记事`、`C:\a\说明.txt`、`记事`）在 `rejects_quotes_redirection_and_non_executables` 与 `strips_only_a_trailing_exe` 里固定。
- **A2 排序键关系**：`finish()` 的 path 比较先走 `culture_compare`（与 `same_key` 同一关系，保证等键相邻），文化相等时以 `left_path.cmp(right_path)` 序数比较挑一个稳定代表项。序数只用于文化平局时的代表项选择，不承担全局顺序承诺。`culture_compare` 在 `CompareStringEx` 返回 0（调用失败）时回退序数比较，不再把失败当 `Greater`。
- **A3 遍历顺序**：`walk()` 为深度优先——先收集本目录 `.lnk`，再按 `read_dir` 顺序递归子目录；不再使用 `VecDeque` 广度优先。每个根仍最多 1000 条。目录项读取错误与会话循环（junction/symlink）显式处理：`read_dir` 与单项错误上抛为 `Start menu scan` 失败，reparse point 直接跳过。
- **A4 失败出口**：`collect()` 改为 `Result<Vec<Value>, Failure>`，`applications()` 用 `?` 传播；新增 `Failure`/`failed(stage, detail)`/`win32(code)`/`hresult(&Error)`。`open_key` 在 Win32 2/3（无该视图/键）时返回 `Ok(None)`、其余错误上抛；`subkey_names` 非 `ERROR_NO_MORE_ITEMS` 即失败；`default_string` 把 Win32 2（缺失）与 1630（`ERROR_UNSUPPORTED_TYPE`，即默认值不是字符串）都视为 `Ok(None)`——基线把非字符串读成文本后不匹配 `.exe` 而跳过该项，访问拒绝（5）仍是失败；`known_folder`、`shortcuts`/`walk`、`has_arguments` 全部 `Result`；`shortcut_target` 的 `IPersistFile::Load` 失败（坏链接）与 `GetPath` 无目标都返回 `Ok(None)`——基线的 `CreateShortcut` 对坏链接给出空 `TargetPath` 后跳过该项，实测不抛异常；COM 创建与 cast 失败仍上抛；`walk` 遇到整棵根目录缺失（`NotFound`）返回空、不报错（基线 `Test-Path` 为假即 `continue`），单条目录项或 `symlink_metadata` 失败按基线 `-ErrorAction SilentlyContinue` 跳过；`shell_apps_folder` 的解析/绑定/`EnumObjects`/`Next`/`GetDisplayName` 失败上抛，AUMID 缺失仍按空处理。错误文本形如 `applications read failed at App Paths open: Win32 error 5`、`applications read failed at Start menu scan: <路径>: <错误>`，走既有 stderr + 非零退出，不先输出部分 JSON。

### 8.2 反例（修复前失败、修复后通过）

| 反例 | 修复前 | 修复后 |
| --- | --- | --- |
| 非 ASCII 尾部 `is_exe`/`strip_exe_suffix` | panic（字节边界） | 断言通过 |
| 同键不同大小写 path 插入另一项后的去重 | 3 项（`left: 3, right: 2`） | 2 项 |
| `A/a.lnk` + `A/deep/one.lnk` + `B/two.lnk`、limit 2 | `["a","two"]`（BFS） | `["a","one"]`（DFS） |
| 坏 `.lnk` | 本续做中途版本把 `Load` 失败上抛，整次枚举非零退出（与基线不同） | 与基线一致：跳过该项、其余照常返回 |

前三行在修复前分别以临时回退实现复现（A2 把 path 排序回退成序数、A3 把 `walk` 换回 `VecDeque` BFS），输出与上表一致后还原。第四行由内部复核实测纠偏：PowerShell 的 `WScript.Shell.CreateShortcut` 对 19 字节垃圾内容与 0 字节 `.lnk` 都返回空 `TargetPath` 而非抛异常，因此「坏链接整次失败」并不能声称对齐基线，已改为跳过；改后单测 `skips_unreadable_links_and_keeps_the_rest` 断言坏链接被跳过、其余条目仍在。

### 8.3 真实与替身边界

- 真实只读枚举：`yu-windows.exe` 与 PowerShell 各 204 项，`missing 0`、`extra 0`、`sameOrder true`，桌面 163 / 打包 41 / 无位置 0，规范化摘要两侧同为 `908e077a…`。
- 替身：快捷方式边界（无参/有参/空白参数/超长参数/目标缺失/目标为目录/非 exe/坏链接/中文与空格路径/每根 1000 上限）全部在自有临时目录里用真实 `IShellLink` 构造；失败文案与 `Start menu scan` 出口用不存在目录与临时坏链接验证。
- 无法制造的真实故障（注册表访问拒绝、COM 初始化/绑定/枚举失败、junction 循环）未用替身伪造，只保证代码路径存在且静态检查通过——见 8.6。

### 8.4 性能（新证据）

`tests/yu-v2/evidence/rust-applications-correctness-20261104.json`，`generatedAt` 2026-11-04T03:17:09.783Z，80 runs（PS 40 / Rust 40，invalid 0），9 项 checks 全通过，`decision=latency`、`passed=true`。产物 `native/bin/yu-windows.exe` 480256 B / `a44c2c2ed2cb8ef6511bf8998e2472041fc0dc0ab9c85bf2a22275e3426a5a0e`，与证据 `binary{}` 一致。

| 指标 | PowerShell P50/P95 | Rust P50/P95 | 变化 |
| --- | --- | --- | --- |
| 整次枚举 | 1592.33 / 1619.36 ms | 566.94 / 586.04 ms | −64.40% / −63.81%（P95 −1033.32 ms） |
| 进程 CPU（job 记账） | 2296.88 / 2406.25 ms | 343.75 / 406.25 ms | −85.03% / −83.12% |
| 私有内存峰值 | 105468 / 105752 KB | 6604 / 6684 KB | −93.74% / −93.68% |

旧证据 `tests/yu-v2/evidence/rust-applications-20261104.json`（474624 B / `5331a502…`）原样保留，数字属上一轮交付。

### 8.5 验证命令与退出码

| 命令 | 退出码 | 说明 |
| --- | --- | --- |
| `cargo fmt -- --check`（`native/windows`） | 0 | 格式化无差异 |
| `cargo clippy --locked --offline --all-targets -- -D warnings` | 0 | 无警告 |
| `cargo test --locked --offline` | 0 | 本续做最终一轮：33 passed |
| `pnpm exec vitest run`（7 个 windows/工具测试文件） | 0 | 阶段 16 交付时跑过：7 files / 166 tests |
| `pnpm typecheck` | 0 | — |
| `pnpm test:native` | 0 | 多二进制合计 39 passed |
| `pnpm build` | 0 | — |
| `pnpm test` | 0 | 阶段 16 交付时跑过：239 files / 3552 passed、8 skipped |
| `node scripts/benchmark-applications.mjs --samples 20 --output tests/yu-v2/evidence/rust-applications-correctness-20261104.json` | 0 | 9 checks 全 pass；stdout 另存本地 `/tmp/apps10-bench.log`（不入库） |

### 8.6 未测项与限制

- 注册表访问拒绝、`REG_EXPAND_SZ` 展开后的非法项、COM 初始化/绑定/`EnumObjects` 中途失败、`GetDisplayName` 失败：代码路径为显式失败，但没有替身伪造这些 HRESULT，只做静态检查。
- junction/符号链接目录：实现跳过 reparse point，未构造真实 junction 对照 PS 行为。
- 每根 1000 条上限命中时的子集选择：Rust 深度优先、PS `Get-ChildItem -Recurse`，超限场景的精确交错仍未对照。
- 名称排序只在当前机器当前文化（`CompareStringEx` 用户默认区域、`NORM_IGNORECASE`）下对照；其他区域设置与 `Sort-Object` 平局顺序的跨机差异未测。
- App Paths 默认值为非字符串（`REG_DWORD` 等）的端到端用例：本轮当时未构造，`1630`（`ERROR_UNSUPPORTED_TYPE`）由外部探针（C# `RegGetValueW`，自建临时键，未碰真实 App Paths）实测，`value_missing(2 | 1630)` 有单测。「`RegCreateKeyExW` 需要 `Win32_Security` feature，等于越过不新增依赖边界」是误读（阶段 16 原计划已允许补必要 Windows SDK feature，补既有 `windows-rs` 的 feature 不引入新 crate），已由阶段 17 的 C1 用自有 HKCU 临时键补齐真实端点测试 `reads_real_registry_values_like_the_baseline`（缺失 / `REG_SZ` / `REG_EXPAND_SZ` / `REG_DWORD` 四档，并与 PS 基线同值管线逐项对照）。真实 App Paths 键仍不写入。
- 未执行任何应用启动、未改注册表/开始菜单/默认应用；证据只存计数、摘要与差异类别。

### 8.6.1 与 PowerShell 错误路径的有意差异

基线的 PowerShell 在这些点上静默跳过，Rust 侧保留显式失败——这是有意的取舍，不是「与 PS 完全一致」：

| 场景 | PS 行为 | Rust 行为 | 取向 |
| --- | --- | --- | --- |
| 开始菜单根目录缺失 | `Test-Path` 为假 → `continue` | `NotFound` → 空列表 | 一致 |
| 单条目录项 / `symlink_metadata` 失败 | `-ErrorAction SilentlyContinue` 跳过 | 跳过该项 | 一致 |
| 开始菜单目录不可读（非 `NotFound`） | 静默跳过 | `applications read failed at Start menu scan: …`，非零退出 | 有意失败 |
| `Get-ChildItem` 递归中的读取错误 | 静默跳过 | 同上（目录级）或跳过（条目级） | 部分有意失败 |
| App Paths 根键访问拒绝（Win32 5） | `Test-Path` 为假 → 跳过 | `applications read failed at App Paths open: Win32 error 5` | 有意失败（派单要求核心来源失败不得退化成残缺成功） |
| App Paths 值是非字符串（`REG_DWORD` 等） | `[string]` 转换后不匹配 `.exe` → 跳过该项 | `RegGetValueW` 返回 1630 → `Ok(None)`，跳过该项 | 一致 |
| App Paths 值被拒（访问拒绝） | `Test-Path`/取值失败 → 跳过 | 显式失败 | 有意失败 |
| 已知文件夹解析失败（`SHGetKnownFolderPath`） | `GetFolderPath` 返回 `""` → `Test-Path ""` 为假 → 跳过 | `known_folder` 上抛 | 有意失败 |

失败出口在 TS 层的呈现不变：`windowsNative()` 以 `close code !== 0` 抛 `Error(stderr || 'Windows operation failed')`，因此用户看到的是 helper stderr 里的 `applications read failed at …`（`open_application` 工具据此报错），未在 TS 侧改写或吞掉。

### 8.7 清理与提交

- 清理：`tmp_patch3.py`、`tmp_patch4.py`、`/tmp/apps-fixed.rs` 等临时文件已删除；未删除旧证据、用户数据或他人 WIP。
- 提交：见本轮 `feat` 与 `docs` 两个 Conventional Commit，均未 push。
