// 世界层 A 阶段：life.js 单测
// 跑法：node scripts/test-life.mjs
import {
  LIFE_DEFAULTS,
  buildLifeAsk,
  lifeCfg,
  lifeDayFor,
  lifeLineFor,
  localDayOf,
  normalizeLifePlan,
  pruneLife,
  setLifeDay,
  shiftDay,
  summarizeLifeDay
} from '../src/life.js';

let pass = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) pass += 1;
  else fails.push(`${name}${extra ? ` —— ${extra}` : ''}`);
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

// ---------- 配置：脏值一律回落，不许出现「配成 0」
const d = lifeCfg({});
eq('默认 maxPlans', d.maxPlans, 3);
eq('默认 planChars', d.planChars, 30);
ok('默认开启', d.enabled === true);
eq('enabled:false 关掉', lifeCfg({ socialV2: { life: { enabled: false } } }).enabled, false);
eq('null 不当 0（maxPlans）', lifeCfg({ socialV2: { life: { maxPlans: null } } }).maxPlans, 3);
eq('空串不当 0（planChars）', lifeCfg({ socialV2: { life: { planChars: '' } } }).planChars, 30);
eq('脏字符串回落', lifeCfg({ socialV2: { life: { maxPlans: 'abc' } } }).maxPlans, 3);
eq('上限夹住（maxPlans 99）', lifeCfg({ socialV2: { life: { maxPlans: 99 } } }).maxPlans, 5);
eq('下限夹住（maxPlans 0）', lifeCfg({ socialV2: { life: { maxPlans: 0 } } }).maxPlans, 1);
eq('小数取整', lifeCfg({ socialV2: { life: { keepDays: 7.8 } } }).keepDays, 7);

// ---------- 日期
const at = (y, m, day, h) => new Date(y, m - 1, day, h, 0, 0).getTime();
eq('localDayOf', localDayOf(at(2026, 10, 28, 15)), '2026-10-28');
eq('localDayOf 补零', localDayOf(at(2026, 1, 5, 9)), '2026-01-05');
eq('shiftDay 跨月', shiftDay('2026-10-31', 1), '2026-11-01');
eq('shiftDay 跨年', shiftDay('2026-12-31', 1), '2027-01-01');
eq('shiftDay 往回', shiftDay('2026-03-01', -1), '2026-02-28');
eq('shiftDay 脏输入', shiftDay('nope', 1), '');

const before = lifeDayFor(at(2026, 10, 28, 15));
eq('白天写今天', before.day, '2026-10-28');
ok('白天不是明天', before.isTomorrow === false);
const after = lifeDayFor(at(2026, 10, 28, 21));
eq('20 点后写明天', after.day, '2026-10-29');
ok('20 点后是明天', after.isTomorrow === true);
eq('switchHour 可调（18 点算明天）', lifeDayFor(at(2026, 10, 28, 18), { switchHour: 18 }).day, '2026-10-29');

// ---------- 洗数据
const n1 = normalizeLifePlan({
  outfit: '  白色围裙那条裙子，头发随手扎起来  ',
  moodHint: '想安静一点',
  plans: [
    { period: '上午', text: '把上次没看完的旧书看完' },
    { period: '下午', text: '去海边拍两张' },
    { period: '晚上', text: '整理相册' },
    { period: '深夜', text: '不该存在的时段' },
    { period: '上午', text: '第四条会被砍掉' }
  ]
});
eq('picks 三条（maxPlans 3）', n1.plans.length, 3);
eq('超出的第四条被砍掉', n1.plans[2], { period: '晚上', text: '整理相册' });
eq(
  '非法时段被丢掉但正文保留',
  normalizeLifePlan({ plans: [{ period: '深夜', text: '不该存在的时段' }] }).plans[0],
  { period: '', text: '不该存在的时段' }
);
eq('空白被压成一个空格', n1.outfit, '白色围裙那条裙子，头发随手扎起来');
eq('字符串计划也认', normalizeLifePlan({ plans: ['发呆'] }).plans, [{ period: '', text: '发呆' }]);

const n2 = normalizeLifePlan({ plans: ['  ', { period: '上午', text: '' }], outfit: '  ', moodHint: '' });
ok('全空返回 null', n2 === null);
ok('非对象返回 null', normalizeLifePlan('哈哈') === null);
ok('数组返回 null', normalizeLifePlan([1, 2]) === null);

const longText = '很'.repeat(60);
eq('正文按 planChars 截断', normalizeLifePlan({ plans: [{ period: '上午', text: longText }] }, { planChars: 10 }).plans[0].text.length, 10);
const dup = normalizeLifePlan({ plans: [{ period: '上午', text: '看书' }, { period: '上午', text: '看书' }] });
eq('同一条去重', dup.plans.length, 1);

// ---------- 存盘 / 清理
let store = { version: 1, days: {} };
store = setLifeDay(store, '2026-10-29', n1, { keepDays: 14 });
ok('写进去了', Boolean(store.days['2026-10-29']));
eq('来源标 settle', store.days['2026-10-29'].source, 'settle');
ok('脏 day 不写', setLifeDay(store, '2026/10/30', n1).days['2026/10/30'] === undefined);
ok('plan 为空不写', setLifeDay(store, '2026-10-30', null).days['2026-10-30'] === undefined);

const withOld = {
  days: {
    '2026-09-01': { plans: [{ period: '', text: '很旧' }] },
    '2026-10-27': { plans: [{ period: '', text: '昨天' }] },
    '2026-10-28': { plans: [{ period: '', text: '今天' }] },
    'bad-key': { plans: [] }
  }
};
const pruned = pruneLife(withOld, { now: at(2026, 10, 28, 12), keepDays: 7 });
ok('超窗的被清掉', pruned.days['2026-09-01'] === undefined);
ok('窗口内的留下', Boolean(pruned.days['2026-10-27']));
ok('脏键被清掉', pruned.days['bad-key'] === undefined);

// ---------- 注入
const line = lifeLineFor({ days: { '2026-10-28': { plans: [{ period: '上午', text: '看书' }, { period: '晚上', text: '整理相册' }, { period: '', text: '发呆' }], outfit: '白围裙', moodHint: '想安静' } } }, at(2026, 10, 28, 15));
ok('有【今天】', line.startsWith('【今天】'), line);
ok('按时段排序', line.indexOf('上午') < line.indexOf('晚上'), line);
ok('无时段那条也在', line.includes('发呆'), line);
ok('带穿着', line.includes('白围裙'), line);
ok('带心情', line.includes('想安静'), line);
ok('不是任务播报', line.includes('不用逐条汇报'), line);
eq('没有今天的数据就空串', lifeLineFor({ days: { '2026-10-27': { plans: [{ period: '', text: 'x' }] } } }, at(2026, 10, 28, 15)), '');
eq('空库空串', lifeLineFor({}, at(2026, 10, 28, 15)), '');
const onlyOutfit = lifeLineFor({ days: { '2026-10-28': { plans: [], outfit: '白围裙' } } }, at(2026, 10, 28, 15));
ok('只有穿着时也说没什么安排', onlyOutfit.includes('没什么安排'), onlyOutfit);

// ---------- 摘要 / 提问
eq('摘要', summarizeLifeDay({ days: { '2026-10-28': { plans: [{ period: '上午', text: '看书' }, { period: '晚上', text: '整理相册' }] } } }, '2026-10-28'), '上午 看书；晚上 整理相册');
eq('摘要空日', summarizeLifeDay({ days: {} }, '2026-10-28'), '');
const ask = buildLifeAsk({ dayLabel: '明天', previous: '上午 看书', moodLabel: '有点闷', maxPlans: 2, planChars: 20 });
ok('提问含明天', ask.includes('明天'), ask);
ok('提问含条数', ask.includes('最多 2 条'), ask);
ok('提问含字数', ask.includes('20 字'), ask);
ok('提问含别重复', ask.includes('别重复'), ask);
ok('提问含心情', ask.includes('有点闷'), ask);
ok('提问含 JSON 字段', ask.includes('"life"'), ask);
const askBare = buildLifeAsk({ dayLabel: '今天' });
ok('没有前一天就不提别重复', !askBare.includes('别重复'), askBare);
eq('标签最多六字', buildLifeAsk({ dayLabel: '一二三四五六七八' }).includes('一二三四五六'), true);

if (fails.length) {
  console.error(`✗ test-life: ${pass} 过 / ${fails.length} 败`);
  for (const f of fails) console.error('  · ' + f);
  process.exit(1);
}
console.log(`✓ test-life: ${pass} 项全过（LIFE_DEFAULTS.maxPlans=${LIFE_DEFAULTS.maxPlans}）`);
