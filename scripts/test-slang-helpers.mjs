// 回归守卫：黑话模块用到的每个 slangHelpers 句柄，必须在 src/bridge.js 里真的存在。
//
// 为什么要有它：src/modules/slang/index.js 里的 batch-delete / clear / batch-confirm /
// batch-reject 全都调 `h.setEntries(...)`，但注入出来的 slangHelpers 只交了
// `entries`（getter）和 `push`，没有 setter。于是线上按「批量删除黑话」会直接
// HTTP 500「h.setEntries is not a function」，而且只有真去点那个按钮才会发现。
// 这类"模块和句柄契约对不上"的错，静态检查一次就能全捞出来。
//
// 用法：node scripts/test-slang-helpers.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeFile = path.join(root, 'src', 'bridge.js');
const moduleFile = path.join(root, 'src', 'modules', 'slang', 'index.js');

const bridge = fs.readFileSync(bridgeFile, 'utf8');
const mod = fs.readFileSync(moduleFile, 'utf8');

let failures = 0;
const pass = (msg) => console.log(`✅ ${msg}`);
const fail = (msg) => { failures += 1; console.error(`❌ ${msg}`); };

// ── 1. 取出 slangHelpers 对象字面量的文本块 ────────────────────────────
const startAt = bridge.indexOf('slangHelpers: {');
if (startAt < 0) {
  fail('src/bridge.js 里找不到 slangHelpers 定义');
  process.exit(1);
}
// 从 '{' 开始按花括号配对找到块尾（够用：块内没有字符串里带裸花括号的情况）
let depth = 0;
let endAt = -1;
for (let i = bridge.indexOf('{', startAt); i < bridge.length; i += 1) {
  const ch = bridge[i];
  if (ch === '{') depth += 1;
  else if (ch === '}') {
    depth -= 1;
    if (depth === 0) { endAt = i; break; }
  }
}
if (endAt < 0) { fail('slangHelpers 块没有闭合'); process.exit(1); }
const block = bridge.slice(startAt, endAt);

// 只取顶层键（缩进 6 空格 + 名字 + 冒号），排除嵌套对象的内部键
const declared = new Set();
for (const line of block.split(/\r?\n/)) {
  // 支持两种写法：`name: value` 与简写 `name,`（例如 SLANG_STATUS）
  const m = /^ {6}([A-Za-z_$][\w$]*)\s*(?::|,)/.exec(line);
  if (m) declared.add(m[1]);
}
if (!declared.size) { fail('没能从 slangHelpers 块里解析出任何键'); process.exit(1); }

// ── 2. 收集模块里用到的 h.xxx ─────────────────────────────────────────
const used = new Set();
for (const m of mod.matchAll(/\bh\.([A-Za-z_$][\w$]*)/g)) used.add(m[1]);
for (const m of mod.matchAll(/\bslangHelpers\.([A-Za-z_$][\w$]*)/g)) used.add(m[1]);

const missing = [...used].filter((n) => !declared.has(n)).sort();
if (missing.length) {
  fail(`模块用到但 slangHelpers 没交的句柄：${missing.join(', ')}`);
} else {
  pass(`模块用到的 ${used.size} 个句柄全部已注入（${[...used].sort().join(', ')}）`);
}

// ── 3. 关键回归点：整体换数组必须有 setter ────────────────────────────
if (declared.has('setEntries')) {
  pass('slangHelpers.setEntries 存在（batch-delete / clear / confirm / reject 依赖它）');
} else {
  fail('slangHelpers 缺少 setEntries：批量删除/清空/批量确认/批量驳回会 500');
}

// ── 4. 这四个 handler 确实还在调它（防止有人把接口删了却留着测试） ────
const batchCalls = (mod.match(/\bh\.setEntries\(/g) || []).length;
if (batchCalls >= 4) {
  pass(`模块里有 ${batchCalls} 处 h.setEntries(...) 调用（批量删除/清空/确认/驳回）`);
} else {
  fail(`模块里只有 ${batchCalls} 处 h.setEntries(...)，预期至少 4 处`);
}

if (failures) {
  console.error(`\n# fail ${failures}`);
  process.exit(1);
}
console.log('\n# fail 0');
