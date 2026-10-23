#!/usr/bin/env node
/**
 * 阶段 4：人格管理整族（7 条）+ 挂起审批清单（1 条）搬进模块。
 *
 * 为什么这一批能一次搬这么多：scripts/classify-routes.mjs 量过，
 * `api:roles` 这族 7 条路由 / 96 行 / 闭包 0 / 状态 2（全是文件级纯函数和常量），
 * `api:pending` 1 条 / 闭包 0 / 状态 2。它们不需要搬运任何 main() 内部逻辑，
 * 只需要把这些纯工具交给 ctx。
 *
 * 用法：node scripts/patch-modules-stage4.mjs [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/opt/qq-bridge';
const SRC = path.join(ROOT, 'src/bridge.js');
const DRY = process.argv.includes('--dry-run');
const src = fs.readFileSync(SRC, 'utf8');
function die(msg) { console.error('✗', msg); process.exit(1); }

function insertBefore(text, anchor, block, label, comment) {
  const key = comment ?? label;
  if (text.includes(key)) { console.log(`· 已打过 ${label}，跳过`); return text; }
  const i = text.indexOf(anchor);
  if (i < 0) die(`找不到锚点（${label}）：${JSON.stringify(anchor.slice(0, 60))}`);
  if (text.indexOf(anchor, i + 1) >= 0) die(`锚点不唯一（${label}）`);
  console.log(`· 插入 ${label}`);
  return text.slice(0, i) + block + text.slice(i);
}

function removeRouteBlock(text, openLine, label) {
  const ls = text.split('\n');
  const start = ls.findIndex((l) => l === openLine);
  if (start < 0) { console.log(`· ${label} 已不存在，跳过`); return text; }
  if (ls.indexOf(openLine, start + 1) >= 0) die(`待删路由行不唯一（${label}）`);
  let end = -1;
  for (let i = start + 1; i < ls.length; i += 1) if (ls[i] === '        }') { end = i; break; }
  if (end < 0) die(`找不到闭合行（${label}）`);
  const removed = ls.splice(start, end - start + 1);
  console.log(`· 删除路由 ${label}（${removed.length} 行，原 L${start + 1}）`);
  return ls.join('\n');
}

let out = src;

// ── 1. 人格管理的纯工具打包交给 ctx ─────────────────────────────────────────
// 这些全是**文件级**函数/常量（不在 main() 闭包里），模块直接 import bridge.js 又不行
// （会触发第二次 main()），所以只能由这里显式交出。
out = insertBefore(out, '  // MARKER: modules-ctx-api', [
  '  // MARKER: modules-ctx-roles',
  '  // 人格管理整族用到的文件级工具。roleInjectMaxChars 是 `let`（applyRoleInjectLimit',
  '  // 会给它赋新值），所以只交 getter/setter，不能交值。',
  '  Object.assign(moduleCtx, {',
  '    roleHelpers: {',
  '      NAME_MAX: ROLE_NAME_MAX,',
  '      CONTENT_MAX_BYTES: ROLE_CONTENT_MAX_BYTES,',
  '      validateName: validateRoleName,',
  '      validateContent: validateRoleContent,',
  '      fileExists: (name) => fs.existsSync(roleFilePath(name)),',
  '      readContent: readRoleContent,',
  '      writeContent: writeRoleContent,',
  '      renameFile: (from, to) => fs.renameSync(roleFilePath(from), roleFilePath(to)),',
  '      removeFile: (name) => fs.rmSync(roleFilePath(name)),',
  '      warnings: roleWarnings,',
  '      charStats: roleCharStats,',
  '      sectionReport: roleSectionReport,',
  '      applyInjectLimit: applyRoleInjectLimit,',
  '      getInjectMaxChars: () => roleInjectMaxChars,',
  '      setInjectMaxChars: (v) => { roleInjectMaxChars = v; },',
  '    },',
  '  });',
  '',
].join('\n'), '// MARKER: modules-ctx-roles', '  // MARKER: modules-ctx-roles');

// ── 2. pending Map 交给 ctx ─────────────────────────────────────────────────
// pending 是 `const`，只 add/delete/clear，从不整体重新赋值 → 可以交引用。
// 必须插在 `const pending = new Map()` **之后**：它在 main() 里是 TDZ 变量，
// 插在前面会让整个进程起不来（ReferenceError: Cannot access 'pending' before initialization）。
{
  const anchor = '  const pending = new Map(); // key -> { kind, rpcId, sessionId, ... }';
  const block = [
    anchor,
    '  // MARKER: modules-ctx-pending',
    '  // pending 是 `const Map`，只增删不整体重新赋值 → 直接交引用是安全的。',
    '  Object.assign(moduleCtx, { pending });',
    '',
  ].join('\n');
  if (out.includes('// MARKER: modules-ctx-pending')) console.log('· 已打过 pending，跳过');
  else if (!out.includes(anchor)) die('找不到 pending 声明');
  else { out = out.replace(anchor, block); console.log('· 注入 pending（声明之后）'); }
}

// ── 3. 删掉 8 条老路由 ─────────────────────────────────────────────────────
const targets = [
  ["        if (req.method === 'GET' && url.pathname === '/api/pending') {", 'GET /api/pending'],
  ["        if (req.method === 'GET' && url.pathname === '/api/roles') {", 'GET /api/roles'],
  ["        if (req.method === 'GET' && url.pathname === '/api/roles/content') {", 'GET /api/roles/content'],
  ["        if (req.method === 'POST' && url.pathname === '/api/roles/limit') {", 'POST /api/roles/limit'],
  ["        if (req.method === 'POST' && url.pathname === '/api/roles/create') {", 'POST /api/roles/create'],
  ["        if (req.method === 'POST' && url.pathname === '/api/roles/update') {", 'POST /api/roles/update'],
  ["        if (req.method === 'POST' && url.pathname === '/api/roles/rename') {", 'POST /api/roles/rename'],
  ["        if (req.method === 'POST' && url.pathname === '/api/roles/delete') {", 'POST /api/roles/delete'],
];
for (const [open, label] of targets) out = removeRouteBlock(out, open, label);

// ── 4. 语法检查 + 备份 + 写盘 ───────────────────────────────────────────────
const tmp = path.join(ROOT, 'src/.bridge-stage4.tmp.js');
fs.writeFileSync(tmp, out);
const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
if (DRY) { console.log('\n[dry-run] 未写盘；结果在', tmp); process.exit(0); }
try {
  (await import('node:child_process')).execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  console.log('· node --check 通过');
} catch (error) {
  console.error('✗ 语法检查失败，未动线上文件：');
  console.error(String(error.stderr ?? error.message));
  process.exit(1);
}
fs.copyFileSync(SRC, path.join(ROOT, `src/bridge.js.bak-stage4-${stamp}`));
fs.writeFileSync(SRC, out);
fs.rmSync(tmp, { force: true });
console.log(`· 已写盘 ${SRC}（${src.split('\n').length} → ${out.split('\n').length} 行）`);
console.log(`· 备份 src/bridge.js.bak-stage4-${stamp}`);
