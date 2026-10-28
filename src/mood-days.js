// 世界层 §3.3：连续心情（心情编年史）
// ---------------------------------------------------------------------------
// 现状：情绪.json 里已经有 pad（此刻）、baseline（底色，按采样日结算）、samples。
// 缺的只是「跨天的那一条」——每天记一格，才能看出「这周她一直有点低」。
//
// 两条原则：
// 1) 趋势由代码算，不让模型自由发挥。模型只会把「今天开心」说成「心花怒放」，
//    而我们要的是「比昨天舒展一点」这种可核对的结论。
// 2) 一天一条，当天重复结算就覆盖。别做成流水账，否则注入里塞不进去。

import { localDayOf, shiftDay } from './life.js';

export const MOOD_DAYS_DEFAULTS = {
  enabled: true,
  keepDays: 30,
  // 判定「变好/变坏」的阈值（PAD 的 pleasure 维度）。小于它就是「差不多」。
  shiftGap: 0.12
};

function num(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clip(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function padOf(pad) {
  const src = pad && typeof pad === 'object' ? pad : {};
  return {
    pleasure: num(src.pleasure, 0, { min: -1, max: 1 }),
    arousal: num(src.arousal, 0, { min: -1, max: 1 }),
    dominance: num(src.dominance, 0, { min: -1, max: 1 })
  };
}

export function moodDaysCfg(cfg = {}) {
  const raw = (cfg && cfg.socialV2 && cfg.socialV2.moodDays) || (cfg && cfg.moodDays) || {};
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled !== false,
    keepDays: Math.floor(num(src.keepDays, MOOD_DAYS_DEFAULTS.keepDays, { min: 3, max: 365 })),
    shiftGap: num(src.shiftGap, MOOD_DAYS_DEFAULTS.shiftGap, { min: 0.02, max: 0.6 })
  };
}

/** 记一天。同一天重复结算就覆盖，不追加。 */
export function recordMoodDay(store, { now = Date.now(), label = '', pad = null, samples = 0 } = {}) {
  const base = store && typeof store === 'object' ? store : {};
  const days = base.days && typeof base.days === 'object' ? { ...base.days } : {};
  const day = localDayOf(now);
  days[day] = {
    label: clip(label, 20),
    pad: padOf(pad),
    samples: Math.max(0, Math.floor(num(samples, 0, { min: 0, max: 500 }))),
    at: now
  };
  return { version: 1, updatedAt: now, days };
}

export function pruneMoodDays(store, { now = Date.now(), keepDays = MOOD_DAYS_DEFAULTS.keepDays } = {}) {
  const base = store && typeof store === 'object' ? store : {};
  const days = base.days && typeof base.days === 'object' ? base.days : {};
  const keep = Math.floor(num(keepDays, MOOD_DAYS_DEFAULTS.keepDays, { min: 3, max: 365 }));
  const oldest = shiftDay(localDayOf(now), -(keep - 1));
  const next = {};
  for (const [day, entry] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (day < oldest) continue;
    next[day] = entry;
  }
  return { version: 1, updatedAt: Number(base.updatedAt) || 0, days: next };
}

/** 最近几天（不含今天）的 pleasure 均值。 */
function previousAverage(days, today, span = 3) {
  const keys = Object.keys(days)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < today)
    .sort()
    .slice(-span);
  if (!keys.length) return { avg: null, keys };
  let sum = 0;
  let n = 0;
  for (const k of keys) {
    const p = days[k] && days[k].pad ? days[k].pad.pleasure : null;
    if (typeof p === 'number' && Number.isFinite(p)) {
      sum += p;
      n += 1;
    }
  }
  return { avg: n ? sum / n : null, keys };
}

/**
 * 注入用的一句话趋势。没有今天的数据就返回 ''（还没结算过，不硬编）。
 * 只比 pleasure 一维：另外两维（唤醒度/掌控感）对「这两天怎么样」这种说法没有帮助。
 */
export function moodTrendLine(store, { now = Date.now(), shiftGap = MOOD_DAYS_DEFAULTS.shiftGap } = {}) {
  const base = store && typeof store === 'object' ? store : {};
  const days = base.days && typeof base.days === 'object' ? base.days : {};
  const today = localDayOf(now);
  const cur = days[today];
  if (!cur || typeof cur !== 'object') return '';
  const prev = previousAverage(days, today);
  if (prev.avg === null) {
    return cur.label ? `【最近心情】今天「${clip(cur.label, 20)}」。` : '';
  }
  const gap = num(shiftGap, MOOD_DAYS_DEFAULTS.shiftGap, { min: 0.02, max: 0.6 });
  const diff = (cur.pad ? cur.pad.pleasure : 0) - prev.avg;
  const lastKey = prev.keys[prev.keys.length - 1] || '';
  const lastLabel = lastKey && days[lastKey] ? clip(days[lastKey].label, 20) : '';
  let verdict;
  if (diff >= gap) verdict = '今天比前几天舒展一点';
  else if (diff <= -gap) verdict = '今天比前几天沉一点';
  else verdict = '跟这几天差不多';
  const head = lastLabel ? `前几天是「${lastLabel}」，` : '';
  return `【最近心情】${head}${verdict}。`;
}
