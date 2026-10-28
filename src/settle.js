// 结算层（settle）：回合收工之后，另起一个安静的小回合，把这一轮里
// 「她的情绪走向」和「对谁多了什么印象」写回库里。
//
// 为什么必须在聊天之外：
//   2026-10-25 的心脏系统方案定过一条铁律 —— 情绪/关系写入放结算，
//   绝不新增聊天中的工具调用（实测 trae 渠道缓存 0%，一次工具调用重发约 24 万 token）。
//   可「放结算」这件事一直没人实现，于是：
//     · `qq_mood` 调用次数 0     → 情绪库停在 10-24，四天没动
//     · `qq_memory_update` 0 次  → 印象只在「念提醒」，没有一次真的重写
//     · 自述 portrait.json 停在 10-23
//   三条血管断在同一个地方：写入全挂在「她聊天时主动调工具」上，而她自己不会调。
//
// 这里补上那个结算。她不需要知道，也不需要为此多调一次工具。
//
// 本文件只做纯逻辑（可单测）：判断该不该结算、拼提示词、解析并校验 JSON、给出写入计划。
// 真正的会话创建、提问、写库在 bridge.js 里。

export const SETTLE_DEFAULTS = Object.freeze({
  enabled: true,
  // 回合结束后等这么久再结算：等她收工，也给对方留一句补充的机会。
  delayMs: 45000,
  // 同一个会话两次结算之间至少隔这么久（防止一来一回就把额度烧光）。
  cooldownMs: 30 * 60 * 1000,
  // 这段时间里对方至少说了这么多条，才值得结算（她自己的话不算）。
  minMessages: 4,
  // 提示词里最多放多少条消息、多少字。
  maxMessages: 40,
  maxChars: 6000,
  // 一次最多写几条印象（写多了会把 40 字/人的标签墙冲垮）。
  maxImpressions: 3,
  timeoutMs: 120000,
  preset: ''
});

function num(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  // 别让 null 冒充 0：Number(null) === 0，会让「没配」被当成「配成 0」，
  // 于是 cooldown 变 0（每轮都结算）或上限变 0（一条都不写）。
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 读取并校正配置（socialV2.settle）。脏值一律回落默认，不抛错。 */
export function settleCfg(cfg = {}) {
  const raw = cfg?.socialV2?.settle ?? cfg?.settle ?? {};
  const d = SETTLE_DEFAULTS;
  return {
    enabled: raw.enabled !== false,
    delayMs: num(raw.delayMs, d.delayMs, { min: 5000, max: 30 * 60 * 1000 }),
    cooldownMs: num(raw.cooldownMs, d.cooldownMs, { min: 60 * 1000 }),
    minMessages: num(raw.minMessages, d.minMessages, { min: 1, max: 200 }),
    maxMessages: num(raw.maxMessages, d.maxMessages, { min: 4, max: 400 }),
    maxChars: num(raw.maxChars, d.maxChars, { min: 500, max: 40000 }),
    maxImpressions: num(raw.maxImpressions, d.maxImpressions, { min: 0, max: 10 }),
    timeoutMs: num(raw.timeoutMs, d.timeoutMs, { min: 15000, max: 600000 }),
    preset: typeof raw.preset === 'string' ? raw.preset.trim() : d.preset
  };
}

/**
 * 从会话的 recentMessages 里取出「够结算用」的一段原文。
 * 规则：丢掉空文本、丢掉别的机器人（它们不是她的人际关系素材），
 * 先按条数截尾，再按字数从头部裁掉。
 */
export function pickSettleMessages(recentMessages, opts = {}) {
  const list = Array.isArray(recentMessages) ? recentMessages : [];
  const maxMessages = num(opts.maxMessages, SETTLE_DEFAULTS.maxMessages, { min: 1 });
  const maxChars = num(opts.maxChars, SETTLE_DEFAULTS.maxChars, { min: 100 });

  const mapped = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    if (m.isBot) continue;
    const text = String(m.plain ?? m.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    mapped.push({
      who: m.isSelf ? '我' : String(m.sender ?? m.userId ?? '某人').slice(0, 30),
      text,
      self: m.isSelf === true,
      at: Number(m.time) || 0
    });
  }

  let tail = mapped.slice(-maxMessages);
  let total = tail.reduce((sum, m) => sum + m.text.length, 0);
  while (tail.length > 1 && total > maxChars) {
    total -= tail[0].text.length;
    tail = tail.slice(1);
  }
  return tail;
}

/**
 * 该不该结算。返回 {ok, reason, pending}：
 *   ok=true 表示可以结算，pending 是「上次结算之后对方说了几条」。
 */
export function shouldSettle({ key = '', st = null, now = Date.now(), cfg = {} } = {}) {
  const c = settleCfg(cfg);
  if (!c.enabled) return { ok: false, reason: 'disabled', pending: 0 };
  if (!st || typeof st !== 'object') return { ok: false, reason: 'no-state', pending: 0 };
  if (st.paused) return { ok: false, reason: 'paused', pending: 0 };

  const last = Number(st.lastSettleAt) || 0;
  if (last > 0 && now - last < c.cooldownMs) return { ok: false, reason: 'cooldown', pending: 0 };

  const messages = Array.isArray(st.recentMessages) ? st.recentMessages : [];
  const pending = messages.filter((m) => {
    if (!m || typeof m !== 'object' || m.isSelf || m.isBot) return false;
    if (!String(m.plain ?? m.text ?? '').trim()) return false;
    return (Number(m.time) || 0) > last;
  }).length;

  if (pending < c.minMessages) return { ok: false, reason: 'too-few', pending };
  return { ok: true, reason: 'ok', pending };
}

/** 拼结算提示词：只要严格 JSON，只依据给到的原文，宁可空着也不许编。 */
export function buildSettlePrompt({ key = '', isGroup = false, lines = [], impressions = [] } = {}) {
  const known = Array.isArray(impressions)
    ? impressions.filter((x) => x && x.who && String(x.text || '').trim()).slice(0, 12)
    : [];

  const said = (Array.isArray(lines) ? lines : [])
    .map((m) => `${m.self ? '我' : m.who}：${m.text}`)
    .join('\n');

  const knownBlock = known.length
    ? known.map((x) => `· ${x.who}：${x.text}`).join('\n')
    : '（还没有）';

  return [
    '你是一个只做总结的旁白，不是聊天的人。你在读一段对话原文，把「她的状态变化」和',
    '「她对某个人新认识到的东西」提取成结构化数据。',
    '',
    '铁律：',
    '1. 只依据下面的原文。原文里没有的东西一律不写，宁可留空，绝对不许想象、不许补完。',
    '2. 情绪是「她此刻的感觉」，不是你对她表现的评价；没有明显变化就写 null。',
    '3. 印象只写这一轮里**新出现或需要修正**的认识，一个人最多一条，四十字以内，',
    '   要具体（做了什么、在意什么、什么脾气），不要「人很好」「很健谈」这种空话。',
    '4. 「她已经记得的人」里有的那个人，who 必须原样抄那个名字，',
    '   不许改写成 QQ 号、手机号、或者「私聊xxx」这种别的称呼。',
    '5. 只输出一个 JSON 对象，不要解释、不要 markdown 代码块、不要多余的话。',
    '',
    '输出格式：',
    '{"mood":{"pleasure":0,"arousal":0,"dominance":0,"label":"","reason":""},"impressions":[{"who":"昵称","text":"四十字以内的新印象"}]}',
    '',
    '字段说明：',
    '· mood.pleasure / arousal / dominance 取值 -1 到 1，0 表示平静；',
    '· mood.label 是她情绪的短标签（不超过十个字，如「有点心虚」「挺高兴」）；',
    '· mood.reason 是一句话原因（不超过四十个字）；',
    '· 没有情绪变化时写 "mood": null；没有新印象时写 "impressions": []。',
    '',
    `对话场景：${isGroup ? '群聊' : '私聊'}（${key}）`,
    `她已经记得的人：`,
    knownBlock,
    '',
    '最近这段原文（「我」是她，其余是对方）：',
    said || '（空）',
    '',
    '现在只输出那个 JSON 对象。'
  ].join('\n');
}

/** 从模型输出里抠出 JSON：容忍代码块、前后废话、半角全角引号。 */
export function parseSettleJSON(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, error: '空输出' };

  let body = raw;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) body = fenced[1].trim();

  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: '没有 JSON 对象' };
  body = body.slice(start, end + 1).replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return { ok: false, error: `JSON 解析失败：${error?.message ?? error}` };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: '不是对象' };

  let mood = null;
  if (parsed.mood && typeof parsed.mood === 'object') {
    const label = String(parsed.mood.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 20);
    const reason = String(parsed.mood.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (label) {
      mood = {
        pleasure: Math.round(num(parsed.mood.pleasure, 0, { min: -1, max: 1 }) * 100) / 100,
        arousal: Math.round(num(parsed.mood.arousal, 0, { min: -1, max: 1 }) * 100) / 100,
        dominance: Math.round(num(parsed.mood.dominance, 0, { min: -1, max: 1 }) * 100) / 100,
        label,
        reason
      };
    }
  }

  const impressions = [];
  const rawList = Array.isArray(parsed.impressions) ? parsed.impressions : [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const who = String(item.who ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
    const text = String(item.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!who || !text) continue;
    if (['__proto__', 'constructor', 'prototype'].includes(who)) continue;
    if (impressions.some((x) => x.who === who)) continue;
    impressions.push({ who, text });
  }

  return { ok: true, value: { mood, impressions } };
}

/**
 * 把模型写的「who」归到已有的键上。
 *
 * 为什么需要（2026-10-28 实测）：模型会把 QQ 号当成名字写回来，
 * 于是同一个人在同一份 memberImpressions 里分身成三条 ——
 * `管理员`、`私聊 1124721191`、`1124721191`，每次结算各写一条，
 * 谁的印象都不完整。
 *
 * 规则从严到宽，只做「显然同一个人」的归一，不猜人名：
 *   1. 完全同名 → 原样用
 *   2. who 里的数字命中某个已有键（或反过来）→ 用那个键
 *      例："1124721191" → "私聊 1124721191"
 *   3. who 是某个已有键的一部分（≥2 字）→ 用那个键
 *      例："管理员" → "管理员 1124721191"
 *   4. 私聊场景且只有一个已有键 → 归到它（私聊对面只有这一个人）
 *   5. 其余当成新的人
 */
export function resolveImpressionWho({ key = '', impressions = null, who = '' } = {}) {
  const raw = String(who ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  if (['__proto__', 'constructor', 'prototype'].includes(raw)) return '';
  const entries = impressions && typeof impressions === 'object' ? impressions : {};
  const keys = Object.keys(entries);
  if (keys.length === 0) return raw;
  if (Object.prototype.hasOwnProperty.call(entries, raw)) return raw;

  const digits = (raw.match(/\d{5,12}/) || [])[0] || '';
  if (digits) {
    const hit = keys.find((k) => k.includes(digits));
    if (hit) return hit;
  }

  if (raw.length >= 2) {
    // 双向包含：模型可能给名字加后缀（"管理员大人"），也可能省掉后缀
    // （"管理员" 对 "管理员 1124721191"）。取重叠最长的那个，越长越像同一个人。
    const cands = keys.filter((k) => k.length >= 2 && (k.includes(raw) || raw.includes(k)));
    if (cands.length) {
      cands.sort((a, b) => b.length - a.length);
      return cands[0];
    }
  }

  if (String(key).startsWith('private:') && keys.length === 1) return keys[0];
  return raw;
}

/** 写入计划：把解析结果裁成「最多写几条」，方便上层直接照做。 */
export function planSettleWrites(parsed, { maxImpressions = SETTLE_DEFAULTS.maxImpressions } = {}) {
  const value = parsed && typeof parsed === 'object' ? parsed : {};
  const mood = value.mood && typeof value.mood === 'object' ? value.mood : null;
  const list = Array.isArray(value.impressions) ? value.impressions : [];
  const cap = num(maxImpressions, SETTLE_DEFAULTS.maxImpressions, { min: 0, max: 10 });
  return {
    mood,
    impressions: list.slice(0, cap),
    skippedImpressions: Math.max(0, list.length - cap)
  };
}
