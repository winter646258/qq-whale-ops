// 生图审批：好友私聊想要图 → 先问主人 → 主人点头才画。
//
// 为什么需要这一层：
//   生图是要花钱的（一张约 $0.01），而且画的是「她」这个角色。原来的闸门
//   （imageSceneFor）只认两种场景：主人私聊、主人在群里 @ 她。其他好友私聊
//   一律拒绝 —— 因为「谁都能喊一声就让她花钱画图」不可接受。
//
//   但拒绝太死：好友真的想要一张图时，她连转达都做不到。所以中间加一道
//   人工闸门：好友要图 → 她记一条申请、通知主人 → 主人说「通过」才真画。
//
// 设计边界（都写在代码里，别靠记忆）：
//   - 一条申请只对一个 (key, prompt) 生效。同一个好友用同一句话催两次，不重复
//     登记，也不重复通知主人（否则刷屏）；催的时候把 createdAt 刷新，等于续期。
//   - 不同 prompt 允许并存，但有总数上限。好友可以换着说法要十张图，主人
//     不该收到十条申请。
//   - 过期就是过期，不自动重发。10 分钟没人理，那张图就不画了 —— 但会在
//     状态里留痕，主人事后能看到「谁要过图、我没批」。
//   - 审批结果只有三种终态：approved / rejected / expired。没有「部分通过」。
//
// 这个模块是纯逻辑（除了最后两个 IO 函数），不碰网络、不碰 QQ、不碰 bridge。

import fs from 'node:fs';
import path from 'node:path';

export const IMAGE_APPROVAL_VERSION = 1;

/** 同时最多挂几个待审申请。超了就拒新的，不排队。 */
export const MAX_PENDING = 5;

/** 一条申请等主人多久。10 分钟没表态就当没戏。 */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

/** prompt 上限，和 /api/socialV2/image 端点的校验保持一致。 */
export const MAX_PROMPT_CHARS = 2000;

/** 终态记录保留多少条（只用于事后回看，不参与判定）。 */
export const MAX_HISTORY = 50;

export const STATUSES = ['pending', 'approved', 'rejected', 'expired'];

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 只认 private:正整数 / group:正整数，其余返回 null。 */
export function normalizeKey(key) {
  const m = /^(group|private):(\d+)$/.exec(str(key));
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

function trimPrompt(prompt) {
  const s = typeof prompt === 'string' ? prompt : String(prompt ?? '');
  return s.length > MAX_PROMPT_CHARS ? s.slice(0, MAX_PROMPT_CHARS) : s;
}

function newId(seq, now) {
  // 时间前缀 + 序号：日志里一眼能看出先后，也不怕重启后 seq 归零撞名。
  const stamp = Number(now).toString(36).slice(-5);
  return `ia${stamp}${Number(seq).toString(36)}`;
}

export function createDefaultState(now = Date.now()) {
  return {
    version: IMAGE_APPROVAL_VERSION,
    seq: 0,
    approvals: [],
    createdAt: Number(now) || Date.now(),
    updatedAt: Number(now) || Date.now()
  };
}

/**
 * 把外部读进来的东西修成可信状态。
 *
 * 原则：坏条目丢、好条目留，别因为一条烂数据把整份历史抹掉 —— 主人事后
 * 回看「谁要过图」靠的就是这份历史。
 */
export function normalizeState(raw, now = Date.now()) {
  const nowMs = Number(now) || Date.now();
  const base = createDefaultState(nowMs);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;

  const list = Array.isArray(raw.approvals) ? raw.approvals : [];
  const seen = new Set();
  const approvals = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const key = normalizeKey(item.key);
    if (!key) continue;
    const id = str(item.id);
    if (!id || seen.has(id)) continue;
    const status = STATUSES.includes(item.status) ? item.status : 'expired';
    const prompt = trimPrompt(item.prompt);
    if (!prompt) continue;
    seen.add(id);
    approvals.push({
      id,
      key,
      requesterName: str(item.requesterName).slice(0, 40),
      prompt,
      size: str(item.size).slice(0, 16),
      status,
      createdAt: num(item.createdAt) || nowMs,
      decidedAt: num(item.decidedAt) || 0
    });
  }
  // 新的在前；历史只留最近 MAX_HISTORY 条终态。
  approvals.sort((a, b) => b.createdAt - a.createdAt);
  const pending = approvals.filter((a) => a.status === 'pending');
  const settled = approvals.filter((a) => a.status !== 'pending').slice(0, MAX_HISTORY);
  return {
    version: IMAGE_APPROVAL_VERSION,
    seq: num(raw.seq),
    approvals: [...pending, ...settled],
    createdAt: num(raw.createdAt) || nowMs,
    updatedAt: num(raw.updatedAt) || nowMs
  };
}

/** 一条申请是否还活着（pending 且没过期）。 */
function alive(a, now) {
  return a && a.status === 'pending' && Number(now) - a.createdAt < APPROVAL_TTL_MS;
}

/** 列出当前真正待审的（顺手把过期挪成 expired，返回变化的 id）。 */
export function expireStale(state, now = Date.now()) {
  const nowMs = Number(now) || Date.now();
  const expired = [];
  for (const a of state.approvals) {
    if (a.status === 'pending' && nowMs - a.createdAt >= APPROVAL_TTL_MS) {
      a.status = 'expired';
      a.decidedAt = nowMs;
      expired.push(a.id);
    }
  }
  if (expired.length) state.updatedAt = nowMs;
  return expired;
}

export function listPending(state, now = Date.now()) {
  const nowMs = Number(now) || Date.now();
  return state.approvals.filter((a) => alive(a, nowMs));
}

export function pendingCount(state, now = Date.now()) {
  return listPending(state, now).length;
}

/**
 * 登记一条申请。
 *
 * 返回 { approval, reused, reason }：
 *   reused=true  同一个好友用同一句话又在催，续期而不是新开一条
 *   reason       拒绝原因（'bad-key' / 'no-prompt' / 'too-many-pending'），成功时为空
 */
export function createApproval(state, { key, requesterName = '', prompt, size = '', now = Date.now() } = {}) {
  const nowMs = Number(now) || Date.now();
  const k = normalizeKey(key);
  if (!k) return { approval: null, reused: false, reason: 'bad-key' };
  const p = trimPrompt(prompt);
  if (!p.trim()) return { approval: null, reused: false, reason: 'no-prompt' };

  expireStale(state, nowMs);

  // 同一好友 + 同一句话：续期，不重复通知主人。
  const same = state.approvals.find((a) => a.key === k && a.prompt === p && alive(a, nowMs));
  if (same) {
    same.createdAt = nowMs;
    state.updatedAt = nowMs;
    return { approval: same, reused: true, reason: '' };
  }

  const pending = listPending(state, nowMs);
  if (pending.length >= MAX_PENDING) {
    return { approval: null, reused: false, reason: 'too-many-pending' };
  }

  state.seq = num(state.seq) + 1;
  const approval = {
    id: newId(state.seq, nowMs),
    key: k,
    requesterName: str(requesterName).slice(0, 40),
    prompt: p,
    size: str(size).slice(0, 16),
    status: 'pending',
    createdAt: nowMs,
    decidedAt: 0
  };
  state.approvals.unshift(approval);
  trimHistory(state);
  state.updatedAt = nowMs;
  return { approval, reused: false, reason: '' };
}

/**
 * 历史裁剪：终态只留最近 MAX_HISTORY 条，pending 永不裁。
 *
 * 登记后和审批后都要跑 —— 只在登记时裁，最后一条批完就会多出一条
 * （第 51 条永远留着，直到下一条申请进来才被挤掉）。
 */
function trimHistory(state) {
  const keepPending = state.approvals.filter((a) => a.status === 'pending');
  const keepSettled = state.approvals.filter((a) => a.status !== 'pending').slice(0, MAX_HISTORY);
  state.approvals = [...keepPending, ...keepSettled];
}

function decide(state, id, status, now) {
  const nowMs = Number(now) || Date.now();
  const a = state.approvals.find((x) => x.id === str(id));
  if (!a) return { ok: false, reason: 'not-found', approval: null };
  if (a.status !== 'pending') return { ok: false, reason: `already-${a.status}`, approval: a };
  if (nowMs - a.createdAt >= APPROVAL_TTL_MS) {
    a.status = 'expired';
    a.decidedAt = nowMs;
    state.updatedAt = nowMs;
    return { ok: false, reason: 'expired', approval: a };
  }
  a.status = status;
  a.decidedAt = nowMs;
  trimHistory(state);
  state.updatedAt = nowMs;
  return { ok: true, reason: '', approval: a };
}

export function approveApproval(state, id, now = Date.now()) {
  return decide(state, id, 'approved', now);
}

export function rejectApproval(state, id, now = Date.now()) {
  return decide(state, id, 'rejected', now);
}

/**
 * 主人回一句「通过」/「拒绝」时，找出这句话对应的是哪一条。
 *
 * 只按 key 找：主人私聊里挂着好几条时，他说的「通过」指的是**最新那条**。
 * 想指定某一条时用 id（qq_image_approval 工具能列出 id）。
 */
export function pickPendingToDecide(state, { key = '', id = '', now = Date.now() } = {}) {
  const nowMs = Number(now) || Date.now();
  expireStale(state, nowMs);
  if (id) {
    const a = state.approvals.find((x) => x.id === str(id));
    return alive(a, nowMs) ? a : null;
  }
  const k = normalizeKey(key);
  const pool = k ? listPending(state, nowMs).filter((a) => a.key === k) : listPending(state, nowMs);
  // 最新申请优先。
  return pool.slice().sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
}

export function statsOf(state, now = Date.now()) {
  const nowMs = Number(now) || Date.now();
  expireStale(state, nowMs);
  const counts = { pending: 0, approved: 0, rejected: 0, expired: 0 };
  for (const a of state.approvals) {
    if (counts[a.status] !== undefined) counts[a.status] += 1;
  }
  return {
    ...counts,
    ttlMs: APPROVAL_TTL_MS,
    maxPending: MAX_PENDING,
    // 注意别叫 pending —— 上面 spread 进来的 pending 是计数，同名会被覆盖成
    // 数组，于是 `stats.pending === 0` 永远为假（这个坑踩过一次）。
    pendingItems: listPending(state, nowMs).map((a) => ({
      id: a.id, key: a.key, requesterName: a.requesterName, prompt: a.prompt, size: a.size, createdAt: a.createdAt
    }))
  };
}

export function loadApprovalState(file, { now = Date.now() } = {}) {
  const nowMs = Number(now) || Date.now();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return createDefaultState(nowMs);
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`生图审批状态文件损坏（${path.basename(file)}）：${error?.message ?? error}`);
  }
  return normalizeState(parsed, nowMs);
}

export function saveApprovalState(file, state) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 清不掉就算了，别盖住真错误 */ }
    throw error;
  }
}
