#!/usr/bin/env python3
"""修「群里 @ 她生图没反应」：imageSceneFor 读错了消息存储。

现象（10-22 13:0x）：主人在群里 @ 她、明确要图，她回「图这边生成不了，得由
老板在后台开权限」，一次都没画过。日志里所有生图请求的 scene 都是
owner-private，从来没有 owner-group。

根因：imageSceneFor 里判断「该群两分钟内有主人发言」时读的是

    const recent = social.recentMessages.get(key) ?? [];

但那是**一代**（social）的存储。二代 reserved2 模式下，消息由
appendSocialV2Message 存进 `socialV2` 会话自己的 st.recentMessages，
src/bridge.js:8772 的注释原话就写着「二代模式则直接存在 socialV2 会话的
recentMessages/unread 消息对象上」。所以二代下 social.recentMessages 里
根本没有群消息，ownerSpoke 恒为 false，imageSceneFor 恒返回 null：

  - 唤醒 prompt 不会注入群聊版【画画】提示（她不知道能画）
  - 就算她硬调 qq_generate_image，imageAllowedNow 也会以「场景不对」拒绝

修法：优先读二代会话的 recentMessages，读不到再回落一代。
"""
import pathlib
import sys

TARGET = pathlib.Path('/opt/qq-bridge/src/bridge.js')

OLD = """    const recent = social.recentMessages.get(key) ?? [];
    const cutoff = Date.now() - 120000;
    const ownerSpoke = recent.some((m) => m && m.isOwner && Number(m.time ?? 0) >= cutoff);"""

NEW = """    // 二代消息存在 socialV2 会话里（见本文件 socialV2 定义处注释），
    // social.recentMessages 只有一代才写。这里两个都看，否则群里恒判为「主人没说话」。
    const v2state = socialV2.conversations.get(key);
    const recent = (Array.isArray(v2state?.recentMessages) && v2state.recentMessages.length)
      ? v2state.recentMessages
      : (social.recentMessages.get(key) ?? []);
    const cutoff = Date.now() - 120000;
    const ownerSpoke = recent.some((m) => m && m.isOwner && Number(m.time ?? 0) >= cutoff);"""


def main():
    text = TARGET.read_text(encoding='utf-8')
    n = text.count(OLD)
    if n != 1:
        print(f'❌ 命中 {n} 次（应为 1），拒绝写盘')
        return 1
    TARGET.write_text(text.replace(OLD, NEW), encoding='utf-8')
    print('✅ bridge.js：imageSceneFor 改为读二代会话的 recentMessages')
    return 0


if __name__ == '__main__':
    sys.exit(main())
