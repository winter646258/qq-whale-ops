#!/usr/bin/env node
/**
 * 阶段 3：把第一批「只读/低风险」路由从老 if 链搬进模块。
 *
 * 搬的四条：GET /api/security、POST /api/security、POST /api/role、GET /api/sessions。
 * （阶段 2 已搬 GET /api/presets、POST /api/role-mode）
 *
 * 为什么是这四条：scripts/classify-routes.mjs 的依赖量化里，这四条的闭包 = 0，
 * 触碰的状态都是「句柄」（cfg/state/api）或文件级函数，不需要搬运任何 main() 内部逻辑。
 *
 * 做法与阶段 2 一致：删掉老 if 块，不留 fallback（两条真相是最容易埋雷的东西）。
 * 回退：cfg.socialV2.modules.enabled === false 或 git revert。
 *
 * 用法：node scripts/patch-modules-stage3.mjs [--dry-run]
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

/** 删掉一条路由 if 块（含到它闭合的 8 空格 `}`）。已删过则跳过。 */
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

// ── 1. stateDirHardened 改成可被模块访问（getter/setter） ────────────────────
// 它现在是 main() 里的 `let`，模块只能通过闭包读写；给它一对访问器。
out = insertBefore(out, `  // MARKER: modules-ctx-fns`, [
  '  // stateDirHardened 是 main() 里的 let，模块要读**和写**它（否则控制台显示旧状态）。',
  '  // 布尔是值传递，只能交一对访问器，不能交变量本身。',
  '  Object.assign(moduleCtx, {',
  '    getStateDirHardened: () => stateDirHardened,',
  '    setStateDirHardened: (v) => { stateDirHardened = v; },',
  '  });',
  '',
].join('\n'), '// MARKER: modules-ctx-security', '  // MARKER: modules-ctx-security');

// ── 2. 补齐模块要用的纯工具与常量 ────────────────────────────────────────────
{
  const anchor = '    roleSummaries,   // 人格清单摘要';
  if (!out.includes(anchor)) die('找不到 modules-ctx-fns 的既有内容');
  if (out.includes('sanitizeRoleName,')) console.log('· 已交过 sanitizeRoleName，跳过');
  else {
    out = out.replace(anchor, [
      '    roleSummaries,   // 人格清单摘要',
      '    sanitizeRoleName, // 人格名净化（文件级纯函数）',
      '    // 「roles/<名字>.md 存在吗」——模块不该自己拼 ROOT，交给主文件判断。',
      '    rolesDirExists: (name) => fs.existsSync(path.join(ROOT, \'roles\', name + \'.md\')),',
      '    hardenStateDirAcl,   // state/ ACL 收紧（会写 stateDirHardened，配合上面那对访问器）',
      '    manualDirCommand,    // state-acl 提供的安全版手工命令',
      '    readConfigObject,    // 读 config.json 为对象',
      '    atomicWriteJson,     // 原子写 JSON',
      '    configFile: path.join(ROOT, \'config.json\'),',
    ].join('\n'));
    console.log('· 补齐 sanitizeRoleName / rolesDirExists / hardenStateDirAcl / manualDirCommand / readConfigObject / atomicWriteJson / configFile');
  }
}

// ── 3. state 是 main() 里的 `let state`，模块要读 state.sessions ─────────────
{
  // 注意：state 在运行时会被**整体重新赋值**（loadState/保存路径），
  // 所以不能 `Object.assign(moduleCtx, { state })` —— 那会冻住旧对象。
  const anchor = '  // MARKER: modules-ctx-api';
  if (out.includes('get state()')) console.log('· 已交过 state 访问器，跳过');
  else {
    out = out.replace('  // MARKER: modules-ctx-api', [
      '  // MARKER: modules-ctx-state',
      '  // state 是 `let`，运行时会被整体重新赋值（loadState / 保存路径），',
      '  // 直接 Object.assign 会把旧对象冻住 —— 必须交访问器。',
      '  Object.defineProperty(moduleCtx, \'state\', { get: () => state, enumerable: true, configurable: true });',
      '',
      '  // MARKER: modules-ctx-api',
    ].join('\n'));
    console.log('· 注入 state 访问器');
  }
}

// ── 4. 删掉四条老路由 ────────────────────────────────────────────────────────
out = removeRouteBlock(out, "        if (req.method === 'GET' && url.pathname === '/api/sessions') {", 'GET /api/sessions');
out = removeRouteBlock(out, "        if (req.method === 'POST' && url.pathname === '/api/role') {", 'POST /api/role');
out = removeRouteBlock(out, "        if (req.method === 'GET' && url.pathname === '/api/security') {", 'GET /api/security');
out = removeRouteBlock(out, "        if (req.method === 'POST' && url.pathname === '/api/security') {", 'POST /api/security');

// ── 5. 语法检查 + 备份 + 写盘 ────────────────────────────────────────────────
const tmp = path.join(ROOT, 'src/.bridge-stage3.tmp.js');
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
fs.copyFileSync(SRC, path.join(ROOT, `src/bridge.js.bak-stage3-${stamp}`));
fs.writeFileSync(SRC, out);
fs.rmSync(tmp, { force: true });
console.log(`· 已写盘 ${SRC}（${src.split('\n').length} → ${out.split('\n').length} 行）`);
console.log(`· 备份 src/bridge.js.bak-stage3-${stamp}`);
