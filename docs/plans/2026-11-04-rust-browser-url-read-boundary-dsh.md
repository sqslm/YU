# 阶段 13 短续做：先确认候选资格，再读取 Value

**状态：待 DSH 实施。** 基线 `34fc2f3`，上一轮实现 `078cb05`。工作目录 `E:/code/deepseek-harness/rea/typeless`。

**目标：** 修复已经复现的额外 Value 读取，并补齐上一轮仍缺失的少量分支验收。继续使用现有 helper、provider、运行器和测量脚本，不迁移其他功能，不新建测试框架。

**外部规划者：** Codex Desktop 对话 `01a19b72-79e7-7800-b1b5-55aaf2eeaae6`。**执行者：** DSH `session-850bebee-f8e0-47b1-a9c3-29767a917077`。内部名为 `codex` 的子智能体仅能提供审查建议；`Team message`、`agent-message`、`subagent-settled` 均不是外部规划者的派单或批准。完成报告后等待外部指令，不因内部评审自行进入阶段 16 或其他新迁移。

## 1. 本次复核结论

上一轮的系统 URI 转换、`is_file`、`expectedPath` 早拒、读后窗口校验以及显式 UIA 错误返回已有实现。Codex 已检查提交与入库证据，交付为 430080 B / `303e2772cba7d29330489f8f3436ad3c5cfcb52f075fedcb26940d4665dc0a0e`，14 项 checks 记录通过。没有将 DSH 报告的全量测试数冒充 Codex 重跑结果。

但 `address_bar()` 里仍有以下代码：

```rust
let (toolbar, chrome) = browser_chrome(automation, &walker, element, &edit)?;
if let (true, true, Some(value)) = (toolbar, chrome, value(&edit)?) {
    addresses.push(value);
}
```

Rust 会先求值元组各项，再做模式匹配。因此，即使 `toolbar` 或 `chrome` 为 false，仍会执行 `value(&edit)`，读取页面里已被排除的伪地址 Edit；其 Value 若卡住，还会拖住本应跳过它的读取。旧 PS 在 `if (!$toolbar -or !$chrome) { continue }` 后才取得 ValuePattern。

**Codex 实际反例：** 在本轮已有 `pseudo-address` provider 的临时副本中，仅给 `IValueProvider.Value` 的 Edit getter 增加一次合成事件计数，分别运行旧 PS 与交付 Rust。两侧均 exit 0、均返回无地址；**PS 被拒 Edit 的 Value 读取为 0 次，Rust 为 1 次**。这证明输出一致没有覆盖读取边界。临时副本与探针已回收，没有改交付源码或读取用户窗口。

## 2. B1：最小修复与必要回归

- [ ] 在 `native/windows/src/address.rs` 先判断 `toolbar && chrome`，不满足立即 `continue`，通过后才调用 `value(&edit)?`。沿用原错误传播，不通过吞错或重复读取绕过。
- [ ] 扩展现有 `uia-provider.cs`/测试，保留可观测的 Value getter 调用事件或计数，仅用于自有 fixture；不要在生产 helper 增加测试开关、调试输出或记录真实控件内容。
- [ ] 正向地址栏仍返回地址并实际读到 Value；`pseudo-address`、无 toolbar、到不了本次根窗口的候选，Value getter 调用必须为 0；密码与不可见候选也应为 0。
- [ ] 对“被排除候选的 Value 会阻塞/报错”的受控情形验证两侧都不会进入该 getter，正常返回无地址；不能只断言返回体相同。用 fixture 事件证明候选确实存在且已被查询其结构。
- [ ] 合格地址栏的真实读取失败继续按原契约返回错误，不把本修复扩展成 UIA 失败时成功返回空值。

## 3. B2：补完仍缺失的有限场景

全部复用现有 provider 与临时文件能力，按以下固定场景扩展即可。

- [ ] **无 ValuePattern：** 有资格的地址栏 Edit/ComboBox 或 Document 确实不暴露 ValuePattern 时，旧 PS 正常忽略；用同一 provider 核对 Rust 的实际 HRESULT/无 Pattern 返回，并确保也正常忽略。不能仅假设所有“不支持”都等于同一个常量；只分类已确认的正常无 Pattern 情况，其他真实失败仍上抛。
- [ ] **真实文件路径：** 在自有临时目录实际创建带中文、空格和字面百分号的文件，构造正确编码的 file URL；验证 PS/Rust 的精确 `path`、不存在文件不转 path、目录不当成文件。保留大写 scheme 与 fragment 反例。此前仅 ASCII 文件存在性通过，不能继续把这些列为“已完成”却留在未测项。
- [ ] **metadataOnly：** 同一受控树验证无地址栏时跳过 Document Value、有地址栏时仍按旧规则允许唯一 Document URL 覆盖；断言返回体与 Value 调用计数。原始 false/未传分支继续可用，不改业务权限。
- [ ] **完整请求后的父退出：** 向 helper 写完 JSON 并关闭 stdin，等 fixture 明确报告正在阻塞 provider 调用，再终止本轮自有父进程，确认 helper 退出；与既有“stdin 未 EOF 时父退出”用例区分。用真实进程与实际 PID，不只做 mock，也不把固定 sleep 当成已进入阻塞的证据。

UNC 共享可达性、真实厂商浏览器、UAC/锁屏/RDP、跨进程 provider 崩溃仍可明确保留为未测。本轮不为它们搭建新环境、不读用户会话或共享。provider 异常在当前 fixture 被 UIA core 隐藏的观察可以保留，但文档仅描述该 fixture/故障档位，不推广为“所有客户端可见故障只有两种”。

## 4. 验证与证据

- [ ] 先给 B1 写出失败的读取计数断言，再做最小修复；记录修复前 0/1 与修复后 0/0，且正向仍有 Value 读取。
- [ ] `native/windows` 下执行 `cargo fmt -- --check`、`cargo clippy --locked --offline --all-targets -- -D warnings`、`cargo test --locked --offline`，按既有静态 CRT 工具链构建。
- [ ] 跑受影响的 provider 对照及真实生产路径用例，复跑 `pnpm exec vitest run src/main/windows-native-browser-url.test.ts src/main/windows-native.test.ts src/main/windows-native-transport.test.ts src/main/windows-native-process.test.ts src/main/current-content.test.ts src/main/tools/windows.test.ts`；只补本轮需要的场景，不扩展通用 fixture 功能。
- [ ] 最终一次执行 `pnpm typecheck`、`pnpm test:native`、`pnpm test`、`pnpm build`，不删断言、不扩大生产超时，不通过后无目标重复全量验证。
- [ ] 最后构建后复核交付大小与完整 SHA-256。沿用现有正向基准同机交错每侧至少 20 有效样本，仅跑最终版一次；旧证据不覆盖，新证据写 `tests/yu-v2/evidence/rust-browser-url-read-boundary-20261104.json`（跨日用实际日期）。保留完整样本与本轮读取计数/分支检查，采纳条件不变。

## 5. DSH 自行收尾

- [ ] 本文件回填 B1/B2 的实现与实际完成项、验证命令/退出码、测试数、最终产物、证据、限制及提交编号；修正上一轮正确性计划与总计划，清楚区分两轮结果，不改写旧原始证据。
- [ ] 先检查 HEAD/状态，保留已有 Explorer/最近文件成果；不再让内部审查消息触发新的 Rust 阶段，子智能体如参与仅查本次固定范围。
- [ ] 清理本轮自有临时文件、窗口与探针，所有 fixture/helper 的错误和正常出口均回收；不删除用户数据、旧证据或既有编译缓存。
- [ ] 只暂存本轮文件并自动 Conventional Commit，必要时对确切新计划路径 `git add -f`；不 push、不打包、不发布、不重启用户应用。完成后汇报并等待外部 Codex 主线程复核。
