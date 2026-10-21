#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch-item56.py —— 第 5、6 项
  5a. poke 目标判定：只在她本人被拍时唤醒（别人互拍只记消息、不唤醒）
  5b. 主人 @ / 私聊不被「会话繁忙」吞掉：
      - 繁忙暂存队列从 FIFO 改成按优先级出队（@/私聊 90/100 优先）
      - 队列满时先丢最低优先级，而不是丢最早的
      - 队列落盘（重启不再丢）
      - turn 结束出队 + 每 30s 巡检兜底（重启/会话被替换也能补发）
  6.  主动计时器持久化：proactiveNextAt 落盘，重启后按剩余时间续档
     （今天十分钟内重启两次，旧实现每次都把已等待的档期清空）
"""
import io
import re
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else 'bridge.js'
src = io.open(PATH, encoding='utf-8').read()
orig_len = len(src)
applied = []


def rep(old, new, expect=1, label=''):
    global src
    n = src.count(old)
    if n != expect:
        raise SystemExit(f'✖ [{label}] 期望命中 {expect} 次，实际 {n} 次；未写入')
    src = src.replace(old, new)
    applied.append(f'{label}: {n} 处')


# ─────────────────────────────────────────────────────────────
# 5a. poke 目标判定
# ─────────────────────────────────────────────────────────────
rep(
    """    appendActivity(`${key} 拍一拍事件：${msg.text.slice(0, 80)}`);
    if (currentMode !== 'reserved2') return;
    if (socialV2.paused) return;
    const st = getSocialV2State(key);
    if (!st.bootstrapSent) {
      st.bootstrapSent = true;
      saveSocialV2State();
      scheduleWakeV2(key, 'bootstrap');
    } else if (st.wakeConfig?.triggers?.poke) {
      scheduleWakeV2(key, 'poke');
    }""",
    """    appendActivity(`${key} 拍一拍事件：${msg.text.slice(0, 80)}`);
    if (currentMode !== 'reserved2') return;
    if (socialV2.paused) return;
    // MARKER: poke-target
    // 只有「拍她本人」才唤醒。旧实现只看 triggers.poke，不看 target —— 群友互拍
    // 也会把她叫起来（实测 poke 把群聊每小时 8 次唤醒额度吃光，真正 @ 她时反而被限流跳过）。
    // 私聊没有 target_id 时按拍摄她处理：私聊里的拍一拍天然指向对方。
    const pokedMe = targetIsSelf || (kind === 'private' && !targetId);
    const st = getSocialV2State(key);
    if (!st.bootstrapSent) {
      st.bootstrapSent = true;
      saveSocialV2State();
      scheduleWakeV2(key, 'bootstrap');
    } else if (!pokedMe) {
      // 拍的是别人：事件已经进消息流供她参考，但不唤醒、不烧额度。
      log(`[reserved2] 拍一拍目标不是她（${senderId} -> ${targetId}），只记录不唤醒 ${key}`);
    } else if (st.wakeConfig?.triggers?.poke) {
      scheduleWakeV2(key, 'poke');
    }""",
    label='poke 目标判定',
)

rep(
    """      return `${base}【唤醒】${key}\\n原因：有人拍了一拍（可能拍了你，也可能拍了别人）。\\n先看未读/最近消息里的 [拍一拍] 事件：如果是拍你，可以自然回应一句，也可以用 qq_send_poke 回一个拍一拍；如果是拍别人，觉得有趣也可以接梗。除了回应，偶尔也可以主动戳一下正在聊的人/熟人，像真人手贱/提醒/逗一下，但别频繁。不想接就安静收尾（qq_mark_read 或 qq_set_wake_config）。`;""",
    """      return `${base}【唤醒】${key}\\n原因：有人拍了一拍你。\\n先看未读/最近消息里的 [拍一拍] 事件，认出是谁拍的、后缀写了什么，再自然回应一句；也可以用 qq_send_poke 回一个拍一拍。除了回应，偶尔也可以主动戳一下正在聊的人/熟人，像真人手贱/提醒/逗一下，但别频繁。不想接就安静收尾（qq_mark_read 或 qq_set_wake_config）。`;""",
    label='poke 唤醒文案',
)

# ─────────────────────────────────────────────────────────────
# 5b-1. 优先级队列纯函数（插在 wakePriorityV2 之后）
# ─────────────────────────────────────────────────────────────
HELPERS = """
  // MARKER: busy-queue
  // 繁忙暂存队列原本有两个真问题（2026-10-21 实测）：
  //   1) 入队/出队都是 FIFO —— 一条低优先级的 probability 排在前面，后面跟进的
  //      @ / 私聊只能排在它后面（实测 08:54–09:01 五条 private 全被暂存）；
  //   2) 只在「turn 正常结束」时出队一次，而队列只存在内存里 ——
  //      桥接十分钟内重启了两次，五条暂存一条都没补发（补发计数=0）。
  // 这里把入队/选队抽成纯函数：按优先级排队、满了先丢最低优先级、出队取最高优先级。
  const PENDING_WAKE_MAX = 20;
  const PENDING_WAKE_TTL_MS = 30 * 60 * 1000;

  function enqueuePendingWake(st, reason, seq) {
    if (!st) return false;
    if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
    const s = Number(seq) || 0;
    if (st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === s)) return false;
    st.pendingWakeReasons.push({ reason, seq: s, at: Date.now(), pr: wakePriorityV2(reason) });
    if (st.pendingWakeReasons.length > PENDING_WAKE_MAX) {
      // 满了先牺牲优先级最低那条；同优先级丢最早入队的
      let worst = 0;
      for (let i = 1; i < st.pendingWakeReasons.length; i += 1) {
        const cur = st.pendingWakeReasons[i] || {};
        const low = st.pendingWakeReasons[worst] || {};
        const cp = Number(cur.pr ?? wakePriorityV2(cur.reason));
        const lp = Number(low.pr ?? wakePriorityV2(low.reason));
        if (cp < lp || (cp === lp && Number(cur.at || 0) < Number(low.at || 0))) worst = i;
      }
      st.pendingWakeReasons.splice(worst, 1);
    }
    return true;
  }

  function pickPendingWakeIndex(st) {
    const q = Array.isArray(st?.pendingWakeReasons) ? st.pendingWakeReasons : [];
    if (!q.length) return -1;
    let best = 0;
    for (let i = 1; i < q.length; i += 1) {
      const cur = q[i] || {};
      const top = q[best] || {};
      const cp = Number(cur.pr ?? wakePriorityV2(cur.reason));
      const tp = Number(top.pr ?? wakePriorityV2(top.reason));
      if (cp > tp || (cp === tp && Number(cur.at || 0) < Number(top.at || 0))) best = i;
    }
    return best;
  }

  // 出队并补发：取最高优先级那条；仍忙就放回去，等下一次 turn 结束或巡检。
  // 保留「已被本回合处理就别补发」的判断，避免同一条消息被回两次。
  function drainPendingWakeFor(key) {
    const st = getSocialV2State(key);
    if (!st || !Array.isArray(st.pendingWakeReasons) || !st.pendingWakeReasons.length) return false;
    const idx = pickPendingWakeIndex(st);
    if (idx < 0) return false;
    const item = st.pendingWakeReasons.splice(idx, 1)[0];
    if (!item || typeof item !== 'object') return false; // 兼容旧字符串残留
    if (isConversationBusyV2(key, st)) {
      st.pendingWakeReasons.push(item);
      return false;
    }
    const stale = item.at && Date.now() - Number(item.at) > PENDING_WAKE_TTL_MS;
    const stillRelevant = Array.isArray(st.unread) && st.unread.some((m) => m && Number(m.seq) >= Number(item.seq));
    if (stale || !stillRelevant) {
      log(`[reserved2] ${key} 繁忙期间唤醒 ${item.reason}@seq${item.seq} ${stale ? '已过期' : '已被当前回合处理'}，跳过补发`);
      return false;
    }
    log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}@seq${item.seq}（队列剩 ${st.pendingWakeReasons.length} 条）`);
    scheduleWakeV2(key, item.reason);
    return true;
  }

  // 巡检：turn 结束时出队依赖「那个 turn 真的正常结束」，
  // 但重启 / 会话被替换 / 回合异常都可能让它永远等不到。这里每 30s 兜一次。
  function sweepPendingWakeReasons() {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    for (const [key, st] of socialV2.conversations) {
      if (!st || !Array.isArray(st.pendingWakeReasons) || !st.pendingWakeReasons.length) continue;
      // 先清掉过期的，避免重启后把半小时前的 @ 再补一遍
      st.pendingWakeReasons = st.pendingWakeReasons.filter((r) => {
        if (!r || typeof r !== 'object') return false;
        return !(r.at && Date.now() - Number(r.at) > PENDING_WAKE_TTL_MS);
      });
      if (!st.pendingWakeReasons.length) continue;
      if (isConversationBusyV2(key, st)) continue;
      drainPendingWakeFor(key);
    }
  }

  function scheduleWakeV2(key, reason) {"""

rep(
    """    return WAKE_PRIORITY[base] ?? 0;
  }

  function scheduleWakeV2(key, reason) {""",
    """    return WAKE_PRIORITY[base] ?? 0;
  }
""" + HELPERS,
    label='优先级队列函数',
)

# ─────────────────────────────────────────────────────────────
# 5b-2. 两处「繁忙 → 暂存」改为优先级入队
# ─────────────────────────────────────────────────────────────
OLD_BUSY = """      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}）`);
      return;"""
NEW_BUSY = """      const seq = st.lastUnreadSeq || 0;
      enqueuePendingWake(st, reason, seq);
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，队列 ${st.pendingWakeReasons.length} 条）`);
      return;"""
rep(OLD_BUSY, NEW_BUSY, expect=2, label='繁忙暂存改优先级入队')

# ─────────────────────────────────────────────────────────────
# 5b-3. turn 结束出队 → 统一走 drainPendingWakeFor
# ─────────────────────────────────────────────────────────────
OLD_DRAIN = """              // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次，避免关键 @/提问被漏掉。
              // 但如果触发它的消息已经被 AI 在当前回合处理（unread 中已不存在该 seq），则不再补发。
              {
                const stEnd = getSocialV2State(key);
                if (Array.isArray(stEnd.pendingWakeReasons) && stEnd.pendingWakeReasons.length) {
                  const item = stEnd.pendingWakeReasons.shift();
                  if (!item || typeof item !== 'object') {
                    // 兼容旧字符串残留
                  } else {
                    const stillRelevant = Array.isArray(stEnd.unread) && stEnd.unread.some((m) => m && Number(m.seq) >= Number(item.seq));
                    if (stillRelevant) {
                      log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}@seq${item.seq}`);
                      scheduleWakeV2(key, item.reason);
                    } else {
                      log(`[reserved2] ${key} 繁忙期间唤醒 ${item.reason}@seq${item.seq} 已被当前回合处理，跳过补发`);
                    }
                  }
                }
              }"""
NEW_DRAIN = """              // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次，取**最高优先级**那条。
              // 已被本回合处理（unread 里没有该 seq）则跳过，避免重复回复。
              drainPendingWakeFor(key);"""
rep(OLD_DRAIN, NEW_DRAIN, label='turn 结束出队')

# ─────────────────────────────────────────────────────────────
# 5b-4. 队列落盘（save / load / 新会话默认）
# ─────────────────────────────────────────────────────────────
rep(
    """          lastImpressionNudgeAt: Number(st.lastImpressionNudgeAt) || 0,
          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)""",
    """          lastImpressionNudgeAt: Number(st.lastImpressionNudgeAt) || 0,
          // MARKER: item56
          // 繁忙暂存队列与主动档期也必须落盘：桥接一天要重启好几次，
          // 只存内存等于「每次重启都把还没补发的 @ 和已经等过的主动档期清空」。
          pendingWakeReasons: Array.isArray(st.pendingWakeReasons)
            ? st.pendingWakeReasons.filter((r) => r && typeof r === 'object').slice(-PENDING_WAKE_MAX)
            : [],
          proactiveNextAt: Number(st.proactiveNextAt) || 0,
          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)""",
    label='save 补队列与档期',
)

rep(
    """            lastImpressionNudgeAt: Number(val.lastImpressionNudgeAt) > 0 ? Number(val.lastImpressionNudgeAt) : 0
          };""",
    """            lastImpressionNudgeAt: Number(val.lastImpressionNudgeAt) > 0 ? Number(val.lastImpressionNudgeAt) : 0,
            // 繁忙暂存队列：重启后仍要补发（过期项由巡检清掉）
            pendingWakeReasons: Array.isArray(val.pendingWakeReasons)
              ? val.pendingWakeReasons
                .filter((r) => r && typeof r === 'object' && typeof r.reason === 'string')
                .map((r) => ({ reason: r.reason, seq: Number(r.seq) || 0, at: Number(r.at) || 0, pr: Number(r.pr) || wakePriorityV2(r.reason) }))
                .slice(-PENDING_WAKE_MAX)
              : [],
            // 主动检查的下一次档期（ms 时间戳）：重启后按剩余时间续上，而不是重新抽随机
            proactiveNextAt: Number(val.proactiveNextAt) > 0 ? Number(val.proactiveNextAt) : 0
          };""",
    label='load 读队列与档期',
)

rep(
    """        lastImpressionRefreshAt: 0,
        lastImpressionNudgeAt: 0
      };""",
    """        lastImpressionRefreshAt: 0,
        lastImpressionNudgeAt: 0,
        pendingWakeReasons: [],
        proactiveNextAt: 0
      };""",
    label='新会话默认字段',
)

# ─────────────────────────────────────────────────────────────
# 6. 主动计时器持久化
# ─────────────────────────────────────────────────────────────
rep(
    """  function scheduleProactiveCheckV2(key) {""",
    """  function scheduleProactiveCheckV2(key, opts = {}) {""",
    label='scheduleProactiveCheckV2 签名',
)

rep(
    """    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    const delay = Math.floor(min + Math.random() * (max - min));
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;""",
    """    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    // MARKER: proactive-persist
    // 档期落盘：旧实现重启就重抽随机，等于每次重启都白等一轮
    // （今天 08:52、09:01 两次重启，group:910502749 的档期被推成 78min / 96min）。
    const storedNextAt = Number(st.proactiveNextAt) || 0;
    const nowMs = Date.now();
    let delay;
    if (storedNextAt > nowMs + 1000) {
      // 续档，但最多续 max 的两倍，避免一个过期的远档把检查推太远
      delay = Math.min(storedNextAt - nowMs, max * 2);
    } else {
      delay = Math.floor(min + Math.random() * (max - min));
    }
    st.proactiveNextAt = nowMs + delay;
    if (!opts.skipSave) saveSocialV2State();
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;
      st.proactiveNextAt = 0;""",
    label='主动档期续期',
)

rep(
    """          ensureWakeableV2(st, { skipSave: true, key });
          scheduleProactiveCheckV2(key);""",
    """          ensureWakeableV2(st, { skipSave: true, key });
          // 加载期不要在循环里落盘（会把还没加载完的会话写成空），交给加载末尾统一写
          scheduleProactiveCheckV2(key, { skipSave: true });""",
    label='load 内调用传 skipSave',
)

rep(
    """    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
  }""",
    """    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
    // 定时器被清掉后档期也该清：否则下次启动会按一个已经作废的旧档期续期
    st.proactiveNextAt = 0;
  }""",
    label='清定时器时清档期',
)

# ─────────────────────────────────────────────────────────────
# 5b-5. 启动巡检
# ─────────────────────────────────────────────────────────────
rep(
    """  loadSocialV2State();
""",
    """  loadSocialV2State();

  // MARKER: busy-queue-sweep
  // 兜底巡检：上面所有出队都依赖「某个 turn 正常结束」，而重启 / 会话被替换 /
  // 回合异常都可能让暂存的 @ 永远等不到那个时机（实测五条 private 全卡死）。
  // 每 30s 扫一遍，忙的跳过，不忙的直接补发。
  setInterval(sweepPendingWakeReasons, 30_000).unref?.();
""",
    label='启动巡检定时器',
)

io.open(PATH, 'w', encoding='utf-8', newline='').write(src)
print('✔ 补丁写入完成')
print('  原大小 %d -> 新大小 %d（+%d 字节）' % (orig_len, len(src), len(src) - orig_len))
for a in applied:
    print('  -', a)
