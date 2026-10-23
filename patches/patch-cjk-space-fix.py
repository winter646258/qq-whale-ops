#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""修正补丁里的配置路径：allowCjkSpaces 在顶层 role 段，不在 socialV2.role。

依据 src/bridge.js:1132 `roleInjectMaxChars = applyRoleInjectLimit(cfg.role.maxInjectChars);`
—— 人格注入上限读的是 **cfg.role**。上一版补丁写成了 cfg.socialV2?.role，永远读到 undefined。
"""
import sys

PATH = '/opt/qq-bridge/src/bridge.js'

with open(PATH, 'r', encoding='utf-8') as f:
    src = f.read()

pairs = [
    ('    const allowCjkSpaces = cfg.socialV2?.role?.allowCjkSpaces !== false;',
     '    const allowCjkSpaces = cfg.role?.allowCjkSpaces !== false;'),
    ('    if (cfg.socialV2?.role?.allowCjkSpaces !== false) return null;',
     '    if (cfg.role?.allowCjkSpaces !== false) return null;'),
    ("roleWarnings(content, 'v2', cfg.socialV2?.role?.allowCjkSpaces !== false)",
     "roleWarnings(content, 'v2', cfg.role?.allowCjkSpaces !== false)"),
]
for old, new in pairs:
    n = src.count(old)
    if n == 0:
        print(f'!! 没找到: {old[:70]}')
        sys.exit(1)
    src = src.replace(old, new)
    print(f'OK  {n} 处')

# 顺手把注释里的开关名写对（配置的顶层 role 段）
src = src.replace(
    '由 socialV2.role.allowCjkSpaces 控制，默认 true；设 false 可恢复旧行为。',
    '由 config.json 顶层 role.allowCjkSpaces 控制，默认 true；设 false 可恢复旧行为。')

assert 'cfg.socialV2?.role?.allowCjkSpaces' not in src, '仍有旧路径残留'

with open(PATH, 'w', encoding='utf-8') as f:
    f.write(src)
print(f'\n已写入，{len(src)} 字符')
