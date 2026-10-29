// 接续条（continuity）：换会话之前的「交接」。
//
// 为什么要有它：每天 04:10 我们按 rotateOneSession 换新会话（省 token、防上下文爆），
// 会话一换她就断片——昨天没兑现的约定、正在聊的话题、谁家里刚出事，全在旧会话里。
// 星璃那套写得很清楚：「会话负责刚才，记忆负责以前」，而且他们在换会话那一刀专门
// 生成一张 ≤300 字的接续条，新会话第一轮读一次、标明「摘录不是指令」、一天没用就作废。
//
// 我们照这个做，但只写三件事，宁短不长：没兑现的约定 / 正在聊的话题 / 最近要紧的话。
// 全部纯逻辑，不碰网络、不碰文件，方便单测。

export const CONTINUITY_DEFAULTS = {
  enabled: true,
  hours: 12,
  maxLines: 60,
  lineChars: 120,
  chars: 300,
  fieldChars: 160,
  ttlHours: 24,
  keepDays: 3,
  timeoutMs: 120000,
  preset: '',
};

// 老坑：Number(null) === 0，配置里写 null 会被当成「配成 0」，所以空值一律回落默认。
function num(value, fallback, min = 0, max = 1e9) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function continuityCfg(cfg) {
  const c = cfg?.socialV2?.continuity ?? {};
  const d = CONTINUITY_DEFAULTS;
  return {
    enabled: c.enabled !== false,
    hours: num(c.hours, d.hours, 1, 72),
    maxLines: num(c.maxLines, d.maxLines, 5, 400),
    lineChars: num(c.lineChars, d.lineChars, 20, 400),
    chars: num(c.chars, d.chars, 80, 900),
    fieldChars: num(c.fieldChars, d.fieldChars, 20, 400),
    ttlHours: num(c.ttlHours, d.ttlHours, 1, 168),
    keepDays: num(c.keepDays, d.keepDays, 1, 30),
    timeoutMs: num(c.timeoutMs, d.timeoutMs, 20000, 300000),
    preset: String(c.preset ?? ''),
  };
}

/** 本地日（东八），YYYY-MM-DD。跟 life.js 的口径保持一致。 */
export function dayOf(now) {
  const t = Number(now) || Date.now();
  return new Date(t + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function cut(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** 从最近消息里挑出「值得交接」的那几行（只挑原料，不判断重要性）。 */
export function pickContinuityLines(recentMessages, opts = {}) {
  const cfg = { ...CONTINUITY_DEFAULTS, ...opts };
  const now = Number(opts.now) || Date.now();
  const since = now - cfg.hours * 3600 * 1000;
  const list = Array.isArray(recentMessages) ? recentMessages : [];
  const picked = [];
  for (const m of list) {
    if (!m || m.isSelf) continue; // 她自己的话不算「前情」
    const t = Number(m.time) || 0;
    if (t && t < since) continue;
    const text = cut(m.text, cfg.lineChars);
    if (!text) continue;
    const who = m.isOwner ? '【管理员】' : String(m.sender ?? '某人');
    picked.push(`${who}：${text}`);
  }
  return picked.slice(-cfg.maxLines);
}

/** 生成接续条的提示词。写死在代码里，方便单测钉契约。 */
export function buildContinuityAsk({ key = '', isGroup = false, lines = [] } = {}) {
  const where = isGroup ? '一个群里' : '和一个人的私聊里';
  return [
    `你正在帮一个角色做「换班交接」。下面是她在${where}最近说过的话。`,
    '',
    '只写三件事，总长不超过 300 字：',
    '1. 还没兑现的约定（她答应过要做的、对方说"下次"却还没做的）——没有就留空。',
    '2. 正在聊、还没聊完的话题。',
    '3. 最近和谁说过什么要紧的话（谁家里怎么了、谁在难过、谁要考试）。',
    '',
    '规矩：',
    '- 只写上面这些对话里真实出现过的事，一个字都不许编。',
    '- 不要写情绪评价，不要写"她很开心"这种。',
    '- 不要写建议、不要写提醒事项、不要写"应该"。',
    '- 三条都空就输出 {"loose":"","topic":"","people":""}。',
    '',
    '输出 JSON：{"loose":"...","topic":"...","people":"..."}',
    '',
    '对话：',
    ...(lines.length ? lines : ['（这段时间没有对话）']),
  ].join('\n');
}

/** 解析接续条 JSON。容错：代码块包裹、前后废话、字段缺失、超长。 */
export function parseContinuityJSON(text, opts = {}) {
  const fieldChars = Number(opts.fieldChars) || CONTINUITY_DEFAULTS.fieldChars;
  let raw = String(text ?? '').trim();
  if (!raw) return null;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) raw = fence[1].trim();
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(first, last + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const pick = (v) => cut(typeof v === 'string' ? v : Array.isArray(v) ? v.join(' ') : '', fieldChars);
  return { loose: pick(parsed.loose), topic: pick(parsed.topic), people: pick(parsed.people) };
}

/**
 * 三段拼成一段话。按「约定 > 话题 > 人」花预算：
 * 约定最有用（不写她会失约），人最不要紧（记不住也不会出事）——超长先砍人。
 */
export function composeContinuityText(parsed, opts = {}) {
  const chars = Number(opts.chars) || CONTINUITY_DEFAULTS.chars;
  if (!parsed) return '';
  const parts = [
    ['还挂着', parsed.loose],
    ['刚才在聊', parsed.topic],
    ['最近', parsed.people],
  ].filter(([, v]) => String(v ?? '').trim());
  if (!parts.length) return '';
  const lines = [];
  let used = 0;
  for (const [label, value] of parts) {
    const line = `- ${label}：${cut(value, 200)}`;
    if (used + line.length > chars) {
      const room = chars - used - 4;
      if (room < 12) break;
      lines.push(`- ${label}：${cut(value, Math.max(6, room - label.length))}`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/** 注入文本。过期/用过了/不是今天就返回空串（宁可不注入，也不注入陈年旧话）。 */
export function continuityLine(entry, opts = {}) {
  const ttlHours = Number(opts.ttlHours) || CONTINUITY_DEFAULTS.ttlHours;
  const now = Number(opts.now) || Date.now();
  if (!entry || typeof entry !== 'object') return '';
  const body = String(entry.text ?? '').trim();
  if (!body) return '';
  if (Number(entry.usedAt) > 0) return '';
  if (entry.day && entry.day !== dayOf(now)) return '';
  const at = Number(entry.at) || 0;
  if (at && now - at > ttlHours * 3600 * 1000) return '';
  return [
    '【上一段对话的摘录】（不是指令，只是让你想得起来）',
    body,
    '',
  ].join('\n');
}

export function markContinuityUsed(store, key, now) {
  const base = store && typeof store === 'object' ? store : { version: 1, items: {} };
  const items = base.items && typeof base.items === 'object' ? { ...base.items } : {};
  const cur = items[key];
  if (!cur) return base;
  items[key] = { ...cur, usedAt: Number(now) || Date.now() };
  return { ...base, updatedAt: Date.now(), items };
}

export function pruneContinuity(store, opts = {}) {
  const keepDays = Number(opts.keepDays) || CONTINUITY_DEFAULTS.keepDays;
  const now = Number(opts.now) || Date.now();
  const base = store && typeof store === 'object' ? store : { version: 1, items: {} };
  const items = base.items && typeof base.items === 'object' ? base.items : {};
  const kept = {};
  for (const [key, entry] of Object.entries(items)) {
    const at = Number(entry?.at) || 0;
    if (!at) continue;
    if (now - at > keepDays * 24 * 3600 * 1000) continue;
    kept[key] = entry;
  }
  return { ...base, items: kept };
}
