#!/usr/bin/env python3
"""唤醒判定：消息 @ 了别人（无论 @ 的是谁、在不在群里），都不算叫她。

第一版（patch-at-others-suppress.py）只看顶层 `event.message` 里的 at 段，漏了两种真实形态：

  1. **引用别人的消息**：QQ 的引用/@ 经常只在 `reply` 段的原消息里，顶层只有一个 text 段，
     `event.message` 里根本没有 at → `atOthers` 恒 false →
     `[引用 超大肥鱼：22岁那条]@超大肥鱼 你不是2023年才出生吗` 照样命中 `keyword:小鲸鱼`。
  2. **只在 unread 里能看到的 at**：`recentMessages` 存的 `text` 已把 at 拍平成纯文本
     `"@超大肥鱼 你现在对应的多少岁的时候"` —— 说明 at 段在事件层是有的，但可能藏在 reply 里。

改法：把判定下沉到 `isDirectedAtOthers(event)`，普通段 / 合并转发 / 引用原消息 / `all` 段
全都扫一遍；只要出现「at 自己」就返回 false（那是叫她）；否则任意 at 段返回 true。
调用点仍是 `evaluateWakeTriggerV2` 里 atMention 之后、所有软触发之前。

为什么放 atMention 之后：@ 自己 + @ 别人同时出现（「@A @小鲸鱼 你们看」）时，
第一条 `if (atSelf || quoteTargetIsSelf) return 'atMention'` 已经返回，够不着这里。
为什么不影响私聊：函数第一行 `if (kind === 'private') return 'private';` 早退了。
为什么不影响引用：`quoteTargetIsSelf`（引用她自己的消息）走 atMention 分支，同样在 return null 之前。
"""
import pathlib
import sys

TARGET = pathlib.Path('/opt/qq-bridge/src/bridge.js')

OLD_MARK = """    // MARKER: at-others-suppress —— 这句话 @ 了别人（且没同时 @ 自己），那就是说给那个人的。
    // 关键词/名字/提问/随机概率四类软触发一律失效，否则群里「@大肥鱼」会把另一条鱼的话算到她头上。
    const atOthers = Array.isArray(event?.message) && event.message.some(
      (seg) => seg?.type === 'at' && String(seg.data?.qq) !== String(event?.self_id ?? '')
    );
    if (atOthers) return null;"""

NEW_MARK = """    // MARKER: at-others-suppress —— 这句话 @ 了别人（且没同时 @ 自己），那就是说给那个人的。
    // 关键词/名字/提问/随机概率四类软触发一律失效，否则群里「@大肥鱼」会把另一条鱼的话算到她头上。
    // 判定下沉到 isDirectedAtOthers：普通段、合并转发、引用原消息、all/陌生人 全扫一遍。
    if (isDirectedAtOthers(event)) return null;"""

HELPER = """  // MARKER: at-others-helper
  // 一条消息是否「明确 @ 了别人」。QQ 的 @ 有三种落点，本函数全部覆盖：
  //   a) 普通段 event.message[] 里的 at（@某人 / @全体）
  //   b) 引用回复 event.message[] 的 reply 段里，原消息的 at
  //   c) 合并转发 / 多层嵌套里的 at（很少见，但扫一遍不花钱）
  // 只要出现「at 到她自己」，一律返回 false —— 那是叫她，不是叫别人。
  function isDirectedAtOthers(event) {
    const selfId = String(event?.self_id ?? '');
    if (!selfId) return false;
    let hasOther = false;
    const scan = (segs, depth) => {
      if (!Array.isArray(segs) || depth > 4) return null;
      for (const seg of segs) {
        if (!seg || typeof seg !== 'object') continue;
        if (seg.type === 'at') {
          const qq = String(seg.data?.qq ?? '');
          // qq 为 'all' 或陌生人号码，都算 @ 了别人
          if (qq && qq === selfId) return 'self';
          hasOther = true;
        }
        if (seg.type === 'reply') {
          const inner = seg.data?.content ?? seg.data?.message ?? null;
          if (scan(inner, depth + 1) === 'self') return 'self';
        }
        if (seg.type === 'node' || seg.type === 'forward' || Array.isArray(seg.data?.content)) {
          const inner = seg.data?.content ?? null;
          if (scan(inner, depth + 1) === 'self') return 'self';
        }
      }
      return null;
    };
    if (scan(event?.message, 0) === 'self') return false;
    return hasOther;
  }

"""

ANCHOR = '  function evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf) {'


def main():
    text = TARGET.read_text(encoding='utf-8')

    if OLD_MARK not in text:
        if 'MARKER: at-others-helper' in text and 'isDirectedAtOthers(event)' in text:
            print('✅ 已经是深层版本，无需再改')
            return 0
        print('❌ 找不到第一版的 MARKER 块，拒绝写盘')
        return 1

    n = text.count(OLD_MARK)
    if n != 1:
        print(f'❌ 旧标记命中 {n} 次（应为 1），拒绝写盘')
        return 1
    text = text.replace(OLD_MARK, NEW_MARK)

    m = text.count(ANCHOR)
    if m != 1:
        print(f'❌ evaluateWakeTriggerV2 锚点命中 {m} 次（应为 1）')
        return 1
    if 'MARKER: at-others-helper' not in text:
        text = text.replace(ANCHOR, HELPER + ANCHOR)

    assert text.count('MARKER: at-others-helper') == 1
    assert text.count('isDirectedAtOthers(event)') == 1
    TARGET.write_text(text, encoding='utf-8')
    print('✅ 已装 isDirectedAtOthers + 调用点')
    return 0


if __name__ == '__main__':
    sys.exit(main())
