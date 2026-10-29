// 消息长寿存档 + 回忆检索（history / recall）。
//
// 为什么要有它：`social-v2.json` 的 recentMessages 每会话只留 200 条，超过就往前挤掉了。
// 结果是她问「上周你说的那个」时什么都想不起来——memory 只有 impression（印象），
// 没有原文。星璃那套的做法是「会话负责刚才，记忆负责以前」，而记忆表的原料是原文。
// 我们内存撑不住向量库（available 只剩 ~450MB），所以只抄「双字词重叠」那半：
// 原文按月落进 state/history/YYYY-MM.jsonl（0.2~0.4MB/天），检索时按字面匹配。
//
// 这个文件只放纯逻辑，读写文件由 bridge 负责，方便单测。

export const HISTORY_DEFAULTS = {
  enabled: true,
  months: 3,
  defaultDays: 7,
  maxDays: 90,
  maxResults: 20,
  lineChars: 200,
  scanLines: 20000,
};

function num(value, fallback, min = 0, max = 1e9) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function historyCfg(cfg) {
  const c = cfg?.socialV2?.history ?? {};
  const d = HISTORY_DEFAULTS;
  return {
    enabled: c.enabled !== false,
    months: num(c.months, d.months, 1, 24),
    defaultDays: num(c.defaultDays, d.defaultDays, 1, 90),
    maxDays: num(c.maxDays, d.maxDays, 1, 365),
    maxResults: num(c.maxResults, d.maxResults, 1, 60),
    lineChars: num(c.lineChars, d.lineChars, 40, 500),
    scanLines: num(c.scanLines, d.scanLines, 1000, 200000),
  };
}

/** 东八区月份，YYYY-MM。文件名用它。 */
export function monthOf(now) {
  const t = Number(now) || Date.now();
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 7);
}

export function archivePath(dir, month) {
  const m = String(month ?? '');
  if (!/^\d{4}-\d{2}$/.test(m)) return '';
  return `${String(dir).replace(/[\\/]+$/, '')}/${m}.jsonl`;
}

/** 从一条 recentMessages 记录压成存档行。只留检索要用的字段，别的都不进磁盘。 */
export function toRecord(key, msg, opts = {}) {
  const lineChars = Number(opts.lineChars) || HISTORY_DEFAULTS.lineChars;
  if (!msg || typeof msg !== 'object') return null;
  const text = String(msg.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const t = Number(msg.time) || Date.now();
  return {
    t,
    key: String(key ?? ''),
    who: String(msg.isSelf ? '她' : msg.isOwner ? '管理员' : msg.sender ?? '某人').slice(0, 24),
    self: msg.isSelf === true,
    owner: msg.isOwner === true,
    text: text.length <= lineChars ? text : `${text.slice(0, lineChars - 1)}…`,
  };
}

export function encodeRecord(record) {
  if (!record) return '';
  try {
    return JSON.stringify(record);
  } catch {
    return '';
  }
}

export function decodeLine(line) {
  const s = String(line ?? '').trim();
  if (!s || s[0] !== '{') return null;
  try {
    const v = JSON.parse(s);
    if (!v || typeof v !== 'object') return null;
    const t = Number(v.t);
    const text = String(v.text ?? '').trim();
    if (!Number.isFinite(t) || !text) return null;
    return {
      t,
      key: String(v.key ?? ''),
      who: String(v.who ?? '某人').slice(0, 24),
      self: v.self === true,
      owner: v.owner === true,
      text,
    };
  } catch {
    return null;
  }
}

/**
 * 中文没有空格，切成相邻两字集合再算重叠。跟星璃那边同一个做法：
 * 「检索时现算，不建倒排」——我们一天才几千条，够用。
 */
export function bigrams(text) {
  const s = String(text ?? '').replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

export function overlapScore(queryGrams, text) {
  if (!queryGrams || queryGrams.size === 0) return 0;
  const grams = bigrams(text);
  if (grams.size === 0) return 0;
  let hit = 0;
  for (const g of grams) if (queryGrams.has(g)) hit += 1;
  // 分母取「查询长度」和「正文长度」的较大者，避免长正文被稀释太狠、短正文被一句相同的两字词顶满。
  const denom = Math.max(queryGrams.size, Math.min(grams.size, queryGrams.size * 4));
  return hit / denom;
}

/**
 * 在存档记录里找「说过什么」。
 * 规则（都写死在用例里）：默认只搜近 N 天；who 过滤按人说；没有关键词就按时间倒序给最近的。
 */
export function queryArchive(records, opts = {}) {
  const cfg = { ...HISTORY_DEFAULTS, ...opts };
  const now = Number(opts.now) || Date.now();
  const days = Math.min(cfg.maxDays, num(opts.days, cfg.defaultDays, 1, cfg.maxDays));
  const since = now - days * 24 * 3600 * 1000;
  const limit = num(opts.limit, cfg.maxResults, 1, cfg.maxResults);
  const q = String(opts.text ?? '').trim();
  const who = String(opts.who ?? '').trim();
  const grams = bigrams(q);
  const list = Array.isArray(records) ? records : [];
  const scored = [];
  for (const r of list) {
    if (!r) continue;
    if (Number(r.t) < since) continue;
    if (who && !String(r.who).includes(who)) continue;
    if (opts.keyOnly && String(r.key) !== String(opts.keyOnly)) continue;
    if (opts.excludeSelf && r.self) continue;
    if (!q) {
      scored.push({ record: r, score: 0 });
      continue;
    }
    const inText = r.text.includes(q) ? 0.5 : 0; // 整串命中给个大分，比双字词更可信
    const score = inText + overlapScore(grams, r.text);
    if (score <= 0.05) continue;
    scored.push({ record: r, score });
  }
  scored.sort((a, b) => (b.score - a.score) || (b.record.t - a.record.t));
  return scored.slice(0, limit).map((x) => x.record);
}

/** 时间标签：今天/昨天/月-日 时:分，按东八区算。 */
export function stampOf(t, now) {
  const n = Number(now) || Date.now();
  const day = (x) => new Date(Number(x) + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const d = new Date(Number(t) + 8 * 3600 * 1000);
  const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const today = day(n);
  const yesterday = day(n - 24 * 3600 * 1000);
  const td = day(t);
  if (td === today) return `今天 ${hm}`;
  if (td === yesterday) return `昨天 ${hm}`;
  return `${td.slice(5)} ${hm}`;
}

/** 给她看的回忆清单。空结果也给一句话，免得她以为工具坏了。 */
export function formatRecall(records, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const list = Array.isArray(records) ? records : [];
  const q = String(opts.text ?? '').trim();
  const days = num(opts.days, HISTORY_DEFAULTS.defaultDays, 1, HISTORY_DEFAULTS.maxDays);
  if (!list.length) {
    return q ? `最近 ${days} 天里没找到和「${q}」有关的原话。` : `最近 ${days} 天里没找到原话。`;
  }
  const lines = list.map((r) => `- ${stampOf(r.t, now)} ${r.who}：${r.text}`);
  return [`【原话摘录】最近 ${days} 天：`, ...lines].join('\n');
}

/** 检索边界：给工具的 days 参数夹一下，别让它一次扫十年。 */
export function clampDays(days, cfg) {
  const maxDays = Number(cfg?.maxDays) || HISTORY_DEFAULTS.maxDays;
  const fallback = Math.min(maxDays, Number(cfg?.defaultDays) || HISTORY_DEFAULTS.defaultDays);
  // days 传 0 / 负数 / 脏值 = 「没指定」，走默认；只有正数才是真的往前翻 N 天。
  const raw = days === null || days === undefined || days === '' ? NaN : Number(days);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(maxDays, Math.max(1, Math.floor(raw)));
}
