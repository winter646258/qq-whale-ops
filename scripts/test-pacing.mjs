// 离线断言：节奏层（src/pacing.js）。
// 这是真 import，不是复制副本 —— pacing.js 是独立模块，所以测试跟实现永远同源。
import assert from 'node:assert/strict';
import {
  PACING_DEFAULTS, densityOf, isSoftReason, pacingCfg, rhythmOf, rollSkip, skipDecision, urgeDelay
} from '../src/pacing.js';

let pass = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n    ${error?.message ?? error}`); process.exitCode = 1; }
}

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0); // 本地 20:00，白天
const HOUR = new Date(NOW).getHours();

console.log('pacingCfg');
ok('默认值齐全且 enabled', () => {
  const c = pacingCfg({});
  assert.equal(c.enabled, true);
  assert.equal(c.rhythm.asleep, 0.15);
  assert.deepEqual(c.skip.normal, [0, 6]);
  assert.ok(c.densityRefCount >= 1);
});
ok('config 覆盖生效（socialV2.pacing）', () => {
  const c = pacingCfg({ socialV2: { pacing: { activeMultiplier: 2, skip: { normal: [1, 2] } } } });
  assert.equal(c.activeMultiplier, 2);
  assert.deepEqual(c.skip.normal, [1, 2]);
  assert.deepEqual(c.skip.eager, [0, 3]); // 没覆盖的仍用默认
});
ok('脏值不抛错，回落默认', () => {
  const c = pacingCfg({ socialV2: { pacing: { activeMultiplier: 'abc', densityRefCount: 0, rhythm: { asleep: null } } } });
  assert.equal(c.activeMultiplier, PACING_DEFAULTS.activeMultiplier);
  assert.equal(c.densityRefCount, 1);            // 0 → 夹到 1
  assert.equal(c.rhythm.asleep, 0.15);           // null → 默认
});

console.log('densityOf');
ok('没有消息 → 因子 1.0', () => {
  assert.equal(densityOf([], NOW).factor, 1);
});
ok('刚聊完十几条 → 接近 activeMultiplier', () => {
  const msgs = Array.from({ length: 12 }, (_, i) => ({ time: NOW - i * 1000, isSelf: false }));
  const d = densityOf(msgs, NOW, pacingCfg({}));
  assert.ok(d.factor > 1.3, `factor=${d.factor}`);
  assert.equal(d.count, 12);
});
ok('自己说的话不算密度', () => {
  const msgs = Array.from({ length: 12 }, (_, i) => ({ time: NOW - i * 1000, isSelf: true }));
  assert.equal(densityOf(msgs, NOW).count, 0);
});
ok('超出窗口的老消息忽略', () => {
  const msgs = [{ time: NOW - 7 * 60 * 60 * 1000, isSelf: false }];
  assert.equal(densityOf(msgs, NOW).count, 0);
});
ok('半衰期：90 分钟前的一条只剩一半权重', () => {
  const one = densityOf([{ time: NOW, isSelf: false }], NOW).weighted;
  const half = densityOf([{ time: NOW - 90 * 60 * 1000, isSelf: false }], NOW).weighted;
  assert.ok(Math.abs(half - one / 2) < 0.02, `one=${one} half=${half}`);
});

console.log('rhythmOf');
ok('3 分钟内有人说话 → phoneFocused 1.4', () => {
  assert.deepEqual(
    (({ level, multiplier }) => ({ level, multiplier }))(rhythmOf({ lastIncomingAt: NOW - 60 * 1000, now: NOW, hour: 20 })),
    { level: 'phoneFocused', multiplier: 1.4 }
  );
});
ok('深夜没动静 → asleep 0.15', () => {
  const r = rhythmOf({ lastIncomingAt: NOW - 5 * 60 * 60 * 1000, now: NOW, hour: 2 });
  assert.equal(r.level, 'asleep');
  assert.equal(r.multiplier, 0.15);
});
ok('两小时没人理 → resting 0.5', () => {
  const r = rhythmOf({ lastIncomingAt: NOW - 3 * 60 * 60 * 1000, now: NOW, hour: 20 });
  assert.equal(r.level, 'resting');
  assert.equal(r.multiplier, 0.5);
  assert.equal(r.stale, true);
});
ok('白天半小时前说过话 → available 1.0', () => {
  const r = rhythmOf({ lastIncomingAt: NOW - 30 * 60 * 1000, now: NOW, hour: 20 });
  assert.equal(r.level, 'available');
  assert.equal(r.multiplier, 1);
});
ok('从没说过话 → 兜底 resting×restMultiplier', () => {
  const r = rhythmOf({ lastIncomingAt: 0, now: NOW, hour: 20 });
  assert.equal(r.level, 'resting');
  assert.equal(r.multiplier, 0.6);
  assert.equal(r.stale, true);
});

console.log('urgeDelay');
ok('热闹+正聊 → 间隔明显短于基础', () => {
  const msgs = Array.from({ length: 20 }, (_, i) => ({ time: NOW - i * 5000, isSelf: false }));
  const busy = urgeDelay({ baseMs: 30 * 60 * 1000, recentMessages: msgs, lastIncomingAt: NOW - 1000, now: NOW, hour: 20 });
  assert.ok(busy.delay < 30 * 60 * 1000, `delay=${busy.delay}`);
});
ok('深夜久静 → 间隔拉长但不超过 base×4', () => {
  const quiet = urgeDelay({ baseMs: 30 * 60 * 1000, recentMessages: [], lastIncomingAt: NOW - 6 * 60 * 60 * 1000, now: NOW, hour: 3 });
  assert.ok(quiet.delay > 30 * 60 * 1000, `delay=${quiet.delay}`);
  assert.ok(quiet.delay <= 30 * 60 * 1000 * 4, `delay=${quiet.delay}`);
});
ok('间隔永远不小于 minDelayMs', () => {
  const msgs = Array.from({ length: 50 }, (_, i) => ({ time: NOW - i * 100, isSelf: false }));
  const r = urgeDelay({ baseMs: 60 * 1000, recentMessages: msgs, lastIncomingAt: NOW, now: NOW, hour: 20 });
  assert.ok(r.delay >= 60 * 1000, `delay=${r.delay}`);
});

console.log('isSoftReason');
ok('软触发表', () => {
  for (const r of ['anyMessage', 'probability', 'keyword:鲸鱼', 'speaker:小雨']) assert.equal(isSoftReason(r), true, r);
  for (const r of ['private', 'atMention', 'nameMention', 'question', 'poke', 'bootstrap', 'replyCheck', 'timeout', 'proactiveCheck', '', null]) {
    assert.equal(isSoftReason(r), false, String(r));
  }
});

console.log('rollSkip');
ok('三档都落在各自区间内', () => {
  for (let i = 0; i < 200; i += 1) {
    const eager = rollSkip({ level: 'phoneFocused', random: () => Math.random() });
    const normal = rollSkip({ level: 'available', random: () => Math.random() });
    const quiet = rollSkip({ level: 'resting', random: () => Math.random() });
    assert.ok(eager >= 0 && eager <= 3, `eager=${eager}`);
    assert.ok(normal >= 0 && normal <= 6, `normal=${normal}`);
    assert.ok(quiet >= 1 && quiet <= 12, `quiet=${quiet}`);
  }
});
ok('睡了要比躺着跳得更多（同样随机数）', () => {
  const r = () => 0.5;
  const resting = rollSkip({ level: 'resting', random: r });
  const asleep = rollSkip({ level: 'asleep', random: r });
  assert.ok(asleep > resting, `resting=${resting} asleep=${asleep}`);
});
ok('正聊着要跳得更少（同样随机数）', () => {
  const r = () => 0.5;
  const focused = rollSkip({ level: 'phoneFocused', random: r });
  const normal = rollSkip({ level: 'available', random: r });
  assert.ok(focused < normal, `focused=${focused} normal=${normal}`);
});

console.log('skipDecision');
ok('还没说过话 → 不跳，target=0', () => {
  const d = skipDecision({ st: {}, reason: 'anyMessage', now: NOW, hour: HOUR, random: () => 0.2 });
  assert.equal(d.target, 0);
  assert.equal(d.skip, false);
});
ok('她刚说过话 → 掷出 target 并跳第 1 次软触发', () => {
  const st = { lastAiReplyAt: NOW - 1000, skipRolledAt: 0, skipSeen: 0, skipTarget: 0 };
  const d = skipDecision({ st, reason: 'anyMessage', now: NOW, hour: HOUR, cfg: pacingCfg({}), random: () => 0.9 });
  assert.equal(d.rolled, true);
  assert.ok(d.target >= 0);
  assert.equal(d.seen, 1);
});
ok('明确在叫她 → 决不跳', () => {
  const st = { lastAiReplyAt: NOW - 1000, skipRolledAt: 0, skipSeen: 0, skipTarget: 6 };
  for (const reason of ['atMention', 'nameMention', 'private', 'question', 'poke']) {
    const d = skipDecision({ st, reason, now: NOW, hour: HOUR, random: () => 0.9 });
    assert.equal(d.skip, false, reason);
  }
});
ok('软触发在 target 之内被跳，超过之后放行', () => {
  const st = { lastAiReplyAt: NOW - 1000, skipRolledAt: NOW - 1000, skipSeen: 0, skipTarget: 2 };
  const first = skipDecision({ st: { ...st, skipSeen: 0 }, reason: 'probability', now: NOW, hour: HOUR });
  assert.equal(first.skip, true);
  const second = skipDecision({ st: { ...st, skipSeen: 1 }, reason: 'probability', now: NOW, hour: HOUR });
  assert.equal(second.skip, true);
  const third = skipDecision({ st: { ...st, skipSeen: 2 }, reason: 'probability', now: NOW, hour: HOUR });
  assert.equal(third.skip, false);
});
ok('她再说话之后重新掷骰（rolledAt 追上）', () => {
  const st = { lastAiReplyAt: NOW, skipRolledAt: NOW - 60000, skipSeen: 5, skipTarget: 9 };
  const d = skipDecision({ st, reason: 'keyword:鲸鱼', now: NOW, hour: HOUR, random: () => 0 });
  assert.equal(d.rolled, true);
  assert.equal(d.seen, 1);
  assert.equal(d.rolledAt, NOW);
});


// MARKER: attention-test - 生活线声明应当压过纯时间戳推算
// ok(name, fn) 第二个参数必须是函数，所以每条都包成 () => assert...
const T_DAY = Date.UTC(2026, 9, 30, 6, 0, 0);
const ATTN = (att, hour, idleMs) => rhythmOf({
  lastIncomingAt: idleMs === null ? 0 : T_DAY - idleMs,
  now: T_DAY, hour, attention: att, cfg: PACING_DEFAULTS
});
ok('attention=occupied -> occupied 档', () => assert.equal(ATTN('occupied', 14, 3 * 3600 * 1000).level, 'occupied'));
ok('occupied 倍率 0.7', () => assert.equal(ATTN('occupied', 14, 3 * 3600 * 1000).multiplier, 0.7));
ok('没人说过话时仍是 resting（occupied 不越过 stale 判定）', () => assert.equal(ATTN('occupied', 14, null).level, 'resting'));
ok('刚有人说话时 phoneFocused 优先', () => assert.equal(ATTN('occupied', 14, 60000).level, 'phoneFocused'));
ok('半夜 asleep 优先于 occupied', () => assert.equal(ATTN('occupied', 2, 30 * 60 * 1000).level, 'asleep'));
ok('不传 attention 时行为不变（resting）', () => assert.equal(ATTN('', 14, 3 * 3600 * 1000).level, 'resting'));
ok('urgeDelay 认 attention', () => assert.equal(urgeDelay({
  baseMs: 600000, recentMessages: [], lastIncomingAt: T_DAY - 3 * 3600 * 1000,
  now: T_DAY, hour: 14, attention: 'occupied', cfg: PACING_DEFAULTS
}).rhythm, 'occupied'));

console.log(`\n${pass} 项通过${process.exitCode ? '（有失败）' : ''}`);
