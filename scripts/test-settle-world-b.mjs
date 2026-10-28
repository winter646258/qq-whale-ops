// 世界层 B 的接线单测：settle.js 的 worldAsk / threads / wishes 透传 + bridge 的四处 MARKER。
import fs from 'node:fs';
import path from 'node:path';
import { buildSettlePrompt, parseSettleJSON, planSettleWrites } from '../src/settle.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const bridgeSrc = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');

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

// ---- buildSettlePrompt 的 worldAsk ----
const base = { key: 'private:1', lines: [{ who: '他', text: '明天再告诉你' }] };
const noAsk = buildSettlePrompt(base);
ok('没给 worldAsk 时不出现额外任务（接着来）', !noAsk.includes('额外任务（接着来）'), '不该有');
const withAsk = buildSettlePrompt({ ...base, worldAsk: '记一条还挂着的话' });
ok('给了 worldAsk 就出现', withAsk.includes('额外任务（接着来）'), '没出现');
ok('worldAsk 正文带进去', withAsk.includes('记一条还挂着的话'));
ok('和 lifeAsk 能共存', buildSettlePrompt({ ...base, lifeAsk: '写明天的安排', worldAsk: '记话题' }).includes('写明天的安排'));
ok('worldAsk 超长被截断', buildSettlePrompt({ ...base, worldAsk: 'あ'.repeat(3000) }).length < 6000);

// ---- parseSettleJSON 透传 ----
const raw = JSON.stringify({
  mood: { pleasure: 0.2, arousal: 0, dominance: 0, label: '还行', reason: '聊得挺顺' },
  impressions: [{ who: '管理员', text: '爱出题' }],
  threads: [{ who: '他', topic: '要说的事没说完', quote: '明天再讲', dueIn: 'tomorrow' }],
  wishes: [{ text: '一起看海边纪录片', kind: 'movie' }],
  done: ['一起看电影'],
  resolved: ['t123']
});
const parsed = parseSettleJSON(raw);
ok('解析成功', parsed.ok === true, parsed.error);
eq('threads 透传', parsed.value.threads.length, 1);
eq('threads 原样（洗在模块里）', parsed.value.threads[0].topic, '要说的事没说完');
eq('wishes 透传', parsed.value.wishes[0].text, '一起看海边纪录片');
eq('done 透传', parsed.value.doneWishes, ['一起看电影']);
eq('resolved 透传', parsed.value.resolvedThreads, ['t123']);
const onlyMood = parseSettleJSON(JSON.stringify({ mood: { label: '平静' } }));
eq('没有这些键时给空数组', [onlyMood.value.threads.length, onlyMood.value.wishes.length, onlyMood.value.doneWishes.length, onlyMood.value.resolvedThreads.length], [0, 0, 0, 0]);
const bad = parseSettleJSON(JSON.stringify({ threads: 'not-array', wishes: { a: 1 } }));
eq('类型不对当空', [bad.value.threads.length, bad.value.wishes.length], [0, 0]);

// ---- planSettleWrites 透传 ----
const plan = planSettleWrites(parsed.value, {});
eq('plan 带 threads', plan.threads.length, 1);
eq('plan 带 wishes', plan.wishes.length, 1);
eq('plan 带 doneWishes', plan.doneWishes, ['一起看电影']);
eq('plan 带 resolvedThreads', plan.resolvedThreads, ['t123']);
const empty = planSettleWrites({}, {});
eq('空输入给空数组', [empty.threads, empty.wishes, empty.doneWishes, empty.resolvedThreads], [[], [], [], []]);

// ---- bridge 接线（静态检查） ----
for (const m of ['world-b-store', 'world-b-inject', 'world-b-ask', 'world-b-write']) {
  eq(`MARKER ${m} 恰好一次`, (bridgeSrc.match(new RegExp('MARKER: ' + m, 'g')) || []).length, 1);
}
ok('import threads', bridgeSrc.includes("from './threads.js'"));
ok('import wishes', bridgeSrc.includes("from './wishes.js'"));
ok('注入进 base', bridgeSrc.includes('moodTrendText + threadsText + wishesText'));
ok('结算调用带 worldAsk', bridgeSrc.includes('worldAsk: askWorldText'));
ok('写入调 addThreads', bridgeSrc.includes('addThreads(store'));
ok('写入调 addWishes', bridgeSrc.includes('addWishes(store'));
ok('写入调 resolveThreads', bridgeSrc.includes('resolveThreads(store'));
ok('写入调 completeWishes', bridgeSrc.includes('completeWishes(store'));
ok('主动开口才记账', bridgeSrc.includes('isProactive && line.dueIds.length'));
ok('话题落盘走 atomicWriteJson', /function saveThreadsStore[\s\S]{0,200}atomicWriteJson/.test(bridgeSrc));
ok('愿望落盘走 atomicWriteJson', /function saveWishesStore[\s\S]{0,200}atomicWriteJson/.test(bridgeSrc));

console.log(`世界层 B 接线：${pass} 项通过，${fails.length} 项失败`);
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
