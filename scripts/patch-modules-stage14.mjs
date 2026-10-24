#!/usr/bin/env node
/**
 * 阶段14：把黑话库管理 /api/slang* 搬进 modules/slang 模块。
 *
 * 幂等：
 *   - 注入块以 `// MARKER: modules-ctx-slang` 判重
 *   - 老 if 链的删除以「起止锚点整段删除」为准，找不到锚点直接失败、不动文件
 *
 * 用法：
 *   node scripts/patch-modules-stage14.mjs            # 真改
 *   node scripts/patch-modules-stage14.mjs --dry-run  # 只报告
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TARGET = path.join(ROOT, 'src', 'bridge.js');
const DRY = process.argv.includes('--dry-run');

const MARK = 'modules-ctx-slang';

// ── 1. ctx 注入：必须挂在**所有** slang 容器声明之后 ─────────────────────
// 踩过的坑：一开始用 `const slangSubmitTimes` 当锚点，而 slangResearchingIds 与
// learner* 都排在它后面 —— 注入块在对象字面量里直接引用它们，当场 TDZ：
//   ReferenceError: Cannot access 'slangResearchingIds' before initialization
// 所以锚点换成最后一个容器 learnerWaiters。
const INJECT_ANCHOR = '  const learnerWaiters = new Map();     // sessionId -> [{resolve,reject,timer}]\n';

const INJECT_TEXT = `
  // MARKER: ${MARK}
  // 黑话库模块（slang）需要的句柄。分三类交付：
  //   1. 顶层 import 的常量/纯函数：SLANG_STATUS、createSlangEntry —— 交引用
  //   2. main() 里会被**整体重新赋值**的变量：slangEntries —— 只交 getter/setter，
  //      模块里绝不能缓存快照，否则清空/批量删之后拿到的是旧数组
  //   3. main() 里 const 容器（Map/Set）与函数声明 —— 交引用或闭包均可，
  Object.assign(moduleCtx, {
    slangHelpers: {
      entries: () => slangEntries,
      push: (entry) => {
        slangEntries.push(entry);
      },
      save: () => saveSlangStore(),
      createEntry: (input) => createSlangEntry(input),
      SLANG_STATUS,
      windows: slangWindows,
      cooldowns: slangExtractionCooldowns,
      submitTimes: slangSubmitTimes,
      researchingIds: slangResearchingIds,
      queueTask: (fn) => queueSlangTask(fn),
      runExtraction: (key, opts) => runSlangExtraction(key, opts),
      runResearch: (candidates, opts) => runSlangResearch(candidates, opts),
      invalidateLearnerSession: () => invalidateSlangLearnerSession(),
    },
  });
`;

// ── 2. 老 if 链删除：从 GET /api/slang 起，到 POST /api/slang/config 块收尾 ──
const DEL_START = "        if (req.method === 'GET' && url.pathname === '/api/slang') {\n";
const DEL_END = "        // ── 会话查看 ──────────────────────────────────────────────────────────\n";

function die(message) {
  console.error(`[stage14] ${message}`);
  process.exit(1);
}

function insertAfter(source, anchor, text, label) {
  const idx = source.indexOf(anchor);
  if (idx < 0) die(`找不到锚点（${label}）`);
  const at = idx + anchor.length;
  // 已存在同 MARKER 就不重复插
  if (source.includes(`// MARKER: ${MARK}`)) return source;
  return `${source.slice(0, at)}${text}${source.slice(at)}`;
}

function removeBlock(source) {
  const start = source.indexOf(DEL_START);
  if (start < 0) die('找不到删除起点 GET /api/slang');
  const end = source.indexOf(DEL_END, start);
  if (end < 0) die('找不到删除终点（// ── 会话查看 ──）');
  const removed = source.slice(start, end);
  const lines = removed.split('\n').length - 1;
  console.log(`[stage14] 将删除 ${lines} 行（${start} .. ${end}）`);
  return `${source.slice(0, start)}${source.slice(end)}`;
}

let code = fs.readFileSync(TARGET, 'utf8');
const before = code.length;

code = insertAfter(code, INJECT_ANCHOR, INJECT_TEXT, 'modules-ctx-slang');
code = removeBlock(code);

if (before === code.length) {
  console.log('[stage14] 无改动');
  process.exit(0);
}

const tmp = path.join(ROOT, 'src', '.bridge-stage14.tmp.js');
fs.writeFileSync(tmp, code);
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
} catch (error) {
  fs.rmSync(tmp, { force: true });
  die(`语法检查失败：${error.stderr?.toString() ?? error.message}`);
}
fs.rmSync(tmp, { force: true });

if (DRY) {
  console.log(`[stage14] dry-run 通过：${before} -> ${code.length} 字节（未写盘）`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = `${TARGET}.bak-stage14-${stamp}`;
fs.copyFileSync(TARGET, backup);
fs.writeFileSync(TARGET, code);
console.log(`[stage14] 已写入，备份 ${path.basename(backup)}；${before} -> ${code.length} 字节`);
