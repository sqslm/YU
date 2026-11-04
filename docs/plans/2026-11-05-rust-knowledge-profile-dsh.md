# Rust 知识库、知识卡片与用户画像开发计划

**状态：阶段 1 已实现，待外部 Codex 复核。阶段 2～7 未开始；用户可见的知识库/画像功能尚未开放。**

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

基线 `4e077a3795025d61dc81878d24a1c8100f046c72`（`master`，工作区干净）。本节记录的是**已实现并实测**的内容；未实现的阶段保持“未开始”，不能把本节当作整体验收通过。

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

模型子请求 `id`（`m<N>`）与父请求 `id` 分开；过期、取消或被替换进程的迟到回包不结算任何在途请求。`TS`/`Rust` 共用 `src/shared/knowledge.ts` 的固定夹具 `KNOWLEDGE_FIXTURES` 验证结构。

方法表（`params` → `result`）：

| method | params | result |
| --- | --- | --- |
| `status` | `{}` | `{version,schema:{knowledge,profile},opened,fts5,trigram}`；不创建目录或数据库 |
| `shutdown` | `{}` | `{stopping:true}` 后进程以 0 退出 |
| `source.save` | `{kind,originRef,locator?,title?,version?,scope?,readAt?,text}` | `KnowledgeSource`（`fingerprint` 由 Rust 计算，`text` 只在本次内存使用） |
| `source.get` | `{id}` | `KnowledgeSource` |
| `source.invalidate` | `{id,reason?}` | `KnowledgeSource`（`state:"invalid"`，关联卡片保留） |
| `card.save` | `{kind,title,summary?,body,topics?,aliases?,sourceIds?}` | `KnowledgeCard` |
| `card.update` | `{id,...同上任一字段,edited?}` | `KnowledgeCard`（未显式传 `edited` 时记为人工编辑） |
| `card.get` | `{id}` | `KnowledgeCard` |
| `card.delete` | `{id}` | `{removed:true}`（写排除信息，失败不留半张卡片） |
| `card.list` | `{offset?,limit?}` | `{items,total,offset,limit}` |
| `card.search` | `{query,offset?,limit?}` | 同上；空查询等价 `card.list` |
| `profile.save` | `{dimension,value,category,origin?,pinned?,corrected?,evidence?}` | `ProfileItem`（`origin:"auto"` 不覆盖固定/已更正项） |
| `profile.update` | `{id,dimension?,value?,category?,pinned?,corrected?,evidence?}` | `ProfileItem` |
| `profile.get` | `{id}` | `ProfileItem` |
| `profile.delete` | `{id}` | `{removed:true}`（写排除信息） |
| `profile.list` | `{offset?,limit?}` | `{items,total,offset,limit}` |

错误码：`invalid_request`、`unsupported_version`、`unknown_method`、`invalid_params`、`too_large`、`not_found`、`protected_item`、`storage_error`、`storage_schema_newer`、`cancelled`、`timeout`、`model_unavailable`、`internal`。

固定上限：单帧 2 MiB（UTF-8）、`id` 128 字符、标题 200、摘要 2000、正文 200000（超限报错，不静默截断）、搜索词 200、主题 32×100、分页默认 30/最大 100；普通操作期限 15 秒、含模型回调的父操作期限 120 秒（总期限，不按消息刷新）；空闲退出 120 秒（`YU_KNOWLEDGE_IDLE_MS` 仅供测试注入更短期限）。

### 数据根、schema 与边界

- 数据根由主进程计算：打包模式 `dirname(app.getPath('exe'))`，开发模式 `app.getAppPath()`，经 `--root` 在初始化时绑定；renderer 与资料内容不能指定。库文件为 `<root>/data/knowledge/knowledge.db` 与 `<root>/data/profile/profile.db`。
- `knowledge.db`（`user_version = 1`）：`sources`、`cards`、`card_sources`、`cards_fts`（FTS5 `tokenize='trigram'`）、`exclusions`。`profile.db`（`user_version = 1`）：`profile_items`、`profile_evidence`、`exclusions`。建表与版本号在同一事务内完成；遇到比程序更新的 `user_version` 以 `storage_schema_newer` 拒绝，不降级、不重建。
- 两库与原 `chats.db`、随记存储、Mem0 `assistant/style.db`、用户模型缓存完全独立；画像证据保存原来源引用，不依赖卡片，清空知识不级联清空画像。
- 取消在提交点生效：`cards.rs` 3 处、`profile.rs` 3 处 `transaction.commit()` 前调用 `ensure_not_cancelled()`，取消后不会落库；已提交的写入如实返回结果，不虚报回滚。
- 搜索由 Rust 执行：`≥3` 字符走 FTS5 `MATCH`（查询串整体加引号，操作符一律当字面），标题/别名/主题命中优先于正文；`1～2` 字符与短查询走转义后的 `LIKE` 字面分支——实测 SQLite trigram 以 3 字符为索引粒度，`MATCH '"识图"'` 命中为空，这一点已写入 `store::probe_capabilities` 的注释与探针（探针改用 `"识图谱"`）。

### 依赖与许可证

`rusqlite = 0.41.1`（仅 `bundled`、`backup`）、`libsqlite3-sys = 0.39.1`（bundled SQLite amalgamation，public domain）、`serde`/`serde_derive = 1.0.229`、`serde_json = 1.0.151`、`sha2 = 0.10.9`；`cargo tree --target x86_64-pc-windows-msvc` 实际编译 34 个第三方 crate，版本与校验和锁定在 `native/knowledge/Cargo.lock`。许可证文本逐条登记在 `licenses/rust-<crate>-<version>-MIT`（`foldhash` 为 `-Zlib`，`unicode-ident` 另有 `-UNICODE`），`THIRD_PARTY_NOTICES.md` 新增对应表格。未引入 ORM、向量库、图数据库、网络服务器或模型依赖。

### 改动

- 新增 crate `native/knowledge/`：`Cargo.toml`、`.cargo/config.toml`（静态 CRT）、`Cargo.lock`、`src/{main,lib,protocol,store,util,sources,cards,profile,link,service}.rs`（2,737 行）、`tests/process.rs`（388 行）。
- 新增 `src/shared/knowledge.ts`（290 行，契约与夹具）、`src/main/knowledge/host.ts`（378 行，进程与管道）、`src/main/knowledge/model.ts`（62 行，模型回调）、`src/main/knowledge/{host,model,host.integration}.test.ts`。
- 接入：`src/main/index.ts`（helper 实例、15 个 `knowledge:*`/`profile:*` 通道、资源统计、游戏模式与 `before-quit` 停止）、`src/main/resources.ts`（`knowledge` PID）、`src/main/ipc-trust.test.ts`（结构性校验：`index.ts` 不得直接使用 `ipcMain.handle/on`，15 个通道必须经 `handle()`）、`src/shared/api.ts` 与 `src/preload/index.ts`（有限类型化方法，不暴露 helper、路径、SQL 或 prompt）。
- 构建与打包：`scripts/build-native.mjs` 增加 `knowledge`；`electron-builder.yml` 增加 `native/bin/yu-knowledge.exe` → `resources/native/yu-knowledge.exe`。
- 文档：README/README.en 各补一段底座说明并注明用户功能未开放；`THIRD_PARTY_NOTICES.md` 与 `licenses/` 新增条目。

### 验证（实际命令与结果）

| 命令 | 工作目录 | 结果 |
| --- | --- | --- |
| `cargo fmt -- --check` | `native/knowledge` | exit 0，无差异 |
| `cargo test --locked` | `native/knowledge` | exit 0，17 passed（12 lib + 5 process），0 failed |
| `cargo clippy --locked --all-targets -- -D warnings` | `native/knowledge` | exit 0，无告警 |
| `pnpm exec vitest run src/main/knowledge/host.test.ts src/main/knowledge/model.test.ts src/main/knowledge/host.integration.test.ts src/preload/index.test.ts src/main/ipc-trust.test.ts` | 仓库根 | exit 0，5 files / 37 tests passed（host 13、model 8、integration 5、preload 3、ipc-trust 8） |
| `pnpm typecheck` | 仓库根 | exit 0 |
| `pnpm test:native` | 仓库根 | exit 0（7 个 crate 的 `cargo test --locked`） |
| `pnpm test` | 仓库根 | exit 0，255 files / 3707 tests passed，8 skipped，98.27s（机器空闲时的一次完整运行） |
| `pnpm build` | 仓库根 | exit 0（`electron-vite build` 完成，含 renderer/settings 4.69 MB 产物） |
| `git diff --check` | 仓库根 | 无空白错误 |

真实辅助进程证据（非 mock）：`native/bin/yu-knowledge.exe`，2,302,464 字节，SHA-256 `131620348e36fa7093f998715fd83052ac1c2d5c817304da85f7f96a93baa2cc`。`native/knowledge/tests/process.rs` 用 `env!("CARGO_BIN_EXE_yu-knowledge")` 拉起同一二进制，覆盖：懒启动（`status` 不建目录，首次写库才建 `data/knowledge/knowledge.db`）、跨重启持久化、来源失效后卡片保留、卡片更新/删除、画像固定项保护、并行与拆包 UTF-8、垃圾帧、超长帧、未知方法与错误版本、`YU_KNOWLEDGE_IDLE_MS=400` 空闲退出、父进程 EOF 后自身退出（`tasklist` 校验 PID 已消失）。`src/main/knowledge/host.integration.test.ts` 用生产 `KnowledgeHost` 驱动该二进制完成同一批业务调用；`host.test.ts` 用真实管道的 Node stub 覆盖启动失败、ready、连续/并行、emoji 拆包、超时+取消后恢复、迟到回包、崩溃重启、空闲退出、`stop()` 与模型回调传递。Rust 侧 `probe_capabilities()` 在真实二进制初始化时实测 FTS5 与 trigram 均为可用（`ready` 帧回报 `fts5:true, trigram:true`）。

### 复核自查发现并修正的问题

- 空闲退出走 `stop()` 时把主机标记为“已停止”，紧接的显式请求就再也拉不起新进程（全量并发负载下由 `host.test.ts` 复现）。改为两个明确语义：`stop()` 只停当前进程、允许下次请求重启（空闲退出与游戏模式用它），`shutdown()` 供应用退出使用、此后不再启动；`index.ts` 的 `before-quit` 改用 `shutdown()`。
- 被替换的旧进程晚到的 `close`/`error` 会清空新进程的状态并连带失败新请求。宿主在 handler 里先校验 `this.child !== child` 再动状态；readline 接口在守卫之前关闭。
- 上述两点连同 trigram 粒度、`changed` 帧干扰断言一起，是本节记录的真实发现，不是事后美化。
- 全量套件在与 CPU 密集型任务（`cargo clippy`/`tsc`）同时运行时，先后出现过 `src/main/providers/asr/cn.test.ts`、`realtime.test.ts` 的本地 mock 服务连接失败与 `src/main/windows-native-browser-url.test.ts` 的 30 个 PID 观测失败；两类文件单独运行均全绿，机器空闲时的完整 `pnpm test` 也全绿，判定为本机并行负载下的既有测试抖动，未改动其断言或超时。

### 失败与未测

- 实测发现：SQLite trigram 以 3 字符为粒度，2 字 `MATCH` 无命中 → 探针改用 3 字样本，短查询走字面 `LIKE`（已在代码注释与本节记录）。
- 实测发现：`changed` 通知帧会让按行读取的断言错位 → 测试辅助函数先跳过非结果帧再匹配 `id`（实现不改）。
- 未测/未做（属阶段 2～7）：真实付费模型调用（本阶段外部 LLM 调用数 0，模型回调只用 stub 完成器验证通路）、自动输入挂钩、历史扫描、七类卡片提炼与语义去重、画像归纳、知识图谱、侧栏页面、聊天检索工具、待办/工作流联动、备份格式 v2、安装器与卸载交互。

### 资源

- 保留：`native/bin/yu-knowledge.exe`（2.3 MB，交付产物）、`native/knowledge/Cargo.lock`、`licenses/` 新增 28 个文本、`native/knowledge/target/`（697 MB，可重建构建缓存，被 `.gitignore` 的 `/native/**/target/` 忽略，与其他 crate 的 target 并存保留）。
- 回收：测试用隔离数据根位于 `%TEMP%` 下并由测试自行删除；本轮未生成其他临时脚本或证据文件，`.gitignore` allowlist 无需改动。
