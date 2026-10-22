// 生图审批接线的隔离副本验证。跑：node scripts/verify-image-approval-wire.mjs <bridge.js> <store.js>
//
// 目的：不启动整个桥接，只把接线层抽出来，配最小 shim 真跑一遍判定逻辑。
// 覆盖的都是「判错了会出事」的点：谁能申请、通知发到哪、重复申请会不会刷屏、
// 主人的「通过」会不会误吃别的话、代发边界守不守得住。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const BRIDGE = process.argv[2] || '/tmp/iav/bridge.js';
const STORE = process.argv[3] || '/tmp/iav/image-approval-store.js';
const SRC = fs.readFileSync(BRIDGE, 'utf8');

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

/**
 * 按大括号配对精确抽一个函数。
 *
 * 关键：先把**参数表的括号**配平，其后的第一个 `{` 才是函数体。
 * 直接把第一个 `{` 当函数体开头会踩到解构参数
 * （`persistXxx(store, { a, b } = {})`），抽出来只有参数表 → SyntaxError。
 */
function extractFn(source, name) {
  const patterns = [`function ${name}(`, `async function ${name}(`, `const ${name} = (`, `const ${name} = async (`];
  let start = -1;
  let sig = '';
  for (const p of patterns) {
    const i = source.indexOf(p);
    if (i >= 0 && (start < 0 || i < start)) { start = i; sig = p; }
  }
  if (start < 0) throw new Error(`找不到函数 ${name}`);

  // 1) 配平参数表 ( ... )
  let i = source.indexOf('(', start);
  let depth = 0;
  for (; i < source.length; i += 1) {
    const c = source[i];
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  // 2) 找参数表之后的第一个 { —— 但要跳过 `= (` 这种「const f = (a) => {」中间的箭头和返回类型。
  //    从 ) 之后开始扫，遇到 { 就是函数体。
  let bodyStart = -1;
  let d2 = 0;
  for (let j = i; j < source.length; j += 1) {
    const c = source[j];
    if (c === '{') { bodyStart = j; break; }
    if (c === '(') d2 += 1;
    if (c === ')') d2 -= 1;
    if (c === ';' && d2 === 0) break;
  }
  if (bodyStart < 0) throw new Error(`找不到 ${name} 的函数体`);

  // 3) 从 bodyStart 配平到收尾
  let d = 0;
  let end = bodyStart;
  for (; end < source.length; end += 1) {
    const c = source[end];
    if (c === '{') d += 1;
    else if (c === '}') { d -= 1; if (d === 0) { end += 1; break; } }
  }
  return source.slice(start, end);
}

// ── 拼 harness ────────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iav-h-'));
const stateDir = path.join(dir, 'state');
fs.mkdirSync(stateDir, { recursive: true });

// store：去掉 export 前缀，末尾补一条 export 列表
let storeSrc = fs.readFileSync(STORE, 'utf8');
const exported = [];
storeSrc = storeSrc.replace(/^export (const|function|async function) (\w+)/gm, (_m, kind, name) => {
  exported.push(name);
  return `${kind} ${name}`;
});
storeSrc += `\nexport { ${exported.join(', ')} };\n`;
const storePath = path.join(dir, 'store.mjs');
fs.writeFileSync(storePath, storeSrc);

const FNS = [
  'loadImageApprovalOrNull', 'getImageApprovalState', 'appendImageApprovalAudit',
  'persistImageApproval', 'imageApprovalOwnerKey', 'imageApprovalEligible',
  'imageApprovalRequesterName', 'sendPlainToQQ', 'notifyOwnerImageRequest',
  'requestImageApproval', 'commitApprovedImageApproval',
  'tryConsumeImageApprovalReply', 'ownerDelegateTokenOk'
];
const bodies = FNS.map((n) => extractFn(SRC, n)).join('\n\n');

const harness = `
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  createApproval as createImageApproval, approveApproval as approveImageApproval,
  rejectApproval as rejectImageApproval, pickPendingToDecide as pickImageApprovalToDecide,
  listPending as listPendingImageApprovals, pendingCount as pendingImageApprovalCount,
  expireStale as expireStaleImageApprovals, statsOf as imageApprovalStatsOf,
  loadApprovalState as loadImageApprovalState, saveApprovalState as saveImageApprovalState,
  createDefaultState as createDefaultImageApprovalState,
  APPROVAL_TTL_MS as IMAGE_APPROVAL_TTL_MS, MAX_PROMPT_CHARS as IMAGE_APPROVAL_MAX_PROMPT
} from ${JSON.stringify(pathToFileURL(storePath).href)};

const STATE_DIR = ${JSON.stringify(stateDir)};
const IMAGE_APPROVAL_FILE = path.join(STATE_DIR, 'image-approval.json');
const IMAGE_APPROVAL_AUDIT_FILE = path.join(STATE_DIR, 'image-approval-audit.jsonl');
const APPROVE_WORDS = new Set(['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
const REJECT_WORDS = new Set(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'reject', 'deny']);

const logs = [];
function log(...a) { logs.push(a.join(' ')); }

let cfg = { ownerQQ: '1124721191' };
let selfUserId = '2157801858';
let friendSetReady = true;
let friendSet = new Set(['3414115838', '2050117833', '2275396596']);
let allowPrivate = ['1124721191', '2050117833', '2275396596'];
function allowed(kind, id, c) {
  if (kind !== 'private') return false;
  return allowPrivate.map(String).includes(String(id));
}
function canonicalV2Key(key) {
  const m = /^(group|private):(\\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return m[1] + ':' + id;
}

const sent = [];
async function onebotSend(kind, id, message, replyTo, atUser, images) {
  sent.push({ key: kind + ':' + id, message: String(message ?? ''), images: Array.isArray(images) ? images.slice() : [] });
}
let imageResult = { path: '/tmp/fake.png' };
let imageShouldThrow = false;
async function generateImageNow({ prompt, size }) {
  if (imageShouldThrow) throw new Error('生图接口炸了');
  return { ...imageResult, prompt, size };
}

const socialV2 = { conversations: new Map() };
// 主人私聊会话，令牌 "OWNERTOKEN"
socialV2.conversations.set('private:1124721191', { agentToken: 'OWNERTOKEN', recentMessages: [] });
// 好友私聊会话
socialV2.conversations.set('private:3414115838', {
  agentToken: 'FRIENDTOKEN',
  recentMessages: [{ sender: '我', text: 'x' }, { sender: '云息玉衡下', text: 'y' }]
});

let imageApprovalCache = null;

${bodies}

const setImageResult = (v) => { imageResult = v; };
const setImageThrow = (v) => { imageShouldThrow = v; };
const resetCache = () => { imageApprovalCache = null; };
const getCache = () => imageApprovalCache;
// ESM 的导出绑定只读，改状态必须走 setter。
const setAllowPrivate = (v) => { allowPrivate = v; };
const setFriendSet = (v) => { friendSet = new Set(v); };
const setFriendSetReady = (v) => { friendSetReady = v; };
const setSelfUserId = (v) => { selfUserId = v; };

export {
  cfg, socialV2, logs, sent,
  setImageResult, setImageThrow, resetCache, getCache,
  setAllowPrivate, setFriendSet, setFriendSetReady, setSelfUserId,
  IMAGE_APPROVAL_FILE, IMAGE_APPROVAL_AUDIT_FILE,
  imageApprovalOwnerKey, imageApprovalEligible, imageApprovalRequesterName,
  sendPlainToQQ, notifyOwnerImageRequest, requestImageApproval,
  commitApprovedImageApproval, tryConsumeImageApprovalReply, ownerDelegateTokenOk,
  createImageApproval, approveImageApproval, rejectImageApproval,
  pickImageApprovalToDecide, pendingImageApprovalCount, expireStaleImageApprovals,
  loadImageApprovalState, saveImageApprovalState, createDefaultImageApprovalState,
  IMAGE_APPROVAL_TTL_MS
};
`;
const harnessPath = path.join(dir, 'harness.mjs');
fs.writeFileSync(harnessPath, harness);

const H = await import(pathToFileURL(harnessPath).href);
const T0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const reset = () => {
  H.resetCache();
  H.sent.length = 0;
  H.logs.length = 0;
  H.setImageThrow(false);
  H.setImageResult({ path: '/tmp/fake.png' });
  try { fs.unlinkSync(H.IMAGE_APPROVAL_FILE); } catch { /* 没有就算了 */ }
  try { fs.unlinkSync(H.IMAGE_APPROVAL_AUDIT_FILE); } catch { /* 同上 */ }
};

// ── 1. 出口恒主人私聊 ─────────────────────────────────────────────────────
ok(H.imageApprovalOwnerKey() === 'private:1124721191', '审批通知出口恒主人私聊');
H.cfg.ownerQQ = '';
ok(H.imageApprovalOwnerKey() === null, '没配 ownerQQ 返回 null');
H.cfg.ownerQQ = '1124721191';

// ── 2. 谁有资格申请 ───────────────────────────────────────────────────────
// 3414115838 是好友，但不在 allow.private 里 -> 准入不过，不能申请。
ok(H.imageApprovalEligible('private:3414115838') === false, '不在准入白名单里的好友不能申请');
H.setAllowPrivate(['1124721191', '2050117833', '2275396596', '3414115838']);
ok(H.imageApprovalEligible('private:3414115838') === true, '白名单放开后好友可申请');
ok(H.imageApprovalEligible('private:1124721191') === false, '主人自己不走审批');
ok(H.imageApprovalEligible('private:2157801858') === false, '她自己不走审批');
ok(H.imageApprovalEligible('group:906710082') === false, '群聊不走审批');
ok(H.imageApprovalEligible('private:9999999999') === false, '非好友不走审批');
H.setFriendSetReady(false);
ok(H.imageApprovalEligible('private:3414115838') === false, '好友表没就绪时 fail-closed');
H.setFriendSetReady(true);
ok(H.imageApprovalEligible('private:bad') === false, '非法 key 拒绝');

// ── 3. 申请人昵称 ─────────────────────────────────────────────────────────
ok(H.imageApprovalRequesterName('3414115838') === '云息玉衡下', '昵称从 recentMessages 取');
ok(H.imageApprovalRequesterName('9999999999') === '9999999999', '拿不到昵称退回号码');

// ── 4. 申请 → 通知主人 ────────────────────────────────────────────────────
reset();
const r1 = H.requestImageApproval('private:3414115838', '画一只鲸鱼娘在吃米饭', '1024x1024');
ok(r1.ok === true, '申请成功');
ok(!!r1.approval?.id, '申请有 id');
ok(r1.reused === false, '首次不是复用');
await sleep(30);
ok(H.sent.length === 1, '通知发了 1 条', `实得 ${H.sent.length}`);
ok(H.sent[0].key === 'private:1124721191', '通知发给主人私聊');
ok(H.sent[0].message.includes('有人想要图'), '通知含标题');
ok(H.sent[0].message.includes('云息玉衡下'), '通知含申请人昵称');
ok(H.sent[0].message.includes('画一只鲸鱼娘在吃米饭'), '通知含 prompt');
ok(H.sent[0].message.includes('通过'), '通知说明怎么批');

// ── 5. 重复申请不刷屏 ─────────────────────────────────────────────────────
H.sent.length = 0;
const r2 = H.requestImageApproval('private:3414115838', '画一只鲸鱼娘在吃米饭', '');
ok(r2.reused === true, '同 prompt 复用');
ok(r2.approval.id === r1.approval.id, '复用同一条 id');
await sleep(30);
ok(H.sent.length === 0, '复用不再通知主人', `实得 ${H.sent.length}`);

H.sent.length = 0;
const r3 = H.requestImageApproval('private:3414115838', '画一只猫', '');
ok(r3.reused === false, '不同 prompt 新开一条');
ok(r3.approval.id !== r1.approval.id, '新 id');
await sleep(30);
ok(H.sent.length === 1, '新申请再通知一次');

// ── 6. 主人回「通过」 ─────────────────────────────────────────────────────
reset();
const a1 = H.requestImageApproval('private:3414115838', '画鲸鱼', '');
await sleep(30);
H.sent.length = 0;
const consumed = H.tryConsumeImageApprovalReply('private:1124721191', '通过');
ok(consumed === true, '主人「通过」被审批消费');
ok(H.sent.some((s) => s.message.includes('开始画')), '回执告诉主人开始画');
await sleep(60);
ok(H.sent.some((s) => s.key === 'private:3414115838' && s.images.length === 1), '图发给了申请的好友');
ok(H.sent.some((s) => s.message.includes('已经画好')), '通知主人画好了');

// ── 7. 非主人 / 群里 / 无待审 不消费 ──────────────────────────────────────
ok(H.tryConsumeImageApprovalReply('private:2050117833', '通过') === false, '好友说「通过」不消费');
ok(H.tryConsumeImageApprovalReply('group:906710082', '通过') === false, '群里说「通过」不消费');
reset();
ok(H.tryConsumeImageApprovalReply('private:1124721191', '通过') === false, '没有待审时不消费（主人平时说通过不受影响）');
ok(H.tryConsumeImageApprovalReply('private:1124721191', '今天吃米饭') === false, '无关的话不消费');

// ── 8. 主人回「拒绝」 ─────────────────────────────────────────────────────
reset();
H.requestImageApproval('private:3414115838', '画鲸鱼', '');
await sleep(30);
H.sent.length = 0;
ok(H.tryConsumeImageApprovalReply('private:1124721191', '拒绝') === true, '主人「拒绝」被消费');
await sleep(60);
ok(!H.sent.some((s) => s.key === 'private:3414115838'), '拒绝后不发图');
ok(H.sent.some((s) => s.message.includes('不画了')), '告诉主人不画了');

// ── 9. 指定编号 ───────────────────────────────────────────────────────────
reset();
const b1 = H.requestImageApproval('private:3414115838', '第一张', '');
await sleep(10);
const b2 = H.requestImageApproval('private:2050117833', '第二张', '');
await sleep(30);
H.sent.length = 0;
H.tryConsumeImageApprovalReply('private:1124721191', `通过 ${b1.approval.id}`);
await sleep(60);
ok(H.sent.some((s) => s.key === 'private:3414115838' && s.images.length === 1), '按编号指定第一张（发给 3414115838）');
ok(!H.sent.some((s) => s.key === 'private:2050117833' && s.images.length === 1), '第二张没被动');

// ── 10. 不指定编号取最新 ──────────────────────────────────────────────────
reset();
H.requestImageApproval('private:3414115838', '旧', '');
await sleep(10);
H.requestImageApproval('private:2050117833', '新', '');
await sleep(30);
H.sent.length = 0;
H.tryConsumeImageApprovalReply('private:1124721191', '通过');
await sleep(60);
ok(H.sent.some((s) => s.key === 'private:2050117833' && s.images.length === 1), '不指定时取最新那条');

// ── 11. 出图失败要把话讲明 ────────────────────────────────────────────────
reset();
H.requestImageApproval('private:3414115838', '画鲸鱼', '');
await sleep(30);
H.setImageThrow(true);
H.sent.length = 0;
H.tryConsumeImageApprovalReply('private:1124721191', '通过');
await sleep(80);
ok(H.sent.some((s) => s.message.includes('出图失败')), '出图失败时通知主人');
ok(!H.sent.some((s) => s.key === 'private:3414115838' && s.images.length === 1), '失败不发图');

// ── 12. 审计落盘 ──────────────────────────────────────────────────────────
reset();
H.requestImageApproval('private:3414115838', '画鲸鱼', '');
await sleep(20);
const auditRaw = fs.existsSync(H.IMAGE_APPROVAL_AUDIT_FILE) ? fs.readFileSync(H.IMAGE_APPROVAL_AUDIT_FILE, 'utf8') : '';
const auditLines = auditRaw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
ok(auditLines.some((l) => l.action === 'request'), '审计记了 request');
ok(auditLines.some((l) => l.action === 'notify'), '审计记了 notify');
if (process.platform !== 'win32') {
  ok((fs.statSync(H.IMAGE_APPROVAL_AUDIT_FILE).mode & 0o777) === 0o600, '审计文件权限 600');
} else {
  ok(fs.existsSync(H.IMAGE_APPROVAL_AUDIT_FILE), '审计文件存在（Windows 不查权限）');
}

// ── 13. 持久化：重启后还能读到 ────────────────────────────────────────────
reset();
const p1 = H.requestImageApproval('private:3414115838', '画鲸鱼', '');
await sleep(20);
const stRaw = JSON.parse(fs.readFileSync(H.IMAGE_APPROVAL_FILE, 'utf8'));
ok(stRaw.approvals.length === 1, '申请已落盘');
ok(stRaw.approvals[0].prompt === '画鲸鱼', '落盘内容正确');
H.resetCache();
const reloaded = H.loadImageApprovalState(H.IMAGE_APPROVAL_FILE);
ok(H.pendingImageApprovalCount(reloaded) === 1, '重启后仍能看到待审');
if (process.platform !== 'win32') {
  ok((fs.statSync(H.IMAGE_APPROVAL_FILE).mode & 0o777) === 0o600, '审批文件权限 600');
}

// ── 14. 过期 ──────────────────────────────────────────────────────────────
reset();
const e1 = H.createImageApproval(H.createDefaultImageApprovalState(), {
  key: 'private:3414115838', prompt: '要过期', now: T0
}).approval;
const stE = H.createDefaultImageApprovalState();
stE.approvals.push({ ...e1, createdAt: T0 - H.IMAGE_APPROVAL_TTL_MS - 1000 });
H.saveImageApprovalState(H.IMAGE_APPROVAL_FILE, stE);
H.resetCache();
H.requestImageApproval('private:2050117833', '新的', '');
await sleep(20);
const stAfter = JSON.parse(fs.readFileSync(H.IMAGE_APPROVAL_FILE, 'utf8'));
ok(stAfter.approvals.find((a) => a.id === e1.id)?.status === 'expired', '过期的被标成 expired');

// ── 15. 代发：主人令牌 → 好友私聊 ─────────────────────────────────────────
H.setAllowPrivate(['1124721191', '2050117833', '2275396596', '3414115838']);
H.setFriendSet(['3414115838', '2050117833']);
H.setFriendSetReady(true);
ok(H.ownerDelegateTokenOk('private:3414115838', 'OWNERTOKEN') === true, '主人令牌可代发到好友私聊');

// 边界：拒绝的每一种都要真拒
ok(H.ownerDelegateTokenOk('private:3414115838', 'FRIENDTOKEN') === false, '好友自己的令牌不算主人代发');
ok(H.ownerDelegateTokenOk('private:3414115838', 'WRONG') === false, '错令牌拒绝');
ok(H.ownerDelegateTokenOk('private:3414115838', '') === false, '空令牌拒绝');
ok(H.ownerDelegateTokenOk('private:3414115838', null) === false, 'null 令牌拒绝');
ok(H.ownerDelegateTokenOk('group:906710082', 'OWNERTOKEN') === false, '不能代发到群');
ok(H.ownerDelegateTokenOk('private:1124721191', 'OWNERTOKEN') === false, '不能代发给自己');
ok(H.ownerDelegateTokenOk('private:2157801858', 'OWNERTOKEN') === false, '不能代发给她自己');
ok(H.ownerDelegateTokenOk('private:9999999999', 'OWNERTOKEN') === false, '非好友不能代发');
ok(H.ownerDelegateTokenOk('bad:key', 'OWNERTOKEN') === false, '非法 key 拒绝');
H.setFriendSet(['2050117833']);
ok(H.ownerDelegateTokenOk('private:3414115838', 'OWNERTOKEN') === false, '不在好友表里拒绝');
H.setFriendSet(['3414115838']);
H.setAllowPrivate(['1124721191']);
ok(H.ownerDelegateTokenOk('private:3414115838', 'OWNERTOKEN') === false, '准入白名单没过拒绝');
H.setAllowPrivate(['1124721191', '3414115838']);
// 主人会话没有 token
const savedToken = H.socialV2.conversations.get('private:1124721191').agentToken;
H.socialV2.conversations.get('private:1124721191').agentToken = '';
ok(H.ownerDelegateTokenOk('private:3414115838', 'OWNERTOKEN') === false, '主人会话没令牌时拒绝');
H.socialV2.conversations.get('private:1124721191').agentToken = savedToken;
// 主人会话不存在
H.socialV2.conversations.delete('private:1124721191');
ok(H.ownerDelegateTokenOk('private:3414115838', 'OWNERTOKEN') === false, '主人会话不存在时拒绝');
H.socialV2.conversations.set('private:1124721191', { agentToken: 'OWNERTOKEN', recentMessages: [] });

// ── 16. 容量上限 ──────────────────────────────────────────────────────────
reset();
H.setAllowPrivate(['1124721191', '2050117833', '2275396596', '3414115838', '1', '2', '3', '4', '5']);
for (let i = 0; i < 5; i += 1) H.requestImageApproval(`private:${1000 + i}`, `第${i}张`, '');
await sleep(20);
const over = H.requestImageApproval('private:3414115838', '超了', '');
ok(over.ok === false, '超上限拒绝');
ok(over.error.includes('太多'), '拒绝理由讲人话');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
