#!/usr/bin/env node
// 阶段19：把记忆读写五条路由搬进 memory 模块。
//
// 幂等：老 if 在就删，ctx 注入块按 MARKER 判重。
// 依赖里 getSocialV2State(L9910) / formatMemoryV2(L10200) / saveSocialV2State(L10103) /
// appendMemoryV2(L10232) 都声明在注入点之后 ⇒ 一律包箭头；
// redactKnownTokensOnly(L8592) 也在注入点之后，同样包箭头。
//
// 注意：rejectV2/handler 里用 this.ctx，registry 用 `.call({ ...def, ctx })` 调用，
// 所以 this 上是模块定义对象 —— this.ctx 能取到，别在模块顶层缓存 ctx 快照。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FILE = path.join(ROOT, 'src/bridge.js');
const TMP = path.join(ROOT, 'src/.bridge-stage19.tmp.js');
const dryRun = process.argv.includes('--dry-run');

const MARK = '// MARKER: modules-ctx-memory';
const HEADS = [
  { label: 'memory-append', head: "        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {" },
  { label: 'memory-update', head: "        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-update') {" },
  { label: 'memory-GET', head: "        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {" },
  { label: 'memory-remove', head: "        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remove') {" },
  { label: 'memory-clear', head: "        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-clear') {" },
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

if (!source.includes(MARK)) {
  const ANCHOR = '  let imageApprovalCache = null;';
  const at = source.indexOf(ANCHOR);
  if (at < 0) throw new Error('找不到 imageApprovalCache 声明，注入点定位失败');
  const insertAt = source.indexOf('\n', at) + 1;
  const block = `  ${MARK}
  // 阶段19：记忆读写模块要用的句柄。五个函数全部声明在注入点之后 ⇒ 只能包箭头，
  // 绝不能直接放进对象字面量的值位置（那会立即求值并撞上 TDZ）。
  Object.assign(moduleCtx, {
    redactKnownTokensOnly: (text) => redactKnownTokensOnly(text),
    getSocialV2State: (key) => getSocialV2State(key),
    appendMemoryV2: (st, category, content, extra) => appendMemoryV2(st, category, content, extra),
    formatMemoryV2: (st) => formatMemoryV2(st),
    saveSocialV2State: () => saveSocialV2State(),
  });
`;
  source = source.slice(0, insertAt) + block + source.slice(insertAt);
  notes.push('注入记忆句柄');
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
const backup = `${FILE}.bak-stage19-${stamp}`;
fs.copyFileSync(FILE, backup);
fs.writeFileSync(FILE, source, 'utf8');
console.log(`已写回 ${FILE}（备份 ${path.basename(backup)}）`);