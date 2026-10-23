#!/usr/bin/env python3
"""主动机会唤醒（proactiveCheck）的文案按私聊/群聊分开写。

## 为什么改

`buildWakePromptV2` 的 `proactiveCheck` 分支原来只有一份文案：

    【主动机会】private:1124721191
    原因：群里已经安静了一段时间，这是一次你可以主动冒泡的机会。
    优先主动开个话题、追问上次没聊完的事、分享一个刚想到的想法；
    如果一时想不到，可以用 web_search 搜一下当前热点/时事/网络热梗，
    再结合记忆里的群友兴趣挑一个自然角度。

但 `scheduleProactiveCheckV2` 对 `group:` 和 `private:` 两种 key 都会排档期
（正则就是 `/^(group|private):(\\d+)$/`）。私聊里读到「群里」「群友兴趣」
是明显的串味：她会以为自己在群里，说出「大家」「你们」这种对私聊对象
很怪的话，或者去搜一个热点硬塞给对方。

## 改法

一个三元表达式分叉，私聊走自己的文案：

  私聊：原因写成「和对方已经有一段时间没说话了」，动作是「接着上次的话头、
        问候一下、分享一件刚想到的和你有关的小事」，明确「不要群发的口吻，
        这是两个人的私聊」。并且诚实提醒：对方可能在忙，没回就安静收尾，
        不要连发。

  群聊：保持原样（群里确实是要挑话题、搜热点）。

## 为什么不用 who 变量

私聊 key 不一定是主人（还有好友）。原文案里 `private` 分支用的是
`key === private:${cfg.ownerQQ} ? '主人' : '对方'`。这里照抄这个判定，
但不写死称呼进正文——正文用「对方」，避免把好友叫成主人。
"""
import pathlib
import sys

TARGET = pathlib.Path('/opt/qq-bridge/src/bridge.js')

OLD = """    if (reason === 'proactiveCheck') {
      return `${base}【主动机会】${key}\\n原因：群里已经安静了一段时间，这是一次你可以主动冒泡的机会。\\n优先主动开个话题、追问上次没聊完的事、分享一个刚想到的想法；如果一时想不到，可以用 mcp__web-search-safe__web_search 搜一下当前热点/时事/网络热梗，再结合记忆里的群友兴趣挑一个自然角度。只要内容自然，就大胆开口；如果实在没话想说，再安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }"""

NEW = """    if (reason === 'proactiveCheck') {
      // MARKER: proactive-prompt-split
      // 私聊和群聊是两种完全不同的处境：私聊里说「群里」「群友」会让她
      // 以为自己在群里，冒出「大家」「你们」这种对着一个人说的怪话。
      if (key.startsWith('private:')) {
        const who = key === `private:${cfg.ownerQQ}` ? '主人' : '对方';
        return `${base}【主动机会】${key}\\n原因：你和${who}在私聊里已经有一段时间没说话了，这次是你可以主动开口的机会。\\n接着上次没聊完的话头最自然；也可以问一句近况、分享一件刚想到的、和${who}有关的小事。\\n这是**两个人的私聊**，不要用群发/对着一屋子人说话的口吻（别说「大家」「你们」），也不要为了找话题去搜热点硬塞。\\n${who}可能在忙，发了没回就安静收尾，别连发；如果实在没什么想说的，也可以直接安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
      }
      return `${base}【主动机会】${key}\\n原因：群里已经安静了一段时间，这是一次你可以主动冒泡的机会。\\n优先主动开个话题、追问上次没聊完的事、分享一个刚想到的想法；如果一时想不到，可以用 mcp__web-search-safe__web_search 搜一下当前热点/时事/网络热梗，再结合记忆里的群友兴趣挑一个自然角度。只要内容自然，就大胆开口；如果实在没话想说，再安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }"""


def main():
    text = TARGET.read_text(encoding='utf-8')
    if 'MARKER: proactive-prompt-split' in text:
        print('· 已装 proactive-prompt-split，跳过')
        return 0

    n = text.count(OLD)
    if n != 1:
        print(f'❌ 原文案命中 {n} 次（应为 1）')
        return 1
    text = text.replace(OLD, NEW)

    assert text.count('MARKER: proactive-prompt-split') == 1
    TARGET.write_text(text, encoding='utf-8')
    print('✅ proactiveCheck 文案已按私聊/群聊分叉')
    return 0


if __name__ == '__main__':
    sys.exit(main())
