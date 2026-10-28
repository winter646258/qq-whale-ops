// MARKER: topics —— 「今天可以聊的」：她自己的谈资，不是新闻播报。
//
// 设计（为什么这样而不是别的做法）：
// 1) 不加聊天中的工具调用。一次工具调用要把整个上下文重发一遍（实测约 24 万 token），
//    所以谈资只在「后台定时」里生成，聊天时只读缓存。
// 2) 不联网。每天两次 web_search 的代价比生成本身还大（研究会话实测 44 次检索、
//    且超时率 100%），所以这里只从她自己的知识里挑，prompt 里明确「不要联网、不要编具体数字」。
// 3) 只留标题 + 两句话。注入进提示词的东西越长越贵，也越容易变成「播报」。
// 4) 只在主动开口时注入。被动回话时塞谈资，她会答得前言不搭后语。

export const TOPICS_DEFAULTS = {
  enabled: true,
  slots: [10, 16],        // 每天几点各挑一次（小时，24 小时制）
  graceHours: 2,          // 到点后多久之内还算「该挑」（过了就算了，不在晚上补一次）
  keepDays: 3,
  maxItems: 20,
  maxInject: 2,
  titleChars: 24,
  summaryChars: 60,
  askChars: 400,
};

function num(v, d, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  // Number(null) === 0 的坑：配置里没写不能等于写成 0。
  if (v === null || v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function topicsCfg(cfg) {
  const raw = cfg?.socialV2?.topics;
  const src = raw && typeof raw === 'object' ? raw : {};
  const slots = Array.isArray(src.slots)
    ? [...new Set(src.slots.map((h) => {
      // Number(null) === 0，写成 null 会被当成「0 点」；这里先把空值挡掉。
      if (h === null || h === undefined || h === '') return -1;
      const n = Number(h);
      // 越界的点直接丢掉，不要夹到 23 点（99 点不是「23 点」）。
      return Number.isInteger(n) && n >= 0 && n <= 23 ? n : -1;
    }).filter((h) => h >= 0))].sort((a, b) => a - b)
    : TOPICS_DEFAULTS.slots;
  return {
    enabled: src.enabled !== false,
    slots: slots.length ? slots : TOPICS_DEFAULTS.slots,
    graceHours: num(src.graceHours, TOPICS_DEFAULTS.graceHours, { min: 1, max: 12 }),
    keepDays: num(src.keepDays, TOPICS_DEFAULTS.keepDays, { min: 1, max: 30 }),
    maxItems: num(src.maxItems, TOPICS_DEFAULTS.maxItems, { min: 1, max: 200 }),
    maxInject: num(src.maxInject, TOPICS_DEFAULTS.maxInject, { min: 0, max: 5 }),
    titleChars: num(src.titleChars, TOPICS_DEFAULTS.titleChars, { min: 4, max: 80 }),
    summaryChars: num(src.summaryChars, TOPICS_DEFAULTS.summaryChars, { min: 10, max: 200 }),
    askChars: num(src.askChars, TOPICS_DEFAULTS.askChars, { min: 80, max: 1200 }),
  };
}

export function localDayOf(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function cleanText(v, max) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}

export function normalizeTopic(raw, opts = {}) {
  const cfg = { ...TOPICS_DEFAULTS, ...opts };
  if (!raw || typeof raw !== 'object') return null;
  const title = cleanText(raw.title ?? raw.topic ?? raw.name, cfg.titleChars);
  const summary = cleanText(raw.summary ?? raw.text ?? raw.note, cfg.summaryChars);
  if (!title) return null;
  return {
    title,
    summary,
    kind: cleanText(raw.kind, 12) || '自己想的',
    at: Number(raw.at) > 0 ? Number(raw.at) : Date.now(),
  };
}

export function addTopics(store, list, { now = Date.now(), cfg = TOPICS_DEFAULTS } = {}) {
  const next = { ...(store || {}) };
  const items = Array.isArray(next.items) ? [...next.items] : [];
  let added = 0;
  for (const raw of Array.isArray(list) ? list : []) {
    const t = normalizeTopic(raw, cfg);
    if (!t) continue;
    if (items.some((x) => x.title === t.title)) continue;
    items.unshift({ ...t, at: now });
    added += 1;
  }
  items.sort((a, b) => b.at - a.at);
  next.items = items.slice(0, cfg.maxItems ?? TOPICS_DEFAULTS.maxItems);
  next.updatedAt = now;
  return { store: next, added };
}

export function pruneTopics(store, { now = Date.now(), cfg = TOPICS_DEFAULTS } = {}) {
  const keep = Math.max(1, cfg.keepDays ?? TOPICS_DEFAULTS.keepDays) * 86400000;
  const next = { ...(store || {}) };
  next.items = (Array.isArray(next.items) ? next.items : []).filter((x) => x && now - Number(x.at) < keep);
  return next;
}

// 谈资一天两次就够。这里只判「这个点该不该挑」，不负责真的去问模型。
export function dueTopicSlot(store, { now = Date.now(), cfg = TOPICS_DEFAULTS } = {}) {
  if (!cfg.enabled) return null;
  const day = localDayOf(now);
  const hour = new Date(now).getHours();
  const slots = Array.isArray(cfg.slots) ? cfg.slots : TOPICS_DEFAULTS.slots;
  const done = (store?.days && store.days[day]) || {};
  // 只在「到点后 2 小时之内」算数：错过 10 点就别在 15 点补一次，
  // 否则 15:00 补的 10 点档会和 16:00 那档挤在一起，一天挑两条一样的。
  const grace = Math.max(1, cfg.graceHours ?? TOPICS_DEFAULTS.graceHours);
  const passed = slots.filter((h) => hour >= h && hour - h < grace);
  if (!passed.length) return null;
  const slot = passed[passed.length - 1];
  if (done[slot]) return null;
  return { day, slot, hour };
}

export function markTopicSlot(store, { day, slot, now = Date.now() } = {}) {
  const next = { ...(store || {}) };
  if (!next.days || typeof next.days !== 'object') next.days = {};
  if (!next.days[day] || typeof next.days[day] !== 'object') next.days[day] = {};
  next.days[day][slot] = now;
  // 只留最近三天的记账，别让它长成一本书。
  const keep = Object.keys(next.days).sort().slice(-3);
  next.days = Object.fromEntries(keep.map((d) => [d, next.days[d]]));
  return next;
}

export function topicsLine(store, { now = Date.now(), cfg = TOPICS_DEFAULTS, isProactive = false } = {}) {
  if (!isProactive) return '';        // 被动回话不塞谈资
  const maxInject = cfg.maxInject ?? TOPICS_DEFAULTS.maxInject;
  if (maxInject <= 0) return '';
  const keep = Math.max(1, cfg.keepDays ?? TOPICS_DEFAULTS.keepDays) * 86400000;
  const items = (Array.isArray(store?.items) ? store.items : [])
    .filter((x) => x && x.title && now - Number(x.at) < keep)
    .slice(0, maxInject);
  if (!items.length) return '';
  const body = items.map((x) => (x.summary ? `${x.title}——${x.summary}` : x.title)).join('；');
  return `【今天可以聊的】${body}。想聊就聊，不想聊不用硬提。`;
}

export function summarizeTopics(store, { now = Date.now(), cfg = TOPICS_DEFAULTS } = {}) {
  const keep = Math.max(1, cfg.keepDays ?? TOPICS_DEFAULTS.keepDays) * 86400000;
  const items = (Array.isArray(store?.items) ? store.items : []).filter((x) => x && now - Number(x.at) < keep);
  if (!items.length) return '';
  return items.slice(0, 3).map((x) => x.title).join('、').slice(0, 120);
}

export function buildTopicAsk({ hour = 10, recent = '', cfg = TOPICS_DEFAULTS } = {}) {
  const lines = [];
  lines.push('（这是一次后台任务，不要在聊天里回复这段。）');
  lines.push(`现在是${hour < 12 ? '上午' : '下午'}。挑一件你自己最近想聊的事，作为今天的谈资。`);
  if (recent) lines.push(`这些是前两天的，别再挑重复的：${recent}。`);
  lines.push('要求：');
  lines.push('- 不联网，就凭你自己的见闻和兴趣挑；别报具体数字、日期、人名这类你没法核实的东西。');
  lines.push(`- 标题 ${cfg.titleChars} 字以内，说清是什么；再用一句话写你会怎么开口（${cfg.summaryChars} 字以内）。`);
  lines.push('- 别写新闻播报，也别写「今天我们来聊聊」这种主持人腔。');
  lines.push('');
  lines.push('只输出一个 JSON 对象，不要任何解释：');
  lines.push('{"title":"…","summary":"…"}');
  return lines.join('\n').slice(0, cfg.askChars ?? TOPICS_DEFAULTS.askChars);
}

export function parseTopicJSON(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  const body = start >= 0 && end > start ? fenced.slice(start, end + 1) : fenced;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return normalizeTopic(parsed);
  } catch {
    return null;
  }
}
