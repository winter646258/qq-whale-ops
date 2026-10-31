/**
 * turnBudgetCfg 单测。
 *
 * 做法：从 bridge.js 里把 `function turnBudgetCfg(key) {...}` 整段切出来，
 * 塞进 new Function 跑 —— 测的是线上真正那一份代码，不是复刻的逻辑。
 * （之前 test-wake-bucket / test-wake-hold 都是这个套路，收益是改实现时测试不会骗人。）
 *
 * 跑法：node scripts/test-turn-budget.mjs
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const bridgePath = path.join(process.cwd(), 'src', 'bridge.js');
const source = fs.readFileSync(bridgePath, 'utf8');

const START = '  function turnBudgetCfg(key) {';
const startIdx = source.indexOf(START);
assert.ok(startIdx > 0, '在 bridge.js 里找不到 turnBudgetCfg');

// 从函数体的第一个 { 开始数括号，配到深度归零为止
let depth = 0;
let endIdx = -1;
for (let i = source.indexOf('{', startIdx); i < source.length; i += 1) {
  const ch = source[i];
  if (ch === '{') depth += 1;
  else if (ch === '}') {
    depth -= 1;
    if (depth === 0) { endIdx = i + 1; break; }
  }
}
assert.ok(endIdx > startIdx, 'turnBudgetCfg 的括号没配平');

const body = source.slice(startIdx, endIdx);
// 严格模式 + 空壳依赖：函数只用到 cfg，其余都是字面量
const factory = new Function('cfg', `'use strict';\n${body}\n  return turnBudgetCfg;`);

const cfgWith = (turnBudget, ownerQQ = 1124721191) => ({
  ownerQQ,
  socialV2: { turnBudget, wake: { overrides: {} } },
});

const GROUPS = 'group:906710082';
const OWNER = 'private:1124721191';
const FRIEND = 'private:3098835427';

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

console.log('\n【1】群聊行为必须一点不变');
ok('群聊仍是全局 maxSteps（12）', () => {
  const fn = factory(cfgWith({ maxSteps: 12, ownerMaxSteps: 60, privateMaxSteps: 30 }));
  assert.equal(fn(GROUPS).maxSteps, 12);
});
ok('群聊即便配了 owner/private 步数也不受影响', () => {
  const fn = factory(cfgWith({ maxSteps: 12, ownerMaxSteps: 999, privateMaxSteps: 999 }));
  assert.equal(fn(GROUPS).maxSteps, 12);
});
ok('群覆盖 turnMaxSends 仍是只降不升（不回归）', () => {
  const cfg = cfgWith({ maxSteps: 12, maxSends: 8 });
  cfg.socialV2.wake.overrides = { 906710082: { turnMaxSends: 3 } };
  assert.equal(factory(cfg)(GROUPS).maxSends, 3);
});

console.log('\n【2】主人私聊放宽步数');
ok('配了 ownerMaxSteps: 60 → 60', () => {
  const fn = factory(cfgWith({ maxSteps: 12, ownerMaxSteps: 60 }));
  assert.equal(fn(OWNER).maxSteps, 60);
});
ok('没配 ownerMaxSteps → 回落到 40（代码默认，不再吃全局 12）', () => {
  const fn = factory(cfgWith({ maxSteps: 12 }));
  assert.equal(fn(OWNER).maxSteps, 40);
});
ok('ownerMaxSteps 配得比全局小 → 只升不降，仍是 12', () => {
  const fn = factory(cfgWith({ maxSteps: 12, ownerMaxSteps: 3 }));
  assert.equal(fn(OWNER).maxSteps, 12);
});
ok('主人私聊的 maxSends / maxMs 放宽没有被带坏（不回归）', () => {
  const fn = factory(cfgWith({ maxSteps: 12, maxSends: 5, ownerMaxSends: 100, maxMs: 600000, ownerMaxMs: 1800000 }));
  const r = fn(OWNER);
  assert.equal(r.maxSends, 100);
  assert.equal(r.maxMs, 1800000);
});

console.log('\n【3】好友私聊放宽步数（但不是主人那个量级）');
ok('配了 privateMaxSteps: 30 → 30', () => {
  const fn = factory(cfgWith({ maxSteps: 12, privateMaxSteps: 30 }));
  assert.equal(fn(FRIEND).maxSteps, 30);
});
ok('没配 privateMaxSteps → 回落 30', () => {
  const fn = factory(cfgWith({ maxSteps: 12 }));
  assert.equal(fn(FRIEND).maxSteps, 30);
});
ok('好友拿不到主人的 60', () => {
  const fn = factory(cfgWith({ maxSteps: 12, ownerMaxSteps: 60, privateMaxSteps: 30 }));
  assert.equal(fn(FRIEND).maxSteps, 30);
});
ok('好友的 maxSends 仍是 privateMaxSends（不回归）', () => {
  const fn = factory(cfgWith({ maxSteps: 12, maxSends: 5, privateMaxSends: 12 }));
  assert.equal(fn(FRIEND).maxSends, 12);
});

console.log('\n【4】没配 ownerQQ 时的兜底');
ok('ownerQQ 为空 → 主人那个号被当成普通好友，不吃主人额度', () => {
  const fn = factory(cfgWith({ maxSteps: 12, ownerMaxSteps: 60, privateMaxSteps: 30 }, ''));
  assert.equal(fn(OWNER).maxSteps, 30);
});
ok('ownerQQ 为空也不抛错', () => {
  const fn = factory(cfgWith({}));
  assert.ok(Number.isFinite(fn(OWNER).maxSteps));
});

console.log('\n【5】脏配置');
ok('maxSteps 是 0 / 负数 / 字符串 → 回落 40', () => {
  for (const bad of [0, -5, 'abc', null, undefined]) {
    const fn = factory(cfgWith({ maxSteps: bad }));
    assert.equal(fn(GROUPS).maxSteps, 40, String(bad));
  }
});
ok('maxSteps 是字符串数字 → 按整数用', () => {
  const fn = factory(cfgWith({ maxSteps: '20' }));
  assert.equal(fn(GROUPS).maxSteps, 20);
});
ok('turnBudget 整个缺失也不抛错', () => {
  const fn = factory({ ownerQQ: 1124721191, socialV2: {} });
  assert.equal(fn(GROUPS).maxSteps, 40);
});
ok('key 是空值不抛错', () => {
  const fn = factory(cfgWith({ maxSteps: 12 }));
  for (const k of ['', null, undefined]) assert.ok(Number.isFinite(fn(k).maxSteps));
});

console.log(`\n结果：${pass} 过 / ${fail} 挂`);
if (fail) process.exit(1);
