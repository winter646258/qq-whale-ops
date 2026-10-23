# -*- coding: utf-8 -*-
"""
让「有额度就画」变成事实，而不是「如果他是在要图」这种问句。

线上实测（2026-10-23 日志全量配对）：
    授予额度 107 次，真的调了 qq_generate_image 的只有 14 次；
    where group:906710082 给了 74 次额度，生图请求 0 次 —— 成功率 0/74。

根因是三句劝退话叠在一起：
  1. 唤醒提示 imageLine：「如果他是在要图，就用…」「没要图就别主动画」
  2. 工具描述：「一张约 40 秒、花 $0.01，别连着画」
  3. 同一条唤醒里还可能有「【参与度参考】你最近 1 小时发言 N 次」推她少说

第 1、2 句最要命：她把「判断他是不是在要图」当成自己的责任，
一想「刚刚才画过、别连着画」，就改成嘴上应付「显示不了就删了呗」。

改法：
  · 唤醒提示改成陈述句「这一轮你可以画」，并明确「额度已经批了，不用自己掂量」
  · 「别连着画」从工具描述里删掉 —— 频次由服务端 60 秒节流兜着，
    不该让模型替系统克制（实测节流每次都在 14ms 内拦下，很便宜）

用法：
    python3 patch-image-nudge.py [TARGET]     # TARGET 默认 /opt/qq-bridge
"""

import io
import os
import sys

TARGET = sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge'
BRIDGE = os.path.join(TARGET, 'src', 'bridge.js')
MCP = os.path.join(TARGET, 'src', 'mcp-snowluma-safe.js')


def read(p):
    with io.open(p, encoding='utf-8', newline='') as f:
        return f.read()


def write(p, s):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(s)


def ensure(cond, msg):
    if not cond:
        print('FAIL: ' + msg)
        sys.exit(1)


src = read(BRIDGE)

# ── 1. 主人私聊那段 ────────────────────────────────────────────────
PID = '// MARKER: image-nudge-private'
OLD_P = (
    "        imageLine = '【画画】主人私聊里想要图就用 qq_generate_image（prompt 写清要什么）。"
    "一张约 40 秒、花 $0.01，别连着画。画完会给你 url 和本地路径，发给他就行。\\n"
)
NEW_P = (
    "        // MARKER: image-nudge-private\n"
    "        imageLine = '【画画】你的生图额度**这一轮是开着的** —— 主人私聊里提到图、让你画、"
    "或者你觉得该给他看个什么，直接用 qq_generate_image（prompt 写清主体/风格/构图）。"
    "一张约 40 秒；连不连着画是服务端管的，你不用自己掂量，额度开着就动手。"
    "画完会给你 url 和本地路径，发给他就行。\\n"
)

if PID not in src:
    ensure(src.count(OLD_P) == 1, '私聊 imageLine 锚点命中 %d 次（应恰好 1）' % src.count(OLD_P))
    src = src.replace(OLD_P, NEW_P, 1)
    print('[1] 改主人私聊 imageLine')

# ── 2. 群聊那段 ────────────────────────────────────────────────────
GID = '// MARKER: image-nudge-group'
OLD_G = (
    "        imageLine = '【画画】刚才主人 @ 了你，如果他是在要图，就用 qq_generate_image"
    "（prompt 写清要什么）。一张约 40 秒、$0.01，别连着画。没要图就别主动画。\\n"
)
NEW_G = (
    "        // MARKER: image-nudge-group\n"
    "        imageLine = '【画画】刚才主人 @ 了你 / 叫了你的名字 —— 这一轮你的生图额度**是开着的**。"
    "他要图就直接用 qq_generate_image 画出来发出去（prompt 写清主体/风格/构图），"
    "**别只回一句「画好了」然后不动手**，也别把「他到底是不是在要图」当成要你反复掂量的事："
    "他说了跟图有关的话就画，他明显在聊别的就不用管。一张约 40 秒；连不连着画服务端会管，不用你克制。\\n"
)

if GID not in src:
    ensure(src.count(OLD_G) == 1, '群聊 imageLine 锚点命中 %d 次（应恰好 1）' % src.count(OLD_G))
    src = src.replace(OLD_G, NEW_G, 1)
    print('[2] 改群聊 imageLine')

# 断言：劝退式措辞不该再出现在 imageLine 里
seg_start = src.find('let imageLine =')
seg_end = src.find('// MARKER: group-digest-inject', seg_start)
ensure(seg_end > seg_start, '找不到 imageLine 段的结束锚点')
seg = src[seg_start:seg_end]
ensure('如果他是在要图' not in seg, '旧劝退句「如果他是在要图」还在')
ensure('没要图就别主动画' not in seg, '旧劝退句「没要图就别主动画」还在')
print('[3] 劝退句已清除')

write(BRIDGE, src)

# ── 3. 工具描述删掉「别连着画」 ─────────────────────────────────────
mcp = read(MCP)
MID = '// MARKER: ia-desc-image'
OLD_M = '画一张图。prompt 写清要什么：主体、风格、构图、色调。一张约 40 秒、花 $0.01，别连着画。返回 url（会过期）和本地路径（长期保留）。'
NEW_M = (
    '画一张图，画好会自动发到当前会话。prompt 写清要什么：主体、风格、构图、色调。'
    '一张约 40 秒。返回 url（会过期）和本地路径（长期保留）。'
    '**被称呼/被要求画的时候直接画，不要用文字说「画好了」来代替调用这个工具。**'
)

if '画一张图，画好会自动发到当前会话' not in mcp:
    ensure(mcp.count(OLD_M) == 1, '工具描述锚点命中 %d 次（应恰好 1）' % mcp.count(OLD_M))
    mcp = mcp.replace(OLD_M, NEW_M, 1)
    print('[4] 改 qq_generate_image 工具描述')

ensure('别连着画' not in mcp.split(MID)[0][-400:], '工具描述里「别连着画」没删干净')
write(MCP, mcp)

print('OK 全部完成')
