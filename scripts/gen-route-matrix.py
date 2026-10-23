#!/usr/bin/env python3
"""整理出「路由 × 鉴权矩阵」Markdown 表，写到指定路径。

基于 audit-routes / audit-scopes 的解析结果 + 人工确认的集中闸门结构。
只读源码，只写目标 Markdown 文件。
"""
import re
import sys
import json

SRC = sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge/src/bridge.js'
OUT = sys.argv[2] if len(sys.argv) > 2 else '/tmp/routes-matrix.md'

lines = open(SRC, encoding='utf-8').read().split('\n')

route_pat = re.compile(
    r"""url\.pathname\s*(?:
        (?P<op1>===|==|!==|!=)\s*(?P<q1>['"`])(?P<p1>[^'"`]*)(?P=q1)
      | (?P<op2>\.startsWith)\s*\(\s*(?P<q2>['"`])(?P<p2>[^'"`]*)(?P=q2)
    )""", re.X)

routes = []
for i, line in enumerate(lines, 1):
    for m in route_pat.finditer(line):
        if m.group('op2'):
            kind, path = 'prefix', m.group('p2')
        else:
            kind, path = 'exact', m.group('p1')
        routes.append({'line': i, 'kind': kind, 'path': path, 'text': line.strip()})

# 集中闸门（人工从 L4670-4790 确认，作为常量写死，避免正则误判）
G = {
    'G1_host':      'Host 校验（回环/绑定端口）',
    'G2_console450':'consoleToken 401（除 /api/phone/* 豁免）',
    'G3_agentcall': "x-agent-call 存在则必须 isLiveAgentToken（403）",
    'G4_json':      '非 GET 必须 application/json（415）',
    'G5_origin':    '带 Origin 必须同源（403）',
    'G6_emptytok':  'x-agent-token 空串拒绝（403）',
    'G7_paused':    'socialV2.paused 时 v2 路径拒绝（403）',
    'G8_disabled':  'socialV2.enabled=false 时 v2 路径拒绝（403）',
    'G9_reserved2': '带 agent token 的 /api/socialV2/* 必须 reserved2（403）',
    'G10_adminOnly':'adminOnlyV2Paths 等仅控制台（403）',
    'G11_stickers': '/api/stickers* 仅控制台（403）',
    'G12_defaultDeny': '带 agent token 时白名单外一律 403',
}

def gate_set(path, kind):
    """按集中闸门的实际条件算出这条路由受哪些闸门约束。"""
    g = ['G1_host']
    if not (kind == 'prefix' and path.startswith('/api/phone')) and not path.startswith('/api/phone'):
        g.append('G2_console450')
    g.append('G3_agentcall')
    g += ['G4_json', 'G5_origin', 'G6_emptytok']
    is_v2 = path.startswith('/api/socialV2') or path.startswith('/api/send') or path.startswith('/api/images')
    if is_v2:
        g += ['G7_paused', 'G8_disabled']
    if path.startswith('/api/socialV2'):
        g.append('G9_reserved2')
    if path in ('/api/socialV2/config', '/api/socialV2/activity', '/api/socialV2/reset',
                '/api/socialV2/states', '/api/socialV2/wake'):
        g.append('G10_adminOnly')
    if path.startswith('/api/stickers'):
        g.append('G11_stickers')
    g.append('G12_defaultDeny')
    return g

def extra_gates(r, all_lines):
    """路由内部自己的检查（读该路由后 80 行内的特征）。"""
    found = []
    lo, hi = r['line'], min(r['line'] + 90, len(all_lines))
    body = '\n'.join(all_lines[lo - 1:hi])
    for label, pat in [
        ('agentTokenOk', r'agentTokenOk'),
        ('v2SessionAllowed', r'v2SessionAllowed'),
        ('v2ToolEnabled', r'v2ToolEnabled'),
        ('phoneTokenOk', r'phoneTokenOk'),
        ('adminToken', r'adminOnlyV2Paths'),
    ]:
        if re.search(pat, body):
            found.append(label)
    return found

for r in routes:
    r['gates'] = gate_set(r['path'], r['kind'])
    r['extra'] = extra_gates(r, lines)

# ---- 写 Markdown ----
with open(OUT, 'w', encoding='utf-8') as f:
    f.write('# 路由 × 鉴权检查矩阵（自动生成，只读）\n\n')
    f.write(f'源文件：`{SRC}`\n\n')
    f.write(f'- 路径判断总数：**{len(routes)}**\n')
    f.write(f'- 落在多少行：**{len({r["line"] for r in routes})}**\n')
    f.write(f'- 精确匹配 `===`：**{len([r for r in routes if r["kind"]=="exact"])}**\n')
    f.write(f'- 前缀匹配 `startsWith`：**{len([r for r in routes if r["kind"]=="prefix"])}**\n\n')
    f.write('## 集中闸门（都在 `main()` 里，路由分发之前）\n\n')
    for k, v in G.items():
        f.write(f'- `{k}` {v}\n')
    f.write('\n> **关键结论**：这 12 道闸门是**集中式**的，都写在路由 if 链之前，'
            '所以「每条路由各自有没有写鉴权」不是主要风险面——风险在**每条路由内部的**'
            '`agentTokenOk` / `v2ToolEnabled` / `v2SessionAllowed` 用没用、用对没有。\n\n')

    f.write('## 前缀路由（顺序敏感，必须固化成显式优先级）\n\n')
    f.write('| # | 行号 | 前缀 | 内部检查 |\n|---|---|---|---|\n')
    n = 0
    for r in [x for x in routes if x['kind'] == 'prefix']:
        n += 1
        f.write(f"| {n} | L{r['line']} | `{r['path']}` | {', '.join(r['extra']) or '—'} |\n")

    f.write('\n## 全部路由\n\n')
    f.write('| 行号 | 方式 | 路径 | 内部检查 |\n|---|---|---|---|\n')
    for r in sorted(routes, key=lambda x: x['line']):
        mark = '前缀' if r['kind'] == 'prefix' else '精确'
        f.write(f"| L{r['line']} | {mark} | `{r['path']}` | {', '.join(r['extra']) or '—'} |\n")

    # 汇总：缺 v2ToolEnabled 的
    f.write('\n## 疑似缺口\n\n')
    no_tool = [r for r in routes if r['path'].startswith('/api/socialV2') and 'v2ToolEnabled' not in r['extra']]
    f.write(f'### `/api/socialV2/*` 里没有 `v2ToolEnabled` 检查的（{len(no_tool)} 条）\n\n')
    for r in no_tool:
        f.write(f"- L{r['line']} `{r['path']}`\n")
    no_sess = [r for r in routes if r['path'].startswith('/api/socialV2') and 'v2SessionAllowed' not in r['extra']]
    f.write(f'\n### `/api/socialV2/*` 里没有 `v2SessionAllowed` 检查的（{len(no_sess)} 条）\n\n')
    for r in no_sess:
        f.write(f"- L{r['line']} `{r['path']}`\n")

json.dump(routes, open('/tmp/routes-matrix.json', 'w'), ensure_ascii=False, indent=1)
print('已写', OUT)
print('路由总数', len(routes))
