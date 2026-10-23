#!/usr/bin/env python3
"""把闸门结构还原成真实的作用域，而不是「最近的几条检查」。

做法：从路由行向上回溯到最近的 `if (...)` 块头，把块头的条件当成该路由的闸门。
被 `if (url.pathname.startsWith('/api/socialV2/')) { ... 深处 ... }` 包住的路由，
会正确继承外层闸门，而不是被误判为「0 个闸门」。

只读。
"""
import re
import json
import sys
from collections import Counter

SRC = sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge/src/bridge.js'
src = open(SRC, encoding='utf-8').read()
lines = src.split('\n')

# 用括号深度法：统计每一行开头时的花括号深度
depth = 0
line_depth = []
for line in lines:
    line_depth.append(depth)
    # 去掉字符串和注释里的花括号（粗过滤，够用）
    s = re.sub(r"'[^'\\]*'", "''", line)
    s = re.sub(r'"[^"\\]*"', '""', s)
    s = re.sub(r'`[^`\\]*`', '``', s)
    s = re.sub(r'//.*$', '', s)
    depth += s.count('{') - s.count('}')

# 找所有以 `if (` 开头、块体包住后续行的位置（即该行结尾有 `{`）
block_openers = []
for i, line in enumerate(lines):
    st = line.strip()
    if st.endswith('{') and (st.startswith('if (') or st.startswith('if(')):
        block_openers.append({'line': i + 1, 'depth': line_depth[i], 'cond': st[:-1].strip()})

route_pat = re.compile(
    r"""url\.pathname\s*(?:
        (?P<op1>===|==|!==|!=)\s*(?P<q1>['"`])(?P<p1>[^'"`]*)(?P=q1)
      | (?P<op2>\.startsWith)\s*\(\s*(?P<q2>['"`])(?P<p2>[^'"`]*)(?P=q2)
    )""", re.X)

routes = []
for i, line in enumerate(lines):
    for m in route_pat.finditer(line):
        if m.group('op2'):
            kind, path = 'startsWith', m.group('p2')
        else:
            kind, path = 'equals', m.group('p1')
        routes.append({'line': i + 1, 'depth': line_depth[i], 'kind': kind, 'path': path})

# 对每条路由：把所有 depth 更小、且在它之前打开、还没闭合的 if 块头收为「作用域闸门」
for r in routes:
    chain = []
    for b in block_openers:
        if b['line'] < r['line'] and b['depth'] < r['depth']:
            chain.append(b)
    # 从深到浅保留（最近的先）
    chain.sort(key=lambda x: (-x['depth'], -x['line']))
    r['chain'] = chain[:8]

def classify(cond):
    if 'x-agent-call' in cond: return 'agent隔离'
    if 'tokenMatches' in cond or '未授权' in cond: return 'consoleToken401'
    if 'isLiveAgentToken' in cond: return 'liveAgentToken'
    if 'agentTokenOk' in cond: return 'agentTokenOk'
    if 'adminOnlyV2Paths' in cond: return 'adminOnly'
    if 'v2SessionAllowed' in cond: return 'sessionAllowed'
    if 'v2ToolEnabled' in cond: return 'toolEnabled'
    if 'phoneToken' in cond or 'x-phone-token' in cond: return 'phoneToken'
    if 'origin' in cond.lower() or 'csrf' in cond.lower(): return 'csrf'
    if 'url.pathname' in cond: return 'mount:' + re.sub(r".*['\"`]([^'\"`]*)['\"`].*", r'\1', cond)
    if "method === 'GET'" in cond: return 'GET'
    if "method === 'POST'" in cond: return 'POST'
    return 'other'

for r in routes:
    r['gate_names'] = [classify(b['cond']) for b in r['chain']]

json.dump(routes, open('/tmp/routes-scoped.json', 'w'), ensure_ascii=False, indent=1)

print('=== 作用域统计 ===')
print('路由总数:', len(routes))
has_mount = [r for r in routes if any(g.startswith('mount:') for g in r['gate_names'])]
print('挂在某个前缀挂载点下（继承外层闸门）:', len(has_mount))
no_mount = [r for r in routes if not any(g.startswith('mount:') for g in r['gate_names'])]
print('不在任何前缀挂载点下:', len(no_mount))

print('\n=== 不在挂载点下的路由（需逐个确认外层闸门）===')
for r in no_mount:
    gs = ' > '.join(r['gate_names']) or '(无)'
    print(f'  L{r["line"]:<6} d={r["depth"]:<2} {r["path"]:<30} {gs}')

print('\n=== 挂载点分布 ===')
mounts = Counter()
for r in routes:
    ms = [g for g in r['gate_names'] if g.startswith('mount:')]
    if ms:
        mounts[ms[0]] += 1
for m, n in mounts.most_common():
    print(f'  {m:<28} {n} 条')
