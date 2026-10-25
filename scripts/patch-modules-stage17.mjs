#!/usr/bin/env node
// 阶段17：把白名单可视化编辑 /api/whitelist 两条路由搬进 whitelist 模块。
//
// 幂等：老 if 在就删，ctx 注入块按 MARKER 判重。
// 这一族只依赖顶层函数（readConfigObject L268 / atomicWriteJson L299 /
// normalizeOwnerQQ L755 是顶层声明，reconcileSessionPolicies L3451 是 main 内声明
// 且早于注入点），所以直交引用即可，只有 cfg 需要热更新 —— cfg 是对象，引用不变。
//
// 用法：
//   node scripts/patch-modules-stage17.mjs            # 应用
//   node scripts/patch-modules-stage17.mjs --dry-run  # 只看会改什么
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FILE = path.join(ROOT, 'src/bridge.js');
const TMP = path.join(ROOT, 'src/.bridge-stage17.tmp.js');
const dryRun = process.argv.includes('--dry-run');

const MARK = '// MARKER: modules-ctx-whitelist';
const HEADS = [
  { label: 'whitelist-GET', head: "        if (req.method === 'GET' && url.pathname === '/api/whitelist') {" },
  { label: 'whitelist-POST', head: "        if (req.method === 'POST' && url.pathname === '/api/whitelist') {" },
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

// 顺手清掉紧邻上方那条已经空掉的章节注释（与 whitelist 紧挨着的）
const staleComment = '        // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────\n';
if (source.includes(staleComment) && !source.includes('/api/whitelist')) {
  source = source.replace(staleComment, '');
  notes.push('清理已空掉的章节注释');
}

if (!source.includes(MARK)) {
  const ANCHOR = '  let imageApprovalCache = null;';
  const at = source.indexOf(ANCHOR);
  if (at < 0) throw new Error('找不到 imageApprovalCache 声明，注入点定位失败');
  const insertAt = source.indexOf('\n', at) + 1;
  const block = `  ${MARK}
  // 阶段17：白名单模块要用的句柄。四个函数都在注入点之前声明（顶层三个 +
  // main 内的 reconcileSessionPolicies），直交引用安全；cfg 是对象，改它的属性
  // 立刻对所有持有者可见，不需要访问器。
  Object.assign(moduleCtx, {
    readConfigObject,
    atomicWriteJson,
    normalizeOwnerQQ,
    reconcileSessionPolicies: () => reconcileSessionPolicies(),
  });
`;
  source = source.slice(0, insertAt) + block + source.slice(insertAt);
  notes.push('注入白名单句柄');
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
const backup = `${FILE}.bak-stage17-${stamp}`;
fs.copyFileSync(FILE, backup);
fs.writeFileSync(FILE, source, 'utf8');
console.log(`已写回 ${FILE}（备份 ${path.basename(backup)}）`);
