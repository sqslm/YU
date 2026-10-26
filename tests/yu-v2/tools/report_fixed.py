"""Summarize this remediation run, retaining the original audit and raw phases."""
import collections
import hashlib
import json
import pathlib
import subprocess

base = pathlib.Path(__file__).resolve().parents[1]
root = base.parents[1]
load = lambda path: json.loads(path.read_text(encoding='utf-8'))
original = load(base / 'YU_V2_results.json')
suite = load(base / 'YU_V2_150_cases.json')
data = load(base / 'YU_V2_results-postfix.json')
rows = {row['id']: row for row in data['cases']}
assert len(rows) == 150 and all(row['automated_executed'] for row in rows.values())
phases = [('postfix', data)]
for label in ['fix-verified', 'fix-confirmed']:
    phase = load(base / f'YU_V2_results-{label}.json')
    phases.append((label, phase))
    for row in phase['cases']:
        if not row['automated_executed']:
            continue
        previous = rows[row['id']]
        rows[row['id']] = {**row, 'evidence': list(dict.fromkeys(previous['evidence'] + row['evidence']))}

attempt_phases = [(label, load(base / f'YU_V2_results-{label}.json')) for label in
                  ['fix-probe', 'fix-probe-2', 'postfix', 'fix-final', 'recurrence-trace', 'fix-verified', 'fix-confirmed']]
attempt_phases.sort(key=lambda item: item[1]['environment']['started_at'])

before = {row['id']: row for row in original['cases']}
for row in rows.values():
    row['original_audit_status'] = before[row['id']]['status']
    row['attempts'] = [{'phase': label, 'status': item['status'], 'evidence': item['evidence']}
                       for label, phase in attempt_phases for item in phase['cases'] if item['id'] == row['id'] and item['automated_executed']]
    row['physical_speech_gui_e2e'] = False
    assert row['status'] != 'NOT_RUN' and row['actual_behavior']
    for evidence in row['evidence']:
        assert (base / evidence).is_file(), (row['id'], evidence)
    if row['status'] == 'MANUAL_REQUIRED':
        assert row['manual_steps'], row['id']

paths = subprocess.check_output(['git', '-c', 'core.quotePath=false', 'diff', data['environment']['app_commit'], '--name-only', '--', 'src', 'scripts', 'README.md', 'ASSISTANT_ROADMAP.md'], cwd=root, text=True).splitlines()
paths.append('src/main/v2-regressions.test.ts')
source = {'tested_worktree_base': data['environment']['app_commit'], 'source_dirty_during_tests': True,
          'tested_run_id': phases[-1][1]['run_id'],
          'hash_basis': 'SHA256 of working-tree file bytes at final verification',
          'source_files': {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in paths}}
state_file = base / 'evidence/postfix/final-source-state.json'
if not state_file.exists() or load(state_file).get('tested_run_id') != source['tested_run_id']:
    state_file.write_text(json.dumps(source, indent=2) + '\n', encoding='utf-8')
counts = collections.Counter(row['status'] for row in rows.values())
data['cases'] = [rows[case['id']] for case in suite['cases']]
data['remediation'] = {
    'original_audit': 'YU_V2_results.json',
    'source_state': 'evidence/postfix/final-source-state.json',
    'status_counts': {state: counts[state] for state in suite['status_enum']},
    'code_updates_after_full_run': {
        'YU-011': 'Literal source recovery for punctuation/spacing only; real words remain mandatory.',
        'YU-118': 'Normalize an interval label only when unit/count match the deterministic parsed rule.',
        'YU-122': 'Check original requested zone before model argument validation to explain unsupported capability.'
    },
    'limits': 'Logic/integration verification only; GUI, microphone, screenshot layout and audible output retain manual status. IANA reminder semantics remain unimplemented; original unsafe local-time creation is prevented.'
}
out = base / 'YU_V2_results-fixed.json'
out.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
subprocess.run(['python', str(base / 'tools/report_results.py'), str(out)], check=True)
report = base / 'YU_V2_results-fixed_report.md'
existing = report.read_text(encoding='utf-8')
unit = load(base / 'evidence/fixes-existing-suite.json')
targeted = load(base / 'evidence/fixes-final-targeted.json')
disk = load(base / 'evidence/fixes-disk.json')
header = f'''# V2 问题修复与复测

以原始150题审计为基线修复，保留原始报告和逐题证据。先执行完整150题，再在源代码修复后复测受影响用例；各次失败与成功均保存在JSON.attempts，不把同一代码下偶然成功用来覆盖失败。

最终状态：**PASS {counts['PASS']} / FAIL {counts['FAIL']} / NOT_IMPLEMENTED {counts['NOT_IMPLEMENTED']} / ENV_BLOCKED {counts['ENV_BLOCKED']} / MANUAL_REQUIRED {counts['MANUAL_REQUIRED']} / NOT_RUN {counts['NOT_RUN']}**。PASS仅为注明的真实逻辑或业务集成层，完整语音GUI端到端验收为0。150题均已自动探测/登记，纯路由探针、桌面交互和声音没有伪装成业务成功。

| 原问题 | 修复及验证 |
|---|---|
| YU-021/118/120 | 支持中文月日期、带起始日的双周锚点、月底截止；程序仅在单位和间隔一致时规范化模型的频率标签，拒绝不一致规则。真实数据库与下一次发生时间验证通过。 |
| YU-036 | 个人记录不再被当作应用名；open_page携带真实随记ID，UI保存当前编辑后定位，重复打开同一ID也可重定位。实际窗口选中仍需人工。 |
| YU-087/109 | 识别“刚刚”的原对象，按明确标题/日期缩小候选；日程纯时钟修改直接使用原文参数，保留原日期与时长。真实记录修改已验证。 |
| YU-140 | 截图预览/上传前确认先进入本地编辑器，未确认不发图；区分“确认画面事实”和“确认上传”。真实确认/取消UI仍需人工。 |
| YU-143 | 条件和备用分支重载保留并验证；只给保存工作流中绑定前序真实文件搜索结果的ID赋予选择权限，目录、类型和工具白名单照常检查；有/无PDF分支均已验证。 |
| YU-070 | 稳定版使用技术文档检索，过期原文不会被无日期转载重新包装成新消息；无法读取官方信息时不再断言最新版。当前DNS把官方站点解析为198.18.x.x代理地址，原文读取被内网防护拒绝，故为ENV_BLOCKED；没有关闭SSRF保护。 |
| YU-122 | 已阻止按本地时间误建，并在模型改写参数时明确返回不支持；IANA时区/DST提醒尚未实现，仍为NOT_IMPLEMENTED，不能算完整功能通过。 |

新发现的YU-011复合任务标点差异也已修复：仅容忍标点和空白变化，还原实际原文后执行；不同实词、数字、否定或改口仍严格校验。新增单元测试覆盖拒绝伪造内容。

## 验证

- 项目全套：{unit['numPassedTests']}通过、{unit['numFailedTests']}失败、{unit['numPendingTests']}跳过；随后最终定向测试{targeted['numPassedTests']}通过、{targeted['numFailedTests']}失败（重叠测试不重复加总）。类型检查和Electron构建通过。
- 首次全套中search-pool有一次本地HTTP请求记录为空；该模块单跑及随后全套通过，未修改该测试或其生产逻辑。首次输出保留在evidence/fixes-existing-suite-first.json，原因未独立证实。
- 原新闻转载回归的固定日期夹具已经过期，改为由测试传入日期；断言仍要求原文优先、去除2023旧文和转载。另增加“过期原文不能被无日期转载翻新”的真实规则回归，未放宽产品过滤。
- 测试在父提交{data['environment']['app_commit']}加未提交工作树上执行，最终源码哈希见evidence/postfix/final-source-state.json；完整轮与后续小范围修复分别保留证据。没有开发/测试长期记忆，也未修改用户数据、音量、主应用配置或云账号。
- 磁盘核对：测试包与证据约{disk['retained_test_package_bytes'] / 1048576:.1f} MiB，隔离测试夹具约{disk['retained_fixture_bytes'] / 1048576:.1f} MiB。前次自动审批拒绝了夹具目录清理，本轮未重试或改用其他方式删除；实际回收0字节，详见evidence/fixes-disk.json。

## 仍需处理的边界

未实现3题为删除确认链YU-113/114（保留原有排除项）及IANA提醒YU-122。环境受限6题包括官方版本原文、登录墙、结构化前序新闻会话、副屏夹具、实际外部投递。GUI、物理右Alt/ASR、截图排版/快速滚动、通知可见性和声音继续按逐题manual_steps验收，不因底层断言通过而改为PASS。

详细状态、模块汇总和每题人工步骤如下。原始审计见[YU_V2_results_report.md](YU_V2_results_report.md)。

---

'''
report.write_text(header + existing, encoding='utf-8')
print('Remediation:', dict(counts))
