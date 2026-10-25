#!/usr/bin/env node
// 阶段20：把控制台巡检小族搬进 inspect 模块。
//
// 删四段老 if：
//   · GET  /api/socialV2/tool-log  + POST /api/socialV2/tool-log/clear    （原 L7360-7371）
//   · GET  /api/socialV2/feedback  + POST /api/socialV2/feedback-clear    （原 L7373-7383）
//   · GET  /api/socialV2/my-recent                                        （原 L7415-7426）
//   · GET  /api/socialV2/active-members                                   （原 L7594-7617）
// 注意 feedback 另有 POST /api/socialV2/feedback（L7384-7414）**不搬**，那是写接口，留给后面的族。
//
// 幂等：老 if 在就删，ctx 注入块按 MARKER 判重。
// 依赖：readToolLog / readFeedbackEntries / atomicWriteJson / TOOL_LOG_FILE / FEEDBACK_FILE 全是顶层，
// 直接引用即可；getSocialV2State / readThroughSeqV2 声明在注入点之后，包箭头。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FILE = path.join(ROOT, 'src/bridge.js');
const TMP = path.join(ROOT, 'src/.bridge-stage20.tmp.js');
const dryRun = process.argv.includes('--dry-run');

const MARK = '// MARKER: modules-ctx-inspect';
const HEADS = [
  { label: 'tool-log', head: "        if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') {" },
  { label: 'tool-log/clear', head: "        if (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') {" },
  { label: 'feedback GET', head: "        if (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') {" },
  { label: 'feedback-clear', head: "        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') {" },
  { label: 'my-recent', head: "        if (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') {" },
  { label: 'active-members', head: "        if (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') {" },
];

let source = fs.readFileSync(FILE, 'utf8');
const before = source;
const notes = [];

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
  let end = i;
  const rest = text.slice(end);
  const m = rest.match(/^\n(\s*)return;\n/);
  if (m) end += m[0].length;
  while (text[end] === '\n') end += 1;
  const removed = text.slice(ifIdx, end);
  return { text: text.slice(0, ifIdx) + text.slice(end), lines: removed.split('\n').length - 1 };
}

for (const { label, head } of HEADS) {
  const idx = source.indexOf(head);
  if (idx < 0) { notes.push(`${label}：老 if 块已不存在（幂等跳过）`); continue; }
  const res = cutBlock(source, idx);
  source = res.text;
  notes.push(`${label}：删除 ${res.lines} 行`);
}

// 清掉变空的章节注释（四段各自挂着一条「── 反馈 / 自己消息 / 消息详情 / 活跃成员 ──」类注释）
source = source.replace(/\n {8}\/\/ ── 反馈 \/ 自己消息 \/ 消息详情 \/ 活跃成员[^\n]*\n\s*\n(\s*)(if \(req\.method === 'POST' && url\.pathname === '\/api\/socialV2\/feedback'\))/, "\n$1$2");

if (!source.includes(MARK)) {
  const ANCHOR = '  let imageApprovalCache = null;';
  const at = source.indexOf(ANCHOR);
  if (at < 0) throw new Error('找不到 imageApprovalCache 声明，注入点定位失败');
  const insertAt = source.indexOf('\n', at) + 1;
  const block = `  ${MARK}
  // 阶段20：巡检小族的句柄。getSocialV2State / readThroughSeqV2 声明在注入点之后 ⇒ 包箭头。
  Object.assign(moduleCtx, {
    readToolLog: (limit) => readToolLog(limit),
    readFeedbackEntries: () => readFeedbackEntries(),
    toolLogFile: TOOL_LOG_FILE,
    feedbackFile: FEEDBACK_FILE,
    getSocialV2State: (key) => getSocialV2State(key),
    readThroughSeqV2: (st) => readThroughSeqV2(st),
  });
`;
  source = source.slice(0, insertAt) + block + source.slice(insertAt);
  notes.push('注入巡检句柄');
}

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
const backup = `${FILE}.bak-stage20-${stamp}`;
fs.copyFileSync(FILE, backup);
fs.writeFileSync(FILE, source, 'utf8');
console.log(`已写回 ${FILE}（备份 ${path.basename(backup)}）`);