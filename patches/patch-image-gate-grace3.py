#!/usr/bin/env python3
"""生图闸门宽限：reason 被 notify-ai 覆盖时，改用「主人最近 @ 过」兜底。

现场（15:05–15:07 采样）：

    15:05:34 [image] 授予额度（group:906710082，无原因）   ← notify-ai，没带 wakeReason
    ...      status 一直返回「只有主人私聊、或在群里@你...」

为什么 reason 丢了：notify-ai 走的是 deliverPrompt(key, promptText, { silent: true })，
**没有 wakeReason**。但 deliverPromptNow 一上来就
`globalThis.__qqTurnContext = { key, reason: opts.wakeReason || '' }`，
于是后台提醒把紧接着真唤醒（reason=question）的上下文覆盖成空串，
宽限分支再拿 reason 判 byMention 就永远为 false。

上一版补丁（patch-image-gate-grace2）只保证「自己带的 reason 能传下去」，
挡不住被别的投递覆盖。这里加一层语义兜底：

  回合结束 90 秒内、且该群最近 3 分钟内有主人发言
  → 视同 byMention 成立

安全性：冒充仍然被挡，因为 isOwner 是桥接按 QQ 号判的，群友改昵称没用；
另外「主人没说话时不许画」这一条也没放松——ownerSpoke 依旧必过。
换句话说：主人刚在这个群里说过话（很可能就是 @ 她），她就有 90 秒余量补画。
"""
import pathlib
import sys

TARGET = pathlib.Path('/opt/qq-bridge/src/bridge.js')

OLD = """    const r = String(reason || '');
    const byMention = r === 'atMention' || r === 'nameMention' || r === 'question';
    return ownerSpoke && byMention ? 'owner-group' : null;"""

NEW = """    const r = String(reason || '');
    let byMention = r === 'atMention' || r === 'nameMention' || r === 'question';
    // 后台提醒（notify-ai）投递时不带 wakeReason，会把上下文 reason 覆盖成空串，
    // 于是紧跟着的真唤醒判不出 byMention。这里兜一层：主人三分钟内在群里说过话，
    // 就当作是被叫了（冒充挡不住 isOwner，冒充者也改不了 QQ 号）。
    if (!byMention) {
      const limit = Date.now() - 180000;
      byMention = recent.some((m) => m && m.isOwner && Number(m.time ?? 0) >= limit);
    }
    return ownerSpoke && byMention ? 'owner-group' : null;"""


def main():
    text = TARGET.read_text(encoding='utf-8')
    n = text.count(OLD)
    if n != 1:
        print(f'❌ 命中 {n} 次（应为 1），拒绝写盘')
        return 1
    TARGET.write_text(text.replace(OLD, NEW), encoding='utf-8')
    print('✅ bridge.js：imageSceneFor 增加「主人三分钟内说过话」兜底')
    return 0


if __name__ == '__main__':
    sys.exit(main())