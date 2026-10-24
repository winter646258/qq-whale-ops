#!/usr/bin/env node
// 阶段18：把仿真群友模式（旧社交引擎）的四条路由搬进 social 模块。
//
// 幂等：老 if 在就删，ctx 注入块按 MARKER 判重。
//
// 这一族只有两处依赖需要小心：
//   · social（L9556 的 const 对象）—— Map 内容可变但引用不变，直交；
//   · flushSummaries（L10856 async 声明）、enterActive（L10471）、
//     leaveActive（L10523）都在注入点之后 ⇒ 必须包箭头函数，绝不能直接放进
//     对象字面量的值位置（那是立即求值，会 TDZ 炸）。
//
// 用法：
//   node scripts/patch-modules-stage18.mjs            # 应用
//   node scripts/patch-modules-stage18.mjs --dry-run  # 只看会改什么
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const FILE = path.join(ROOT, 'src/bridge.js');
const TMP = path.join(ROOT, 'src/.bridge-stage18.tmp.js');
const dryRun = process.argv.includes('--dry-run');

const MARK = '// MARKER: modules-ctx-social';
const HEADS = [
  { label: 'social-GET', head: "        if (req.method === 'GET' && url.pathname === '/api/social') {" },
  { label: 'social-POST', head: "        if (req.method === 'POST' && url.pathname === '/api/social') {" },
  { label: 'social-flush', head: "        if (req.method === 'POST' && url.pathname === '/api/social/flush') {" },
  { label: 'social-state', head: "        if (req.method === 'POST' && url.pathname === '/api/social/state') {" },
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

// 清掉两处已空的章节注释与错位注释
for (const [label, line] of [
  ['清理 empty 社交配置注释', '        // ── 仿真群友模式（社交引擎）配置 ──────────────────────────────────────\n'],
  ['清理误挂的测试发送注释', '        // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────\n']
]) {
  // 「测试发送」那条注释本来挂错了地方（它下面紧接 /api/social/state），删掉它安全：
  // 真正的 /api/test-send 有自己的一块注释。
  if (source.includes(line)) { source = source.replace(line, ''); notes.push(label); }
}

if (!source.includes(MARK)) {
  const ANCHOR = '  let imageApprovalCache = null;';
  const at = source.indexOf(ANCHOR);
  if (at < 0) throw new Error('找不到 imageApprovalCache 声明，注入点定位失败');
  const insertAt = source.indexOf('\n', at) + 1;
  const block = `  ${MARK}
  // 阶段18：旧社交引擎（仿真群友模式）搬进 social 模块要用的句柄。
  // social 是 L9556 的 const 对象（Map 内容可变、引用不变）⇒ 直交；
  // enterActive/leaveActive/flushSummaries 都声明在注入点之后 ⇒ 只能包箭头。
  Object.assign(moduleCtx, {
    social: () => social,
    socialHelpers: {
      enterActive: (key) => enterActive(key),
      leaveActive: (key) => leaveActive(key),
      flushSummaries: (key) => flushSummaries(key),
    },
  });
`;
  source = source.slice(0, insertAt) + block + source.slice(insertAt);
  notes.push('注入 socialHelpers');
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
const backup = `${FILE}.bak-stage18-${stamp}`;
fs.copyFileSync(FILE, backup);
fs.writeFileSync(FILE, source, 'utf8');
console.log(`已写回 ${FILE}（备份 ${path.basename(backup)}）`);
