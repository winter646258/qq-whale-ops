// 生图审批纯逻辑单测。跑：node scripts/test-image-approval.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  APPROVAL_TTL_MS, MAX_PENDING, MAX_HISTORY, MAX_PROMPT_CHARS,
  normalizeKey, createDefaultState, normalizeState, expireStale, listPending,
  pendingCount, createApproval, approveApproval, rejectApproval,
  pickPendingToDecide, statsOf, loadApprovalState, saveApprovalState
} from '../src/image-approval-store.js';

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};
const eq = (a, b, name) => ok(Object.is(a, b), name, `期望 ${JSON.stringify(b)} 实得 ${JSON.stringify(a)}`);

const T0 = Date.parse('2026-10-22T14:00:00+08:00');
const MIN = 60 * 1000;

// ---- normalizeKey ----
eq(normalizeKey('private:3414115838'), 'private:3414115838', 'normalizeKey 私聊');
eq(normalizeKey('group:906710082'), 'group:906710082', 'normalizeKey 群');
eq(normalizeKey('  private:3414115838  '), 'private:3414115838', 'normalizeKey 去空白');
eq(normalizeKey('private:0003414115838'), 'private:3414115838', 'normalizeKey 去前导零');
eq(normalizeKey('private:0'), null, 'normalizeKey 0 拒绝');
eq(normalizeKey('private:-1'), null, 'normalizeKey 负数拒绝');
eq(normalizeKey('foo:123'), null, 'normalizeKey 前缀拒绝');
eq(normalizeKey(''), null, 'normalizeKey 空拒绝');
eq(normalizeKey(null), null, 'normalizeKey null 拒绝');
eq(normalizeKey('private:99999999999999999999'), null, 'normalizeKey 超 safe int 拒绝');

// ---- createDefaultState / normalizeState ----
const d = createDefaultState(T0);
eq(d.version, 1, '默认版本号');
eq(d.approvals.length, 0, '默认空列表');
eq(d.seq, 0, '默认 seq 0');

ok(normalizeState(null, T0).approvals.length === 0, 'normalizeState null → 空库');
ok(normalizeState([], T0).approvals.length === 0, 'normalizeState 数组 → 空库');
ok(normalizeState('x', T0).approvals.length === 0, 'normalizeState 字符串 → 空库');

const dirty = normalizeState({
  seq: 3,
  approvals: [
    { id: 'a1', key: 'private:3414115838', prompt: '画只鲸鱼', status: 'pending', createdAt: T0 },
    { id: 'a1', key: 'private:3414115838', prompt: '重复 id', status: 'pending', createdAt: T0 },
    { id: 'a2', key: 'bad-key', prompt: '坏 key', status: 'pending', createdAt: T0 },
    { id: 'a3', key: 'group:906710082', prompt: '', status: 'pending', createdAt: T0 },
    { id: 'a4', key: 'private:2050117833', prompt: '没状态的', createdAt: T0 },
    { id: 'a5', key: 'private:2050117833', prompt: '疯状态', status: 'wat', createdAt: T0 }
  ]
}, T0);
eq(dirty.approvals.length, 3, 'normalizeState 坏条目丢弃好条目保留');
ok(dirty.approvals.every((a) => a.id !== 'a1' || a.prompt === '画只鲸鱼'), '重复 id 只留第一条');
ok(dirty.approvals.find((a) => a.id === 'a4').status === 'expired', '缺 state 视为 expired');
ok(dirty.approvals.find((a) => a.id === 'a5').status === 'expired', '非法 state 视为 expired');

const longPrompt = 'x'.repeat(MAX_PROMPT_CHARS + 500);
const trimmed = normalizeState({ approvals: [{ id: 'b1', key: 'private:1', prompt: longPrompt, status: 'approved', createdAt: T0 }] }, T0);
eq(trimmed.approvals[0].prompt.length, MAX_PROMPT_CHARS, 'prompt 截到上限');

// ---- createApproval ----
const st = createDefaultState(T0);
const r1 = createApproval(st, { key: 'private:3414115838', requesterName: '云息玉衡下', prompt: '画只鲸鱼', size: '1024x1024', now: T0 });
ok(r1.approval && r1.reason === '', 'createApproval 成功');
eq(r1.reused, false, 'createApproval 首次不复用');
eq(r1.approval.status, 'pending', '新申请是 pending');
eq(st.approvals.length, 1, '落进列表');
eq(pendingCount(st, T0), 1, 'pendingCount 1');

const r1b = createApproval(st, { key: 'private:3414115838', requesterName: '云息玉衡下', prompt: '画只鲸鱼', now: T0 + 30 * 1000 });
ok(r1b.reused === true, '同 key 同 prompt 复用');
eq(r1b.approval.id, r1.approval.id, '复用同一条 id');
eq(st.approvals.length, 1, '复用不新增');
eq(r1b.approval.createdAt, T0 + 30 * 1000, '复用刷新 createdAt');

const r2 = createApproval(st, { key: 'private:3414115838', prompt: '画只猫', now: T0 });
ok(r2.approval && r2.approval.id !== r1.approval.id, '同 key 不同 prompt 新开一条');
eq(st.approvals.length, 2, '两条并存');

const rbad = createApproval(st, { key: 'private:bad', prompt: 'x', now: T0 });
eq(rbad.reason, 'bad-key', 'createApproval 坏 key 拒绝');
const rnone = createApproval(st, { key: 'private:3414115838', prompt: '   ', now: T0 });
eq(rnone.reason, 'no-prompt', 'createApproval 空 prompt 拒绝');

// 上限
const stFull = createDefaultState(T0);
for (let i = 0; i < MAX_PENDING; i += 1) {
  createApproval(stFull, { key: `private:${1000 + i}`, prompt: `第${i}张`, now: T0 });
}
eq(pendingCount(stFull, T0), MAX_PENDING, '装满上限');
const overflow = createApproval(stFull, { key: 'private:9999', prompt: '超了', now: T0 });
eq(overflow.reason, 'too-many-pending', '超上限拒绝');
eq(pendingCount(stFull, T0), MAX_PENDING, '超上限不挤掉旧的');

// ---- 过期 ----
const stExp = createDefaultState(T0);
const e1 = createApproval(stExp, { key: 'private:3414115838', prompt: '要过期', now: T0 }).approval;
eq(listPending(stExp, T0 + APPROVAL_TTL_MS - 1000).length, 1, '差一秒还活着');
eq(listPending(stExp, T0 + APPROVAL_TTL_MS).length, 0, '正好到点就死');
const expiredIds = expireStale(stExp, T0 + APPROVAL_TTL_MS);
ok(expiredIds.includes(e1.id), 'expireStale 返回变化的 id');
eq(stExp.approvals[0].status, 'expired', '过期标成 expired');
eq(expireStale(stExp, T0 + APPROVAL_TTL_MS + 1000).length, 0, 'expireStale 幂等');

// ---- 审批 ----
const stA = createDefaultState(T0);
const ap = createApproval(stA, { key: 'private:3414115838', prompt: '画只鲸鱼', now: T0 }).approval;
const okA = approveApproval(stA, ap.id, T0 + MIN);
ok(okA.ok, 'approve 成功');
eq(okA.approval.status, 'approved', 'approve 状态');
const againA = approveApproval(stA, ap.id, T0 + 2 * MIN);
eq(againA.reason, 'already-approved', '重复 approve 拒绝');
eq(rejectApproval(stA, ap.id, T0).reason, 'already-approved', 'approve 后不能 reject');
eq(approveApproval(stA, 'nope', T0).reason, 'not-found', '不存在的 id');

const stR = createDefaultState(T0);
const rp = createApproval(stR, { key: 'private:3414115838', prompt: '画只鲸鱼', now: T0 }).approval;
eq(rejectApproval(stR, rp.id, T0 + MIN).approval.status, 'rejected', 'reject 状态');

const stLate = createDefaultState(T0);
const lp = createApproval(stLate, { key: 'private:3414115838', prompt: '太晚了', now: T0 }).approval;
const lateRes = approveApproval(stLate, lp.id, T0 + APPROVAL_TTL_MS + 1);
eq(lateRes.reason, 'expired', '过期后 approve 变 expired');
eq(lateRes.approval.status, 'expired', '过期后状态是 expired 不是 approved');

// ---- pickPendingToDecide ----
const stP = createDefaultState(T0);
const p1 = createApproval(stP, { key: 'private:1', prompt: '甲', now: T0 }).approval;
const p2 = createApproval(stP, { key: 'private:2', prompt: '乙', now: T0 + MIN }).approval;
const p3 = createApproval(stP, { key: 'private:1', prompt: '丙', now: T0 + 2 * MIN }).approval;
eq(pickPendingToDecide(stP, { key: 'private:1', now: T0 + 3 * MIN }).id, p3.id, '同 key 取最新那条');
eq(pickPendingToDecide(stP, { id: p1.id, now: T0 + 3 * MIN }).id, p1.id, '指定 id 优先');
eq(pickPendingToDecide(stP, { key: 'private:999', now: T0 + 3 * MIN }), null, '没人挂起返回 null');
eq(pickPendingToDecide(stP, { now: T0 + 3 * MIN }).id, p3.id, '不给 key 取全局最新');
eq(pickPendingToDecide(stP, { key: 'private:2', now: T0 + APPROVAL_TTL_MS }).id, p2.id, '边界前还能选到');

// ---- 历史裁剪 ----
const stH = createDefaultState(T0);
for (let i = 0; i < MAX_HISTORY + 20; i += 1) {
  const a = createApproval(stH, { key: `private:${2000 + i}`, prompt: `历史${i}`, now: T0 + i }).approval;
  approveApproval(stH, a.id, T0 + i);
}
eq(stH.approvals.length, MAX_HISTORY, '终态只留 MAX_HISTORY 条');
const stHP = createDefaultState(T0);
for (let i = 0; i < 3; i += 1) createApproval(stHP, { key: `private:${3000 + i}`, prompt: `活跃${i}`, now: T0 + i });
for (let i = 0; i < MAX_HISTORY + 10; i += 1) {
  const a = createApproval(stHP, { key: `private:${4000 + i}`, prompt: `历史${i}`, now: T0 + 10 + i }).approval;
  rejectApproval(stHP, a.id, T0 + 10 + i);
}
eq(listPending(stHP, T0 + 99).length, 3, '裁剪时 pending 永不删');

// ---- statsOf ----
const stS = createDefaultState(T0);
createApproval(stS, { key: 'private:1', prompt: '甲', now: T0 });
const s2 = createApproval(stS, { key: 'private:2', prompt: '乙', now: T0 }).approval;
approveApproval(stS, s2.id, T0 + 1);
const s3 = createApproval(stS, { key: 'private:3', prompt: '丙', now: T0 }).approval;
rejectApproval(stS, s3.id, T0 + 1);
createApproval(stS, { key: 'private:4', prompt: '丁', now: T0 });
const stats = statsOf(stS, T0 + APPROVAL_TTL_MS);
eq(stats.pending, 0, 'stats pending（全过期）');
eq(stats.approved, 1, 'stats approved');
eq(stats.rejected, 1, 'stats rejected');
eq(stats.expired, 2, 'stats expired（含被 expireStale 挪过去的）');
eq(stats.ttlMs, APPROVAL_TTL_MS, 'stats 带 ttl');

// ---- 安全：__proto__ / constructor 不能污染 ----
const stProto = createDefaultState(T0);
const protoRes = createApproval(stProto, { key: 'private:1', prompt: '__proto__' });
ok(protoRes.approval && protoRes.approval.prompt === '__proto__', '__proto__ 当普通文本');
ok({}.polluted === undefined, '原型没被污染');
const ctorRes = createApproval(stProto, { key: 'private:2', prompt: 'constructor' });
ok(ctorRes.approval && ctorRes.approval.prompt === 'constructor', 'constructor 当普通文本');

// ---- IO ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-'));
const file = path.join(dir, 'image-approval.json');
const empty = loadApprovalState(file, { now: T0 });
eq(empty.approvals.length, 0, '文件不存在 → 空库');

const stW = createDefaultState(T0);
createApproval(stW, { key: 'private:3414115838', requesterName: '云息玉衡下', prompt: '画只鲸鱼', size: '1024x1024', now: T0 });
saveApprovalState(file, stW);
const back = loadApprovalState(file, { now: T0 });
eq(back.approvals.length, 1, '往返保留条数');
eq(back.approvals[0].prompt, '画只鲸鱼', '往返保留 prompt');
eq(back.approvals[0].requesterName, '云息玉衡下', '往返保留昵称');
if (process.platform !== 'win32') {
  eq(fs.statSync(file).mode & 0o777, 0o600, '落盘权限 600');
} else {
  ok(fs.existsSync(file), '落盘存在（Windows 不查权限）');
}

fs.writeFileSync(file, '{ 坏 json');
let threw = false;
try { loadApprovalState(file, { now: T0 }); } catch { threw = true; }
ok(threw, '损坏文件抛错而不是当空库');

fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
const nested = path.join(dir, 'sub', 'deep', 'x.json');
saveApprovalState(nested, createDefaultState(T0));
ok(fs.existsSync(nested), '目录自动创建');

// 并发落盘不互相踩（tmp 名字带 pid + 时间）
const stC = createDefaultState(T0);
createApproval(stC, { key: 'private:1', prompt: 'a', now: T0 });
saveApprovalState(file, stC);
saveApprovalState(file, stC);
eq(loadApprovalState(file, { now: T0 }).approvals.length, 1, '重复落盘不出错');

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
