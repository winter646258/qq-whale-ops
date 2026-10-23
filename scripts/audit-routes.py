#!/usr/bin/env python3
"""路由审计：把 src/bridge.js 里所有的路径判断逐条抽出来。

产出：
  - 每条路由的行号、缩进、匹配方式（=== / startsWith）、路径、所在上下文
  - 缩进直方图（用于判断闸门层级）
  - 前缀路由（startsWith）单独表

只读，不改任何文件。
"""
import re
import json
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge/src/bridge.js'
lines = open(SRC, encoding='utf-8').read().split('\n')

# 匹配： url.pathname === '/xxx'   或   url.pathname.startsWith('/xxx')
pat = re.compile(
    r"""url\.pathname\s*(?:
        (?P<op1>===|==|!==|!=)\s*(?P<q1>['"`])(?P<p1>[^'"`]*)(?P=q1)
      | (?P<op2>\.startsWith)\s*\(\s*(?P<q2>['"`])(?P<p2>[^'"`]*)(?P=q2)
    )""",
    re.X,
)

rows = []
for i, line in enumerate(lines, 1):
    for m in pat.finditer(line):
        indent = len(line) - len(line.lstrip())
        if m.group('op2'):
            kind = 'startsWith'
            path = m.group('p2')
            neg = False
        else:
            kind = 'equals'
            path = m.group('p1')
            neg = m.group('op1') in ('!==', '!=')
        rows.append({
            'line': i,
            'indent': indent,
            'kind': kind,
            'path': path,
            'negated': neg,
            'text': line.strip()[:150],
        })

# 缩进直方图
hist = {}
for r in rows:
    hist[r['indent']] = hist.get(r['indent'], 0) + 1

# 前缀路由表
prefix = [r for r in rows if r['kind'] == 'startsWith']

print('=== 总体 ===')
print('路径判断总数:', len(rows))
print('落在多少行:', len({r['line'] for r in rows}))
print('=== 缩进直方图 ===')
for k in sorted(hist):
    print(f'  {k:>2} 空格: {hist[k]:>3}')
print('=== 前缀路由（startsWith）', len(prefix), '条 ===')
for r in prefix:
    print(f'  L{r["line"]:<6} indent={r["indent"]:<2} {r["path"]}')
print('=== 精确匹配（===）', len([r for r in rows if r['kind'] == 'equals']), '条，按路径排序 ===')

# 去重看路径
uniq = {}
for r in rows:
    uniq.setdefault(r['path'], []).append(r)
for p in sorted(uniq):
    ls = uniq[p]
    print(f'  {p:<52} x{len(ls):<2} lines={[x["line"] for x in ls][:6]}')

json.dump(rows, open('/tmp/routes.json', 'w'), ensure_ascii=False, indent=1)
print('\n已写 /tmp/routes.json')
