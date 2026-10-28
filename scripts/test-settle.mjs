// 离线断言：结算层（src/settle.js）。真 import，不复制逻辑。
import assert from 'node:assert/strict';
import {
  SETTLE_DEFAULTS, buildSettlePrompt, parseSettleJSON, pickSettleMessages, planSettleWrites, settleCfg, shouldSettle
} from '../src/settle.js';

let pass = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n    ${error?.message ?? error}`); process.exitCode = 1; }
}

const NOW = 1793000000000;
const MIN = 60 * 1000;
const msg = (text, extra = {}) => ({ sender: '小雨', time: NOW - 1000, plain: text, ...extra });

console.log('settleCfg');
ok('默认值', () => {
  const c = settleCfg({});
  assert.equal(c.enabled, true);
  assert.equal(c.delayMs, 45000);
  assert.equal(c.cooldownMs, 30 * MIN);
  assert.equal(c.minMessages, 4);
  assert.equal(c.maxImpressions, 3);
});
ok('配置覆盖', () => {
  const c = settleCfg({ socialV2: { settle: { minMessages: 8, maxImpressions: 1, preset: ' qq-chat ' } } });
  assert.equal(c.minMessages, 8);
  assert.equal(c.maxImpressions, 1);
  assert.equal(c.preset, 'qq-chat');
});
ok('脏值回落 + 夹紧', () => {
  const c = settleCfg({ socialV2: { settle: { delayMs: 10, cooldownMs: 'abc', minMessages: 0, maxImpressions: 99 } } });
  assert.equal(c.delayMs, 5000);          // 夹到下限
  assert.equal(c.cooldownMs, 30 * MIN);   // 非数字回落默认
  assert.equal(c.minMessages, 1);         // 0 → 1
  assert.equal(c.maxImpressions, 10);     // 99 → 10
});
ok('null 不当 0 用', () => {
  const c = settleCfg({ socialV2: { settle: { cooldownMs: null, timeoutMs: null } } });
  assert.equal(c.cooldownMs, SETTLE_DEFAULTS.cooldownMs);
  assert.equal(c.timeoutMs, SETTLE_DEFAULTS.timeoutMs);
});

console.log('pickSettleMessages');
ok('空文本与别的机器人被丢掉', () => {
  const got = pickSettleMessages([
    msg('在吗'), msg('   '), msg('机器人插话', { isBot: true }), msg('好的', { isSelf: true })
  ]);
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((m) => m.text), ['在吗', '好的']);
});
ok('她的发言标 self 且 who 是「我」', () => {
  const got = pickSettleMessages([msg('我回来了', { isSelf: true })]);
  assert.equal(got[0].self, true);
  assert.equal(got[0].who, '我');
});
ok('超字数从头裁掉，留最近的', () => {
  const long = 'x'.repeat(600);
  const got = pickSettleMessages([msg(long), msg(long), msg(long), msg('最后一句')], { maxChars: 700 });
  assert.equal(got.at(-1).text, '最后一句');
  assert.ok(got.length <= 2, `len=${got.length}`);
  assert.ok(got.reduce((s, m) => s + m.text.length, 0) <= 700);
});
ok('条数上限生效', () => {
  const many = Array.from({ length: 30 }, (_, i) => msg(`第${i}句`));
  assert.equal(pickSettleMessages(many, { maxMessages: 5 }).length, 5);
});
ok('空数组不炸', () => {
  assert.deepEqual(pickSettleMessages(null), []);
  assert.deepEqual(pickSettleMessages([]), []);
});

console.log('shouldSettle');
const busySt = (extra = {}) => ({
  recentMessages: [
    { ...msg('一'), time: NOW - 5000 },
    { ...msg('二'), time: NOW - 4000 },
    { ...msg('三'), time: NOW - 3000 },
    { ...msg('四'), time: NOW - 2000 }
  ],
  ...extra
});
ok('关闭时不动', () => {
  assert.equal(shouldSettle({ st: busySt(), now: NOW, cfg: { socialV2: { settle: { enabled: false } } } }).reason, 'disabled');
});
ok('没有会话状态', () => {
  assert.equal(shouldSettle({ st: null, now: NOW }).reason, 'no-state');
});
ok('暂停的会话不动', () => {
  assert.equal(shouldSettle({ st: busySt({ paused: true }), now: NOW }).reason, 'paused');
});
ok('冷却期内不动', () => {
  const st = busySt({ lastSettleAt: NOW - 5 * MIN });
  assert.equal(shouldSettle({ st, now: NOW }).reason, 'cooldown');
});
ok('对方说得太少不动（她自己的话不算）', () => {
  const st = {
    lastSettleAt: NOW - 60 * MIN,
    recentMessages: [
      { ...msg('嗯'), time: NOW - 3000 },
      { ...msg('我说两句', { isSelf: true }), time: NOW - 2500 },
      { ...msg('我说三句', { isSelf: true }), time: NOW - 2000 }
    ]
  };
  const r = shouldSettle({ st, now: NOW });
  assert.equal(r.reason, 'too-few');
  assert.equal(r.pending, 1);
});
ok('够了就放行，pending 只数上次结算之后的', () => {
  const st = busySt({ lastSettleAt: NOW - 60 * MIN });
  const r = shouldSettle({ st, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.pending, 4);
});
ok('冷却是从上次结算算起，不是从上次消息', () => {
  const st = busySt({ lastSettleAt: NOW - 29 * MIN });
  assert.equal(shouldSettle({ st, now: NOW }).reason, 'cooldown');
  assert.equal(shouldSettle({ st, now: NOW + 2 * MIN }).ok, true);
});

console.log('buildSettlePrompt');
ok('带上输出格式与三条铁律', () => {
  const p = buildSettlePrompt({ key: 'group:906710082', isGroup: true, lines: pickSettleMessages(busySt().recentMessages) });
  assert.match(p, /只输出一个 JSON 对象/);
  assert.match(p, /"mood"/);
  assert.match(p, /"impressions"/);
  assert.match(p, /绝对不许想象/);
  assert.match(p, /群聊（group:906710082）/);
});
ok('原文按「谁：说了什么」排开，她的发言是「我」', () => {
  const p = buildSettlePrompt({
    key: 'private:1',
    lines: [{ who: '小雨', text: '今天好累', self: false }, { who: '我', text: '那早点睡', self: true }]
  });
  assert.match(p, /小雨：今天好累/);
  assert.match(p, /我：那早点睡/);
});
ok('已有印象会带进去，好让她修正而不是重复', () => {
  const p = buildSettlePrompt({ key: 'private:1', lines: [], impressions: [{ who: '小雨', text: '做设计的，作息颠倒' }] });
  assert.match(p, /小雨：做设计的，作息颠倒/);
});
ok('没有原文时写「空」，不编', () => {
  assert.match(buildSettlePrompt({ key: 'private:1', lines: [] }), /（空）/);
  assert.match(buildSettlePrompt({ key: 'private:1', lines: [] }), /还没有/);
});

console.log('parseSettleJSON');
ok('纯 JSON', () => {
  const r = parseSettleJSON('{"mood":{"pleasure":0.4,"arousal":-0.2,"dominance":0.1,"label":"有点心虚","reason":"答应的事拖了"},"impressions":[{"who":"小雨","text":"怕被催"}]}');
  assert.equal(r.ok, true);
  assert.equal(r.value.mood.label, '有点心虚');
  assert.equal(r.value.mood.pleasure, 0.4);
  assert.deepEqual(r.value.impressions, [{ who: '小雨', text: '怕被催' }]);
});
ok('代码块包着也能取', () => {
  const r = parseSettleJSON('```json\n{"mood":null,"impressions":[]}\n```');
  assert.equal(r.ok, true);
  assert.equal(r.value.mood, null);
  assert.deepEqual(r.value.impressions, []);
});
ok('前后有废话也能取', () => {
  const r = parseSettleJSON('好的，这是结果：\n{"mood":null,"impressions":[{"who":"阿豪","text":"爱熬夜"}]}\n希望有用。');
  assert.equal(r.ok, true);
  assert.equal(r.value.impressions[0].who, '阿豪');
});
ok('越界的 PAD 被夹回 -1..1，label 空则整个 mood 作废', () => {
  const r = parseSettleJSON('{"mood":{"pleasure":9,"arousal":-9,"dominance":0.005,"label":"炸毛","reason":"x"},"impressions":[]}');
  assert.equal(r.value.mood.pleasure, 1);
  assert.equal(r.value.mood.arousal, -1);
  assert.equal(r.value.mood.dominance, 0.01);
  assert.equal(parseSettleJSON('{"mood":{"label":"","reason":"啥"},"impressions":[]}').value.mood, null);
});
ok('印象条目去脏、去重、截长', () => {
  const r = parseSettleJSON(JSON.stringify({
    mood: null,
    impressions: [
      { who: '', text: '没有名字' },
      { who: '小雨', text: '' },
      { who: '__proto__', text: '污染' },
      { who: '小雨', text: '怕被催' },
      { who: '小雨', text: '重复的人不算第二条' },
      { who: '阿豪', text: 'y'.repeat(200) }
    ]
  }));
  assert.equal(r.value.impressions.length, 2);
  assert.deepEqual(r.value.impressions[0], { who: '小雨', text: '怕被催' });
  assert.equal(r.value.impressions[1].text.length, 40);
});
ok('不是 JSON 就老实报错', () => {
  const r = parseSettleJSON('我觉得她今天挺高兴的');
  assert.equal(r.ok, false);
  assert.match(r.error, /JSON/);
  assert.equal(parseSettleJSON('').ok, false);
});

console.log('planSettleWrites');
ok('按上限裁剪并报出跳过几条', () => {
  const plan = planSettleWrites(
    { mood: { label: '有点累' }, impressions: [{ who: 'a', text: '1' }, { who: 'b', text: '2' }, { who: 'c', text: '3' }] },
    { maxImpressions: 2 }
  );
  assert.equal(plan.mood.label, '有点累');
  assert.equal(plan.impressions.length, 2);
  assert.equal(plan.skippedImpressions, 1);
});
ok('mood 为 null 时照样能写印象', () => {
  const plan = planSettleWrites({ mood: null, impressions: [{ who: 'a', text: '1' }] }, { maxImpressions: 3 });
  assert.equal(plan.mood, null);
  assert.equal(plan.impressions.length, 1);
});
ok('上限 0 表示一条都不写', () => {
  const plan = planSettleWrites({ mood: { label: 'x' }, impressions: [{ who: 'a', text: '1' }] }, { maxImpressions: 0 });
  assert.equal(plan.impressions.length, 0);
  assert.equal(plan.skippedImpressions, 1);
});

console.log(`\n${pass} 项通过${process.exitCode ? '（有失败）' : ''}`);
