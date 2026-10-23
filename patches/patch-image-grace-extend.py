# -*- coding: utf-8 -*-
"""
群聊生图：主人在群里 @ 过她，这个许可就该在整轮对话里有效，不该被 90 秒宽限掐断。

线上实测（2026-10-23 12:56:01 / 12:57:12）：
    [image] 拒绝 group:906710082：没有回合上下文

她在群里调 qq_generate_image 时，回合已经收工超过 90 秒——
因为生图本身要 36~50 秒，而她往往是「先回一句『我去画』，
等这轮对话结束、下一轮才想起调工具」，那时 __qqTurnContext 早清了。

但「主人在群里 @ 过她」这个事实在 state/social-v2.json 的 recentMessages
里仍然成立（120 秒内主人发过言 + byMention），安全栅栏 imageSceneFor 完全挡得住冒名。
所以：回合上下文过期时，私聊维持原样（主人私聊里她随时能画？不，私聊也该有窗），
群聊则退回到「只看 imageSceneFor」—— 只要主人在两分钟内真 @ 过她，就允许。

安全边界（一条都没放松）：
  · 群聊仍然要求 imageSceneFor 返回 owner-group，即「主人 120 秒内发过言 + byMention」；
    群友改昵称冒充没用，isOwner 按 QQ 号判定。
  · 主人没在群里说话的时段，任何人都画不了。
  · 陌生人私聊、别的群，imageSceneFor 恒 null，照旧拒绝。

用法：
    python3 patch-image-grace-extend.py [TARGET]    # TARGET 默认 /opt/qq-bridge
"""

import io
import os
import sys

TARGET = sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge'
BRIDGE = os.path.join(TARGET, 'src', 'bridge.js')


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

MARK = '// MARKER: image-grace-group'

OLD = """      const fresh = ended && String(ended.key) === String(key) && Date.now() - Number(ended.at || 0) <= graceMs;
      if (!fresh) {
        log(`[image] 拒绝 ${key}：没有回合上下文`);
        return { ok: false, why: '当前没有进行中的对话' };
      }"""

NEW = """      const fresh = ended && String(ended.key) === String(key) && Date.now() - Number(ended.at || 0) <= graceMs;
      if (!fresh) {
        // MARKER: image-grace-group
        // 群聊：主人在 120 秒内真的 @ 过她，就允许画（imageSceneFor 会再判一次，
        // 冒名改昵称过不了 isOwner）。理由：生图要 36~50 秒，她常常是
        // 「先回一句我去画，下一轮才调工具」，那时回合早已收工、宽限也过期了。
        // 私聊不放宽：私聊里主人随时能说话，没有「错过就永远画不了」的问题。
        if (String(key).startsWith('group:') && imageSceneFor(key, '')) {
          log(`[image] 群聊放行（${key}，回合已结束，但主人 120 秒内 @ 过）`);
          return { ok: true, scene: 'owner-group' };
        }
        log(`[image] 拒绝 ${key}：没有回合上下文`);
        return { ok: false, why: '当前没有进行中的对话' };
      }"""

if MARK not in src:
    ensure(src.count(OLD) == 1, '宽限判定锚点命中 %d 次（应恰好 1）' % src.count(OLD))
    src = src.replace(OLD, NEW, 1)
    print('[1] 加上群聊放行分支')

# 断言：私聊路径没被放宽
ensure("if (String(key).startsWith('group:') && imageSceneFor(key, ''))" in src,
       '群聊放行分支没写进去')
ensure('只有主人私聊、或主人在群里 @ 你/叫你名字时才能画' in src,
       'scene 为空的拒绝文案被改掉了（应该还在）')

write(BRIDGE, src)
print('OK 全部完成')
