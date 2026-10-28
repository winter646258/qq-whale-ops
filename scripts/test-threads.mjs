// 未完话题（threads.js）单测：跑的是真模块，不是复制一份逻辑。
import {
  THREADS_DEFAULTS,
  threadsCfg,
  parseDueIn,
  normalizeThread,
  addThreads,
  dueThreads,
  markAsked,
  resolveThreads,
  pruneThreads,
  threadsLine,
  summarizeThreads,
  buildThreadsAsk
} from '../src/threads.js';

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
const H = 3600 * 1000;
const D = 24 * H;

// ---- 配置 ----
const d = threadsCfg({});
eq('默认值', d, THREADS_DEFAULTS);
ok('enabled 默认开', d.enabled === true);
eq('调 maxAsk', threadsCfg({ socialV2: { threads: { maxAsk: 5 } } }).maxAsk, 5);
eq('脏值回落', threadsCfg({ socialV2: { threads: { maxAsk: 'x', maxItems: -3 } } }).maxAsk, THREADS_DEFAULTS.maxAsk);
eq('负数夹到 1', threadsCfg({ socialV2: { threads: { maxItems: -3 } } }).maxItems, 1);
eq('显式 0 也算数（maxAsk 允许 0）', threadsCfg({ socialV2: { threads: { maxAsk: 0 } } }).maxAsk, 0);

// ---- dueIn ----
eq('tomorrow', parseDueIn('tomorrow', T0), T0 + D);
eq('3h', parseDueIn('3h', T0), T0 + 3 * H);
eq('2d', parseDueIn('2d', T0), T0 + 2 * D);
eq('1w', parseDueIn('1w', T0), T0 + 7 * D);
eq('nextWeek', parseDueIn('nextWeek', T0), T0 + 7 * D);
eq('tonight 四小时', parseDueIn('tonight', T0), T0 + 4 * H);
eq('空 → 明天', parseDueIn('', T0), T0 + D);
eq('认不出 → 明天', parseDueIn('whatever', T0), T0 + D);
eq('毫秒数原样', parseDueIn(String(T0 + 5 * H), T0), T0 + 5 * H);

// ---- normalizeThread ----
eq('缺 topic 丢', normalizeThread({ who: '他' }, { key: 'private:1', now: T0 }), null);
const nt = normalizeThread({ topic: '他要说的事还没说', quote: '明天再告诉你', dueIn: 'tomorrow' }, { key: 'private:1', who: '管理员', now: T0 });
eq('字段齐全', [nt.key, nt.who, nt.topic, nt.quote, nt.status, nt.askedCount], ['private:1', '管理员', '他要说的事还没说', '明天再告诉你', 'open', 0]);
eq('dueAt 换好了', nt.dueAt, T0 + D);
eq('原型污染丢', normalizeThread({ topic: '__proto__' }, { key: 'k', now: T0 }), null);

// ---- addThreads ----
let store = { version: 1, items: [] };
let r = addThreads(store, { key: 'private:1', who: '管理员', items: [{ topic: 'A', dueIn: '3h' }, { topic: 'B', dueIn: 'tomorrow' }], now: T0 });
eq('加两条', r.added, 2);
eq('总数', r.store.items.length, 2);
ok('都带 id', r.store.items.every((x) => String(x.id || '').length > 2));
// 同 key 同 topic 去重（更新不新增）
r = addThreads(r.store, { key: 'private:1', who: '管理员', items: [{ topic: 'A', dueIn: '2d', quote: '后天说' }], now: T0 + H });
eq('同 topic 不重复加', r.added, 0);
eq('但算更新', r.updated, 1);
eq('dueAt 被更新', r.store.items.find((x) => x.topic === 'A').dueAt, T0 + H + 2 * D);
// 不同 key 各自独立
r = addThreads(r.store, { key: 'group:9', who: '群友', items: [{ topic: 'A', dueIn: '3h' }], now: T0 });
eq('不同 key 同一个 topic 各算一条', r.store.items.length, 3);
// 上限 20：淘汰 dueAt 最远的
let many = { version: 1, items: [] };
const batch = [];
for (let i = 0; i < 25; i += 1) batch.push({ topic: 'T' + i, dueIn: String(i + 1) + 'd' });
r = addThreads(many, { key: 'private:2', who: '他', items: batch, now: T0 });
eq('上限 20 生效', r.store.items.length, 20);
ok('最远的被淘汰', !r.store.items.some((x) => x.topic === 'T24'), 'T24 应该被挤掉');
ok('最近的在', r.store.items.some((x) => x.topic === 'T0'));

// ---- dueThreads ----
store = {
  version: 1,
  items: [
    { id: 'a', key: 'private:1', topic: '过期的', dueAt: T0 - H, askedCount: 0, lastAskedAt: 0, status: 'open' },
    { id: 'b', key: 'private:1', topic: '还没到', dueAt: T0 + D, askedCount: 0, lastAskedAt: 0, status: 'open' },
    { id: 'c', key: 'private:1', topic: '问够了', dueAt: T0 - H, askedCount: 2, lastAskedAt: 0, status: 'open' },
    { id: 'd', key: 'private:1', topic: '刚问过', dueAt: T0 - H, askedCount: 1, lastAskedAt: T0 - H, status: 'open' },
    { id: 'e', key: 'private:1', topic: '别的会话', dueAt: T0 - H, askedCount: 0, lastAskedAt: 0, status: 'open' },
    { id: 'f', key: 'private:1', topic: '关了', dueAt: T0 - H, askedCount: 0, lastAskedAt: 0, status: 'closed' }
  ]
};
store.items[4].key = 'group:9';
const due = dueThreads(store, { key: 'private:1', now: T0 });
eq('只有 a 合条件', due.map((x) => x.id), ['a']);
eq('6 小时后 d 又能问', dueThreads(store, { key: 'private:1', now: T0 + 6 * H + 1 }).map((x) => x.id), ['a', 'd']);
eq('maxAsk 调 0 就永不问', dueThreads(store, { key: 'private:1', now: T0, cfg: { maxAsk: 0 } }).length, 0);

// ---- markAsked / resolve / prune ----
let m = markAsked(store, { ids: ['a'], now: T0 });
eq('问了记一次', m.asked, 1);
eq('askedCount 变 1', m.store.items[0].askedCount, 1);
eq('lastAskedAt 写上', m.store.items[0].lastAskedAt, T0);
eq('别的没动', m.store.items[1].askedCount, 0);
eq('空 ids 不动', markAsked(store, { ids: [] }).asked, 0);
let c = resolveThreads(store, { ids: ['a'], now: T0 });
eq('关掉一条', c.closed, 1);
eq('状态变 closed', c.store.items[0].status, 'closed');
eq('重复关不算', resolveThreads(c.store, { ids: ['a'] }).closed, 0);
let p = pruneThreads({
  version: 1,
  items: [
    { id: 'x', key: 'k', dueAt: T0 - 8 * D, status: 'open', topic: 'x' },
    { id: 'y', key: 'k', dueAt: T0 - 2 * D, status: 'open', topic: 'y' },
    { id: 'z', key: 'k', dueAt: T0 - D, status: 'closed', closedAt: T0 - D, topic: 'z' }
  ]
}, { now: T0 });
eq('过期 7 天的清掉，其余留', p.items.map((x) => x.id), ['y', 'z']);

// ---- threadsLine ----
store = {
  version: 1,
  items: [
    { id: 'a', key: 'private:1', who: '管理员', topic: '他要说的事还没说', quote: '明天再告诉你', dueAt: T0 - H, askedCount: 0, lastAskedAt: 0, status: 'open' },
    { id: 'b', key: 'private:1', who: '管理员', topic: '还没到的那件', quote: '', dueAt: T0 + D, askedCount: 0, lastAskedAt: 0, status: 'open' },
    { id: 'c', key: 'group:9', who: '群友', topic: '别的会话', quote: '', dueAt: T0 - H, askedCount: 0, lastAskedAt: 0, status: 'open' }
  ]
};
const passive = threadsLine(store, { key: 'private:1', now: T0 });
ok('回话时用「还挂着的话」', passive.text.includes('【还挂着的话】'), passive.text);
ok('带上引用原话', passive.text.includes('「明天再告诉你」'), passive.text);
ok('回话时不报 dueIds', passive.dueIds.length === 0);
ok('不串会话', !passive.text.includes('别的会话'));
const proactive = threadsLine(store, { key: 'private:1', now: T0, isProactive: true });
ok('主动时用「可以问了」', proactive.text.includes('【可以问了】'), proactive.text);
eq('主动时报 dueIds', proactive.dueIds, ['a']);
ok('措辞留活口', proactive.text.includes('想提就提'), proactive.text);
eq('enabled=false 不注入', threadsLine(store, { key: 'private:1', now: T0, cfg: { enabled: false } }).text, '');
eq('maxInject 0 不注入', threadsLine(store, { key: 'private:1', now: T0, cfg: { maxInject: 0 } }).text, '');
eq('空库不注入', threadsLine({ version: 1, items: [] }, { key: 'private:1', now: T0 }).text, '');

// ---- summarize / ask ----
ok('摘要列话题', summarizeThreads(store, { key: 'private:1' }).includes('还没到的那件'));
eq('空库摘要', summarizeThreads({ version: 1, items: [] }, { key: 'x' }), '（没有）');
ok('任务段提到 resolved', buildThreadsAsk({}).includes('resolved'));
ok('任务段提到 dueIn', buildThreadsAsk({}).includes('dueIn'));

console.log(`threads: ${pass} 项通过，${fails.length} 项失败`);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
