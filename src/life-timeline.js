// 生活线 §3.1：她此刻在哪儿、手上是什么、能不能被打断
// ---------------------------------------------------------------------------
// 为什么要它：现在提示词里只有 life.json 那三条「今天想干嘛」，那是**计划**，
// 不是**此刻**。她答「你现在干嘛」，只能照计划念 —— 一天里答几次都一样，
// 这就露馅了。生活线补的是「格」：几点到几点、在哪间屋、手上什么事、身体什么状态。
//
// 三条设计纪律（抄 HDSI 的，但那三条是对的）：
// 1) **只投影当天，最多到下一格**。不预告明天、不预告晚上八点以后 —— 提前播报
//    会让她说「我一会儿要去堤坝」然后真到点又不去，谎越撒越大。
// 2) **模式与例外分离**。日常骨架来自 world.regimes（一周不变），
//    临时变化走 exceptions（停水、来客），不每天重排。
// 3) **素材只能来自 world**。where 必须在 world.place.places 里，
//    爱好必须在 world.hobbies 里。越界即丢，否则她会冒出「今天去公司开了会」。
//
// 确定性：同一格在同一天里被问多少次，答案必须一样。所以「挑哪条无聊事」
// 「今天熬不熬夜」都由日期种子决定，不用 Math.random。

import fs from 'node:fs';
import path from 'node:path';
import {
  dayOf,
  envPools,
  exceptionsOf,
  minuteOf,
  placeByName,
  placesOf,
  regimesOf,
  readWorld
} from './world.js';

export const TL_VERSION = 1;
export const TIMELINE_FILE = 'life-timeline.json';
const KEEP_DAYS = 14;

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 什么算「正事」：在书房、且明确说了不好打断。这个判定只用来保证
// 「不能连续两个正事块」—— 她一天到晚都在干活，那是最塑料的写法。
const isWork = (slot) => slot.where === '书房' && slot.interruptible <= 0.6;

// 什么算「闲」：能被打断 0.85 以上、又不是吃饭睡觉。无聊块从这里挑。
const isIdle = (slot) =>
  slot.interruptible >= 0.85 && !['里间', '厨房'].includes(slot.where);


/**
 * 从一句计划里猜她会在哪做。
 *
 * 为什么必须猜：life.json 的 plan 是 settle 写的纯文本（「煮一锅白饭配咸菜」），
 * 没有地点。不猜就会按「上午/下午/晚上」盲配 —— 实测把「煮白饭」排进了
 * 09:00–11:30 书房正经干活那格，她一边「腾不出手」一边在书房煮饭。
 */
const PLACE_HINTS = [
  ['厨房', /煮|煎|炒|熬|炖|蒸|烤|做饭|做菜|下锅|一锅|白饭|米饭|配(一|个|咸)|洗碗|洗锅|烧水|盛|尝|鱼/],
  ['阳台', /晒|晾|挪去|搬到|花|浇|窗台/],
  ['堤坝', /堤|海|潮|风口|看海/],
  ['公园', /公园|湖|绕一圈|下棋|溜达/],
  ['巷口', /巷口|逛街|逛|小店|铺子|菜场|买菜/],
  ['客厅', /电视|游戏|手柄|投屏|刷视频|沙发/],
  ['里间', /床|躺|睡|被|枕头/],
  ['书房', /书|读|翻页|画|改图|排版|接活|电脑|桌/]
];
export function guessPlaceOf(text) {
  const s = str(text, 80);
  if (!s) return '';
  for (const [place, re] of PLACE_HINTS) if (re.test(s)) return place;
  return '';
}

/**
 * 「这格已经有自己的说法了」——world.json 里 regime 写的 doing 都很具体
 * （「吃完饭往堤上走，走十分钟又回来」），不该被爱好或无聊事覆盖。
 * 只有空、太短、或者是通用占位的东西才算没说法。
 */
const PLACEHOLDER_DOING = /^(待着|闲着|随便|干点活|做点事|没事|休息|放松|自由活动|刷刷手机)?$/;

/** 固定块：起床 / 三顿饭 / 洗漱。谁都不许顶掉 —— 顶了她就不吃饭了。 */
const PROTECTED_DOING = /醒|睡|赖着|早饭|早饭|午饭|晚饭|吃饭|做饭|端回来|洗澡|刷牙|洗漱|烧水|洗碗/;

/**
 * 无聊事的场景相容。无聊池是通用的（「蹲在冰箱前面看有什么能吃的」），
 * 但摊到「堤坝」那格就成了笑话：她会站在海堤上开冰箱。
 * 所以含室内物件的只在室内用，含户外地点的只在户外用。
 */
const INDOOR_PROP = /冰箱|洗衣|晾|抽屉|窗台|椅子|床|镜子|电视|游戏机|桌角|柜|壶|锅|碗|碟|插头|充电|吹风机|头发|洗澡|洗了|刷牙|换衣服|衣柜/;
const OUTDOOR_SPOT = /早餐铺|楼下|街上|巷|摊/;
const DOWNSTAIRS_ONLY = /早餐铺|楼下|收废品/;
const INDOOR_ONLY = /对面楼|亮着灯|冰箱|洗衣|抽屉|镜子|柜|衣柜|桌角/;
const OUTDOOR_PLACES = ['堤坝', '公园', '巷口', '楼下'];
function boringFits(text, where) {
  const w = String(where ?? '');
  const outdoor = OUTDOOR_PLACES.includes(w);
  if (INDOOR_PROP.test(text) && outdoor) return false;
  if (OUTDOOR_SPOT.test(text) && !outdoor) return false;
  // 「在早餐铺门口站着」发生在楼下，不该出现在公园；「数对面楼亮着几盏灯」得在屋里或阳台。
  if (DOWNSTAIRS_ONLY.test(text) && w !== '楼下') return false;
  if (INDOOR_ONLY.test(text) && outdoor) return false;
  return true;
}
function hasOwnWords(slot) {
  const d = str(slot?.doing, 60);
  if (!d) return false;
  if (PLACEHOLDER_DOING.test(d)) return false;
  if (d.length < 8) return false;
  // 已经带爱好/无聊标记的，算有说法
  if (slot.hobby || slot.boring) return true;
  return true;
}

function str(value, max = 120) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function num(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 本地日期键 YYYY-MM-DD（she 的时区就是机器时区）。 */
export function dayKeyOf(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 把 dayKey 变回本地零点毫秒。 */
export function dayStartOf(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(dayKey, 10));
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime();
}

/** 确定性 32 位散列：同一天同一个种子永远得到同一个序列。 */
export function seedOf(dayKey, salt = '') {
  const s = `${dayKey}|${salt}`;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** 由种子生成 [0,1) 序列，不改全局状态。 */
export function rngOf(seed) {
  let x = (seed || 1) >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

/** 从数组里按种子挑一个（空数组返回 null）。 */
export function pick(arr, rnd) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr[Math.floor(rnd() * arr.length) % arr.length];
}

const toMin = (hhmm) => minuteOf(hhmm);
const toHHMM = (min) => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** 时段名：用来选光线、也用来给提示词分「上午/下午/傍晚」。 */
export function periodOf(hhmm) {
  const m = toMin(hhmm);
  if (m < 0) return '上午';
  if (m < 5 * 60) return '夜里';
  if (m < 9 * 60) return '清晨';
  if (m < 12 * 60) return '上午';
  if (m < 17 * 60) return '下午';
  if (m < 20 * 60) return '傍晚';
  return '夜里';
}

/**
 * 时段在一天里的先后顺序 —— 只用来比较「两格差多远」，不参与展示。
 * MARKER: period-order
 * 起因（2026-11-01 实测）：11-02「晚上 多摆几个角度比新头像，早点睡」
 * 被排到了 06:00 清晨那一格。查下来是 weavePlans 的兜底「同地点优先」
 * 无条件让路，哪怕时段差了三档 —— 地点对了，时间荒谬，一样是错的。
 */
export const PERIOD_ORDER = ['清晨', '上午', '下午', '傍晚', '夜里'];

export function periodIndex(hhmm) {
  const i = PERIOD_ORDER.indexOf(periodOf(hhmm));
  return i < 0 ? 1 : i;
}

/**
 * 今天用哪个日程模式。
 *
 * 顺序：先按星期几筛候选；常驻型（chance >= 1）优先；
 * 只有条件型时按日期种子掷一次，掷中才算数。
 *
 * MARKER: regime-chance —— 旧实现是
 *   const usable = candidates.filter((r) => r.chance >= 1 || rnd() < r.chance);
 *   const pool = usable.length ? usable : candidates;
 * 兜底把「掷不中的条件型」又放回候选，而 pool[0] 永远取到排在前面的
 * 常驻型 —— 等于把 chance 当摆设。实测「买菜日（chance 0.5）」连算 14 天一次没选中；
 * 而且它 blocks 为空、只有一条 insert，真选中反而会得到「只有一格的一天」。
 * 现在没有条件型模式了；以后真要加，必须同时给它一份完整 blocks。
 */
export function pickRegime(world, dayKey, now = Date.now()) {
  const regimes = regimesOf(world);
  if (!regimes.length) return null;
  const start = dayStartOf(dayKey);
  // dayKey 非法就明确放弃，不偷偷用运行时日期去猜星期几（会不确定）。
  if (!Number.isFinite(start)) return null;
  const weekday = new Date(start).getDay();
  const candidates = regimes.filter((r) => r.days.includes(weekday));
  // 没有匹配当天星期几的模式，就说没有 —— 不要乱选一个不适用的日型。
  if (!candidates.length) return null;
  const steady = candidates.filter((r) => num(r.chance, 1, { min: 0, max: 1 }) >= 1);
  if (steady.length) return steady[0];
  const rnd = rngOf(seedOf(dayKey, 'regime'));
  const rolled = candidates.filter((r) => rnd() < num(r.chance, 0, { min: 0, max: 1 }));
  return rolled.length ? rolled[0] : null;
}

/**
 * 把 regime 的 blocks 展开成当天的格子，并套上 exceptions。
 * 合法性硬校验（不合法当场丢格，不修补）：
 *   - from/to 都合法、from < to（跨零点用 24:00 表示）
 *   - where 在 world.place.places 里
 * 结果按开始时间排序，并且**不留缝**（后一格从前一格结束处开始）。
 */
export function expandSlots(world, regime, dayKey) {
  const placeNames = new Set(placesOf(world).map((p) => p.name));
  const raw = [];
  const pushSlot = (b, extra = {}) => {
    const from = toMin(b.from);
    let to = toMin(b.to);
    if (from < 0 || to < 0) return false;
    // 跨零点：21:00→00:30 是合法的一格（她夜里那格本来就拖过 12 点）。
    // 但只有「跨度合理」才认 —— 22:00→21:00 这种写反的会被加成 23 小时，必须丢。
    if (to <= from) to += 1440;
    if (to - from > 8 * 60) return false;
    const where = str(b.where, 12);
    if (!placeNames.has(where)) return false;
    raw.push({
      from: str(b.from, 5),
      to: str(b.to, 5),
      fromMin: from,
      toMin: to,
      where,
      doing: str(b.doing, 60),
      body: str(b.body, 60),
      interruptible: num(b.interruptible, 0.8, { min: 0, max: 1 }),
      reason: '',
      unfinished: false,
      attentionBand: normalizeAttentionBand(b.attentionBand),
      busyUntil: normalizeBusyUntil(b.busyUntil, from, to),
      ...extra
    });
    return true;
  };
  for (const b of Array.isArray(regime?.blocks) ? regime.blocks : []) pushSlot(b);
  raw.sort((a, b) => a.fromMin - b.fromMin);

  // insert 型模式（买菜日）：自己没骨架，就挂到「同一天能匹配上的模式的格子」上，
  // 或者干脆只留这一格 —— 由调用方决定要不要单独用。
  if (!raw.length && regime?.insert) pushSlot(regime.insert);

  // 套例外
  for (const e of exceptionsOf(world)) {
    if (e.date !== dayKey) continue;
    if (e.kind === 'skip') continue;      // skip 只在下面按 target 处理
    const from = toMin(e.patch?.from);
    const to = toMin(e.patch?.to);
    const where = str(e.patch?.where, 12);
    if (from < 0 || to <= from) continue;
    if (where && !placeNames.has(where)) continue;
    // 找出被覆盖的格子，整格替换（不做局部缝补 —— 缝补会混两种语气）
    const keep = raw.filter((s) => s.toMin <= from || s.fromMin >= to);
    keep.push({
      from: e.patch.from,
      to: e.patch.to,
      fromMin: from,
      toMin: to,
      where: where || '楼下',
      doing: str(e.patch.doing, 60) || str(e.note, 60),
      body: str(e.patch.body, 60),
      interruptible: num(e.patch.interruptible, 0.8, { min: 0, max: 1 }),
      reason: str(e.reason, 60),
      unfinished: false,
      attentionBand: normalizeAttentionBand(e.patch?.attentionBand),
      busyUntil: normalizeBusyUntil(e.patch?.busyUntil, from, to)
    });
    raw.length = 0;
    raw.push(...keep.sort((a, b) => a.fromMin - b.fromMin));
  }

  return raw;
}

/**
 * 织入「今天具体干嘛」：把 life.json 的三条 plan 摊到对应时段的格子里。
 * 只改 doing/body，不改时间与地点 —— 结构由 world 保证，文字由今天的心情保证。
 */
export function weavePlans(world, slots, plans) {
  const out = slots.map((s) => ({ ...s }));
  const used = new Set();
  for (const plan of Array.isArray(plans) ? plans : []) {
    const period = str(plan.period, 6);
    const text = str(plan.text, 60);
    if (!period || !text) continue;
    const wantPeriod = period === '晚上' ? '夜里' : period;
    // 先按这句计划自己提到的地方找格（煮饭→厨房，晒太阳→阳台）；
    // 猜不到再退回「按时段找一格腾得出手的」。
    // MARKER: plan-place-first —— 实测按纯时段配会把煮饭排进书房正经干活那格。
    const hintedPlace = guessPlaceOf(text);
    const pool = [];
    for (let i = 0; i < out.length; i += 1) {
      if (used.has(i)) continue;
      const p = periodOf(out[i].from);
      const periodOk = wantPeriod === '夜里' ? (p === '夜里' || p === '傍晚') : p === wantPeriod;
      if (!periodOk) continue;
      if (out[i].interruptible < 0.4) continue;
      pool.push(i);
    }
    // 该时段一格可用的都没有（比如夜里只剩睡着的格子）就让位给别的时段，
    // 而不是把这条计划整句丢掉。
    if (!pool.length) {
      for (let i = 0; i < out.length; i += 1) {
        if (used.has(i)) continue;
        if (out[i].interruptible < 0.4) continue;
        pool.push(i);
      }
    }
    if (!pool.length) continue;
    const wantIdx = periodIndex(
      wantPeriod === '夜里' ? '23:00' : wantPeriod === '清晨' ? '06:00' : wantPeriod === '上午' ? '10:00' : wantPeriod === '下午' ? '14:00' : '19:00',
    );
    let idx = -1;
    if (hintedPlace) {
      // MARKER: plan-period-first —— 同地点只在「时段偏一档以内」时才让路。
      // 实测教训：旧实现无条件优先同地点，把「晚上早点睡」排进清晨六点。
      let best = Infinity;
      for (const i of pool) {
        if (out[i].where !== hintedPlace) continue;
        const d = Math.abs(periodIndex(out[i].from) - wantIdx);
        if (d > 1) continue;
        if (d < best) {
          best = d;
          idx = i;
        }
      }
    }
    if (idx < 0) {
      // 没有可用的同地点格：取时段最接近的一格，地点随后由 movedForPlan 搬过去。
      let bestDist = Infinity;
      for (const i of pool) {
        const d = Math.abs(periodIndex(out[i].from) - wantIdx);
        if (d < bestDist) {
          bestDist = d;
          idx = i;
        }
      }
    }
    if (idx < 0) idx = pool[0];
    // 这句计划自己说了要去哪，但当天骨架里没有那个地方（比如「挪去晒太阳」要去阳台，
    // 工作日骨架只有里间/书房）—— 那就让她真的挪到那儿去，而不是在卧室里晒太阳。
    if (hintedPlace && out[idx].where !== hintedPlace) {
      const hit = placeByName(world, hintedPlace);
      if (hit) {
        out[idx].where = hintedPlace;
        out[idx].whereNote = hit.note || '';
        out[idx].noise = hit.noise || '';
        out[idx].movedForPlan = true;
      }
    }
    out[idx].doing = text;
    out[idx].planText = text;
    out[idx].planPlace = hintedPlace;
    used.add(idx);
  }
  return out;
}

/**
 * 织入爱好与无聊：让一天里至少有「不干什么正事」的格子。
 * 硬保证（不是尽量）：
 *   - 至少 1 个无聊块
 *   - 不出现连续两个正事块
 * 做不到就返回原样，绝不为了满足断言去伪造时间。
 */
export function weaveIdle(world, slots, dayKey) {
  const out = slots.map((s) => ({ ...s }));
  if (out.length < 3) return out;
  const pools = envPools(world);
  const hobbies = (Array.isArray(world?.hobbies) ? world.hobbies : [])
    .filter((h) => str(h?.name, 12));
  const rnd = rngOf(seedOf(dayKey, 'idle'));
  // 计划格绝不动（她自己说的事优先级最高）
  const free = out.map((s, i) => (s.planText ? -1 : i)).filter((i) => i >= 0);

  // 1) 只给「空着的」格子塞爱好。
  // MARKER: hobby-only-empty —— 实测 v4 骨架每格都自带说法（「下楼买早饭，端回来吃」），
  // 之前无条件按 interruptible 挑格，把「下楼买早饭」顶成了「散步：吃完饭往堤上走」，
  // 结果一天里出现两次散步、而买早饭凭空消失。
  // v4 的 regimes 本身就把爱好编进骨架了（堤坝散步、公园绕湖、巷口逛街、客厅打游戏机）。
  // 只有当这一天**一个爱好都没提到**时才补（给自定义世界的兜底），否则一定会出现
  // 同一天两次逛街、或者在堤坝上逛公园 —— 实测过，很出戏。
  const dayHasHobby = hobbies.some((h) => {
    const n = str(h?.name, 12);
    return n && out.some((s) => str(s.doing, 60).includes(n));
  });
  const emptyIdx = dayHasHobby ? [] : free.filter((i) => !hasOwnWords(out[i])
    && !PROTECTED_DOING.test(str(out[i].doing, 60)));
  const shuffled = emptyIdx.slice().sort(() => rnd() - 0.5);
  // 爱好也要看地方：煎鱼只能在厨房，散步得在户外。
  // MARKER: hobby-place —— 实测把「煎鱼：一直没学会」摊到了堤坝那格，她会站在海堤上煎鱼。
  const usedHobby = new Set();
  let hobbyUsed = 0;
  for (const i of shuffled) {
    if (hobbyUsed >= 3 || !hobbies.length) break;
    const slot = out[i];
    const outdoor = OUTDOOR_PLACES.includes(String(slot.where ?? ''));
    const fitHobbies = hobbies.filter((h) => {
      const name = str(h?.name, 12);
      if (!name || usedHobby.has(name)) return false;
      // 说了是哪儿的事，就必须发生在那个地方 —— 否则会出现「在堤坝上煎鱼」「在堤坝上逛公园」。
      const hint = guessPlaceOf(`${name} ${h?.note ?? ''}`);
      if (hint) return String(slot.where ?? '') === hint;
      // 没线索的（刷视频/学新东西）随便哪都行，但别在室外
      return !outdoor;
    });
    if (!fitHobbies.length) break;
    const h = fitHobbies[Math.floor(rnd() * fitHobbies.length) % fitHobbies.length];
    const name = str(h.name, 12);
    // 这一天里已经出现过同名的事（骨架自己就写了「逛街」）就别再塞一遍
    const dup = out.some((s2) => s2 !== slot && str(s2.doing, 60).includes(name));
    if (dup) { usedHobby.add(name); continue; }
    out[i].doing = str(h.note ? `${name}：${h.note}` : name, 60);
    out[i].hobby = name;
    usedHobby.add(name);
    hobbyUsed += 1;
  }

  // 2) 至少 1 个无聊块 —— 这是「偏离骨架」的那一下，所以允许顶掉骨架原本的说法。
  //    不挑正事格、不挑计划格；优先腾得出手的闲格。
  const boring = Array.isArray(pools.boringPool) ? pools.boringPool : [];
  let placedBoring = false;
  if (boring.length) {
    // 不挑正事格、不挑计划格、不挑固定块（吃饭洗澡这些）；
    // 只挑还没被爱好占掉的 —— 爱好是她自己挑的，比通用无聊事有信息量。
    const cands = free.filter((i) => !isWork(out[i]) && !out[i].hobby
      && !PROTECTED_DOING.test(str(out[i].doing, 60)));
    const idleCands = cands.filter((i) => isIdle(out[i]));
    const use = idleCands.length ? idleCands : cands;
    // 再按场景相容筛一遍；滤空了就说明这一天没合适的地方摆无聊事，那就干脆不摆
    const fit = use.filter((i) => boringFits(str(out[i].doing, 60), out[i].where));
    // 先试室内的，室内放不下才用室外 —— 无聊事大半是屋里的事
    const indoorFit = fit.filter((i) => !OUTDOOR_PLACES.includes(String(out[i].where ?? '')));
    const pool2 = indoorFit.length ? indoorFit : fit;
    if (pool2.length) {
      const i = pool2[Math.floor(rnd() * pool2.length) % pool2.length];
      const line = pick(boring.filter((b) => boringFits(str(b, 80), out[i].where)), rnd);
      if (line && !PROTECTED_DOING.test(str(line, 80))) {
        out[i].doing = str(line, 60);
        out[i].boring = true;
        delete out[i].hobby;
        placedBoring = true;
      }
    }
  }

  // 3) 破连续正事：第二格降级成「站起来倒水/发呆」，不动时间。
  //    计划格不动（她说了要干这件事，就不替她取消）。
  for (let i = 1; i < out.length; i += 1) {
    if (isWork(out[i]) && isWork(out[i - 1]) && !out[i].planText) {
      out[i].doing = pick(['站起来倒杯水，站着发会儿呆', '活儿推到一边，先看两页闲书'], rnd) || out[i].doing;
      out[i].interruptible = 0.75;
      out[i].relaxed = true;
    }
  }
  void placedBoring;
  return out;
}

/**
 * 今天的现场：天气 / 光线 / 气味。
 * **不查真实天气**：她住虚构城市，查了就会说「今天杭州下雨」，一问哪的立刻穿帮。
 * 从 world.place.season + env.weatherPool 派生一份当天自洽的天气，
 * weatherBanned 里的一律不出（台风那种她应付不了）。
 */
export function envOf(world, dayKey, now = Date.now()) {
  const pools = envPools(world);
  const rnd = rngOf(seedOf(dayKey, 'env'));
  const banned = (pools.weatherBanned || []).map((x) => str(x, 8));
  const allowed = (pools.weatherPool || []).filter((w) => !banned.includes(str(w?.kind, 8)));
  const weather = allowed.length ? allowed[Math.floor(rnd() * allowed.length) % allowed.length] : null;
  const smell = pick(pools.smellPool, rnd);
  return {
    weather: weather ? { kind: str(weather.kind, 8), temp: str(weather.temp, 12), note: str(weather.note, 40) } : null,
    smell: smell ? str(smell, 40) : '',
    lightByPeriod: { ...pools.lightByPeriod }
  };
}

/** 熬夜日：概率来自 world.day.nightOwl，后果写进 tell（要说得出、也看得出）。 */
export function nightOwlOf(world, dayKey) {
  const d = dayOf(world);
  const owl = d.nightOwl || {};
  const p = num(owl.probability, 0, { min: 0, max: 1 });
  if (p <= 0) return { isOwl: false, sleep: d.sleep, wake: d.wake, tell: '' };
  const rnd = rngOf(seedOf(dayKey, 'owl'));
  const isOwl = rnd() < p;
  if (!isOwl) return { isOwl: false, sleep: d.sleep, wake: d.wake, tell: '' };
  return {
    isOwl: true,
    sleep: str(owl.latestSleep, 5) || d.sleep,
    wake: toHHMM(toMin(d.wake) + num(owl.wakeShiftHours, 0, { min: 0, max: 6 }) * 60),
    tell: str(owl.tell, 60)
  };
}

/** 生成本地骨架的完整一天。纯函数，不写盘、不调模型。 */
/**
 * 计划落格后的最后一道纠偏：谁的时段离得最远，谁就让给还在等的人。
 * MARKER: plan-period-swap
 * 为什么还要这一道：weavePlans 里「同地点优先」已经限制在一档以内，但真实数据里
 * 仍会出现「晚上 早点睡」落在 06:00 清晨 —— 因为夜里那一格（20:00–00:30 书房）
 * 被另一条计划占着，pool 里剩下的只有清晨的里间。这不是选格算错，
 * 是「该时段已经没格子了」，只能靠交换解决，不能靠挑选解决。
 *
 * 规则：
 *   - 时段偏 ≥2 档才算错位
 *   - 找一格时段正好、且没被计划占的（可能是无用格的骨架格），把两条计划互换
 *   - 找不到就放弃，宁可留着错位也不丢计划
 */
export function fixPlanPeriods(slots, plans) {
  const want = { 上午: '10:00', 下午: '14:00', 晚上: '19:00' };
  const out = slots.map((s) => ({ ...s }));
  const list = Array.isArray(plans) ? plans : [];
  if (!list.length) return out;

  for (let round = 0; round < list.length; round += 1) {
    let moved = false;
    for (let i = 0; i < out.length; i += 1) {
      const s = out[i];
      if (!s.planText) continue;
      const p = list.find((x) => x.text === s.planText);
      if (!p || !want[p.period]) continue;
      const gap = Math.abs(periodIndex(s.from) - periodIndex(want[p.period]));
      if (gap <= 1) continue;
      // 找一格时段对得上、且现在没被计划占的
      const target = out.findIndex((o, j) => {
        if (j === i) return false;
        if (o.planText) return false;
        return Math.abs(periodIndex(o.from) - periodIndex(want[p.period])) === 0;
      });
      if (target < 0) continue;
      const t = out[target];
      // 只换「人此刻在哪、在做什么」，不换时间与时段
      const keep = { doing: t.doing, body: t.body, where: t.where, whereNote: t.whereNote, noise: t.noise, interruptible: t.interruptible, planText: t.planText, planPlace: t.planPlace, movedForPlan: t.movedForPlan };
      t.doing = s.doing;
      t.planText = s.planText;
      t.planPlace = s.planPlace;
      t.where = s.where;
      t.whereNote = s.whereNote;
      t.noise = s.noise;
      t.body = s.body;
      t.interruptible = s.interruptible;
      t.movedForPlan = s.movedForPlan;
      s.doing = keep.doing;
      s.planText = keep.planText;
      s.planPlace = keep.planPlace;
      s.where = keep.where;
      s.whereNote = keep.whereNote;
      s.noise = keep.noise;
      s.body = keep.body;
      s.interruptible = keep.interruptible;
      s.movedForPlan = keep.movedForPlan;
      moved = true;
      break;
    }
    if (!moved) break;
  }
  return out;
}

export function buildLocalDay(world, { dayKey, plans = [], now = Date.now() } = {}) {
  const key = dayKey || dayKeyOf(now);
  const regime = pickRegime(world, key, now);
  const owl = nightOwlOf(world, key);
  let slots = expandSlots(world, regime, key);
  for (const s of slots) {
    const hit = placeByName(world, s.where);
    s.whereNote = hit ? hit.note : '';
    s.noise = hit ? hit.noise : '';
  }
  slots = weavePlans(world, slots, plans);
  // MARKER: plan-period-call —— 选格只解决「挑哪一格」，解决不了「该时段已无空格」。
  // 所以占完格再跑一次纠偏，把时段偏两档以上的计划换到对得上的格子里去。
  slots = fixPlanPeriods(slots, plans);
  slots = weaveIdle(world, slots, key);
  if (owl.isOwl && slots.length) {
    const last = slots[slots.length - 1];
    if (last) {
      last.doing = last.doing.includes('刷') ? last.doing : '刷视频/打游戏机停不下来，一看就这个点了';
      last.owl = true;
    }
  }
  // 今天最后一格如果拖过了睡觉时间，标成「还没收」，明天第一格会说「昨天没干完」
  if (slots.length && owl.isOwl) slots[slots.length - 1].unfinished = true;
  return {
    source: 'local',
    regimeId: regime?.id || '',
    regimeLabel: regime?.label || '',
    weekday: WEEK[new Date(dayStartOf(key) || now).getDay()],
    wake: owl.wake,
    sleep: owl.sleep,
    nightOwl: owl.isOwl,
    owlTell: owl.tell,
    env: envOf(world, key, now),
    slots,
    generatedAt: now
  };
}

// ---- 存取 ----------------------------------------------------------------

export function readTimeline(stateDir, { log = null } = {}) {
  const file = path.join(String(stateDir || '.'), TIMELINE_FILE);
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const days = d && typeof d === 'object' && d.days && typeof d.days === 'object' ? d.days : {};
    return { version: TL_VERSION, days };
  } catch (error) {
    if (error?.code !== 'ENOENT') log?.(`[life-timeline] 读取失败，当作空：${error?.message ?? error}`);
    return { version: TL_VERSION, days: {} };
  }
}

export function writeTimeline(stateDir, store) {
  const file = path.join(String(stateDir || '.'), TIMELINE_FILE);
  const keys = Object.keys(store?.days || {}).sort();
  const keep = keys.slice(-KEEP_DAYS);
  const days = {};
  for (const k of keep) days[k] = store.days[k];
  const payload = { version: TL_VERSION, updatedAt: Date.now(), days };
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return payload;
}

/** 缺今天的就生成一份；已有就不动（同一天不重排，避免她中途改口）。 */
export function ensureDay(stateDir, world, { dayKey, plans = [], now = Date.now(), log = null, force = false } = {}) {
  const key = dayKey || dayKeyOf(now);
  const store = readTimeline(stateDir, { log });
  const existing = store.days[key];
  if (existing && !force) return { day: existing, store, created: false };
  const day = buildLocalDay(world, { dayKey: key, plans, now });
  store.days[key] = day;
  const saved = writeTimeline(stateDir, store);
  return { day, store: { ...saved }, created: true };
}

// ---- 注入 -----------------------------------------------------------------

/** 找当前那一格。跨零点往回兜一格（00:10 时她还在「夜里那格」里）。 */
export function slotAt(day, now = Date.now()) {
  if (!day || !Array.isArray(day.slots) || !day.slots.length) return null;
  const d = new Date(now);
  const min = d.getHours() * 60 + d.getMinutes();
  const last = day.slots[day.slots.length - 1];
  const first = day.slots[0];
  // 凌晨且还没到今天第一格（例如 05:00，她 06:00 起）→ 仍在昨天最后一格里
  const firstFrom = Number.isFinite(first.fromMin) ? first.fromMin : toMin(first.from);
  if (min < firstFrom) return last;
  for (const s of day.slots) {
    const from = Number.isFinite(s.fromMin) ? s.fromMin : toMin(s.from);
    let to = Number.isFinite(s.toMin) ? s.toMin : toMin(s.to);
    if (to <= from) to += 1440;
    const cur = min < from && to > 1440 ? min + 1440 : min;
    if (cur >= from && cur < to) return s;
  }
  return last;
}

function tailByInterruptible(x) {
  if (x >= 0.6) return '手上这点事不着急，你说话我听得见。';
  if (x >= 0.3) return '你说我就应，可能慢一点。';
  return '我正腾不出手，等会儿才能好好回你。';
}

/**
 * 「来路」—— 今天早些时候她在哪、在做什么。
 * MARKER: trace-line
 *
 * 为什么要有它：lifeMomentLine 只讲当前这一格。她 17:00 在堤坝的时候，
 * 不知道自己 12:40 才躺过、也不知道 18:30 翻冰箱是刚从堤上回来——
 * 她只有「此刻」，没有来路。HDSI 那份注入是「过去 + 现在 + 未来」，
 * 我们只有现在。
 *
 * 只讲已经过去的格子，不编未来；一格一句，最多 maxSlots 句，整体不超过 maxChars。
 * 同一地点连着几格只留最近那次，免得「在书房…在书房…在书房」。
 */
export function traceLine(day, now = Date.now(), { maxSlots = 3, maxChars = 90, doingChars = 18, maxAgeMs = 8 * 3600 * 1000 } = {}) {
  try {
    if (!day || !Array.isArray(day.slots) || !day.slots.length) return '';
    const d = new Date(now);
    const min = d.getHours() * 60 + d.getMinutes();
    const first = day.slots[0];
    const firstFrom = Number.isFinite(first.fromMin) ? first.fromMin : toMin(first.from);
    // 凌晨且还没到今天第一格 → 今天还没开始，没有「来路」可言
    if (min < firstFrom) return '';

    const done = [];
    for (const s of day.slots) {
      const from = Number.isFinite(s.fromMin) ? s.fromMin : toMin(s.from);
      let to = Number.isFinite(s.toMin) ? s.toMin : toMin(s.to);
      if (to <= from) to += 1440;
      if (to > min) break; // 还没走完的格子不算来路
      const doing = str(s.doing, doingChars);
      if (!doing) continue;
      // 太旧的别提：23:10 说「早些时候 13:40 在书房」既不像话也没用
      const startedAt = Number.isFinite(from) ? from : null;
      if (startedAt != null && maxAgeMs > 0) {
        const ageMin = min - startedAt;
        if (ageMin > 0 && ageMin * 60000 > maxAgeMs) continue;
      }
      done.push({ from: str(s.from, 5), where: str(s.where, 8), doing });
    }
    if (!done.length) return '';

    // 从最近的往前取，同地点只留最近一次
    const picked = [];
    const seen = new Set();
    for (let i = done.length - 1; i >= 0 && picked.length < maxSlots; i -= 1) {
      const s = done[i];
      if (seen.has(s.where)) continue;
      seen.add(s.where);
      picked.unshift(s);
    }
    if (!picked.length) return '';

    const render = (list) => `早些时候：${list.map((s) => `${s.from} 在${s.where}，${s.doing}`).join('；')}。`;
    // 超长就从最旧的那个开始丢（保留离现在最近的）
    let list = picked.slice();
    let text = render(list);
    while (text.length > maxChars && list.length > 1) {
      list = list.slice(1);
      text = render(list);
    }
    return text.length > maxChars ? '' : text;
  } catch {
    return '';
  }
}

/**
 * 生活线注入文本（约 180~230 字）。**这是 P2a 唯一的对外出口**。
 * 出问题一律返回空串，让调用方回落 lifeLineFor —— 宁可没有这一句，也不要一句假的。
 */
export function lifeMomentLine(day, now = Date.now()) {
  try {
    const slot = slotAt(day, now);
    if (!slot) return '';
    const parts = [];
    // 日型：她得知道今天算工作日还是周末，否则「今天想歇着」和「今天得干活」她分不出来。
    // label 里可能的括号注释是写给我看的，先去括号再限长，免得截断截在括号中间。
    // 两个字段任一缺失就整句不加 —— 不拼半截信息。
    // MARKER: day-type
    const dayLabel = str(day.regimeLabel || '', 40).replace(/[（(][^）)]*[）)]/g, '').trim().slice(0, 20);
    const dayWeek = str(day.weekday || '', 6);
    if (dayWeek && dayLabel) parts.push(`今天是${dayWeek}，${dayLabel}。`);
    const range = `${slot.from}–${slot.to}`;
    const whereNote = str(slot.where, 12);
    const note = str(slot.whereNote, 60);
    parts.push(`现在是 ${range}，你在${whereNote}${note ? `（${note}）` : ''}。`);
    if (slot.doing) parts.push(`手上：${slot.doing}。`);
    if (slot.body) parts.push(`身上：${slot.body}。`);

    // 来路：今天早些时候在哪、做了什么（只有过去，不编未来）
    const trace = traceLine(day, now);
    if (trace) parts.push(trace);

    // 现场：天气 / 光线 / 气味 —— 只给一条，别堆
    const env = day.env || {};
    const period = periodOf(slot.from);
    const light = env.lightByPeriod?.[period];
    const bits = [];
    if (env.weather?.kind) bits.push(`${env.weather.kind}天${env.weather.temp ? `，${env.weather.temp} 度` : ''}`);
    if (light) bits.push(light);
    if (env.smell) bits.push(env.smell);
    if (bits.length) parts.push(`外面：${bits.join('；')}。`);

    if (day.owlTell && day.nightOwl) parts.push(`（昨天熬了，${day.owlTell}）`);

    parts.push(tailByInterruptible(num(slot.interruptible, 0.8, { min: 0, max: 1 })));
    parts.push('这是你自己此刻的样子，是背景，不用主动播报；被问到就照这个说，别把整段念出来。');
    return parts.join('');
  } catch {
    return '';
  }
}

/**
 * 此刻的注意力档位 —— 给 pacing 的 rhythm 用。
 * MARKER: attention-of —— pacing.js 里五档 rhythm 一直有 occupied(0.7)，但从来没人写进去，
 * 所以她「在书房正经干活」和「在客厅窝着」对主动频率的影响完全一样，这不合理。
 * 这里把生活线声明翻成一个档位，桥那边当 override 传给 rhythmOf。
 * 只覆盖白天：phoneFocused（有人刚说话）和 asleep（半夜）仍由时间戳决定，优先级更高。
 */
/**
 * 生活线可选的「注意力标注」。
 * MARKER: attention-band
 *
 * 为什么要有它：attentionOf() 只返回一个字符串 —— 它能说「现在忙」，
 * 但说不出「忙到几点」。入站门控（三态注意力）需要知道结束时间，
 * 只调 interruptible 阈值永远补不出这个事实。所以由作者在 regime block
 * 上显式写 attentionBand / busyUntil，代码只负责校验与透传，
 * 绝不从 doing 文本里猜「真忙」。
 */
export const ATTENTION_BANDS = ['asleep', 'focused', 'occupied', 'available'];

export function normalizeAttentionBand(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'sleep') return 'asleep'; // 兼容另一套拼法
  return ATTENTION_BANDS.includes(v) ? v : '';
}

/**
 * busyUntil 只允许落在本格 [fromMin, toMin] 内，且必须晚于起始。
 * 返回分钟数（跨零点时可能 >1440）；任何非法输入一律返回 0，
 * 0 的语义是「没有显式结束点」—— 不虚构。
 */
export function normalizeBusyUntil(value, fromMin, slotToMin) {
  // 形参不能叫 toMin —— 那会遮蔽模块级同名帮助函数，调用时直接 TypeError。
  const raw = String(value ?? '').trim();
  if (!raw) return 0;
  let m = toMin(raw);
  if (!Number.isFinite(m) || m < 0) return 0;
  if (m < fromMin) m += 1440;                  // 21:00 的格写 00:10 → 跨零点
  if (m <= fromMin || m > slotToMin) return 0; // 越界或写反 → 丢弃
  return m;
}

/**
 * 三态注意力快照。MARKER: attention-snapshot
 *
 * 优先级：作者显式写的 attentionBand 高于按 interruptible 推算；
 * focused 必须还没过 busyUntil 才算数，过了就降级成 occupied
 * （格还没结束，只是「专注段」结束了）。
 */
export function attentionSnapshot(day, now = Date.now()) {
  const empty = { band: '', source: 'none', busyUntil: 0, fromMin: 0, toMin: 0 };
  try {
    const slot = slotAt(day, now);
    if (!slot) return empty;
    const d = new Date(now);
    let min = d.getHours() * 60 + d.getMinutes();
    const fromMin = Number.isFinite(slot.fromMin) ? slot.fromMin : toMin(slot.from);
    let toEnd = Number.isFinite(slot.toMin) ? slot.toMin : toMin(slot.to);
    if (toEnd <= fromMin) toEnd += 1440;
    if (toEnd > 1440 && min < fromMin) min += 1440;
    const busyUntil = Number(slot.busyUntil) || 0;
    const base = { busyUntil, fromMin, toMin: toEnd };

    const declared = normalizeAttentionBand(slot.attentionBand);
    if (declared) {
      if (declared === 'focused' && busyUntil > 0 && min >= busyUntil) {
        return { ...base, band: 'occupied', source: 'band-expired' };
      }
      return { ...base, band: declared, source: 'band' };
    }
    const doing = str(slot.doing, 60);
    const where = str(slot.where, 12);
    if (/睡|赖着|午睡/.test(doing) && where === '里间') {
      return { ...base, band: 'asleep', source: 'heuristic' };
    }
    const it = num(slot.interruptible, 0.8, { min: 0, max: 1 });
    if (it <= 0.45) return { ...base, band: 'occupied', source: 'heuristic' };
    return { ...base, band: 'available', source: 'heuristic' };
  } catch {
    return empty;
  }
}

export function attentionOf(day, now = Date.now()) {
  // 保持旧签名与旧返回值（'' / asleep / occupied / available），
  // 新增的 focused 只有在 regime block 显式标注时才会出现。
  return attentionSnapshot(day, now).band || '';
}
/** 给调试脚本看的一行摘要。 */
export function summarizeDay(day) {
  if (!day) return '(空)';
  const parts = [`${day.regimeLabel || day.regimeId || '?'}（${day.weekday || '?'}）`];
  parts.push(`醒 ${day.wake} 睡 ${day.sleep}${day.nightOwl ? ' [熬夜日]' : ''}`);
  if (day.env?.weather?.kind) parts.push(`天气 ${day.env.weather.kind}`);
  parts.push(`${(day.slots || []).length} 格`);
  return parts.join(' | ');
}
