// world-events 单测：只跑纯函数，不碰磁盘、不联网、不看真实时钟。
//   node scripts/test-world-events.mjs
// TMPDIR 会用来隔离 readEvents/writeEvents 的落盘测试。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EVENT_DEFAULTS,
  SEED_CATALOG,
  buildDay,
  describeForLog,
  eligibleSeeds,
  ensureDay,
  eventsCfg,
  eventsLine,
  eventsSoFar,
  isSafeEvent,
  planDayEvents,
  readEvents,
  writeEvents
} from '../src/world-events.js';

let pass = 0;
let fail = 0;
const fails = [];

function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail += 1;
    fails.push(`${name} :: ${error?.message ?? error}`);
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
}

// ---------------------------------------------------------------- 夹具
// 9 个地点、8 个爱好、workday 骨架 —— 与线上 world.json 同形（但小一号）。
const PLACES = ['书房', '客厅', '厨房', '阳台', '里间', '楼下', '堤坝', '公园', '巷口'];

const WORLD = {
  place: { city: '南方靠海的小城', floor: 5, places: PLACES.map((n) => ({ name: n, note: `${n}的描述`, noise: `${n}的声音` })) },
  day: { wake: '06:00', sleep: '00:30' },
  hobbies: [{ name: '读书', note: '翻几页' }, { name: '煎鱼', note: '一直没学会', aspiration: true }],
  // 种子文本必须是线上 world.json 的原文 —— 否则 catalog 匹配测不到真东西。
  worldDomains: [
    { key: 'nature', label: '天象与环境', seeds: ['海雾起来了，对面楼看不清', '涨潮把堤坝下面的石阶淹了', '风向变了，阳台上晾的鱼干吹掉一条', '一夜之间凉下去，玻璃上有了水气', '远处有船在雾里拉了一声笛'] },
    { key: 'dwelling', label: '居所与近邻', seeds: ['楼上换了新住户，白天在敲东西', '楼下早餐铺歇业一天，卷帘门拉着', '楼道的灯坏了，回家要走黑楼梯', '门口贴了停水通知，明早六点到十点', '隔壁把鞋架挪到了公共走道上'] },
    { key: 'livelihood', label: '生计与日常事务', seeds: ['老客户把那版图退回来，说要改配色'] },
    { key: 'close-people', label: '亲近之人', seeds: ['老家打来电话，说天气转凉了要多穿'] },
    { key: 'paths', label: '途中与陌生人', seeds: ['堤坝上有人钓上来一条小的，看了看又放回去', '有人在巷口问她这条路通不通海边', '巷口在修路，买菜要绕一个圈', '公交站有个老太太问她几点了', '有人把共享的推车放在她楼下，没还'] },
    { key: 'chance', label: '小意外与际遇', seeds: ['在堤坝上捡到一把钥匙，挂在栏杆上等人来拿', '买菜多找了两块钱，走了十几米才发现', '鞋底开胶了，走到一半才发现', '旧书摊翻到一本，里面有前人的笔记', '手机屏摔了一下，裂缝在角上，还能用'] }
  ],
  worldEventRules: { fabricateRealPeople: false, blockedNames: ['主人'], channels: ['公共场合'], forbidden: [] }
};

function slot(from, to, where, doing, interruptible = 0.8) {
  const [fh, fm] = from.split(':').map(Number);
  let [th, tm] = to.split(':').map(Number);
  let fromMin = fh * 60 + fm;
  let toMin = th * 60 + tm;
  if (toMin <= fromMin) toMin += 1440;
  return { from, to, fromMin, toMin, where, doing, body: '', interruptible };
}

const DAY = {
  day: '2026-10-30',
  regimeId: 'workday',
  env: { weather: { kind: '晴', temp: '18~25', note: '晒得人犯困' }, smell: '咸味', lightByPeriod: {} },
  slots: [
    slot('06:00', '06:40', '里间', '醒了先躺着，把窗开条缝', 0.5),
    slot('06:40', '07:30', '楼下', '下楼买早饭，端回来吃', 0.9),
    slot('09:00', '11:30', '书房', '正经干活，中间会站起来倒水', 0.4),
    slot('12:40', '13:40', '阳台', '把窗边那几样挪去晒太阳', 0.6),
    slot('17:00', '18:30', '堤坝', '吃完饭往堤上走，走十分钟又回来', 0.85),
    slot('18:30', '20:00', '客厅', '烧了一壶水，忘了喝，凉了又烧', 0.9),
    slot('20:00', '00:30', '书房', '翻几页旧书，不赶着画图', 0.7)
  ]
};

// 记录里的 text 可能是 emit（改造后的说法），所以查 spec 要两个字段都试。
function specOf(record) {
  const t = String(record?.text || '');
  return SEED_CATALOG.find((x) => x.text === t || x.emit === t) || null;
}

const CFG = { enabled: true, inject: false, maxPerDay: 2, minGapMinutes: 180, keepDays: 14, injectMaxChars: 80 };

const DAYS = ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'];

console.log('\n【1】配置归一化');
ok('缺省值齐全', () => {
  const c = eventsCfg();
  assert.equal(c.enabled, true);
  assert.equal(c.inject, false, '影子模式必须默认关闭注入');
  assert.equal(c.maxPerDay, 2);
  assert.equal(c.minGapMinutes, 180);
  assert.equal(c.keepDays, 14);
  assert.equal(c.injectMaxChars, 80);
});
ok('null 不被当成 0（Number(null)===0 的坑）', () => {
  const c = eventsCfg({ maxPerDay: null, minGapMinutes: null, injectMaxChars: null });
  assert.equal(c.maxPerDay, EVENT_DEFAULTS.maxPerDay);
  assert.equal(c.minGapMinutes, EVENT_DEFAULTS.minGapMinutes);
  assert.equal(c.injectMaxChars, EVENT_DEFAULTS.injectMaxChars);
});
ok('0 是合法值，不被回落', () => {
  assert.equal(eventsCfg({ maxPerDay: 0 }).maxPerDay, 0);
});
ok('超界被夹住', () => {
  assert.equal(eventsCfg({ maxPerDay: 99 }).maxPerDay, 4);
  assert.equal(eventsCfg({ maxPerDay: -5 }).maxPerDay, 0);
});
ok('inject 只认严格的 true', () => {
  assert.equal(eventsCfg({ inject: 'yes' }).inject, false);
  assert.equal(eventsCfg({ inject: 1 }).inject, false);
  assert.equal(eventsCfg({ inject: true }).inject, true);
});

console.log('\n【2】安全校验（fabricateRealPeople:false 的代码落点）');
ok('正常记录通过', () => {
  assert.equal(isSafeEvent({ id: 'a', at: '09:10', atMin: 550, text: '楼道的灯坏了，回家要走黑楼梯' }), true);
});
ok('带人物字段整条拒绝', () => {
  for (const key of ['people', 'person', 'name', 'names', 'who', 'speaker', 'member', 'target', 'quote']) {
    assert.equal(isSafeEvent({ text: '楼道的灯坏了', [key]: '张三' }), false, `字段 ${key} 应当被拒`);
  }
});
ok('空文本拒绝', () => {
  assert.equal(isSafeEvent({ text: '   ' }), false);
  assert.equal(isSafeEvent(null), false);
});
ok('把路人抬成当事人的说法被拒', () => {
  assert.equal(isSafeEvent({ text: '有人告诉我这条路通海边' }), false);
  assert.equal(isSafeEvent({ text: '老太太说她几点了' }), false);
});
ok('普通叙述不被误杀', () => {
  assert.equal(isSafeEvent({ text: '有人在巷口问她这条路通不通海边' }), true);
  assert.equal(isSafeEvent({ text: '堤坝上有人钓上来一条小的，看了看又放回去' }), true);
});

console.log('\n【3】放行名单（人工闸门）');
ok('未登记的种子进不来', () => {
  // 基准用「同一份 world 的放行结果」，不是 SEED_CATALOG 的长度
  // （夹具里的 world 只放了 catalog 的一个子集）。
  const before = eligibleSeeds(WORLD, null).length;
  assert.ok(before > 0, '夹具本身应当有种子能被放行');
  const w = { ...WORLD, worldDomains: [...WORLD.worldDomains, { key: 'chance', seeds: ['天上掉下来一个我没登记的事件'] }] };
  const got = eligibleSeeds(w, null);
  assert.equal(got.length, before, '总数不应因为多了一条没登记的种子而变多');
  assert.ok(!got.some((x) => x.text.includes('没登记')), '未登记的种子必须被挡在放行名单外');
  // 再确认：如果把它登记进去，才会计入
  assert.ok(!SEED_CATALOG.some((x) => x.text.includes('没登记')));
});
ok('livelihood 整块不在放行名单', () => {
  assert.ok(!SEED_CATALOG.some((x) => x.domain === 'livelihood'));
});
ok('close-people 整块不在放行名单', () => {
  assert.ok(!SEED_CATALOG.some((x) => x.domain === 'close-people'));
});
ok('「停水通知」不在放行名单（它改的是未来）', () => {
  assert.ok(!SEED_CATALOG.some((x) => x.text.includes('停水')));
});
ok('「手机屏摔了」不在放行名单（留长期状态）', () => {
  assert.ok(!SEED_CATALOG.some((x) => x.text.includes('手机屏')));
});

console.log('\n【4】确定性：同一天必须同一个答案');
ok('十天里同一天连算三次完全一致', () => {
  for (const dayKey of DAYS) {
    const a = JSON.stringify(planDayEvents(WORLD, { dayKey, day: { ...DAY, day: dayKey }, cfg: CFG }));
    const b = JSON.stringify(planDayEvents(WORLD, { dayKey, day: { ...DAY, day: dayKey }, cfg: CFG }));
    const c = JSON.stringify(planDayEvents(WORLD, { dayKey, day: { ...DAY, day: dayKey }, cfg: CFG }));
    assert.equal(a, b, `${dayKey} 第一次与第二次不一致`);
    assert.equal(b, c, `${dayKey} 第二次与第三次不一致`);
  }
});
ok('不同天会挑到不同的事（不能天天一条）', () => {
  const sigs = DAYS.map((k) => JSON.stringify(planDayEvents(WORLD, { dayKey: k, day: { ...DAY, day: k }, cfg: CFG }).map((e) => e.text)));
  const uniq = new Set(sigs);
  assert.ok(uniq.size >= 3, `十天里只有 ${uniq.size} 种不同结果，太单调`);
});

console.log('\n【5】频率与间隔');
ok('十天里每天不超过 maxPerDay', () => {
  for (const k of DAYS) {
    const got = planDayEvents(WORLD, { dayKey: k, day: { ...DAY, day: k }, cfg: CFG });
    assert.ok(got.length <= CFG.maxPerDay, `${k} 出了 ${got.length} 条`);
  }
});
ok('允许「今天什么都没发生」', () => {
  const empty = planDayEvents(WORLD, { dayKey: '2026-10-30', day: { ...DAY, day: '2026-10-30' }, cfg: { ...CFG, maxPerDay: 0 } });
  assert.equal(empty.length, 0);
});
ok('两条之间至少隔 minGapMinutes', () => {
  for (const k of DAYS) {
    for (const max of [2, 3, 4]) {
      const got = planDayEvents(WORLD, { dayKey: k, day: { ...DAY, day: k }, cfg: { ...CFG, maxPerDay: max } });
      for (let i = 1; i < got.length; i += 1) {
        assert.ok(Math.abs(got[i].atMin - got[i - 1].atMin) >= CFG.minGapMinutes, `${k} 两条太近：${got[i - 1].at} 与 ${got[i].at}`);
      }
    }
  }
});
ok('结果按时间排序', () => {
  for (const k of DAYS) {
    const got = planDayEvents(WORLD, { dayKey: k, day: { ...DAY, day: k }, cfg: { ...CFG, maxPerDay: 4 } });
    for (let i = 1; i < got.length; i += 1) assert.ok(got[i].atMin >= got[i - 1].atMin);
  }
});

console.log('\n【6】种子约束真的生效');
ok('限地点的种子只出现在它的地点上', () => {
  const spec = SEED_CATALOG.find((x) => x.text.includes('堤坝'));
  assert.ok(spec && Array.isArray(spec.where));
  assert.ok(spec.where.includes('堤坝'));
  // 十天 × 全开，逐条核对
  for (const k of DAYS) {
    const got = planDayEvents(WORLD, { dayKey: k, day: { ...DAY, day: k }, cfg: { ...CFG, maxPerDay: 4 } });
    for (const e of got) {
      const s = specOf(e);
      if (s?.where) assert.ok(s.where.includes(e.where), `${e.text} 出现在 ${e.where}，但只允许 ${s.where.join('/')}`);
    }
  }
});
ok('「路过楼下，早餐铺卷帘门拉着」不会撞上买早饭那格', () => {
  const spec = SEED_CATALOG.find((x) => x.text.includes('早餐铺'));
  assert.ok(spec);
  const buySlot = DAY.slots.find((s) => s.doing.includes('买早饭'));
  assert.equal(spec.forbid.test(buySlot.doing), true, 'forbid 正则必须命中买早饭那格');
  for (const k of DAYS) {
    const got = planDayEvents(WORLD, { dayKey: k, day: { ...DAY, day: k }, cfg: { ...CFG, maxPerDay: 4 } });
    for (const e of got) {
      if (e.text.includes('早餐铺')) assert.notEqual(e.slotFrom, '06:40', '不该排在买早饭那一格');
    }
  }
});
ok('需要天气的种子在天气不对时不会出现', () => {
  const fogSeeds = SEED_CATALOG.filter((x) => Array.isArray(x.weather) && x.weather.includes('海雾'));
  assert.ok(fogSeeds.length >= 2);
  const sunnyDay = { ...DAY, env: { ...DAY.env, weather: { kind: '晴', temp: '18~25', note: '' } } };
  for (const k of DAYS) {
    const got = planDayEvents(WORLD, { dayKey: k, day: { ...sunnyDay, day: k }, cfg: { ...CFG, maxPerDay: 4 } });
    for (const e of got) {
      assert.ok(!fogSeeds.some((s) => s.text === e.text), `晴天不该出现海雾事件：${e.text}`);
    }
  }
});
ok('买菜日的种子只在 market-day 出现', () => {
  const spec = SEED_CATALOG.find((x) => x.regime === 'market-day');
  assert.ok(spec);
  for (const k of DAYS) {
    const got = planDayEvents(WORLD, { dayKey: k, day: { ...DAY, day: k }, cfg: { ...CFG, maxPerDay: 4 } });
    for (const e of got) {
      if (e.text === spec.text) assert.equal(DAY.regimeId, 'market-day', 'workday 不该出买菜事件');
    }
  }
});
ok('before/after 时段约束真的生效', () => {
  const before = SEED_CATALOG.find((x) => x.before);
  assert.ok(before, 'catalog 里应当至少有一条带 before 约束的种子');
  const cut = before.before.split(':').map(Number);
  const cutMin = cut[0] * 60 + cut[1];
  // 造一份「所有格子都在下午」的日程，这条种子必须一条都出不来
  const afternoonDay = {
    ...DAY,
    slots: [slot('13:00', '15:00', '书房', '正经干活'), slot('15:00', '17:00', '客厅', '窝着')]
  };
  for (const k of DAYS) {
    const got = planDayEvents(WORLD, { dayKey: k, day: { ...afternoonDay, day: k }, cfg: { ...CFG, maxPerDay: 4 } });
    assert.ok(!got.some((e) => e.text === before.text), `下午的日程里不该出现「${before.text}」`);
    for (const e of got) {
      const s = specOf(e);
      if (s?.before) assert.ok(e.slotTo <= s.before, `${e.text} 的整格结束时间 ${e.slotTo} 越过了 ${s.before}`);
    }
  }
  // 反过来：清晨的日程里它是可以出现的（不保证一定出现，但至少候选里有）
  const morningDay = { ...DAY, slots: [slot('06:00', '06:40', '里间', '醒了先躺着')] };
  let hit = 0;
  for (const k of DAYS) {
    const got = planDayEvents(WORLD, { dayKey: k, day: { ...morningDay, day: k }, cfg: { ...CFG, maxPerDay: 4 } });
    if (got.some((e) => e.text === before.text)) hit += 1;
  }
  assert.ok(hit >= 1, '清晨日程里十天至少该出现一次');
});
ok('before 的边界是「整格」而不是「事件时刻」', () => {
  // 一格 09:00-11:30 横跨 10:00 截止线 —— 整格不在线内，必须排除；
  // 否则事件可能落在 10:30，说「一夜之间凉下去」就不对了。
  const straddle = { ...DAY, slots: [slot('09:00', '11:30', '书房', '正经干活')] };
  const spec = SEED_CATALOG.find((x) => x.before);
  assert.ok(spec);
  for (const k of DAYS) {
    const got = planDayEvents(WORLD, { dayKey: k, day: { ...straddle, day: k }, cfg: { ...CFG, maxPerDay: 4 } });
    assert.ok(!got.some((e) => e.text === spec.text), '横跨截止线的格子必须整格排除');
  }
});
ok('blockedNames 命中整条丢弃', () => {
  const blockedWorld = { ...WORLD, worldEventRules: { ...WORLD.worldEventRules, blockedNames: ['楼道'] } };
  for (const k of DAYS) {
    const got = planDayEvents(blockedWorld, { dayKey: k, day: { ...DAY, day: k }, cfg: { ...CFG, maxPerDay: 4 } });
    for (const e of got) assert.ok(!e.text.includes('楼道'));
  }
});

console.log('\n【7】注入文本');
ok('没有事件时返回空串（调用方什么都不加）', () => {
  assert.equal(eventsLine({ day: '2026-10-30', events: [] }, Date.now()), '');
  assert.equal(eventsLine(null, Date.now()), '');
});
ok('只给已经发生的，未来的一个字都不给', () => {
  const rec = {
    day: '2026-10-30',
    events: [
      { id: 'a', at: '09:10', atMin: 550, text: '楼道的灯坏了' },
      { id: 'b', at: '18:00', atMin: 1080, text: '有人把共享的推车放在她楼下' }
    ]
  };
  const at10 = new Date(2026, 9, 30, 10, 0, 0).getTime();
  const got = eventsSoFar(rec, at10);
  assert.equal(got.length, 1);
  assert.equal(got[0].id, 'a');
  const line = eventsLine(rec, at10, CFG);
  assert.ok(line.includes('楼道'));
  assert.ok(!line.includes('推车'), '未来的事件不该出现在注入文本里');
});
ok('长度受 injectMaxChars 约束', () => {
  const rec = {
    day: '2026-10-30',
    events: [
      { id: 'a', at: '01:00', atMin: 60, text: '甲'.repeat(50) },
      { id: 'b', at: '02:00', atMin: 120, text: '乙'.repeat(50) }
    ]
  };
  const line = eventsLine(rec, new Date(2026, 9, 30, 23, 0, 0).getTime(), { ...CFG, injectMaxChars: 60 });
  assert.ok(line.length <= 60 + 40, `注入文本 ${line.length} 字，超了`);
});
ok('注入文本不含系统腔（记账腔防线）', () => {
  const dayRecord = buildDay(WORLD, { dayKey: '2026-10-30', day: { ...DAY, day: '2026-10-30' }, cfg: { ...CFG, maxPerDay: 4 }, now: new Date(2026, 9, 30, 23, 0, 0).getTime() });
  const line = eventsLine(dayRecord, new Date(2026, 9, 30, 23, 0, 0).getTime(), { ...CFG, maxPerDay: 4 });
  if (line) {
    for (const bad of ['事件', '账本', '记录', '清单', '系统生成', '已注入']) {
      assert.ok(!line.includes(bad), `注入文本里出现了系统词「${bad}」：${line}`);
    }
    assert.ok(line.includes('背景'), '应当明说这是背景');
  }
});
ok('注入文本里不带人物字段的值', () => {
  const rec = { day: '2026-10-30', events: [{ id: 'a', at: '09:00', atMin: 540, text: '楼道的灯坏了', who: '张三' }] };
  const line = eventsLine(rec, new Date(2026, 9, 30, 23, 0, 0).getTime(), CFG);
  assert.ok(!line.includes('张三'), '带人物字段的记录必须被 isSafeEvent 拦下');
});

console.log('\n【8】落盘与幂等');
const TMP = path.join(process.env.TMPDIR || os.tmpdir(), `we-test-${process.pid}`);
fs.mkdirSync(TMP, { recursive: true });

ok('writeEvents/readEvents 往返一致', () => {
  const store = { version: 1, days: { '2026-10-30': { day: '2026-10-30', events: [] } } };
  writeEvents(TMP, store, { keepDays: 14 });
  const back = readEvents(TMP);
  assert.equal(back.days['2026-10-30'].day, '2026-10-30');
});
ok('保留期外的日期被裁掉', () => {
  const days = {};
  for (let i = 0; i < 20; i += 1) days[`2026-10-${String(i + 1).padStart(2, '0')}`] = { day: `d${i}`, events: [] };
  writeEvents(TMP, { version: 1, days }, { keepDays: 5 });
  const back = readEvents(TMP);
  assert.equal(Object.keys(back.days).length, 5, `应该留 5 天，实际 ${Object.keys(back.days).length}`);
  assert.ok(back.days['2026-10-20'], '应该留最新的几天');
});
ok('已有那一天就不重抽（ensureDay 幂等）', () => {
  const t = path.join(TMP, 'idem');
  fs.rmSync(t, { recursive: true, force: true });
  fs.mkdirSync(t, { recursive: true });
  const first = ensureDay(t, WORLD, { dayKey: '2026-10-30', day: { ...DAY, day: '2026-10-30' }, cfg: CFG, now: 1 });
  assert.equal(first.created, true);
  const snapshot = JSON.stringify(first.day.events);
  // 换一份 day（模拟 timeline 被 force 重排过），再看会不会覆盖
  const second = ensureDay(t, WORLD, { dayKey: '2026-10-30', day: { ...DAY, day: '2026-10-30', slots: [...DAY.slots].reverse() }, cfg: CFG, now: 2 });
  assert.equal(second.created, false, '第二次不该重建');
  assert.equal(JSON.stringify(second.day.events), snapshot, '事件不该因为日程重排而变');
});
ok('force 才重建（只给明确的修复操作用）', () => {
  const t = path.join(TMP, 'force');
  fs.rmSync(t, { recursive: true, force: true });
  fs.mkdirSync(t, { recursive: true });
  ensureDay(t, WORLD, { dayKey: '2026-10-30', day: { ...DAY, day: '2026-10-30' }, cfg: CFG, now: 1 });
  const forced = ensureDay(t, WORLD, { dayKey: '2026-10-30', day: { ...DAY, day: '2026-10-30' }, cfg: CFG, now: 2, force: true });
  assert.equal(forced.created, true);
});
ok('坏文件不炸，退回空账本', () => {
  const t = path.join(TMP, 'broken');
  fs.rmSync(t, { recursive: true, force: true });
  fs.mkdirSync(t, { recursive: true });
  fs.writeFileSync(path.join(t, 'world-events.json'), '{ 这不是 JSON', 'utf8');
  const back = readEvents(t, { log: () => {} });
  assert.deepEqual(back.days, {});
});

console.log('\n【9】日志格式');
ok('日志带 ISO 日期（现有日志只有 HH:MM:SS，没法统计今天）', () => {
  const line = describeForLog({ day: '2026-10-30', events: [{ at: '09:10', text: '楼道的灯坏了' }] });
  assert.ok(line.includes('day=2026-10-30'), `日志缺日期：${line}`);
  assert.ok(line.includes('楼道的灯坏了'));
});
ok('没事件也有明确一行', () => {
  const line = describeForLog({ day: '2026-10-30', events: [] });
  assert.ok(line.includes('day=2026-10-30'));
  assert.ok(line.includes('今天没事'));
});

console.log('\n【10】边界情况');
ok('day 缺失 / slots 为空 → 空数组，不炸', () => {
  assert.deepEqual(planDayEvents(WORLD, { dayKey: '2026-10-30', day: null, cfg: CFG }), []);
  assert.deepEqual(planDayEvents(WORLD, { dayKey: '2026-10-30', day: { slots: [] }, cfg: CFG }), []);
});
ok('enabled:false 时一条都不出', () => {
  const got = planDayEvents(WORLD, { dayKey: '2026-10-30', day: DAY, cfg: { ...CFG, enabled: false } });
  assert.equal(got.length, 0);
});
ok('world 是空对象也不炸', () => {
  const got = planDayEvents({}, { dayKey: '2026-10-30', day: DAY, cfg: CFG });
  assert.deepEqual(got, []);
});
ok('同一格里最多一条（不重复堆叠）', () => {
  for (const k of DAYS) {
    const got = planDayEvents(WORLD, { dayKey: k, day: { ...DAY, day: k }, cfg: { ...CFG, maxPerDay: 4, minGapMinutes: 0 } });
    const seen = new Set();
    for (const e of got) {
      assert.ok(!seen.has(e.text), `同一天重复了同一条：${e.text}`);
      seen.add(e.text);
    }
  }
});

fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n结果：${pass} 过 / ${fail} 挂`);
if (fail) {
  console.log('\n失败项：');
  fails.forEach((x) => console.log(`  · ${x}`));
  process.exitCode = 1;
}
