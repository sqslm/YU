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

- [ ] 增加真正调用生产 `default_string`/相关读取函数的测试，覆盖缺失默认值、REG_SZ、REG_EXPAND_SZ、REG_DWORD；对照旧 PS 的实际最终跳过/返回语义。不能仅调用 `value_missing(1630)` 后称端点已验证。
- [ ] 测试数据只放在本轮唯一、可明确归属的 HKCU 临时测试子键，**不写真实 App Paths、不改 ACL、不注册应用、不改开始菜单**。已存在测试工具足够就复用；可以用测试侧 .NET/PowerShell 创建键，也可增加必要 SDK feature，选最小实现，不搭 registry mock 平台。
- [ ] 所有正常/失败出口关闭句柄并移除自己创建的确切测试键，删除前核对其解析路径和唯一标识仍位于本轮测试分支；不递归清理未知父键。测试进程异常时保留可定位的唯一键名和清理原因，不能顺带清理用户配置。
- [ ] 访问拒绝等无法安全制造的故障可以保留模拟/未测，不能通过改真实 App Paths 权限来制造。文档准确区别真实 OS 读取、局部替身与静态检查。
- [ ] 修正两份阶段 16 文档中“补 SDK feature 就越过无新依赖边界”的说法及错误验证来源。新增测试数据只用合成值，不提交真实用户登记内容。

## 3. C2：文化比较失败不得隐式变成成功的另一种排序

当前 `culture_compare()` 在 `CompareStringEx` 返回 0 时改走 `left.cmp(right)`，随后 `finish()` 仍返回成功。按[微软返回值契约](https://learn.microsoft.com/en-us/windows/win32/api/stringapiset/nf-stringapiset-comparestringex)，0 是失败，应获取错误；并不是正常 Greater 或另一种文化排序。

这是静态发现的未履行失败契约，Codex 没有在真实系统上制造过该 API 失败。不能把“对某一失败 pair 改走序数”写成已保证整体排序关系一致。

- [ ] 在必要排序准备/比较层保留失败，最终让应用枚举以阶段 + Win32 错误明确失败，不输出按另一种排序产生的成功名单；不新增静默回退或吞掉错误。
- [ ] 选择最小、关系一致的实现；若采用可失败的排序键准备，先完成准备再调用不失败的排序。不要让比较器在一部分 pair 用文化关系、另一部分用序数关系且仍宣称关系可靠，也不要为此建立通用排序框架。
- [ ] 用局部替身固定一个失败返回，断言不会产生成功 JSON/名单；真实 Windows 正常排序与原有大小写穿插去重、截断反例继续通过。替身失败与真实平台验证分别记录。
- [ ] 不扩大到别的语言环境或所有 Unicode 等价形式的全套平台测试；其他区域设置限制继续如实保留。

## 4. E1：剩余三个 PS action 的实际边界和成本

阅读 `resources/windows-tools.ps1`、`resources/current-content.ps1`、`src/main/windows-native.ts`、`src/main/tools/windows.ts` 及直接调用者，整理一张表：调用入口、固定输入/输出、缓存与重复调用、Windows 能力依赖、故障/取消语义、Rust 能复用的已有模块、必须保留 TS/PS 的业务边界。频率只能标为代码推断或实测计数，不编造用户使用频率。

- [ ] **activate：** 核对 `system:settings` 与注册 AppID 的验证/派发规则。可以对保证不存在的合成 AppID 测量“注册验证直到拒绝”，不能真正打开应用或设置窗口；明确该数字排除了成功 ShellExecute 与窗口可见时间，不将它写成完整激活性能。
- [ ] **search：** 在本轮自有临时目录构造固定的小/中等文件树，包含名称、扩展名、日期/大小、递归深度与限额场景，执行实际 PS `search`。区分 Windows Search 可用、索引结果是否命中与目录 fallback；只查询自己的范围，不能为验证扫描用户目录或整个索引。未能测到索引正向时明确说明，不能声称覆盖了它。
- [ ] **current-content：** 仅对已有自有 UIA fixture/固定正文做可到达分支的测量，核对浏览器/编辑控件、原窗口、metadataOnly/expectedPath 及 Explorer/Office 特殊路径如何分流。不读用户当前窗口、浏览器登录态或 Office 文档；未测 Office/真实 TextPattern 路径明确列出，不为本轮评估建立大型新 provider。
- [ ] 每个实际可安全测量的代表场景至少 10 个有效样本，warmup 单列；记录 spawn 到 stdio close 的 P50/P95、原始样本/失败原因。能同法可靠测到的 helper CPU/私有内存可记录，不能测到就写不可用，不填零，不外推整应用收益。
- [ ] 本轮不实现这三个 action 的生产 Rust 版本、不调整路由、不增加缓存、不迁移存储、不打开应用、不修改系统设置。源码阶段划分及性能测量不是新增执行这些动作的权限。

## 5. E2：交付可据以决定下一轮的建议

- [ ] 对 `activate`、`search`、`current-content` 分别给出“适合下一轮完整迁移 / 仅适合一个明确子范围 / 暂保留 PS”的结论，依据包含实测包装成本、原生功能是否已有、兼容/验证难点与剩余未测项，不能仅以“PS 还在”当迁移理由。
- [ ] 若建议只迁一个子范围，写清生产路由如何在执行前确定，不能设计失败后改走 PS 的隐式回退；无可行验收边界就不推荐上线。
- [ ] 对首选候选写出下一轮所需文件、协议、兼容门槛与可执行验证；若三项均收益不明或风险不匹配，可以明确建议此轮 Rust 迁移到此收束，不为维持接力制造空任务。
- [ ] 将评估与实际测量写入本文件“实施与评估结果”，新证据 `tests/yu-v2/evidence/rust-windows-remaining-20261104.json`（跨日用实际日期）。证据只含合成数据/计数，旧证据原样保留。

## 6. 验证与 DSH 自行收尾

- [ ] 检查 HEAD/状态，保留已有 WIP；只改 C1/C2 所需模块、测试、必要计量与文档。任何已在并行处理中完成的项先核对，不重复覆盖。
- [ ] C1/C2 稳定后执行 `native/windows` 的 fmt/clippy（`--locked --offline --all-targets -- -D warnings`）/cargo test，以及直接相关 Windows/工具 Vitest、`pnpm typecheck`。生产代码有变时再跑最终 `pnpm test:native`、`pnpm test`、`pnpm build`，不搬用上轮次数声称本轮通过。
- [ ] 如生产资产因 C2 或 feature 变更重链接，最后构建后复跑应用完整名单对照和既有基准一次，写新的带实际日期/收口标记的证据文件，保留旧 `rust-applications-correctness-20261104.json`；核对最终大小/完整 SHA-256。评估部分没有 Rust 对照时不伪造“Rust 提升”。
- [ ] 回填本文件、总计划阶段 17 与阶段 16 收口说明；逐项列实际实现/验证、测量范围、限制、清理与提交编号，README 仅改确实变化的行为。
- [ ] 清理本轮自有临时文件/窗口/测试键与探针，不删历史证据、用户数据或既有缓存；只暂存本轮文件自动 Conventional Commit，不 push、不打包、不发布、不重启用户应用。
- [ ] 内部审查须在最终外部报告前收齐。最终一次报告实现、测量与建议后，等待绑定外部 Codex 决定下一步，不自行写并实施阶段 18。
