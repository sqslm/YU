# 第六阶段：GDI 截图采集 Rust 重构与 DSH 实施计划

> **执行者：DSH，直接在现有 typeless 工作区实施。** 按任务顺序推进；完成后由 DSH 自行回写本文件和总计划的实际实现、命令结果、性能证据及限制，然后结束。不自动启动下一轮，不要求 Codex 监听或验收后才能收尾。

**状态：已完成（DSH，2026-11-03，基线 `872e5b5`）。结论：采纳「缓存 Koffi 绑定 + 原始 BGRA Buffer」的 TypeScript 路径，不采纳 Rust DLL。** 本文件是评估与开发要求；实际实现、命令结果与限制见文末“实际实现与验收结果”。

**目标：** 保留 Electron，降低滚动截图采集过程中的主线程开销和多余整帧转换，同时保持像素、DPI、失败处理和资源回收行为。

**架构：** 优先验证独立的 `yu-capture.dll`，通过既有 Koffi 同步写入调用方 Buffer；GDI 资源只在单次调用期间存在，不保留像素指针。保留 `captureScreen(rect): NativeImage`，为滚动路径提供原始 BGRA Buffer 入口。根据三方案实测决定是否采纳 Rust；不引入图像 RPC、共享内存、常驻截图进程或新截图技术栈。

**工具链：** 既有 Rust stable MSVC、微软 windows-rs、Koffi、Electron、Vitest。复用已安装工具与 E 盘缓存，不升级依赖或下载大型工具。

**评估基线：** `872e5b5f17e4c57a82077061a38bdc9733307847`。开始前检查当前 Git 状态；若已有更新，以实际代码复核，不覆盖工作区变更。

## 1. 本轮评估结论

| 候选 | 现有证据 | 本轮决定 |
| --- | --- | --- |
| GDI 截图采集 | `capture-screen.ts` 每帧重新 load/绑定 9 个 API，遍历全部像素设置 alpha；`screenshot-tool.ts` 每 50ms 调用并转回 Bitmap | 本轮优先，先测再迁移；采集收益尚未测定 |
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

- [x] 记录采集函数、alpha 循环、NativeImage 创建/转回 Bitmap、`scroll.add`、预览采样的分段耗时，确认主要成本。
- [x] 对照 A：基线原版；B：仅缓存 Koffi 绑定并直接返回原始 Buffer 的 TypeScript 控制版本；C：Rust DLL + 原始 Buffer。
- [x] B 只用于隔离缓存/复制改善，不把 A→C 的全部收益归因于语言；若最终 B 更适合，可采用 B 并说明 Rust 未采纳。
- [x] 在同一个实际 Electron 运行时、同一个不抢焦点的自有不透明测试窗口中交错运行 A/B/C/C/B/A，至少预热 3 次，每项每轮测 15 次；保存原始样本、P50/P95、CPU 时间、可用的私有驻留/提交内存和 GDI 对象计数。
- [x] 分别报告采集到 Buffer、兼容 NativeImage 路径，以及采集到拼接/原始缩略图的总成本。若不测 PNG、renderer 或合成等待，明确排除，不能称作整链路帧率。
- [x] 测试只采自有窗口内已验证的客户端区域。窗口须不透明，不能复用透明 fixture 去读背后的用户桌面；不保存或上传用户画面。
- [x] 可显示的 720p/1080p 场景做实际 GDI 采集；4K 若无法完全覆盖自有窗口，就只做内存 DC/合成像素测试并标注，不能冒充真实 4K 桌面采集。

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

- [x] JS 与 Rust 都校验整数坐标/尺寸、正宽高、上限及 `width*height*4` 的安全计算。负 x/y 合法；长度不符、空指针、溢出必须在 GDI/指针读取前失败。
- [x] Buffer 由 JS 分配，Rust 仅在同步调用期间写入；不从 Rust 返回堆指针，不保留指针，不跨线程访问 Buffer。
- [x] 首版沿用 GetDC → CreateCompatibleDC/Bitmap → BitBlt → GetDIBits 的现行算法，直接把 GetDIBits 输出写入调用方 Buffer，Rust 填 alpha；无需先引入 CreateDIBSection 或 GPU 后端。
- [x] BITMAPINFOHEADER 使用负高度的 top-down 32bpp；必须在 GetDIBits 前将目标 bitmap 从 DC 选出，返回行数必须等于高度。
- [x] 使用生成的 Win32 绑定与局部 RAII 管理。正确识别句柄/API 失败；先恢复旧选中对象，再删除 bitmap/DC，屏幕 DC 用 ReleaseDC，不混用 DeleteDC。
- [x] 所有成功及中途失败路径都回收资源；GetLastError 只在对应 API 保证设置时使用，不能用陈旧错误码遮蔽实际失败阶段。
- [x] 维持当前错误语义，JS 不读取失败时的部分 Buffer。不要用 `catch` 返回空图；panic 不跨 FFI 展开。
- [x] 静态 CRT，DLL 按需加载，不在 import 时访问桌面。DLL 仅导出固定的业务函数，不接受任意句柄、指令或命令文本。

## 5. 任务 C：接入原始像素路径与构建

- 修改：`src/main/capture-screen.ts`、`screenshot-tool.ts`、`screenshot-tool.test.ts`。
- 核对：`capture-displays.ts`、`capture-displays.test.ts`、`foreground-capture.test.ts`、`scroll-capture.test.ts`。
- 修改：`scripts/build-native.mjs`、`electron-builder.yml`、`package.json`、`.gitignore`、必要的 `THIRD_PARTY_NOTICES.md`。

- [x] 提供 `captureScreenPixels(rect): Buffer`（或等效窄接口）；`captureScreen(rect)` 包装它创建 NativeImage，保持既有调用方接口。
- [x] 滚动计时器直接将 BGRA Buffer 传给 `scroll.add`，去掉该处 `NativeImage → toBitmap` 回绕。不要改结束导出时的 BGRA→RGBA 交换，否则会造成红蓝颠倒。
- [x] 更新测试中的 capture mock，使初始截图和原始帧路径都受覆盖；不通过删除既有断言、放宽像素检查掩盖回归。
- [ ] 建议产物：开发 `native/bin/yu-capture.dll`，打包 `resources/native/yu-capture.dll`，ASAR 外。Cargo 默认 `yu_capture.dll` 的文件名差异在构建脚本明确处理。**不适用：未采纳 DLL，未产生打包产物，`native/bin/yu-capture.dll` 只由 `pnpm benchmark:capture` 构建。**
- [ ] 保留“内容相同则不覆盖”逻辑；不得终止用户运行中的热键/UIA/应用进程来绕过 Windows 文件锁。打包模拟路径与缺失 DLL 错误要有回归。**不适用：`scripts/build-native.mjs` 与 `electron-builder.yml` 未改动，原有逻辑照旧。**
- [x] 原生源码、lockfile、许可与正式报告入 Git；临时探针、Cargo target、二进制缓存按既有规则处理，不提交完整运行目录。

## 6. 任务 D：正确性、资源与性能验收

- [x] 证明 BGRA 通道、alpha、行方向与行跨度正确，包含红/蓝可区分色块、首末行以及奇数宽度；用实际 Electron NativeImage 做一次往返对照。
- [x] 对固定自有图案逐像素比较新旧结果；渲染有变化时应失败/重测，不以放宽容差掩盖时序或像素问题。
- [x] 测试无效尺寸、非整数、NaN/Infinity、ABI 范围、空/短 Buffer 和像素上限；失败后可继续正常调用。
- [x] 持续采集/失败/关闭循环后 GDI 对象数无随次数增长的趋势。预热与基线波动单独记录，不把系统计时粒度的 0 当作零 CPU。
- [x] 保留混合 DPI/负坐标布局测试；无实际第二屏、UAC、RDP 或锁屏场景时标为未测，不改系统设置凑验收。
- [x] 确认关闭/游戏模式/异常时原有计时器与 Escape 清理仍工作，预览节流和拼接上限不变。

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

- [x] 在测试/构建结束后单独运行最终性能对照，避免并发测试污染数据；建议接入 `pnpm benchmark:capture`。
- [x] 最终二进制 SHA-256 与报告一致；核对 x64/固定导出/无额外 VC++ 运行库要求。没有生成 DLL 时相应项标为“不采用”，不要填写通过。

## 7. DSH 的文档与交付要求

- [x] 开始时将本文件状态改为“实施中”，总计划只引用本轮；不要重开已完成阶段。
- [x] 在本文件追加“实际实现与验收结果”：采用哪种方案、准确接口与文件、真实改动、各项命令及退出结果、性能原始报告、边界/未测项、清理量。
- [x] 只有代码、必要测试/构建和相应验收都完成的项目才能勾选。单测、真实 Electron、硬件测试分开写；不能将 mock 通过写成真实桌面通过。
- [x] 更新 `docs/rust-refactor-plan.md` 的第六阶段状态，以及中英文 README 的现行架构/构建命令；没有采用 Rust 时明确记录原因，不声称迁移完成。
- [x] 遵循当前分支与工作区 AGENTS.md，只暂存本任务文件，必要验证通过后自动 Conventional Commit。建议标题：`refactor(capture): move GDI capture to Rust`；若仅采纳 TS 改善，按实际变更改标题。实际标题：`refactor(capture): cache GDI bindings and expose raw BGRA frames`。
- [x] 不 push、不打安装器、不发布、不修改用户设置/模型/数据、不自动重启正在使用的开发版。清理本轮可重建暂存前核对绝对路径，保留正式产物与报告。
- [x] 最终在本 DSH 对话说明完成项、指标的范围、测试、未测项、提交 hash 和开发版需重启。然后停止，等待用户下一轮指令；不要继续处理本表中暂缓候选。

## 实际实现与验收结果（DSH，2026-11-03）

### 结论：采纳缓存绑定的 TypeScript，不采纳 Rust DLL

同一 Electron 进程内对本项目自有不透明窗口交错运行 A（基线原版）/B（缓存 Koffi 绑定 + 直接返回原始 Buffer 的 TS）/C（Rust DLL + 原始 Buffer），每变体 30 个样本，`decision: reject`：

| 场景 | 指标 | A p50/p95 | B p50/p95 | C p50/p95 | C vs B p50 |
| --- | --- | --- | --- | --- | --- |
| 720p | buffer | 8.653/13.238 ms | 7.863/9.135 ms | 8.060/8.798 ms | -2.5% |
| 720p | image | 8.460/11.032 ms | 8.177/21.879 ms | 8.262/15.046 ms | -1.0% |
| 720p | thumbnail | 8.355/18.081 ms | 8.413/17.374 ms | 8.203/10.502 ms | 2.5% |
| 720p | scroll | 9.006/12.116 ms | 8.378/11.653 ms | 8.098/12.899 ms | 3.3% |
| 1080p | buffer | 14.105/20.820 ms | 12.303/18.719 ms | 12.184/13.045 ms | 1.0% |
| 1080p | image | 12.730/15.832 ms | 12.779/17.829 ms | 12.482/22.327 ms | 2.3% |
| 1080p | thumbnail | 17.082/20.673 ms | 16.943/29.588 ms | 16.859/28.404 ms | 0.5% |
| 1080p | scroll | 13.697/18.737 ms | 12.516/13.785 ms | 12.282/12.954 ms | 1.9% |

- 真实收益在 A→B：1080p 采集到 Buffer 的 P50 从 14.1 → 12.3 ms（−12.8%）、P95 从 20.8 → 18.7 ms（−10.1%），720p P50 8.7 → 7.9 ms（−9.1%）、P95 13.2 → 9.1 ms（−31%）。三次运行 A→B 的 P50 区间为 6.9%–12.8%，来自“每帧重新 `koffi.load` 并绑定 9 个导出 + 为每帧创建 NativeImage 再 `toBitmap`”这两处被移除的成本；两处的占比没有单独测量，不能把 −6.9%～−12.8% 全部归给导出解析。
- Rust DLL 相对 B 的 P50 只有 −2.5%–7.9%（三次运行区间），低于本计划“P50 改善至少 10%”的采纳参考，且 p95 无稳定优势（1080p buffer +30%、image −25%、thumbnail +4%、scroll +6%），因此不采用：不接入生产路径、不进 `scripts/build-native.mjs`、不进 `electron-builder.yml`、不产生打包产物。`native/capture/` 作为“已测量的候选实现”留在仓库，DLL 只由基准脚本构建到 gitignore 目录。
- 采集收益只能归因于缓存绑定与原始 Buffer 路径；上一轮滚动匹配的 64→15 ms 与本轮无关（本轮 `scroll` 指标内两方案共用同一个 `yu-scroll.dll`，变体差异仅来自采集与包装）。

### 实际接口与文件

- `src/main/capture-screen.ts`（重写，约 85 行）：
  - `captureApi()` 在首次调用时 `koffi.load('user32.dll'/'gdi32.dll')` 并绑定 9 个签名（GetDC/ReleaseDC/CreateCompatibleDC/DeleteDC/CreateCompatibleBitmap/SelectObject/DeleteObject/BitBlt/GetDIBits），模块级缓存；import 时不触碰桌面。
  - `captureScreenPixels(rect: Rectangle): Buffer` — 校验 `win32`、整数宽高、`width<1 / height<1 / width*height > 40_000_000`，错误文案仍为 `Unsupported screen capture`；`GetDC → CreateCompatibleDC → CreateCompatibleBitmap → SelectObject → BitBlt(0x40cc0020) → 先选出旧对象 → GetDIBits`；40 字节 `BITMAPINFOHEADER`（40 / `-height` / planes 1 / 32bpp / BI_RGB），`Buffer.allocUnsafe(width*height*4)`，行数不等于高度抛 `GetDIBits failed`，alpha 逐 4 字节填 255；`finally` 中先恢复旧选中对象，再 DeleteObject、DeleteDC、ReleaseDC。
  - `captureScreen(rect): NativeImage` = `nativeImage.createFromBitmap(captureScreenPixels(rect), { width, height })`，调用方接口不变。
- `src/main/screenshot-tool.ts`：滚动计时器改为一行动作 `scroll.add(captureScreenPixels(physical))`，不再 `captureScreen(...).toBitmap()`；`open()` 仍用 `captureScreen`，结束导出的 BGRA→RGBA 交换未改动。
- `src/main/capture-screen.test.ts`（新建，4 个用例）：非法参数在绑定任何 API 前失败（7 组）、BGRA + alpha 全 255、BitBlt/行数失败后仍可继续采集、`captureScreen` 只创建一次 NativeImage。
- `src/main/screenshot-tool.test.ts`：mock 同时提供 `captureScreen` 与 `captureScreenPixels`；滚动用例改为断言原始 Buffer 路径的最后调用参数 `{ x: -1770, y: 150, width: 90, height: 90 }`，既有像素断言与回退/节流断言保留。
- `native/capture/{Cargo.toml,Cargo.lock,.cargo/config.toml,src/lib.rs}`（候选实现）：导出 `int32_t yu_capture_bgra(int32_t x, int32_t y, int32_t width, int32_t height, uint8_t *output, size_t output_len)`；0 成功、1 参数、2–7 对应 GetDC/CreateCompatibleDC/CreateCompatibleBitmap/SelectObject/BitBlt/GetDIBits 阶段；`windows = "=0.61.3"`（Foundation + GDI）、静态 CRT、`panic=abort`、局部 RAII，仅导出该函数。
- `scripts/benchmark-capture.mjs`（新建）：自行 `cargo build --release --locked --offline` 并复制到 `native/bin/yu-capture.dll`，两场景各起一个隔离 Electron（临时 profile、删除 `ELECTRON_RUN_AS_NODE`），校验像素/句柄/内存并写证据；`tests/yu-v2/fixtures/capture-electron.cjs`（新建）提供自有窗口与 A/B/C 实现；`package.json` 新增 `benchmark:capture`；`.gitignore` 加白名单 `!/scripts/benchmark-capture.mjs`。

### 命令与结果（同机 Windows 11、Ryzen 7 9700X、Electron 42.11.18、Node 24.22.2、Rust 1.97.0）

| 命令 | 结果 |
| --- | --- |
| `pnpm exec vitest run src/main/capture-screen.test.ts src/main/capture-displays.test.ts src/main/screenshot-tool.test.ts` | 3 文件 / 24 用例通过 |
| `pnpm exec vitest run src/main/foreground-capture.test.ts src/main/scroll-capture.test.ts` | 2 文件 / 11 用例通过 |
| `pnpm typecheck` | 通过 |
| `pnpm test:native` | hotkey 14、UIA 8、Windows 4、scroll 4 全通过 |
| `pnpm test` | 233 文件通过 / 1 文件失败，3495 用例通过 / 2 失败；失败均在 `src/main/wake-word-native.test.ts`（真实离线唤醒引擎未识别音频），单独复跑同样失败，与本轮文件无关，属既有环境相关失败 |
| `pnpm build` | 通过（renderer 11.76s） |
| `cargo fmt -- --check` | 通过 |
| `cargo clippy --locked --offline --all-targets -- -D warnings` | 通过（修掉 `field_reassign_with_default` 与 5 处 `manual_dangling_ptr`） |
| `cargo test --locked --offline` | 2 用例通过 |
| `pnpm benchmark:capture` | 三次运行均 `decision: "reject"`，production 与 A/B/C 逐字节一致 |

- 候选 DLL：`native/bin/yu-capture.dll` 197120 字节，SHA-256 `f379c1115e01e7f86758b4a8fb5cf9dce1a82fb8b373a068e22181360d13293b`；PE32+ x86-64、单节导出 `yu_capture_bgra`、导入仅 gdi32/user32/kernel32/api-ms-win-core-synch-l1-2-0/ntdll，无 VCRUNTIME/MSVCP，静态 CRT 生效。
- 生产模块交叉校验：基准采样后加载工作区 `src/main/capture-screen.ts`，`captureScreenPixels` 与 `captureScreen().toBitmap()` 的 SHA-256 均等于 A/B/C（720p `86edce0a44c8d064e71c3153dde6a52279c0b8f2c42e9ebb55a03adf3723bc36`，1080p `8af1aaa11ab7309fdf526b9e1e75bf5ba99dec1fe314233f6a36dde210f8f6e2`）。

### 像素、资源与边界

- 逐字节校验：顶部四色块（红/绿/蓝/白）、首行与末行、奇数宽度像素（`w-1`）、末行 6 个采样列、相邻行错位、alpha 全 255，全部等于确定性图案公式；`captureScreen` 与 `captureScreenPixels` 的字节完全一致，证明 BGRA 通道顺序、行方向与行跨度未被包装层改动。
- 泄漏：每个变体先采集 1 次再连续采集 200 次，GDI 对象 19→19、USER 对象 50→50，两个场景均零增量；`GetGuiResources` 由 user32 提供。
- 内存：`process.getProcessMemoryInfo()` 为异步接口，本次已改为 await 并在运行前后各取一次（720p 前 69.5 MB 私有 / 127 MB 驻留，后 6.5 GB / 6.3 GB）。阶段 7 复核结论（`tests/yu-v2/evidence/rust-capture-memory-20261103.json`）：6.5 GB 是基准同步批次分配快于回收时保留的已提交内存，external 始终只有 19–65 MB；采样停止后 `gc` + 两次 400 ms 事件循环空闲让私有内存回到 104–109 MB，再跑 100 次 `captureScreenPixels` 与 100 次 `nativeImage.createFromBitmap` 都不残留。该结论的适用范围是“调用方释放引用 + 显式 GC + 事件循环空闲”的探针条件，不能据此断定所有生产场景都无泄漏；该数字也不能作为变体间对比，GDI/USER 句柄零增长只证明被统计的句柄稳定。
- CPU：单次调用低于 Windows 计时粒度，按每变体连续 100 次累计。1080p buffer 批次 A 11.24 / B 7.03 / C 4.69 ms/次，720p A 5.77 / B 2.35 / C 2.19 ms/次，但跨运行波动明显（含 GC 与分配器归属），只作为旁证，不构成采纳依据。
- 未测项：4K（无 4K 显示器，也未做内存 DC 合成）、第二显示器与混合 DPI（本机单屏 1920×1080、scaleFactor 1）、UAC/安全桌面、RDP、锁屏、HDR/广色域、独占全屏 DirectX、PNG 编码、renderer 往返与桌面合成等待。`image`/`thumbnail` 指标只覆盖主进程内的 NativeImage 创建与 `resize().toBitmap()`，不是整条截图链路帧率。
- 边界条件：1080p 场景实际客户区为 1920×1032，因为普通顶层窗口会被 Windows 限制在 1080p 显示器的工作区内（`enableLargerThanScreen` 只在 macOS 生效）；报告在 `scenario.note` 中记录了该裁剪。窗口四角用 `DwmSetWindowAttribute(DWMWA_WINDOW_CORNER_PREFERENCE, DONOTROUND)` 取消圆角，否则边角像素会与桌面混合导致探针失败。

### 清理量

- 删除 `scripts/.capdbg/`、`.probe/`、`scripts/.capture-benchmark-*` 临时调查目录与每轮临时 profile。
- 保留 `native/capture/target/`（Cargo 构建缓存，`--offline` 可重建）与 `native/bin/yu-capture.dll`（基准产物），二者均被 `.gitignore` 排除。
- 本轮未改动 `scripts/build-native.mjs`、`electron-builder.yml`，安装包内容与上一阶段一致。

## 官方依据

- [GetDIBits：格式、返回行数与 bitmap 的选出要求](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-getdibits)
- [BitBlt：复制及 CAPTUREBLT 规则](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-bitblt)
- [DeleteObject：不能删除仍选入 DC 的对象](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-deleteobject)
- [Koffi：指针与原始缓冲区](https://koffi.dev/pointers)
- [windows-rs：微软生成的 Windows API 绑定](https://github.com/microsoft/windows-rs)
