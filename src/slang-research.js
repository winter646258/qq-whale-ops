// 黑话研究的「按需」逻辑（纯函数，可单测）。
//
// 背景：研究是全链最贵的一步 —— 一轮研究会话实测要跑 30~45 次 web_search/web_fetch，
// 180 秒必超时被丢弃（2026-10-28 记录：研究会话创建 16 次、超时 17 次，产出 0）。
// 所以研究必须有闸：
//   ① 只研究「群友真的用过 researchMinCount 次以上」的词（count=1 的碎句子不查）
//   ② 每天有配额（researchMaxPerDay），配额用完当天就不研究了
//   ③ 手动指定 ids 时才允许越过门槛（明确要查某个词），但同样吃配额

export const RESEARCH_DEFAULTS = {
  minCount: 5,
  maxPerDay: 6,
  batch: 10
};

function num(value, fallback) {
  // Number(null) === 0 的坑：没配不等于配成 0。
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function researchCfg(slang) {
  const raw = slang && typeof slang === 'object' ? slang : {};
  return {
    minCount: num(raw.researchMinCount, RESEARCH_DEFAULTS.minCount),
    maxPerDay: num(raw.researchMaxPerDay, RESEARCH_DEFAULTS.maxPerDay),
    batch: num(raw.researchBatch, RESEARCH_DEFAULTS.batch)
  };
}

export function quotaFor(state, day, maxPerDay) {
  const max = num(maxPerDay, RESEARCH_DEFAULTS.maxPerDay);
  const want = String(day ?? '');
  const days = state && typeof state === 'object' ? state : {};
  // 换天了就从 0 开始 —— 老账不删，只当它不存在。
  const used = String(days.day ?? '') === want ? Math.max(0, Math.floor(Number(days.used) || 0)) : 0;
  return { day: want, used, left: Math.max(0, max - used), max };
}

export function pickResearchCandidates({ entries, statusCandidate, ids = [], minCount = RESEARCH_DEFAULTS.minCount, limit = RESEARCH_DEFAULTS.batch, quotaLeft = Infinity } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const wantIds = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
  const min = num(minCount, RESEARCH_DEFAULTS.minCount);
  const cap = num(limit, RESEARCH_DEFAULTS.batch);
  const left = Number.isFinite(Number(quotaLeft)) ? Math.max(0, Math.floor(Number(quotaLeft))) : cap;
  if (!list.length) return { candidates: [], reason: 'empty', minCount: min };
  if (left <= 0) return { candidates: [], reason: 'quota', minCount: min };

  const isCandidate = (e) => e && (statusCandidate === undefined || e.status === statusCandidate);
  let pool;
  let explicit = false;
  if (wantIds.length) {
    // 手点名的：不看 count 门槛，但仍然要是候选状态、仍然吃配额。
    explicit = true;
    const set = new Set(wantIds);
    pool = list.filter((e) => e && set.has(String(e.id)) && isCandidate(e));
  } else {
    pool = list.filter((e) => isCandidate(e) && (Number(e.count) || 0) >= min);
  }
  if (!pool.length) return { candidates: [], reason: explicit ? 'not-found' : 'below-threshold', minCount: min };

  pool = [...pool].sort((a, b) => {
    const am = String(a.meaning ?? '').trim() ? 1 : 0;
    const bm = String(b.meaning ?? '').trim() ? 1 : 0;
    if (am !== bm) return am - bm; // 没释义的先
    return (Number(b.count) || 0) - (Number(a.count) || 0);
  });
  const take = Math.min(cap, left);
  return { candidates: pool.slice(0, take), reason: 'ok', minCount: min, explicit, total: pool.length };
}

// 一天一条日志用的摘要，避免每次扫描刷屏。
export function describePick({ reason, candidates, minCount }) {
  const n = Array.isArray(candidates) ? candidates.length : 0;
  if (reason === 'ok') return `按需研究：挑出 ${n} 条（门槛 ${minCount} 次）`;
  if (reason === 'quota') return '按需研究：今天配额用完了，跳过';
  if (reason === 'below-threshold') return `按需研究：没有达到 ${minCount} 次且缺释义的词，跳过`;
  if (reason === 'not-found') return '按需研究：指定的词条不在候选里';
  return '按需研究：没有可研究的词条';
}
