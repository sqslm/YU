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

## 3. 实施条款

- [ ] `native/windows/src/recent.rs`：`SHGetKnownFolderPath(FOLDERID_Recent)` 取目录 → `FindFirstFileW`/`FindNextFileW`
  枚举 `*.lnk`（文件）→ 按 `LastWriteTimeUtc` 降序稳定排序 → 截断 300 → 逐个
  `CoCreateInstance(ShellLink)` + `IPersistFile::Load(STGM_READ)` + `IShellLinkW::GetPath` → 空目标跳过。
- [ ] `recordedAt` 用 `GetFileAttributesExW` / `metadata().modified()` 的 UTC 时间格式化成本节的 7 位小数 + `Z` 形状；
  纯函数 + 单测钉住格式（含 0 微秒、整秒、跨年边界）。
- [ ] 键序与字面量由 `serde_json` 插入序保证；`path` → `recordedAt` → `source`，顶层 `files` → `source`。
- [ ] `operations.rs` 增 `recent-files` 分支（`Runtime::initialize()` 后调用）；不引入 `assert_original`（本动作不绑定窗口）。
- [ ] `Cargo.toml` 只按需补 feature（`Win32_UI_Shell` 已有；`.lnk` 解析可能补 `Win32_System_Com` 相关已有项），不加 crate。
- [ ] 基准 `scripts/benchmark-recent-files.mjs`：沿用 `benchmark-explorer-folder.mjs` 骨架（koffi job 记账、
  最近秩百分位、checks 任一失败即非零退出），无窗口 fixture；`result-identical` 只比同一次配对运行内的输出，
  另加 `recent-stable-during-run`（跑前跑后条目数与排序键一致；漂移只记录不掩盖）。
- [ ] 基准**只读真实 Recent 目录，绝不写入**（`.lnk` 一创建就在操作者机器上留痕）；不加"基准专用目录"开关。
- [ ] TS 侧达标后：`recent-files` 加入 `nativeActions`，同步 `src/main/windows-native-transport.test.ts` 两个 `it.each`。
- [ ] PS 侧 `recent-files` 分支保留，仅作基准对照与回滚参照。

## 4. 真实验收

- [ ] 真实 Recent 目录：PS 与 Rust 输出 `path` / `recordedAt` / `source` 逐字一致（含键序），条目数一致。
- [ ] 300 条截断：若真实目录不足 300 条，如实记录实测条目数，不构造。
- [ ] 空目标 `.lnk` 跳过：由单测覆盖；真实目录中若存在则一并记录。
- [ ] 解析失败向上报：由单测/契约覆盖，真实目录未构造。

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

## 7. 未测项（事先登记）

- Recent 目录为空或无 `.lnk`。
- `.lnk` 指向已删除或不可访问的目标。
- 网络共享（UNC）目标。
- 正好 300 条的截断边界与 `LastWriteTimeUtc` 并列时的顺序。
- 用户运行中途打开文件导致的条目漂移（基准只检测并记录，不阻断）。
- 损坏 / 非标准 `.lnk`。

## 8. 实施结果

待回填。
