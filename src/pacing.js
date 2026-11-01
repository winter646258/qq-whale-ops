// 节奏层（pacing）—— 「她有作息」的那一层。纯逻辑，无副作用，带单测。
//
// 为什么单独一个文件：
//   bridge.js 里「什么时候叫醒她」原本是两个骰子：wake 的 probability（每条消息
//   掷一次）和 proactive 的 [min,max] 均匀随机。两者都跟她当时在干什么没关系 ——
//   实测就是凌晨照样排档期、刚说完话立刻又被叫，群里则是「每条都回」。
//
//   这里照着 Interlude 的两条公式重写（只借思路，没抄代码 —— 对方是 AGPL）：
//     推进间隔 = 基础间隔 / (对话密度因子 × 生活节奏因子)
//     回复后跳过 N 次（eager 0~3 / normal 0~6 / quiet 1~9，再按节奏加减）
//
//   三条约束，都来自本项目的踩坑记录：
//     1. 不新增定时器 —— 密度和节奏都是「读的时候现算」，进程重启不丢东西。
//        这台机器可用内存只剩几百 MB，bridge.js 已经挂了六个 setInterval。
//     2. 不新增工具调用 —— 节奏只从「最后一次有人说话的时间 + 当前钟点」推，
//        不让她在聊天中间额外调一次工具（实测一次工具调用要重发约 24 万 token）。
//     3. 只挡软触发 —— private / atMention / nameMention / question / poke 这些
//        「明确在叫她」的信号绝不因为抖动被跳掉（wake-priority-exempt 那条教训：
//        额度用光后叫名字被丢 8 次，用户体感就是「叫了不理」）。
//
// 一句话：她忙的时候少叫她，她闲的时候正常叫，叫完了先歇几条。

/** 所有可调旋钮的默认值。config.json 的 socialV2.pacing 会盖在上面。 */
export const PACING_DEFAULTS = Object.freeze({
  enabled: true,
  // 对话密度：最近 6 小时里收到的消息，按 90 分钟半衰期指数衰减后加权求和，
  // 再拿 densityRefCount 条当「很热闹」的参照归一化。
  densityRefCount: 12,
  densityHalfLifeMs: 90 * 60 * 1000,
  densityWindowMs: 6 * 60 * 60 * 1000,
  activeMultiplier: 1.4,
  // 生活节奏（五档）。occupied 现在没人写，留给以后她自己标「在上课」。
  rhythm: Object.freeze({
    phoneFocused: 1.4,   // 正在用手机、刚说完话
    available: 1,        // 空闲
    occupied: 0.7,       // 上课/干活
    // MARKER: focused-rhythm —— 作者在生活线上显式标了「这段真在专注」。
    // 必须比 occupied 更低：否则 focused 会掉进下面按时间戳的 available(1.0)，
    // 比 occupied(0.7) 更爱说话，等于标了专注反而更吵。
    focused: 0.4,
    resting: 0.5,        // 躺着、低能量
    asleep: 0.15         // 睡了
  }),
  focusWindowMs: 3 * 60 * 1000,      // 3 分钟内有人说话 = 正在用手机
  rhythmTtlMs: 2 * 60 * 60 * 1000,   // 2 小时没动静 = 节奏数据过期
  restMultiplier: 0.6,               // 过期/从没说过话时的兜底倍率
  // 回复后跳过几次软触发（不是「几条消息」：只有本来会叫醒她的消息才计数）
  skip: Object.freeze({
    enabled: true,
    eager: [0, 3],
    normal: [0, 6],
    quiet: [1, 9],
    focusAdjust: -1,
    restAdjust: 2,
    asleepAdjust: 3
  }),
  minDelayMs: 60 * 1000,   // 主动间隔的下限，再怎么热闹也不密于 1 分钟
  maxDelayStretch: 4       // 间隔最多拉长到基础值的 4 倍
});

function num(value, fallback) {
  // null / undefined / '' 都是「没配这一项」，不是 0 —— Number(null) 会得到 0，
  // 那样 `rhythm: { asleep: null }` 就会被当成「睡着的倍率是 0」，
  // 她的主动间隔直接变成无穷大。配置写坏最多让节奏不准，不该让她彻底闭嘴。
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

/**
 * 把 cfg.socialV2.pacing 摊平成完整配置。脏值一律回落默认，不抛错 ——
 * 这是读路径，配置写错了最多是节奏不准，不该让她哑掉。
 */
export function pacingCfg(cfg) {
  const raw = (cfg?.socialV2?.pacing ?? cfg?.pacing ?? {}) || {};
  const skip = { ...PACING_DEFAULTS.skip, ...(raw.skip || {}) };
  const rhythm = { ...PACING_DEFAULTS.rhythm, ...(raw.rhythm || {}) };
  const out = {
    ...PACING_DEFAULTS,
    ...raw,
    skip: {
      enabled: skip.enabled !== false,
      eager: Array.isArray(skip.eager) ? skip.eager : PACING_DEFAULTS.skip.eager,
      normal: Array.isArray(skip.normal) ? skip.normal : PACING_DEFAULTS.skip.normal,
      quiet: Array.isArray(skip.quiet) ? skip.quiet : PACING_DEFAULTS.skip.quiet,
      focusAdjust: num(skip.focusAdjust, PACING_DEFAULTS.skip.focusAdjust),
      restAdjust: num(skip.restAdjust, PACING_DEFAULTS.skip.restAdjust),
      asleepAdjust: num(skip.asleepAdjust, PACING_DEFAULTS.skip.asleepAdjust)
    },
    rhythm: {
      phoneFocused: num(rhythm.phoneFocused, PACING_DEFAULTS.rhythm.phoneFocused),
      available: num(rhythm.available, PACING_DEFAULTS.rhythm.available),
      occupied: num(rhythm.occupied, PACING_DEFAULTS.rhythm.occupied),
      resting: num(rhythm.resting, PACING_DEFAULTS.rhythm.resting),
      asleep: num(rhythm.asleep, PACING_DEFAULTS.rhythm.asleep)
    }
  };
  out.enabled = raw.enabled !== false;
  out.densityRefCount = Math.max(1, num(out.densityRefCount, PACING_DEFAULTS.densityRefCount));
  out.densityHalfLifeMs = Math.max(60 * 1000, num(out.densityHalfLifeMs, PACING_DEFAULTS.densityHalfLifeMs));
  out.densityWindowMs = Math.max(out.densityHalfLifeMs, num(out.densityWindowMs, PACING_DEFAULTS.densityWindowMs));
  out.activeMultiplier = Math.max(1, num(out.activeMultiplier, PACING_DEFAULTS.activeMultiplier));
  out.focusWindowMs = Math.max(0, num(out.focusWindowMs, PACING_DEFAULTS.focusWindowMs));
  out.rhythmTtlMs = Math.max(out.focusWindowMs, num(out.rhythmTtlMs, PACING_DEFAULTS.rhythmTtlMs));
  out.restMultiplier = Math.max(0.05, num(out.restMultiplier, PACING_DEFAULTS.restMultiplier));
  out.minDelayMs = Math.max(1000, num(out.minDelayMs, PACING_DEFAULTS.minDelayMs));
  out.maxDelayStretch = Math.max(1, num(out.maxDelayStretch, PACING_DEFAULTS.maxDelayStretch));
  return out;
}

/**
 * 对话密度因子：1.0（没人说话）~ activeMultiplier（很热闹）。
 * 权重按 90 分钟半衰期衰减 —— 所以聊完不会立刻冷下来，会有一段余温。
 */
export function densityOf(recentMessages, now = Date.now(), cfg = PACING_DEFAULTS) {
  const half = Math.max(1000, num(cfg.densityHalfLifeMs, PACING_DEFAULTS.densityHalfLifeMs));
  const win = Math.max(half, num(cfg.densityWindowMs, PACING_DEFAULTS.densityWindowMs));
  const ref = Math.max(1, num(cfg.densityRefCount, PACING_DEFAULTS.densityRefCount));
  const active = Math.max(1, num(cfg.activeMultiplier, PACING_DEFAULTS.activeMultiplier));
  let weighted = 0;
  let count = 0;
  const list = Array.isArray(recentMessages) ? recentMessages : [];
  for (const m of list) {
    if (!m || m.isSelf) continue;
    const t = Number(m.time);
    if (!Number.isFinite(t) || t <= 0) continue;
    const age = now - t;
    if (age < 0 || age > win) continue;
    weighted += Math.pow(0.5, age / half);
    count += 1;
  }
  const norm = Math.min(1, weighted / ref);
  return { count, weighted: round3(weighted), factor: round3(1 + (active - 1) * norm) };
}

/**
 * 生活节奏：只从「最后一次有人说话」和「现在几点」推。
 *
 * 优先级：
 *   1. 3 分钟内有人说话 → phoneFocused（她正看着手机）
 *   2. 23:00 ~ 08:00      → asleep
 *   3. 2 小时没人理       → resting（躺着，但没睡）
 *   4. 其余               → available
 *   从没说过话（没有信号）→ resting × restMultiplier 兜底，绝不按 available 算。
 */
export function rhythmOf({ lastIncomingAt = 0, now = Date.now(), hour, attention = '', cfg = PACING_DEFAULTS } = {}) {
  const table = cfg.rhythm ?? PACING_DEFAULTS.rhythm;
  const focusWin = Math.max(0, num(cfg.focusWindowMs, PACING_DEFAULTS.focusWindowMs));
  const ttl = Math.max(focusWin, num(cfg.rhythmTtlMs, PACING_DEFAULTS.rhythmTtlMs));
  const rest = Math.max(0.05, num(cfg.restMultiplier, PACING_DEFAULTS.restMultiplier));
  const last = Math.max(0, num(lastIncomingAt, 0));
  const h = Number.isFinite(Number(hour)) ? Number(hour) : new Date(now).getHours();
  const idle = last > 0 ? Math.max(0, now - last) : null;

  if (idle === null) {
    const mult = num(table.available, 1) * rest;
    return { level: 'resting', multiplier: round3(mult), idleMs: null, stale: true };
  }
  if (idle <= focusWin) return { level: 'phoneFocused', multiplier: round3(num(table.phoneFocused, 1.4)), idleMs: idle, stale: false };
  // MARKER: attention-override —— 生活线声明优先于纯时间戳推算。
  // 她正在书房正经干活（interruptible<=0.45）就该按 occupied 走，而不是因为
  // 两小时没人说话就被判成 resting；反过来「躺在床上没睡着」本来就和 asleep 同频。
  // 只认 occupied/asleep 两档（其余交给下面按时间戳的判定），半夜睡着那条仍然最硬。
  const att = String(attention || '');
  // focused 与 occupied 同一条分支：都表示「生活线声明她现在腾不出手」，
  // 区别只在倍率（focused 更慢）。夜里仍然让位给下面的 asleep，睡眠最硬。
  if ((att === 'focused' || att === 'occupied') && !(h >= 23 || h < 8)) {
    const level = att === 'focused' ? 'focused' : 'occupied';
    const fb = level === 'focused' ? 0.4 : 0.7;
    return { level, multiplier: round3(num(table[level], fb)), idleMs: idle, stale: false, source: 'life' };
  }
  if (h >= 23 || h < 8) return { level: 'asleep', multiplier: round3(num(table.asleep, 0.15)), idleMs: idle, stale: false };
  if (idle > ttl) return { level: 'resting', multiplier: round3(num(table.resting, 0.5)), idleMs: idle, stale: true };
  return { level: 'available', multiplier: round3(num(table.available, 1)), idleMs: idle, stale: false };
}

/**
 * 主动间隔：intervals = 基础间隔 / (密度因子 × 节奏因子)。
 * 热闹时更勤、深夜/久无人语时更懒，但夹在 [minDelayMs, base × maxDelayStretch] 之间，
 * 避免一次算出「3 秒后叫她」或「明天早上」。
 */
export function urgeDelay({ baseMs, recentMessages = [], lastIncomingAt = 0, now = Date.now(), hour, attention = '', cfg = PACING_DEFAULTS } = {}) {
  const base = Math.max(1000, num(baseMs, 1000));
  const d = densityOf(recentMessages, now, cfg);
  const r = rhythmOf({ lastIncomingAt, now, hour, attention, cfg });
  const factor = Math.max(0.15, d.factor * r.multiplier);
  const min = Math.max(1000, num(cfg.minDelayMs, PACING_DEFAULTS.minDelayMs));
  const stretch = Math.max(1, num(cfg.maxDelayStretch, PACING_DEFAULTS.maxDelayStretch));
  const delay = Math.min(base * stretch, Math.max(min, base / factor));
  return {
    delay: Math.round(delay),
    factor: round3(factor),
    density: d.factor,
    densityCount: d.count,
    rhythm: r.level,
    multiplier: r.multiplier
  };
}

/**
 * 哪些唤醒原因属于「猜她可能想说」，可以被抖动跳掉。
 * 明确在叫她的（private / atMention / nameMention / question / poke）以及系统
 * 自己排的（bootstrap / replyCheck / timeout / proactiveCheck / schedule）一律不算软。
 */
export function isSoftReason(reason) {
  const r = String(reason ?? '');
  if (!r) return false;
  if (r === 'anyMessage' || r === 'probability') return true;
  return r.startsWith('keyword:') || r.startsWith('speaker:');
}

/**
 * 掷一个「回复后先跳几次」。返回 0 就是下一条触发照常回。
 * 三档：正聊着 eager（0~3）、平常 normal（0~6）、躺着/睡了 quiet（1~9），
 * 再按节奏做加减（正聊着 -1，躺着 +2，睡了 +3）。
 */
export function rollSkip({ level = 'available', cfg = PACING_DEFAULTS, random = Math.random } = {}) {
  const s = cfg.skip ?? PACING_DEFAULTS.skip;
  const band = level === 'phoneFocused'
    ? (s.eager || PACING_DEFAULTS.skip.eager)
    : (level === 'resting' || level === 'asleep')
      ? (s.quiet || PACING_DEFAULTS.skip.quiet)
      : (s.normal || PACING_DEFAULTS.skip.normal);
  const lo = Math.max(0, Math.floor(num(band[0], 0)));
  const hi = Math.max(lo, Math.floor(num(band[1], lo)));
  const r = Math.max(0, Math.min(1, num(random(), 0)));
  let n = lo + Math.floor(r * (hi - lo + 1));
  if (level === 'phoneFocused') n += num(s.focusAdjust, 0);
  if (level === 'resting') n += num(s.restAdjust, 0);
  if (level === 'asleep') n += num(s.asleepAdjust, 0);
  return Math.max(0, Math.min(12, Math.round(n)));
}

/**
 * 一条消息过闸：要不要因为她刚说过话而跳过这次唤醒。
 *
 * 入参 st 就是该会话的 socialV2 状态，函数**不改它**（返回新值，由调用方写回）：
 *   st.lastAiReplyAt   她最后一次发言
 *   st.skipRolledAt    上次掷骰子时依据的那次发言
 *   st.skipSeen        掷完之后已经过了几次触发
 *   st.skipTarget      这次要跳几次
 *
 * 关键点：只在「她确实又说过话」之后才重掷，所以被跳过的消息不会无限累积，
 * 她一回话计数就归零。
 */
export function skipDecision({ st = {}, reason = null, now = Date.now(), hour, attention = '', cfg = PACING_DEFAULTS, random = Math.random } = {}) {
  const lastReply = Math.max(0, num(st.lastAiReplyAt, 0));
  let rolledAt = Math.max(0, num(st.skipRolledAt, 0));
  let target = Math.max(0, num(st.skipTarget, 0));
  let seen = Math.max(0, num(st.skipSeen, 0)) + 1;
  const rhythm = rhythmOf({ lastIncomingAt: st.lastIncomingAt, now, hour, attention, cfg });
  let rolled = false;
  if (lastReply > rolledAt) {
    target = rollSkip({ level: rhythm.level, cfg, random });
    rolledAt = lastReply;
    seen = 1;
    rolled = true;
  }
  const active = seen <= target;
  const soft = isSoftReason(reason);
  return {
    seen,
    target,
    rolledAt,
    rolled,
    level: rhythm.level,
    active,
    // 只有「本来要叫醒她的软触发」才真的被跳；其余照旧
    skip: Boolean(reason) && soft && active
  };
}
