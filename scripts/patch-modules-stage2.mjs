#!/usr/bin/env node
/**
 * 阶段 2：把「功能模块」的骨架钉进代码，并把第一个模块真搬进去。
 *
 * 为什么先做「轻的」：
 *   scripts/classify-routes.mjs 量过 115 条路由的依赖。`/api/socialV2/*` 那一族
 *   6 条路由 + 600 行、闭包 60~91 个函数，先动它等于在 24/7 进程上做大手术；
 *   而 `GET /api/presets` 闭包 0、只碰 `api` 一个句柄，`POST /api/role-mode`
 *   只调两个**文件级函数** readRoleState/writeRoleState。先搬这种，
 *   「装载器 + 模块 + 回退开关」这条链才能真正跑起来并被验证。
 *
 * 关键设计（都是踩过的坑）：
 *   1. **ctx 是同一个对象**：bridge.js 先建 `{}`，后面 `Object.assign` 往里灌句柄，
 *      模块在 `setup(ctx)` 里看到的就是灌满的那个。不这么做就得在启动早期
 *      把所有句柄都算出来（`api` 要到 main() 中段才建），不可能。
 *   2. **模块不得 import bridge.js** —— 那会触发两次 main()（循环 import）。
 *      需要主文件的函数，由 bridge.js 通过 `Object.assign` 显式交给 ctx。
 *   3. 老 if 块**删掉**，不是留着当 fallback。留着就等于两条真相，改一处忘另一处。
 *      回退靠 `socialV2.modules.enabled=false` + git revert。
 *
 * 用法：node scripts/patch-modules-stage2.mjs [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/opt/qq-bridge';
const SRC = path.join(ROOT, 'src/bridge.js');
const DRY = process.argv.includes('--dry-run');

const src = fs.readFileSync(SRC, 'utf8');
const lines = src.split('\n');

function die(msg) { console.error('✗', msg); process.exit(1); }

/** 幂等：找到锚点就插在它前面；已插过就跳过。 */
function insertBefore(text, anchor, block, label, comment) {
  // 判重必须用**带缩进的定义行/注释行**，不能用 label 原文：
  // 第一次跑的时候 label 恰好是待删路由的整行文本，导致「锚点不唯一」的误报。
  const key = comment ?? label;
  if (text.includes(key)) { console.log(`· 已打过 ${label}，跳过`); return text; }
  const i = text.indexOf(anchor);
  if (i < 0) die(`找不到锚点（${label}）：${JSON.stringify(anchor.slice(0, 60))}`);
  if (text.indexOf(anchor, i + 1) >= 0) throw new Error(`锚点不唯一（${label}）：${JSON.stringify(anchor.slice(0, 60))}`);
  console.log(`· 插入 ${label}`);
  return text.slice(0, i) + block + text.slice(i);
}

/** 按行首精确匹配删掉一个 if 块（含到它闭合的 8 空格 `}`）。 */
function removeRouteBlock(text, openLine, label) {
  if (!text.includes(openLine)) die(`找不到待删路由（${label}）：${openLine}`);
  const ls = text.split('\n');
  const start = ls.findIndex((l) => l === openLine);
  if (start < 0 || ls.indexOf(openLine, start + 1) >= 0) die(`待删路由行不唯一（${label}）`);
  let end = -1;
  for (let i = start + 1; i < ls.length; i += 1) {
    if (ls[i] === '        }') { end = i; break; }
  }
  if (end < 0) die(`找不到闭合行（${label}）`);
  const removed = ls.splice(start, end - start + 1);
  console.log(`· 删除路由 ${label}（${removed.length} 行，原 L${start + 1}）`);
  return ls.join('\n');
}

let out = src;

// ── 1. ctx 句柄容器：紧跟 moduleHost 声明之后 ────────────────────────────────
out = insertBefore(out, `  acquireLock();\n  loadState();`, [
  '  // MARKER: modules-ctx',
  '  // 功能模块共用的句柄容器。**先建空对象，后面逐步 Object.assign 灌满**：',
  '  // 模块在 setup(ctx) 里拿到的是同一个对象，所以只要句柄在装载前灌好就行。',
  '  // 不在启动早期一次性算出来 —— api 等句柄要到 main() 中段才建得出来。',
  '  const moduleCtx = {};',
  '',
].join('\n'), '// MARKER: modules-ctx', '  // MARKER: modules-ctx');

// ── 2. 灌 cfg / log / stateDir ───────────────────────────────────────────────
out = insertBefore(out, `  // ── 群聊黑话/网络用语学习（slang）`, [
  '  Object.assign(moduleCtx, { cfg, log, stateDir: STATE_DIR });',
  '',
].join('\n'), 'Object.assign(moduleCtx, { cfg, log, stateDir: STATE_DIR });', '  Object.assign(moduleCtx, { cfg, log, stateDir: STATE_DIR });');

// ── 3. 灌 api：紧跟 NodeApiClient 构造之后（找构造的闭合行） ────────────────
{
  const anchor = '  const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {';
  const i = out.indexOf(anchor);
  if (i < 0) die('找不到 NodeApiClient 构造');
  if (out.indexOf(anchor, i + 1) >= 0) die('NodeApiClient 构造不唯一');
  const ls = out.split('\n');
  const start = ls.findIndex((l) => l === anchor);
  let end = -1;
  for (let k = start + 1; k < ls.length; k += 1) if (ls[k] === '  });') { end = k; break; }
  if (end < 0) die('找不到 NodeApiClient 构造的闭合行');
  if (ls.slice(start, end + 1).join('\n').includes('MARKER: modules-ctx-api')) { console.log('· 已灌过 api，跳过'); }
  else {
    // 注意：`api` 后面还有一个 `api.callUnary = ...` 覆写，必须在它之后灌，否则拿到的是旧引用？
    // 不需要 —— 灌的是对象引用本身，覆写方法不换对象。但为了稳，灌在闭合行之后。
    ls.splice(end + 1, 0, '', '  // MARKER: modules-ctx-api', '  Object.assign(moduleCtx, { api });');
    out = ls.join('\n');
    console.log('· 灌入 api 句柄');
  }
}

// ── 4. 灌主文件里的函数（模块不能 import bridge.js，只能由这里显式交出去） ──
// 插在 functions 定义之前的**唯一**位置：main() 里 `  startDshWatch();` 之前。
// （`startConsoleServer();` 在 14785，装载器块就在它下面；`const server = startConsoleServer;`
//  这个写法根本不存在 —— 返回值从来没被接住，第一版锚点写错了。）
out = insertBefore(out, `  startDshWatch();`, [
  '  // MARKER: modules-ctx-fns',
  '  // 模块**禁止** import bridge.js（会触发第二次 main()，循环 import）。',
  '  // 主文件里的函数一律从这里显式交付。注意只交**无状态、无副作用**的纯工具。',
  '  // unwrap 是 import 进来的纯工具（来自 dsh-client），模块要在 setup 里拿它。',
  '  Object.assign(moduleCtx, {',
  '    unwrap,',
  '    readRoleState,   // 读角色状态（role/mode），文件级函数，不依赖 main() 闭包',
  '    writeRoleState,  // 写角色状态',
  '    roleSummaries,   // 人格清单摘要',
  '  });',
  '',
].join('\n'), '// MARKER: modules-ctx-fns', '  // MARKER: modules-ctx-fns');

// ── 5. loader 换成 moduleCtx ─────────────────────────────────────────────────
{
  if (out.includes('        ctx: moduleCtx,')) console.log('· loader 已用 moduleCtx，跳过');
  else {
    // 实际写法是多行对象字面量（含注释），按「ctx: { ... },」整段括起来换掉。
    const re = /        ctx: \{\n[\s\S]*?\n        \},\n/;
    if (!re.test(out)) die('找不到 loader 里的 ctx 字面量');
    out = out.replace(re, '        // 与模块共用同一个 ctx 对象（bridge.js 逐步 Object.assign 灌满）\n        ctx: moduleCtx,\n');
    console.log('· loader 改用 moduleCtx');
  }
}

// ── 6. 删除第一条要搬走的路由（/api/presets） ────────────────────────────────
out = removeRouteBlock(out, "        if (req.method === 'GET' && url.pathname === '/api/presets') {", 'GET /api/presets');
// ── 7. 删除第二条（/api/role-mode） ──────────────────────────────────────────
out = removeRouteBlock(out, "        if (req.method === 'POST' && url.pathname === '/api/role-mode') {", 'POST /api/role-mode');

// ── 8. 语法检查 + 备份 + 写盘 ────────────────────────────────────────────────
const tmp = path.join(ROOT, 'src/.bridge-stage2.tmp.js');
fs.writeFileSync(tmp, out);
const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
if (DRY) {
  console.log('\n[dry-run] 未写盘；结果在', tmp);
  process.exit(0);
}
try {
  (await import('node:child_process')).execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  console.log('· node --check 通过');
} catch (error) {
  console.error('✗ 语法检查失败，未动线上文件：');
  console.error(String(error.stderr ?? error.message));
  process.exit(1);
}
fs.copyFileSync(SRC, path.join(ROOT, `src/bridge.js.bak-stage2-${stamp}`));
fs.writeFileSync(SRC, out);
fs.rmSync(tmp, { force: true });
console.log(`· 已写盘 ${SRC}（${src.split('\n').length} → ${out.split('\n').length} 行）`);
console.log(`· 备份 src/bridge.js.bak-stage2-${stamp}`);
