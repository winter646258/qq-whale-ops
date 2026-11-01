// 三态注意力的影子观测层（shadow）。
//
// 只回答一个问题：如果开了 focused 门，会发生什么？
// 因此这里**一个调度决策都不做** —— 不建定时器、不清队列、不改 reason、不动意愿门。
// bridge 只在入站与她自己发言两处各调一次，把「候选状态 + 如果真开门会怎么处置」记下来。
//
// 为什么单开一层而不塞进 pacing.js：
//   pacing 的 rhythmOf 是**行为参数**（说话快慢），shadow 要的是**事件级样本**
//   （每条软消息落到哪一档、会不会被抑制、响应延迟多少）。混在一起的话，
//   统计口径会被 rhythm 的兜底分支污染，也算不出 bootstrap 需要的延迟分布。
//
// 三条纪律（照 codex 判据）：
//   1) 记录必须有界：一天最多 maxEventsPerDay 条，超出只累加计数，绝不无限长。
//   2) 摘要只留计数/首尾/最多 maxPendingSenders 个 sender，不存完整消息。
//   3) 判据写死在代码里：|B|<30 或 |A|<100 一律判「样本不足」，不靠人眼看日志。

export const SHADOW_VERSION = 1;

export const SHADOW_DEFAULTS = {
  enabled: true,
  /** 一天最多留多少条事件（超出只累加计数）。 */
  maxEventsPerDay: 3000,
  /** 假想 pending 摘要里最多留几个 sender。 */
  maxPendingSenders: 6,
  /** 摘要保留头部几条。 */
  pendingKeepHead: 2,
  /** 摘要保留尾部几条。 */
  pendingKeepTail: 2,
  /** bootstrap 重采样次数。 */
  bootstrapIterations: 1000,
  /** bootstrap 固定种子 —— 同一天重跑必须给同样的区间。 */
  bootstrapSeed: 20261101,
  /** 延迟回填的最长等待（超过就记成 dropped，不算进分布）。 */
  latencyMaxMs: 30 * 60 * 1000,
  /** 判据：|B| 低于它判样本不足。 */
  minB: 30,
  /** 判据：|A| 低于它判样本不足。 */
  minA: 100,
};

/** 软触发：这些 reason 代表「她自己想插话 / 泛泛被提到」，不是有人明确要她。 */
const SOFT_REASONS = new Set([
  'willingness',
  'probability',
  'anyMessage',
  'replyCheck',
  'keyword',
  'speaker',
]);

/** 明确触发：被点到名 / 被拍 / 私聊。这类必须能穿透 focused，否则就是「明明在叫她却不理」。 */
const EXPLICIT_REASONS = new Set(['atMention', 'nameMention', 'poke', 'private']);

const isSoft = (reason) => SOFT_REASONS.has(String(reason ?? ''));
const isExplicit = (reason) => EXPLICIT_REASONS.has(String(reason ?? ''));

export function normalizeShadowCfg(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const pickInt = (v, d, lo, hi) => {
    if (v === null || v === undefined || v === '') return d;
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(hi, Math.max(lo, Math.floor(n)));
  };
  // 判据阈值与采样次数：<=0 一律当「没配」回落默认，不能 clamp 成 1 ——
  // 把 minB 从 0 抬到 1 会让判据在没有样本时也装成「样本够」。
  const pickPositive = (v, d, hi) => {
    if (v === null || v === undefined || v === '') return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return d;
    return Math.min(hi, Math.floor(n));
  };
  // 重采样次数另有地板：跑 10 次的 bootstrap 给不出可信区间，宁可拒绝这个配置。
  const pickIterations = (v) => {
    const n = pickPositive(v, SHADOW_DEFAULTS.bootstrapIterations, 20000);
    return Math.max(200, n);
  };
  return {
    enabled: src.enabled !== false,
    // 上限本身允许配小（测试与回放要用），只挡非法值。
    maxEventsPerDay: pickInt(src.maxEventsPerDay, SHADOW_DEFAULTS.maxEventsPerDay, 1, 50000),
    maxPendingSenders: pickInt(src.maxPendingSenders, SHADOW_DEFAULTS.maxPendingSenders, 1, 20),
    pendingKeepHead: pickInt(src.pendingKeepHead, SHADOW_DEFAULTS.pendingKeepHead, 0, 5),
    pendingKeepTail: pickInt(src.pendingKeepTail, SHADOW_DEFAULTS.pendingKeepTail, 0, 5),
    bootstrapIterations: pickIterations(src.bootstrapIterations),
    bootstrapSeed: pickPositive(src.bootstrapSeed, SHADOW_DEFAULTS.bootstrapSeed, 2 ** 31 - 1),
    latencyMaxMs: pickPositive(src.latencyMaxMs, SHADOW_DEFAULTS.latencyMaxMs, 24 * 3600 * 1000),
    minB: pickPositive(src.minB, SHADOW_DEFAULTS.minB, 100000),
    minA: pickPositive(src.minA, SHADOW_DEFAULTS.minA, 100000),
  };
}

/**
 * 分类一条入站事件。
 *
 * 返回 { intent, group, why }：
 *   intent = 'pass'     照现在的路径走（什么都不变）
 *          | 'explicit' 明确触发，即使 focused 也不该吞，会写进 explicit pending
 *          | 'suppress' 软触发撞上 focused，真开门时会被抑制
 *   group  = 'B-focused' / 'B-occupied' / 'A' / 'S-other'  —— 就是 codex 判据里的 B 与 A
 *
 * 注意 asleep 一律 pass：睡眠本来就有自己的定时器与静默规则，
 * 再叠一层 focused 抑制只会让「半夜有人在群里问一句」彻底没人理。
 */
export function classifyAttention({ band = '', reason = '', side = '' } = {}) {
  const b = String(band ?? '');
  const r = String(reason ?? '');
  const s = String(side ?? '');
  const explicit = isExplicit(r) || s === 'private';

  // 明确触发优先于一切 band：被点名就该应。
  if (explicit) {
    const wouldNeedPending = b === 'focused' || b === 'occupied';
    return {
      intent: 'explicit',
      group: b === 'focused' ? 'B-focused' : b === 'occupied' ? 'B-occupied' : b === 'asleep' ? 'Z-asleep' : 'A',
      why: wouldNeedPending ? `${r || s} 明确触发，穿透 ${b}` : `${r || s} 明确触发`,
    };
  }
  // 没有触发原因的消息单列 N 组：欢迎语、机器人噪声、@了别人、她的群聊
  // 这些本来就不会唤醒她，把它们算进 A 会让 A 的 p90 变长、Δp90 被压小，
  // 判据就会朝「没差异」偏。单列之后 B/A 只比较「真会进唤醒流程」的消息。
  if (!r) return { intent: 'pass', group: 'N', why: '未触发唤醒' };
  // 睡眠单列 Z 组：她睡着时回得慢是睡眠策略（asleep ×0.15）造成的，
  // 不是注意力门控的效果。混进 A 会同时污染两侧的 p90。
  if (b === 'asleep') return { intent: 'pass', group: 'Z-asleep', why: '睡眠期间，不参与对比' };
  // 只有 focused + 软触发才是候选抑制点。
  if (b === 'focused' && isSoft(r)) {
    return { intent: 'suppress', group: 'B-focused', why: `${r} 软触发撞上 focused` };
  }
  if (b === 'occupied') return { intent: 'pass', group: 'B-occupied', why: `${r} 撞上 occupied，只慢不吞` };
  if (b === 'focused') return { intent: 'pass', group: 'B-focused', why: `${r} 撞上 focused，但不是软触发` };
  return { intent: 'pass', group: 'A', why: b ? `${b} 档` : '无 band' };
}

/** 一天一个桶。events 有界；counters 只增不减；selfTimes 也有界（回合间隔统计用）。 */
export function newDayBucket(day = '') {
  return {
    day: String(day ?? ''),
    events: [],
    /** 她自己发言的时刻（毫秒）。只留时刻，不留正文。有界。 */
    selfTimes: [],
    selfDropped: 0,
    dropped: 0,
    counters: {
      total: 0,
      /** 入了唤醒判定但没触发任何 reason 的消息数 —— 不进 B/A，只做体量参考。 */
      noTrigger: 0,
      /** 睡眠期间的入站条数 —— 也不进 B/A。 */
      asleepEvents: 0,
      byIntent: {},
      byBand: {},
      byReason: {},
      suppressedUnreadAtArrival: 0,
      suppressedMaxUnreadAtArrival: 0,
      explicitWhileBusy: 0,
    },
  };
}

const bump = (obj, k) => {
  const key = String(k ?? 'none');
  obj[key] = (Number(obj[key]) || 0) + 1;
};

/**
 * 记一条入站事件。返回 { stored, dropped }。
 * 事件形状刻意小：不存正文、不存 sender 全量，只够算延迟与分布。
 */
export function pushEvent(bucket, ev, opts = {}) {
  const cfg = normalizeShadowCfg(opts.cfg);
  const b = bucket && typeof bucket === 'object' ? bucket : newDayBucket();
  if (!Array.isArray(b.events)) b.events = [];
  if (!b.counters || typeof b.counters !== 'object') b.counters = newDayBucket().counters;
  const c = b.counters;
  c.total = (Number(c.total) || 0) + 1;
  bump(c.byIntent, ev.intent);
  bump(c.byBand, ev.band || 'none');
  bump(c.byReason, ev.reason || 'none');
  if (ev.intent === 'suppress') {
    const unread = Number(ev.unreadAtArrival) || 0;
    c.suppressedUnreadAtArrival += unread;
    c.suppressedMaxUnreadAtArrival = Math.max(Number(c.suppressedMaxUnreadAtArrival) || 0, unread);
  }
  if (ev.intent === 'explicit' && (ev.band === 'focused' || ev.band === 'occupied')) {
    c.explicitWhileBusy = (Number(c.explicitWhileBusy) || 0) + 1;
  }
  if (!ev.reason && ev.group === 'N') {
    c.noTrigger = (Number(c.noTrigger) || 0) + 1;
  }
  if (ev.group === 'Z-asleep') {
    c.asleepEvents = (Number(c.asleepEvents) || 0) + 1;
  }
  if (b.events.length >= cfg.maxEventsPerDay) {
    b.dropped = (Number(b.dropped) || 0) + 1;
    return { stored: false, dropped: b.dropped };
  }
  b.events.push({
    at: Number(ev.at) || 0,
    key: String(ev.key ?? ''),
    side: ev.side === 'private' ? 'private' : 'group',
    reason: String(ev.reason ?? ''),
    band: String(ev.band ?? ''),
    source: String(ev.source ?? ''),
    intent: String(ev.intent ?? 'pass'),
    group: String(ev.group ?? ''),
    unreadAtArrival: Number(ev.unreadAtArrival) || 0,
    // 默认 -1 =「还没量到延迟」。显式传了有限数值就照用（回放/导入用得上），
    // 但绝不能因为调用方没传就当成 0 —— 0 毫秒延迟会污染 p90。
    latencyMs: Number.isFinite(ev.latencyMs) ? Math.max(-2, Math.trunc(ev.latencyMs)) : -1,
  });
  return { stored: true, dropped: 0 };
}

/**
 * 她自己在这个会话说话了 ⇒ 把该会话所有还没回填的入站事件补上延迟。
 * 返回回填的条数。
 */
export function fillLatency(bucket, key, now, opts = {}) {
  const cfg = normalizeShadowCfg(opts.cfg);
  const b = bucket && typeof bucket === 'object' ? bucket : null;
  if (!b || !Array.isArray(b.events)) return 0;
  const k = String(key ?? '');
  const t = Number(now) || 0;
  let n = 0;
  for (const ev of b.events) {
    if (!ev || ev.latencyMs !== -1) continue;
    if (ev.key !== k) continue;
    const d = t - Number(ev.at || 0);
    if (!(d >= 0)) continue;
    if (d > cfg.latencyMaxMs) { ev.latencyMs = -2; continue; } // 太久，记成超时而不是延迟
    ev.latencyMs = d;
    n += 1;
  }
  return n;
}

/**
 * 记一次她自己的发言时刻（回合间隔统计的唯一输入）。
 * 有界：一天最多 maxEventsPerDay 条。
 */
export function noteSelfSpeak(bucket, now, opts = {}) {
  const cfg = normalizeShadowCfg(opts.cfg);
  const b = bucket && typeof bucket === 'object' ? bucket : null;
  if (!b) return false;
  if (!Array.isArray(b.selfTimes)) b.selfTimes = [];
  const t = Number(now) || 0;
  if (!(t > 0)) return false;
  if (b.selfTimes.length >= cfg.maxEventsPerDay) {
    b.selfDropped = (Number(b.selfDropped) || 0) + 1;
    return false;
  }
  b.selfTimes.push(t);
  return true;
}

/**
 * 假想 pending 摘要：如果真开门，专注结束时她会看到什么。
 * 必须有界 —— 这是 codex 点名的「摘要是否有界」验证项。
 */
export function pendingSummaryOf(events, opts = {}) {
  const cfg = normalizeShadowCfg(opts.cfg);
  const list = (Array.isArray(events) ? events : []).filter((e) => e && e.intent === 'suppress');
  if (!list.length) return { count: 0, dropped: 0, senders: [], head: [], tail: [], chars: 0, firstAt: 0, lastAt: 0 };
  const senders = [];
  const seen = new Set();
  for (const e of list) {
    const s = String(e.key ?? '');
    if (seen.has(s)) continue;
    seen.add(s);
    if (senders.length < cfg.maxPendingSenders) senders.push(s);
  }
  const head = list.slice(0, cfg.pendingKeepHead).map((e) => ({ at: e.at, reason: e.reason }));
  const tail = cfg.pendingKeepTail > 0 ? list.slice(-cfg.pendingKeepTail).map((e) => ({ at: e.at, reason: e.reason })) : [];
  // 粗估字符：每条只算「某某说：…」的量级，不存正文所以给个保守常数。
  const chars = list.length * 24 + senders.length * 8;
  return {
    count: list.length,
    dropped: Math.max(0, list.length - cfg.pendingKeepHead - cfg.pendingKeepTail),
    senders,
    head,
    tail,
    chars,
    firstAt: Number(list[0]?.at) || 0,
    lastAt: Number(list[list.length - 1]?.at) || 0,
  };
}

/** 分位数（输入可未排序）。q ∈ [0,1]。 */
export function quantile(values, q) {
  const arr = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (!arr.length) return 0;
  const pos = (arr.length - 1) * Math.min(1, Math.max(0, Number(q) || 0));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return arr[lo];
  return arr[lo] + (arr[hi] - arr[lo]) * (pos - lo);
}

/**
 * 回合间隔：验证「5 秒算不算分条」。
 * times 是她自己发言的时刻列表（毫秒，任意顺序）。
 */
export function turnGapStats(times) {
  const arr = (Array.isArray(times) ? times : []).filter((t) => Number.isFinite(t) && t > 0).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < arr.length; i += 1) gaps.push(arr[i] - arr[i - 1]);
  if (!gaps.length) return { n: 0, p10: 0, p50: 0, p90: 0, under1s: 0, under5s: 0, under120s: 0 };
  const countUnder = (ms) => gaps.filter((g) => g < ms).length;
  return {
    n: gaps.length,
    p10: quantile(gaps, 0.1),
    p50: quantile(gaps, 0.5),
    p90: quantile(gaps, 0.9),
    under1s: countUnder(1000),
    under5s: countUnder(5000),
    under120s: countUnder(120000),
  };
}

/** 确定性 PRNG（mulberry32）—— bootstrap 必须可复现，不能用 Math.random。 */
function makeRng(seed) {
  let a = (Number(seed) || 1) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const resampleP90 = (arr, rng) => {
  const n = arr.length;
  if (!n) return 0;
  const pick = new Array(n);
  for (let i = 0; i < n; i += 1) pick[i] = arr[Math.floor(rng() * n)];
  return quantile(pick, 0.9);
};

/**
 * 分层 bootstrap 的 Δp90 = p90(B) - p90(A)。
 *
 * rows: [{ key, group, latencyMs }]，group 为 'B-focused' / 'B-occupied' / 'A'
 * 分层 = 按 key。每一层内部先各自重采样，再按层原始样本量加权合成 —— 
 * 这样「群里一个人刷屏」不会把整段区间拽走。
 *
 * 返回 { point, lo, hi, iterations, bN, aN, insufficient }。
 */
export function stratifiedBootstrapDeltaP90(rows, opts = {}) {
  const cfg = normalizeShadowCfg(opts.cfg);
  const isB = (g) => String(g ?? '').startsWith('B-');
  // N 组（压根没触发唤醒）不进比较：它们不是「响应慢」，是「本来就不该响」。
  const isCompare = (g) => isB(g) || String(g ?? '') === 'A';
  const list = (Array.isArray(rows) ? rows : []).filter(
    (r) => r && Number.isFinite(r.latencyMs) && r.latencyMs >= 0 && r.latencyMs !== -2 && isCompare(r.group)
  );
  const bAll = list.filter((r) => isB(r.group));
  const aAll = list.filter((r) => !isB(r.group));
  const point = quantile(bAll.map((r) => r.latencyMs), 0.9) - quantile(aAll.map((r) => r.latencyMs), 0.9);
  if (bAll.length < cfg.minB || aAll.length < cfg.minA) {
    return {
      point,
      lo: 0,
      hi: 0,
      iterations: 0,
      bN: bAll.length,
      aN: aAll.length,
      insufficient: true,
    };
  }
  // 按会话分层
  const strata = new Map();
  for (const r of list) {
    const k = String(r.key ?? '');
    if (!strata.has(k)) strata.set(k, { b: [], a: [], n: 0 });
    const s = strata.get(k);
    s.n += 1;
    if (isB(r.group)) s.b.push(r.latencyMs);
    else s.a.push(r.latencyMs);
  }
  const layers = [...strata.values()].filter((s) => s.n > 0);
  const totalN = layers.reduce((acc, s) => acc + s.n, 0);
  const rng = makeRng(cfg.bootstrapSeed);
  const deltas = [];
  for (let it = 0; it < cfg.bootstrapIterations; it += 1) {
    let wb = 0;
    let wa = 0;
    for (const s of layers) {
      const w = s.n / totalN;
      if (s.b.length) wb += w * resampleP90(s.b, rng);
      if (s.a.length) wa += w * resampleP90(s.a, rng);
    }
    if (wb || wa) deltas.push(wb - wa);
  }
  deltas.sort((x, y) => x - y);
  return {
    point,
    lo: quantile(deltas, 0.025),
    hi: quantile(deltas, 0.975),
    iterations: deltas.length,
    bN: bAll.length,
    aN: aAll.length,
    insufficient: false,
  };
}

/**
 * 汇总一个窗口内的全部影子数据，直接给判据结论。
 * days: { 'YYYY-MM-DD': bucket }
 */
export function shadowReport(days, opts = {}) {
  const cfg = normalizeShadowCfg(opts.cfg);
  const buckets = Object.values(days && typeof days === 'object' ? days : {}).filter(Boolean);
  const rows = [];
  const selfTimes = [];
  let events = 0;
  let dropped = 0;
  let suppress = 0;
  let explicitWhileBusy = 0;
  let noTrigger = 0;
  let asleepEvents = 0;
  let unreadMax = 0;
  const byBand = {};
  const byReason = {};
  for (const b of buckets) {
    const c = b.counters || {};
    events += Number(c.total) || 0;
    dropped += Number(b.dropped) || 0;
    explicitWhileBusy += Number(c.explicitWhileBusy) || 0;
    noTrigger += Number(c.noTrigger) || 0;
    asleepEvents += Number(c.asleepEvents) || 0;
    unreadMax = Math.max(unreadMax, Number(c.suppressedMaxUnreadAtArrival) || 0);
    for (const [k, v] of Object.entries(c.byBand || {})) byBand[k] = (Number(byBand[k]) || 0) + (Number(v) || 0);
    for (const [k, v] of Object.entries(c.byReason || {})) byReason[k] = (Number(byReason[k]) || 0) + (Number(v) || 0);
    for (const ev of Array.isArray(b.events) ? b.events : []) {
      if (!ev) continue;
      if (ev.intent === 'suppress') suppress += 1;
      rows.push({ key: ev.key, group: ev.group, latencyMs: Number(ev.latencyMs) });
    }
    for (const t of Array.isArray(b.selfTimes) ? b.selfTimes : []) {
      if (Number.isFinite(t) && t > 0) selfTimes.push(t);
    }
  }
  const bN = rows.filter((r) => String(r.group ?? '').startsWith('B-')).length;
  // aN 只数真 A 组，不能拿 rows 总数减 —— N 组（没触发唤醒的）也在 rows 里。
  const aN = rows.filter((r) => String(r.group ?? '') === 'A').length;
  const boot = stratifiedBootstrapDeltaP90(rows, { cfg });
  const insufficient = bN < cfg.minB || aN < cfg.minA;
  let verdict = 'insufficient';
  if (!insufficient) {
    if (boot.lo > 0) verdict = 'eligible-for-canary';
    else verdict = 'no-delta';
  }
  return {
    days: Object.keys(days || {}).sort(),
    events,
    dropped,
    suppress,
    explicitWhileBusy,
    noTrigger,
    asleepEvents,
    suppressedMaxUnreadAtArrival: unreadMax,
    bN,
    aN,
    mB: bN + aN > 0 ? bN / (bN + aN) : 0,
    byBand,
    byReason,
    turnGap: turnGapStats(selfTimes),
    pending: pendingSummaryOf(
      buckets.flatMap((b) => (Array.isArray(b.events) ? b.events : [])),
      { cfg }
    ),
    bootstrap: boot,
    insufficient,
    verdict,
    thresholds: { minB: cfg.minB, minA: cfg.minA },
  };
}
