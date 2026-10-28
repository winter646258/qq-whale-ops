// 未完的话题（世界层 B · §3.2）
//
// 为什么单独一个模块：所有判断都要能单测（`scripts/test-threads.mjs`），
// bridge.js 里只做「取数据 / 调函数 / 写回」，不再长出一个 300 行的 if。
//
// 三条设计决定（都有理由）：
//   1. 谁说的算「谁」：走 settle 里已有的 `resolveImpressionWho` 归一，
//      不另造第四套别名（同一个人已经有过三个键的教训）。
//   2. `dueIn` 只在解析时换算成 `dueAt`：存的是绝对时间，注入时不用再猜。
//   3. 只记「他说了一半」的话，不记「她在等回复」：后者会把聊天变成催债。

export const THREADS_DEFAULTS = {
  enabled: true,
  maxItems: 20,
  maxAsk: 2,
  askGapMs: 6 * 60 * 60 * 1000,
  expireDays: 7,
  maxInject: 3,
  topicChars: 40,
  quoteChars: 20
};

function num(value, fallback, { min = -Infinity, max = Infinity, int = true } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = int ? Math.floor(n) : n;
  return Math.min(max, Math.max(min, v));
}

export function threadsCfg(cfg) {
  const t = cfg?.socialV2?.threads ?? cfg?.threads ?? {};
  const d = THREADS_DEFAULTS;
  return {
    enabled: t.enabled !== false,
    maxItems: num(t.maxItems, d.maxItems, { min: 1, max: 200 }),
    maxAsk: num(t.maxAsk, d.maxAsk, { min: 0, max: 9 }),
    askGapMs: num(t.askGapMs, d.askGapMs, { min: 60000, max: 7 * 24 * 3600 * 1000 }),
    expireDays: num(t.expireDays, d.expireDays, { min: 1, max: 90 }),
    maxInject: num(t.maxInject, d.maxInject, { min: 0, max: 9 }),
    topicChars: num(t.topicChars, d.topicChars, { min: 4, max: 120 }),
    quoteChars: num(t.quoteChars, d.quoteChars, { min: 2, max: 120 })
  };
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/**
 * 把模型写的 `dueIn` 换成绝对时间。
 * 认：`tomorrow` / `tonight` / `later` / `3h` / `2d` / `nextWeek` / 毫秒数。
 * 认不出来就当「明天」——比丢一条线索强。
 */
export function parseDueIn(raw, now = Date.now()) {
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return Math.floor(now + DAY);
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(m|min|h|hour|d|day|w|week)$/);
  if (m) {
    const v = Number(m[1]);
    const unit = m[2];
    const scale = unit.startsWith('m')
      ? 60 * 1000
      : unit.startsWith('h')
        ? HOUR
        : unit.startsWith('w')
          ? 7 * DAY
          : DAY;
    return Math.floor(now + v * scale);
  }
  if (s.includes('tonight') || s.includes('今晚')) return Math.floor(now + 4 * HOUR);
  if (s.includes('tomorrow') || s.includes('明天')) return Math.floor(now + DAY);
  if (s.includes('week') || s.includes('周')) return Math.floor(now + 7 * DAY);
  if (s.includes('later') || s.includes('过会') || s.includes('待会')) return Math.floor(now + 3 * HOUR);
  return Math.floor(now + DAY);
}

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

let counter = 0;
function newId(now) {
  counter += 1;
  return `t${now.toString(36).slice(-5)}${counter.toString(36)}`;
}

/** 把结算里的一条 `{who, topic, quote, dueIn}` 洗成一条记录；不合格返回 null。 */
export function normalizeThread(raw, { key = '', who = '', now = Date.now(), cfg = THREADS_DEFAULTS } = {}) {
  const c = { ...THREADS_DEFAULTS, ...(cfg || {}) };
  const topic = cleanText(raw?.topic, c.topicChars);
  if (!topic) return null;
  if (['__proto__', 'constructor', 'prototype'].includes(topic)) return null;
  return {
    id: '',
    key: String(key ?? ''),
    who: cleanText(who || raw?.who, 20),
    topic,
    quote: cleanText(raw?.quote, c.quoteChars),
    dueAt: parseDueIn(raw?.dueIn, now),
    askedCount: 0,
    lastAskedAt: 0,
    status: 'open',
    createdAt: now
  };
}

/**
 * 并入一批话题。
 * 同一会话 + 同一 topic 视为同一条（更新 dueAt/quote，不重复记）；
 * 超过上限时淘汰 `dueAt` 最远的那条（最不急的先让位）。
 */
export function addThreads(store, { key = '', who = '', items = [], now = Date.now(), cfg = THREADS_DEFAULTS } = {}) {
  const c = { ...THREADS_DEFAULTS, ...(cfg || {}) };
  const base = store && typeof store === 'object' ? store : {};
  const list = Array.isArray(base.items) ? base.items.map((x) => ({ ...x })) : [];
  let added = 0;
  let updated = 0;
  for (const raw of Array.isArray(items) ? items : []) {
    const item = normalizeThread(raw, { key, who: who || raw?.who, now, cfg: c });
    if (!item) continue;
    const hit = list.find((x) => x.key === item.key && x.topic === item.topic);
    if (hit) {
      hit.dueAt = item.dueAt || hit.dueAt;
      hit.quote = item.quote || hit.quote;
      hit.who = item.who || hit.who;
      hit.status = 'open';
      updated += 1;
      continue;
    }
    item.id = newId(now);
    list.push(item);
    added += 1;
  }
  while (list.length > c.maxItems) {
    let far = 0;
    for (let i = 1; i < list.length; i += 1) if (Number(list[i].dueAt) > Number(list[far].dueAt)) far = i;
    list.splice(far, 1);
  }
  return { store: { ...base, version: 1, items: list }, added, updated };
}

/** 到点、还没问够次数、距上次问够久的话题（最急的在前面）。 */
export function dueThreads(store, { key = '', now = Date.now(), cfg = THREADS_DEFAULTS } = {}) {
  const c = { ...THREADS_DEFAULTS, ...(cfg || {}) };
  const list = store && Array.isArray(store.items) ? store.items : [];
  return list
    .filter((x) => x && x.status === 'open' && String(x.key ?? '') === String(key ?? ''))
    .filter((x) => Number(x.dueAt) <= now)
    .filter((x) => Number(x.askedCount ?? 0) < c.maxAsk)
    .filter((x) => !Number(x.lastAskedAt) || now - Number(x.lastAskedAt) >= c.askGapMs)
    .sort((a, b) => Number(a.dueAt) - Number(b.dueAt))
    .slice(0, c.maxInject);
}

export function markAsked(store, { ids = [], now = Date.now() } = {}) {
  const base = store && typeof store === 'object' ? store : {};
  const set = new Set((Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean));
  if (!set.size) return { store: base, asked: 0 };
  let asked = 0;
  const items = (Array.isArray(base.items) ? base.items : []).map((x) => {
    if (!x || !set.has(String(x.id))) return x;
    asked += 1;
    return { ...x, askedCount: Number(x.askedCount ?? 0) + 1, lastAskedAt: now };
  });
  return { store: { ...base, version: 1, items }, asked };
}

/** 她提到了（结算回 `resolved: [id]`）就关掉。 */
export function resolveThreads(store, { ids = [], now = Date.now() } = {}) {
  const base = store && typeof store === 'object' ? store : {};
  const set = new Set((Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean));
  if (!set.size) return { store: base, closed: 0 };
  let closed = 0;
  const items = (Array.isArray(base.items) ? base.items : []).map((x) => {
    if (!x || !set.has(String(x.id)) || x.status !== 'open') return x;
    closed += 1;
    return { ...x, status: 'closed', closedAt: now };
  });
  return { store: { ...base, version: 1, items }, closed };
}

/** 过期（dueAt + expireDays 天）或已关闭超过 keepDays 的清掉。 */
export function pruneThreads(store, { now = Date.now(), cfg = THREADS_DEFAULTS, keepDays = 14 } = {}) {
  const c = { ...THREADS_DEFAULTS, ...(cfg || {}) };
  const base = store && typeof store === 'object' ? store : {};
  const expireMs = c.expireDays * DAY;
  const keepMs = Math.max(1, keepDays) * DAY;
  const items = (Array.isArray(base.items) ? base.items : []).filter((x) => {
    if (!x) return false;
    if (x.status !== 'open') return now - Number(x.closedAt || x.dueAt || now) < keepMs;
    return now - Number(x.dueAt || now) < expireMs;
  });
  return { ...base, version: 1, items };
}

/**
 * 注入行。`isProactive` 决定措辞强弱：
 *   - 平时（回话）：「【还挂着的话】…（想提就提，不想提就算了）」
 *   - 主动开口：「【可以问了】…」—— 只在这里允许她先开口问
 */
export function threadsLine(store, { key = '', now = Date.now(), cfg = THREADS_DEFAULTS, isProactive = false } = {}) {
  const c = { ...THREADS_DEFAULTS, ...(cfg || {}) };
  if (!c.enabled || c.maxInject <= 0) return { text: '', dueIds: [] };
  const open = (store && Array.isArray(store.items) ? store.items : [])
    .filter((x) => x && x.status === 'open' && String(x.key ?? '') === String(key ?? ''))
    .sort((a, b) => Number(a.dueAt) - Number(b.dueAt))
    .slice(0, c.maxInject);
  if (!open.length) return { text: '', dueIds: [] };
  const due = dueThreads(store, { key, now, cfg: c });
  const parts = open.map((x) => {
    const who = x.who ? `${x.who}` : '他';
    const quote = x.quote ? `「${x.quote}」` : '';
    return `${who}跟你说过${quote}${x.topic}`;
  });
  const canAsk = isProactive && due.length > 0;
  const head = canAsk ? '【可以问了】' : '【还挂着的话】';
  const tail = canAsk ? '想提就提，不想提就算了。' : '记得就提一句，不记得就算了。';
  const text = `${head}${parts.join('；')}。${tail}`.slice(0, 260);
  return { text, dueIds: isProactive ? due.map((x) => x.id) : [] };
}

export function summarizeThreads(store, { key = '', limit = 3 } = {}) {
  const list = (store && Array.isArray(store.items) ? store.items : [])
    .filter((x) => x && x.status === 'open' && String(x.key ?? '') === String(key ?? ''))
    .slice(0, Math.max(1, limit));
  if (!list.length) return '（没有）';
  return list.map((x) => `- ${x.topic}`).join('\n');
}

/** 结算提示词里的额外任务段。 */
export function buildThreadsAsk({ maxInject = 3 } = {}) {
  return [
    '如果他这次说了「明天再讲」「等会告诉你」「回头说」这类没说完的话，把它记成一条「还挂着的话」：',
    `- 最多 ${maxInject} 条，只记他真的没说完的，不要记你答应过的事。`,
    '- 每条写成 `{"who":"他","topic":"要跟你说的事还没说","quote":"明天再讲","dueIn":"tomorrow"}`，',
    '  `dueIn` 只能是 `3h` / `tomorrow` / `nextWeek` 这类；没有就省略这个字段。',
    '- 反过来，如果你这次已经问到了、或他说已经讲过了，把那条的 id 放进 `resolved`。'
  ].join('\n');
}
