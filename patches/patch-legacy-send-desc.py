#!/usr/bin/env python3
"""
修三个旧发送工具的描述 —— 修 // MARKER: legacy-send-desc

## 三个毛病

1. **「必须命中白名单」是错的**。`qq_send_private_message` 写着
   「目标 QQ 必须命中系统白名单（config.json 的 allow.private），否则拒绝」，
   但实际准入是 `allowed()`：

       friendOnly===true 时，只要是好友就放行；
       allow.private 只用来放行「非好友」

   3098835427 不在 allow.private 里，却因为好友身份发得出去。
   描述跟实际不符，她自己判断不了哪个是真的。

2. **没写「主人私聊里能代发」**。10-22 加了跨会话代发，但三个旧工具的描述
   一个字都没提。她 06:48 想给第三方发图，撞上「agent token 无效」——
   现在端点已经修了（patch-legacy-send-delegate.py），描述也要跟上。
   注意 `qq_send_group_message` / `qq_reply` **不能**代发（群目标一律拒绝），
   只有私聊那条能，所以两句不一样。

3. **优先顺序写反了**。三处都写「优先使用 qq_send_message」，
   但老端点与 /api/socialV2/send-message 走的是不同的限流与记录路径。
   真正该说的是「两个都行，选哪个都算」，别制造二选一的焦虑。
"""

import os
import shutil
import sys
import time

MCP = '/opt/qq-bridge/src/mcp-snowluma-safe.js'
MARKER = '目标 QQ 必须是好友，或命中 config.json 的 allow.private 白名单'

# ── 1. qq_send_private_message 描述 ────────────────────────────────────
OLD_PRIV = (
    "'向指定 QQ 好友发送一条私聊消息。若提供 replyToMessageId，会以 QQ 引用/回复形式发出"
    "（引用条 + 文本）。replyToMessageId 必须是非零整数消息 id（QQ 消息 id 可能为负数），"
    "可先用 qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，"
    "但优先使用 qq_send_message；调用时必须携带会话令牌 token，否则会被拒绝。"
    "不要在发送后输出“已发送”类汇报。目标 QQ 必须命中系统白名单（config.json 的 allow.private），否则拒绝。'"
)

NEW_PRIV = (
    "'向指定 QQ 好友发送一条私聊消息。若提供 replyToMessageId，会以 QQ 引用/回复形式发出"
    "（引用条 + 文本）。replyToMessageId 必须是非零整数消息 id（QQ 消息 id 可能为负数），"
    "可先用 qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一"
    "（和 qq_send_message 等价，选哪个都行）。调用时必须携带会话令牌 token，否则会被拒绝。"
    "不要在发送后输出“已发送”类汇报。"
    "目标 QQ " + MARKER + "（好友就够，白名单只是额外放行非好友的人）；"
    "在主人私聊里可以用主人自己的令牌代发给好友（只限私聊好友，不能代发到群）。'"
)

# ── 2. qq_send_group_message 描述 ──────────────────────────────────────
OLD_GRP = (
    "'向指定 QQ 群发送一条纯文本消息；如需引用某条消息，可传 replyToMessageId"
    "（非零整数，可为负数），可先用 qq_get_recent_messages / qq_get_message_detail 查询。"
    "二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；"
    "reserved2 下调用时必须携带会话令牌 token，否则会被拒绝。"
    "不要在发送后输出“已发送”类汇报。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。'"
)

NEW_GRP = (
    "'向指定 QQ 群发送一条纯文本消息；如需引用某条消息，可传 replyToMessageId"
    "（非零整数，可为负数），可先用 qq_get_recent_messages / qq_get_message_detail 查询。"
    "二代模式（reserved2）下这是可用的发送工具之一（和 qq_send_message 等价，选哪个都行）。"
    "reserved2 下调用时必须携带会话令牌 token，否则会被拒绝。"
    "不要在发送后输出“已发送”类汇报。"
    "目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。"
    "注意：群发送**不能**用主人的令牌代发，只能发你自己所在的会话。'"
)

# ── 3. qq_reply 描述 ───────────────────────────────────────────────────
OLD_REPLY = (
    "reserved2 下调用时必须携带会话令牌 token。"
    "目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。'"
)

NEW_REPLY = (
    "reserved2 下调用时必须携带会话令牌 token。"
    "目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。"
    "群回复同样不能用主人的令牌代发。'"
)


def fail(msg):
    print(f'FAIL: {msg}')
    sys.exit(1)


def apply(src, old, new, label):
    hits = src.count(old)
    if hits != 1:
        fail(f'{label} 锚点命中 {hits} 次（应为 1）')
    return src.replace(old, new, 1)


def main():
    if not os.path.exists(MCP):
        fail(f'{MCP} 不存在')

    with open(MCP, 'r', encoding='utf-8') as f:
        src = f.read()

    if MARKER in src:
        print('已装，跳过')
        return

    out = apply(src, OLD_PRIV, NEW_PRIV, 'qq_send_private_message')
    out = apply(out, OLD_GRP, NEW_GRP, 'qq_send_group_message')
    out = apply(out, OLD_REPLY, NEW_REPLY, 'qq_reply')

    # 自检
    if '必须命中系统白名单（config.json 的 allow.private）' in out:
        fail('私聊描述里的错误白名单句还在')
    if '优先使用 qq_send_message' in out:
        fail('「优先使用 qq_send_message」还在，说明有一处没替换')

    ts = time.strftime('%Y%m%d-%H%M%S')
    backup = f'{MCP}.bak-legacydesc-{ts}'
    shutil.copy2(MCP, backup)
    with open(MCP, 'w', encoding='utf-8') as f:
        f.write(out)

    print('已改 3 处描述：私聊 / 群发 / 群回复')
    print(f'备份：{backup}')
    print(f'字节：{len(src)} → {len(out)}')


if __name__ == '__main__':
    main()
