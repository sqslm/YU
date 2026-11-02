# 第六阶段：GDI 截图采集 Rust 重构与 DSH 实施计划

> **执行者：DSH，直接在现有 typeless 工作区实施。** 按任务顺序推进；完成后由 DSH 自行回写本文件和总计划的实际实现、命令结果、性能证据及限制，然后结束。不自动启动下一轮，不要求 Codex 监听或验收后才能收尾。

**状态：待 DSH 开始。** 本文件是评估与开发要求，没有宣称新功能已实现或新基准已通过。

**目标：** 保留 Electron，降低滚动截图采集过程中的主线程开销和多余整帧转换，同时保持像素、DPI、失败处理和资源回收行为。

**架构：** 优先验证独立的 `yu-capture.dll`，通过既有 Koffi 同步写入调用方 Buffer；GDI 资源只在单次调用期间存在，不保留像素指针。保留 `captureScreen(rect): NativeImage`，为滚动路径提供原始 BGRA Buffer 入口。根据三方案实测决定是否采纳 Rust；不引入图像 RPC、共享内存、常驻截图进程或新截图技术栈。

**工具链：** 既有 Rust stable MSVC、微软 windows-rs、Koffi、Electron、Vitest。复用已安装工具与 E 盘缓存，不升级依赖或下载大型工具。

**评估基线：** `872e5b5f17e4c57a82077061a38bdc9733307847`。开始前检查当前 Git 状态；若已有更新，以实际代码复核，不覆盖工作区变更。

## 1. 本轮评估结论

| 候选 | 现有证据 | 本轮决定 |
| --- | --- | --- |
| GDI 截图采集 | `capture-screen.ts` 每帧重新 load/绑定约 10 个 API，遍历全部像素设置 alpha；`screenshot-tool.ts` 每 50ms 调用并转回 Bitmap | 本轮优先，先测再迁移；采集收益尚未测定 |
| 记忆向量评分/图谱 | 上轮 1000 条向量召回已降到约 11ms，且在独立 worker 内；进一步迁移需付出 BLOB/FFI 与分数兼容成本 | 留作后续候选，需证明计算而非 SQLite/嵌入成为主要开销 |
| 前台窗口/进程信息 | `foreground.ts` 已缓存绑定；标题、排除自身、窗口 Z 序和原目标身份要求严格 | 暂缓，不以 API 数量推断性能收益 |
| 文本注入、游戏状态、资源面板 | 核心已是 Win32 调用；输入还涉及焦点、修饰键与 UIPI | 暂缓，缺少本轮可量化的性能证据 |
| ASR/编码/网络/数据库整体重写 | ASR/FFmpeg/ONNX 已有原生核心；上轮已降低记忆 SDK 导入成本 | 不纳入本轮，不换推理引擎或数据格式 |

以上是代码检查和前五阶段证据得出的优先级，不是本轮 Rust 截图的实测结果。禁止把第四阶段“匹配 64→15ms”当作本次采集收益：该基准明确未测 GDI。

## 2. 不变的行为与范围

- 物理像素坐标，允许负屏幕原点；DIP/多屏布局仍由 `capture-displays.ts` 和 `screen.dipToScreenRect` 处理。
- 输出为 Windows BGRA、每像素 4 字节、从上到下，alpha 全为 255；保持 `SRCCOPY | CAPTUREBLT`，不额外捕获/绘制光标。
- 保持 40,000,000 像素采集上限；滚动拼接的 32,000,000 像素/30,000 行上限仍由现有类处理。
- 普通截图仍返回 NativeImage；截图编辑、跨屏、OCR、固定头尾拼接、预览节流、Escape/关闭/游戏模式的行为不变。
- 首次截图 GDI 失败时保留现有 Chromium 截图回退；滚动采集失败按现有逻辑停止并报错。不得添加吞错、空白成功图或新的静默重试。
- 不改 `captureOriginalWindow` 的窗口身份与敏感应用检查，不触及热键、UIA、文本注入、ASR、记忆、模型、账户或存储。
- 当前 GDI 已在主进程通过 Koffi 执行。本轮 DLL 保持这一故障域，不宣称获得进程隔离或能中断卡住的驱动调用；不要把 GDI 加进纯计算的 `yu-scroll.dll`。

## 3. 任务 A：先建立可复现基线

涉及：

- 阅读：`src/main/capture-screen.ts`、`capture-displays.ts`、`screenshot-tool.ts`、`scroll-capture.ts`、`scroll-match.ts`。
- 参考：`scripts/benchmark-scroll.mjs`、`tests/yu-v2/fixtures/scroll-electron.cjs` 的隔离 Electron 方式。
- 新建：`scripts/benchmark-capture.mjs`、`tests/yu-v2/fixtures/capture-window.ps1`（或更简单的等效自有窗口 fixture）。
- 最终证据：`tests/yu-v2/evidence/rust-capture-20261103.json`。

- [ ] 记录采集函数、alpha 循环、NativeImage 创建/转回 Bitmap、`scroll.add`、预览采样的分段耗时，确认主要成本。
- [ ] 对照 A：基线原版；B：仅缓存 Koffi 绑定并直接返回原始 Buffer 的 TypeScript 控制版本；C：Rust DLL + 原始 Buffer。
- [ ] B 只用于隔离缓存/复制改善，不把 A→C 的全部收益归因于语言；若最终 B 更适合，可采用 B 并说明 Rust 未采纳。
- [ ] 在同一个实际 Electron 运行时、同一个不抢焦点的自有不透明测试窗口中交错运行 A/B/C/C/B/A，至少预热 3 次，每项每轮测 15 次；保存原始样本、P50/P95、CPU 时间、可用的私有驻留/提交内存和 GDI 对象计数。
- [ ] 分别报告采集到 Buffer、兼容 NativeImage 路径，以及采集到拼接/原始缩略图的总成本。若不测 PNG、renderer 或合成等待，明确排除，不能称作整链路帧率。
- [ ] 测试只采自有窗口内已验证的客户端区域。窗口须不透明，不能复用透明 fixture 去读背后的用户桌面；不保存或上传用户画面。
- [ ] 可显示的 720p/1080p 场景做实际 GDI 采集；4K 若无法完全覆盖自有窗口，就只做内存 DC/合成像素测试并标注，不能冒充真实 4K 桌面采集。

**采纳条件：** 至少一个代表场景的采集/拼接总成本，相对 B 有超出重复测量噪声的 CPU、耗时或分配改善；建议以 P50 改善至少 10% 为参考，同时无可复现的 P95 恶化、像素差异或泄漏。此百分比是采纳参考，不是性能承诺。若主要耗时来自驱动、Rust 与 B 无可复测优势，停止扩展原生代码，只保留有证据的简单改善并记录决定。

## 4. 任务 B：实现最小 Rust 采集边界

预期文件（以任务 A 的决定为前提）：

- 新建：`native/capture/{Cargo.toml,Cargo.lock,.cargo/config.toml,src/lib.rs}`。
- 复用版本：优先已有 `windows = 0.61.3`，仅打开实际需要的 GDI/Foundation 等 feature；不引入截图框架。
- 修改：`src/main/capture-screen.ts`；新建 `src/main/capture-screen.test.ts`。

建议固定接口（等效的更简单实现也可，需回写准确签名）：

```c
int32_t yu_capture_bgra(
    int32_t x, int32_t y, int32_t width, int32_t height,
    uint8_t *output, size_t output_len);
// 0 成功；非 0 为可区分的参数/GDI 阶段错误。
```

- [ ] JS 与 Rust 都校验整数坐标/尺寸、正宽高、上限及 `width*height*4` 的安全计算。负 x/y 合法；长度不符、空指针、溢出必须在 GDI/指针读取前失败。
- [ ] Buffer 由 JS 分配，Rust 仅在同步调用期间写入；不从 Rust 返回堆指针，不保留指针，不跨线程访问 Buffer。
- [ ] 首版沿用 GetDC → CreateCompatibleDC/Bitmap → BitBlt → GetDIBits 的现行算法，直接把 GetDIBits 输出写入调用方 Buffer，Rust 填 alpha；无需先引入 CreateDIBSection 或 GPU 后端。
- [ ] BITMAPINFOHEADER 使用负高度的 top-down 32bpp；必须在 GetDIBits 前将目标 bitmap 从 DC 选出，返回行数必须等于高度。
- [ ] 使用生成的 Win32 绑定与局部 RAII 管理。正确识别句柄/API 失败；先恢复旧选中对象，再删除 bitmap/DC，屏幕 DC 用 ReleaseDC，不混用 DeleteDC。
- [ ] 所有成功及中途失败路径都回收资源；GetLastError 只在对应 API 保证设置时使用，不能用陈旧错误码遮蔽实际失败阶段。
- [ ] 维持当前错误语义，JS 不读取失败时的部分 Buffer。不要用 `catch` 返回空图；panic 不跨 FFI 展开。
- [ ] 静态 CRT，DLL 按需加载，不在 import 时访问桌面。DLL 仅导出固定的业务函数，不接受任意句柄、指令或命令文本。

## 5. 任务 C：接入原始像素路径与构建

- 修改：`src/main/capture-screen.ts`、`screenshot-tool.ts`、`screenshot-tool.test.ts`。
- 核对：`capture-displays.ts`、`capture-displays.test.ts`、`foreground-capture.test.ts`、`scroll-capture.test.ts`。
- 修改：`scripts/build-native.mjs`、`electron-builder.yml`、`package.json`、`.gitignore`、必要的 `THIRD_PARTY_NOTICES.md`。

- [ ] 提供 `captureScreenPixels(rect): Buffer`（或等效窄接口）；`captureScreen(rect)` 包装它创建 NativeImage，保持既有调用方接口。
- [ ] 滚动计时器直接将 BGRA Buffer 传给 `scroll.add`，去掉该处 `NativeImage → toBitmap` 回绕。不要改结束导出时的 BGRA→RGBA 交换，否则会造成红蓝颠倒。
- [ ] 更新测试中的 capture mock，使初始截图和原始帧路径都受覆盖；不通过删除既有断言、放宽像素检查掩盖回归。
- [ ] 建议产物：开发 `native/bin/yu-capture.dll`，打包 `resources/native/yu-capture.dll`，ASAR 外。Cargo 默认 `yu_capture.dll` 的文件名差异在构建脚本明确处理。
- [ ] 保留“内容相同则不覆盖”逻辑；不得终止用户运行中的热键/UIA/应用进程来绕过 Windows 文件锁。打包模拟路径与缺失 DLL 错误要有回归。
- [ ] 原生源码、lockfile、许可与正式报告入 Git；临时探针、Cargo target、二进制缓存按既有规则处理，不提交完整运行目录。

## 6. 任务 D：正确性、资源与性能验收

- [ ] 证明 BGRA 通道、alpha、行方向与行跨度正确，包含红/蓝可区分色块、首末行以及奇数宽度；用实际 Electron NativeImage 做一次往返对照。
- [ ] 对固定自有图案逐像素比较新旧结果；渲染有变化时应失败/重测，不以放宽容差掩盖时序或像素问题。
- [ ] 测试无效尺寸、非整数、NaN/Infinity、ABI 范围、空/短 Buffer 和像素上限；失败后可继续正常调用。
- [ ] 持续采集/失败/关闭循环后 GDI 对象数无随次数增长的趋势。预热与基线波动单独记录，不把系统计时粒度的 0 当作零 CPU。
- [ ] 保留混合 DPI/负坐标布局测试；无实际第二屏、UAC、RDP 或锁屏场景时标为未测，不改系统设置凑验收。
- [ ] 确认关闭/游戏模式/异常时原有计时器与 Escape 清理仍工作，预览节流和拼接上限不变。

先运行直接相关的测试，再完成以下必要检查，按实际结果记录，不抄上轮通过数量：

```powershell
pnpm exec vitest run src/main/capture-screen.test.ts src/main/capture-displays.test.ts src/main/foreground-capture.test.ts src/main/screenshot-tool.test.ts src/main/scroll-capture.test.ts
pnpm typecheck
pnpm test:native
pnpm test
pnpm build
# 若采用 Rust，必须从 native/capture 工作目录执行，以读取作用域 CRT 配置：
cargo fmt -- --check
cargo clippy --locked --offline --all-targets -- -D warnings
```

- [ ] 在测试/构建结束后单独运行最终性能对照，避免并发测试污染数据；建议接入 `pnpm benchmark:capture`。
- [ ] 最终二进制 SHA-256 与报告一致；核对 x64/固定导出/无额外 VC++ 运行库要求。没有生成 DLL 时相应项标为“不采用”，不要填写通过。

## 7. DSH 的文档与交付要求

- [ ] 开始时将本文件状态改为“实施中”，总计划只引用本轮；不要重开已完成阶段。
- [ ] 在本文件追加“实际实现与验收结果”：采用哪种方案、准确接口与文件、真实改动、各项命令及退出结果、性能原始报告、边界/未测项、清理量。
- [ ] 只有代码、必要测试/构建和相应验收都完成的项目才能勾选。单测、真实 Electron、硬件测试分开写；不能将 mock 通过写成真实桌面通过。
- [ ] 更新 `docs/rust-refactor-plan.md` 的第六阶段状态，以及中英文 README 的现行架构/构建命令；没有采用 Rust 时明确记录原因，不声称迁移完成。
- [ ] 遵循当前分支与工作区 AGENTS.md，只暂存本任务文件，必要验证通过后自动 Conventional Commit。建议标题：`refactor(capture): move GDI capture to Rust`；若仅采纳 TS 改善，按实际变更改标题。
- [ ] 不 push、不打安装器、不发布、不修改用户设置/模型/数据、不自动重启正在使用的开发版。清理本轮可重建暂存前核对绝对路径，保留正式产物与报告。
- [ ] 最终在本 DSH 对话说明完成项、指标的范围、测试、未测项、提交 hash 和开发版需重启。然后停止，等待用户下一轮指令；不要继续处理本表中暂缓候选。

## 官方依据

- [GetDIBits：格式、返回行数与 bitmap 的选出要求](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-getdibits)
- [BitBlt：复制及 CAPTUREBLT 规则](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-bitblt)
- [DeleteObject：不能删除仍选入 DC 的对象](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-deleteobject)
- [Koffi：指针与原始缓冲区](https://koffi.dev/pointers)
- [windows-rs：微软生成的 Windows API 绑定](https://github.com/microsoft/windows-rs)
