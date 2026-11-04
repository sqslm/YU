# 阶段 14：资源管理器文件夹读取的 Rust 迁移与验收

**状态：DSH 已实施并接入生产路由。** 基线：`f31e17a`，工作目录 `E:/code/deepseek-harness/rea/typeless`。

**目标：** 把 `windowsNative({ action: 'explorer-folder', handle, pid, title })` 从 PowerShell 迁到已有的一次性 `native/bin/yu-windows.exe`，在行为一致、取消与回收通过、同机对照达标的前提下接入生产；不达标就保留 PS 路由并如实结项。

`explorer-folder` 与阶段 13 的 `browser-url` 同属“冻结窗口 + 读一个路径”，可复用 `assert_original` 与窗口归属逻辑，是本轮收益/风险比最高的候选。阶段 13 已确立的测量口径（job 记账 CPU、spawn → stdio close、job 内核私有内存峰值）继续沿用，便于跨阶段横比。

## 1. 边界

- 只迁移 `explorer-folder`。`current-content` 的网页正文依赖 Document 元素，本机 Edge 不向 UIA 暴露，真实验收做不了，**本阶段不碰**；`recent-files`、应用枚举、激活、搜索、窗口枚举同样不动。
- 不新增常驻服务、端口或可执行文件；不新增依赖、不升级工具链；不改 `windowsNative` 的 15s 预算、2MB 输出上限、abort 与 `--parent-pid` 回收。
- 不改 `src/main/tools/windows.ts` 的权限与路径判断：`explorer-folder` 的调用前置条件（`appName` 为 explorer、敏感应用拒绝）仍在 TS 侧。
- 不改两个偶发失败的测试（`src/main/providers/search-pool.test.ts`、`src/main/update-download.test.ts`），只如实记录。

## 2. 基线行为（`resources/windows-tools.ps1:40-49`，必须逐条对齐）

```powershell
$shell = New-Object -ComObject Shell.Application
$windows = $shell.Windows()
$folders = @($windows | Where-Object { [long]$_.HWND -eq [long]$request.handle } |
  ForEach-Object { $_.Document.Folder.Self.Path } | Sort-Object -Unique)
Assert-OriginalWindow
@{folder=$(if ($folders.Count -eq 1 -and [IO.Directory]::Exists($folders[0])) { $folders[0] } else { $null })}
```

要点：先按 HWND 过滤（非本窗口的 Shell 窗口不取 `Document`，因此它们的文档类型不影响结果）；命中窗口取 `Document.Folder.Self.Path`；`Sort-Object -Unique` 去重（默认大小写不敏感）；**再次** `Assert-OriginalWindow`；只有“恰好一个且是真实目录”才给 `folder`，否则 `null`（键始终存在）。输出 `ConvertTo-Json -Compress`。

## 3. 实施条款

- [x] `native/windows/src/folder.rs`：`IShellWindows`（CoCreateInstance + `ShellWindows` CLSID + `CLSCTX_ALL`）枚举 `Count()`/`Item(VARIANT)` → `IWebBrowser2`（`HWND()` 过滤冻结窗口）→ `Document()` → `IShellFolderViewDual` → `Folder()` → `Self_()` → `Path()`。命中窗口内的 COM 失败向上返回，与 PS 的 `$ErrorActionPreference='Stop'` 一致；未命中窗口不触碰其文档。
- [x] 去重与选择：按大小写不敏感排序去重；`len == 1` 且 `Path::is_dir()` 才给值，否则 `null`。逻辑抽成可单测的纯函数。
- [x] 读前、读后各一次 `assert_original`；`assert_original` 从 `address.rs` 移到 `operations.rs`（`pub(crate)`）供两个动作共用，行为不变，`window_check` 的 `IsIconic` 规则不动。
- [x] `operations.rs` 增加 `explorer-folder` 分支（`Runtime::initialize()` 后调用）；`Cargo.toml` 只按需补 `Win32_UI_Shell`，不加 crate。
- [x] TS 侧：达标后把 `explorer-folder` 加入 `src/main/windows-native.ts` 的 `nativeActions`，并同步 `src/main/windows-native-transport.test.ts` 的两个 `it.each`（从 PS 名单移到 native 名单）。
- [x] PS 侧 `resources/windows-tools.ps1` 的 `explorer-folder` 分支保留，仅作基准对照与回滚参照，生产不再路由。

## 4. 真实验收

- [x] 真实资源管理器窗口（`explorer.exe`）打开一个本地目录，冻结 HWND/PID/标题；PS 与 Rust 输出 `{"folder": "..."}` 逐字一致（仅键序可比）。
- [x] 反向：不是资源管理器的窗口（无 Shell 窗口绑定，如记事本）→ 两侧都给 `null`；窗口已关闭/标题失配 → 两侧都非零退出并报 `Original window has changed or closed`。
- [x] 目录被删除后同一窗口 → `null`（`Directory::Exists` 语义）。
- [x] 父进程退出 → helper 以 0 退出（`--parent-pid` 指向被 kill 的 `ping`）。
- [x] 至少 40 次实际启停，`close` 正常收尾、无超时项。

## 5. 同机对照与采纳门槛

- PS 侧直接跑生产 `resources/windows-tools.ps1`；Rust 侧跑本轮候选；两侧读同一个冻结窗口。
- PS/Rust/Rust/PS 交错，两侧各 ≥20 个有效请求，报告 P50/P95（最近秩法 `ceil(n·q)-1`）、CPU（job user+kernel，spawn → stdio close）、私有内存（job 内核峰值）。
- 采纳门槛：行为/退出/回归通过，且整次请求 P95 下降 ≥25% 并 ≥100ms；或私有内存 P50 下降 ≥30% 且无延迟退化。未达标则保留 PS 路由。
- 证据 `tests/yu-v2/evidence/rust-explorer-folder-20261104.json`，`kind: windows-helper-comparison`，含 meta/aggregate/runs/comparison/checks/adoption/binary，任一硬检查失败即非零退出。

## 6. 验证与交付

- [x] `cd native/windows && cargo fmt -- --check && cargo clippy --locked --offline --all-targets -- -D warnings && cargo test --locked --offline`
- [x] `node scripts/benchmark-explorer-folder.mjs --samples 20`（退出码 0）
- [x] `pnpm exec vitest run src/main/windows-native.test.ts src/main/windows-native-transport.test.ts src/main/windows-native-process.test.ts src/main/tools/windows.test.ts src/main/current-content.test.ts`
- [x] `pnpm typecheck`、`pnpm test:native`、`pnpm build`、`pnpm test`（失败项如实记录）
- [x] 所有会触发 `build-native` 的验证结束后再算最终 `yu-windows.exe` 大小/SHA-256；证据必须对应交付版本（重链接必然换哈希，窗口内哈希取最后一次真实构建之后的值）。
- [x] 文档：本节勾选 + §7 实施结果、`docs/rust-refactor-plan.md` 阶段 14 行与结果段、README 两版职责描述；阶段 13 的 P3 修正随本轮文档提交带上。
- [x] 两次提交（实现+证据、文档），不 push、不打包、不重启应用。

## 7. 实施结果

**代码范围。** 新增 `native/windows/src/folder.rs`（约 110 行，含 3 个单测）：`IShellWindows` 枚举 → `IWebBrowser2::HWND()` 过滤冻结窗口 → `Document()` → `IShellFolderViewDual` → `Folder()` → `Folder2::Self_()` → `FolderItem::Path()`；`select()` 做大小写不敏感去重，只有唯一且 `Path::is_dir()` 才给值。`assert_original` 从 `address.rs` 上移到 `operations.rs` 供两个读取动作共用，`window_check` 的“最小化即报错”规则未变。`operations.rs` 增加 `explorer-folder` 分支（先 `Runtime::initialize()`），`Cargo.toml` 只补 `Win32_UI_Shell`，未新增依赖。

**接入依据。** TS 侧只把 `explorer-folder` 加入 `src/main/windows-native.ts` 的 `nativeActions`，`src/main/windows-native-transport.test.ts` 的两个 `it.each` 同步（native 名单加、PS 名单减）；15s 预算、2MB 输出上限、`--parent-pid`、取消语义与权限前置条件（`appName` 为 explorer、敏感应用拒绝、允许目录）全部未改。PS 侧 `resources/windows-tools.ps1:40-49` 的 `explorer-folder` 分支保留，仅作基准对照与回滚参照。

**真实对照（首轮，两侧各一次）。** PS 与 Rust 输出 `{"folder":"E:\CpanQianYi\Temp\yu-explorer-folder-…"}` 逐字一致（键序相同，因为只有一个键）；非 Shell 窗口两侧都返回 `{"folder":null}`；stale 标题与失效句柄两侧都非零退出并报 `Original window has changed or closed`；父进程退出后 helper 3ms 内以 0 退出。

**同机对照（每侧 40 个有效样本，80 次运行，`--samples 20`）。**

| 指标 | PowerShell P50 | Rust P50 | P50 变化 | PowerShell P95 | Rust P95 | P95 变化 |
| --- | --- | --- | --- | --- | --- | --- |
| 整次请求 | 985ms | 39ms | −96.1% | 1015ms | 44ms | −95.7%（−971ms） |
| CPU（job user+kernel） | 1766ms | 31ms | −98.2% | 1859ms | 47ms | −97.5% |
| 私有内存峰值（job 内核） | 67564KB | 1716KB | −97.5% | 67748KB | 1804KB | −97.3% |

9 项 checks 全 PASS、退出码 0，`decision = latency`（延迟与内存门槛同时满足）。

**证据。** `tests/yu-v2/evidence/rust-explorer-folder-20261104.json`，`generatedAt` 2026-11-04T00:04:26Z，`kind: windows-helper-comparison`，80 runs（40/40，invalid 0），`binary` 396800 B / `aa9232e554340e42d13e01f7e99e718f31415ec2a008e7222a2ce9c31f222010`。

**失败与修正。** ① 初次 smoke 用 `title === marker` 匹配窗口，实际标题带 ` - 文件资源管理器` 后缀，导致 fixture 找不到 → 改为 `startsWith(marker)` 且限定 `CabinetWClass`。② `tmpdir()` 返回 8.3 短路径而 Shell 报长路径，`folder-present` 误判 → 用 `realpathSync.native()` 归一后比较。③ `Folder` 接口没有 `Self_`，需把 `Document.Folder` 转成 `Folder2` 才能取 `Self` → 显式 `cast::<Folder2>()`。④ 探针脚本曾把两个临时资源管理器窗口留在桌面，已用 Shell COM `Quit()` 清理，之后的基准只关闭自己打开的窗口。

**未测项。** 同一 HWND 多标签/多 Shell 文件夹的歧义、UNC 与超过 260 字符路径、符号链接与 OneDrive 占位目录、请求中途窗口被关闭（仅用失效句柄近似）、UAC 提权窗口、锁屏与远程桌面均未测；`select()` 的歧义与缺失目录分支只由单测覆盖。

**验证。** `cargo fmt -- --check`、`cargo clippy --locked --offline --all-targets -- -D warnings`、`cargo test --locked --offline`（12 单测）、`node scripts/benchmark-explorer-folder.mjs --samples 20`、`pnpm exec vitest run` 五个 Windows 相关文件（149 用例）、`pnpm typecheck`、`pnpm test:native`、`pnpm build`、`pnpm test`（237 文件 3535 用例通过，3 文件 8 用例跳过）全部退出码 0；验证链结束后重新取 `sha256sum native/bin/yu-windows.exe` 仍为 `aa9232e5…`（cargo 未重新链接）。

**清理。** 删除 `.tmp-explorer-probe.mjs`、`.tmp-verify14.sh`、`tests/yu-v2/evidence/.smoke-explorer.json` 与临时目录；基准结束自行关闭 fixture 窗口。
