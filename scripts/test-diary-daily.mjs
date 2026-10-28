// 每天先日记：每日提醒的纯逻辑用例（真 import，不复制代码）。
import {
  DIARY_DAILY_DEFAULTS,
  dailyCfg,
  dailyDiaryLine,
  decideDailyDiary,
  hasEntryOnDay,
  inQuiet,
  localDayOf
} from '../src/diary-daily.js';

let pass = 0;
const fails = [];
function ok(name, cond) {
  if (cond) {
    pass += 1;
    return;
  }
  fails.push(name);
}
function eq(name, actual, expected) {
  ok(`${name}（实际 ${JSON.stringify(actual)} 期望 ${JSON.stringify(expected)}）`, JSON.stringify(actual) === JSON.stringify(expected));
}

const NOW = new Date(2026, 9, 28, 14, 30, 0).getTime(); // 2026-10-28 14:30 本地
const DAY = '2026-10-28';

// ---- 配置 ----
eq('默认值', dailyCfg({}), {
  enabled: true,
  cooldownMs: 3 * 3600 * 1000,
  maxPerDay: 3,
  quietStart: 23,
  quietEnd: 8,
  strongAfterHour: 20,
  keepDays: 7
});
ok('enabled:false 关掉', dailyCfg({ socialV2: { diaryDaily: { enabled: false } } }).enabled === false);
ok('enabled:0 不算关（只认明确 false）', dailyCfg({ socialV2: { diaryDaily: { enabled: 0 } } }).enabled === true);
eq('cooldownMs:null 回落默认（不是 0）', dailyCfg({ socialV2: { diaryDaily: { cooldownMs: null } } }).cooldownMs, DIARY_DAILY_DEFAULTS.cooldownMs);
eq('cooldownMs:"abc" 回落默认', dailyCfg({ socialV2: { diaryDaily: { cooldownMs: 'abc' } } }).cooldownMs, DIARY_DAILY_DEFAULTS.cooldownMs);
eq('maxPerDay:2 生效', dailyCfg({ socialV2: { diaryDaily: { maxPerDay: 2 } } }).maxPerDay, 2);
eq('quietStart:0 合法（0 点起）', dailyCfg({ socialV2: { diaryDaily: { quietStart: 0 } } }).quietStart, 0);
eq('quietStart:99 回落默认', dailyCfg({ socialV2: { diaryDaily: { quietStart: 99 } } }).quietStart, 23);
eq('没有 socialV2 也不炸', dailyCfg(undefined).maxPerDay, 3);

// ---- 日期 ----
eq('localDayOf 格式', localDayOf(NOW), DAY);
eq('localDayOf 补零', localDayOf(new Date(2026, 0, 5, 9, 0, 0).getTime()), '2026-01-05');

// ---- 今天写过没有 ----
ok('按 day 命中', hasEntryOnDay([{ day: DAY }], DAY) === true);
ok('别的日子不算', hasEntryOnDay([{ day: '2026-10-27' }], DAY) === false);
ok('没 day 字段用 t 兜底', hasEntryOnDay([{ t: NOW }], DAY) === true);
ok('空数组', hasEntryOnDay([], DAY) === false);
ok('null 安全', hasEntryOnDay(null, DAY) === false);
ok('脏条目安全', hasEntryOnDay([null, 'x', { day: DAY }], DAY) === true);
ok('空 day 参数返回 false', hasEntryOnDay([{ day: DAY }], '') === false);

// ---- 安静时段 ----
ok('23 点在安静时段（跨零点）', inQuiet(23) === true);
ok('凌晨 3 点在安静时段', inQuiet(3) === true);
ok('8 点已经出了安静时段', inQuiet(8) === false);
ok('22 点还没进安静时段', inQuiet(22) === false);
ok('start==end 视为不安静', inQuiet(23, { quietStart: 23, quietEnd: 23 }) === false);
ok('自定义 0~6', inQuiet(2, { quietStart: 0, quietEnd: 6 }) === true && inQuiet(7, { quietStart: 0, quietEnd: 6 }) === false);

// ---- 决策 ----
const first = decideDailyDiary({ entries: [], now: NOW, hour: 14, state: { days: {} } });
ok('没写过 → 提醒', first.nudged === true && first.reason === 'nudge');
ok('提醒带正文', typeof first.line === 'string' && first.line.includes('今天还没写日记'));
ok('第 1 次不写「再提醒」', first.line.includes('再提醒一次') === false);
eq('记了一次', first.count, 1);
ok('状态里落了今天的账', first.state.days[DAY].count === 1 && first.state.days[DAY].lastAt === NOW);
ok('第一次就有改动', first.dirty === true);

const doneOne = decideDailyDiary({ entries: [{ day: DAY, text: '写了' }], now: NOW, hour: 14, state: { days: {} } });
ok('今天写过 → 不提醒', doneOne.nudged === false && doneOne.reason === 'done');
ok('写过时没有正文', doneOne.line === undefined);

const quietOne = decideDailyDiary({ entries: [], now: NOW, hour: 23, state: { days: {} } });
ok('安静时段不催', quietOne.nudged === false && quietOne.reason === 'quiet');

const withinCooldown = decideDailyDiary({ entries: [], now: NOW + 60 * 1000, hour: 14, state: first.state });
ok('冷却内不重复催', withinCooldown.nudged === false && withinCooldown.reason === 'cooldown');

const afterCooldown = decideDailyDiary({ entries: [], now: NOW + 3 * 3600 * 1000 + 1, hour: 18, state: first.state });
ok('冷却过后再催一次', afterCooldown.nudged === true && afterCooldown.count === 2);
ok('第二次带「再提醒一次」', afterCooldown.line.includes('再提醒一次'));

let st = { days: {} };
let t = new Date(2026, 9, 28, 9, 0, 0).getTime(); // 同一天的早上，留够 3 次的空间
for (let i = 0; i < 3; i += 1) {
  const r = decideDailyDiary({ entries: [], now: t, hour: 9, state: st });
  ok(`第 ${i + 1} 次催到了`, r.nudged === true);
  st = r.state;
  t += 3 * 3600 * 1000; // 09:00 -> 12:00 -> 15:00
}
const capped = decideDailyDiary({ entries: [], now: t, hour: 18, state: st });
ok('一天最多 3 次', capped.nudged === false && capped.reason === 'capped');

const disabled = decideDailyDiary({ entries: [], now: NOW, hour: 14, state: { days: {} }, cfg: { enabled: false } });
ok('关掉就不催', disabled.nudged === false && disabled.reason === 'disabled');

const late = decideDailyDiary({ entries: [], now: NOW, hour: 21, state: { days: {} } });
ok('20 点后换更强的措辞', late.line.includes('今天快过完了'));

// ---- 记账清理 ----
const oldState = { days: { '2026-10-01': { count: 1, lastAt: 1 }, '2026-10-02': { count: 1, lastAt: 2 }, '2026-10-27': { count: 2, lastAt: 9 } } };
const prunedOut = decideDailyDiary({ entries: [], now: NOW, hour: 14, state: oldState, cfg: { keepDays: 2 } });
ok('最老的账被清掉', prunedOut.state.days['2026-10-01'] === undefined);
ok('最近两条保留 + 今天新开', prunedOut.state.days['2026-10-02'] !== undefined && prunedOut.state.days['2026-10-27'] !== undefined && prunedOut.state.days[DAY] !== undefined);

const dirtyFree = decideDailyDiary({ entries: [{ day: DAY }], now: NOW, hour: 14, state: { days: { [DAY]: { count: 1, lastAt: NOW } } } });
ok('什么都没变时 dirty=false', dirtyFree.dirty === false);

// ---- 脏数据 ----
const dirtyState = decideDailyDiary({ entries: [], now: NOW, hour: 14, state: { days: { [DAY]: { count: 'x', lastAt: 'y' } } } });
ok('脏计数当 0 处理（会催）', dirtyState.nudged === true && dirtyState.count === 1);
ok('乱传 state 不炸', decideDailyDiary({ entries: [], now: NOW, hour: 14, state: 'nope' }).nudged === true);
ok('乱传 cfg 不炸', decideDailyDiary({ entries: [], now: NOW, hour: 14, cfg: 'nope' }).nudged === true);

// ---- 文案 ----
ok('白天文案提到 qq_diary', dailyDiaryLine({ hour: 10 }).includes('qq_diary'));
ok('夜里文案不许汇报', dailyDiaryLine({ hour: 10 }).includes('汇报'));
ok('强文案提到明天', dailyDiaryLine({ hour: 22 }).includes('明天'));

console.log(`\n${fails.length === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
}
