// 世界事件（world-events）：让「世界会自己往外冒事」真的动起来。
// ---------------------------------------------------------------------------
// 设计四条（每条都是踩过的坑换来的）：
//
// 1) 按天物化，不按时段现编。
//    她必须有稳定的过去：同一天问两次「刚才怎么了」必须同一个答案。
//    所以今天的事在第一次 ensure 时就全部定下来写进账本，之后只读不重抽。
//    —— 这也是为什么它不能塞进 life-timeline.json：那边 settle 每晚 force:true 重排整天，
//    事件跟着被重抽就等于「白天发生的事晚上变了」。
//
// 2) 独立文件 state/world-events.json，不塞进时间线的 env。
//    env 是天气/光线/气味（状态），事件是「发生过什么」（事实 + 时间 + 来源）。
//    生命周期也不同：时间线可重排，事件不可。
//
// 3) 只放行审核过的种子（SEED_CATALOG 是「放行名单」，不是「种子清单」）。
//    种子本身还是主人能在 world.json 里改的，但新加的种子不会自动生效 ——
//    必须在下面的 catalog 里登记过（带上地点/天气/日程约束）才会被生成。
//    这样世界可以继续长，而「什么东西能自动跑起来」始终有一道人工闸门。
//
// 4) fabricateRealPeople:false 是结构保证，不是提示词约束。
//    事件记录里根本没有「人」这个字段；路人只能作为句子内容出现，不能带身份、
//    不能带后续行为、不能被再次引用。close-people 整个切面不进 catalog。
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';

import { dayKeyOf, rngOf, seedOf } from './life-timeline.js';
import { minuteOf, worldDomainsOf, worldEventRulesOf } from './world.js';

export const EVENTS_VERSION = 1;
export const EVENTS_FILE = 'world-events.json';

// 户外地点：用于「必须在外头才能撞见」的种子。
const OUTDOOR = ['楼下', '堤坝', '公园', '巷口'];
// 室内地点：用于「家里/楼里」的种子。
const INDOOR = ['书房', '客厅', '厨房', '阳台', '里间'];

export const EVENT_DEFAULTS = Object.freeze({
  enabled: true,
  // 影子模式默认：只生成、只记日志，不进提示词。要开必须显式打开。
  inject: false,
  // 一天 0~2 条，平均 0.9 条。允许「今天什么都没发生」——
  // 天天有插曲反而不像过日子。
  maxPerDay: 2,
  // 两条之间至少隔 3 小时，别把一天塞成连续剧。
  minGapMinutes: 180,
  keepDays: 14,
  // 注入上限：整段事件补白不超过这么多汉字。
  injectMaxChars: 80
});

// ---------------------------------------------------------------------------
// 放行名单。key = world.json 里种子的原文（改造过的写改造后的文本）。
// 加一条种子到 world.json 却没在这里登记 = 永远不会被生成。
// 字段：
//   where     只能在这些地点的那一格发生（省略 = 不限）
//   weather   当天天气必须是其中之一（省略 = 不限）
//   regime    当天日程模式必须是这个（省略 = 不限）
//   avoid     当前格子的 doing 命中这个正则就跳过（避免和日程撞车）
//   forbid    当前格子的 doing 命中就跳过（更强的排除）
//   before    整格必须在 HH:MM 之前结束（「清晨才发现的事」不能排到下午）
//   after     整格必须在 HH:MM 之后开始
//   emit      生成时替换成这句话（原文用于匹配 world.json，emit 用于输出）
//             例：原文「楼道的灯坏了，回家要走黑楼梯」预设了「回家」，
//             但她可能正下楼 —— emit 改成「上下楼都是黑的」
// ---------------------------------------------------------------------------
const SEED_CATALOG = [
  // ---- nature：天象与环境（5/5 全放行）----
  { text: '海雾起来了，对面楼看不清', domain: 'nature', weather: ['海雾', '阴'] },
  { text: '涨潮把堤坝下面的石阶淹了', domain: 'nature', where: ['堤坝'] },
  { text: '风向变了，阳台上晾的鱼干吹掉一条', domain: 'nature', where: ['阳台'] },
  // 玻璃水气是室内现象，必须限室内；且这是清晨才发现的事，整格要在 10 点前。
  { text: '一夜之间凉下去，玻璃上有了水气', domain: 'nature', where: INDOOR, before: '10:00' },
  { text: '远处有船在雾里拉了一声笛', domain: 'nature', weather: ['海雾'] },

  // ---- dwelling：居所与近邻（放行 4，停用「停水通知」）----
  // 原文是持续状态（「换了新住户，白天在敲东西」），emit 成一次性动静。
  { text: '楼上换了新住户，白天在敲东西', domain: 'dwelling', where: INDOOR, avoid: /睡|午睡/, before: '11:00', emit: '楼上在敲东西，敲了一上午' },
  // 原文会和她 06:40「下楼买早饭」直接撞车，emit 成路过看见。
  { text: '楼下早餐铺歇业一天，卷帘门拉着', domain: 'dwelling', where: ['楼下'], forbid: /买早饭|端回来/, emit: '路过楼下，早餐铺卷帘门拉着' },
  // 原文预设了「回家」，但她可能正下楼。改成不预设方向。
  { text: '楼道的灯坏了，回家要走黑楼梯', domain: 'dwelling', where: ['楼下'], emit: '楼道的灯坏了，上下楼都是黑的' },
  { text: '隔壁把鞋架挪到了公共走道上', domain: 'dwelling', where: INDOOR },

  // ---- livelihood：整块停用 ----
  // 这 5 条是「她的工作状况变了」，属日程内容（settle 的活儿），不是环境事件。
  // 硬塞进这里会和 settle 生成的计划打架，等 P2b 统一处理。

  // ---- close-people：整块停用 ----
  // 真人禁区。老家/旧同学/表姐/长辈背后要么是真人，要么是编出来的亲戚，两种都不行。

  // ---- paths：途中与陌生人（放行 5）----
  { text: '堤坝上有人钓上来一条小的，看了看又放回去', domain: 'paths', where: ['堤坝'] },
  { text: '有人在巷口问她这条路通不通海边', domain: 'paths', where: ['巷口'] },
  // 原文会改她的行动范围（「买菜要绕一个圈」），emit 成听说的。
  { text: '巷口在修路，买菜要绕一个圈', domain: 'paths', where: ['巷口', '楼下'], emit: '听巷口的人说在修路，买菜要绕个圈' },
  // 「公交站」不在 9 个地点里，映射到楼下。
  { text: '公交站有个老太太问她几点了', domain: 'paths', where: ['楼下'], emit: '在楼下等车的时候，有个老太太问她几点了' },
  { text: '有人把共享的推车放在她楼下，没还', domain: 'paths', where: ['楼下'] },

  // ---- chance：小意外与际遇（放行 4，停用「手机屏摔了」）----
  { text: '在堤坝上捡到一把钥匙，挂在栏杆上等人来拿', domain: 'chance', where: ['堤坝'] },
  { text: '买菜多找了两块钱，走了十几米才发现', domain: 'chance', regime: 'market-day' },
  { text: '鞋底开胶了，走到一半才发现', domain: 'chance', where: OUTDOOR },
  // 「旧书摊」不在 9 个地点里，映射到巷口。
  { text: '旧书摊翻到一本，里面有前人的笔记', domain: 'chance', where: ['巷口'], emit: '巷口的旧书摊翻到一本，里面有前人的笔记' }
  // 「手机屏摔了一下，裂缝在角上，还能用」停用：一次性事件留下长期状态，
  // 之后每轮对话都要考虑「她手机还裂着」，污染最重。
];

const CATALOG_BY_TEXT = new Map(SEED_CATALOG.map((x) => [x.text, x]));

function str(value, max = 80) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function num(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  // null/undefined/'' 一律回落默认：Number(null) === 0 会把「没配」变成「配成 0」。
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function hhmm(minute) {
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function eventsCfg(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled !== false,
    inject: src.inject === true,
    maxPerDay: Math.floor(num(src.maxPerDay, EVENT_DEFAULTS.maxPerDay, { min: 0, max: 4 })),
    minGapMinutes: Math.floor(num(src.minGapMinutes, EVENT_DEFAULTS.minGapMinutes, { min: 0, max: 720 })),
    keepDays: Math.floor(num(src.keepDays, EVENT_DEFAULTS.keepDays, { min: 2, max: 120 })),
    injectMaxChars: Math.floor(num(src.injectMaxChars, EVENT_DEFAULTS.injectMaxChars, { min: 20, max: 300 }))
  };
}

/**
 * 这道函数是「代码里强制 fabricateRealPeople:false」的地方。
 * 它在两处被调用：生成时、注入时。任何一条记录只要带人物字段就整条拒绝。
 */
export function isSafeEvent(record) {
  if (!record || typeof record !== 'object') return false;
  const banned = ['people', 'person', 'name', 'names', 'who', 'speaker', 'member', 'target', 'quote'];
  for (const key of banned) {
    if (key in record) return false;
  }
  const text = str(record.text, 200);
  if (!text) return false;
  // 兜底：文本里不许出现「某某说/某某告诉」这类把路人抬成当事人的说法。
  if (/(说|告诉|发消息|打电话给|回我).{0,4}(我|她)/.test(text)) return false;
  return true;
}

function compatible(seed, slot, day) {
  if (!seed || !slot) return false;
  if (Array.isArray(seed.where) && !seed.where.includes(String(slot.where || ''))) return false;
  if (Array.isArray(seed.weather)) {
    const kind = str(day?.env?.weather?.kind, 12);
    if (!kind || !seed.weather.includes(kind)) return false;
  }
  if (seed.regime && str(day?.regimeId, 40) !== seed.regime) return false;
  // before / after 是「这件事只在这个时段成立」。
  // 判定用整格时间窗：要么整格都在截止线之前，要么整格都在起始线之后 ——
  // 否则事件可能落在格子靠后的位置、越过那条线。
  if (seed.before) {
    const cut = minuteOf(seed.before);
    if (cut < 0 || !(Number(slot.toMin) <= cut)) return false;
  }
  if (seed.after) {
    const from = minuteOf(seed.after);
    if (from < 0 || !(Number(slot.fromMin) >= from)) return false;
  }
  const doing = str(slot.doing, 60);
  if (seed.avoid && seed.avoid.test(doing)) return false;
  if (seed.forbid && seed.forbid.test(doing)) return false;
  return true;
}

/**
 * 把 world.json 里登记的种子过一遍放行名单。
 * 未登记（新加的）只记一次日志、不进候选 —— 这就是人工闸门。
 */
export function eligibleSeeds(world, log = null) {
  const domains = worldDomainsOf(world);
  const out = [];
  const unknown = [];
  for (const domain of domains) {
    const key = str(domain?.key, 20);
    const seeds = Array.isArray(domain?.seeds) ? domain.seeds : [];
    for (const raw of seeds) {
      const text = str(raw, 120);
      if (!text) continue;
      const spec = CATALOG_BY_TEXT.get(text);
      if (!spec) {
        unknown.push(text);
        continue;
      }
      out.push(spec);
    }
  }
  if (unknown.length && typeof log === 'function') {
    log(`[world-events] ${unknown.length} 条种子未登记放行名单，跳过：${unknown.slice(0, 3).join(' / ')}`);
  }
  return out;
}

/**
 * 定下「今天发生了什么」。纯确定性：同一天同样的输入必然同样的输出。
 * @returns 事件数组（已按时间排序、已过间隔检查、已过安全校验）
 */
export function planDayEvents(world, { dayKey, day, cfg = EVENT_DEFAULTS, log = null } = {}) {
  const key = str(dayKey, 10) || dayKeyOf();
  const c = eventsCfg(cfg);
  if (!c.enabled || c.maxPerDay <= 0) return [];
  if (!day || !Array.isArray(day.slots) || !day.slots.length) return [];

  // 安全边界：主人可以在 world.json 里写 blockedNames，这里是最后一道。
  const rules = worldEventRulesOf(world);
  const blocked = (rules.blockedNames || []).map((x) => str(x, 20)).filter(Boolean);

  const seeds = eligibleSeeds(world, log);
  if (!seeds.length) return [];

  const rnd = rngOf(seedOf(key, 'events'));
  // 数量分布：20% 没有，55% 一条，25% 两条 —— 期望 1.05，实测会落到 0.7~0.9
  // （因为种子受 where/weather 约束，不是每天都挑得出来；挑不出就空着，不硬凑）。
  const roll = rnd();
  const wanted = roll < 0.2 ? 0 : roll < 0.75 ? 1 : 2;
  const count = Math.min(wanted, c.maxPerDay);

  // 候选池：种子 × 它能在的那个格子。用确定性洗牌，别用 Math.random。
  const pool = [];
  for (const spec of seeds) {
    const slots = day.slots.filter((s) => compatible(spec, s, day));
    if (!slots.length) continue;
    pool.push({ spec, slots });
  }
  if (!pool.length) return [];

  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1)) % (i + 1);
    const t = pool[i];
    pool[i] = pool[j];
    pool[j] = t;
  }

  const picked = [];
  const usedSeed = new Set();
  for (const item of pool) {
    if (picked.length >= count) break;
    if (usedSeed.has(item.spec.text)) continue;
    const slot = item.slots[Math.floor(rnd() * item.slots.length) % item.slots.length];
    const span = Math.max(1, (slot.toMin || 0) - (slot.fromMin || 0));
    // 落在格子靠前的位置：事件是「这一格里发生过的事」。
    const atMin = Math.min(1439, (slot.fromMin || 0) + Math.floor(rnd() * span));
    const record = {
      id: `${key}#${picked.length + 1}`,
      at: hhmm(atMin),
      atMin,
      domain: item.spec.domain,
      // emit 优先：原文是给 world.json 匹配用的，emit 才是念出来的那句话。
      text: str(item.spec.emit || item.spec.text, 80),
      where: str(slot.where, 12),
      slotFrom: str(slot.from, 5),
      slotTo: str(slot.to, 5)
    };
    if (blocked.some((b) => record.text.includes(b))) continue;
    if (!isSafeEvent(record)) continue;
    // 间隔检查：和已挑的比，太近就跳过（不往后挪，挪了就不是「确定的事」）。
    if (picked.some((p) => Math.abs(p.atMin - record.atMin) < c.minGapMinutes)) continue;
    usedSeed.add(item.spec.text);
    picked.push(record);
  }

  return picked.sort((a, b) => a.atMin - b.atMin);
}

export function buildDay(world, { dayKey, day, cfg = EVENT_DEFAULTS, now = Date.now(), log = null } = {}) {
  const key = str(dayKey, 10) || dayKeyOf(now);
  const events = planDayEvents(world, { dayKey: key, day, cfg, log });
  return {
    day: key,
    version: EVENTS_VERSION,
    regimeId: str(day?.regimeId, 40),
    generatedAt: now,
    events
  };
}

export function readEvents(stateDir, { log = null } = {}) {
  const file = path.join(String(stateDir || '.'), EVENTS_FILE);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object') {
      return { version: raw.version || EVENTS_VERSION, days: raw.days };
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') log?.(`[world-events] 读取失败：${error?.message ?? error}`);
  }
  return { version: EVENTS_VERSION, days: {} };
}

export function writeEvents(stateDir, store, { keepDays = EVENT_DEFAULTS.keepDays } = {}) {
  const file = path.join(String(stateDir || '.'), EVENTS_FILE);
  const days = { ...(store?.days || {}) };
  const keys = Object.keys(days).sort();
  const limit = Math.max(2, Math.floor(Number(keepDays) || EVENT_DEFAULTS.keepDays));
  while (keys.length > limit) {
    const drop = keys.shift();
    delete days[drop];
  }
  const out = { version: EVENTS_VERSION, updatedAt: Date.now(), days };
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return out;
}

/**
 * 幂等：当天已有账本就原样返回，绝不重抽。
 * force 只给「明确的修复操作」用，不给普通请求路径用。
 */
export function ensureDay(stateDir, world, { dayKey, day, cfg = EVENT_DEFAULTS, now = Date.now(), log = null, force = false } = {}) {
  const key = str(dayKey, 10) || dayKeyOf(now);
  const store = readEvents(stateDir, { log });
  const existing = store.days[key];
  if (existing && !force) return { day: existing, store, created: false };
  const built = buildDay(world, { dayKey: key, day, cfg, now, log });
  store.days[key] = built;
  const saved = writeEvents(stateDir, store, { keepDays: eventsCfg(cfg).keepDays });
  return { day: built, store: saved, created: true };
}

/** 已经发生的事件（atMin <= 当前分钟）。未来的事一个字都不给模型看。 */
export function eventsSoFar(dayRecord, now = Date.now()) {
  const events = Array.isArray(dayRecord?.events) ? dayRecord.events : [];
  if (!events.length) return [];
  const d = new Date(now);
  const nowMin = d.getHours() * 60 + d.getMinutes();
  return events.filter((e) => Number(e.atMin) <= nowMin && isSafeEvent(e));
}

/**
 * 注入文本。没有事件就返回空串（调用方什么都不加）。
 * 刻意不长：她真实发言 p50 才 22 字，给一段 200 字的世界描述是浪费。
 */
export function eventsLine(dayRecord, now = Date.now(), cfg = EVENT_DEFAULTS) {
  try {
    const c = eventsCfg(cfg);
    const list = eventsSoFar(dayRecord, now);
    if (!list.length) return '';
    const seen = [];
    let budget = c.injectMaxChars;
    for (const e of list) {
      const t = str(e.text, 60);
      if (!t) continue;
      if (t.length + 1 > budget) continue;
      seen.push(t);
      budget -= t.length + 1;
    }
    if (!seen.length) return '';
    const body = seen.join('；');
    return `今天碰上的一点事：${body}。这些是背景，不用主动提，被问到再说。`;
  } catch {
    return '';
  }
}

/** 给日志用的一行摘要。带 ISO 日期 —— 现有日志只有 HH:MM:SS，没法统计「今天几次」。 */
export function describeForLog(dayRecord) {
  const key = str(dayRecord?.day, 10);
  const list = Array.isArray(dayRecord?.events) ? dayRecord.events : [];
  if (!list.length) return `[world-events] day=${key} 今天没事`;
  return `[world-events] day=${key} ${list.length} 条：${list.map((e) => `${e.at} ${e.text}`).join(' / ')}`;
}

export { SEED_CATALOG, INDOOR, OUTDOOR };
