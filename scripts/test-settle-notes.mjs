// 手札（notes）在结算里的解析与写入计划。
import { buildSettlePrompt, parseSettleJSON, planSettleWrites, settleCfg, SETTLE_DEFAULTS } from '../src/settle.js';

let pass = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${extra ? ' —— ' + extra : ''}`);
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

const base = {
  key: 'private:1124721191',
  isGroup: false,
  lines: [{ who: '主人', text: '今天累死了', self: false }],
  impressions: []
};

// ---- 配置 ----
eq('默认 maxNotes = 2', SETTLE_DEFAULTS.maxNotes, 2);
eq('没配时 2', settleCfg({}).maxNotes, 2);
eq('配 99 夹到 4', settleCfg({ socialV2: { settle: { maxNotes: 99 } } }).maxNotes, 4);
eq('配 null 回落 2', settleCfg({ socialV2: { settle: { maxNotes: null } } }).maxNotes, 2);

// ---- 提示词 ----
const p = buildSettlePrompt(base);
ok('格式里有 notes', p.includes('"notes"'));
ok('有第 6 条铁律（手札）', p.includes('6. 手札（notes）'));
ok('手札要求「还挂着」', p.includes('心里还挂着'));
ok('明说别写情绪形容词', p.includes('情绪形容词'));
ok('JSON-only 顺延成第 8 条（手札 6、日记草稿 7）', p.includes('8. 只输出一个 JSON 对象'));
ok('没有第 6 条残留旧文本', !p.includes('6. 只输出一个 JSON 对象'));

// ---- 解析 ----
const r1 = parseSettleJSON(JSON.stringify({ notes: [{ text: '答应他的奶茶还没买' }] }));
eq('解析一条手札', r1.value.notes, [{ text: '答应他的奶茶还没买' }]);

const r2 = parseSettleJSON(JSON.stringify({ notes: [{ text: '  ' }, { text: '有效的' }] }));
eq('空文本丢掉', r2.value.notes, [{ text: '有效的' }]);

const r3 = parseSettleJSON(JSON.stringify({ notes: [{ text: '重' }, { text: '重' }] }));
eq('同批去重', r3.value.notes.length, 1);

const r4 = parseSettleJSON(JSON.stringify({ notes: [{ text: '啊'.repeat(60) }] }));
ok('超 40 字被截断', r4.value.notes[0].text.length === 40, `len=${r4.value.notes[0]?.text?.length}`);

const r5 = parseSettleJSON(JSON.stringify({ notes: ['直接给字符串也行'] }));
eq('字符串形式也认', r5.value.notes, [{ text: '直接给字符串也行' }]);

const r6 = parseSettleJSON(JSON.stringify({ notes: '不是数组' }));
eq('不是数组就当没有', r6.value.notes, []);

const r7 = parseSettleJSON(JSON.stringify({ mood: null }));
eq('完全没提 notes 时是空数组', r7.value.notes, []);

// ---- 写入计划 ----
const three = { mood: null, impressions: [], portraits: [], notes: [{ text: '1' }, { text: '2' }, { text: '3' }] };
eq('上限 2 只写两条', planSettleWrites(three, { maxNotes: 2 }).notes.length, 2);
eq('超限条数记下来', planSettleWrites(three, { maxNotes: 2 }).skippedNotes, 1);
eq('上限 0 一条不写', planSettleWrites(three, { maxNotes: 0 }).notes.length, 0);
eq('没给上限时用默认 2', planSettleWrites(three).notes.length, 2);
eq('portrait 逻辑没被破坏', planSettleWrites({ portraits: [{ subject: 'A', facet: 'view', text: 'x' }], notes: [] }, { maxPortraits: 2 }).portraits.length, 1);
eq('脏输入不炸', planSettleWrites(undefined).notes, []);

console.log(`\n结算手札：${pass} 项通过，${fails.length} 项失败`);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('全绿 ✓');