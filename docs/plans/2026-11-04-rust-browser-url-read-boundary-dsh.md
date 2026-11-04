# 阶段 13 短续做：地址读取边界与有限场景补齐

**状态**：DSH 已实施（待外部 Codex 复核）。基线 `34fc2f3`，上一轮实现 `078cb05`。

## 1. 范围

只修已经复现的「读取被排除候选的 Value」以及上一轮缺失的少量分支验收，沿用现有 helper、自有 provider、生产运行器与基准脚本，不迁移其他 Windows 操作、不新建测试框架。

## 2. B1：先确认候选资格，再读取 Value

- [x] `native/windows/src/address.rs` 的候选循环先判 `toolbar && chrome`，不满足直接 `continue`，通过后才调用 `value(&edit)`；错误传播与读取次数契约不变。
- [x] 自有 provider 在 `IValueProvider.Value` getter 内记录 `value-read` 事件（仅 fixture，不进入生产 helper）。
- [x] 正向地址栏仍读到 Value（`addressEditBox` 1 次）；`pseudo-address`、`excluded-value-blocked`、`no-value-pattern` 的 Edit 读取为 0。
- [x] 被排除候选的 Value 会阻塞时（`excluded-value-blocked`）两侧都不进入 getter，响应明显快于 fixture 的 2s 闸门。

## 3. B2：补齐仍缺失的有限场景

- [x] 无 ValuePattern：有资格候选不暴露 ValuePattern 时两侧都正常忽略；只把 `UIA_E_NOTSUPPORTED` 与「S_OK + 空接口」归为无 Pattern，其他失败仍带阶段与 HRESULT 上抛。
- [x] 真实文件路径：临时文件带中文、空格与字面百分号；两侧返回同一条精确 `path`，不存在文件不转 `path`，目录不当文件；保留大写 scheme 与 fragment 反例。
- [x] `metadataOnly`：无地址栏时跳过 Document Value（读取 0 次）；有地址栏时仍允许唯一 Document URL 覆盖地址栏值（Document 读取 1 次），两侧返回体一致。
- [x] 完整请求后的父退出：写完 JSON 并关闭 stdin、provider 已进入阻塞后终止父进程，helper 自行退出；与「stdin 未 EOF」用例区分。

## 4. 未测（本轮不做）

UNC 共享可达性、真实浏览器（Edge/Chrome/Firefox）与密码管理器、UAC/锁屏/RDP、跨进程 provider 崩溃。provider 异常被 UIA core 吞掉的现象只描述本 fixture 与故障档位，不推广为「客户端可见故障只有两种」。

## 5. 验证与证据

`cargo fmt -- --check`、`cargo clippy --locked --offline --all-targets -- -D warnings`、`cargo test --locked --offline`；`pnpm exec vitest run` 六个文件；`pnpm typecheck`、`pnpm test:native`、`pnpm test`、`pnpm build`；`node scripts/benchmark-browser-url.mjs --samples 20`。新证据 `tests/yu-v2/evidence/rust-browser-url-read-boundary-20261104.json`，旧证据不改。

## 6. 实施结果

### 6.1 改动

| 文件 | 改动 |
| --- | --- |
| `native/windows/src/address.rs` | 候选循环先判 `toolbar && chrome` 再读 Value；`local_path` 改为 UTF-8 百分号解码（`PathCreateFromUrlW` 按 ANSI 解码，中文路径会变乱码）；新增 3 条单测（UTF-8 文件名、`.NET` 其余边界、失败文案与 HRESULT） |
| `tests/yu-v2/fixtures/uia-provider.cs` / `.ps1` / `.md` | `value-read` 事件（只在 `IValueProvider.Value` getter 内触发）、`value-blocked`、四个新 mode（`excluded-value-blocked`、`no-value-pattern`、`metadata-document`、`metadata-override`）、`file-url` 文件名改为 `yu-uia-中文 100% <guid>.md`、`-ListModes` 补齐 23 项 |
| `scripts/uia-fixture-check.mjs` | `--events` 探针（读取顺序、metadataOnly 边界、阳性对照）、`--file` 断言随新文件名更新 |
| `scripts/benchmark-browser-url.mjs` | 新增 5 个正确性 mode、按 side 统计 `value-read`、3 项读取边界 checks、`watchdog` 兜底（helper 已退出但不发 `close` 时不再挂死整轮） |
| `src/main/windows-native-browser-url.test.ts` | 13 个用例：读取计数、阻塞候选、`no-value-pattern`、两个 `metadataOnly`、`file-url`、父进程退出；连续请求改为 60 次（阈值仍 ≥30 个观测 PID，采样在忙时会漏） |
| `tests/yu-v2/evidence/rust-browser-url-read-boundary-20261104.json` | 本轮证据（新文件，旧证据不改） |

### 6.2 先失败后通过的反例证据

把候选循环临时还原成上一轮的元组求值写法、`node scripts/build-native.mjs` 重建（`8e423797…`），`node scripts/build-native.mjs` 后的产物跑 `-t 'value once'` 得到：

```
AssertionError: expected [ Array(1) ] to have a length of +0 but got 1
```

即修复前被排除的伪地址 Edit 确实被读了 1 次；恢复修复后重建（`11994ce3…`），同一用例通过（0 次）。fixture 侧 `pseudo-address`、`excluded-value-blocked`、`no-value-pattern` 三档在两侧都是 0 次 Edit 读取。

### 6.3 基准（`node scripts/benchmark-browser-url.mjs --samples 20`）

`tests/yu-v2/evidence/rust-browser-url-read-boundary-20261104.json`，`generatedAt` 2026-11-04T01:36:54.298Z，80 runs（PS 40 / Rust 40），invalid 0，17 项 checks 全 PASS，`passed=true`，`decision=latency`。

| 指标 | PowerShell P50 / P95 | yu-windows P50 / P95 | 变化 |
| --- | --- | --- | --- |
| 整次请求 | 1158.66 / 1272.69 ms | 45.00 / 50.57 ms | −96.1% / −96.0% |
| 进程 CPU（job user+kernel） | 2000 / 2187.5 ms | 31.25 / 46.875 ms | −98.4% / −97.9% |
| 内核私有内存峰值 | 76552 / 76804 KB | 2464 / 2500 KB | −96.8% / −96.7% |

`binary`：430592 B / `11994ce36ac6f3ed111dde68746c369486378d6270f32d030853c1a38887f49d`，与验证链结束后 `sha256sum native/bin/yu-windows.exe` 一致（`build`/`test`/`test:native` 均未触发重新链接）。

### 6.4 验证命令与退出码

| 命令 | 退出码 | 关键输出 |
| --- | --- | --- |
| `cargo fmt -- --check`（`native/windows`） | 0 | 无输出 |
| `cargo clippy --locked --offline --all-targets -- -D warnings` | 0 | `Finished dev profile` |
| `cargo test --locked --offline` | 0 | 21 passed |
| `pnpm exec vitest run`（6 个 Windows/地址相关文件） | 0 | 6 files、162 tests passed |
| `pnpm typecheck` | 0 | 两次 `tsc --noEmit` 通过 |
| `pnpm test:native` | 0 | 39 passed |
| `pnpm build` | 0 | `✓ built in 11.63s` |
| `pnpm test` | 0 | 236 files、3548 passed / 8 skipped |
| `node scripts/benchmark-browser-url.mjs --samples 20` | 0 | 17 checks PASS、`decision=latency` |

### 6.5 失败与修正（本轮自身）

1. `retires the helper when its own parent dies after a complete request` 首版一直报「fixture never reported blocked」：传给 `node -e` 的子程序里写了 `"\n"`，TS 先把它变成真换行、`-e` 源码出现跨行字符串字面量（`SyntaxError: Invalid or unexpected token`），父进程根本没起 helper。改成 `String.fromCharCode(10)` 后通过。
2. 六个文件在同一 vitest 进程池里跑时曾挂起 19 分钟：同一个语法错误让 `node -e` 父进程异常退出、fixture 停在 `blocking`、随后的 `settle` 一直等到超时，占住了 worker。修复后 6 文件 98s 跑完；`pnpm test` 全量 98s 亦通过。
3. 连续请求用例原先 40 次请求 + 忙时采样漏记，偶发 `seen.size < 30`：改为 60 次请求（阈值仍是 ≥30），单独跑与全量跑都稳定通过。
4. 基准首跑在 helper 已退出但 `close` 未触发时整轮挂死：加 `settled` 守卫与 `timeoutMs + 5000` 的 `watchdog` 兜底。

### 6.6 未测与边界

- 客户端侧 HRESULT 失败注入仍不可得：进程内 provider 抛异常会被 UIA core 吞掉，fixture 只能证明「provider 侧异常在两侧都表现为空结果 + exit 0」与「窗口消失 exit 1」「读取永久挂死被 15s 预算终止」。本轮把失败文案与阶段/HRESULT 格式用单测钉住（`failures_report_the_stage_and_hresult`），但「真实 UIA 失败时 helper 非零退出且不输出 JSON」这条链路没有端到端用例。
- `metadataOnly` 只在本 fixture 上验了 Document Value 的读取次数与覆盖行为，未接真实 Office/浏览器文档。
- 未测（沿用第 4 节）：UNC 共享可达性、真实浏览器与密码管理器、UAC/锁屏/RDP、跨进程 provider 崩溃。

### 6.7 清理与提交

临时探针（`.tmp-parent.mjs`）已删；fixture 自身 `quit`/`destroy` 后删除临时文件，验证链结束后 `Get-Process yu-windows` 为空。

