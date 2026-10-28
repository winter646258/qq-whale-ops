// 世界层 A 阶段：settle.js 的 life 接线单测（不碰网络，只验提示词与计划）
// 跑法：node scripts/test-settle-life.mjs
import { buildSettlePrompt, parseSettleJSON, planSettleWrites } from '../src/settle.js';
import { buildLifeAsk, normalizeLifePlan } from '../src/life.js';

let pass = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) pass += 1;
  else fails.push(`${name}${extra ? ` —— ${extra}` : ''}`);
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

const lines = [
  { self: false, who: '管理员', text: '明天再告诉你那件事' },
  { self: true, who: '我', text: '行 我等着' }
];

// ---------- 不要 life 的时候，提示词里一个字都不许多
const plain = buildSettlePrompt({ key: 'private:1', isGroup: false, lines, impressions: [], selfView: '' });
ok('默认不含额外任务', !plain.includes('额外任务'), plain.slice(0, 80));
ok('默认输出格式不含 life', !plain.includes('"life"'));
ok('默认仍然有铁律 7', plain.includes('7. 只输出一个 JSON 对象'));
ok('默认仍然要求 notes', plain.includes('"notes"'));
ok('默认仍然要求 portrait', plain.includes('"portrait"'));

// ---------- 要 life 的时候
const ask = buildLifeAsk({ dayLabel: '明天', previous: '上午 看书', moodLabel: '有点闷', maxPlans: 3, planChars: 30 });
const withLife = buildSettlePrompt({ key: 'private:1', isGroup: false, lines, impressions: [], selfView: '', lifeAsk: ask });
ok('含额外任务', withLife.includes('额外任务：'), '');
ok('含那段提问原文', withLife.includes('写一写她明天想怎么过'), '');
ok('输出格式含 life 字段', withLife.includes('"life"'));
ok('output 里带 outfit', withLife.includes('"outfit"'));
ok('output 里带 plans', withLife.includes('"plans"'));
ok('output 里带 moodHint', withLife.includes('"moodHint"'));
ok('字段说明提到 life 是她自己的日子', withLife.includes('life 是她自己的日子'));
ok('字段说明禁止写成任务清单', withLife.includes('不许写成任务清单'));
ok('铁律长度没变（7 条仍在）', withLife.includes('7. 只输出一个 JSON 对象'));

// lifeAsk 是脏值（非字符串）时不许炸，也不许把垃圾塞进提示词
const junk = buildSettlePrompt({ key: 'private:1', lines, lifeAsk: { a: 1 } });
ok('脏 lifeAsk 不炸', typeof junk === 'string' && junk.includes('7. 只输出一个 JSON 对象'));
const huge = buildSettlePrompt({ key: 'private:1', lines, lifeAsk: 'x'.repeat(5000) });
ok('lifeAsk 截到 900 字', huge.length < plain.length + 1500, `${plain.length} -> ${huge.length}`);

// ---------- 解析：带 life 的 JSON 能过
const answer = JSON.stringify({
  mood: { pleasure: 0.3, arousal: 0.1, dominance: 0, label: '挺高兴', reason: '明天有事做' },
  impressions: [{ who: '管理员', text: '说好明天告诉我' }],
  portrait: [],
  notes: [{ text: '他还欠我一句' }],
  life: { outfit: '白围裙那条', plans: [{ period: '上午', text: '看完那本旧书' }], moodHint: '想安静过' }
});
const parsed = parseSettleJSON('```json\n' + answer + '\n```');
ok('带 life 也能解析', parsed.ok === true, parsed.error || '');
ok('life 原样透传', parsed.ok && parsed.value.life && parsed.value.life.outfit === '白围裙那条');

const plan = planSettleWrites(parsed.value, { maxImpressions: 3 });
ok('计划里有 life', Boolean(plan.life));
eq('计划里 life 内容', plan.life.plans, [{ period: '上午', text: '看完那本旧书' }]);
eq('没有 life 时是 null', planSettleWrites({ mood: null }).life, null);
eq('life 是数组时当没有', planSettleWrites({ life: [1, 2] }).life, null);
eq('life 是字符串时当没有', planSettleWrites({ life: '哈哈' }).life, null);

// ---------- 洗数据接到一起（life.js × settle.js）
const normalized = normalizeLifePlan(plan.life, { maxPlans: 3, planChars: 30 });
eq('洗出来的计划条数', normalized.plans.length, 1);
eq('洗出来的穿着', normalized.outfit, '白围裙那条');

if (fails.length) {
  console.error(`✗ test-settle-life: ${pass} 过 / ${fails.length} 败`);
  for (const f of fails) console.error('  · ' + f);
  process.exit(1);
}
console.log(`✓ test-settle-life: ${pass} 项全过`);
