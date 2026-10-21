#!/usr/bin/env python3
# 第 5 项补丁二：繁忙队列只进不出（线上实测队列涨到 15 条，@ 等了 150s 还没发）
# 根因：drainPendingWakeFor 被 turn 结束处调用时，这一轮的 collector/pendingWakeTimer 还挂着，
#       isConversationBusyV2() 仍然返回 true ⇒ 取出来又塞回去，永远不出队。
import sys

P = '/opt/qq-bridge/src/bridge.js'
t = open(P, encoding='utf-8').read()
orig = t
marks = []

def rep(old, new, expect, label):
    global t
    n = t.count(old)
    if n != expect:
        print(f'✖ {label}: 期望 {expect} 处，实际 {n} 处')
        sys.exit(1)
    t = t.replace(old, new)
    marks.append(label)

# 1) 函数签名加 opts
rep(
    "  function drainPendingWakeFor(key) {",
    "  function drainPendingWakeFor(key, opts = {}) {",
    1, '1 签名'
)

# 2) busy 检查可跳过（turn 刚结束那一下，本轮的 collector 还挂着，不能算「忙」）
rep(
    """    if (isConversationBusyV2(key, st)) {
      st.pendingWakeReasons.push(item);
      return false;
    }""",
    """    if (!opts.ignoreBusy && isConversationBusyV2(key, st)) {
      st.pendingWakeReasons.push(item);
      return false;
    }""",
    1, '2 busy 可跳过'
)

# 3) turn 结束处那一次调用带上 ignoreBusy（14 空格缩进，与巡检的 6 空格区分）
rep(
    "              drainPendingWakeFor(key);",
    "              drainPendingWakeFor(key, { ignoreBusy: true });",
    1, '3 turn 结束处调用'
)

# 4) 巡检：一直忙时高优先级积压超 120s 强行补一条，避免 @ 被永久饿死
rep(
    """      if (isConversationBusyV2(key, st)) continue;
      drainPendingWakeFor(key);""",
    """      if (isConversationBusyV2(key, st)) {
        // 群里一直有人说话 ⇒ isConversationBusyV2 长期为真，高优先级积压会被永久饿死。
        // 已经等够 120s 就强行补一条（scheduleWakeV2 内部还会各自合并/排队）。
        let top = st.pendingWakeReasons[0];
        for (const x of st.pendingWakeReasons) {
          if ((Number(x?.pr) || 0) > (Number(top?.pr) || 0)) top = x;
        }
        const waited = Date.now() - Number(top?.at || 0);
        if ((Number(top?.pr) || 0) >= 80 && waited > 120_000) {
          log(`[reserved2] ${key} 持续繁忙，高优先级积压已等 ${Math.round(waited / 1000)}s，强行补发一条`);
          drainPendingWakeFor(key, { ignoreBusy: true });
        }
        continue;
      }
      drainPendingWakeFor(key);""",
    1, '4 巡检饿死保护'
)

if t == orig:
    print('✖ 没有改动')
    sys.exit(1)

open(P, 'w', encoding='utf-8').write(t)
print('✔ 已改 4 处：', ' / '.join(marks))
print('体积:', len(orig), '->', len(t))
