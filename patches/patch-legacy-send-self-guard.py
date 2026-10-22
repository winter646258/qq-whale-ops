#!/usr/bin/env python3
"""
补一条：代发只能发给**别人**，不能借代发的名义把消息灌进主人自己的会话。

修复 // MARKER: legacy-send-self-guard

## 怎么发现的

实测边界时报了两条 200：

    主人令牌 → /api/send/private 好友        200 ok:true
    主人令牌 → /api/send/private 发给自己    200 ok:true   ← 这条不该过

日志坐实它真的发出去了：

    07:19:21 [send] /api/send/private private:1124721191: 成功 1/1 条

## 为什么 ownerDelegateTokenOk 没拦住

它第 4 行确实写着 `if (id === ownerQQ) return false;`，但那行只在
「agentTokenOk 失败后」才会被调用。主人私聊是自己的会话，
`agentTokenOk('private:<ownerQQ>', <主人令牌>)` **第一层就通过**，
`agentTokenOkOrOwnerDelegate` 直接 return true，压根没走到代发判定。

再加上 `/api/send/*` 这一段里**没有** `modeAllowed` 复查
（`/api/socialV2/send-message` 那套有），于是消息一路落到
`sendMessagesV2` 真发出来。

## 这不是这次改出来的

改造前这里是严格 `agentTokenOk`，同样的请求也同样会过 —— 老问题，
只是从来没人从「发给自己」这个角度测过。

## 改法

在正确的令牌之外，**明确要求这是代发**：如果令牌来自主人私聊、
而目标也是主人私聊，就必须是主人私聊自己的令牌（那就是普通发送，
应该走 qq_send_message），否则拒绝。

判据保持最简单的一句话：**目标是自己就不许代发**。
"""

import os
import shutil
import sys
import time

BRIDGE = '/opt/qq-bridge/src/bridge.js'
MARKER = '// MARKER: legacy-send-self-guard'

ANCHOR = (
    "          if (token && !agentTokenOkOrOwnerDelegate(key, token)) "
    "{ sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }"
)

ADDITION = ANCHOR + """
          // MARKER: legacy-send-self-guard
          // 上面那行对「主人令牌发给自己」是放行的：主人私聊本来就是自己的会话，
          // agentTokenOk 第一层就过，ownerDelegateTokenOk 里那句
          // `if (id === ownerQQ) return false` 根本没机会执行。
          // 而 /api/send/* 这一段没有 modeAllowed 复查，消息会直接落到
          // sendMessagesV2 真发出去（2026-10-23 07:19:21 日志里确实发过一条）。
          // 代发这条路只用来发**给别人**，发自己的会话请用 qq_send_message。
          if (token && key === `private:${String(cfg.ownerQQ ?? '')}` && !agentTokenOk(key, token)) {
            sendJson({ ok: false, error: '不能代发到主人自己的会话：直接用自己的令牌走 qq_send_message' }, 403);
            return;
          }"""


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

    hits = src.count(ANCHOR)
    if hits != 1:
        fail(f'锚点命中 {hits} 次（应为 1）')

    ts = time.strftime('%Y%m%d-%H%M%S')
    backup = f'{BRIDGE}.bak-selfguard-{ts}'
    shutil.copy2(BRIDGE, backup)

    out = src.replace(ANCHOR, ADDITION, 1)

    if out.count(MARKER) != 1:
        fail('替换后 MARKER 数量不对')
    if "不能代发到主人自己的会话" not in out:
        fail('新拒绝分支没进去')

    with open(BRIDGE, 'w', encoding='utf-8') as f:
        f.write(out)

    print('已加：目标是自己时拒绝代发')
    print(f'备份：{backup}')
    print(f'字节：{len(src)} → {len(out)}')


if __name__ == '__main__':
    main()
