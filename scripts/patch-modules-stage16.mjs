#!/usr/bin/env node
// 阶段16：把生图/审批/画像三条路由搬进 image 模块。
//
// 幂等：每个删除块先看老 if 在不在，在就整块删；ctx 注入块用 MARKER 判重。
// 顺序：删三块 → 注入 ctx → node --check → 备份 → 写回。
//
// 三条路由的性格不一样，删的时候按「整块」删，不要按行挑选：
//   · /api/socialV2/self-image  —— 简单读文件，块内无嵌套 if
//   · /api/socialV2/image       —— 内含审批转申请与限流，块很长
//   · /api/socialV2/image-approval —— 内含 console-only 闸门
//
// 用法：
//   node scripts/patch-modules-stage16.mjs            # 应用
//   node scripts/patch-modules-stage16.mjs --dry-run  # 只看会改什么
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FILE = path.join(ROOT, 'src/bridge.js');
const TMP = path.join(ROOT, 'src/.bridge-stage16.tmp.js');
const dryRun = process.argv.includes('--dry-run');

const MARK = '// MARKER: modules-ctx-image';

const HEADS = [
  { label: 'self-image', head: "        if (req.method === 'GET' && url.pathname === '/api/socialV2/self-image') {" },
  { label: 'image', head: "        if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/socialV2/image') {" },
  { label: 'image-approval', head: "        if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/socialV2/image-approval') {" },
];

let source = fs.readFileSync(FILE, 'utf8');
const before = source;
const notes = [];

// ── 块级删除：从 if 行开始，按大括号配平找到收尾，连带紧跟的 return; 一起删 ──
function cutBlock(text, ifIdx) {
  const braceStart = text.indexOf('{', ifIdx);
  let depth = 0;
  let i = braceStart;
  let inStr = null;
  let inTpl = false;
  for (; i < text.length; i += 1) {
    const c = text[i];
    const prev = text[i - 1];
    if (inStr) { if (c === inStr && prev !== '\\') inStr = null; continue; }
    if (inTpl) { if (c === '`' && prev !== '\\') inTpl = false; continue; }
    if (c === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); if (nl < 0) break; i = nl; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '`') { inTpl = true; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  // 吃掉 `}` 之后的换行与紧跟的 `return;`（老代码每个路由块都以 return 收尾）
  let end = i;
  const rest = text.slice(end);
  const m = rest.match(/^\n(\s*)return;\n/);
  if (m) end += m[0].length;
  while (text[end] === '\n') end += 1;
  let start = ifIdx;
  // 起点往上吃掉仅属于这条路由的注释行（行首 // 且不含「──」章节分隔符以外的内容）
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const prevLineEnd = lineStart - 1;
  if (prevLineEnd > 0) {
    const prevLineStart = text.lastIndexOf('\n', prevLineEnd - 1) + 1;
    const prevLine = text.slice(prevLineStart, prevLineEnd);
    if (/^\s*\/\/\s*(MARKER|生图|生图审批)/.test(prevLine)) start = prevLineStart;
  }
  const removed = text.slice(start, end);
  return { text: text.slice(0, start) + text.slice(end), lines: removed.split('\n').length - 1 };
}

for (const { label, head } of HEADS) {
  const idx = source.indexOf(head);
  if (idx < 0) { notes.push(`${label}：老 if 块已不存在（幂等跳过）`); continue; }
  const res = cutBlock(source, idx);
  source = res.text;
  notes.push(`${label}：删除 ${res.lines} 行`);
}

// ── ctx 注入 ────────────────────────────────────────────────────────
// 锚点选 `let imageApprovalCache = null;` 之后：这几个名字（imageLastStartAt /
// IMAGE_THROTTLE_MS / imageApprovalEligible / requestImageApproval /
// getImageApprovalState / approve/reject/persist/commit）都在它附近或之后，
// 一律用箭头函数包一层，绝不在对象字面量里立即求值。
if (!source.includes(MARK)) {
  const ANCHOR = '  let imageApprovalCache = null;';
  const at = source.indexOf(ANCHOR);
  if (at < 0) throw new Error('找不到 imageApprovalCache 声明，注入点定位失败');
  let insertAt = source.indexOf('\n', at) + 1;
  const block = `  ${MARK}
  // 阶段16：生图/审批/画像搬进 image 模块后要用的句柄。
  // imageAllowedNow(L10013) / generateImageNow(L10055) 比这里晚得多，必须包闭包；
  // imageLastStartAt 是 Map（引用不变）但给访问器，免得以后改成重新赋值时踩空。
  Object.assign(moduleCtx, {
    imageHelpers: {
      agentTokenOkOrOwnerDelegate: (key, token) => agentTokenOkOrOwnerDelegate(key, token),
      imageAllowedNow: (key) => imageAllowedNow(key),
      imageApprovalEligible: (key) => imageApprovalEligible(key),
      requestImageApproval: (key, prompt, size) => requestImageApproval(key, prompt, size),
      getImageApprovalState: () => getImageApprovalState(),
      imageApprovalStatsOf: (st) => imageApprovalStatsOf(st),
      approveImageApproval: (st, id) => approveImageApproval(st, id),
      rejectImageApproval: (st, id) => rejectImageApproval(st, id),
      persistImageApproval: (action, detail) => persistImageApproval(action, detail),
      commitApprovedImageApproval: (approval) => commitApprovedImageApproval(approval),
      generateImageNow: (opts) => generateImageNow(opts),
      onebotSend: (kind, id, message, replyToMessageId, atUserId, images) =>
        onebotSend(kind, id, message, replyToMessageId, atUserId, images),
      throttleMs: () => IMAGE_THROTTLE_MS,
      lastStartAt: (key) => imageLastStartAt.get(key),
      markStart: (key) => imageLastStartAt.set(key, Date.now()),
      maxPromptChars: () => IMAGE_APPROVAL_MAX_PROMPT,
      ttlMs: () => IMAGE_APPROVAL_TTL_MS,
    },
  });
`;
  source = source.slice(0, insertAt) + block + source.slice(insertAt);
  notes.push('注入 imageHelpers');
}

// ── 落盘 ────────────────────────────────────────────────────────────
if (source === before) {
  console.log('无变化（已应用过）');
  for (const n of notes) console.log(`  · ${n}`);
  process.exit(0);
}

fs.writeFileSync(TMP, source, 'utf8');
try {
  execFileSync(process.execPath, ['--check', TMP], { stdio: 'pipe' });
} catch (error) {
  fs.unlinkSync(TMP);
  console.error('语法检查失败，未改动线上文件：');
  console.error(String(error.stderr || error.message));
  process.exit(1);
}
fs.unlinkSync(TMP);

for (const n of notes) console.log(`  · ${n}`);
console.log(`  · 行数 ${before.split('\n').length} → ${source.split('\n').length}`);

if (dryRun) {
  console.log('--dry-run：未写回');
  process.exit(0);
}
const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
const backup = `${FILE}.bak-stage16-${stamp}`;
fs.copyFileSync(FILE, backup);
fs.writeFileSync(FILE, source, 'utf8');
console.log(`已写回 ${FILE}（备份 ${path.basename(backup)}）`);
