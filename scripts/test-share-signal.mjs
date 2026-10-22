// 主动报告纯逻辑的单测。跑法：node scripts/test-share-signal.mjs
//
// 每条用例都盯着计划里的硬规则，不测实现细节：
//   · 只有群事件能触发；私聊自身不能制造来信
//   · 同一事件只报一次
//   · 6 小时一次、每日 4 次
//   · 连续 3 次未回应 → 间隔减半（翻倍），连续 3 天无回应 → 暂停一周
//   · 安静时段、暂停恢复、主人回应清退避
//   · 角色不能解除系统硬上限
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createDefaultState, normalizeState, addSignal, canDeliver, markDelivered,
  settleDeliveries, noteOwnerReply, setPolicy, pruneState, statsOf,
  inQuietHours, normalizePolicy, clampValence, trimSummary, effectiveIntervalMs,
  isGroupKey, pickSignal,
  loadShareState, saveShareState, lastDelivery,
  HARD_MIN_INTERVAL_MS, HARD_MAX_PER_DAY, RESPONSE_WINDOW_MS, PAUSE_MS,
  MAX_SUMMARY_CHARS, MAX_SIGNALS
} from '../src/share-signal-store.js';

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// 用固定基准时间，避免真实时钟影响。选 14:00 是因为它不在默认安静时段里。
const T0 = Date.parse('2026-10-22T14:00:00+08:00');

// 落盘测试用独立临时目录，跑完自己清掉 —— 不碰仓库里的 state/。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-signal-test-'));
process.on('exit', () => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function fresh() {
  return createDefaultState(T0);
}

// 造一个「已经能发」的状态：有一条信号，从没发过
function readyState(overrides = {}) {
  const st = fresh();
  addSignal(st, {
    eventId: 'ev1', summary: '群里在吵一部新番好不好看',
    valence: 0.4, sourceGroup: 'group:906710082', now: T0
  });
  return Object.assign(st, overrides);
}

// ── 基础归一化 ────────────────────────────────────────────
t('isGroupKey 只认 group:数字', () => {
  assert.equal(isGroupKey('group:906710082'), true);
  assert.equal(isGroupKey('private:1124721191'), false);
  assert.equal(isGroupKey('group:abc'), false);
  assert.equal(isGroupKey(''), false);
});

t('valence 夹到 -1..+1', () => {
  assert.equal(clampValence(5), 1);
  assert.equal(clampValence(-9), -1);
  assert.equal(clampValence('0.3'), 0.3);
  assert.equal(clampValence('abc'), 0);
});

t('摘要按字符截断并加省略号', () => {
  const long = '鲸'.repeat(200);
  const out = trimSummary(long);
  assert.equal(out.length, MAX_SUMMARY_CHARS);
  assert.ok(out.endsWith('…'));
  assert.equal(trimSummary('  多个   空格  合并 '), '多个 空格 合并');
  assert.equal(trimSummary(undefined), '');
});

// ── 策略不能被放宽 ────────────────────────────────────────
t('角色想把间隔调到 1 小时 → 被夹回 6 小时', () => {
  const p = normalizePolicy({ minIntervalMs: HOUR });
  assert.equal(p.minIntervalMs, HARD_MIN_INTERVAL_MS);
});

t('角色想把每日上限调到 20 条 → 被夹回 4 条', () => {
  assert.equal(normalizePolicy({ maxPerDay: 20 }).maxPerDay, HARD_MAX_PER_DAY);
});

t('角色想调成每日 0 条 → 抬到 1（关要用 enabled=false）', () => {
  assert.equal(normalizePolicy({ maxPerDay: 0 }).maxPerDay, 1);
});

t('非法小时数回落到默认', () => {
  const p = normalizePolicy({ quietStartHour: 99, quietEndHour: -3 });
  assert.equal(p.quietStartHour, 23);
  assert.equal(p.quietEndHour, 8);
});

t('setPolicy 之后硬上限依然成立', () => {
  const st = fresh();
  setPolicy(st, { minIntervalMs: 1000, maxPerDay: 99 });
  assert.equal(st.policy.minIntervalMs, HARD_MIN_INTERVAL_MS);
  assert.equal(st.policy.maxPerDay, HARD_MAX_PER_DAY);
});

// ── 安静时段 ─────────────────────────────────────────────
t('安静时段跨零点（23→8）', () => {
  const p = normalizePolicy({});
  assert.equal(inQuietHours(23, p), true);
  assert.equal(inQuietHours(0, p), true);
  assert.equal(inQuietHours(7, p), true);
  assert.equal(inQuietHours(8, p), false);
  assert.equal(inQuietHours(14, p), false);
});

t('安静时段同起同止 = 没有安静时段', () => {
  const p = normalizePolicy({ quietStartHour: 5, quietEndHour: 5 });
  assert.equal(inQuietHours(5, p), false);
});

// ── 信号准入 ─────────────────────────────────────────────
t('私聊来源一律拒绝', () => {
  const st = fresh();
  const r = addSignal(st, { eventId: 'e1', summary: 'x', valence: 0, sourceGroup: 'private:1124721191', now: T0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'group-source-required');
});

t('缺 eventId / summary 拒绝', () => {
  const st = fresh();
  assert.equal(addSignal(st, { summary: 'x', sourceGroup: 'group:1', now: T0 }).reason, 'event-id-required');
  assert.equal(addSignal(st, { eventId: 'e', sourceGroup: 'group:1', now: T0 }).reason, 'summary-required');
});

t('同一 event 只收一次（seenEventIds 之外也拦 signals 内重复）', () => {
  const st = readyState();
  const r = addSignal(st, { eventId: 'ev1', summary: '换个说法', valence: 0, sourceGroup: 'group:906710082', now: T0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'duplicate-event');
});

t('已投递过的事件不许再进（seenEventIds 生效）', () => {
  const st = readyState();
  const d = canDeliver(st, { now: T0, hour: 14 });
  assert.equal(d.ok, true);
  markDelivered(st, { signalId: d.signal.id, now: T0 });
  const again = addSignal(st, { eventId: 'ev1', summary: '又来', valence: 0, sourceGroup: 'group:906710082', now: T0 + HOUR });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'duplicate-event');
});

t('负向事件也能进（覆盖三种 valence）', () => {
  const st = fresh();
  for (const [i, v] of [[-0.8, -0.8], [0, 0], [0.7, 0.7]].entries()) {
    const r = addSignal(st, { eventId: `e${i}`, summary: `s${i}`, valence: v[1], sourceGroup: 'group:1', now: T0 });
    assert.equal(r.ok, true, `valence=${v[1]} 应被接受`);
    assert.equal(r.signal.valence, v[1]);
  }
});

// ── 投递判定 ─────────────────────────────────────────────
t('没有信号时不能发，且不会自己编', () => {
  const st = fresh();
  const r = canDeliver(st, { now: T0, hour: 14 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-signal');
});

t('关掉之后不发', () => {
  const st = readyState();
  setPolicy(st, { enabled: false });
  assert.equal(canDeliver(st, { now: T0, hour: 14 }).reason, 'disabled');
});

t('第一次投递放行，并选出信号', () => {
  const r = canDeliver(readyState(), { now: T0, hour: 14 });
  assert.equal(r.ok, true);
  assert.equal(r.signal.eventId, 'ev1');
});

t('6 小时边界：差一秒不发，正好到点可以', () => {
  const st = readyState();
  markDelivered(st, { signalId: canDeliver(st, { now: T0, hour: 14 }).signal.id, now: T0 });
  addSignal(st, { eventId: 'ev2', summary: '第二件事', valence: 0.2, sourceGroup: 'group:1', now: T0 + HOUR });
  const a = canDeliver(st, { now: T0 + HARD_MIN_INTERVAL_MS - 1000, hour: 19 });
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'cooldown');
  assert.ok(a.waitMs > 0 && a.waitMs <= 1000);
  const b = canDeliver(st, { now: T0 + HARD_MIN_INTERVAL_MS, hour: 20 });
  assert.equal(b.ok, true);
});

t('安静时段不发（23 点）', () => {
  const r = canDeliver(readyState(), { now: T0, hour: 23 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'quiet-hours');
});

t('每日上限 4 次：24 小时内已有 4 条就拦', () => {
  // 直接摆出「24 小时内已发 4 条」的状态。
  // 不用循环真发：6 小时间隔下第 4 条落在 18h，此时首条还没滑出 24h 窗口，
  // 但到第 5 次（24h）首条正好滑出，循环写法永远撞不到上限——测了个寂寞。
  const st = readyState();
  st.deliveries = [0, 1, 2, 3].map((i) => ({
    id: `d${i}`, eventId: `e${i}`, at: T0 - 20 * HOUR + i * HOUR, answered: false, settled: false
  }));
  st.lastDeliveredAt = T0 - 17 * HOUR;
  const r = canDeliver(st, { now: T0, hour: 14 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'daily-cap');
});

t('每日上限的边界：24 小时窗口滑过后能再发', () => {
  const st = readyState();
  st.deliveries = [0, 1, 2, 3].map((i) => ({
    id: `d${i}`, eventId: `e${i}`, at: T0 - 25 * HOUR + i * HOUR, answered: false, settled: false
  }));
  st.lastDeliveredAt = T0 - 22 * HOUR;
  const r = canDeliver(st, { now: T0, hour: 14 });
  assert.equal(r.ok, true);
});

// ── 退避 ────────────────────────────────────────────────
t('连续 3 次未回应 → 间隔翻倍', () => {
  const st = readyState();
  st.unansweredStreak = 3;
  assert.equal(effectiveIntervalMs(st), HARD_MIN_INTERVAL_MS * 2);
});

t('settleDeliveries：窗口内不结算，过了窗口才算未回应', () => {
  const st = readyState();
  markDelivered(st, { signalId: canDeliver(st, { now: T0, hour: 14 }).signal.id, now: T0 });
  const early = settleDeliveries(st, { now: T0 + HOUR });
  assert.equal(early.newlyUnanswered, 0);
  assert.equal(st.unansweredStreak, 0);
  const late = settleDeliveries(st, { now: T0 + RESPONSE_WINDOW_MS + HOUR });
  assert.equal(late.newlyUnanswered, 1);
  assert.equal(st.unansweredStreak, 1);
});

t('主人回话后 streak 清零，且已回的投递不算未回应', () => {
  const st = readyState();
  markDelivered(st, { signalId: canDeliver(st, { now: T0, hour: 14 }).signal.id, now: T0 });
  const r = noteOwnerReply(st, { now: T0 + HOUR });
  assert.equal(r.answered, 1);
  assert.equal(st.unansweredStreak, 0);
  const settled = settleDeliveries(st, { now: T0 + RESPONSE_WINDOW_MS + HOUR });
  assert.equal(settled.newlyUnanswered, 0);
});

t('连续 3 天完全没回应 → 暂停一周', () => {
  const st = readyState();
  // createdAt 必须早于投递：真实场景里状态先存在才会有投递。
  // 「沉默了多久」是从 max(lastOwnerReplyAt, createdAt) 起算的，所以不设
  // createdAt 就等于「状态刚建好就判暂停」，那是假的。
  st.createdAt = T0 - 20 * DAY;
  st.deliveries = [0, 1, 2].map((i) => ({
    id: `d${i}`, eventId: `e${i}`, at: T0 - 4 * DAY + i * HOUR, answered: false, settled: false
  }));
  st.lastOwnerReplyAt = T0 - 10 * DAY;
  const r = settleDeliveries(st, { now: T0 });
  assert.equal(r.newlyUnanswered, 3);
  assert.equal(r.paused, true);
  assert.equal(st.silencedUntil, T0 + PAUSE_MS);
  const blocked = canDeliver(st, { now: T0 + DAY, hour: 14 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'paused');
});

t('刚建的状态不会被立刻判暂停（沉默从 createdAt 起算）', () => {
  const st = readyState();
  st.unansweredStreak = 3;
  const r = settleDeliveries(st, { now: T0 });
  assert.equal(r.paused, false);
  assert.equal(st.silencedUntil, 0);
});

t('只是没接话题、但人天天在聊 → 不暂停（只降频）', () => {
  const st = readyState();
  st.deliveries = [0, 1, 2].map((i) => ({
    id: `d${i}`, eventId: `e${i}`, at: T0 - 4 * DAY + i * HOUR, answered: false, settled: false
  }));
  st.lastOwnerReplyAt = T0 - HOUR; // 一小时前刚聊过
  const r = settleDeliveries(st, { now: T0 });
  assert.equal(r.newlyUnanswered, 3);
  assert.equal(r.paused, false);
  assert.equal(st.unansweredStreak, 3);
  assert.equal(effectiveIntervalMs(st), HARD_MIN_INTERVAL_MS * 2);
});

t('暂停中主人一说话就解除（他是理由本身）', () => {
  const st = readyState();
  st.silencedUntil = T0 + PAUSE_MS;
  const r = noteOwnerReply(st, { now: T0 + DAY });
  assert.equal(r.resumed, true);
  assert.equal(st.silencedUntil, 0);
  const d = canDeliver(st, { now: T0 + DAY, hour: 14 });
  assert.equal(d.ok, true);
});

t('暂停期内再 settle 不会把暂停延长', () => {
  const st = readyState();
  st.createdAt = T0 - 20 * DAY;
  st.silencedUntil = T0 + PAUSE_MS;
  st.unansweredStreak = 5;
  // 暂停还没到期（第一天）
  const r = settleDeliveries(st, { now: T0 + DAY });
  assert.equal(r.paused, false);
  assert.equal(st.silencedUntil, T0 + PAUSE_MS);
});

t('暂停到期后不会立刻再罚（streak 已清零）', () => {
  const st = readyState();
  st.createdAt = T0 - 40 * DAY;
  st.deliveries = [0, 1, 2].map((i) => ({
    id: `d${i}`, eventId: `e${i}`, at: T0 - 4 * DAY + i * HOUR, answered: false, settled: false
  }));
  st.lastOwnerReplyAt = T0 - 30 * DAY;
  settleDeliveries(st, { now: T0 }); // 第一次暂停，streak 归零
  assert.equal(st.unansweredStreak, 0);
  // 一周后再巡检：streak 是 0，不该再罚
  const again = settleDeliveries(st, { now: T0 + PAUSE_MS + HOUR });
  assert.equal(again.paused, false);
});

// ── 挑选 ────────────────────────────────────────────────
t('挑意愿×情绪强度最高的那条，同分取新的', () => {
  const st = fresh();
  addSignal(st, { eventId: 'a', summary: '平淡', valence: 0, sourceGroup: 'group:1', willingness: 0.2, now: T0 });
  addSignal(st, { eventId: 'b', summary: '很气', valence: -1, sourceGroup: 'group:1', willingness: 0.8, now: T0 + 1 });
  addSignal(st, { eventId: 'c', summary: '也一般', valence: 0.1, sourceGroup: 'group:1', willingness: 0.5, now: T0 + 2 });
  assert.equal(pickSignal(st).eventId, 'b');
});

t('pickSignal 空集合返回 null', () => {
  assert.equal(pickSignal(fresh()), null);
});

// ── 投递记账 ────────────────────────────────────────────
t('markDelivered 消信号、写历史、更新节流时间', () => {
  const st = readyState();
  const d = canDeliver(st, { now: T0, hour: 14 });
  const r = markDelivered(st, { signalId: d.signal.id, now: T0 });
  assert.equal(r.ok, true);
  assert.equal(st.signals.length, 0);
  assert.equal(st.deliveries.length, 1);
  assert.equal(st.lastDeliveredAt, T0);
  assert.ok(st.seenEventIds.includes('ev1'));
  assert.equal(st.deliveries[0].answered, false);
});

t('markDelivered 对不存在的信号返回失败', () => {
  const st = readyState();
  assert.equal(markDelivered(st, { signalId: 'nope', now: T0 }).reason, 'no-such-signal');
});

t('投递后立刻再问：被 cooldown 拦住（反向验证节流真的生效）', () => {
  const st = readyState();
  markDelivered(st, { signalId: canDeliver(st, { now: T0, hour: 14 }).signal.id, now: T0 });
  addSignal(st, { eventId: 'ev2', summary: '紧接着又来一件', valence: 0, sourceGroup: 'group:1', now: T0 });
  const r = canDeliver(st, { now: T0 + 1000, hour: 14 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cooldown');
});

// ── 容量与清理 ──────────────────────────────────────────
t(`信号超过 ${MAX_SIGNALS} 条时保留最新的`, () => {
  const st = fresh();
  for (let i = 0; i < MAX_SIGNALS + 5; i += 1) {
    addSignal(st, { eventId: `e${i}`, summary: `s${i}`, valence: 0, sourceGroup: 'group:1', now: T0 + i });
  }
  assert.equal(st.signals.length, MAX_SIGNALS);
  assert.equal(st.signals[st.signals.length - 1].eventId, `e${MAX_SIGNALS + 4}`);
});

t('pruneState 清掉超过 3 天的旧信号', () => {
  const st = fresh();
  addSignal(st, { eventId: 'old', summary: '旧闻', valence: 0, sourceGroup: 'group:1', now: T0 - 4 * DAY });
  addSignal(st, { eventId: 'new', summary: '新闻', valence: 0, sourceGroup: 'group:1', now: T0 });
  pruneState(st, { now: T0 });
  assert.deepEqual(st.signals.map((s) => s.eventId), ['new']);
});

// ── 损坏恢复 ────────────────────────────────────────────
t('空/垃圾输入归一化成默认状态', () => {
  assert.equal(normalizeState(null).signals.length, 0);
  assert.equal(normalizeState('garbage').signals.length, 0);
  assert.equal(normalizeState({ signals: 'not-array' }).signals.length, 0);
});

t('坏信号被丢弃，好信号保留', () => {
  const st = normalizeState({
    signals: [
      { eventId: 'ok', summary: '好的', sourceGroup: 'group:1', valence: 0.2 },
      { eventId: 'bad', summary: '私聊来的', sourceGroup: 'private:1' },
      { eventId: '', summary: '没 id', sourceGroup: 'group:1' }
    ]
  }, { now: T0 });
  assert.equal(st.signals.length, 1);
  assert.equal(st.signals[0].eventId, 'ok');
});

t('越界的 streak 归一化成非负整数', () => {
  assert.equal(normalizeState({ unansweredStreak: -5 }).unansweredStreak, 0);
  assert.equal(normalizeState({ unansweredStreak: 2.7 }).unansweredStreak, 2);
});

t('statsOf 暴露可观察的数字', () => {
  const st = readyState();
  const s = statsOf(st, { now: T0 });
  assert.equal(s.pendingSignals, 1);
  assert.equal(s.minIntervalMs, HARD_MIN_INTERVAL_MS);
  assert.equal(s.maxPerDay, HARD_MAX_PER_DAY);
  assert.deepEqual(s.quietHours, [23, 8]);
  assert.equal(s.pausedUntil, null);
});

// ── 落盘 IO ──────────────────────────────────────────────
t('save/load 往返：信号、策略、退避状态都不丢', () => {
  const file = path.join(tmpDir, 'roundtrip.json');
  const st = readyState();
  st.policy = setPolicy(st, { maxPerDay: 2 }).after;
  saveShareState(file, st);
  const back = loadShareState(file, { now: T0 });
  assert.equal(back.signals.length, 1);
  assert.equal(back.signals[0].eventId, 'ev1');
  assert.equal(back.signals[0].summary, '群里在吵一部新番好不好看');
  assert.equal(back.policy.maxPerDay, 2);
  assert.equal(back.lastDeliveredAt, 0);
});

t('投递记录里保留摘要（唤醒入队后还要靠它拼文案）', () => {
  const file = path.join(tmpDir, 'delivery-keeps-text.json');
  const st = readyState();
  const sig = st.signals[0];
  markDelivered(st, { signalId: sig.id, now: T0 });
  saveShareState(file, st);
  const back = loadShareState(file, { now: T0 });
  assert.equal(back.deliveries.length, 1);
  assert.equal(back.deliveries[0].summary, '群里在吵一部新番好不好看');
  assert.equal(back.deliveries[0].sourceGroup, 'group:906710082');
  assert.equal(back.deliveries[0].valence, 0.4);
  assert.equal(lastDelivery(back).eventId, 'ev1');
});

t('lastDelivery 空历史返回 null', () => {
  assert.equal(lastDelivery(fresh()), null);
});

t('文件不存在 → 空库，不抛错', () => {
  const file = path.join(tmpDir, 'nope-never-created.json');
  const st = loadShareState(file, { now: T0 });
  assert.equal(st.signals.length, 0);
  assert.equal(st.policy.minIntervalMs, HARD_MIN_INTERVAL_MS);
});

t('文件损坏 → 抛错（绝不当空库写回去）', () => {
  const file = path.join(tmpDir, 'broken.json');
  fs.writeFileSync(file, '{ this is not json');
  assert.throws(() => loadShareState(file, { now: T0 }));
});

t('落盘后权限是 600（POSIX 才验；Windows 上 mode 是模拟的，恒为 666）', () => {
  const file = path.join(tmpDir, 'perm.json');
  saveShareState(file, readyState());
  if (process.platform === 'win32') {
    // Windows 不实现 POSIX 权限位，fs.statSync 一律报 0o666。
    // 这里只确认文件确实写出来了，权限由部署端的 e2e 检查兜。
    assert.equal(fs.existsSync(file), true);
    return;
  }
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

t('load 丢掉坏信号、保留好信号', () => {
  const file = path.join(tmpDir, 'mixed.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    signals: [
      { id: 's1', eventId: 'ok', sourceGroup: 'group:123', summary: '好消息', createdAt: T0 },
      { id: 's2', eventId: '', sourceGroup: 'group:123', summary: '没 eventId' },
      { id: 's3', eventId: 'x', sourceGroup: 'private:999', summary: '私聊来源' }
    ]
  }));
  const st = loadShareState(file, { now: T0 });
  assert.equal(st.signals.length, 1);
  assert.equal(st.signals[0].eventId, 'ok');
});

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
