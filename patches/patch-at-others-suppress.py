#!/usr/bin/env python3
"""唤醒判定：消息 @ 了别人（无论 @ 的是谁、在不在群里），都不算叫她。

## 现场（2026-10-22 16:25–16:31，主群 group:906710082）

    16:25:50 主人 winter：@大肥鱼 画图
    16:25:54 超大肥鱼(3960400511)：不画，问几遍了
    16:27:52 主人 winter：@大肥鱼 谁是小鲸鱼
    16:30:18 主人 winter：@大肥鱼 怎么猫娘也在水里

群里有**三条**叫「大肥鱼」的号（她是 2157801858，另两条 3960400511、3925980140）。
主人 @ 的是另一条鱼，但消息正文里有「大肥鱼」→ 命中 `keyword:大肥鱼` →
`evaluateWakeTriggerV2` 返回 `keyword:大肥鱼` → 她被唤醒插进别人正在聊的对话里。

根因：`evaluateWakeTriggerV2` 只检查「有没有 @ 到自己」，**从不检查「有没有 @ 到别人」**。
QQ 里 @ 某人意味着这句话是给那个人的，不是给全场的；只要 @ 了别人（且没同时
@ 她），关键词 / 名字 / 提问 / 随机概率四类软触发都应该直接失效。

## 改法

在 `evaluateWakeTriggerV2` 的 atMention 判定**之后**、所有软触发**之前**插：

    if (isDirectedAtOthers(event)) return null;

新的辅助函数 `isDirectedAtOthers(event)` 扫描三种 @ 落点：

  a) 普通段 `event.message[]` 里的 `at`（@某人 / @全体）
  b) 引用回复 `reply` 段里原消息的 at（`seg.data.content`）
  c) 合并转发 / 多层嵌套里的 at

只要出现「at 到她自己的 self_id」，一律返回 false —— 那是叫她，不是叫别人。

## 为什么放在 atMention 之后

@ 自己 + @ 别人同时出现（「@A @小鲸鱼 你们看」）时，第一条
`if (atSelf || quoteTargetIsSelf) return 'atMention'` 已经返回，够不着这里。

## 为什么不影响

- 私聊：函数第一行 `if (kind === 'private') return 'private';` 早退了。
- 引用她自己的消息：`quoteTargetIsSelf` 走 atMention 分支，同样在 return null 之前。

## 线上验证（2026-10-22）

- 破例抓到的真实事件：`raw=[{"type":"at","data":{"qq":"3218266862"}},{"type":"text","data":{"text":" 你的问题"}}]`
  → `[wakedbg] atOthers-suppress group:906710082`，拦下了。
- `isDirectedAtOthers` 离线单测 9 条全过（顶层 at / 引用内 at / 纯文本 / @自己 /
  @自己+@别人 / 无 at / @全体 / 嵌套转发 / 引用内 @自己）。

## 一个已知限制（不改）

`event.message` 里没有 at 段、只有被拍平成 `"@某人 内容"` 的纯文本时（例如某些
客户端把 @ 写死在文本里），本函数判不出来，仍会走关键词。这类消息占比很低，
真正的修复要改上游事件采集，不在这一层。
"""
import pathlib
import sys

TARGET = pathlib.Path('/opt/qq-bridge/src/bridge.js')

HELPER = """  function isDirectedAtOthers(event) {
    const selfId = String(event?.self_id ?? '');
    if (!selfId) return false;
    let hasOther = false;
    const scan = (segs, depth) => {
      if (!Array.isArray(segs) || depth > 4) return null;
      for (const seg of segs) {
        if (!seg || typeof seg !== 'object') continue;
        if (seg.type === 'at') {
          const qq = String(seg.data?.qq ?? '');
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

INJECT_AFTER = """      if (atSelf || quoteTargetIsSelf) return 'atMention';
    }
"""

INJECT = """      if (atSelf || quoteTargetIsSelf) return 'atMention';
    }
    // MARKER: at-others-suppress —— 这句话 @ 了别人（且没同时 @ 自己），那就是说给那个人的。
    // 关键词/名字/提问/随机概率四类软触发一律失效，否则群里「@大肥鱼」会把另一条鱼的话算到她头上。
    // 判定下沉到 isDirectedAtOthers：普通段、合并转发、引用原消息、all/陌生人 全扫一遍。
    if (isDirectedAtOthers(event)) return null;
"""


def main():
    text = TARGET.read_text(encoding='utf-8')

    if 'isDirectedAtOthers' in text and 'at-others-suppress' in text:
        print('✅ 已经是目标状态，无需再改')
        return 0

    m = text.count(ANCHOR)
    if m != 1:
        print(f'❌ evaluateWakeTriggerV2 锚点命中 {m} 次（应为 1），拒绝写盘')
        return 1
    text = text.replace(ANCHOR, HELPER + ANCHOR)

    n = text.count(INJECT_AFTER)
    if n != 1:
        print(f'❌ atMention 块命中 {n} 次（应为 1），拒绝写盘')
        return 1
    text = text.replace(INJECT_AFTER, INJECT)

    assert text.count('isDirectedAtOthers') == 2
    assert text.count('at-others-suppress') == 1
    TARGET.write_text(text, encoding='utf-8')
    print('✅ 已装 isDirectedAtOthers + 调用点')
    return 0


if __name__ == '__main__':
    sys.exit(main())
