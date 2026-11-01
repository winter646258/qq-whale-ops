#!/usr/bin/env node
// 集成测试：从线上 bridge.js 抽出真实的 scheduleWakeV2 段，用假定时器 + 假 Date 跑。
// 目的：证明「窗口内又来一条消息 → 取消旧定时器并按滑动规则重排」真的发生了。
import fs from 'node:fs';

const SRC = '/opt/qq-bridge/src/bridge.js';
const text = fs.readFileSync(SRC, 'utf8');

const START = '  function scheduleWakeV2(key, reason, opts = {}) {';
const END = '  // MARKER: tts-gc-tick';
const i = text.indexOf(START);
const j = text.indexOf(END);
if (i < 0 || j < 0 || j <= i) {
  console.error('抽不到 scheduleWakeV2：START=' + i + ' END=' + j);
  process.exit(2);
}
const body = text.slice(i, j);
console.log(`抽出 ${body.length} 字节（scheduleWakeV2 全文）`);

// 形参顺序必须与下面调用处一致。Date 也注入，否则 Date.now() 骗不了。
const PARAMS = [
  'decideRearm', 'planBatchWindow', 'resolveBatchPolicy',
  'cfg', 'socialV2', 'log',
  'cancelCooldownUntil', 'isSessionAllowedInCurrentMode', 'getSocialV2State',
  'isConversationBusyV2', 'enqueuePendingWake', 'cancelReplyCheckV2',
  'wakePriorityV2', 'wakeTriggerSeq', 'sendWakePromptV2',
  'setTimeout', 'clearTimeout', 'Date',
];
const factory = new Function(
  ...PARAMS,
  `"use strict";
   ${body}
   return { scheduleWakeV2 };`,
);

// ── 假时钟：setTimeout/clearTimeout/Date.now 全都受控 ──────────
function makeClock() {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map();
  const setTimeoutFake = (fn, ms) => {
    const id = ++seq;
    timers.set(id, { fn, at: now + Math.max(1, Number(ms) || 0) });
    return { __id: id, unref() {} };
  };
  const clearTimeoutFake = (h) => { if (h && h.__id) timers.delete(h.__id); };
  const advance = (ms) => {
    now += ms;
    let guard = 0;
    for (;;) {
      if (guard++ > 500) break;
      let pick = null;
      for (const [id, t] of timers) if (t.at <= now && (!pick || t.at < pick.t.at)) pick = { id, t };
      if (!pick) break;
      timers.delete(pick.id);
      pick.t.fn();
    }
  };
  class FakeDate {
    constructor(...a) { return a.length ? new (class { constructor() { this.__d = a[0]; } })() : new RealDate(now); }
    static now() { return now; }
    static parse(s) { return RealDate.parse(s); }
  }
  const RealDate = globalThis.Date;
  return { setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake, advance, now: () => now, pending: () => timers.size, Date: FakeDate };
}

let pass = 0;
let fail = 0;
const eq = (a, b, msg) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { pass += 1; console.log(`  ok  ${msg}`); }
  else { fail += 1; console.log(`  FAIL ${msg}\n       实得=${JSON.stringify(a)}\n       期望=${JSON.stringify(b)}`); }
};
const ok = (v, msg) => eq(Boolean(v), true, msg);

function build(clock, opts = {}) {
  const {
    maxBatchWindowMs = 30000, batchWindowMs = 8000, extend = true,
    busy = false, priorityMap = null,
  } = opts;
  const state = {
    pendingWakeTimer: null, pendingWakeReason: null,
    batchFirstAt: 0, batchDeadline: 0, sleepTimer: null, lastUnreadSeq: 7,
    pendingWakeReasons: [],
    wakeConfig: { batchWindowMs, maxBatchWindowMs, extendBatchOnNewMessage: extend },
  };
  const sent = [];
  const logs = [];
  const queued = [];
  const wakeTriggerSeq = new Map();
  const prio = priorityMap || { anyMessage: 1, atMention: 5, private: 6, question: 4, willingness: 2 };
  const realModule = globalThis.__batch;
  const { scheduleWakeV2 } = factory(
    realModule.decideRearm, realModule.planBatchWindow, realModule.resolveBatchPolicy,
    { socialV2: { enabled: true, paused: false } }, { paused: false },
    (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ')),
    new Map(),
    () => true,
    () => state,
    () => busy,
    (st2, reason, seq) => { queued.push({ reason, seq }); st2.pendingWakeReasons.push({ reason, seq, at: clock.now(), pr: 1 }); },
    () => {},
    (r) => prio[String(r ?? '').split(':')[0]] ?? prio[r] ?? 1,
    wakeTriggerSeq,
    (k, r) => { sent.push({ key: k, reason: r, at: clock.now() }); return Promise.resolve(); },
    clock.setTimeout, clock.clearTimeout, clock.Date,
  );
  return { scheduleWakeV2, state, sent, logs, queued };
}

// ── 1. 首次建窗口 ────────────────────────────────────────
console.log('\n【1】首次建窗口');
{
  const clock = makeClock();
  const t = build(clock);
  const t0 = clock.now();
  t.scheduleWakeV2('group:1', 'anyMessage');
  eq(clock.pending(), 1, '排了一个定时器');
  eq(t.state.batchFirstAt, t0, 'batchFirstAt 记下来了');
  eq(t.state.batchDeadline, t0 + 8000, 'deadline = now + 8000');
  ok(t.logs.some((l) => /计划唤醒.*8s 后发送/.test(l)), '日志写了 8s');
  clock.advance(8000);
  eq(t.sent.length, 1, '到点发了');
  eq(t.state.pendingWakeTimer, null, '定时器清空');
  eq(t.state.batchDeadline, 0, 'deadline 清空');
  eq(t.state.batchFirstAt, 0, 'firstAt 清空');
}

// ── 2. 窗口内来第二条 → 延后 ─────────────────────────────
console.log('\n【2】窗口内第二条 → 滑动延后');
{
  const clock = makeClock();
  const t = build(clock);
  const t0 = clock.now();
  t.scheduleWakeV2('group:1', 'anyMessage');
  clock.advance(3000);
  t.scheduleWakeV2('group:1', 'anyMessage');
  eq(t.sent.length, 0, '还没发');
  eq(clock.pending(), 1, '仍然只有一个定时器');
  eq(t.state.batchDeadline, clock.now() + 8000, '新 deadline = 现在 + 8000');
  ok(t.logs.some((l) => /合并窗口延后.*8s 后发送/.test(l)), '日志写了「合并窗口延后」');
  ok(t.state.batchDeadline > t0 + 8000, '确实比原来晚');
  clock.advance(8000);
  eq(t.sent.length, 1, '延后之后才发，只发一次');
  eq(t.sent[0].at - t0, 11000, '实际在 11 秒时发出');
}

// ── 3. 连续刷屏被封顶 ────────────────────────────────────
console.log('\n【3】连续刷屏 → 封顶 30 秒');
{
  const clock = makeClock();
  const t = build(clock);
  const t0 = clock.now();
  t.scheduleWakeV2('group:1', 'anyMessage');
  // 每 3 秒来一条，但只刷到封顶前（t0+27s）——不能刷过 30s，
  // 否则定时器先到点发了一轮，之后每条消息开的都是「新窗口」，测的就不是封顶了。
  for (let k = 0; k < 9; k += 1) {
    clock.advance(3000);
    t.scheduleWakeV2('group:1', 'anyMessage');
  }
  eq(t.sent.length, 0, '封顶前一条都没发');
  eq(t.state.batchDeadline, t0 + 30000, `真的封顶在 t0+30s（实际 deadline-t0=${t.state.batchDeadline - t0}）`);
  ok(t.logs.some((l) => /已到上限|封顶|cap/i.test(l) || /合并窗口延后/.test(l)), '有延后/封顶记录');
  clock.advance(3000);
  eq(t.sent.length, 1, '封顶时刻只发一次');
  eq(t.sent[0].at - t0, 30000, '正好在 30 秒发出');
}

// ── 4. 延长开关关掉时退回快照行为 ────────────────────────
console.log('\n【4】extendBatchOnNewMessage=false 退回快照');
{
  const clock = makeClock();
  const t = build(clock, { extend: false });
  const t0 = clock.now();
  t.scheduleWakeV2('group:1', 'anyMessage');
  clock.advance(3000);
  t.scheduleWakeV2('group:1', 'anyMessage');
  eq(t.state.batchDeadline, t0 + 8000, 'deadline 没被推后');
  clock.advance(5000);
  eq(t.sent.length, 1, '按原定 8 秒发出');
  eq(t.sent[0].at - t0, 8000, '正好 8 秒');
  ok(!t.logs.some((l) => /合并窗口延后/.test(l)), '没有延后日志');
}

// ── 5. 原因升级仍然有效 ─────────────────────────────────
console.log('\n【5】优先级升级不受影响');
{
  const clock = makeClock();
  const t = build(clock);
  t.scheduleWakeV2('group:1', 'anyMessage');
  clock.advance(2000);
  t.scheduleWakeV2('group:1', 'atMention');
  ok(t.logs.some((l) => /升级唤醒原因.*anyMessage -> atMention/.test(l)), '原因升级日志出现');
  eq(t.state.pendingWakeReason, 'atMention', 'state 里存的是升级后的原因');
  clock.advance(20000);
  eq(t.sent.map((s) => s.reason), ['atMention'], '最终用的是升级后的原因');
}

// ── 6. 同一毫秒连调两次不该堆定时器 ──────────────────────
console.log('\n【6】同一毫秒连调两次');
{
  const clock = makeClock();
  const t = build(clock);
  t.scheduleWakeV2('group:1', 'anyMessage');
  t.scheduleWakeV2('group:1', 'anyMessage');
  eq(clock.pending(), 1, '只有一个定时器');
  clock.advance(30000);
  eq(t.sent.length, 1, '只发一次');
}

// ── 7. 会话繁忙时低优先级进积压队列（回归：不该被合并窗口吞）──
console.log('\n【7】繁忙时低优先级进积压队列');
{
  const clock = makeClock();
  const t = build(clock, { busy: true });
  t.scheduleWakeV2('group:1', 'willingness');
  eq(t.queued.length, 1, '进了积压队列');
  eq(t.sent.length, 0, '没直接发');
}

// ── 8. 繁忙时 private 照常安排（回归）──────────────────
console.log('\n【8】繁忙时 private 照常安排');
{
  const clock = makeClock();
  const t = build(clock, { busy: true });
  t.scheduleWakeV2('private:1', 'private');
  eq(t.queued.length, 0, '没进积压队列');
  eq(clock.pending(), 1, '排了定时器');
}

console.log(`\n结果：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
