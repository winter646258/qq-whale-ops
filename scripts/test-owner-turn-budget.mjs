// 回归守卫：主人私聊的回合预算要比全局宽（turnBudgetCfg 的 owner-turn-budget）
//
// 背景（2026-10-26 21:26:07 实测）：private:1124721191 只跑了 97s / 4 步就发满 6 条，
// 被「发送 6 条 > 5」掐掉。全局 maxSends=5 是按群里防刷屏定的，主人私聊里是误伤。
// 现在主人私聊读 socialV2.turnBudget.ownerMaxSends，语义是「至少这么多条」，只升不降。
//
// 这个用例把 src/bridge.js 里真实的 turnBudgetCfg 抽出来跑，验的是真代码不是抄一遍。
//
// 跑法：node scripts/test-owner-turn-budget.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'bridge.js'), 'utf8');

const start = src.indexOf('function turnBudgetCfg(key) {');
if (start < 0) {
  console.error('❌ 抽不出 turnBudgetCfg');
  process.exit(1);
}
let depth = 0;
let end = -1;
for (let i = src.indexOf('{', start); i < src.length; i += 1) {
  if (src[i] === '{') depth += 1;
  else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
}
const fnSrc = src.slice(start, end);

const OWNER = 'private:1124721191';
const FRIEND = 'private:3098835427';
const GROUP_TIGHT = 'group:906710082';   // 这个群有 turnMaxSends: 3 的收紧覆盖
const GROUP_PLAIN = 'group:201188739';

function cfgWith(turnBudget) {
  return {
    ownerQQ: 1124721191,
    socialV2: { turnBudget, wake: { overrides: { 906710082: { turnMaxSends: 3 } } } },
  };
}
function resolve(cfg, key) {
  return new Function('cfg', `return (${fnSrc});`)(cfg)(key);
}

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); }
  catch (error) { failed += 1; console.log(`  ❌ ${name} —— ${error?.message ?? error}`); }
}

const base = { maxSteps: 40, maxMs: 600000, maxSends: 5 };

console.log('场景1 没配 ownerMaxSends：行为完全不变（向后兼容）');
{
  const cfg = cfgWith(base);
  for (const [key, want] of [[OWNER, 5], [FRIEND, 5], [GROUP_TIGHT, 3], [GROUP_PLAIN, 5]]) {
    check(`${key} → ${want}`, () => assert.equal(resolve(cfg, key).maxSends, want));
  }
}

console.log('场景2 配了 ownerMaxSends: 20：只有主人放宽');
{
  const cfg = cfgWith({ ...base, ownerMaxSends: 20 });
  check(`主人 → 20`, () => assert.equal(resolve(cfg, OWNER).maxSends, 20));
  check('好友私聊仍是 5（不越权）', () => assert.equal(resolve(cfg, FRIEND).maxSends, 5));
  check('群收紧覆盖仍然生效 → 3', () => assert.equal(resolve(cfg, GROUP_TIGHT).maxSends, 3));
  check('普通群仍是 5', () => assert.equal(resolve(cfg, GROUP_PLAIN).maxSends, 5));
}

console.log('场景3 ownerMaxSends 比全局小：不降，取全局（语义是「至少这么多」）');
{
  const cfg = cfgWith({ ...base, maxSends: 12, ownerMaxSends: 3 });
  check('主人 → 12（不是 3）', () => assert.equal(resolve(cfg, OWNER).maxSends, 12));
}

console.log('场景4 ownerMaxMs 同理，只升不降');
{
  const cfg = cfgWith({ ...base, ownerMaxSends: 20, ownerMaxMs: 1200000 });
  check('主人 maxMs → 1200000', () => assert.equal(resolve(cfg, OWNER).maxMs, 1200000));
  check('好友 maxMs 不变', () => assert.equal(resolve(cfg, FRIEND).maxMs, 600000));
  const cfg2 = cfgWith({ ...base, ownerMaxMs: 1000 });
  check('主人 maxMs 不降 → 600000', () => assert.equal(resolve(cfg2, OWNER).maxMs, 600000));
}

console.log('场景5 没配 ownerQQ：谁都不放宽，且不抛错');
{
  const cfg = { socialV2: { turnBudget: { ...base, ownerMaxSends: 20 } } };
  check('私聊 → 5', () => assert.equal(resolve(cfg, OWNER).maxSends, 5));
}

console.log('场景6 垃圾配置不炸（字符串 / 负数 / 0 / null）');
{
  for (const bad of ['20', -1, 0, null, undefined, NaN, {}]) {
    const cfg = cfgWith({ ...base, ownerMaxSends: bad });
    let got = null;
    check(`ownerMaxSends=${JSON.stringify(bad) ?? String(bad)} 不抛错`, () => {
      got = resolve(cfg, OWNER);
    });
    // '20' 会被 pick 认成 20；其余非法值回落到全局 5
    const want = bad === '20' ? 20 : 5;
    if (got) check(`  → ${want}`, () => assert.equal(got.maxSends, want));
  }
}

if (failed) {
  console.log(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n✅ 全部通过');
