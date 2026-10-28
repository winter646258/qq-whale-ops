// portrait 接进结算的单测：只测纯逻辑（提示词、解析、写入计划）。
import {
  SETTLE_DEFAULTS,
  settleCfg,
  buildSettlePrompt,
  parseSettleJSON,
  planSettleWrites
} from '../src/settle.js';

let pass = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${extra ? ' —— ' + extra : ''}`);
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

// ---- 默认值与配置 ----
eq('默认 maxPortraits = 2', SETTLE_DEFAULTS.maxPortraits, 2);
eq('配置缺省时 maxPortraits = 2', settleCfg({}).maxPortraits, 2);
eq('配置给 5 时用 5', settleCfg({ socialV2: { settle: { maxPortraits: 5 } } }).maxPortraits, 5);
eq('配置给 99 时夹到 6', settleCfg({ socialV2: { settle: { maxPortraits: 99 } } }).maxPortraits, 6);
eq('配置给 -3 时夹到 0', settleCfg({ socialV2: { settle: { maxPortraits: -3 } } }).maxPortraits, 0);
eq('配置给脏字符串时回落 2', settleCfg({ socialV2: { settle: { maxPortraits: 'abc' } } }).maxPortraits, 2);
eq('配置给 null 时回落 2（不是 0）', settleCfg({ socialV2: { settle: { maxPortraits: null } } }).maxPortraits, 2);

// ---- 提示词 ----
const base = {
  key: 'private:1124721191',
  isGroup: false,
  lines: [
    { who: '主人', text: '今天累死了', self: false },
    { who: '我', text: '那就别熬了', self: true }
  ],
  impressions: [{ who: '管理员', text: '爱出题考梗' }]
};
const p0 = buildSettlePrompt(base);
ok('提示词里有 portrait 字段示例', p0.includes('"portrait"'));
ok('提示词里点了 facet 三个值', p0.includes('doing / view / bond'));
ok('提示词强调长期看法', p0.includes('长期看法'));
ok('提示词明说日常寒暄不写', p0.includes('日常寒暄'));
ok('提示词有第 6 条铁律', p0.includes('6. 只输出一个 JSON 对象'));
ok('没有传自述时显示占位', p0.includes('（还没有自述）'));
ok('没传自述时不出现 undefined', !p0.includes('undefined'));

const p1 = buildSettlePrompt({ ...base, selfView: '· 主人：爱熬夜，嘴上说累还是接着干' });
ok('传了自述就原样出现在提示词里', p1.includes('爱熬夜，嘴上说累还是接着干'));
ok('传了自述就不再是占位', !p1.includes('（还没有自述）'));
const p2 = buildSettlePrompt({ ...base, selfView: 'x'.repeat(5000) });
ok('自述超长被截断（≤2000 字）', !p2.includes('x'.repeat(2001)));
const p3 = buildSettlePrompt({ ...base, selfView: '  \r\n  ' });
ok('自述只有空白时当没有', p3.includes('（还没有自述）'));

// ---- 解析 ----
const good = JSON.stringify({
  mood: { pleasure: 0.3, arousal: 0.1, dominance: 0, label: '有点来气', reason: '被晾了半天' },
  impressions: [{ who: '管理员', text: '今天是真的累' }],
  portrait: [{ subject: '管理员', facet: 'view', text: '他累了也会硬撑，得主动问' }]
});
const r1 = parseSettleJSON(good);
ok('解析成功', r1.ok === true, r1.error);
eq('portrait 解析出一条', r1.value.portraits, [{ subject: '管理员', facet: 'view', text: '他累了也会硬撑，得主动问' }]);
eq('情绪与印象没被影响', [r1.value.mood.label, r1.value.impressions.length], ['有点来气', 1]);

const r2 = parseSettleJSON(JSON.stringify({ portrait: [{ subject: '我', facet: 'mood', text: '乱写的' }] }));
eq('facet 不在白名单就丢掉', r2.value.portraits, []);

const r3 = parseSettleJSON(JSON.stringify({ portrait: [{ subject: '我', facet: 'DOING', text: '在写代码' }] }));
eq('facet 大小写归一', r3.value.portraits, [{ subject: '我', facet: 'doing', text: '在写代码' }]);

const r4 = parseSettleJSON(JSON.stringify({ portrait: [{ subject: '我', facet: 'doing', text: '啊'.repeat(80) }] }));
ok('text 超 60 字被截断', r4.value.portraits[0].text.length === 60, `len=${r4.value.portraits[0]?.text?.length}`);

const r5 = parseSettleJSON(JSON.stringify({ portrait: [{ subject: '', facet: 'doing', text: '没有主体' }] }));
eq('subject 为空丢掉', r5.value.portraits, []);

const r6 = parseSettleJSON(JSON.stringify({
  portrait: [
    { subject: '管理员', facet: 'bond', text: '第一条' },
    { subject: '管理员', facet: 'bond', text: '第二条重复' }
  ]
}));
eq('同人同 facet 去重', r6.value.portraits.length, 1);

const r7 = parseSettleJSON(JSON.stringify({ portrait: '不是数组' }));
eq('portrait 不是数组就当没有', r7.value.portraits, []);

const r8 = parseSettleJSON(JSON.stringify({ mood: null }));
eq('完全没有 portrait 字段时是空数组', r8.value.portraits, []);

const r9 = parseSettleJSON(JSON.stringify({ portrait: [{ subject: '__proto__', facet: 'view', text: '污染' }] }));
eq('原型污染主体丢掉', r9.value.portraits, []);

const r10 = parseSettleJSON(JSON.stringify({ portrait: [{ subject: '管理员', facet: 'view', text: '' }] }));
eq('text 为空丢掉', r10.value.portraits, []);

const r11 = parseSettleJSON('```json\n' + good + '\n```');
ok('代码块包裹也能解析出 portrait', r11.ok === true && r11.value.portraits.length === 1);

// ---- 写入计划 ----
const planIn = {
  mood: null,
  impressions: [],
  portraits: [
    { subject: 'A', facet: 'doing', text: '1' },
    { subject: 'B', facet: 'view', text: '2' },
    { subject: 'C', facet: 'bond', text: '3' }
  ]
};
const pl = planSettleWrites(planIn, { maxPortraits: 2 });
eq('上限 2 只写前两条', pl.portraits.length, 2);
eq('超限条数记下来', pl.skippedPortraits, 1);
eq('上限 0 一条都不写', planSettleWrites(planIn, { maxPortraits: 0 }).portraits.length, 0);
eq('上限 99 夹到 6', planSettleWrites({ ...planIn, portraits: Array.from({ length: 9 }, (_, i) => ({ subject: 'X' + i, facet: 'doing', text: 't' })) }, { maxPortraits: 99 }).portraits.length, 6);
eq('没给上限时用默认 2', planSettleWrites(planIn).portraits.length, 2);
eq('plan 里 impressions 逻辑没被破坏', planSettleWrites({ impressions: [1, 2, 3, 4], portraits: [] }, { maxImpressions: 2 }).skippedImpressions, 2);
eq('脏输入不炸', planSettleWrites(null).portraits, []);

console.log(`\nportrait 结算：${pass} 项通过，${fails.length} 项失败`);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('全绿 ✓');