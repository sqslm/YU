# Rust 知识库、知识卡片与用户画像开发计划

**状态：阶段 1、阶段 2 已通过外部复核；阶段 3 已实现，待外部 Codex 复核。阶段 4～7 未开始；用户可见的知识库/画像功能尚未开放。**

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
- 关闭即静默：总开关关闭时 `extract.next` 返回 `enabled: false`、不占用任务；`ExtractEngine` 在未运行、未启用或游戏态下不发请求，空闲等待上限 60 秒，不轮询全库。

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
