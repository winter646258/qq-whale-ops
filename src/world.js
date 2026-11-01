// 世界层 §3.0：她住在哪、身体什么样、会什么、不会什么
// ---------------------------------------------------------------------------
// 设计四条（都是踩过的坑）：
// 1) 这份数据**不进提示词**。它是数据库，不是台词。HDSI 的 Canon 也不每轮重念 ——
//    每轮念一遍设定，模型学到的只是「背设定」，不是「过日子」。她要是把
//    「我住在六楼」当台词念，比不说更假。
// 2) 它是生活线的**唯一素材来源**。life-timeline 生成时必须只能从 hobbies/places
//    里取，越界即丢弃，否则她会凭空多出「今天去公司开了一天会」这种她做不了的事。
// 3) 静态部分一年不动，只有 season 这类慢变化由 settle 顺手更新。
// 4) **不写真地名**。只给气候与质感（「南方潮湿小城」），不给城市名 ——
//    给了名字，群友一追问哪条街、几号线就开始露馅。
//
// 与 state/life.json 的分工：life.json 是「今天想怎么过」（每天变），
// world.json 是「她是个什么样的人」（常年不变）。混在一起她说话就变成播报设定。
//
// v2（2026-10-30）新增四块，本文件的归一化是白名单，不加进来就会被整块丢掉：
//   regimes      日程模式（周一~周五 / 周末 / 隔两天的买菜日）
//   exceptions   一次性例外（「楼下贴了停水通知」只改明天那一格）
//   worldDomains 六切面世界事件种子（世界会自己往外冒事）
//   env          现场质感池（天气 / 光线 / 气味 / 无聊池）
//   meta / day.nightOwl / body.tail.tell / place.scale 一并接住。

import fs from 'node:fs';
import path from 'node:path';

export const WORLD_VERSION = 2;
export const WORLD_FILE = 'world.json';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// 文件缺失时的兜底。与 state/world.json 的初始内容一致 ——
// 所以调用方不需要到处判空：readWorld 永远返回一个可用的对象。
export const DEFAULT_WORLD = Object.freeze({
  version: WORLD_VERSION,
  meta: {
    name: '小鲸鱼的世界',
    note: '虚构。地名、店、人都是编的。天气不走真实 API。',
    fantasy: true,
    weatherSource: 'derived'
  },
  place: {
    city: '南方靠海的小城',
    scale: '',
    season: '秋末，雨刚停，白天十八九度，夜里有潮气',
    home: {
      floor: 5,
      elevator: false,
      facing: '东南',
      rooms: '一室一厅，大桌靠窗，床在里间，灶上只有一口小锅',
      outside: '楼下一条马路直通堤坝',
      keepsake: '一把坐塌了的旧木椅'
    },
    places: [
      { name: '书房', note: '靠窗，关上门就是在忙', noise: '楼下有人收废品' },
      { name: '厨房', note: '一口小锅，抽油烟机有点响', noise: '水开了，锅盖在响' },
      { name: '阳台', note: '朝东南，晴天才晒被子', noise: '海风把晾的东西吹得拍栏杆' },
      { name: '里间', note: '床和无靠背的凳子', noise: '冰箱压缩机启动' },
      { name: '楼下', note: '马路边，早餐铺门口', noise: '电动车从身边过去' }
    ]
  },
  body: {
    shape: '不高，圆一点',
    tail: { length: '一米出头', sleep: '侧着放，压久了会麻', cold: '怕冷不怕热', tell: '' },
    habits: ['怕静电', '被拎尾巴会炸', '洗完澡要擦很久']
  },
  day: {
    wake: '06:00',
    sleep: '00:30',
    nightOwl: { probability: 0.2, latestSleep: '03:00', wakeShiftHours: 2, tell: '' },
    meals: { morning: '认真吃', noon: '认真做', evening: '随便' },
    rituals: ['隔天买菜', '晴天才晒被子']
  },
  hobbies: [
    { name: '拼图', note: '一千片的那种，拼到一半就搁着', hours: '夜里' },
    { name: '刷视频', note: '一刷就停不下来', hours: '夜里' },
    { name: '煎鱼', note: '一直没学会，总破皮', hours: '', aspiration: true }
  ],
  livelihood: '在家接零散的活，改图、写点东西，不富裕但够用',
  self: {
    awareness: 'half',
    knows: ['自己是被造出来的', '主人是认识很久的人'],
    notCare: ['自己是什么型号', '参数多少']
  },
  regimes: [],
  exceptions: [],
  worldDomains: [],
  worldEventRules: { fabricateRealPeople: false, blockedNames: [], channels: [], forbidden: [] },
  env: { weatherPool: [], weatherBanned: [], lightByPeriod: {}, smellPool: [], boringPool: [] }
});

function str(value, max = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function num(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  // null/undefined/'' 一律回落默认：Number(null) === 0 会把「没配」变成「配成 0」，
  // pacing.js / settle.js / life.js 都栽过这个坑。
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function list(value, max = 12) {
  const arr = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of arr) {
    const s = str(item, 80);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function timeOr(value, fallback) {
  const s = str(value, 5);
  return HHMM.test(s) ? s : fallback;
}

// MARKER: world-attention-band
// 只做「是不是这四个词」的类型检查；「这个结束点落不落在这格里」是
// life-timeline.expandSlots 的事 —— 世界层不知道格子的边界。
const ATTENTION_BANDS = new Set(['asleep', 'focused', 'occupied', 'available']);
function bandOr(value, fallback = '') {
  const s = str(value, 12).toLowerCase();
  if (s === 'sleep') return 'asleep';
  return ATTENTION_BANDS.has(s) ? s : fallback;
}

/** 每分钟数，只用来比较顺序；非法返回 -1。 */
export function minuteOf(hhmm) {
  const s = str(hhmm, 5);
  if (!HHMM.test(s)) return -1;
  const [h, m] = s.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * 把磁盘上的（或模型给的）任意形状洗成可用形状。
 * 原则：**宁可少一条，也不要一条坏的** —— 坏数据会直接变成她嘴里的假话。
 */
export function normalizeWorld(raw) {
  const d = DEFAULT_WORLD;
  const v = obj(raw);
  const meta = obj(v.meta);
  const place = obj(v.place);
  const home = obj(place.home);
  const body = obj(v.body);
  const tail = obj(body.tail);
  const day = obj(v.day);
  const nightOwl = obj(day.nightOwl);
  const meals = obj(day.meals);
  const self = obj(v.self);

  const places = [];
  for (const item of Array.isArray(place.places) ? place.places : d.place.places) {
    const o = item && typeof item === 'object' ? item : { name: item };
    const name = str(o.name, 12);
    if (!name) continue;
    if (places.some((p) => p.name === name)) continue;
    places.push({ name, note: str(o.note, 60), noise: str(o.noise, 60) });
    if (places.length >= 12) break;
  }
  const finalPlaces = places.length ? places : clone(d.place.places);
  const placeNames = new Set(finalPlaces.map((p) => p.name));

  const hobbies = [];
  for (const item of Array.isArray(v.hobbies) ? v.hobbies : d.hobbies) {
    const o = item && typeof item === 'object' ? item : { name: item };
    const name = str(o.name, 12);
    if (!name) continue;
    if (hobbies.some((h) => h.name === name)) continue;
    hobbies.push({
      name,
      note: str(o.note, 60),
      hours: str(o.hours, 8),
      aspiration: o.aspiration === true
    });
    if (hobbies.length >= 16) break;
  }

  const awareness = str(self.awareness, 8);

  // ---- regimes：日程模式。where 不在 places 里的整格丢掉（宁可少一格，也不让她去不存在的地方）
  const regimes = [];
  for (const item of Array.isArray(v.regimes) ? v.regimes : []) {
    const r = obj(item);
    const id = str(r.id, 24);
    if (!id) continue;
    if (regimes.some((x) => x.id === id)) continue;
    const days = [];
    for (const dv of Array.isArray(r.days) ? r.days : []) {
      const n = Number(dv);
      if (Number.isInteger(n) && n >= 0 && n <= 6 && !days.includes(n)) days.push(n);
    }
    const blocks = [];
    for (const bv of Array.isArray(r.blocks) ? r.blocks : []) {
      const b = obj(bv);
      const from = timeOr(b.from, '');
      const to = timeOr(b.to, '');
      const where = str(b.where, 12);
      if (!from || !to) continue;
      if (!where || !placeNames.has(where)) continue;
      blocks.push({
        from,
        to,
        where,
        doing: str(b.doing, 60),
        body: str(b.body, 60),
        interruptible: num(b.interruptible, 0.8, { min: 0, max: 1 }),
        attentionBand: bandOr(b.attentionBand),
        busyUntil: timeOr(b.busyUntil, '')
      });
      if (blocks.length >= 24) break;
    }
    const insertIn = obj(r.insert);
    const insert = timeOr(insertIn.from, '') && timeOr(insertIn.to, '') && placeNames.has(str(insertIn.where, 12))
      ? {
        from: timeOr(insertIn.from, ''),
        to: timeOr(insertIn.to, ''),
        where: str(insertIn.where, 12),
        doing: str(insertIn.doing, 60),
        body: str(insertIn.body, 60),
        interruptible: num(insertIn.interruptible, 0.9, { min: 0, max: 1 }),
        attentionBand: bandOr(insertIn.attentionBand),
        busyUntil: timeOr(insertIn.busyUntil, '')
      }
      : null;
    regimes.push({
      id,
      label: str(r.label, 24),
      days,
      chance: num(r.chance, 1, { min: 0, max: 1 }),
      blocks,
      insert
    });
    if (regimes.length >= 8) break;
  }

  // ---- exceptions：一次性例外。形状留全，具体条目由世界事件或她自己的话生成
  const exceptions = [];
  for (const item of Array.isArray(v.exceptions) ? v.exceptions : []) {
    const e = obj(item);
    const id = str(e.id, 32);
    const date = str(e.date, 10);
    if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const patch = obj(e.patch);
    const where = str(patch.where, 12);
    exceptions.push({
      id,
      date,
      kind: ['modify', 'skip', 'insert'].includes(str(e.kind, 8)) ? str(e.kind, 8) : 'modify',
      target: str(e.target, 24),
      note: str(e.note, 80),
      reason: str(e.reason, 60),
      patch: {
        from: timeOr(patch.from, ''),
        to: timeOr(patch.to, ''),
        where: where && placeNames.has(where) ? where : '',
        doing: str(patch.doing, 60),
        body: str(patch.body, 60)
      }
    });
    if (exceptions.length >= 60) break;
  }

  // ---- worldDomains：六切面种子
  const worldDomains = [];
  for (const item of Array.isArray(v.worldDomains) ? v.worldDomains : []) {
    const dm = obj(item);
    const key = str(dm.key, 24);
    if (!key) continue;
    if (worldDomains.some((x) => x.key === key)) continue;
    worldDomains.push({
      key,
      label: str(dm.label, 16),
      seeds: list(dm.seeds, 20)
    });
    if (worldDomains.length >= 10) break;
  }

  // ---- worldEventRules：硬边界。默认就禁止编真人，写错也翻不回来
  const rules = obj(v.worldEventRules);
  const worldEventRules = {
    fabricateRealPeople: false,
    note: str(rules.note, 120),
    blockedNames: list(rules.blockedNames, 24),
    channels: list(rules.channels, 12),
    forbidden: list(rules.forbidden, 12)
  };

  // ---- env：现场质感池
  const env = obj(v.env);
  const weatherPool = [];
  for (const item of Array.isArray(env.weatherPool) ? env.weatherPool : []) {
    const w = obj(item);
    const kind = str(w.kind, 8);
    if (!kind) continue;
    if (weatherPool.some((x) => x.kind === kind)) continue;
    weatherPool.push({ kind, temp: str(w.temp, 12), note: str(w.note, 40) });
    if (weatherPool.length >= 10) break;
  }
  const lightByPeriod = {};
  for (const [k, val] of Object.entries(obj(env.lightByPeriod))) {
    const key = str(k, 8);
    const s = str(val, 60);
    if (key && s) lightByPeriod[key] = s;
  }

  return {
    version: WORLD_VERSION,
    meta: {
      name: str(meta.name, 24) || d.meta.name,
      note: str(meta.note, 160) || d.meta.note,
      fantasy: meta.fantasy === true,
      weatherSource: ['derived', 'api', 'none'].includes(str(meta.weatherSource, 8))
        ? str(meta.weatherSource, 8)
        : 'derived'
    },
    place: {
      city: str(place.city, 30) || d.place.city,
      scale: str(place.scale, 40),
      season: str(place.season, 40) || d.place.season,
      home: {
        floor: Math.floor(num(home.floor, d.place.home.floor, { min: 1, max: 60 })),
        elevator: home.elevator === true,
        facing: str(home.facing, 6) || d.place.home.facing,
        rooms: str(home.rooms, 100) || d.place.home.rooms,
        outside: str(home.outside, 100) || d.place.home.outside,
        keepsake: str(home.keepsake, 40) || d.place.home.keepsake
      },
      places: finalPlaces
    },
    body: {
      shape: str(body.shape, 20) || d.body.shape,
      tail: {
        length: str(tail.length, 12) || d.body.tail.length,
        sleep: str(tail.sleep, 40) || d.body.tail.sleep,
        cold: str(tail.cold, 20) || d.body.tail.cold,
        tell: str(tail.tell, 40)
      },
      habits: list(body.habits, 8).length ? list(body.habits, 8) : clone(d.body.habits)
    },
    day: {
      wake: timeOr(day.wake, d.day.wake),
      sleep: timeOr(day.sleep, d.day.sleep),
      nightOwl: {
        probability: num(nightOwl.probability, 0, { min: 0, max: 1 }),
        latestSleep: timeOr(nightOwl.latestSleep, '03:00'),
        wakeShiftHours: num(nightOwl.wakeShiftHours, 0, { min: 0, max: 6 }),
        tell: str(nightOwl.tell, 60)
      },
      meals: {
        morning: str(meals.morning, 16) || d.day.meals.morning,
        noon: str(meals.noon, 16) || d.day.meals.noon,
        evening: str(meals.evening, 16) || d.day.meals.evening
      },
      rituals: list(day.rituals, 8).length ? list(day.rituals, 8) : clone(d.day.rituals)
    },
    hobbies: hobbies.length ? hobbies : clone(d.hobbies),
    livelihood: str(v.livelihood, 80) || d.livelihood,
    self: {
      awareness: ['none', 'half', 'full'].includes(awareness) ? awareness : d.self.awareness,
      knows: list(self.knows, 8).length ? list(self.knows, 8) : clone(d.self.knows),
      notCare: list(self.notCare, 8).length ? list(self.notCare, 8) : clone(d.self.notCare)
    },
    regimes,
    exceptions,
    worldDomains,
    worldEventRules,
    env: {
      weatherPool,
      weatherBanned: list(env.weatherBanned, 12),
      lightByPeriod,
      smellPool: list(env.smellPool, 12),
      boringPool: list(env.boringPool, 40)
    }
  };
}

let cache = { key: '', world: null };

/**
 * 读世界数据。按 mtime 缓存 —— 主人改 world.json 不需要重启 bridge。
 * 文件不存在/坏了都退回 DEFAULT_WORLD，绝不抛错（她说话不能因为一个数据文件缺席就崩）。
 */
export function readWorld(stateDir, { now = Date.now(), log = null } = {}) {
  const file = path.join(String(stateDir || '.'), WORLD_FILE);
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    stat = null;
  }
  if (!stat) {
    cache = { key: 'missing', world: normalizeWorld(DEFAULT_WORLD) };
    return cache.world;
  }
  const key = `${file}|${stat.mtimeMs}|${stat.size}`;
  if (cache.world && cache.key === key) return cache.world;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache = { key, world: normalizeWorld(parsed) };
  } catch (error) {
    // 坏文件比没文件更危险（半截 JSON 会让她一整天说不出自己的住处），
    // 所以退回默认值并只记一次日志，不重试、不重写。
    log?.(`[world] ${file} 读取失败，用默认世界观：${error?.message ?? error}`);
    cache = { key, world: normalizeWorld(DEFAULT_WORLD) };
  }
  return cache.world;
}

/** 首次启动把建议值落盘，主人才有东西可改。已存在则不动。 */
export function seedWorld(stateDir, { overwrite = false } = {}) {
  const file = path.join(String(stateDir || '.'), WORLD_FILE);
  if (!overwrite) {
    try {
      fs.statSync(file);
      return { ok: false, reason: 'exists', file };
    } catch {
      // 不存在，继续写
    }
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(DEFAULT_WORLD, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  cache = { key: '', world: null };
  return { ok: true, file };
}

/** 她「会」的事：只在生活线里能出现的行为。 */
export function hobbyNames(world) {
  const w = world && typeof world === 'object' ? world : DEFAULT_WORLD;
  return (Array.isArray(w.hobbies) ? w.hobbies : []).map((h) => str(h?.name, 12)).filter(Boolean);
}

/** 她「能去」的地方：生活线的 where 只能从这里取。 */
export function placesOf(world) {
  const w = world && typeof world === 'object' ? world : DEFAULT_WORLD;
  const arr = Array.isArray(w?.place?.places) ? w.place.places : [];
  return arr
    .map((p) => ({ name: str(p?.name, 12), note: str(p?.note, 60), noise: str(p?.noise, 60) }))
    .filter((p) => p.name);
}

export function placeByName(world, name) {
  const target = str(name, 12);
  if (!target) return null;
  return placesOf(world).find((p) => p.name === target) || null;
}

/** 作息：生活线要按这个排「几点睡、几点起」。 */
export function dayOf(world) {
  const w = world && typeof world === 'object' ? world : DEFAULT_WORLD;
  const day = w.day && typeof w.day === 'object' ? w.day : DEFAULT_WORLD.day;
  const owl = day.nightOwl && typeof day.nightOwl === 'object' ? day.nightOwl : {};
  return {
    wake: str(day.wake, 5),
    sleep: str(day.sleep, 5),
    nightOwl: {
      probability: num(owl.probability, 0, { min: 0, max: 1 }),
      latestSleep: timeOr(owl.latestSleep, '03:00'),
      wakeShiftHours: num(owl.wakeShiftHours, 0, { min: 0, max: 6 }),
      tell: str(owl.tell, 60)
    },
    meals: { ...DEFAULT_WORLD.day.meals, ...(day.meals && typeof day.meals === 'object' ? day.meals : {}) },
    rituals: list(day.rituals, 8)
  };
}

/** 日程模式（已归一化）。 */
export function regimesOf(world) {
  const w = world && typeof world === 'object' ? world : DEFAULT_WORLD;
  return Array.isArray(w.regimes) ? w.regimes : [];
}

/** 一次性例外（已归一化）。 */
export function exceptionsOf(world) {
  const w = world && typeof world === 'object' ? world : DEFAULT_WORLD;
  return Array.isArray(w.exceptions) ? w.exceptions : [];
}

/** 六切面世界事件种子。 */
export function worldDomainsOf(world) {
  const w = world && typeof world === 'object' ? world : DEFAULT_WORLD;
  return Array.isArray(w.worldDomains) ? w.worldDomains : [];
}

/** 世界事件的硬边界（永远 fabricateRealPeople:false）。 */
export function worldEventRulesOf(world) {
  const w = world && typeof world === 'object' ? world : DEFAULT_WORLD;
  const r = w.worldEventRules && typeof w.worldEventRules === 'object' ? w.worldEventRules : {};
  return {
    fabricateRealPeople: false,
    note: str(r.note, 120),
    blockedNames: Array.isArray(r.blockedNames) ? r.blockedNames : [],
    channels: Array.isArray(r.channels) ? r.channels : [],
    forbidden: Array.isArray(r.forbidden) ? r.forbidden : []
  };
}

/** 现场质感池（天气 / 光线 / 气味 / 无聊）。 */
export function envPools(world) {
  const w = world && typeof world === 'object' ? world : DEFAULT_WORLD;
  const e = w.env && typeof w.env === 'object' ? w.env : {};
  return {
    weatherPool: Array.isArray(e.weatherPool) ? e.weatherPool : [],
    weatherBanned: Array.isArray(e.weatherBanned) ? e.weatherBanned : [],
    lightByPeriod: e.lightByPeriod && typeof e.lightByPeriod === 'object' ? e.lightByPeriod : {},
    smellPool: Array.isArray(e.smellPool) ? e.smellPool : [],
    boringPool: Array.isArray(e.boringPool) ? e.boringPool : []
  };
}

/**
 * 给**生活线生成器**看的简报（不是聊天提示词，别接到 buildWakePromptV2 里）。
 * 生成器的任务是「用这些素材排她的一天」，所以这里要全；聊天那边一个字都不进。
 */
export function worldBrief(world) {
  const w = normalizeWorld(world && typeof world === 'object' ? world : DEFAULT_WORLD);
  const h = w.place.home;
  const places = w.place.places.map((p) => (p.note ? `${p.name}（${p.note}）` : p.name)).join('、');
  const hobbies = w.hobbies
    .map((x) => (x.note ? `${x.name}——${x.note}` : x.name))
    .join('；');
  const d = w.day;
  const lines = [
    `住处：${w.place.city}${w.place.scale ? `，${w.place.scale}` : ''}，${w.place.season}。${h.floor} 楼${h.elevator ? '有' : '没有'}电梯，朝${h.facing}。${h.rooms}。`,
    `窗外：${h.outside}。屋里留着：${h.keepsake}。`,
    `能去的地方：${places}。`,
    `身体：${w.body.shape}，尾巴${w.body.tail.length}（${w.body.tail.sleep}，${w.body.tail.cold}）。${w.body.habits.join('、')}。`,
    `作息：${d.wake} 起，${d.sleep} 睡${d.nightOwl.probability > 0 ? `；五次里约有 ${Math.round(d.nightOwl.probability * 5)} 次会熬到 ${d.nightOwl.latestSleep}` : ''}；早饭${d.meals.morning}，午饭${d.meals.noon}，晚饭${d.meals.evening}；${d.rituals.join('，')}。`,
    `爱好：${hobbies}。`,
    `营生：${w.livelihood}。`
  ];
  if (w.regimes.length) {
    lines.push(`日常模式：${w.regimes.map((r) => `${r.label || r.id}（${r.blocks.length} 段）`).join('；')}。`);
  }
  if (w.worldDomains.length) {
    lines.push(`世界会冒事的方向：${w.worldDomains.map((x) => x.label || x.key).join('、')}。`);
  }
  return lines.join('\n');
}

/**
 * 生成器用的硬边界：写进 prompt 让模型别越界，也供代码侧二次校验。
 * 这不是给她看的规矩，是给生成器看的约束。
 */
/**
 * 「家」的稳定锚点 —— 只留常年不变的空间事实。
 * MARKER: home-brief
 *
 * 为什么单独开一个函数：worldBrief() 有 900 字符，其中身体 / 作息 / 爱好 / 营生
 * 在角色卡和生活线里各有一份，每轮再注入一遍等于白花钱；而真正让她「有个家」的
 * 那几样（一室一厅、大桌横在窗下、窗外直通堤坝、坐塌的旧木椅）反而一次都没进过
 * 提示词 —— 她只知道此刻在客厅烧水，不知道家是什么样。
 *
 * 四条边界：
 * 1) 不收 place.season。它混着「白天十八九度，夜里有潮气」这类易变信息，和当天的
 *    env 会打架。当下现场（天气/光线/气味）以生活线为准，这里只给稳定的。
 * 2) 不收 regimes 的段数。那是给排程器看的，对模型没有语义价值。
 * 3) 不收 body / hobbies / livelihood。角色卡里已经写全，重复注入只会稀释注意力。
 * 4) 目标 300~400 字符。超了先砍地点 note 里区分度低的，不砍户型 —— 户型是
 *    「家」这个概念本身，地点只是门牌。
 */
export function homeBrief(world) {
  const w = normalizeWorld(world && typeof world === 'object' ? world : DEFAULT_WORLD);
  const h = w.place.home;
  const places = w.place.places
    .map((p) => (p.note ? `${p.name}（${p.note}）` : p.name))
    .join('、');
  const head = `【你的住处】${w.place.city}${w.place.scale ? `，${w.place.scale}` : ''}。`
    + `住在 ${h.floor} 楼，${h.elevator ? '有' : '没有'}电梯，朝${h.facing}。${h.rooms}。`;
  const tail = `窗外：${h.outside}。`
    + `屋里留着：${h.keepsake}。`
    + `附近可去：${places}。`
    + '这是稳定背景，相关时自然提到就好，不用整段念；此刻的天气和你在做什么，以后面那条为准。\n\n';
  return head + tail;
}

export function worldBounds(world) {
  const names = hobbyNames(world);
  const places = placesOf(world).map((p) => p.name);
  return {
    hobbies: names,
    places,
    line: `只能写这些爱好之内的事（${names.join('、')}），只能在这些地方或从这里出发（${places.join('、')}）。`
      + '不要出现上班、开会、通勤、课堂教学、健身房、旅行度假、开车这类她做不到的事；'
      + '不要出现任何真实城市名、街道名、店名、公司名。'
  };
}

/** 自我认知档位：P5 重写角色卡时要读它。 */
export function selfOf(world) {
  const w = world && typeof world === 'object' ? world : DEFAULT_WORLD;
  const s = w.self && typeof w.self === 'object' ? w.self : DEFAULT_WORLD.self;
  return {
    awareness: ['none', 'half', 'full'].includes(str(s.awareness, 8)) ? s.awareness : 'half',
    knows: list(s.knows, 8),
    notCare: list(s.notCare, 8)
  };
}
