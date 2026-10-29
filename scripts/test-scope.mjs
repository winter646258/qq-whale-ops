// 世界层会话归属单测：wishes / dates / topics 按 key 隔离，life 过滤指代。
// 跑法：node scripts/test-scope.mjs

import assert from 'node:assert/strict';

import { normScopeKey, visibleFor, withScope, filterByScope } from '../src/scoped-store.js';
import { addWishes, wishesLine, openWishes } from '../src/wishes.js';
import { addDates, datesLine, upcomingDates } from '../src/dates.js';
import { addTopics, topicsLine } from '../src/topics.js';
import { normalizeLifePlan, lifeLineFor, setLifeDay } from '../src/life.js';

let n = 0;
const ok = (name) => { n += 1; console.log(`  ✓ ${name}`); };

const OWNER = 'private:1124721191';
const GROUP_A = 'group:906710082';
const GROUP_B = 'group:201188739';
const T0 = new Date('2026-10-30T12:00:00+08:00').getTime();

// ---------- scoped-store 基础 ----------
assert.equal(normScopeKey('  private:1124721191 '), OWNER);
assert.equal(normScopeKey('group:906710082'), GROUP_A);
assert.equal(normScopeKey(''), '');
assert.equal(normScopeKey('weird'), '');
assert.equal(normScopeKey(null), '');
ok('normScopeKey 只认 private:/group:+数字');

assert.equal(visibleFor('', OWNER), true);          // 老数据
assert.equal(visibleFor(undefined, GROUP_A), true);
assert.equal(visibleFor(OWNER, OWNER), true);
assert.equal(visibleFor(OWNER, GROUP_A), false);    // 私聊 → 群：不可见（本次修的目标）
assert.equal(visibleFor(GROUP_A, GROUP_B), false);  // 群 → 别的群：不可见
assert.equal(visibleFor(GROUP_A, OWNER), false);    // 群 → 私聊：也不串
assert.equal(visibleFor(OWNER, ''), true);          // 没传当前 key 时不过滤
ok('visibleFor 五条边界');

const stamped = withScope({ text: 'x' }, OWNER);
assert.equal(stamped.k, OWNER);
assert.equal(withScope({ text: 'x' }, 'junk').k, undefined);
const arr = filterByScope([{ k: OWNER }, { k: GROUP_A }, { text: '老数据' }], GROUP_A);
assert.equal(arr.length, 2);
ok('withScope / filterByScope');

// ---------- wishes ----------
{
  let store = { version: 1, items: [] };
  store = addWishes(store, { items: [{ text: '一起看那部电影' }], now: T0, key: OWNER }).store;
  store = addWishes(store, { items: [{ text: '群里说的那个展' }], now: T0, key: GROUP_A }).store;
  store = addWishes(store, { items: [{ text: '她早上想的事' }], now: T0 }).store;  // 无 key = 全局

  assert.equal(wishesLine(store, { key: OWNER, cfg: { maxInject: 5 } }).includes('一起看那部电影'), true);
  assert.equal(wishesLine(store, { key: OWNER, cfg: { maxInject: 5 } }).includes('群里说的那个展'), false);
  assert.equal(wishesLine(store, { key: GROUP_A, cfg: { maxInject: 5 } }).includes('群里说的那个展'), true);
  assert.equal(wishesLine(store, { key: GROUP_A, cfg: { maxInject: 5 } }).includes('一起看那部电影'), false);
  assert.equal(wishesLine(store, { key: GROUP_B, cfg: { maxInject: 5 } }).includes('一起看那部电影'), false);
  assert.equal(wishesLine(store, { key: GROUP_A, cfg: { maxInject: 5 } }).includes('她早上想的事'), true); // 老数据两边都在
  assert.equal(openWishes(store, { limit: 5, key: OWNER }).length, 2);
  ok('wishes：私聊愿望不进群、群愿望不进别的群、无来源的照旧全局');
}

// ---------- dates ----------
{
  let store = { version: 1, items: [] };
  const soon = new Date(T0 + 86400000);   // 明天
  const md = { month: soon.getMonth() + 1, day: soon.getDate() };
  store = addDates(store, { items: [{ name: '主人私聊说的纪念日', ...md }], now: T0, key: OWNER }).store;
  store = addDates(store, { items: [{ name: '群里说起来的日子', ...md }], now: T0, key: GROUP_A }).store;

  const a = datesLine(store, { now: T0, key: OWNER, cfg: { maxInject: 3, lookaheadDays: 5 } });
  assert.equal(a.includes('主人私聊说的纪念日'), true);
  assert.equal(a.includes('群里说起来的日子'), false);
  const b = datesLine(store, { now: T0, key: GROUP_A, cfg: { maxInject: 3, lookaheadDays: 5 } });
  assert.equal(b.includes('群里说起来的日子'), true);
  assert.equal(b.includes('主人私聊说的纪念日'), false);
  assert.equal(upcomingDates(store, { now: T0, key: GROUP_B, cfg: { lookaheadDays: 5 } }).soon.length, 0);
  ok('dates：纪念日按会话隔离');
}

// ---------- topics ----------
{
  let store = { items: [] };
  store = addTopics(store, [{ title: '私聊聊到的番' }], { now: T0, key: OWNER }).store;
  store = addTopics(store, [{ title: '群里聊到的游戏' }], { now: T0, key: GROUP_A }).store;
  const p = { now: T0, isProactive: true, cfg: { maxInject: 5, keepDays: 7 } };
  assert.equal(topicsLine(store, { ...p, key: OWNER }).includes('私聊聊到的番'), true);
  assert.equal(topicsLine(store, { ...p, key: OWNER }).includes('群里聊到的游戏'), false);
  assert.equal(topicsLine(store, { ...p, key: GROUP_A }).includes('群里聊到的游戏'), true);
  assert.equal(topicsLine(store, { ...p, key: GROUP_A }).includes('私聊聊到的番'), false);
  assert.equal(topicsLine(store, { ...p, key: GROUP_B }), '');
  assert.equal(topicsLine(store, { ...p, key: OWNER, isProactive: false }), '');
  ok('topics：谈资按会话隔离，且被动回话仍然不注入');
}

// ---------- life 指代过滤 ----------
{
  const bad = normalizeLifePlan({
    plans: [
      { period: '晚上', text: '看半场CS比赛，等他讲压了谁' },   // 线上真实案例
      { period: '上午', text: '煮一锅白饭配咸菜，慢慢吃完' },
      { period: '下午', text: '问问你今天忙不忙' },
      { period: '下午', text: '把窗边那几样挪去晒太阳' },
    ],
    outfit: '浅色T恤',
    moodHint: '慢悠悠的'
  });
  assert.equal(bad.plans.length, 2);
  assert.equal(bad.plans.some((p) => p.text.includes('等他讲')), false);
  assert.equal(bad.plans.some((p) => p.text.includes('你今天')), false);
  assert.equal(bad.plans.some((p) => p.text.includes('煮一锅白饭')), true);
  assert.equal(bad.plans.some((p) => p.text.includes('挪去晒太阳')), true);
  ok('life：带「他/你」的整条丢掉，纯自己的动作留下');

  const day = '2026-10-30';
  const store = setLifeDay({ version: 1, days: {} }, day, normalizeLifePlan({
    plans: [{ period: '上午', text: '煮一锅白饭配咸菜' }],
    outfit: '浅色T恤',
    moodHint: '慢悠悠的'
  }));
  const line = lifeLineFor(store, new Date('2026-10-30T12:00:00+08:00').getTime());
  assert.equal(line.includes('煮一锅白饭'), true);
  assert.equal(line.includes('不用主动说'), true);
  assert.equal(line.includes('被问到就照这个说'), false);
  ok('life：注入措辞改成「背景，不用主动说」');
}

console.log(`\n${n} 组断言全部通过`);
