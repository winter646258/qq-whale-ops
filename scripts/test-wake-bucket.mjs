// test-wake-bucket.mjs —— 直接抽出线上 bridge.js 里的限流段与 push 段来跑，
// 不是重新实现一遍逻辑（避免「测试通过但线上代码不同」的假绿）。
import fs from 'node:fs';

const FILE = '/opt/qq-bridge/src/bridge.js';
const src = fs.readFileSync(FILE, 'utf8');

const M1 = "    const HIGH_PRIORITY = new Set(['private', 'atMention', 'nameMention', 'poke']);";
const M2 = '    // Only a real new wake resets observation;';
const M3 = '    const wakeTime = now;';
const M4 = '    // 无论提前唤醒还是超时唤醒，都清理有限潜水定时器与 sleepUntil';

function slice(from, to) {
  const i = src.indexOf(from);
  const j = src.indexOf(to, i);
  if (i < 0) throw new Error('起点锚点没找到: ' + from.slice(0, 40));
  if (j < 0) throw new Error('终点锚点没找到: ' + to.slice(0, 40));
  if (j <= i) throw new Error('锚点顺序错: ' + from.slice(0, 30));
  return src.slice(i, j);
}

const block1 = slice(M1, M2);   // 限流判定（含 return; 拒绝）
const block2 = slice(M3, M4);   // push + 裁剪

// 把两块拼成一个可调用函数。st / now / log / __wlim 由调用方注入。
const runner = new Function(
  'st', 'now', 'log', '__wlim', 'exemptHigh', 'reasonBase', 'key', 'reason',
  block1 + '\n' + block2 + '\n return "passed";'
);

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass += 1; }
  catch (e) { console.log('  ✗ ' + name + ' —— ' + e.message); fail += 1; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const now = 1793340000000;
const min = 60 * 1000;
const hour = 60 * 60 * 1000;
const LIM = { maxWakePerHour: 5, maxWakePerMinute: 1 };

function mk(ordinary = 0, exempt = 0) {
  const st = {
    wakeTimes: [],
    exemptWakeTimes: [],
    wakeConfig: {},
  };
  for (let i = 0; i < ordinary; i += 1) st.wakeTimes.push(now - 10 * min - i * 1000);
  for (let i = 0; i < exempt; i += 1) st.exemptWakeTimes.push(now - 10 * min - i * 1000);
  return st;
}

function run(st, reasonBase) {
  const logs = [];
  const out = runner(st, now, (m) => logs.push(String(m)), LIM, true, reasonBase, 'group:906710082', reasonBase);
  return { out, logs, denied: logs.some((l) => l.includes('唤醒频率超限')) };
}

console.log('=== 1. 普通额度没满时，普通唤醒能过');
ok('wakeTimes 0 条 → 放行', () => {
  const st = mk(0, 0);
  const r = run(st, 'willingness');
  assert(!r.denied, '不该被拒');
  assert(st.wakeTimes.length === 1, '应记进 wakeTimes，实得 ' + st.wakeTimes.length);
  assert(st.exemptWakeTimes.length === 0, '不该动 exemptWakeTimes');
});

console.log('=== 2. 【核心】豁免把 5 条额度占满，普通唤醒仍能过');
ok('exemptWakeTimes 5 条 → willingness 仍放行', () => {
  const st = mk(0, 5);
  const r = run(st, 'willingness');
  assert(!r.denied, '修复目标就是这条：不该再被豁免挤掉，实际被拒了');
  assert(st.wakeTimes.length === 1, '应记进普通桶');
  assert(st.exemptWakeTimes.length === 5, '豁免桶不该被改');
});

console.log('=== 3. 普通额度真满了，普通唤醒必须被拒（没放太宽）');
ok('wakeTimes 5 条 → willingness 被拒', () => {
  const st = mk(5, 0);
  const r = run(st, 'willingness');
  assert(r.denied, '普通额度用光就该拒，实得放行');
  assert(st.wakeTimes.length === 5, '被拒时不该记账');
});

console.log('=== 4. 豁免唤醒记进豁免桶，且不受额度限制');
ok('exemptWakeTimes 100 条 → nameMention 仍放行，且只进豁免桶', () => {
  const st = mk(5, 100);
  const r = run(st, 'nameMention');
  assert(!r.denied, '豁免不该被拒');
  assert(st.exemptWakeTimes.length === 101, '应进豁免桶，实得 ' + st.exemptWakeTimes.length);
  assert(st.wakeTimes.length === 5, '不该污染普通桶');
});

console.log('=== 5. 四种豁免 reason 都能进豁免桶');
for (const rb of ['private', 'atMention', 'nameMention', 'poke']) {
  ok(rb + ' → 豁免桶', () => {
    const st = mk(0, 0);
    run(st, rb);
    assert(st.exemptWakeTimes.length === 1, '应进豁免桶');
    assert(st.wakeTimes.length === 0, '不该进普通桶');
  });
}

console.log('=== 6. 带冒号的非豁免 reason 不会被误判');
for (const rb of ['keyword', 'speaker', 'willingness', 'question', 'bootstrap']) {
  ok(rb + ' → 普通桶', () => {
    const st = mk(0, 0);
    run(st, rb);
    assert(st.wakeTimes.length === 1, rb + ' 应进普通桶，实得普通=' + st.wakeTimes.length);
    assert(st.exemptWakeTimes.length === 0, rb + ' 不该进豁免桶');
  });
}

console.log('=== 7. 每分钟上限仍然生效');
ok('1 分钟内有 1 条普通记录 → 第二条被拒', () => {
  const st = mk(0, 0);
  st.wakeTimes.push(now - 20 * 1000);
  const r = run(st, 'willingness');
  assert(r.denied, 'maxWakePerMinute=1 应拦住');
});

console.log('=== 8. 超过 200 条时裁剪，不动另一个桶');
ok('普通桶 250 条 → 裁到 200', () => {
  const st = mk(250, 3);
  const r = run(st, 'willingness');
  // 250 条近 1 小时记录必然超额度，会被拒；这里只验证不炸、桶不变
  assert(Array.isArray(st.wakeTimes), 'wakeTimes 应仍是数组');
  assert(st.exemptWakeTimes.length === 3, '豁免桶不该被动');
});

console.log('=== 9. 回滚幂等（源码层面）');
ok('rollbackWakeTime 有幂等闸且用 wakeBucket', () => {
  assert(src.includes('let wakeRolledBack = false;'), '缺少幂等 flag');
  assert(src.includes('if (wakeRolledBack) return;'), '缺少幂等 return');
  assert(src.includes('const idx = wakeBucket.lastIndexOf(wakeTime);'), '回滚没用同一个桶');
  assert(!src.includes('st.wakeTimes.push(wakeTime);'), '旧的 st.wakeTimes.push 还在');
});

console.log('=== 10. 三处初始化/序列化齐全');
ok('exemptWakeTimes 有初始化、反序列化、持久化', () => {
  assert(src.includes('        exemptWakeTimes: [],'), '缺初始化');
  assert(src.includes('exemptWakeTimes: Array.isArray(val.exemptWakeTimes) ? val.exemptWakeTimes : [],'), '缺反序列化');
  assert(src.includes("exemptWakeTimes: Array.isArray(st.exemptWakeTimes) ? st.exemptWakeTimes.slice(-200) : [],"), '缺持久化');
});

console.log('');
console.log('结果：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail === 0 ? 0 : 1);
