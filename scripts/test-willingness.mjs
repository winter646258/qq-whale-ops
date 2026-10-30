// 离线断言：意愿门（src/willingness.js）。
// 真 import，不复制副本 —— 这是纯函数模块，测试与实现永远同源。
import assert from 'node:assert/strict';
import {
  WILLINGNESS_DEFAULTS,
  WILLINGNESS_TIERS,
  consumeWillingness,
  decayWillingness,
  describeWillingness,
  emptyWillingnessState,
  evaluateWillingness,
  isForcedReason,
  reasonKind,
  resolveTier,
  resolveWillingness
} from '../src/willingness.js';

let pass = 0;
function ok(name, fn) {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n    ${error?.message ?? error}`); process.exitCode = 1; }
}

const T0 = Date.UTC(2026, 9, 30, 4, 0, 0); // 本地 12:00

// 纯函数式掷骰：给定返回值
const fixed = (v) => () => v;

function step(state, overrides = {}) {
  return evaluateWillingness(state, overrides.cfg ?? { enabled: true }, {
    now: T0,
    messageCount: 1,
    content: '今天中午吃啥',
    quotedBot: false,
    reason: 'keyword:小鲸鱼',
    rhythm: 'available',
    random: fixed(0.99), // 默认掷不中，专门测分数累积
    ...overrides,
    cfg: undefined
  });
}

console.log('\n【1】关闭即等于不存在');
ok('enabled:false 时恒为可说', () => {
  const d = evaluateWillingness(undefined, { enabled: false }, { now: T0, messageCount: 1, reason: 'keyword:鲸鱼' });
  assert.equal(d.shouldCall, true);
  assert.equal(d.reason, 'disabled');
  assert.equal(d.probability, 1);
});

console.log('\n【2】原因归一与直通');
ok('reasonKind 剥掉冒号后缀', () => {
  assert.equal(reasonKind('keyword:小鲸鱼'), 'keyword');
  assert.equal(reasonKind('atMention'), 'atMention');
  assert.equal(reasonKind(''), '');
  assert.equal(reasonKind(null), '');
});
ok('明确叫她的都直通', () => {
  for (const r of ['private', 'atMention', 'nameMention', 'question', 'poke', 'bootstrap']) {
    assert.equal(isForcedReason(r), true, r);
    const d = evaluateWillingness(undefined, { enabled: true }, { now: T0, messageCount: 1, reason: r, rhythm: 'asleep' });
    assert.equal(d.shouldCall, true, r);
    assert.equal(d.reason, 'forced', r);
  }
});
ok('软触发不直通（关键词/概率/任意消息/发言人）', () => {
  for (const r of ['keyword:鲸鱼', 'probability', 'anyMessage', 'speaker:张三']) {
    assert.equal(isForcedReason(r), false, r);
  }
});

console.log('\n【3】分数从零攒起来（normal 档）');
ok('第一条消息不够，差得明明白白', () => {
  const d = step(undefined);
  assert.equal(d.shouldCall, false);
  assert.equal(d.reason, 'below-threshold');
  assert.ok(d.score > 0 && d.score < 0.62, `score=${d.score}`);
  assert.ok(String(describeWillingness(d)).includes('差'));
});
ok('第三条左右越过阈值', () => {
  let st = undefined;
  const scores = [];
  for (let i = 0; i < 3; i += 1) {
    const d = step(st);
    scores.push(d.score);
    st = d.state;
  }
  assert.ok(scores[0] < scores[1] && scores[1] < scores[2], `单调递增 ${scores}`);
  assert.ok(scores[2] > 0.62, `第三条应过阈值，实得 ${scores[2]}`);
});
ok('边际递减：越接近满值涨得越慢', () => {
  const low = step(undefined);
  const high = step({ score: 1.8, updatedAt: T0, skipCount: 0 });
  const lowGain = low.score - 0;
  const highGain = high.score - 1.8;
  assert.ok(lowGain > highGain, `低分涨 ${lowGain} 应大于高分涨 ${highGain}`);
});
ok('不会超过 maxScore', () => {
  let st = { score: 1.99, updatedAt: T0, skipCount: 0 };
  for (let i = 0; i < 20; i += 1) st = step(st).state;
  assert.ok(st.score <= 2 + 1e-9, `score=${st.score}`);
});

console.log('\n【4】越过阈值后是概率放行，不是必然');
ok('骰子掷 0 → 说；掷 1 → 不说（天花板 0.92 留了余地）', () => {
  const st = { score: 1.5, updatedAt: T0, skipCount: 0 };
  const yes = evaluateWillingness(st, { enabled: true }, { now: T0, messageCount: 1, reason: 'keyword:x', rhythm: 'available', random: fixed(0) });
  assert.equal(yes.shouldCall, true);
  assert.equal(yes.reason, 'roll');
  const no = evaluateWillingness(st, { enabled: true }, { now: T0, messageCount: 1, reason: 'keyword:x', rhythm: 'available', random: fixed(0.95) });
  assert.equal(no.shouldCall, false, `概率 ${no.probability} 应小于 0.95`);
});
ok('概率封顶：攒满也不会变成必然开口', () => {
  const st = { score: 2, updatedAt: T0, skipCount: 0 };
  const d = evaluateWillingness(st, { enabled: true }, { now: T0, messageCount: 3, reason: 'keyword:x', rhythm: 'phoneFocused', random: fixed(0.999) });
  assert.ok(d.probability <= 0.92 + 1e-9, `probability=${d.probability}`);
  assert.equal(d.shouldCall, false);
});
ok('概率随分数上升（到天花板为止）', () => {
  const p = (score) => evaluateWillingness({ score, updatedAt: T0, skipCount: 0 }, { enabled: true }, {
    now: T0, messageCount: 1, reason: 'keyword:x', rhythm: 'available', random: fixed(0.99)
  }).probability;
  assert.ok(p(0.65) < p(0.8), `${p(0.65)} 应小于 ${p(0.8)}`);
  assert.ok(p(0.8) <= p(1.9), `${p(0.8)} 应不大于 ${p(1.9)}`);
  assert.ok(p(1.9) <= 0.92 + 1e-9, `封顶 ${p(1.9)}`);
});

console.log('\n【5】衰减');
ok('一个半衰期后分数减半', () => {
  const cfg = { enabled: true };
  const half = resolveWillingness(cfg).decayHalfLifeSeconds;
  const s = decayWillingness({ score: 1.2, updatedAt: T0, skipCount: 0 }, cfg, T0 + half * 1000);
  assert.ok(Math.abs(s.score - 0.6) < 0.01, `score=${s.score}`);
});
ok('低于 0.001 直接归零（不留浮点尾巴）', () => {
  const s = decayWillingness({ score: 0.0005, updatedAt: T0, skipCount: 0 }, { enabled: true }, T0 + 1000);
  assert.equal(s.score, 0);
});
ok('skipCount 不随时间衰减（隔一天也不会立刻又接）', () => {
  const s = decayWillingness({ score: 0, updatedAt: T0, skipCount: 5 }, { enabled: true }, T0 + 24 * 3600 * 1000);
  assert.equal(s.skipCount, 5);
});

console.log('\n【6】说完话要歇几条');
ok('consumeWillingness 扣 replyCost', () => {
  const s = consumeWillingness({ score: 1.5, updatedAt: T0, skipCount: 0 }, { enabled: true }, T0, fixed(0));
  assert.ok(Math.abs(s.score - 0.7) < 0.01, `score=${s.score}`);
  assert.ok(s.skipCount >= 0 && s.skipCount <= 6, `skipCount=${s.skipCount}`);
});
ok('分数不会被扣成负数', () => {
  const s = consumeWillingness({ score: 0.1, updatedAt: T0, skipCount: 0 }, { enabled: true }, T0, fixed(0.5));
  assert.equal(s.score, 0);
});
ok('抖动期内一律不说，只消耗条数', () => {
  let st = { score: 1.9, updatedAt: T0, skipCount: 3 };
  const d1 = step(st);
  assert.equal(d1.shouldCall, false);
  assert.equal(d1.reason, 'skip');
  assert.equal(d1.state.skipCount, 2);
  st = d1.state;
  const d2 = step(st);
  assert.equal(d2.state.skipCount, 1);
  const d3 = step(d2.state);
  assert.equal(d3.state.skipCount, 0);
  // 条数耗完之后回到正常评分（此时分数还高，可能放行）
  const d4 = step(d3.state);
  assert.notEqual(d4.reason, 'skip');
});
ok('@ 直通但不清零抖动（一次 @ 不重置整个周期）', () => {
  const st = { score: 0, updatedAt: T0, skipCount: 4 };
  const d = evaluateWillingness(st, { enabled: true }, { now: T0, messageCount: 1, reason: 'atMention', rhythm: 'available' });
  assert.equal(d.shouldCall, true);
  assert.equal(d.reason, 'forced');
  assert.equal(d.state.skipCount, 4);
});

console.log('\n【7】生活节奏改档');
ok('resolveTier 按节奏映射', () => {
  assert.equal(resolveTier({ ...WILLINGNESS_DEFAULTS }, 'phoneFocused'), 'active');
  assert.equal(resolveTier({ ...WILLINGNESS_DEFAULTS }, 'occupied'), 'reserved');
  assert.equal(resolveTier({ ...WILLINGNESS_DEFAULTS }, 'resting'), 'quiet');
  assert.equal(resolveTier({ ...WILLINGNESS_DEFAULTS }, 'asleep'), 'quiet');
  assert.equal(resolveTier({ ...WILLINGNESS_DEFAULTS }, 'available'), 'normal');
  assert.equal(resolveTier({ ...WILLINGNESS_DEFAULTS }, ''), 'normal');
});
ok('auto:false 时锁死在 tier', () => {
  assert.equal(resolveTier({ ...WILLINGNESS_DEFAULTS, auto: false, tier: 'eager' }, 'asleep'), 'eager');
});
ok('半夜几乎不说话（档位+乘数双重收窄）', () => {
  const st = { score: 1.5, updatedAt: T0, skipCount: 0 };
  const day = evaluateWillingness(st, { enabled: true }, { now: T0, messageCount: 1, reason: 'keyword:x', rhythm: 'available', random: fixed(0.5) });
  const night = evaluateWillingness(st, { enabled: true }, { now: T0, messageCount: 1, reason: 'keyword:x', rhythm: 'asleep', random: fixed(0.5) });
  assert.ok(night.probability < day.probability, `夜 ${night.probability} 应远小于日 ${day.probability}`);
  assert.equal(night.tier, 'quiet');
});
ok('多个群在聊时（occupied）更收敛', () => {
  const st = { score: 1.2, updatedAt: T0, skipCount: 0 };
  const free = evaluateWillingness(st, { enabled: true }, { now: T0, messageCount: 1, reason: 'keyword:x', rhythm: 'available', random: fixed(0.99) });
  const busy = evaluateWillingness(st, { enabled: true }, { now: T0, messageCount: 1, reason: 'keyword:x', rhythm: 'occupied', random: fixed(0.99) });
  assert.ok(busy.probability < free.probability, `忙 ${busy.probability} < 闲 ${free.probability}`);
});
ok('显式数值覆盖仍然生效', () => {
  const conf = resolveWillingness({ enabled: true, threshold: 0.2, baseGain: 0.5, keywords: [' 米饭 ', '', null] });
  assert.equal(conf.threshold, 0.2);
  assert.equal(conf.baseGain, 0.5);
  assert.deepEqual(conf.keywords, ['米饭']);
});
ok('关键词命中加一点分', () => {
  const cfgNo = { enabled: true, keywords: [] };
  const cfgKw = { enabled: true, keywords: ['米饭'] };
  const a = evaluateWillingness(undefined, cfgNo, { now: T0, messageCount: 1, content: '今天吃米饭', reason: 'keyword:x', rhythm: 'available', random: fixed(0.99) });
  const b = evaluateWillingness(undefined, cfgKw, { now: T0, messageCount: 1, content: '今天吃米饭', reason: 'keyword:x', rhythm: 'available', random: fixed(0.99) });
  assert.ok(b.score > a.score, `有关键词 ${b.score} 应高于无 ${a.score}`);
});
ok('一批多条消息涨得更快', () => {
  const one = evaluateWillingness(undefined, { enabled: true }, { now: T0, messageCount: 1, reason: 'keyword:x', rhythm: 'available', random: fixed(0.99) });
  const three = evaluateWillingness(undefined, { enabled: true }, { now: T0, messageCount: 3, reason: 'keyword:x', rhythm: 'available', random: fixed(0.99) });
  assert.ok(three.score > one.score, `${three.score} > ${one.score}`);
});

console.log('\n【8】健壮性');
ok('脏 state 不炸', () => {
  for (const bad of [null, undefined, {}, { score: 'x' }, { score: NaN, updatedAt: 'y' }, { score: -5, updatedAt: T0 }]) {
    const d = evaluateWillingness(bad, { enabled: true }, { now: T0, messageCount: 1, reason: 'keyword:x', rhythm: 'available', random: fixed(0.99) });
    assert.equal(typeof d.shouldCall, 'boolean');
    assert.ok(Number.isFinite(d.score) && d.score >= 0, `score=${d.score}`);
  }
});
ok('未知档位回落 normal', () => {
  assert.equal(resolveTier({ ...WILLINGNESS_DEFAULTS, auto: false, tier: '不存在' }, ''), 'normal');
});
ok('五档齐备且数值合理', () => {
  const names = ['quiet', 'reserved', 'normal', 'active', 'eager'];
  for (const n of names) {
    const t = WILLINGNESS_TIERS[n];
    assert.ok(t, n);
    assert.ok(t.threshold >= 0, n);
    assert.ok(t.replyCost > 0, n);
    assert.ok(t.decayHalfLifeSeconds >= 1, n);
  }
  // 阈值必须单调下降：eager 最容易开口
  assert.ok(WILLINGNESS_TIERS.quiet.threshold > WILLINGNESS_TIERS.eager.threshold);
});
ok('emptyWillingnessState 是零向量', () => {
  const s = emptyWillingnessState(T0);
  assert.equal(s.score, 0);
  assert.equal(s.skipCount, 0);
  assert.equal(s.updatedAt, T0);
});

console.log(`\n结果：${pass} 过 / ${process.exitCode ? '有挂' : 0} 挂`);
