/**
 * speech-habit.js 单测。
 * 跑法：node scripts/test-speech-habit.mjs
 */

import assert from 'node:assert';
import { HABIT_DEFAULTS, riceEchoLine } from '../src/speech-habit.js';

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  ✗ ${name}\n      ${error?.message ?? error}`);
  }
}

const self = (text) => ({ isSelf: true, plain: text });
const other = (text) => ({ isSelf: false, plain: text });
const quoteOf = (line) => line.match(/「(.+?)」/)[1];

console.log('\n【1】不该触发的场景');
ok('没有自己说的话', () => {
  assert.equal(riceEchoLine([]), '');
  assert.equal(riceEchoLine([other('我在家专吃白饭')]), '');
});
ok('自己说了但没提饭', () => {
  assert.equal(riceEchoLine([self('这条路由我来看'), self('行')]), '');
});
ok('裸的「饭」不算——饭点是别人的话题', () => {
  assert.equal(riceEchoLine([self('现在离饭点还早')]), '');
});
ok('「饭店」「碗柜」不误伤', () => {
  assert.equal(riceEchoLine([self('那家饭店排队老长'), self('碗柜第二层')]), '');
});
ok('坏入参不抛错', () => {
  assert.equal(riceEchoLine(null), '');
  assert.equal(riceEchoLine(undefined), '');
  assert.equal(riceEchoLine('白饭'), '');
  assert.equal(riceEchoLine([null, undefined, 0, '白饭']), '');
});
ok('消息正文为空时不触发', () => {
  assert.equal(riceEchoLine([{ isSelf: true, plain: '', text: '   ' }]), '');
});

console.log('\n【2】该触发，且措辞对');
ok('提过一次 → 带上原话与「换别的说」', () => {
  const line = riceEchoLine([self('我在家专吃白饭 这个不用抢')]);
  assert.match(line, /^【别再说白饭】你上一条已经提过一次（「.+?」）/);
  assert.match(line, /别再提饭、碗、馒头这些吃的/);
  assert.match(line, /这是设定，不是每句话的比喻/);
  assert.ok(line.endsWith('\n\n'));
});
ok('连提两次 → 说清次数', () => {
  const line = riceEchoLine([
    self('只能站旁边吃白饭'),
    self('这条无关'),
    self('我吃白饭啊 这个刚才我自己都答过了'),
  ]);
  assert.match(line, /最近 2 条里你提了 2 次/);
});
ok('「端碗」「一碗」「碗里」都算', () => {
  for (const t of ['我先端碗了', '就剩一碗了', '碗里还有两颗']) {
    assert.ok(riceEchoLine([self(t)]).includes('别再说白饭'), t);
  }
});
ok('引用是命中词附近，不是开头（避免「我什么时候说过」）', () => {
  const line = riceEchoLine([self('一只蓝鲸游过深夜 尾巴扫落一地的白饭 然后游走了')]);
  const quote = quoteOf(line);
  assert.ok(quote.includes('白饭'), `应包含命中词：${quote}`);
  assert.ok(!quote.startsWith('一只蓝鲸游过深夜'), `不该从头截：${quote}`);
  assert.ok(quote.startsWith('…'), `前面被截应有省略号：${quote}`);
});
ok('长原话两头都可能带省略号', () => {
  const quote = quoteOf(riceEchoLine([self('我今天又是一整天吃白饭吃到快吐了但是真的没办法啊')]));
  assert.ok(quote.includes('白饭'), quote);
  assert.ok(quote.endsWith('…'), quote);
});
ok('原话里的换行被压成一行', () => {
  const quote = quoteOf(riceEchoLine([self('看吧\n\n我在家专吃白饭')]));
  assert.ok(!/\n/.test(quote), quote);
  assert.ok(quote.includes('白饭'), quote);
});

console.log('\n【3】窗口边界');
ok('只回看最近 N 条——更早提过但最近没提就不提醒', () => {
  const messages = [self('我在家专吃白饭')];
  for (let i = 0; i < HABIT_DEFAULTS.lookback; i += 1) messages.push(self(`第 ${i} 条无关`));
  assert.equal(riceEchoLine(messages), '');
});
ok('窗口内最后一条命中仍触发', () => {
  const messages = [];
  for (let i = 0; i < HABIT_DEFAULTS.lookback - 1; i += 1) messages.push(self(`第 ${i} 条无关`));
  messages.push(self('我在家专吃白饭'));
  assert.ok(riceEchoLine(messages).includes('别再说白饭'));
});
ok('别人说的不进窗口计数', () => {
  assert.equal(riceEchoLine([other('我在家专吃白饭'), other('端碗'), self('这条无关')]), '');
});
ok('自定义 lookback 生效', () => {
  assert.equal(riceEchoLine([self('我在家专吃白饭'), self('无关')], { lookback: 1 }), '');
});
ok('自定义 quoteChars 生效（引用变短，但仍含命中词）', () => {
  const long = quoteOf(riceEchoLine([self('我在家专吃白饭')], { quoteChars: 16 }));
  const short = quoteOf(riceEchoLine([self('我在家专吃白饭')], { quoteChars: 6 }));
  assert.ok(short.length <= long.length, `${short} vs ${long}`);
  assert.ok(short.includes('白饭'), short);
  assert.ok(short.length <= 8, `最多 6 字 + 省略号：${short}`);
});

console.log(`\n结果：${pass} 过 / ${fail} 挂`);
if (fail) process.exit(1);
