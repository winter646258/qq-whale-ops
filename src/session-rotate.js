// 每天换新会话：不让一个 DSH 会话日记账式地长到几十万字。
//
// 为什么需要它：会话越长，每一轮都要把整段历史重新发上去。压缩能救一部分，
// 但工具调用留下的噪声压不掉（摘要只留话，不留工具过程）。换个新会话，
// 她的「记忆」靠的是我们自己的东西 —— 最近 100 条消息、成员印象、日程、
// 挂着的话、愿望、纪念日、日记、自述 —— 那些都在 state 里，不随会话消失。
//
// 设计上刻意保守：
//  - 只在设定的时间窗内换（默认 04:10 起 90 分钟），错过窗口就**当天不换**，
//    绝不在聊天当中突然换掉上下文；
//  - 正在回合里（有在跑的任务/排队）的不换，等下一次 tick；
//  - 刚说过话（默认 10 分钟内）的不换；
//  - 换的是「映射」，旧会话是**归档**不是删除，随时能翻回去看。
export const ROTATE_DEFAULTS = {
  enabled: true,
  hour: 4,
  minute: 10,
  windowMinutes: 90,
  minIdleMinutes: 10,
  kinds: ['private', 'group']
};

export function rotateCfg(cfg) {
  const raw = cfg?.socialV2?.sessionRotate ?? {};
  const num = (v, d, lo, hi) => {
    if (v === null || v === undefined || v === '') return d;
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    const f = Math.floor(n);
    if (f < lo) return lo;
    if (f > hi) return hi;
    return f;
  };
  const kinds = Array.isArray(raw.kinds) && raw.kinds.length
    ? raw.kinds.map((k) => String(k)).filter((k) => k === 'private' || k === 'group')
    : ROTATE_DEFAULTS.kinds.slice();
  return {
    enabled: raw.enabled !== false,
    hour: num(raw.hour, ROTATE_DEFAULTS.hour, 0, 23),
    minute: num(raw.minute, ROTATE_DEFAULTS.minute, 0, 59),
    windowMinutes: num(raw.windowMinutes, ROTATE_DEFAULTS.windowMinutes, 1, 24 * 60),
    minIdleMinutes: num(raw.minIdleMinutes, ROTATE_DEFAULTS.minIdleMinutes, 0, 24 * 60),
    kinds: kinds.length ? kinds : ROTATE_DEFAULTS.kinds.slice()
  };
}

export function localDayOf(now) {
  const d = now instanceof Date ? now : new Date(Number(now) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 现在是不是在换会话的窗口里。返回 due 与窗口起止（毫秒）。 */
export function rotateWindow(now, cfg) {
  const c = cfg ?? rotateCfg({});
  const t = Number(now) || Date.now();
  const d = new Date(t);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), c.hour, c.minute, 0, 0).getTime();
  const end = start + c.windowMinutes * 60 * 1000;
  return { due: t >= start && t <= end, start, end };
}

export function kindOfKey(key) {
  const s = String(key ?? '');
  if (s.startsWith('private:')) return 'private';
  if (s.startsWith('group:')) return 'group';
  return 'other';
}

/**
 * 这个会话现在该不该换。
 * lastActivityAt：这个会话最后一次有动静的时间（毫秒）。
 */
export function shouldRotate(key, { now, cfg, lastDay, busy, lastActivityAt } = {}) {
  const c = cfg ?? rotateCfg({});
  const t = Number(now) || Date.now();
  if (!c.enabled) return { rotate: false, why: 'disabled' };
  const kind = kindOfKey(key);
  if (kind === 'other') return { rotate: false, why: 'kind' };
  if (!c.kinds.includes(kind)) return { rotate: false, why: 'kind' };
  if (lastDay === localDayOf(t)) return { rotate: false, why: 'already' };
  const w = rotateWindow(t, c);
  if (!w.due) return { rotate: false, why: 'outside-window' };
  if (busy) return { rotate: false, why: 'busy' };
  const idleMs = Number(lastActivityAt) > 0 ? t - Number(lastActivityAt) : Infinity;
  if (idleMs < c.minIdleMinutes * 60 * 1000) return { rotate: false, why: 'recent-activity' };
  return { rotate: true, why: 'ok' };
}

export function rotateLine(key, oldSessionId) {
  const sid = String(oldSessionId ?? '');
  const short = sid ? sid.slice(0, 13) : '无';
  return `[会话换新] ${key} 旧会话 ${short}… 已归档，下一条消息开新上下文（记忆/日程/印象都在 state 里，不会丢）`;
}

export function pruneRotateDays(days, today, keepDays = 7) {
  const out = {};
  const keys = Object.keys(days || {}).sort();
  const keep = Math.max(1, Number(keepDays) || 7);
  for (const day of keys.slice(-keep)) out[day] = days[day];
  if (today && !out[today]) out[today] = { keys: [], at: 0 };
  return out;
}
