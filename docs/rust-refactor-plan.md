# Rust 渐进重构计划

**目标：** 保留 Electron 外壳，以实测为依据降低本机内存、CPU 开销和交互延迟。

**架构：** React、preload、窗口、托盘、更新、凭据管理和业务编排继续使用 TypeScript；Windows 原生能力逐步迁入独立 Rust 辅助进程。辅助进程使用继承的本地管道通信，不增加监听端口。保留故障隔离、按需启动和退出回收。

**工具链：** 现有 Rust stable MSVC / Windows SDK、微软 windows-rs、serde_json、Electron、TypeScript、Vitest。原生程序静态链接 CRT，最终用户无需安装 Rust 或单独的 VC++ 运行库。

本文件是后续重构的统一待办与验收记录。每次先更新当前任务，再实施和验证；完成阶段后登记证据、限制与提交，避免仅把“已写代码”当作完成。

## 阶段与优先级

| 顺序 | 范围 | 状态 | 完成条件 |
| --- | --- | --- | --- |
| 1 | 全局热键 | 已完成，`fc05bab` | Rust 事件循环替代 JS 轮询；手势回归、真实钩子退出、构建及性能对比通过 |
| 2 | UIA 焦点控件读取 | 已完成，本阶段代码与本文同次提交 | 原窗口校验、快照字段、超时和故障隔离已保留；真实控件读取及性能对比通过 |
| 3 | Windows 操作桥接 | 待实施，下一阶段 | 先盘点 PowerShell 调用，优先迁移频繁调用的 Win32 操作；逐项验证权限、取消和结果 |
| 4 | 滚动截图等计算热点 | 待性能分析 | CPU 剖析确认热点后再选算法；测量计算和跨进程数据复制的总成本 |
| 5 | 本地 ASR / 记忆模型包装层 | 待性能分析 | 区分 JS 运行时、模型权重与原生推理占用；明确收益后再迁移 |

聊天、笔记、日历、存储和网络编排目前保留 TypeScript。查询算法、同步阻塞、模型加载、隐藏窗口和缓存生命周期优先通过原架构优化。保持既有数据格式、持久化位置与记忆学习范围；本计划不进行数据库迁移。

## 阶段 1：已完成基线

- 实现：`native/hotkey/`、`src/main/hotkey/host.ts`。
- 证据：[`rust-hotkey-20261103.json`](../tests/yu-v2/evidence/rust-hotkey-20261103.json)。热键辅助进程私有提交内存约 33–34 → 1 MiB，工作集约 61–64 → 5.3 MiB，注入按键到主进程事件 P95 约 16–17 → 0.3–0.5 ms。
- 验证：3454 项客户端测试通过、8 项跳过，14 项 Rust 测试通过；类型检查、生产构建和独立审查通过。
- 限制：上述为辅助进程测量，非整机/整应用收益；CPU 降幅尚不能可靠量化，实体键盘、UAC 与锁屏仍需人工验收。

## 阶段 2：UIA 实施清单

### 2.1 理解与技术决策

- [x] 阅读 `src/main/uia/{host,child,reader}.ts`、调用链、资源统计和现有测试。
- [x] 使用微软生成的 COM 接口绑定，替代手写 vtable 与 BSTR 指针管理。
- [x] 使用不拥有窗口的 MTA 线程读取 UIA，保留与热键、Electron 的进程隔离。
- [x] 发现旧控件 ID 表与 Windows 官方枚举不一致；迁移时改用官方标识，补充 Edit=50004 / Document=50030 回归。

决策依据：独立原生程序可以移除 UIA 包装层的 Node 开销；COM 对象使用 RAII 释放。代价是增加一个原生构建产物和 Windows 真实控件验收。这里复用热键阶段的简单管道方式，不搭建通用 RPC 框架。

### 2.2 原生实现

- [x] 新建 `native/uia/`，编译输出 `native/bin/yu-uia.exe`。
- [x] 接口：启动报告 `ready`；接收 `{type:"read", id, target?}`；返回 `{type:"result", id, snapshot}`，无可用数据为 `null`。
- [x] 保留 `UiaSnapshot` 的字段和末尾 4000 个 UTF-16 单元的限长语义；正确释放 COM/BSTR，避免截断产生损坏字符。
- [x] 只读 ValuePattern；不引入过去导致 provider 崩溃的 TextRange 调用。
- [x] 密码控件不返回快照；诊断不记录管道输入正文或控件内容。
- [x] 读前与读后检查同一个原窗口的句柄、PID 和标题；切换窗口即丢弃结果，不打印控件正文。
- [x] 父管道 EOF 时退出，包含 provider 卡住时的清理路径；可疑 provider 故障只影响 UIA 子进程。

### 2.3 Electron 接入

- [x] `src/main/uia/host.ts` 改为原生管道，保持按需 warm、启动等待、读取预算、崩溃重试上限、闲置回收和显式释放。
- [x] 卡住的读取到期后终止失去响应的进程，避免后续请求一直排在它后面；迟到消息不影响新进程。
- [x] 更新 `scripts/build-native.mjs`、`electron-builder.yml` 与 `electron.vite.config.ts`，移除旧 UIA 构建入口。
- [x] 资源统计包含 UIA 原生 PID；无法读取的值保持不可用，不算作零。
- [x] 移除旧 COM 实现，保留独立类型契约；同步中英文 README 和依赖许可。

### 2.4 验收与提交

- [x] 主机测试覆盖启动/读取、分块管道、窗口目标、超时终止、有限重启、停止、闲置回收与迟到消息。
- [x] Rust 测试覆盖控件标识、UTF-16/中文/emoji 限长、目标匹配，以及读后窗口切换丢弃。
- [x] 使用本轮创建的固定测试窗口，真实验证可编辑控件、只读值、长中文文本、非 ValuePattern、失配目标与 EOF；不读取用户正在操作的窗口。
- [x] 基线对比：旧提交 `fc05bab` 的 UIA 辅助进程与新程序，同机、同一个固定测试控件、交错两轮，分别记录启动、读取延迟、私有内存与工作集；比较结果但不预设速度一定提高。
- [x] 执行 `pnpm test:native`、UIA/资源/管线相关测试、`pnpm typecheck`、`pnpm test`、`pnpm build`，以及 Cargo 格式/Clippy 检查。
- [x] 独立代码审查通过；清理本轮临时窗口、探针和编译暂存，保留有效程序与原始测量。
- [x] 更新本文的结果记录，本阶段代码与本文一起提交，不推送或发布安装器。

### 阶段 2 结果

实现：`native/uia/`、`src/main/uia/{host,types}.ts`；旧 UIA TypeScript/COM 实现和构建入口已移除。原生 PID 接入资源统计，构建复用内容相同且仍在运行的热键程序。本阶段提交标题为 `refactor(uia): migrate context reader to Rust`，实现与本文一起归档。

验证：3464 项客户端测试通过、8 项跳过；Rust 22 项通过（热键 14、UIA 8）。类型检查、生产构建、Cargo 格式/Clippy、独立审查通过。真实合成控件验收覆盖可编辑、只读、长中文/emoji、非 ValuePattern 按钮、密码框、失配目标，以及 provider 阻塞时父管道 EOF 退出（约 2.7ms）。已确认二进制 SHA-256 与报告一致，导入表无需单独 VC++ 运行库；生产构建中不再包含 `uia.js`。

性能证据：[`rust-uia-20261103.json`](../tests/yu-v2/evidence/rust-uia-20261103.json)，基线 `fc05bab`，同机同控件交错两轮：

| 辅助进程指标 | 旧版 | Rust |
| --- | --- | --- |
| 私有驻留内存（不含共享页） | 18.7–18.8 MiB | 1.8–1.9 MiB |
| 私有提交 | 31.7–31.9 MiB | 2.4–2.5 MiB |
| 工作集（含共享页） | 110.7–110.9 MiB | 15.9–16.0 MiB |
| 读取 P95（含 UIA / IPC） | 3.9–4.3ms | 3.1–3.2ms |
| 就绪加首读 | 92–102ms | 39–45ms |

边界：只衡量 UIA 辅助进程，不把工作集差额当作整应用节省的物理内存；CPU 采样不足以推断降幅。测试使用固定的合成窗口，焦点不稳定的尝试直接失败、未计入报告。真实厂商应用、UAC/锁屏/权限桌面与安装升级仍待人工验收。现有运行中的开发版需正常重启才加载新主进程代码，本轮未终止用户的热键进程。

产物：保留 `native/bin/yu-uia.exe`（325 KiB）、正式前端/主进程构建与原始报告；清理本轮 UIA 编译暂存约 422 MiB，以及测试窗口和隔离探针。未清理已有热键缓存或用户数据。

## 后续阶段的推进规则

1. 每次只推进一个可独立验收的阶段；性能分析阶段可以得出“保留现实现”的结论。
2. 阶段 3 先记录 `windows-native.ts` / `windows-tools.ps1` 的实际操作和调用频率，再迁移当前有收益的操作。OCR、Office、语音等分别核对 API，避免把脚本统一塞进一个大后端。
3. 不承诺整个应用的固定降幅；区分常驻包装层、Chromium、模型及网络等待。
4. 失败或未测项明确保留为待办，不把自动测试代替真实厂商应用、UAC、权限桌面或安装升级验收。

## 官方参考

- [UIA 线程模型](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)
- [UIA 控件类型标识](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-controltype-ids)
- [微软 Rust Windows 绑定](https://github.com/microsoft/windows-rs)
