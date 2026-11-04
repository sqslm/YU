# 自有 UIA 测试 provider（yu-v2 fixture）

用于把 PowerShell 基线（`resources/windows-tools.ps1` / `resources/current-content.ps1`）与 Rust 候选（`native/windows/src/address.rs` → `native/bin/yu-windows.exe`）并排对照的**完全可控** UI Automation 树。

它不是浏览器，也不依赖 Win32/WinForms 的默认映射：窗口、树、每个节点的 ControlType/Name/AutomationId/IsOffscreen/IsPassword 以及 ValuePattern 取值全部由自带 provider 通过 `WM_GETOBJECT` + `UiaReturnRawElementProvider` 直接暴露。窗口是**非激活**的（`WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`，`ShowWindow(SW_SHOWNOACTIVATE)`，从不调用 `SetForegroundWindow`/`Activate`），创建与刷新期间不夺取前台。

## 文件

| 文件 | 作用 |
| --- | --- |
| `tests/yu-v2/fixtures/uia-provider.ps1` | 唯一入口：解析 `-Mode`，用 .NET Framework 的 `csc.exe` 编译同目录 `uia-provider.cs`，加载后运行消息泵 |
| `tests/yu-v2/fixtures/uia-provider.cs` | provider 实现（`IRawElementProviderSimple/Fragment/FragmentRoot` + `IValueProvider`）、命令循环、各 mode 的树组装 |
| `tests/yu-v2/fixtures/uia-tree.ps1` | 用 `System.Windows.Automation` 从外部读树，逐行输出 JSON（调试/取证用） |
| `tests/yu-v2/fixtures/uia-foreground.ps1` | 打印当前前台 HWND（证明 fixture 不夺取前台） |
| `scripts/uia-fixture-check.mjs` | 自检：每个 mode 起一次 fixture，读树并断言，再跑两侧读取器对照 |

编译产物写在 `%TEMP%\uia-provider-fixture\uia-provider-<源码时间戳>.dll`，**不进仓库**；源码改动后自动重编译。

## 启动

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/yu-v2/fixtures/uia-provider.ps1 -Mode address-edit
powershell -NoProfile -ExecutionPolicy Bypass -File tests/yu-v2/fixtures/uia-provider.ps1 -ListModes
```

启动后在 stdout 打一行 `ready`：

```json
{"type":"ready","pid":12816,"handle":"0x6A0EC2","title":"UIA fixture - address-edit","mode":"address-edit"}
```

`-Mode file-url` 额外带上自己创建的临时文件绝对路径（长路径形式）：

```json
{"type":"ready","pid":9120,"handle":"0x5C0F2A","title":"UIA fixture - file-url","mode":"file-url","file":"E:\\CpanQianYi\\Temp\\yu-uia-中文 100% 8b38cc364a224898a0c671fccf592ca2.md"}
```

## 命令（stdin，一行一个 JSON）

| 命令 | 事件 |
| --- | --- |
| `{"command":"describe"}` | `describe`：pid/handle/title/mode/failStage（有则附 `file`）/alive/blocking/rootName |
| `{"command":"retitle","title":"…"}` | `retitle`：改窗口标题（UIA 根 Name 同步） |
| `{"command":"block"}` | `blocked`；此后首次非根节点的属性/pattern 读取会阻塞 |
| `{"command":"unblock"}` | `unblocked`，放行被阻塞的读取 |
| `{"command":"destroy"}` | `destroyed`：销毁窗口，进程存活；`file-url` 下顺手删除临时文件 |
| `{"command":"quit"}` | `quit` 后进程退出 |
| `-Mode provider-error` | 额外 `{"type":"injected","stage":"…","call":"…"}`，证明故障真的在 provider 侧触发 |
| 任意读取 | 每次 `IValueProvider.Value` getter 被调用都会发 `{"type":"value-read","id":…,"name":…,"controlType":…}`；`excluded-value-blocked` 中被标记的字段先发 `{"type":"value-blocked","id":…}` 再阻塞 |

未知命令、`retitle` 缺 `title`、`unblock` 未阻塞时都会回 `{"type":"error","message":"…"}`，不退出。

## mode 与期望树

根节点恒为 `Window`（AutomationId `fixtureRoot`）。`Edit`/`ComboBox` 一律挂在 `ToolBar`（`browserToolbar`）下，除非另有说明。

| mode | 期望树 |
| --- | --- |
| `address-edit` | Window > ToolBar > Edit（id `addressEditBox`，Name `Address and search bar`，Value `https://example.com/a`） |
| `address-combo` | Window > ToolBar > ComboBox（Name `地址和搜索栏`，Value `https://example.com/b`） |
| `no-candidate` | Window > ToolBar，没有 Edit/ComboBox |
| `duplicate` | ToolBar 下两个 Edit，值都为 `https://example.com/c`（应去重成 1 个） |
| `ambiguous` | 两个 Edit，`https://example.com/d` / `https://example.com/e` |
| `document-overrides` | ToolBar 下 Edit `https://example.com/f` + 一个可见 Document `https://example.com/g` |
| `document-ambiguous` | 两个可见 Document，值不同 |
| `pseudo-address` | 一个 Document，内部含 ToolBar > Edit（Name `地址和搜索栏`，Value `https://evil.example/x`）——伪地址栏，必须被拒 |
| `password` | ToolBar 下 Edit，IsPassword=true，Value `https://example.com/h` |
| `offscreen` | ToolBar 下 Edit，IsOffscreen=true |
| `no-toolbar` | Edit `https://example.com/j`，但没有 ToolBar 祖先 |
| `deep-40` / `deep-41` | Edit 距根 40 / 41 层祖先（Edit 的 `depth` 就是 40 / 41） |
| `documents-20` / `documents-21` | 20 / 21 个可见 Document（第 21 个为 `https://example.com/late`） |
| `edits-100` / `edits-101` | 100 / 101 个 Edit（第 101 个为 `https://example.com/late`） |
| `file-url` | ToolBar 下 Edit，Value 是 fixture 自己创建的临时文件的 `file:///` URI（`System.Uri.AbsoluteUri`，百分号转义与真实浏览器一致） |
| `provider-error` | 与 `address-edit` 同形；故障按 `-FailStage` 注入（见下） |
| `excluded-value-blocked` | `pseudo-address` 的树；Document > ToolBar > Edit（Name `地址和搜索栏`，Value `https://example.com/pseudo`），该 Edit 的 Value getter 先发 `value-blocked` 再等 `unblock`/2s。跳过它的读取器完全不会进 getter |
| `no-value-pattern` | ToolBar 下有一个合格 Edit，但 `GetPatternProvider(ValuePattern)` 返回 null（不会抛异常）；没有可用地址 |
| `metadata-document` | 一张 Document（Value `https://example.com/doc`），没有地址栏 |
| `metadata-override` | ToolBar 下 Edit `https://example.com/from-bar` + 唯一 Document `https://example.com/from-doc` |

深度语义：`deep-N` 用 N-2 层 Pane 垫到 ToolBar，再把 Edit 挂在 ToolBar 下，所以 Edit 的 UIA 深度恰好等于 N。

## 故障注入（`-Mode provider-error -FailStage …`）

| stage | 注入点 | 客户端实测 |
| --- | --- | --- |
| `get-property` | `Kind.Edit` 读 ControlType 时抛 `InvalidOperationException` | 两侧都退化成「树里没有候选」：exit 0、无 `url`。**UIA core 吞掉了异常** |
| `find-children` | `ToolBar`/`Document` 的 `Navigate(FirstChild)` 抛异常 | 同上 |
| `root-fragment` | 根节点的 GetPropertyValue/GetPatternProvider/GetRuntimeId/Navigate 抛异常 | 同上（core 对根节点也不上报） |
| `host-hwnd` | 根的 `HostRawElementProvider` 指向已销毁的哑窗口 | 无效果：core 直接忽略根的 host provider，读取照常成功 |
| `unresponsive` | 启动即 `block`（不释放），首个非根读取永久阻塞 | 读取端一直卡住（客户端必须自己加超时）；`describe`/`quit` 仍然即时可用 |
| `both` | 同时开启上面四种抛错注入 | 同 `get-property` |

结论：**在进程内 provider 上，异常不可能变成客户端可见的错误**——core 会把它转成「属性不可用/没有子节点」。客户端能看见的 UIA 故障只有两种：读取挂死，以及窗口消失（见下）。因此自检脚本对 `provider-error` 只断言「故障确实触发 + 两侧都没编造 url」，两类客户端可见故障另做断言。

## 值读取事件（`value-read` / `value-blocked`）

`value-read` 只在 `IValueProvider.Value` 的 getter 里发，`GetPatternProvider`/`IsReadOnly` 都不发，因此事件流能区分「走了一遍树」和「真的读了值」。它无条件发出，不受 `block` 影响。

- `metadata-document`：`metadataOnly=false` 时读 Document 一次（`value-read` 1 条，返回 `https://example.com/doc`）；`metadataOnly=true` 且没有地址栏时一条都不发、也不返回 url。
- `metadata-override`：两种 `metadataOnly` 下都是 `Edit:addressEditBox` → `Document:document` 两条，url 取 Document 的 `https://example.com/from-doc`。
- `no-value-pattern`：两侧都不会产生 `value-read`（没有 ValuePattern 可读）。
- `excluded-value-blocked`：跳过被排除字段的读取器既没有 `value-read`（针对该 Edit）也没有 `value-blocked`；作为阳性对照，用 `uia-tree.ps1` 全量读树时该字段必然发出 1 条 `value-blocked`，并在 2s 上限内放行。

## 自检

```bash
node scripts/uia-fixture-check.mjs                # 遍历 -ListModes 全部 mode，读树断言
node scripts/uia-fixture-check.mjs --helper       # 额外跑 native/bin/yu-windows.exe 对照
node scripts/uia-fixture-check.mjs --block        # 阻塞门与被阻塞后仍可 describe 的验证
node scripts/uia-fixture-check.mjs --unicode      # 非 ASCII 标题经 stdin 往返
node scripts/uia-fixture-check.mjs --file         # file-url：两侧都返回 path、且没有 url
node scripts/uia-fixture-check.mjs --error        # 故障注入：吞异常 / 挂死 / 窗口消失
node scripts/uia-fixture-check.mjs --events       # value-read/value-blocked 顺序与 metadataOnly 边界
node scripts/uia-fixture-check.mjs --only deep-40 # 单 mode
```

退出码 0 表示全部通过，1 表示有失败（逐条打印原因）。脚本对每个子进程都设了超时，超时只杀自己起的 pid，从不按进程名强杀。

`--error` 的三段断言：

1. `get-property` / `find-children`：`injected` 事件必须出现，两侧读取器不得返回 `url`，fixture 后续仍能 `describe`、`quit`。
2. `unresponsive`：读取卡住时 `describe` 必须立即响应、`quit` 必须退出（实测 describe 0ms、quit 62ms）。
3. 销毁窗口后：两侧都必须显式失败（实测都报 `Original window has changed or closed`、exit 1），不得返回空结果当成功。

## 已知限制

- **进程内 provider 的异常对客户端不可见**（上面实测）。不要把「provider 抛错」当成可传导的失败用例；需要客户端可见的失败请用 `unblock` 之外的挂死，或销毁窗口。
- `host-hwnd` 档位是死代码：core 不使用根的 host provider，仅作为阴性对照保留。
- `block` 只作用于非根节点，这是刻意的：既要能卡住真实读取，又要让 `describe`/`quit` 在窗口线程被占用时仍可用。被卡住的读取无法在调用线程内中断，调用方必须自带超时。
- 非激活是设计约束而不是断言对象：窗口从不调用 `SetForegroundWindow`。自检只判定「前台 HWND 是否变成 fixture 自己」；前台被其它程序拿走只记录、不判失败。
- `file-url` 的临时文件由 fixture 自己创建（`%TEMP%\yu-uia-中文 100% <guid>.md`，故意带中文、空格和字面百分号，用来验 `file:///` URI 的百分号转义），不接受调用方传入路径；`quit`/`destroy` 时删除，删除失败只写 stderr。`ready` 里的路径用 `GetLongPathNameW` 展开，避免 8.3 短名。
- PowerShell 5.1 的管道默认编码会破坏非 ASCII：给 fixture 写 stdin 必须由 Node 用 `Buffer` 以 UTF-8 写入，不能用字符串直接 `write` 后交给控制台编码。
- `no-value-pattern` 的 provider 侧行为是「不支持」而不是「抛异常」：`GetPatternProvider(ValuePatternId)` 直接返回 null，连续两次读树都正常、无 `injected` 事件、stderr 为空，客户端表现是「没有 ValuePattern」。历史对照：08:23 / 09:22 构建的 `yu-windows.exe` 在该 mode 上以 exit 1 失败（`UIA address read failed at value pattern (HRESULT 0x00000000)`），当前构建（09:31，由主会话侧修好）与 PowerShell 基线一致：exit 0、空结果、无 `value-read`。
- `retitle` 只改窗口标题与根 Name，不重新组装树。
- `-Mode provider-error` 默认（`-FailStage none`）与 `address-edit` 完全同形，方便先用它做基线再注入故障。

## 与两侧读取器对接的方式

两侧读同一个请求对象（stdin 一次性 JSON），字段一致才能对照：

```json
{"action":"browser-url","handle":"<十进制 HWND>","pid":<fixture pid>,"title":"<ready.title>"}
```

- `handle` 用十进制字符串：Rust 侧按 `u64` 解析，PowerShell 侧转 `IntPtr`。
- `title`/`pid` 必须在读取前后都能对上，否则两侧都会以「Original window has changed or closed」失败。
- 必须自带超时（`spawnSync({timeout})` 或 `AbortSignal.timeout()`）：fixture 卡住时调用线程无法自行恢复。
- `native/bin/yu-windows.exe` 与 `resources/windows-tools.ps1` 的输出字段顺序不同（前者 title 在前，后者 title/truncated 在前），对照时按 JSON 语义比较，不要按字符串比较。

## 实测记录（本机 Windows PowerShell 5.1）

- 全部 mode 读树断言通过；元素数：`address-edit` 3、`no-candidate` 2（Window+ToolBar+Pane 中无候选）、`duplicate` 4、`ambiguous` 4、`document-overrides` 4、`document-ambiguous` 3、`pseudo-address` 4、`password` 3、`offscreen` 3、`no-toolbar` 2、`deep-40` 41、`deep-41` 42、`documents-20` 21、`documents-21` 22、`edits-100` 102、`edits-101` 103。
- `file-url`：两侧均返回 `{"path":"E:\\…\\yu-uia-中文 100% <guid>.md","truncated":false}`，`path` 与 `ready.file` 逐字相等，都没有 `url` 键；地址栏值是 `file:///E:/…/yu-uia-%E4%B8%AD%E6%96%87%20100%25%20<guid>.md`。`quit` 后临时文件已删除。
- 值读取事件：`--events` 全 PASS，明细见 `value-events` 探针输出。
- `provider-error`：四个注入档位的两侧输出见上表；`unresponsive` 下 describe/quit 不受影响。
- 前台不变：fixture 启动、读树、销毁全程，`GetForegroundWindow` 从未等于 fixture 自己的 HWND。
- 进程残留：自检结束后按 pid 检查，fixture 全部退出。

## 仓库注意

`.gitignore` 是白名单：`/tests/yu-v2/` 已放行（本目录文件可提交），但 `/scripts/*` 默认忽略——`scripts/uia-fixture-check.mjs` 需要额外一行 `!/scripts/uia-fixture-check.mjs` 才会被跟踪。
