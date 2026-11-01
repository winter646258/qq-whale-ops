// 三态注意力 shadow 层单测。
// 跑法：node scripts/test-attention-shadow.mjs
import {
  SHADOW_DEFAULTS,
  normalizeShadowCfg,
  classifyAttention,
  newDayBucket,
  pushEvent,
  fillLatency,
  noteSelfSpeak,
  pendingSummaryOf,
  quantile,
  turnGapStats,
  stratifiedBootstrapDeltaP90,
  shadowReport,
} from '../src/attention-shadow.js';

let pass = 0;
let fail = 0;
const eq = (a, b, msg) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { pass += 1; console.log(`  ✓ ${msg}`); } else { fail += 1; console.log(`  ✗ ${msg}\n      实得 ${JSON.stringify(a)}\n      期望 ${JSON.stringify(b)}`); }
};
const ok = (v, msg) => eq(Boolean(v), true, msg);
const notOk = (v, msg) => eq(Boolean(v), false, msg);

console.log('\n【1】classifyAttention —— 明确触发必须穿透');
for (const [band, reason, side] of [
  ['focused', 'atMention', 'group'],
  ['focused', 'nameMention', 'group'],
  ['focused', 'poke', 'group'],
  ['focused', 'private', 'private'],
  ['occupied', 'atMention', 'group'],
]) {
  const r = classifyAttention({ band, reason, side });
  eq(r.intent, 'explicit', `${band}/${reason} 判 explicit`);
  ok(String(r.group).startsWith('B-') || r.group === 'A', `${band}/${reason} group=${r.group} 合法`);
}
// 私聊即使 reason 为空也必须 explicit
eq(classifyAttention({ band: 'focused', reason: '', side: 'private' }).intent, 'explicit', '私聊空 reason 仍 explicit');

console.log('\n【2】classifyAttention —— 软触发撞 focused 才是抑制点');
for (const reason of ['willingness', 'probability', 'anyMessage', 'replyCheck', 'keyword', 'speaker']) {
  eq(classifyAttention({ band: 'focused', reason, side: 'group' }).intent, 'suppress', `focused/${reason} → suppress`);
}
// occupied 只慢不吞
eq(classifyAttention({ band: 'occupied', reason: 'willingness', side: 'group' }).intent, 'pass', 'occupied/软触发只 pass');
eq(classifyAttention({ band: 'occupied', reason: 'willingness', side: 'group' }).group, 'B-occupied', 'occupied 软触发仍计 B');
// available 全 pass 且计 A
eq(classifyAttention({ band: 'available', reason: 'willingness', side: 'group' }).intent, 'pass', 'available 不抑制');
eq(classifyAttention({ band: 'available', reason: 'willingness', side: 'group' }).group, 'A', 'available 计入 A');
// asleep 不叠抑制
eq(classifyAttention({ band: 'asleep', reason: 'willingness', side: 'group' }).intent, 'pass', 'asleep 不抑制');
eq(classifyAttention({ band: 'asleep', reason: 'willingness', side: 'group' }).group, 'Z-asleep', 'asleep 计入 Z 组（不参与对比）');
// 无 band
eq(classifyAttention({ band: '', reason: 'willingness', side: 'group' }).intent, 'pass', '无 band 不抑制');
// focused + 非软非明确
eq(classifyAttention({ band: 'focused', reason: 'bootstrap', side: 'group' }).intent, 'pass', 'focused/bootstrap 不抑制');
// focused + question：question 不在软也不在明确，pass 但计 B
const q = classifyAttention({ band: 'focused', reason: 'question', side: 'group' });
eq(q.intent, 'pass', 'question 不被 focused 吞');
eq(q.group, 'B-focused', 'question 仍归 B 组');

console.log('\n【2b】没触发唤醒的消息单列 N 组、睡眠单列 Z 组');
eq(classifyAttention({ band: 'available', reason: '', side: 'group' }).group, 'N', 'available 空 reason → N');
eq(classifyAttention({ band: 'available', reason: 'willingness', side: 'group' }).group, 'A', 'available 有 reason → A');
eq(classifyAttention({ band: '', reason: '', side: 'group' }).group, 'N', '无 band 无 reason → N');
eq(classifyAttention({ band: 'focused', reason: '', side: 'group' }).group, 'N', 'focused 空 reason → N（没触发就没什么可抑制）');
eq(classifyAttention({ band: 'asleep', reason: 'willingness', side: 'group' }).group, 'Z-asleep', '睡眠期软触发 → Z');
eq(classifyAttention({ band: 'asleep', reason: 'atMention', side: 'group' }).group, 'Z-asleep', '睡眠期明确触发 → Z（仍不参与对比）');
eq(classifyAttention({ band: 'asleep', reason: '', side: 'group' }).group, 'N', '睡眠期无触发 → N');

console.log('\n【3】normalizeShadowCfg —— 脏配置');
const d = normalizeShadowCfg(null);
eq(d.minB, 30, '默认 minB=30');
eq(d.minA, 100, '默认 minA=100');
eq(d.bootstrapIterations, 1000, '默认 1000 次重采样');
eq(normalizeShadowCfg({ minB: 0 }).minB, SHADOW_DEFAULTS.minB, 'minB=0 视为非法回落');
eq(normalizeShadowCfg({ minB: 'abc' }).minB, SHADOW_DEFAULTS.minB, 'minB 非数字回落');
eq(normalizeShadowCfg({ minB: 5 }).minB, 5, 'minB=5 合法');
eq(normalizeShadowCfg({ enabled: false }).enabled, false, 'enabled:false 生效');
eq(normalizeShadowCfg({ bootstrapIterations: 999999 }).bootstrapIterations, 20000, 'iterations 封顶 20000');
eq(normalizeShadowCfg({ bootstrapIterations: 10 }).bootstrapIterations, 200, 'iterations 兜底 200');

console.log('\n【4】pushEvent —— 有界与计数');
{
  const b = newDayBucket('2026-11-02');
  const ev = { at: 1000, key: 'group:1', side: 'group', reason: 'willingness', band: 'focused', intent: 'suppress', group: 'B-focused', unreadAtArrival: 5, latencyMs: -1 };
  eq(pushEvent(b, ev, { cfg: { maxEventsPerDay: 3 } }).stored, true, '第一条入桶');
  eq(b.counters.total, 1, 'total=1');
  eq(b.counters.byIntent.suppress, 1, 'byIntent.suppress=1');
  eq(b.counters.byBand.focused, 1, 'byBand.focused=1');
  eq(b.counters.suppressedUnreadAtArrival, 5, '未读累计 5');
  pushEvent(b, { ...ev }, { cfg: { maxEventsPerDay: 3 } });
  pushEvent(b, { ...ev }, { cfg: { maxEventsPerDay: 3 } });
  const r4 = pushEvent(b, { ...ev }, { cfg: { maxEventsPerDay: 3 } });
  eq(r4.stored, false, '第 4 条被丢');
  eq(b.events.length, 3, 'events 上界 3');
  eq(b.dropped, 1, 'dropped=1');
  eq(b.counters.total, 4, 'total 仍记 4（计数不丢）');
  eq(b.counters.suppressedMaxUnreadAtArrival, 5, '最大未读 5');
}
{
  // explicit 且 busy → explicitWhileBusy
  const b = newDayBucket('2026-11-02');
  pushEvent(b, { at: 1, key: 'g:1', side: 'group', reason: 'atMention', band: 'focused', intent: 'explicit', group: 'B-focused', latencyMs: -1 });
  eq(b.counters.explicitWhileBusy, 1, 'focused 下明确触发计数 +1');
  pushEvent(b, { at: 2, key: 'g:1', side: 'group', reason: 'atMention', band: 'available', intent: 'explicit', group: 'A', latencyMs: -1 });
  eq(b.counters.explicitWhileBusy, 1, 'available 下明确触发不计');
}
{
  // 不存正文：事件字段必须只有白名单
  const b = newDayBucket('2026-11-02');
  pushEvent(b, { at: 1, key: 'g:1', side: 'group', reason: 'willingness', band: 'focused', intent: 'suppress', group: 'B-focused', latencyMs: -1, text: '这是一段不该被存下来的聊天正文' });
  eq(Object.prototype.hasOwnProperty.call(b.events[0], 'text'), false, '事件里不存正文');
  ok(b.events[0].latencyMs === -1, 'latency 初值 -1');
}

console.log('\n【5】fillLatency — 回填与超时');
{
  const b = newDayBucket('2026-11-02');
  const cfg = { latencyMaxMs: 600000 };
  pushEvent(b, { at: 1000, key: 'group:1', side: 'group', reason: 'willingness', band: 'focused', intent: 'suppress', group: 'B-focused', latencyMs: -1 }, { cfg });
  pushEvent(b, { at: 2000, key: 'group:1', side: 'group', reason: 'willingness', band: 'focused', intent: 'suppress', group: 'B-focused', latencyMs: -1 }, { cfg });
  pushEvent(b, { at: 3000, key: 'group:2', side: 'group', reason: 'willingness', band: 'focused', intent: 'suppress', group: 'B-focused', latencyMs: -1 }, { cfg });
  eq(fillLatency(b, 'group:1', 5000, { cfg }), 2, '只回填同会话的 2 条');
  eq(b.events[0].latencyMs, 4000, '第一条延迟 4000');
  eq(b.events[1].latencyMs, 3000, '第二条延迟 3000');
  eq(b.events[2].latencyMs, -1, '别的会话不动');
  eq(fillLatency(b, 'group:1', 9000, { cfg }), 0, '已回填的不重复填');
  // 超时
  const b2 = newDayBucket('2026-11-02');
  pushEvent(b2, { at: 1000, key: 'group:1', side: 'group', reason: 'willingness', band: 'focused', intent: 'suppress', group: 'B-focused', latencyMs: -1 }, { cfg });
  eq(fillLatency(b2, 'group:1', 1000 + 700000, { cfg }), 0, '超过 latencyMaxMs 不回填');
  eq(b2.events[0].latencyMs, -2, '记成超时 -2');
}

console.log('\n【6】noteSelfSpeak — 有界');
{
  const b = newDayBucket('2026-11-02');
  const cfg = { maxEventsPerDay: 2 };
  eq(noteSelfSpeak(b, 1000, { cfg }), true, '第一条记下');
  eq(noteSelfSpeak(b, 2000, { cfg }), true, '第二条记下');
  eq(noteSelfSpeak(b, 3000, { cfg }), false, '超界拒绝');
  eq(b.selfTimes.length, 2, 'selfTimes 上界 2');
  eq(b.selfDropped, 1, 'selfDropped=1');
  eq(noteSelfSpeak(b, 0, { cfg }), false, '时刻 0 不记');
}

console.log('\n【7】pendingSummaryOf — 摘要必须有界');
{
  const evs = [];
  for (let i = 0; i < 40; i += 1) {
    evs.push({ at: 1000 + i * 10, key: `group:${i % 3}`, reason: 'willingness', intent: 'suppress', group: 'B-focused' });
  }
  const s = pendingSummaryOf(evs, { cfg: { maxPendingSenders: 6, pendingKeepHead: 2, pendingKeepTail: 2 } });
  eq(s.count, 40, 'count=40');
  eq(s.dropped, 36, 'dropped=40-2-2=36');
  eq(s.senders.length, 3, 'sender 去重后 3 个');
  eq(s.head.length, 2, 'head 2 条');
  eq(s.tail.length, 2, 'tail 2 条');
  ok(s.chars < 1400, `字符估算有界（${s.chars}）`);
  eq(s.firstAt, 1000, 'firstAt');
  eq(s.lastAt, 1390, 'lastAt');
}
{
  // sender 超过上限也要截
  const evs = [];
  for (let i = 0; i < 20; i += 1) evs.push({ at: i + 1, key: `group:${i}`, reason: 'willingness', intent: 'suppress' });
  const s = pendingSummaryOf(evs, { cfg: { maxPendingSenders: 6 } });
  eq(s.senders.length, 6, 'sender 上界 6');
}
eq(pendingSummaryOf([]).count, 0, '空输入 count=0');
eq(pendingSummaryOf(null).count, 0, 'null 输入不炸');

console.log('\n【8】quantile');
eq(quantile([], 0.5), 0, '空数组 0');
eq(quantile([5], 0.9), 5, '单元素');
eq(quantile([1, 2, 3, 4, 5], 0.5), 3, '中位数');
eq(quantile([1, 2, 3, 4], 0.5), 2.5, '偶数中位插值');
eq(quantile([1, 2, 3], 0), 1, 'q=0 取最小');
eq(quantile([1, 2, 3], 1), 3, 'q=1 取最大');
eq(quantile([3, 1, 2], 0.5), 2, '乱序也能算');
eq(quantile([-1, 5], 0.5), 5, '负值被过滤');

console.log('\n【9】turnGapStats —— 验证 5 秒算不算分条');
{
  const times = [1000, 1500, 2500, 10000, 11000];
  const s = turnGapStats(times);
  eq(s.n, 4, '4 个间隔');
  eq(s.under1s, 1, '1 秒内只有 500ms 那 1 个（1000ms 不算「内」）');
  eq(s.under5s, 3, '5 秒内 3 个');
  eq(s.under120s, 4, '全部在 2 分钟内');
  eq(turnGapStats([]).n, 0, '空输入');
  eq(turnGapStats([5]).n, 0, '单点无间隔');
  eq(turnGapStats([1000, 2000, NaN, 0, -5]).n, 1, '非法值被过滤');
}

console.log('\n【10】stratifiedBootstrapDeltaP90 —— 确定性、样本不足');
{
  const mk = (n, group, base, key = 'g:1') => Array.from({ length: n }, (_, i) => ({ key, group, latencyMs: base + (i % 10) * 100 }));
  // 样本不足
  const few = [...mk(10, 'B-focused', 5000), ...mk(20, 'A', 1000)];
  const r1 = stratifiedBootstrapDeltaP90(few, { cfg: { minB: 30, minA: 100 } });
  eq(r1.insufficient, true, '样本不足时不跑 bootstrap');
  eq(r1.iterations, 0, 'iterations=0');
  eq(r1.bN, 10, 'bN=10');
  eq(r1.aN, 20, 'aN=20');
  // 样本足够，且 B 明显更慢
  const big = [...mk(60, 'B-focused', 20000), ...mk(200, 'A', 2000)];
  const r2 = stratifiedBootstrapDeltaP90(big, { cfg: { minB: 30, minA: 100, bootstrapIterations: 500 } });
  eq(r2.insufficient, false, '样本足够');
  ok(r2.point > 0, `point=${Math.round(r2.point)} > 0`);
  ok(r2.lo > 0, `95% 下界 ${Math.round(r2.lo)} > 0（B 真的更慢）`);
  ok(r2.lo <= r2.hi, '区间有序');
  // 确定性：同种子同输入必须同结果
  const r3 = stratifiedBootstrapDeltaP90(big, { cfg: { minB: 30, minA: 100, bootstrapIterations: 500 } });
  eq(r3.lo, r2.lo, '同种子重跑下界一致');
  eq(r3.hi, r2.hi, '同种子重跑上界一致');
  // B 反而更快 → 区间应跨 0 或全负
  const rev = [...mk(60, 'B-focused', 500), ...mk(200, 'A', 20000)];
  const r4 = stratifiedBootstrapDeltaP90(rev, { cfg: { minB: 30, minA: 100 } });
  ok(r4.hi < 0 || (r4.lo <= 0 && r4.hi >= 0), `B 更快时不会给 eligible（lo=${Math.round(r4.lo)} hi=${Math.round(r4.hi)}）`);
  // 超时样本不得计入
  const withTimeout = [...mk(60, 'B-focused', 20000), ...mk(200, 'A', 2000), { key: 'g:1', group: 'B-focused', latencyMs: -2 }];
  const r5 = stratifiedBootstrapDeltaP90(withTimeout, { cfg: { minB: 30, minA: 100 } });
  eq(r5.bN, 60, '超时样本被剔除');
  // 分层：两个会话样本量悬殊，结果应仍以 B/A 差异为准
  const two = [
    ...mk(50, 'B-focused', 20000, 'g:1'), ...mk(20, 'A', 2000, 'g:1'),
    ...mk(20, 'B-focused', 20000, 'g:2'), ...mk(150, 'A', 2000, 'g:2'),
  ];
  const r6 = stratifiedBootstrapDeltaP90(two, { cfg: { minB: 30, minA: 100, bootstrapIterations: 500 } });
  ok(r6.lo > 0, `跨会话分层后下界仍 >0（${Math.round(r6.lo)}）`);
}

console.log('\n【11】shadowReport —— 判据必须自动出结论');
{
  // 造 3 天，样本不足
  const days = {};
  for (const day of ['2026-11-01', '2026-11-02', '2026-11-03']) {
    const b = newDayBucket(day);
    for (let i = 0; i < 10; i += 1) {
      pushEvent(b, { at: 1000 + i, key: 'group:1', side: 'group', reason: 'willingness', band: i < 3 ? 'focused' : 'available', intent: i < 3 ? 'suppress' : 'pass', group: i < 3 ? 'B-focused' : 'A', latencyMs: i < 3 ? 30000 : 5000 });
    }
    noteSelfSpeak(b, 2000);
    days[day] = b;
  }
  const rep = shadowReport(days, { cfg: { minB: 30, minA: 100 } });
  eq(rep.verdict, 'insufficient', '|B|=9 <30 ⇒ 样本不足');
  eq(rep.insufficient, true, 'insufficient=true');
  eq(rep.bN, 9, 'bN=9');
  eq(rep.aN, 21, 'aN=21');
  ok(rep.mB > 0 && rep.mB < 0.5, `M_B=${rep.mB.toFixed(2)} 合理`);
  eq(rep.days.length, 3, '3 天');
  eq(rep.thresholds.minB, 30, '阈值带出来');
  // 无数据也不炸
  const empty = shadowReport({}, {});
  eq(empty.verdict, 'insufficient', '空数据判样本不足');
  eq(empty.events, 0, 'events=0');
  eq(shadowReport(null).verdict, 'insufficient', 'null 不炸');
}
{
  // 样本足够且 B 明显慢 → eligible
  const b = newDayBucket('2026-11-02');
  for (let i = 0; i < 200; i += 1) {
    pushEvent(b, { at: 1000 + i, key: 'group:1', side: 'group', reason: 'willingness', band: 'focused', intent: 'suppress', group: 'B-focused', latencyMs: 20000 + i });
  }
  for (let i = 0; i < 300; i += 1) {
    pushEvent(b, { at: 5000 + i, key: 'group:2', side: 'group', reason: 'willingness', band: 'available', intent: 'pass', group: 'A', latencyMs: 2000 + i });
  }
  const rep = shadowReport({ '2026-11-02': b }, { cfg: { minB: 30, minA: 100, bootstrapIterations: 400, maxEventsPerDay: 5000 } });
  eq(rep.verdict, 'eligible-for-canary', '样本够且 B 更慢 ⇒ 有资格进 canary');
  ok(rep.bootstrap.lo > 0, `下界 ${Math.round(rep.bootstrap.lo)} > 0`);
}
{
  // 样本够但没差异 → no-delta
  const b = newDayBucket('2026-11-02');
  for (let i = 0; i < 200; i += 1) {
    pushEvent(b, { at: 1000 + i, key: 'group:1', side: 'group', reason: 'willingness', band: 'focused', intent: 'suppress', group: 'B-focused', latencyMs: 5000 + (i % 7) });
  }
  for (let i = 0; i < 300; i += 1) {
    pushEvent(b, { at: 5000 + i, key: 'group:2', side: 'group', reason: 'willingness', band: 'available', intent: 'pass', group: 'A', latencyMs: 5000 + (i % 7) });
  }
  const rep = shadowReport({ '2026-11-02': b }, { cfg: { minB: 30, minA: 100, bootstrapIterations: 400, maxEventsPerDay: 5000 } });
  eq(rep.verdict, 'no-delta', '两组一样快 ⇒ 不给 canary');
}

console.log('\n【12】红线：shadow 不许有任何调度副作用');
{
  // 纯函数模块，不应 import 任何 fs / 网络 / 计时器
  const src = await import('node:fs').then((m) => m.readFileSync(new URL('../src/attention-shadow.js', import.meta.url), 'utf8'));
  eq(/from ['"]node:fs['"]/.test(src), false, '不 import fs');
  eq(/from ['"]node:http/.test(src), false, '不 import http');
  eq(/\bsetTimeout\s*\(/.test(src), false, '不调 setTimeout');
  eq(/\bsetInterval\s*\(/.test(src), false, '不调 setInterval');
  eq(/Math\.random\s*\(/.test(src), false, '不调 Math.random（bootstrap 必须可复现）');
  eq(/\bwriteFileSync\b/.test(src), false, '不写文件');
}

console.log(`\n结果：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
