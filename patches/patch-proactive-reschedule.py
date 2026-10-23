#!/usr/bin/env python3
"""主动机会档期「被清掉就再也不排」的兜底巡检。

## 问题

`clearSocialV2Timers(key)` 末尾有一句：

    // 定时器被清掉后档期也该清：否则下次启动会按一个已经作废的旧档期续期
    st.proactiveNextAt = 0;

这句本身没错（旧档期确实该作废），但**三个调用点没有一处重新排期**：

  · `retireSession(key)`（`:3086` 附近）—— 会话退役
  · `startConsoleServer()` 里控制台重置（`:7735` 附近）
  · `handleIncoming` 的 `/clear` 分支（`:11603` 附近）

`/clear` 那条最要命：它先 `socialV2.conversations.delete(key)` 再
`saveSocialV2State()`，之后**不重排**。而 `getSocialV2State(key)` 下次被任何路径
碰到的确会重新排（它的新建分支末尾就有 `scheduleProactiveCheckV2(key)`）——
但「下次被碰到」可能是一整天以后。结果就是：**清过档期的会话可能长期拿不到主动机会**。

## 改法：加一条巡检兜底

`sweepPendingWakeReasons()` 已经每 30 秒跑一次（`setInterval(..., 30_000)`，
`:9577`）。在它末尾加 `ensureProactiveScheduledV2()`：对每个会话检查

    !st.proactiveTimer && !st.proactiveNextAt && 有消息历史

三者同时成立才补排。加「有消息历史」这条是为了不把幽灵会话（recentMessages 为空）
顺手复活 —— 那类会话本来就该等着被清理，不该主动去打扰谁。
`scheduleProactiveCheckV2` 内部还会再过一遍 `proactiveAllowed`，所以白名单外
的会话补排也是空转，安全。

## 为什么不做成「无论如何都重排」

如果某个会话因为「不在主动白名单」而排不上，巡检每次都调一次
`scheduleProactiveCheckV2` 就会每次打一条 «已安排主动机会检查» 日志，
30 秒一条把日志刷爆。所以巡检只在**确实没有定时器也没有档期**时动手一次，
排上了 `st.proactiveTimer` 就非空，下次巡检自然跳过。
"""
import pathlib
import sys

TARGET = pathlib.Path('/opt/qq-bridge/src/bridge.js')

HELPER = '''  // MARKER: proactive-reschedule
  // 兜底：档期被 clearSocialV2Timers 清掉后没有任何调用点重排（尤其是 /clear），
  // 会让一个会话长期拿不到主动机会。这里每 30s 巡检一次，只补「既没定时器也没档期」
  // 且确实有过消息的会话。幽灵会话（recentMessages 为空）不补，避免复活该清的会话。
  function ensureProactiveScheduledV2() {
    if (cfg.socialV2?.proactive?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    for (const [key, st] of socialV2.conversations) {
      if (!st) continue;
      if (st.proactiveTimer) continue;
      if (Number(st.proactiveNextAt) > 0) continue;
      if (!Array.isArray(st.recentMessages) || st.recentMessages.length === 0) continue;
      const m = /^(group|private):(\\d+)$/.exec(key);
      if (!m) continue;
      if (!proactiveAllowed(key, m[1], Number(m[2]), cfg, currentMode)) continue;
      log(`[reserved2] 主动机会档期缺失，补排 ${key}`);
      scheduleProactiveCheckV2(key);
    }
  }

'''

OLD_TAIL = """      drainPendingWakeFor(key);
    }
  }

  function scheduleWakeV2(key, reason, opts = {}) {"""

NEW_TAIL = """      drainPendingWakeFor(key);
    }
    // MARKER: proactive-reschedule —— 巡检末尾顺手补排缺档期的会话。
    ensureProactiveScheduledV2();
  }

  function scheduleWakeV2(key, reason, opts = {}) {"""


def main():
    text = TARGET.read_text(encoding='utf-8')
    if 'MARKER: proactive-reschedule' in text:
        print('· 已装 proactive-reschedule，跳过')
        return 0

    anchor = '  function sweepPendingWakeReasons() {'
    n = text.count(anchor)
    if n != 1:
        print(f'❌ sweepPendingWakeReasons 锚点命中 {n} 次（应为 1）')
        return 1
    text = text.replace(anchor, HELPER + anchor)

    c = text.count(OLD_TAIL)
    if c != 1:
        print(f'❌ 巡检尾部命中 {c} 次（应为 1）')
        return 1
    text = text.replace(OLD_TAIL, NEW_TAIL)

    assert text.count('MARKER: proactive-reschedule') == 2, text.count('MARKER: proactive-reschedule')
    TARGET.write_text(text, encoding='utf-8')
    print('✅ 已装 ensureProactiveScheduledV2 + 巡检末尾调用')
    return 0


if __name__ == '__main__':
    sys.exit(main())
