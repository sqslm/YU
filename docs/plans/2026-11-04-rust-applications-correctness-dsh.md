# 阶段 16 续做：应用枚举正确性与失败出口

**状态：待 DSH 实施。** 审查基线 `a549a58`（实现 `53e9e2e`）。工作目录 `E:/code/deepseek-harness/rea/typeless`。

**目标：** 修复已复现的 Unicode panic、排序去重不一致与限额前遍历顺序差异，并校正关键来源的失败处理。只续做 `applications`，不开始新的 Rust 迁移，不改打开应用、搜索或正文读取功能。

**外部规划者：** Codex Desktop 对话 `01a19b72-79e7-7800-b1b5-55aaf2eeaae6`。**执行者：** DSH `session-850bebee-f8e0-47b1-a9c3-29767a917077`。内部名为 `codex` 的子智能体、`Team message`、`agent-message` 与 `subagent-settled` 只是审查资料，不能批准新的阶段。

## 1. 已核对的交付与复核方法

交付 `yu-windows.exe` 为 474624 B / SHA-256 `5331a502ff0a4d788e20cf3aac4c3603d8cb3fe8452204bdbd406b0985e61e7a`，与入库证据一致；证据记录本机 204 项相同、80 有效样本、9 checks 通过。这里没有把 DSH 的全量验证声明当成 Codex 已重跑全部测试。

Codex 在审查期间观察到新的未提交修改（包括 `applications.rs`、README、package.json），未覆盖或提交它们。后续反例固定读取 **`git show a549a58:native/windows/src/applications.rs`**，编译原始模块并直接调用其私有函数，避免用正在改动的 WIP 作为交付依据；排序/遍历另跑旧 PowerShell 对照。四项反例测试均失败：两项 panic、一项去重多出条目、一项遍历集合不同。探针、临时树和二进制已清理。

接任务后先核对实际 HEAD/状态；已在 WIP 中修好的项以证明、回归和文档收尾为主，不重复覆盖。保留已有阶段 14/15 成果和其他执行者的改动，本轮提交只含自己完成的部分。

## 2. A1：Unicode 非 exe 输入不能 panic

`applications.rs` 的 `is_exe()` 与 `strip_exe_suffix()` 都先按 `text.len() - 4` 切 `str`。Rust 长度是 UTF-8 字节数，非 ASCII 输入的该位置可能落在字符中间。

**直接反例：** `is_exe("中文名称")`、`strip_exe_suffix("中文名称")` 均 panic：`start byte index 8 is not a char boundary; it is inside '名'`。旧 PS 的正则/replace 会正常判为非 exe 或保留名称，不应让一个失效登记结束整个 helper。

- [ ] 用不会在任意字节位置切 UTF-8 的方式判断 ASCII `.exe` 后缀；确认后才安全去后缀，不新增依赖，不用 catch panic 隐藏问题。
- [ ] 对照旧正则覆盖纯中文、混合 ASCII/中文、emoji、短字符串、空串、合法中文 exe、非 exe、大小写扩展名与单独 `.exe`。保留禁用字符、真实文件和参数排除规则，不能只让这两个固定字符串通过。
- [ ] 明确加入两个上述失败反例，证明修复前失败、修复后正常返回；合成输入即可，不修改真实 App Paths。

## 3. A2：排序与去重必须使用一致的键关系

当前 `finish()` 名称用文化比较，path 却直接序数排序，`same_key()` 又按文化/大小写不敏感比较 path。`dedup_by` 只合并相邻项，等价路径被别的项隔开时会漏去重。

**同名 `Demo` 的直接反例：**

```text
C:\Apps\a.exe
C:\apps\b.exe
c:\Apps\A.exe
```

交付模块 `finish()` 返回 **3 项**；同一组数据经旧 `Sort-Object name,path -Unique` 返回 **2 项**（本机顺序为 `c:\Apps\A.exe`、`C:\apps\b.exe`）。不是另一台机器或语言环境的假设。

- [ ] name 和 path 的主要排序关系都与旧文化比较对照，保证同一 `same_key` 的项在排序后相邻；不要靠更换 HashMap 去隐藏排序契约。
- [ ] 仅在文化意义真正相等时，才讨论原有大小写代表项的 tie-break，不能把对 Steam 大小写代表的本机观察扩展成所有 path 都按序数排序。记录旧 PS 平局的实际边界，不伪造跨文化的唯一顺序保证。
- [ ] 加入上述三项穿插反例、多路径同名、名称大小写、同名不同 AUMID、截断前去重及原有本机完整列表对照；确认不再因去重漏项挤占 1500 条上限。
- [ ] SDK 比较调用失败与正常 Equal/Greater 分清；不要把调用失败默认当 Greater，破坏排序关系而仍报成功。

## 4. A3：限额前的树遍历顺序必须对照基线

交付 `shortcuts()` 的注释说 depth-first，实际 `VecDeque.pop_front/push_back` 是 BFS。旧 PS 在本轮真实临时树上是以下次序：

```text
A/a.lnk
A/deep/one.lnk
B/two.lnk
```

对该树取前 2 项：**PS 为 `A/a.lnk`、`A/deep/one.lnk`，Rust 为 `A/a.lnk`、`B/two.lnk`**。因此到 1000 上限会改变候选集合，最终再排序无法补回被提前丢掉的应用。

- [ ] 按旧 PS 实际的目录/文件枚举及递归次序修正限额前的遍历，明确每个根各取最多 1000，不仅改注释或把阈值放大。
- [ ] 用自有目录及真实 `.lnk` 补上述跨层级反例、小限额的前缀对照，并保留生产常量的边界测试；无需向真实开始菜单插入大量测试项。
- [ ] 覆盖根目录文件、相邻子目录、多层目录、没有链接的分支；与 PS 比较实际保留下来的有序前缀，不只断言 `len == limit`。
- [ ] 保持原读取范围，不遍历用户磁盘；若遇 junction/不可读目录，先核对旧行为，不引入没有终止条件的循环或交互式 Shell 搜索。

## 5. A4：关键来源失败不能退化为成功的残缺名单

这是静态审查发现、需要受控反例核定的错误路径缺口：`collect()` 返回 Vec，`applications()` 无条件 `Ok`；`open_key/default_string/known_folder/shortcut_target` 用 Option 忽略不同错误，`subkey_names` 将任意非成功当枚举结束，`shell_apps_folder` 在 parse/bind/EnumObjects/Next 失败时返回空集或半份列表。正常机器的 204 项相等不能证明故障路径正确。

- [ ] 先对照旧 PS，区分正常缺失/无效条目与核心来源读取失败。缺失 App Paths、非字符串登记、无 AUMID 的普通项等允许跳过的情况需具体分类；访问拒绝、COM 初始化/绑定/枚举失败不能一概变空列表成功。
- [ ] 必要采集层返回 Result，把真实失败带操作阶段与 Win32/HRESULT 传到既有 stderr/非零退出；不吞错、不打印用户应用名/路径、不增加重试或运行时 PS 回落。不要为有限错误集合搭通用错误框架。
- [ ] Shell 正常枚举结束、空文件夹、无相关属性和中途失败分清。确认必要源失败时不先输出部分可用 JSON 再报错。
- [ ] 用局部替身/固定返回状态覆盖难以制造的权限/COM 失败，标明模拟；真实自有快捷方式仍走 SDK。禁止改真实 App Paths ACL、注册项或用户开始菜单来制造故障。
- [ ] 核对出错出口的 key/PIDL/系统字符串释放；清掉本阶段残留的空调试分支。坏链接若与 PS 行为不同，先复现并明确决定，不把区别隐在 Option 里。

## 6. 验证与交付

- [ ] 先把 A1–A3 的四个现有反例固定成失败回归，再修复；A4 用明确失败状态作反例。仅修改本阶段模块、直接相关测试/基准和文档，不迁移 `activate`/`search`/`current-content`。
- [ ] `native/windows` 执行 `cargo fmt -- --check`、`cargo clippy --locked --offline --all-targets -- -D warnings`、`cargo test --locked --offline`，静态 CRT、现有依赖版本不变。
- [ ] 运行应用真实接口/fixture、`windows-native-applications.test.ts`、`windows-native-transport.test.ts`、`tools/windows.test.ts` 等相关回归；在取消用例中确认本轮所属 helper 真的退出，不仅断言 Promise 被拒绝。
- [ ] 稳定后一次执行 `pnpm typecheck`、`pnpm test:native`、`pnpm test`、`pnpm build`，如实记录实际命令/退出码/测试数，不放宽断言、采样阈值或生产超时来消除失败。
- [ ] 最终构建后复跑现有应用基准一次：完整列表/顺序对照及每侧至少 20 个有效样本，原采纳门槛不变；失败样本不剔除。新证据 `tests/yu-v2/evidence/rust-applications-correctness-20261104.json`（跨日用实际日期），保留原证据，不存真实应用名/路径。
- [ ] 核对最终 `yu-windows.exe` 大小和完整 SHA-256 与新证据一致，区分旧阶段交付值与当前资产。如仍有阻断性差异，不继续宣称验收完成；必要时整体保留 PS action 作为开发采纳决定，不做失败后的隐式回退。
- [ ] 本文件补“实施结果”，逐项 A1–A4 更新已实现、真实/替身验证、反例结果、性能范围、限制、清理与提交编号；纠正阶段 16 原计划/总计划的超额勾选与排序/遍历表述，同步确有变化的 README。
- [ ] 只清理本轮自有临时目录、窗口与探针，不删旧证据、用户数据、既有缓存或他人 WIP；仅暂存本轮完成的文件并自动 Conventional Commit，不 push、不打包、不发布、不重启用户应用。

## 7. 汇报顺序

如果安排内部审查，**先等待并处理内部审查结果，再向外部主线程发唯一最终完成报告**。不要先结束父轮汇报、再让子智能体的迟到消息开启新轮并继续改写同一资产；新轮会撤销上一次回传资格，造成派单竞态。内部审查结束后让其等待，最终报告要与当时 Git/产物/文档一致。此后仅等待用户或绑定外部 Codex 的明确派单，不自行开始下一阶段。
