#!/usr/bin/env python3
# 第 5 项补丁四：
#  (a) scheduleWakeV2 这一层仍在把 @ 塞进积压队列（上一版只放开了 drain 与 sendWakePrompt）
#  (b) 唤醒文案对 atMention / private 走的是默认分支，模型只看到「原因：atMention」，
#      不知道这是「有人点名 @ 你」，容易按「路过话题」处理，于是只观察不吭声。
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

# (a) scheduleWakeV2：高优先级不进积压队列，继续走定时器 → sendWakePrompt 排队投递
rep(
    """    if (!opts.force && isConversationBusyV2(key, st)) {
      const seq = st.lastUnreadSeq || 0;
      enqueuePendingWake(st, reason, seq);
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，队列 ${st.pendingWakeReasons.length} 条）`);
      return;
    }
    cancelReplyCheckV2(key);""",
    """    if (!opts.force && isConversationBusyV2(key, st)) {
      const base0 = String(reason ?? '').split(':')[0];
      // 被 @ / 被私聊 / 被提问 不放积压队列：群聊持续繁忙时它会在 drain 与投递之间反复弹，
      // 实测同一条 seq 进出队 3 次以上、一次都没真正送到。
      if (!['private', 'atMention', 'question'].includes(base0)) {
        const seq = st.lastUnreadSeq || 0;
        enqueuePendingWake(st, reason, seq);
        log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，队列 ${st.pendingWakeReasons.length} 条）`);
        return;
      }
      log(`[reserved2] ${key} 繁忙但属高优先级唤醒（${reason}），照常安排推送`);
    }
    cancelReplyCheckV2(key);""",
    1, 'a scheduleWakeV2 高优先级放行'
)

# (b1) atMention 专用唤醒文案
rep(
    """    if (reason === 'poke') {""",
    """    if (reason === 'atMention') {
      return `${base}【唤醒】${key}\\n原因：有人在群里 @ 了你 —— 这是明确点名找你，不是路过的话题。\\n先去未读消息里找到那条 @，看清是谁、说了什么，然后直接回应它。回应简短自然即可（一到两小句），不要只观察不吭声；确实没什么可回的，用一句话接住也行。`;
    }
    if (reason === 'private') {
      const who = key === `private:${cfg.ownerQQ}` ? '主人' : '对方';
      return `${base}【唤醒】${key}\\n原因：${who}在私聊里给你发消息了 —— 私聊就是明确找你。\\n先看未读，直接回，别晾着。`;
    }
    if (reason === 'poke') {""",
    1, 'b1 atMention/private 专用文案'
)

if t == orig:
    print('✖ 没有改动')
    sys.exit(1)

open(P, 'w', encoding='utf-8').write(t)
print('✔ 已改：', ' / '.join(done))
print('体积:', len(orig), '->', len(t))
