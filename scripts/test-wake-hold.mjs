// test-wake-hold.mjs —— 从线上 bridge.js 里抽出「限流 + 抑制点 + 入桶 + 回滚」的真实代码段来跑。
// 为什么这么写：这套逻辑的坑全在副作用（写不写桶、回滚几次、抑制点算得准不准），
// 自己复刻一遍只会在「测试绿了但线上不是这样」上栽跟头。抽取边界靠 MARKER 注释固定，
// 一旦有人改动那几行，find 不到就会直接报错，不会静默假绿。
import fs from 'node:fs';

const FILE = process.env.BRIDGE_FILE || '/opt/qq-bridge/src/bridge.js';
const src = fs.readFileSync(FILE, 'utf8');

const M_LIMIT = "    const HIGH_PRIORITY = new Set(['private', 'atMention', 'nameMention', 'poke']);";
const M_LIMIT_END = '    // Only a real new wake resets observation;';
const M_PUSH = '    const wakeTime = now;';
const M_PUSH_END = '    // 无论提前唤醒还是超时唤醒，都清理有限潜水定时器与 sleepUntil';
const M_ROLLBACK = '    let wakeRolledBack = false;';
const M_ROLLBACK_END = '      saveSocialV2State();\n    };';

function cut(from, to) {
  const i = src.indexOf(from);
  if (i < 0) throw new Error('起点锚点没找到: ' + from.slice(0, 50));
  const j = src.indexOf(to, i);
  if (j < 0) throw new Error('终点锚点没找到: ' + to.slice(0, 50));
  if (j <= i) throw new Error('锚点顺序错: ' + from.slice(0, 40));
  return src.slice(i, j);
}

const blockLimit = cut(M_LIMIT, M_LIMIT_END);
const blockPush = cut(M_PUSH, M_PUSH_END);
const rollFrom = src.indexOf(M_ROLLBACK);
if (rollFrom < 0) throw new Error('回滚段锚点没找到');
const rollEnd = src.indexOf(M_ROLLBACK_END, rollFrom);
if (rollEnd < 0) throw new Error('回滚段终点没找到');
const blockRollback = src.slice(rollFrom, rollEnd + M_ROLLBACK_END.length);

const runLimit = new Function(
  'st', 'now', 'log', '__wlim', 'exemptHigh', 'reasonBase', 'key', 'reason', 'cfg',
  blockLimit + '\n' + blockPush + '\n  return "passed";'
);
const runRollback = new Function(
  'st', 'wakeBucket', 'wakeTime', 'saveSocialV2State',
  blockRollback + '\n  return rollbackWakeTime;'
);

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass += 1; }
  catch (e) { console.log('  ✗ ' + name + ' —— ' + e.message); fail += 1; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实得 ' + JSON.stringify(a)); }

const now = 1793361600000;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const CFG = { socialV2: { wake: {} } };
const LIM = { maxWakePerHour: 5, maxWakePerMinute: 1 };

function mk(o = [], e = []) {
  return { wakeTimes: o.slice(), exemptWakeTimes: e.slice(), wakeConfig: {} };
}
function fill(n, startAgeMs, stepMs) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(now - startAgeMs + i * stepMs);
  return out;
}
function run(st, reasonBase, lim = LIM, exemptHigh = true) {
  const logs = [];
  let out;
  try {
    out = runLimit(st, now, (m) => logs.push(String(m)), lim, exemptHigh, reasonBase, 'group:906710082', reasonBase, CFG);
  } catch (e) {
    throw new Error('抽取代码执行抛错: ' + e.message);
  }
  return { out, logs, denied: logs.some((l) => l.includes('唤醒频率超限')) };
}

console.log('\n[1] 豁免桶与普通桶隔离');
ok('豁免桶满 5 条时，普通桶空的 willingness 仍放行', () => {
  const st = mk([], fill(5, 10 * MIN, 1000));
  const r = run(st, 'willingness');
  eq(r.denied, false, '不该被拦');
  eq(st.wakeTimes.length, 1, '应写入普通桶');
  eq(st.exemptWakeTimes.length, 5, '豁免桶不该被动');
});
ok('普通桶满 5 条时 willingness 被拒', () => {
  const st = mk(fill(5, 10 * MIN, 1000), []);
  const r = run(st, 'willingness');
  eq(r.denied, true, '应被拦');
  eq(st.wakeTimes.length, 5, '被拦不得写桶');
});
ok('nameMention 进豁免桶，不吃普通额度', () => {
  const st = mk([], []);
  run(st, 'nameMention');
  eq(st.exemptWakeTimes.length, 1);
  eq(st.wakeTimes.length, 0);
});
ok('exemptHigh=false 时 nameMention 退回普通桶', () => {
  const st = mk([], []);
  run(st, 'nameMention', LIM, false);
  eq(st.wakeTimes.length, 1);
  eq(st.exemptWakeTimes.length, 0);
});
ok('question 走普通桶（不豁免，锁住这个契约）', () => {
  const st = mk([], []);
  run(st, 'question');
  eq(st.wakeTimes.length, 1);
  eq(st.exemptWakeTimes.length, 0);
});

console.log('\n[2] 抑制点算得准不准');
ok('count == max 时，恢复点 = 最老一条 + 1 小时', () => {
  const st = mk(fill(5, 50 * MIN, 10 * MIN), []);
  run(st, 'probability');
  eq(st.wakeHold && st.wakeHold.until, now - 50 * MIN + HOUR, '恢复点算错');
});
ok('count > max（6 条）时，要等够使 count 降到 max-1 的那一条', () => {
  const st = mk([now - 55 * MIN, now - 50 * MIN, now - 40 * MIN, now - 30 * MIN, now - 20 * MIN, now - 10 * MIN], []);
  run(st, 'probability');
  eq(st.wakeHold && st.wakeHold.until, now - 50 * MIN + HOUR, '6 条时算成了第 5 早的那条');
});
ok('只有每分钟上限触发时，恢复点 = 那条 + 60 秒', () => {
  const st = mk([now - 30 * 1000], []);
  run(st, 'probability', { maxWakePerHour: 99, maxWakePerMinute: 1 });
  eq(st.wakeHold && st.wakeHold.until, now - 30 * 1000 + MIN);
});
ok('两个上限同时触发时取较早的那个', () => {
  const st = mk([now - 20 * 1000, now - 50 * MIN, now - 40 * MIN, now - 30 * MIN, now - 20 * MIN, now - 10 * MIN], []);
  run(st, 'probability');
  eq(st.wakeHold && st.wakeHold.until, now - 20 * 1000 + MIN, '应取分钟窗口的恢复点');
});
ok('抑制期内再进来：静默返回，不写桶不刷日志', () => {
  const st = mk(fill(5, 10 * MIN, 1000), []);
  run(st, 'probability');
  const before = st.wakeTimes.length;
  const r2 = run(st, 'probability');
  eq(r2.out, undefined, '应提前 return');
  eq(r2.logs.length, 0, '抑制期内不该再打日志');
  eq(st.wakeTimes.length, before, '不该写桶');
});
ok('抑制期过期后被清掉，流程继续', () => {
  const st = mk([], []);
  st.wakeHold = { until: now - 1, at: now - 1000, reason: 'x' };
  const r = run(st, 'probability', { maxWakePerHour: 99, maxWakePerMinute: 0 });
  eq(r.out, 'passed');
  eq(st.wakeHold, null, '过期抑制点应清空');
});

console.log('\n[3] 入桶与回滚');
ok('放行后只在桶里追加一条 now', () => {
  const st = mk([now - 3 * HOUR], []);
  run(st, 'probability');
  eq(st.wakeTimes.length, 2);
  eq(st.wakeTimes[st.wakeTimes.length - 1], now);
});
ok('放行后抑制点作废', () => {
  const st = mk([], []);
  st.wakeHold = { until: now - 1, at: 0, reason: 'x' };
  run(st, 'probability', { maxWakePerHour: 99, maxWakePerMinute: 0 });
  eq(st.wakeHold, null);
});
ok('回滚幂等：调两次只删一条', () => {
  // 故意放两条同毫秒记录：不幂等的话第二次会把另一条也削掉。
  const st = mk([], []);
  const bucket = st.wakeTimes;
  bucket.push(now - 5, now, now);
  const rb = runRollback(st, bucket, now, () => {});
  rb();
  eq(bucket.length, 2, '第一次应只删一条');
  rb();
  eq(bucket.length, 2, '第二次调用不该再删');
  eq(bucket.filter((t) => t === now).length, 1, '应还剩一条同毫秒的 now');
});
ok('回滚只删自己那条，同桶其他记录不动', () => {
  const st = mk([], []);
  const bucket = st.wakeTimes;
  bucket.push(now - 1000, now, now + 1000);
  const rb = runRollback(st, bucket, now, () => {});
  rb();
  eq(bucket.length, 2);
  assert(bucket.includes(now - 1000) && bucket.includes(now + 1000), '别的记录被误删');
});
ok('桶上限 200 条，超出从头部削', () => {
  const old = [];
  for (let i = 0; i < 200; i += 1) old.push(now - 300 * MIN + i);
  const st = mk(old, []);
  run(st, 'probability', { maxWakePerHour: 0, maxWakePerMinute: 0 });
  eq(st.wakeTimes.length, 200, '超过 200 应被削');
});

console.log('\n[4] 主动 willingness 抑制（源码层 + 谓词）');
const GUARD = '    if (!reason && Number((st.wakeHold && st.wakeHold.until) || 0) > Date.now()) return null;';
const BLOCKED = '    if (!reason && blocked) return null;';
ok('源码里存在抑制守卫', () => { assert(src.includes(GUARD), '守卫那行没找到'); });
ok('守卫排在 blocked 判定之后', () => {
  const a = src.indexOf(BLOCKED);
  const b = src.indexOf(GUARD);
  assert(a > 0 && b > a, '顺序不对或是同一行');
});
ok('reason 为空 + 抑制点未过 → 拦', () => {
  const hold = { until: Date.now() + 60000 };
  assert(!('' && 0) && Number((hold && hold.until) || 0) > Date.now(), '谓词应成立');
});
ok('reason=question + 抑制点未过 → 不被这条守卫拦', () => {
  const reason = 'question';
  const hold = { until: Date.now() + 60000 };
  assert(!(!reason && Number((hold && hold.until) || 0) > Date.now()), '护栏应放过带 reason 的');
});

console.log('\n[5] 旧状态与配置');
ok('st 上没有 wakeTimes/exemptWakeTimes 也不炸', () => {
  const st = { wakeConfig: {} };
  const r = run(st, 'willingness');
  eq(r.out, 'passed');
  assert(Array.isArray(st.wakeTimes), '应自动补空数组');
});
ok('旧记录继续计入普通额度（不清空）', () => {
  const old = fill(5, 20 * MIN, 1000);
  const st = mk(old, []);
  run(st, 'willingness');
  eq(st.wakeTimes.length, 5, '旧记录不该被清');
});
ok('maxWakePerHour=0 视为不限', () => {
  const st = mk(fill(50, 30 * MIN, 1000), []);
  const r = run(st, 'probability', { maxWakePerHour: 0, maxWakePerMinute: 0 });
  eq(r.denied, false);
  eq(r.out, 'passed');
});
ok('被拦时不消费抑制点以外的状态（repeat 调用幂等）', () => {
  const st = mk(fill(5, 10 * MIN, 1000), []);
  run(st, 'probability');
  const h1 = st.wakeHold && st.wakeHold.until;
  run(st, 'probability');
  eq(st.wakeHold && st.wakeHold.until, h1, '第二次不该改抑制点');
});

console.log('\n[6] 落点完整性');
ok('wake-hold 三处落点齐全', () => {
  const n = (src.match(/MARKER: wake-hold/g) || []).length;
  assert(n >= 3, 'MARKER: wake-hold 只有 ' + n + ' 处');
});
ok('抑制点写入与作废成对出现', () => {
  assert(src.includes('st.wakeHold = { until, at: now'), '没找到写入点');
  assert(src.includes('st.wakeHold = null;   // 真的唤醒了'), '没找到作废点');
});

console.log('\n结果：' + pass + ' 过 / ' + fail + ' 挂');
if (fail > 0) process.exitCode = 1;
