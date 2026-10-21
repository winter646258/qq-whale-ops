#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一次性脚本的临时 workspace 目录改成固定路径（幂等）。

背景：DSH 按 workspace 路径给每个会话建一个目录，slug 形如
`--tmp-model-bench-<..>--`。这些脚本原来用 `'/tmp/xxx-' + process.pid`，
跑一次就多一个会话目录 —— 云上一晚上攒了 96 个临时目录（67 个渠道探测 +
20 个测速 + 9 个其它）。

探测与测速都是串行调用，共用同一目录不会打架。

用法：python3 patch-tmp-workspace-dir.py
"""
import shutil
import sys
import time

TARGETS = [
    (
        "/opt/qq-bridge/scripts/probe-model.mjs",
        "const dir = '/tmp/channel-probe-' + process.pid;",
        "const dir = '/tmp/channel-probe';",
    ),
    (
        "/opt/qq-bridge/scripts/bench-model.mjs",
        "const dir = '/tmp/model-bench-' + process.pid;",
        "const dir = '/tmp/model-bench';",
    ),
]

stamp = time.strftime("%Y%m%d-%H%M")
changed = 0
for path, old, new in TARGETS:
    with open(path, encoding="utf-8") as fh:
        src = fh.read()

    if old not in src:
        if new in src:
            print("·  %s 已是固定目录，跳过" % path)
            continue
        print("!! %s 里既找不到旧写法也找不到新写法，跳过（请人工看一眼）" % path)
        continue

    if src.count(old) != 1:
        print("!! %s 命中 %d 次，期望 1 次，未写盘" % (path, src.count(old)))
        sys.exit(1)

    shutil.copy(path, "%s.bak-%s" % (path, stamp))
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(src.replace(old, new))
    print("✅ %s：%s -> %s" % (path, old, new))
    changed += 1

print("完成，本次改动 %d 个文件" % changed)
