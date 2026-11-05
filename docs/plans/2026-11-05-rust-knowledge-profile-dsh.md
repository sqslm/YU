# Rust 知识库、知识卡片与用户画像开发计划

**状态：阶段 1～5 已通过外部 Codex 复核；阶段 6（软件联动）已提交，等待外部复核（见文末「阶段 5 外部复核与修复」…「阶段 5 二次复核残余修复」与「阶段 5 外部验收与阶段 6 实施记录」）。阶段 7 未开始；备份与卸载尚未接入。**

**目标：** 从随记、与语的聊天、用户交给语总结的网页和文档中持续提炼可复用知识，形成可整理、可追溯、可关联、可在聊天中调用的知识卡片；同时通过 YU 内的使用与聊天维护可查看、可纠正的用户画像。

**语言约束：** 新增业务逻辑使用 Rust。现有 Electron/React 外壳继续负责页面、交互、权限入口及已有能力的桥接，不在 TypeScript 中新增一套知识、去重或画像业务实现。本计划不迁移既有聊天、随记、模型提供商或 Windows 读取模块。

**规划基线：** `af643b1`，当前分支 `master`。实施前重新检查 HEAD、AGENTS.md 和工作区。沿用当前分支，保留无关修改，不 push、merge、rebase、发布或重启用户实例。

## 1. 已确定的产品行为

- 主界面侧栏在“随记”下方新增“知识库”；页面包含主题导航、卡片列表、详情和独立图谱视图。“用户画像”由知识库右上角按钮打开独立侧面板，不再增加一级导航。
- 首次启用时说明自动提炼会调用所选模型。启用后新内容自动沉淀，也可手动对指定内容执行“提炼知识”。一次性历史整理由用户点击开始，支持暂停、继续和查看进度，不自动扫描全部历史。
- 语在相关问题中自动检索并引用知识卡片；用户可查看原来源。知识库、个人记忆和用户画像分别管理，知识图谱不与记忆图谱串联。
- 删除随记或聊天后保留已提炼知识，标记“来源已删除”，不在知识库另存原文快照。原记录删除确认框提供同时删除关联知识的选项，并显示涉及数量及多来源卡片的影响。
- 用户画像只使用 YU 内操作与聊天，不采集其他应用的使用时长、后台窗口或键盘输入。网页、文档的作者观点和人物经历不直接作为用户画像证据。
- 知识自动提炼、画像自动更新分别启用；未启用时不开展对应后台学习。两者共用一个可选择的提炼 LLM 配置，默认首个启用的 LLM、思考强度 high；日常使用统计聚合不调用模型，画像归纳尽量与已有聊天提炼批次合并。

## 2. Rust 架构与接口边界

### 2.1 最小架构

- 新建 `native/knowledge/`，生成 `yu-knowledge.exe`。一个按需启动的 Rust 辅助进程承担知识与画像业务，复用项目现有继承管道的接入方式，不开监听端口，不引入新的服务框架。
- Rust 负责来源归一化、分段、任务调度、提炼提示词与结果解析、去重合并、修订建议、搜索排序、关系管理、画像归纳和两类数据的持久化。
- 现有主进程仅转交已获准的数据、转发用户操作及模型请求，调用既有 LLM/文件读取/网页读取/待办能力；React 负责展示和交互。新增提炼策略、去重判断和画像更新规则不落在 TypeScript。
- 模型请求通过固定的 `model.request` / `model.result` 管道消息复用现有模型适配、网络与凭据管理。模型密钥不进入新数据库，Rust 输出不提供任意工具执行或任意脚本入口。
- 知识保存于安装目录 `data/knowledge/knowledge.db`，画像保存于 `data/profile/profile.db`；开发模式使用工程目录对应位置。两者不写 Mem0 数据库，Rust 是新库的业务读写拥有者。
- 选择 `rusqlite = 0.41.1`，仅启用所需的 `bundled`、`backup` 功能，固定 Cargo.lock；序列化沿用项目的 serde_json 版本。来源指纹使用 SHA-256，选用固定版本的成熟 Rust 实现并登记许可证。不为本功能新增 ORM、图数据库、向量服务或大型模型下载。
- 新辅助进程无任务且无页面使用 120 秒后退出；无启用的后台任务且无显式数据维护请求时不自动启动（“自动学习关闭”只停后台学习，不妨碍用户以后显式查看/维护已有数据）。执行任务时不轮询桌面；游戏模式暂停提炼，退出应用或父管道关闭时取消模型调用、关闭数据库并回收进程。崩溃显式显示状态，下次请求可重新启动，不无限重试或回退到 TS 业务实现。

### 2.2 接口与数据职责

- Electron IPC 分为 `knowledge:*` 与 `profile:*`，只对可信应用界面开放；Rust 管道按请求 ID 关联响应，包含明确的错误、取消、任务状态及变更通知。
- 知识接口包括来源提交/失效、卡片列表/详情/搜索/编辑/合并/删除/导出、关系管理、历史整理及任务暂停/继续/重试；画像接口包括读取、更新证据、人工更正/固定/删除、启停与清空。
- 共享类型覆盖 `KnowledgeCard`、`KnowledgeSource`、`KnowledgeRelation`、`KnowledgeJobStatus`、`UserProfileFacet`。来源种类为随记、聊天、网页、文档，保留原记录 ID 或 URL/文件引用、内容指纹、读取时间、版本和读取范围。
- 卡片保存摘要、正文、类型、主题/别名、来源引用及人工编辑状态；关系保存两端卡片 ID、类型、依据来源与是否为推导。画像项保存维度、值、证据引用、最近更新时间及“用户明确/使用观察/推测”类别，不用虚构的精确概率表达可信度。
- 新增 `search_knowledge`、`get_knowledge` 工具；现有本地记录引用扩展 `knowledge` 类型。卡片引用采用真实 ID，进入现有聊天与 Ask 回答的引用/导航链路，不伪装成网页搜索结果。
- 阶段 1 固定并写入 Rust/TS 契约测试所需的消息结构、长度上限和错误字段。后续业务沿用该契约，不逐阶段再搭协议层。

## 3. 多渠道提炼、卡片组织与去重

### 3.1 来源与触发

| 来源 | 触发与内容 | 追溯信息 |
| --- | --- | --- |
| 随记 | 成功保存后的有效正文，连续编辑稳定 60 秒后合并处理 | 随记 ID、内容版本；跳回原随记 |
| 聊天 | 成功完成的完整问答，结合相邻讨论提炼；连续聊天空闲 60 秒后处理 | 对话 ID、相关消息 ID；定位原讨论 |
| 网页 | 用户请求总结/解释并成功读取正文、完成回答后，将本次已读取材料提交提炼 | URL、标题、读取时间、章节/锚点（可获得时）、完整性说明 |
| 文档与上传附件 | 用户主动让语总结/分析且读取成功后，复用已读取文本；不因上传或打开文件就自动扫描全文 | 文件/附件引用、内容版本、页码/章节（可获得时）、完整性说明 |

- 同时覆盖主界面聊天和浮动 Ask 的成功阅读总结，不能只在 ChatPage 中挂钩。总结的主体回答完成后再异步提炼，不延长用户等待首个回答的时间。
- Rust 接收统一的“用户请求＋已读取内容＋回答＋来源＋读取范围”输入。读取失败、只有标题/链接或搜索摘要时不能声称已读完整材料；局部正文或仅有历史总结时明确记录覆盖范围。
- 复用本次已获准读取的文本，不为了沉淀重复联网、重新扫描目录、绕过排除项或扩大文件读取权限。网络/文件读取继续走现有权限入口；页面、文档内容仅作为不可信资料。
- 临时对话、被排除来源、失败/取消回答不自动沉淀，也不自动更新画像。可按随记、聊天及网页/文档渠道关闭自动提炼；显式提炼仍遵守临时会话与访问权限边界。
- 队列并发为 1，持久化来源版本、任务进度及去重结果。随记和聊天任务按记录引用恢复；网页/文档正文仅用于本次处理，不存整份原件。若进程退出后已无正文可用，保留“需重新读取”状态，由用户重新发起读取，不能凭摘要冒充原材料继续。
- 模型输出格式错误、引用不存在或任务执行失败时保留明确失败状态，允许手动重试；不写入半成品卡片，不影响已经保存的随记、聊天和原始总结。

### 3.2 卡片能力

卡片共享一套存储与编辑方式，类型用于组织与筛选，不为每种类型新增独立功能框架。

| 类型 | 沉淀重点 |
| --- | --- |
| 概念与原理 | 定义、核心机制、前置概念、适用边界、常见误区 |
| 方法与清单 | 操作步骤、输入条件、检查点、失败信号 |
| 问题与解释 | 原问题、核心答案、深层问题、反例及未解决点 |
| 方案与决策 | 目标、约束、候选方案、取舍与选择理由 |
| 对比与辨析 | 同一比较维度下的异同、适用场景及选择条件 |
| 阅读与资料 | 网页/文档要点、关键论据、来源、版本及阅读范围 |
| 经验与复盘 | 做法、实际结果、原因分析和下次可调整的动作 |

- 从“问了什么”进一步提炼“真正要解决什么、关键机制是什么、哪些条件会改变结论、如何验证”。只保留有实际内容的部分，不强行给每张卡填满全部栏目。
- 区分来源中的陈述、对话形成的结论、模型进一步推导和待验证内容。讨论结论不等于外部事实已经验证，引用出处也不等于认可该出处。
- 跨多次聊天和多份材料建立主题聚合页，汇集相关卡片、决策与开放问题。聚合页首先通过现有条目组织生成；用户请求综合总结时再生成综合内容，避免每次新增材料都重写整套知识。

### 3.3 入库前去重与更新

1. **来源去重：** 使用稳定来源标识和内容指纹识别重复阅读、重复总结、上传的相同文件与同一版本；URL 不擅自删除可能改变正文的查询参数。
2. **卡片去重：** Rust 先用标题、别名、主题和关键术语搜索已有卡片，向模型提供有限候选比较结论是否等价。相同结论优先补充来源或新增信息，而不是新建卡片；相同文字即使来自不同渠道也应汇合。
3. **合理拆分：** 一个独立问题或结论对应一张主卡，只有可以独立复用的知识才拆分，不按每段文字或所有卡片类型批量生成。
4. **保留差异：** 新前提、新适用范围、反例和矛盾结论不因标题相近而被误合并。没有人工修改的同一结论可自动补充；实质结论变化、冲突或人工编辑过的内容生成更新/合并建议，用户决定是否应用。
5. **防止循环：** 知识检索产生的回答保留被引用卡片 ID，纯复述不再生成新卡。删除卡片记录来源版本的排除信息，同一版本重跑不得复活；新版本出现时优先提示更新，不静默恢复用户已删除的内容。

### 3.4 搜索与图谱

- Rust SQLite 采用 FTS5 trigram 搜索并处理 1～2 字中文的字面匹配；标题/别名/主题的命中优先于正文。首版通过别名和模型选择关键词提供语义入口，不宣称已实现独立向量语义搜索。
- Rust 实际构建出的 SQLite 需验证 FTS5、短中文及特殊字符；之前 Electron 的内存探针不能代替 Rust 二进制验收。
- 关系以卡片为节点，支持包含、前置、应用、对比、推导。模型关系注明推导性质并能追溯依据，不把相似度视为因果关系；支持手动增删关系。
- 默认图谱最多 200 节点，筛选后再截断，显示真实总数；提供主题筛选、搜索、聚焦和邻居展开。只复用现有图谱渲染依赖，不复用记忆库的数据或业务状态。

## 4. 用户画像与软件联动

### 4.1 画像内容与更新

- 画像维度包括用户明确提供的背景与目标、表达偏好、希望的解释深度、反复关注的领域、当前项目与问题，以及 YU 内常用功能。仅凭一次提问不推断职业、能力等级、人格或健康等敏感属性。
- YU 内操作只累计必要的功能使用类别、卡片收藏/编辑/明确反馈等信号；统计立即更新，明确设置与人工更正保存即生效，聊天归纳随后台提炼批次完成后更新。不要将“实时”实现成持续轮询或每次点击单独调用模型。
- 单次浏览或提问仅作为近期关注的弱证据；反复出现的关注可以累积。近期关注默认使用最近 30 天证据，稳定偏好以用户明确表达或持续证据为依据。用户更正/固定的画像项不被自动归纳覆盖。
- 外部资料内容、模型自己的回答、代写角色、假设情境均不能直接写成用户事实。用户针对资料明确表达的偏好或观点，可按用户原话建立证据。
- 画像负责结构化总结与使用观察，个人记忆负责已有事实/偏好的保留；不自动把画像再写回 Mem0 形成双重学习。回答组装时对同一事实去重，冲突以当前用户要求及最新明确更正优先，不让推测压过原话。
- 画像面板展示“了解了什么、依据是什么、何时更新”，支持更正、固定、移除、暂停自动更新和清空。删除/清空会保留必要的排除记录，避免旧证据自动重建已移除项目；用户可显式重新启用相应学习。
- 画像从启用后的使用和聊天开始更新，历史知识整理不自动生成历史画像。知识提炼与画像更新分别开关、分别清空。

### 4.2 实际联动

| 软件入口 | 联动行为 |
| --- | --- |
| 聊天与 Ask | 相关时检索卡片，按画像调整说明深度、例子及表达形式，展示知识引用；当前明确要求始终优先 |
| 网页/文档总结 | 回答完成后提炼或更新卡片，显示简洁的完成状态和入口；手动提炼与自动提炼共用同一路径 |
| 随记 | 查看由该随记生成的卡片；卡片能回到原随记，用户可将整理结果另存为新随记 |
| 知识详情 | “继续讨论”携带所选卡片开始新对话；“生成待办”仅在用户主动操作后按现有流程创建，不在后台自动执行卡片步骤 |
| 方案讨论 | 关联既有决策、约束和待验证问题，补充本次新结论；不因为提到方案就覆盖旧决策 |
| 工作流 | 接入现有工作流系统的总结/提炼动作，执行相同 Rust 入库与去重流程，不再建立第二套工作流引擎 |

- 新知识默认自动入库但清楚标识推导/待验证内容，不增加逐卡强制审核流程；冲突、人工修改覆盖和语义合并例外使用明确建议。
- 不新增独立弹窗打断日常聊天，页面以简洁状态反馈任务与错误，细节按需展开。

## 5. DSH 分阶段任务与交付

按顺序派单，每阶段验收后再派下一阶段；阶段完成后停止，不自行扩展范围。这里的阶段为本次新功能，不重启已经收束的 Rust 性能重构阶段 1～22。

| 阶段 | DSH 开发任务 | 验收结果 |
| --- | --- | --- |
| 1：Rust 底座 | 新 crate、管道契约、两类数据库与迁移、按需进程、模型回调桥接；接入原生构建与打包资源 | 真实辅助进程能完成来源/卡片/画像基本读写，FTS5 可用；取消、父进程退出和事务失败可验证 |
| 2：多渠道输入 | 接入随记、聊天、Ask、成功网页/文档总结与主动分析附件；历史整理、排除项、任务进度 | 完整来源、版本和读取范围可追溯；不重复读取，历史与新增任务可暂停续跑 |
| 3：卡片提炼 | 深层问题提炼、七类卡片、来源/语义去重、修订和人工编辑保护 | 同知识多渠道不产生多张重复主卡；独立知识、矛盾结论和新版本正确区分 |
| 4：用户画像 | YU 使用信号聚合、聊天证据、近期关注、人工更正及画像上下文 | 画像可解释、可纠正、可关闭；资料作者和假设情境不被认成用户，推测不覆盖明确更正 |
| 5：页面与图谱 | 主界面侧栏、主题/列表/详情、编辑/收藏/合并/导出、独立图谱、画像面板 | 原文定位和卡片关系可操作；中英文、主题、窄窗口及键盘访问符合现有界面习惯 |
| 6：软件联动 | 聊天/Ask 搜索引用、继续讨论、关联随记、生成待办、工作流提炼入口 | 引用真实卡片，动作只在用户明确操作后执行；重复入口共享去重与来源链 |
| 7：数据保护与收尾 | 备份恢复、升级与卸载、相关回归、真实样例效果验证、现有文档更新 | 新数据不丢失，旧备份可用，已确认产品规则全部有验证；交付结果与限制如实记录 |

DSH 每阶段报告：实际改动、验证命令与退出码、失败/未测项、效果样例、主要产物及占用。主会话统一检查 Diff、进行必要复核并 Conventional Commit；阶段提交由 DSH 主会话完成，外部 Codex 复核并批准下一阶段。提交权限不扩展到内部子代理，也不包含 push/merge/rebase/reset 等远程或改写操作。

## 6. 验收、数据保护与明确边界

- Rust 单元/集成测试覆盖来源指纹、中文搜索、跨来源去重、差异保留、修订与手工编辑、任务中断、删除排除、关系一致性和画像证据优先级。Rust/TS 契约与真实辅助进程测试分别执行，mock 不代替实际管道、数据库和二进制测试。
- 用隔离合成库和少量明确允许的真实模型样例覆盖：同一内容从网页/文档/聊天进入、多个独立观点、一次片面提问、方案取舍、含矛盾材料、截断阅读、虚构角色、用户更正和已删来源。不读取或修改用户现有个人库开展测试。
- 真实模型效果检查“有无新增可复用知识、是否深入且有依据、是否重复或误合并、是否把资料当画像”，不只检查 JSON 能解析。按实际测得的耗时/调用量报告，不预先承诺节省或推理质量。
- 执行对应 crate 的 `cargo fmt -- --check`、`cargo test --locked`、`cargo clippy --locked --all-targets -- -D warnings`，以及相关 Vitest、`pnpm typecheck`、`pnpm test:native`、`pnpm test`、`pnpm build`；失败与未测项单列。新模块停用时检查未新增后台进程和循环调用，历史任务期间检查界面仍可用，空闲后资源可回收。
- 新备份清单升级为版本 2，使用 Rust SQLite 在线备份接口生成新库的一致快照，纳入现有备份/恢复流程；仍可读取版本 1，旧备份没有知识/画像时保留目标已有的新模块数据，避免误清空。恢复期间暂停写入，失败可按既有恢复机制回退。
- 升级保留安装目录下两类新数据；卸载将知识和画像加入现有数据保留/迁移/删除选择及静默保护，不只保护聊天目录。验证持久化、可写目录错误和旧数据格式，不静默换到 C 盘。
- 新库使用内部 schema 版本和事务迁移；不迁移旧聊天、随记与 Mem0 数据格式。历史整理只读原来源，通过新库保存产物；来源内容、密钥及模型提示正文不进入诊断日志。
- 阶段完成仅更新当前计划状态/结果及受影响的 README、许可证与架构说明。清理本轮临时数据和可重建中间产物，保留必要证据，不复制整个项目或 node_modules，不清理历史未知目录。
- 首版不做云端同步、后台网页爬取、全盘文档索引、操作系统使用画像、新增复习提醒体系或全应用 Rust UI 迁移。后续再考虑学习路径和阶段性知识复习，不影响本轮闭环交付。

## 技术决策依据

- 项目当前 Rust 重构保留 Electron 外壳和原生进程隔离；本次沿用这个接入边界，新增知识与画像业务由 Rust 拥有。
- [rusqlite 0.41.1 官方文档](https://docs.rs/rusqlite/0.41.1/rusqlite/)与[官方项目说明](https://github.com/rusqlite/rusqlite)：提供 Rust SQLite 访问、按需启用的在线备份及 bundled SQLite，项目使用 MIT 许可；实施时随锁定依赖核对并登记所有实际启用依赖的许可证。
- [SQLite FTS5 官方文档](https://www.sqlite.org/fts5.html)：trigram 支持子串检索，短于三个字符的查询需单独处理。Rust 自带 SQLite 的能力仍以阶段 1 实际构建验收为准。

## 阶段 1 实施记录（2026-11-05，DSH 执行会话 session-e4795148-53a3-4afd-b014-730be9b3c9f1）

基线 `4e077a3795025d61dc81878d24a1c8100f046c72`（`master`，工作区干净）；本阶段实现提交 `6b54999a8b267d9bfa3fc3387687422b7dd52182`（随后一次 `docs` 提交只补充这个编号，不改代码）。本节记录的是**已实现并实测**的内容；未实现的阶段保持“未开始”，不能把本节当作整体验收通过。

### 契约（v1，继承 stdin/stdout 的 UTF-8 JSON Lines，无端口）

| 消息 | 结构 |
| --- | --- |
| 请求 | `{v:1,type:"request",id,method,params}` |
| 成功结果 | `{v:1,type:"result",id,ok:true,result}` |
| 失败结果 | `{v:1,type:"result",id,ok:false,error:{code,message}}` |
| 取消 | `{v:1,type:"cancel",id}`（关联原请求，不产生结果） |
| 就绪通知 | `{v:1,type:"ready",schema:{knowledge,profile},fts5,trigram}` |
| 变更通知 | `{v:1,type:"changed",scope:"sources"\|"cards"\|"profile"}`（不作为结果结算） |
| Rust→宿主模型请求 | `{v:1,type:"model.request",id,parentId,profileId,effort,messages,maxTokens}` |
| 宿主→Rust 模型结果 | `{v:1,type:"model.result",id,ok:true,text}` 或 `{...ok:false,error}` |

模型子请求 `id`（`m<N>`）与父请求 `id` 分开；宿主只在该父请求仍于当前进程代际在途时才发起模型调用，重复子 ID 丢弃，父请求结束、超时、`cancel`、停机或进程退出都会 abort 对应模型并清理映射；旧进程的 `ready`/`result`/`model.request` 与重启后同子 ID 的迟到回包不结算任何在途请求（2026-11-05 复核后修复，见文末）。`TS`/`Rust` 共用 `src/shared/knowledge.ts` 的固定夹具 `KNOWLEDGE_FIXTURES` 验证结构。

方法表（`params` → `result`）：

| method | params | result |
| --- | --- | --- |
| `status` | `{}` | `{version,schema:{knowledge,profile},opened,fts5,trigram}`；不创建目录或数据库。宿主在停机时本地返回 `{running:false,schema:null,fts5:null,trigram:null}`，不启动进程 |
| `shutdown` | `{}` | `{stopping:true}` 后进程以 0 退出 |
| `source.save` | `{kind,originRef,locator?,title?,version?,scope?,readAt?,text}` | `KnowledgeSource`（`fingerprint` 由 Rust 计算，`text` 只在本次内存使用） |
| `source.get` | `{id}` | `KnowledgeSource` |
| `source.invalidate` | `{id,reason?}` | `KnowledgeSource`（`state:"invalid"`，关联卡片保留） |
| `card.save` | `{kind,title,summary?,body,topics?,aliases?,sourceIds?}` | `KnowledgeCard` |
| `card.update` | `{id,...同上任一字段,edited?}` | `KnowledgeCard`（未显式传 `edited` 时记为人工编辑） |
| `card.get` | `{id}` | `KnowledgeCard` |
| `card.delete` | `{id}` | `{removed:true}`（写排除信息，失败不留半张卡片） |
| `card.list` | `{offset?,limit?}` | `{items,total,offset,limit,hasMore,nextOffset}`，`items` 为 `CardSummary`（无正文，含 `bodyChars`） |
| `card.search` | `{query,offset?,limit?}` | 同上；空查询等价 `card.list` |
| `profile.save` | `{dimension,value,category,origin?,pinned?,corrected?,evidence?}` | `ProfileItem`（`origin:"auto"` 不覆盖固定/已更正项） |
| `profile.update` | `{id,dimension?,value?,category?,pinned?,corrected?,evidence?}` | `ProfileItem` |
| `profile.get` | `{id}` | `ProfileItem` |
| `profile.delete` | `{id}` | `{removed:true}`（写排除信息） |
| `profile.list` | `{offset?,limit?}` | `{items,total,offset,limit,hasMore,nextOffset}` |

错误码：`invalid_request`、`unsupported_version`、`unknown_method`、`invalid_params`、`too_large`、`not_found`、`protected_item`、`storage_error`、`storage_schema_newer`、`cancelled`、`timeout`、`model_unavailable`、`internal`。

固定上限：单帧 2 MiB（按实际 UTF-8 字节，含封装）、`id` 128 字符、标题 200、摘要 2000、正文 200000（超限报错，不静默截断）、搜索词 200、主题 32×100、分页默认 30/最大 100；出站列表页另受 `RESULT_BUDGET_BYTES`（1 MiB 序列化字节）约束，按整条装入并显式给出 `hasMore`/`nextOffset`，装不下的单条详情返回有界 `too_large`，不拖累其他请求；普通操作期限 15 秒、含模型回调的父操作期限 120 秒（总期限，从调用开始计，覆盖 spawn/`ready`/执行，不按消息刷新）；空闲退出 120 秒（`YU_KNOWLEDGE_IDLE_MS` 仅供测试注入更短期限）。

### 数据根、schema 与边界

- 数据根由主进程计算：打包模式 `dirname(app.getPath('exe'))`，开发模式 `app.getAppPath()`，经 `--root` 在初始化时绑定；renderer 与资料内容不能指定。库文件为 `<root>/data/knowledge/knowledge.db` 与 `<root>/data/profile/profile.db`。
- `knowledge.db`（`user_version = 1`）：`sources`、`cards`、`card_sources`、`cards_fts`（FTS5 `tokenize='trigram'`）、`exclusions`。`profile.db`（`user_version = 1`）：`profile_items`、`profile_evidence`、`exclusions`。建表与版本号在同一事务内完成；遇到比程序更新的 `user_version` 以 `storage_schema_newer` 拒绝，不降级、不重建。
- 两库与原 `chats.db`、随记存储、Mem0 `assistant/style.db`、用户模型缓存完全独立；画像证据保存原来源引用，不依赖卡片，清空知识不级联清空画像。
- 取消在提交点生效：`cards.rs` 3 处、`profile.rs` 3 处、`sources.rs` 2 处（`source.save`/`source.invalidate`，复核后补）在 `transaction.commit()` 前调用 `ensure_not_cancelled()`，取消后回滚不落库；已提交的写入如实返回结果，不虚报回滚。入口处检查不算数，真正生效的是提交点检查。
- 搜索由 Rust 执行：`≥3` 字符走 FTS5 `MATCH`（查询串整体加引号，操作符一律当字面），标题/别名/主题命中优先于正文；`1～2` 字符与短查询走转义后的 `LIKE` 字面分支——实测 SQLite trigram 以 3 字符为索引粒度，`MATCH '"识图"'` 命中为空，这一点已写入 `store::probe_capabilities` 的注释与探针（探针改用 `"识图谱"`）。

### 依赖与许可证

`rusqlite = 0.41.1`（仅 `bundled`、`backup`）、`libsqlite3-sys = 0.39.1`（bundled SQLite amalgamation，public domain）、`serde`/`serde_derive = 1.0.229`、`serde_json = 1.0.151`、`sha2 = 0.10.9`；`cargo tree --target x86_64-pc-windows-msvc` 实际编译 34 个第三方 crate，版本与校验和锁定在 `native/knowledge/Cargo.lock`。许可证文本逐条登记在 `licenses/rust-<crate>-<version>-MIT`（`foldhash` 为 `-Zlib`，`unicode-ident` 另有 `-UNICODE`），`THIRD_PARTY_NOTICES.md` 新增对应表格。未引入 ORM、向量库、图数据库、网络服务器或模型依赖。

### 改动

- 新增 crate `native/knowledge/`：`Cargo.toml`、`.cargo/config.toml`（静态 CRT）、`Cargo.lock`、`src/{main,lib,protocol,store,util,sources,cards,profile,link,service}.rs`、`tests/process.rs`；复核后新增 `bin/fixture.rs`（`--features fixture` 才构建的闭环夹具，不打包、不在生产方法表内）。
- 新增 `src/shared/knowledge.ts`（契约与夹具）、`src/main/knowledge/host.ts`（进程、管道、期限与代际）、`src/main/knowledge/model.ts`（模型回调）、`src/main/knowledge/{host,model,host.integration}.test.ts`，复核后新增 `src/main/knowledge/loop.test.ts`（真实 Rust 夹具闭环）。
- 接入：`src/main/index.ts`（helper 实例、15 个 `knowledge:*`/`profile:*` 通道、资源统计、游戏模式与 `before-quit` 停止）、`src/main/resources.ts`（`knowledge` PID）、`src/main/ipc-trust.test.ts`（结构性校验：`index.ts` 不得直接使用 `ipcMain.handle/on`，15 个通道必须经 `handle()`）、`src/shared/api.ts` 与 `src/preload/index.ts`（有限类型化方法，不暴露 helper、路径、SQL 或 prompt）。
- 构建与打包：`scripts/build-native.mjs` 增加 `knowledge`；`electron-builder.yml` 增加 `native/bin/yu-knowledge.exe` → `resources/native/yu-knowledge.exe`。
- 复核轮改动：`protocol.rs`（`RESULT_BUDGET_BYTES` + `fit_page`）、`cards.rs`（`CardSummary` 列表与摘要查询）、`profile.rs`（分页字段）、`sources.rs`（提交点取消 + 正文字符上限）、`service.rs`（来源分支改用可变连接）、`lib.rs`（`write_answer` 出站越界降级）、`link.rs`（行尾修复）、`tests/process.rs`（`TempRoot` 守卫与 6 个真实边界回归）、`host.ts`（总期限、模型父子绑定、进程代际、本地 `status`）、`host.test.ts`（23 项）、`host.integration.test.ts`（8 项）、`loop.test.ts`（6 项）、`src/shared/knowledge.ts`（`KnowledgeCardSummary`/`hasMore`/`nextOffset`/`KnowledgeStatus.running`）。
- 文档：README/README.en 各补一段底座说明并注明用户功能未开放；`THIRD_PARTY_NOTICES.md` 与 `licenses/` 新增条目。

### 验证（实际命令与结果）

阶段 1 初次交付（2026-11-05 第一轮，HEAD 至 `2ea246f`）：

| 命令 | 工作目录 | 结果 |
| --- | --- | --- |
| `cargo fmt -- --check` | `native/knowledge` | exit 0，无差异 |
| `cargo test --locked` | `native/knowledge` | exit 0，17 passed（12 lib + 5 process），0 failed |
| `cargo clippy --locked --all-targets -- -D warnings` | `native/knowledge` | exit 0，无告警 |
| `pnpm exec vitest run src/main/knowledge/host.test.ts src/main/knowledge/model.test.ts src/main/knowledge/host.integration.test.ts src/preload/index.test.ts src/main/ipc-trust.test.ts` | 仓库根 | exit 0，5 files / 37 tests passed（host 13、model 8、integration 5、preload 3、ipc-trust 8） |
| `pnpm typecheck` | 仓库根 | exit 0 |
| `pnpm test:native` | 仓库根 | exit 0（7 个 crate 的 `cargo test --locked`） |
| `pnpm test` | 仓库根 | exit 0，255 files / 3707 tests passed，8 skipped，98.27s |
| `pnpm build` | 仓库根 | exit 0（含 renderer/settings 4.69 MB 产物） |
| `git diff --check` | 仓库根 | 无空白错误（当时对空工作区执行；本节修正为对 `4e077a3..HEAD` 复核，见第二轮） |

第一轮报告宣称的构件哈希 `e1019b4b…` 标识的是那份文件；同一源码重复构建哈希会变（MSVC 写入 PE 时间戳），第二轮交付改用新哈希，见下表。

## 阶段 1 复核修复后验证（2026-11-05 第二轮）

| 命令 | 工作目录 | 结果 |
| --- | --- | --- |
| `cargo fmt -- --check` | `native/knowledge` | exit 0，无差异 |
| `cargo test --locked` | `native/knowledge` | exit 0，25 passed（14 lib + 11 process），0 failed |
| `cargo clippy --locked --all-targets -- -D warnings` | `native/knowledge` | exit 0，无告警 |
| `cargo clippy --locked --all-targets --features fixture -- -D warnings` | `native/knowledge` | exit 0，含夹具 bin |
| `pnpm exec vitest run src/main/knowledge/host.test.ts src/main/knowledge/loop.test.ts src/main/knowledge/host.integration.test.ts src/main/knowledge/model.test.ts src/preload/index.test.ts src/main/ipc-trust.test.ts` | 仓库根 | exit 0，6 files / 56 tests passed（host 23、loop 6、integration 8、model 8、preload 3、ipc-trust 8），6.93s |
| `pnpm typecheck` | 仓库根 | exit 0 |
| `pnpm test:native` | 仓库根 | exit 0（7 个 crate，含 knowledge 的 14 + 11） |
| `pnpm test` | 仓库根 | exit 0，256 files passed / 3 skipped（259），3726 tests passed / 8 skipped，98.97s 与提交后复跑 99.15s（两次均单独运行，无并行编译负载） |
| `pnpm build` | 仓库根 | exit 0（renderer `settings-*.js` 4,687.76 kB）；提交后复跑同样 exit 0，且 release 辅助进程字节未变（增量构建，未触发重新复制） |
| `git diff --check`（工作区） | 仓库根 | exit 0 |
| `git diff --check 4e077a3..HEAD`（提交后） | 仓库根 | exit 0（`licenses/rust-vcpkg-0.2.15-MIT` 的 EOF 空行已清理） |

构件与哈希（本轮重新测量）：

| 文件 | 类型 | 字节 | SHA-256 |
| --- | --- | --- | --- |
| `native/bin/yu-knowledge.exe` | 交付用 release 构件（`scripts/build-native.mjs` 从 `cargo build --release --locked` 复制） | 2,318,336 | `42673ca79c8122837d90527123a20322e34395c0a41263fe0850237c293cfbd5` |
| `native/knowledge/target/debug/yu-knowledge.exe` | `cargo test` 使用的 debug 二进制，**不是**交付件 | 3,406,848 | `35700f65c7478ce8e5dddd706a0eae9e7024f11e7f475ee07ebe5d22f88319d5` |
| `native/knowledge/target/debug/yu-knowledge-fixture.exe` | 复核闭环用 debug 夹具（`--features fixture`，不打包） | 2,411,520 | `940851fceb214be3d1f3812952b3c186d4057e91c0bb0cf5d3be27ed21ef630c` |

`native/bin/yu-knowledge.exe` 的哈希仍只在“这一份文件”意义上有效：MSVC 链接器写入 PE 时间戳，重复构建会得到不同哈希；重建后需重新取哈希。

资源与回收：`native/knowledge/target` 1.1 GB（被 `.gitignore:69` 忽略，与其余 crate 保留编译缓存的做法一致）；`%TEMP%/yu-knowledge*` 在本轮结束前实测 **0 个**——`native/knowledge/tests/process.rs` 新增 `TempRoot` 守卫（`Drop` 删除目录，声明在 `Helper` 之前，进程先退出再删库），上一轮遗留的 45 个临时根已清理。

### 复核自查发现并修正的问题

- 空闲退出走 `stop()` 时把主机标记为“已停止”，紧接的显式请求就再也拉不起新进程（全量并发负载下由 `host.test.ts` 复现）。改为两个明确语义：`stop()` 只停当前进程、允许下次请求重启（空闲退出与游戏模式用它），`shutdown()` 供应用退出使用、此后不再启动；`index.ts` 的 `before-quit` 改用 `shutdown()`。
- 被替换的旧进程晚到的 `close`/`error` 会清空新进程的状态并连带失败新请求。宿主在 handler 里先校验 `this.child !== child` 再动状态；readline 接口在守卫之前关闭。
- 上述两点连同 trigram 粒度、`changed` 帧干扰断言一起，是本节记录的真实发现，不是事后美化。
- 全量套件在与 CPU 密集型任务（`cargo clippy`/`tsc`）同时运行时，先后出现过 `src/main/providers/asr/cn.test.ts`、`realtime.test.ts` 的本地 mock 服务连接失败与 `src/main/windows-native-browser-url.test.ts` 的 30 个 PID 观测失败；两类文件单独运行均全绿，机器空闲时的完整 `pnpm test` 也全绿，判定为本机并行负载下的既有测试抖动，未改动其断言或超时。

### 失败与未测

- 复核第一轮暴露的真实缺陷（非环境问题）：来源两个写入口缺提交点取消检查、宿主期限未覆盖 `ready`、模型子请求未绑定父请求与进程代际、`source.text` 缺字符上限、列表返回完整正文无出站长度检查。均已修复并有真实边界回归，见上两节。
- 实测发现：SQLite trigram 以 3 字符为粒度，2 字 `MATCH` 无命中 → 探针改用 3 字样本，短查询走字面 `LIKE`（已在代码注释与本节记录）。
- 实测发现：`changed` 通知帧会让按行读取的断言错位 → 测试辅助函数先跳过非结果帧再匹配 `id`（实现不改）。
- 负载抖动（保留可复现依据）：全量 `pnpm test` 与 CPU 密集型任务并行时，出现过 `src/main/providers/asr/cn.test.ts`、`realtime.test.ts` 的本地 mock 连接失败与 `src/main/windows-native-browser-url.test.ts` 的 30 PID 观测失败；单独运行全绿。本轮另修正了本阶段新增测试自身过紧的期限（`late` 回包从 250 ms 改为 2500 ms，相应断言等待加长），属于测试侧对负载的鲁棒性，不是产品行为放宽。
- 未测/未做（属阶段 2～7）：真实付费模型调用（本阶段外部 LLM 调用数 0）、自动输入挂钩、历史扫描、七类卡片提炼与语义去重、画像归纳、知识图谱、侧栏页面、聊天检索工具、待办/工作流联动、备份格式 v2、安装器与卸载交互。

- 实测发现：SQLite trigram 以 3 字符为粒度，2 字 `MATCH` 无命中 → 探针改用 3 字样本，短查询走字面 `LIKE`（已在代码注释与本节记录）。
- 实测发现：`changed` 通知帧会让按行读取的断言错位 → 测试辅助函数先跳过非结果帧再匹配 `id`（实现不改）。
- 未测/未做（属阶段 2～7）：真实付费模型调用（本阶段外部 LLM 调用数 0，模型回调只用 stub 完成器验证通路）、自动输入挂钩、历史扫描、七类卡片提炼与语义去重、画像归纳、知识图谱、侧栏页面、聊天检索工具、待办/工作流联动、备份格式 v2、安装器与卸载交互。

### 外部复核（2026-11-05，Codex thread `01a1a846-2e68-7062-89a9-bc2ed962ce86`，reportId `820b0b7b-423c-46ff-97ac-a0764c41a649`）

结论：阶段 1 **未通过**。外部复跑了本次报告的 5 个 Vitest 文件（37 项）与 `cargo test --locked`（12 lib + 5 process），也核对了 `native/bin/yu-knowledge.exe` 的 SHA-256；但下列边界探针真实失败，测试通过不能代替未覆盖的行为：

| 探针 | 外部实测输出 | 结论 |
| --- | --- | --- |
| `cancel_source_while_busy` | `{"probe":"cancel_source_while_busy","resultOk":true,"persisted":1}` | 外部连接持写锁时取消 `source.save` 仍然落库；`source.invalidate` 同样在取消后把状态改成 `invalid` |
| `ready_deadline`（`requestMs=60`，对端永不发 `ready`） | `{"probe":"ready_deadline","requestMs":60,"observationAfterMs":300,"result":"still_pending"}` | `call()` 先 await `ready` 再建计时器，期限没覆盖握手 |
| `parent_model_timeout` | `{"parentResult":"timeout","modelStarted":true,"modelAbortedAtParentTimeout":false,"modelAbortedAfterStop":true}` | 模型子请求只按子 ID 记录，父请求超时不 abort 模型 |
| `source_text_limit` | `{"probe":"source_text_limit","characters":200001,"resultOk":true,"error":null}` | `source.text` 未做 200000 字符上限检查 |
| `legal_cards_default_page`（11 张、每张 200000 字符正文） | `{"ok":false,"code":"internal","message":"the knowledge helper stopped"}` | 列表返回完整正文且无出站长度检查，合法输入即可撑爆单帧 |

另有事实修正：`git diff --check 4e077a3..HEAD` 因 `licenses/rust-vcpkg-0.2.15-MIT:26` 的多余 EOF 空行退出 1；本节此前“所有取消都不会落库”“模型取消通路完整”“旧进程迟到回包不影响在途请求”属于**超出实测范围的概括**，实际验证范围见下文修复记录。

### 复核问题修复（2026-11-05 第二轮）

- A 取消原子性：`source.save`/`source.invalidate` 改为显式事务，写语句之后、`commit()` 之前检查取消 token；取消即回滚。六个卡片/画像写入口在写锁等待与既有 token 下复核过，规则不变。
- B1 总期限：`call()` 在 await `ready` 之前创建唯一计时器，覆盖 spawn、`ready` 与执行，收到 `ready` 不重新计时；到期拒绝等待者、abort 该父请求的模型、写 `cancel`，未就绪且无在途请求时回收该进程，不伤及已替换的新进程。
- B2 模型回调绑定：模型子请求同时记录父请求与 `child`/`generation`；父请求结束、超时、取消、Rust 等待结束、进程退出都 abort 并清理映射（`finally`）。无在途父请求、旧进程、重复子 ID 的 `model.request` 不发起模型调用。模型期限仍沿用父请求的 120 秒总预算，不在回调里另起可续期计时器。
- B3 进程代际：stdout/stderr/stdin 回调先校验 `this.child === child && this.generation === generation`；旧 `ready` 不能解除新 ready，旧 `model.request` 不会写到新管道，重启后复用的子 ID 不受旧回包影响；单帧累积超过 2 MiB 或出现流错误（EPIPE、非法 JSON、`null`、非对象帧）走 `discard()` 清理该进程与等待者，不把异常抛进主进程。
- C1 正文上限：来源正文在指纹计算与写入前统一按 200000 字符检查，超限返回 `too_large`，不截断。
- C2 出站分页：`card.list`/`card.search` 返回 `CardSummary`（无正文、带 `bodyChars`）与 `hasMore`/`nextOffset`；`protocol::fit_page` 按 `RESULT_BUDGET_BYTES`（1 MiB 序列化字节）装整条、至少保留一条，调用方按 `nextOffset` 翻页不会漏项；`lib.rs::write_answer` 在整帧超过 2 MiB 时替换为有界 `too_large` 错误帧；单条详情不截断。`src/shared/knowledge.ts` 的 `KnowledgeCardPage`/`KnowledgeCardSummary`/`ProfilePage` 同步修改。
- D 闭环：新增 `native/knowledge/bin/fixture.rs`（仅 `--features fixture` 构建，不打包、不安装、不进生产方法表），复用生产 `Link`/协议；`card.search`/`card.get` 触发 `model.request`，子 ID 固定 `m1` 以覆盖重启复用。
- E 懒启动：停机时 `KnowledgeHost.status()` 本地返回 `{running:false,schema:null,fts5:null,trigram:null}`，不 spawn、不谎报能力；运行中才转发真实值。`KnowledgeStatus` 增加 `running` 与可空能力字段。

### 复核取证（真实边界，不以 mock 代替）

- `native/knowledge/tests/process.rs`（真实 `yu-knowledge.exe`）：写锁期间取消 `source.save`、写锁期间取消 `source.invalidate`（均断言 `error.code == "cancelled"` 且库内行数与状态不变）、提交后取消不虚报回滚、正文恰好 200000 与超出（含 emoji 边界）、11 张 200000 字符卡片的默认分页（无 `body`、`bodyChars == 200000`、`card.get` 仍给全文）、多字节内容按 `nextOffset` 翻完且无重无漏。
- `src/main/knowledge/loop.test.ts`：生产 `KnowledgeHost` + 真实 Rust 夹具 + 注入完成器，覆盖成功、provider 失败码回传、父超时 abort、停机后重启、重启后同子 ID 迟到回包不影响新进程。夹具由该测试在 `beforeAll` 里自建：`cargo build --features fixture --bin yu-knowledge-fixture --manifest-path native/knowledge/Cargo.toml`（工作目录 `native/knowledge`，600 秒上限），产物 `native/knowledge/target/debug/yu-knowledge-fixture.exe`（2,411,520 字节 / `940851fc…`），属 debug 夹具，不是交付构件；单独复跑命令：`pnpm exec vitest run src/main/knowledge/loop.test.ts`。
- `src/main/knowledge/host.test.ts`（真实管道 stub）：永不 `ready`、`ready` 晚于期限、停机时仍在等 `ready`、`null`/数组垃圾帧、EPIPE、重复子 ID、无父请求的模型调用、父超时 abort、旧代际迟到回包。


### 第二次外部复核（2026-11-05，同一 thread，reportId `5e4cbb0a-b702-472c-9605-1bc0c14c02b9`）

基线 HEAD `0597ca4bb486d280d33aff745a977abfcf897cf2`，工作区干净。外部已核实并保留本轮通过的项：6 文件 / 56 项 Vitest；`cargo test --locked` 14 lib + 11 process；完整阶段 `git diff --check`；交付 release 哈希 `42673ca7…` 与报告一致；真实 Rust 锁等待期间取消 `source.save`/`source.invalidate` 均回滚；来源 200000 字符边界；50 张上限卡片实测按字节分为 40+10 项（约 1,024,049 / 256,105 字节）且无重复无遗漏；Rust 夹具确复用生产 `Link`/协议；懒启动 `status` 正确；换代隔离通过（旧 `m1` 答案在新进程 `m1` 仍等待时释放，只有新答案结算）。

仍有下列两项帧边界缺口，因此本阶段暂未验收：

| 探针 | 外部实测输出 | 原因 |
| --- | --- | --- |
| `host_utf8_frame_limit`（对端对 `getCard` 回 750000 个 `知`） | `{"frameBytes":2250101,"limitBytes":2097152,"result":{"accepted":true,"bodyChars":750000}}` | `host.ts` 的 stdout 处理用 `buffer.length`/`line.length`，那是 JS 字符数而不是 UTF-8 字节数，中文大帧绕过 2 MiB 上限 |
| `malformed_error_result`（`{"v":1,"type":"result","id":<在途>,"ok":false}`） | `{"uncaughtExceptions":["Cannot read properties of undefined (reading 'code')"],"parentSettled":false}` | `onLine` 先 `pending.delete` + `clearTimeout`，再读取 `frame.error.code`，抛 TypeError 后该请求再也不会被结算 |

### 第二次复核修复（2026-11-05 第三轮）

- F1 字节帧：`host.ts` 去掉 `stdout.setEncoding('utf8')`，数据通路保留 `Buffer`，按 `NEWLINE (0x0a)` 切帧；每帧用 `line.length`（字节）与 `KNOWLEDGE_LIMITS.frame`（2 MiB）比较，只有完整帧才 `toString('utf8')` 解码，因此跨 chunk 的多字节字符与 emoji 仍完整；多帧同 chunk 逐帧判定，不累加成单帧；循环结束后若残留无换行缓冲已超限，立即回收该进程。超限一律 `discard()` 并拒绝等待者，错误文案独立为 `the knowledge helper wrote an oversized frame`，不冒充业务结果。
- F2 外壳校验：新增 `isRecord`/`readReady`/`readFailure`，`onLine` 先校验再动状态——`type` 必须是字符串、`v` 必须为 1、`ready` 必须带 `{knowledge,profile}` 对象与布尔 `fts5`/`trigram`（不合格不解除握手，直接回收）、`changed` 要求字符串 `scope`、`result` 要求字符串 `id` 与布尔 `ok`、失败分支在触碰 `pending` **之前**校验 `error.code`/`error.message` 均为字符串、`model.request` 要求 `id`/`parentId` 字符串且 `messages` 是数组。命中在途请求的损坏帧走新私有方法 `settle()` + `protocolBreak()`：结算该请求为有界 `internal` 协议错误再回收进程；未知/孤儿帧保持原有安全忽略；业务正文结构仍由 Rust 校验，TS 不重建业务 schema。
- `native/knowledge/src/protocol.rs` `ready_frame` 的 `schema` 改为对象 `{"knowledge": KNOWLEDGE_SCHEMA, "profile": PROFILE_SCHEMA}`，与 `src/shared/knowledge.ts` 的 `ready.schema: { knowledge, profile }` 一致；协议版本仍为 1，方法表未变。真实helper与夹具均断言该对象结构（`tests/process.rs` 的 `Helper::start`、`loop.test.ts` 的 `status()`）。


实现提交：`c385db7`（`fix(knowledge): enforce byte framing and validate response envelopes`，5 个文件：`src/main/knowledge/host.ts`、`host.test.ts`、`loop.test.ts`、`native/knowledge/src/protocol.rs`、`native/knowledge/tests/process.rs`），本节与验证表由 `ec405dc` 记录，其后的 docs 提交只补交付哈希。状态：阶段 1 修复已提交，待外部 Codex 复核，阶段 2～7 未开始。
### 第二次复核修复后验证（2026-11-05 第三轮，实际命令与退出码）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `cargo fmt -- --check`（`native/knowledge`） | 0 | 无差异 |
| `cargo test --locked` | 0 | 14 lib + 11 process 全通过 |
| `cargo clippy --locked --all-targets -- -D warnings` | 0 | 无告警 |
| `cargo clippy --locked --all-targets --features fixture -- -D warnings` | 0 | 夹具 bin 一并 lint |
| `pnpm exec vitest run src/main/knowledge/ src/preload/index.test.ts src/main/ipc-trust.test.ts` | 0 | 6 文件 / 61 项（host 28、loop 6、integration 8、model 8、preload 3、ipc-trust 8） |
| `pnpm typecheck` | 0 | node + web 两个工程 |
| `pnpm test:native` | 0 | 7 个 crate |
| `pnpm test` | 0 | 256 文件通过 / 3 跳过（259），3731 项通过 / 8 跳过（3739），98.55 s |
| `pnpm build` | 0 | 渲染端 `settings-*.js` 4,687.76 kB，helper 字节未变 |

本轮新增的真实管道回归（不使用 mock 替代边界）：

- `src/main/knowledge/host.test.ts`：`rejects a frame whose UTF-8 bytes exceed the transport limit`（750000 个 `知`，JS 长度 < 2 MiB、UTF-8 2,250,101 字节）、`rejects a frame that never ends with a newline once it passes the limit`（900000 个 `知` 且无换行）、`accepts several complete frames that arrive in one chunk`（`changed` + `result` 同一次写入）、`rejects a failure result that carries no usable error`（缺 `error`、`error: null`、`error` 字段类型错误三种）、`does not release the handshake for an unusable ready frame`（旧数字形态 `schema: 1`）；整套用例安装了 `uncaughtException` 观察器并断言为空，拒绝后断言 `running === false` 且下一次请求由新进程恢复正常。
- `native/knowledge/tests/process.rs` 的 `Helper::start` 断言真实 helper 的 `ready.schema` 等于 `{"knowledge":1,"profile":1}`；`src/main/knowledge/loop.test.ts` 在真实夹具闭环里额外断言运行中 `status().schema` 为同一对象。

构件与哈希（区分用途）：交付 release `native/bin/yu-knowledge.exe` 2,318,848 字节 / `68ff70bef5d565b411a574612da2215586cab40a773860da0d1c0188ff9112e5`；`cargo test` 使用的 debug `native/knowledge/target/debug/yu-knowledge.exe` 3,407,360 字节 / `d35d2cf1dd8f9520…`；夹具 `native/knowledge/target/debug/yu-knowledge-fixture.exe` 2,412,544 字节 / `afb137a62955913c…`（debug 夹具，不交付）。MSVC 链接器会写入 PE 时间戳，同一源码重复构建的哈希不同，故哈希只标识这一次构建的文件。

未测/限制：`KnowledgeHost` 的字节上限只对单帧生效，未对超长连接的持续压力做基准；中文 1～2 字检索仍走 `LIKE` 分支（trigram 最小 3 字符）；真实付费模型调用未纳入（夹具与注入完成器替代）。

### 资源

- 保留：`native/bin/yu-knowledge.exe`（2.3 MB，交付产物）、`native/knowledge/Cargo.lock`、`licenses/` 新增 28 个文本、`native/knowledge/target/`（697 MB，可重建构建缓存，被 `.gitignore` 的 `/native/**/target/` 忽略，与其他 crate 的 target 并存保留）。
- 回收：测试用隔离数据根位于 `%TEMP%` 下并由测试自行删除。Windows 上删除会被仍打开的连接挡住，因此 `store.rs` 的重开用例先 `drop(reopened)`、`process.rs` 的懒启动用例先 `shutdown` 再删目录，`host.test.ts` 复用同一个 stub 目录并在 `afterAll` 删除；修好后连续运行 `cargo test --locked` 与 `host.integration.test.ts` 均不再留下目录（实测 `ls -d %TEMP%/yu-knowledge*` 为 0）。本轮未生成其他临时脚本或证据文件，`.gitignore` allowlist 无需改动。

## 阶段 2 实施记录（2026-11-05，DSH 执行会话 session-e4795148-53a3-4afd-b014-730be9b3c9f1）

外部 Codex 已在 HEAD `7186caeb82fc111d23d9ef3ce20d59502c33fac2` 通过阶段 1 验收（复跑 6 文件 61 项 Vitest、`cargo test --locked` 14 lib + 11 process、`pnpm typecheck`、完整阶段 `git diff --check`；交付 release 哈希 `68ff70be…` 一致；两项帧边界探针独立重放通过）。本阶段只做“接收来源 + 持久化待提炼队列”，实际生成卡片数为 0，真实付费模型调用数为 0。

### 渠道、配置与权限

- 配置沿用现有 `Settings`，新增 `knowledge: { enabled, notes, chat, reading }`，默认 `{ false, true, true, true }`：总开关默认关闭，三个渠道默认允许但只有总开关启用后才接收。主进程用总开关快速跳过 spawn/读取/暂存；渠道、临时会话、排除、去重、稳定期与队列状态由 Rust 最终决定（`collect.configure` 同步）。
- 渠道枚举固定为 `note`、`chat`、`reading`。`reading` 同时覆盖主界面聊天与浮动 Ask 的成功阅读总结；`reading` 关闭时该渠道来源不入队，也不允许经 `chat` 入口绕过（两者由真实来源事实区分：`chat` 只收 `chat` 渠道的问答，阅读总结只记 `reading`）。
- 排除以稳定来源组为单位：`exclude.add {kind:'note'|'chat'|'reading', key}`，`key` 为随记 ID、对话 ID 或阅读来源引用；排除覆盖该来源各版本，重新允许必须显式 `exclude.remove`，不因新版本自动解除。
- 渲染端只能发有界控制参数与已知来源引用；不能指定数据库根、文件路径或正文。

### 数据模型（knowledge.db `user_version = 2`）

v1 → v2 只新增表，不改既有列，卡片/来源/排除原地保留；`profile.db` 无职责变化，版本仍为 1。

| 表 | 主键/唯一键 | 用途 |
| --- | --- | --- |
| `queue_groups` | `id`；`UNIQUE(channel, group_key)` | 稳定期分组：渠道、组键、`state`、`stable_at`、`reason`、`error`、`attempts` |
| `queue_items` | `PK(group_id, ordinal)` | 组内来源顺序（一次问答一段），引用 `sources(id)` |
| `queue_control` | `key` | `paused_manual`、`paused_game`、渠道开关快照 |
| `history_jobs` | `id` | 一次性历史整理作业：`scopes`、`state`、两个游标、六类计数 |

- 组状态 `state ∈ {stabilizing, ready, needs_reread, failed, cancelled}`；`stabilizing` 且 `now >= stable_at` 时对外一律报告 `ready`（待提炼），因此重启后无需补跑定时器也不会虚报。
- 来源身份仍是 v1 的 `sources(kind, origin_ref, version)`，`version = sha256(正文)`；同正文重复发布命中同一行，不产生新来源、不产生新任务。
- 去重与稳定期规则：同一 `(channel, group_key)` 只有一个组；正文指纹变化才把 `stable_at` 推到 `at + 60000`（默认 60 秒，测试注入短时钟），纯标题/访问时间变化既不重复建任务也不延长稳定期；组内 `at` 更旧的事件不覆盖较新的未处理内容；同一 `completed` 事件重复发布不新增任务；已生成的历史卡片不受随记新版本影响。
- 原文边界：`sources` 只存引用、指纹、大小、范围与时间，不存随记/聊天正文快照；`reading` 正文只留在主进程有界暂存（总上限 16 MiB），逐出或 helper 重启后对应任务置 `needs_reread`，不伪装可恢复。
- 恢复适配：主进程只对 Rust 通过 `queue.list` 报告的在途任务，按已绑定 ID 从现有 store 做有界只读投影并重新 `source.publish`（指纹一致即去重）；来源已删除/临时/被排除时调用 `queue.invalidate`/`queue.needs_reread`，不新增通用 RPC，也不允许 Rust 请求任意路径/URL。

### 方法表（新增 17 个，协议版本仍为 1）

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `collect.configure` | `{notes, chat, reading, paused:{manual, game}}` | 生效渠道与暂停态 |
| `source.publish` | `{channel, kind, originRef, groupKey, title, scope, text, at, meta?}` | `{sourceId, version, fingerprint, groupId, state, duplicate}` |
| `queue.list` | `{offset, limit, state?}` | 任务分页（`hasMore`/`nextOffset`，按 1 MiB 装页）+ 暂停态 |
| `queue.status` | — | 各有效状态计数、暂停态、组数 |
| `queue.pause` | `{reason:'manual'\|'game', paused}` | 暂停态 |
| `queue.cancel` | `{groupId, reason?}` | 任务置 `cancelled` |
| `queue.retry` | `{groupId}` | `failed`/`needs_reread` 回 `stabilizing` 并重置 `stable_at` |
| `queue.invalidate` | `{groupId, reason}` | 来源失效并把任务置 `cancelled` |
| `queue.needs_reread` | `{groupId, reason}` | 任务置 `needs_reread` |
| `exclude.add` / `exclude.remove` / `exclude.list` | `{kind, key}` / `{kind, key}` / `{}` | 排除项 |
| `history.begin` | `{notes, chat}` | 作业 ID 与初始游标（重复 begin 返回同一运行中作业） |
| `history.step` | `{jobId, kind, cursor, rows:[publish 形态]}` | `{cursor, counts, done}` |
| `history.pause` / `history.resume` / `history.cancel` / `history.status` | `{jobId}` | 作业状态与计数 |

- 并发仍为 1 个任务写入位；`queue.list` 分页与 `card.list` 共用 `protocol::fit_page` 与出站 2 MiB 检查。
- 手动暂停与游戏暂停互不覆盖：`paused = paused_manual || paused_game`，退出游戏不清除手动暂停；停止功能不删除已有任务元信息。
- 历史整理只覆盖现有随记与已完成持久聊天，不扫描 `history.sqlite` 听写历史、全盘文件或历史 URL；历史中的网页总结按“历史对话总结”标注范围入队。

### 状态含义

- `stabilizing`：仍在稳定期（不足 60 秒）。
- `ready`：待提炼，等待阶段 3 消费；本阶段不会把它改成完成。
- `needs_reread`：正文已不可用（阅读暂存逐出/helper 重启/来源失效），需用户重新发起原阅读任务。
- `failed`：采集或读取阶段真实失败，可 `queue.retry`。
- `cancelled`：被删除、排除、临时会话或用户取消。
- 进度计数（历史作业）区分已扫描、跳过、去重、待提炼、需重读、失败；扫描结束只表示来源收集完成，不等于提炼完成。

### 阶段 2 实现与验证（2026-11-05）

实现提交：`b2fb4d0`（`feat(knowledge): collect sources into a pending extraction queue`）。

**实现落点**

- Rust：`native/knowledge/src/queue.rs`（采集开关、稳定期、去重、排他、暂停、任务状态）、`history.rs`（一次性历史作业与游标）、`store.rs`（`KNOWLEDGE_SCHEMA = 2` 与增量迁移 `QUEUE_SQL`）、`service.rs`/`lib.rs`（20 个新方法注册）、`protocol.rs`（`MAX_GROUP_CHARS`、`channel_disabled`、`excluded`）。
- TS 投影层：`src/main/knowledge/collector.ts`（笔记/问答/阅读投影、材料上限、阅读正文进程内暂存、历史控制），`src/main/knowledge/host.ts`（新增 20 个薄转发方法与 `TaskTarget`）。
- 真实写入点：`src/main/notes.ts`（`onSettled`/`onRemoved`）、`src/main/chat.ts`（`ChatService` 第五个参数 `onCompleted`）、`src/main/assistant.ts`（`deps.onReading`）。
  - 首次交付的这些写入点判定有误，已在复核后修正（见「阶段 2 复核修复」B/C）：当时只检查 `completed` 而没检查临时会话与运行中取消，笔记通知不看是否真的落盘，阅读材料全部记成 `web` 并丢掉路径与覆盖范围。此处的描述不再代表当前行为。
- 开关：`src/shared/knowledgeSettings.ts` + `Settings.knowledge` + `DEFAULT_SETTINGS.knowledge = { enabled: false, notes: true, chat: true, reading: true }`。
  - 首次交付的 `sync()` 在总开关关闭时直接返回，等于永远不把"关闭"告诉 helper，也不清空阅读暂存；复核后改为无条件同步 `enabled` 并清空暂存，见「阶段 2 复核修复」D。
- IPC：`knowledge:collect-configure|collect-pause|queue-list|queue-status|task-cancel|task-retry|task-invalidate|task-needs-reread|exclude-add|exclude-remove|exclude-list|history-begin|history-pause|history-resume|history-cancel|history-status|history-latest`，全部经 `handle()` 与 `knowledgeOwner`（仅设置窗口）；渲染进程不能指定数据根、不能发 SQL。
  - 首次交付还暴露过 `history-step`（渲染进程自带 `rows`/`cursor`/`done`），这等于允许伪造"已读正文"，已在复核后删除（见「阶段 2 复核修复」A）。
- 阅读材料上限：最多 5 条、合计 48000 字符，`scope` 记录实际包含范围与截断；正文只在本进程暂存（16 MiB LRU），逐出或 helper 重启后只能 `needs_reread`，不假装可恢复。

**修复的自身问题（实现期发现）**

- `queue.invalidate|refusal` 原先只接受铸造出的 `groupId`，删除随记时无从反查；`GroupParams` 改为 `groupId` 或 `(channel, groupKey)` 二选一，删除/排除按来源键直接失效。
- 仅改元数据会重复通知采集：`NotesStore.update` 比较改动前后的正文字段，只有正文变化才 `onSettled`。
- 夹具 ready 帧仍写死旧架构号，导致 `loop.test.ts` 与真实 helper 不一致；夹具改用 `store::KNOWLEDGE_SCHEMA`/`PROFILE_SCHEMA`。

**验证（依赖顺序执行，未并发；以下为首次交付时的测量，修复后的实测见「阶段 2 复核修复」）**

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `cargo fmt -- --check`（`native/knowledge`） | 0 | — |
| `cargo test --locked` | 0 | 15 lib + 11 process + 10 queue |
| `cargo clippy --locked --all-targets -- -D warnings` | 0 | — |
| `pnpm exec vitest run src/main/knowledge` | 0 | 5 文件 / 66 项 |
| `pnpm exec vitest run src/main/notes.test.ts src/main/chat.test.ts src/preload/index.test.ts src/main/ipc-trust.test.ts src/shared` | 0 | 全部通过（notes 50、chat 12、collector 12、integration 12 等） |
| `pnpm typecheck` | 0 | node + web |
| `pnpm test:native` | 0 | 7 个 crate |
| `pnpm test` | 0 | 257 文件通过 / 3 跳过；3750 项通过 / 8 跳过；99.99 s |
| `pnpm build` | 0 | renderer 与主进程构建通过 |

- 交付 release：`native/bin/yu-knowledge.exe`，2,458,112 字节，SHA-256 `e6456b0f5217765ee256ba225f9b7f7758e4015875f721006e6b066bb5b03fd3`（每次重建都会变，hash 只标识该文件）。
- debug/fixture 二进制仅用于测试：`target/debug/yu-knowledge.exe`、`target/debug/yu-knowledge-fixture.exe`。

**未测与边界**

- 稳定期只做短窗口验证（`YU_KNOWLEDGE_STABLE_MS` 缩短），未在真实 60 秒窗口下做端到端等待。
- 本阶段不产生卡片：`ready` 任务只排队，没有消费方；真实模型调用为 0。
- 未做历史整理的真实大数据量压测（只验证批次游标、去重计数与暂停/恢复/完成流转）。

### 阶段 2 第二次外部复核（2026-11-05，同一 thread，reportId `ea9a9602-4cc5-4add-ab07-0076296c0e98`）：未通过

复核基线 HEAD `f7701a4`，工作区干净。复核方**确认通过**的部分：6 文件 / 139 项 Vitest、完整阶段 `git diff --check`、交付 release hash `e6456b0f…` 与报告一致、Rust 锁等待取消与 200000 字符边界、50 张上限卡片按字节 40+10 分页、夹具复用生产 `Link`、懒启动 status、代际隔离。**未通过的是真实入口**：采集链只在"调用方自己喂 `PublishInput`"时成立，因此阶段 2 不予验收，只允许修 A～E，不得开始阶段 3、不得调用真实模型。

复核的实测探针（原始输出）：

- 历史整理没有生产驱动：`history-begin` 只做转发，`history-step` 由渲染进程提交 `rows`/`cursor`/`done`，真实启动后停在 `running` / `scanned 0`；`collector.locate`/`retry` 没有生产调用方，"来源恢复"不存在。
- 临时会话仍入库：真实 `AssistantSession`（`memoryTemporary = true`）返回 `completed`，仍发布 → `{"temporary":true,"published":1,"scope":"浮动提问"}`。
- 清空正文后仍用旧正文：`{"probe":"intentionally_cleared_note","queued":true,"usedOldTranscript":true}`。
- 阅读身份丢失：`{"kind":"web","originRef":"ask:synthetic-reading","locator":"","preservedDocumentPath":false,"preservedCoverage":false}`（`E:/synthetic/doc.md` 与 `coverage` 均丢失）。
- 关闭开关不清暂存：`{"probe":"disable_clears_reading_stash","bodyRetained":true}`。
- 新发布路径绕过字段上限：`{"probe":"new_publish_text_limit","characters":200001,"outcome":{"accepted":true}}`。
- 乱序回合只剩一条：同线程先发布 `at=2000` 的 turn2、再发布 `at=1000` 的 turn1，只有 turn2 入库（旧实现按组 `updated_at` 判定陈旧）。
- 取消仍推进检查点：外部持 `BEGIN IMMEDIATE` 时 `history.step` + cancel 返回 `cancelled` 且 `source_rows=0`，但 `history.status` 已是 `noteCursor='after-n-cancel'`、`scanned=1`、`failed=1`。
- 分页把 201 条截成 200：`queue_items` 有 201 条，`queue.list` 返回 200 且 `hasMore:false`，第 201 条不可达。

### 阶段 2 复核修复（A～E，2026-11-05）

**A｜真实历史扫描与来源恢复（Rust 掌握扫描状态）**

- `native/knowledge/src/history.rs`：`step` 改为单事务——重放保护（`cursor` 与已存游标相同时返回 `replayed: true` 且不计数）、发布走 `queue::publish_in(&transaction, row)`、`Cancelled` 直接上抛（不再计为 `failed`）、游标/计数/状态 UPDATE 与 `ensure_not_cancelled()` 在同一事务提交前完成，取消的批次不会移动检查点。
- `native/knowledge/src/sources.rs`：`source.read` 恢复适配器（`read(conn, id, expect)` → `{source, matched}`），按已绑定的来源 id 读取既有库并按指纹/版本核对，不重新抓取、不重新扫描文件、不接受渲染进程指定路径或 URL。
- TS：新增 `src/main/knowledge/history.ts`（`HistoryDriver`：`start`/`resume`/`control`/`walk`，只在 helper 的 `running` 状态下继续，切开关后自动 `pauseHistory`）与 `src/main/knowledge/pages.ts`（`createHistoryPages`：笔记按 `updatedAt:id` 游标、问答按 `threadId:messageIndex` 游标，单页 20 条）。渲染进程的 `history-step`（`rows`/`cursor`/`done`）已从 preload 与 `api.ts` 删除，只剩启动/暂停/恢复/取消/状态/最近作业。
- 语义：扫描完成只表示来源收集完成，`ready` 任务等待阶段 3 提炼；卡片仍为 0，模型调用 0。

**B｜真实入口的临时/失败/删除与正文字段语义**

- `src/main/chat.ts`：只在 `temporary === false && taskState === 'completed' && !closing` 时发布；`temporary` 同时读会话与最终结果，运行中转为临时的线程会调用 `onRemoved(id, 'thread became temporary')` 撤回，而不是仍然入库。
- `src/main/assistant.ts`：`turn.memoryTemporary` 为真时不交接阅读来源。
- `src/main/notes.ts`：`save()` 返回是否真正落盘，`patch()` 只在 `save()` 成功后才 `settled(note)`；后台保存失败不再通知采集（`notes.test.ts` 用只读目录验证）。
- `src/main/knowledge/collector.ts`：正文被清空时按"撤回"处理（`invalidateTask(..., 'note body cleared')`），不再回退到旧转写；`noteRemoved`/`threadRemoved` 走 `queue.invalidate_thread`，线程删除会同时取消该线程的问答与阅读任务（Rust `tests/queue.rs` 验证两条都被取消、来源标记 `invalid`）。
- 观察者的失败只写脱敏日志，不回灌到原回答流程。

**C｜阅读与附件身份、实际范围**

- `src/main/knowledge/collector.ts`：`readingFinished` 改为**一条材料一条来源**：`originRef = material.origin`、`groupKey = reading:<origin>`、`threadKey` = 线程、`kind` 由 `materialKind` 决定（附件/文档 → `document`，URL → `web`）、`locator` 保留 URL/路径/附件 id，`scope` 记录 `材料 i/n，约 N 字符（已截断）`，正文含问题、材料、覆盖说明、回答与来源。
- `src/main/chat-attachments.ts`：新增 `includedAttachments()`（与 `chatAttachmentReference()` 共用同一份切片，最多 5 个附件、合计 48000 字符），`chat.ts` 从这份切片投影 `attachmentMaterial()`，因此记录的就是真正送给模型的文本；单纯上传或未被引用的附件不入库；阅读通道关闭时不回退成普通问答。
- 暂存仍只在进程内（16 MiB LRU），键为真实 `origin`；`retry` 通过 `keys` 映射按组 id 找回正文，正文不在时改为 `needs_reread`，不会留下不可恢复的 `ready`。

**D｜总开关与游戏暂停**

- Rust：`queue::enabled`（`queue_control.enabled`，默认 false），`channel_enabled` 要求总开关打开，`collect.configure` 可写 `enabled`；`channels_json` 回报 `enabled`。
- TS：`collector.sync({ game })` 无条件把 `enabled` 与三通道、游戏暂停一起交给 helper；总开关关闭且 helper 未运行时只清空暂存、不启动进程；关闭时先确认配置落地（`confirmed` 握手，发布前等待仍在途的配置），再清空暂存。
- 游戏模式（第三轮修正）：进入与退出都通过 `collector.sync({ game })` 直接写数据库，不依赖进程是否在运行；进入后仍停掉进程，退出后新来源到来会重新启动；手动暂停不受影响。

**E｜一致性、分页与输入上限**

- E1 陈旧判定改为按来源：`publish` 用 `EXISTS(… origin_ref = ? AND read_at > ?)` 判断，乱序/迟到/历史回合都保留且按会话顺序追加（`tests/queue.rs` 验证 2 条都在，`ordinal` 递增）。
- E2 见 A 的事务化；取消不再移动检查点（真实锁等待测试验证 `noteCursor` 仍为 `null`、`scanned` 为 0，随后正常批次仍能推进）。
- E3 队列条目分页：`queue.items`（`ITEM_PAGE = 32`、`fit_page` 字节预算、`nextOffset`），201 条全部可达且无重复（测试逐页走完 201 个 `ordinal`）。
- E4 上限复用：`sources::validate` 统一 originRef/title/locator/version/scope/正文上限，`source.publish` 与历史路径都经过它；200000 字符通过、再加一个 emoji 与 201 字符标题都返回 `too_large`，不静默截断。

**未覆盖与说明**

- 开关/游戏暂停的端到端验证在 `KnowledgeCollector` 与真实 helper 上完成（含"关闭时不启动进程"、进程死亡后仍保持游戏暂停、退出后解除），未在真实 Electron 启动流程里跑集成测试：`src/main/index.ts` 的装配仍由现有 vitest 结构之外的人工验证覆盖。
- 60 秒稳定期仍只用缩短窗口（`YU_KNOWLEDGE_STABLE_MS`）验证。

**A～E 修复后验证（2026-11-05 第三轮，实现提交 `45b7fab`；实际命令与退出码，依赖顺序执行，未并发）**

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `cargo fmt -- --check`（`native/knowledge`） | 0 | — |
| `cargo test --locked` | 0 | 15 lib + 11 process + 18 queue |
| `cargo clippy --locked --all-targets -- -D warnings` | 0 | — |
| `cargo clippy --locked --all-targets --features fixture -- -D warnings` | 0 | — |
| `pnpm exec vitest run src/main/knowledge src/main/notes.test.ts src/main/chat.test.ts src/preload/index.test.ts src/main/ipc-trust.test.ts src/shared` | 0 | 46 文件 / 603 项 |
| `pnpm typecheck` | 0 | node + web |
| `pnpm test:native` | 0 | 7 个 crate |
| `pnpm test` | 0 | 258 文件通过 / 3 跳过（261）；3764 项通过 / 8 跳过（3772）；102.39 s |
| `pnpm build` | 0 | renderer 与主进程构建通过 |
| `git diff --check`（本轮未提交 diff） | 0 | 仅 CRLF 提示，无空白错误 |

- 本轮有实质改动的 crate 测试增量：`tests/queue.rs` 由 10 项增至 18 项（新增开关默认关闭、乱序回合保留、201 条分页、字段上限、线程删除同时取消问答与阅读、`source.read` 指纹核对、取消不移动检查点、重放不重复计数）。
- 真实入口新增：`src/main/knowledge/history.integration.test.ts` 3 项（真实 `NotesStore` + 真实 `ChatStore` + 编译后的 helper，渲染进程不参与提交正文）；`src/main/knowledge/collector.test.ts` 重写为 19 项；`src/main/chat.test.ts` 15 项（含临时会话撤回、非 `completed` 不入库、附件按真实切片投影）；`src/main/notes.test.ts` 51 项（含后台保存失败不通知采集）。
- 事务行为修正：写事务改为 `TransactionBehavior::Immediate`，避免延迟事务在锁竞争下升级失败（改为 `storage_error`），使"取消不推进检查点"在真实 `BEGIN IMMEDIATE` 竞争下成立。
- 交付 release：`native/bin/yu-knowledge.exe`，2,489,344 字节，SHA-256 `0e6a998a7eecbbbb8332be481b1fba336aef634011ac6a92b3e46685783af457`（每次重建都会变）。
- 仅用于测试的二进制：`target/debug/yu-knowledge.exe`（`aeb44d65…`）、`target/debug/yu-knowledge-fixture.exe`（`616f34c6…`），不随安装包分发。

## 阶段 2 第三次复核修复（2026-11-05，DSH 执行会话 session-e4795148-53a3-4afd-b014-730be9b3c9f1）

外部复核报告 ID `7b95f676-f74b-46ce-94d9-7b4c1866ab95`，基线 `56556579061fa69d6322491c344b327ce195235a`。外部确认通过且未重做的部分：批次锁等待取消不推进游标、重放不重复计数、200000 字符发布上限、201 条条目全部可达、公开 `history-step` 已移除、`HistoryDriver` 已接线、问答仅在 `completed` 入库且删除/临时会话会撤回、附件与真实切片同源。

复核实际失败项（真实入口，不用 mock 代替）：

| 项 | 探针结果 |
| --- | --- |
| R1 恢复 | `source.read` 只和自己比较，没有真实读取 NotesStore/ChatStore，也没有生产调用方 |
| R2 游标/边界 | 按可变 `updatedAt` 排序：扫描中把已读笔记改旧后，下一页返回 `[n2,n3,n1]`；`get(thread, 10000)` 的数组下标游标在 5001 回合下丢掉第 0 问，追加后下一页丢掉第 2 问 |
| R2 尾部批次 | 同一游标的空批次被当成重放，剩余行被删除时驱动会一直循环 |
| R3 清空笔记 | `polished=''`、`transcript='旧转写'`、`polishStatus='ok'` 时仍以旧转写入库（`{"probe":"cleared_note_after_repair","queued":true}`） |
| R4 游戏暂停 | 进入时暂停并停进程，退出时因进程已停不再解除（`{"probe":"game_exit_then_new_source","resumeSent":false,"running":true,"paused":true,"reasons":{"game":true,"manual":false}}`） |
| R5 乱序回合 | 迟到的历史回合把组的稳定期起点向后拖，刚到的新讨论因此提前 ready |

**修复映射**

- **R1**：新增 `src/main/knowledge/recover.ts`（`createSourceRecovery`，按 channel + origin 从真实 `NotesStore`/`ChatStore` 读当前正文，明确区分 `deleted`/`temporary`/`empty`/`unknown`），在 `index.ts` 装配为 `KnowledgeCollector` 的 `readBody`；`retry` 现在走 `queue.items` → 真实读取 → `source.read` 带正文重新计算指纹 → 未变才 `queue.retry`，变了按 `source changed` 撤回，读不到正文按 `needs_reread` 落库。Rust `sources::read` 改为接收正文并由 Rust 重算 SHA-256，不再自证。
- **R2**：`chat-store.ts` 新增 `historyBound()`/`historyThreads()`/`historyTurns(threadId, afterSeq, bound, limit)`，按 `seq` 分页并配对完整问答，不再用消息窗口下标；`pages.ts` 重写为稳定 id 顺序 + 作业开始时固定并持久化的上界（`history_jobs.note_bound`/`chat_bound`，schema 升到 4），笔记页按 UTF-8 字节预算（`HISTORY_BATCH_BYTES = 512 KiB`）装箱；`history.rs` 的重放判定改为"同游标且批次非空"，空批次视为完成标记。
- **R3**：`collector.noteBody` 改用 `@shared/noteBody` 的 `noteBodyField`，`NotesStore` 的写入前后比较用同一条规则，清空润色不再回退到旧转写。
- **R4**：游戏进入/退出都通过 `collector.sync({ game })` 直接写库；退出后新来源会重新启动 helper；手动暂停保留。
- **R5**：`queue.items` 排序改为 `s.read_at, i.ordinal`，组更新用 `MAX(stable_at, ?)`/`MAX(updated_at, ?)`，迟到回合不再把稳定期拉回过去。

**新增真实回归**

- `src/main/knowledge/host.integration.test.ts`（真实 helper）：正文已变的待办在重试时被撤回为 `cancelled`；清空润色的笔记不再以旧转写入库；helper 死亡后游戏暂停仍保持、退出后解除；总开关关闭时既不启动进程也不入队。
- `src/main/knowledge/history.integration.test.ts`：真实 `NotesStore` + 真实 `ChatStore` 驱动扫描；5001 回合（10002 条消息）线程第一页从第 0 问开始且 5001 回合全部到达；边界内的插入不重复、原有笔记不漏。
- `src/main/knowledge/pages.test.ts`：按字节预算装箱（20 行上限下只发 17 行）、单个超大正文仍可达下一页。
- `src/main/knowledge/collector.test.ts`：暂存超过 16 MiB 后最早的分组重试落到 `needs_reread`；`queue.items` 返回的是分组条目而不是分组本身（真实形状）。

**第三轮（R1～R5）修复后验证（实现提交 `16f52ae`、文档 `f0eb4f3`、测试收尾 `b97f173`；实际命令与退出码，依赖顺序执行）**

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `cargo fmt -- --check` | 0 | — |
| `cargo test --locked` | 0 | 15 lib + 11 process + 18 queue |
| `cargo clippy --locked --all-targets -- -D warnings` | 0 | — |
| `cargo clippy --locked --all-targets --features fixture -- -D warnings` | 0 | — |
| `pnpm exec vitest run src/main/knowledge src/main/notes.test.ts src/main/chat.test.ts src/preload/index.test.ts src/main/ipc-trust.test.ts` | 0 | 11 文件 / 161 项 |
| `pnpm typecheck` | 0 | node + web |
| `pnpm test:native` | 0 | 7 个 crate |
| `pnpm test` | 0 | 259 文件通过 / 3 跳过（262）；3772 项通过 / 8 跳过（3780）；（在最终 `b97f173` 树上复跑一次仍为 0） |
| `pnpm build` | 0 | renderer 与主进程构建通过 |

- 交付 release：`native/bin/yu-knowledge.exe`，2,497,536 字节，SHA-256 `085f3ec8cb272de639adf26a893e7bc80e6514ceac7cb1cce5ae9069b0dca20f`（每次重建都会变）。
- 仅用于测试的二进制：`target/debug/yu-knowledge.exe`（3,927,040 字节，`2f47e92afd61de7bd4db2f16d0773a201431a1c1af9d9ebbfb9220f2a3086d66`）、`target/debug/yu-knowledge-fixture.exe`（2,412,544 字节，`393df85ac02f8945e9da4cbc6fdc5fbd4947dee82a4dd5ac61abf53a5fc7657c`），不随安装包分发。
- 临时产物：本轮删除了先前遗留的 15 个 `%TEMP%/yu-knowledge-scan-*` 目录；`history.integration.test.ts` 现在在 `afterEach` 关闭 `ChatStore` 再删根目录（Windows 会锁住打开中的数据库），复跑后 `%TEMP%/yu-knowledge*` 为 0；`native/knowledge/target` 为 1.2 GB（`.gitignore` 已忽略，沿用仓库保留编译缓存的习惯）。
- 仍未覆盖：真实 Electron 启动、打包安装后的六程序联动、60 秒稳定期的真实时长（仍用 `YU_KNOWLEDGE_STABLE_MS` 缩短验证）、阶段 3 的卡片生成（本阶段不调用任何模型）。

## 阶段 2 第四次复核修复（T1～T3，2026-11-05，DSH 执行会话 session-e4795148-53a3-4afd-b014-730be9b3c9f1）

外部复核（reportId `b6179793-6dde-42ed-a4f9-59f0d7658a91`，基线 HEAD `6808376`）复跑目标 11 文件 161 项 Vitest 与阶段 diff 均通过，release 哈希 `085f3ec8…` 一致；真实 helper 探针确认空尾批可完成、锁等待取消不动 checkpoint、重放不重复计数、201 项完整唯一可取、乱序来源按原时间顺序且 `stableAt` 不倒退。这些保留、未重做。以下三处仍属原 R1/R2/R4 目标内的实际失败，本轮只修它们。

### T1 旧聊天正文恢复受默认 100 条窗口限制（P1）

- 失败证据：真实 `ChatStore` 61 轮共 122 条消息，`ChatStore.get(threadId)` 默认只返回最近 100 条 → 生产 `createSourceRecovery` 对第 1 轮返回 `{"missing":"deleted"}`，`collector.retry` 会因此整组撤回。
- 修复：`src/main/knowledge/recover.ts` 改为按绑定的 `userId` 锚点定向读取 `ChatStore.get(threadId, CHAT_MESSAGE_WINDOW = 8, userId)`，不再依赖"最近窗口"；短窗口里没有不再是删除的依据。真实 store 在线程或锚点消息不存在时抛错，恢复层捕获后如实返回 `deleted`；回答未 `done` 返回 `unknown`（撤回为 `source changed`），`memoryTemporary` 仍返回 `temporary`。
- 真实链路（`collector.retry`）：`queue.items` 取分组条目 → `readBody`（recover 读真实 store）→ `source.read`（Rust 用收到的正文重算 SHA-256 与来源指纹比对）→ 只有一致才 `queue.retry`，不一致按 `source changed` 撤回。
- 回归：`src/main/knowledge/recover.test.ts`（真实 `ChatStore`，61 轮 122 条，第 1/30/60 轮正文正确；删除线程 → `deleted` 且同库另一线程仍可恢复；临时会话 → `temporary`；未完成回答 → `unknown`）、`src/main/knowledge/recover.integration.test.ts`（真实 store + 生产 recovery/collector + 编译好的 helper：三个 61 轮线程分别绑定第 1/30/60 轮，`needs_reread` 后重试全部成功，来源指纹未变、分组未被撤回）。

### T2 字节分页跨已完成线程时 cursor 不前进（P1）

- 失败证据：A 线程 2 轮、B 线程 1 轮（每轮回答约 180 000 字符）时，第一页装下 A0+A1 后因 B0 超预算返回，而 cursor 被写成裸线程 id `A`；下一页 `splitCursor` 把裸 id 当作 `A:0`，于是永远重复 A0+A1，B 不可达。
- 修复：`src/main/knowledge/pages.ts` 线程结束后仍写 `${threadId}:${position}`，不再写裸 id；字节预算、固定 `chatBound`、持久 seq、完整问答配对、空尾完成标记与重放保护都保持不变。
- 回归：`src/main/knowledge/pages.cursor.test.ts`（真实 `ChatStore`：字节溢出的 A/B 用例逐页读到 `done`，三轮各出现一次、B 可达、非末页 cursor 每次前进；行数上限跨线程同样推进）。

### T3 游戏自动挂起被误记为手动暂停（P2）

- 失败证据：`HistoryDriver.walk` 在 `allowed()` 为假时调用 `pauseHistory` 把作业持久化为 `paused`，而 `resume()` 只接受 `running`；游戏退出只同步队列暂停标记，没有恢复 walk，作业永久停在 `paused`。
- 修复：`src/main/knowledge/history.ts` 的自动暂停改为"只结束本次 walk、保留 helper 中的 `running`"，手动暂停仍是持久 `paused`；新增 `src/main/knowledge/session.ts` 的 `syncKnowledge(wiring, game)`：先 `collector.sync({ game })` 让配置落地，再在"功能开启且不在游戏"时 `history.resume()`。`src/main/index.ts` 的游戏进入、游戏退出、设置更新、启动恢复四处都改为走它，因此真实流程（而不是单测手工调用两个组件）就会续跑。
- 回归：`src/main/knowledge/session.integration.test.ts`（真实 helper + 真实 `ChatStore` + 生产 `HistoryDriver`/collector/`syncKnowledge`：25 轮扫描进行到已提交批次后进入游戏 → 作业保持 `running` 且未完成 → 退出游戏经 `syncKnowledge` 自动续跑到 `completed`、`scanned 25`；手动暂停的作业经游戏进入/退出仍 `paused`；功能关闭时 `syncKnowledge` 不启动进程、也不触发恢复）。

实现提交 `0267018`（修复）与 `083e007`（本文档记录）。

### 本轮验证（实际命令与退出码，依赖顺序执行）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm exec vitest run src/main/knowledge src/main/notes.test.ts src/main/chat.test.ts src/preload/index.test.ts src/main/ipc-trust.test.ts` | 0 | 15 文件 / 170 项 |
| `pnpm typecheck` | 0 | node + web |
| `pnpm test` | 0 | 263 文件通过 / 3 跳过（266）；3781 项通过 / 8 跳过（3789） |
| `pnpm build` | 0 | 主进程与 renderer 构建通过 |

- 本轮未改 Rust 源码/协议/迁移，`native/bin/yu-knowledge.exe` 与上一轮逐字节相同：2,497,536 字节，SHA-256 `085f3ec8cb272de639adf26a893e7bc80e6514ceac7cb1cce5ae9069b0dca20f`（重建后仍以此为准，重启构建不保证可复现）。
- 测试专用二进制未变：`target/debug/yu-knowledge.exe` 3,927,040 字节 `2f47e92a…`；`target/debug/yu-knowledge-fixture.exe` 2,412,544 字节 `393df85a…`，不随安装包分发。
- 临时产物：`%TEMP%/yu-knowledge*` 复跑后为 0；`native/knowledge/target` 1.2 GB（`.gitignore` 已忽略）。
- 仍未覆盖：真实 Electron 启动与安装包联动、60 秒稳定期真实时长（仍用 `YU_KNOWLEDGE_STABLE_MS` 缩短）、阶段 3 卡片生成（本轮 0 次模型调用）。

## 阶段 2 外部验收（2026-11-05，reportId `bf09ce12-6830-4bf5-a033-6b1d4398e505`）

外部在 HEAD `4c05194` 定点复核通过阶段 2：目标 15 文件 170 项 Vitest 全部通过，完整阶段 `git diff --check` 通过，release 哈希 `085f3ec8…` 一致；独立合成探针确认 61 轮 122 条消息的首/中/末问答可定向恢复、两线程长问答字节分页为 `[A0,A1] → [B0]` 且 cursor 前进无重无漏、游戏自动挂起保留 `running` 而手动 `paused` 保持、`syncKnowledge` 四处真实接线成立。此前通过的取消/checkpoint、201 项分页、默认关闭与来源限长仍然有效。以上为外部复核结论；本文件中的 DSH 自测数字不代表外部全量复跑。

## 阶段 3 实施记录（2026-11-05，DSH 执行会话 session-e4795148-53a3-4afd-b014-730be9b3c9f1）

### 目标与边界

- 启用知识库后，真实待提炼队列在稳定期结束且未暂停时自动取得合法正文，经既有模型桥接由 Rust 提炼知识卡片；相同知识补来源或更新，冲突与人工编辑内容形成建议。
- 本阶段只新增必要的 Rust 业务、共享类型、设置项与受信管理 API；页面仍在阶段 5，软件联动在阶段 6，画像/图谱/检索工具不在此阶段。
- 生产模型路径必须接通（`createKnowledgeCompleter`），测试用注入完成器；真实模型质量与付费效果留到阶段 7。

### 管道操作（协议版本仍为 1）

| 操作 | 参数 | 结果 |
| --- | --- | --- |
| `extract.next` | `{}` | `{group, nextDueAt, paused, enabled}`；`group` 为占用凭证与来源描述，Rust 决定顺序与占用 |
| `extract.run` | `{groupId, claim, sources:[{sourceId, version, text}], profileId?, effort?}` | `{groupId, state, cards, proposals, noKnowledge, reason, remaining}`；内部写卡/建议/进度在一个事务 |
| `extract.fail` | `{groupId, claim, code, reason}` | `{groupId, state}`；`cancelled`/`changed`/`needs_reread`/`failed` 由 code 决定 |

- 三个操作都不接受 renderer 提供的任意正文或 prompt：`extract.run` 的正文由主进程按被占用来源读取，Rust 逐条核对 `sourceId + version + sha256(text)`。
- 主进程只做来源 I/O、既有模型请求与唤醒（`nextDueAt` 定时器或既有 `changed` 通知），同一批次由 Rust 的 `working` + `claim` 保证单并发。
- `extract.run` 的 120 秒是包含 ready、正文读取与模型往返的总预算；普通 CRUD 仍为 15 秒；模型子请求绑定真实在途父请求并沿用既有代际/迟到/取消规则。

### 数据模型（knowledge.db `user_version = 5`）

- `queue_groups`：新增 `priority INTEGER NOT NULL DEFAULT 0`（历史积压为 1、显式重试为 -1）与 `claim TEXT`；`state` 允许新增 `working`、`completed`。
- `cards`：新增 `fingerprint TEXT`（规范化正文的 SHA-256，用于精确去重）与 `revision INTEGER NOT NULL DEFAULT 1`；人工编辑递增 `revision`。
- `card_history(id, card_id, revision, title, summary, body, reason, created_at)`：自动更新前的实质内容与理由，供阶段 5 查看。
- `extract_progress(source_id, version, segment, state, group_id, created_at, updated_at, PRIMARY KEY(source_id, version, segment))`：以来源版本与分段为键的幂等进度。
- `suggestions(id, kind, target_card_id, target_revision, action, draft, reason, source_ids, state, created_at, updated_at)`：`action ∈ reference|merge|propose`，`state ∈ open|accepted|rejected`。

### 提炼与去重规则

- 单来源分段上限 12 000 Unicode 字符、段间重叠最多 500 字符；单批模型输入合计最多 12 000 字符；不把首段成功当作整源完成。
- 每批最多 3 张卡片，卡片正文建议 300～800 字，`maxTokens` 8192；单批最多一次提炼调用加一次候选比较调用，精确重复或无候选时跳过比较，总期限不重置。
- 精确去重：规范化（仅折叠空白，不改代码/路径/参数/版本号）后比较指纹，相同结论只补来源、保留正文与 `edited`。
- 语义去重：用现有 FTS/LIKE 找最多 8 条候选（候选文本合计最多 6000 字符），一次比较决定 `new|reference|merge|propose`；不引入 embedding 或全库两两比较。
- 自动合并仅限"同一结论 + 增加细节 + 目标未人工编辑 + 依据充分"，合并前把旧版本写入 `card_history` 并保留全部来源；其余情况只写建议、保留原卡片。
- 提交前重新核对目标卡片 `revision`/`edited` 与来源版本；变化则放弃本次过期写入。
- 尊重 `card.delete` 写入的 `source_version`/来源组排除：已删除卡片同版本重跑不复活，改为建议。
- 合法空数组可 `completed` 并记录原因；非法 JSON、陌生 source/target、超限、超时、缺模型都明确失败，不写半成品。

### 设置

- `KnowledgeSettings` 新增 `profileId: string | null`（默认 `null` → 首个启用 LLM）与 `effort: string`（默认 `high`）；不继承听写 `thinking off`，不读写密钥。缺可用模型返回 `model_unavailable`。

### 阶段 3 实现与验证（2026-11-05）

实现提交：`786dc14` `feat(knowledge): extract cards from the pending queue`（本轮全部代码与测试）。

**落地位置**

- Rust：`native/knowledge/src/extract.rs`（`next`/`run`/`fail`）、`suggestions.rs`（`list`/`get`/`accept`/`reject`）、`store.rs`（`EXTRACT_SQL`，`user_version = 5`）、`cards.rs`（`reindex`、`fingerprint_of`、`revision` 与列表 `revision` 列）、`service.rs`（7 个新方法）、`lib.rs`（模块与派发绑定 `parent`）。
- TS：`src/main/knowledge/engine.ts`（`ExtractEngine`，单并发、按 `nextDueAt` 唤醒）、`collector.ts`（`onQueued` 入队后唤醒）、`session.ts`（开关/游戏确认后唤醒）、`host.ts`（`extractNext/extractRun/extractFail` 与四个建议方法）、`src/main/index.ts`（引擎实例、`readBody` 走生产恢复、退出时 `stop()`、4 个受信 IPC）、`src/shared/knowledge.ts`（`Card.revision`、`QueueState` 增 `working|completed`、建议类型与方法名）、`src/shared/knowledgeSettings.ts`（`profileId`/`effort`）。

**实现要点**

- 占用与单并发：`extract.next` 用 `claim = clm_…` 把 `ready`（或稳定期已过的 `stabilizing`）任务改成 `working` 再返回；同一批次不可能被两个事件同时启动，重复 `claim` 在 `extract.run` 开头即被 `source_changed` 拒绝。
- 正文核对：`extract.run` 对每条输入重新 `sha256(text)` 与 `sources.fingerprint` 比对，版本不符返回 `source_changed`；主进程只提供自己按 source id 读到的正文。
- 分段与进度：单段 12 000 字符、段间重叠 500 字符，`extract_progress(source_id, version, segment)` 记录已完成段；未完成段则任务回到 `ready` 并保留 `remaining: true`，首段成功不等于整源完成。
- 模型预算：每批一次提炼调用（`maxTokens = 8192`，≤3 张卡），仅当存在候选时再调用一次比较；候选最多 8 条、合计 6 000 字符；`extract.run` 总期限 120 秒（`KNOWLEDGE_LIMITS.modelRequestMs`），普通 CRUD 仍 15 秒。
- 提交事务：卡片写入、来源关联、`card_history` 快照、`extract_progress`、组状态与 `changed` 通知在同一事务内完成；取消在提交前检查，失败或取消不留半张卡、不前进进度。
- 去重与修订：正文指纹相同则只补来源（`reference`），保留原正文与 `edited`；`merge` 仅当目标未人工编辑时执行，且先把旧版本写入 `card_history` 并使 `revision + 1`；目标已被人工编辑、结论冲突或依据不足时只写建议。
- 建议生命周期：`suggestion.list/get/accept/reject`；`accept` 在目标卡片 `revision` 与该建议记录的目标版本一致时才应用，否则把建议置为 `rejected`（原因"目标卡片已更新，建议已过期"）并返回 `source_changed`；同目标同草稿指纹的建议不重复写入，被拒绝的也不会因下一批而复活。`suggestions` 因此比原契约多一列 `fingerprint TEXT NOT NULL DEFAULT ''` 与索引 `suggestions_target`。
- 失败语义：`cancelled`/`source_changed` → `needs_reread`，其余（非法 JSON、陌生 source/target、超时、缺模型）→ `failed` 并清空 `claim`；合法空数组 → `completed` 且 `noKnowledge: true`，写入 0 张卡也算有结论。
- 关闭即静默（**经复核证伪并已修正，见下节 R4**）：最初只在「发起前」检查开关——批处理已在进行时关闭总开关，模型答案仍会写入卡片。现在关闭开关、手动/游戏暂停、来源失效、线程删除、取消与排除都会先取消在途请求，Rust 在提交事务里再次核对配置、暂停、来源状态与版本、占用、卡片修订与 `edited`、排除项，取消检查在 `commit()` 之前。`ExtractEngine` 在未运行、未启用或游戏态下不发请求，空闲等待上限 60 秒，不轮询全库。

**本轮验证（实际命令与退出码，依赖顺序执行）**

| 命令 | 结果 |
| --- | --- |
| `cargo fmt -- --check`（`native/knowledge`） | 0 |
| `cargo test --locked` | 0；15 lib + 8 extract + 11 process + 18 queue |
| `cargo clippy --locked --all-targets -- -D warnings` | 0（含 `--features fixture`） |
| `pnpm exec vitest run src/main/knowledge src/preload/index.test.ts src/main/ipc-trust.test.ts` | 15 文件 / 116 项通过 |
| `pnpm typecheck` | 0 |
| `pnpm test:native` | 0（6 个原生 crate 的恢复构建与测试） |
| `pnpm test` | 0；265 文件通过 / 3 跳过（268），3792 项通过 / 8 跳过（3800），98.96 s |
| `pnpm build` | 0（渲染层 `settings-*.js` 4,687.76 kB） |

交付产物：`native/bin/yu-knowledge.exe` 2,688,000 字节，SHA-256 `dc19de6b50f6f92289bcc20555326ca3aea9ced9d68b1070c0bc4e14af231fdd`（release）；调试用 `native/knowledge/target/debug/yu-knowledge.exe` `b80a88b9…` 与 `yu-knowledge-fixture.exe` `850a0ccc…` 不属于交付物。

**新增回归**

- Rust `native/knowledge/tests/extract.rs`（8 项）：稳定来源写成卡、同正文只补来源、空数组 `completed` 无卡、正文变更被拒并转 `needs_reread`、非法 JSON → `failed`、30 000 字符来源分三批且提示词 ≤12 500 字符、总开关关闭时 `source.publish` 与 `extract.next` 都按关闭处理、建议全生命周期（人工编辑后只出建议 → 过期建议被 `source_changed` 关闭 → 当前版本建议可接受并 `revision + 1` → 拒绝的同草稿不再复活）。
- TS `src/main/knowledge/engine.test.ts`（9 项）：未运行/未启用不请求、按 `nextDueAt` 等待、读正文后单批执行、正文缺失时不调用模型并释放占用、存储故障保持可重试、单并发、按设置传 `profileId`/`effort`、批次抛错不冒泡。
- TS `src/main/knowledge/extract.integration.test.ts`（2 项，真实 helper + 生产 host + 真实 `NotesStore` + 生产恢复）：队列里的随记经真实链路提炼成卡片并绑定来源；已人工编辑的卡片只得到建议，接受后才写入且 `revision` 增加。

**未测与边界**

- 仍以注入完成器代替真实模型：本阶段只证明程序规则，提示词质量与付费模型表现留待阶段 7。
- 未在打包后的 Electron 实例里跑真实启动/退出；`extract.run` 的 120 秒预算只以较短期限验证了超时与取消路径。
- 60 秒稳定期在测试中通过 `YU_KNOWLEDGE_STABLE_MS` 缩短；未做长时间多批并行压测。
- 页面、图谱、画像、聊天检索仍未开始（阶段 5、6）。
- 全量套件在本轮共跑四次，前三次各自出现不同失败：`src/main/windows-native-browser-url.test.ts` 的 30-pid 用例（单独运行 13 项全通过，48.9 秒）、`src/main/cloud.live.test.ts` 与 `src/main/providers/search-pool.test.ts` 的 `fetch failed`（`cloud.live.test.ts` 单独运行 3 项通过，462 毫秒，同期 `curl https://api.deepseek.com` 返回 401，说明网络正常）、以及 `src/main/providers/tts.test.ts` 的 `listen EACCES 127.0.0.1:49667`（临时端口占用）。这些用例与本阶段改动无关，属并发负载下的既有抖动；本轮没有放宽任何断言或跳过用例，第四次在最终代码上得到 265 文件 / 3792 项全绿。本轮自己新增的集成用例曾因采集在后台发布而抢跑，已改为等待队列与建议页出现（20 秒上限、25 毫秒步进），随后连续三次通过。

## 阶段 3 外部复核（2026-11-05，reportId `24ae72ae-c8ed-44ba-be33-59276fd4913c`）：未通过及 R1～R7 修复

修复提交：`6f9298e` `fix(knowledge): drain the queue and bound the extraction protocol`（本轮全部代码、测试、README 与本文件记录）。

复核基线 `0c55630…`，阶段起点 `4c05194…`。复核方实测通过并保留：定向 Vitest 15 文件 / **115** 项（原记录写成 116，以复核的 115 为准）、`git diff --check 4c05194..HEAD` 为 0、交付 release 哈希 `dc19de6b…` 一致。下列七项实测失败，因此阶段 3 本轮不验收；本轮只修这七项与其直接关联的契约、测试、文档。

### 失败与修复对照

| 项 | 实测失败 | 修复 |
| --- | --- | --- |
| R1 一次唤醒只推进一个任务 | 两个 `ready` 组只产生 `modelCalls=1` | `ExtractEngine.tick()` 循环 `extract.next` 直到无任务/未到期/暂停；忙时到达的唤醒记为 `again`，批次结束后补跑；历史扫描、显式重试、解除暂停也会唤醒；无到期任务时不保留定时器 |
| R2 失败后任务永久 `working` | 读正文 I/O 错误、模型非法 JSON、未配置完成器都留下 `working`/`error=null`，`retryTask` 报 `invalid_params` | 取到占用后每条退出路径都由 `extract.fail` 带显式 code 结算；区分模型失败/超时/非法输出、来源缺失/变更、I/O；`store.rs` 启动时把上次进程遗留的 `working` 转为 `failed`（原因「进程已退出，任务未完成」）并清空 `claim`，保留已提交的分段进度；不做自动付费重试 |
| R3 阅读材料进不了提炼 | 引擎接到 `knowledgeRecovery`，阅读来源一律 `unknown`，真实阅读批次 `failed`/`来源暂时无法读取`、`modelCalls=0` | `KnowledgeCollector.resolveBody()` 从 16 MiB 内存暂存返回**材料正文本身**（即发布时记录的指纹所对应的文本），问答上下文只留在 `scope`；引擎 `readBody` 改走它；暂存淘汰/重启/关闭 → `needs_reread`（`fail` 新增 `needs_reread` 映射） |
| R4 提交前缺少取消/失效/删除/编辑保护 | 等待模型期间 `queue.pause`、`source.invalidate` 仍写卡；删除同源卡后仍重建；关闭总开关时 `signal.aborted=false` 且完成写卡；`card.update {edited:false}` 能清掉人工编辑标记 | `ExtractEngine.abort()` → `host.cancelInFlight()`（对在途 `extract.run` 写 `cancel` 帧并结算）；`syncKnowledge` 在关闭/进入游戏后先 abort；暂停 IPC 先 abort 再落标志；Rust `apply()` 在事务内重查开关+暂停、组占用、来源状态/版本/指纹、分段未完成、两类排除、`card.revision` 与 `edited`，`ensure_not_cancelled()` 在 `commit()` 前；`card.update` 的 `edited` 入参删除，人工更新恒置 `edited = true` |
| R5 非法结构当成功 | `{}` 返回 `ok=true, noKnowledge=true, state=completed`；引用未发送的 `segment 999` 仍建卡 | 只有显式合法 `{"cards": []}` 才算无知识；`cards` 必须是数组、每张卡字段与类型齐全、正文 ≥30 字符、来源必须属于本批且分段号确实发送过；`reference/merge/propose` 缺合法目标即 `invalid_output`；只接受一段完整的 ```json 围栏，混杂内容拒绝 |
| R6 预算超支与合并丢内容 | 一份草稿对同一候选连调三次比较（`modelCalls=4`）；`apply` 用草稿正文覆盖 `cards.body`，合并丢掉原结论 | 每批最多一次提炼 + 一次共享比较；候选按批累计 ≤8 条、≤6 000 字符；正文指纹已相同的草稿跳过比较；合并改为「原正文 + 新的补充」追加，无法保证保留时降级为建议 |
| R7 整组塞进一帧 | 四个 200 000 字符来源使 `extract.run` 帧达 2 400 631 字节，真实 helper 返回 `too_large` | `extract.next` 改为返回**读取计划**（`items: [{sourceId, version, segment, start, end}]` 字符区间，不含正文）；主进程按区间切片并附整源指纹；`extract.run` 只带本批需要的分段，单段 ≤12 000 字符；帧上限仍是 2 MiB，不截断来源 |

### 本轮落地位置

- Rust：`extract.rs`（读取计划、严格输出校验、单次比较、合并追加、提交前重查）、`suggestions.rs`（不受影响）、`store.rs`（启动修复 `working`）、`cards.rs`（`update` 不再接受 `edited`）。
- TS：`src/main/knowledge/engine.ts`（重写：排空循环、区间读取、显式结算、`abort`）、`host.ts`（`cancelInFlight`）、`collector.ts`（暂存材料正文、`resolveBody`、`clear()` 归还任务）、`session.ts`（关闭/游戏先 abort）、`src/main/index.ts`（引擎 `readBody` 走 `resolveBody`、暂停与重试接线）、`src/shared/knowledge.ts`（`ExtractItem`、`items` 协议、`skipped`）。

### 新增回归（真实 helper，生产 host/engine，不借助 `card.save`）

- `native/knowledge/tests/extract.rs`（11 项）：读取计划只带区间、超长来源分三批且每批 ≤12 000 字符、非法/缺字段/陌生分段被拒且不写卡、伪造指纹 `source_changed`、暂停期间完成仍不写卡、合并保留原结论并 `revision + 1`、三份草稿只调用两次模型、进程退出后任务不停在 `working` 且可重试。
- `src/main/knowledge/engine.test.ts`（14 项）：一次唤醒排空两组、只读计划区间、整源指纹随批发送、正文缺失/暂存失效分别结算、模型错误码透传、关闭开关时批次转 `paused`、忙时唤醒不丢、`abort` 走 host、停止后不再请求。
- `src/main/knowledge/repair.integration.test.ts`（5 项）：两条随记一次唤醒全部完成（同结论只补来源）、阅读材料经内存暂存取到正文并成卡、暂存清空后任务转 `needs_reread` 且不写卡、模型答非 JSON 后任务 `failed` 且可重试成功、等待回答时暂停并取消 → 不写卡。

### 本轮验证（实际命令与退出码，依赖顺序执行，最终代码上各跑一次）

| 命令 | 结果 |
| --- | --- |
| `cargo fmt -- --check`（`native/knowledge`） | 0 |
| `cargo test --locked` | 0；15 lib + 11 extract + 11 process + 18 queue |
| `cargo clippy --locked --all-targets -- -D warnings` | 0（含 `--features fixture`） |
| `pnpm exec vitest run src/main/knowledge src/preload/index.test.ts src/main/ipc-trust.test.ts` | 16 文件 / 125 项通过 |
| `node scripts/build-native.mjs` | 0（release helper 重新构建） |
| `pnpm typecheck` | 0 |
| `pnpm test:native` | 0（6 个原生 crate 的恢复构建与测试） |
| `pnpm test` | 0；266 文件通过 / 3 跳过（269），3802 项通过 / 8 跳过（3810），100.27 s |
| `pnpm build` | 0（渲染层 `settings-*.js` 4,687.76 kB） |

交付产物（release，重新构建后实测）：`native/bin/yu-knowledge.exe` 2,704,896 字节，SHA-256 `62ade61d28668f28ba8c432dce890fc5725ae1d8c0f187ff9266c4fab1ea09a0`。调试与夹具二进制（`native/knowledge/target/debug/yu-knowledge.exe`、`yu-knowledge-fixture.exe`）不属于交付物。

**未测与边界**：本阶段仍以注入完成器代替真实付费模型（0 次真实模型调用）；未在打包后的 Electron 实例里跑启动/退出；120 秒总预算只以较短期限验证取消路径；60 秒稳定期由 `YU_KNOWLEDGE_STABLE_MS` 缩短；无大批量并发压测。本轮全量套件一次通过，前几轮出现过的 `windows-native-browser-url` 30-pid、`cloud.live`/`search-pool` `fetch failed`、`tts` `listen EACCES` 抖动本轮未复现，也未放宽任何断言。

## 阶段 3 外部复核（第二轮，2026-11-05，reportId `192782d4-6803-4d1e-808e-3a0613cb351c`）：T1～T5 修复

外部在本轮基线 `3ae28e14d7b519077608ca5e098a78659fab46a8` 上确认通过：定向 Vitest 16 文件 / 125 项、`cargo test --locked --test extract` 11 项、`git diff --check 0c55630..HEAD` 为 0、release 2,704,896 字节与哈希 `62ade61d…` 一致；并用独立探针确认跨组排空、阅读材料经暂存提炼、非法 JSON/缺模型转 `failed`、关闭总开关不写卡、Rust 提交保护（暂停/失效源/同源删卡）、`{}` 与伪造分段 `invalid_output`、`edited` 不可清零、4×200 000 字符与 201 来源边界。以下五项仍不通过，本轮只修这些。

### 失败与修复对照

| 项 | 实测失败 | 修复 |
| --- | --- | --- |
| T1 历史扫描后不唤醒引擎 | 空闲引擎（无定时器）后由生产 `HistoryDriver.start` 完成扫描：`scan=completed`、`modelCalls=0`、`queue=[ready]`、`engineTimer=false` | `HistoryDriver` 新增 `onBatch` 通知，只在批次**真的提交**（`step.job.scanned` 增长）时触发；`src/main/index.ts` 接 `onBatch: () => extractEngine.wake()`。首次扫描与恢复扫描同路径，仍受手动暂停/游戏模式/总开关/`nextDueAt` 约束，不引入全库轮询 |
| T2 读正文异常逃出结算边界 | `runGroup` 的 `readBody` 在 `try` 之外抛错时，活着的 helper 上任务持续 `working`，只有重启后的启动修复才转 `failed` | `runGroup` 取下占用后整条链路（解析/读取/切片/模型/结果）交给统一结算边界 `execute()`；`MissingSource` 按其 code 结算（来源缺失走既有缺失语义），其它异常记录「读取正文失败：…」并结算 `internal`，不把 store 异常一律当删除，也不吞掉真实错误 |
| T3 比较期间目标被删仍新建并提交 | 目标卡只关联旧来源、新批次只引用新来源时，在比较回调中 `card.delete` 目标后回复 `merge(oldTarget)`：`runOk=true, cards=1, progress=1, completed` | `judge()` 的 `reference/merge/propose` 目标必须经 `known()` 存在性校验，缺失返回 `source_changed`（「比较目标已不存在（可能已被删除）」），不再落到新建分支；`moved_under_us()` 额外拒绝判定后 revision 已变化的目标；精确匹配同样复核目标当前内容/指纹后再挂来源；保留人工编辑与同源删卡排除保护 |
| T4 单渠道关闭不 abort，正常停机被记成重读/失败 | 仅关闭 notes 渠道时 `signal.aborted=false`，放行后任务转 `needs_reread`（来源其实可读）；生产游戏进入顺序 `syncKnowledge(game=true)` → `stop` 后重开 helper 任务为 `failed` | `collector.sync()` 返回本次真正关闭的渠道（`{ closed }`），`syncKnowledge` 对其逐个 `engine.abortChannel()`；关闭/进入游戏时先 `await engine.park()` 再 `knowledge.stop()`（`extract.fail` 先落库）；`extract.rs::fail` 把 `cancelled|paused` 映射为 `ready`+`stable_at`（停放，可继续），`source_changed` 才转 `needs_reread`，其它故障才 `failed`；退出游戏/解除手动暂停/重开渠道后同一正文继续，无需重读网页，手动暂停不被游戏恢复覆盖 |
| T5 `extract.next` 仍整组下发元数据 | 450 个来源（`originRef` 395 字符、title 200、scope 1000）时 `extractNext` 返回 `too_large`，组停在 `working=1` | 读取计划与来源描述按**实际 UTF-8 JSON 字节**一起打包：`HEADROOM_BYTES = 4_096`，预算取 `RESULT_BUDGET_BYTES - HEADROOM_BYTES`；只为保留的 items 附带描述，后续 item 以 `sourceId` 引用首次出现的描述；至少保留一项保证推进；序列化失败即释放占用并返回 `internal`，不留无计划占用。2 MiB 上限不变，不截断来源，下一批按已提交进度继续 |

### 本轮落地位置

- Rust：`extract.rs`（字节预算读取计划、目标存在性/版本复核、停放语义）、`protocol.rs`（沿用 `RESULT_BUDGET_BYTES`）。
- TS：`engine.ts`（`park()`/`abortChannel()`/统一结算边界 `execute()`/`read()`）、`history.ts`（`onBatch` 提交后通知）、`collector.ts`（`sync()` 返回本次关闭的渠道）、`session.ts`（关闭与游戏先停放再停机、逐渠道取消后唤醒）、`src/main/index.ts`（`onBatch` 接线）。

### 新增回归（真实 helper + 生产 host/engine/HistoryDriver）

`src/main/knowledge/residual.integration.test.ts`（9 项）：T1 空闲引擎 → 生产 `HistoryDriver.start` 扫描后组自动完成（测试内不调用 `wake`/`tick`）；T2 `readBody` 抛 `EIO` → 立刻 `failed`、`working 0`、helper 未重启，故障消除后显式重试完成；T3 `reference`/`merge`/`propose` 三例在比较回调内删除目标 → 0 张替身卡、无已提交进度、`working 0`，另加「比较期间人工改卡」只产生一条有效建议且不覆盖正文；T4 仅关闭 notes 渠道 → provider `signal.aborted`、0 卡、任务留 `ready`，重开渠道后同一任务完成且 `needs_reread 0`，游戏模式先停放再 `host.stop()`，重启后为 `ready` 并在游戏结束后完成；T5 450 条长元数据来源 → 单组、全部可达（`seen.size === 450`）、计划确实分批、`completed`、`working 0`。

### 本轮验证（实际命令与退出码，依赖顺序执行）

| 命令 | 结果 |
| --- | --- |
| `cargo fmt -- --check` | 0 |
| `cargo test --locked` | 0；15 lib + 11 extract + 11 process + 18 queue |
| `cargo clippy --locked --all-targets -- -D warnings`（含 `--features fixture`） | 0 |
| `pnpm exec vitest run src/main/knowledge src/preload/index.test.ts src/main/ipc-trust.test.ts` | 17 文件 / 134 项通过 |
| `node scripts/build-native.mjs` | 0（release helper 重新构建） |
| `pnpm typecheck` | 0 |
| `pnpm test:native` | 0 |
| `pnpm test` | 0；267 文件通过 / 3 跳过（270），3811 项通过 / 8 跳过（3819） |
| `pnpm build` | 0（渲染层 `settings-*.js` 4,687.76 kB） |

交付产物：`native/bin/yu-knowledge.exe` 2,714,624 字节，SHA-256 `00ea3c33761468ccb41c1f18a9a7607bbb2c509c370aa1eaf8e487d397e9fece`

实现提交：`79e6f5e`（`fix(knowledge): settle every claim, bound the plan and park cleanly`）。上述验证在同一份代码的提交前工作区上各跑一次，提交内容与该工作区一致。

**未测与边界**：真实付费模型调用 0 次（注入完成器）；未在打包后的 Electron 实例中跑启动/退出；120 秒预算只以较短期限验证取消；60 秒稳定期由 `YU_KNOWLEDGE_STABLE_MS` 缩短；未对 450 来源以上规模做并发压测。

### T3 补充：比较期间版本变化时的 merge 建议（2026-11-05，reportId `294d7136-c80e-478c-9f8c-828c2c69649d`）

外部在 `15737f5` 上确认通过：定向 Vitest 17 文件 / 134 项、`cargo test --locked --test extract` 11 项、`git diff --check 3ae28e1..HEAD` 为 0、release 哈希一致；并定点重放通过 T1（空闲后扫描自动提炼、结束无 timer）、T2（读 I/O 抛错立即 `failed`/`working 0`、同 helper 修复读取后可重试完成）、T4（渠道关闭 abort 并停放 `ready`、重开自动完成、手动暂停不被游戏恢复覆盖、游戏进入先 park 后 stop、退出续跑）、T5（450 条长元数据按预算分批 200/200/50，最大请求 52,577 字节、结果 1,044,038 字节，模型正文 ≤5,400 字符）以及 T3 的「目标被删」三例。

仍有一处未通过：比较期间人工改卡后，旧的 merge 草稿被重新绑到新 revision 上，`suggestion.accept` 版本比较因此通过，旧草稿覆盖了人工正文。

| 项 | 实测失败 | 修复 |
| --- | --- | --- |
| T3 陈旧 merge 建议 | 目标卡 revision1、模型比较所见 revision1；等待比较回复期间 `card.update` 改成 revision2（`edited=1`）；模型返回基于 revision1 的 merge → `apply` 走 `edited != 0 \|\| moved` 分支并以**当前** revision2 生成 open 建议（`target_revision=2`），`runOk=true`、提交进度；随后 `suggestion.accept` 版本比较通过，人工正文被覆盖 | merge 分支把「比较后版本已变化」与「比较前就已人工编辑」分开：前者与 `reference`/`propose` 一致，直接 `source_changed`（「目标卡片在提炼期间已更新」），事务不写卡、不写分段完成、不生成可接受草稿，由既有 `extract.fail` 结算（`source_changed → needs_reread`）；只有「比较前已 `edited` 且期间 revision 未变」才 `suggest`，且绑定模型实际所见的 revision。`suggestions::accept` 的 revision 校验语义不变，用户仍可接受有效建议 |

落地：`native/knowledge/src/extract.rs`（merge 分支）。

新增/修正回归（真实 helper + 生产 host/engine，`src/main/knowledge/residual.integration.test.ts`，现 11 项）：

1. 比较期间人工改到 revision2 后返回 merge → 人工正文/`edited`/revision 保留，**没有**可接受建议（`listSuggestions().total === 0`），无新卡，`working 0`，本批明确 `needs_reread`（`source_changed` 结算），已完成计数不增加。
2. 比较前就已 `edited`（revision2）、期间未变 → 生成绑定 `targetRevision = 2` 的建议；`acceptSuggestion` 成功，正文按草稿更新、`revision = 3`、`edited` 仍为真、两条来源都在。
3. 该有效建议生成后再人工改到 revision3 → `acceptSuggestion` 拒绝（`source_changed`），revision3 正文不变，建议按既有语义置为 `rejected`。

验证（实际命令与退出码）：`cargo fmt -- --check` 0；`cargo test --locked` 0（15 lib + 11 extract + 11 process + 18 queue）；`cargo clippy --locked --all-targets -- -D warnings` 0（含 `--features fixture`）；`node scripts/build-native.mjs` 0；`pnpm exec vitest run src/main/knowledge src/preload/index.test.ts src/main/ipc-trust.test.ts` 17 文件 / 136 项通过；`pnpm typecheck` 0。本轮只改 Rust 与该回归，未重跑 7 crate 与整仓长测试。

交付产物：`native/bin/yu-knowledge.exe` 2,714,624 字节，SHA-256 `f0359af8b3937fe427efcb67b4d0465123f539a56caff012a9cadaf94fb9fb12`（MSVC 重建哈希可能变化；debug/fixture 不计入交付）。实现提交 `0f42024`。未测：真实付费模型 0 次；未在打包 Electron 实例中运行。

## 阶段 4 实施记录（2026-11-05，DSH 执行会话 session-e4795148-53a3-4afd-b014-730be9b3c9f1）

**状态：阶段 4 外部复核未通过，P1～P6 与 T1～T4 的修复均已提交（见文末两节），等待外部复核。阶段 5～7 未开始；用户可见的画像页面尚未开放，但后台画像与上下文字符串已经可读。**

### 契约（本阶段对外行为）

设置块 `Settings.userProfile`：`{enabled:false, usage:true, chat:true, profileId:null, effort:'high'}`。与知识库开关完全独立：知识库关、画像开可正常工作，反之亦然；两者都关时不启动 helper、不新建数据库、不排定时器。

RPC（全部经 `handle()`／`knowledgeOwner`，渲染进程不能提交正文、根目录、SQL 或提示词）：

| 方法 | 用途 |
| --- | --- |
| `profile.configure` | 同步 `enabled/usage/chat/pausedManual/pausedGame`，返回状态 |
| `profile.pause` | 手动暂停/恢复（与游戏暂停分开存储，互不覆盖） |
| `profile.status` | 开关、暂停原因、待处理条数、条数、统计总数、`nextDueAt` |
| `profile.event` | 幂等记录一次已完成动作（`op_id` 去重），立即聚合到按天/按功能 |
| `profile.evidence` | 入队用户本人语句（超长按 Rust 选定分段切分，>200000 字符显式 `too_large`） |
| `profile.learn.next` / `.run` / `.fail` | 取批次（claim）、一次模型归纳、释放 claim |
| `profile.context` | 只读上下文（≤2000 字符，带条目 id/类别） |
| `profile.retract` | 会话删除/转临时后撤回证据 |
| `profile.clear` | 清空统计、待处理正文、条目与证据，并留下清除屏障（`cleared_at` + 幂等标记） |
| `profile.retry` | 人工把 `failed` 的暂存项放回 `pending`（唯一的重试入口） |

数据模型（`data/profile/profile.db`，`PROFILE_SCHEMA = 3`；阶段 4 首次实现时为 2，P5 复核后升到 3）：`profile_items.slot`（稳定身份）、`profile_control(key, value, updated_at)`（开关、暂停原因、`cleared_at` 屏障、`epoch`）、`profile_usage(day, feature, count)`（按天/功能聚合）、`profile_usage_ops(op_id, feature, at)`（动作幂等窗口，30 天后回收）、`profile_pending(id, source_kind, source_id, version, segment, origin_ref, locator, text, state, claim, reason, at, updated_at)`（活动暂存，状态只有 `pending|working|failed`，归纳成功后整行删除、不留正文）、`profile_source_state(source_kind, source_id, state, reason)`（来源撤回后为 `invalid`）、`profile_markers(source_kind, source_id, version, segment, created_at)`（已处理证据的轻量幂等标记，不存正文）。没有 `profile_events`、`profile_claims`、`profile_progress`，也没有 `profile_evidence.state`。知识库库仍是 `KNOWLEDGE_SCHEMA = 5`；两个库独立清空，无跨库外键或分布式事务。

稳定身份：`save` 以 `slot`（缺省为 `dimension`）为准，同一 slot 的再次写入是覆盖而不是新增；人工纠正/固定/删除留下的是 slot 级排除，自动写入既不能改值也不能靠新 id 绕过；`profile.save` 不再按 `(dimension,value)` 匹配。

学习预算：单批 ≤12000 字符用户材料、≤8 条候选条目（≤4000 字符）、一次归纳请求、`maxTokens ≤ 4096`、120 秒总预算、最多 6 条有效更新，无事可写时返回显式空数组；无隐式重试、无第二次比较、无向量检索。`profile.learn.run` 与 `extract.run` 一样通过 `model.request` 父子协议借用既有的 `KnowledgeHost` + `createKnowledgeCompleter`；未配置 profile 时由主进程解析“第一个可用模型”（与知识库共用同一规则），不在 Rust 里各猜一份。

### 实现

Rust（`native/knowledge/src/`）：`store.rs` 增加 `PROFILE_LEARN_SQL`（阶段 4）与 `PROFILE_MARKER_SQL`（复核修复）迁移，并在打开画像库时把 `working` 残留标成可重试的 `failed`；`profile.rs` 增加 `slot`、槽位级排除与「手改即视为人工更正」；`profile_learning.rs`（控制、幂等统计、分段入队、容量与屏障检查、批次 claim、单次归纳、候选快照校验、原子写入、retract、clear 屏障、优先级上下文）；`service.rs`/`lib.rs` 挂载 `profile.*` 十二个方法。

主进程：新增 `src/main/knowledge/profile.ts`（`ProfileCollector`：把真实完成点的事实交给 helper、只持有一次唤醒与一个 in-flight 批次、`park()` 只取消 `profile.learn.run`）；`session.ts`、`engine.ts`、`host.ts` 增加 `cancelInFlight(reason, only)` 以便两个模块各取消自己的批次；`src/main/index.ts` 接上聊天完成、浮动提问完成、随记创建、手动改卡四个真实入口，游戏进入先 park 再 stop、退出后恢复，`settings:update` 与启动各自同步两个模块的开关；新增 `profile:pause`、`profile:clear`、`profile:context` 三个受信通道并在 `api.ts`/`preload` 镜像。

### 验证（实际命令与退出码）

| 命令 | 结果 |
| --- | --- |
| `cargo fmt -- --check` | 0 |
| `cargo test --locked` | 0（15 lib + 11 extract + 11 process + 11 profile + 18 queue） |
| `cargo clippy --locked --all-targets -- -D warnings` | 0（含 `--features fixture`） |
| `pnpm exec vitest run src/main/knowledge src/main/chat.test.ts src/main/notes.test.ts src/preload/index.test.ts src/main/ipc-trust.test.ts` | 20 文件 / 208 项通过 |
| `pnpm typecheck` | 0 |
| `pnpm test:native` | 0（7 个 crate 全部构建并测试通过） |
| `pnpm test` | 0（268 文件通过 / 3 跳过；3819 项通过 / 8 跳过） |
| `pnpm build` | 0 |
| `git diff --check` | 0（提交前）；提交后再核对 `git diff --check 7987aed..HEAD` 与 `git status` |

新增回归 `src/main/knowledge/profile.integration.test.ts`（真实 helper + 生产 `KnowledgeHost`/`ProfileCollector`，6 项）：开关关闭时不启动任何进程、不建库且上下文为空；同一次完成重复上报只计一次、统计立即可查且 0 次模型调用；用户自己的句子经一次归纳写成带原文引用的条目，上下文可读且 ≤2000 字符，同时证明知识库渠道仍为关闭（两模块互不影响）；清除后迟到的模型答复不能复活条目（人工固定条目先写、随后 clear，上下文为空、条目 0）；游戏进入 park 后 `pausedGame` 为真、退出恢复后排队证据被消费；手动暂停期间证据不丢、恢复后立刻处理。

未测与边界：未调用真实付费模型（全部为注入 completer）；未在打包 Electron 实例里运行；30 天窗口以注入时间验证；上下文只有字符串，尚未接入回答（阶段 6）。

实现提交：`df335c3` `feat(knowledge): run the user profile loop in the background`。交付产物：`native/bin/yu-knowledge.exe` 2,863,616 字节，SHA-256 `0d53a348ef6541f358787cad86d70d61a5d25eb754d6c9618e2bd284bfa08341`（MSVC 重建哈希会变；debug/fixture 不计入交付）。

## 阶段 4 复核问题修复（2026-11-05 第四轮，P1～P6）

外部复核在 `fe3f127` 上判阶段 4 未通过（reportId `3c6b1b49-b492-457f-b8a0-92a507d5e1e7`），并给出六组真实缺陷。本节记录实测失败与修复，不覆盖上文已交付记录。

| 项 | 外部实测失败 | 修复 |
| --- | --- | --- |
| P1 证据不唤醒归纳、统计口径错 | 引擎空闲后调用生产 `completedChat`：`pending=1、modelCalls=0、timer=false`；旧随记仅改正文也计入「创建」；Rust 手动暂停后 `recordProfileEvent` 仍 `counted=true` | 入队成功即 `wake()`（重复投递 `queued:0` 不触发、不花模型调用）；随记 `onSettled(note, event)` 区分 `created/updated`，只有真正创建计入；卡片编辑用 `card:${id}:${revision}` 作操作身份；`record_event` 与 `enqueue` 都先看 `enabled/usage/chat/pausedManual/pausedGame` |
| P2 取消不释放、重启不恢复、模块互杀 | 关画像总开关/chat 后 `signal.aborted=false`、行永久 `working`；手动暂停 `cancelled` 分支直接 return；`ExtractEngine.abort` 无过滤取消，关知识库会误杀画像批次 | 每个 claim 的退出路径显式结算：`cancelled/paused → release()` 回 `pending`，`source_changed/retracted → drop_claim()`，其余 `failed`；`Store::open` 把 `working` 残留改成 `failed`（`助手中断，需重试`）；新增 `profile.retry` 为唯一重试入口，`profile.status` 给出有界 `failed/failedItems`；`engine.abort()` 只取消 `extract.run`，`ProfileCollector.park()` 只取消 `profile.learn.run` |
| P3 人工更正被覆盖、slot 未受控 | 在途 `profile.update` 只改值不改 `corrected`，旧回复覆盖人工值；pinned 后可另建矛盾项；同批两个 focus 互相覆盖到 1 条 | 手改值即视为更正（`corrected = 原值 or 值已变`）；候选带 `Candidate{id,slot,dimension,updated_at}` 快照，写入前核对 `updated_at`，人工更正/固定/删除后旧回复一律跳过；自动输出只能引用本批候选的 slot，未知 slot 直接 `invalid_output`；`project/focus` 等可并存维度按值派生 slot（`dimension:hash12`），单值维度用快照 slot；排除同时按 slot 与 `dimension=value` 生效；提示词附带 ≤20 条、≤400 字符的 `removed` 列表，避免换措辞绕过（不增加第二次模型调用） |
| P4 清空/撤回后旧证据可重放、schema1 排除丢失 | `clear` 后重放同 source/version 仍 `queued=1` 并重新归纳；`retract` 后重放也能重建；schema1 的 `dimension=value` 排除在迁移后失效 | `clear` 写入 `profile_control.cleared_at` 屏障并给在途/待处理证据打 `profile_markers`；`enqueue` 拒绝 `at <= cleared_at`、来源 `invalid`、命中标记的项；撤回同样落标记；迁移保留 schema1/schema2 的条目、证据、固定/更正与 `dimension=value` 排除 |
| P5 容量静默丢任务 | 200 条 `done` 后第 201 条 `queued:1` 但随后被 `prune` 删掉，`learn.next.batch=null`；`done` 仍留全文 3690 字符 | `profile_pending` 只装活动工作（`pending/working/failed`），成功归纳后整行删除、改记 `profile_markers`；`enqueue` 先整批规划再写：`active_rows + planned > 200` 或 `active_chars + chars > 240000` 时返回 `{queued:0, reason:"capacity", capacity, pending}` 且一条不写；`prune` 只回收 30 天前的标记，从不裁剪待处理队列 |
| P6 观察时间错、稳定偏好误过期、使用观察不可读 | 31 天前的 focus 被标 `recent=true`（`attach` 写了学习时刻）；明确 depth 偏好因证据超 30 天从上下文消失；`context` 从不读 `profile_usage` | `attach` 写真实 `at`（观察时间）；`context` 只对 `project/focus` 施加 30 天近期窗口，明确稳定偏好按人工固定/更正优先保留，并追加 `- 近期常用：{feature} {count} 次`（来自 `profile_usage` 的窗口聚合） |
| 文档 | 计划与 README 写了 `PROFILE_LOOP_SQL`、`profile_events`、`profile_claims`、`profile_progress`、`profile_evidence.state` 与「处理后删除正文」 | 已按真实实现改写：`PROFILE_LEARN_SQL`/`PROFILE_MARKER_SQL`、`profile_control`/`profile_usage`/`profile_usage_ops`/`profile_pending`/`profile_source_state`/`profile_markers`，并说明成功后正文即删 |

接口变化（仅本阶段）：新增 `profile.retry`；`profile.status` 增加 `failed` 与有界 `failedItems[{id,reason,chars,at}]`；`profile.clear` 返回 `clearedAt`；`profile.context` 返回 `recent` 与使用观察行；画像 schema 由 2 升到 3（新增 `profile_markers`），知识库 schema 仍为 5。

### 新增回归

Rust `native/knowledge/tests/profile.rs` 现 20 项（原 11 项 + 9 项）：手改即更正且在途旧回复不能覆盖；两个 focus 并存且伪造 slot 被拒；容量不足整批拒绝且不丢任务（200 条满后第 201 条先 `capacity`、归纳完再 `queued:1` 并被处理）；清空/撤回后原样重放不入队不重建；31 天前 focus 不算近期而明确偏好保留且「近期常用」可读；暂停冻结统计与入队、恢复后继续；真实模型失败只能经 `profile.retry` 恢复且 `status.failed` 可读；删除的偏好被列入提示词并在返回时被拒；真实进程崩溃（kill）后重启把在途批次标成可重试失败并成功重试。

`src/main/knowledge/profile.integration.test.ts` 重写为 8 项（真实 helper + 生产 `KnowledgeHost`/`ProfileCollector`，0 次付费模型）：开关关闭不启动进程；同一次完成重复上报只计一次且只调一次模型；用户句子仅靠真实证据（测试内**不调用** `wake()`）自动归纳出带原文引用的条目；清空时 completer 真的停在 gate 上、放行后迟到回复不能复活条目；仅关闭知识库时画像批次照常完成（`cancelInFlight('采集已暂停','extract.run')`）；真实失败只经 `profile.retry` 恢复；游戏 park/pause 在批次真正在途时取消，待处理数归零后恢复并继续。

`src/main/notes.test.ts` 现在断言 settled 事件为 `created:`/`updated:`，证明既有笔记编辑不算新建；`engine.test.ts` 断言 `cancelInFlight('采集已暂停','extract.run')`；`host.integration.test.ts`/`loop.test.ts` 的 ready 契约改为 `{knowledge:5, profile:3}`。

### 验证（最终代码，实际命令与退出码）

| 命令 | 结果 |
| --- | --- |
| `cargo fmt -- --check` | 0 |
| `cargo test --locked` | 0（15 lib + 11 extract + 11 process + 20 profile + 18 queue = 75 项） |
| `cargo clippy --locked --all-targets -- -D warnings` | 0（含 `--features fixture`） |
| `node scripts/build-native.mjs` | 0（只用 20.67 s 重建 knowledge crate） |
| `pnpm exec tsc --noEmit -p tsconfig.node.json` / `-p tsconfig.web.json` | 0 / 0 |
| `pnpm exec vitest run src/main/knowledge src/main/chat.test.ts src/main/notes.test.ts src/main/assistant.test.ts src/preload/index.test.ts src/main/ipc-trust.test.ts` | 0（21 文件 / 267 项） |
| `pnpm test:native` | 0（7 个 crate 全部构建并测试通过） |
| `pnpm test` | 0（268 文件通过 / 3 跳过；3821 项通过 / 8 跳过；98.75 s） |
| `pnpm build` | 0（`settings-*.js` 4,687.76 kB） |
| `git diff --check` | 0（提交前） |

交付产物：`native/bin/yu-knowledge.exe` 2,891,264 字节，SHA-256 `3bbf5711eb35fcb2d5f851ff6355dec6db369c9c3d1eae1e4717e2ca311dc889`（MSVC 重建哈希会变；debug `native/knowledge/target/debug/yu-knowledge.exe` 与 fixture `yu-knowledge-fixture.exe` 不计入交付）。

实现提交：`c30df7e` `fix(knowledge): close the stage 4 profile loop review gaps`。

未测与边界：未调用真实付费模型（全部为注入 completer，模型调用次数由测试断言为 0 或 1）；未在打包 Electron 实例内运行；30 天窗口用注入时间验证，未等待真实日历；画像页面与聊天检索仍属阶段 5～7，`profile.context` 目前只有主进程消费者；`profile.retry` 只把 `failed` 放回 `pending`，不做自动重试。

## 阶段 4 剩余复核修复（T1～T4，2026-11-05 第五轮，reportId `67b11b40-166f-4cf1-8111-6e0a081380e8`）

外部复核在 `1944446` 上判阶段 4 仍未通过：P1～P6 的修复范围通过（21 文件 / 267 项 Vitest、`cargo test --locked --test profile` 20 项、`git diff --check fe3f127..HEAD`、交付哈希 `3bbf5711…`），但留下 T1～T4 四组控制/事务边界缺口。本节记录实测失败与修复，不覆盖上文已有的失败记录。

| 项 | 外部实测失败 | 修复 |
| --- | --- | --- |
| T1 控制操作与 claim 释放不同步 | 模型调用在途时关总开关／关 chat／暂停，信号虽被中止，数据库仍是 `working` 加 claim；重新打开后 230 ms 内行确实回到 `pending`（`modelCalls` 仍为 1），但恢复时的唤醒已经看过空队列，之后再没有唤醒 | 释放放进写控制状态的同一个 Immediate 事务：`profile.configure` 在最终状态会停止循环时（`!enabled \|\| !chat \|\| pausedManual \|\| pausedGame`）执行 `UPDATE profile_pending SET state='pending', claim=NULL WHERE state='working'`，控制回包即代表释放已提交；`ProfileCollector.sync()` 改为先 `stop()` + `cancelInFlight('profile.learn.run')`，再 `await configureProfile`，最后按状态 park 或 `wake()`。迟到结算只作用于自己的 claim：`release()` 带 `state='working' AND claim=?` 条件，被重新领取的行不会被退回 |
| T2 清空屏障不覆盖使用事件、关闭期撤回失效、来源失效仍进上下文 | 清空后重放同一 `opId`/`at` 仍 `counted=true`、`usageTotal` 回到 1；画像开关关闭时 `retractThread` 因 `enabled=false` 提前返回，重开后仍从已删除对话学习；自动条目唯一证据被撤回后 `context` 仍在引用（稳定偏好的时间例外盖过了来源有效性） | `record_event` 在自己的事务内用 `at <= cleared_at` 拒绝清空之前的事件（清空会删掉操作日志，屏障必须由判断承担）；`retractThread` 在 `host.running \|\| host.hasProfileData()` 时照常执行，关闭期也能撤回且先于恢复学习生效，从未创建过的画像仍不建库；`context` 增加 `origin` 与 `valid_evidence` 计数（按 `#` 截断来源 id 后匹配 `profile_source_state`），`!protected && origin != "manual" && valid == 0` 的条目退出上下文，条目详情仍返回 `evidence[].withdrawn` 供管理 |
| T3 容量不计 failed、旧 done 正文留存 | 造出 200 条失败后第 201 条仍 `queued=1`（201 行 / 6523 字）；真实 schema2 库中一条 `done` 行在启动后 `user_version=3` 但 31 字正文仍在、`markers=0` | `active_usage` 计入 `pending/working/failed`（失败行仍保存待重试正文）；`Store::open` 每次打开都把 `state='done'` 行转成 `profile_markers` 再删除，schema2 升级与已在 schema3 的库同样生效；`retry` 只把已有失败放回队列，不产生新工作；`enqueue` 的容量拒绝带 `reason:"capacity"`，`ProfileCollector` 单独记一条「画像证据已满」日志，与重复投递区分 |
| T4 槽位未按维度校验、同槽手写另建条目 | pinned `depth` 时模型借用本批 `focus:rust` 槽位回答 `dimension=depth` 成功，产生第二条矛盾 `depth`；两次手写同一 `dimension=depth, slot=depth` 产生两个 id、两行 | `apply` 校验候选槽位所属维度，跨维度引用报 `invalid_output` 并整事务拒绝（原未知槽位文案不变）；`save` 改为先按 `dimension+slot` 查找（无槽位的旧行回退按值匹配），同槽手写复用 id、保留证据与固定/更正，并按人工语义把 `corrected` 置真；可并存维度仍按值派生槽位，旧数据兼容 |

接口与数据模型变化（仅本阶段）：无新增方法；`profile.configure` 的返回时机现在包含在途批次的释放；`save` 的匹配顺序变为槽位优先；画像 schema 仍为 3，`profile_markers` 兼作成功／清空／撤回三类去重记录；知识库 schema 仍为 5。

### 新增回归与反向对照

Rust `native/knowledge/tests/profile.rs` 现 27 项（20 + 7）：`a_control_change_releases_the_batch_in_its_own_transaction`、`an_event_before_a_clear_is_not_counted_after_a_restart`、`a_withdrawal_while_the_switch_is_off_still_drops_the_queued_source`、`a_retracted_source_takes_its_automatic_item_out_of_the_context`、`capacity_counts_work_that_failed_to_learn`、`a_manual_save_reuses_the_id_of_a_controlled_slot`、`a_slot_from_another_dimension_is_refused`。`native/knowledge/src/store.rs` 新增 1 项库内测试 `a_finished_stage_two_row_loses_its_text_when_the_database_opens`（真实 schema2 DDL 库 + 已在 schema3 的库各一次），lib 由 15 增至 16 项。

`src/main/knowledge/profile.integration.test.ts` 现 12 项（8 + 4，真实 release helper + 生产 `KnowledgeHost`/`ProfileCollector`，0 次付费模型）：总开关「快速关→开」、chat 通道「快速关→开」、手动暂停「快速关→开」三个路径都在批次真正停在 gate 上时操作，且**不等待** `pending`、不手动 `wake()`、不调 `learn.fail`、不补新证据；第四项证明关闭画像期间的对话撤回仍生效。

反向对照（逐项临时改回缺陷实现后实测失败，随后恢复）：

| 临时改回 | 实测失败 |
| --- | --- |
| 去掉 `configure` 事务内释放 | `a_control_change_releases_the_batch_in_its_own_transaction` 失败（`pending` 0，期望 1） |
| 去掉 `record_event` 的 `cleared_at` 判断 | `an_event_before_a_clear_is_not_counted_after_a_restart` 失败（重放仍计数） |
| `active_usage` 退回 `pending/working` | `capacity_counts_work_that_failed_to_learn` 失败（201 条被接受，`left 1 / right 0`） |
| 去掉 `apply` 的维度校验 | `a_slot_from_another_dimension_is_refused` 失败 |
| `save` 退回按值匹配 | `a_manual_save_reuses_the_id_of_a_controlled_slot` 失败（两个不同 id） |
| `Store::open` 不迁移 `done` | `a_finished_stage_two_row_loses_its_text_when_the_database_opens` 失败（`markers` 0） |
| `context` 不查来源有效性 | `a_retracted_source_takes_its_automatic_item_out_of_the_context` 失败 |
| `retractThread` 退回 `!enabled` 提前返回 | `retracts a held chat while the switch is off so it is never learned` 失败 |

调试过程中的一条实测事实（记录以免重复踩坑）：TS 集成测试用的是 `native/bin/yu-knowledge.exe`，Rust 改动后不先 `node scripts/build-native.mjs`，测试仍在跑旧行为——本轮最初三次「控制不释放」的失败就是旧二进制造成的，不能据此推断 Rust 逻辑有问题。

### 验证（最终代码，实际命令与退出码）

| 命令 | 结果 |
| --- | --- |
| `cargo fmt -- --check` | 0 |
| `cargo test --locked` | 0（16 lib + 11 extract + 11 process + 27 profile + 18 queue = 83 项） |
| `cargo clippy --locked --all-targets -- -D warnings` | 0（含 `--features fixture`） |
| `node scripts/build-native.mjs` | 0（20.33 s） |
| `pnpm exec tsc --noEmit -p tsconfig.node.json` / `-p tsconfig.web.json` | 0 / 0 |
| `pnpm exec vitest run src/main/knowledge src/main/chat.test.ts src/main/notes.test.ts src/main/assistant.test.ts src/preload/index.test.ts src/main/ipc-trust.test.ts` | 0（21 文件 / 271 项） |
| `pnpm test:native` | 0（7 个 crate 全部构建并测试通过） |
| `pnpm test` | 0（268 文件通过 / 3 跳过；3825 项通过 / 8 跳过；99.29 s） |
| `pnpm build` | 0（`settings-*.js` 4,687.76 kB） |
| `git diff --check` | 0（本轮提交前） |
| `git diff --check 7987aed..HEAD` | 0（阶段 3 验收点到本轮之前） |

交付产物：`native/bin/yu-knowledge.exe` 2,897,408 字节，SHA-256 `10ed0e8743a94a102685db4fb7061f24bc6fa5a48eb5a526fe95be117edca01c`（MSVC 重建哈希会变）；debug `native/knowledge/target/debug/yu-knowledge.exe`、fixture `yu-knowledge-fixture.exe` 与 `native/knowledge/target`（1.6 GB，已 gitignore）不计入交付。`%TEMP%/yu-knowledge*` 已清空（提交前实测 0 个）。

未测与边界：未调用真实付费模型（全部注入 completer，模型调用次数由测试断言为 0 或 1）；未在打包 Electron 实例内运行；30 天窗口仍用注入时间；「快速关→开」三条路径覆盖总开关、chat 通道与手动暂停，游戏暂停走同一条 `configure` 释放路径但未单独做快速开关回归；`profile.retry` 仍只人工触发。阶段 5～7 未开始，用户可见的画像页面尚未开放。

## 阶段 4 外部验收（2026-11-05，reportId `be0f31a5-f917-47ef-9f07-cbe81ca501f1`）

外部在 `efc0b9b` 上复核并**通过**阶段 4：`cargo test --locked` 83 项通过；定向 Vitest（knowledge/chat/notes/assistant/preload/ipc-trust）21 文件 / 271 项通过；`git diff --check 1944446..HEAD` 与 `git diff --check 4e077a3..HEAD` 均通过；交付 release 2,897,408 字节，SHA-256 `10ed0e8743a94a102685db4fb7061f24bc6fa5a48eb5a526fe95be117edca01c`，与报告一致；T1～T4 的实现与对应回归（快速关→开、关闭期撤回、失败容量、旧库回收、维度与同槽身份）均已核对。上文记录的 DSH 全量与 `pnpm build` 仍标注为 DSH 侧验证。

阶段 5（知识库页面与独立图谱）随之授权。

## 阶段 5 实施记录（2026-11-05，DSH 执行会话 session-e4795148-53a3-4afd-b014-730be9b3c9f1）

**起始 HEAD `efc0b9bd9d47bbb7aedefaa94c276b8518169373`（master，工作区干净）。** 本轮交付：主界面侧栏的“知识库”入口、知识库内容页（主题/列表/详情）、卡片管理与采集操作、独立知识图谱、由知识库打开的画像面板。语在回答中检索与引用、原记录删除时的关联知识联动属阶段 6；备份、卸载与安装包真实模型验证属阶段 7。阶段 1～4 的输入、提炼、保护与画像行为是本轮必须保持的回归基线。

### 边界

- 新增业务仍在 Rust：收藏标记、主题聚合、修订读取、手工合并、导出序列化、关系与图谱查询、筛选与分页全部由 `native/knowledge` 完成，Schema 由 `store.rs` 迁移持有。
- 主进程只做固定接口与权限：`host.ts` 增加同名 RPC，`index.ts` 增加 `handle()` 通道并沿用 `knowledgeOwner`，Renderer 只传卡片/关系 ID；导出文件的写入路径由主进程保存对话框决定，Renderer 不接触文件系统与 SQL。
- 不新增框架、ORM、向量库或网络服务；沿用 SQLite、JSONL 管道、现有 React/MUI/主题/i18n 与已安装的 `react-force-graph-2d`。

### 数据模型变更（知识库 schema 5 → 6）

迁移在 `KNOWLEDGE_SQL` 序列末尾追加，升级保留全部卡片、来源、修订、建议与排除记录，更高版本仍返回 `storage_schema_newer`：

```sql
ALTER TABLE cards ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
CREATE INDEX cards_favorite ON cards (favorite, updated_at DESC);
CREATE TABLE card_relations (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('contains','prerequisite','applies','contrast','derives')),
  origin TEXT NOT NULL CHECK (origin IN ('manual','model')),
  evidence TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (from_id, to_id, kind)
);
```

`contrast` 是对称关系：落库前按两个 ID 排序规范化，`(a,b)` 与 `(b,a)` 是同一条边。收藏是持久标记而非内容编辑：只更新 `updated_at`，不提升 `revision`、不置 `edited`。

### 新增与变更接口

| 方法 | 参数 | 结果 | 关键约束 |
| --- | --- | --- | --- |
| `card.list` / `card.search`（变更） | 增加 `topic?`、`favorite?`、`kind?` | `CardPage`（条目含 `favorite`） | 筛选在 SQL 内先于 `LIMIT/OFFSET`，`total` 为筛选后的真实总数；沿用字节预算与 `nextOffset` |
| `card.update`（变更） | 增加 `favorite?` | `Card` | 收藏翻转只改 `updated_at` |
| `topic.list` | `limit?`（默认 50，上限 200） | `{topics:[{topic,count}], total}` | 按 `cards.topics` 的 JSON 数组聚合，计数降序、主题升序 |
| `card.revisions` | `id`、`limit?`（默认 10，上限 20） | `{id, revisions:[{revision,title,summary,body,topics,edited,createdAt}]}` | 新的在前；受 2 MiB 帧预算约束 |
| `card.merge` | `keepId`、`mergeId`、`keepRevision`、`mergeRevision`、`title?`、`summary?`、`body?` | `{card, removedId, sources, relations}` | 单个 `IMMEDIATE` 事务：重验两卡与版本、合并主题/别名、重指来源与关系、去重去自环、把被并卡的历史修订移交给保留卡、`favorite` 取或、置 `edited` 并提版；版本过期→`source_changed`，同 ID 或超长→`invalid_params`，失败时两卡与关系不变 |
| `card.export` | `id` | `{id, filename, markdown}` | Rust 序列化 Markdown；文件名清洗 `\/:*?"<>|` 与控制字符 |
| `relation.add` | `fromId`、`toId`、`kind`、`evidence?` | `KnowledgeRelation` | 拒未知端点、自环、未知类型、依据超 500 字；`contrast` 规范化去重；重复返回既有行 |
| `relation.remove` | `id` | `{removed:true}` | 未知 ID → `not_found` |
| `relation.list` | `cardId`、`limit?`（默认 30，上限 100） | `{items:[{…relation, card:{id,title,kind}, direction}], total}` | 对方卡片元数据随行返回，避免逐条查询 |
| `graph.query` | `topic?`、`query?`、`focusId?`、`depth?`、`limit?` | `{nodes,edges,total,shown,truncated,limitedBy}` | Rust 先筛后截断：节点默认/上限 200，`total` 为裁剪前命中数，边只保留两端都在节点集内的，512 KiB 预算触发 `limitedBy:'bytes'`；节点只带元数据 |
| `profile.*`（沿用） | 不变 | 不变 | 面板复用阶段 4 的 list/get/update/delete/pause/clear/retry/status/context |

模型关系不新增方法：`extract.run` 的批次答案可带 `relations:[{from,to,kind,evidence}]`，端点必须是本批实际提供过的卡片或建议标识，`evidence` 必须是本批文本子串，单批上限 12 条，落库标记 `origin:'model'`；越界即 `invalid_output`。空白关系是合法答案。

主进程通道（`handle()` + `knowledgeOwner`）：`knowledge:topic-list`、`knowledge:card-revisions`、`knowledge:card-merge`、`knowledge:card-export`、`knowledge:card-export-save`（保存对话框 + UTF-8 写入，取消不写）、`knowledge:relation-add|remove|list`、`knowledge:graph`；新增 `knowledge:changed` 广播（携带 helper 的 scope），页面挂载时订阅、卸载时退订，用于刷新可见页面而不是轮询。

### 验收（本轮实际执行结果见下一节）

- 真实 helper 合成验证：筛选分页与 `total`、中文/特殊字符搜索、收藏持久化、合法关系与非法端点、重复边与删除/合并后的关系一致性、200+ 节点裁剪与字节预算、schema 5→6 升级与更高版本拒绝、合并的过期版本/超长正文/来源保留/原子失败、模型关系的可引用集合与错误输出。
- 生产渲染入口：从侧栏到真实卡片的搜索/选择/编辑/收藏/删除/合并/导出、图谱节点与邻居展开、源记录跳转与失效说明、历史整理、关闭状态、画像更正/固定/清空；至少一组窄窗口、键盘路径、中英文与深浅主题；图谱与 Mem0 各自查实际数据。
- 组件级 mock 只作 UI 检查，Rust/host/IPC 真实链路单独验证；阶段 1～4 的既有回归继续通过。

### 新增回归

Rust：`native/knowledge/tests/cards_view.rs` 7 项（过滤后的 `total`、收藏不动 revision/edited、`nextOffset` 续页、字节预算页、`topic.list` 计数排序、`card.revisions` 顺序与上限、merge 成功路径与四类拒绝、导出 Markdown 与文件名清洗）；`native/knowledge/tests/relations.rs` 10 项（增删列与幂等、自环/未知端点/未知类型/超长依据拒绝、`contrast` 对称去重、删卡级联、图谱 topic/短查询 LIKE/长查询 FTS、focus 1～2 跳、节点上限与边端点闭合、字节预算、模型关系可引用集合与三类 `invalid_output`）；`native/knowledge/src/store.rs` 库内 1 项（schema 5 → 6 保住来源/卡片/来源关联/修订/建议/排除，`favorite` 默认 0，新列默认值正确）。合计 `cargo test --locked` 101 项。

TS：`src/main/knowledge/loop.test.ts` 增 2 项，用真实 fixture 管道验证 `topic.list`/`card.revisions`/`card.export` 与 `card.merge`/`relation.add|list|remove`/`graph.query` 的方法名、参数形状与返回类型；`src/renderer/src/settings/pages/knowledgeView.test.ts` 24 项（请求构造与上限钳制、`nextOffset` 合并与重叠去重、过期响应闸门、选择保持、宽窄切换、空状态、关系分组、合并预览、图谱截断文案、画像分组）。渲染侧共 52 文件 / 562 项通过。

顺手修掉的两处真实问题（不是测试问题）：ready 帧的 `schema.knowledge` 由 5 变 6 后，`host.integration.test.ts` 与 `loop.test.ts` 里钉住的对象断言仍是 5，实测失败后改为 6；`suggestions.rs` 接受建议时写 `card_history` 未带 `topics`/`edited`（依赖默认值），会让该版修订在列表里显示空主题，改为随快照写入真实值。

### 验证（最终代码，实际命令与退出码）

| 命令 | 结果 |
| --- | --- |
| `cargo fmt -- --check`（native/knowledge） | 0 |
| `cargo test --locked`（native/knowledge） | 0，101 项通过（lib 17 + cards_view 7 + extract 11 + process 11 + profile 27 + queue 18 + relations 10） |
| `cargo clippy --locked --all-targets -- -D warnings` | 0 |
| `cargo clippy --locked --all-targets --features fixture -- -D warnings` | 0 |
| `node scripts/build-native.mjs` | 0（knowledge crate release 重建 23.83 s；`suggestions.rs` 修正后再次重建） |
| `pnpm exec tsc --noEmit -p tsconfig.node.json` / `-p tsconfig.web.json` | 0 / 0 |
| `pnpm exec vitest run src/main/knowledge src/main/chat.test.ts src/main/notes.test.ts src/main/assistant.test.ts src/preload/index.test.ts src/main/ipc-trust.test.ts src/renderer` | 0（73 文件 / 835 项） |
| `pnpm test:native` | 0（7 个 crate 全部构建并通过） |
| `pnpm test` | 0（269 文件通过 / 3 跳过；3851 项通过 / 8 跳过；98.40 s） |
| `pnpm build` | 0（`settings-*.js` 5,255.65 kB，含图谱与知识库页面） |
| `git diff --check` | 0（本轮提交前工作区） |

交付产物：`native/bin/yu-knowledge.exe` 3,044,864 字节，SHA-256 `5dc8d3ba733f8e86d1d6058fde5e4ae81df3ecfb55e128130c5942fdb3900b66`（MSVC 重建哈希会变）；debug `native/knowledge/target/debug/yu-knowledge.exe`、fixture `yu-knowledge-fixture.exe` 与 `native/knowledge/target` 不计入交付。

### 提交

- `03842fc` `fix(knowledge): close the stage 5 review gaps in layout, sources, refresh, merge, graph and model relations`（33 文件，+2218/−220）。
- `76d1fce` `docs(knowledge): record the stage 5 review and its R1-R6 repair`。
- 阶段范围 `git diff --check 2ced462..HEAD` 与 `4e077a3..HEAD` 均通过；release 见上表，`native/knowledge/target` 2.0 GB（gitignore 内，沿用仓库惯例）。

### 未测与边界

- 未调用真实付费模型：图谱与合并路径都不触发模型；模型关系只在既有提炼批次里接收，测试全部用注入 completer，并断言调用次数。
- 未在打包的 Electron 实例里手工点选：页面、对话框与图谱的验证是类型检查加纯逻辑单测（`knowledgeView.test.ts`）加构建通过，没有真实窗口截图或窄窗口目视证据。这一项与阶段 1～4 的记录口径一致，仍是本阶段最主要的未测部分。
- 文档来源（`kind: 'document'`）没有可打开的原记录类型，详情里只显示类型/标题/ID/定位与失效原因，不伪造跳转。
- 图谱是知识库页内的视图（`view: 'cards' | 'graph'`）而不是独立一级导航；知识库设置是知识库页顶栏打开的对话框，没有并入全局设置树。
- 图谱的 Byte 预算与节点上限有 Rust 侧实测，但 200+ 节点在真实窗口里的渲染表现未目视确认。
- 阶段 6 的聊天检索引用、系列、工作流联动与删除联动，阶段 7 的备份/卸载/安装包验证仍未开始。

## 阶段 5 外部复核与修复（R1～R6，2026-11-05 第六轮，DSH 执行会话 session-e4795148-53a3-4afd-b014-730be9b3c9f1）

复核方：外部 Codex 线程 `01a1a846-2e68-7062-89a9-bc2ed962ce86`，本次汇报 `7f829dea-b12d-4dac-9a84-bed5c45da242`；起始 HEAD `2ced462c2283333b0699bfc98e9894b2326a531e`（master，工作区干净）。复核结论：阶段 5 暂不验收，仅修 R1～R6；阶段 6～7 另派。

### 复核自行实测通过、本轮回修不重做的部分

- `cargo test --locked --quiet` 101 项通过；`git diff --check efc0b9b..HEAD` 通过；release SHA-256 `5dc8d3ba733f8e86d1d6058fde5e4ae81df3ecfb55e128130c5942fdb3900b66` 与 DSH 汇报一致。
- 真实 schema 5→6 探针：卡片、来源、修订、建议、排除与既有标记全部保留，更高未知 schema 被拒绝。
- 合并的过期/超长原子拒绝、来源保留、删除边级联实测通过。
- 外部用 Playwright 连隔离 Electron 开发构建加载 `settings.html`（真实 preload/IPC 与 release helper）：合成库里验证了「随记」下方的知识库入口、空态、详情、收藏入库、画像面板、2 节点 1 边图谱，以及模拟 760px 窄版返回。
- 未使用个人库或付费模型；安装包验收留在阶段 7。

### 未通过项与本轮修复状态

| 编号 | 复核证据 | 根因 | 状态 |
| --- | --- | --- | --- |
| R1 | 真实 1080×750 与 940×690 窗口下，知识库搜索 input 与 `InputBase` 宽度实测为 0，Playwright 无法输入；图谱有同类并排筛选结构 | 筛选下拉继承了主题的 `MuiTextField.fullWidth=true`，在 flex 行里没有可收缩列宽；页面与力图仍是静态导入 | 已修复 |
| R2 | 卡片详情把聊天复合 `originRef` 当 messageId，缺 `threadId`，真实点击报「原记录已不存在」；PDF/有效附件无打开入口；画像证据重复同一错误且忽略 Rust 已返回的 `withdrawn` | 渲染层自行拼记录标识；`document` 来源无分支 | 已修复 |
| R3 | 失败组重试用 `{channel, groupKey}` 走错分支，把没有原文的 reading 重置成 ready（wake=0）；缺少「指定来源手动提炼」；`lib.rs` 丢弃 `Outcome.scope`，`collect.configure`/`source.publish`/`history.*`/`profile.clear` 成功后无通知；模型选择把 disabled 档位当可用项 | 队列状态没有 group id；通知用硬编码方法表；下拉未过滤 `enabled` | 已修复 |
| R4 | 两张从未编辑的卡合并后修订里只剩合并后正文，双方旧稿丢失；保留卡与被并卡各与第三卡相连的 contrast 合并后出现 K→T 与 T→K 两条 | 合并事务只迁移已有历史，未登记双方当前版本；重指向未对对称关系规范化 | 已修复 |
| R5 | 70 个大元数据命中 + 焦点邻居裁到 54 节点/522585 字节时，尾部追加的焦点与邻居被裁掉；`limit=2` 满页时唯一邻居无法展开 | 追加焦点节点在压缩之后，没有优先级 | 已修复 |
| R6 | 真实 release 接受两个来源末尾/开头用合成换行拼出的 quote（任一来源都不含完整引文）并提交模型边，边缺 source/segment；首轮未展示的旧卡 ID 被提前引用仍建边成功 | 只校验了「引文出现在任一候选文本」，未绑定单个来源/段，也未按本轮可引用端点集合校验 | 已修复 |

### 本轮实现范围（不含阶段 6～7）

- Rust：R4/R5/R6 + `queue.status` 分组 + `queue.extract` 手动提炼 + 通知改用 `Outcome.scope`。
- 主进程：`knowledge:source-target|source-open|source-extract|model-info` 四个受信通道，来源身份由主进程从已存来源或附件记录解析（`src/main/knowledge/targets.ts`），`chat-store.attachmentOwner` 按附件 id 反查所属消息。
- 渲染层：R1 布局与懒加载、R2 来源定位/撤回态、R3 重试/手动提炼/通知刷新/模型选择。

### 修复实现（R1～R6）

- R1（渲染层，`src/renderer/**`）：`theme.ts` 的 `MuiTextField.defaultProps.fullWidth` 未改，改为在筛选行调用点收紧——工具行 `flexWrap`，搜索框 `flex: '1 1 220px'`、`minWidth: 120`，两个下拉显式 `fullWidth={false}` + 固定 152/132px 列宽 + `minWidth: 0`，收藏按钮 `flex: '0 0 36px'`。主/从布局改为用 `ResizeObserver` 量知识面板自身的宽度，新增纯函数 `SPLIT_MIN_WIDTH = 720`、`splitFit(w)`、`paneModeFor(w, hasSelection)`；图谱页同一判定（<720 上下堆叠，列表 `maxHeight: 260`）。`App.tsx` 与 `KnowledgePage.tsx` 改为 `React.lazy` + `Suspense`。
- R2（主进程 + 渲染层）：来源身份改由主进程解析。新增纯逻辑 `src/main/knowledge/targets.ts`（`parseChatRef`、`resolveSourceTarget`）与 `src/main/chat-store.ts` 的 `attachmentOwner(attachmentId)`（按附件 id 反查 thread/message）。`knowledge:source-target` 返回 `record`（交给既有 `openRecord`）、`url`/`file`（交给 `knowledge:source-open`，`safeLink` 校验）或 `none` + 真实原因；`knowledge:source-open` 只用主进程自己解析出的路径或链接，渲染层不传路径。卡片详情与画像证据共用该语义：`withdrawn === true` 显示「已撤回」且不可点击，条目级纠正改用独立标签。
- R3：`queue.status` 增加 `groups`（≤20，按最近更新倒序，含 `id/channel/state/title/items/updatedAt`），队列页按真实 `group.id` 重试与标记需重读；新增 `queue.extract`（只入队并复用既有稳定窗口与去重，返回 `queued/groupId/state` 或 `needs_reread`/`working`/`no_group`），卡片详情来源行提供「手动提炼」；`lib.rs` 通知改用真实 `Outcome.scope`，取消/失败/无变化不广播；模型下拉只列 `enabled` 档位，已选档位被停用时显示实际使用的档位。
- R4：`cards.rs` 合并事务在 UPDATE 之前把双方当前正文各写一条 `card_history`（`WHERE NOT EXISTS` 幂等），再迁移其他历史；返回新增 `bodySource`（`request`/`keep`）与 `preview`；contrast 边重指向后按 `(min,max)` 规范化并用 `dedupe_contrast` 去重，保留人工边与其依据。
- R5：`relations.rs` 图查询先取匹配集，再把焦点与请求的邻居放进优先集，`selected` 先放优先集再补匹配集，字节裁剪只从尾部弹出，满页时用优先节点替换优先级最低的匹配节点；返回 `focused`、`expanded`，`truncated` 在节点或字节任一超限时为真。
- R6：`extract.rs` 关系解析不再跨段拼接——引文必须完整落在同一来源段内，否则 `invalid_output`「关系依据必须来自同一段原文」；`resolve_edge` 只接受本轮展示给模型的端点（首轮即本轮草稿），模型边写入 `source_id`/`segment`，`origin` 仍为 `model`。

### 新增回归

- Rust：`tests/relations.rs` 15（R5 焦点/邻居优先、满页替换、字节裁剪、`focused`/`expanded`/`truncated`、非法端点/自环/重复边、删除级联；R6 同段引文、跨段拒绝、未展示卡片拒绝、边带来源与段号），`tests/cards_view.rs` 9（R4 双方正文进历史、`bodySource`/`preview`、contrast 规范化去重、过期/超长/失败原子性），`tests/queue.rs` 22（R3 分组、按组重试、`queue.extract` 四种返回、稳定窗口内重复提炼去重），`tests/extract.rs` 12（R6 关系端点集合与引文同段）。
- TypeScript：`src/main/knowledge/targets.test.ts` 13（聊天复合标识、缺 threadId、附件、文档、伪造路径、缺失来源、不可信链接）；`src/main/knowledge/loop.test.ts` 增加 3 项真实夹具契约（`queueStatus().groups`、`extractSource`、合并/关系/图新字段）；`src/renderer/src/settings/pages/knowledgeView.test.ts` 33（含 `splitFit`/`paneModeFor`/`extractStatus`/`modelView`）；`src/main/knowledge/host.integration.test.ts` 与 `loop.test.ts` 的 ready schema 断言同步到 `{knowledge: 7, profile: 3}`。

### 真实窗口证据（隔离配置，非个人数据）

探针脚本 `C:/Users/17133/AppData/Local/Temp/yu-stage5/probe.mjs`（仓库外）用 `--remote-debugging-port` 启动真实构建（真实 preload/IPC 与 release helper），在隔离 `user-data-dir` 下经 `window.api.knowledge.saveCard` 造 3 张合成卡片并加 1 条 `contains` 关系，点击侧栏「知识库」，测量、输入、截图；未调用付费模型。

- 1080×750：搜索 input 宽 **434px**（复核时为 0），两个下拉 152/132px；聚焦后输入「探针乙」得到 `hasHit: true`、`hasMiss: false`（只出现命中卡片）；图谱页 canvas 508×585、节点「显示 3 / 3」、可展开；画像面板可打开、3 个开关、空态「还没有画像条目」；渲染进程错误 0；截图 `k-1080.png`、`k-1080-graph.png`、`k-1080-profile.png`。
- 940×690：搜索 input 宽 **294px**，下拉 152/132px，同样聚焦可输入并只出命中项；窄版主从切换为单列列表；图谱 canvas 680×253（上下堆叠）；画像面板可用；错误 0；截图 `k-940.png`、`k-940-graph.png`、`k-940-profile.png`。
- 说明：该 Electron 构建未暴露 `Browser.setWindowBounds`，探针用 `Emulation.setDeviceMetricsOverride` 固定视口，报告里标注为 `viewport-emulation`；1080×750 与应用自身默认窗口尺寸一致。

### 验证（最终代码，实际命令与退出码）

| 命令 | 结果 |
| --- | --- |
| `cargo fmt -- --check`（native/knowledge） | 0 |
| `cargo test --locked` | 0；113 项（lib 17 / cards_view 9 / extract 12 / process 11 / profile 27 / queue 22 / relations 15） |
| `cargo clippy --locked --all-targets -- -D warnings` | 0 |
| 同上 `--features fixture` | 0 |
| `node scripts/build-native.mjs` | 0；`native/bin/yu-knowledge.exe` 3,076,608 字节，SHA-256 `67c5a55e2b112e0d656dca9a73dae5d6016678f7908b10e5d98068a6cd409188` |
| `pnpm exec tsc --noEmit -p tsconfig.node.json` / `-p tsconfig.web.json` | 0 / 0 |
| 定向 vitest（knowledge / chat / notes / assistant / preload / ipc-trust / renderer） | 74 文件 / 857 项通过 |
| `pnpm test:native` | 0 |
| `pnpm test` | 0；270 文件通过 / 3 跳过，3876 项通过 / 8 跳过，98.48s |
| `pnpm build` | 0；11.82s；`KnowledgePage-iHPQ5e0U.js` 200,441 字节与 `KnowledgeGraphPage-CXEJRLc-.js` 18,250 字节为独立 chunk，主包 `settings-BcbIafwQ.js` 4,689,684 字节内无 `d3Force` |

### 未测与边界

- 未调用任何付费模型；R6 的模型关系用注入的 completions 覆盖。
- 未在打包安装包上点测（阶段 7）；本轮证据来自真实 Electron 构建 + 隔离 `user-data-dir`。
- 图谱仍是知识页内的视图（通过知识页工具栏进入），不是一等侧栏路由；知识设置仍是页面自有对话框，未并入全局设置分区。
- 来源定位对已删除或本机不可读的文件只显示真实原因，不提供重建入口。
- 真实窗口只走到「搜索 → 命中列表 → 图谱 → 画像面板」这条主线：来源跳转/失效原因、手动提炼、合并对话框、建议接受、画像纠正/置顶/清空这些动作由单元与集成测试覆盖（`targets.test.ts`、`loop.test.ts` 真实夹具、Rust 各 suite），本轮未在真实窗口逐个点击。

## 阶段 5 补充复核修复（T1～T3，2026-11-05 第七轮，DSH 执行会话 session-e4795148-53a3-4afd-b014-730be9b3c9f1）

外部复核在 `9e60512` 上仍判三项阻塞：手动提炼接不回队列消费、文档打开只靠可伪造的 locator、图谱前端把两次响应合并导致超出节点预算。本轮只修这三项，阶段 1～4 的数据与行为、已通过项一律不动；阶段 6～7 未开始。

### 三项根因与落点

| 编号 | 根因（实际代码） | 落点 |
| --- | --- | --- |
| T1 | `knowledge:source-extract` 只调用 `host.extractSource`，而 helper 仅入队；`changed` 只广播给渲染进程，空闲的 `ExtractEngine` 没有任何唤醒，稳定窗口（测试为 0）过后任务仍停在 `ready`，模型调用数不变。阅读来源的原文已逐出时同样回 `queued:1`。 | 新增 `src/main/knowledge/manual.ts`（`extractSourceNow` / `sourceChannel` / `missingReason`）：先按 `enabled`/`allowed` 门控，读真实来源、用 `collector.resolveBody` 取回原文（笔记/会话走 `createSourceRecovery`，阅读走进程内暂存），原文仍在本进程时入队并 `extractEngine.wake()`；原文已逐出则用 `host.needsReread` 落 `needs_reread` 并回真实原因，不启动模型调用。`src/main/index.ts` 的 handler 改为调用它，渲染进程仍只传来源 ID。 |
| T2 | `resolveSourceTarget` 的文件分支只做 `statSync(path).isFile()`，而 `knowledge:source-save` 允许写任意 locator，于是「能存元数据 + 文件存在」被当成读取授权；`knowledge:source-open` 直接把它交给 `shell.openPath`。 | `TargetDeps.file` 换成 `ownedFile(path): string | null`，由主进程用 `realpathSync` 校验文件确实位于自身笔记根目录（`roots().notes`）之下；新增 `src/main/knowledge/open.ts`（`openSource`），解析与打开共用同一裁决，`url` 分支再次校验 `^https?://`，其余一律回真实原因。附件仍走 `chats.store.attachmentOwner` → 会话记录。 |
| T3 | `knowledgeView.mergeGraph` 把前后两次图谱响应按 id 求并：Rust 已按 200 节点预算裁掉的旧节点又被加回（复现为 201），而 `total/shown` 取自新响应，画布与页脚因此可以不一致。 | 删除 `mergeGraph`，改用 `acceptGraph`（最新票据才替换、过期票据原样返回、从不合并）+ `graphView`/`graphCounts`：画布节点、边、信息栏计数和裁切提示全部取自同一份已校验响应，`expanded` 与 `visible` 同源。页面数据 effect 用票据作废旧响应。 |

### 反例修复前后（真实入口，非 mock）

| 探针 | 修复前 | 修复后 |
| --- | --- | --- |
| 生产 host + release helper：给一条合成随记入队后调用生产手动提炼（稳定窗口 0，引擎先空转） | `queued:1, state:'stabilizing'`，任务停在 `ready`，`wake` 未发生，模型调用 1 | `manual.test.ts`：`queued:1` 且 `wake` 1 次，任务进入 `stabilizing`；真实引擎在无手动 tick 情况下把该组跑到 `completed` |
| 同一入口，原文已不在（仅剩 active 元数据） | `queued:1`，随后提炼失败 | 返回 `{queued:0, state:'needs_reread', reason:'无法读取原文'}`，落库为该状态，来源 `state`/`version` 不变，模型调用 0 |
| 用 `knowledge:source-save` 写入隔离根里的惰性 txt 后请求打开 | `{kind:'file', path:'…fake.txt'}`，随后会被交给 `shell.openPath` | `{kind:'none', reason:'该来源没有可核验的读取记录'}`，打开函数未被调用（注入 opener 断言 0 次） |
| 200 同主题节点 + 1 主题外邻居：主题查询后焦点查询 | 合并后画布 201 节点，页脚 200 / 200 | 画布 200（含焦点与邻居，被裁节点不回流），`{visible:200,total:200,expanded:1}`，无悬空边 |

### 三条反例的负向控制（临时复原缺陷，确认对应用例确实失败）

| 复原的缺陷 | 失败的用例 |
| --- | --- |
| 去掉 `extractSourceNow` 里的 `deps.wake()` | `manual.test.ts` 的「queues the existing task and wakes the engine once」与「finishes a clicked extraction through the real engine with no manual pump」 |
| 文件分支退回「locator 存在即可打开」 | `open.test.ts` 的「never hands a fabricated locator to the file opener」、`targets.test.ts` 的「opens an app-owned document and refuses a locator with no read credential」 |
| `acceptGraph` 改回按 id 求并 | `knowledgeView.test.ts` 的「draws the expanded answer at its own size, not on top of the previous one」（走页面真实路径 `acceptGraph → graphView`）与「ignores a late answer for a query the user already left」 |

### 新增回归

- `src/main/knowledge/manual.test.ts`（6 项，release helper + 生产函数）：入队并唤醒一次；原文缺失落 `needs_reread` 且 0 次模型调用；总开关关闭时不启动 helper；`sourceChannel` 映射；helper 无法启动时如实失败；真实引擎无人为唤醒也把点击的任务跑到 `completed`。
- `src/main/knowledge/open.test.ts`（6 项，注入 opener）：可信网页来源可打开；伪造 locator 到不了 opener；自有文件可打开并原样回传 opener 失败原因；解析器给出不可信协议时仍拒绝；会话来源回 `record`；失效来源按解析器结果拒绝。
- `src/main/knowledge/graph-budget.test.ts`（1 项，真实 helper）：201 张卡片建图，主题查询 200 → 焦点查询含邻居，经 `acceptGraph`/`graphView` 后画布 ≤200 且边端点全部可见。
- `src/renderer/src/settings/pages/knowledgeView.test.ts` 增至 37 项：预算用例改为走页面真实路径（先接受主题答案，再接受焦点答案），并保留重复展开不累积、迟到响应不覆盖、计数同源等断言。

### 验证（本轮最终代码，实际命令与退出码）

| 命令 | 结果 |
| --- | --- |
| `cargo fmt -- --check`（`native/knowledge`） | 0 |
| `cargo test --locked` | 0；113 项（lib 17 / cards_view 9 / extract 12 / process 11 / profile 27 / queue 22 / relations 15） |
| `cargo clippy --locked --all-targets -- -D warnings` | 0（含 `--features fixture` 变体 0） |
| `node scripts/build-native.mjs` | 0；release `native/bin/yu-knowledge.exe` 3,076,608 字节，SHA-256 `67c5a55e2b112e0d656dca9a73dae5d6016678f7908b10e5d98068a6cd409188`（本轮未改 Rust，重跑仅确认产物一致） |
| `pnpm typecheck` | 0（node + web） |
| 定向 vitest（`src/main/knowledge`、`knowledgeView.test.ts`、`preload`、`ipc-trust`） | 23 文件 / 216 项通过 |
| `pnpm test:native` | 0 |
| `pnpm test` | 0；273 文件通过 / 3 跳过，3893 项通过 / 8 跳过，95.38s |
| `pnpm build` | 0；11.78s；`KnowledgePage-DWi4WlsZ.js` 200,361 字节、`KnowledgeGraphPage-ZG1dz-Nr.js` 18,523 字节为独立 chunk，`settings-D1FTgw9p.js` 4,689.68 kB 内 `d3Force` 计数 0 |

### 未测与边界

- 未调用付费模型；T1 的闭环用注入的 completer 与 `{"cards": []}` 响应，只验证「点击 → 入队 → 引擎消费 → 结算」这条链路。
- 未在打包安装包上点测（阶段 7）；未重复做真实窗口截图，本轮 T1～T3 的证据是真实 helper + 生产桥接 + 生产渲染函数，UI 布局回归沿用上轮 1080×750 / 940×690 的窗口证据。
- `ownedFile` 只承认笔记根目录下的文件；保存在其他位置的历史 `document` 来源将显示「该来源没有可核验的读取记录」，不提供重建入口（不新增授权框架）。
- 手动提炼受现有稳定窗口约束：窗口内重复点击只归并到同一任务，不额外排批。

### 提交

- `3f4645b` `fix(knowledge): consume manual extractions and bound what can be opened` —— `src/main/knowledge/{manual,open}.ts` 与三份新回归、`targets.ts` / `targets.test.ts`、`src/main/index.ts` 的两处 handler、`knowledgeView.ts` 与图谱页面、两份语言包。
- `a115aca` `docs(knowledge): record the stage 5 supplementary review and its T1-T3 repair` —— 本节与状态行；交付哈希与提交编号由本次小型 docs 提交补齐。
- 工作区干净；`git diff --check`、`git diff --check 9e60512..HEAD`、`git diff --check 4e077a3..HEAD` 均为 0；`%TEMP%/yu-knowledge*` 残留 0；`native/knowledge/target` 2.0 GB（gitignore，按仓库惯例保留）；仓库内 `data/` 只有既有的 `data/chat`，本轮测试全部使用隔离根目录。

## 阶段 5 二次复核修复（A～C，2026-11-05 第八轮，DSH 执行会话 session-e4795148-53a3-4afd-b014-730be9b3c9f1）

外部 Codex（thread `01a1a846-2e68-7062-89a9-bc2ed962ce86`，reportId `7dadc1bf-1cc1-4a16-8f03-41ef638c42db`）在 HEAD `84b3da4` 上复核第七轮结果：手动提炼的唤醒、附件/会话定位、节点预算、异步问答票据、侧边栏与宽窄窗口布局均已通过，阶段 5 仍不验收，因为上一轮的修复只做了一层。本轮只修 A～C 三项，阶段 6～7 未开始。

### 三项复核发现（外部实测，本轮复现并修复）

- **A 队列原子性**：两个已完成来源的进度为 `[1,1]`；对正文已消失的活跃阅读来源做手动提炼返回 `needs_reread`，但进度变成 0；正文已变的笔记仍返回 `queued:1`/`stabilizing` 并把进度清零、白唤醒一次。
- **B 文档打开凭据**：把笔记根指向临时目录后，通过生产 host 的 `knowledge.source-save` 写入两个伪造来源（`unread.txt`、惰性 `inert.cmd`），`resolveSourceTarget` 与 `openSource` 都返回 `file` 并调用了注入的 opener。
- **C 图谱计数**：1 个匹配节点 + 1 个筛选外邻居时，生产 `graphView` 给出 `visible:2, total:1, expanded:1`，`KnowledgeGraphPage` 印出「当前显示 2 / 总数 1」，把画布节点数与匹配总数混成一个数。

### 根因与落点

| 项 | 根因 | 落点 |
| --- | --- | --- |
| A | `manual.ts` 先调 `queue.extract`（其中 `DELETE FROM extract_progress`），再发第二个 IPC 请求 `needs_reread`，失败还被 `.catch(() => undefined)` 吞掉；正文缺失时也可能先被认领 | `native/knowledge/src/queue.rs` 的 `extract()` 改为在同一个 Immediate 事务里先判定 `missing` / 版本 / 指纹，再决定是否重置进度；`src/main/knowledge/manual.ts` 先取正文与指纹，缺失就地 park，只有 `queued === 1` 才 `wake()` |
| B | `ownedFile` 把「文件在笔记目录内」当成读取凭据，而来源行本身是可写的 | 新增 `src/main/knowledge/documents.ts`：拒绝空 locator 与显式协议、只放行文档扩展名、要求主进程自己读到过正文且 `sha256(正文) === source.fingerprint`，再 realpath + `isFile`；`targets.ts`、`open.ts` 共用同一判定 |
| C | `graphCounts` 直接把 `graph.shown`（画布节点数）当匹配数 | `knowledgeView.ts` 新增 `graphMatched = max(0, shown - expanded)`，`GraphNotice`/`GraphCounts` 改用 `matched`；语言包只改占位符 |

### 反例修复前后（真实入口，非 mock）

- A：修复前「缺失正文手动提炼」→ `needs_reread` 且进度 0；修复后 `extract_progress` 计数前后都是 1，0 次唤醒，分组停在 `needs_reread`。正文变更：修复前 `queued:1` + 进度清零 + 1 次唤醒；修复后 `source_changed`（界面文案「原文已变更，需要重新读取该来源」），进度仍为 1，0 次唤醒。来源版本被后来的发布替换：同样返回 `source_changed`。
- B：修复前伪造 `unread.txt`（笔记根内外）与 `inert.cmd` 都判为 `file`，opener 被调用；修复后两者都返回 `{kind:'none'}`，原因分别为「该来源没有可核验的读取记录」与「这类文件不提供打开」，注入的 opener 调用 0 次。真实读过并由 Rust 铸出指纹的文档仍可定位、可打开，opener 的失败原因原样回传。
- C：修复前 `shown=2,total=1,expanded=1` → 「当前显示 2 / 总数 1」；修复后「匹配 1 / 总数 1 · 展开 1」，画布仍是 2 个节点；纯 200 匹配场景为 200/200、展开 0、画布 200；焦点扩展场景为 199/200 + 展开 1。

### 负向控制（临时复原缺陷，确认对应用例确实失败）

| 复原的缺陷 | 失败的用例 |
| --- | --- |
| `queue.rs` 的过期判定短路（`if false && (stale_version || stale_body)`） | `manual.test.ts` 的「refuses a body that changed after it was read and keeps the progress」与「refuses when the source moved to a newer version than the one read」（2 失败 / 6 通过） |
| `documentPath` 去掉读取记录与哈希校验 | `documents.test.ts` / `open.test.ts` 的「never hands a fabricated locator to the file opener」「refuses a script or an unread body even when the path exists」「refuses a file inside the notes root that was never read」「refuses a body that no longer matches the stored hash」「lets the real helper mint the fingerprint that authorises a real file」（5 失败） |
| `graphMatched` 退回 `graph.shown` | `knowledgeView.test.ts` 四项（展开答案自身体量、匹配/总数/展开拆分、邻居不计作第二匹配、预算提示用筛选分母、重复展开不累积）+ `graph-budget.test.ts` 一项（6 失败） |

三处缺陷均已复原为最终实现；A 的复原需要重新构建 helper，恢复后再次 `node scripts/build-native.mjs` 并核对哈希。

### 新增回归

- `src/main/knowledge/manual.test.ts` 增至 8 项：缺失正文 park 且保留上次进度（真实引擎跑到 `completed`）；正文变更拒绝且保留进度；来源被新版本替换时拒绝；总开关关闭不启动 helper；helper 无法启动时如实失败；真实引擎把点击的任务跑到 `completed`（无人为唤醒）。
- `src/main/knowledge/documents.test.ts`（7 项，真实临时文件）：笔记根内/根外伪造 locator、脚本与可执行、URL 与空 locator、文件已消失、哈希不符，以及真实 helper `source.save` 铸出指纹后可授权真实文件。
- `src/main/knowledge/open.test.ts` 增至 8 项：新增「打开真实读过的文档并原样回传 opener 失败原因」「脚本或未读正文即使路径存在也拒绝」。
- `src/main/knowledge/targets.test.ts`：默认依赖改为 `documentPath`（无读取记录即拒绝），正向用例改为真实读取记录 + 真实哈希。
- `src/main/knowledge/graph-budget.test.ts`：断言改为 `{matched: shown - expanded, total, expanded}`。
- `src/renderer/src/settings/pages/knowledgeView.test.ts` 增至 40 项：1 匹配 + 1 邻居的探针用例、预算提示分母、200 满预算用例。

### 验证（本轮最终代码，实际命令与退出码）

| 命令 | 结果 |
| --- | --- |
| `cargo fmt -- --check`（`native/knowledge`） | 0 |
| `cargo test --locked` | 0；113 项（lib 17 / cards_view 9 / extract 12 / process 11 / profile 27 / queue 22 / relations 15） |
| `cargo clippy --locked --all-targets -- -D warnings` | 0（含 `--features fixture` 变体 0） |
| `node scripts/build-native.mjs` | 0；release `native/bin/yu-knowledge.exe` 3,082,752 字节，SHA-256 `87a5c6532f87aea2dd37a72dab118d47c0c027b7ab545b458ca1c5f2b46d0c15` |
| `pnpm typecheck` | 0（node + web） |
| 定向 vitest（`src/main/knowledge`、`knowledgeView.test.ts`、`preload`、`ipc-trust`） | 24 文件 / 229 项通过 |
| `pnpm test:native` | 0 |
| `pnpm test` | 0；274 文件通过 / 3 跳过，3906 项通过 / 8 跳过，96.93s |
| `pnpm build` | 0；12.30s；`KnowledgePage-CbpWfKjM.js` 200,477 字节、`KnowledgeGraphPage-CvlaDKY-.js` 18,533 字节为独立 chunk，`settings-yYYCVi9k.js` 4,689.68 kB |

### 未测与边界

- 未调用付费模型；A 的闭环用注入 completer 与 `{"cards": []}`，只验证「点击 → 取正文 → 入队 → 引擎消费 → 结算」。
- B 的凭据来自主进程自己读到过的正文（进程内读取记录 + Rust 铸出的指纹），重启后没有旧凭据的历史 `document` 来源会显示「该来源没有可核验的读取记录」，不提供重建入口；未引入磁盘级索引或新的授权存储。
- 未在打包安装包上点测（阶段 7）；C 只改渲染计数与文案占位，未改 Rust 协议、力导向参数与节点/字节预算。
- 手动提炼仍受现有稳定窗口与认领互斥约束：窗口内重复点击归并到同一任务，已有认领中的任务返回 `working` 而不重复排队。

### 提交

- `16ce29c` `fix(knowledge): verify manual extraction and document opening against real reads` —— `native/knowledge/src/queue.rs`、`src/main/knowledge/{manual,documents,open,targets,host,engine}.ts`、`src/main/index.ts`、`src/shared/knowledge.ts`、`src/renderer/**`（图谱计数）与对应回归。
- 本节由随后的 docs 提交记录，提交编号与产物哈希在本节内回填。

## 阶段 5 二次复核残余修复（A～C，2026-11-05 第九轮，DSH 执行会话 session-e4795148-53a3-4afd-b014-730be9b3c9f1）

外部复核（thread `01a1a846-2e68-7062-89a9-bc2ed962ce86`，reportId `62346e79-bc5f-4206-9b18-ed52dc84ba52`）在 `15c134a` 上指出上一轮 A～C 仍各留一处反例，并实测定向用例 23 文件通过 / 1 失败（`graph-budget.test.ts:57`，`expanded` 实测 0）。本轮只修这三处，阶段 6～7 仍未开始。

### 三项残余反例

- **A**：manual 提炼的「正文已丢失」分支不带版本与指纹，而且在活跃/大小、取消、快照三类检查之前就写了状态。外部在读取与请求之间插入真实的 `invalidateTask`（任务取消、来源失效），迟到的 missing 请求仍把任务改成 `needs_reread` 并回报成功。
- **B**：`documentPath` 仍以来源行里的 `locator` 作为文件目标。外部用生产读取素材归集发布 `read.txt`（真实读到、可打开），再用真实 helper 的 `source.save` 把同一行 upsert 成同 kind / 同 originRef / 同版本 / 同正文，只把 locator 改成从未读过的 `unread.txt`；id 与指纹都没变，于是 `unread.txt` 被交给 opener。
- **C**：`relations.rs` 把 `LIMIT` 之后的命中集合当成整个过滤集合。两张都匹配 `Match` 的卡片、`limit=1` 时，聚焦第一页放不下的那张，生产 `graphView` 给出 `matched:0, total:2, expanded:1`（正确应为 `1 / 2 / 0`）。同时 `graph-budget.test.ts` 的展开查询漏了 `topic`，导致「至少一个额外节点」依赖排序，外部实测 `expanded` 为 0。

### 修复落点

- `native/knowledge/src/queue.rs` `extract()`：顺序改为 取组 → `working` 拒绝 → 渠道 → 排除 → 来源失效/空正文（`needs_reread`）→ 任务已取消（`cancelled`）→ 快照比对（`source_changed`）→ 才进入 missing 分支（同一 Immediate 事务内 `set_state(..., "needs_reread", ...)` + `ensure_not_cancelled()` + commit）。迟到的 missing 报告因此不会再覆盖已取消/已失效/已换版本的任务；只有真正还能 park 的来源才会写入。
- `src/main/knowledge/manual.ts`：missing 分支一并发送 `expectVersion` / `expectFingerprint`（来源自身快照）；Rust 未真正 park（如 `working`）时原样返回 Rust 的答复，`source_changed` 映射为「原文已变更，需要重新读取该来源」；`wake()` 仅在 `queued === 1` 时调用，删除了原先吞掉错误的 `.catch`。
- `src/main/knowledge/collector.ts`：阅读素材缓冲改为 `{ text, size, path? }`，`remember(origin, groupKey, text, path?)` 记录真实读到的路径，新增只读视图 `readRecord(channel, originRef)`。
- `src/main/knowledge/documents.ts`：目标文件改由读取记录决定 —— 空 locator / URL 拒绝、无记录拒绝、指纹不符拒绝、记录无路径（网页）拒绝，然后 `target = file(record.path)` 判类型，最后要求 `file(locator) === target`，否则「该来源的文件与读取记录不符」。类型判断作用在真正要交给 opener 的路径上。
- `src/main/knowledge/relations.rs`：新增 `matches_among(connection, plan, filter, ids)`，对**已选中的节点**用与 `total` 完全相同的 topic/搜索计划/过滤条件再问一次，`expanded = nodes.len() - matched_shown` 因此诚实：页面装不下的匹配仍是匹配，只有不满足过滤的节点才算扩张。
- `src/main/knowledge/graph-budget.test.ts`：展开查询补上 `topic:'Rust'`，并断言真实值 `total 200 / shown 200 / expanded 1 / truncated` 与 `counts {matched:199, total:200, expanded:1}`。
- 顺带修掉一处真实的排序不确定性：`queue.status` 的 `ORDER BY g.updated_at DESC, g.id` 在同毫秒新组之间按随机 id 排序，导致 `the_status_names_the_groups_a_retry_can_reach` 抖动；改为 `g.rowid DESC`（同毫秒内后创建者在前），断言未改。

### 反例修复前后（真实入口）

| 反例 | 修复前 | 修复后 |
| --- | --- | --- |
| A：失效来源的迟到 missing | 写入 `needs_reread`、回报成功 | 返回已取消/来源已变更，任务与来源状态不变，0 次 wake |
| A：快照不匹配的迟到 missing | 不比对快照 | `source_changed` →「原文已变更，需要重新读取该来源」，0 次 wake |
| B：同 id/同版本/同指纹、只改 locator | 把未读文件交给 opener | 「该来源的文件与读取记录不符」，opener 调用 0 次 |
| C：页面外的匹配聚焦 | `matched:0, expanded:1` | `matched:1, total:2, expanded:0` |

### 负向控制（临时复原缺陷，确认对应用例确实失败）

1. A：把活跃/取消/快照三类检查在 missing 请求时跳过（等价于旧顺序），重建 release helper 后 `manual.test.ts` 失败 1 项（`refuses a late missing report whose snapshot no longer matches the source`）。失效来源那条用例在控制下仍通过——真实 `invalidateTask` 会连带移除队列行，迟到请求只会得到「无任务」，因此 A 的顺序由快照用例证明。
2. B：删掉 `claimed !== target` 检查，`documents/targets/open` 失败 4 项（含真实 helper 铸指纹后改写 locator 的用例）。
3. C：把 `matches_among` 换回「只认 `LIMIT` 后的命中集合」，`relations` 失败 2 项（200 满页用例与页面外匹配聚焦用例）。

### 新增回归

- `src/main/knowledge/manual.test.ts` 增至 10 项：`does not park a source that was invalidated while the read was in flight`、`refuses a late missing report whose snapshot no longer matches the source`。
- `src/main/knowledge/documents.test.ts` 增至 8 项（含真实 helper 铸指纹后改写 locator 被拒、类型按真实目标判定、网页读取无本地路径）。
- `src/main/knowledge/open.test.ts` 增至 7 项、`targets.test.ts` 13 项：locator 与读取记录不一致时拒绝且 opener 0 调用。
- `native/knowledge/tests/relations.rs` 增至 16 项：`a_page_out_focus_that_matches_the_filter_is_counted_as_a_match`（含 `query` 变体，页面外卡片取自第一页结果，不依赖时间戳或 id 顺序）、`a_full_page_still_admits_the_focus_and_one_neighbour` 改为无过滤时 `expanded == 0`。

### 验证（本轮最终代码，实际命令与退出码）

| 命令 | 结果 |
| --- | --- |
| `cargo fmt -- --check`（`native/knowledge`） | 0 |
| `cargo test --locked` | 0；114 项（lib 17 / cards_view 9 / extract 12 / process 11 / profile 27 / queue 22 / relations 16） |
| `cargo clippy --locked --all-targets -- -D warnings` | 0（含 `--features fixture` 变体 0） |
| `node scripts/build-native.mjs` | 0；release `native/bin/yu-knowledge.exe` 3,085,824 字节，SHA-256 `f73ace70b183b43edf156a6c4bd896d4e5bdcbe601c058cacd958353258a00c9` |
| `pnpm typecheck` | 0（node + web） |
| 定向 vitest（`src/main/knowledge`、`knowledgeView.test.ts`、`preload`、`ipc-trust`） | 24 文件 / 232 项通过（含上一轮外部实测失败的 `graph-budget.test.ts`） |
| `pnpm test:native` | 0 |
| `pnpm test` | 0；274 文件通过 / 3 跳过，3909 项通过 / 8 跳过，96.52s |
| `pnpm build` | 0；11.78s；`KnowledgePage-CbpWfKjM.js` 200.48 kB 独立 chunk，`settings-yYYCVi9k.js` 4,689.68 kB |
| `git diff --check` / `git diff --check 15c134a..HEAD` | 0 / 0 |

### 未测与边界

- 未调用付费模型；A 的快照反例用注入 host double 提供「调用方读到的旧行」并转发到真实 helper，B 的 opener 为注入函数，未真正打开任何文件。
- B 的凭据仍只来自主进程进程内的读取记录：重启或缓冲淘汰后，历史 `document` 来源显示「该来源没有可核验的读取记录」，不提供重建入口（不引入磁盘索引或新授权存储）。
- C 只改 Rust 的匹配计数来源，未改节点/字节预算、排序、协议字段与渲染布局；渲染侧本轮未动。
- 仍未在打包安装包上点测（阶段 7）。

### 提交

- `d4318de` `fix(knowledge): recheck the source snapshot and the real read before acting` —— `native/knowledge/src/{queue,relations}.rs`、`native/knowledge/tests/relations.rs`、`src/main/knowledge/{manual,collector,documents}.ts`、`src/main/index.ts` 与六个回归文件（12 个文件，+314/−91）。
- 本节由随后的 docs 提交记录，交付哈希已在「验证」表中给出。

## 阶段 6 复核修复（R1～R4，2026-11-05 第十一轮，进行中）

外部报告 reportId `d5bf9353-a61b-49e3-9ceb-6a8aba636e26`，基线 `01d31b1`。

### R1 聊天与 Ask 真正拿到读工具和引用
- 三处断点：`askAgent` 构建 `ToolContext` 时丢掉 `options.knowledge`；`AssistantSession.localQueries()` 不返回 `knowledge`（ChatService 因此拿不到）；`ChatService` 只加 `search_knowledge`。现在 ctx 透传 `knowledge`，`allowedTools()` 追加 `KNOWLEDGE_TOOLS`，chat 推入两个读工具。
- 引用：`onCompleted` 把本轮 `kind === 'knowledge'` 记录的真实 ID 作为 `citedCardIds` 交给采集投影（此前完全没传，Rust 候选只在手拼 fixture 时生效）。

### R2 删除按记录级预览与真实落盘顺序
- `knowledge:impact` 改为**一次** `card.impact`（此前在 TS 里按来源合并、最多 50 条来源 ×20 项，正是 `single:0/multi:1` 误报来源）。
- 顺序改为先删原记录、后结清知识（笔记与对话一致）；未勾选以 `{cards:false}` 只失效来源并解链；勾选时带用户确认的 `ticket`；清理失败抛「记录已删除，但关联知识清理失败：…」的部分失败，可重试。
- 帮助器开关关闭但库已存在时仍执行撤回（此前 `enabled === false` 直接返回，关闭期删除遗留活跃来源）。
- wire 对齐：`card.purge` 收「身份 + `confirm:{sources,ticket}` + `cards`」，ticket 不一致回 `source_changed / 预览已失效，请重新确认` 且事务零改动；`card.impact` 增 `record/incomplete/ticket/sources`。

### R3 卡片动作
- `knowledge:continue` 不再后台 `chats.send`：只建草稿并登记卡片种子，真正发送时消费（发送前零模型调用），卡片正文按不可信参考、`MAX_CARD_CONTEXT` 截断。
- 另存为随记后立即以 `publishNote(note, [card.id])` 登记来源并引用该卡片，重复沉淀不再产新主卡。

### R4 工作流从真实读取送提炼
- 新增 `KnowledgeTools.reading(material)`：把本次工作流真的读过的材料经既有 `readingFinished` 投影发布，再按 origin 找回来源并 `extractSourceNow`（不重抓、不接受外部正文）。
- `run_workflow` 记录上一成功读取步骤的材料；`queued === 0` 如实返回失败，不再合成 `ok:true`。

### 真实回归（本轮）
- `src/main/knowledge/linkage.integration.test.ts` 6 项（真 helper）：note/thread 来源查询；按来源分页；仅单来源卡被删、双来源卡只解链；同一随记两个版本仍算「单来源依赖」（`cards:1, single:1, multi:0` 并整体删除）；旧版本预览被拒且卡片与来源均未变。
- `src/main/tools/knowledge.test.ts` 7 项：未授权轮次拒绝、`limit` 截到 8、超长查询拒绝（不截断）、无命中如实、`get_knowledge` 透出 helper 错误、`extract_knowledge` 透传 note id。
- `src/main/tools/workflow.test.ts` 22 项：仅授 `run_workflow` 时保存的 `extract_knowledge` 步骤可重放；缺知识依赖时失败且不产生第二次提炼。
- `src/main/notes-ipc.test.ts` 15 项：顺序为「先删记录、后结清的知识」、勾选回传 `ticket`、清理失败报部分失败、未勾选以 `{cards:false}` 结清。

### 验证（本轮最终代码）
| 命令 | 结果 |
| --- | --- |
| `cargo fmt -- --check` | exit 0 |
| `cargo test --locked` | exit 0，130 passed（lib 18 / cards_view 11 / extract 15 / process 11 / profile 27 / queue 22 / relations 26） |
| `cargo clippy --locked --all-targets -- -D warnings`（含 `--features fixture`） | exit 0 / exit 0 |
| 定向 Vitest（knowledge、tools、notes-ipc、chat、assistant、workspace、preload、ipc-trust、settings） | 77 文件 / 1071 项全过 |
| `tsc -p tsconfig.node.json` / `-p tsconfig.web.json` | 0 / 0 |
| `pnpm test` | exit 0，276 文件通过 / 3 跳过，3941 项通过 / 8 跳过 |
| `pnpm build` | exit 0，11.87 s |
| `git diff --check` | exit 0 |

### 未测与边界
- R1 的「真实 `ChatService`/`AssistantSession` + 仅替网络的传输替身」端到端断言尚未补齐（目前覆盖到工具注册、授权门、采集投影与单元级透传）。
- 未做隔离 Electron 真窗口点击验证（继续讨论、随记↔卡片跳转）。
- `card.purge` 的旧 `{sources,cards}` 无 ticket 形态仍被 Rust 接受为即时重算（向后兼容）；TS 只走身份 + `confirm` 形态。

## 阶段 5 外部验收与阶段 6 实施记录（2026-11-05 第十轮）

外部 Codex 在 `0178d20` 上核对阶段 5：`cargo test --locked` 114 项、targeted vitest 24 文件 / 232 项、`git diff --check 15c134a..HEAD` 通过、release 3,085,824 字节 `f73ace70b183b43edf156a6c4bd896d4e5bdcbe601c058cacd958353258a00c9`，阶段 5 通过并授权阶段 6（软件联动）。阶段 7 未开始。

### 交付条目

| 条目 | 落点 | 真实行为 |
| --- | --- | --- |
| 对话/提问检索 | `src/main/tools/knowledge.ts`、`src/main/tools/registry.ts`、`src/main/chat.ts`、`src/main/assistant.ts`、`src/main/index.ts` | 只读 `search_knowledge`/`get_knowledge` 走真实 Rust 卡片检索与详情；仅在知识开关打开且本轮 allowlist 含该工具时可用（`availableToolNames` 与 `runRegisteredTool` 两处同时校验）；本轮未授权时拒绝并说明，不静默降级 |
| 画像上下文 | `src/shared/prompts.ts`、`src/main/chat.ts`、`src/main/assistant.ts`、`src/main/index.ts` | 每轮按画像开关读取 helper 的有界画像（≤2000 字符）并作为参考材料放进提示词：开关关着返回空，helper 读不到时静默降级，回答照常完成；提示词末尾写明与用户当前这句话冲突时以当前这句话为准；读取点位于取消可感知处，读到一半被停止就结束本轮 |
| 引用 | `src/shared/workspace.ts`、`src/main/knowledge/collector.ts`、`src/renderer/src/settings/WorkspaceSearch.tsx`、`App.tsx` | 检索结果进入既有本地引用通道（`LocalRecord.kind` 新增 `knowledge`），只登记本轮真正取回的卡片；点击走知识页并定位卡片；被删卡片显示页面自身的缺失状态 |
| 复用去重 | `src/main/knowledge/collector.ts`、`native/knowledge/src/{queue,extract}.rs` | 本轮引用 id 去重保序、上限 12 条随 `source.publish` 落库（`sources.cited_card_ids`）；提炼时按 6 张 × 400 字符并入比较候选，纯复述落到 `reference` 不新增卡片，新结论仍 `new` |
| 卡片联动 | `src/main/index.ts`、`src/renderer/src/settings/sections/KnowledgeCardDetail.tsx` | 「继续讨论」用既有新对话链路并只携带该卡片 id 与 2000 字正文；「生成待办」写既有提醒存储；「另存为随记」写既有随记存储；主进程按 id 重读，卡片被删时报真实原因 |
| 随记联动 | `src/main/index.ts`、`src/renderer/src/settings/pages/NotesPage.tsx` | 随记详情列出由该随记生成的卡片（Rust 按来源 id 过滤后再分页，真实 `total`），点击进入知识页；最多 3 次分页请求 |
| 删除联动 | `src/main/index.ts`、`src/main/notes-ipc.ts`、`native/knowledge/src/purge.rs`、`src/renderer/src/settings/pages/{NotesPage,ChatPage}.tsx` | 删除前预览受影响卡片（单来源/多来源分别统计）；默认只作废来源并保留知识；勾选「同时删除仅依赖这条记录的知识」时只删唯一有效来源就是该记录的卡片，其余仅解链；Rust 在一个 `Immediate` 事务内重校验版本，版本不符的记录 `skipped` |
| 工作流 | `src/shared/workflow.ts`、`src/shared/workflow-tool-groups.ts`、`src/main/tools/workflow.ts`、`src/renderer/src/settings/sections/WorkflowEditor.tsx` | 新增步骤工具 `extract_knowledge`，复用随记来源发布与既有队列，返回真实 `queued`/`reason`；已保存流程重放时按当前知识开关准入，不需要聊天 allowlist 点名 |

### 新增协议与入口

| RPC | params | result | scope |
| --- | --- | --- | --- |
| `source.find` | `{channel?, originRef?, groupKey?}` | `{sources: [...]}`（≤200，按 `at` 升序） | 只读 |
| `card.by_source` | `{sourceId?} \| {channel, originRef} \| {channel:'chat', groupKey}` + 分页/过滤 | 与 `card.list` 同形（先过滤后分页） | 只读 |
| `card.impact` | 同上（来源身份） | `{sourceId, version, sources, cards, single, multi, items≤20, more}` | 只读 |
| `card.purge` | `{sources:[{id,version}], cards}` | `{removed, kept, skipped}` | `cards` |
| `source.publish` | 原字段 + `citedCardIds?: string[]`（≤12×128 字符） | 原样 | `queue` |

- IPC：`knowledge:by-source`、`knowledge:impact`、`knowledge:continue`、`knowledge:card-todo`、`knowledge:card-note`；`notes:remove(id, {deleteKnowledge})`；`chat:edit({action:'delete', id, deleteKnowledge})`，全部经 `handle()` + 信任校验。
- 工具：`search_knowledge`（空查询与超 200 字查询拒绝，`limit` ≤8，默认 5）、`get_knowledge`、`extract_knowledge`。
- 迁移：`KNOWLEDGE_SCHEMA` 7 → 8，`CITED_SQL` 只有 `ALTER TABLE sources ADD COLUMN cited_card_ids TEXT NOT NULL DEFAULT '[]'`，旧库原地升级、旧行保留。

### 证据（真实 helper、真实入口）

- `src/main/knowledge/linkage.integration.test.ts`（5 项，真实 release helper）：按 `originRef` 找到随记与对话来源；`cardsBySource` 只列该记录的卡片且带真实 `total`；预览 `{cards:2, single:1, multi:1}` 后 purge `removed:[唯一来源卡]`、`kept:[双来源卡]`，保留卡 `sourceIds` 指向另一条随记；`cards:false` 只解链；未落库的版本字符串 `skipped` 且不删任何卡。
- `src/main/tools/knowledge.test.ts`（7 项）：无知识依赖时不广告；本轮未授权时拒绝；`limit` 收敛到 8、查询去空白；超长查询拒绝且 `searchCards` 未被调用；无命中如实返回；`get` 透出 helper 错误；`extract_knowledge` 转发 noteId 并回报真实分组。
- `src/main/knowledge/collector.test.ts`（22 项）：引用 id 去重、空值丢弃、上限 12；空列表不下发 `citedCardIds`。
- `src/main/notes-ipc.test.ts`（15 项）：purge 先于 `store.remove` 执行；purge 被拒时记录仍在且不广播删除；未勾选时不请求 purge。
- `src/main/tools/workflow.test.ts`（22 项）：已保存的 `extract_knowledge` 步骤只授权 `run_workflow` 也能重放；知识依赖缺失时该步失败且不产生第二次提炼。
- `src/main/workspace.test.ts`（4 项）：`recordsFromTool('search_knowledge')` 产 `kind:'knowledge'`；`readWorkspaceRecord` 不含知识卡（渲染侧先路由到知识页）。
- `src/shared/prompts.test.ts`（43 项）与 `src/main/chat.test.ts`（16 项）：画像块只在有内容时出现、写明「以当前这句话为准」；`ChatService` 把拿到的画像传给本轮上下文，读不到时上下文为空但回答仍落 `done`。`src/main/assistant.test.ts`（58 项）：提问侧同样带画像，画像读取抛错时该轮没有画像字段（并在 await 之后重新检查取消）。
- Rust 新增：`tests/cards_view.rs` 的来源分页用例、`tests/relations.rs` 的 impact/purge/thread 用例 5 项、`tests/extract.rs` 的引用复述 3 项、`src/store.rs` 的 v7→v8 升级用例。

### 验证（本轮最终代码，实际命令与退出码）

| 命令 | 结果 |
| --- | --- |
| `cargo fmt -- --check` | 0 |
| `cargo test --locked` | 0（124 项：lib 18 / cards_view 10 / extract 15 / process 11 / profile 27 / queue 22 / relations 21） |
| `cargo clippy --locked --all-targets -- -D warnings` | 0（含 `--features fixture` 变体） |
| `node scripts/build-native.mjs` | 0；release `native/bin/yu-knowledge.exe` 3,162,112 字节 `d14e7e397396e2045ee1221f3f473dc6046f231f2c1c16857e5d32a08fe447c7` |
| `pnpm typecheck` | 0（node + web） |
| 定向 vitest（`src/main/knowledge`、chat/notes/notes-ipc/assistant/workspace、`src/main/tools`、preload、ipc-trust、`src/renderer/src/settings`） | 78 文件 / 1121 项 |
| `pnpm test:native` | 0（7 个 crate） |
| `pnpm test` | 0（276 文件通过 / 3 跳过，3940 项通过 / 8 跳过，96.13 s） |
| `pnpm build` | 0（`KnowledgePage-B1B150_h.js` 200.28 kB，`settings-BQOcJqrR.js` 4,708.92 kB，11.59 s） |
| `git diff --check`、`git diff --check 0178d20..HEAD` | 0 / 0 |

### 未测与边界

- 未调用任何付费模型：检索、引用、提炼与删除预览都跑真实 release helper，模型调用一律用注入 completer。
- 未在打包安装包上点测（阶段 7 范围）。
- 删除联动跨两个数据库，不是单一事务：顺序是知识库 purge 事务成功后删记录；purge 失败则不删记录并保留可重试状态（`notes-ipc.test.ts` 记录了这个顺序），不做跨库回滚的承诺。
- 引用正文按 6 张 × 400 字符进入比较候选，超出部分不参与复用判断；这 6 张按来源聚合取最早引用。
- 批量删除随记不携带 `deleteKnowledge`（逐条删除才有该选项）。
- 随记详情的知识区不订阅 `onChanged`，进入或翻页时取最新数据。
- 重建打包产物与节点/字节预算沿用阶段 5 结论，未重新做性能基准。

### 提交

- `c9d3fb5` `feat(knowledge): link retrieval, citations and record deletion to the helper` —— 44 个文件（+2482/−62），含 `native/knowledge/src/purge.rs`、`src/main/tools/knowledge.ts` 两个新文件与全部回归。
- `5a98e43` `feat(knowledge): read the bounded user profile into every answer` —— 8 个文件：`src/shared/prompts.ts`（`PromptContext.profile` 与 `profileContext()`）、`src/main/chat.ts`、`src/main/assistant.ts`、`src/main/index.ts`（`profileText` 提供者）与三处测试。
- 说明：`pnpm test` 首轮出现 1 项失败，重跑两次均为 276 文件 / 3940 项通过；首轮失败项的名称未被保留，`src/main/chat.test.ts` 随后连续三次单独重跑 16/16 通过。
- 本节由随后的 docs 提交记录。
