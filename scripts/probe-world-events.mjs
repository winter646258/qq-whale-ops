// 真数据体检：拿线上真实的 world.json + life-timeline.json 跑 world-events。
//   node scripts/probe-world-events.mjs            # 只算不写
//   node scripts/probe-world-events.mjs --write    # 写入 state/world-events.json
//   node scripts/probe-world-events.mjs --days 10  # 看十天
//
// 这个脚本走的是「影子模式」：默认不注入、不碰 bridge 的任何路径，
// 只是证明「种子真的会被读到、挑得出、挑得对」。

import fs from 'node:fs';
import path from 'node:path';

import { readWorld } from '../src/world.js';
import { buildLocalDay, readTimeline } from '../src/life-timeline.js';
import {
  EVENT_DEFAULTS,
  buildDay,
  describeForLog,
  eligibleSeeds,
  ensureDay,
  eventsLine,
  isSafeEvent,
  planDayEvents,
  readEvents
} from '../src/world-events.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const STATE = path.join(ROOT, 'state');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const dayIdx = args.indexOf('--days');
const HOW_MANY = dayIdx >= 0 ? Number(args[dayIdx + 1]) || 10 : 10;

const CFG = { ...EVENT_DEFAULTS, enabled: true, inject: false, maxPerDay: 2, minGapMinutes: 180 };

const logs = [];
const log = (m) => {
  logs.push(String(m));
  console.log(m);
};

console.log('===== 环境 =====');
console.log(`STATE  ${STATE}`);

const world = readWorld(STATE, { log });
console.log(`world  ${world.place?.city || '?'} · ${world.place?.places?.length || 0} 地点 · ${world.hobbies?.length || 0} 爱好`);

console.log('\n===== 放行名单 =====');
const seeds = eligibleSeeds(world, log);
console.log(`放行 ${seeds.length} 条，覆盖切面：${[...new Set(seeds.map((x) => x.domain))].join(' / ')}`);

const tl = readTimeline(STATE, { log });
const haveTimeline = Object.keys(tl.days || {}).length;
console.log("\n===== 生活线 =====");
console.log(`已有 ${haveTimeline} 天：${Object.keys(tl.days || {}).sort().join(', ')}`);

// 用今天真实的那条时间线来测（有就拿真的，没有就用最近一天）
const todayKey = new Date().toISOString().slice(0, 10);
const keys = Object.keys(tl.days || {}).sort();
const baseKey = tl.days?.[todayKey] ? todayKey : keys[keys.length - 1];
if (!baseKey) {
  console.log('没有可用的生活线数据，退出。');
  process.exit(1);
}
const baseDay = tl.days[baseKey];
console.log(`基准日 ${baseKey}（${baseDay.regimeId}，${baseDay.slots?.length || 0} 格，天气 ${baseDay.env?.weather?.kind || '?'}）`);

// 用 buildLocalDay 真正排每天（不同平日/周末/天气）——这才是运行时的真实水平。
// 之前用同一份 baseDay 当模板，等于「永远是工作日 + 永远晴」，那是最坏情况。
console.log(`\n===== 连算 ${HOW_MANY} 天（每天真排日程）=====`);
const start = new Date(`${baseKey}T12:00:00`);
let total = 0;
let emptyDays = 0;
const domainCount = {};
for (let i = 0; i < HOW_MANY; i += 1) {
  const d = new Date(start.getTime() + i * 86400000);
  const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const built = buildLocalDay(world, { dayKey, plans: baseDay.plans || [], now: d.getTime() });
  const day = built || { ...baseDay, day: dayKey };
  console.log(`  ${dayKey} ${day.regimeId} ${String(day.slots?.length || 0)} 格 ${day.env?.weather?.kind || '?'}`);
  const rec = buildDay(world, { dayKey, day, cfg: CFG, now: Date.now(), log });
  total += rec.events.length;
  if (!rec.events.length) emptyDays += 1;
  for (const e of rec.events) domainCount[e.domain] = (domainCount[e.domain] || 0) + 1;
  console.log('  ' + describeForLog(rec));
  for (const e of rec.events) {
    console.log(`      [${e.domain}] ${e.at} 在${e.where}（${e.slotFrom}-${e.slotTo}）  ${e.text}`);
    if (!isSafeEvent(e)) console.log('      !! 安全校验未过');
  }
}

console.log(`\n合计 ${total} 条 / ${HOW_MANY} 天 = ${(total / HOW_MANY).toFixed(2)} 条每天；空白天 ${emptyDays} 天`);
console.log('切面分布：', JSON.stringify(domainCount));

// 确定性复核：同一天算三次
console.log('\n===== 确定性复核（同一天算三次）=====');
const k0 = baseKey;
const a = JSON.stringify(planDayEvents(world, { dayKey: k0, day: { ...baseDay, day: k0 }, cfg: CFG }));
const b = JSON.stringify(planDayEvents(world, { dayKey: k0, day: { ...baseDay, day: k0 }, cfg: CFG }));
const c = JSON.stringify(planDayEvents(world, { dayKey: k0, day: { ...baseDay, day: k0 }, cfg: CFG }));
console.log(a === b && b === c ? '  ✓ 三次完全一致' : '  ✗ 不一致！');

// 注入文本样例
console.log('\n===== 注入文本样例 =====');
const rec0 = buildDay(world, { dayKey: k0, day: { ...baseDay, day: k0 }, cfg: { ...CFG, maxPerDay: 2 }, now: Date.now() });
const line = eventsLine(rec0, new Date(`${k0}T23:59:00`).getTime(), CFG);
if (line) {
  console.log(`  「${line}」`);
  console.log(`  长度 ${line.length} 字`);
} else {
  console.log('  （今天没挑到事件，注入为空 —— 这是合法的「什么都没发生」）');
}

// 影子落盘
console.log('\n===== 影子落盘 =====');
if (WRITE) {
  const got = ensureDay(STATE, world, { dayKey: todayKey, day: { ...baseDay, day: todayKey }, cfg: CFG, now: Date.now(), log });
  console.log(`  ${got.created ? '新建' : '复用'} state/world-events.json：${describeForLog(got.day)}`);
  const back = readEvents(STATE, { log });
  console.log(`  账本里现有 ${Object.keys(back.days || {}).length} 天：${Object.keys(back.days || {}).join(', ')}`);
} else {
  console.log('  （只算不写；加 --write 才落盘）');
}

console.log('\n===== 结论 =====');
console.log(`  放行种子 ${seeds.length} 条 · 十天平均 ${(total / HOW_MANY).toFixed(2)} 条/天 · 注入开关 inject=${CFG.inject}`);
if (CFG.inject === false) console.log('  当前是影子模式：只生成、不注入提示词。');
