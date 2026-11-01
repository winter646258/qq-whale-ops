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
  // 两个上限，含义完全不同，不能共用一个：
  //   maxPerDay       = 她当天**实际写了几条**的上限（写满就不再催）
  //   maxPromptsPerDay= 系统当天**催了几次**的上限（防止从早念到晚）
  // 原来两个都用 maxPerDay，结果「她主动写了 1 条」也占掉一次催写额度，
  // 或者反过来「催了 3 次」就被当成「已经写了 3 条」。语义混在一起算不清。
  maxPerDay: 5,
  maxPromptsPerDay: 5,
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
    // 没配就跟着 maxPerDay 走（默认都是 5）——单独配了才分叉。
    maxPromptsPerDay: num(raw.maxPromptsPerDay, num(raw.maxPerDay, DIARY_DAILY_DEFAULTS.maxPromptsPerDay)),
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

// MARKER: diary-daily-count
/** 某天已经写了几条（day 字段优先，老条目用 t 兜底）。 */
export function countEntriesOnDay(entries, day) {
  const want = String(day ?? '');
  if (!want) return 0;
  const list = Array.isArray(entries) ? entries : [];
  let n = 0;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    if (String(entry.day ?? '') === want) { n += 1; continue; }
    const t = Number(entry.t);
    if ((!entry.day) && Number.isFinite(t) && t > 0 && localDayOf(t) === want) n += 1;
  }
  return n;
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
  // MARKER: diary-daily-multi —— 一天可以写多条。
  // 原来这里是 `if (hasEntryOnDay(entries, day)) return done;`，一条就停，
  // maxPerDay 那个配置等于没用。改成按当天**实际条数**判断：写满 maxPerDay 才停，
  // 中间靠 cooldownMs 拉开间隔（默认 3 小时），免得一天追着念。
  const wroteToday = countEntriesOnDay(entries, day);
  if (wroteToday >= c.maxPerDay) return result(false, 'done', { wroteToday });
  if (inQuiet(hh, c)) return result(false, 'quiet');
  // 注意这里换成 maxPromptsPerDay：rec.count 是「催了几次」，不是「写了几条」。
  if (rec.count >= c.maxPromptsPerDay) return result(false, 'capped', { wroteToday });
  const lastAt = Number(rec.lastAt) || 0;
  if (lastAt > 0 && Number(now) - lastAt < c.cooldownMs) return result(false, 'cooldown');

  const updated = { count: rec.count + 1, lastAt: Number(now) };
  return {
    nudged: true,
    reason: 'nudge',
    state: { days: { ...pruned.days, [day]: updated } },
    dirty: true,
    count: updated.count,
    wroteToday,
    line: dailyDiaryLine({ hour: hh, count: updated.count, wroteToday, cfg: c })
  };
}

export function dailyDiaryLine({ hour = 12, count = 1, wroteToday = 0, cfg = DIARY_DAILY_DEFAULTS } = {}) {
  const c = { ...DIARY_DAILY_DEFAULTS, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  const again = Number(count) > 1 ? '（再提醒一次）' : '';
  const already = Number(wroteToday) || 0;
  const cap = Math.max(1, Number(c.maxPerDay) || DIARY_DAILY_DEFAULTS.maxPerDay);
  // 已经写过就别再说「今天还没写」—— 那是事实错误，她会照着演。
  if (already > 0) {
    if (Number(hour) >= c.strongAfterHour) {
      return `【今天已经写了 ${already}/${cap} 条】${again}还能再写${already + 1 < cap ? '几' : '一'}条。想记就记，写具体的：谁说了什么、你当时怎么想的、场景是什么样。没有就不用写，别硬凑。\n\n`;
    }
    return `【今天写了 ${already}/${cap} 条】${again}又想起什么了？可以再记一条（qq_diary，写具体的事，几百字也行，分段也行）。没想起就跳过，别为了凑数写。\n\n`;
  }
  if (Number(hour) >= c.strongAfterHour) {
    return `【今天快过完了，日记还没写】${again}先补一条今天的事（qq_diary，写具体的：发生了什么、你当时怎么想、周围什么样；几百字也行，分段也行），写完再去聊别的。别等明天——明天写不出今天的感觉。\n\n`;
  }
  return `【今天还没写日记】${again}先把今天写下来（qq_diary，写具体的事：谁说了什么、你当时怎么想的、旁边是什么样；可以写长，可以分几段），写完再聊别的。别写成总结，也别在聊天里汇报「我写了日记」。\n\n`;
}

// MARKER: diary-draft
// 日记草稿：结算顺手写一句，等她点头再落进真正的日记本。
// 为什么不直接写进 日记.jsonl：她的日记是她自己的东西，
// 系统替她写进去，那份「她自己写的」就不成立了。草稿放着，她改两句再发。
export const DIARY_DRAFT_DEFAULTS = {
  keepHours: 20,
  textChars: 400,
  moodChars: 20,
  eveningHour: 23,
  eveningMinute: 20,
  eveningWindowMin: 30,
};

export function draftCfg(cfg) {
  const raw = cfg && cfg.socialV2 && typeof cfg.socialV2 === 'object' ? cfg.socialV2.diaryDaily : null;
  const src = raw && typeof raw === 'object' ? raw : {};
  const pick = (v, d, lo, hi) => {
    if (v === null || v === undefined || v === '') return d;
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(hi, Math.max(lo, Math.floor(n)));
  };
  return {
    keepHours: pick(src.draftKeepHours, DIARY_DRAFT_DEFAULTS.keepHours, 1, 72),
    textChars: pick(src.draftTextChars, DIARY_DRAFT_DEFAULTS.textChars, 20, 800),
    moodChars: pick(src.draftMoodChars, DIARY_DRAFT_DEFAULTS.moodChars, 2, 40),
    eveningHour: pick(src.eveningHour, DIARY_DRAFT_DEFAULTS.eveningHour, 0, 23),
    eveningMinute: pick(src.eveningMinute, DIARY_DRAFT_DEFAULTS.eveningMinute, 0, 59),
    eveningWindowMin: pick(src.eveningWindowMin, DIARY_DRAFT_DEFAULTS.eveningWindowMin, 10, 120),
  };
}

export function normalizeDraft(raw, cfg = null) {
  const c = { ...DIARY_DRAFT_DEFAULTS, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  if (!raw || typeof raw !== 'object') return null;
  // 保留换行（草稿可能是一段场景，压成一行就只剩流水账）；只压横向空白。
  const text = String(raw.text ?? '').replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').trim();
  if (!text) return null;
  return {
    day: String(raw.day ?? '').slice(0, 10),
    text: text.length > c.textChars ? text.slice(0, Math.max(1, c.textChars - 1)) + '…' : text,
    mood: String(raw.mood ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, c.moodChars),
    at: Number(raw.at) > 0 ? Number(raw.at) : Date.now(),
  };
}

export function isDraftFresh(draft, { now = Date.now(), cfg = null } = {}) {
  if (!draft || !draft.text) return false;
  const c = { ...DIARY_DRAFT_DEFAULTS, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  if (now - Number(draft.at || 0) > c.keepHours * 3600000) return false;
  return !draft.day || draft.day === localDayOf(now);
}

export function draftLine(draft, { now = Date.now(), cfg = null } = {}) {
  if (!isDraftFresh(draft, { now, cfg })) return '';
  const mood = draft.mood ? `（${draft.mood}）` : '';
  return `【今天的日记草稿${mood}】${draft.text}\n（这是我替你记的草稿，不用照抄——改成你自己的口气，写完调 qq_diary 落进日记本；不想写就直说。）\n\n`;
}

// 傍晚那一档：只在这个窗口里算「该催了」，错过就不补（半夜催人写日记没道理）。
export function eveningDue(now = Date.now(), cfg = null) {
  const c = { ...DIARY_DRAFT_DEFAULTS, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  const d = new Date(now);
  const mins = d.getHours() * 60 + d.getMinutes();
  const start = c.eveningHour * 60 + c.eveningMinute;
  return mins >= start && mins < start + c.eveningWindowMin;
}
