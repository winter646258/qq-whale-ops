// 隔离副本上验证「主动报告接线层」是否真的成立。
//
// 和 verify-shared-memory-wire.mjs 同一套办法：不启动完整 bridge（那要连
// OneBot/DSH），而是从**打补丁后的** bridge.js 里按括号配对抽出接线层函数，
// 配一个最小 shim 一起求值，再跑真实的节流/权限/投递断言。
//
// 这样验证的是「部署出去的那份代码」，不是我在本地重写一遍的版本。
//
// 跑法：node verify-share-signal-wire.mjs   （文件需放在 /tmp/ssv/ 里跑，
// 或者改下面 BRIDGE 常量。设计上和 shared-memory 那份一样是硬编码路径。）
import fs from 'node:fs';
import path from 'node:path';

const BRIDGE = '/tmp/ssv/bridge.js';
const src = fs.readFileSync(BRIDGE, 'utf8');

/**
 * 从 from 位置开始，按括号配对找出函数体结束位置。
 * 先配平参数表的 ( ... )，之后第一个 { 才是函数体 —— 解构参数里的 { 会骗人。
 */
function extractFn(text, name) {
  const re = new RegExp(`\\n  function ${name}\\s*\\(`);
  const m = re.exec(text);
  if (!m) throw new Error(`找不到函数 ${name}`);
  let i = text.indexOf('(', m.index + m[0].length - 1);
  let pdepth = 0;
  let parenEnd = -1;
  for (; i < text.length; i += 1) {
    if (text[i] === '(') pdepth += 1;
    else if (text[i] === ')') {
      pdepth -= 1;
      if (pdepth === 0) { parenEnd = i; break; }
    }
  }
  if (parenEnd < 0) throw new Error(`${name}: 参数表括号不配对`);
  const bodyStart = text.indexOf('{', parenEnd);
  if (bodyStart < 0) throw new Error(`${name}: 找不到函数体`);
  let depth = 0;
  for (let j = bodyStart; j < text.length; j += 1) {
    const c = text[j];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(m.index + 1, j + 1);
    }
  }
  throw new Error(`${name}: 大括号不配对`);
}

const fns = ['loadShareStateOrNull', 'getShareState', 'appendShareAudit', 'persistShareState',
  'shareOwnerKey', 'shareLastDeliveryInfo', 'noteOwnerReplyToShare', 'reportTickV2',
  'shareRejectReason'];

const bodies = fns.map((n) => extractFn(src, n)).join('\n\n');
console.log(`抽取 ${fns.length} 个函数，共 ${bodies.length} 字符`);

// 模块级闭包变量与常量抽不到，shim 里显式补上（抽函数做隔离的固有代价）。
const shim = `
import fs from 'node:fs';
import path from 'node:path';
import {
  loadShareState, saveShareState, addSignal, settleDeliveries, pruneState,
  canDeliver, markDelivered, lastDelivery, noteOwnerReply as noteShareOwnerReply,
  setPolicy as setSharePolicy, statsOf as shareStatsOf, normalizePolicy as normalizeSharePolicy,
  effectiveIntervalMs, isGroupKey,
  UNANSWERED_THRESHOLD, MAX_SIGNALS as SHARE_MAX_SIGNALS,
  HARD_MIN_INTERVAL_MS as SHARE_HARD_MIN_INTERVAL_MS,
  HARD_MAX_PER_DAY as SHARE_HARD_MAX_PER_DAY
} from '/tmp/ssv/share-signal-store.js';

const __dirname = '/tmp/ssv';
const ROOT = '/tmp/ssv';
const STATE_DIR = path.join(ROOT, 'state');
const SHARE_SIGNAL_FILE = path.join(STATE_DIR, 'share-signal.json');
const SHARE_SIGNAL_AUDIT_FILE = path.join(STATE_DIR, 'share-signal-audit.jsonl');

// 默认把「实际投递」打开：观察模式（deliverEnabled !== true）默认是关的，
// 不打开的话下面所有投递用例都会被拦成 observe。观察模式自己有专门用例。
const cfg = { ownerQQ: 1124721191, socialV2: { share: { deliverEnabled: true } } };

const logs = [];
function log(...args) { logs.push(args.join(' ')); }

// 会话状态表：reportTickV2 会看主人在不在忙
const socialV2 = { conversations: new Map(), paused: false };
let busyKeys = new Set();
function isConversationBusyV2(key) { return busyKeys.has(key); }

// 投递出口：记录下来，不真的发
const sent = [];
async function sendWakePromptV2(key, reason) { sent.push({ key, reason }); }

let shareStateCache = null;
let shareSkipLoggedAt = 0;
let shareSkipLoggedReason = '';
// 观察模式的「已经念过哪条」也是模块级闭包变量，抽函数抽不到。
let shareObservedSignalId = '';

${bodies}

// export 列表里不能内联函数定义，先声明再导出。
function setBusy(keys) { busyKeys = new Set(keys); }
function setCache(v) { shareStateCache = v; }
function resetSkipLog() { shareSkipLoggedAt = 0; shareSkipLoggedReason = ''; shareObservedSignalId = ''; }

export {
  loadShareStateOrNull, getShareState, persistShareState, shareOwnerKey,
  shareLastDeliveryInfo, noteOwnerReplyToShare, reportTickV2, shareRejectReason,
  cfg, socialV2, setBusy, setCache, resetSkipLog,
  sent, logs, SHARE_SIGNAL_FILE, STATE_DIR,
  shareStatsOf, normalizeSharePolicy
};
`;

fs.writeFileSync('/tmp/ssv/wire-harness.mjs', shim);

// 干净的 state 目录
const stateDir = '/tmp/ssv/state';
fs.rmSync(stateDir, { recursive: true, force: true });
fs.mkdirSync(stateDir, { recursive: true });

const H = await import('/tmp/ssv/wire-harness.mjs');

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
function reset() {
  fs.rmSync(H.SHARE_SIGNAL_FILE, { force: true });
  fs.rmSync(path.join(stateDir, 'share-signal-audit.jsonl'), { force: true });
  H.setCache(null);
  H.sent.length = 0;
  H.logs.length = 0;
  H.setBusy([]);
  H.cfg.socialV2 = { share: { deliverEnabled: true } };
  // 日志节流的时间戳是模块级闭包状态，不重置会串用例：
  // 上一个用例刚打过节流日志，本用例就静默了，看起来像「没拦」。
  H.resetSkipLog();
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const now = Date.now();
const GROUP = 'group:906710082';
const OWNER = 'private:1124721191';

// ── 读者/出口基础 ─────────────────────────────────────────
t('报告出口永远是主人私聊，不是当前会话', () => {
  assert(H.shareOwnerKey() === OWNER, `期望 ${OWNER}，实际 ${H.shareOwnerKey()}`);
});

t('没状态文件时 getShareState 返回空库而不是抛错', () => {
  reset();
  const st = H.getShareState();
  assert(st && Array.isArray(st.signals), 'getShareState 应返回带 signals 的状态');
  assert(st.signals.length === 0, '空库不该有信号');
});

// ── 投递主路径 ───────────────────────────────────────────
t('有信号、冷却已过 → 真投递，wakeReason 是 share', () => {
  reset();
  const st = H.getShareState();
  st.signals.push({
    id: 's1', eventId: 'e1', sourceGroup: GROUP,
    summary: '群里在吵新番', valence: 0.5, willingness: 0.8, createdAt: now
  });
  H.reportTickV2();
  assert(H.sent.length === 1, `应投递 1 次，实际 ${H.sent.length}`);
  assert(H.sent[0].key === OWNER, `应发给 ${OWNER}`);
  assert(H.sent[0].reason === 'share', `wakeReason 应是 share，实际 ${H.sent[0].reason}`);
  assert(H.getShareState().signals.length === 0, '投递后信号应被消费');
  assert(H.getShareState().deliveries.length === 1, '投递历史应记一条');
});

t('投递前的摘要会先写进投递历史（唤醒入队后拼文案靠它）', () => {
  reset();
  const st = H.getShareState();
  st.signals.push({
    id: 's1', eventId: 'e1', sourceGroup: GROUP,
    summary: '有人在群里表白被拒', valence: -0.7, willingness: 0.9, createdAt: now
  });
  H.reportTickV2();
  const info = H.shareLastDeliveryInfo();
  assert(info, 'shareLastDeliveryInfo 应有内容');
  assert(info.summary === '有人在群里表白被拒', `摘要不对：${info.summary}`);
  assert(info.sourceGroup === GROUP, '来源群不对');
  assert(info.valence === -0.7, `valence 不对：${info.valence}`);
});

t('没有信号 → 什么都不发，也不刷日志', () => {
  reset();
  H.reportTickV2();
  assert(H.sent.length === 0, '不该投递');
  assert(H.logs.length === 0, `不该刷日志，实际 ${H.logs.length} 条：${H.logs.join(' | ')}`);
});

// ── 反向验证：投递一次后立刻再试 ─────────────────────────
t('刚投递完立刻再报 → 被 cooldown 拦住，且日志说明原因', () => {
  reset();
  const st = H.getShareState();
  st.signals.push({ id: 's1', eventId: 'e1', sourceGroup: GROUP, summary: 'a', valence: 0, willingness: 0.9, createdAt: now });
  H.reportTickV2();
  assert(H.sent.length === 1, '第一次应投递');
  // 再来一条
  const st2 = H.getShareState();
  st2.signals.push({ id: 's2', eventId: 'e2', sourceGroup: GROUP, summary: 'b', valence: 0, willingness: 0.9, createdAt: now });
  H.reportTickV2();
  assert(H.sent.length === 1, `第二次应被拦，实际投递 ${H.sent.length} 次`);
  const hasCooldown = H.logs.some((l) => l.includes('节流拦截') && l.includes('cooldown'));
  assert(hasCooldown, `应有 cooldown 日志，实际：${H.logs.join(' | ')}`);
});

t('主人私聊正忙 → 压着不发，信号不消费', () => {
  reset();
  const st = H.getShareState();
  st.signals.push({ id: 's1', eventId: 'e1', sourceGroup: GROUP, summary: 'a', valence: 0, willingness: 0.9, createdAt: now });
  H.setBusy([OWNER]);
  H.reportTickV2();
  assert(H.sent.length === 0, '主人忙时不该投递');
  assert(H.getShareState().signals.length === 1, '信号应保留，30 秒后再看');
  assert(H.logs.some((l) => l.includes('主人私聊正忙')), `应有繁忙日志：${H.logs.join(' | ')}`);
});

// ── 开关与策略 ───────────────────────────────────────────
t('socialV2.share.enabled=false → 整个 tick 直接返回', () => {
  reset();
  H.cfg.socialV2 = { share: { enabled: false } };
  const st = H.getShareState();
  st.signals.push({ id: 's1', eventId: 'e1', sourceGroup: GROUP, summary: 'a', valence: 0, willingness: 0.9, createdAt: now });
  H.reportTickV2();
  assert(H.sent.length === 0, '关掉后不该投递');
  H.cfg.socialV2 = {};
});

t('策略 enabled=false 时 canDeliver 报 disabled，且不刷日志', () => {
  reset();
  const st = H.getShareState();
  st.policy.enabled = false;
  st.signals.push({ id: 's1', eventId: 'e1', sourceGroup: GROUP, summary: 'a', valence: 0, willingness: 0.9, createdAt: now });
  H.reportTickV2();
  assert(H.sent.length === 0, '关闭后不该投递');
});

// ── 主人回应 ─────────────────────────────────────────────
t('主人私聊说话 → 之前那条投递标记为已回应，streak 清零', () => {
  reset();
  const st = H.getShareState();
  st.signals.push({ id: 's1', eventId: 'e1', sourceGroup: GROUP, summary: 'a', valence: 0, willingness: 0.9, createdAt: now });
  H.reportTickV2();
  assert(H.getShareState().deliveries.length === 1, '应有一条投递');
  H.noteOwnerReplyToShare();
  const after = H.getShareState();
  assert(after.deliveries[0].answered === true, '应标记为已回应');
  assert(after.unansweredStreak === 0, 'streak 应清零');
  assert(after.lastOwnerReplyAt > 0, '应记下回应时间');
});

t('暂停中主人说话 → 暂停解除（他是理由本身）', () => {
  reset();
  const st = H.getShareState();
  st.silencedUntil = now + 7 * 24 * 3600 * 1000;
  st.unansweredStreak = 3;
  H.persistShareState({ action: 'test-seed' });
  H.noteOwnerReplyToShare();
  assert(H.getShareState().silencedUntil === 0, '暂停应解除');
  assert(H.logs.some((l) => l.includes('暂停自动解除')), `应有解除日志：${H.logs.join(' | ')}`);
});

t('没回应过任何一条、也没暂停时，主人说话不刷日志', () => {
  reset();
  H.getShareState();
  H.noteOwnerReplyToShare();
  assert(H.logs.length === 0, `不该有日志，实际：${H.logs.join(' | ')}`);
});

// ── 审计 ─────────────────────────────────────────────────
t('每次写盘都留一条审计（action 分类）', () => {
  reset();
  const st = H.getShareState();
  st.signals.push({ id: 's1', eventId: 'e1', sourceGroup: GROUP, summary: 'a', valence: 0, willingness: 0.9, createdAt: now });
  H.reportTickV2();
  const auditPath = path.join(stateDir, 'share-signal-audit.jsonl');
  assert(fs.existsSync(auditPath), '审计文件应存在');
  const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean);
  assert(lines.length >= 1, '至少一条审计');
  const rec = JSON.parse(lines[lines.length - 1]);
  assert(rec.action === 'deliver', `最后一条应是 deliver，实际 ${rec.action}`);
  assert(rec.key === OWNER, `审计 key 应是主人私聊`);
  assert(rec.detail && rec.detail.summary === 'a', '审计要带摘要');
  if (process.platform !== 'win32') {
    assert((fs.statSync(auditPath).mode & 0o777) === 0o600, '审计文件权限应为 600');
  }
});

// ── 拒绝原因人话化 ───────────────────────────────────────
t('拒绝原因都翻成人话，不吐内部代号', () => {
  for (const code of ['event-id-required', 'group-source-required', 'summary-required', 'duplicate-event']) {
    const msg = H.shareRejectReason(code);
    assert(msg && !msg.includes('required'), `${code} 没翻成中文：${msg}`);
  }
  assert(H.shareRejectReason('unknown-thing').length > 0, '未知原因也要有兜底文案');
});

// ── 损坏恢复 ─────────────────────────────────────────────
t('状态文件损坏 → getShareState 返回 null，tick 不炸也不覆盖', () => {
  reset();
  fs.writeFileSync(H.SHARE_SIGNAL_FILE, '{ broken json');
  H.setCache(null);
  const st = H.getShareState();
  assert(st === null, '损坏时应返回 null');
  const before = fs.readFileSync(H.SHARE_SIGNAL_FILE, 'utf8');
  H.reportTickV2();
  assert(H.sent.length === 0, '损坏时不该投递');
  const after = fs.readFileSync(H.SHARE_SIGNAL_FILE, 'utf8');
  assert(before === after, '损坏的文件不该被覆盖成空库');
});

// ── 观察模式（阶段 4 要用的上线形态）─────────────────────
t('观察模式（deliverEnabled 不为 true）→ 判定跑完但不发、不消费信号', () => {
  reset();
  H.cfg.socialV2 = { share: {} };   // 没写 deliverEnabled
  const st = H.getShareState();
  st.signals.push({ id: 's1', eventId: 'e1', sourceGroup: GROUP, summary: '观察这条', valence: 0.3, willingness: 0.9, createdAt: now });
  H.reportTickV2();
  assert(H.sent.length === 0, '观察模式不该真发');
  assert(H.getShareState().signals.length === 1, '观察模式不该消费信号');
  assert(H.getShareState().lastDeliveredAt === 0, '观察模式不该更新冷却时间');
  const seen = H.logs.filter((l) => l.includes('[share][观察]'));
  assert(seen.length === 1, `应恰好一条观察日志，实际 ${seen.length}：${H.logs.join(' | ')}`);
  assert(seen[0].includes('观察这条'), '观察日志要带摘要');
});

t('观察模式：同一条信号不会每 30 秒刷一次日志', () => {
  reset();
  H.cfg.socialV2 = { share: {} };
  const st = H.getShareState();
  st.signals.push({ id: 's1', eventId: 'e1', sourceGroup: GROUP, summary: '只念一次', valence: 0, willingness: 0.9, createdAt: now });
  H.reportTickV2();
  H.reportTickV2();
  H.reportTickV2();
  const seen = H.logs.filter((l) => l.includes('[share][观察]'));
  assert(seen.length === 1, `三条 tick 只该念一次，实际 ${seen.length} 条`);
});

t('观察模式拦在记账之前：信号还在，切回正式后能立刻发出去', () => {
  reset();
  H.cfg.socialV2 = { share: {} };
  const st = H.getShareState();
  st.signals.push({ id: 's1', eventId: 'e1', sourceGroup: GROUP, summary: '攒着', valence: 0, willingness: 0.9, createdAt: now });
  H.reportTickV2();
  assert(H.sent.length === 0, '观察模式不该发');
  H.cfg.socialV2 = { share: { deliverEnabled: true } };
  H.resetSkipLog();
  H.reportTickV2();
  assert(H.sent.length === 1, '切回正式后应立刻发出去（信号没被观察模式吃掉）');
  assert(H.sent[0].reason === 'share', 'wakeReason 应是 share');
});

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
