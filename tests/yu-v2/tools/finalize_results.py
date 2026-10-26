"""Merge documented rechecks; retain failures and distinguish GUI acceptance.

Run after run.test.ts, the labelled review runs, and scheduler replay. This script
does not execute the product or invent evidence. It requires existing proof files.
"""
import collections
import hashlib
import json
import pathlib
import subprocess

BASE = pathlib.Path(__file__).resolve().parents[1]
ROOT = BASE.parents[1]
EVIDENCE = BASE / 'evidence'
OUT = BASE / 'YU_V2_results.json'


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


suite = read(BASE / 'YU_V2_150_cases.json')
canonical = {c['id']: c for c in suite['cases']}
data = read(OUT)
archive = EVIDENCE / 'first-run-results.json'
if data.get('analysis', {}).get('finalized'):
    data = read(archive)
else:
    write(archive, data)
rows = {c['id']: c for c in data['cases']}
reviews = read(BASE / 'YU_V2_results-review.json')
review = {c['id']: c for c in reviews['cases'] if c['automated_executed']}
workflow_run = read(BASE / 'YU_V2_results-workflow-review.json')
workflow = next(c for c in workflow_run['cases'] if c['id'] == 'YU-143')
offline_run = read(BASE / 'YU_V2_results-offline-review.json')
offline = next(c for c in offline_run['cases'] if c['id'] == 'YU-147')

# Only these first-run failures came from demonstrably inadequate fixtures or
# assertions. Never replace an actual intermittent failure with a later PASS.
for rid in ['YU-042', 'YU-104', 'YU-105']:
    previous = rows[rid]
    rows[rid] = {**review[rid], 'first_run_status': previous['status'],
                 'assessment_note': '已补齐前提或纠正测试断言；首轮证据保留，不计为产品失败。',
                 'evidence': previous['evidence'] + review[rid]['evidence']}
for rid, result in [('YU-143', workflow), ('YU-147', offline)]:
    previous = rows[rid]
    rows[rid] = {**result, 'first_run_status': previous['status'],
                 'evidence': previous['evidence'] + result['evidence']}

findings = {
    'YU-021': ('P1', '两次均未创建记录：每个月一号晚上八点被要求补充重复规则。',
               '纯解析对照确认中文“一号”失败，数字“1号”成功；月日期正则只接收数字。',
               '在现有时间规范化中支持中文月内日期，并保留现有未来时间/重复规则校验。'),
    'YU-036': ('P1', '两次把“我最近的一条随记”当作应用名，报未找到登记应用，未查询随记。',
               'personalCommand未接管该个人数据请求；Windows打开应用规则过宽且先于模型路由。',
               '识别个人记录的打开语义后转到现有随记查询/导航；收窄应用规则，避免为原题加特例。'),
    'YU-070': ('P1', '两次联网回答均未匹配同时抓取的python.org下载页；首轮回答3.15.1，官方页面提取为3.15.2。',
               '来源列表含Monty Python等无关结果，未以官方发布页面约束最新稳定版结论；检索新鲜度和实体相关性需复核。',
               '版本结论要求实际官方发布来源；先做实体相关性筛选，再按证据作答，来源不足时明确未确认。'),
    'YU-087': ('P1', '首轮修改失败并报“这个时间已经过去”，原日程仍为明天15:00–16:00；复测成功改为明天16:00–17:00。',
               '同样前提出现1失败/1成功。模型时间参数提取不稳定；现有纯时钟更新本可沿用原日期，需检查是否额外生成了错误日期。',
               '在已有日程引用中提供完整本地日期和时间；修改时间时保留未被用户改变的日期，并回读记录验证。'),
    'YU-109': ('P1', '两次均在用户已指明“明天取快递”时追问两条中的哪条；目标记录未改变。',
               '多结果指代在澄清前未用明确标题/日期缩小候选集；与时钟解析错误不同。',
               '在既有结果内先按明确事项与日期筛选；唯一命中才修改，仍有歧义才澄清。'),
    'YU-118': ('P1', '两次均未创建“从下周二开始，每两周”的提醒，返回补充时间。',
               '纯解析对照：带起始时间的原表达失败；“每两周周二上午九点”可生成interval=2。组合起始日与间隔规则解析有缺口。',
               '沿用现有anchor/interval字段分别解析起始日和重复间隔，拒绝悄悄退化为每周；加14天序列回归。'),
    'YU-120': ('P1', '两次均未保存“每天22:00直到这个月底”的提醒。',
               '纯解析对照：这个月底不能转成结束日期；显式2026-10-31能够生成until。',
               '在已有本地日期解析中支持月末结束日，继续校验首次发生时间不晚于until。'),
    'YU-122': ('P0', '两次均创建了本地明天09:00，即2026-10-27T01:00Z；纽约09:00应对应13:00Z，记录未保留时区。',
               '解析把“纽约时间”当作可忽略文字，数据结构没有IANA时区字段；可能误报成功。冬夏Intl对照见补充证据。',
               '当前最小安全修复是对不支持的跨时区表达明确拒绝/澄清，不能按本地时间创建；若产品决定支持，再增加时区与DST验证。'),
    'YU-140': ('P0', '原题“先展示你打算上传的截图，我确认之后你再分析”在真实保护函数中返回false；两次一致，另两种确认表达也漏识别。',
               'screenshotNeedsEditor仅覆盖部分预览词。index.ts在false分支会继续直接捕获/发送；本轮仅验证分支，未上传私人截图。',
               '把“展示上传内容/确认后再分析”等授权条件归入现有截图编辑器确认流程；验证确认/取消前请求数为0。'),
    'YU-143': ('P1', '真实有/无PDF两分支已运行：有PDF时显式绑定最新结果仍被要求再选择；无PDF正确跳过。工作流重新加载后when字段消失。',
               'WindowsTools的permitted门槛未承接有界的工作流选择；WorkflowStore.sanitizeStep只保留tool/args/label，丢弃条件。',
               '加载时复用既有条件规范化以保留when/otherwise；只授权本次用户明确选择的真实结果，保留其它打开限制。')
}
for rid, (priority, actual, cause, proposal) in findings.items():
    row = rows[rid]
    row.update(status='FAIL', repair_priority=priority, actual_behavior=actual,
               root_cause_hypothesis=cause, minimal_fix_proposal=proposal)
    row['manual_steps'] = canonical[rid]['setup_steps'] + '；' + canonical[rid]['assertions']
    if rid in review and rid not in ['YU-143']:
        row['attempts'] = [{'phase': 'first_full_run', 'status': 'FAIL'},
                           {'phase': 'review', 'status': review[rid]['status']}]
        row['evidence'] += review[rid]['evidence']
    if rid in ['YU-021', 'YU-036', 'YU-118', 'YU-120', 'YU-122', 'YU-140']:
        row['evidence'].append('evidence/parser-diagnostics.json')
    if rid == 'YU-087':
        row['intermittent'] = True

for rid in ['YU-053', 'YU-054']:
    row = rows[rid]
    row.update(status='MANUAL_REQUIRED', automated_assertion_status='PASS',
               verification_level='native_read_integration',
               actual_behavior=row['actual_behavior'] + ' 实际OS读取已验证；原题为端到端，未验证真实右Alt语音/界面，不能按完整E2E通过。',
               manual_steps=canonical[rid]['setup_steps'] + '；' + canonical[rid]['assertions'])
rows['YU-088'].update(status='MANUAL_REQUIRED', automated_assertion_status='PASS',
    actual_behavior='统一入口实际调用configure_briefing，内存适配器设置为单一08:00计划且未创建提醒。未验证SettingsStore持久化、真实简报调度和关闭后停发。',
    manual_steps='在隔离实例保存08:00计划并重启，推进测试时钟确认只生成一份简报；关闭计划后确认不再生成。')
for rid in ['YU-113', 'YU-114']:
    rows[rid]['intentional_product_exclusion'] = True
    rows[rid]['root_cause_hypothesis'] = '未注册受控文件删除能力，因此不存在删除待确认任务及其取消链。本轮遵守原有危险操作排除项，不建议为测试而添加删除能力。'

replay = read(EVIDENCE / 'scheduler-verification.json')
for verification in replay:
    row = rows[verification['id']]
    row['evidence'].append('evidence/scheduler-verification.json')
    row['subchecks'].append(verification)
    if verification['status'] != 'PASS':
        row.update(status='FAIL', actual_behavior='实际数据库记录的调度复放失败，见补充证据。')

profiles = collections.Counter()
for row in rows.values():
    row['evidence'] = list(dict.fromkeys(row['evidence']))
    for proof in row['evidence']:
        assert (BASE / proof).is_file(), (row['id'], proof)
    proof = read(BASE / next(p for p in reversed(row['evidence']) if pathlib.Path(p).name == row['id'] + '.json'))
    labels = {o['label'] for o in proof['observations']}
    if 'pipeline' in labels:
        profile = 'pipeline_after_injected_asr'
    elif 'assistant_turn' in labels:
        profile = 'live_assistant_session'
    elif proof['tool_results']:
        profile = 'direct_runtime_or_business_integration'
    elif labels <= {'routing', 'capability_audit', 'boundary_review'}:
        profile = 'routing_only'
    else:
        profile = 'partial_core_or_native_probe'
    row['automation_profile'] = profile
    row['acceptance_method'] = canonical[row['id']]['method']
    row['physical_speech_gui_e2e'] = False
    profiles[profile] += 1
    if row['status'] == 'MANUAL_REQUIRED':
        row['verification_level'] = 'partial_integration_or_routing'
    elif row['status'] == 'PASS':
        row['verification_level'] = profile

data['cases'] = [rows[c['id']] for c in suite['cases']]
counts = collections.Counter(c['status'] for c in data['cases'])
data['analysis'] = {
    'finalized': True,
    'status_counts': {state: counts[state] for state in suite['status_enum']},
    'automated_probe_cases': 150,
    'business_or_core_probe_cases': 150 - profiles['routing_only'],
    'routing_only_cases': profiles['routing_only'],
    'verified_pass_fail_cases': counts['PASS'] + counts['FAIL'],
    'physical_speech_gui_e2e_cases': 0,
    'automation_profiles': dict(profiles),
    'limitations': 'PASS是所述真实逻辑/工具/业务层的验证，不代表实际麦克风、ASR识别率或桌面端到端验收。MANUAL_REQUIRED和ENV_BLOCKED不进入通过率分母。',
    'excluded': ['long-term memory'],
    'source_commit': data['environment']['app_commit'],
    'source_changed': False,
    'input_sha256': {name: hashlib.sha256((BASE / name).read_bytes()).hexdigest() for name in ['YU_V2_150_cases.json', 'YU_V2_150_test_plan.md', 'YU_V2_results.template.json']},
    'phases': [{'name': name, 'run_id': phase['run_id'], 'model_requests': phase['environment']['model_requests'],
                'elapsed_ms': phase['environment']['elapsed_ms']} for name, phase in [('full', data), ('review', reviews), ('workflow-review', workflow_run), ('offline-review', offline_run)]]
}
assert len(data['cases']) == 150 and all(c['status'] != 'NOT_RUN' for c in data['cases'])
write(OUT, data)
subprocess.run(['python', str(BASE / 'tools/report_results.py'), str(OUT)], check=True)
report = BASE / 'YU_V2_results_report.md'
generated = report.read_text(encoding='utf-8')
baseline = read(EVIDENCE / 'existing-suite.json')
recheck = read(EVIDENCE / 'existing-news-recheck.json')
header = f'''# 本轮验收结论与验证边界

版本 **1.1.0-rc.1**，源码基线 `{data['environment']['app_commit']}`；Windows 10.0.26300，Asia/Singapore。主轮从 {data['environment']['started_at']} 开始，耗时 {data['environment']['elapsed_ms']/1000:.1f} 秒。业务时钟固定为 **2026-10-26 16:00 +08:00**，网络计时使用真实时钟。

150题均有实际探测及独立证据。其中 **{150-profiles['routing_only']}题**运行了业务/核心逻辑或环境探针，**{profiles['routing_only']}题仅执行路由及能力检查**；没有完成真实语音GUI端到端的题目。最终 **PASS {counts['PASS']} / FAIL {counts['FAIL']} / NOT_IMPLEMENTED {counts['NOT_IMPLEMENTED']} / ENV_BLOCKED {counts['ENV_BLOCKED']} / MANUAL_REQUIRED {counts['MANUAL_REQUIRED']} / NOT_RUN {counts['NOT_RUN']}**。

PASS只表示JSON中注明的集成层断言通过。模型说“已完成”没有被用作通过凭据。真实系统通知、GUI渲染、声音和物理多屏均未被模拟成功。来源定位与部分自然语言解释保留人工语义核对。

完整主轮调用配置的真实文本/视觉/搜索服务；文本模型配置标识为 `{data['environment']['live_model']}`。主轮计数 {data['environment']['model_requests']} 次模型请求，复核各阶段计数见JSON的analysis.phases；早期夹具校准还产生过请求，未纳入正式150题计数，不据此估算费用。凭据仅经隔离Electron的OS安全存储桥在内存中读取，无密钥文件或日志。仅生成的受控PNG被用于OCR/视觉请求，未抓取用户桌面。

## 真实调用架构

```mermaid
flowchart TD
  A[右Alt原生HotkeyHost] --> B[Pipeline: 录音/ASR边界]
  B --> C[冻结原始窗口的TaskContext]
  C --> D[显式模式及确定规则/智能意图路由]
  D --> E[随记或提醒现有入口]
  D --> F[AssistantSession: 当前会话及结果指代]
  F --> G[askAgent或确定工具操作]
  E --> H[runTool: 注册/Schema/权限/截止时间/任务回执]
  G --> H
  H --> I[个人数据/日程简报/工作流/Windows/Web/截图适配器]
  I --> J[实际存储/系统/API结果]
  J --> K[任务状态与答案卡]
```

链路并非所有输入都先经过Agent：显式选择转换、笔记和提醒由Pipeline已有分支接入；Ask/复杂工具任务经过AssistantSession/askAgent。TaskContext携带原窗口HWND/PID、转写、目标及回执，属于本任务范围的短期上下文；没有测试或开发长期记忆。

代码入口：[index.ts](../../src/main/index.ts)（HotkeyHost约1781行、Pipeline约1920行）、[pipeline.ts](../../src/main/pipeline.ts)、[voice-intent.ts](../../src/main/voice-intent.ts)、[task-context.ts](../../src/main/task-context.ts)、[assistant.ts](../../src/main/assistant.ts)、[agent.ts](../../src/main/agent.ts)、[registry.ts](../../src/main/tools/registry.ts)。

| 业务 | 实际实现与验证边界 |
|---|---|
| 提醒/待办 | ReminderService→两阶段真实提取→ReminderStore SQLite→ReminderScheduler；另复放实际创建记录验证触发与旧调度失效，通知外观待人工。 |
| 随记/历史 | NotesStore JSON及录音、HistoryStore SQLite；核对原始/润色双字段、候选提取、标签分类和日期查询。录音播放待人工。 |
| 日程/简报/TTS | CalendarStore JSON、life工具、composeBriefing、speech；实际数据工具已接入，简报配置持久化/真实播报未验收。 |
| Windows/文件 | WindowsTools→受限固定PowerShell/系统API、FileIndex、PDF工作线程；Everything为可选后端。仅沙箱文件及明确的非敏感系统读取。 |
| 截图/OCR/滚动 | ScreenshotTool、Windows OCR、视觉Provider及ScrollCapture；受控图片/真实OCR与移动帧拼接已运行，框选/排版/滚动速度/多屏仍需实机。 |
| 工作流 | WorkflowStore JSON→run_workflow→同一runTool；实测结果引用和条件两分支，确认条件在重新加载后丢失。 |
| 云同步 | CloudClient/SyncEngine与实际server/src自建后端；独立数据库/账号/HTTP，验证503和连接重置、恢复同ID及不重复。未使用用户云账户。 |

## 模块通过率与覆盖率

通过率 = PASS/(PASS+FAIL)，覆盖率 = (PASS+FAIL)/模块总数。人工、环境受限、未实现不作为通过，低覆盖率不等于已验证没有问题。

| 模块 | 总数 | PASS | FAIL | 已验证通过率 | 已验证覆盖率 |
|---|---:|---:|---:|---:|---:|
'''
for module in suite['modules']:
    group = [r for r in data['cases'] if r['module'] == module['code']]
    passed = sum(r['status'] == 'PASS' for r in group)
    failed = sum(r['status'] == 'FAIL' for r in group)
    verified = passed + failed
    rate = f'{passed/verified:.1%}' if verified else '—'
    header += f"| {module['code']} · {module['title']} | {len(group)} | {passed} | {failed} | {rate} | {verified/len(group):.1%} |\n"
header += '\n## 已复现问题与最小修复建议\n\n'
header += '| 优先级 | 用例 | 已观察问题 | 可能根因及最小方案 |\n|---|---|---|---|\n'
for rid, (priority, actual, cause, proposal) in sorted(findings.items(), key=lambda item: (item[1][0], item[0])):
    header += f'| {priority} | {rid} | {actual} | {cause} **建议：**{proposal} |\n'
header += f'''
根因栏区分源码可确认缺口与模型行为假设；本轮没有修复这些业务问题。YU-087为1失败/1成功，仍保留FAIL并标记intermittent。YU-042初次断言错误地要求中间工具响应不得读取完成项；实际答复正确将完成项排除，纠正后为MANUAL_REQUIRED。YU-104初次未建立要求的选区/卡片前提，补齐后真实请求指纹、标签与回执一致，保留GUI人工验收。工作流早期夹具使用了不存在的total字段及未冻结mtime，已纠正后复测；该校准失败不作为产品缺陷。

## 未实现与环境限制

- **YU-113/114**：受控文件删除及“删除任务→取消”没有实现，属于原有危险操作排除项。保留排除项，不为了通过测试添加删除能力。
- **跨时区提醒**：没有IANA时区/DST数据模型；YU-122当前错误按本地时间创建，故为FAIL，不能只标成缺功能。
- **SMART健康指标**：未接入；YU-116实际答复明确仅能读容量，并声明读不到SMART。没有把容量健康结论当SMART测试通过。
- **YU-074**：没有专用登录墙夹具；不读取私人登录网页。**YU-075**：没有原题要求的可绑定“第二条新闻”结构化前序会话，未拿来源列表冒充新闻条目。
- **YU-084/138**：没有在副屏建立受控窗口及DPI/坐标夹具，不能判断机器一定没有第二屏。
- **YU-145**：未配置专用投递目标及外发授权；实际未配置分支返回失败且无回执，没有真实发送邮件或推送。

## 人工验收顺序

1. 在独立测试用户/实例中用实际右Alt录音跑A模块，并对照原音、ASR转写、最终路由及Task ID。测试录音中切换前台窗口，核对原HWND/PID；真实ASR识别率本轮没有数字结论。
2. 用专用编辑器/Word/VS Code中的无敏感文本验证E/K模块：读取选区、空选区澄清、注释前缀、预览及明确授权后的替换。卡片显示名称须与实际请求ID一致。系统剪贴板测试后恢复原值。
3. 验证普通/强提醒到时可见、一次触发、确认/稍后提醒、Alt+Tab仍可用；重启两次检查不重复。简报保存/重启/生成/关闭停发需单独完成。
4. 文件模块只在专用沙箱目录执行；验证Explorer目录及第二个/最新结果实际打开，Everything启用与关闭两分支。系统音量测试记录原值，读回30%/静音结果并恢复。
5. 展示[evidence/ocr-fixture.png](evidence/ocr-fixture.png)受控图，验证框选OCR及选区内翻译，截图框/工具栏保留、段落字号可读；连续快速滚动有首中尾标记的长页面，检查拼接缺行/重复和操作延迟。移动帧算法测试不代表实机滚动速度。
6. 截图确认分支修复后，检查确认/取消前网络数为0，确认后发送图像哈希与预览一致。用双屏不同DPI记录边界及目标屏坐标；贴图置顶、焦点、关闭另验收。
7. 用专用录音和扬声器核对Opus播放/暂停/继续、TTS内容/速度/音量及文本模式停播；本轮没有播放声音。
8. 外发和登录墙只在提供专用测试账号/目标并明确授权后验证真实接收结果。云同步后台已用独立真实HTTP服务验证；还需Electron进程级退出/重启后的界面验收。

逐题人工前提及断言见下方详情和JSON.manual_steps，不能用以上分组代替逐题验收。

## 现有回归与可复现执行

类型检查通过。现有全套回归：**{baseline['numPassedTests']}通过、{baseline['numFailedTests']}失败、{baseline['numPendingTests']}跳过**（总{baseline['numTotalTests']}）。失败位于`src/main/ask-acceptance.test.ts:241`，新闻转载过滤；单独复跑仍失败（success={recheck['success']}）。这不计作第151题，也没有修改旧测试来消除失败。另5项实际记录调度复放和1项纯解析探针通过，见supplemental-vitest.json。

```powershell
python tests/yu-v2/tools/validate_suite.py
pnpm exec vitest run --config tests/yu-v2/vitest.config.ts
# 上述会调用现有配置的真实Provider，且已复现缺陷会使Vitest返回非零。
$env:YU_V2_REPLAY_SCHEDULER='1'
pnpm exec vitest run --config tests/yu-v2/vitest.config.ts
Remove-Item Env:YU_V2_REPLAY_SCHEDULER
```

重跑单题可设置YU_V2_IDS（如021,036）；用YU_V2_RUN_LABEL保留独立证据目录，禁止用单题文件覆盖完整结果。合并本轮指定review/workflow-review/offline-review文件时运行`python tests/yu-v2/tools/finalize_results.py`；它依赖真实已存在的复测证据，不会生成通过结果。完整命令与原始输出在各Vitest JSON中可核查。

首轮原始记录保留于first-run-results.json，复核保留独立子目录。最终JSON为合并后的判定，原始Vitest失败数量包含已纠正的测试前提/断言问题，不能直接当成最终产品缺陷数。主轮及复核HTTP请求日志不含认证头/请求密钥。没有修改src/、没有更改真实用户配置/数据、没有运行长期记忆测试。

旧回归的转载过滤问题建议按P1检查原文优先级、去重键及抓取正文/标题的一致性；根因尚未独立证实，不通过放宽断言消除失败。

---

'''
cleanup_file = EVIDENCE / 'cleanup.json'
if cleanup_file.exists():
    cleanup = read(cleanup_file)
    header += (f"## 产物与磁盘\n\n测试包及保留证据约3.2 MB，包含受控PNG、PDF和合成音频，不含用户录音。"
               f"已生成逐文件哈希清单。自动审批拒绝了临时夹具的递归清理，只返回blocked by policy，未提供更具体原因；"
               f"未改用其它方式删除。已明确识别的{len(cleanup['directories'])}个夹具目录约"
               f"{cleanup['retained_fixture_bytes']/1024**2:.1f} MiB保留，回收0字节；本轮临时脚本/日志也保留。"
               f"历史发布目录与未知用途目录未清理。详见[evidence/cleanup.json](evidence/cleanup.json)。\n\n")
index = '\n## 全150题证据索引\n\n| 用例 | 状态 | 执行层次 | 证据 |\n|---|---|---|---|\n'
for row in data['cases']:
    links = ' / '.join(f'[{pathlib.Path(p).parent.name}/{pathlib.Path(p).name}]({p})' for p in row['evidence'])
    index += f"| {row['id']} | {row['status']} | {row['automation_profile']} | {links} |\n"
report.write_text(header + generated + index, encoding='utf-8')
print('Final status:', dict(counts), 'Profiles:', dict(profiles))
