# 语 / YU

**用你的方式，与电脑交流。** [English](README.en.md) · [完整设计理念](resources/brand/PHILOSOPHY.zh-CN.md)

![语 / YU](resources/brand/logo-light.png)

当前发布候选版 **1.0.0-rc.1**。Electron 运行时更新至 42.11.18，测试工具更新至 Vitest 4.1.12，修复发布审计发现的已知依赖漏洞。中文界面显示「语」，英文界面显示「YU」。主题 Logo、应用/任务栏/托盘与安装图标使用统一资源；设置只保留「关于」，介绍设计理念并按需展开诊断工具。登录页默认隐藏服务器地址，不预设个人部署；导出诊断时遮蔽凭据、网址、邮箱、内网地址及本机路径。已有安装沿用原配置、登录态和稳定的应用标识，避免改名造成数据丢失。


Ask 首次加载等待回答界面订阅完成后再发送内容，保留早到消息；关闭会清理旧内容，完成后空闲语音条按原时限隐藏，回答卡独立保留。普通任务仍只使用语音条反馈。侧边栏移除“自建后端 · 本地”，历史标题不再显示“仅本地”；同步与隐私说明保留在账户和数据设置。

设置初始读取不会覆盖更新后的连接配置。顺序备用从上到下使用启用的连接，不按账户数平分每个请求的期限；单个连接最多 8 秒，整轮最多 24 秒，外层工具采用相应的有限预算。合并来源仍最多并发两个连接、合并去重，达到整轮期限时保留已完成的结果；全部失败会明确报错，取消不会把部分结果伪装为完成。新闻多方向查询不再强制每方向仅 4 秒，连接密钥和顺序保持原配置。

Windows AI 助手升级按阶段交付，完整范围、实际进度和后续衔接见 [升级进度](ASSISTANT_ROADMAP.md)。问答统一使用 Ask 窗口，支持文字/语音提问和临时追问；独立 AI 助手窗口与主页入口已删除。本地助手工具在后台继续运行，可直接打开用户要求的 Windows 应用、文件夹、文档或网页，并支持用户要求的限定目录文件查找。原有语音输入、随记和提醒入口继续保留。提醒/待办、随记、历史查询、页面导航及当前窗口截图已接入；日程、长期记忆、简报和 TTS 尚未接入助手；可选 Windows 离线唤醒已接入统一语音入口。

0.35.0 的 [81 项验收对照](ASSISTANT_ROADMAP.md#81-项实测对照03502026-10-24) 记录真实接口测试结果和未解决事项，不代表全部通过。测试使用中英文合成语音及实际配置的 ASR、文本和视觉模型；真人麦克风、实体快捷键、覆盖安装和 Windows 通知实际显示另有验证边界。解释/分析选区有只读保护；已有提醒/待办修改必须取得真实成功工具回执，不能将模型回答当作已执行。明确的截图问题可直接调用既有视觉/OCR 服务，实际回执保留在短期会话中用于后续追问。

**0.41.0**：截图吸附按鼠标位置选取最上层可见的真实窗口，过滤完全透明以及鼠标穿透的覆盖层（例如系统手写输入画布），避免所有位置只吸附整屏。多个重叠窗口可在各自露出的区域分别预览、单击选取；不会截取被其他窗口遮挡的内容。按住 Alt 可临时跳过吸附，拖动仍自由框选。

截图图层仅在「鼠标」模式选中、拖动或缩放；画笔等绘制模式即使笔画重叠也创建新图层。矩形、椭圆、箭头、画笔、文字与马赛克均提供四角和四边中点共八个调整节点，复用截图选区缩放方式，并支持撤销。文字可独立调节宽高，保持文字内容；完成、另存为、OCR 与翻译沿用既有流程。

重新启动软件或从睡眠恢复时，到期未处理的提醒集中在主界面的醒目卡片逐条显示，仅有「已完成」和「知道了」两个按钮。「已完成」完成一次性事项；重复提醒完成本次并继续下一次。「知道了」只关闭本次告知，保留事项状态和原时间，不会因再次启动重复告知同一到期事项。错过的强提醒也在此汇总，不再次开启遮罩窗口；以后正常到期的强提醒继续使用原提醒方式。告知状态写入现有本地 SQLite，无需账号或服务器；后台启动发现尚未告知的错过事项时显示主界面。软件未运行时仍无法准时提醒，需实际启动后才能补报。

In **0.41.0**, screenshot hover/click targets each exposed native window while ignoring transparent click-through overlays. Use **Mouse** to move or resize annotation layers with eight handles; drawing tools create new marks even when they overlap. Missed reminders appear prominently in the main window on restart or resume. **Completed** completes that occurrence (recurring schedules continue); **Got it** dismisses only the notice and leaves the item unhandled. Acknowledgments persist locally and are not repeated for the same occurrence.

**0.40.0**：唤醒录音合并约 160 ms 小段后判断声音，修复真实 64 ms 麦克风分块总被判静音的问题；连续约 320 ms 有声且停顿 2 秒后提交，无语音等待 15 秒后明确结束。离线唤醒增加竞争听写语法、整句/逐词置信度、300 ms–9 秒长度及 5 秒冷却门槛；短唤醒词要求更高置信度。默认仍关闭，不上传唤醒前音频；建议选择四字以上、不像日常口语的短语。合成语音验证不代表嘈杂房间、电视声音或真人麦克风全部通过，系统语音语言包仍需安装。

随记新增独立标题，点击详情顶部即可命名或清空，沿用自动保存；标题可检索、导出并同步。助手可按真实随记 ID 增删标签、改名、分配已有分类或新建分类，不再只支持标签。原始转写直接保留 ASR 返回内容（包括口头语及入口指令），与润色稿分别存储；不会用任务识别改写后的文本充当原文。旧记录中已经被改写的文字不能凭空恢复，可从原有录音手动重新识别。列表与筛选分行，分类/标签编辑和次要操作默认收起，原文仍默认隐藏，主要空间保留给润色稿。

助手安全操作按用户当前请求直接执行，不弹额外授权框；缺少目标或时间时用文字询问，不猜测。不可逆删除、任意命令、安装及系统修改直接拒绝，未注册工具不能执行。仍不后台读取剪贴板、截图或文件正文，敏感应用和原窗口校验继续有效。随记提取仅在主动点击或要求时运行，明确事项直接保存并保留来源，歧义项汇报后跳过。手动管理页面的删除保护及系统文件路径选择器保留。

标题云同步需服务端 **2.0.2**，数据库自动增加兼容字段；旧客户端省略标题不会清空服务端已有标题，新客户端连接旧服务端时保留本地名称，但旧服务端不能跨设备同步名称。

Windows 工具使用 App Paths 和开始菜单的真实应用登记，不让模型猜 exe 路径。比如“打开 VS Code”“打开下载文件夹”“查找下载目录最新修改的 PDF”。简单打开请求和“打开第二个”直接由程序处理；复杂任务沿用现有 function calling，不支持时使用结构化 JSON，每次任务最多 4 轮工具、8 次调用、90 秒。工具按顺序执行，失败时停止后续操作；界面显示真实执行回执。打开成功表示 Windows 接受请求，不保证目标应用已加载完成。

用户明确要求打开软件、网页、文件夹或已有文档结果时直接执行，不再重复弹授权框。应用发现覆盖真实 App Paths、开始菜单和商店应用登记。文件元数据搜索按用户要求直接查询限定范围；文件名、路径、修改日期、大小可能发送至配置的模型，文件正文不会读取。「设置 → 数据与性能 → 数据与存储 → 助手文件搜索」可保存自定义下载目录，留空使用 Windows 下载目录。搜索优先查询 Windows Search，再补查目标目录；用户要求时可补查最多 3 层子目录、5000 个条目、5 秒，不跟随目录链接，支持压缩包等文件类型。最多展示 40 项，范围或时间受限会说明。日期指修改时间，不代表下载时间。多个候选必须由用户点击选择或明确说“打开第二个”；只允许打开实际结果 ID，支持常见文档/图片/音视频，不运行脚本和安装程序。清空或过期会话会使旧 ID 失效。本阶段不提供文件删除、软件安装或任意命令执行工具；原 Ask 不会自动获得这些本地工具。

助手可按原 ID 修改提醒时间和普通/强提醒等级，回执包含标题及修改前后时间；仅修改时刻会保留原日期，重复提醒保留星期集合。每周可指定多个星期或星期范围；明确的无时间待办可直接保存，不强迫设置通知时间。查询返回绝对时间、查询时刻的剩余秒数、等级和状态；今天的事项包含尚未处理的无时间待办。随记支持最近/上一条定位、独立标题、分类设置、标签增删和品牌同音检索，保留原文、录音与既有标签；历史日期筛选先于查询条数限制。随记录音沿用用户润色开关，明确使用轻度整理要求；原文已通顺时结果可以相同。

助手复用任务开始时的原窗口快照，不以助手窗口替代当前应用。明确请求后可读取原窗口选区或当前剪贴板文字，保留原窗口校验和剪贴板恢复，不监控历史；代码注释润色仅提交注释正文，程序保留注释符号、缩进、换行和其他代码。资源管理器目录通过原 HWND 查询 Shell，浏览器地址通过原窗口的地址栏可访问性信息读取，再使用原网页工具读取公开内容；目标变化、登录内容或无法读取地址时明确提示，不根据标题猜路径或编造摘要。

明确请求分析截图、屏幕图表或界面时，只捕获任务起始的目标窗口，直接调用已启用的 Gemini-compatible 多模态配置。普通文本模型不会被当作视觉模型。图片文字提取可使用 Windows 本地 OCR，依赖系统已安装的识别语言；图片保留在内存，提取文字可进入当前模型对话。默认不保存截图，也不截图其他屏幕作为失败兜底；窗口关闭、内容标题改变或最小化时要求重新操作。

**截图工具**：默认 `左 Ctrl + 右 Shift + X`，在「设置 → 语音与输入 → 快捷键」可修改/清空，升级避让已有绑定。仅在主动触发时冻结鼠标所在显示器，单击吸附窗口或拖动框选，只有边框可移动选区，四角及四边中点可调整大小；支持矩形、椭圆、箭头、画笔、文字、马赛克和撤销。「完成」复制带标注的选区图片到剪贴板并关闭；「另存为」打开系统保存窗口，可自选位置和文件名，取消保存返回编辑。`Enter` / `Ctrl+C` 完成，`Ctrl+S` 另存为，`Ctrl+Z` 撤销，`Esc` 退出；文字输入时保留常规编辑快捷键。右键撤掉选区，再次右键退出。

OCR 只在本机提取所选图片文字。默认「智能翻译」识别外语并译成应用界面主语言；无明确界面语言时使用系统语言，已有目标语言内容保留，也可手动选语言。翻译仅把 OCR 文字提交现有文本模型；点击 Ask 才把所选图片发送给已启用的多模态模型，截图问题可自填。结果可编辑、复制。未配置模型、OCR 无文字或缺少系统识别语言时明确报错，不编造结果。编辑器使用现有中英文和明暗主题，关闭即释放截图、窗口及未完成请求，不后台截图或自动保存。当前不含滚动长截图、贴图常驻或跨显示器框选。

The screenshot shortcut is **Left Ctrl + Right Shift + X**, configurable in Settings → Voice & input → Shortcuts. Select a region on the cursor's display; move/resize it, annotate or undo. **Done** copies the annotated PNG and closes; **Save as** opens the native location/name picker, and cancellation preserves editing. Enter/Ctrl+C copies; Ctrl+S saves; Ctrl+Z undoes; Esc closes. OCR uses installed Windows recognition languages locally. Smart translation defaults to the interface language (system locale fallback), with manual target selection; only recognized text goes to the text model. Explicit Ask sends the selected image to the configured vision model. No automatic capture, uploads, persistence or resident editor. Scrolling capture, pinned images and cross-monitor selections are not implemented. Display IDs and source pixel sizes follow Electron's [desktop capture API](https://www.electronjs.org/docs/latest/api/structures/desktop-capturer-source).

Ask 可通过托盘或默认 `左 Ctrl + 右 Shift + A` 打开/收起，快捷键仍可录制或清空，升级保留原绑定。原有 Ask 语音快捷键继续有效。一般问答、原窗口识别、截图分析和只读查询统一在 Ask 回答卡显示，文件搜索候选在同一窗口分页选择；打开应用/网页、创建或修改提醒/随记、复制等操作结果仅在语音条上方反馈，不再提供“查看详情”跳转助手窗口。后台继续复用原工具注册、参数校验、权限确认和临时上下文；不重新开发路由或执行引擎。Ask 支持文字输入、停止、复制、保存随记和继续提问；截图发送前的预览及取消也在同一 Ask 窗口完成，不绕过原确认。


「设置 → 通用 → 关闭主窗口时」可选保留后台或完全退出。默认关闭后后台保留快捷键、提醒与托盘；最小化保留任务栏窗口，不隐藏到托盘。隐藏主窗口在 60 秒后回收界面（录随记或最小化时不回收），需要时再创建；Ask 回答卡沿用原隐藏回收机制。操作任务在语音条上方显示结果气泡，10 秒后收起；问答使用 Ask，截图审批等必需交互仍保留。独立请求不携带旧对话，明确追问可引用必要的最近上下文；当前窗口查询直接使用本次录音开始的快照。托盘左键单击恢复主窗口并保留当前页面及编辑状态；主窗口重新创建时默认显示概览；右键菜单分别提供「打开主界面」「Ask」「随记」「提醒」「设置」，其中「设置」直接打开设置面板。托盘显示待命/录音/处理/快捷键暂停状态。开机启动仍为用户可选；默认不持续录音、截图或读取剪贴板。

The assistant upgrade ships in stages; see [the roadmap](ASSISTANT_ROADMAP.md). The standalone AI Assistant window and sidebar entry have been removed. Use the existing **Ask** answer window for questions, read-only local queries, file candidates and screenshot preview/consent. The configurable `Left Ctrl + Right Shift + A` shortcut and the tray's Ask action open it; existing voice shortcuts remain available. Actual action receipts appear only above the voice strip for 10 seconds, without opening another assistant window. The existing tool engine, permissions, original-window snapshots and temporary task context are retained. Independent requests do not inherit old question context; explicit follow-ups may use relevant prior results. The main window still minimizes to the taskbar and can close to the tray; a hidden main window retires after 60 seconds when safe.


Windows tools discover real registered applications, open folders/documents/web addresses and search scoped file metadata. Requested application, folder, document and website opens run directly without a second confirmation. File metadata searches retain their explicit, cancel-by-default authorization. Only file names, paths, modification times and sizes may reach the configured model; file contents are not read. Windows Search is supplemented with an immediate-folder check, never a whole-disk crawl. Unindexed subfolders, a 40-item result limit and unavailable indexing are reported. Multiple results require a user choice; “Open second” uses the actual previous ordering. Model output cannot supply an arbitrary executable or document path. Dependent operations are sequential and stop on failure, with at most four tool rounds, eight calls and a 90-second task deadline. Scripts, installers, deletion and arbitrary commands are unavailable. Calendar, memory, briefings and TTS remain future stages. Optional offline Windows wake phrases now use the existing unified voice entry.

品牌源文件位于 `logo/YU_语_品牌图标资源包`，运行资源位于 `resources/`。纯图标用于应用与任务栏，多尺寸 ICO 用于 Windows 程序、安装器和快捷方式；系统托盘按 Windows 托盘主题切换深浅线条图标。侧边栏用紧凑 Logo，关于页用横版完整 Logo，均跟随应用主题。原始资源保留，未重新绘制。`pnpm icon` 使用 Python 3 标准库直接复制资源，无需 Pillow；可用 `YU_PYTHON` 指定已有 Python。中文显示「语」、英文显示「YU」，静态 Windows 安装器与快捷方式名为 YU。技术包名、App ID 和原 `typeless-rebuild` 用户目录沿用，以保留配置、登录与升级身份。

Tray left-click restores the main window and preserves the current page or editor. Its context menu keeps Open main window, Ask and Settings as separate actions. Light and dark wordmarks use matching transparent canvases and sizing.

![语 / YU 品牌标志](resources/brand/brand-board.png)

Windows 上的语音输入客户端，界面与交互对齐 Typeless（hub 三页 + 设置弹层 + 底部胶囊悬浮条）：按一下热键开始说话，再按一下结束，自动「识别 → 润色 → 整段插入到当前焦点位置」，另提供翻译模式、Ask Anything（可联网检索）与「粘贴上一条」。

后端不绑定厂商：通用 ASR / LLM 支持 OpenAI 兼容协议，也提供厂商专用 ASR 适配器。通过「模型 → 添加配置」选择服务商并填写地址、密钥、模型及需要的专用字段。也可以切到**多模态链路**，把 WAV 直接丢给 Gemini `generateContent` 一条龙出文本。

随记支持按文字、录音或处理失败筛选，也可按最近修改排序；筛选和排序先于分页、批量操作及导出。录音随记即使尚未下载音频，也归入录音类型。详情可分别复制当前原文、润色稿（含尚未保存的编辑），播放器可前后跳转 10 秒并停在录音边界。手动编辑、批量修改和删除保存失败时会报告错误并恢复内存记录；删除写入成功后才清理录音。编辑未保存成功时，切换随记和重新润色会暂停，保留当前草稿供重试。

Notes can be filtered by text, voice or processing failure and sorted by last modification before pagination, bulk operations and export. Voice notes without a downloaded recording still count as voice notes. Copy the current original or polished draft directly, and skip recordings backward or forward by 10 seconds. Failed manual edits, bulk changes and deletions preserve the stored rows and recordings. Switching notes or polishing again waits for unsaved edits to succeed.

## 录音保障与离线唤醒（0.37.0） / Recording reliability and offline wake

开始录音时检查配置链路的 TCP 连通性，不提交测试音频或消耗 ASR 额度；服务未启动会立即结束本次录音并明确提示。已启用的内置 ASR 模型会按选定配置自动加载（仅使用已有文件，不自动下载）；外部 llama.cpp 等服务仍由用户启动，软件不会猜测启动命令。连接成功仅表示端口可达，不能保证模型已就绪、鉴权或转写必定成功。录音结束后遇到转写失败，音频保留到随记，可恢复服务后重新转写；取消和静音不保存，失败记录不进入历史。随记录音直接写盘后处理，继续保留原录音。

语音随记默认突出润色结果，原始转写区域默认完全隐藏，点击“查看原始转写”才显示，可编辑、复制；切换随记重新隐藏。文字随记直接编辑正文；未生成润色稿时显示已有正文，不冒充润色结果。

「设置 → 语音与输入 → 语音与翻译 → 语音唤醒」默认关闭，启用后通过 Windows 本地 System.Speech 的限定词语法等待用户自定义的 2–40 字符唤醒词。默认中文“你好语助手”，英文“Hello YU assistant”；仅旧版出厂唤醒词自动迁移，用户自定义词保留；对应的 Windows **桌面语音识别**语言包必须可用，中文/英文缺失会明确报错，不会降级为持续云端 ASR。使用 Windows 默认麦克风，默认设备与听写自选设备可以不同。先说唤醒词，看到录音条后再说需求；本版不承诺同一句连说唤醒词和正文。之后复用统一语音分流、ASR 与模型配置，连续有声约 320 ms 后停顿约 2 秒自动提交；无语音等待 15 秒后结束，右 Alt 提交，Esc 取消。任务、截图、锁屏或休眠期间暂停监听，恢复空闲后继续；唤醒前不上传音频，不保存监听内容。误唤醒和识别率仍受系统语言包、发音、噪声影响；可随时关闭，启用会增加本地麦克风与识别进程资源占用。参见 [Windows SpeechRecognitionEngine](https://learn.microsoft.com/en-us/dotnet/api/system.speech.recognition.speechrecognitionengine)。

Recording starts with a bounded TCP availability check, without sending test audio or consuming ASR quota. An enabled built-in model loads automatically from existing files. External ASR servers must still be started by the user. An open port does not certify credentials or model readiness. Final transcription failures preserve audio in Notes for retranscription; cancelled or silent takes are discarded, and failed history rows are not added. Voice notes devote the main editor to the polished draft. The original transcript is not rendered until Show original transcript is clicked; switching notes hides it again. Text-only or unpolished notes retain editable content.

Optional **Settings → Voice & input → Speech & translation → Voice wake** uses offline Windows desktop speech recognition and a custom 2–40 character phrase. It is off by default and requires the matching Chinese/English speech recognition language pack. It uses the Windows default microphone. Say the phrase, wait for the recording strip, then speak your request. Wake-triggered recording submits after about 1.4 seconds of silence or cancels after 10 seconds without speech; Right Alt submits and Esc cancels. Tasks, screenshots, lock and sleep pause listening. No pre-wake audio is uploaded or saved. Existing recognition and providers process the request after waking. Recognition accuracy and false activations depend on the installed Windows recognizer and microphone environment; enabling it adds a local recognition process.

## 截图改进（0.37.0） / Screenshot improvements

框选截图优先通过 Windows GDI 直接捕获光标所在显示器的原始像素，不启动 Chromium 屏幕视频捕获；不可用时保留 Electron 路径。编辑器仍按需创建，退出即释放。工具栏保持单行，窄屏可横向滚动；颜色、线宽、字号、马赛克块大小、OCR 语言、翻译目标和 Ask 问题在对应工具二级面板展开。四角与四边中点共八个节点用于缩放，只有拖动其他边框线才移动选区，内部空白不移动选区。选择工具可拖动全部标注图层，文字和马赛克工具也可拖动已有同类图层，撤销支持图层移动。

本地 OCR 优先选择中英混排识别语言，支持手动中文/英文选择；识别专用副本放大小字、反转暗底文字，导出图片保持原始像素。保留识别行分隔，消除中文分词空格，保留英文单词间空格。没有替换为微信私有 OCR，也不使用 LLM 编造纠字；很小、模糊、复杂背景的文字仍可能识别错误，未安装的语言包会报错。复制、另存为、翻译和视觉 Ask 保留现有数据发送边界。

On Windows, screenshot capture first uses a direct GDI monitor snapshot at source resolution, with the existing Electron path as fallback. The editor is on demand. One toolbar row contains all actions; tool-specific options expand below it. Eight corner/edge handles resize the crop; only its remaining border moves it. Blank interior dragging does nothing. Annotation layers, including text and mosaic, can move independently and undo their movement. OCR uses an enlarged, dark-background-adjusted copy, supports Chinese/English language selection, preserves lines and removes artificial Chinese spaces without joining English words. It remains Windows OCR, with accuracy limits for blurred or tiny text; screenshots are not secretly uploaded for correction.

## 提醒与待办（0.39.0） / Reminders and todos

同页提供“全部事项 / 提醒 / 待办”按钮，沿用现有数据：有具体触发时间的是提醒，无具体时间的是待办。提供单一“新建”分裂按钮：主按钮默认待办，下拉菜单选择提醒或待办，编辑器仍可切换事项类型；提醒必须选择时间，待办不显示提醒等级、重复或稍后提醒操作，不会因缺少时间而误存为提醒。从随记提取且无精确时间的候选仍可确认为待办。

类型标签下提供搜索框、状态与时间筛选：全部时间、今日、近一周、未来一周、自定义。近一周包含今天及过去六个日历日；未来一周包含今天及随后六天。自定义包含完整结束日期，反向日期会提示并不返回错误范围的数据。提醒按实际提醒时间、待办按创建日期筛选，筛选先于分页；查看通知或保存事项会恢复能看到目标的筛选范围。中英文与深浅主题均适配。

The same page separates scheduled reminders and undated todos, using the existing store. A single split New control defaults to a todo; its dropdown chooses a todo or reminder, and the editor retains its item-type selector. Reminders require a time; todos do not expose reminder level, recurrence or snooze controls. Clickable date filters support Today, Past week, Next 7 days and an inclusive custom range. Reminder dates use scheduled time; todo dates use creation time. All filters apply before pagination. Invalid ranges are reported, and navigation to a specific item clears restrictive filters.

## 截图与界面整理（0.39.0） / Capture and interface cleanup

提醒列表突出标题、提醒时间和重复规则；点击圆圈完成事项，编辑、复制、取消与删除收进“更多”菜单。新建默认待办，下拉可选提醒；搜索、状态和时间筛选集中在一行，自定义时才显示日期范围。

截图在首次绘制截图后再显示窗口，启动时直接传递原始像素，省去整屏 PNG 编码和解码，导出仍为原分辨率 PNG。启动时只读取一次可见顶层窗口边界；悬停预览、单击适配窗口，拖动仍自由框选，四边/四角调整与图层拖动保留。按住 Alt 点击可临时略过吸附。仅适配当前显示器可见区域，不承诺识别网页内控件或跨屏完整窗口；不增加常驻窗口或后台检测。窗口边界使用 [Windows DWM](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute)，缩放和坐标遵循现有显示器机制。

Settings now use six groups with contextual tabs, preserving existing values. Secondary audio/upload and application-exclusion controls expand on demand. Help & about → Diagnostics shows correctly parsed take timestamps, mode and app, and updates on take events. The task list uses one split New control (todo by default), compact rows and a More menu. Screenshot startup transfers lossless pixels and waits for a painted frame before showing. Hover previews a real top-level window, click snaps to its visible bounds, and drag still selects freely. Only the current display is captured; no resident capture or window polling is added.

## 快速开始

```powershell
pnpm install
# 起一个本地假后端，便于没有 API 时自测
pnpm mock                     # http://127.0.0.1:8787/v1
pnpm build
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # 见「已知坑」
node_modules\electron\dist\electron.exe .
```

首次运行的模型配置为空。在「设置 → 模型」添加语音转写和语言模型配置，填写服务地址、密钥与模型，测试连接后保存。使用本地假后端时，手动将配置地址设为 `http://127.0.0.1:8787/v1`；启动 mock 不会自动修改设置。

打包安装器：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
pnpm package          # → release\YU-1.0.0-rc.1-setup.exe
```


## 统一语音入口 / Unified voice entry（0.34.0）

默认用听写快捷键（右 Alt）说需求，结束后基于完整转写选择实际功能：普通/联网 Ask、计算/天气/时间、翻译、语音随记、提醒/待办、应用/网站/文件操作、个人数据查询或管理。原有专用快捷键与启用的自定义开头关键词优先；「指令输入」可明确保留为口述。取消、静音、识别失败或非法意图结果不执行动作。语音条在实际决策后显示对应模式/任务；自然语言意图不使用字幕片段提前执行。

「设置 → 语音与输入 → 快捷键 → 统一语音入口」默认开启，可关闭恢复纯听写。明确的提醒/随记及可识别的开发需求不额外分类；其他内容使用既有文本模型判断意图，可能增加一次调用，受 12 秒期限约束。多模态先转写；普通多模态听写继续以原音频和实际自动路由卡片处理，翻译使用本次指定目标语言或原有目标设置，不改动保存的设置。开发需求、引用命令继续按录音开始时的窗口路由润色；意图判断不是绝对无误，需明确口述时可用「指令输入」或关闭智能分流。

例：“明天提醒我上午十点去银行”复用完整内置提醒模板和本地时间校验；“帮我翻译成英语，今晚一起吃烧烤吧”只翻译正文；“为什么天空是蓝色的”走原 Ask 回答卡；“打开卡巴斯基官方网站”由助手先检索真实地址，再直接在默认浏览器打开，不猜域名或重复弹确认框。“帮我保存到随记：……”保留本次原始录音并复用已识别正文。

助手已接入现有提醒创建/查询/完成/取消/稍后/恢复/删除、随记创建/检索/提取候选、历史检索、确认后复制结果，以及概览/历史/随记/提醒/纠正规则/设置页面。没有单独为每项设置提供自动修改接口；配置仍在原设置页完成。本地数据读取、助手文字随记写入和已有事项修改保留逐次授权；提醒创建有歧义时打开原确认界面，不能把候选当作已保存。随记提取仍用完整模板并由用户确认，不覆盖原文。同任务重复的相同创建/修改调用复用回执，避免重复写入。

明确说“润色/翻译选中文字”复用选区捕获、原提示词及覆盖/追加设置；读取前检查录音起始窗口，应用前复核选区。选区解释/总结走原 Ask，读取前后均验证目标；敏感密码应用拒绝自动读取。正常 Ask 的成功答案进入现有 15 分钟临时助手会话，支持后续请求引用“刚才的回答”；失败、停止的内容不加入。没有常驻录音、剪贴板监听、额外窗口轮询或后台模型请求。

Use your dictation shortcut (Right Alt by default) for normal or web-enabled Ask, translation, voice notes, reminders/todos, Windows actions, personal-data queries and existing application pages. Dedicated shortcuts and enabled activation phrases take priority. Ordinary dictation and development requirements retain automatic prompt routing. Turn **Understand voice requests** off in Settings → Voice & input → Shortcuts for plain dictation. Classification uses your current text model and may add one request; multimodal audio is transcribed first. Commands are executed only after the final transcript, never from captions. Invalid/failed/cancelled takes perform no action.

Voice selection polish/translation reuses existing replace/append preferences and verifies the original window. Ask remains in its answer card; successful answers share the assistant's temporary session so follow-up requests can reference them. Notes retain original audio. Reminder creation and note extraction reuse the complete built-in template and program-side time validation. Personal data reads and existing task changes require explicit permission, official URLs must come from real search evidence, and ambiguous reminders still need review. Calendar, persistent memory and TTS remain unimplemented; opening Settings does not automatically change individual options.

## 使用

| 操作 | 默认快捷键 |
| --- | --- |
| 听写（识别 + 润色 + 插入） | `右 Alt` 按一下开始，再按一下结束；录音中按 `Esc` 取消 |
| Ask Anything（可联网检索后回答） | `Space + 右 Alt` 起，**单按右 Alt** 结束；答案同时弹出一张回答卡 |
| 翻译模式（识别后译成目标语言） | `右 Alt + 右 Shift` |
| 粘贴上一条结果 | `左 Ctrl + 右 Shift + V` |
| 选区润色（直接应用） | `左 Ctrl + 右 Shift + S` |
| 选区翻译（直接应用） | `左 Ctrl + 右 Shift + T` |
| 快速语音提醒 | `左 Ctrl + 右 Shift + R` |
| 框选截图 / OCR / 智能翻译 | `左 Ctrl + 右 Shift + X` |

触发方式可在「快捷键」页切成**按一下开始 / 结束**（默认，和 Typeless 一致）或**按住说话**；热键用录制方式改，托盘菜单可临时停用全部快捷键。切到「按一下」后，**听写、Ask 和语音翻译都只按一下右 Alt 就结束**——包括用 `Space + 右 Alt` 起头的 Ask，不必再重复起手组合。悬浮条不再重复显示「免提」标签或录音锁定提示，录音时保留波形和计时。

说明页仅在设置中提供，主窗口侧栏不重复显示。

「设置 → 语音与输入 → 快捷键」直接点击按键区域录制，无独立录制按钮；悬停显示提示。按下组合键后松开第一个键保存，先松开其他键也保留完整组合。`Esc`、点击其他区域或窗口失焦取消，旁边的 `×` 清空并解除该绑定。录制直接接收底层按键，区分左右 Shift / Ctrl / Alt；录制期间拦截按键向后续钩子及目标窗口传递，结束或失焦后恢复，仍按住的键在松开后释放拦截。系统保护的按键不保证拦截，其他软件先于本钩子处理的事件也无法撤回（[Windows 钩子说明](https://learn.microsoft.com/zh-cn/windows/win32/winmsg/lowlevelkeyboardproc)）。新组合与其他功能完全相同时会显示冲突并保留原绑定，按键顺序不同的同一组合也视为冲突；Alt / Alt+Shift 这类刻意设计的包含关系仍允许。

「设置 → 语音与输入 → 快捷键 → 语音关键词切换模式」默认关闭，开启后使用听写启动键（默认右 Alt）开麦，先说关键词，再说正文。听写、翻译、问答、提醒和随记分别默认使用「指令输入」「指令翻译」「指令问答」「指令提醒」「指令笔记」，英文对应 `command dictation` / `command translate` / `command ask` / `command reminder` / `command note`。每个模式可自定义多个短语，用分号或换行分隔，失焦保存；留空停用该模式，跨模式重复关键词会提示冲突并保留原配置。

关键词只匹配语音开头，不做模糊匹配，也不扫描正文；没命中时，统一入口开启则继续判断自然语言意图；统一入口关闭仍按正常听写处理。实时识别到开头关键词后，语音条立即更新模式和对应卡片/任务标签，保持同一段录音与计时；窗口路由继续使用录音开始时的窗口快照。最终执行以完整转写再次匹配为准，关键词不进入正文；只有关键词、识别失败或取消时不执行空任务。显式使用其他模式的快捷键，或录音中通过快捷键升级模式时，以快捷键为准。关键词配置在录音开始时快照，修改从下一次新录音生效；历史重试、随记重新转写不重新选择模式。

实时切换复用现有字幕的开头识别结果，仅接受仍包含首次有效声音起点的片段，避免六秒滑动字幕把正文误当指令。开麦后先保持安静不会耗掉关键词窗口，静音等待仅保留 200 毫秒预缓冲；已识别出的模式不会因后续不完整预览而闪回，最终仍以完整转写为准。关闭字幕时识别首次有效声音起点起至多六秒的音频来更新模式，可能增加少量 ASR 请求，不会在录音后半段持续轮询；实际反馈速度取决于识别接口，预览失败时仍由最终转写决定。多模态入口开启此功能后先用既有多模态服务转写，再走既有文本模型处理；传统路径只做一次最终 ASR。提醒复用原解析器，随记复用原存储、录音和润色流程及已识别文本，不重复整段 ASR。空闲时不监听唤醒词，不新增服务或模型配置。

「设置 → 搜索 → 调用方式」提供单一服务、顺序备用和合并来源。多连接模式可添加同一服务的多把已授权密钥，也可混用已有搜索服务；每条连接独立保存名称、密钥、地址、单次条数、启停和顺序。顺序备用遇到错误、额度不足、超时或空结果时尝试下一条，第一条成功即停止；合并来源以最多两个连接并行取回结果并去重，保留健康连接的结果。每次查询仍受总超时约束，普通查询使用各连接的条数，新闻汇总沿用多主题扩展。单一服务保留原配置。推荐以顺序备用节省重复调用；合并来源会增加请求量。密钥沿用系统密钥库加密保存（系统不支持加密时沿用原有明文回退）；不自动注册账号或推测免费额度。

搜索页的单一服务、保存的连接以及连接编辑框都提供「测试连接」，仅测试该条配置，不走备用链、不修改保存的密钥，显示结果数和耗时或具体错误。测试只在手动点击时发送一次真实搜索请求，可能计入供应商额度；编辑密钥、地址或服务后旧结果不再显示。

历史页「导出」可保存当前搜索、模式、应用和归档筛选下的全部正常记录，跨全部分页，支持 Markdown / TXT。导出包含本地时间、模式、应用、卡片、原始文字、结果和安全的来源地址，不带本机录音路径或同步信息；取消保存不写文件，记录已删除或写入失败会明确提示。历史读取范围跟随已配置的保存上限，不再固定截取前 200 条。历史页工具栏分为刷新和筛选两行，长结果默认收起，展开可读 Markdown 和来源；每条显示当前筛选下跨页连续的序号，顶部、底部均可翻页。

历史页可按今天、近 7 天、近 30 天或自定义日期筛选，按最新或最早排序；自定义范围包含结束日期整天，也可只填起始或结束日期。日期按本地日历计算，筛选和排序先于分页，导出保留相同范围及顺序；「重置筛选」恢复默认条件。普通结果和归档结果可单条保存到随记，保留原文、结果、模式、卡片名称及全部安全来源，不调用模型或读取剪贴板。历史详情默认预览四个来源，可展开完整来源并按全局每页数量分页，保留原引用编号。历史读取失败会保留上次结果并提示刷新，失败不丢弃期间排队的新搜索；失败恢复前禁用导出。搜索去重只规范化 URL 主机和片段，保留路径和查询值的大小写，避免误合并不同页面。

History supports local-calendar date filters (today, last 7/30 days or custom inclusive dates), oldest/newest ordering, and saving an individual successful record to Notes without another model call. Filtering and sorting apply before pagination and carry through to export. Full source lists expand and paginate with their original citation numbers. Read failures show a recoverable error and retain the last successful results; a newer queued search still runs. URL deduplication preserves case-sensitive paths and query values.

Ask 回答卡片右上角「固定」可保持卡片在切换应用后显示；关闭或按 Esc 仍可退出，隐藏后取消固定。回答结束后可「保存到随记」，保留问题、Markdown 回答及安全的来源地址和原引用编号；主动停止的部分回答会标注未完成。同一份当前回答保存成功后按钮禁用，避免重复创建；复用随记存储，不读取剪贴板、不额外调用模型。代码块可单独复制，不带正文或 Markdown 围栏。新问题和卡片隐藏后清理未发送的追问草稿。回答中的转义标点、含下划线的英文标识符及代码围栏按字面内容显示。

Ask cards support **Pin** to stay open when switching apps, **Save to Notes** to preserve the question, Markdown answer and numbered sources, and **Copy code** for individual code blocks. Closing or pressing Esc still dismisses a pinned card. Stopped partial answers are labelled incomplete; saving uses the existing notes store without a clipboard round trip or another model request. Unsent follow-up drafts clear for a new question or after the card hides. Notes recordings stream only requested byte ranges, including suffix ranges, instead of buffering the whole recording for every seek.

「设置 → 通用 → 列表每页条数」可选择 10 / 20 / 30 / 50 / 100（默认 30），历史页底部分页栏也可直接修改，顶部只保留翻页按钮。随记及分类管理、纠正规则与候选词、各类提示词卡片、窗口路由规则与窗口选择器、模型连接、搜索连接、热门场景分布明细、进程详情、提醒与提醒提取结果、Ask 来源列表在超出每页数量时分页；筛选先于分页，批量操作和导出仍针对完整筛选结果。随记新建或选中记录时自动定位所在页，删除导致末页缩减会返回有效页。菜单中的选项、固定设置行和概览摘要不拆页。

选区润色和选区翻译现在分别使用独立快捷键，直接处理选中文字，不弹出选择或预览窗口。默认 `左 Ctrl + 右 Shift + S` 润色、`左 Ctrl + 右 Shift + T` 翻译，在「设置 → 文本输入 → 选区处理」选择覆盖选区或追加到输入框末尾；追加保留原文并在输入框末尾添加换行和结果。升级保留原选区键，作为润色快捷键；新翻译键优先使用 T，如与已有绑定冲突则使用 Y 或 F9，实际绑定显示在快捷键页，清空的绑定保持清空。动作和粘贴上一条在完整组合键松开后执行。选区处理复用现有文本模型链、手动卡片优先级、窗口提示词路由和翻译目标，不录音、不调用 ASR、不写语音历史。应用前复查原窗口及选区；选区变化或取消时不写入，以悬浮条提示错误。

AI 提醒通过「快速提醒」快捷键复用现有录音和 ASR，开始/结束方式跟随录音设置，点按模式使用同一个完整快捷键再次结束。所有模式（听写、翻译、问答、提醒、随记）的录音也可统一按右 Alt 结束并提交，按 Esc 取消；这两个录音控制键的按下、重复和松开不会向当前应用透传，空闲时 Esc 恢复原行为。识别后使用文本模型备用链的独立结构化 Prompt，不使用润色卡片，也不插入原输入框。快速提醒入口本身表达提醒意图，支持直接说「20分钟后打扫卫生」，无需重复「提醒我」；明确的无时间待办直接保存；信息不一致时文字提示补充。明确且有效的提醒自动保存，悬浮条显示实际日期、时间及等级并提供短时撤销；缺失或有歧义的时间只以文字提示补充，不弹出确认窗口，失败、取消及普通陈述不创建提醒。默认快捷键如与已有绑定冲突，会选择可用备用键并在设置中显示。

语音提醒和随记提取共用「完整内置提示词提炼 → 结构化提取 → 程序时间校验」链路。第一阶段直接使用 [完整提醒提示词](src/main/prompts/reminder-refinement.md) 全文，不摘取、不改写、不使用用户润色卡片，模板随主进程打包，设置中无显示或编辑入口。中英文保持原语言；随记仅额外注明来源，避免将普通陈述或可能计划升级为明确提醒。第二阶段参考原文核对改口、否定、数字及条件，第一阶段的不确定性不能被清除。通常调用现有文本模型两次；已撤回或没有可提炼事项时只调用一次。没有新增服务或模型配置。语音条显示两阶段进度；相对时间以结束录音的提交时刻为基准，不随 ASR、意图判断或多步骤工具耗时向后漂移。失败或任一阶段取消均不保存提醒，撤回请求显示未保存反馈；随记原文不会被改写。

提醒支持中文、繁体中文和英文常见时间表达，由 Chrono 2.10.3 识别，再由程序校验明确的日期/时刻并计算本地时间戳。例如「20 分钟后提醒我打扫卫生」「明天上午 10 点提醒我打电话」「每周一上午 9 点提醒我开会」，以及 “Remind me in twenty minutes to clean up”, “Tomorrow at three thirty PM”, “Every Monday at 9 AM”。含糊的上午/下午、数字日期、日期范围和缺少时刻的事项要求确认，不使用模型生成的 Unix 时间戳。重复规则支持每天、每周多个星期和星期范围；月度、年度和限定次数/截止日期等规则保留原文并提示补充，不自动创建，不转换为一次性或无限重复。夏令时不存在的单次时刻要求修改，重复提醒跳过不存在的本地时刻。

提醒支持最多 4000 字的可选备注，保留人物、数量、条件等细节；语音创建、随记提取、批量确认和手动编辑共用此字段。备注保存在现有 SQLite JSON 记录中，旧提醒无需迁移；可按备注搜索，普通通知和强提醒均显示备注，长备注可滚动阅读。未设置时间的事项保留原始时间表达，方便稍后补充或确认不支持的规则。

提醒可复制为新的编辑草稿，确认保存后才创建，已过期的时间会清空。已完成或取消的事项可恢复为待处理：未来时间保留，过期的一次性事项恢复为不定时待办，重复事项安排下一次。管理页和强提醒窗口的「稍后提醒」旁提供 1、5、10、15、30、60 分钟选项，仅改变本次提醒，不改默认设置；重复提醒延后时间持久保存，系统时区变化不会覆盖明确的延后时间。随记在 AI 提取期间被删除或相关文本被修改时，旧结果不会再展示，须重新提取；空白转写可使用已有随记文本。

Reminders can be duplicated into an editable draft and are created only after saving. Restore completed/cancelled items to pending: keep a future time, turn an expired one-off item into an untimed to-do, or schedule the next recurring occurrence. The snooze menu offers 1, 5, 10, 15, 30 or 60 minutes for this occurrence without changing your default. Explicit snooze deadlines survive restart and timezone rebasing. Notes changed or deleted during extraction require a fresh extraction rather than showing stale results.

侧栏「提醒」支持本地手动创建、编辑、完成、取消、删除、稍后提醒、搜索、筛选和分页。普通提醒调用 Windows 系统通知，点击打开对应记录，是否呈现及声音受 Windows 通知权限和专注设置影响。提醒时间使用应用内日期选择器，跟随应用明暗主题和中英文；点击整行可选择日期、小时和分钟，确认后应用，清除则改为不定时待办。强提醒使用一个无系统标题栏、无最小化/最大化/关闭按钮的置顶遮罩窗口，在鼠标所在显示器居中显示约 480 × 380 的卡片；周围暗化并接收鼠标，避免误点后方应用。首次出现时请求前台焦点，不持续抢焦点。队列共用一个窗口，每 30 秒提示音，可完成或默认延后 5 分钟；界面保留紧急关闭入口，Esc / Alt+F4 也可退出本次显示，保留待处理状态，重启恢复。不会锁定桌面或拦截系统级切换、任务管理器等按键。通用设置可关闭普通通知、关闭强提醒声音，或修改默认稍后提醒时长。

随记详情的「提取待办与提醒」只在点击时调用模型，直接保存明确的待办和有效提醒，跳过可能的计划、含糊时间及不支持的重复规则，并汇报数量；明确要求保存且未指定时间的待办不强迫填写提醒时间，保留来源随记链接，不覆盖随记原文。所有入口共用本地 SQLite 存储与同一个调度器，数据在用户目录的 reminders.sqlite，独立于语音历史保留规则和账号登录；已保存任务离线仍可触发。应用完全退出或电脑关机期间无法准时通知；重新启动、休眠恢复时检查逾期事项，一次性通知不重复弹出，未处理强提醒恢复显示。一个截止时间计时器配合至多每分钟检查系统时钟/时区变化，无高频轮询。本阶段不做云同步或服务端推送。

For English users: set **Settings → General → Language** to English. Selection polish and translation have separate configurable shortcuts and apply directly; choose **Replace selection** or **Append to end** in Text input settings. **Quick reminder** uses your existing ASR and text model, accepts Chinese or English, and shows a review when the date/time is ambiguous. After choosing this mode, you can say "Clean up in twenty minutes" without repeating "remind me". Items classified only as to-dos are reviewed before saving. Activation phrases start at the first audible input, so a silent wait after pressing the recording key does not exhaust the keyword window. Captions queue new characters with a bounded buffer, preserving existing text and word spacing as new characters enter; transcription is still chunked, with a 100-millisecond check interval and provider-dependent latency. Quiet/DC-biased input and Qwen's known server-instruction echo are excluded. Saved reminders work offline while the app runs in the tray. Persistent reminders remain actionable after restart; closing their window does not mark them complete. Notes extraction always requires explicit review. Daily and weekly recurrence are supported; the app cannot notify while fully exited or the computer is off. All new pages, settings, notifications, confirmation/error messages and persistent-reminder controls follow the UI language.

Reminder refinement uses the entire built-in [prompt document](src/main/prompts/reminder-refinement.md), then the existing structured extraction and local time validator. Voice and note entry points share this fixed pipeline; there is no prompt setting. It normally makes two calls to your existing text provider, or one for withdrawn/empty requests. Relative voice times are anchored to recording submission. Optional reminder details preserve conditions and quantities, remain editable/searchable, and appear in notifications. Unsupported recurrence requires review rather than silently changing the schedule.

模型页先选择「分步处理」或「音频直达」，再通过「语音识别 / 文本处理 / 音频模型」管理连接；文本连接始终可访问，用于 Ask 和选区等纯文字任务。本地识别独立显示，配置数据、启用开关、顺序、编辑和测试沿用原有机制，不丢弃原配置。

供应商覆盖范围、协议修正和尚未完成真实账号验证的项目见 [API 核对记录](PROVIDER_API_AUDIT.md)。

随记工具栏的「新建」或随记页内的 `Ctrl+N` 会创建文字随记并聚焦正文；新建菜单可从系统剪贴板的纯文字创建，只有点击该项时才读取剪贴板。当前分类会沿用，搜索和标签筛选会清空以显示新记录；空白随记显示「未命名随记」。正文自动保存，保存失败时保留待重试改动，并阻止继续新建。剪贴板内容最多 200000 个字符，超限会明确报错，不会截断。文字随记不生成录音，不自动调用模型；可手动润色，支持已有的分类、标签、同步和导出。`Ctrl+N` 仅在随记页生效，弹出对话框时不会新建。

新建菜单的「导入录音」支持单个 WAV、MP3、M4A、OGG，最大 128 MB、10 分钟，超过上限会报错而不会截断。导入时创建可播放的 OGG / WAV 副本并自动转写、按当前设置润色，源文件不修改；副本沿用随记的同步和导出机制。原生 16 kHz 单声道 PCM16 WAV 无需额外工具，其他格式需安装 FFmpeg 并加入 PATH，或通过 `TYPELESS_FFMPEG` 指向其可执行文件；安装包不捆绑 FFmpeg。导入解码期间及「重新识别」处理期间可取消，界面显示当前处理阶段。自动识别失败仍保留录音，可在详情点击「重新识别」，确认后使用当前语音与润色配置重试；两段文字只在全部成功后替换，失败、取消、删除记录或处理期间出现新文字编辑时，不覆盖原文。

按住录音键（默认右 Alt）说话时，识别条上方的小气泡默认显示字幕预览，气泡仅比识别条宽 28 像素，首次随首字从识别条弹出。新增文字排队从右侧逐字进入，旧字随显示进度从左侧退出；最多排队 120 个字、显示 48 个字，短小识别修正保留已有字符节点，大段改写重新排队，不一批同时替换。识别条保留波形、计时和模式；松开、取消后字幕清空，窗口恢复原大小，保存的位置保持以识别条为准。靠近屏幕顶部时气泡显示在下方，并适配系统的减少动画偏好。可在「设置 → 语音与翻译 → 录音实时字幕」关闭。优先使用已可用的本地识别模型，否则使用首个语音转写配置；多模态处理模式仍需语音转写配置或可用的本地模型才能预览。当前采用分段识别最近 6 秒音频，检查间隔 0.1 秒且单次仅一个请求，首段仍需积累至少一秒音频，字幕仍受接口识别延迟影响，可能修正已显示文字；云端预览会增加接口调用。静音判断按短帧去直流后的能量识别持续声音，过滤无声底噪和短促开麦爆音；不是完整语音分类器，持续环境声仍可能触发识别。Qwen ASR 返回已知转写指令回显时会剔除，避免把服务器英文指令显示为字幕或交给提醒模型。预览失败会停止该次预览，最终文本仍由结束后的完整识别生成。预览音频和显示字符均有固定上限，关闭后不发送预览请求（启用关键词切换时仍保留开头识别）。

概览底部的热门场景保持单行标签，过长名称省略显示，标签和「分布」按钮不相互遮挡；悬停可查看完整名称，完整场景和占比见分布图。

概览「最近识别」只显示本条记录的模式和实际使用的卡片名称，统一为紧凑边框标签，不显示模型或提供商；长卡片名省略并可悬停查看，旧记录没有卡片信息时不虚构标签。复制按钮优先复制结果，旧版失败记录如果保留原始转写也可复制，并支持键盘操作。

新历史只保存成功且有正文的结果。识别失败、模型失败、插入失败、手动取消、空录音和空结果只保留提示与诊断日志，不写历史或历史录音，也不累计成功使用量；插入失败时生成的文本仍复制到剪贴板。录音文件只在 `keepAudio=always` 时随成功结果保存，旧 `failed` 配置自动归一为 `never`。随记的录音与导入失败恢复功能独立于历史，不受此规则影响。

历史搜索支持文字、应用和当时使用的卡片名称，按普通子串匹配。旧版异常记录不会因升级直接删除，可在历史页点击「清理旧异常」并确认后清除失败、取消、空记录及其录音，成功记录及其归档保留；删除标记会随现有同步上传，其他设备可收到删除。异常旧记录不再上传，云端拉取的异常记录也不会重新入库。「粘贴上一条」跳过旧异常记录，使用最新正常结果。

语音悬浮条在录音和处理阶段显示本次选择的提示词卡片名称，过长名称省略并保留完整名称提示。标签、请求正文和温度复用同一份卡片快照，沿用现有自动路由及手动固定卡片的优先级；窗口取录音开始时的已有快照，录音中切换活动窗口不会改选卡片。录音期间改动设置时，在停止后处理阶段采用最新设置并同步标签，处理过程中再修改卡片不会改变已经选定的请求。纯 ASR 转写及不使用卡片库的问答代理不显示卡片标签；多模态听写仍会显示其请求实际使用的卡片。完成、取消或失败后清除标签。

随记工具栏「更多 → 导出」可将当前筛选结果导出为 Markdown 或 UTF-8 纯文本；勾选记录后只导出选中项，按当前排序排列。详情中的「导出此条」只导出当前记录。文档包含创建时间（本机时区）、分类、标签、正文或原始转写、润色文本；有录音时包含录音时长。导出前会等待文字保存，保存失败时停止导出。播放器右侧「保存录音」按原始 OGG / WAV 格式另存，不转码。这些是可阅读的文档与原始录音导出，不是可还原分类和同步状态的完整数据库备份。

设置导航收拢为六组：通用、语音与输入、AI 与模型、数据与性能、账户、帮助与关于。组内标签复用原设置；语音唤醒归入语音设置，音频上传压缩、应用排除等次要选项按需展开，不改变既有保存值。版本页不再重复模型和搜索状态；诊断与听写日志在「帮助与关于 → 诊断」，日志按真实日期时间显示，录音开始/结束后自动更新，无需后台轮询。每项修改自动保存，数字输入在失焦或按 Enter 后保存。

「语音与翻译 → 录音处理」默认保真优先：优先请求设备 48 kHz 单声道输入，关闭浏览器的回声、降噪和自动增益处理；设备不支持时使用其可提供的格式，不将低带宽输入冒充高音质。为兼容现有本地和云端识别接口，PCM 仍由浏览器重采样为 16 kHz 单声道 16-bit WAV，不新增自制降噪或重采样算法。环境噪声较重时可选择「通话降噪」，使用 Chromium 已有的回声消除、降噪和自动增益；声卡或麦克风已有处理时可选保真，避免重复处理。录音中更改设备或处理方式，会在本次收音结束后应用，保留当前任务的完整音频。

立体声设备输入会先混合为单声道，避免只读取左声道而遗漏右声道的人声。停止录音会立即请求最后一段 PCM，并与压缩编码收尾并行等待；排队中的收音块也会保留。取消时丢弃尾音及编码副本，新任务等待旧任务收尾，避免串入上一条声音。随记同样等待尾音完成后关闭设备。空闲麦克风保持预热，PCM 工作节点不再持续向页面发送空闲音频块。可选的浏览器 Opus 上传与 FFmpeg Opus 存储均请求 64 kbps，实际码率随编码器和内容变化；WAV 仍是默认识别上传格式，既有压缩选择保留。

「说话测试」复用实际录音链路，最多录制 10 秒，停止后可试听同一份识别 PCM，显示输入采样率及音量过高提示。测试不调用识别服务、不写历史或随记，音频仅在页面内存中；重新测试、切换设备/处理方式或关闭页面会释放旧试听。它用于区分设备输入、处理模式和录音链路问题，不代表已验证真实麦克风的识别准确率。

处理方式参考 [TeamSpeak 音频处理说明](https://business.teamspeak.com/features/client-audio-example/)、[KOOK 降噪比较建议](https://help.kookapp.cn/6a2f/cd01) 和 [Oopz 声卡兼容说明](https://help.oopz.cn/42f9/f5ae)；保真默认及无损识别输入参考 [Google Cloud ASR 最佳实践](https://docs.cloud.google.com/speech-to-text/docs/best-practices?hl=en)。通话的主观听感与识别准确率需要分别验证。

设置里还有几项直接影响结果：

- **麦克风**：列出全部输入设备（悬浮条持有麦克风权限，因此能拿到真实设备名）；空闲时立即切换，录音中更改在本次收音结束后生效。
- **语言**：作为 `language` 传给 ASR；留空自动检测。
- **词典**（hub 的「词典」页）：润色后按字面替换，修正常被识别错的专有名词，长词优先。
- **插入方式**：默认「自动」= 剪贴板整段粘贴（一次到位，且不会被聊天框当成回车），失败才回退 SendInput 逐字符。
- **换行处理**：多行结果默认换成空格；可选 Shift+Enter（不触发发送）或保留回车。
- **模型页**：一页里先选「模式」（传统/多模态），再填对应的接口；传统模式下面是 ASR 与文本模型两组，多模态模式下面是 Gemini 一组，切模式不用换页面。
- **网页搜索**：Ask Anything 先判断要不要检索（也能强制检索），需要就按问题类型排一份检索计划——新闻/实时类走 Brave News 或带 `freshness` 的普通检索，技术问题补英文关键词做中英双语检索；拿到结果先过来源排序（一手优先、聚合站只当线索、同稿转载折叠、按日期剔旧文、字段冲突标出来），再挑 2–3 篇精读原文后才作答，答案带 `[1]` 引用与「## 来源」列表，检索失败会直说覆盖受限而不是编。
- **检索范围**：「单次搜索条数」只控制普通查询每次取回的网页数。新闻汇总自动拆成最多 6 个主题/语言查询，每次请求最多 10 个结果，合并去重后保留整个结果集合，不再按单次条数或 6 条来源截断；“今天的 AI 新闻”覆盖模型发布、产品应用、开源研究和产业政策。候选网页数不等于独立新闻数，不承诺覆盖全网所有信息。已知不是本地当天的新闻不进入今日汇总；日期不明的线索由回答单列待核实。普通问题仍最多两条查询及一次空结果重试，最多精读 3 篇原文；兼容模型的回答流程也会拿到已读摘录。
- **响应预算**：最多两条检索并发、3 篇精读并发；明确要求联网及新闻汇总跳过模型是否检索的判定。普通回答预算 1024 tokens / 25 秒，新闻汇总 4096 tokens / 45 秒，不再强制只写几个要点。汇总检索每个查询 4 秒、整体 15 秒；普通搜索 8 秒、精读 6 秒。单个主题失败时保留其他成功结果。回答以 SSE 流式显示，80ms 节流；最终结果不会被排队中的旧文本覆盖。未完成的追问不能重复提交，失败后恢复追问。
- **ASR 上传与连接**：复用 keep-alive 连接，`concatPcm` 一次分配；按去直流的短帧能量裁剪首尾静音并保留 120/240 毫秒前后保护，不裁剪内部停顿。裁剪后不会再误用包含整段静音的原始压缩录音。请求仅在配置时发送 `language`，不发送兼容性不一的 `temperature`；超时默认 25 秒（`TYPELESS_ASR_TIMEOUT_MS` 可覆盖），字幕预览为 5 秒。空闲保活默认只针对本地网络服务，每 4 分钟发送 300 毫秒探针（`TYPELESS_ASR_WARMUP=off|all|local`），连续 3 次空闲后停止；探针返回文本直接丢弃，不进入字幕或录音任务。实际识别速度取决于模型与服务端硬件，可通过 `[perf] asr bytes=… ms=… rtf=… trim=… conn=reuse|new` 核对。
- **天气直连**：问句里出现天气/气温/下雨等意图时，绕过搜索引擎直接查 Open-Meteo（免 Key）的实况与逐日预报，把数字交给模型，因此能答出「实况 10.3°C，白天 10.2～22.5°C，降水概率 4%」这种具体值；地名会按省份消歧（`河南安阳` 不会飘到广西安阳）。
- **悬浮条位置**：拖动后自动记住；托盘菜单可重置，显示器变化时自动回落到可用区域。
- **回答卡**：独立悬浮卡宽 560，位于悬浮条正上方 10px，不抢焦点，`Esc` 或 ✕ 关闭。问题、回答、来源和操作分区；长回答在正文区滚动，复制和追问保持可见。支持 Markdown 对比表格；正文 `[n]` 只有对应真实来源时才可点击，来源区按原始编号展开全部网页，显示域名、日期和摘要。联网状态来自实际工具结果，展示查询方向、精读数量及部分失败，不把未联网的模型回答伪装成联网结果。完整内容和来源仍写入历史，卡片正文不重复附来源列表。界面思路参考 [Typeless 快捷问答](https://www.typeless.com/ask-anything)、[Perplexity 来源与追问](https://www.perplexity.ai/help-center/en/articles/10352903-what-is-pro-search) 和 [Raycast 搜索工具](https://manual.raycast.com/ai/custom-providers)。
- **模型列表与思考档位**：文本模型一栏点「获取模型列表」会拉 `GET /models`（`Authorization: Bearer`），下拉支持直接输入；「思考档位」按模型的 `reasoning_supported_efforts` 与 `can_disable_thinking` 生成。官方 OpenAI、Gemini、Cohere、Mistral、MiniMax 与 Claude 的参数差异由同一请求适配函数处理，润色、Ask 工具和流式回答共用；不能关闭推理的模型使用其支持的最低档位。自定义网关保留原来的 `thinking` / `reasoning_effort` 约定。输出额度至少 1024，OpenAI 推理模型使用 `max_completion_tokens` 并移除不支持的温度参数；Claude 新模型同样省略不支持的温度。列表缓存 10 分钟，拉取失败沿用上次结果且不清空已选模型，请求 UA 为 `typeless-rebuild/<version>`。
- **停止 Ask 回答**：检索、思考和流式生成期间可点回答卡底部「停止生成」，中断请求并保留已显示的部分文字，允许复制；停止状态不写正常历史，也不把半截回答加入对话记忆。可以重新提问，迟到结果不会覆盖新任务；听写与翻译不受该按钮影响。
- **Ask 是工具 Agent**：Ask 不再只是「检索 + 一次回答」，模型可以调 8 个工具——`get_weather`（Open-Meteo 实况+预报）、`web_search`、`read_webpage`（正文抽取、拒内网、内容视为不可信）、`get_datetime`（系统时间，不让模型猜日期）、`calculate`（手写递归下降求值，无 `eval`）、`get_selection` / `replace_selection`（读选中、替换选中；**替换必须点卡片按钮确认**）、`open_search`。优先走原生 Function Calling（最多两轮），模型不支持时降级为严格 JSON 意图；卡片上会显示工具进度与来源。
- **取消**：录音中按 `Esc` 直接丢弃这一条——不插入、不写历史，悬浮条显示「已取消」后收拢。
- **五类提示词**：设置里的「提示词」页把五类提示词（AI / 润色 / 翻译 / 文档 / 邮件）平铺成五个卡片区块——不分 tab，内置提示词也是卡片，一眼看到全部。每张卡有自己的名字、内容、**可选独立温度**；卡上可「激活 / 复制 / 编辑 / 删除」，**内置卡也能直接改**（改过会标「已改写」，编辑器里有「恢复默认文本」），改完立刻生效；内置卡也能删掉，删光后区块显示空态并提供「恢复内置提示词」，不会白屏。虚线卡用于新建。
- **自动激活提示词**：提示词页顶部有「自动激活」开关，默认打开。打开时按前台应用挑卡——微信 / 聊天类走「润色」（也就是日常说话的那张卡），Codex / Claude Code / OpenCode / Cursor / 终端这类 AI 开发工具走「AI」，Word / Notion 这类编辑器走「文档」，邮件客户端走「邮件」，其余回落「润色」；翻译模式固定用「翻译」卡。**关掉后由你自己钉住主模式 + 主卡片**（两个下拉，主卡片留空 = 跟随该类型的当前卡片），所有窗口统一用它。卡片的温度会真正进到请求体，没设卡片温度时才回落到全局温度。
- **窗口归类**：设置里的「窗口归类」页解决「某个应用被认错」的问题。上面写清判定顺序（手动规则 → 内置分类表 → 兜底润色），下面是一张手动规则表——填一段匹配关键词（进程名或窗口标题的子串，大小写不敏感）再选归为哪一类（AI / 润色 / 翻译 / 文档 / 邮件）；「拾取当前窗口」会列出此刻所有可见窗口、各自当前会被归成哪一类、以及是被规则还是内置表命中，没被认出来的窗口标红，点一下就能生成一条规则。下面还有实时预览输入框，改规则前可以先验证。
- **多模态也吃提示词**：多模态（Gemini 那一路）以前只是把音频转成文字，现在系统提示词里带的是同一套卡片内容（加一句「先在心里听写、只输出最终结果」），因此 AI / 文档 / 邮件 / 翻译的规则在一次直出里同样生效。
- **复制**：历史记录每条 hover 出复制按钮（走主进程剪贴板，`file://` 渲染进程没有剪贴板权限）；回答卡只保留底部一个「复制回答」，不再重复三处。
- **设置入口**：侧栏底部固定「设置」齿轮（也可 `Ctrl+,`），同一个地方还有亮/暗切换与版本号。
- **界面**：hub 首页是概览（今日字数/时长/平均段落/累计记录、近 7 天或 30 天的柱状图、最近识别、
  年度活动热力图）；热力图是**最近 52 周**（最后一列永远是本周，当前月份标签用强调色标出来——之前按自然年画，十月会看到九月当最后一格）；侧栏底部的太阳/月亮按钮切换亮/暗主题；窗口无独立标题栏，顶部与应用内容一体。
- **悬浮条与模式标签**：条上可以显示当前模式（听写 / 翻译 / 问答），在「通用」页用「在悬浮条上显示当前模式」开关控制，关掉就只剩波形与计时；标签不受录音状态影响，`idle` 小药丸与错误态不显示。
- **按服务商分开的搜索配置**：Tavily / Brave / SearXNG / DuckDuckGo 各自的 Key、地址、结果条数分开存，切服务商不会串用上一家的凭据；标「可选」的 Key 输入框同样可以输入（SearXNG 开了鉴权的实例就用它）。

## 架构

```
右 Alt（按一下 / 按住）
   ↓  WH_KEYBOARD_LL 全局钩子（utilityProcess + koffi，吞键，不影响原本的 Alt 行为）
hotkey child ──IPC──▶ main/pipeline
   ↓
bar 窗口（AudioWorklet，常开暖流，16 kHz 单声道 PCM16）
   ↓ 分块回传
pipeline：静音判断 → 拼接 WAV
   ├─ classic：ASR(/v1/audio/transcriptions) → LLM(/v1/chat/completions)
   │            └─ ask 模式走工具 Agent：get_weather / web_search / read_webpage /
   │               get_datetime / calculate / get_selection → 带来源回答 → 弹卡
   └─ multimodal：Gemini generateContent(WAV + 提示词) 一条龙
   ↓
插入：剪贴板整段粘贴 → 失败回退 SendInput Unicode → 再失败走 UIA
   ↓
history.sqlite（SQLite 检索，含来源与链路标记）
```

关键模块：

- `src/main/hotkey/child.ts` — 全局键盘钩子。`PeekMessageW` + `setInterval(..., 4)` 泵消息（阻塞式 `GetMessageW` 会让 V8 无法执行 koffi 回调）；chord 状态机识别「同时按下」与「按住」，`activation` 控制 toggle/hold 语义；`CallNextHookEx` 需要 `koffi.address(lParam)`。
- `src/main/hotkey/host.ts` — 用 `utilityProcess` 跑钩子，崩溃自动重启（最多 5 次），避免钩子拖慢主进程。
- `src/main/pipeline.ts` — 一次听写的完整生命周期，`MIN_DURATION_MS=350` 防误触，`STOP_GRACE_MS=500` 等最后一块音频；`complete()` 按 `pipelineMode` 分流，统一走术语替换后插入。
- `src/main/keyevents.ts` — 纯函数生成 `INPUT` 事件序列，决定换行是空格 / Shift+Enter / 回车，并提供 `submitsOnEnter()` 自检。
- `src/main/agent.ts` — Ask 的调度核心：原生 tool_calls 最多两轮，失败降级为严格 JSON 意图，最后包一层「工具结果 → 回答」；`applyReplaceText()` 只在用户点了「替换选中」后调用。
- `src/main/tools/` — 8 个工具的纯实现（`registry.ts` 出 schema 并按名分发，`runTool` 永不抛异常而是回结构化错误）。
- `src/main/answer.ts` — 旧检索外壳的兼容层：`isWeatherQuery` 直连 Open-Meteo，其余检索路径、来源追加都在这里，`agent.ts` 复用它。
- `src/main/providers/models.ts` — `GET /models` 拉取 + snake→camel 归一化 + 10 分钟磁盘缓存 + 失败回退缓存（从不抛异常）。
- `src/shared/effort.ts` — 思考档位的纯规则：`can_disable_thinking` 才给 `off`，其余只开放 `reasoning_supported_efforts`。
- `src/main/cardLayout.ts` — 回答卡定位的纯函数：以悬浮条矩形为锚，正上方 10px 居中，放不下才翻到下方，越界夹到工作区。
- `src/main/answer.ts` 的检索调度：天气意图先走 Open-Meteo，其余用模型判定 → 搜索 → 结果拼进提示词 → 补「## 来源」；搜索失败自动退回纯问答。
- `src/main/providers/weather.ts` — Open-Meteo 地理编码 + 预报（`placeCandidates` 剥口语、按省份消歧、`formatWeather` 生成必须被引用的数字块）。
- `src/main/providers/search.ts` — DuckDuckGo（HTML 抓取）/ Tavily / Brave / SearXNG 四种检索适配器。
- `src/main/providers/gemini.ts` — `generateContent` 多模态调用（`inline_data` 传 WAV，API Key 走请求头）。
- `src/renderer/src/bar/capture.ts` — 麦克风常开（`setActive` 只控制是否上报），避免冷启动 200–800 ms 丢音。
- `src/main/insert.ts` — 剪贴板整段粘贴优先；SendInput 用 40 字节手写 `INPUT` 布局，注入前用 `AttachThreadInput` 强制前台。
- `src/main/providers/*` — OpenAI 兼容适配器，含 `<SAY>`/引号包裹等模型输出清洗。

数据目录：`%APPDATA%\typeless-rebuild\`（`settings.json`、`history.sqlite`、`notes.json` 和 `notes/audio/`；随记可迁移到自定义目录）。

## 设置规范

修改自动保存；数字输入在失焦或按 Enter 后保存，空值恢复原值，超出范围时收敛到边界。保存失败会保留待保存改动并显示重试入口；关闭设置弹窗会提交待保存改动。更改与当前设置分组内的其他字段合并，不会清空同组连接信息。

| 位置 | 设置与生效条件 |
| --- | --- |
| 通用 | 界面语言、主题、启动与提示反馈；提示停留时长 1–60 秒。 |
| 语音与翻译 → 识别与翻译 | 识别语言仅作为 ASR 提示；翻译目标为 1–3 个不同语言。 |
| 语音与翻译 → 音频 | Opus 为显式选择，关闭时上传 WAV，压缩格式被拒时回退 WAV。内置本地识别与厂商专用协议由各自适配器处理。 |
| 数据与存储 → 历史 | 保留期与记录上限集中管理；上限为 1–100000 条，修改后立即执行；「不保存」需确认，且会清空现有历史和对应录音。 |
| 文本输入 | 插入方式、换行、剪贴板恢复、格式保留集中管理；选择 SendInput 时剪贴板恢复和格式保留不可用。 |
| 快捷键 | 管理全局开关、触发方式和各模式按键。 |
| 资源管理 | 查看所有应用进程的驻留与已提交内存、复制占用信息、释放空闲资源；本地模型默认空闲 5 分钟卸载，可选保持加载，下一次本地听写自动恢复。 |
| 模型 | 先选语音流程，再按识别、文本和音频用途管理连接；本地识别独立显示，音频上限为 5–600 秒。 |
| 提示词 / 窗口归类 | 管理任务卡片及按应用自动路由；润色温度范围为 0–1。 |
| 搜索 | 各服务独立保存地址、密钥与单次结果数；普通查询 1–10，新闻汇总自动按主题扩展并合并。 |
| 账户 | 同步历史、随记及随记录音；同步频率提供常用分钟选项及仅手动同步，保留已有自定义秒数。关闭同步开关后手动同步也不可用。服务器地址仅在登录界面设置。 |

历史、随记新增、编辑、删除、删除冲突以及同步期间的本机修改，都有客户端对真实本地服务端的回归测试。服务端恢复备份导致游标回退时，客户端接受新的游标继续分页。随记分类列表的名称保存在本机，服务端同步的是记录上的分类 ID。录音上传失败会计入待上传数量并显示错误；下载游标在录音落盘后才提交，中断或重启后可继续重试。

资源管理统计包含主进程、界面、快捷键及媒体等全部应用进程。Windows x64 支持时显示私有驻留物理内存；不支持时明确标为包含共享页的工作集。已提交内存单独显示，不能用来代替驻留占用。关闭主窗口会销毁其界面进程；开机启动使用 `--background` 参数，只驻留托盘和听写悬浮条。手动启动仍打开主窗口。

React、MUI、Emotion 和界面国际化库由 Vite 编译进前端资源，仅作为开发依赖保存。安装包运行时仅携带主进程所需依赖，避免重复分发界面源码及其大量文件索引。

后台约 200 MB 是未加载本地模型时的优化目标，不能保证录音、识别或打开主窗口时也保持该占用。本地模型权重需额外内存；空闲卸载后，下次本地听写会因重新加载而稍慢。手动释放模型会取消自动恢复；「释放空闲资源」保留自动恢复能力。录音或识别中不可回收，麦克风预热保持开启以避免漏掉开头。Windows 使用软件图形合成减少悬浮条的图形缓存，所有渲染窗口启用沙箱。

## 开源范围与许可

本项目以 MIT 许可证发布，是独立实现，不隶属于 Typeless，也不包含其客户端源码、录音、原始历史、截图或逆向取证产物。应用图标来自 `logo/YU_语_品牌图标资源包`，`pnpm icon` 从原始资源复制适用图标。第三方依赖保留各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 `licenses/`。

首次安装不会预设任何个人服务器地址。从「设置 → 账户」打开登录页，主动展开高级选项、填写自己的 HTTP / HTTPS 地址后登录；已有安装保留其保存的地址。客户端会读取服务端能力：关闭公开注册时隐藏注册入口，未配置邮件时隐藏密码找回入口。不需要验证码的私有实例可直接注册。

应用启动时会恢复用户数据目录中保存的登录态；同一系统用户重启、覆盖安装或普通卸载后重装，无需因安装操作重新登录。Windows 令牌使用系统加密，访问令牌过期时沿用现有刷新流程；主动退出、服务端撤销或刷新令牌到期后仍需登录。手动清除用户数据、换系统用户或换电脑不属于登录态保留范围。

提示词由本项目自行编写，听写、翻译、问答与按应用路由由 `src/shared/prompts.ts` 和 `src/shared/promptLibrary.ts` 管理。随记在服务器上是明文存储，管理员能够读取；当前不提供端到端加密。

源码仓库只跟踪可编辑工程、测试、构建配置和许可。`.env`、密钥、API 凭据、用户数据、日志、安装包和本机取证目录都不进入源码发布。`private: true` 用于防止意外发布到 npm，不影响代码开源。

本地验证后执行 `pnpm package` 生成 Windows x64 NSIS 安装器。开发过程使用本地 Git 管理，源码压缩包按需生成，推送 GitHub 须明确授权。提交后运行 `pnpm release:archives` 只生成服务端 tar.gz、发布清单及 SHA-256 校验文件；需要源码 ZIP 时显式追加 `--source`；归档来自已提交的 Git 内容。安装器未配置代码签名时为未签名版本。

服务端部署见 [server/README.md](server/README.md)。Docker 只提供账号与同步；ASR、语言模型和可选本地模型由客户端独立配置。语音模型权重不包含在安装器和源码包中，下载后遵循各模型自己的许可。

## 自测

```powershell
pnpm test                     # 单元测试及自动启动本地真实服务端的历史/随记联调测试
pnpm typecheck

# 端到端（跳过静音门槛，全程指向假后端：听写 / Ask+检索 / 多模态 三条链路）
pnpm mock
$env:TYPELESS_SELFTEST='1'; $env:TYPELESS_IGNORE_SILENCE='1'
node_modules\electron\dist\electron.exe .

# 只截 UI，不需要人操作
$env:TYPELESS_CAPTURE='1'     # → screenshots\hub-*.png、prefs-*.png、bar-*.png
```

`scripts/mock-openai.mjs` 还带 A–I 九个检索场景：`curl http://127.0.0.1:8787/__scenario?id=C` 切场景后，下一次 Ask 就会走「官方文档优先 / 旧文剔除 / 转载折叠 / 数值冲突」这些分支，`src/main/ask-acceptance.test.ts` 用同一套场景做离线断言。

辅助脚本：`scripts/mock-openai.mjs` 提供假 ASR / LLM / Gemini / SearXNG；`scripts/make-icon.mjs` 可重新生成图标。

## 变更记录

- **v0.8.3**：翻译回到「只用翻译分类自己的卡片」——主模式 / 主卡片只作用于听写这类场景，不干预翻译（它是独立业务）；年度活动热力图加了悬停反馈（已上色格子在自己那个蓝上再深几度，空格子加灰，月份标题不跟着变色）；首页「最近识别」的「全部记录 →」改为跳到侧栏「历史记录」而不是弹设置，模式标签「问任何问题」简称 Ask；「窗口归类」页顶部的三步路由说明收进标题行右侧的 ⓘ（悬停给一句话、点击展开精简版）。
- **v0.8.2**：提示词页收口——删掉「使用内置提示词」「手写提示词（听写/翻译）」「术语表」三块，只留润色开关、温度和「Ask 附加要求」；术语表统一由侧栏「词典」管理。关掉自动激活后，主模式 + 主卡片现在**对所有模式生效**（此前翻译仍固定用翻译卡，看起来像没生效）。`polish.askPrompt` 从「整体替换」改为「追加在内置问答提示词后面」。
- **v0.8.1**：首页「最近识别」的复制改走主进程剪贴板（`file://` 下 `navigator.clipboard` 无权限，点了没反应），空内容条目不再误显示「已复制」；年度活动热力图去掉误标在未来日期上的蓝色描边，「今天」只说真话；月份轴修掉「两个 10 月 + 11 月被挤掉」——同名月份保留最近一次、间距阈值降到 2 列、末位标签左移避免裁切。
- **v0.8.0**：Ask 提速（并发检索/并发精读/单轮工具/SSE 流式）、本地 ASR 提速与保活、悬浮条模式标签、窗口归类、按应用自动切提示词。

## 已知坑

- **FFmpeg 编码支持**：启用 Opus 需要带 libopus 的 FFmpeg，或使用 Chromium 已捕获的压缩副本；编码器不可用时保留 WAV，不影响转写。
- **`ELECTRON_RUN_AS_NODE=1`**：本机若设了该环境变量，`electron.exe` 会退化成纯 Node，报 `Cannot read properties of undefined (reading 'getPath')`。启动前清掉。
- Electron 主进程走 **CJS**：ESM 下 `import { BrowserWindow } from 'electron'` 运行时报 `does not provide an export named 'BrowserWindow'`，所以 `package.json` 不设 `"type": "module"`。
- pnpm 11 不再读 `package.json` 的 `pnpm.onlyBuiltDependencies`，构建脚本白名单要写在 `pnpm-workspace.yaml` 的 `allowBuilds`。
- koffi 回调里解码指针：参数声明成 `const KBDLLHOOKSTRUCT *` 才会自动解成对象；声明 `intptr_t` 拿到的是 number，`koffi.decode` 会报 `expected external or TypedArray`。
- 粘贴回退会短暂占用剪贴板，设置里可开启「粘贴后恢复剪贴板内容」。
- 工具 Agent 依赖模型的函数调用能力：支持 `tools`/`tool_calls` 的直接走原生调用，不支持的（或网关回 400/404/422 等）自动降级成「只输出一个 JSON 意图」的模式，能力弱一些但不会整条失败。

## 与 Typeless 的差异（有意为之）

- 登录可选；登录成功会开启同步，可在「设置 → 账户」关闭。同步包含听写文字、随记和随记录音，听写录音仅保存在产生它的本机。服务端不提供支付，套餐和配额由管理员设置。
- ASR/LLM/Gemini 需通过保存的模型配置接入；默认没有可用模型连接。
- 检索先用模型判断再决定是否联网（Typeless 由服务端决定）；回答里的来源列表是本项目加的，方便核对。
- 提供首次使用引导；没有团队空间和支付订阅流程。
