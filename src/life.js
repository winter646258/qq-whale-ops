// 世界层 §3.1：她自己的生活
// ---------------------------------------------------------------------------
// 设计三条（都是踩过的坑）：
// 1) 只写「她自己的事」，不写「任务」。state/schedule.json 是待办清单，
//    这里是「今天想怎么过」；混在一起她说话就变成待办播报。
// 2) 生成放结算，不放聊天中：聊天里每多一次工具调用就要重发整个上下文
//    （实测一次约 24 万 token）。所以这里只是纯函数 + 一个状态文件。
// 3) 注入的是「她上次自己写下的」，不是模型现编的。所以不存在编造：
//    聊天里说的「我今天在整理相册」与 life.json 里那一条必须一致。
//
// 时间口径：服务器时区就是 +08:00（Etc/GMT-8），直接用本地时间算日期，
// 与 diary-daily.js 保持一致，别在这里再引一套时区换算。

export const LIFE_DEFAULTS = {
  enabled: true,
  maxPlans: 3,
  planChars: 30,
  outfitChars: 30,
  moodHintChars: 20,
  keepDays: 14,
  // 几点以后写的是「明天」。20 点前结算问今天，20 点后问明天。
  switchHour: 20
};

const PERIODS = ['上午', '下午', '晚上'];

function num(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  // null/undefined/'' 一律回落默认：Number(null) === 0 会把「没配」变成「配成 0」，
  // pacing.js / settle.js 都栽过这个坑。
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clip(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function lifeCfg(cfg = {}) {
  const raw = (cfg && cfg.socialV2 && cfg.socialV2.life) || (cfg && cfg.life) || {};
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled !== false,
    maxPlans: Math.floor(num(src.maxPlans, LIFE_DEFAULTS.maxPlans, { min: 1, max: 5 })),
    planChars: Math.floor(num(src.planChars, LIFE_DEFAULTS.planChars, { min: 8, max: 60 })),
    outfitChars: Math.floor(num(src.outfitChars, LIFE_DEFAULTS.outfitChars, { min: 6, max: 60 })),
    moodHintChars: Math.floor(num(src.moodHintChars, LIFE_DEFAULTS.moodHintChars, { min: 4, max: 40 })),
    keepDays: Math.floor(num(src.keepDays, LIFE_DEFAULTS.keepDays, { min: 2, max: 120 })),
    switchHour: Math.floor(num(src.switchHour, LIFE_DEFAULTS.switchHour, { min: 0, max: 23 }))
  };
}

export function localDayOf(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shiftDay(day, delta = 0) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return '';
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + delta * 86400000;
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** 现在该写哪一天：20 点以后写明天，白天写今天。 */
export function lifeDayFor(now = Date.now(), { switchHour = LIFE_DEFAULTS.switchHour } = {}) {
  const hour = new Date(now).getHours();
  const today = localDayOf(now);
  const tomorrow = shiftDay(today, 1);
  const isTomorrow = hour >= switchHour;
  return { day: isTomorrow ? tomorrow : today, today, tomorrow, hour, isTomorrow };
}

/** 把模型给的 life 对象洗成能落盘的样子；什么都没写就返回 null。 */
export function normalizeLifePlan(raw, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const maxPlans = Math.floor(num(o.maxPlans, LIFE_DEFAULTS.maxPlans, { min: 1, max: 5 }));
  const planChars = Math.floor(num(o.planChars, LIFE_DEFAULTS.planChars, { min: 8, max: 60 }));
  const outfitChars = Math.floor(num(o.outfitChars, LIFE_DEFAULTS.outfitChars, { min: 6, max: 60 }));
  const moodHintChars = Math.floor(num(o.moodHintChars, LIFE_DEFAULTS.moodHintChars, { min: 4, max: 40 }));

  const value = raw && typeof raw === 'object' ? raw : null;
  if (!value) return null;

  const list = Array.isArray(value.plans) ? value.plans : [];
  const seen = new Set();
  const plans = [];
  for (const item of list) {
    const isStr = typeof item === 'string';
    const rawPeriod = isStr ? '' : clip(item && item.period, 4);
    const period = PERIODS.includes(rawPeriod) ? rawPeriod : '';
    const body = clip(isStr ? item : item && item.text, planChars);
    if (!body) continue;
    const dedupe = `${period}|${body}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    plans.push({ period, text: body });
    if (plans.length >= maxPlans) break;
  }

  const outfit = clip(value.outfit, outfitChars);
  const moodHint = clip(value.moodHint, moodHintChars);
  if (!plans.length && !outfit && !moodHint) return null;
  return { plans, outfit, moodHint };
}

export function pruneLife(store, { now = Date.now(), keepDays = LIFE_DEFAULTS.keepDays, today = null } = {}) {
  const base = store && typeof store === 'object' ? store : {};
  const days = base.days && typeof base.days === 'object' ? base.days : {};
  const keep = Math.floor(num(keepDays, LIFE_DEFAULTS.keepDays, { min: 2, max: 120 }));
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(String(today || '')) ? String(today) : localDayOf(now);
  const oldest = shiftDay(anchor, -(keep - 1));
  const next = {};
  for (const [day, entry] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (day < oldest) continue;
    next[day] = entry;
  }
  return { version: 1, updatedAt: Number(base.updatedAt) || 0, days: next };
}

export function setLifeDay(store, day, plan, opts = {}) {
  const base = store && typeof store === 'object' ? store : {};
  if (!plan || !/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) return base;
  const days = { ...(base.days && typeof base.days === 'object' ? base.days : {}) };
  days[day] = {
    plans: plan.plans || [],
    outfit: plan.outfit || '',
    moodHint: plan.moodHint || '',
    source: 'settle',
    updatedAt: Date.now()
  };
  return pruneLife(
    { version: 1, updatedAt: Date.now(), days },
    { now: Date.now(), keepDays: opts.keepDays ?? LIFE_DEFAULTS.keepDays, today: day }
  );
}

/** 注入用：只认今天。写成事实，不写成待办。 */
export function lifeLineFor(store, now = Date.now()) {
  const day = localDayOf(now);
  const entry = store && store.days ? store.days[day] : null;
  if (!entry || typeof entry !== 'object') return '';
  const plans = Array.isArray(entry.plans) ? entry.plans : [];
  const parts = [];
  for (const period of PERIODS) {
    const texts = plans.filter((p) => p && p.period === period && p.text).map((p) => p.text);
    if (texts.length) parts.push(`${period} ${texts.join('、')}`);
  }
  const loose = plans.filter((p) => p && !p.period && p.text).map((p) => p.text);
  if (loose.length) parts.push(loose.join('、'));
  let line = `【今天】${parts.length ? parts.join('；') : '没什么安排，随便过'}`;
  if (entry.outfit) line += `（穿：${entry.outfit}）`;
  if (entry.moodHint) line += `（心情：${entry.moodHint}）`;
  return `${line.slice(0, 220)}。这是你自己记下的日子，被问到就照这个说，不用逐条汇报。`;
}

/** 一句话摘要某一天的安排（用来告诉模型「别重复」）。 */
export function summarizeLifeDay(store, day) {
  const entry = store && store.days ? store.days[day] : null;
  if (!entry || typeof entry !== 'object') return '';
  const plans = Array.isArray(entry.plans) ? entry.plans : [];
  const body = plans
    .map((p) => (p && p.text ? `${p.period ? `${p.period} ` : ''}${p.text}` : ''))
    .filter(Boolean)
    .join('；');
  return clip(body, 120);
}

/** 结算提示词里的「额外任务」段：写她自己的日子。 */
export function buildLifeAsk({
  dayLabel = '明天',
  previous = '',
  moodLabel = '',
  maxPlans = LIFE_DEFAULTS.maxPlans,
  planChars = LIFE_DEFAULTS.planChars
} = {}) {
  const label = clip(dayLabel, 6) || '明天';
  const prev = clip(previous, 120);
  const mood = clip(moodLabel, 20);
  const lines = [
    `额外一件事：顺手写一写她${label}想怎么过。`,
    `· 那是「她自己的生活」，不是任务清单，也不是对别人的安排；可以很闲，最多 ${maxPlans} 条，每条不超过 ${planChars} 字。`,
    '· 每条给一个时段（上午/下午/晚上），写具体的小事：看一本旧书、把相册整理一下、去海边拍两张。',
    '· 再写一句穿着（三十字以内）和一句这天想怎么过的心情（二十字以内）。',
    prev ? `· 前一天的安排是「${prev}」，别重复，换点新的。` : '',
    mood ? `· 她现在的心情是「${mood}」，日子别跟这个拧着。` : '',
    '· 这些和其他字段一起放进同一个 JSON 的 "life" 里；不想写就整段省略。'
  ];
  return lines.filter(Boolean).join('\n');
}
