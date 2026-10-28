// 纪念日（dates.js）单测。
import {
  DATES_DEFAULTS,
  GIFT_TYPES,
  datesCfg,
  parseMonthDay,
  normalizeDate,
  addDates,
  daysUntil,
  upcomingDates,
  datesLine,
  summarizeDates,
  buildDatesAsk
} from '../src/dates.js';

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fails.push(name + (extra ? `（${extra}）` : ''));
}
function eq(name, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  ok(name, a === b, `got ${a} want ${b}`);
}

// 2026-10-28 23:00 本地时间
const T = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const NOW = T(2026, 10, 28, 23);

eq('默认值', datesCfg({}), DATES_DEFAULTS);
eq('覆盖 lookahead', datesCfg({ socialV2: { dates: { lookaheadDays: 7 } } }).lookaheadDays, 7);
eq('脏值回落', datesCfg({ socialV2: { dates: { lookaheadDays: 'x' } } }).lookaheadDays, DATES_DEFAULTS.lookaheadDays);
eq('gift 白名单', GIFT_TYPES, ['text', 'image', 'both']);

// ---- parseMonthDay ----
eq('中文月日', parseMonthDay('3月7日'), { month: 3, day: 7 });
eq('中文带号', parseMonthDay('10月20号'), { month: 10, day: 20 });
eq('短横线', parseMonthDay('3-7'), { month: 3, day: 7 });
eq('完整日期取月日', parseMonthDay('1999-03-07'), { month: 3, day: 7 });
eq('对象', parseMonthDay({ month: 3, day: 7 }), { month: 3, day: 7 });
eq('非法月', parseMonthDay('13月1日'), null);
eq('非法日', parseMonthDay('3月32日'), null);
eq('空', parseMonthDay(''), null);
eq('认不出', parseMonthDay('哪天来着'), null);

// ---- normalize / add ----
eq('缺名字丢', normalizeDate({ month: 3, day: 7 }, { now: NOW }), null);
eq('缺日期丢', normalizeDate({ name: '生日' }, { now: NOW }), null);
const nd = normalizeDate({ name: '他的生日', month: 3, day: 7, note: '不爱过生日', giftType: 'image' }, { now: NOW });
eq('字段齐全', [nd.name, nd.month, nd.day, nd.repeat, nd.giftType], ['他的生日', 3, 7, 'year', 'image']);
eq('非法 giftType 归 text', normalizeDate({ name: 'x', month: 1, day: 1, giftType: 'zzz' }, { now: NOW }).giftType, 'text');
eq('原型污染丢', normalizeDate({ name: '__proto__', month: 1, day: 1 }, { now: NOW }), null);

let r = addDates({ version: 1, items: [] }, { items: [{ name: '他的生日', month: 3, day: 7 }], now: NOW });
eq('加一条', r.added, 1);
ok('带 id', String(r.store.items[0].id || '').length > 2);
r = addDates(r.store, { items: [{ name: '他的生日', month: 3, day: 7, note: '今年别买蛋糕' }], now: NOW });
eq('同名同日不重复', r.added, 0);
eq('算更新', r.updated, 1);
eq('note 被补上', r.store.items[0].note, '今年别买蛋糕');
r = addDates(r.store, { items: [{ name: '认识那天', month: 10, day: 20 }], now: NOW });
eq('不同日子各一条', r.store.items.length, 2);

// ---- daysUntil ----
eq('今天 = 0', daysUntil(10, 28, NOW), 0);
eq('明天 = 1', daysUntil(10, 29, NOW), 1);
eq('明年 1 月 1 日跨年', daysUntil(1, 1, NOW), 65);
eq('今年已过 → 算到明年', daysUntil(3, 7, NOW), 130);
eq('大月边界', daysUntil(11, 1, NOW), 4);

// ---- upcoming / line ----
const store = {
  version: 1,
  items: [
    { id: 'a', name: '他的生日', month: 10, day: 28, note: '不爱过生日', giftType: 'image', repeat: 'year' },
    { id: 'b', name: '认识那天', month: 10, day: 30, repeat: 'year', giftType: 'text' },
    { id: 'c', name: '远的事', month: 6, day: 1, repeat: 'year', giftType: 'text' }
  ]
};
const up = upcomingDates(store, { now: NOW });
eq('今天一条', up.today.map((x) => x.name), ['他的生日']);
eq('三天内一条', up.soon.map((x) => [x.name, x.left]), [['认识那天', 2]]);
const line = datesLine(store, { now: NOW });
ok('当天段出现', line.includes('【今天是】'), line);
ok('当天带备注', line.includes('不爱过生日'));
ok('要图时催动笔', line.includes('动笔'), line);
ok('预告段出现', line.includes('【快到了】') && line.includes('认识那天还有 2 天'), line);
eq('关掉就是空', datesLine(store, { now: NOW, cfg: { enabled: false } }), '');
eq('maxInject 0 就是空', datesLine(store, { now: NOW, cfg: { maxInject: 0 } }), '');
const farOnly = { version: 1, items: [{ id: 'x', name: '远', month: 6, day: 1, repeat: 'year', giftType: 'text' }] };
eq('没有临近的就不注入', datesLine(farOnly, { now: NOW }), '');
const soonOnly = { version: 1, items: [{ id: 'y', name: '快到的', month: 10, day: 30, repeat: 'year', giftType: 'text' }] };
ok('只有预告时没有当天段', !datesLine(soonOnly, { now: NOW }).includes('【今天是】'));

eq('摘要列月日', summarizeDates(store, { limit: 2 }), '- 10 月 28 日：他的生日\n- 10 月 30 日：认识那天');
eq('空摘要', summarizeDates({ version: 1, items: [] }), '（没有）');
ok('任务段要求不推算', buildDatesAsk().includes('不许推算') || buildDatesAsk().includes('不许假设'));

console.log(`dates: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
