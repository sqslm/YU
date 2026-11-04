# 阶段 17：应用枚举收口与剩余 Windows 桥接评估

**状态：待 DSH 实施。** 基线 `ff22acb`。工作目录 `E:/code/deepseek-harness/rea/typeless`。

**目标：** 补齐阶段 16 的两个有限收口项，测清仍在 PS 的 `activate`、`search`、`current-content` 的成本与迁移边界，向外部规划者交付有依据的下一步选择。本轮不新增这些 action 的生产 Rust 路由。

**架构：** 继续使用既有 Electron、Windows helper、windows-rs、现有真实 fixture 与计量方式；无新第三方依赖、服务、端口、通用测试/基准框架或数据格式变化。

**派单与汇报顺序：** 外部规划者是 Codex Desktop `01a19b72-79e7-7800-b1b5-55aaf2eeaae6`，执行会话是 DSH `session-850bebee-f8e0-47b1-a9c3-29767a917077`。内部名为 `codex` 的审查者不是本主线程。若需要内部审查，先收齐并处理其结果，再发唯一最终外部完成报告；不得先结束父轮再等迟到团队消息触发新一轮修改。最终报告后让内部协作者等待，只接外部明确派单，不自行开始阶段 18。

## 1. 当前已核对的交付

阶段 16 的已复现 Unicode panic、大小写路径漏去重、限额前 BFS 差异已有修复。Codex 本轮直接运行 `cargo test --locked --offline applications::tests -- --nocapture`，12 passed；没有把旧全量 TS 测试或先前构建记录当成此次重跑。当前资产 480256 B / SHA-256 `a44c2c2ed2cb8ef6511bf8998e2472041fc0dc0ab9c85bf2a22275e3426a5a0e`，与新证据一致；证据记录 80 runs、9 checks、同序 204 项对照。

以下收口仅针对明确缺口，不扩大到另一个枚举重构，也不重做此前 UIA/唤醒/TTS 阶段。

## 2. C1：非字符串值的真实端点测试与 SDK 规则纠正

上轮 `value_missing(2/1630/5)` 单测只验证状态分类，没有执行 `RegGetValueW` 读取 DWORD。报告将增加 `Win32_Security` SDK feature 视为违反“不新增第三方依赖”，这是误解：阶段 16 原计划已允许补必要 Windows SDK feature；添加既有 windows-rs 的 feature 不等于引入新 crate。这里无需征求用户确认，也不因该误解继续跳过必要验证。

- [x] 增加真正调用生产 `default_string`/相关读取函数的测试，覆盖缺失默认值、REG_SZ、REG_EXPAND_SZ、REG_DWORD；对照旧 PS 的实际最终跳过/返回语义。不能仅调用 `value_missing(1630)` 后称端点已验证。
- [x] 测试数据只放在本轮唯一、可明确归属的 HKCU 临时测试子键，**不写真实 App Paths、不改 ACL、不注册应用、不改开始菜单**。已存在测试工具足够就复用；可以用测试侧 .NET/PowerShell 创建键，也可增加必要 SDK feature，选最小实现，不搭 registry mock 平台。
- [x] 所有正常/失败出口关闭句柄并移除自己创建的确切测试键，删除前核对其解析路径和唯一标识仍位于本轮测试分支；不递归清理未知父键。测试进程异常时保留可定位的唯一键名和清理原因，不能顺带清理用户配置。
- [x] 访问拒绝等无法安全制造的故障可以保留模拟/未测，不能通过改真实 App Paths 权限来制造。文档准确区别真实 OS 读取、局部替身与静态检查。
- [x] 修正两份阶段 16 文档中“补 SDK feature 就越过无新依赖边界”的说法及错误验证来源。新增测试数据只用合成值，不提交真实用户登记内容。

## 3. C2：文化比较失败不得隐式变成成功的另一种排序

当前 `culture_compare()` 在 `CompareStringEx` 返回 0 时改走 `left.cmp(right)`，随后 `finish()` 仍返回成功。按[微软返回值契约](https://learn.microsoft.com/en-us/windows/win32/api/stringapiset/nf-stringapiset-comparestringex)，0 是失败，应获取错误；并不是正常 Greater 或另一种文化排序。

这是静态发现的未履行失败契约，Codex 没有在真实系统上制造过该 API 失败。不能把“对某一失败 pair 改走序数”写成已保证整体排序关系一致。

- [x] 在必要排序准备/比较层保留失败，最终让应用枚举以阶段 + Win32 错误明确失败，不输出按另一种排序产生的成功名单；不新增静默回退或吞掉错误。
- [x] 选择最小、关系一致的实现；若采用可失败的排序键准备，先完成准备再调用不失败的排序。不要让比较器在一部分 pair 用文化关系、另一部分用序数关系且仍宣称关系可靠，也不要为此建立通用排序框架。
- [x] 用局部替身固定一个失败返回，断言不会产生成功 JSON/名单；真实 Windows 正常排序与原有大小写穿插去重、截断反例继续通过。替身失败与真实平台验证分别记录。
- [x] 不扩大到别的语言环境或所有 Unicode 等价形式的全套平台测试；其他区域设置限制继续如实保留。

## 4. E1：剩余三个 PS action 的实际边界和成本

阅读 `resources/windows-tools.ps1`、`resources/current-content.ps1`、`src/main/windows-native.ts`、`src/main/tools/windows.ts` 及直接调用者，整理一张表：调用入口、固定输入/输出、缓存与重复调用、Windows 能力依赖、故障/取消语义、Rust 能复用的已有模块、必须保留 TS/PS 的业务边界。频率只能标为代码推断或实测计数，不编造用户使用频率。

- [x] **activate：** 核对 `system:settings` 与注册 AppID 的验证/派发规则。可以对保证不存在的合成 AppID 测量“注册验证直到拒绝”，不能真正打开应用或设置窗口；明确该数字排除了成功 ShellExecute 与窗口可见时间，不将它写成完整激活性能。
- [x] **search：** 在本轮自有临时目录构造固定的小/中等文件树，包含名称、扩展名、日期/大小、递归深度与限额场景，执行实际 PS `search`。区分 Windows Search 可用、索引结果是否命中与目录 fallback；只查询自己的范围，不能为验证扫描用户目录或整个索引。未能测到索引正向时明确说明，不能声称覆盖了它。
- [x] **current-content：** 仅对已有自有 UIA fixture/固定正文做可到达分支的测量，核对浏览器/编辑控件、原窗口、metadataOnly/expectedPath 及 Explorer/Office 特殊路径如何分流。不读用户当前窗口、浏览器登录态或 Office 文档；未测 Office/真实 TextPattern 路径明确列出，不为本轮评估建立大型新 provider。
- [x] 每个实际可安全测量的代表场景至少 10 个有效样本，warmup 单列；记录 spawn 到 stdio close 的 P50/P95、原始样本/失败原因。能同法可靠测到的 helper CPU/私有内存可记录，不能测到就写不可用，不填零，不外推整应用收益。
- [x] 本轮不实现这三个 action 的生产 Rust 版本、不调整路由、不增加缓存、不迁移存储、不打开应用、不修改系统设置。源码阶段划分及性能测量不是新增执行这些动作的权限。

## 5. E2：交付可据以决定下一轮的建议

- [x] 对 `activate`、`search`、`current-content` 分别给出“适合下一轮完整迁移 / 仅适合一个明确子范围 / 暂保留 PS”的结论，依据包含实测包装成本、原生功能是否已有、兼容/验证难点与剩余未测项，不能仅以“PS 还在”当迁移理由。
- [x] 若建议只迁一个子范围，写清生产路由如何在执行前确定，不能设计失败后改走 PS 的隐式回退；无可行验收边界就不推荐上线。
- [x] 对首选候选写出下一轮所需文件、协议、兼容门槛与可执行验证；若三项均收益不明或风险不匹配，可以明确建议此轮 Rust 迁移到此收束，不为维持接力制造空任务。
- [x] 将评估与实际测量写入本文件“实施与评估结果”，新证据 `tests/yu-v2/evidence/rust-windows-remaining-20261104.json`（跨日用实际日期）。证据只含合成数据/计数，旧证据原样保留。

## 6. 验证与 DSH 自行收尾

- [x] 检查 HEAD/状态，保留已有 WIP；只改 C1/C2 所需模块、测试、必要计量与文档。任何已在并行处理中完成的项先核对，不重复覆盖。
- [x] C1/C2 稳定后执行 `native/windows` 的 fmt/clippy（`--locked --offline --all-targets -- -D warnings`）/cargo test，以及直接相关 Windows/工具 Vitest、`pnpm typecheck`。生产代码有变时再跑最终 `pnpm test:native`、`pnpm test`、`pnpm build`，不搬用上轮次数声称本轮通过。
- [x] 如生产资产因 C2 或 feature 变更重链接，最后构建后复跑应用完整名单对照和既有基准一次，写新的带实际日期/收口标记的证据文件，保留旧 `rust-applications-correctness-20261104.json`；核对最终大小/完整 SHA-256。评估部分没有 Rust 对照时不伪造“Rust 提升”。
- [x] 回填本文件、总计划阶段 17 与阶段 16 收口说明；逐项列实际实现/验证、测量范围、限制、清理与提交编号，README 仅改确实变化的行为。
- [x] 清理本轮自有临时文件/窗口/测试键与探针，不删历史证据、用户数据或既有缓存；只暂存本轮文件自动 Conventional Commit，不 push、不打包、不发布、不重启用户应用。
- [x] 内部审查须在最终外部报告前收齐。最终一次报告实现、测量与建议后，等待绑定外部 Codex 决定下一步，不自行写并实施阶段 18。

## 7. 实施与评估结果

### 7.1 C1：注册表真实端点测试与 SDK 规则纠正

- 生产读取路径抽出 `app_path_entry(key, name)`（`default_string` → `unquote(expand_environment(..))` → `is_exe` → `is_file`），测试直接调用它，而不是只测 `value_missing`。
- 测试 `reads_real_registry_values_like_the_baseline` 用 `RegCreateKeyExW` 在 `HKCU\Software\yu-applications-test-<pid>-<nanos>` 建本轮唯一临时键，四档默认值：缺失 → `Ok(None)`；`REG_SZ` 带引号的 `<SystemRoot>\System32
otepad.exe` → 去引号后的路径；`REG_EXPAND_SZ` 的 `%SystemRoot%\System32
otepad.exe` → 展开后的路径；`REG_DWORD` 4660 → `Ok(None)`（`ERROR_UNSUPPORTED_TYPE` 视为跳过该项，与基线一致）。
- `TestKey` 的 `Drop` 先关子键句柄并 `RegDeleteKeyW` 子键、再关父句柄删父键（顺序写反会得到 `Win32 error 6`）；删除目标是本轮唯一键名，不递归清理未知父键。正常与失败出口都会走到该清理。
- PS 侧同值对照（一次性脚本，已删）：在 `HKCU:\Software\yu-applications-pscmp-<pid>` 建同样四档后跑基线管线（`ExpandEnvironmentVariables` → `Trim('"')` → `.exe` 正则 → `Test-Path -Leaf`），`accepted` 依次 false/true/true/false，与 Rust 逐项一致。
- 规则纠正：`Win32_Security` 是既有 `windows` crate 的 feature，不是新 crate；阶段 16 计划本就允许补必要 Windows SDK feature。上轮把它当作「越过不新增依赖边界」而跳过端到端验证属误读，本轮已补测试并回改正确性计划 §8.6 的措辞。真实 App Paths 键本轮仍未写入。

### 7.2 C2：文化比较失败不再变成另一种排序

- `culture_compare` 返回 `Result<Ordering, Failure>`：`CompareStringEx` 返回 0 时取 `GetLastError` 并以 `failed("Application sort", win32(code))` 上抛，不再当作 `Greater`、也不回退序数比较。
- `same_key` 与 `compare_entries` 与排序使用同一关系；`finish()` 改为可失败比较器的稳定归并排序（`merge_sort`/`merge`），排序完成后再按 `same_key` 去重、`truncate(1500)`。文化平局时用 path 的序数比较仅作**次键**挑稳定代表项，注释写明这不是失败回退，也不是全局顺序承诺。
- 局部替身：`#[cfg(test)] static FORCE_COMPARE_FAILURE: AtomicBool`（命中即 `failed("Application sort", win32(5))`），`a_failed_culture_comparison_fails_the_read` 断言返回 `Err` 且文案以 `applications read failed at Application sort: Win32 error` 开头——失败不会产出成功名单或 JSON。真实平台上没有制造过该 API 失败，故「真实失败路径」记为未测。
- 踩坑：`split_off` 返回尾部，最初把两半写反导致稳定序反向（`orders_case_insensitively…` 报 `left: "alpha" right: "Alpha"`），改为 `let tail = head.split_off(head.len() / 2)` 后通过。

### 7.3 E1：三个仍在 PS 的 action 的边界与实测成本

调用面（代码推断，无使用频次遥测，不编造频率）：`activate` 由 `src/main/tools/windows.ts:238` 的打开应用工具以 `{action:'activate', appId}` 调用；`search` 由 `:419` 的文件搜索工具以 `{root,name,extension(s),recursive,after,before,minBytes,sort}` 调用；`current-content` 由 `:169` 的 `originalContext()`（浏览器地址、编辑器正文读取路径）以 `{action:'current-content', metadataOnly?, expectedPath?}` 调用。

| action | 输入 → 输出 | Windows 能力 | 故障/取消 | 可复用的 Rust 模块 | 必须留在 TS/PS 的边界 |
| --- | --- | --- | --- | --- | --- |
| `activate` | `{appId}` → `{}` 或错误 | `Get-StartApps` 校验 + `ShellExecute` 打开 `shell:AppsFolder\<appId>` | 取消靠信号杀进程；AppID 不存在时报 `Registered app is no longer available` | `applications.rs` 已能枚举 AUMID 与打包项 | 打开后的窗口存在性、前台切换、失败重试策略 |
| `search` | 见上 → `{backend, files[]}` | Windows Search（OLE DB provider）+ 目录 fallback 遍历 | 15s 超时、取消、索引不可用回落 | 目录遍历可借 `recent/folder` 的 `read_dir` 模式 | 索引语义（命中、排序、日期/大小过滤）与 fallback 合并 |
| `current-content` | 见上 → `{title, truncated, text?/path?}` | UIA `TextPattern`/`ValuePattern` + Office/Explorer 特例 | 原窗口校验、`expectedPath` 拒绝、取消 | `address.rs` 的 UIA 骨架与 `assert_original` | Office COM 正文、Explorer 选中项、登录态与受限文件 |

实测（`scripts/benchmark-windows-remaining.mjs`，每个场景 1 次 warmup 后取 10 个有效样本，spawn → stdio close，koffi job 记账统计 CPU 与内核私有峰值）：

| 场景 | 覆盖 | P50 / P95 | CPU P50/P95 | 私有峰值 P50/P95 | 有效 |
| --- | --- | --- | --- | --- | --- |
| `activate`（合成 AppID `yu-remaining-missing-appid`） | 仅 AppID 校验直到拒绝；**不含** `ShellExecute` 与窗口可见 | 1329.48 / 1387.51 ms | 2000.00 / 2062.50 ms | 70292 / 70616 KB | 10/10（均 exit 1 + 同一文案） |
| `search`（自有临时树：4 × `.txt` + 1 × `.md`，`recursive`、name 过滤 `sample`） | `backend=windows-search+folder`、`indexUnavailable=false`，返回 4 条且都在本轮临时根下 | 991.03 / 1017.52 ms | 1796.88 / 1875.00 ms | 67524 / 67724 KB | 10/10 |
| `current-content`（仓库自有 UIA fixture `address-edit`） | 无 Document 元素的分支；Office/Explorer/真实 `TextPattern` 未测 | 1077.76 / 1100.29 ms | 1859.38 / 1953.13 ms | 76692 / 76896 KB | 10/10 |

限制：三项都只测到 PowerShell helper 的包装成本，没有 Rust 对照，故不构成「Rust 提升」。`search` 的命中没有逐条区分索引与目录 fallback，索引正向未被单独证明；`activate` 的数字排除了成功激活与窗口出现时间。

### 7.4 E2：下一轮建议

- **`activate`：暂保留 PS。** 校验部分可复用 `applications.rs` 的 AUMID 枚举，原生打开也只需一次 `ShellExecute`，但验收必须真的启动目标应用或设置窗口，本轮与后续自动化都无法在不触碰用户环境的前提下稳定断言；只测拒绝路径不足以支撑上线判断。
- **`search`：暂保留 PS。** Windows Search 的索引语义（命中、排序、日期/大小过滤）无法用自有树证明；用 Rust 只改写目录 fallback 会让每次搜索变成「PS 索引 + Rust 遍历」双进程，收益方向不明。
- **`current-content`：暂保留 PS。** 真实价值在 Office 正文、Explorer 选中项与受限文件分流，验收需要真实 Office/编辑器窗口与文档，属于本仓库当前不方便自动化的面。
- **总体：建议 Rust 迁移在此收束。** 阶段 17 的收口项已全部落地，三项剩余 action 均无可验证的收益/边界，不为维持接力制造空任务。若将来重启 `activate`，前置条件是：可注入的启动 seam（测试替换 `ShellExecute`）+ 一个自有沙箱应用 fixture，能在不打开用户应用的前提下断言「校验通过 → 启动调用发生 → 失败/超时出口」，并把成功路径与拒绝路径分开计量。

### 7.5 验证与产出

命令与退出码（`/tmp/verify17b.sh` → `/tmp/v17b.log`，逐条记录；按阶段 12 的教训，日志作为临时产物在结题时清理，下表是当轮记录。复现只需按顺序执行同样的六条命令 + 两条基准，命令原文见本行上方的脚本内容或 §6）：

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `cargo fmt -- --check`（`native/windows`） | 0 | — |
| `cargo clippy --locked --offline --all-targets -- -D warnings` | 0 | 无告警 |
| `cargo test --locked --offline` | 0 | 35 passed |
| `pnpm exec vitest run`（7 个 windows/工具测试文件） | 0 | 7 files / 166 tests passed |
| `pnpm typecheck` | 0 | — |
| `pnpm test:native` | 0 | 39 passed |
| `pnpm build` | 0 | built |
| `pnpm test` | 0 | 239 files passed / 3 skipped；3552 passed / 8 skipped |
| `node scripts/benchmark-applications.mjs --samples 20` | 0 | 80 runs、9/9 checks、`decision=latency`、entries 204 |
| `node scripts/benchmark-windows-remaining.mjs --samples 10` | 0 | 三场景各 10/10 有效、`cleanup.failures` 为空 |

产物与证据：`native/bin/yu-windows.exe` 466944 B / `0a1680bedd2f8bdf73014ff0838768e4c51fb47dedba001c23132c984903497e`（删掉 `compare_entries` 的测试期调试打印后重链接得到），与两份本轮证据的 `binary`/`helper` 字段一致。真实对照 Rust 204 / PS 204、`sameOrder true`、两侧 exit 0、stderr 空。收口基准 `tests/yu-v2/evidence/rust-applications-closure-20261104.json`（`generatedAt` 2026-11-04T03:51:16.884Z，80 runs、9/9 checks、`decision=latency`、两侧 204 项；总数 1580.03/1610.69 → 566.60/587.53 ms，−64.14%/−63.52%、P95 −1023.16 ms；CPU 2265.63/2437.50 → 359.38/421.88 ms，−84.14%/−82.69%；私有内存 105364/105656 → 6612/6712 KB，−93.72%/−93.65%）；评估证据 `tests/yu-v2/evidence/rust-windows-remaining-20261104.json`（`generatedAt` 2026-11-04T03:51:56.501Z，三场景共 30 个有效样本，`cleanup` 只记 `{mode,pid,handle,title,exitCode}` 与临时目录路径，`failures` 为空）。旧证据 `rust-applications-20261104.json` 与 `rust-applications-correctness-20261104.json` 原样保留。

### 7.6 清理与提交

清理：`/tmp/pscmp.ps1`、上一轮的 `/tmp/verify17.sh` 与 `/tmp/v17.log`、本轮的 `/tmp/verify17b.sh` 与 `/tmp/v17b.log`、`/tmp/s17-*` 等临时脚本与输出；基准脚本收尾只结束自己启动的 fixture/目录，不按进程名强杀。提交见下一节回执（实现+证据、文档两个提交，未 push）。

## 8. Codex 最终复核与本轮收束

Codex 核对 `bf21eea` 的收口代码、交付 SHA-256、应用基准 80 条样本及 9 项通过检查，确认剩余桥接评估的三个场景各 10 个有效样本、无失败，fixture 正常退出、清理无失败。三项数据仅来自 PS：`activate` 只测拒绝路径，`search` 未单独证明索引命中，`current-content` 只覆盖指定 fixture；不是剩余功能已经完成原生迁移的证据。

最终复核额外复现一个测试专用的并发串扰：全局 `FORCE_COMPARE_FAILURE` 可被另一测试线程消费。新增 `comparison_failure_stays_with_its_test_thread` 在修复前失败（`another test consumed the injected failure`），将开关改为 `#[cfg(test)]` 下的线程局部 Cell 后通过；真实注册表端点与原有反例继续通过。Codex 直接执行 `cargo fmt -- --check`、`cargo clippy --locked --offline --all-targets -- -D warnings`、`cargo test --locked --offline`，全部退出 0，最终 **36 项 Rust 测试通过**。上文 DSH 的 35 项是交付链的历史记录，不改写为本次运行数。

这次补丁只影响测试注入及测试用例，未修改生产逻辑或重建 release 资产；复核后的交付仍为 466944 B / `0a1680bedd2f8bdf73014ff0838768e4c51fb47dedba001c23132c984903497e`，与两份证据一致。没有为测试改动重跑全部 TS 套件或伪造新版性能数字。

**本轮结论：已收束。** 保留 `activate`、`search`、`current-content` 的现有 PS 实现；后续只有建立足够隔离、可复现的成功路径/索引/真实文档验收后再重新评估。结束本轮自动派单，保留汇报能力，不为保持接力生成空任务。没有 push、打包、发布或重启用户应用。

