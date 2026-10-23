#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把「主动报告」接进 bridge.js（阶段 3 的桥接侧）。

判断逻辑全在 src/share-signal-store.js（纯逻辑、42 条单测）。这个补丁只做接线：

  · import 新模块、加 state/share-signal.json 路径常量
  · 接线层：读写文件、审计日志、「现在能不能报」、把报告变成一次 wakeReason='share' 的唤醒
  · HTTP 端点 /api/socialV2/share-signal（signal / policy / stats 三个 action）
  · sweepPendingWakeReasons 末尾调一次 reportTickV2（不新增定时器）
  · buildWakePromptV2 加 reason === 'share' 分支
  · 主人私聊来信时调 noteOwnerReply（回应 + 解除暂停）
  · WAKE_PRIORITY 里给 share 定级

用法：python3 patch-share-signal-wire.py [bridge.js 路径]
"""

import sys
import io

TARGET = sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge/src/bridge.js'

SRC = io.open(TARGET, encoding='utf-8').read()
orig_len = len(SRC)
changed = []
skipped = []


def ensure(cond, msg):
    if not cond:
        print('FAIL: ' + msg)
        sys.exit(1)


# ── 1. import ────────────────────────────────────────────────────────────
IMPORT_ANCHOR = "} from './shared-memory-store.js';"
IMPORT_ADD = r"""} from './shared-memory-store.js';

// MARKER: share-signal
// 主动报告：她自己在群里判断「这件事值得跟主人说一句」，再由桥接按冷却与退避
// 决定什么时候真的说。判断逻辑在 share-signal-store.js，纯逻辑带单测。
import {
  loadShareState, saveShareState, addSignal, settleDeliveries, pruneState,
  canDeliver, markDelivered, lastDelivery, noteOwnerReply as noteShareOwnerReply,
  setPolicy as setSharePolicy, statsOf as shareStatsOf, normalizePolicy as normalizeSharePolicy,
  effectiveIntervalMs, isGroupKey,
  UNANSWERED_THRESHOLD, MAX_SIGNALS as SHARE_MAX_SIGNALS,
  HARD_MIN_INTERVAL_MS as SHARE_HARD_MIN_INTERVAL_MS,
  HARD_MAX_PER_DAY as SHARE_HARD_MAX_PER_DAY
} from './share-signal-store.js';"""

# ── 2. 状态文件路径 ──────────────────────────────────────────────────────
FILE_ANCHOR = "const SHARED_MEMORY_FILE = path.join(STATE_DIR, 'shared-memory.json');"
FILE_ADD = """
const SHARE_SIGNAL_FILE = path.join(STATE_DIR, 'share-signal.json');  // MARKER: share-signal-file
const SHARED_MEMORY_FILE = path.join(STATE_DIR, 'shared-memory.json');"""

# ── 3. 接线层 ────────────────────────────────────────────────────────────
WIRE_ANCHOR = "  function v2ToolEnabled(flag) {"
WIRE_ADD = r"""  // MARKER: share-signal-wire
  // ── 主动报告的接线层 ────────────────────────────────────────────────
  // 这里只做四件事：读写文件、留审计、问一次「现在能不能报」、把报告变成一次唤醒。
  // 所有判断（冷却、安静时段、未回应退避、暂停）都在 share-signal-store.js ——
  // 两边各写一套迟早会走偏。
  //
  // 一条硬规则在这里再落一次：报告只能由群事件触发。store 侧的 addSignal 已经
  // 拒掉 private: 来源，路由那边还会再要求 sourceGroup === 当前会话 key。
  let shareStateCache = null;
  let shareSkipLoggedAt = 0;
  let shareSkipLoggedReason = '';
  // 观察模式下「已经念过哪条」，免得同一条信号每 30 秒刷一次日志。
  let shareObservedSignalId = '';

  // 审计日志独立一份：不占 share-signal.json，也方便主人直接翻。
  const SHARE_SIGNAL_AUDIT_FILE = path.join(STATE_DIR, 'share-signal-audit.jsonl');

  function loadShareStateOrNull() {
    try {
      const st = loadShareState(SHARE_SIGNAL_FILE);
      shareStateCache = st;
      return st;
    } catch (error) {
      // 和共享记忆一样：文件坏了要吵出来，绝不静默当空库写回去 ——
      // 那等于把她攒着的「想跟主人说的事」一次性抹掉。
      console.error(`[share] 读取失败，本轮不投递也不写入：${error?.message ?? error}`);
      return null;
    }
  }

  function getShareState() {
    if (!shareStateCache) shareStateCache = loadShareStateOrNull();
    return shareStateCache;
  }

  function appendShareAudit(entry) {
    try {
      const line = JSON.stringify({
        at: new Date().toISOString(),
        action: String(entry?.action ?? ''),
        key: String(entry?.key ?? ''),
        detail: entry?.detail ?? null
      });
      fs.appendFileSync(SHARE_SIGNAL_AUDIT_FILE, `${line}\n`, { mode: 0o600 });
    } catch {
      // 审计失败不该让业务失败
    }
  }

  function persistShareState({ action, key, detail } = {}) {
    const st = getShareState();
    if (!st) return false;
    try {
      saveShareState(SHARE_SIGNAL_FILE, st);
      appendShareAudit({ action, key, detail });
      return true;
    } catch (error) {
      console.error(`[share] 写入失败：${error?.message ?? error}`);
      return false;
    }
  }

  /** 报告永远只投给主人私聊。 */
  function shareOwnerKey() {
    return `private:${cfg.ownerQQ}`;
  }

  /** buildWakePromptV2 拼文案时取「刚投递的那一条」。 */
  function shareLastDeliveryInfo() {
    const st = getShareState();
    if (!st) return null;
    const d = lastDelivery(st);
    if (!d || !d.summary) return null;
    return {
      summary: d.summary,
      sourceGroup: d.sourceGroup || '',
      valence: Number(d.valence) || 0,
      at: Number(d.at) || 0
    };
  }

  /**
   * 主人私聊来信 = 他回应了，也等于「他不理我」这个暂停理由不成立了。
   * 所以这条既是记回应，也是唯一的解除暂停途径。
   */
  function noteOwnerReplyToShare() {
    const st = getShareState();
    if (!st) return;
    const r = noteShareOwnerReply(st, { now: Date.now() });
    if (!r.answered && !r.resumed) {
      // 没回应过任何一条、也没在暂停里：只更新时间戳，别刷日志。
      saveShareState(SHARE_SIGNAL_FILE, st);
      return;
    }
    persistShareState({
      action: 'owner-reply',
      key: shareOwnerKey(),
      detail: { answered: r.answered, resumed: r.resumed }
    });
    if (r.resumed) log('[share] 主人说话了，报告暂停自动解除');
    if (r.answered) log(`[share] 主人回应了之前的报告，未回应计数清零`);
  }

  /**
   * 30 秒巡检时问一次：现在能不能把待报的事跟主人说。
   *
   * 挂在 sweepPendingWakeReasons 末尾，是因为计划要求不新增定时器；而
   * socialLoopTick 只在 currentMode === 'reserved' 下跑，本模式是 reserved2，
   * 那条路根本到不了这里。
   */
  function reportTickV2() {
    if (cfg.socialV2?.share?.enabled === false) return;
    const st = getShareState();
    if (!st) return;
    const now = Date.now();

    // 先把过窗口的投递结算掉：谁没回我、要不要降频、要不要暂停。
    const settled = settleDeliveries(st, { now });
    pruneState(st, { now });
    if (settled.newlyUnanswered || settled.paused) {
      persistShareState({
        action: 'settle',
        detail: {
          newlyUnanswered: settled.newlyUnanswered,
          streak: st.unansweredStreak,
          paused: settled.paused,
          silencedUntil: settled.silencedUntil || null
        }
      });
      if (settled.paused) {
        log(`[share] 连续 ${UNANSWERED_THRESHOLD} 次没回应、且这段时间主人一句没回，暂停到 ${new Date(settled.silencedUntil).toLocaleString()}`);
      } else {
        log(`[share] 上一次报告没被回应，未回应 ${st.unansweredStreak} 次，间隔调到 ${Math.round(effectiveIntervalMs(st) / 60000)} 分钟`);
      }
    }

    const verdict = canDeliver(st, { now });
    if (!verdict.ok) {
      // 没信号是常态，一个字都不打。其它原因 10 分钟最多一条日志，避免 30 秒一刷。
      if (verdict.reason !== 'no-signal' && verdict.reason !== 'disabled' && st.signals.length) {
        if (verdict.reason !== shareSkipLoggedReason || now - shareSkipLoggedAt > 600_000) {
          shareSkipLoggedReason = verdict.reason;
          shareSkipLoggedAt = now;
          const wait = verdict.waitMs ? `，还需等 ${Math.round(verdict.waitMs / 60000)} 分钟` : '';
          log(`[share] 节流拦截（${verdict.reason}）：待报 ${st.signals.length} 条${wait}`);
        }
      }
      return;
    }

    const ownerKey = shareOwnerKey();
    // 主人在跟她聊别的，这时候插一条群里的汇报就是在打断人。
    // 不消费信号、不加冷却，30 秒后再看一眼就够。
    const ownerSt = socialV2.conversations.get(ownerKey);
    if (isConversationBusyV2(ownerKey, ownerSt)) {
      if (now - shareSkipLoggedAt > 600_000) {
        shareSkipLoggedAt = now;
        shareSkipLoggedReason = 'owner-busy';
        log(`[share] 主人私聊正忙，这次报告先压着（待报 ${st.signals.length} 条）`);
      }
      return;
    }

    const sig = verdict.signal;

    // 观察模式：判定全跑，但**不记账、不发送** —— 每 6 小时才有一条，
    // 上线后要盯好几轮才能确认判定对不对。开着它先看日志：
    //   · 挑中的是不是真值得说的
    //   · valence 的语气提示合不合适
    //   · 安静时段/冷却有没有按预期拦
    // 确认没问题再把 socialV2.share.deliverEnabled 改成 true。
    if (cfg.socialV2?.share?.deliverEnabled !== true) {
      // 同一条信号只念一次，别每 30 秒刷一遍。
      if (shareObservedSignalId !== sig.id || now - shareSkipLoggedAt > 3_600_000) {
        shareObservedSignalId = sig.id;
        shareSkipLoggedAt = now;
        shareSkipLoggedReason = 'observe';
        log(`[share][观察] 本可以投递（${sig.sourceGroup}，valence ${sig.valence}）：${sig.summary}`);
      }
      return;
    }

    const marked = markDelivered(st, { signalId: sig.id, now });
    if (!marked.ok) return;
    persistShareState({
      action: 'deliver',
      key: ownerKey,
      detail: {
        eventId: sig.eventId,
        sourceGroup: sig.sourceGroup,
        valence: sig.valence,
        summary: sig.summary
      }
    });
    // 先记账再发：发失败也不重试，否则一次网络抖动会变成连发。
    log(`[share] 报告已投递（${sig.sourceGroup}，valence ${sig.valence}）：${sig.summary}`);
    void sendWakePromptV2(ownerKey, 'share').catch((error) => {
      log(`[share] 投递唤醒异常，不重试：${error?.message ?? error}`);
    });
  }

  /** addSignal 的失败原因翻成人话，让角色知道该怎么办。 */
  function shareRejectReason(reason) {
    switch (reason) {
      case 'event-id-required': return 'eventId 不能为空：同一条事件要能认出来，用来去重';
      case 'group-source-required': return '报告只能由群聊事件触发：sourceGroup 必须是 group:群号';
      case 'summary-required': return 'summary 不能为空：一句话说清发生了什么';
      case 'duplicate-event': return '这条事件已经报过了（或正在待报），同一条只说一次';
      default: return String(reason || '未知原因');
    }
  }

"""

# ── 4. HTTP 端点 ─────────────────────────────────────────────────────────
ROUTE_ANCHOR = "        // MARKER: shared-memory-route"
ROUTE_ADD = r"""        // MARKER: share-signal-route
        // 主动报告（MCP qq_share_signal / qq_set_report_policy 走这里）。
        //   action=signal  角色在群里判断「这事值得跟主人说」→ 写一条待报信号
        //   action=policy  查/改策略（只能往更保守的方向调，硬上限由 store 夹住）
        //   action=stats   看当前节流状态，便于自查为什么没发出去
        if (url.pathname === '/api/socialV2/share-signal') {
          const body = req.method === 'POST' ? await readBody() : {};
          const q = url.searchParams;
          const rawAction = String(body.action ?? q.get('action') ?? 'stats').trim();
          const action = ['signal', 'policy', 'stats'].includes(rawAction) ? rawAction : null;
          if (!action) {
            sendJson({ ok: false, error: 'action 必须是 signal / policy / stats' }, 400);
            return;
          }
          const key = String(body.key ?? q.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }

          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          if (agentToken && !agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          if (agentToken && !v2SessionAllowed(key)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const needFlag = action === 'signal' ? 'shareSignal' : 'reportPolicy';
          if (agentToken && !v2ToolEnabled(needFlag)) {
            sendJson({ ok: false, error: `工具未启用：${needFlag}` }, 403);
            return;
          }

          const st = getShareState();
          if (!st) {
            sendJson({ ok: false, error: '报告状态文件读取失败，请让主人检查 state/share-signal.json' }, 500);
            return;
          }
          const nowMs = Date.now();

          if (action === 'stats') {
            sendJson({
              ok: true,
              key,
              stats: shareStatsOf(st, { now: nowMs }),
              policy: normalizeSharePolicy(st.policy),
              pending: st.signals.map((s) => ({
                id: s.id, eventId: s.eventId, sourceGroup: s.sourceGroup,
                summary: s.summary, valence: s.valence, createdAt: s.createdAt
              })),
              recentDeliveries: st.deliveries.slice(-5).map((d) => ({
                eventId: d.eventId, at: d.at, answered: d.answered,
                settled: d.settled, summary: d.summary
              })),
              hardLimits: {
                minIntervalMs: SHARE_HARD_MIN_INTERVAL_MS,
                maxPerDay: SHARE_HARD_MAX_PER_DAY,
                maxSignals: SHARE_MAX_SIGNALS
              }
            });
            return;
          }

          if (action === 'signal') {
            // 只有群会话能报：主人私聊自身不能反复制造来信，这是计划里的硬规则。
            if (!isGroupKey(key)) {
              sendJson({
                ok: false,
                error: '主动报告只能由群会话发起：私聊里没有「群事件」，不该自己制造来信'
              }, 403);
              return;
            }
            // 也不能替别的群报：A 群发生的事从 B 群报出来就是串台。
            const sourceGroup = String(body.sourceGroup ?? key).trim() || key;
            if (sourceGroup !== key) {
              sendJson({
                ok: false,
                error: `只能报告本群的事：sourceGroup 必须是当前会话 ${key}`
              }, 403);
              return;
            }
            const r = addSignal(st, {
              eventId: body.eventId,
              summary: body.summary,
              valence: body.valence,
              sourceGroup,
              willingness: body.willingness,
              now: nowMs
            });
            if (!r.ok) {
              sendJson({ ok: false, error: shareRejectReason(r.reason), reason: r.reason }, 400);
              return;
            }
            persistShareState({
              action: 'signal',
              key,
              detail: {
                eventId: r.signal.eventId,
                summary: r.signal.summary,
                valence: r.signal.valence,
                willingness: r.signal.willingness
              }
            });
            log(`[share] 收到待报告信号（${key}，valence ${r.signal.valence}）：${r.signal.summary}`);
            sendJson({ ok: true, accepted: true, signal: r.signal, pending: st.signals.length });
            return;
          }

          // action === 'policy'
          // setPolicy 内部是 {...before, ...raw}，传 undefined 会把已有的自定义值
          // 打回默认。所以这里只挑真正给了的字段。
          const patch = {};
          if (body.enabled !== undefined) patch.enabled = !!body.enabled;
          if (body.quietStartHour !== undefined && body.quietStartHour !== null) patch.quietStartHour = body.quietStartHour;
          if (body.quietEndHour !== undefined && body.quietEndHour !== null) patch.quietEndHour = body.quietEndHour;
          if (body.maxPerDay !== undefined && body.maxPerDay !== null) patch.maxPerDay = body.maxPerDay;
          if (body.minIntervalMs !== undefined && body.minIntervalMs !== null) patch.minIntervalMs = body.minIntervalMs;
          const changedKeys = Object.keys(patch);
          const r = setSharePolicy(st, patch, { now: nowMs });
          persistShareState({ action: 'policy', key, detail: { changed: changedKeys, before: r.before, after: r.after } });
          if (changedKeys.length) {
            log(`[share] 报告策略更新（${key}）：${changedKeys.join('/')} → 间隔 ${Math.round(r.after.minIntervalMs / 60000)} 分钟、每日 ${r.after.maxPerDay} 条、安静 ${r.after.quietStartHour}-${r.after.quietEndHour} 点`);
          }
          // 被夹回原值时明确告诉她，别说「改了」其实没改。
          const clamped = [];
          for (const k of changedKeys) {
            if (JSON.stringify(r.before[k]) !== JSON.stringify(r.after[k]) && String(patch[k]) !== String(r.after[k])) {
              clamped.push(k);
            }
          }
          sendJson({
            ok: true,
            before: r.before,
            after: r.after,
            clamped,
            note: clamped.length
              ? '有几项被系统硬上限夹回更保守的值（报告最短 6 小时一次、每日最多 4 条）'
              : null
          });
          return;
        }
"""

# ── 5. sweepPendingWakeReasons 末尾调用 ──────────────────────────────────
SWEEP_ANCHOR = """    // MARKER: proactive-reschedule —— 巡检末尾顺手补排缺档期的会话。
    ensureProactiveScheduledV2();"""
SWEEP_ADD = """    // MARKER: proactive-reschedule —— 巡检末尾顺手补排缺档期的会话。
    ensureProactiveScheduledV2();
    // MARKER: share-signal-tick —— 同一趟巡检里看一眼有没有该跟主人说的事。
    // 不新增定时器（计划要求），每次只做一次 O(信号数) 的判断，有界。
    reportTickV2();"""

# ── 6. buildWakePromptV2 的 share 分支 ──────────────────────────────────
PROMPT_ANCHOR = "    if (reason === 'poke') {"
PROMPT_ADD = r"""    if (reason === 'share') {
      // MARKER: share-prompt
      // 这是她自己攒下来的「想跟主人说的事」，不是主人问。语气要像人主动开口，
      // 不是写工作汇报；也得给她「这次不说了」的余地——判断权在她手上。
      const d = shareLastDeliveryInfo();
      const tone = !d ? '' : (d.valence <= -0.34
        ? '（这件事不太妙，说的时候可以低落一点）'
        : d.valence >= 0.34
          ? '（这件事挺好，说的时候可以高兴一点）'
          : '');
      return `${base}【跟主人说一声】${key}
原因：你在群里碰到了一件值得跟主人提一句的事，现在轮到说了。
事件：${d ? d.summary : '（这条信号已经过期了）'}${tone}
来源：${d && d.sourceGroup ? d.sourceGroup : '群聊'}
这是一次**你主动开口**，不是他问你才答。用一两句话说清发生了什么、你当时怎么想，别写成通报，也别把群聊原话搬过来。
说完就安静收尾（qq_mark_read 或 qq_set_wake_config）；他要是不接这个话题，就别追着往下说。
如果这件事牵扯到别人的私事、你觉得不该外传，这次就不说，直接收尾也可以。`;
    }
    """

# ── 7. 主人私聊来信 → 记回应 ─────────────────────────────────────────────
OWNER_ANCHOR = """    if (!plainContent && !quoteTargetIsSelf) return;
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');"""
OWNER_ADD = """    if (!plainContent && !quoteTargetIsSelf) return;
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');
    // MARKER: share-owner-reply
    // 主人在私聊里说话 = 他回应了之前的报告，也等于「他不理我」这个暂停理由
    // 不成立了。这是解除暂停的唯一入口。
    if (kind === 'private' && isOwner && plainContent) {
      try { noteOwnerReplyToShare(); } catch (error) { log(`[share] 记主人回应失败：${error?.message ?? error}`); }
    }"""

# ── 8. WAKE_PRIORITY 加 share ────────────────────────────────────────────
PRIO_ANCHOR = """    timeout: 30,
    proactiveCheck: 20
  };"""
PRIO_ADD = """    timeout: 30,
    proactiveCheck: 20,
    // 主动报告比「主动冒泡」重要一点：那是她攒着想跟主人说的话，
    // 但绝不能压过 replyCheck 以上的「有人在跟她说话」。
    share: 35
  };"""


def apply(marker, anchor, addition, label, before=True):
    if marker in SRC:
        skipped.append(label)
        return None
    cnt = SRC.count(anchor)
    ensure(cnt == 1, '%s 的锚点命中 %d 次（必须恰好 1 次）' % (label, cnt))
    if before:
        return SRC.replace(anchor, addition + anchor, 1)
    return SRC.replace(anchor, addition, 1)


steps = [
    ('MARKER: share-signal\n', IMPORT_ANCHOR, IMPORT_ADD, 'import', False),
    ('MARKER: share-signal-file', FILE_ANCHOR, FILE_ADD, '状态文件路径', False),
    ('MARKER: share-signal-wire', WIRE_ANCHOR, WIRE_ADD, '接线层', True),
    ('MARKER: share-signal-route', ROUTE_ANCHOR, ROUTE_ADD, 'HTTP 端点', True),
    ('MARKER: share-signal-tick', SWEEP_ANCHOR, SWEEP_ADD, '巡检调用', False),
    ('MARKER: share-prompt', PROMPT_ANCHOR, PROMPT_ADD, 'share 唤醒文案', True),
    ('MARKER: share-owner-reply', OWNER_ANCHOR, OWNER_ADD, '主人回应钩子', False),
]

for marker, anchor, addition, label, before in steps:
    new = apply(marker, anchor, addition, label, before)
    if new is not None:
        SRC = new
        changed.append(label)

# WAKE_PRIORITY 单独处理（marker 用注释插不进去，靠 share: 35 判）
if '    share: 35' in SRC:
    skipped.append('唤醒优先级')
else:
    cnt = SRC.count(PRIO_ANCHOR)
    ensure(cnt == 1, '唤醒优先级的锚点命中 %d 次（必须恰好 1 次）' % cnt)
    SRC = SRC.replace(PRIO_ANCHOR, PRIO_ADD, 1)
    changed.append('唤醒优先级')

# ── 最终断言 ─────────────────────────────────────────────────────────────
# 锚点行的存活断言 —— apply(before=False) 是替换而非插入，漏写锚点就会静默删掉原行。
# 这个坑第一次踩时，shared-memory 的 import 尾巴和 SHARED_MEMORY_FILE 常量都被删了，
# 而临时目录里 node --check 因为是 CJS 解析、直接返回 0，看不出任何问题。
ensure("} from './shared-memory-store.js';" in SRC, 'shared-memory 的 import 尾巴被删了')
ensure("} from './share-signal-store.js';" in SRC, 'share-signal 的 import 尾巴没写上')
ensure('const SHARED_MEMORY_FILE = path.join(STATE_DIR,' in SRC, 'SHARED_MEMORY_FILE 常量被删了')
ensure("const SHARE_SIGNAL_FILE = path.join(STATE_DIR, 'share-signal.json');" in SRC, 'SHARE_SIGNAL_FILE 没写上')
ensure('reportTickV2();' in SRC, '巡检里没接上 reportTickV2')
ensure(SRC.count('reportTickV2') == 2, 'reportTickV2 应恰好出现 2 次（定义 + 调用），实际 %d' % SRC.count('reportTickV2'))
ensure('shareMemoryLine' not in SRC, '写错名字了')
ensure(SRC.count("reason === 'share'") == 1, "reason === 'share' 应恰好 1 次")
ensure('noteOwnerReplyToShare' in SRC, '主人回应钩子没接上')
ensure(SRC.count("if (reason === 'poke') {") == 1, "锚点行的插入把 'if (reason === \"poke\") {' 复制成了两份，会多套一层 if，导致其余 reason 的 prompt 全变 undefined")
ensure(SRC.count('function reportTickV2') == 1, 'reportTickV2 定义应恰好 1 次')

io.open(TARGET, 'w', encoding='utf-8').write(SRC)
print('changed: ' + (', '.join(changed) if changed else '(无)'))
print('skipped: ' + (', '.join(skipped) if skipped else '(无)'))
print('bytes: %d -> %d (+%d)' % (orig_len, len(SRC), len(SRC) - orig_len))
