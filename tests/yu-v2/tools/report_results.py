#!/usr/bin/env python3
"""Produce a factual markdown report from executed case records; never runs tests."""
import json,sys,pathlib,collections,datetime
base=pathlib.Path(__file__).resolve().parents[1]
suite=json.loads((base/'YU_V2_150_cases.json').read_text(encoding='utf-8'))
infile=pathlib.Path(sys.argv[1]) if len(sys.argv)>1 else base/'YU_V2_results.json'
if not infile.exists():
 sys.exit('No results file: '+str(infile)+'; start from YU_V2_results.template.json')
results=json.loads(infile.read_text(encoding='utf-8'))
states=set(suite['status_enum'])
refs={v['id']:v for v in suite['cases']}
seen={}
for r in results['cases']:
 rid=r.get('id')
 if rid not in refs:sys.exit('Unknown ID: '+str(rid))
 if rid in seen:sys.exit('Duplicate ID: '+rid)
 if r.get('status') not in states:sys.exit('Invalid status: '+str(r))
 if r['status'] in ('PASS','FAIL') and not r.get('evidence'):
  sys.exit('Missing evidence for '+rid+' '+r['status']+'; refuse to count as verified')
 seen[rid]=r
if set(seen)!=set(refs):sys.exit('Missing result IDs: '+str(sorted(set(refs)-set(seen))[:15]))
counts=collections.Counter(v['status'] for v in seen.values())
lines=['# 语 YU · V2 150 题实际测试报告','',f'- 结果文件：`{infile.name}`',f'- 生成时间：{datetime.datetime.now().isoformat(timespec="seconds")}','- 注意：报告只整理用户提供的结果文件，不会自动运行测试。','', '## 状态汇总','', '| 状态 | 数量 |','|---|---:|']
for s in suite['status_enum']:lines.append(f'| {s} | {counts[s]} |')
completed=counts['PASS']+counts['FAIL']
lines+=['',f'**已验证通过率：** {counts["PASS"]}/{completed} = {counts["PASS"]/completed:.1%}' if completed else '**已验证通过率：** 尚无 PASS/FAIL 实测数据',f'**已验证覆盖率：** {completed}/150 = {completed/150:.1%}','', '## 各模块','', '| 模块 | PASS | FAIL | 未实现 | 环境受限 | 需人工 | 未运行 |','|---|---:|---:|---:|---:|---:|---:|']
for m in suite['modules']:
 sub=collections.Counter(seen[c['id']]['status'] for c in suite['cases'] if c['module']==m['code'])
 lines.append(f"| {m['code']} · {m['title']} | {sub['PASS']} | {sub['FAIL']} | {sub['NOT_IMPLEMENTED']} | {sub['ENV_BLOCKED']} | {sub['MANUAL_REQUIRED']} | {sub['NOT_RUN']} |")
for state,title in [('FAIL','已复现失败（优先修复）'),('NOT_IMPLEMENTED','仓库确认未实现（产品缺口）'),('ENV_BLOCKED','环境受限'),('MANUAL_REQUIRED','待人工确认'),('NOT_RUN','未执行')]:
 lines+=['',f'## {title}：{counts[state]} 项','']
 arr=sorted([refs[id] for id,r in seen.items() if r['status']==state],key=lambda c:(c['priority'],c['id']))
 if not arr:lines.append('无。')
 for c in arr:
  r=seen[c['id']]
  lines += [f"### {c['id']} · {c['module']} · {c['priority']}",f"- 输入：{c['utterance']}",f"- 预期：{c['expected_action']}",f"- 实际：{r.get('actual_behavior') or '(未记录)'}"]
  if r.get('evidence'):lines.append('- 证据：'+ '; '.join(map(str,r['evidence'])))
  if r.get('root_cause_hypothesis'):lines.append('- 根因假设（未证实）：'+r['root_cause_hypothesis'])
  if r.get('manual_steps'):lines.append('- 人工复测：'+r['manual_steps'])
  lines.append('')
lines+=['','## Codex 后续修复约束','- 先区分实测失败、产品能力缺口和测试环境不足。','- 只针对已确认的共性根因提出最小必要修改；不在产品代码里硬编码测试语句或模拟成功。','- 不开发长期记忆系统；任务级短期指代可以保留。','- 保护用户真实数据、权限和未提交代码；高影响工具必须确认。']
out=infile.with_name(infile.stem+'_report.md')
out.write_text('\n'.join(lines)+'\n',encoding='utf-8')
print('Report written:',out)
print('Status:',dict(counts))
