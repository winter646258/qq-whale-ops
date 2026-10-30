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

import fs from 'node:fs';
import path from 'node:path';

export const WORLD_VERSION = 1;
export const WORLD_FILE = 'world.json';

// 文件缺失时的兜底。与 state/world.json 的初始内容一致 ——
// 所以调用方不需要到处判空：readWorld 永远返回一个可用的对象。
export const DEFAULT_WORLD = Object.freeze({
  version: WORLD_VERSION,
  place: {
    city: '南方潮湿小城',
    season: '秋末，梅雨刚走，夜里凉',
    home: {
      floor: 6,
      elevator: false,
      facing: '西',
      rooms: '一室一厅，大桌靠窗，床在里间，灶上只有一口小锅',
      outside: '楼下梧桐，早餐铺的蒸汽，晚归的电动车声',
      keepsake: '一把坐塌了的旧椅子'
    },
    places: [
      { name: '书桌', note: '靠窗，下午晒得到太阳', noise: '楼下有人收废品' },
      { name: '厨房', note: '一口小锅，抽油烟机有点响', noise: '水开了，锅盖在响' },
      { name: '阳台', note: '朝西，晴天才晒被子', noise: '楼道里有脚步声' },
      { name: '里间', note: '床和无靠背的凳子', noise: '冰箱压缩机启动' },
      { name: '楼下', note: '梧桐树底，早餐铺门口', noise: '电动车从身边过去' }
    ]
  },
  body: {
    shape: '不高，圆一点',
    tail: { length: '一米多', sleep: '侧着放，压久了会麻', cold: '怕冷不怕热' },
    habits: ['怕静电', '被拎尾巴会炸', '洗完澡要擦很久']
  },
  day: {
    wake: '08:00',
    sleep: '00:30',
    meals: { morning: '常省', noon: '认真做', evening: '随便' },
    rituals: ['隔天买菜', '晴天才晒被子']
  },
  hobbies: [
    { name: '拼图', note: '一千片的那种，拼到一半就搁着', hours: '夜里' },
    { name: '看比赛', note: '只看关键的，看不懂战术', hours: '' },
    { name: '煎鱼', note: '一直没学会，总破皮', hours: '', aspiration: true }
  ],
  livelihood: '在家接零散的活，改图、写点东西，不富裕但够用',
  self: {
    awareness: 'half',
    knows: ['自己是被造出来的', '主人是认识很久的人'],
    notCare: ['自己是什么型号', '参数多少']
  }
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

/**
 * 把磁盘上的（或模型给的）任意形状洗成可用形状。
 * 原则：**宁可少一条，也不要一条坏的** —— 坏数据会直接变成她嘴里的假话。
 */
export function normalizeWorld(raw) {
  const d = DEFAULT_WORLD;
  const v = raw && typeof raw === 'object' ? raw : {};
  const place = v.place && typeof v.place === 'object' ? v.place : {};
  const home = place.home && typeof place.home === 'object' ? place.home : {};
  const body = v.body && typeof v.body === 'object' ? v.body : {};
  const tail = body.tail && typeof body.tail === 'object' ? body.tail : {};
  const day = v.day && typeof v.day === 'object' ? v.day : {};
  const meals = day.meals && typeof day.meals === 'object' ? day.meals : {};
  const self = v.self && typeof v.self === 'object' ? v.self : {};

  const places = [];
  for (const item of Array.isArray(place.places) ? place.places : d.place.places) {
    const obj = item && typeof item === 'object' ? item : { name: item };
    const name = str(obj.name, 12);
    if (!name) continue;
    if (places.some((p) => p.name === name)) continue;
    places.push({ name, note: str(obj.note, 40), noise: str(obj.noise, 40) });
    if (places.length >= 8) break;
  }

  const hobbies = [];
  for (const item of Array.isArray(v.hobbies) ? v.hobbies : d.hobbies) {
    const obj = item && typeof item === 'object' ? item : { name: item };
    const name = str(obj.name, 12);
    if (!name) continue;
    if (hobbies.some((h) => h.name === name)) continue;
    hobbies.push({
      name,
      note: str(obj.note, 50),
      hours: str(obj.hours, 8),
      aspiration: obj.aspiration === true
    });
    if (hobbies.length >= 12) break;
  }

  const awareness = str(self.awareness, 8);

  return {
    version: WORLD_VERSION,
    place: {
      city: str(place.city, 20) || d.place.city,
      season: str(place.season, 40) || d.place.season,
      home: {
        floor: Math.floor(num(home.floor, d.place.home.floor, { min: 1, max: 60 })),
        elevator: home.elevator === true,
        facing: str(home.facing, 6) || d.place.home.facing,
        rooms: str(home.rooms, 80) || d.place.home.rooms,
        outside: str(home.outside, 80) || d.place.home.outside,
        keepsake: str(home.keepsake, 40) || d.place.home.keepsake
      },
      places: places.length ? places : clone(d.place.places)
    },
    body: {
      shape: str(body.shape, 20) || d.body.shape,
      tail: {
        length: str(tail.length, 12) || d.body.tail.length,
        sleep: str(tail.sleep, 30) || d.body.tail.sleep,
        cold: str(tail.cold, 20) || d.body.tail.cold
      },
      habits: list(body.habits, 8).length ? list(body.habits, 8) : clone(d.body.habits)
    },
    day: {
      wake: str(day.wake, 5) || d.day.wake,
      sleep: str(day.sleep, 5) || d.day.sleep,
      meals: {
        morning: str(meals.morning, 10) || d.day.meals.morning,
        noon: str(meals.noon, 10) || d.day.meals.noon,
        evening: str(meals.evening, 10) || d.day.meals.evening
      },
      rituals: list(day.rituals, 8).length ? list(day.rituals, 8) : clone(d.day.rituals)
    },
    hobbies: hobbies.length ? hobbies : clone(d.hobbies),
    livelihood: str(v.livelihood, 60) || d.livelihood,
    self: {
      awareness: ['none', 'half', 'full'].includes(awareness) ? awareness : d.self.awareness,
      knows: list(self.knows, 8).length ? list(self.knows, 8) : clone(d.self.knows),
      notCare: list(self.notCare, 8).length ? list(self.notCare, 8) : clone(d.self.notCare)
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
    .map((p) => ({ name: str(p?.name, 12), note: str(p?.note, 40), noise: str(p?.noise, 40) }))
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
  return {
    wake: str(day.wake, 5),
    sleep: str(day.sleep, 5),
    meals: { ...DEFAULT_WORLD.day.meals, ...(day.meals && typeof day.meals === 'object' ? day.meals : {}) },
    rituals: list(day.rituals, 8)
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
  return [
    `住处：${w.place.city}，${w.place.season}。${h.floor} 楼${h.elevator ? '有' : '没有'}电梯，朝${h.facing}。${h.rooms}。`,
    `窗外：${h.outside}。屋里留着：${h.keepsake}。`,
    `能去的地方：${places}。`,
    `身体：${w.body.shape}，尾巴${w.body.tail.length}（${w.body.tail.sleep}，${w.body.tail.cold}）。${w.body.habits.join('、')}。`,
    `作息：${d.wake} 起，${d.sleep} 睡；早饭${d.meals.morning}，午饭${d.meals.noon}，晚饭${d.meals.evening}；${d.rituals.join('，')}。`,
    `爱好：${hobbies}。`,
    `营生：${w.livelihood}。`
  ].join('\n');
}

/**
 * 生成器用的硬边界：写进 prompt 让模型别越界，也供代码侧二次校验。
 * 这不是给她看的规矩，是给生成器看的约束。
 */
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
