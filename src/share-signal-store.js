// 主动报告的纯逻辑层：何时可以「跟主人说一声」，以及说了之后怎么退避。
//
// 这个文件只做判断，不做 IO、不发消息、不认识 QQ 和 DSH。所有「现在几点」都由
// 调用方传 now 进来，于是每条规则都能被单测钉死。
//
// 设计上刻意把它和 mood-store 分开：情绪是「她此刻什么感觉」，待报告信号是
// 「有件事发生了、她想着要不要跟主人讲」。混成一个字段，就会出现「心情不好所以
// 汇报一下」这种既不是情绪也不是事件的东西。
//
// 几条硬规则（角色改不了，主人也只能往更保守的方向调）：
//   · 只有群事件能触发报告。私聊自身不能凭空生成来信。
//   · 同一条事件只报一次。
//   · 最短 6 小时一次；每日最多 4 次。
//   · 连续 3 次没回应 → 间隔翻倍；再叠上「这段时间主人一句没回」→ 暂停一周。
//
// 文件末尾两个 load/save 是唯一的 IO，和 shared-memory-store.js 同一个模型：
// 读不到就当空库，读坏了要抛（不能把「读不动」当「空库」写回去，那等于把她
// 攒着想说的话一次性抹掉）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SHARE_VERSION = 1;

/** 系统硬下限：角色与服务端都不能比这更频繁。 */
export const HARD_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 系统硬上限：一天最多几条。 */
export const HARD_MAX_PER_DAY = 4;

/** 多久没回应算「这次没回应」。 */
export const RESPONSE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
/** 暂停时长。 */
export const PAUSE_MS = 7 * 24 * 60 * 60 * 1000;
/** 连续几次没回应后开始降频。 */
export const UNANSWERED_THRESHOLD = 3;

export const MAX_SIGNALS = 20;
export const MAX_SUMMARY_CHARS = 80;
export const MAX_DELIVERIES = 50;
export const MAX_SEEN_EVENTS = 200;

export const DEFAULT_QUIET_START_HOUR = 23;
export const DEFAULT_QUIET_END_HOUR = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v, fallback = '') {
  return typeof v === 'string' ? v : fallback;
}

/** 只接受 group:<数字>。/^private:/ 一律拒——报告不能由私聊自己制造。 */
export function isGroupKey(v) {
  return typeof v === 'string' && /^group:\d+$/.test(v.trim());
}

export function clampValence(v) {
  const n = num(v, 0);
  return Math.min(1, Math.max(-1, n));
}

export function clampHour(v, fallback) {
  const n = Math.trunc(num(v, fallback));
  if (!Number.isFinite(n) || n < 0 || n > 23) return fallback;
  return n;
}

/** 摘要截断：按字符截，不按字节，中文不至于被砍成半个字。 */
export function trimSummary(text) {
  const s = str(text).replace(/\s+/g, ' ').trim();
  if (s.length <= MAX_SUMMARY_CHARS) return s;
  return s.slice(0, MAX_SUMMARY_CHARS - 1) + '…';
}

/** 角色可调的策略，但每条都被夹回安全区间。 */
export function normalizePolicy(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const start = clampHour(r.quietStartHour, DEFAULT_QUIET_START_HOUR);
  const end = clampHour(r.quietEndHour, DEFAULT_QUIET_END_HOUR);
  // 间隔只能更保守：角色想调成 1 小时，被夹回 6 小时。
  const wantInterval = num(r.minIntervalMs, HARD_MIN_INTERVAL_MS);
  const minIntervalMs = Math.max(HARD_MIN_INTERVAL_MS, wantInterval);
  const wantPerDay = Math.trunc(num(r.maxPerDay, HARD_MAX_PER_DAY));
  const maxPerDay = Math.min(HARD_MAX_PER_DAY, Math.max(1, wantPerDay));
  return {
    enabled: r.enabled !== false,
    quietStartHour: start,
    quietEndHour: end,
    minIntervalMs,
    maxPerDay
  };
}

export function createDefaultState(now = 0) {
  return {
    version: SHARE_VERSION,
    policy: normalizePolicy({}),
    signals: [],
    deliveries: [],
    seenEventIds: [],
    lastDeliveredAt: 0,
    lastOwnerReplyAt: 0,
    unansweredStreak: 0,
    silencedUntil: 0,
    createdAt: now
  };
}

export function normalizeState(raw, { now = 0 } = {}) {
  const base = createDefaultState(now);
  if (!raw || typeof raw !== 'object') return base;
  const signals = Array.isArray(raw.signals) ? raw.signals.filter((s) => s && typeof s === 'object').map((s) => ({
    id: str(s.id) || `s${Math.random().toString(36).slice(2, 8)}`,
    eventId: str(s.eventId),
    sourceGroup: str(s.sourceGroup),
    summary: trimSummary(s.summary),
    valence: clampValence(s.valence),
    willingness: Math.min(1, Math.max(0, num(s.willingness, 0.5))),
    createdAt: num(s.createdAt, now)
  })).filter((s) => s.eventId && s.summary && isGroupKey(s.sourceGroup)) : [];
  const deliveries = Array.isArray(raw.deliveries) ? raw.deliveries.filter((d) => d && typeof d === 'object').map((d) => ({
    id: str(d.id),
    eventId: str(d.eventId),
    at: num(d.at),
    answered: d.answered === true,
    settled: d.settled === true,
    // 投递记录里保留摘要与来源：唤醒可能先入队、等会话空了才真正投递，
    // 那时候信号本身已经从待报队列里摘掉了，提示词得靠这里取原文。
    summary: trimSummary(d.summary),
    valence: clampValence(d.valence),
    sourceGroup: str(d.sourceGroup)
  })) : [];
  return {
    version: SHARE_VERSION,
    policy: normalizePolicy(raw.policy),
    signals: signals.slice(-MAX_SIGNALS),
    deliveries: deliveries.slice(-MAX_DELIVERIES),
    seenEventIds: Array.isArray(raw.seenEventIds)
      ? raw.seenEventIds.map((x) => str(x)).filter(Boolean).slice(-MAX_SEEN_EVENTS)
      : [],
    lastDeliveredAt: num(raw.lastDeliveredAt),
    lastOwnerReplyAt: num(raw.lastOwnerReplyAt),
    unansweredStreak: Math.max(0, Math.trunc(num(raw.unansweredStreak))),
    silencedUntil: num(raw.silencedUntil),
    createdAt: num(raw.createdAt, now)
  };
}

/** 安静时段：支持跨零点（23→8）。起止相同视为没有安静时段。 */
export function inQuietHours(hour, policy) {
  const p = policy ?? normalizePolicy({});
  const h = Math.trunc(num(hour, 0));
  if (p.quietStartHour === p.quietEndHour) return false;
  if (p.quietStartHour < p.quietEndHour) {
    return h >= p.quietStartHour && h < p.quietEndHour;
  }
  return h >= p.quietStartHour || h < p.quietEndHour;
}

/**
 * 记一条待报告信号。
 *
 * 拒绝的情况都返回人话 reason，不抛错——角色调错参数时应该得到「为什么不行」，
 * 而不是一个堆栈。
 */
export function addSignal(state, {
  eventId, summary, valence, sourceGroup, willingness = 0.5, now = Date.now()
} = {}) {
  const st = state;
  const eid = str(eventId).trim();
  const group = str(sourceGroup).trim();
  if (!eid) return { ok: false, reason: 'event-id-required' };
  if (!isGroupKey(group)) return { ok: false, reason: 'group-source-required' };
  const text = trimSummary(summary);
  if (!text) return { ok: false, reason: 'summary-required' };
  if (st.seenEventIds.includes(eid)) return { ok: false, reason: 'duplicate-event' };
  if (st.signals.some((s) => s.eventId === eid)) return { ok: false, reason: 'duplicate-event' };
  const sig = {
    id: `s${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    eventId: eid,
    sourceGroup: group,
    summary: text,
    valence: clampValence(valence),
    willingness: Math.min(1, Math.max(0, num(willingness, 0.5))),
    createdAt: now
  };
  st.signals.push(sig);
  if (st.signals.length > MAX_SIGNALS) st.signals = st.signals.slice(-MAX_SIGNALS);
  return { ok: true, signal: sig };
}

/**
 * 结算过窗口的投递：窗口内主人没回过的，记一次「未回应」。
 * 返回本次新结算的数量和是否触发了暂停，方便调用方只在对数上打一次日志。
 */
export function settleDeliveries(state, { now = Date.now() } = {}) {
  const st = state;
  let newlyUnanswered = 0;
  for (const d of st.deliveries) {
    if (d.settled) continue;
    if (now - d.at < RESPONSE_WINDOW_MS) continue;
    d.settled = true;
    if (!d.answered) {
      st.unansweredStreak += 1;
      newlyUnanswered += 1;
    }
  }
  let paused = false;
  if (st.unansweredStreak >= UNANSWERED_THRESHOLD && st.silencedUntil <= now) {
    // 降频只管「间隔翻倍」；暂停还要满足「这段时间主人一句话都没回」。
    // 否则主人明明天天在聊、只是没接这个话题，也会被停一周——那太粗暴。
    const silenceFrom = Math.max(st.lastOwnerReplyAt, st.createdAt);
    if (now - silenceFrom >= RESPONSE_WINDOW_MS) {
      st.silencedUntil = now + PAUSE_MS;
      // 罚过了就把计数清零。否则暂停一周期满的那一刻 streak 仍然是 3，
      // 下一次巡检会立刻再判一次暂停——名义上一周，实际是无限期。
      st.unansweredStreak = 0;
      paused = true;
    }
  }
  return { newlyUnanswered, paused, silencedUntil: st.silencedUntil };
}

/** 当前生效的投递间隔：未回应满 3 次就翻倍，但仍不低于系统硬下限。 */
export function effectiveIntervalMs(state) {
  const st = state;
  const base = Math.max(HARD_MIN_INTERVAL_MS, normalizePolicy(st.policy).minIntervalMs);
  const factor = st.unansweredStreak >= UNANSWERED_THRESHOLD ? 2 : 1;
  return base * factor;
}

/** 24 小时内已投递条数。 */
export function deliveredInLastDay(state, { now = Date.now() } = {}) {
  return state.deliveries.filter((d) => now - d.at < DAY_MS).length;
}

/** 挑一条最值得说的：意愿高、情绪/事件越强越靠前；同分取更新的。 */
export function pickSignal(state) {
  const list = [...state.signals];
  if (!list.length) return null;
  list.sort((a, b) => {
    const sa = a.willingness * (1 + Math.abs(a.valence));
    const sb = b.willingness * (1 + Math.abs(b.valence));
    if (sb !== sa) return sb - sa;
    return b.createdAt - a.createdAt;
  });
  return list[0];
}

/**
 * 现在能不能给主人发一条。
 *
 * 顺序有讲究：先看结构性原因（关掉/没信号/在暂停），再看安静时段，最后看节流。
 * 这样日志里读到的第一个 reason 就是「最根本的那个」，不会被次要条件掩盖。
 */
export function canDeliver(state, { now = Date.now(), hour } = {}) {
  const st = state;
  const p = normalizePolicy(st.policy);
  if (!p.enabled) return { ok: false, reason: 'disabled' };
  if (!st.signals.length) return { ok: false, reason: 'no-signal' };
  if (now < st.silencedUntil) {
    return { ok: false, reason: 'paused', waitMs: st.silencedUntil - now };
  }
  const h = hour === undefined ? new Date(now).getHours() : hour;
  if (inQuietHours(h, p)) return { ok: false, reason: 'quiet-hours' };
  const interval = effectiveIntervalMs(st);
  const elapsed = now - st.lastDeliveredAt;
  if (st.lastDeliveredAt && elapsed < interval) {
    return { ok: false, reason: 'cooldown', waitMs: interval - elapsed };
  }
  if (deliveredInLastDay(st, { now }) >= p.maxPerDay) {
    return { ok: false, reason: 'daily-cap' };
  }
  const signal = pickSignal(st);
  return { ok: true, reason: 'ok', signal };
}

/** 记一次投递：消掉信号、进投递历史、更新节流时间。 */
export function markDelivered(state, { signalId, now = Date.now() } = {}) {
  const st = state;
  const idx = st.signals.findIndex((s) => s.id === signalId);
  if (idx < 0) return { ok: false, reason: 'no-such-signal' };
  const [sig] = st.signals.splice(idx, 1);
  st.deliveries.push({
    id: `d${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    eventId: sig.eventId,
    at: now,
    answered: false,
    settled: false,
    summary: sig.summary,
    valence: sig.valence,
    sourceGroup: sig.sourceGroup
  });
  if (st.deliveries.length > MAX_DELIVERIES) st.deliveries = st.deliveries.slice(-MAX_DELIVERIES);
  if (!st.seenEventIds.includes(sig.eventId)) {
    st.seenEventIds.push(sig.eventId);
    if (st.seenEventIds.length > MAX_SEEN_EVENTS) st.seenEventIds = st.seenEventIds.slice(-MAX_SEEN_EVENTS);
  }
  st.lastDeliveredAt = now;
  return { ok: true, delivery: st.deliveries[st.deliveries.length - 1], signal: sig };
}

/** 取最近一条投递（拼 prompt 用）。 */
export function lastDelivery(state) {
  const list = state.deliveries;
  return list.length ? list[list.length - 1] : null;
}

/**
 * 主人回话了。
 *
 * 这既算「回应了那几条」，也是恢复暂停的唯一途径——暂停的理由是「他不理我」，
 * 他一说话这个理由就不成立了。想让暂停必须硬性走满一周，等于把人晾着。
 */
export function noteOwnerReply(state, { now = Date.now() } = {}) {
  const st = state;
  let answered = 0;
  for (const d of st.deliveries) {
    if (!d.answered && !d.settled && d.at <= now) {
      d.answered = true;
      answered += 1;
    }
  }
  st.lastOwnerReplyAt = now;
  st.unansweredStreak = 0;
  const resumed = st.silencedUntil > now;
  st.silencedUntil = 0;
  return { answered, resumed };
}

/** 主人改策略：同样只能往保守方向调，系统硬上限不受影响。 */
export function setPolicy(state, raw, { now = Date.now() } = {}) {
  const before = normalizePolicy(state.policy);
  const merged = {
    ...before,
    ...(raw && typeof raw === 'object' ? raw : {})
  };
  const after = normalizePolicy(merged);
  state.policy = after;
  if (state.silencedUntil && now && after.enabled === false) {
    // 关掉不等于解除暂停；反过来也不该「关一下再开」就洗掉暂停。
  }
  return { before, after };
}

/** 清掉过期垃圾，避免文件无限长。 */
export function pruneState(state, { now = Date.now() } = {}) {
  const st = state;
  st.deliveries = st.deliveries.slice(-MAX_DELIVERIES);
  st.seenEventIds = st.seenEventIds.slice(-MAX_SEEN_EVENTS);
  // 待报告信号放太久就没意义了：三天都没说出口的「刚刚发生的事」是旧闻。
  st.signals = st.signals.filter((s) => now - s.createdAt < RESPONSE_WINDOW_MS);
  return st;
}

export function statsOf(state, { now = Date.now() } = {}) {
  const st = state;
  const p = normalizePolicy(st.policy);
  return {
    enabled: p.enabled,
    pendingSignals: st.signals.length,
    unansweredStreak: st.unansweredStreak,
    pausedUntil: st.silencedUntil > now ? st.silencedUntil : null,
    lastDeliveredAt: st.lastDeliveredAt || null,
    lastOwnerReplyAt: st.lastOwnerReplyAt || null,
    deliveredInLastDay: deliveredInLastDay(st, { now }),
    effectiveIntervalMs: effectiveIntervalMs(st),
    minIntervalMs: p.minIntervalMs,
    maxPerDay: p.maxPerDay,
    quietHours: [p.quietStartHour, p.quietEndHour]
  };
}

// ── IO ────────────────────────────────────────────────────────────────────

/** 读库。不存在返回空库；损坏抛错——不能把「读不动」当「空库」写回去。 */
export function loadShareState(file, { now = Date.now() } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return createDefaultState(now);
    throw error;
  }
  const raw = JSON.parse(text);
  return normalizeState(raw, { now });
}

/** 原子写盘，权限 600（state/ 目录本身是 700）。 */
export function saveShareState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const st = normalizeState(state, { now: Date.now() });
  const body = JSON.stringify(st, null, 2) + '\n';
  try {
    fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}
