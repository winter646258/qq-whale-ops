#!/usr/bin/env python3
"""
让旧版发送端点也认「主人私聊代发」—— 修 // MARKER: legacy-send-delegate

## 为什么

2026-10-22 上线跨会话代发时，`agentTokenOkOrOwnerDelegate` 只挂到了
`/api/socialV2/` 那一套（send-message / send-sticker / send-poke / image）。

但还有**另一套更老的发送端点** `/api/send/group|private|reply`（bridge.js:8921），
`qq_send_private_message` / `qq_send_group_message` / `qq_reply` 三个 MCP 工具走的是它。
那三个工具的描述里写着「二代模式下优先使用 qq_send_message」—— 于是她照着选，
结果撞上仍然严格的 `agentTokenOk`：

    06:48:46 AI 反馈 (private:1124721191) [info]:
    尝试给管理员指定的第三方 QQ 3098835427 发私聊图，
    qq_send_private_message 返回"agent token 无效"

令牌本身是好的（主人私聊那把），是这条老路没开。**同一个能力两条路，只开了一条。**

## 改什么

把 `/api/send/*` 那一条 `if (token && !agentTokenOk(key, token))` 换成
`agentTokenOkOrOwnerDelegate`。三端点（group/private/reply）共用同一行，
换一处即可覆盖。

`ownerDelegateTokenOk`（bridge.js:4176）自己已经把边界钉死了：
目标必须是 `private:<id>`（群直接 return false）、必须是好友
（`friendSetReady && friendSet.has(id)`）、必须过 `allowed()`、
不能是自己也不能是 selfUserId。所以群发送不会被这条放宽影响。
"""

import os
import shutil
import sys
import time

BRIDGE = '/opt/qq-bridge/src/bridge.js'
MARKER = '// MARKER: legacy-send-delegate'

OLD = "          if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }"

NEW = (
    "          // MARKER: legacy-send-delegate\n"
    "          // 旧版 /api/send/* 也要认主人私聊代发。\n"
    "          // 原来这里是严格的 agentTokenOk，导致 qq_send_private_message\n"
    "          // 在主人私聊里代发好友会报「agent token 无效」—— 令牌其实是对的，\n"
    "          // 只是这条路没跟着 10-22 那次代发改动一起开。\n"
    "          // 边界由 ownerDelegateTokenOk 兜底：只放行「私聊 + 好友 + 过准入」，\n"
    "          // 群发送仍然只能用自己的会话令牌。\n"
    "          if (token && !agentTokenOkOrOwnerDelegate(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }"
)


def fail(msg):
    print(f'FAIL: {msg}')
    sys.exit(1)


def main():
    if not os.path.exists(BRIDGE):
        fail(f'{BRIDGE} 不存在')

    with open(BRIDGE, 'r', encoding='utf-8') as f:
        src = f.read()

    if MARKER in src:
        print('已装，跳过')
        return

    hits = src.count(OLD)
    if hits != 1:
        fail(f'锚点命中 {hits} 次（应为 1）—— /api/send/* 的鉴权行可能变了，先人工核对')

    # 前提：代发判定函数必须已经在（image-approval patch 装的）
    if 'const agentTokenOkOrOwnerDelegate = (key, token) => {' not in src:
        fail('agentTokenOkOrOwnerDelegate 不存在，先跑 patch-image-approval-wire.py')
    if 'function ownerDelegateTokenOk(key, token) {' not in src:
        fail('ownerDelegateTokenOk 不存在，先跑 patch-image-approval-wire.py')

    ts = time.strftime('%Y%m%d-%H%M%S')
    backup = f'{BRIDGE}.bak-legacydelegate-{ts}'
    shutil.copy2(BRIDGE, backup)

    out = src.replace(OLD, NEW, 1)

    # 自检：改完之后这一行必须还在、且必须只剩这一个代发入口
    if "if (token && !agentTokenOkOrOwnerDelegate(key, token))" not in out:
        fail('替换后没找到新鉴权行')
    if OLD in out:
        fail('旧鉴权行仍然存在')

    with open(BRIDGE, 'w', encoding='utf-8') as f:
        f.write(out)

    print(f'已改：/api/send/* 切换为 agentTokenOkOrOwnerDelegate')
    print(f'备份：{backup}')
    print(f'字节：{len(src)} → {len(out)}')


if __name__ == '__main__':
    main()
