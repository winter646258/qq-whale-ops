// 日程（短期记忆）—— 纯逻辑模块：不碰网络、不读全局 config、无副作用，
// 便于隔离单测（沿用本项目 slang-learner.js / sticker-lib.js 的做法）。
//
// 作业规格说「三条原则比功能本身重要」，本模块就是照那三条落地的：
//
//   一、记不记、糊不糊、升不升，都归角色自己
//       ⇒ 不做「按天数自动降级 / 自动删除」这类规则。系统只做两件事：给工具、给事实。
//         没有「确认三次就升级」这种查表逻辑 —— 规则一写，它就在查表，不在想事。
//
//   二、模糊是改写，不是删除
//       ⇒ update 改 text 时，把旧文留进 originalText（角色在注入里看不到，管理员翻得到），
//         blurred=true。remove 才是真的没了。
//
//   三、注入要分层，别一股脑塞
//       ⇒ 今天明天说清楚，本周后面只报数量，更远只报总数。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 只允许这三个时段。给不准的精度，比给错的强。 */
export const PERIODS = ['上午', '下午', '晚上'];
const PERIOD_SET = new Set(PERIODS);

export const MAX_ENTRIES = 300;
export const MAX_TEXT_CHARS = 120;
export const MAX_ORIGINAL_CHARS = 200;
export const MAX_STRENGTH = 9;
export const MAX_QUERY_RESULTS = 60;

/** 结算提醒的最早小时（「凌晨 4 点」那个语义：4 点前不念叨）。 */
export const REVIEW_START_HOUR = 4;

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地日期 yyyy-MM-dd（服务器时区 Asia/Shanghai）。 */
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 「10 月 20 日 01:20」——注入里给人看的写法。 */
export function formatNow(d = new Date()) {
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 严格解析 yyyy-MM-dd；非法（含 2 月 30 日这种）返回 null。 */
export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

export function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  if (!d) return null;
  d.setDate(d.getDate() + Number(n || 0));
  return localDate(d);
}

/** a - b 的天数差；任一非法返回 null。 */
export function dayDiff(a, b) {
  const A = parseDate(a);
  const B = parseDate(b);
  if (!A || !B) return null;
  return Math.round((A.getTime() - B.getTime()) / 86400000);
}

/** 本周日（周一为一周之始）。 */
export function endOfWeek(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return null;
  const dow = d.getDay(); // 0=周日
  return addDays(dateStr, dow === 0 ? 0 : 7 - dow);
}

const CN_WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

/**
 * 把「今天 / 明天 / 后天 / 昨天 / 这周三 / 下周一 / 具体日期」归一成 yyyy-MM-dd。
 * 认不出来返回 null —— 宁可报错，也不瞎猜一个日期记下去。
 */
export function normalizeDate(input, todayStr) {
  const raw = String(input ?? '').trim();
  const today = todayStr || localDate();
  if (!raw) return today;
  if (parseDate(raw)) return raw;

  const rel = {
    今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2,
    昨天: -1, 昨日: -1, 前天: -2
  };
  if (raw in rel) return addDays(today, rel[raw]);

  // 「这周三」= 前缀「这」+「周」+「三」：前缀与「周」必须分开匹配，
  // 否则前缀里的「周」会被吃掉，后面再要求一个「周」就永远匹配不上。
  const m = /^(这|本|下|上)?(?:周|星期|礼拜)([一二三四五六日天])$/.exec(raw);
  if (m) {
    const target = CN_WEEKDAY[m[2]];
    const base = parseDate(today);
    const dow = base.getDay();
    const toMonday = dow === 0 ? -6 : 1 - dow;      // 本周一相对今天
    // 目标日相对本周一的偏移；周日（0）排在一周之末。
    let offset = toMonday + (target === 0 ? 6 : target - 1);
    if (m[1] === '下') offset += 7;
    else if (m[1] === '上') offset -= 7;
    return addDays(today, offset);
  }
  return null;
}

/** 宽松映射到三个时段之一；认不出返回 null（交给调用方报错）。 */
export function normalizePeriod(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '上午';
  if (PERIOD_SET.has(raw)) return raw;
  if (/^(早|早上|早晨|清早|上午|一早)$/.test(raw)) return '上午';
  if (/^(中午|午后|下午|白天|半晌)$/.test(raw)) return '下午';
  if (/^(晚|晚上|今晚|夜里|夜间|傍晚|半夜)$/.test(raw)) return '晚上';
  return null;
}

function emptyStore() {
  return { version: 1, reviewDays: {}, entries: [] };
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim();
  const date = String(raw.date ?? '').trim();
  if (!id || !parseDate(date)) return null;
  const period = PERIOD_SET.has(raw.period) ? raw.period : '上午';
  const text = String(raw.text ?? '').trim().slice(0, MAX_TEXT_CHARS);
  if (!text) return null;
  const originalText = String(raw.originalText ?? '').trim().slice(0, MAX_ORIGINAL_CHARS) || null;
  return {
    id,
    key: String(raw.key ?? '').trim(),
    date,
    period,
    text,
    originalText,
    blurred: raw.blurred === true,
    strength: Math.min(MAX_STRENGTH, Math.max(1, Math.round(Number(raw.strength) || 1))),
    createdAt: Number(raw.createdAt) > 0 ? Number(raw.createdAt) : Date.now(),
    lastMentionedAt: Number(raw.lastMentionedAt) > 0 ? Number(raw.lastMentionedAt) : 0
  };
}

/**
 * 读取日程库。
 * 文件不存在返回空库；文件损坏**抛错**，由调用方决定降级
 * （绝不能把「读不动」当成「空库」再写回去，那会清空全部日程）。
 */
export function loadSchedule(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyStore();
    throw error;
  }
  const raw = JSON.parse(text);
  const store = emptyStore();
  if (!raw || typeof raw !== 'object') return store;
  // 结算日**按会话**记：全局记一个的话，第一个会话念过之后别的会话当天就再也不会被提醒。
  if (raw.reviewDays && typeof raw.reviewDays === 'object') {
    for (const [k, v] of Object.entries(raw.reviewDays)) {
      if (parseDate(v)) store.reviewDays[String(k)] = String(v);
    }
  } else if (parseDate(raw.lastReviewDay)) {
    // 兼容早期只有全局 lastReviewDay 的格式
    store.reviewDays['*'] = String(raw.lastReviewDay);
  }
  if (Array.isArray(raw.entries)) {
    for (const item of raw.entries) {
      const e = normalizeEntry(item);
      if (e) store.entries.push(e);
    }
  }
  if (store.entries.length > MAX_ENTRIES) {
    store.entries = store.entries.slice(-MAX_ENTRIES);
  }
  return store;
}

/** 原子写盘（临时文件 + rename），权限 600。 */
export function saveSchedule(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const payload = {
    version: 1,
    reviewDays: store?.reviewDays && typeof store.reviewDays === 'object' ? store.reviewDays : {},
    entries: Array.isArray(store?.entries) ? store.entries : []
  };
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function makeId(taken) {
  for (let i = 0; i < 100; i += 1) {
    const id = 's' + crypto.randomBytes(3).toString('hex').slice(0, 5);
    if (!taken.has(id)) return id;
  }
  return 's' + Date.now().toString(16).slice(-5);
}

/** 记一条。返回新增的 entry。 */
export function addEntry(store, { key = '', date, period, text, now = Date.now() }) {
  const d = normalizeDate(date, localDate(new Date(now)));
  if (!d) throw new Error(`认不出日期「${date}」；请给 yyyy-MM-dd 或 今天/明天/后天/这周三`);
  const p = normalizePeriod(period);
  if (!p) throw new Error(`时段只能是 上午/下午/晚上（收到「${period}」）`);
  const t = String(text ?? '').trim().slice(0, MAX_TEXT_CHARS);
  if (!t) throw new Error('内容不能为空');
  if (store.entries.length >= MAX_ENTRIES) throw new Error(`日程条数已达上限（${MAX_ENTRIES} 条），先删几条`);

  const taken = new Set(store.entries.map((e) => e.id));
  const entry = {
    id: makeId(taken),
    key: String(key || '').trim(),
    date: d,
    period: p,
    text: t,
    originalText: null,
    blurred: false,
    strength: 1,
    createdAt: now,
    lastMentionedAt: 0
  };
  store.entries.push(entry);
  return entry;
}

/**
 * 改一条。
 * - 改 text ⇒ 旧文留底进 originalText、blurred=true（模糊是改写，不是删除）
 * - 改 date / period ⇒ 只是挪位置，不算糊
 * - strength ⇒ 绝对值（「加固」就是调大它）
 */
export function updateEntry(store, id, patch = {}, now = Date.now()) {
  const entry = store.entries.find((e) => e.id === String(id ?? '').trim());
  if (!entry) return null;

  let changed = false;

  if (patch.text !== undefined && patch.text !== null && String(patch.text).trim() !== '') {
    const next = String(patch.text).trim().slice(0, MAX_TEXT_CHARS);
    if (next !== entry.text) {
      // 只留**最原始**的那一份底：二次改写不会把已经糊过的版本再覆盖进去。
      if (!entry.originalText) entry.originalText = entry.text.slice(0, MAX_ORIGINAL_CHARS);
      entry.text = next;
      entry.blurred = true;
      changed = true;
    }
  }

  if (patch.date !== undefined && patch.date !== null && String(patch.date).trim() !== '') {
    const d = normalizeDate(patch.date, localDate(new Date(now)));
    if (!d) throw new Error(`认不出日期「${patch.date}」`);
    if (d !== entry.date) { entry.date = d; changed = true; }
  }

  if (patch.period !== undefined && patch.period !== null && String(patch.period).trim() !== '') {
    const p = normalizePeriod(patch.period);
    if (!p) throw new Error(`时段只能是 上午/下午/晚上（收到「${patch.period}」）`);
    if (p !== entry.period) { entry.period = p; changed = true; }
  }

  if (patch.strength !== undefined && patch.strength !== null && String(patch.strength).trim() !== '') {
    const s = Math.min(MAX_STRENGTH, Math.max(1, Math.round(Number(patch.strength) || 1)));
    if (s !== entry.strength) { entry.strength = s; changed = true; }
  }

  if (patch.blurred !== undefined && typeof patch.blurred === 'boolean') {
    if (entry.blurred !== patch.blurred) { entry.blurred = patch.blurred; changed = true; }
  }

  return { entry, changed };
}

/** 真删。返回是否删掉。 */
export function removeEntry(store, id) {
  const sid = String(id ?? '').trim();
  const idx = store.entries.findIndex((e) => e.id === sid);
  if (idx < 0) return false;
  store.entries.splice(idx, 1);
  return true;
}

const PERIOD_ORDER = (p) => {
  const i = PERIODS.indexOf(p);
  return i < 0 ? 99 : i;
};

function sortEntries(list) {
  return [...list].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.period !== b.period) return PERIOD_ORDER(a.period) - PERIOD_ORDER(b.period);
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

/**
 * 翻日程。scope 支持：
 *   today / tomorrow / week(今天到周日) / later(周日后) / past(今天之前) /
 *   upcoming(今天起) / all / 具体日期 yyyy-MM-dd
 */
export function querySchedule(store, { key = '', scope = 'today', now = new Date() } = {}) {
  const today = localDate(now instanceof Date ? now : new Date(now));
  const raw = String(scope ?? '').trim();
  const aliases = {
    今天: 'today', 今日: 'today', 明天: 'tomorrow', 明日: 'tomorrow',
    这周: 'week', 本周: 'week', 以后: 'later', 未来: 'later',
    过去: 'past', 之前: 'past', 全部: 'all', 所有: 'all', 今天起: 'upcoming'
  };
  const s = aliases[raw] || raw || 'today';

  let from;
  let to;
  let label = s;
  if (parseDate(s)) {
    from = s; to = s; label = s;
  } else if (s === 'today') {
    from = today; to = today; label = '今天';
  } else if (s === 'tomorrow') {
    from = addDays(today, 1); to = from; label = '明天';
  } else if (s === 'week') {
    from = today; to = endOfWeek(today); label = '这周';
  } else if (s === 'later') {
    from = addDays(endOfWeek(today), 1); to = '9999-12-31'; label = '以后';
  } else if (s === 'past') {
    from = '0000-01-01'; to = addDays(today, -1); label = '过去';
  } else if (s === 'upcoming') {
    from = today; to = '9999-12-31'; label = '今天起';
  } else if (s === 'all') {
    from = '0000-01-01'; to = '9999-12-31'; label = '全部';
  } else {
    throw new Error(`不认识的查询范围「${raw}」；可用 today/tomorrow/week/later/past/upcoming/all 或具体日期`);
  }

  const hit = sortEntries(
    store.entries
      .filter((e) => (key ? e.key === String(key) : true))
      .filter((e) => e.date >= from && e.date <= to)
  );
  const limited = hit.slice(0, MAX_QUERY_RESULTS);
  return { scope: label, from, to, total: hit.length, returned: limited.length, entries: limited };
}

/** 查询时更新「最后提及时间」，供角色判断哪条久未提起。 */
export function touchMentioned(store, ids, now = Date.now()) {
  const set = new Set((ids || []).map(String));
  let hit = 0;
  for (const e of store.entries) {
    if (set.has(e.id)) { e.lastMentionedAt = now; hit += 1; }
  }
  return hit;
}

/**
 * 生成每轮注入的分层文本。
 * 今天明天：逐条写清楚；本周后面：只报数量；更远：只报总数。
 */
export function formatScheduleForPrompt(store, { key = '', now = new Date() } = {}) {
  const dt = now instanceof Date ? now : new Date(now);
  const today = localDate(dt);
  const tomorrow = addDays(today, 1);
  const weekEnd = endOfWeek(today);

  const mine = (Array.isArray(store?.entries) ? store.entries : [])
    .filter((e) => e && e.date && (key ? e.key === String(key) : true));

  const todayList = sortEntries(mine.filter((e) => e.date === today));
  const tomorrowList = sortEntries(mine.filter((e) => e.date === tomorrow));

  let weekCount = 0;
  let laterCount = 0;
  for (const e of mine) {
    const diff = dayDiff(e.date, today);
    if (diff === null || diff <= 1) continue;   // 今天/明天已单独列；过去的不进注入
    if (weekEnd && e.date <= weekEnd) weekCount += 1;
    else laterCount += 1;
  }

  const lines = [];
  for (const e of todayList) lines.push(`- 今天 ${e.period}：${e.text}`);
  for (const e of tomorrowList) lines.push(`- 明天 ${e.period}：${e.text}`);
  if (weekCount > 0) lines.push(`- 这周还有 ${weekCount} 条，想知道具体就翻一下`);
  if (laterCount > 0) lines.push(`- 以后还有 ${laterCount} 条`);
  if (!lines.length) lines.push('今天和明天没有记下什么。');

  return `【他的日程】现在是 ${formatNow(dt)}\n${lines.join('\n')}`;
}

/**
 * 今天是否该提醒她结算一次（每个会话每天一次，4 点后才念）。
 * 只是提醒，不强制 —— 糊/删/加固都由她自己决定。
 */
export function shouldReviewToday(store, { key = '', now = new Date() } = {}) {
  const dt = now instanceof Date ? now : new Date(now);
  const today = localDate(dt);
  const k = String(key || '*');
  if (store?.reviewDays?.[k] === today) return false;
  if (dt.getHours() < REVIEW_START_HOUR) return false;
  return true;
}

export function markReviewed(store, { key = '', now = new Date() } = {}) {
  const dt = now instanceof Date ? now : new Date(now);
  if (!store.reviewDays || typeof store.reviewDays !== 'object') store.reviewDays = {};
  const day = localDate(dt);
  store.reviewDays[String(key || '*')] = day;
  return day;
}

/** 管理员视角：把某条被糊掉的原文翻出来（角色看不到）。 */
export function revealOriginal(store, id) {
  const entry = store.entries.find((e) => e.id === String(id ?? '').trim());
  if (!entry) return null;
  return { id: entry.id, text: entry.text, originalText: entry.originalText, blurred: entry.blurred };
}
