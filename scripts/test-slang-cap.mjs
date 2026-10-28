// 黑话软上限：1200 条按价值淘汰，不再靠手清。
import { capSlangEntries, resolveSlangCap, SLANG_SOFT_CAP, SLANG_MAX_ENTRIES } from '../src/slang-learner.js';

let pass = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${extra ? ' —— ' + extra : ''}`);
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

// ---- 配置夹取 ----
eq('默认软上限 1200', SLANG_SOFT_CAP, 1200);
eq('没配就用 1200', resolveSlangCap(undefined), 1200);
eq('null 也用 1200', resolveSlangCap(null), 1200);
eq('0 用 1200（不当成上限 0）', resolveSlangCap(0), 1200);
eq('乱写用 1200', resolveSlangCap('abc'), 1200);
eq('字符串数字认', resolveSlangCap('1500'), 1500);
eq('太小抬到 200', resolveSlangCap(50), 200);
eq('太大压到硬顶 2000', resolveSlangCap(9999), SLANG_MAX_ENTRIES);
eq('小数取整', resolveSlangCap(1200.9), 1200);

// ---- 淘汰 ----
const mk = (i, extra = {}) => ({ id: `e${i}`, content: `词${i}`, status: 'candidate', count: 1, ...extra });
const keepConfirmed = Array.from({ length: 5 }, (_, i) => mk(i, { status: 'confirmed', meaning: '有释义', count: 5 }));
const keepMeaning = Array.from({ length: 5 }, (_, i) => mk(100 + i, { meaning: '有释义', count: 1 }));
const keepRejected = Array.from({ length: 3 }, (_, i) => mk(200 + i, { status: 'rejected' }));
const junk = Array.from({ length: 1200 }, (_, i) => mk(300 + i));

const total = keepConfirmed.length + keepMeaning.length + keepRejected.length + junk.length;
const capped = capSlangEntries([...junk, ...keepRejected, ...keepMeaning, ...keepConfirmed], 1200);
eq('裁到上限', capped.entries.length, 1200);
eq('丢掉的是多出来的那些', capped.dropped, total - 1200);
ok('已确认的一条没丢', keepConfirmed.every((e) => capped.entries.some((x) => x.id === e.id)));
ok('有释义的一条没丢', keepMeaning.every((e) => capped.entries.some((x) => x.id === e.id)));
ok('拉黑的一条没丢', keepRejected.every((e) => capped.entries.some((x) => x.id === e.id)));
ok('丢的全是无释义单次碎片', capped.entries.filter((e) => e.status === 'candidate' && !e.meaning).length === 1200 - 13);

const small = [...junk.slice(0, 100)];
const untouched = capSlangEntries(small, 1200);
eq('没超上限时一条不动', untouched.entries.length, 100);
eq('没超上限时不报丢弃', untouched.dropped, 0);
ok('没超上限时原样返回（同一个数组内容）', untouched.entries[0].id === small[0].id);

const empty = capSlangEntries([], 1200);
eq('空库不炸', empty.dropped, 0);
eq('脏输入当空库', capSlangEntries(null, 1200).entries.length, 0);
eq('上限写坏回落硬顶时仍然工作', capSlangEntries(junk, 'x').entries.length, Math.min(junk.length, SLANG_MAX_ENTRIES));

console.log(`\n黑话软上限：${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
console.log('全绿 ✓');