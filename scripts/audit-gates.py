#!/usr/bin/env python3
"""闸门结构分析：找出每个路由之前最近的「检查语句」，推断它受哪些检查保护。

只读。产出 /tmp/gates.json，并打印人工可读的三段：
  1. 全局闸门位置（401 / 403 / CSRF / 方法判断）
  2. 每个路由的「最近前置检查」链
  3. 疑似未受保护的写路由（POST/PUT/DELETE 且前置检查里没有 agentToken）
"""
import re
import json
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge/src/bridge.js'
lines = open(SRC, encoding='utf-8').read().split('\n')

# 检查语句的特征（按出现顺序，后出现的覆盖前面的作用域）
CHECK_PATTERNS = [
    ('consoleToken 401',      re.compile(r'tokenMatches|未授权.{0,6}控制台')),
    ('agent-call 403',        re.compile(r"x-agent-call")),
    ('isLiveAgentToken',      re.compile(r'isLiveAgentToken')),
    ('agentTokenOk',          re.compile(r'agentTokenOk')),
    ('v2SessionAllowed',      re.compile(r'v2SessionAllowed')),
    ('v2ToolEnabled',         re.compile(r'v2ToolEnabled')),
    ('adminOnlyV2Paths',      re.compile(r'adminOnlyV2Paths')),
    ('allowAllWhenEmpty',     re.compile(r'allowAllWhenEmpty')),
    ('origin/csrf',           re.compile(r'origin|csrf|Referer', re.I)),
    ('method GET',            re.compile(r"method === 'GET'")),
    ('method POST',           re.compile(r"method === 'POST'")),
    ('phone token',           re.compile(r'phoneToken|x-phone-token')),
    ('console-token 头',      re.compile(r'x-console-token')),
]

route_pat = re.compile(
    r"""url\.pathname\s*(?:
        (?P<op1>===|==|!==|!=)\s*(?P<q1>['"`])(?P<p1>[^'"`]*)(?P=q1)
      | (?P<op2>\.startsWith)\s*\(\s*(?P<q2>['"`])(?P<p2>[^'"`]*)(?P=q2)
    )""", re.X)

# 收集所有检查语句的行号与类型
checks = []
for i, line in enumerate(lines, 1):
    for name, pat in CHECK_PATTERNS:
        if pat.search(line):
            indent = len(line) - len(line.lstrip())
            checks.append({'line': i, 'name': name, 'indent': indent})
            break

# 收集路由
routes = []
for i, line in enumerate(lines, 1):
    for m in route_pat.finditer(line):
        indent = len(line) - len(line.lstrip())
        if m.group('op2'):
            kind, path = 'startsWith', m.group('p2')
        else:
            kind, path = 'equals', m.group('p1')
        routes.append({'line': i, 'indent': indent, 'kind': kind, 'path': path})

# 对每条路由，找缩进严格小于它的最近若干检查
def preceding_checks(route, window=120):
    out = []
    for c in checks:
        if c['line'] >= route['line']:
            break
        if c['indent'] < route['indent'] and route['line'] - c['line'] <= window:
            out.append(c)
    # 只保留最近 6 条，且去重（同名只留最近）
    seen = {}
    for c in reversed(out):
        if c['name'] not in seen:
            seen[c['name']] = c
    return [seen[k] for k in seen][:6]

for r in routes:
    r['gates'] = preceding_checks(r)

json.dump({'routes': routes, 'checks': checks}, open('/tmp/gates.json', 'w'),
          ensure_ascii=False, indent=1)

print('=== 检查语句总数:', len(checks), '===')
from collections import Counter
for name, n in Counter(c['name'] for c in checks).most_common():
    print(f'  {name:<22} {n}')

print('\n=== 前缀路由及其最近闸门 ===')
for r in routes:
    if r['kind'] == 'startsWith':
        gs = ', '.join(f"{g['name']}@L{g['line']}" for g in r['gates']) or '(无)'
        print(f'  L{r["line"]:<6} {r["path"]:<22} <- {gs}')

print('\n=== 精确路由：按闸门数量分组 ===')
buckets = {}
for r in routes:
    if r['kind'] == 'equals':
        buckets.setdefault(len(r['gates']), []).append(r)
for n in sorted(buckets):
    print(f'  {n} 个闸门: {len(buckets[n])} 条')

print('\n=== 0 个闸门的精确路由（最可疑）===')
for r in buckets.get(0, []):
    print(f'  L{r["line"]:<6} indent={r["indent"]:<2} {r["path"]}')

print('\n已写 /tmp/gates.json')
