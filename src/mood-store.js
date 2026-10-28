// 情绪状态（json）—— 纯逻辑模块。
//
// 为什么单独一个文件：
//   diary-store.js 开篇那段自己承认过 ——「这张『人体系统』图里唯一整块空白的是
//   情绪系统：心情有状态、有原因、有时长」。diary 里的 mood 只是日记条目上的一个
//   字符串，写日记时顺带记一笔；它没有状态、不会自己变、也不知道已经持续了多久。
//   这个文件补的就是那块空白。
//
// 三个决定，写在最前面：
//
// 1. 不做定时器，做惰性衰减。
//    理论上的做法是「每 60 秒重算一次，模拟激素代谢」。这台机器 available 只剩
//    568MB，bridge.js 已经挂了六个 setInterval，再加一个每分钟的 tick 换不来任何
//    东西 —— 指数衰减有解析解，读的时候按时间差现算，跟每分钟 tick 数学等价，
//    而且进程重启不会丢 tick。所以 state.pad 存的是「最后一次写入时的原始值」，
//    当前情绪永远由 pad + (now - updatedAt) 现算。这条性质有单测守着。
//
// 2. 数值归数值，标签归标签。
//    PAD 三个浮点只用来做衰减和阈值判断；给人看的情绪标签由她自己写，不设枚举。
//    这条沿用 diary 的教训：「一旦写成固定几档，她就会开始贴标签而不是记事」。
//
// 3. 不自动打分。
//    这里没有「这句话让她生气 → pleasure -0.2」这种文本判断。情绪只有两个来源：
//    她自己写，和时间。一旦系统开始判断该扣多少分，它就在查表，不在感受。
//
// 状态机：
//   pad              当前情绪（-1 ~ +1 三维），是最后一次写入时的原始值
//   baseline         长期底色，只能显式调（见 setBaseline 注释：为什么不自动漂移）
//   label / reason   情绪标签和原因，自由文本
//   since            这个心情从什么时候开始（label 不变就不重置）
//   undercurrent     压着没说出口的事，带权重
//   affinity         好感度 1~10 + 一句描述（描述才是给人看的，数字只是索引）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MOOD_VERSION = 1;
export const MOOD_FILE = '情绪.json';

export const PAD_KEYS = Object.freeze(['pleasure', 'arousal', 'dominance']);
export const PAD_MIN = -1;
export const PAD_MAX = 1;

// 半衰期按「离底色多远」分三档：越远代谢越慢。
// 这不是查表判断，是物理参数 —— 人浓烈的情绪本来就要更久才消。
export const HALF_LIFE_STRONG_MS = 90 * 60 * 1000;
export const HALF_LIFE_MID_MS = 45 * 60 * 1000;
export const HALF_LIFE_LIGHT_MS = 20 * 60 * 1000;
export const STRONG_GAP = 0.6;
export const MID_GAP = 0.3;

// 底色：一次最多挪这么多。防手滑，不防她 —— 她要真想变，多调几次就是了。
export const BASELINE_STEP_LIMIT = 0.05;

export const DEFAULT_BASELINE = Object.freeze({ pleasure: 0.1, arousal: 0.0, dominance: 0.1 });

// 暗流：总和超过这个值才在注入里提一句。只提示，不引爆 ——
// 自动引爆 = 定时器 + 判断规则 = 查表，人不是被定时器引爆的。
export const UNDERCURRENT_ALERT = 1.5;
export const MAX_UNDERCURRENT = 20;

export const MAX_LABEL_CHARS = 20;
export const MAX_REASON_CHARS = 120;
export const MAX_VENT_CHARS = 200;
export const MAX_NOTE_CHARS = 120;
export const AFFINITY_MIN = 1;
export const AFFINITY_MAX = 10;
export const MAX_BYTES = 256 * 1024;

// MARKER: mood-fade —— 「此刻」也要会淡。
// 旧实现只衰减 PAD 三维，label/reason 原样留在注入里，于是她能连着几天读到
// 「【此刻】有点意外 · …（4 天前开始）」。PAD 早就归位了，标签还在。
// 这两个数是 describeMood 的两道闸：偏离小于阈值就当她情绪过去了；
// 挂得太久（哪怕 PAD 还没完全归位）也不再把旧标签当「此刻」念。
export const DEFAULT_LABEL_MIN_INTENSITY = 0.12;
export const DEFAULT_LABEL_MAX_MS = 24 * 60 * 60 * 1000;

// ── 基础工具 ────────────────────────────────────────────────────────────

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function clampPad(value) {
  return clamp(value, PAD_MIN, PAD_MAX);
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function clampLevel(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return AFFINITY_MIN;
  return Math.min(AFFINITY_MAX, Math.max(AFFINITY_MIN, Math.round(n)));
}

/**
 * 把任意输入读成 PAD 数字。读不出来返回 null。
 *
 * 为什么要这么啰嗦：Number('') === 0、Number(null) === 0、Number([]) === 0，
 * 用 Number() 一把梭会把「没填」当成「正值 0」，而 0 在 PAD 里是有意义的中性值。
 */
function toPadNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 保留三位小数：情绪是模糊量，浮点尾巴没有意义，还会让 json 变丑。 */
function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function cleanLine(raw, max) {
  return String(raw ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, max);
}

export function cleanLabel(raw) {
  return cleanLine(raw, MAX_LABEL_CHARS);
}

export function cleanReason(raw) {
  return cleanLine(raw, MAX_REASON_CHARS);
}

export function cleanVent(raw) {
  return cleanLine(raw, MAX_VENT_CHARS);
}

export function cleanNote(raw) {
  return cleanLine(raw, MAX_NOTE_CHARS);
}

// ── 衰减 ────────────────────────────────────────────────────────────────

/** 按偏离幅度选半衰期。偏离越远，代谢越慢。 */
export function halfLifeFor(gap) {
  const g = Math.abs(Number(gap) || 0);
  if (g > STRONG_GAP) return HALF_LIFE_STRONG_MS;
  if (g > MID_GAP) return HALF_LIFE_MID_MS;
  return HALF_LIFE_LIGHT_MS;
}

/**
 * 指数回归：v(t) = baseline + (v0 - baseline) * 0.5^(Δt / halfLife)。
 *
 * 这是整个模块的地基。它满足半群性质：
 *   decay(decay(v, t1), t2) === decay(v, t1 + t2)
 * 所以「每分钟 tick 一次」和「隔一天算一次」结果完全一样 —— 这就是不做定时器的理由。
 */
export function decayValue(current, baseline, elapsedMs, halfLifeMs) {
  const v = Number(current);
  const b = Number(baseline);
  if (!Number.isFinite(v)) return Number.isFinite(b) ? b : 0;
  if (!Number.isFinite(b)) return v;
  const half = Number(halfLifeMs);
  if (!Number.isFinite(half) || half <= 0) return v;
  const dt = Number(elapsedMs);
  if (!Number.isFinite(dt) || dt <= 0) return v;
  return b + (v - b) * Math.pow(0.5, dt / half);
}

/**
 * 把 state 衰减到 now，返回新的 pad（不改原对象）。
 * 三维各自按自己的偏离幅度选半衰期 —— 可能某一维还没消、另一维已经归位了。
 */
export function decayMood(state, now = Date.now()) {
  const base = state?.baseline || DEFAULT_BASELINE;
  const pad = state?.pad || {};
  const updatedAt = Number(state?.updatedAt) || now;
  const elapsed = Math.max(0, now - updatedAt);
  const out = {};
  for (const key of PAD_KEYS) {
    const current = clampPad(pad[key] ?? base[key] ?? 0);
    const baseline = clampPad(base[key] ?? 0);
    out[key] = round3(decayValue(current, baseline, elapsed, halfLifeFor(current - baseline)));
  }
  return out;
}

// ── 规范化 ──────────────────────────────────────────────────────────────

function normalizeVent(raw, fallbackAt) {
  if (!raw || typeof raw !== 'object') return null;
  const text = cleanVent(raw.text);
  if (!text) return null;
  const at = Number(raw.at);
  return {
    id: String(raw.id || '').trim() || newVentId(text),
    text,
    weight: round3(clamp01(raw.weight ?? 0.3)),
    at: Number.isFinite(at) && at > 0 ? at : fallbackAt
  };
}

/**
 * 把任意来源（磁盘 / 工具入参 / 旧版本）的对象摊平成完整 state。
 * 缺字段补默认，超范围钳制，脏数据丢掉 —— 但**不抛错**，
 * 因为这是读路径；真正读不动的情况由 readMood 负责抛。
 */
export function normalizeState(raw, now = Date.now()) {
  const o = raw && typeof raw === 'object' ? raw : {};

  const baseline = {};
  for (const key of PAD_KEYS) {
    const n = toPadNumber(o.baseline?.[key]);
    baseline[key] = round3(clampPad(n === null ? DEFAULT_BASELINE[key] : n));
  }
  const pad = {};
  for (const key of PAD_KEYS) {
    const n = toPadNumber(o.pad?.[key]);
    // 脏值回落到 baseline，不是回落到 -1 —— 钳到下限会让「写了个错的数字」
    // 变成「她突然极度难过」，这是完全不同的两件事。
    pad[key] = round3(clampPad(n === null ? baseline[key] : n));
  }

  const undercurrent = (Array.isArray(o.undercurrent) ? o.undercurrent : [])
    .map((item) => normalizeVent(item, now))
    .filter(Boolean)
    .slice(-MAX_UNDERCURRENT);

  // MARKER: affinity-migrate-norm
  // 好感度不在这里了 —— 它按会话各存一份，落在 state/affinity.json，
  // 见 affinity-store.js。老文件里的 affinity 字段读进来会被直接丢掉
  // （normalizeState 只挑认识的键返回，多余的字段不会带出去），
  // 所以迁移完之后文件里那一段就自然消失了。
  const updatedAt = Number(o.updatedAt);
  const sinceAt = Number(o.since);
  const baseAt = Number(o.baselineUpdatedAt);

  return {
    version: MOOD_VERSION,
    pad,
    baseline,
    label: cleanLabel(o.label),
    reason: cleanReason(o.reason),
    since: Number.isFinite(sinceAt) && sinceAt > 0 ? sinceAt : (Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : now),
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : now,
    baselineUpdatedAt: Number.isFinite(baseAt) && baseAt > 0 ? baseAt : now,
    undercurrent
  };
}

/** 一个刚建立、什么都没经历过的状态。 */
export function createDefaultMood(now = Date.now()) {
  return normalizeState({}, now);
}

// ── 读 / 写 ─────────────────────────────────────────────────────────────

/**
 * 读情绪文件。
 * 不存在 ⇒ 默认状态；坏 JSON ⇒ **抛错**（绝不当成默认状态再写回去，
 * 那会把真实情绪清空 —— 跟日记同样的处理）。
 */
export function readMood(file, now = Date.now()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return createDefaultMood(now);
    throw error;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`情绪文件无法解析（${file}）：${error.message}`);
  }
  return normalizeState(raw, now);
}

/** 原子写（临时文件 + rename），权限 600。 */
export function writeMood(file, state) {
  const s = normalizeState(state);
  const payload = JSON.stringify(s, null, 2) + '\n';
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes > MAX_BYTES) throw new Error(`情绪文件超过上限（${bytes} > ${MAX_BYTES} 字节）`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
  return bytes;
}

// ── 写入心情 ────────────────────────────────────────────────────────────

function newVentId(text) {
  return 'u' + crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 5);
}

/**
 * 设置心情。
 *
 * 先把旧情绪衰减到 now 再叠加新值 —— 否则「上次写完之后隔了一天」的那段代谢量
 * 会被直接丢掉，等于每次 set 都偷偷把情绪拉回上一次的原始值。
 *
 * since 只在 label 变了的时候重置：她连写三条「还是有点闷」，起点应该还是第一条。
 */
export function setMood(state, { label, reason, pleasure, arousal, dominance, now = Date.now() } = {}) {
  const s = normalizeState(state, now);
  const decayed = decayMood(s, now);

  const nextPad = { ...decayed };
  // 传了非法值就当没传 —— 三者的语义是「把这一维设成多少」，
  // 读不成数字时静默跳过比钳成极值安全得多。
  if (pleasure !== undefined) { const n = toPadNumber(pleasure); if (n !== null) nextPad.pleasure = clampPad(n); }
  if (arousal !== undefined) { const n = toPadNumber(arousal); if (n !== null) nextPad.arousal = clampPad(n); }
  if (dominance !== undefined) { const n = toPadNumber(dominance); if (n !== null) nextPad.dominance = clampPad(n); }

  const nextLabel = label === undefined ? s.label : cleanLabel(label);
  const nextReason = reason === undefined ? s.reason : cleanReason(reason);
  const labelChanged = nextLabel !== s.label;

  return {
    ...s,
    pad: {
      pleasure: round3(clampPad(nextPad.pleasure)),
      arousal: round3(clampPad(nextPad.arousal)),
      dominance: round3(clampPad(nextPad.dominance))
    },
    label: nextLabel,
    reason: nextReason,
    since: labelChanged ? now : (s.since || now),
    updatedAt: now
  };
}

// ── 暗流 ────────────────────────────────────────────────────────────────

/** 压一件事进去。weight 是它有多重（0~1），默认 0.3 —— 随口一句的分量。 */
export function ventUndercurrent(state, { text, weight = 0.3, now = Date.now() } = {}) {
  const s = normalizeState(state, now);
  const body = cleanVent(text);
  if (!body) throw new Error('压着的事不能为空');
  if (s.undercurrent.length >= MAX_UNDERCURRENT) {
    throw new Error(`压着的事已达上限（${MAX_UNDERCURRENT} 条），先处理几条`);
  }
  const item = {
    id: newVentId(body + now),
    text: body,
    weight: round3(clamp01(weight)),
    at: now
  };
  return { ...s, undercurrent: [...s.undercurrent, item] };
}

/**
 * 把一条从暗流里拿出来（说出口了，或者自己放下了）。
 * 返回 { state, item }，item 为 null 表示没找到。
 */
export function resolveUndercurrent(state, id, now = Date.now()) {
  const s = normalizeState(state, now);
  const sid = String(id ?? '').trim();
  const index = s.undercurrent.findIndex((item) => item.id === sid);
  if (index < 0) return { state: s, item: null };
  const next = s.undercurrent.slice();
  const [item] = next.splice(index, 1);
  return { state: { ...s, undercurrent: next }, item };
}

/** 暗流总重量。超过 UNDERCURRENT_ALERT 就会在注入里提一句。 */
export function undercurrentLoad(state) {
  const list = Array.isArray(state?.undercurrent) ? state.undercurrent : [];
  return round3(list.reduce((sum, item) => sum + clamp01(item.weight), 0));
}

// ── 好感度 ──────────────────────────────────────────────────────────────

// MARKER: affinity-migrate-set
// setAffinity 已经搬走了 —— 好感度按会话各存一份，写入走 affinity-store.js
// 的 setAffinity(state.affinities, {key, level, note})，由 bridge.js 的
// recordAffinityForKey() 调用。这里留一个显式的墓碑，避免有人以为它还在。

// ── 底色 ────────────────────────────────────────────────────────────────

/**
 * 底色（baseline）—— 长期是个什么样的人。
 *
 * 这里**故意不做自动漂移**，理由有两层，都是踩过的：
 *
 *   1. 自动漂移要一个「她最近的长期情绪」当输入，但这个模块只存得住「最后一次
 *      写入的心情」。拿一次瞬时值当长期平均，等于让一个下午的心情改写性格。
 *   2. 那就先按时间衰减再取？不行 —— 隔 24 小时情绪早就代谢归位了，目标值约等于
 *      底色本身，一辈子也推不动。
 *
 * 所以改成和好感度同一个逻辑：系统不猜她变成了什么样，她自己觉得「我最近好像
 * 容易烦」再调。限速仍保留（一次最多 0.05），防的是手滑，不是防她。
 *
 * 常量 BASELINE_STEP_LIMIT 在文件顶部，这里不重复声明。
 */

export function setBaseline(state, { pleasure, arousal, dominance, now = Date.now() } = {}) {
  const s = normalizeState(state, now);
  const baseline = { ...s.baseline };
  let moved = false;

  const apply = (key, raw) => {
    const n = toPadNumber(raw);
    if (n === null) return;
    const from = baseline[key];
    const step = Math.min(BASELINE_STEP_LIMIT, Math.max(-BASELINE_STEP_LIMIT, n - from));
    const next = round3(clampPad(from + step));
    if (next !== from) moved = true;
    baseline[key] = next;
  };
  apply('pleasure', pleasure);
  apply('arousal', arousal);
  apply('dominance', dominance);

  if (!moved) return { baseline: s.baseline, moved: false, state: s };
  return {
    baseline,
    moved: true,
    state: { ...s, baseline, baselineUpdatedAt: now }
  };
}

// ── 读出来给人看 ────────────────────────────────────────────────────────

/** 把毫秒说成人话。 */
export function formatDuration(ms) {
  const min = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前开始`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前开始`;
  const days = Math.floor(hours / 24);
  return `${days} 天前开始`;
}

/**
 * 当前生效的情绪：衰减后的值 + 已经持续多久 + 暗流/好感度。
 * 这是给 bridge 用的唯一入口 —— 它不写盘，纯读。
 */
/**
 * 当前情绪离底色有多远：三维里偏得最远的那一维。0 = 已经归位。
 *
 * 这是「情绪还在不在」的唯一判据 —— 不用时间戳猜，用衰减后的真实偏离量。
 * 所以「写了一句很强的话，然后隔了一夜」和「昨天写过、今天又提了一句」
 * 得到的是同一个答案：PAD 归位了就是过去了。
 */
export function moodIntensity(state, now = Date.now()) {
  const s = normalizeState(state, now);
  const pad = decayMood(s, now);
  let max = 0;
  for (const key of PAD_KEYS) {
    const gap = Math.abs(Number(pad[key]) - Number(s.baseline[key]));
    if (Number.isFinite(gap) && gap > max) max = gap;
  }
  return round3(max);
}

export function effectiveMood(state, now = Date.now(), opts = {}) {
  const s = normalizeState(state, now);
  const pad = decayMood(s, now);
  const since = s.since || s.updatedAt || now;
  const durationMs = Math.max(0, now - since);
  const intensity = moodIntensity(s, now);
  const minIntensity = Number.isFinite(Number(opts.labelMinIntensity))
    ? Number(opts.labelMinIntensity)
    : DEFAULT_LABEL_MIN_INTENSITY;
  const maxMs = Number.isFinite(Number(opts.labelMaxMs)) && Number(opts.labelMaxMs) > 0
    ? Number(opts.labelMaxMs)
    : DEFAULT_LABEL_MAX_MS;
  // MARKER: mood-fade —— 两个闸：情绪已经归位，或者这个标签挂得太久。
  const faded = intensity < minIntensity || durationMs > maxMs;
  return {
    pad,
    label: s.label,
    reason: s.reason,
    since,
    durationMs,
    intensity,
    faded,
    undercurrent: s.undercurrent.map((item) => ({ ...item })),
    undercurrentLoad: undercurrentLoad(s)
  };
}

/** 底色是偏亮还是偏沉 —— 只有偏得够多才值得说，否则不提。 */
export function describeBaseline(state) {
  const base = normalizeState(state).baseline;
  const pleasure = base.pleasure - DEFAULT_BASELINE.pleasure;
  if (pleasure <= -0.15) return '最近偏沉';
  if (pleasure >= 0.15) return '最近偏亮';
  return '';
}

/**
 * 生成注入文本。三行封顶，**没有数字**。
 *
 * 格式：
 *   【此刻】闷闷的 · 他说自己很没用（40 分钟前开始）
 *   【底色】最近偏沉
 *   【压着】2 件事没说
 *
 * 空的东西整行不出现 —— 不写「无」「暂无」，那只是噪声。
 */
export function describeMood(state, now = Date.now(), opts = {}) {
  const eff = effectiveMood(state, now, opts);
  const lines = [];

  // MARKER: mood-fade —— 「此刻」只写还在的。情绪凉透了整行不出现，
  // 而不是留一句「（4 天前开始）」让她照着念。
  if (eff.label && !eff.faded) {
    const why = eff.reason ? ` · ${eff.reason}` : '';
    lines.push(`【此刻】${eff.label}${why}（${formatDuration(eff.durationMs)}）`);
  }

  const baselineLine = describeBaseline(state);
  if (baselineLine) lines.push(`【底色】${baselineLine}`);

  // 只要压着东西就提一句（她该知道自己心里有未结的事），
  // 压得沉的时候换个说法，但**都不展开内容** —— 要不要翻出来由她自己决定。
  const count = eff.undercurrent.length;
  if (count > 0) {
    const heavy = eff.undercurrentLoad >= UNDERCURRENT_ALERT;
    lines.push(heavy ? `【压着】${count} 件事压得有点沉` : `【压着】${count} 件事没说`);
  }

  return lines.join('\n');
}

/** 自检：给管理端看的几个数。 */
export function moodStats(state, now = Date.now()) {
  const s = normalizeState(state, now);
  const eff = effectiveMood(s, now);
  return {
    version: s.version,
    label: eff.label || '(未设置)',
    pad: eff.pad,
    intensity: eff.intensity,
    faded: eff.faded,
    baseline: s.baseline,
    durationMs: eff.durationMs,
    undercurrentCount: s.undercurrent.length,
    undercurrentLoad: eff.undercurrentLoad,
    // MARKER: affinity-migrate-stats
    // 这里原来报 affinityLevel/hasNote，读的是全局那一份。
    // 全局删了，好感度按会话（state/affinity.json）—— 要看就用
    // GET /api/socialV2/affinity?key=xxx，别在这里塞一个不属于任何人的数。
    updatedAt: s.updatedAt
  };
}
