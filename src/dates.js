// 纪念日（世界层 C · §3.4）
//
// 只记**明确说过的日子**（「我生日是 3 月 7 日」），不做推理 —— 记错日期比不记更糟。
//
// 三条设计决定：
//   1. 存 `{month, day}` 而不是完整时间戳：生日/纪念日是按年重复的，存年份反而会在跨年时失效。
//   2. 提前 `lookaheadDays` 天预告，当天单独一段：预告让她有时间准备，当天才是「说点什么」的时刻。
//   3. 生成图只是**提示**（`giftType` 里写着），发不发、画不画由她决定；代码不做自动发送。

export const DATES_DEFAULTS = {
  enabled: true,
  lookaheadDays: 3,
  maxItems: 50,
  maxInject: 2,
  noteChars: 60,
  promptChars: 120,
  keepPastDays: 1
};

export const GIFT_TYPES = ['text', 'image', 'both'];

function num(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function datesCfg(cfg) {
  const d = cfg?.socialV2?.dates ?? cfg?.dates ?? {};
  const def = DATES_DEFAULTS;
  return {
    enabled: d.enabled !== false,
    lookaheadDays: num(d.lookaheadDays, def.lookaheadDays, { min: 0, max: 30 }),
    maxItems: num(d.maxItems, def.maxItems, { min: 1, max: 400 }),
    maxInject: num(d.maxInject, def.maxInject, { min: 0, max: 9 }),
    noteChars: num(d.noteChars, def.noteChars, { min: 4, max: 200 }),
    promptChars: num(d.promptChars, def.promptChars, { min: 10, max: 500 }),
    keepPastDays: num(d.keepPastDays, def.keepPastDays, { min: 0, max: 30 })
  };
}

/** 从 `3月7日` / `3-7` / `03-07` / `{month:3,day:7}` 里取月日；取不到返回 null。 */
export function parseMonthDay(raw, extra) {
  const pick = (m, d) => {
    const mm = Number(m);
    const dd = Number(d);
    if (!Number.isFinite(mm) || !Number.isFinite(dd)) return null;
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    return { month: Math.floor(mm), day: Math.floor(dd) };
  };
  if (raw && typeof raw === 'object') return pick(raw.month, raw.day);
  if (extra && typeof extra === 'object') return pick(extra.month, extra.day);
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const cn = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (cn) return pick(cn[1], cn[2]);
  const iso = s.match(/^\d{4}-(\d{1,2})-(\d{1,2})/);
  if (iso) return pick(iso[1], iso[2]);
  const dash = s.match(/^(\d{1,2})[-/.](\d{1,2})$/);
  if (dash) return pick(dash[1], dash[2]);
  return null;
}

/** 洗一条纪念日；同名同月日视为同一条（更新 note）。 */
export function normalizeDate(raw, { now = Date.now(), cfg = DATES_DEFAULTS } = {}) {
  const c = { ...DATES_DEFAULTS, ...(cfg || {}) };
  const name = cleanText(raw?.name, 20);
  if (!name) return null;
  if (['__proto__', 'constructor', 'prototype'].includes(name)) return null;
  const md = parseMonthDay(raw);
  if (!md) return null;
  const repeat = String(raw?.repeat ?? 'year').trim() === 'once' ? 'once' : 'year';
  const giftType = GIFT_TYPES.includes(String(raw?.giftType ?? '').trim()) ? String(raw.giftType).trim() : 'text';
  return {
    id: '',
    name,
    month: md.month,
    day: md.day,
    repeat,
    note: cleanText(raw?.note, c.noteChars),
    giftType,
    giftPrompt: cleanText(raw?.giftPrompt, c.promptChars),
    createdAt: now
  };
}

export function addDates(store, { items = [], now = Date.now(), cfg = DATES_DEFAULTS } = {}) {
  const c = { ...DATES_DEFAULTS, ...(cfg || {}) };
  const base = store && typeof store === 'object' ? store : {};
  const list = Array.isArray(base.items) ? base.items.map((x) => ({ ...x })) : [];
  let added = 0;
  let updated = 0;
  for (const raw of Array.isArray(items) ? items : []) {
    const item = normalizeDate(raw, { now, cfg: c });
    if (!item) continue;
    const hit = list.find((x) => x.name === item.name && Number(x.month) === item.month && Number(x.day) === item.day);
    if (hit) {
      hit.note = item.note || hit.note;
      hit.giftType = item.giftType || hit.giftType;
      hit.giftPrompt = item.giftPrompt || hit.giftPrompt;
      updated += 1;
      continue;
    }
    item.id = `d${now.toString(36).slice(-5)}${(list.length + 1).toString(36)}`;
    list.push(item);
    added += 1;
  }
  while (list.length > c.maxItems) list.shift();
  return { store: { ...base, version: 1, items: list }, added, updated };
}

/** 距离「今年这个月日」还有几天：今天=0，已经过去=负数。 */
export function daysUntil(month, day, now = Date.now()) {
  const d = new Date(now);
  const year = d.getFullYear();
  const today = new Date(year, d.getMonth(), d.getDate()).getTime();
  let target = new Date(year, Math.max(0, month - 1), Math.max(1, day)).getTime();
  if (target < today) target = new Date(year + 1, Math.max(0, month - 1), Math.max(1, day)).getTime();
  return Math.round((target - today) / (24 * 3600 * 1000));
}

/** 今天 / 快到了（lookaheadDays 内），按剩余天数升序。 */
export function upcomingDates(store, { now = Date.now(), cfg = DATES_DEFAULTS } = {}) {
  const c = { ...DATES_DEFAULTS, ...(cfg || {}) };
  if (!c.enabled) return { today: [], soon: [] };
  const list = store && Array.isArray(store.items) ? store.items : [];
  const today = [];
  const soon = [];
  for (const x of list) {
    if (!x) continue;
    const left = daysUntil(Number(x.month), Number(x.day), now);
    if (left === 0) today.push({ ...x, left });
    else if (left > 0 && left <= c.lookaheadDays) soon.push({ ...x, left });
  }
  today.sort((a, b) => a.name.localeCompare(b.name));
  soon.sort((a, b) => a.left - b.left);
  return {
    today: today.slice(0, Math.max(0, c.maxInject)),
    soon: soon.slice(0, Math.max(0, c.maxInject))
  };
}

/** 注入行：当天一段 + 预告一段（都是事实，怎么反应由她决定）。 */
export function datesLine(store, { now = Date.now(), cfg = DATES_DEFAULTS } = {}) {
  const c = { ...DATES_DEFAULTS, ...(cfg || {}) };
  if (!c.enabled || c.maxInject <= 0) return '';
  const { today, soon } = upcomingDates(store, { now, cfg: c });
  const parts = [];
  if (today.length) {
    const who = today.map((x) => `${x.name}${x.note ? `（${x.note}）` : ''}`).join('、');
    const gift = today.some((x) => x.giftType === 'image' || x.giftType === 'both')
      ? '要画张图的话现在就该动笔了。'
      : '想好要说什么了吗。';
    parts.push(`【今天是】${who}。${gift}`);
  }
  if (soon.length) {
    const who = soon.map((x) => `${x.name}还有 ${x.left} 天`).join('、');
    parts.push(`【快到了】${who}。`);
  }
  return parts.join('').slice(0, 240);
}

export function summarizeDates(store, { now = Date.now(), limit = 5 } = {}) {
  const list = store && Array.isArray(store.items) ? store.items : [];
  if (!list.length) return '（没有）';
  return list
    .slice(0, Math.max(1, limit))
    .map((x) => `- ${x.month} 月 ${x.day} 日：${x.name}`)
    .join('\n');
}

/** 结算提示词里的额外任务段。 */
export function buildDatesAsk() {
  return [
    '如果他明确说了某个「过日子」的日期（比如「我生日是 3 月 7 日」「我们认识是 10 月 20 号」），记下来：',
    '- 每条写成 `{"name":"他的生日","month":3,"day":7,"repeat":"year","note":"他说过不太爱过生日"}`。',
    '- 只记原话里明确给出的月日，**不许推算、不许假设**；没说年份就 `repeat:"year"`。',
    '- 想要那天有图的，加 `"giftType":"image"`（默认 text）。'
  ].join('\n');
}
