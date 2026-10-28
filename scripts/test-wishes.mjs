// 共同愿望（wishes.js）单测。
import {
  WISHES_DEFAULTS,
  WISH_KINDS,
  wishesCfg,
  normalizeWish,
  addWishes,
  openWishes,
  completeWishes,
  pruneWishes,
  wishesLine,
  buildWishesAsk,
  summarizeWishes
} from '../src/wishes.js';

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fails.push(name + (extra ? `（${extra}）` : ''));
}
function eq(name, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  ok(name, a === b, `got ${a} want ${b}`);
}

const T0 = new Date('2026-10-28T23:00:00+08:00').getTime();
const D = 24 * 3600 * 1000;

// ---- 配置 ----
eq('默认值', wishesCfg({}), WISHES_DEFAULTS);
eq('覆盖 maxInject', wishesCfg({ socialV2: { wishes: { maxInject: 1 } } }).maxInject, 1);
eq('脏值回落', wishesCfg({ socialV2: { wishes: { maxInject: 'a' } } }).maxInject, WISHES_DEFAULTS.maxInject);
eq('负数夹住', wishesCfg({ socialV2: { wishes: { maxItems: -5 } } }).maxItems, 1);
eq('kind 白名单', WISH_KINDS, ['movie', 'game', 'trip', 'thing']);

// ---- normalize ----
eq('缺文本丢', normalizeWish({ kind: 'movie' }, { now: T0 }), null);
const w = normalizeWish({ text: '一起看海边纪录片', kind: 'movie' }, { now: T0, addedBy: '她' });
eq('字段齐全', [w.text, w.kind, w.addedBy, w.done, w.addedAt], ['一起看海边纪录片', 'movie', '她', false, T0]);
eq('非法 kind 归 thing', normalizeWish({ text: 'x' }, { now: T0 }).kind, 'thing');
eq('字符串也能洗', normalizeWish('一起去看海', { now: T0 }).text, '一起去看海');
eq('原型污染丢', normalizeWish({ text: '__proto__' }, { now: T0 }), null);
eq('长文本截断', normalizeWish({ text: 'あ'.repeat(200) }, { now: T0 }).text.length, WISHES_DEFAULTS.textChars);

// ---- add ----
let r = addWishes({ version: 1, items: [] }, { items: [{ text: 'A' }, { text: 'B' }], now: T0 });
eq('加两条', r.added, 2);
eq('跳过 0', r.skipped, 0);
ok('都带 id', r.store.items.every((x) => String(x.id || '').length > 2));
r = addWishes(r.store, { items: [{ text: 'A' }], now: T0 + 1000 });
eq('重复不新增', r.added, 0);
eq('重复计数', r.skipped, 1);
eq('去重后仍两条', r.store.items.length, 2);
// 上限 30：一条已完成的都没有 → 不再加，旧的愿望保住
let big = { version: 1, items: [] };
const batch = [];
for (let i = 0; i < 32; i += 1) batch.push({ text: 'W' + i });
r = addWishes(big, { items: batch, now: T0 });
eq('上限 30', r.store.items.length, 30);
eq('加进 30 条', r.added, 30);
eq('多出来的记 skipped', r.skipped, 2);
ok('最早的 W0 还在（旧愿望不该被静悄悄挤掉）', r.store.items.some((x) => x.text === 'W0'));
ok('没挤进去的是最后两条', !r.store.items.some((x) => x.text === 'W31'));
// 已完成的那条优先被淘汰
const withDone = {
  version: 1,
  items: [
    ...Array.from({ length: 29 }, (_, i) => ({ id: 'w' + i, text: 'K' + i, done: false, addedAt: T0 - i * 1000 })),
    { id: 'wd', text: '已完成的', done: true, addedAt: T0, doneAt: T0 - 5 * D }
  ]
};
r = addWishes(withDone, { items: [{ text: '新来的' }], now: T0 });
eq('加完还是 30', r.store.items.length, 30);
ok('已完成最久的被淘汰', !r.store.items.some((x) => x.text === '已完成的'));

// ---- open ----
const store = {
  version: 1,
  items: [
    { id: '1', text: '老的', done: false, addedAt: T0 - 5 * D },
    { id: '2', text: '新的', done: false, addedAt: T0 - 1 * D },
    { id: '3', text: '做完了', done: true, addedAt: T0 - 9 * D, doneAt: T0 }
  ]
};
eq('只给未完成、老的优先', openWishes(store, { limit: 5 }).map((x) => x.text), ['老的', '新的']);
eq('limit 生效', openWishes(store, { limit: 1 }).map((x) => x.text), ['老的']);
eq('limit 0 给空', openWishes(store, { limit: 0 }), []);

// ---- complete / prune ----
let c = completeWishes(store, { texts: ['老的'], now: T0 });
eq('完成一条', c.done, 1);
eq('标记 done', c.store.items[0].done, true);
eq('按 id 也能标', completeWishes(store, { texts: ['2'], now: T0 }).done, 1);
eq('不存在的文字不动', completeWishes(store, { texts: ['没有这条'], now: T0 }).done, 0);
eq('已经完成的再标不算', completeWishes(c.store, { texts: ['老的'], now: T0 }).done, 0);
let p = pruneWishes(store, { now: T0 });
eq('完成的留 30 天', p.items.length, 3);
let p2 = pruneWishes(store, { now: T0 + 40 * D });
eq('超过 30 天清掉', p2.items.length, 2);

// ---- 注入 ----
eq('最多 3 条', wishesLine(store, { cfg: { maxInject: 3 } }).includes('老的'), true);
ok('带前缀', wishesLine(store, {}).includes('【一起想做还没做的】'));
ok('带「不用故意提起」', wishesLine(store, {}).includes('不用故意提起'));
eq('关掉就是空', wishesLine(store, { cfg: { enabled: false } }), '');
eq('maxInject 0 就空', wishesLine(store, { cfg: { maxInject: 0 } }), '');
eq('空库空', wishesLine({ version: 1, items: [] }, {}), '');

eq('摘要', summarizeWishes(store, { limit: 2 }), '- 老的\n- 新的');
eq('空摘要', summarizeWishes({ version: 1, items: [] }, {}), '（没有）');
ok('任务段提到 done', buildWishesAsk({}).includes('done'));
ok('任务段提到 kind', buildWishesAsk({}).includes('kind'));

console.log(`wishes: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
