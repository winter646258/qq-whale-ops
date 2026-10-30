// 意愿门（P4）：她「有多想插这句话」的连续量。
//
// 为什么需要它：现在的唤醒判定全是布尔开关 —— anyMessage / atMention / nameMention /
// keyword / question / speaker / probability，每一条都是独立的「命中就醒」。这套东西
// 能表达「这句话是不是冲我来的」，但表达不了「我刚连说了三句，现在该歇会」。
// 结果就是：群里安静十分钟，她一句不吭；热闹起来，她一句接一句地插，显得没有分寸。
//
// 形态抄的是 HDS-Interlude 的 group-willingness.ts（分数累积 + 指数衰减 + 阈值 +
// 概率 + 发言扣分）。它比乘法模型强的地方在于能记住「刚说过话」：replyCost 扣下去，
// 要再攒够几条消息才够阈值，这正好就是「歇一会儿」。
//
// 三条纪律：
//   1. 只挡软触发。明确在叫她的（@/名字/提问/拍一拍/私聊）一律直通，永不丢。
//      这是 wake-priority-exempt 的教训 —— 额度被低优先级吃光后，叫名字被丢了 8 次。
//   2. 纯函数。state 进来、state 出去，不读写文件、不看时钟、不起定时器。
//      桥那边负责持久化（st.willingness），这样单测能完全离线跑。
//   3. 关掉就是关掉。enabled:false 时 shouldCall 恒为 true，行为跟现在一模一样。

export const WILLINGNESS_VERSION = 1;

/** 五档参数表。基线 normal：约每 3~5 条普通群消息放行一次。 */
// 数值是按「真实群聊节奏」调过的，不是拍脑袋：scripts/sweep-willingness.mjs
// 扫了一组参数，看每档在「平均 25 秒一条、20% 概率停三分钟」的群里，
// 折合多少条消息说一句。normal 的目标是 12~15 条（十人群里大约 20 分钟一次）。
export const WILLINGNESS_TIERS = Object.freeze({
  // 阈值高、回复代价大：只有话题真的攒起来才开口（约 30 条一次）
  quiet: Object.freeze({ enabled: true, maxScore: 3, threshold: 2.30, probabilityAmplifier: 1.1, decayHalfLifeSeconds: 150, replyCost: 1.00, baseGain: 0.12, quoteGain: 0.08, keywordGain: 0.12 }),
  // 略收敛：别的群已经在聊，这边少抢（约 22 条一次）
  reserved: Object.freeze({ enabled: true, maxScore: 3, threshold: 1.90, probabilityAmplifier: 1.25, decayHalfLifeSeconds: 200, replyCost: 0.90, baseGain: 0.17, quoteGain: 0.12, keywordGain: 0.16 }),
  // 基线：她没在忙、群里正常聊（约 14 条一次）
  normal: Object.freeze({ enabled: true, maxScore: 3, threshold: 1.60, probabilityAmplifier: 1.4, decayHalfLifeSeconds: 240, replyCost: 0.80, baseGain: 0.25, quoteGain: 0.15, keywordGain: 0.20 }),
  // 正聊得起劲（约 9 条一次）
  active: Object.freeze({ enabled: true, maxScore: 3, threshold: 1.10, probabilityAmplifier: 1.6, decayHalfLifeSeconds: 300, replyCost: 0.70, baseGain: 0.34, quoteGain: 0.20, keywordGain: 0.25 }),
  // 阈值低、回复代价小：几乎每条都可能接（约 5 条一次）
  eager: Object.freeze({ enabled: true, maxScore: 3, threshold: 0.45, probabilityAmplifier: 1.8, decayHalfLifeSeconds: 360, replyCost: 0.60, baseGain: 0.45, quoteGain: 0.28, keywordGain: 0.30 })
});

export const WILLINGNESS_TIER_NAMES = Object.freeze(Object.keys(WILLINGNESS_TIERS));

export const WILLINGNESS_DEFAULTS = Object.freeze({
  ...WILLINGNESS_TIERS.normal,
  tier: 'normal',
  /** 按生活状态自动选档；关掉就用 tier 指定的那一档。 */
  auto: true,
  autoTiers: Object.freeze({ occupied: 'reserved', resting: 'quiet', asleep: 'quiet', phoneFocused: 'active', available: 'normal' }),
  /** 生活节奏对概率的乘数。半夜那条最硬。 */
  rhythmProbability: Object.freeze({ phoneFocused: 1.3, available: 1, occupied: 0.7, resting: 0.6, asleep: 0.2 }),
  /** 睡着的兜底乘数（对状态过期/误判留余量）。 */
  asleepProbabilityMultiplier: 0.2,
  /** 回复后要再观察到几条消息才重新参与评分。 */
  jitter: Object.freeze({ quiet: [1, 9], reserved: [1, 7], normal: [0, 6], active: [0, 4], eager: [0, 3] }),
  /** 没配关键词时，replyCost 之后最少要隔几条消息。 */
  minGapAfterReply: 0,
  /**
   * 概率天花板。分数攒满 + 系数相乘很容易到 1.0，那就变成「必然开口」——
   * 一个必然开口的提议层比没有更糟：她会在每条消息上都接，且完全没有意外感。
   * 留 8% 的余地，「分数很高但仍可能这次不想说」才是人。
   */
  maxProbability: 0.92,
  keywords: Object.freeze([]),
  /** 明确在叫她的原因 —— 直通，不参与评分也不被跳过。 */
  forceReasons: Object.freeze(['private', 'atMention', 'nameMention', 'question', 'poke', 'bootstrap'])
});

/** 原因字符串归一：`keyword:小鲸鱼` → `keyword`，`speaker:张三` → `speaker`。 */
export function reasonKind(reason) {
  const s = String(reason ?? '');
  if (!s) return '';
  const i = s.indexOf(':');
  return i > 0 ? s.slice(0, i) : s;
}

/** 这个原因是不是「明确在叫她」—— 是就直通。 */
export function isForcedReason(reason, cfg = WILLINGNESS_DEFAULTS) {
  const kind = reasonKind(reason);
  if (!kind) return false;
  const list = Array.isArray(cfg?.forceReasons) ? cfg.forceReasons : WILLINGNESS_DEFAULTS.forceReasons;
  return list.map(String).includes(kind);
}

function num(v, d, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.max(min, Math.min(max, n));
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

/**
 * 按生活节奏挑档位。auto 关掉就用 cfg.tier。
 * rhythm 是 pacing.js 那五档（phoneFocused / available / occupied / resting / asleep）。
 */
export function resolveTier(cfg = WILLINGNESS_DEFAULTS, rhythm = '') {
  const base = WILLINGNESS_TIERS[cfg?.tier] ? String(cfg.tier) : 'normal';
  if (cfg?.auto === false) return base;
  const map = cfg?.autoTiers ?? WILLINGNESS_DEFAULTS.autoTiers;
  const picked = map?.[String(rhythm ?? '')];
  return WILLINGNESS_TIERS[picked] ? String(picked) : base;
}

/** 把档位参数和 cfg 里的显式覆盖合起来。cfg 里的数值优先。 */
export function resolveWillingness(cfg) {
  const c = cfg ?? {};
  const tierName = resolveTier(c, c.rhythm ?? '');
  const tier = WILLINGNESS_TIERS[tierName] ?? WILLINGNESS_TIERS.normal;
  const pick = (key) => (c[key] != null && Number.isFinite(Number(c[key])) ? Number(c[key]) : tier[key]);
  return {
    enabled: c.enabled !== false,
    tier: tierName,
    maxScore: Math.max(0.1, pick('maxScore')),
    threshold: Math.max(0, pick('threshold')),
    probabilityAmplifier: Math.max(0, pick('probabilityAmplifier')),
    decayHalfLifeSeconds: Math.max(1, pick('decayHalfLifeSeconds')),
    replyCost: Math.max(0, pick('replyCost')),
    baseGain: Math.max(0, pick('baseGain')),
    quoteGain: Math.max(0, pick('quoteGain')),
    keywordGain: Math.max(0, pick('keywordGain')),
    keywords: (Array.isArray(c.keywords) ? c.keywords : WILLINGNESS_DEFAULTS.keywords)
      .map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 30),
    maxProbability: num(c.maxProbability, WILLINGNESS_DEFAULTS.maxProbability, { min: 0.01, max: 1 })
  };
}

export function emptyWillingnessState(now = 0) {
  return { score: 0, updatedAt: Number(now) || 0, skipCount: 0 };
}

/**
 * 指数衰减。半衰期之外还有一条地板：低于 0.001 直接归零，
 * 免得浮点数留个 1e-30 让它「好像还有点意愿」。
 *
 * skipCount 只按消息条数递减、不随时间衰减 —— 否则「说完隔一晚，
 * 第二天第一条消息立刻又接」正是我们想避免的节律断裂。
 */
export function decayWillingness(previous, cfg, now) {
  const conf = resolveWillingness(cfg);
  const prev = previous && Number.isFinite(Number(previous.score)) ? previous : null;
  const score = prev ? Math.max(0, Number(prev.score)) : 0;
  const at = prev ? Math.max(0, Number(prev.updatedAt) || 0) : 0;
  const t = Math.max(0, Number(now) || 0);
  const elapsedSec = at > 0 ? Math.max(0, t - at) / 1000 : 0;
  const factor = Math.pow(0.5, elapsedSec / conf.decayHalfLifeSeconds);
  const decayed = score * factor;
  return {
    score: decayed < 0.001 ? 0 : round4(decayed),
    updatedAt: t,
    skipCount: Math.max(0, Math.floor(Number(prev?.skipCount) || 0))
  };
}

/**
 * 核心判定。
 *   previous  上一次的 state（可以是 undefined）
 *   cfg       意愿门配置（含 rhythm 用来挑档）
 *   input     { now, messageCount, content, quotedBot, reason, rhythm, random }
 *
 * 返回 { state, shouldCall, probability, score, threshold, tier, reason }
 * 其中 reason 是「决定的原因」，和唤醒触发原因分开，便于日志区分。
 */
export function evaluateWillingness(previous, cfg, input = {}) {
  const now = Number(input.now) || 0;
  const conf = resolveWillingness({ ...(cfg ?? {}), rhythm: input.rhythm ?? cfg?.rhythm ?? '' });
  const state = decayWillingness(previous, { ...(cfg ?? {}), rhythm: input.rhythm ?? '' }, now);
  const base = {
    state,
    shouldCall: true,
    probability: 1,
    score: state.score,
    threshold: conf.threshold,
    tier: conf.tier,
    reason: 'disabled'
  };
  if (!conf.enabled) return base;

  const wakeReason = String(input.reason ?? '');
  // 明确在叫她：直通。不清零 skipCount（一次 @ 不该重置整段抖动周期）。
  if (isForcedReason(wakeReason, cfg)) {
    return { ...base, shouldCall: true, probability: 1, reason: 'forced' };
  }

  // 回复后的抖动：这几条只看不说话，把计数消耗完再重新参与评分。
  const need = Math.max(0, Math.floor(Number(state.skipCount) || 0));
  if (need > 0) {
    const consumed = Math.max(1, Math.floor(Number(input.messageCount) || 1));
    const left = Math.max(0, need - consumed);
    return {
      ...base,
      state: { ...state, skipCount: left },
      shouldCall: false,
      probability: 0,
      reason: 'skip'
    };
  }

  // 攒分：一批消息里条数越多越想接（夹在 1~3，避免刷屏直接顶满）。
  const content = String(input.content ?? '');
  const keywordHit = conf.keywords.length > 0 && conf.keywords.some((k) => content.includes(k));
  const rawGain = conf.baseGain * clamp(Math.floor(Number(input.messageCount) || 1), 1, 3)
    + (input.quotedBot ? conf.quoteGain : 0)
    + (keywordHit ? conf.keywordGain : 0);
  // 边际递减：越接近满值越难再涨，避免「攒满就一直说」。
  const marginal = 1 - Math.pow(Math.min(1, state.score / conf.maxScore), 2);
  const score = clamp(state.score + rawGain * Math.max(0, marginal), 0, conf.maxScore);
  const next = { ...state, score: round4(score) };

  if (score <= conf.threshold) {
    return { ...base, state: next, shouldCall: false, probability: 0, score: next.score, reason: 'below-threshold', gap: round4(conf.threshold - score) };
  }

  const rhythm = String(input.rhythm ?? '');
  const rhythmMul = Number((cfg?.rhythmProbability ?? WILLINGNESS_DEFAULTS.rhythmProbability)[rhythm] ?? 1);
  const asleepMul = rhythm === 'asleep' ? num(cfg?.asleepProbabilityMultiplier, WILLINGNESS_DEFAULTS.asleepProbabilityMultiplier, { min: 0.05, max: 1 }) : 1;
  const probability = clamp((score - conf.threshold) * conf.probabilityAmplifier * rhythmMul * asleepMul, 0, conf.maxProbability);
  const roll = typeof input.random === 'function' ? Number(input.random()) : Math.random();
  return {
    ...base,
    state: next,
    shouldCall: roll < probability,
    probability: round4(probability),
    score: next.score,
    reason: 'roll'
  };
}

/**
 * 她说过话之后调用：扣 replyCost，并按档位掷一段抖动条数。
 * 返回新的 state（直接盖回 st.willingness）。
 */
export function consumeWillingness(previous, cfg, now, random = Math.random) {
  const conf = resolveWillingness(cfg);
  const state = decayWillingness(previous, cfg, now);
  const range = (cfg?.jitter ?? WILLINGNESS_DEFAULTS.jitter)[conf.tier] ?? WILLINGNESS_DEFAULTS.jitter.normal;
  const lo = Math.max(0, Math.floor(Number(range?.[0]) || 0));
  const hi = Math.max(lo, Math.floor(Number(range?.[1]) || 0));
  const span = hi - lo + 1;
  const extra = lo + Math.floor(Math.max(0, Math.min(0.999999, Number(random()) || 0)) * span);
  return {
    score: round4(Math.max(0, state.score - conf.replyCost)),
    updatedAt: Math.max(0, Number(now) || 0),
    skipCount: Math.max(0, extra + Math.max(0, Math.floor(Number(cfg?.minGapAfterReply) || 0)))
  };
}

/** 给日志用的一行。 */
export function describeWillingness(decision) {
  if (!decision) return '';
  const d = decision;
  const head = `${d.tier} 分数 ${d.score}/${d.threshold}`;
  if (d.reason === 'disabled') return `${head} 未启用`;
  if (d.reason === 'forced') return `${head} 直通`;
  if (d.reason === 'skip') return `${head} 还要再看 ${d.state?.skipCount ?? 0} 条`;
  if (d.reason === 'below-threshold') return `${head} 差 ${d.gap ?? '?'}`;
  return `${head} 概率 ${d.probability} → ${d.shouldCall ? '说' : '不说'}`;
}
