#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""修 switch-provider.sh 里未定义的 $B。

根因：set -u 下 probe_primary() 引用 $B（第 241/244 行），而脚本只定义了
B_PROVIDER / B_MODEL / B_EFFORT，从来没有 B。于是每次走到恢复探测就
`line 241: B: unbound variable` → exit 1 → systemd 10s 后拉起 → 再等 300s → 再崩。
实测 NRestarts=46。后果：主渠道 loomy 即使恢复也永远不会被切回。

修法：引入明确的 BRIDGE_DIR，把两处 $B 换成它。命中数不符就不写盘。
"""
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge/switch-provider.sh'
DST = sys.argv[2] if len(sys.argv) > 2 else '/tmp/switch-provider.patched.sh'

t = open(SRC, encoding='utf-8').read()


def rep(old, new, expect, label):
    n = t.count(old)
    if n != expect:
        raise SystemExit(f'[{label}] 命中 {n} 处，期望 {expect}，未写盘')
    return t.replace(old, new)


# 1) 在 STATE 定义后补 BRIDGE_DIR（与 CFG/STATE 同风格，绝对路径）
t = rep(
    'STATE=/opt/qq-bridge/state/provider-switch.json\n',
    'STATE=/opt/qq-bridge/state/provider-switch.json\nBRIDGE_DIR=/opt/qq-bridge\n',
    1,
    'BRIDGE_DIR 定义',
)

# 2) 两处 $B -> $BRIDGE_DIR
t = rep(
    'local script="$B/scripts/probe-model.mjs"',
    'local script="$BRIDGE_DIR/scripts/probe-model.mjs"',
    1,
    'probe-model 路径',
)
t = rep(
    'out=$(cd "$B" && timeout 90 node "$script"',
    'out=$(cd "$BRIDGE_DIR" && timeout 90 node "$script"',
    1,
    'probe 工作目录',
)

# 3) 防回归：全文不应再出现裸 $B（$B_PROVIDER 等不算）
import re
leftover = [m.start() for m in re.finditer(r'\$B(?![_A-Za-z0-9])', t)]
if leftover:
    raise SystemExit(f'仍有 {len(leftover)} 处裸 $B，未写盘')

open(DST, 'w', encoding='utf-8').write(t)
print(f'OK -> {DST}')
print('BRIDGE_DIR 行:', [l for l in t.splitlines() if l.startswith('BRIDGE_DIR')])
