// 每天先日记 —— 每日日记提醒的纯逻辑。
//
// 为什么单独一条：`buildSleepReviewLineFor` 里那段「空窗提醒」只在每天 4 点后
// 第一次醒来的回顾里出现一次，她连着几天不写也不会再说第二遍（实测 10-28 一整天
// 回顾念了 8 次，日记 0 条）。所以要另开一条：私聊里只要今天还没写就提醒，
// 带冷却和每日上限，免得从「不提醒」跳到「每条都念」。
//
// 这里只算「该不该提醒、提醒说什么」，落盘与取数据都在 bridge 里。

export const DIARY_DAILY_DEFAULTS = {
  enabled: true,
  cooldownMs: 3 * 3600 * 1000,
  maxPerDay: 3,
  quietStart: 23,
  quietEnd: 8,
  strongAfterHour: 20,
  keepDays: 7
};

function num(value, fallback) {
  // 注意 Number(null) === 0 这个坑：没配不能当成「配成 0」。
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function hourOf(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const h = Math.trunc(n);
  return h >= 0 && h <= 24 ? h : fallback;
}

export function dailyCfg(cfg) {
  const raw = cfg?.socialV2?.diaryDaily ?? {};
  return {
    enabled: raw.enabled !== false,
    cooldownMs: num(raw.cooldownMs, DIARY_DAILY_DEFAULTS.cooldownMs),
    maxPerDay: num(raw.maxPerDay, DIARY_DAILY_DEFAULTS.maxPerDay),
    quietStart: hourOf(raw.quietStart, DIARY_DAILY_DEFAULTS.quietStart),
    quietEnd: hourOf(raw.quietEnd, DIARY_DAILY_DEFAULTS.quietEnd),
    strongAfterHour: hourOf(raw.strongAfterHour, DIARY_DAILY_DEFAULTS.strongAfterHour),
    keepDays: num(raw.keepDays, DIARY_DAILY_DEFAULTS.keepDays)
  };
}

export function localDayOf(now = Date.now()) {
  const d = new Date(Number(now));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function hasEntryOnDay(entries, day) {
  const want = String(day ?? '');
  if (!want) return false;
  const list = Array.isArray(entries) ? entries : [];
  return list.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if (String(entry.day ?? '') === want) return true;
    // 老条目可能没有 day 字段，用时间戳兜底。
    const t = Number(entry.t);
    return Number.isFinite(t) && t > 0 && localDayOf(t) === want;
  });
}

export function inQuiet(hour, cfg = DIARY_DAILY_DEFAULTS) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return false;
  const start = hourOf(cfg.quietStart, DIARY_DAILY_DEFAULTS.quietStart);
  const end = hourOf(cfg.quietEnd, DIARY_DAILY_DEFAULTS.quietEnd);
  if (start === end) return false;
  if (start > end) return h >= start || h < end; // 跨零点：23 点到 8 点
  return h >= start && h < end;
}

function normalizeState(state) {
  const days = state && typeof state === 'object' && state.days && typeof state.days === 'object' ? state.days : {};
  const out = {};
  for (const [day, rec] of Object.entries(days)) {
    if (!rec || typeof rec !== 'object') continue;
    out[day] = { count: num(rec.count, 0) || 0, lastAt: Number(rec.lastAt) > 0 ? Number(rec.lastAt) : 0 };
  }
  return { days: out };
}

function pruneDays(state, today, keepDays) {
  const days = { ...state.days };
  const keep = num(keepDays, DIARY_DAILY_DEFAULTS.keepDays);
  const keys = Object.keys(days).sort();
  // 按字符串排序即按日期排序（YYYY-MM-DD），只留最近 keep 天 + 今天。
  const cutoff = keys.slice(0, Math.max(0, keys.length - keep));
  for (const day of cutoff) {
    if (day === today) continue;
    delete days[day];
  }
  return { days };
}

export function decideDailyDiary({ entries = [], now = Date.now(), hour = null, state = null, cfg = null } = {}) {
  const c = { ...DIARY_DAILY_DEFAULTS, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  const base = normalizeState(state);
  const day = localDayOf(now);
  const hh = hour === null || hour === undefined ? new Date(Number(now)).getHours() : Number(hour);
  const pruned = pruneDays(base, day, c.keepDays);
  const rec = pruned.days[day] && typeof pruned.days[day] === 'object' ? pruned.days[day] : { count: 0, lastAt: 0 };
  const next = { days: { ...pruned.days, [day]: rec } };
  const dirty = JSON.stringify(next.days) !== JSON.stringify(base.days);
  const result = (nudged, reason, extra) => ({ nudged, reason, state: next, dirty, count: rec.count, ...(extra || {}) });

  if (c.enabled === false) return result(false, 'disabled');
  if (hasEntryOnDay(entries, day)) return result(false, 'done');
  if (inQuiet(hh, c)) return result(false, 'quiet');
  if (rec.count >= c.maxPerDay) return result(false, 'capped');
  const lastAt = Number(rec.lastAt) || 0;
  if (lastAt > 0 && Number(now) - lastAt < c.cooldownMs) return result(false, 'cooldown');

  const updated = { count: rec.count + 1, lastAt: Number(now) };
  return {
    nudged: true,
    reason: 'nudge',
    state: { days: { ...pruned.days, [day]: updated } },
    dirty: true,
    count: updated.count,
    line: dailyDiaryLine({ hour: hh, count: updated.count, cfg: c })
  };
}

export function dailyDiaryLine({ hour = 12, count = 1, cfg = DIARY_DAILY_DEFAULTS } = {}) {
  const c = { ...DIARY_DAILY_DEFAULTS, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  const again = Number(count) > 1 ? '（再提醒一次）' : '';
  if (Number(hour) >= c.strongAfterHour) {
    return `【今天快过完了，日记还没写】${again}先补一条今天的事（qq_diary，一两句具体的：发生了什么、你当时怎么想），写完再去聊别的。别等明天——明天写不出今天的感觉。\n\n`;
  }
  return `【今天还没写日记】${again}先把今天写下来（qq_diary，一两句具体的：谁说了什么、你当时怎么想的），写完再聊别的。别写成总结，也别在聊天里汇报「我写了日记」。\n\n`;
}
