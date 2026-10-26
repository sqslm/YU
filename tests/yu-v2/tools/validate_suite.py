#!/usr/bin/env python3
"""Validate the YU V2 suite, no dependencies beyond stdlib."""
import json, pathlib, collections, sys
here=pathlib.Path(__file__).resolve().parents[1]
f=here/'YU_V2_150_cases.json'
d=json.loads(f.read_text(encoding='utf-8'))
c=d['cases']
assert d['count']==len(c)==150,(d['count'],len(c))
assert [v['id'] for v in c]==[f'YU-{x:03d}' for x in range(1,151)],'IDs must be contiguous, 001-150'
assert len(set(v['id'] for v in c))==150
assert len(d['modules'])==17
assert sum(m['count'] for m in d['modules'])==150
ct=collections.Counter(v['module'] for v in c)
for m in d['modules']:assert ct[m['code']]==m['count'],m
required=('utterance','expected_action','precondition','assertions','method','priority','evidence_to_collect','cleanup','result_status')
for v in c:
 for k in required:assert k in v and isinstance(v[k],str) and v[k].strip(),(v['id'],k)
 assert v['result_status']=='NOT_RUN',v['id']
 assert v['priority'] in ('P0','P1','P2'),v['id']
 assert v['source']==('V1_retained' if int(v['id'][-3:])<=100 else 'V2_new')
 text=' '.join(str(v[k]) for k in ('utterance','expected_action','assertions'))
 assert not any(w in text for w in ('长期记忆','记住我','个人偏好记忆','跨会话记忆','向量记忆')),(v['id'],'memory exclusion')
print('OK: 150 cases, 17 modules, 100 V1 retained + 50 new, all NOT_RUN, memory excluded.')
print('Modules:',dict(sorted(ct.items())))
