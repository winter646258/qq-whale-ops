#!/usr/bin/env python3
# 第 5 项补丁三：高优先级唤醒被「繁忙」在三个地方连着弹回，导致 @ 永远送不到。
# 线上证据（12:47:28 → 12:49:37）：atMention@seq1962 入队 → drain 取出 → scheduleWakeV2
# 判忙又塞回 → sendWakePromptV2 判忙再塞回，同样一条 seq 反复出入队，一次都没真正投递。
import sys

P = '/opt/qq-bridge/src/bridge.js'
t = open(P, encoding='utf-8').read()
orig = t
done = []

def rep(old, new, expect, label):
    global t
    n = t.count(old)
    if n != expect:
        print(f'✖ {label}: 期望 {expect} 处，实际 {n} 处')
        sys.exit(1)
    t = t.replace(old, new)
    done.append(label)

# 1) scheduleWakeV2 支持 force
rep(
    "  function scheduleWakeV2(key, reason) {",
    "  function scheduleWakeV2(key, reason, opts = {}) {",
    1, '1 scheduleWakeV2 签名'
)

# 2) scheduleWakeV2 里的繁忙入队可被 force 跳过（用后面的 cancelReplyCheckV2 定位，和 sendWakePrompt 里同形代码区分）
rep(
    """    if (isConversationBusyV2(key, st)) {
      const seq = st.lastUnreadSeq || 0;
      enqueuePendingWake(st, reason, seq);
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，队列 ${st.pendingWakeReasons.length} 条）`);
      return;
    }
    cancelReplyCheckV2(key);""",
    """    if (!opts.force && isConversationBusyV2(key, st)) {
      const seq = st.lastUnreadSeq || 0;
      enqueuePendingWake(st, reason, seq);
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，队列 ${st.pendingWakeReasons.length} 条）`);
      return;
    }
    cancelReplyCheckV2(key);""",
    1, '2 scheduleWakeV2 可 force'
)

# 3) drain 补发时带 force
rep(
    "    scheduleWakeV2(key, item.reason);",
    "    scheduleWakeV2(key, item.reason, { force: true });",
    1, '3 drain 带 force'
)

# 4) sendWakePromptV2：高优先级不再塞回队列，直接排队投递（deliverPrompt 本身按会话串行）
rep(
    """    if (isConversationBusyV2(key, st)) {
      const seq = st.lastUnreadSeq || 0;
      enqueuePendingWake(st, reason, seq);
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，队列 ${st.pendingWakeReasons.length} 条）`);
      return;
    }
    // 唤醒频率硬限制""",
    """    if (isConversationBusyV2(key, st)) {
      const base0 = String(reason ?? '').split(':')[0];
      // 高优先级（主人私聊 / 被 @ / 被提问）不能因为「她正在思考」就丢回积压队列：
      // 实测群聊持续繁忙时，@ 在 drain 与 sendWakePrompt 之间来回弹，永远送不到。
      // deliverPrompt 本身按会话串行，排队投递不会并发抢麦。
      if (!['private', 'atMention', 'question'].includes(base0)) {
        const seq = st.lastUnreadSeq || 0;
        enqueuePendingWake(st, reason, seq);
        log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，队列 ${st.pendingWakeReasons.length} 条）`);
        return;
      }
      log(`[reserved2] ${key} 繁忙但属高优先级唤醒（${reason}），排队投递`);
    }
    // 唤醒频率硬限制""",
    1, '4 sendWakePrompt 高优先级不丢'
)

if t == orig:
    print('✖ 没有改动')
    sys.exit(1)

open(P, 'w', encoding='utf-8').write(t)
print('✔ 已改 4 处：', ' / '.join(done))
print('体积:', len(orig), '->', len(t))
