// 阶段12：把 POST /api/test-send 搬进 test-send 模块。
//
// 依赖里有三个不同来源，注入写法要分清：
//   - allowed / escapeCqText / SENSITIVE_RE  → 顶层（import 或顶层函数），直接交引用
//   - modeAllowed / redactKnownTokensOnly    → main() 内声明，且都在注入点之后 ⇒ 必须包一层箭头函数（TDZ）
//   - bot                                    → main() 里 late 绑定（L14045 才 new），必须走访问器
//   - text                                   → @snowluma/sdk 的 import
//
// 幂等；先 --check 再落盘；支持 --dry-run。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = '/opt/qq-bridge';
const TARGET = path.join(ROOT, 'src/bridge.js');
const dryRun = process.argv.includes('--dry-run');

const source = fs.readFileSync(TARGET, 'utf8');
let text = source;
const marks = [];

function die(message) {
  console.error(`[stage12] ${message}`);
  process.exit(1);
}

// ── 1) 注入句柄 ─────────────────────────────────────────────────────────
const HELPERS = `  // MARKER: modules-ctx-test-send
  // /api/test-send 的依赖：modeAllowed / redactKnownTokensOnly 是本作用域里
  // 后文才声明的函数，只能写在箭头函数体里（对象字面量位置会触发 TDZ）；
  // bot 在 L14045 才 new 出来，必须走访问器读实时值。
  Object.assign(moduleCtx, {
    modeAllowed: (key, kind, id, config, mode) => modeAllowed(key, kind, id, config, mode),
    redactKnownTokensOnly: (value) => redactKnownTokensOnly(value),
    bot: () => bot,
  });
`;

const helperAnchor = '  let dshReady = false;';
if (text.includes('// MARKER: modules-ctx-test-send')) {
  marks.push('跳过 modules-ctx-test-send：已存在');
} else {
  if (!text.includes(helperAnchor)) die('找不到 dshReady 声明');
  const idx = text.indexOf(helperAnchor);
  const lineEnd = text.indexOf('\n', idx) + 1;
  text = text.slice(0, lineEnd) + HELPERS + text.slice(lineEnd);
  marks.push('插入 modules-ctx-test-send');
}

// ── 2) 删老 if 块（精确匹配 POST /api/test-send，缩进 8）──────────────
const signature = "if (req.method === 'POST' && url.pathname === '/api/test-send') {";
const occurrences = text.split(signature).length - 1;
if (occurrences === 0) {
  marks.push('跳过删除：已搬走');
} else if (occurrences > 1) {
  die(`签名匹配到 ${occurrences} 处，不敢动`);
} else {
  const lines = text.split('\n');
  const startIdx = lines.findIndex((line) => line.includes(signature));
  const indent = lines[startIdx].match(/^\s*/)[0];
  if (indent.length !== 8) die(`缩进不是 8（实际 ${indent.length}），疑似闸门，拒绝删除`);
  const closeRe = new RegExp(`^${indent}}\\s*$`);
  let endIdx = -1;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (closeRe.test(lines[i])) { endIdx = i; break; }
  }
  if (endIdx === -1) die('待删路由块没有闭合');
  const removed = endIdx - startIdx + 1;
  lines.splice(startIdx, removed);
  if (lines[startIdx] === '' && lines[startIdx + 1] === '') lines.splice(startIdx, 1);
  text = lines.join('\n');
  marks.push(`删除 /api/test-send 路由：${removed} 行（原起始行 ${startIdx + 1}）`);
}

if (text === source) {
  console.log('[stage12] 无需改动（全部已应用）');
  for (const line of marks) console.log(`  ${line}`);
  process.exit(0);
}

const tmp = path.join(ROOT, 'src/.bridge-stage12.tmp.js');
fs.writeFileSync(tmp, text);
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
} catch (error) {
  console.error('[stage12] 语法检查失败，未改动线上文件');
  console.error(String(error.stderr ?? error.message));
  fs.unlinkSync(tmp);
  process.exit(1);
}
fs.unlinkSync(tmp);

if (dryRun) {
  console.log('[stage12] dry-run，未写入');
  for (const line of marks) console.log(`  ${line}`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const backup = path.join(ROOT, `src/bridge.js.bak-stage12-${stamp}`);
fs.copyFileSync(TARGET, backup);
fs.writeFileSync(TARGET, text);
console.log(`[stage12] 已写入 ${TARGET}（备份 ${path.basename(backup)}）`);
console.log(`[stage12] 行数 ${source.split('\n').length} → ${text.split('\n').length}`);
for (const line of marks) console.log(`  ${line}`);
