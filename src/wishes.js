// 共同愿望清单（世界层 B · §3.5）
//
// 为什么要有：她记得「等有空一起看那部电影」，过几天能自己翻出来说一句；
// 这让对话有「一直没做完的事」，而不是每轮都从零开场。
//
// 三条设计决定：
//   1. 只在「聊到相关话题」时才可能出现 —— 注入是一条清单事实，不是每日播报任务。
//   2. 上限 30 条、注入最多 3 条，且**老的优先**：新加的总会记得，快要被忘的才需要捞。
//   3. `done` 只能由结算或她自己标记，代码不猜「看完了」。
//
// 复用 `threads.js` 的几个小工具口味（num / cleanText 各写一份，模块之间不互相 import
// 私有函数，避免一个模块的改动把另一个弄坏）。

import { withScope, filterByScope } from './scoped-store.js';

export const WISHES_DEFAULTS = {
  enabled: true,
  maxItems: 30,
  maxInject: 3,
  textChars: 40,
  keepDoneDays: 30
};

export const WISH_KINDS = ['movie', 'game', 'trip', 'thing'];

function num(value, fallback, { min = -Infinity, max = Infinity, int = true } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = int ? Math.floor(n) : n;
  return Math.min(max, Math.max(min, v));
}

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function wishesCfg(cfg) {
  const w = cfg?.socialV2?.wishes ?? cfg?.wishes ?? {};
  const d = WISHES_DEFAULTS;
  return {
    enabled: w.enabled !== false,
    maxItems: num(w.maxItems, d.maxItems, { min: 1, max: 200 }),
    maxInject: num(w.maxInject, d.maxInject, { min: 0, max: 9 }),
    textChars: num(w.textChars, d.textChars, { min: 4, max: 120 }),
    keepDoneDays: num(w.keepDoneDays, d.keepDoneDays, { min: 1, max: 365 })
  };
}

/** 洗一条愿望；不合格返回 null。 */
export function normalizeWish(raw, { now = Date.now(), addedBy = '她', cfg = WISHES_DEFAULTS } = {}) {
  const c = { ...WISHES_DEFAULTS, ...(cfg || {}) };
  const text = cleanText(raw?.text ?? (typeof raw === 'string' ? raw : ''), c.textChars);
  if (!text) return null;
  if (['__proto__', 'constructor', 'prototype'].includes(text)) return null;
  const kind = WISH_KINDS.includes(String(raw?.kind ?? '').trim()) ? String(raw.kind).trim() : 'thing';
  const by = ['她', '主人'].includes(String(raw?.addedBy ?? '').trim()) ? String(raw.addedBy).trim() : addedBy;
  return { id: '', text, kind, addedBy: by, done: false, addedAt: now, doneAt: 0 };
}

/**
 * 并入一批愿望：同 text 去重（已存在的保持原样，不重置 done）。
 *
 * 满了怎么办（`maxItems` 30）：先把**已完成最久**的那条腾出来；
 * 一条已完成的都没有就**不再加**，把新的记成 skipped。
 * 不按「最老/最新」硬挤 —— 清单的意义就是那些一直没做成的旧愿望，
 * 静悄悄丢掉它比加不进去更糟。
 */
export function addWishes(store, { items = [], now = Date.now(), addedBy = '她', cfg = WISHES_DEFAULTS, key = '' } = {}) {
  const c = { ...WISHES_DEFAULTS, ...(cfg || {}) };
  const base = store && typeof store === 'object' ? store : {};
  const list = Array.isArray(base.items) ? base.items.map((x) => ({ ...x })) : [];
  let added = 0;
  let skipped = 0;
  for (const raw of Array.isArray(items) ? items : []) {
    const item = normalizeWish(raw, { now, addedBy, cfg: c });
    if (!item) continue;
    if (list.some((x) => x && x.text === item.text)) {
      skipped += 1;
      continue;
    }
    if (list.length >= c.maxItems) {
      let victim = -1;
      for (let i = 0; i < list.length; i += 1) {
        if (!list[i]?.done) continue;
        if (victim < 0 || Number(list[i].doneAt || 0) < Number(list[victim].doneAt || 0)) victim = i;
      }
      if (victim < 0) {
        skipped += 1;
        continue;
      }
      list.splice(victim, 1);
    }
    item.id = `w${now.toString(36).slice(-5)}${(list.length + 1).toString(36)}`;
    list.push(withScope(item, key));   // 记下是谁那儿聊出来的，注入时按会话过滤
    added += 1;
  }
  return { store: { ...base, version: 1, items: list }, added, skipped };
}

/** 未完成的愿望，老的优先（快要被忘的才需要捞）。 */
export function openWishes(store, { limit = WISHES_DEFAULTS.maxInject, key = '' } = {}) {
  const list = filterByScope(store && Array.isArray(store.items) ? store.items : [], key);
  return list
    .filter((x) => x && !x.done)
    .sort((a, b) => Number(a.addedAt || 0) - Number(b.addedAt || 0))
    .slice(0, Math.max(0, limit));
}

/** 标记完成（按 text 或 id；模型只会复述文字）。 */
export function completeWishes(store, { texts = [], now = Date.now(), cfg = WISHES_DEFAULTS } = {}) {
  const c = { ...WISHES_DEFAULTS, ...(cfg || {}) };
  const base = store && typeof store === 'object' ? store : {};
  const want = new Set((Array.isArray(texts) ? texts : [texts]).map((x) => cleanText(x, c.textChars)).filter(Boolean));
  if (!want.size) return { store: base, done: 0 };
  let done = 0;
  const items = (Array.isArray(base.items) ? base.items : []).map((x) => {
    if (!x || x.done) return x;
    if (!want.has(String(x.text ?? '')) && !want.has(String(x.id ?? ''))) return x;
    done += 1;
    return { ...x, done: true, doneAt: now };
  });
  return { store: { ...base, version: 1, items }, done };
}

/** 已完成的留 keepDoneDays，之后清掉。 */
export function pruneWishes(store, { now = Date.now(), cfg = WISHES_DEFAULTS } = {}) {
  const c = { ...WISHES_DEFAULTS, ...(cfg || {}) };
  const base = store && typeof store === 'object' ? store : {};
  const keepMs = c.keepDoneDays * 24 * 3600 * 1000;
  const items = (Array.isArray(base.items) ? base.items : []).filter(
    (x) => x && (!x.done || now - Number(x.doneAt || now) < keepMs)
  );
  return { ...base, version: 1, items };
}

/** 注入行：最多 3 条，明说「聊到才提」。 */
export function wishesLine(store, { cfg = WISHES_DEFAULTS, key = '' } = {}) {
  const c = { ...WISHES_DEFAULTS, ...(cfg || {}) };
  if (!c.enabled || c.maxInject <= 0) return '';
  const list = openWishes(store, { limit: c.maxInject, key });
  if (!list.length) return '';
  const parts = list.map((x) => x.text);
  return `【一起想做还没做的】${parts.join('；')}。聊到相关的再接，不用故意提起。`;
}

/** 结算提示词里的额外任务段。 */
export function buildWishesAsk({ maxItems = 3 } = {}) {
  return [
    '你们聊到「想看/想玩/想去/想要」的事，记进愿望清单：',
    `- 最多 ${maxItems} 条，`,
    '  每条写成 `{"text":"一起看那部海边纪录片","kind":"movie"}`，`kind` 只能是 movie / game / trip / thing。',
    '- 只记真的说定了的事，随口一提不算；已经在清单里的不要重复记。',
    '- 如果这次已经把某件做完了（看完了/去过了），把它的原文放进 `done`。'
  ].join('\n');
}

export function summarizeWishes(store, { limit = 3 } = {}) {
  const list = openWishes(store, { limit });
  if (!list.length) return '（没有）';
  return list.map((x) => `- ${x.text}`).join('\n');
}
