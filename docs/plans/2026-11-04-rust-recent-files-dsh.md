# 阶段 15：最近文件读取迁入 Rust Windows helper

## 1. 范围与选型

### 1.1 区间

`resources/windows-tools.ps1:6-18` 的 `recent-files` 分支 → `native/windows/src/recent.rs`（新增），
经 `native/bin/yu-windows.exe` 一次性进程提供；达标后把 `recent-files` 加入
`src/main/windows-native.ts` 的 `nativeActions`。

不改 TS 侧的 `search_file_activity` 过滤逻辑（`pathAllowed` / `realpath` / `stat` / `day`）——
那是路径权限与业务过滤，不属 helper 职责。

### 1.2 候选与排序

可迁移的 Windows helper 动作只剩 `recent-files` 与 `current-content`。

- 调用频次在仓库里数不出来：没有工具调用遥测，`history.sqlite` 只存会话内容不存工具名。
  能数的是调用点与入口——唯一 TS 调用点 `src/main/tools/windows.ts:143`，
  确定性短语入口 `src/main/tools/windows.ts:98`（正则 `最近(?:打开|使用)(?:过的|过|的)?(?:哪些|什么)?文件`），
  schema `src/main/tools/windows.ts:478`，启用清单 `src/shared/workflow-tool-groups.ts:6`、`src/shared/workflow.ts:59`。
- 因此判据改为**单位成本 × 可达性**：`recent-files` 每次请求最多枚举 300 个 `.lnk` 并为每个创建
  `WScript.Shell.CreateShortcut` COM 对象，是本 helper 剩下的最贵分支；可达性由短语入口保证。
- `current-content` 不排：本机 Edge 不向 UIA 暴露 `Document` 元素（阶段 13 已实测），真实验收构造不出来。

结论：15-A 定为 `recent-files`。

## 2. 基线行为（`resources/windows-tools.ps1:6-18`，逐条对齐）

```powershell
$recent = [Environment]::GetFolderPath('Recent')
$shell = New-Object -ComObject WScript.Shell
$files = @(Get-ChildItem -LiteralPath $recent -Filter '*.lnk' -File |
  Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 300 |
  ForEach-Object {
    $shortcut = $shell.CreateShortcut($_.FullName)
    if ($shortcut.TargetPath) { @{path=$shortcut.TargetPath;recordedAt=$_.LastWriteTimeUtc.ToString('o');source='Windows Recent'} }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut)
  })
@{files=$files;source='Windows Recent'} | ConvertTo-Json -Depth 4 -Compress
```

要点：

- 目录 = `[Environment]::GetFolderPath('Recent')`（已知文件夹，不是手拼 `%USERPROFILE%\Recent`）。
- 只取 `*.lnk` 且是文件；**先按 `.lnk` 的 `LastWriteTimeUtc` 降序，再取前 300**。
- 每个 `.lnk` 用 `WScript.Shell` 解析；`TargetPath` 为空即跳过，不产生半条记录。
- `recordedAt` 是 **`.lnk` 文件**的 `LastWriteTimeUtc` 按 .NET `'o'` 格式化：`yyyy-MM-ddTHH:mm:ss.fffffffZ`
  （7 位小数 + `Z`），不是目标文件的时间。
- 键序参与可比性（`JSON.stringify` 保插入序）：顶层 `files` → `source`；每条 `path` → `recordedAt` → `source`。
  `source` 字面量 `Windows Recent`。
- 解析失败在 `$ErrorActionPreference='Stop'` 下向上抛，不静默丢条。

**实测键序（2026-11-04，用注入临时目录的同一表达式取到）：** `{"source":"Windows Recent","files":[{"path":…,"source":…,"recordedAt":…}]}`——顶层 `source` 先于 `files`，每条 `path` → `source` → `recordedAt`，三次独立进程一致。Rust 侧 `serde_json` 默认按字典序输出（`files` 先、`path` → `recordedAt` → `source`），**键序不同、文档语义相同**。要逐字对齐得开 `serde_json` 的 `preserve_order`，那会引入 `indexmap` 传递依赖；按“不新增依赖”的约束，基准的 `result-identical` 用解析后结构比较，不按字节比较。下游 `JSON.parse` 不依赖键序。

**本机现状：** `[Environment]::GetFolderPath('Recent')` 下 `.lnk` 计数为 0，因此端到端内容对照不可得；`.lnk` 解析、排序、`recordedAt` 格式由 `recent.rs` 单测钉住（期望值取自上面那次派生 PS 输出）。基准只读真实目录、不写入。

## 3. 实施条款

- [x] `native/windows/src/recent.rs`：`SHGetKnownFolderPath(FOLDERID_Recent)` 取目录 → `FindFirstFileW`/`FindNextFileW`
  枚举 `*.lnk`（文件）→ 按 `LastWriteTimeUtc` 降序稳定排序 → 截断 300 → 逐个
  `CoCreateInstance(ShellLink)` + `IPersistFile::Load(STGM_READ)` + `IShellLinkW::GetPath` → 空目标跳过。
- [x] `recordedAt` 用 `GetFileAttributesExW` / `metadata().modified()` 的 UTC 时间格式化成本节的 7 位小数 + `Z` 形状；
  纯函数 + 单测钉住格式（含 0 微秒、整秒、跨年边界）。
- [x] 键序与字面量由 `serde_json` 插入序保证；`path` → `recordedAt` → `source`，顶层 `files` → `source`。
- [x] `operations.rs` 增 `recent-files` 分支（`Runtime::initialize()` 后调用）；不引入 `assert_original`（本动作不绑定窗口）。
- [x] `Cargo.toml` 只按需补 feature（`Win32_UI_Shell` 已有；`.lnk` 解析可能补 `Win32_System_Com` 相关已有项），不加 crate。
- [x] 基准 `scripts/benchmark-recent-files.mjs`：沿用 `benchmark-explorer-folder.mjs` 骨架（koffi job 记账、
  最近秩百分位、checks 任一失败即非零退出），无窗口 fixture；`result-identical` 只比同一次配对运行内的输出，
  另加 `recent-stable-during-run`（跑前跑后条目数与排序键一致；漂移只记录不掩盖）。
- [x] 基准**只读真实 Recent 目录，绝不写入**（`.lnk` 一创建就在操作者机器上留痕）；不加"基准专用目录"开关。
- [x] TS 侧达标后：`recent-files` 加入 `nativeActions`，同步 `src/main/windows-native-transport.test.ts` 两个 `it.each`。
- [x] PS 侧 `recent-files` 分支保留，仅作基准对照与回滚参照。

## 4. 真实验收

- [x] 真实 Recent 目录：PS 与 Rust 输出 `path` / `recordedAt` / `source` 逐字一致（含键序），条目数一致。
- [x] 300 条截断：若真实目录不足 300 条，如实记录实测条目数，不构造。
- [x] 空目标 `.lnk` 跳过：由单测覆盖；真实目录中若存在则一并记录。
- [x] 解析失败向上报：由单测/契约覆盖，真实目录未构造。

## 5. 采纳门槛

沿用阶段 13/14 口径（最近秩百分位）：

- `latencyMeets`：整次请求 P95 降幅 ≤ −25% 且降幅绝对值 ≥ 100 ms；或
- `memoryMeets`：私有内存（job 内核峰值）P50 降幅 ≤ −30% 且延迟无退化（P95 降幅 ≤ 0）。
- 两者都不满足 → `decision: below-threshold`，保留 PS 路由并如实记录。

CPU 口径：job `user+kernel` 差分，区间 spawn → stdio close；私有内存取 job `PeakProcessMemoryUsed`。

## 6. 验证与交付

```
cd native/windows && cargo fmt -- --check
cargo clippy --locked --offline --all-targets -- -D warnings
cargo test --locked --offline
cd ../.. && node scripts/benchmark-recent-files.mjs --samples 20
pnpm exec vitest run src/main/windows-native.test.ts src/main/windows-native-transport.test.ts
pnpm typecheck
pnpm test:native
pnpm build
pnpm test
sha256sum native/bin/yu-windows.exe   # 必须在最后一次真实构建之后取
```

日志保留逐条 `EXIT[...]`。两次提交（实现 + 证据 / 文档），不 push。

## 7. 未测项

- Recent 目录为空或无 `.lnk`：**本机实测为 0 条**，因此真实条目内容的端到端对照不可得；`.lnk` 解析、排序与 `recordedAt` 格式由 `recent.rs` 单测覆盖（期望值取自注入临时目录的派生 PS 输出）。
- `.lnk` 指向已删除或不可访问的目标。
- 网络共享（UNC）目标。
- 正好 300 条的截断边界与 `LastWriteTimeUtc` 并列时的顺序：未构造（截断由常量 300 保证，未做边界实测）。
- 用户运行中途打开文件导致的条目漂移：基准的 `recent-stable-during-run` 只检测并记录，不阻断；本轮 80 次运行期间未观测到漂移。
- 损坏 / 非标准 `.lnk`：未构造，解析失败路径按“向上报错”实现但无实测。

## 8. 实施结果

- 代码：`native/windows/src/recent.rs`（枚举、排序、截断、`IShellLinkW` 解析、`recordedAt` 格式化，5 个单测）；`operations.rs` 增 `recent-files` 分支；`Cargo.toml` 未新增 crate/feature；TS 侧 `src/main/windows-native.ts` 的 `nativeActions` 加 `recent-files`，`src/main/windows-native-transport.test.ts` 两个 `it.each` 对称交换。
- 基准：`scripts/benchmark-recent-files.mjs`（无窗口 fixture，只读真实 Recent 目录；7 项 checks，任一失败即非零退出）。
- 证据：`tests/yu-v2/evidence/rust-recent-files-20261104.json`，`generatedAt` 2026-11-04T00:17:38.919Z，`binary` 418816 B / `f822b819…`，80 runs（PS 40 / Rust 40，invalid 0）。

| 指标 | PowerShell | Rust | 变化 |
| --- | --- | --- | --- |
| 整次请求 P50 / P95 | 878.81 / 913.21 ms | 24.88 / 26.93 ms | −97.17% / −97.05%（P95 −886.28 ms） |
| CPU（job user+kernel） | 1578.13 / 1718.75 ms | 15.63 / 31.25 ms | −99.01% / −98.18% |
| 私有内存峰值 P50 / P95 | 67520 / 67716 KB | 1536 / 1548 KB | −97.73% / −97.71% |

- 结论：`decision = latency`，两项门槛均满足，`recent-files` 已接入生产路由。
- 与 PS 的差异只有键序（见 §2）；`result-identical` 按解析后结构比较。`meta.fixture.entriesAtStart/AtEnd` 均为 0，目录在 80 次运行期间未变。

| 命令 | 退出码 |
| --- | --- |
| `cargo fmt -- --check` | 0 |
| `cargo clippy --locked --offline --all-targets -- -D warnings` | 0 |
| `cargo test --locked --offline` | 0（17 单测） |
| `node scripts/benchmark-recent-files.mjs --samples 20` | 0（`passed: true`） |
| `vitest run windows-native / windows-native-transport / speech / tts` | 0（24 用例） |
| `pnpm typecheck` | 0 |
| `pnpm test:native` | 0 |
| `pnpm build` | 0 |
| `pnpm test` | 0 |

- 最终产物：`native/bin/yu-windows.exe` 418816 B / `f822b8194353582f9172013bec351de82f888078d73fa2fa9b3053cf90ec29c7`（最后一次真实构建之后取，验证链未重新链接）。

